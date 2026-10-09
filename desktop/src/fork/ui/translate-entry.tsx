import { useState } from 'react'
import { Languages } from 'lucide-react'
import { Button } from '~/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '~/components/ui/tooltip'
import type { Segment, SpeakerNames } from '~/lib/transcript'
import { pick } from '~/fork/locale'
import { TranslateDialog } from '~/fork/translate'

/** Toolbar entry: translate the open transcript into SRT or TXT. */
export function TranslateTranscriptButton({
	name,
	segments,
	speakerNames,
	disabled,
}: {
	name: string
	segments: Segment[]
	speakerNames?: SpeakerNames
	disabled?: boolean
}) {
	const [open, setOpen] = useState(false)
	const label = pick('Перевести', 'Translate')
	return (
		<>
			<Button
				variant="ghost"
				size="sm"
				onClick={() => setOpen(true)}
				disabled={disabled || segments.length === 0}
				aria-label={label}
				className="rounded-full px-3 text-[13px] font-medium">
				<Languages className="h-3.5 w-3.5" />
				{label}
			</Button>
			{open && <TranslateDialog open={open} onOpenChange={setOpen} source={{ name, segments, speakerNames }} />}
		</>
	)
}

/** App menu entry: pick an .srt or .txt from disk and translate it. */
export function TranslateFileButton({ className }: { className?: string }) {
	const [open, setOpen] = useState(false)
	const label = pick('Перевести файл .srt/.txt', 'Translate an .srt/.txt file')
	return (
		<>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon" className={className} aria-label={label} onClick={() => setOpen(true)}>
						<Languages strokeWidth={1.75} />
					</Button>
				</TooltipTrigger>
				<TooltipContent>{label}</TooltipContent>
			</Tooltip>
			{open && <TranslateDialog open={open} onOpenChange={setOpen} />}
		</>
	)
}
