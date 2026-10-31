/** An error answer from the API: `{ error: code }` for app routes, `{ code }` for auth. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`${status} ${code}`)
  }
}

async function errorCode(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (typeof body === 'object' && body !== null) {
      if ('error' in body && typeof body.error === 'string') return body.error
      if ('code' in body && typeof body.code === 'string') return body.code
    }
  } catch {
    // Not JSON: fall through.
  }
  return 'unknown'
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
  if (!res.ok) throw new ApiError(res.status, await errorCode(res))
  // The API answers with the JSON shapes in @folio/shared; this is the one trusted cast.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  if (res.status === 204) return undefined as T
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (await res.json()) as T
}
