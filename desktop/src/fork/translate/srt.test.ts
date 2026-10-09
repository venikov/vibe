import { describe, expect, it } from 'vitest'
import { asSrt, type Segment } from '~/lib/transcript'
import { cuesFromSegments, formatSrt, parseSrt } from './srt'

const BOM = String.fromCharCode(0xfeff)

const SAMPLE = `1
00:00:01,000 --> 00:00:02,500
Привет, это Anmeldung.

2
00:00:03,000 --> 00:00:05,000
Первая строка
вторая строка
`

describe('parseSrt', () => {
	it('reads cues and keeps timecodes verbatim', () => {
		expect(parseSrt(SAMPLE)).toEqual([
			{ index: 1, start: '00:00:01,000', end: '00:00:02,500', text: 'Привет, это Anmeldung.' },
			{ index: 2, start: '00:00:03,000', end: '00:00:05,000', text: 'Первая строка\nвторая строка' },
		])
	})

	it('round-trips through formatSrt', () => {
		expect(formatSrt(parseSrt(SAMPLE))).toBe(SAMPLE)
		expect(parseSrt(formatSrt(parseSrt(SAMPLE)))).toEqual(parseSrt(SAMPLE))
	})

	it('tolerates a BOM, CRLF and extra blank lines', () => {
		const messy = BOM + '\r\n\r\n' + SAMPLE.replace(/\n/g, '\r\n').replace('\r\n\r\n2', '\r\n\r\n\r\n\r\n2') + '\r\n\r\n'
		expect(parseSrt(messy)).toEqual(parseSrt(SAMPLE))
	})

	it('renumbers missing and garbled indexes', () => {
		const broken = `00:00:01,000 --> 00:00:02,000
one

7x
00:00:02,000 --> 00:00:03,000
two
42
00:00:03,000 --> 00:00:04,000
three`
		const cues = parseSrt(broken)
		expect(cues.map((cue) => [cue.index, cue.text])).toEqual([
			[1, 'one'],
			[2, 'two'],
			[3, 'three'],
		])
	})

	it('keeps odd but valid timecodes untouched', () => {
		const cues = parseSrt('5\n0:00:01.5 --> 0:00:02.75\nhi\n')
		expect(cues).toEqual([{ index: 1, start: '0:00:01.5', end: '0:00:02.75', text: 'hi' }])
	})

	it('returns nothing for text without cues', () => {
		expect(parseSrt('')).toEqual([])
		expect(parseSrt('just text')).toEqual([])
	})
})

describe('cuesFromSegments', () => {
	const segments: Segment[] = [
		{ start: 100, stop: 250, text: ' Hallo  ', speaker: 0 },
		{ start: 360_000, stop: 360_150, text: 'a --> b' },
	]

	it('times cues exactly like asSrt', () => {
		expect(formatSrt(cuesFromSegments(segments))).toBe(asSrt(segments.map((s) => ({ ...s, speaker: undefined }))))
	})

	it('adds speaker prefixes when labels are given', () => {
		expect(formatSrt(cuesFromSegments(segments, { label: 'Speaker' }))).toBe(asSrt(segments))
		expect(cuesFromSegments(segments, { label: 'Speaker', names: { 0: 'Anna' } })[0].text).toBe('[Anna] Hallo')
	})
})
