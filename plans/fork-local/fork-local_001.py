# /// script
# requires-python = ">=3.10"
# dependencies = ["httpx==0.28.1"]
# ///
"""Validate the fork's local-Ollama translation path on this machine.

Checks: Ollama is up, a model answers with think:false (no reasoning text),
a 3-cue SRT round-trips through the numbered `⟦id⟧ text` format with ids and
timecodes intact, and keep_alive:0 unloads the model (GET /api/ps).

    uv run plans/fork-local/fork-local_001.py [--base-url URL] [--model NAME] [--target de]
"""

from __future__ import annotations

import argparse
import re
import sys
import time

import httpx

PREFERRED_MODEL = "qwen3.5:35b"

SRT = """1
00:00:01,000 --> 00:00:03,500
Hello, how are you today?

2
00:00:04,000 --> 00:00:06,250
The weather is nice outside.

3
00:00:07,000 --> 00:00:09,800
Let's go for a walk in the park.
"""

CUE_RE = re.compile(r"(\d+)\s*\n(\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3})\s*\n(.+?)(?:\n\s*\n|\Z)", re.S)
LINE_RE = re.compile(r"^\s*⟦(\d+)⟧\s*(.*?)\s*$")


def ok(msg: str) -> None:
    print(f"[ok]   {msg}")


def fail(msg: str) -> None:
    print(f"[FAIL] {msg}")
    sys.exit(1)


def parse_srt(text: str) -> list[tuple[str, str, str]]:
    return [(i, tc, body.strip()) for i, tc, body in CUE_RE.findall(text)]


def check_tags(client: httpx.Client, wanted: str | None) -> str:
    try:
        r = client.get("/api/tags")
    except (httpx.ConnectError, httpx.ConnectTimeout):
        fail(f"cannot reach Ollama at {client.base_url}. Is it running? Start it with `ollama serve` or the tray app.")
    r.raise_for_status()
    names = [m["name"] for m in r.json().get("models", [])]
    if not names:
        fail("Ollama has no models. Pull one, e.g. `ollama pull qwen3.5:35b`.")
    ok(f"/api/tags lists {len(names)} model(s): {', '.join(names)}")
    if wanted:
        if wanted not in names:
            fail(f"model {wanted!r} is not installed")
        return wanted
    model = PREFERRED_MODEL if PREFERRED_MODEL in names else names[0]
    ok(f"using model {model}")
    return model


def generate(client: httpx.Client, model: str, prompt: str) -> dict:
    r = client.post(
        "/api/generate",
        json={"model": model, "prompt": prompt, "stream": False, "think": False, "options": {"temperature": 0}},
    )
    if r.status_code >= 400:
        fail(f"/api/generate returned {r.status_code}: {r.text[:300]}")
    return r.json()


def check_no_thinking(client: httpx.Client, model: str) -> None:
    t0 = time.perf_counter()
    data = generate(client, model, "Reply with exactly the word: pong")
    dt = time.perf_counter() - t0
    if (data.get("thinking") or "").strip():
        fail(f"think:false still produced thinking text: {data['thinking'][:200]!r}")
    if "<think>" in data.get("response", ""):
        fail("response contains a <think> block despite think:false")
    ok(f"think:false honoured ({dt:.1f}s, response {data.get('response', '').strip()[:40]!r})")


def check_translate(client: httpx.Client, model: str, target: str) -> None:
    cues = parse_srt(SRT)
    assert len(cues) == 3, cues
    numbered = "\n".join(f"⟦{i}⟧ {body}" for i, _, body in cues)
    prompt = (
        f"Translate each line into the language with ISO 639-1 code '{target}'.\n"
        "Keep the ⟦n⟧ marker at the start of every line exactly as given, one line per marker, "
        "same order, no extra text, no explanations.\n\n" + numbered
    )
    data = generate(client, model, prompt)
    out = data.get("response", "")
    got: dict[str, str] = {}
    for line in out.splitlines():
        m = LINE_RE.match(line)
        if m and m.group(2):
            got[m.group(1)] = m.group(2)
    want_ids = [i for i, _, _ in cues]
    if sorted(got) != sorted(want_ids):
        fail(f"ids changed: wanted {want_ids}, got {sorted(got)}\n--- raw ---\n{out}")
    rebuilt = "\n".join(f"{i}\n{tc}\n{got[i]}\n" for i, tc, _ in cues)
    back = parse_srt(rebuilt)
    if [(i, tc) for i, tc, _ in back] != [(i, tc) for i, tc, _ in cues]:
        fail("timecodes or ids not preserved after rebuild")
    unchanged = [i for i, _, body in cues if got[i].strip() == body]
    if unchanged:
        print(f"[warn] cue(s) {unchanged} came back untranslated")
    ok("SRT translated, ids and timecodes preserved:")
    print(rebuilt)


def check_unload(client: httpx.Client, model: str) -> None:
    r = client.post("/api/generate", json={"model": model, "keep_alive": 0})
    if r.status_code >= 400:
        fail(f"unload request returned {r.status_code}: {r.text[:300]}")
    for _ in range(20):
        loaded = [m.get("name") or m.get("model") for m in client.get("/api/ps").json().get("models", [])]
        if model not in loaded:
            ok(f"model unloaded (/api/ps: {loaded or 'empty'})")
            return
        time.sleep(0.5)
    fail(f"model still loaded after keep_alive:0 (/api/ps: {loaded})")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://localhost:11434")
    ap.add_argument("--model", default=None, help=f"default: {PREFERRED_MODEL} if installed, else the first model")
    ap.add_argument("--target", default="de", help="ISO 639-1 target language (default: de)")
    args = ap.parse_args()

    with httpx.Client(base_url=args.base_url, timeout=httpx.Timeout(600.0, connect=5.0)) as client:
        model = check_tags(client, args.model)
        check_no_thinking(client, model)
        check_translate(client, model, args.target)
        check_unload(client, model)
    print("all checks passed")


if __name__ == "__main__":
    main()
