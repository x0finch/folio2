import type { Source } from '@folio/sources'

import type { Auth } from './auth'
import type { Env } from './env'

type SessionData = NonNullable<Awaited<ReturnType<Auth['api']['getSession']>>>

export type User = SessionData['user']

export type AppEnv = {
  Bindings: Env
  Variables: {
    user: User
    /** The source plugins this app serves (the registry; tests add fakes). */
    sources: SourceRegistry
  }
}

/** The parts of a Better Auth instance the app uses; tests inject one with extra plugins. */
export interface AuthLike {
  handler: Auth['handler']
  api: { getSession: Auth['api']['getSession'] }
}

export type AuthFor = (env: Env) => AuthLike

export interface SourceRegistry {
  all: readonly Source[]
  get: (id: string) => Source | undefined
}
