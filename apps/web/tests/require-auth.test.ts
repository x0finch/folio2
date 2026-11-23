import { describe, expect, it } from "vitest";
import { resolveAuth } from "@/lib/server/session/auth-session";

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
    expect(Object.keys(ctx)).toEqual(["userId"]);
  });
});
