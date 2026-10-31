export const APP_NAME = 'Folio'

/** Shape of `GET /api/health`. */
export interface HealthResponse {
  ok: true
}

/** Shape of `GET /api/me`. */
export interface MeResponse {
  id: string
  email: string
  name: string
}

export * from './connections'
