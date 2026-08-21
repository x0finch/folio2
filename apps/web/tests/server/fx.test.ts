import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { displayRate } from "../../src/lib/server/preferences/fx";

// 展示币种汇率的应用层接线(#202b)。走**真 D1**(Miniflare)—— 这一段的风险全在
// 「per-user 缓存真的写进去了、下次真的读得到」上,内存假实现测不到这个。
//
// 上游一律打桩:既记账(断言看的是「出了几次网」)又能按用例换返回值。

const USER = "user-fx";
const OTHER = "user-fx-other";

async function insertUser(id: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, id, `${id}@example.com`, 0, now, now)
    .run();
}

async function resetUser(): Promise<void> {
  for (const id of [USER, OTHER]) {
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(id).run(); // cascade → user_cache
  }
  await insertUser(USER);
}

// 上游那个端点以 BTC 为基准:value = 1 BTC 值多少该币种。
// usdPerUnit(EUR) = 100000 / 92000 ≈ 1.087;KRW 故意不给 —— 「上游没收录」那一档。
const RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" },
    eur: { value: 92000, type: "fiat" },
    jpy: { value: 15000000, type: "fiat" },
  },
};

let outbound: string[] = [];

beforeEach(async () => {
  await resetUser();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    return new Response(JSON.stringify(RATES), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

afterEach(() => vi.restoreAllMocks());

describe("USD", () => {
  it("恒 1,而且一次网都不出", async () => {
    expect(await displayRate(USER, "USD")).toBe(1);
    expect(outbound).toEqual([]);
  });
});

describe("冷缓存 —— 「第一次切币种」那一档", () => {
  it("库里什么都没有 → 拉一次 → 立刻拿到汇率", async () => {
    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]).toContain("/exchange_rates");
  });

  it("第二次问同一个币种 → 命中缓存,零请求", async () => {
    await displayRate(USER, "EUR");
    outbound = [];

    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]);
  });

  it("那一次是一把全拉 → 换个币种也已经是热的(同一份响应顺手写全了)", async () => {
    await displayRate(USER, "EUR");
    outbound = [];

    expect(await displayRate(USER, "JPY")).toBeCloseTo(100000 / 15000000, 9);
    expect(outbound).toEqual([]);
  });

  it("真落进了这个用户的缓存(而不是只在内存里)", async () => {
    await displayRate(USER, "EUR");
    const row = await env.DB.prepare("SELECT v FROM user_cache WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .first<{ v: string }>();
    expect(Number(row?.v)).toBeCloseTo(100000 / 92000, 6);
  });

  // **隔离的证据是「它得自己出一趟网」**,不是「它拿不到」。
  //
  // 这条用例原来是拿一个**不存在的 user** 去问的:写缓存撞外键 → D1 抛 → `displayRate` 那个
  // 包住一切的 `try/catch` 吞掉 → `undefined`。也就是说它断言的其实是「D1 报错会被吞」。
  // #362 第 4 站把那个 catch-all 拆了(store 的失败是 defect,一路冒到 `runPromise` —— 与迁移前
  // 「没人 catch 它」的实际行为一致,只是不再被这一层顺手吞掉),于是这条用例得回到它本来的意思:
  // 两个**都存在**的用户各有一份缓存,后来的那个蹭不到前一个的。
  it("按用户隔离:另一个用户问同一个币种,得自己出一趟网", async () => {
    await insertUser(OTHER);
    await displayRate(USER, "EUR");
    outbound = [];

    expect(await displayRate(OTHER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toHaveLength(1); // 它自己出网了一趟,没蹭到别人的缓存
  });
});

describe("拿不到的时候", () => {
  it("上游没收录这个币种 → undefined(调用方回退 USD)", async () => {
    // KRW 不在那份响应里 —— 拉过一次也还是没有,而且不写脏值。
    expect(await displayRate(USER, "KRW")).toBeUndefined();
    expect(outbound).toHaveLength(1);
  });

  it("上游挂了 → undefined,**不抛** —— 认证区不该因为拿不到汇率而加载失败", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    expect(await displayRate(USER, "EUR")).toBeUndefined();
  });

  it("上游返回坏响应(基准 usd 缺失)→ 同样 undefined,不抛", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () =>
        new Response(JSON.stringify({ rates: { eur: { value: 1 } } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await displayRate(USER, "EUR")).toBeUndefined();
  });
});

describe("软过期", () => {
  it("缓存过期了照样给旧值,而且不出网 —— 旧汇率比没汇率好", async () => {
    await displayRate(USER, "EUR");
    // 把过期戳推到过去(模拟隔了很久没预热)。
    await env.DB.prepare("UPDATE user_cache SET expires_at = 1 WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .run();
    outbound = [];

    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]); // 读路径不为新鲜度出网,那是预热的活
  });
});
