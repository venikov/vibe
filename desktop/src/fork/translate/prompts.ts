/** Translation targets: ISO 639-1 code, the name the model is given, the name a Russian UI shows. */
export interface TranslateLanguage {
	code: string
	en: string
	ru: string
}

export const LANGUAGES: TranslateLanguage[] = [
	{ code: 'ru', en: 'Russian', ru: 'Русский' },
	{ code: 'de', en: 'German', ru: 'Немецкий' },
	{ code: 'en', en: 'English', ru: 'Английский' },
	{ code: 'uk', en: 'Ukrainian', ru: 'Украинский' },
	{ code: 'fr', en: 'French', ru: 'Французский' },
	{ code: 'es', en: 'Spanish', ru: 'Испанский' },
	{ code: 'it', en: 'Italian', ru: 'Итальянский' },
	{ code: 'pl', en: 'Polish', ru: 'Польский' },
	{ code: 'tr', en: 'Turkish', ru: 'Турецкий' },
]

export function findLanguage(code: string): TranslateLanguage | undefined {
	return LANGUAGES.find((language) => language.code === code)
}

/** The English name the prompt uses; an unknown code is passed through as is. */
export function languageName(code: string): string {
	return findLanguage(code)?.en ?? code
}

/** Stands in for a line break inside one cue, so every cue stays on one line of the prompt. */
export const NEWLINE_MARK = '⏎'

export function marker(id: number) {
	return `⟦${id}⟧`
}

/**
 * The prompt for one batch of numbered lines. `lines` are already marked (`⟦n⟧ text`);
 * `context` holds the previous cues' translations, shown for continuity and never answered.
 */
export function batchPrompt(lines: string[], targetName: string, context: string[] = []): string {
	const parts = [
		`You are a professional subtitle translator. Translate each numbered line below into ${targetName}.`,
		'',
		'Rules:',
		`- Every line starts with a marker like ⟦12⟧. Copy each marker exactly, then write the ${targetName} translation of that line after it.`,
		'- Output exactly one line per input line, in the same order. Never merge lines, never split a line, never skip one.',
		`- The symbol ${NEWLINE_MARK} marks a line break inside a subtitle; keep it where it belongs in the translation.`,
		'- Keep names, numbers, dates, units and abbreviations as they are.',
		`- If a line is already in ${targetName}, copy it unchanged.`,
		`- The source is often Russian speech with German words mixed in (place names, offices, documents, official terms). Translate the meaning naturally; when the target is German, keep those German words as they are. For other targets, keep a German term when it is a proper name or an official term with no good equivalent.`,
		'- Output only the marked lines: no explanations, no notes, no quotes, no code blocks.',
	]
	if (context.length > 0) {
		parts.push('', 'Previous subtitles, already translated, for context only. Do not output them:', ...context.map((line) => `> ${line}`))
	}
	parts.push('', 'Lines to translate:', ...lines)
	return parts.join('\n')
}

/** The prompt for a piece of plain text: the translation and nothing else. */
export function textPrompt(text: string, targetName: string, context = ''): string {
	const parts = [
		`Translate the text below into ${targetName}.`,
		'Keep the paragraph and line structure. Keep names and numbers as they are; if a passage is already in the target language, keep it.',
		`The source is often Russian with German words mixed in; when translating into German, those German words stay as they are.`,
		'Output only the translation: no introduction, no notes, no quotes, no code blocks.',
	]
	if (context) parts.push('', 'End of the previous part, already translated, for context only. Do not output it:', context)
	parts.push('', 'Text:', text)
	return parts.join('\n')
}

/** Thinking blocks and code fences some models wrap their answer in. */
export function cleanAnswer(answer: string): string {
	return answer
		.replace(/<think>[\s\S]*?<\/think>/g, '')
		.replace(/^\s*```[^\n]*\n?/, '')
		.replace(/\n?```\s*$/, '')
		.trim()
}
