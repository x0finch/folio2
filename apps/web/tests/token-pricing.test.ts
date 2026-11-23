import { type TokenRef, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { priceTickets, type TickerPrice } from "@/lib/server/tokens/pricing";
import { type OracleStub, runWithOracleAt } from "./oracle-stub";

//

const CRYPTO = "coingecko";
const NAMERS = [CRYPTO, "fiat"] as const;
const NOW = 1_700_000_000_000;

const cryptoTicket = (id: string) => tokenTicket.encode(tokenRef.issued(CRYPTO, id));
const fiatTicket = (code: string) => tokenTicket.encode(tokenRef.issued("fiat", code));

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

const run = (stub: OracleStub, tickets: readonly string[]) =>
  runWithOracleAt(NOW, stub, priceTickets(tickets, { namers: NAMERS }));

describe("priceTickets: fiat goes through FX, the rest through the token source", () => {
  it("crypto ticket: goes through the token source, price mapped back to the ticket (unitPrice/change24h/asOf)", async () => {
    const btc = cryptoTicket("bitcoin");
    const { tokens } = fakeCrypto({
      [tokenRef.issued(CRYPTO, "bitcoin")]: { unitPrice: 62000, change24h: -2, asOf: 111 },
    });
    expect(await run({ tokens }, [btc])).toEqual([
      { ticket: btc, unitPrice: 62000, change24h: -2, asOf: 111 },
    ]);
  });

  it("fiat ticket: goes through the FX cache, no 24h, asOf=now; **never warms** (no outbound call within a request)", async () => {
    const eur = fiatTicket("EUR");
    const { fx, warmed } = fakeFx({ EUR: 1.15 });
    const { tokens, calls } = fakeCrypto({});
    expect(await run({ tokens, fx }, [eur])).toEqual([
      { ticket: eur, unitPrice: 1.15, change24h: null, asOf: NOW },
    ]);
    expect(warmed).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("mixed batch: crypto via the token source, fiat via FX, each returned separately", async () => {
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
    expect(calls[0]).toEqual([tokenRef.issued(CRYPTO, "bitcoin")]);
  });

  it("FX unavailable (cold / non-USD without rate): that fiat ticket is absent (degrades)", async () => {
    const { fx } = fakeFx();
    expect(await run({ fx }, [fiatTicket("JPY")])).toEqual([]);
  });

  it("token source does not know the ref: absent (not an error)", async () => {
    const { tokens } = fakeCrypto({});
    expect(await run({ tokens }, [cryptoTicket("nope")])).toEqual([]);
  });

  it("non-allowlisted fiat/issued:XXX: falls back to the token source path (fiatCodeOf empty), just gets no price", async () => {
    const bogus = fiatTicket("XXX");
    const { tokens, calls } = fakeCrypto({});
    const { fx } = fakeFx({ XXX: 999 });
    expect(await run({ tokens, fx }, [bogus])).toEqual([]);
    expect(calls[0]).toEqual([tokenRef.issued("fiat", "XXX")]);
  });

  it("undecodable / foreign-namer tickets: dropped; all dropped: empty, no outbound call", async () => {
    const { tokens, calls } = fakeCrypto({});
    const other = tokenTicket.encode(tokenRef.issued("binance", "USDC"));
    expect(await run({ tokens }, ["!!!not-a-ticket!!!", other])).toEqual([]);
    expect(calls).toEqual([]);
  });
});
