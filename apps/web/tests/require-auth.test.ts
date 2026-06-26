import { beforeEach, describe, expect, it, vi } from "vitest";

// mock ./auth(避免加载 cloudflare:workers)与 server headers 工具。
const getSession = vi.fn();
vi.mock("../src/lib/auth", () => ({ getAuth: () => ({ api: { getSession } }) }));
vi.mock("@tanstack/react-start/server", () => ({
  getRequestHeaders: () => ({ cookie: "test" }),
}));

// 在 mock 之后导入被测模块。
import { resolveAuth } from "../src/lib/require-auth";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveAuth (session guard)", () => {
  it("rejects with 401 when there is no session", async () => {
    getSession.mockResolvedValue(null);
    await expect(resolveAuth()).rejects.toMatchObject({ status: 401 });
  });

  it("derives userId only from the validated session", async () => {
    getSession.mockResolvedValue({
      user: { id: "u1", email: "a@b.com" },
      session: { id: "s1", userId: "u1" },
    });
    const ctx = await resolveAuth();
    expect(ctx.userId).toBe("u1");
    expect(ctx.user.id).toBe("u1");
    expect(ctx.session.id).toBe("s1");
  });

  it("forwards the headers from getRequestHeaders to getSession", async () => {
    getSession.mockResolvedValue({ user: { id: "u1" }, session: { id: "s1" } });
    await resolveAuth();
    expect(getSession).toHaveBeenCalledWith({ headers: { cookie: "test" } });
  });
});
