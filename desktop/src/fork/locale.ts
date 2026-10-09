import { getLocale } from '~/paraglide/runtime.js'

/** Fork strings are kept out of upstream's catalogs: Russian when the UI is Russian, English otherwise. */
export function isRussianUi() {
	try {
		return getLocale().toLowerCase().startsWith('ru')
	} catch {
		return false
	}
}

export function pick(ru: string, en: string) {
	return isRussianUi() ? ru : en
}
