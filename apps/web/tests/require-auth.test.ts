import { describe, expect, it } from "vitest";
import { resolveAuth } from "@/lib/server/session/auth-session";

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
