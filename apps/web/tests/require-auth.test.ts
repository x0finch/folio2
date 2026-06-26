import { describe, expect, it } from "vitest";
import { resolveAuth } from "../src/lib/auth-session";

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
    expect(ctx.user.id).toBe("u1");
    expect(ctx.session.id).toBe("s1");
  });
});
