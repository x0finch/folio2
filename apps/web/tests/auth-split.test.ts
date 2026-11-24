import { describe, expect, it } from "vitest";

// Session checks must not pull in passkey (~12ms cold start). Breaking this is silent, so count in source:
// the full instance is only dynamically imported by /api/auth, and the server passkey plugin lives only there.

const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = Object.entries(sources).map(([path, text]) => ({
  path: path.replace("../src/", ""),
  text,
}));

const FULL_AUTH = /["'](?:@\/lib\/server\/session|\.)\/auth["']/;
const STATIC_IMPORT = /^\s*import\s[^;]*?from\s*["'][^"']+["']/gm;

describe("session checks load separately from full better-auth", () => {
  it("the full instance is only lazily imported by the /api/auth route", () => {
    const importers = files.filter((f) => FULL_AUTH.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(["routes/api/auth/$.ts"]);

    const route = files.find((f) => f.path === "routes/api/auth/$.ts")?.text ?? "";
    const staticOnes = (route.match(STATIC_IMPORT) ?? []).filter((s) => FULL_AUTH.test(s));
    expect(staticOnes).toEqual([]);
    expect(route).toMatch(/await import\(["']@\/lib\/server\/session\/auth["']\)/);
  });

  it("the server passkey plugin lives only in the full instance", () => {
    const users = files
      .filter((f) => /from\s*["']@better-auth\/passkey["']/.test(f.text))
      .map((f) => f.path);
    expect(users).toEqual(["lib/server/session/auth.ts"]);
  });
});
