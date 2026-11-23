import { describe, expect, it } from "vitest";
import { withDefaultNoStore } from "@/lib/server/entry/cache-headers";

// Regression guard: user B once saw user A's page because the CF edge cached an SSR response without
// cache-control by URL (ignoring Cookie). Default must be uncacheable; caching must be explicit.
describe("withDefaultNoStore", () => {
  it("adds private, no-store to a response without cache-control", () => {
    const out = withDefaultNoStore(new Response("<html>Net worth $991,602.80</html>"));

    expect(out.headers.get("cache-control")).toBe("private, no-store");
  });

  it("also adds Vary: Cookie — if a middlebox ignores no-store, the cache key is still per session", () => {
    const out = withDefaultNoStore(new Response("x"));

    expect(out.headers.get("vary")?.toLowerCase()).toContain("cookie");
  });

  it("keeps an explicit cache-control (the logo proxy's edge caching must survive)", () => {
    const logo = new Response(null, {
      status: 200,
      headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=2592000" },
    });

    const out = withDefaultNoStore(logo);

    expect(out.headers.get("cache-control")).toBe(
      "public, max-age=86400, stale-while-revalidate=2592000",
    );
    expect(out).toBe(logo); // passed through as-is, not even cloned
  });

  it("leaves a static asset's must-revalidate alone", () => {
    const asset = new Response("console.log(1)", {
      headers: { "cache-control": "public, max-age=0, must-revalidate" },
    });

    expect(withDefaultNoStore(asset).headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
  });

  it("keeps status / statusText / other headers / body", async () => {
    const res = new Response("payload", {
      status: 418,
      statusText: "I'm a teapot",
      headers: { "content-type": "text/plain", "x-custom": "kept" },
    });

    const out = withDefaultNoStore(res);

    expect(out.status).toBe(418);
    expect(out.statusText).toBe("I'm a teapot");
    expect(out.headers.get("content-type")).toBe("text/plain");
    expect(out.headers.get("x-custom")).toBe("kept");
    await expect(out.text()).resolves.toBe("payload");
  });

  it("appends to an existing Vary without overwriting or duplicating cookie", () => {
    const withEncoding = withDefaultNoStore(
      new Response("x", { headers: { vary: "accept-encoding" } }),
    );
    const vary = withEncoding.headers.get("vary")?.toLowerCase() ?? "";
    expect(vary).toContain("accept-encoding");
    expect(vary).toContain("cookie");

    const alreadyCookie = withDefaultNoStore(new Response("x", { headers: { vary: "Cookie" } }));
    expect(alreadyCookie.headers.get("vary")?.toLowerCase().split(",").length).toBe(1);
  });

  it("null-body statuses (204/304) don't throw", () => {
    expect(withDefaultNoStore(new Response(null, { status: 204 })).status).toBe(204);
    expect(withDefaultNoStore(new Response(null, { status: 304 })).status).toBe(304);
  });

  it("redirects are uncacheable too — a cached /login redirect would kick out signed-in users", () => {
    const redirect = new Response(null, { status: 307, headers: { location: "/login" } });

    const out = withDefaultNoStore(redirect);

    expect(out.status).toBe(307);
    expect(out.headers.get("location")).toBe("/login");
    expect(out.headers.get("cache-control")).toBe("private, no-store");
  });
});
