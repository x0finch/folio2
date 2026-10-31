/** An error answer from the API: `{ error: code }` for app routes, `{ code }` for auth. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** Extra fields of the error answer, e.g. `{ field, message }` for invalid configs. */
    readonly detail?: { field?: string; message?: string },
  ) {
    super(`${status} ${code}`)
  }
}

async function toError(res: Response): Promise<ApiError> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null) {
      const message =
        'message' in body && typeof body.message === 'string' ? body.message : undefined
      const field = 'field' in body && typeof body.field === 'string' ? body.field : undefined
      if ('error' in body && typeof body.error === 'string') {
        return new ApiError(res.status, body.error, { field, message })
      }
      if ('code' in body && typeof body.code === 'string') {
        return new ApiError(res.status, body.code, { message })
      }
    }
  } catch {
    // Not JSON: fall through.
  }
  return new ApiError(res.status, 'unknown')
}

/** Same-origin JSON client for the Folio API. Shapes are shared via @folio/shared. */
export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init
  const headers = new Headers(rest.headers)
  if (json !== undefined) headers.set('Content-Type', 'application/json')
  const res = await fetch(path, {
    ...rest,
    headers,
    credentials: 'same-origin',
    body: json === undefined ? rest.body : JSON.stringify(json),
  })
  if (!res.ok) throw await toError(res)
  // The API answers with the JSON shapes in @folio/shared; this is the one trusted cast.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  if (res.status === 204) return undefined as T
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await res.json()) as T
}
