import { describe, expect, it } from "vitest";
import { hasSessionCookie, resolveAuth } from "@/lib/server/session/auth-session";

// resolveAuth 现是纯校验函数(取 session 由 requireAuth 的 .server() 完成)。
// 测两条安全属性:无 session → 401;userId 只来自已验证 session。
describe("resolveAuth (session guard)", () => {
  it("throws a 401 Response when there is no session", () => {
    let caught: unknown;
    try {
      resolveAuth(null);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Response);
    expect((caught as Response).status).toBe(401);
  });

  it("derives userId only from the validated session", () => {
    const ctx = resolveAuth({
      user: { id: "u1", email: "a@b.com" },
      session: { id: "s1", userId: "u1" },
    });
    expect(ctx.userId).toBe("u1");
    // **出口只有 userId**(#504 T13):`user` / `session` 整份不再往下流 —— 没有 handler 收
    // context 了,装配点也只读这一个字段。多带的字段就是多一条能悄悄用起来的路。
    expect(Object.keys(ctx)).toEqual(["userId"]);
  });
});

// 登录后的路由整树 ssr:false 之后,「没登录跳 /login」不能再靠 `_authed.beforeLoad`(它已经不在
// 服务端跑了)。留在服务端的只剩这一个判据:**cookie 在不在**。它不解密、不查库、不认签名 ——
// 拿着伪 cookie 的人看得到骨架壳,进了浏览器被真鉴权踢走,数据接口一步都走不动(ADR 0049)。
//
// 所以这里测的是「名字对不对得上、空值算不算数」这一层,不是安全边界。安全边界在
// resolveAuth / requireAuth 那边,上面那两条测的就是它。
describe("hasSessionCookie (壳化后的服务端重定向判据)", () => {
  it("认 https 下的 __Secure- 前缀名", () => {
    expect(hasSessionCookie("__Secure-better-auth.session_token=abc.def")).toBe(true);
  });

  it("认本地 http 下的无前缀名", () => {
    expect(hasSessionCookie("better-auth.session_token=abc.def")).toBe(true);
  });

  it("从一串 cookie 里挑得出来,前后有空格也认", () => {
    expect(
      hasSessionCookie(
        "folio_currency=USD; __Secure-better-auth.session_token=abc.def; theme=dark",
      ),
    ).toBe(true);
  });

  it("没有 cookie 头 / 空头 → 没有", () => {
    expect(hasSessionCookie(null)).toBe(false);
    expect(hasSessionCookie(undefined)).toBe(false);
    expect(hasSessionCookie("")).toBe(false);
  });

  it("有名字但值是空的 → 不算(登出时正是把值置空)", () => {
    expect(hasSessionCookie("__Secure-better-auth.session_token=")).toBe(false);
    expect(hasSessionCookie("better-auth.session_token=; folio_locale=en")).toBe(false);
  });

  it("别的 better-auth cookie 不算 session", () => {
    // cookieCache 关着(见 auth.ts),但 passkey 的 challenge cookie 一直在 —— 前缀相同,
    // 名字不同。子串匹配会把它当成已登录,那就等于任何访客都拿得到壳。
    expect(hasSessionCookie("__Secure-better-auth.session_data=xyz")).toBe(false);
    expect(hasSessionCookie("better-auth.challenge=xyz")).toBe(false);
  });

  it("名字必须整段相等,不是后缀相等", () => {
    expect(hasSessionCookie("evil-better-auth.session_token=abc")).toBe(false);
  });
});
