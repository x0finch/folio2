import { useEffect, useState } from 'react'

/** The current time, re-rendering every `intervalMs` (for "5 minutes ago" labels). */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}
