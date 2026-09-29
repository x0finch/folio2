import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeMessage, type QueueMessage } from "@/lib/server/jobs/consume";
import { handleGetCurrencyPreference } from "@/lib/server/preferences/currency";
import { displayRate as rateOf } from "@/lib/server/preferences/fx";
import { runEffect } from "@/lib/server/runtime";

// 展示币种汇率的应用层接线(#202b)。走**真 D1**(Miniflare)—— 这一段的风险全在
// 「per-user 缓存真的写进去了、下次真的读得到」上,内存假实现测不到这个。
//
// `displayRate` 自己只是一段 effect 了(#504 T7),所以这里补上生产那条发动路
// (`runEffect` = server fn 的唯一入口)。**十六条断言一行没动** —— 它们本来测的就是
// 「这个用户问这个币种拿到什么」,那件事没变。
//
// 上游一律打桩:既记账(断言看的是「出了几次网」)又能按用例换返回值。

const displayRate = (userId: string, code: string) =>
  runEffect(() => rateOf(code))({ data: undefined, context: { userId } });

// 汇率的唯一写入口:队列的 `fx` 活(FOL-88)。走生产那条 consumer 路,期望它 ack(上游挂了也 ack ——
// 参考层自己降级,不交给队列重投)。
const warmFx = async (userId: string): Promise<void> => {
  let acked = false;
  const message: QueueMessage = {
    id: "m-fx",
    body: { kind: "fx", userId },
    attempts: 1,
    ack: () => {
      acked = true;
    },
    retry: () => {},
  };
  await Effect.runPromise(consumeMessage(message));
  expect(acked).toBe(true);
};

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

describe("暖过之后(汇率只由队列的 fx 活刷,FOL-88)", () => {
  it("fx 活暖过 → 读得到汇率,读这一下零出网", async () => {
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]);
  });

  it("那一次是一把全拉 → 别的币种也已经是热的(同一份响应顺手写全了)", async () => {
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(USER, "JPY")).toBeCloseTo(100000 / 15000000, 9);
    expect(outbound).toEqual([]);
  });

  it("真落进了这个用户的缓存(而不是只在内存里)", async () => {
    await warmFx(USER);
    const row = await env.DB.prepare("SELECT v FROM user_cache WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .first<{ v: string }>();
    expect(Number(row?.v)).toBeCloseTo(100000 / 92000, 6);
  });

  // 隔离的证据:两个**都存在**的用户各有一份缓存,没暖过的那个蹭不到前一个的(以前的证据是
  // 「它得自己出一趟网」—— 读路径不出网之后,它就是拿不到)。
  it("按用户隔离:另一个用户没暖过 → 拿不到,也不出网", async () => {
    await insertUser(OTHER);
    await warmFx(USER);
    outbound = [];
    expect(await displayRate(OTHER, "EUR")).toBeUndefined();
    expect(outbound).toEqual([]);
  });
});

describe("拿不到的时候", () => {
  it("缓存冷 → undefined,**不出网**(读端点不回源,FOL-88)", async () => {
    expect(await displayRate(USER, "EUR")).toBeUndefined();
    expect(outbound).toEqual([]);
  });

  it("上游没收录这个币种 → 暖过也还是 undefined(调用方回退 USD),而且不写脏值", async () => {
    await warmFx(USER);
    expect(await displayRate(USER, "KRW")).toBeUndefined();
  });

  it("上游挂了 → fx 活照样 ack(参考层降级),读 undefined,**不抛**", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("network down");
    });
    await warmFx(USER);
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
    await warmFx(USER);
    expect(await displayRate(USER, "EUR")).toBeUndefined();
  });
});

describe("软过期", () => {
  it("缓存过期了照样给旧值,而且不出网 —— 旧汇率比没汇率好", async () => {
    await warmFx(USER);
    // 把过期戳推到过去(模拟隔了很久没预热)。
    await env.DB.prepare("UPDATE user_cache SET expires_at = 1 WHERE user_id = ? AND k = ?")
      .bind(USER, "fx:EUR")
      .run();
    outbound = [];

    expect(await displayRate(USER, "EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(outbound).toEqual([]); // 读路径不为新鲜度出网,那是预热的活
  });
});

// `getCurrencyPreference` 那个 handler:码由浏览器作参数传来(ADR 0049 补记,以前读 cookie ——
// 那时它要 TanStack 的请求上下文,这一层 import 不进来,这几条只能 skip)。现在它只是
// 「校验码 → 问汇率 → 套形状」,可以在这里走真 D1 了。
describe("getCurrencyPreference", () => {
  const preferenceOf = (userId: string, code: string) =>
    runEffect(handleGetCurrencyPreference)({ data: { code }, context: { userId } });

  it("支持的币种 + 汇率可得 → 就是那个币种和它的汇率", async () => {
    await warmFx(USER);
    const pref = await preferenceOf(USER, "EUR");
    expect(pref.currency.code).toBe("EUR");
    expect(pref.rate).toBeCloseTo(100000 / 92000, 6);
  });

  it("取不到汇率 → 整体回退 USD(不是「EUR 按 1 算」)", async () => {
    await warmFx(USER);
    const pref = await preferenceOf(USER, "KRW");
    expect(pref).toMatchObject({ currency: { code: "USD" }, rate: 1 });
  });

  it("认不出的码 → 当 USD,且一次网都不出(码是用户可改的输入)", async () => {
    const pref = await preferenceOf(USER, "DOGE");
    expect(pref).toMatchObject({ currency: { code: "USD" }, rate: 1 });
    expect(outbound).toEqual([]);
  });
});
