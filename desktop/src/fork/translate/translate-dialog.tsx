import { basename, dirname, join } from '@tauri-apps/api/path'
import * as dialog from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { Download, FileText, Languages, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '~/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '~/components/ui/dialog'
import { Progress } from '~/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { FORK_TRANSLATE_TARGET } from '~/fork/defaults'
import { isRussianUi, pick } from '~/fork/locale'
import { createClient } from '~/lib/ai'
import { usePersisted } from '~/lib/config-store'
import { cn } from '~/lib/style'
import type { Segment, SpeakerNames } from '~/lib/transcript'
import { usePreferenceProvider } from '~/providers/preference'
import { isAbortError, translateCues } from './batch'
import { LANGUAGES } from './prompts'
import { cuesFromSegments, formatSrt, parseSrt } from './srt'
import { translateText } from './text'

/** Fork-only key in the app config; upstream's CONFIG_KEYS stays untouched. */
const TARGET_KEY = 'fork.translate.target'

type Format = 'srt' | 'txt'

export interface TranslateSource {
	name: string
	segments: Segment[]
	speakerNames?: SpeakerNames
}

export interface TranslateDialogProps {
	open: boolean
	onOpenChange(open: boolean): void
	/** A transcript to translate; without it the dialog asks for an .srt or .txt file. */
	source?: TranslateSource
}

interface PickedFile {
	path: string
	name: string
	kind: Format
	content: string
}

interface Result {
	text: string
	ext: Format
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

/** A file name without its last extension, safe on Windows. */
function stem(name: string) {
	return (
		name
			.replace(/\.[A-Za-z0-9]{1,5}$/, '')
			.replace(/[\\/:*?"<>|]+/g, '_')
			.trim() || 'transcript'
	)
}

function SectionLabel({ children }: { children: React.ReactNode }) {
	return <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">{children}</h3>
}

export function TranslateDialog({ open, onOpenChange, source }: TranslateDialogProps) {
	const { ai } = usePreferenceProvider()
	const [target, setTarget] = usePersisted<string>(TARGET_KEY, FORK_TRANSLATE_TARGET)
	const [format, setFormat] = useState<Format>('srt')
	const [file, setFile] = useState<PickedFile | null>(null)
	const [running, setRunning] = useState(false)
	const [progress, setProgress] = useState({ done: 0, total: 0 })
	const [error, setError] = useState<string | null>(null)
	const [result, setResult] = useState<Result | null>(null)
	const abortRef = useRef<AbortController | null>(null)

	// Closing the dialog cancels the job and forgets the last file and result.
	useEffect(() => {
		if (open) return
		abortRef.current?.abort()
		abortRef.current = null
		setFile(null)
		setRunning(false)
		setProgress({ done: 0, total: 0 })
		setError(null)
		setResult(null)
	}, [open])

	useEffect(() => () => abortRef.current?.abort(), [])

	const russian = isRussianUi()
	const unitLabel = !source && file?.kind === 'txt' ? pick('частей', 'parts') : pick('субтитров', 'subtitles')
	const canStart = !running && (source ? source.segments.length > 0 : file !== null)

	async function pickFile() {
		setError(null)
		setResult(null)
		try {
			const selected = await dialog.open({
				multiple: false,
				filters: [{ name: pick('Субтитры или текст', 'Subtitles or text'), extensions: ['srt', 'txt'] }],
			})
			if (typeof selected !== 'string') return
			const name = await basename(selected)
			const content = await readTextFile(selected)
			setFile({ path: selected, name, kind: /\.srt$/i.test(name) ? 'srt' : 'txt', content })
		} catch (e) {
			setError(pick(`Не удалось открыть файл: ${errorMessage(e)}`, `Could not open the file: ${errorMessage(e)}`))
		}
	}

	async function save(output: Result) {
		try {
			const fileName = `${stem(source ? source.name : (file?.name ?? ''))}.${target}.${output.ext}`
			const defaultPath = !source && file ? await join(await dirname(file.path), fileName) : fileName
			const path = await dialog.save({
				defaultPath,
				canCreateDirectories: true,
				filters: [{ name: output.ext.toUpperCase(), extensions: [output.ext] }],
			})
			if (!path) return
			await writeTextFile(path, output.text)
			toast.success(pick('Перевод сохранён', 'Translation saved'), { description: path, position: 'bottom-center' })
		} catch (e) {
			setError(pick(`Не удалось сохранить файл: ${errorMessage(e)}`, `Could not save the file: ${errorMessage(e)}`))
		}
	}

	async function start() {
		if (!canStart) return
		const controller = new AbortController()
		abortRef.current = controller
		setRunning(true)
		setError(null)
		setResult(null)
		setProgress({ done: 0, total: 0 })
		const options = {
			target,
			contextTokens: ai.connection.contextTokens,
			signal: controller.signal,
			onProgress: (done: number, total: number) => {
				if (!controller.signal.aborted) setProgress({ done, total })
			},
		}
		try {
			const client = createClient(ai.connection)
			let output: Result
			if (source) {
				const speakers = source.segments.some((segment) => segment.speaker != null)
					? { label: pick('Спикер', 'Speaker'), names: source.speakerNames }
					: undefined
				const translated = await translateCues(client, cuesFromSegments(source.segments, speakers), options)
				output =
					format === 'srt' ? { text: formatSrt(translated), ext: 'srt' } : { text: translated.map((cue) => cue.text).join('\n') + '\n', ext: 'txt' }
			} else if (file?.kind === 'srt') {
				const cues = parseSrt(file.content)
				if (cues.length === 0) throw new Error(pick('В файле не найдено ни одного субтитра.', 'The file has no subtitles.'))
				output = { text: formatSrt(await translateCues(client, cues, options)), ext: 'srt' }
			} else if (file) {
				output = { text: await translateText(client, file.content, options), ext: 'txt' }
			} else {
				return
			}
			if (controller.signal.aborted) return
			setResult(output)
			await save(output)
		} catch (e) {
			if (!isAbortError(e) && !controller.signal.aborted) setError(errorMessage(e))
		} finally {
			if (abortRef.current === controller) {
				abortRef.current = null
				setRunning(false)
			}
		}
	}

	function cancel() {
		abortRef.current?.abort()
		abortRef.current = null
		setRunning(false)
		setProgress({ done: 0, total: 0 })
	}

	const percent = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-lg rounded-2xl border-border/60 bg-card/95 p-6 shadow-xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2 text-lg font-semibold">
						<Languages className="h-5 w-5" aria-hidden="true" />
						{pick('Перевод', 'Translate')}
					</DialogTitle>
					<DialogDescription>
						{source
							? pick(
									'Транскрипция переводится по субтитрам, тайм-коды остаются прежними.',
									'The transcript is translated subtitle by subtitle; timecodes stay as they are.',
								)
							: pick(
									'Выберите файл .srt или .txt. В субтитрах тайм-коды не меняются.',
									'Choose an .srt or .txt file. Subtitle timecodes are never changed.',
								)}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-5 pt-2">
					{source ? (
						<p className="truncate rounded-xl border border-border/60 bg-background/40 px-3.5 py-2.5 text-sm" title={source.name}>
							{source.name}
						</p>
					) : (
						<div className="space-y-2">
							<Button type="button" variant="outline" className="w-full" onClick={() => void pickFile()} disabled={running}>
								<FileText aria-hidden="true" />
								{file ? pick('Выбрать другой файл', 'Choose another file') : pick('Выбрать файл .srt/.txt', 'Choose an .srt/.txt file')}
							</Button>
							{file && (
								<p className="truncate px-0.5 text-xs text-muted-foreground" title={file.path}>
									{file.name}
								</p>
							)}
						</div>
					)}

					<section className="space-y-2">
						<SectionLabel>{pick('Язык перевода', 'Target language')}</SectionLabel>
						<Select value={target} onValueChange={setTarget} disabled={running}>
							<SelectTrigger aria-label={pick('Язык перевода', 'Target language')}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{LANGUAGES.map((language) => (
									<SelectItem key={language.code} value={language.code}>
										{russian ? language.ru : language.en}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</section>

					{source && (
						<section className="space-y-2">
							<SectionLabel>{pick('Формат', 'Format')}</SectionLabel>
							<div className="grid grid-cols-2 rounded-full bg-muted/50 p-1" role="radiogroup" aria-label={pick('Формат', 'Format')}>
								{(['srt', 'txt'] as const).map((value) => (
									<button
										key={value}
										type="button"
										role="radio"
										aria-checked={format === value}
										disabled={running}
										onClick={() => setFormat(value)}
										className={cn(
											'cursor-pointer rounded-full px-3 py-1.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/80 disabled:cursor-not-allowed',
											format === value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
										)}>
										{value === 'srt' ? pick('Субтитры SRT', 'SRT subtitles') : pick('Текст TXT', 'Plain text TXT')}
									</button>
								))}
							</div>
						</section>
					)}

					{running && (
						<div className="space-y-1.5" aria-live="polite">
							<Progress value={percent} />
							<p className="text-xs text-muted-foreground">
								{progress.total > 0
									? pick(
											`Переведено ${progress.done} из ${progress.total} ${unitLabel}`,
											`Translated ${progress.done} of ${progress.total} ${unitLabel}`,
										)
									: pick('Подготовка…', 'Preparing…')}
							</p>
						</div>
					)}

					{error && (
						<p
							role="alert"
							className="whitespace-pre-wrap rounded-xl border border-destructive/40 bg-destructive/10 px-3.5 py-2.5 text-sm text-destructive">
							{error}
						</p>
					)}
				</div>

				<DialogFooter className="gap-2 pt-2">
					{running ? (
						<Button type="button" variant="outline" onClick={cancel}>
							<X aria-hidden="true" />
							{pick('Отмена', 'Cancel')}
						</Button>
					) : (
						result && (
							<Button type="button" variant="outline" onClick={() => void save(result)}>
								<Download aria-hidden="true" />
								{pick('Сохранить', 'Save')}
							</Button>
						)
					)}
					<Button type="button" onClick={() => void start()} disabled={!canStart}>
						<Languages aria-hidden="true" />
						{running ? pick('Перевожу…', 'Translating…') : pick('Перевести', 'Translate')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
