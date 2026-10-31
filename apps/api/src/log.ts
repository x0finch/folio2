import type { SourceLog } from '@folio/sources'

/** Structured logs with an allow-listed shape: plugins pass only what they choose. */
export const consoleLog = (scope: Record<string, string>): SourceLog => ({
  info: (message, data) =>
    console.log(JSON.stringify({ level: 'info', message, ...scope, ...data })),
  warn: (message, data) =>
    console.warn(JSON.stringify({ level: 'warn', message, ...scope, ...data })),
})

/** For validation calls during a request: nothing worth keeping. */
export const quietLog: SourceLog = { info: () => undefined, warn: () => undefined }
