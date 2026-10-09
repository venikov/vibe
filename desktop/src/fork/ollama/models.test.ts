import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearModelCache, isInstalled, listOllamaModels, OllamaUnavailableError, resolveModelFor, resolveOllamaModel, unloadOllamaModel } from './models'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))

afterEach(() => {
	fetchMock.mockReset()
	clearModelCache()
})

const tags = (names: string[]) => ({
	ok: true,
	status: 200,
	statusText: 'OK',
	json: async () => ({ models: names.map((name) => ({ name, size: 2e10, details: { parameter_size: '35B', quantization_level: 'Q4_K_M' } })) }),
})

describe('resolveOllamaModel', () => {
	it('keeps the saved model when installed', () => {
		expect(resolveOllamaModel('llama3:8b', ['qwen3.5:35b', 'llama3:8b'])).toBe('llama3:8b')
	})

	it('treats name and name:latest as the same model', () => {
		expect(resolveOllamaModel('llama3', ['qwen3.5:35b', 'llama3:latest'])).toBe('llama3:latest')
		expect(resolveOllamaModel('llama3:latest', ['llama3'])).toBe('llama3')
		expect(isInstalled('llama3', ['llama3:latest'])).toBe(true)
		expect(isInstalled('llama3:8b', ['llama3:latest'])).toBe(false)
	})

	it('falls back to the preferred model, then the first', () => {
		expect(resolveOllamaModel('', ['a:1', 'qwen3.5:35b'])).toBe('qwen3.5:35b')
		expect(resolveOllamaModel('gone:1', ['a:1', 'qwen3.5:35b'])).toBe('qwen3.5:35b')
		expect(resolveOllamaModel('gone:1', ['a:1', 'b:2'])).toBe('a:1')
		expect(resolveOllamaModel('', ['b:2'])).toBe('b:2')
	})

	it('throws a clear error when nothing is installed', () => {
		expect(() => resolveOllamaModel('', [])).toThrow(/ollama pull qwen3\.5:35b/)
	})
})

describe('listOllamaModels', () => {
	it('lists models with details and sends the Origin header', async () => {
		fetchMock.mockResolvedValue(tags(['qwen3.5:35b']))
		const models = await listOllamaModels('http://localhost:11434/')
		expect(models).toEqual([{ name: 'qwen3.5:35b', size: 2e10, parameterSize: '35B', quantization: 'Q4_K_M' }])
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/tags')
		expect(fetchMock.mock.calls[0][1].headers.Origin).toBe('http://127.0.0.1')
	})

	it('maps a network error to OllamaUnavailableError', async () => {
		fetchMock.mockRejectedValue(new Error('error sending request'))
		const error = await listOllamaModels('http://localhost:11434').catch((e) => e)
		expect(error).toBeInstanceOf(OllamaUnavailableError)
		expect(error.message).toContain('http://localhost:11434')
	})

	it('reports a non-OK status', async () => {
		fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error' })
		const error = await listOllamaModels('http://localhost:11434').catch((e) => e)
		expect(error).not.toBeInstanceOf(OllamaUnavailableError)
		expect(error.message).toContain('500')
	})
})

describe('resolveModelFor', () => {
	it('lists once per address within the cache window; empty model means auto', async () => {
		fetchMock.mockResolvedValue(tags(['a:1', 'qwen3.5:35b']))
		const connection = { ollamaBaseUrl: 'http://localhost:11434', model: '' }
		expect(await resolveModelFor(connection)).toBe('qwen3.5:35b')
		expect(await resolveModelFor({ ...connection, model: 'a:1' })).toBe('a:1')
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await resolveModelFor({ ...connection, ollamaBaseUrl: 'http://other:11434' })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

describe('unloadOllamaModel', () => {
	it('posts keep_alive 0', async () => {
		fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: 'OK' })
		await unloadOllamaModel('http://localhost:11434', 'qwen3.5:35b')
		expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/generate')
		expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ model: 'qwen3.5:35b', keep_alive: 0 })
	})
})
