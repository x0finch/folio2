import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  // Applied with `wrangler d1 migrations apply`, which reads this directory.
  out: './migrations',
})
