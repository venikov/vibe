import { fetch } from '@tauri-apps/plugin-http'
import type { AiConnection } from '~/lib/ai/config'
import { FORK_OLLAMA_PREFERRED } from '../defaults'
import { pick } from '../locale'

/** Ollama is not running, or nothing answers at the configured address. */
export class OllamaUnavailableError extends Error {
	constructor(
		readonly baseUrl: string,
		options?: { cause?: unknown },
	) {
		super(
			pick(
				`Ollama не запущен или недоступен по адресу ${baseUrl}. Запустите Ollama и нажмите «Обновить».`,
				`Ollama is not running or not reachable at ${baseUrl}. Start Ollama and click “Refresh”.`,
			),
		)
		this.name = 'OllamaUnavailableError'
		if (options && 'cause' in options) (this as { cause?: unknown }).cause = options.cause
	}
}

export interface OllamaModelInfo {
	name: string
	/** Bytes on disk. */
	size: number
	parameterSize?: string
	quantization?: string
}

export function trimBase(baseUrl: string) {
	return baseUrl.replace(/\/+$/, '')
}

/** Ollama checks Origin; the plugin's unsafe-headers feature lets us set it. */
export const OLLAMA_HEADERS = { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1' }

/** How long a model list is trusted before asking Ollama again. */
const CACHE_MS = 60_000
const cache = new Map<string, { at: number; names: string[] }>()

/** Forget cached model lists (all, or one address). */
export function clearModelCache(baseUrl?: string) {
	if (baseUrl === undefined) cache.clear()
	else cache.delete(trimBase(baseUrl))
}

/** Installed models, as `ollama list` shows them. Also refreshes the cache `resolveModelFor` uses. */
export async function listOllamaModels(baseUrl: string): Promise<OllamaModelInfo[]> {
	const base = trimBase(baseUrl)
	let response: Response
	try {
		response = await fetch(`${base}/api/tags`, { method: 'GET', headers: { Origin: 'http://127.0.0.1' } })
	} catch (error) {
		throw new OllamaUnavailableError(base, { cause: error })
	}
	if (!response.ok) throw new Error(`Ollama: ${response.status} ${response.statusText}`.trim())
	const json = (await response.json()) as {
		models?: Array<{ name?: string; model?: string; size?: number; details?: { parameter_size?: string; quantization_level?: string } }>
	}
	const models = (json?.models ?? [])
		.map((model) => ({
			name: model.name ?? model.model ?? '',
			size: model.size ?? 0,
			parameterSize: model.details?.parameter_size || undefined,
			quantization: model.details?.quantization_level || undefined,
		}))
		.filter((model) => model.name)
	cache.set(base, { at: Date.now(), names: models.map((model) => model.name) })
	return models
}

/** `llama3` and `llama3:latest` are the same model. */
function canonical(name: string) {
	const trimmed = name.trim()
	return trimmed.includes(':') ? trimmed : `${trimmed}:latest`
}

function findInstalled(wanted: string, names: string[]) {
	if (!wanted.trim()) return undefined
	const key = canonical(wanted)
	return names.find((name) => canonical(name) === key)
}

/**
 * The model to use: the saved one if installed, else the preferred default if installed,
 * else the first installed model. An empty saved value means "automatic".
 */
export function resolveOllamaModel(saved: string, names: string[]): string {
	if (names.length === 0) {
		throw new Error(
			pick(
				`В Ollama нет ни одной модели. Установите модель: ollama pull ${FORK_OLLAMA_PREFERRED}`,
				`Ollama has no models installed. Install one: ollama pull ${FORK_OLLAMA_PREFERRED}`,
			),
		)
	}
	return findInstalled(saved, names) ?? findInstalled(FORK_OLLAMA_PREFERRED, names) ?? names[0]
}

/** Whether `saved` names an installed model (with `:latest` equivalence). */
export function isInstalled(saved: string, names: string[]) {
	return findInstalled(saved, names) !== undefined
}

/** The model a request should use, listing installed models at most once a minute per address. */
export async function resolveModelFor(connection: Pick<AiConnection, 'ollamaBaseUrl' | 'model'>): Promise<string> {
	const base = trimBase(connection.ollamaBaseUrl)
	const cached = cache.get(base)
	const names = cached && Date.now() - cached.at < CACHE_MS ? cached.names : (await listOllamaModels(base)).map((model) => model.name)
	return resolveOllamaModel(connection.model, names)
}

/** Ask Ollama to drop the model from VRAM now. */
export async function unloadOllamaModel(baseUrl: string, model: string): Promise<void> {
	const base = trimBase(baseUrl)
	let response: Response
	try {
		response = await fetch(`${base}/api/generate`, {
			method: 'POST',
			headers: OLLAMA_HEADERS,
			body: JSON.stringify({ model, keep_alive: 0 }),
		})
	} catch (error) {
		throw new OllamaUnavailableError(base, { cause: error })
	}
	if (!response.ok) throw new Error(`Ollama unload ${model}: ${response.status} ${response.statusText}`.trim())
}

/** "21.4 ГБ" / "21.4 GB". */
export function formatModelSize(bytes: number) {
	return `${(bytes / 1e9).toFixed(1)} ${pick('ГБ', 'GB')}`
}
