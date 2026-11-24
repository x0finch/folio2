import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { consumeMessage } from "@/lib/server/jobs/consume";
import { handleListFiatOptions } from "@/lib/server/tokens/list-fiat-options";
import { json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { freshUser } from "../_kit/user";

// Runs inside tokens/index.test.ts: each vitest file re-evaluates the whole import graph in workerd (~9s/file), so cases are merged per directory.
describe("tokens/list-fiat-options", () => {
  // Takes the language from the caller (the UI language lives in the browser); how names are localized is covered by `tests/fiat-options.test.ts`.
  // This covers the handler's own half: attaching rates, and degrading when they're unavailable.
  const USER = "h-tok-fiat";

  // The upstream is BTC-based: value = how much of the currency 1 BTC is worth. KRW is deliberately absent (the "not covered upstream" case).
  const RATES = {
    rates: {
      btc: { value: 1, type: "crypto" },
      usd: { value: 100000, type: "fiat" },
      eur: { value: 92000, type: "fiat" },
    },
  };

  const bySymbol = <T extends { symbol: string }>(options: readonly T[], symbol: string) =>
    options.find((o) => o.symbol === symbol);

  // Rates are warmed only by the queue's `fx` job and the handler reads only the cache, so cases needing rates run one first.
  const warmFx = () =>
    Effect.runPromise(
      consumeMessage({
        id: "m-fx",
        body: { kind: "fx", userId: USER },
        attempts: 1,
        ack: () => {},
        retry: () => {},
      }),
    );

  beforeEach(async () => {
    await freshUser(USER);
  });

  describe("listFiatOptions", () => {
    it("locale is zh -> names are Chinese", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      const out = await call(USER, handleListFiatOptions({ locale: "zh" }));
      expect(bySymbol(out, "EUR")?.name).toBe(
        new Intl.DisplayNames(["zh"], { type: "currency" }).of("EUR"),
      );
    });

    it("unrecognized locale -> falls back to the default language (the code is caller-editable input)", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      const junk = await call(USER, handleListFiatOptions({ locale: "x".repeat(64) }));
      const en = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(junk.map((o) => o.name)).toEqual(en.map((o) => o.name));
    });

    it("a currency with no rate -> only that item is missing, not the whole batch", async () => {
      stubOutbound([["/exchange_rates", () => json(RATES)]]);
      await warmFx();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      const krw = bySymbol(out, "KRW") as { price?: number } | undefined;
      expect(krw).toBeDefined();
      expect(krw?.price).toBeUndefined();
      expect((bySymbol(out, "EUR") as { price?: number }).price).toBeDefined();
    });

    it("rate upstream is entirely down -> options still returned, the UI can still pick", async () => {
      stubOutbound([["/exchange_rates", () => json({ error: "down" }, 503)]]);
      await warmFx();
      const out = await call(USER, handleListFiatOptions({ locale: "en" }));
      expect(out.length).toBeGreaterThan(1);
      // USD is always 1 and needs no upstream; the rest have no price.
      expect((bySymbol(out, "EUR") as { price?: number }).price).toBeUndefined();
    });
  });
});
