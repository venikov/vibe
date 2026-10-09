import { inputBudgetBytes, outputTokens, utf8Bytes, type AiClient } from '~/lib/ai/client'
import { pick } from '~/fork/locale'
import { batchPrompt, cleanAnswer, languageName, marker, NEWLINE_MARK } from './prompts'
import type { Cue } from './srt'

export interface TranslateCuesOptions {
	/** ISO 639-1 code of the target language. */
	target: string
	contextTokens: number
	/** Most cues in one request. */
	batchSize?: number
	signal?: AbortSignal
	/** Cues translated so far, out of all cues with text. */
	onProgress?: (done: number, total: number) => void
}

const DEFAULT_BATCH_SIZE = 30
/** Translated cues shown before a batch, for continuity. */
const CONTEXT_CUES = 3
const LINE_PATTERN = /⟦(\d+)⟧\s*(.*)/

export function encodeCueText(text: string) {
	return text.replace(/\r?\n/g, ` ${NEWLINE_MARK} `)
}

export function decodeCueText(text: string) {
	return text
		.split(new RegExp(`\\s*${NEWLINE_MARK}\\s*`))
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.join('\n')
}

export function abortError(signal?: AbortSignal): Error {
	const reason: unknown = signal?.reason
	if (reason instanceof Error) return reason
	const error = new Error(pick('Перевод отменён', 'Translation cancelled'))
	error.name = 'AbortError'
	return error
}

export function isAbortError(error: unknown) {
	return error instanceof Error && error.name === 'AbortError'
}

/** `client.ask`, but a cancel returns at once instead of waiting for the model to finish. */
export function askAbortable(client: AiClient, prompt: string, signal?: AbortSignal): Promise<string> {
	if (signal?.aborted) return Promise.reject(abortError(signal))
	if (!signal) return client.ask(prompt)
	return new Promise<string>((resolve, reject) => {
		const onAbort = () => reject(abortError(signal))
		signal.addEventListener('abort', onAbort, { once: true })
		client.ask(prompt).then(
			(answer) => {
				signal.removeEventListener('abort', onAbort)
				resolve(answer)
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort)
				reject(error instanceof Error ? error : new Error(String(error)))
			},
		)
	})
}

/**
 * The marked lines of an answer, by id; `null` unless it holds exactly the requested ids, once
 * each, with text. Stray prose, fences and blank lines around them are ignored.
 */
export function parseBatchAnswer(answer: string, ids: number[]): Map<number, string> | null {
	const wanted = new Set(ids)
	const found = new Map<number, string>()
	for (const line of cleanAnswer(answer).split(/\r?\n/)) {
		const match = LINE_PATTERN.exec(line)
		if (!match) continue
		const id = Number(match[1])
		if (!wanted.has(id) || found.has(id)) return null
		const text = match[2].replace(/`+\s*$/, '').trim()
		if (!text) return null
		found.set(id, text)
	}
	return found.size === wanted.size ? found : null
}

interface Item {
	/** 1-based position in the source list: the marker the model sees. */
	id: number
	encoded: string
}

/** Greedy batches capped by count and by bytes; a cue too big for any batch goes alone. */
export function planBatches<T extends { encoded: string }>(items: T[], batchSize: number, maxBytes: number): T[][] {
	const batches: T[][] = []
	let current: T[] = []
	let size = 0
	for (const item of items) {
		const bytes = utf8Bytes(item.encoded) + 8
		if (current.length > 0 && (current.length >= batchSize || size + bytes > maxBytes)) {
			batches.push(current)
			current = []
			size = 0
		}
		current.push(item)
		size += bytes
	}
	if (current.length > 0) batches.push(current)
	return batches
}

/**
 * Translate subtitles in numbered batches. A batch whose answer lost, added or reordered lines
 * is asked once more, then split in halves until each half comes back whole; one cue that still
 * fails stops the job with an error. Timecodes and indexes are never touched.
 */
export async function translateCues(client: AiClient, cues: Cue[], opts: TranslateCuesOptions): Promise<Cue[]> {
	const { signal, onProgress } = opts
	const targetName = languageName(opts.target)
	const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE)

	const items: Item[] = []
	cues.forEach((cue, i) => {
		if (cue.text.trim()) items.push({ id: i + 1, encoded: encodeCueText(cue.text.trim()) })
	})
	const total = items.length
	const translated = new Map<number, string>()
	onProgress?.(0, total)
	if (total === 0) return cues.map((cue) => ({ ...cue }))

	const overhead = utf8Bytes(batchPrompt([], targetName, []))
	const budget = inputBudgetBytes(opts.contextTokens) - overhead
	const contextBytes = Math.max(0, Math.min(1_500, Math.floor(budget / 8)))
	// The answer is about as long as the question; keep it well inside the output ceiling.
	const maxBytes = Math.max(1, Math.min(budget - contextBytes, outputTokens(opts.contextTokens) * 2))

	function contextFor(batch: Item[]) {
		const lines: string[] = []
		let bytes = 0
		const before = items.filter((item) => item.id < batch[0].id && translated.has(item.id)).slice(-CONTEXT_CUES)
		for (const item of before.reverse()) {
			const line = encodeCueText(translated.get(item.id)!)
			bytes += utf8Bytes(line) + 3
			if (bytes > contextBytes) break
			lines.unshift(line)
		}
		return lines
	}

	async function attempt(batch: Item[]) {
		const prompt = batchPrompt(
			batch.map((item) => `${marker(item.id)} ${item.encoded}`),
			targetName,
			contextFor(batch),
		)
		const answer = await askAbortable(client, prompt, signal)
		return parseBatchAnswer(
			answer,
			batch.map((item) => item.id),
		)
	}

	async function run(batch: Item[]): Promise<void> {
		const result = (await attempt(batch)) ?? (await attempt(batch))
		if (result) {
			for (const [id, text] of result) translated.set(id, decodeCueText(text))
			onProgress?.(translated.size, total)
			return
		}
		if (batch.length === 1) {
			const cue = cues[batch[0].id - 1]
			throw new Error(
				pick(
					`Модель не смогла перевести субтитр №${cue.index} (${cue.start}): ответ пришёл без нужной строки. Попробуйте ещё раз или выберите другую модель.`,
					`The model could not translate subtitle #${cue.index} (${cue.start}): its answer lacked that line. Try again or choose another model.`,
				),
			)
		}
		const half = Math.ceil(batch.length / 2)
		await run(batch.slice(0, half))
		await run(batch.slice(half))
	}

	for (const batch of planBatches(items, batchSize, maxBytes)) {
		if (signal?.aborted) throw abortError(signal)
		await run(batch)
	}

	return cues.map((cue, i) => ({ ...cue, text: translated.get(i + 1) ?? cue.text }))
}
