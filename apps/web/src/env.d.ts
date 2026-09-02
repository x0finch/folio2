/// <reference types="@tanstack/react-start" />
// ↑ 加载 TanStack Start 类型(含 server route 的 `server.handlers` 对 router-core 的增强),
//   否则 createFileRoute 的 `server` 选项在 tsc 下不被识别(app src 未直接 import react-start)。

// 运行时密钥(不在 wrangler.jsonc,故 wrangler types 不会生成)——手动并入 Cloudflare.Env。
// 本地经 .dev.vars 注入,生产经 `wrangler secret put`。
declare namespace Cloudflare {
  interface Env {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    // 仅 preview env 设置(wrangler.jsonc env.preview.vars);生产不设 → undefined。
    // 逗号分隔的额外可信 origin(含通配),喂 better-auth trustedOrigins,让 workers.dev 预览别名域
    // 也能登录。见 auth.ts。
    PREVIEW_TRUSTED_ORIGINS?: string;
  }
}
