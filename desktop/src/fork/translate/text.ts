import { inputBudgetBytes, outputTokens, utf8Bytes, type AiClient } from '~/lib/ai/client'
import { abortError, askAbortable } from './batch'
import { cleanAnswer, languageName, textPrompt } from './prompts'

export interface TranslateTextOptions {
	target: string
	contextTokens: number
	signal?: AbortSignal
	/** Most lines in one request. */
	maxLines?: number
	/** Pieces translated so far, out of all pieces. */
	onProgress?: (done: number, total: number) => void
}

const DEFAULT_MAX_LINES = 40
/** Tail of the previous translation handed to the next piece, for continuity. */
const CONTEXT_CHARS = 300

export interface Unit {
	/** What stood before this unit in the source: a paragraph break, a line break, or nothing. */
	before: string
	text: string
}

function lineCount(text: string) {
	return text.split('\n').length
}

/** Paragraphs, with any paragraph too big for one request cut further between its lines. */
function units(body: string, maxBytes: number, maxLines: number): Unit[] {
	const parts = body.split(/(\n[ \t]*\n\s*)/)
	const result: Unit[] = []
	for (let i = 0; i < parts.length; i += 2) {
		const before = i === 0 ? '' : parts[i - 1]
		const paragraph = parts[i]
		if (utf8Bytes(paragraph) <= maxBytes && lineCount(paragraph) <= maxLines) {
			result.push({ before, text: paragraph })
			continue
		}
		paragraph.split('\n').forEach((line, j) => result.push({ before: j === 0 ? before : '\n', text: line }))
	}
	return result
}

/** Consecutive units grouped into pieces that each fit one request. */
export function chunkText(body: string, maxBytes: number, maxLines: number): Unit[] {
	const chunks: Unit[] = []
	let current: Unit | null = null
	for (const unit of units(body, maxBytes, maxLines)) {
		if (current) {
			const joined = current.text + unit.before + unit.text
			if (utf8Bytes(joined) <= maxBytes && lineCount(joined) <= maxLines) {
				current.text = joined
				continue
			}
			chunks.push(current)
		}
		current = { ...unit }
	}
	if (current) chunks.push(current)
	return chunks
}

/**
 * Translate plain text piece by piece, cutting between paragraphs (or between lines of a very
 * long one), and put it back together with the source's own separators and outer whitespace.
 */
export async function translateText(client: AiClient, text: string, opts: TranslateTextOptions): Promise<string> {
	const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
	const lead = /^\s*/.exec(normalized)![0]
	const body = normalized.trim()
	const trail = /\s*$/.exec(normalized)![0]
	if (!body) {
		opts.onProgress?.(0, 0)
		return text
	}

	const targetName = languageName(opts.target)
	const overhead = utf8Bytes(textPrompt('', targetName, 'x'.repeat(CONTEXT_CHARS * 2)))
	const maxBytes = Math.max(1, Math.min(inputBudgetBytes(opts.contextTokens) - overhead, outputTokens(opts.contextTokens) * 2))
	const chunks = chunkText(body, maxBytes, opts.maxLines ?? DEFAULT_MAX_LINES)

	let output = ''
	let context = ''
	opts.onProgress?.(0, chunks.length)
	for (const [i, chunk] of chunks.entries()) {
		if (opts.signal?.aborted) throw abortError(opts.signal)
		const answer = cleanAnswer(await askAbortable(client, textPrompt(chunk.text, targetName, context), opts.signal))
		output += (i === 0 ? '' : chunk.before) + answer
		context = answer.slice(-CONTEXT_CHARS)
		opts.onProgress?.(i + 1, chunks.length)
	}
	return lead + output + trail
}
