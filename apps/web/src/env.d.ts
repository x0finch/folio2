/// <reference types="@tanstack/react-start" />
// ↑ Start's router-core augmentation (`server.handlers`); app src never imports react-start.

// Runtime secrets aren't in wrangler.jsonc, so `wrangler types` doesn't generate them.
declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    // Preview env only: comma-separated extra trusted origins (wildcards allowed) for better-auth.
    PREVIEW_TRUSTED_ORIGINS?: string;
  }
}
