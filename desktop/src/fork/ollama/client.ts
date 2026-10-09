import { fetch } from '@tauri-apps/plugin-http'
// Specific files, not '~/lib/ai': lib/ai/client.ts imports this module.
import { outputTokens, type AiClient } from '~/lib/ai/client'
import type { AiConnection } from '~/lib/ai/config'
import { FORK_OLLAMA_KEEP_ALIVE } from '../defaults'
import { gpuGate as defaultGate, type GpuGate } from '../gpu-gate'
import { OLLAMA_HEADERS, OllamaUnavailableError, resolveModelFor, trimBase, unloadOllamaModel } from './models'

/** Read an NDJSON body line by line. */
async function readLines(response: Response, onLine: (line: string) => void) {
	const reader = response.body?.getReader()
	if (!reader) {
		onLine(await response.text())
		return
	}
	const decoder = new TextDecoder()
	let buffer = ''
	for (;;) {
		const { value, done } = await reader.read()
		if (done) break
		buffer += decoder.decode(value, { stream: true })
		let newline = buffer.indexOf('\n')
		while (newline >= 0) {
			onLine(buffer.slice(0, newline).replace(/\r$/, ''))
			buffer = buffer.slice(newline + 1)
			newline = buffer.indexOf('\n')
		}
	}
	if (buffer) onLine(buffer)
}

async function failure(response: Response) {
	let detail = ''
	try {
		const text = await response.text()
		try {
			const json = JSON.parse(text)
			detail = json?.error?.message ?? json?.error ?? text
		} catch {
			detail = text
		}
	} catch {
		// no body
	}
	return new Error(`Ollama: ${response.status} ${response.statusText}${detail ? ` · ${String(detail).slice(0, 300)}` : ''}`)
}

/**
 * The fork's Ollama client: picks an installed model (saved, preferred or first), turns
 * thinking off, and runs every request through the GPU gate so whisper and the model never
 * hold VRAM at the same time.
 */
export class LocalOllama implements AiClient {
	constructor(
		private connection: AiConnection,
		private gate: GpuGate = defaultGate,
	) {}

	private body(model: string, prompt: string, stream: boolean) {
		return JSON.stringify({
			model,
			prompt,
			stream,
			think: false,
			keep_alive: FORK_OLLAMA_KEEP_ALIVE,
			options: { num_ctx: this.connection.contextTokens, num_predict: outputTokens(this.connection.contextTokens) },
		})
	}

	/** Resolve the model, then run one request inside the gate's LLM phase. */
	private async gated<T>(request: (base: string, model: string) => Promise<T>): Promise<T> {
		const base = trimBase(this.connection.ollamaBaseUrl)
		const model = await resolveModelFor(this.connection)
		return this.gate.runLlm(() => request(base, model), { key: `${base}|${model}`, run: () => unloadOllamaModel(base, model) })
	}

	private async post(base: string, model: string, prompt: string, stream: boolean) {
		let response: Response
		try {
			response = await fetch(`${base}/api/generate`, { method: 'POST', headers: OLLAMA_HEADERS, body: this.body(model, prompt, stream) })
		} catch (error) {
			throw new OllamaUnavailableError(base, { cause: error })
		}
		if (!response.ok) throw await failure(response)
		return response
	}

	ask(prompt: string): Promise<string> {
		return this.gated(async (base, model) => {
			const response = await this.post(base, model, prompt, false)
			return (await response.json())?.response ?? ''
		})
	}

	stream(prompt: string, onToken: (text: string) => void): Promise<string> {
		return this.gated(async (base, model) => {
			const response = await this.post(base, model, prompt, true)
			let text = ''
			await readLines(response, (line) => {
				if (!line.trim()) return
				try {
					const piece = JSON.parse(line)?.response
					if (piece) {
						text += piece
						onToken(piece)
					}
				} catch {
					// a partial line; the next read completes it
				}
			})
			return text
		})
	}
}
