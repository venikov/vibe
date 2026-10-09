import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }))

import { createGpuGate } from './gpu-gate'

function deferred<T = void>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

/** Let every pending microtask chain run. */
async function settle() {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function setup(idleUnloadMs = 1000) {
	const log: string[] = []
	let timer: { fn: () => void; ms: number } | null = null
	const setTimer = ((fn: () => void, ms: number) => {
		timer = { fn, ms }
		return 1 as never
	}) as unknown as typeof setTimeout
	const clearTimer = (() => {
		timer = null
	}) as unknown as typeof clearTimeout
	const releaseWhisper = vi.fn(async () => {
		log.push('releaseWhisper')
	})
	const gate = createGpuGate({ releaseWhisper, idleUnloadMs, setTimer, clearTimer })
	const unload = (key: string) => ({
		key,
		run: async () => {
			log.push(`unload:${key}`)
		},
	})
	const fireTimer = () => {
		const current = timer
		timer = null
		current?.fn()
	}
	return { gate, log, releaseWhisper, unload, fireTimer, hasTimer: () => timer !== null, timerMs: () => timer?.ms }
}

describe('gpu gate', () => {
	it('runs concurrent whisper jobs together', async () => {
		const { gate } = setup()
		const a = deferred()
		const b = deferred()
		let running = 0
		const job = (d: { promise: Promise<void> }) =>
			gate.runWhisper(async () => {
				running++
				await d.promise
			})
		const pa = job(a)
		const pb = job(b)
		await settle()
		expect(running).toBe(2)
		expect(gate.phase).toBe('whisper')
		a.resolve()
		b.resolve()
		await Promise.all([pa, pb])
		expect(gate.phase).toBe('idle')
	})

	it('serializes LLM requests and releases whisper once per phase', async () => {
		const { gate, log, releaseWhisper, unload } = setup()
		const first = deferred<string>()
		const p1 = gate.runLlm(async () => {
			log.push('llm1')
			return first.promise
		}, unload('m'))
		const p2 = gate.runLlm(async () => {
			log.push('llm2')
			return 'two'
		}, unload('m'))
		await settle()
		expect(log).toEqual(['releaseWhisper', 'llm1'])
		first.resolve('one')
		expect(await p1).toBe('one')
		expect(await p2).toBe('two')
		expect(log).toEqual(['releaseWhisper', 'llm1', 'llm2'])
		expect(releaseWhisper).toHaveBeenCalledTimes(1)
		expect(gate.phase).toBe('llm')
	})

	it('unloads after the idle timer, and a new request in time cancels it', async () => {
		const { gate, log, unload, fireTimer, hasTimer, timerMs } = setup(3000)
		await gate.runLlm(async () => 'a', unload('m'))
		expect(hasTimer()).toBe(true)
		expect(timerMs()).toBe(3000)
		// Another chunk arrives before the timer fires: model stays loaded.
		await gate.runLlm(async () => 'b', unload('m'))
		expect(log).toEqual(['releaseWhisper'])
		fireTimer()
		await settle()
		expect(log).toEqual(['releaseWhisper', 'unload:m'])
		expect(gate.phase).toBe('idle')
	})

	it('runs every remembered unload once, keyed', async () => {
		const { gate, log, unload } = setup()
		await gate.runLlm(async () => 1, unload('a'))
		await gate.runLlm(async () => 2, unload('b'))
		await gate.runLlm(async () => 3, unload('a'))
		await gate.flush()
		expect(log).toEqual(['releaseWhisper', 'unload:a', 'unload:b'])
		await gate.flush()
		expect(log).toHaveLength(3)
	})

	it('a new LLM phase releases whisper again', async () => {
		const { gate, releaseWhisper, unload } = setup()
		await gate.runLlm(async () => 1, unload('a'))
		await gate.flush()
		await gate.runLlm(async () => 2, unload('a'))
		expect(releaseWhisper).toHaveBeenCalledTimes(2)
	})

	it('whisper waiting while the model idles ends the phase immediately', async () => {
		const { gate, log, unload, hasTimer } = setup()
		await gate.runLlm(async () => 1, unload('m'))
		expect(hasTimer()).toBe(true)
		const whisper = gate.runWhisper(async () => {
			log.push('whisper')
		})
		await whisper
		expect(hasTimer()).toBe(false)
		expect(log).toEqual(['releaseWhisper', 'unload:m', 'whisper'])
		expect(gate.phase).toBe('idle')
	})

	it('whisper waiting during a request unloads right after it', async () => {
		const { gate, log, unload } = setup()
		const llm = deferred()
		const p = gate.runLlm(() => llm.promise, unload('m'))
		await settle()
		const whisper = gate.runWhisper(async () => {
			log.push('whisper')
		})
		await settle()
		expect(log).toEqual(['releaseWhisper'])
		llm.resolve()
		await Promise.all([p, whisper])
		expect(log).toEqual(['releaseWhisper', 'unload:m', 'whisper'])
	})

	it('LLM requests wait for the whisper burst, and new whisper jobs queue behind them', async () => {
		const { gate, log, unload } = setup()
		const w1 = deferred()
		const pw1 = gate.runWhisper(async () => {
			log.push('w1')
			await w1.promise
		})
		await settle()
		const pl = gate.runLlm(async () => {
			log.push('llm')
		}, unload('m'))
		const pw2 = gate.runWhisper(async () => {
			log.push('w2')
		})
		await settle()
		expect(log).toEqual(['w1'])
		expect(gate.phase).toBe('whisper')
		w1.resolve()
		await Promise.all([pw1, pl, pw2])
		// The LLM ran first; w2 waiting then ended its phase immediately.
		expect(log).toEqual(['w1', 'releaseWhisper', 'llm', 'unload:m', 'w2'])
		expect(gate.phase).toBe('idle')
	})

	it('LLM requests arriving while whisper waits go after the whisper burst', async () => {
		const { gate, log, unload } = setup()
		const llm = deferred()
		const p1 = gate.runLlm(async () => {
			log.push('llm1')
			await llm.promise
		}, unload('m'))
		await settle()
		const w = deferred()
		const pw = gate.runWhisper(async () => {
			log.push('w')
			await w.promise
		})
		const p2 = gate.runLlm(async () => {
			log.push('llm2')
		}, unload('m'))
		llm.resolve()
		await settle()
		expect(log).toEqual(['releaseWhisper', 'llm1', 'unload:m', 'w'])
		w.resolve()
		await Promise.all([p1, pw, p2])
		expect(log).toEqual(['releaseWhisper', 'llm1', 'unload:m', 'w', 'releaseWhisper', 'llm2'])
	})

	it('a failing request still releases the gate', async () => {
		const { gate, log, unload } = setup()
		await expect(gate.runLlm(async () => Promise.reject(new Error('boom')), unload('m'))).rejects.toThrow('boom')
		await expect(gate.runLlm(async () => 'ok', unload('m'))).resolves.toBe('ok')
		await expect(gate.runWhisper(async () => Promise.reject(new Error('w')))).rejects.toThrow('w')
		expect(gate.phase).toBe('idle')
		expect(log).toEqual(['releaseWhisper', 'unload:m'])
	})

	it('unload and releaseWhisper errors are logged, not thrown', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const gate = createGpuGate({ releaseWhisper: async () => Promise.reject(new Error('x')), idleUnloadMs: 10 })
		await expect(gate.runLlm(async () => 1, { key: 'k', run: async () => Promise.reject(new Error('u')) })).resolves.toBe(1)
		await gate.flush()
		expect(gate.phase).toBe('idle')
		expect(warn).toHaveBeenCalledTimes(2)
		warn.mockRestore()
	})

	it('acquireWhisper holds the slot until released, and release is idempotent', async () => {
		const { gate, log, unload } = setup()
		const release = await gate.acquireWhisper()
		const other = await gate.acquireWhisper()
		const pl = gate.runLlm(async () => {
			log.push('llm')
		}, unload('m'))
		await settle()
		expect(log).toEqual([])
		release()
		release()
		await settle()
		expect(gate.phase).toBe('whisper')
		expect(log).toEqual([])
		other()
		await pl
		expect(log).toEqual(['releaseWhisper', 'llm'])
	})

	it('acquireWhisper waits for the LLM phase to unload', async () => {
		const { gate, log, unload } = setup()
		await gate.runLlm(async () => 1, unload('m'))
		const release = await gate.acquireWhisper()
		expect(log).toEqual(['releaseWhisper', 'unload:m'])
		expect(gate.phase).toBe('whisper')
		release()
		expect(gate.phase).toBe('idle')
	})

	it('uses the real timer by default', async () => {
		vi.useFakeTimers()
		const run = vi.fn(async () => {})
		const gate = createGpuGate({ releaseWhisper: async () => {}, idleUnloadMs: 3000 })
		await gate.runLlm(async () => 1, { key: 'k', run })
		await vi.advanceTimersByTimeAsync(2999)
		expect(run).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(run).toHaveBeenCalledTimes(1)
		vi.useRealTimers()
	})
})
