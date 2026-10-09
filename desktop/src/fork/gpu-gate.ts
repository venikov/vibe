import { invoke } from '@tauri-apps/api/core'
import { FORK_LLM_IDLE_UNLOAD_MS } from './defaults'

/**
 * One GPU, two tenants: whisper (the vibe-server process) and a local Ollama model that
 * together do not fit into 24 GB of VRAM. The gate makes them take turns.
 *
 * Phases:
 *   idle    – nobody holds the GPU.
 *   whisper – one or more transcription jobs run (they may run concurrently).
 *   llm     – the model is (or may be) loaded. Requests run one at a time. When the queue
 *             empties an idle timer starts; a request arriving before it fires keeps the
 *             model loaded (summaries ask several chunks back to back). When the timer fires,
 *             or as soon as whisper is waiting, the phase ends: every remembered unload runs,
 *             and only then is the GPU handed over.
 *
 * Fairness: a side that is waiting blocks newcomers of the other side from joining the running
 * phase, so neither a stream of whisper jobs nor a stream of LLM requests starves the other.
 */

export interface GpuGateDeps {
	/** Frees whisper's VRAM (stops vibe-server). Called once when an LLM phase begins. */
	releaseWhisper: () => Promise<void>
	idleUnloadMs: number
	setTimer?: typeof setTimeout
	clearTimer?: typeof clearTimeout
}

export interface GpuGate {
	/** Transcription work; waits while the LLM phase holds the GPU (incl. its unload). Concurrent whisper jobs allowed. */
	runWhisper<T>(fn: () => Promise<T>): Promise<T>
	/** Same as runWhisper, but the caller holds the slot until it calls the returned (idempotent) release. */
	acquireWhisper(): Promise<() => void>
	/**
	 * One LLM request. Waits until no whisper job runs; on entering the LLM phase calls
	 * releaseWhisper() once. Requests are serialized. `unload` is remembered by `key` and all
	 * remembered unloads run when the phase ends.
	 */
	runLlm<T>(fn: () => Promise<T>, unload: { key: string; run: () => Promise<void> }): Promise<T>
	/** Ends the LLM phase now if idle (unloads). */
	flush(): Promise<void>
	readonly phase: 'idle' | 'whisper' | 'llm'
}

type Phase = GpuGate['phase']

export function createGpuGate(deps: GpuGateDeps): GpuGate {
	const setTimer = deps.setTimer ?? setTimeout
	const clearTimer = deps.clearTimer ?? clearTimeout

	let phase: Phase = 'idle'
	/** Whisper jobs currently running (phase 'whisper'). */
	let whisperActive = 0
	/** An LLM request is running (phase 'llm'). */
	let llmActive = false
	/** Whether releaseWhisper() already ran in the current LLM phase. */
	let whisperReleased = false
	/** The running phase end (unloading), if any; phase stays 'llm' until it completes. */
	let ending: Promise<void> | null = null
	let idleTimer: ReturnType<typeof setTimeout> | null = null
	const whisperQueue: Array<() => void> = []
	const llmQueue: Array<() => void> = []
	const unloads = new Map<string, () => Promise<void>>()

	function cancelIdleTimer() {
		if (idleTimer !== null) {
			clearTimer(idleTimer)
			idleTimer = null
		}
	}

	/** The LLM phase has nothing running and is not already ending. */
	function llmIdle() {
		return phase === 'llm' && !llmActive && !ending
	}

	/** Hand the idle GPU to the next side. `prefer` is the side that did not just have it. */
	function dispatch(prefer: 'whisper' | 'llm') {
		if (phase !== 'idle') return
		const whisperFirst = prefer === 'whisper' ? whisperQueue.length > 0 : llmQueue.length === 0 && whisperQueue.length > 0
		if (whisperFirst) {
			// Every waiting whisper job starts together.
			phase = 'whisper'
			const waiters = whisperQueue.splice(0)
			whisperActive += waiters.length
			for (const wake of waiters) wake()
		} else if (llmQueue.length > 0) {
			phase = 'llm'
			whisperReleased = false
			llmActive = true
			llmQueue.shift()!()
		}
	}

	/** Unload every remembered model, then give the GPU away. */
	function endLlmPhase(): Promise<void> {
		if (ending) return ending
		cancelIdleTimer()
		ending = (async () => {
			const pending = [...unloads.values()]
			unloads.clear()
			for (const run of pending) {
				try {
					await run()
				} catch (error) {
					console.warn('gpu-gate: unload failed', error)
				}
			}
			ending = null
			phase = 'idle'
			dispatch('whisper')
		})()
		return ending
	}

	function acquireWhisperSlot(): Promise<void> {
		// Join an idle GPU or a running whisper burst, unless an LLM request is already waiting.
		if (phase === 'idle' || (phase === 'whisper' && llmQueue.length === 0)) {
			phase = 'whisper'
			whisperActive++
			return Promise.resolve()
		}
		const granted = new Promise<void>((resolve) => whisperQueue.push(resolve))
		// The model sits loaded but unused: unload it now instead of waiting for the idle timer.
		if (llmIdle()) void endLlmPhase()
		return granted
	}

	/** A whisper slot plus an idempotent release, so a double release cannot corrupt the count. */
	async function acquireWhisper(): Promise<() => void> {
		await acquireWhisperSlot()
		let held = true
		return () => {
			if (!held) return
			held = false
			releaseWhisperSlot()
		}
	}

	function releaseWhisperSlot() {
		whisperActive--
		if (whisperActive > 0) return
		phase = 'idle'
		dispatch('llm')
	}

	function acquireLlm(): Promise<void> {
		if (phase === 'idle' && whisperQueue.length === 0) {
			phase = 'llm'
			whisperReleased = false
			llmActive = true
			return Promise.resolve()
		}
		// Model still loaded from the previous request: keep it and go.
		if (llmIdle() && whisperQueue.length === 0) {
			cancelIdleTimer()
			llmActive = true
			return Promise.resolve()
		}
		return new Promise<void>((resolve) => llmQueue.push(resolve))
	}

	function releaseLlmSlot() {
		llmActive = false
		if (whisperQueue.length > 0) {
			void endLlmPhase()
		} else if (llmQueue.length > 0) {
			llmActive = true
			llmQueue.shift()!()
		} else {
			cancelIdleTimer()
			idleTimer = setTimer(() => {
				idleTimer = null
				if (llmIdle()) void endLlmPhase()
			}, deps.idleUnloadMs)
		}
	}

	return {
		get phase() {
			return phase
		},
		acquireWhisper,
		async runWhisper<T>(fn: () => Promise<T>): Promise<T> {
			const release = await acquireWhisper()
			try {
				return await fn()
			} finally {
				release()
			}
		},
		async runLlm<T>(fn: () => Promise<T>, unload: { key: string; run: () => Promise<void> }): Promise<T> {
			await acquireLlm()
			try {
				unloads.set(unload.key, unload.run)
				if (!whisperReleased) {
					whisperReleased = true
					try {
						await deps.releaseWhisper()
					} catch (error) {
						console.warn('gpu-gate: releasing whisper failed', error)
					}
				}
				return await fn()
			} finally {
				releaseLlmSlot()
			}
		},
		async flush() {
			if (ending) return ending
			if (llmIdle()) return endLlmPhase()
		},
	}
}

/** The app-wide gate: entering the LLM phase stops vibe-server, which frees whisper's VRAM. */
export const gpuGate: GpuGate = createGpuGate({
	releaseWhisper: async () => {
		try {
			await invoke('stop_api_server')
		} catch (error) {
			console.warn('gpu-gate: stop_api_server failed', error)
		}
	},
	idleUnloadMs: FORK_LLM_IDLE_UNLOAD_MS,
})
