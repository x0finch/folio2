import { env } from "cloudflare:workers";
import { passkey } from "@better-auth/passkey";
import { createAuthAdapter } from "@folio/db";
import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { derivePasskeyRp } from "../../passkey-rp";

// 密码哈希:better-auth 1.6 + nodejs_compat 默认走原生 node:crypto scrypt(坑 ① 已默认修复)。
function createAuth() {
  // WebAuthn RP 从 BETTER_AUTH_URL 派生(rpID=host、origin=完整 origin);challenge 走插件默认 cookie,
  // 不加 KV。见 ADR 0028。改隧道域名做手机验证时这里会跟着变 —— 也就意味着 localhost 上注册的
  // 凭据在隧道域名下不可用(rpID 不匹配),反之亦然。
  // authenticatorSelection 的取值理由见下面 passkey() 那处(#353 把 userVerification 从
  // "preferred" 改成了 "required",residentKey 仍是 "preferred")。
  const rp = derivePasskeyRp(env.BETTER_AUTH_URL);
  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: createAuthAdapter(env),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false, // 自托管无邮件验证,注册即用
      autoSignIn: true,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7d
      updateAge: 60 * 60 * 24, // 1d
      // cookieCache 保持关闭(坑 ⑤:与 secondaryStorage 组合有 bug,且单实例下收益小)
    },
    plugins: [
      passkey({
        rpID: rp.rpID,
        rpName: rp.rpName,
        origin: rp.origin,
        // userVerification: "required" —— 每次 ceremony 都必须过本机的生物识别/PIN,平台不许
        // 缓存跳过。锁屏要的是「此刻在键盘前的还是那个人」这个**在场证明**,插件默认的
        // "preferred" 允许平台省掉用户验证,那前提就是空的(#353)。
        // residentKey 保持 preferred:登录页的 conditional-UI(autofill)要可发现凭据,但强制
        // required 会挡掉一部分认证器,收益不抵。
        authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      }),
      tanstackStartCookies(), // 必须放插件数组最后
    ],
  });
}

let authInstance: ReturnType<typeof createAuth> | null = null;

// 惰性单例(坑 ②⑥):首次请求时构建、之后复用;不在模块加载期做任何 auth 工作。
// env 取自 cloudflare:workers(按请求解析的静态绑定),避免每请求新建多个 drizzle 实例。
export function getAuth() {
  authInstance ??= createAuth();
  return authInstance;
}
