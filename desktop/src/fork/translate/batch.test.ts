import { describe, expect, it, vi } from 'vitest'
import type { AiClient } from '~/lib/ai/client'
import { decodeCueText, encodeCueText, parseBatchAnswer, planBatches, translateCues } from './batch'
import type { Cue } from './srt'

/** Lines to translate in a prompt, as [id, text]. */
function requested(prompt: string): Array<[number, string]> {
	const body = prompt.split('Lines to translate:\n')[1] ?? ''
	return body
		.split('\n')
		.map((line) => /^⟦(\d+)⟧ (.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.map((m) => [Number(m[1]), m[2]])
}

/** A fake model: upper-cases each line; `mangle` may break the answer for a given call. */
function fakeClient(mangle?: (lines: Array<[number, string]>, call: number) => string | undefined) {
	let call = 0
	const prompts: string[] = []
	const client: AiClient = {
		ask: vi.fn(async (prompt: string) => {
			prompts.push(prompt)
			const lines = requested(prompt)
			const broken = mangle?.(lines, call++)
			if (broken !== undefined) return broken
			return lines.map(([id, text]) => `⟦${id}⟧ ${text.toUpperCase()}`).join('\n')
		}),
		stream: vi.fn(),
	}
	return { client, prompts }
}

function cues(...texts: string[]): Cue[] {
	return texts.map((text, i) => ({ index: i + 1, start: `00:00:0${i},000`, end: `00:00:0${i},900`, text }))
}

const OPTS = { target: 'de', contextTokens: 8192 }

describe('encode/decode', () => {
	it('round-trips line breaks', () => {
		expect(encodeCueText('a\nb')).toBe('a ⏎ b')
		expect(decodeCueText('A ⏎ B')).toBe('A\nB')
		expect(decodeCueText('A⏎B ⏎')).toBe('A\nB')
	})
})

describe('parseBatchAnswer', () => {
	it('ignores fences, prose and blank lines', () => {
		const answer = 'Here you go:\n```\n⟦1⟧ eins\n\n⟦2⟧ zwei\n```'
		expect(parseBatchAnswer(answer, [1, 2])).toEqual(
			new Map([
				[1, 'eins'],
				[2, 'zwei'],
			]),
		)
	})
	it('rejects missing, extra, duplicate and empty lines', () => {
		expect(parseBatchAnswer('⟦1⟧ a', [1, 2])).toBeNull()
		expect(parseBatchAnswer('⟦1⟧ a\n⟦2⟧ b\n⟦3⟧ c', [1, 2])).toBeNull()
		expect(parseBatchAnswer('⟦1⟧ a\n⟦1⟧ b', [1, 2])).toBeNull()
		expect(parseBatchAnswer('⟦1⟧ a\n⟦2⟧', [1, 2])).toBeNull()
	})
	it('drops thinking blocks', () => {
		expect(parseBatchAnswer('<think>⟦9⟧ x</think>⟦1⟧ a', [1])).toEqual(new Map([[1, 'a']]))
	})
})

describe('planBatches', () => {
	it('caps by count and by bytes', () => {
		const items = Array.from({ length: 7 }, () => ({ encoded: 'xxxxxxxxxx' }))
		expect(planBatches(items, 3, 10_000).map((b) => b.length)).toEqual([3, 3, 1])
		expect(planBatches(items, 30, 40).map((b) => b.length)).toEqual([2, 2, 2, 1])
		expect(planBatches([{ encoded: 'x'.repeat(100) }], 30, 10).length).toBe(1)
	})
})

describe('translateCues', () => {
	it('translates and keeps index and timecodes', async () => {
		const { client } = fakeClient()
		const source = cues('hallo', 'welt')
		const progress: Array<[number, number]> = []
		const out = await translateCues(client, source, { ...OPTS, onProgress: (d, t) => progress.push([d, t]) })
		expect(out).toEqual(source.map((cue) => ({ ...cue, text: cue.text.toUpperCase() })))
		expect(progress[progress.length - 1]).toEqual([2, 2])
	})

	it('accepts a shuffled answer', async () => {
		const { client } = fakeClient((lines) =>
			[...lines]
				.reverse()
				.map(([id, text]) => `⟦${id}⟧ ${text}!`)
				.join('\n'),
		)
		const out = await translateCues(client, cues('a', 'b', 'c'), OPTS)
		expect(out.map((cue) => cue.text)).toEqual(['a!', 'b!', 'c!'])
	})

	it('keeps line breaks inside a cue', async () => {
		const { client, prompts } = fakeClient()
		const out = await translateCues(client, cues('erste\nzweite'), OPTS)
		expect(prompts[0]).toContain('⟦1⟧ erste ⏎ zweite')
		expect(out[0].text).toBe('ERSTE\nZWEITE')
	})

	it('retries once when a line is missing', async () => {
		const { client } = fakeClient((lines, call) => (call === 0 ? `⟦${lines[0][0]}⟧ x` : undefined))
		const out = await translateCues(client, cues('a', 'b'), OPTS)
		expect(out.map((cue) => cue.text)).toEqual(['A', 'B'])
		expect(client.ask).toHaveBeenCalledTimes(2)
	})

	it('retries when an extra line appears', async () => {
		const { client } = fakeClient((lines, call) => (call === 0 ? lines.map(([id]) => `⟦${id}⟧ x`).join('\n') + '\n⟦99⟧ y' : undefined))
		const out = await translateCues(client, cues('a', 'b'), OPTS)
		expect(out.map((cue) => cue.text)).toEqual(['A', 'B'])
	})

	it('splits a batch that keeps failing', async () => {
		// Any batch of more than one line comes back merged; single lines work.
		const { client } = fakeClient((lines) => (lines.length > 1 ? `⟦${lines[0][0]}⟧ merged` : undefined))
		const out = await translateCues(client, cues('a', 'b', 'c', 'd'), OPTS)
		expect(out.map((cue) => cue.text)).toEqual(['A', 'B', 'C', 'D'])
	})

	it('throws a clear error when a single cue keeps failing', async () => {
		const { client } = fakeClient((lines) => (lines.some(([, text]) => text === 'bad') ? 'nonsense' : undefined))
		await expect(translateCues(client, cues('ok', 'bad'), OPTS)).rejects.toThrow(/#2|№2/)
	})

	it('passes earlier translations as context', async () => {
		const { client, prompts } = fakeClient()
		await translateCues(client, cues('a', 'b', 'c'), { ...OPTS, batchSize: 2 })
		expect(prompts[1]).toContain('> A\n> B')
		expect(requested(prompts[1])).toEqual([[3, 'c']])
	})

	it('skips empty cues and leaves them as they are', async () => {
		const { client } = fakeClient()
		const out = await translateCues(client, cues('a', '  ', 'b'), OPTS)
		expect(out.map((cue) => cue.text)).toEqual(['A', '  ', 'B'])
	})

	it('stops between requests when aborted', async () => {
		const controller = new AbortController()
		const { client } = fakeClient()
		const promise = translateCues(client, cues('a', 'b', 'c'), {
			...OPTS,
			batchSize: 1,
			signal: controller.signal,
			onProgress: (done) => done === 1 && controller.abort(),
		})
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
		expect(client.ask).toHaveBeenCalledTimes(1)
	})

	it('cancels a request in flight', async () => {
		const controller = new AbortController()
		const client: AiClient = { ask: () => new Promise(() => {}), stream: vi.fn() }
		const promise = translateCues(client, cues('a'), { ...OPTS, signal: controller.signal })
		controller.abort()
		await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
	})
})
