import { useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'folio-theme'
const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * Runs before the page paints (inlined in <head>) so a dark theme never flashes light. Kept
 * self-contained: it is serialized as a string.
 */
export const themeInitScript = `(() => {
  let pref = 'system'
  try { pref = localStorage.getItem('${STORAGE_KEY}') || 'system' } catch {}
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('${DARK_QUERY}').matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
})()`

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

function apply(preference: ThemePreference) {
  const dark = preference === 'dark' || (preference === 'system' && matchMedia(DARK_QUERY).matches)
  document.documentElement.dataset['theme'] = dark ? 'dark' : 'light'
}

/** The theme preference, persisted per device, following the system unless overridden. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)

  useEffect(() => {
    apply(preference)
    if (preference !== 'system') return undefined
    const media = matchMedia(DARK_QUERY)
    const onChange = () => apply('system')
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [preference])

  const choose = (next: ThemePreference) => {
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY)
      else localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // Storage blocked: the choice lasts for this page only.
    }
    setPreference(next)
  }

  return { preference, choose }
}
