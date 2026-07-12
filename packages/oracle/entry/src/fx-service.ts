import {
  type FxRates,
  type FxSource,
  type FxStore,
  SUPPORTED_CURRENCIES,
} from "@folio/oracle-basic";

// FX 变化慢 → 6h TTL。TTL 只闸 warm;resolve 软过期(返最近值)。
const FX_TTL_MS = 6 * 60 * 60 * 1000;

const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

export interface CreateFxRatesConfig {
  source: FxSource;
  store: FxStore;
  now?: () => number;
}

export function createFxRates({ source, store, now = Date.now }: CreateFxRatesConfig): FxRates {
  return {
    // 读:USD 恒 1;其余返回缓存里最近一次 usdPerUnit(软过期,不看 expiresAt);缺 → undefined。
    async resolve(currency) {
      if (currency === "USD") return 1;
      const rows = await store.getRates([currency]);
      return rows.get(currency)?.usdPerUnit;
    },

    // 写:任一目标币种缺失/过期 → 一次 fetchRates 全量 → putRates。
    async warm(currencies = ALL_CODES) {
      const targets = [...new Set(currencies)].filter((c) => c !== "USD");
      if (targets.length === 0) return;
      const cached = await store.getRates(targets);
      const stale = targets.some((c) => {
        const r = cached.get(c);
        return !r || r.expiresAt <= now();
      });
      if (!stale) return;

      const fresh = await source.fetchRates();
      const expiresAt = now() + FX_TTL_MS;
      const rows = [...fresh].map(([currency, usdPerUnit]) => ({
        currency,
        usdPerUnit,
        expiresAt,
      }));
      if (rows.length > 0) await store.putRates(rows);
    },
  };
}
