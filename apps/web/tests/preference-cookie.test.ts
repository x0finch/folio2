import { describe, expect, it } from "vitest";
import { preferenceCookieAttributes } from "@/lib/server/preferences/cookie-attributes";

// #527 后续件 1:cookie 属性的断言。清单原话是「断言它们,别只断言值」—— 属性以前是
// `setCookie` 的一次副作用,观测不到;现在是纯函数的返回值。
describe("preferenceCookieAttributes", () => {
  it("HttpOnly 开着 —— 这两个 cookie 没有任何客户端读者", () => {
    expect(preferenceCookieAttributes(true).httpOnly).toBe(true);
  });

  it("SameSite 是 Lax,不是 Strict —— 从外链跳进来时偏好该保住", () => {
    expect(preferenceCookieAttributes(true).sameSite).toBe("lax");
  });

  it("Secure 跟协议走:https 开、http 关 —— 写死会让本地 dev 根本设不上", () => {
    expect(preferenceCookieAttributes(true).secure).toBe(true);
    expect(preferenceCookieAttributes(false).secure).toBe(false);
  });

  it("Path=/ 且一年过期 —— 偏好比 session 长得多,又不是永不过期", () => {
    const attrs = preferenceCookieAttributes(true);
    expect(attrs.path).toBe("/");
    expect(attrs.maxAge).toBe(60 * 60 * 24 * 365);
  });
});
