import { formatTimestamp, speakerName, type Segment, type SpeakerNames } from '~/lib/transcript'

/** One subtitle. Timecodes are kept as the source wrote them, so translating never moves a cue. */
export interface Cue {
	index: number
	start: string
	end: string
	text: string
}

const TIMECODE = /^\s*(\d[\d:.,]*)\s*-->\s*(\d[\d:.,]*)/
const DIGITS = /^\s*\d+\s*$/

/**
 * Read an SRT file, forgiving the usual damage: a BOM, CRLF, runs of blank lines, missing or
 * garbled index lines. Cues are renumbered from 1; blank lines inside a cue's text are dropped.
 */
export function parseSrt(text: string): Cue[] {
	const lines = text
		.replace(/^\uFEFF/, '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
	const timecodes: number[] = []
	lines.forEach((line, i) => {
		if (TIMECODE.test(line)) timecodes.push(i)
	})

	const cues: Cue[] = []
	timecodes.forEach((at, n) => {
		const match = TIMECODE.exec(lines[at])!
		const next = timecodes[n + 1] ?? lines.length
		let last = next - 1
		if (n + 1 < timecodes.length && last > at) {
			// The line right above the next timecode is that cue's index: digits, or anything
			// standing alone after a blank line (a garbled index).
			const candidate = lines[last]
			const alone = last - 1 > at && lines[last - 1].trim() === ''
			if (candidate.trim() !== '' && (DIGITS.test(candidate) || alone)) last -= 1
		}
		const body = lines
			.slice(at + 1, last + 1)
			.map((line) => line.trimEnd())
			.filter((line) => line.trim() !== '')
		cues.push({ index: cues.length + 1, start: match[1], end: match[2], text: body.join('\n') })
	})
	return cues
}

/** Write cues back out, the same shape `asSrt` produces. */
export function formatSrt(cues: Cue[]): string {
	return cues.map((cue) => `${cue.index}\n${cue.start} --> ${cue.end}\n${cue.text}\n`).join('\n')
}

export interface SpeakerLabels {
	label: string
	names?: SpeakerNames
}

/** Cues from a transcript, timed exactly like `asSrt`; speakers prefixed only when labels are given. */
export function cuesFromSegments(segments: Segment[], speakers?: SpeakerLabels): Cue[] {
	return segments.map((segment, i) => {
		const prefix = speakers && segment.speaker != null ? `[${speakerName(segment.speaker, speakers.label, speakers.names)}] ` : ''
		return {
			index: i + 1,
			start: formatTimestamp(segment.start, true, ','),
			end: formatTimestamp(segment.stop, true, ','),
			text: `${prefix}${segment.text.trim().replace('-->', '->')}`,
		}
	})
}
