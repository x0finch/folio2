import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGetProviderKeyStatus } from "@/lib/server/settings/provider-keys";

describe("settings/provider-keys", () => {
  // This handler needs no services (it only reads two env flags), so it's called directly. It reads
  // `cloudflare:workers` env, the same object as `cloudflare:test`'s `env` in the workers pool.

  const withKeys = (patch: Record<string, string | undefined>) => {
    const target = env as unknown as Record<string, string | undefined>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) vi.stubEnv(k, ""); // placeholder; the next line is what takes effect
      target[k] = v;
    }
  };

  afterEach(() => {
    const target = env as unknown as Record<string, string | undefined>;
    target.ZERION_API_KEY = undefined;
    target.COINSTATS_API_KEY = undefined;
    vi.unstubAllEnvs();
  });

  describe("getProviderKeyStatus", () => {
    it("both configured → both true", () => {
      withKeys({ ZERION_API_KEY: "zk", COINSTATS_API_KEY: "ck" });

      expect(handleGetProviderKeyStatus()).toEqual({
        ZERION_API_KEY: true,
        COINSTATS_API_KEY: true,
      });
    });

    it("one configured → one true, one false", () => {
      withKeys({ ZERION_API_KEY: "zk", COINSTATS_API_KEY: undefined });

      expect(handleGetProviderKeyStatus()).toEqual({
        ZERION_API_KEY: true,
        COINSTATS_API_KEY: false,
      });
    });

    it("empty string in env → not configured", () => {
      withKeys({ ZERION_API_KEY: "", COINSTATS_API_KEY: "" });

      expect(handleGetProviderKeyStatus()).toEqual({
        ZERION_API_KEY: false,
        COINSTATS_API_KEY: false,
      });
    });

    it("returns booleans only; no character of the key leaks", () => {
      // Asserts the value type, not just truthiness, so returning e.g. a key prefix as a hint fails.
      withKeys({ ZERION_API_KEY: "super-secret-zerion", COINSTATS_API_KEY: "super-secret-cs" });

      const out = handleGetProviderKeyStatus();

      expect(typeof out.ZERION_API_KEY).toBe("boolean");
      expect(typeof out.COINSTATS_API_KEY).toBe("boolean");
      expect(JSON.stringify(out)).not.toContain("super-secret");
    });
  });
});
