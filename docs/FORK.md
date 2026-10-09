# Vibe fork: one Windows PC with CUDA and local Ollama

Target machine: Windows 11, RTX 3090 24 GB, Ryzen 5800X, 64 GB RAM.

What the fork changes:

- **CUDA.** `vibe-server` is built with the CUDA backend of ggml, sm_86, with Vulkan kept as a fallback. The GPU device list shows `CUDA0` first, and it is the default.
- **Defaults.**
  - Interface: ru-RU.
  - Transcription language: `ru`.
  - Whisper model: `large-v3-turbo` (upstream's default too).
  - AI platform: local Ollama at `http://localhost:11434`.
- **Ollama model picker.** The models come from `GET /api/tags` and there is a «Обновить» button. The choice is saved. An empty choice means auto: `qwen3.5:35b` if installed, else the first model in the list. If Ollama is not running, a clear message says so.
- **VRAM sharing.** Whisper and the ~23 GB Ollama model never hold the GPU together (see `desktop/src/fork/gpu-gate.ts`):
  1. Transcription runs first.
  2. Before the first LLM request, `vibe-server` is stopped. This frees all of its VRAM, including the CUDA context.
  3. LLM requests run one at a time, with `"think": false`.
  4. After the last request and a short idle period, the model is unloaded with `keep_alive: 0`.
  5. The next transcription waits for the unload and then restarts `vibe-server`, which takes about 2–3 s.
- **Translation.** The transcript can be translated, and so can any `.srt` or `.txt` file:
  - SRT is translated in batches. Numbering and timecodes are always taken from the source; the model only returns text.
  - Use the «Перевести» button on the transcript toolbar, or the languages icon at the top for a file from disk.
- **No upstream updater.** The updater would install upstream's build, which has no CUDA.
- **CI.** Only the Windows NSIS installer is built, by `.github/workflows/fork-windows.yml`.

Tip for Russian speech with German terms: put the terms into the transcription prompt (Advanced options → prompt), for example `Termin, Anmeldung, Krankenkasse, Bürgeramt`. Whisper then keeps them in Latin script instead of transliterating or translating them.

## Layout

Fork-only files (upstream never touches these):

| Path | What |
|---|---|
| `desktop/src/fork/defaults.ts` | All fork defaults in one place |
| `desktop/src/fork/locale.ts` | `pick(ru, en)`: fork strings stay out of `i18n/` |
| `desktop/src/fork/gpu-gate.ts` | Whisper ↔ LLM phase lock |
| `desktop/src/fork/ollama/` | Model list and auto pick, `LocalOllama` client, model picker |
| `desktop/src/fork/translate/` | SRT parser, batched translation, TXT translation, dialog |
| `desktop/src/fork/ui/translate-entry.tsx` | Toolbar and menu buttons |
| `desktop/src-tauri/tauri.fork.conf.json` | Bundles the cuBLAS DLLs, no updater artifacts |
| `server/libs/cuda.chore` | `chore build-libs-cuda` |
| `server/crates/ggml-rs-sys/build_cuda.rs` | Links `ggml-cuda` and the CUDA libs when present |
| `.github/workflows/fork-windows.yml` | Windows installer CI |
| `plans/fork-local/` | Check script to run against the local Ollama |

Hooks in upstream files are short lines marked `fork:`. List them with:

```sh
git grep -n "fork:" -- desktop/src server .github ':!desktop/src/fork' ; git grep -n "// fork$\|{/\* fork \*/}" -- desktop/src
```

| Upstream file | Hook |
|---|---|
| `desktop/src/lib/ai/client.ts` | `createClient`: Ollama → `LocalOllama` |
| `desktop/src/lib/ai/config.ts` | Default platform is `ollama`; `defaultModel('ollama')` is `''` (auto) |
| `desktop/src/providers/preference.tsx` | Display language, transcription language, first run applies ru-RU |
| `desktop/src/providers/updater.tsx` | Update check off |
| `desktop/src/providers/hotkey.tsx` | GPU gate around dictation transcription |
| `desktop/src/pages/main/hooks/use-transcribe-queue.ts` | GPU gate around a transcription run |
| `desktop/src/pages/settings/sections/ai.tsx` | Ollama model input → `OllamaModelPicker` |
| `desktop/src/pages/main/components/transcript-toolbar.tsx` | «Перевести» button |
| `desktop/src/components/app-menu.tsx` | Translate file button |
| `desktop/src/lib/ai/ai.test.ts` | Upstream Ollama test runs against the fork client |
| `server/chorefile` | `include libs/cuda.chore` |
| `server/crates/ggml-rs-sys/build.rs` | `mod cuda` + `cuda::link` |

## Syncing with upstream

```sh
git remote add upstream https://github.com/thewh1teagle/vibe.git   # once
git fetch upstream
git merge upstream/main
```

Conflicts, if any, are in the hook lines above. Keep upstream's change and re-apply the one-line hook.

Then check:

```sh
cd desktop && pnpm install && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec eslint src
```

If upstream changes `server/libs/libs.chore` (the ggml tag, patches, or the build recipe), mirror the change in `server/libs/cuda.chore`.

In the GitHub repository settings, disable the upstream workflows (Actions → workflow → «Disable workflow»): `release.yml`, `server-*.yml`, `lint_rust.yml`, `test-release.yml`, `website.yml`. This changes no files, so merges stay clean.

## Building

### CI

Run «Fork Windows (CUDA)» by hand (workflow_dispatch), or push a tag `fork-v*`. The installer is uploaded as a workflow artifact; on a tag it is also attached to the release.

The first run compiles ggml-cuda, which takes about 20–40 min. Later runs reuse the cached `server/libs/lib`.

### Locally on Windows

Requirements:

- Visual Studio 2022 Build Tools (C++)
- CUDA Toolkit 12.x (`CUDA_PATH` set)
- Vulkan SDK
- LLVM (`llvm-nm`, `llvm-objcopy` on PATH)
- Rust, Node 22, pnpm
- [chore](https://github.com/getchore/chore) 1.6

Steps:

```powershell
cd server
chore build-libs-cuda                      # ggml with CUDA sm_86 + Vulkan → server/libs/lib
cd ..
chore setup x86_64-pc-windows-msvc         # upstream sidecars (ffmpeg)
chore server-build                         # NOTE: runs fetch-libs; use the two lines below instead
cd server; cargo build -p vibe-server --release; cd ..
copy server\target\release\vibe-server.exe desktop\src-tauri\binaries\vibe-server-x86_64-pc-windows-msvc.exe
mkdir desktop\src-tauri\binaries\cuda
copy "$env:CUDA_PATH\bin\cublas*64_*.dll" desktop\src-tauri\binaries\cuda\
cd desktop; pnpm install; pnpm exec tauri build --bundles nsis --config src-tauri/tauri.fork.conf.json
```

Checking against the real Ollama: `uv run plans/fork-local/fork-local_001.py`.
