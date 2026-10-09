/**
 * Fork defaults for a single Windows + RTX 3090 machine with a local Ollama.
 * Everything the fork changes about upstream's defaults lives here; see docs/FORK.md.
 */

/** Interface language on first run. */
export const FORK_DISPLAY_LANGUAGE = 'ru-RU'
/** Transcription language: Russian speech, with German terms kept by the prompt. */
export const FORK_TRANSCRIBE_LANG = 'ru'
/** The Ollama model picked when nothing is chosen yet; falls back to the first installed model. */
export const FORK_OLLAMA_PREFERRED = 'qwen3.5:35b'
export const FORK_OLLAMA_BASE_URL = 'http://localhost:11434'
/** How long Ollama keeps the model between requests of one burst; the gate unloads it after the burst. */
export const FORK_OLLAMA_KEEP_ALIVE = '10m'
/** Idle time after the last LLM request before the model is unloaded, unless whisper needs the GPU sooner. */
export const FORK_LLM_IDLE_UNLOAD_MS = 3_000
/** Default translation target (ISO 639-1); the dialog remembers the last choice. */
export const FORK_TRANSLATE_TARGET = 'de'
/** The installed build has CUDA, upstream's updater would replace it with a build without. */
export const FORK_DISABLE_UPDATER = true
/** Ollama requests go through the fork's client (think off, model auto-pick, GPU gate). Off only in upstream's own tests. */
export const FORK_LOCAL_OLLAMA = true
