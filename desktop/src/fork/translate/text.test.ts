import { describe, expect, it, vi } from 'vitest'
import type { AiClient } from '~/lib/ai/client'
import { chunkText, translateText } from './text'

function fakeClient() {
	const prompts: string[] = []
	const client: AiClient = {
		ask: vi.fn(async (prompt: string) => {
			prompts.push(prompt)
			return '<think></think>```\n' + prompt.split('Text:\n')[1].toUpperCase() + '\n```'
		}),
		stream: vi.fn(),
	}
	return { client, prompts }
}

describe('chunkText', () => {
	it('groups paragraphs and keeps their separators', () => {
		const chunks = chunkText('a\n\nb\n\n\nc', 1_000, 40)
		expect(chunks).toEqual([{ before: '', text: 'a\n\nb\n\n\nc' }])
	})
	it('cuts by bytes between paragraphs', () => {
		expect(chunkText('aaaa\n\nbbbb\n\ncccc', 10, 40).map((c) => c.text)).toEqual(['aaaa\n\nbbbb', 'cccc'])
	})
	it('cuts by line count, splitting a long paragraph between lines', () => {
		const long = Array.from({ length: 5 }, (_, i) => `l${i}`).join('\n')
		const chunks = chunkText(long, 1_000, 2)
		expect(chunks.map((c) => c.text)).toEqual(['l0\nl1', 'l2\nl3', 'l4'])
		expect(chunks.map((c) => c.before)).toEqual(['', '\n', '\n'])
	})
})

describe('translateText', () => {
	it('translates in one piece and keeps outer whitespace', async () => {
		const { client } = fakeClient()
		expect(await translateText(client, '\n  hallo\n\nwelt\n', { target: 'en', contextTokens: 8192 })).toBe('\n  HALLO\n\nWELT\n')
	})

	it('translates piece by piece with the original separators', async () => {
		const { client, prompts } = fakeClient()
		const progress: number[] = []
		const out = await translateText(client, 'a1\na2\n\n\nb1\nb2\n\nc1', {
			target: 'de',
			contextTokens: 8192,
			maxLines: 2,
			onProgress: (done) => progress.push(done),
		})
		expect(out).toBe('A1\nA2\n\n\nB1\nB2\n\nC1')
		expect(prompts).toHaveLength(3)
		expect(prompts[0]).toContain('into German')
		expect(prompts[1]).toContain('A1\nA2')
		expect(progress).toEqual([0, 1, 2, 3])
	})

	it('returns blank text untouched', async () => {
		const { client } = fakeClient()
		expect(await translateText(client, '  \n', { target: 'de', contextTokens: 8192 })).toBe('  \n')
		expect(client.ask).not.toHaveBeenCalled()
	})

	it('stops when aborted', async () => {
		const { client } = fakeClient()
		const controller = new AbortController()
		controller.abort()
		await expect(translateText(client, 'x', { target: 'de', contextTokens: 8192, signal: controller.signal })).rejects.toMatchObject({
			name: 'AbortError',
		})
	})
})
