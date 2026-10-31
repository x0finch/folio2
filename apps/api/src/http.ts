import { HTTPException } from 'hono/http-exception'
import { validator } from 'hono/validator'

const STATUS = {
  invalid: 400,
  invalid_config: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  too_large: 413,
  not_configured: 503,
} as const

/** Error codes the API answers with, as `{ error }`, each with its status. */
export type ErrorCode = keyof typeof STATUS

/** Stops the request with `{ error: code, ...details }`; `onError` sends it. */
export function fail(code: ErrorCode, details?: Record<string, unknown>): never {
  const status = STATUS[code]
  throw new HTTPException(status, {
    message: code,
    res: Response.json({ error: code, ...details }, { status }),
  })
}

interface Schema<T> {
  safeParse: (value: unknown) => { success: true; data: T } | { success: false }
}

/** Validates the JSON body against a shared schema; handlers read `c.req.valid('json')`. */
export const json = <T>(schema: Schema<T>) =>
  validator('json', (value): T => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) fail('invalid')
    return parsed.data
  })

/**
 * Validates the query string against a schema; handlers read `c.req.valid('query')`. It reads
 * `c.req.query()`, one value per name, as the routes did before.
 */
export const query = <T>(schema: Schema<T>) =>
  validator('query', (_value, c): T => {
    const parsed = schema.safeParse(c.req.query())
    if (!parsed.success) fail('invalid')
    return parsed.data
  })

/** Maps thrown errors to JSON: HTTP errors keep their status, anything else is a 500. */
export function errorResponse(error: Error): Response {
  if (error instanceof HTTPException) {
    // fail() built the response; Hono's own errors (malformed JSON, wrong content type)
    // carry prose, not a code.
    if (error.res) return error.res
    const code = error.status === 400 ? 'invalid' : error.message
    return Response.json({ error: code }, { status: error.status })
  }
  console.error(error)
  return Response.json({ error: 'internal_error' }, { status: 500 })
}
