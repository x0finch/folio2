import { type TokenRef, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { priceTickets, type TickerPrice } from "../src/lib/server/tokens/pricing";
import { type OracleStub, runWithOracleAt } from "./oracle-stub";

// 选币「一批票 → 价」分流(refreshTokenPrices / getTokenPrice 共用的芯):法币走 FX、其余走代币源。
// 这里钉的就是那两个 server fn 里不好直接测的那段 —— 尤其「已有代币」组里法币能拿到价这条(bug 修复)。
//
// 取数从四个注入回调换成了 `R` 通道上的两个服务(`TokenService` / `FxService`),所以桩也
// 从「四个函数」变成「一份 layer」(共用的 `oracle-stub`)。`asOf` 走 `Clock` → 时钟钉在 NOW。

const CRYPTO = "coingecko"; // 当前代币上游命名者(= UPSTREAM_ID)
const NAMERS = [CRYPTO, "fiat"] as const;
const NOW = 1_700_000_000_000;

const cryptoTicket = (id: string) => tokenTicket.encode(tokenRef.issued(CRYPTO, id));
const fiatTicket = (code: string) => tokenTicket.encode(tokenRef.issued("fiat", code));

// 代币价格源的桩:按 ref 给价,记下被问了哪些 ref。
function fakeCrypto(prices: Record<string, TickerPrice>) {
  const calls: TokenRef[][] = [];
  const tokens = {
    pricesByRefs: (refs: readonly TokenRef[]) =>
      Effect.sync(() => {
        calls.push([...refs]);
        const out = new Map<TokenRef, TickerPrice>();
        for (const r of refs) if (prices[r]) out.set(r, prices[r]);
        return out;
      }),
  };
  return { tokens, calls };
}

// FX 桩:按表给汇率,记下被问了哪些 code / warm 过哪些。
function fakeFx(rates: Record<string, number> = {}) {
  const asked: string[] = [];
  const warmed: string[][] = [];
  const fx = {
    resolve: (code: string) =>
      Effect.sync(() => {
        asked.push(code);
        return Option.fromNullable(rates[code.trim().toUpperCase()]);
      }),
    warm: (codes: readonly string[] = []) => Effect.sync(() => void warmed.push([...codes])),
  };
  return { fx, asked, warmed };
}

const run = (stub: OracleStub, tickets: readonly string[], warmFiat = false) =>
  runWithOracleAt(NOW, stub, priceTickets(tickets, { namers: NAMERS, warmFiat }));

describe("priceTickets —— 法币走 FX、其余走代币源", () => {
  it("加密币票:走代币源,价映射回票(unitPrice/change24h/asOf)", async () => {
    const btc = cryptoTicket("bitcoin");
    const { tokens } = fakeCrypto({
      [tokenRef.issued(CRYPTO, "bitcoin")]: { unitPrice: 62000, change24h: -2, asOf: 111 },
    });
    expect(await run({ tokens }, [btc])).toEqual([
      { ticket: btc, unitPrice: 62000, change24h: -2, asOf: 111 },
    ]);
  });

  it("法币票:走 FX,无 24h、asOf=now;命中的 code 先 warm 过", async () => {
    const eur = fiatTicket("EUR");
    const { fx, warmed } = fakeFx({ EUR: 1.15 });
    const { tokens, calls } = fakeCrypto({});
    expect(await run({ tokens, fx }, [eur], true)).toEqual([
      { ticket: eur, unitPrice: 1.15, change24h: null, asOf: NOW },
    ]);
    expect(warmed).toEqual([["EUR"]]); // 先暖再 resolve
    expect(calls).toEqual([]); // 法币不惊动代币源
  });

  it("混一批:加密走代币源、法币走 FX,各回各的", async () => {
    const btc = cryptoTicket("bitcoin");
    const eur = fiatTicket("EUR");
    const { tokens, calls } = fakeCrypto({
      [tokenRef.issued(CRYPTO, "bitcoin")]: { unitPrice: 62000, asOf: 1 },
    });
    const { fx } = fakeFx({ EUR: 1.15 });
    const out = await run({ tokens, fx }, [btc, eur]);
    expect(out.map((o) => [o.ticket, o.unitPrice])).toEqual([
      [btc, 62000],
      [eur, 1.15],
    ]);
    expect(calls[0]).toEqual([tokenRef.issued(CRYPTO, "bitcoin")]); // 代币源只被问加密那条
  });

  it("FX 取不到(冷 / 非 USD 无汇率)→ 该法币票不出现(降级)", async () => {
    const { fx } = fakeFx(); // 没暖到
    expect(await run({ fx }, [fiatTicket("JPY")])).toEqual([]);
  });

  it("代币源没收录该 ref → 不出现(不是报错)", async () => {
    const { tokens } = fakeCrypto({});
    expect(await run({ tokens }, [cryptoTicket("nope")])).toEqual([]);
  });

  it("白名单外的 fiat/issued:XXX → 落回代币源那路(fiatCodeOf 空),拿不到价而已", async () => {
    const bogus = fiatTicket("XXX"); // 命名者是 fiat,但不在支持币种白名单
    const { tokens, calls } = fakeCrypto({});
    const { fx } = fakeFx({ XXX: 999 }); // 就算 FX 会给,也不该走到这
    expect(await run({ tokens, fx }, [bogus])).toEqual([]); // 代币源没有它 → 空
    expect(calls[0]).toEqual([tokenRef.issued("fiat", "XXX")]); // 确实落到了代币源那路
  });

  it("解不开 / 别家命名者的票 → 丢弃;全丢 → 空,不出网", async () => {
    const { tokens, calls } = fakeCrypto({});
    const other = tokenTicket.encode(tokenRef.issued("binance", "USDC")); // 命名者不在 namers
    expect(await run({ tokens }, ["!!!not-a-ticket!!!", other])).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("不开 warmFiat(单条预填那路)也照常出价、不炸", async () => {
    const eur = fiatTicket("EUR");
    const { fx, warmed } = fakeFx({ EUR: 1.15 });
    expect(await run({ fx }, [eur])).toEqual([
      { ticket: eur, unitPrice: 1.15, change24h: null, asOf: NOW },
    ]);
    expect(warmed).toEqual([]); // 没暖过 —— 那一路靠 loader 已暖的缓存
  });
});
