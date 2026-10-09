import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '~/components/ui/select'
import { Spinner } from '~/components/ui/spinner'
import { cn } from '~/lib/style'
import { FORK_OLLAMA_PREFERRED } from '../defaults'
import { pick } from '../locale'
import { formatModelSize, isInstalled, listOllamaModels, OllamaUnavailableError, resolveOllamaModel, type OllamaModelInfo } from './models'

/** Radix Select cannot hold '' as an item value; this stands for "automatic" (saved as ''). */
const AUTO = '__auto__'

type Load = { status: 'loading' } | { status: 'ready'; models: OllamaModelInfo[] } | { status: 'error'; message: string }

/**
 * Installed Ollama models with a refresh button. `value` '' means automatic: the preferred
 * model if installed, else the first one; the resolved name is shown but never written back.
 */
export function OllamaModelPicker({
	baseUrl,
	value,
	onChange,
	className,
}: {
	baseUrl: string
	value: string
	onChange: (model: string) => void
	className?: string
}) {
	const [load, setLoad] = useState<Load>({ status: 'loading' })
	const request = useRef(0)

	const refresh = useCallback(async () => {
		const id = ++request.current
		setLoad({ status: 'loading' })
		try {
			const models = await listOllamaModels(baseUrl)
			if (id === request.current) setLoad({ status: 'ready', models })
		} catch (error) {
			if (id !== request.current) return
			const message =
				error instanceof OllamaUnavailableError
					? error.message
					: pick(
							`Не удалось получить список моделей: ${String(error instanceof Error ? error.message : error)}`,
							`Could not list models: ${String(error instanceof Error ? error.message : error)}`,
						)
			setLoad({ status: 'error', message })
		}
	}, [baseUrl])

	useEffect(() => {
		void refresh()
	}, [refresh])

	const models = load.status === 'ready' ? load.models : []
	const names = models.map((model) => model.name)
	const auto = names.length > 0 ? resolveOllamaModel('', names) : undefined
	const missing = value !== '' && load.status === 'ready' && !isInstalled(value, names)
	const selected = value === '' ? AUTO : (names.find((name) => isInstalled(value, [name])) ?? value)
	const autoLabel = auto ? pick(`авто: ${auto}`, `auto: ${auto}`) : pick('авто', 'auto')

	let message: { text: string; tone: 'error' | 'warning' } | null = null
	if (load.status === 'error') message = { text: load.message, tone: 'error' }
	else if (load.status === 'ready' && names.length === 0)
		message = {
			text: pick(
				`В Ollama нет ни одной модели. Установите модель: ollama pull ${FORK_OLLAMA_PREFERRED}`,
				`Ollama has no models installed. Install one: ollama pull ${FORK_OLLAMA_PREFERRED}`,
			),
			tone: 'error',
		}
	else if (missing)
		message = {
			text: pick(`Модель ${value} не установлена — будет использована ${auto}.`, `Model ${value} is not installed — ${auto} will be used instead.`),
			tone: 'warning',
		}

	return (
		<div className="flex w-64 max-w-full flex-col items-stretch gap-1">
			{/* className sizes the control line (callers pass row sizing like h-9); the message sits below it. */}
			<div className={cn('flex w-full items-center gap-1', className)}>
				<Select
					value={selected}
					onValueChange={(next) => onChange(next === AUTO ? '' : next)}
					disabled={load.status === 'loading' && names.length === 0}>
					<SelectTrigger className="h-9 min-w-0 flex-1 rounded-lg" aria-label={pick('Модель Ollama', 'Ollama model')}>
						<SelectValue placeholder={load.status === 'loading' ? pick('Загрузка…', 'Loading…') : autoLabel} />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={AUTO}>{autoLabel}</SelectItem>
						{missing && (
							<SelectItem value={value} disabled>
								{value} · {pick('не установлена', 'not installed')}
							</SelectItem>
						)}
						{models.map((model) => (
							<SelectItem key={model.name} value={model.name}>
								<span className="flex items-baseline gap-2">
									<span>{model.name}</span>
									<span className="text-xs text-muted-foreground">{formatModelSize(model.size)}</span>
								</span>
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Button
					type="button"
					variant="ghost"
					size="iconSm"
					className="h-9 w-9 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
					aria-label={pick('Обновить', 'Refresh')}
					title={pick('Обновить', 'Refresh')}
					disabled={load.status === 'loading'}
					onClick={() => void refresh()}>
					{load.status === 'loading' ? <Spinner className="h-3.5 w-3.5" /> : <RefreshCw />}
				</Button>
			</div>
			{message && (
				<div className={cn('text-xs', message.tone === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-400')}>{message.text}</div>
			)}
		</div>
	)
}
