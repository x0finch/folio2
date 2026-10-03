import { betterAuth } from "better-auth";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { sharedAuthOptions } from "./auth-options";

// **只认会话的实例**:每个 server fn(`requireAuth`)、要登录的路由 handler、`getSession` 都走这里。
//
// 为什么不直接用 `auth.ts` 那个全量实例:那个带着 passkey 插件,它一 import 就把 WebAuthn 那一大块
// (asn1 / 证书解析)拉进来求值。代码是第一次被用到时才求值的,所以这一笔落在**每个冷 isolate 的
// 第一个请求**上 —— 本地实测约 12ms(`perf:cpu --cold`,模块加载 33–43ms → 21–29ms)。免费计划
// 一次请求 10ms CPU,而认会话根本用不到 passkey。
//
// 配置与全量实例共用 `sharedAuthOptions()`(secret / cookie / 会话时长一字不差),两边签的会话互认。
// 两个惰性单例都是每 isolate 建一次,不是每请求(坑 ②)。
function createSessionAuth() {
  return betterAuth({
    ...sharedAuthOptions(),
    plugins: [tanstackStartCookies()], // 会话续期 / cookie 缓存刷新要写 Set-Cookie
  });
}

let instance: ReturnType<typeof createSessionAuth> | null = null;

export function getSessionAuth() {
  instance ??= createSessionAuth();
  return instance;
}
