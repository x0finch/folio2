import { createApp } from './app'
import type { Env } from './env'

export { Scheduler, SyncRunner } from './sync/durable'

const app = createApp()

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx)
  },
  async scheduled(_controller, env) {
    // The sweep runs in the Scheduler's alarm; the cron only wakes it.
    await env.SCHEDULER.get(env.SCHEDULER.idFromName('global')).kick()
  },
} satisfies ExportedHandler<Env>
