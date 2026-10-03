import { env } from "cloudflare:workers";
import { createAuthAdapter } from "@folio/db";
import type { BetterAuthOptions } from "better-auth";

// **两个 better-auth 实例共用的那份配置**(`auth.ts` 的全量实例、`session-auth.ts` 的只认会话实例)。
// 会话怎么签、cookie 叫什么、多久过期都由这里定 —— 两边必须一字不差,否则一边签的会话另一边不认。
// 只有 `plugins` 各自给;这个文件不许 import passkey(理由见 `session-auth.ts`)。

// 会话 cookie 缓存的有效期(秒)。= better-auth 自己的默认值;取舍见下面 `cookieCache` 那处。
const SESSION_COOKIE_CACHE_MAX_AGE_S = 5 * 60;

// 密码哈希:better-auth 1.6 + nodejs_compat 默认走原生 node:crypto scrypt(坑 ① 已默认修复)。
export function sharedAuthOptions() {
  // 额外可信 origin —— **只有 preview env 会设** PREVIEW_TRUSTED_ORIGINS(见 wrangler.jsonc),生产为空。
  // 让 per-PR 的 workers.dev 预览别名域通过 Origin/CSRF 校验(cookie 默认 host-only,跟着访问域走,
  // 所以密码登录跨域可用;passkey rpID 仍绑 BETTER_AUTH_URL 的固定域、换域名不通 —— 预览用密码登录)。
  // better-auth 支持通配(wildcard-match);baseURL 的 origin 自动可信,无需在此重复。
  const previewTrustedOrigins = (env.PREVIEW_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  return {
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: previewTrustedOrigins,
    database: createAuthAdapter(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // 自托管无邮件验证,注册即用
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // **cookieCache 开着**:认会话先看那枚签过名的 `session_data` cookie(compact 策略 = HMAC),
      // 命中就直接返回,不碰 D1 —— 否则每个 server fn(`requireAuth` → `getSession`)都要一次
      // 会话表 SELECT。免费计划一次请求 10ms CPU,这一笔省得下来。
      //
      // 代价(明知接受):**在别处撤销的会话,最多 maxAge 之后才在这台设备上失效**,因为缓存命中时
      // 不回库看那行还在不在。退出登录不受影响 —— sign-out 会把这枚 cookie 一起清掉。
      // 本应用没有「踢掉其他设备」「改密码」「删账号」这类要求撤销立即生效的服务端路径;哪天有了,
      // 那一处给 `getSession` 传 `query: { disableCookieCache: true }`。
      //
      // 以前关着的理由(坑 ⑤:cookieCache + secondaryStorage 的上游 bug)**在这里不成立**:
      // 本部署没有配 secondaryStorage。哪天配了,先回头复核这一条。
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_MAX_AGE_S },
    },
  } satisfies BetterAuthOptions;
}
