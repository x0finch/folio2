import { useSyncExternalStore } from 'react'

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const media = matchMedia(query)
      media.addEventListener('change', onChange)
      return () => media.removeEventListener('change', onChange)
    },
    () => matchMedia(query).matches,
    () => false,
  )
}

/** Wide enough for the sidebar layout (Tailwind's `md`). */
export const useWide = () => useMedia('(min-width: 48rem)')
