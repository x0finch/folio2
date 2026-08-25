import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleGetProviderKeyStatus } from "@/lib/server/settings/provider-keys";

// #527 · getProviderKeyStatus
//
// **这个 handler 不经 runEffect**(它一个服务都不要,只读两个 env 开关),所以这里直接调它 ——
// 不需要用户、不需要 D1。这也是清单里那句「只读 env 的那几个刻意不套」的可执行形式。
//
// 它读的是 `cloudflare:workers` 的 env,而 workers-pool 里那份与 `cloudflare:test` 的 `env`
// 是同一个对象,所以改这里就能改被测代码看到的值。

const withKeys = (patch: Record<string, string | undefined>) => {
  const target = env as unknown as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) vi.stubEnv(k, ""); // 占位;真正生效的是下面这行
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
  it("两个都配了 → 两个 true", () => {
    withKeys({ ZERION_API_KEY: "zk", COINSTATS_API_KEY: "ck" });

    expect(handleGetProviderKeyStatus()).toEqual({
      ZERION_API_KEY: true,
      COINSTATS_API_KEY: true,
    });
  });

  it("只配了一个 → 一 true 一 false", () => {
    withKeys({ ZERION_API_KEY: "zk", COINSTATS_API_KEY: undefined });

    expect(handleGetProviderKeyStatus()).toEqual({
      ZERION_API_KEY: true,
      COINSTATS_API_KEY: false,
    });
  });

  it("env 里是空串 → 算没配,不是配了", () => {
    withKeys({ ZERION_API_KEY: "", COINSTATS_API_KEY: "" });

    expect(handleGetProviderKeyStatus()).toEqual({
      ZERION_API_KEY: false,
      COINSTATS_API_KEY: false,
    });
  });

  it("返回的必须是布尔 —— 连 key 的一个字符都不许漏出去", () => {
    // **红线。** 这个接口存在的意义就是「告诉界面某个 provider 能不能用」,而不是回显配置。
    // 断言值的类型,而不只是真假:有人把它「顺手」改成返回前四位做提示,这条会红。
    withKeys({ ZERION_API_KEY: "super-secret-zerion", COINSTATS_API_KEY: "super-secret-cs" });

    const out = handleGetProviderKeyStatus();

    expect(typeof out.ZERION_API_KEY).toBe("boolean");
    expect(typeof out.COINSTATS_API_KEY).toBe("boolean");
    expect(JSON.stringify(out)).not.toContain("super-secret");
  });
});
