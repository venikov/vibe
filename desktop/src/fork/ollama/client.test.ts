import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_AI } from '~/lib/ai/config'
import { createGpuGate } from '../gpu-gate'
import { LocalOllama } from './client'
import { clearModelCache, OllamaUnavailableError } from './models'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))
const invokeMock = vi.fn(async () => undefined)
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...(args as [])) }))

afterEach(() => {
	fetchMock.mockReset()
	invokeMock.mockClear()
	clearModelCache()
})

const connection = { ...DEFAULT_AI.connection, platform: 'ollama' as const, model: '', ollamaBaseUrl: 'http://localhost:11434/', contextTokens: 8192 }

function streamResponse(lines: string[]) {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const line of lines) controller.enqueue(encoder.encode(line + '\n'))
			controller.close()
		},
	})
	return { ok: true, status: 200, statusText: 'OK', body, text: async () => lines.join('\n'), json: async () => ({}) }
}

/** Answer /api/tags with the installed models, /api/generate with `generate`. */
function route(generate: () => unknown, names = ['a:1', 'qwen3.5:35b']) {
	fetchMock.mockImplementation(async (url: string, init: { body?: string }) => {
		if (url.endsWith('/api/tags')) return { ok: true, json: async () => ({ models: names.map((name) => ({ name, size: 1 })) }) }
		if (init?.body && JSON.parse(init.body).keep_alive === 0) return { ok: true }
		return generate()
	})
}

const generateCalls = () => fetchMock.mock.calls.filter(([url, init]) => url.endsWith('/api/generate') && JSON.parse(init.body).prompt !== undefined)

describe('LocalOllama', () => {
	it('asks with think:false, keep_alive and the resolved model', async () => {
		route(() => ({ ok: true, json: async () => ({ response: 'OK' }) }))
		const gate = createGpuGate({ releaseWhisper: vi.fn(async () => {}), idleUnloadMs: 10 })
		expect(await new LocalOllama(connection, gate).ask('hi')).toBe('OK')
		const [url, init] = generateCalls()[0]
		expect(url).toBe('http://localhost:11434/api/generate')
		expect(init.headers.Origin).toBe('http://127.0.0.1')
		expect(JSON.parse(init.body)).toEqual({
			model: 'qwen3.5:35b',
			prompt: 'hi',
			stream: false,
			think: false,
			keep_alive: '10m',
			options: { num_ctx: 8192, num_predict: 2048 },
		})
	})

	it('streams NDJSON', async () => {
		route(() => streamResponse(['{"response":"Hel"}', '{"response":"lo"}', '{"done":true}']))
		const gate = createGpuGate({ releaseWhisper: async () => {}, idleUnloadMs: 10 })
		const tokens: string[] = []
		expect(await new LocalOllama({ ...connection, model: 'a:1' }, gate).stream('p', (t) => tokens.push(t))).toBe('Hello')
		expect(tokens).toEqual(['Hel', 'lo'])
		expect(JSON.parse(generateCalls()[0][1].body)).toMatchObject({ model: 'a:1', stream: true, think: false })
	})

	it('runs through the gate and unloads the model when the phase ends', async () => {
		route(() => ({ ok: true, json: async () => ({ response: 'x' }) }))
		const gate = createGpuGate({ releaseWhisper: async () => {}, idleUnloadMs: 10 })
		const runLlm = vi.spyOn(gate, 'runLlm')
		await new LocalOllama(connection, gate).ask('hi')
		expect(runLlm).toHaveBeenCalledTimes(1)
		expect(runLlm.mock.calls[0][1].key).toBe('http://localhost:11434|qwen3.5:35b')
		await gate.flush()
		const unload = fetchMock.mock.calls.find(([, init]) => init?.body && JSON.parse(init.body).keep_alive === 0)
		expect(JSON.parse(unload![1].body)).toEqual({ model: 'qwen3.5:35b', keep_alive: 0 })
	})

	it('uses the default gate, which stops vibe-server first', async () => {
		route(() => ({ ok: true, json: async () => ({ response: 'x' }) }))
		await new LocalOllama(connection).ask('hi')
		expect(invokeMock).toHaveBeenCalledWith('stop_api_server')
	})

	it('maps a network error to OllamaUnavailableError', async () => {
		fetchMock.mockRejectedValue(new Error('connection refused'))
		const gate = createGpuGate({ releaseWhisper: async () => {}, idleUnloadMs: 10 })
		await expect(new LocalOllama(connection, gate).ask('hi')).rejects.toBeInstanceOf(OllamaUnavailableError)
	})

	it('reports Ollama errors with detail', async () => {
		route(() => ({ ok: false, status: 404, statusText: 'Not Found', text: async () => '{"error":"model not found"}' }))
		const gate = createGpuGate({ releaseWhisper: async () => {}, idleUnloadMs: 10 })
		await expect(new LocalOllama(connection, gate).ask('hi')).rejects.toThrow('Ollama: 404 Not Found · model not found')
	})
})
