# fork-local_001 — local Ollama check

Validates the fork's translation path against a local Ollama on the Windows PC
that will run the CUDA build.

## Run

```
ollama serve            # or just have the Ollama tray app running
uv run plans/fork-local/fork-local_001.py
```

Options: `--base-url http://host:11434`, `--model qwen3.5:35b`, `--target de`.

## What it checks

1. `GET /api/tags` — Ollama reachable; lists models, picks `qwen3.5:35b`, else the first one.
2. `POST /api/generate` with `think: false, stream: false` — no `thinking` text, no `<think>` block.
3. Translates a 3-cue SRT sent as `⟦id⟧ text` lines; asserts every id comes back,
   and the rebuilt SRT keeps the original ids and timecodes (warns on untranslated cues).
4. `POST /api/generate {model, keep_alive: 0}` then polls `GET /api/ps` until the model is gone,
   i.e. VRAM is freed for whisper.

Exit code 0 and `all checks passed` means success; any `[FAIL]` line exits 1.
If Ollama is not running it says so instead of a traceback.
