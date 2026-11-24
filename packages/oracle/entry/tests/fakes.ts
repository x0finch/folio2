import type {
  CacheEntry,
  CacheStore,
  DbEnv,
  DbRequest,
  GlobalRefIndexStore,
  TokenPriceStore,
  TokenStore,
} from "@folio/db";
import { DatabaseForOracle, GlobalDatabase, provideCurrentUser, provideDbClient } from "@folio/db";
import type {
  FxUpstream,
  PlatformMeta,
  PlatformUpstream,
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenPrice,
  TokenPricePoint,
  TokenPriceWrite,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
  TokenUpstream,
  UpstreamToken,
} from "@folio/oracle-basic";
import * as Ports from "@folio/oracle-basic/ports";
import { parseTokenRef } from "@folio/oracle-ref";
import { type UpstreamError, UpstreamUnavailableError } from "@folio/upstream-basic";
import { Clock, Effect, Layer, Logger, Option, References } from "effect";
import { TestClock } from "effect/testing";
import type { OraclePorts, OracleServices } from "../src";
import { GlobalRefIndexService, Oracle, oracleLayer } from "../src";
import { FxService } from "../src/fx";
import { PlatformService } from "../src/platforms";
import { TokenService } from "../src/tokens";
import { CandidateSource } from "../src/tokens/candidates";

// In-memory fakes plus the shared test harness (`harness`, below). In-memory rather than real D1: these slices never touch the schema,
// so the contract is pinned here. No data source is named in the fakes (`fakeUpstream()`'s id is a parameter, default "src").
// Time is not a `now` field on fakes: everything goes through `Clock`, use `yield* TestClock.adjust(…)`.
// One construction path: every test goes `harness.run` to Tag to Layer, the one production uses.

const NOW0 = 1_700_000_000_000;
export const now0 = NOW0;

// Real store ops take the connection and user from context at run time, so the contract types carry `DbRequest` in `R`. The fakes need
// neither: their methods have `R = never`, so tests can `runPromise` them directly and they still stand in for the real store.
type InMemory<S> = {
  [K in keyof S]: S[K] extends (...args: infer P) => Effect.Effect<infer A, infer E, DbRequest>
    ? (...args: P) => Effect.Effect<A, E>
    : S[K];
};

// per-user: token rows' info facet + ref rows
interface FakeTokenStore extends InMemory<TokenStore> {
  readonly rows: Map<string, TokenInfo>;
  readonly refs: Map<TokenRef, string>;
  // Token_ids of historical snapshots: merge repoints them too, so tests can verify "identity mutable, amounts unchanged".
  readonly snapshotTokenIds: string[];
  namer: string; // for `linked`: which namer counts as "recognised"
}

function fakeTokenStore(seed: TokenInfo[] = [], namer = "src"): FakeTokenStore {
  const rows = new Map<string, TokenInfo>(seed.map((r) => [r.id, r]));
  const refs = new Map<TokenRef, string>();
  const snapshotTokenIds: string[] = [];
  let seq = 0;

  const store: FakeTokenStore = {
    rows,
    refs,
    snapshotTokenIds,
    namer,

    findByRefs: (input) =>
      Effect.sync(() => {
        // linked = this Token already has a ref row for the current source (a join in the real implementation).
        const linked = new Set<string>();
        for (const [ref, id] of refs) if (ref.startsWith(`${store.namer}/`)) linked.add(id);

        const out = new Map<TokenRef, TokenRefHit>();
        for (const ref of input) {
          const tokenId = refs.get(ref);
          if (tokenId) out.set(ref, { tokenId, linked: linked.has(tokenId) });
        }
        return out;
      }),

    create: (s: ProviderTokenSeed, newRefs) =>
      Effect.sync(() => {
        // upsert-then-read: under concurrency someone may have created it already, so check whether these refs have an owner first.
        for (const ref of newRefs) {
          const existing = refs.get(ref);
          if (existing) {
            for (const r of newRefs) refs.set(r, existing);
            return existing;
          }
        }
        seq += 1;
        const id = `tk_${seq}`;
        // The provider's logo goes to providerLogo (spare slot); `logo` is the source's slot, left for later.
        // `ref` = the current source's name for it: set if a ref of this source is attached at creation, else null.
        const sourceRef = newRefs.find((r) => r.startsWith(`${store.namer}/`)) ?? null;
        rows.set(id, {
          id,
          ref: sourceRef,
          symbol: s.symbol,
          name: s.name ?? s.symbol,
          providerLogo: s.providerLogo,
          // Counts as "due for refresh" at creation: this info is the connector's, upstream has not overwritten it yet (as in the D1 implementation).
          infoStale: true,
        });
        for (const ref of newRefs) refs.set(ref, id);
        return id;
      }),

    linkRef: (tokenId, ref) =>
      Effect.sync(() => {
        const existing = refs.get(ref);
        if (existing) return existing;
        refs.set(ref, tokenId);
        const row = rows.get(tokenId);
        if (row && ref.startsWith(`${store.namer}/`)) row.ref = ref;
        // A ref was really added: mark info stale (contract in stores.ts: this is evidence of a rename).
        if (row) row.infoStale = true;
        return tokenId;
      }),

    merge: (from, into) =>
      Effect.sync(() => {
        for (const [ref, id] of refs) if (id === from) refs.set(ref, into);
        for (let i = 0; i < snapshotTokenIds.length; i++) {
          if (snapshotTokenIds[i] === from) snapshotTokenIds[i] = into;
        }
        const src = rows.get(from);
        const dst = rows.get(into);
        // The old row's provider logo is a fallback-chain tier; do not lose it with the row.
        if (src && dst && !dst.providerLogo && src.providerLogo) {
          dst.providerLogo = src.providerLogo;
        }
        // Mark the winner's info stale: a merge means at least one side's name differs from upstream's current one.
        if (dst) dst.infoStale = true;
        rows.delete(from);
      }),

    getByIds: (ids) =>
      Effect.sync(() => {
        const out = new Map<string, TokenInfo>();
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.set(id, { ...row });
        }
        return out;
      }),

    getAll: () =>
      Effect.sync(() => new Map([...rows].map(([id, row]) => [id, { ...row }] as const))),

    getById: (id) => Effect.sync(() => Option.fromNullishOr(rows.get(id)).pipe(Option.map(clone))),

    fillInfo: (tokenId, patch: TokenInfoPatch) =>
      Effect.sync(() => {
        const row = rows.get(tokenId);
        if (!row) return;
        // Fill empty slots only; fields with values are untouched.
        if (!row.name && patch.name) row.name = patch.name;
        row.logo ??= patch.logo;
        row.providerLogo ??= patch.providerLogo;
      }),

    // Overwrite (opposite of fillInfo). After a refresh infoStale clears, so tests can verify "no wasted refresh every time".
    putInfo: (writes: readonly TokenInfoWrite[]) =>
      Effect.sync(() => {
        for (const w of writes) {
          const row = rows.get(w.tokenId);
          if (!row) continue;
          row.symbol = w.symbol;
          row.name = w.name;
          if (w.logo !== undefined) row.logo = w.logo; // upstream gave no logo: keep the existing one
          row.infoStale = false;
        }
      }),

    candidatesBySymbol: (symbol) =>
      Effect.sync(() => {
        const out: TokenCandidate[] = [];
        for (const row of rows.values()) {
          if (row.ref && row.symbol.toUpperCase() === symbol.toUpperCase()) {
            out.push({ ref: row.ref });
          }
        }
        return out;
      }),
  };
  return store;
}

const clone = (row: TokenInfo): TokenInfo => ({ ...row });

// per-user: price facet + historical daily prices
interface FakeTokenPriceStore extends InMemory<TokenPriceStore> {
  readonly current: Map<string, { price: TokenPrice; expiresAt: number }>;
  readonly daily: Map<string, Map<number, number>>;
  // Daily history stored directly by ref (separate from `daily`, keyed by tokenId; the real table is one token_daily_prices, but the
  // fake buckets by call path so assertions show which path was taken).
  readonly dailyByRef: Map<string, Map<number, number>>;
}

function fakeTokenPriceStore(): FakeTokenPriceStore {
  const current = new Map<string, { price: TokenPrice; expiresAt: number }>();
  const daily = new Map<string, Map<number, number>>();
  const dailyByRef = new Map<string, Map<number, number>>();

  const readDaily = (
    bucket: Map<string, Map<number, number>>,
    key: string,
    days: readonly number[],
  ) =>
    Effect.sync(() => {
      const byDay = bucket.get(key);
      const out = new Map<number, number>();
      if (!byDay) return out;
      for (const b of days) {
        const v = byDay.get(b);
        if (v != null) out.set(b, v);
      }
      return out;
    });

  const writeDaily = (
    bucket: Map<string, Map<number, number>>,
    key: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ) =>
    Effect.sync(() => {
      const byDay = bucket.get(key) ?? new Map<number, number>();
      for (const p of prices) byDay.set(p.dayBucket, p.unitPrice);
      bucket.set(key, byDay);
    });

  return {
    current,
    daily,
    dailyByRef,

    getByIds: (ids) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const out = new Map<string, TokenRecordPrice>();
        for (const id of ids) {
          const hit = current.get(id);
          // Expired is not deleted, read with stale (SWR).
          if (hit) out.set(id, { ...hit.price, stale: hit.expiresAt <= now });
        }
        return out;
      }),

    getAll: () =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const out = new Map<string, TokenRecordPrice>();
        for (const [id, hit] of current) out.set(id, { ...hit.price, stale: hit.expiresAt <= now });
        return out;
      }),

    put: (writes: readonly TokenPriceWrite[], ttlMs) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        for (const w of writes) {
          const { tokenId, ...price } = w;
          current.set(tokenId, { price, expiresAt: now + ttlMs });
        }
      }),

    getDaily: (tokenId, dayBuckets) => readDaily(daily, tokenId, dayBuckets),
    putDaily: (tokenId, prices) => writeDaily(daily, tokenId, prices),
    getDailyByRef: (ref, dayBuckets) => readDaily(dailyByRef, ref, dayBuckets),
    putDailyByRef: (ref, prices) => writeDaily(dailyByRef, ref, prices),
  };
}

// Global ref-index table
// The contract comes from `@folio/db`'s ticket (no owner, so not a reference-layer port); field types are taken, not re-copied.
interface FakeGlobalRefIndexStore extends InMemory<GlobalRefIndexStore> {
  // Test helper to insert a mapping directly (simulating cron refreshing the table). Does not expose the internal key format, so a key format change cannot silently mismatch tests.
  // chainRef to the whole upstreamRef (the value is the whole ref, not a bare id).
  set(upstream: string, chainRef: string, upstreamRef: TokenRef): void;
  writes: number; // putAll calls (verifies "one whole write", not per-row upserts)
  lookups: number;
}

const idxKey = (upstream: string, chainRef: string) => `${upstream} ${chainRef}`;

function fakeGlobalRefIndexStore(
  seed: Record<string, TokenRef> = {}, // chainRef to the whole upstreamRef
  upstream = "src",
): FakeGlobalRefIndexStore {
  const map = new Map<string, TokenRef>();
  for (const [chainRef, upstreamRef] of Object.entries(seed)) {
    map.set(idxKey(upstream, chainRef), upstreamRef);
  }
  const refreshedAt = new Map<string, number>();

  const store: FakeGlobalRefIndexStore = {
    set(u, chainRef, upstreamRef) {
      map.set(idxKey(u, chainRef), upstreamRef);
    },
    writes: 0,
    lookups: 0,

    lookup: (u, chainRefs) =>
      Effect.sync(() => {
        store.lookups += 1;
        const out = new Map<TokenRef, TokenRef>();
        for (const chainRef of chainRefs) {
          const v = map.get(idxKey(u, chainRef));
          if (v) out.set(chainRef, v);
        }
        return out;
      }),

    putAll: (rows: readonly TokenRefIndexRow[], updatedAt) =>
      Effect.sync(() => {
        store.writes += 1;
        // Diff counts: the real store returns changed/added/removed; the fake does too. insert = key absent before, update = present but its name changed.
        // del is by upstream diff in the real table; the fake overwrites by chainRef and does not simulate delisting, so 0.
        let updated = 0;
        let inserted = 0;
        for (const r of rows) {
          // upstream is derived from the whole upstreamRef (same as the real store splitting columns).
          const parts = parseTokenRef(r.upstreamRef);
          if (parts.kind === "unknown") continue;
          const key = idxKey(parts.namer, r.chainRef);
          const prev = map.get(key);
          if (prev === undefined) inserted += 1;
          else if (prev !== r.upstreamRef) updated += 1;
          map.set(key, r.upstreamRef);
          refreshedAt.set(parts.namer, updatedAt);
        }
        if (rows.length === 0) refreshedAt.set(upstream, updatedAt);
        return { updated, inserted, deleted: 0 };
      }),

    refreshedAt: (u) => Effect.sync(() => Option.fromNullishOr(refreshedAt.get(u))),
  };
  return store;
}

// per-user KV cache
interface FakeCacheStore extends InMemory<CacheStore> {
  readonly entries: Map<string, { value: unknown; expiresAt: number }>;
  writes: number; // write batches (not key count): "one batch write-back" assertions read this
  reads: number; // read round trips: "one read gets everything" assertions read this
}

function fakeCacheStore(): FakeCacheStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (key: string, now: number): CacheEntry | undefined => {
    const hit = entries.get(key);
    return hit ? { value: hit.value, stale: hit.expiresAt <= now } : undefined;
  };

  const store: FakeCacheStore = {
    entries,
    writes: 0,
    reads: 0,

    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.reads += 1;
        return Option.fromNullishOr(read(key, now));
      }),

    // One round trip: the real implementation is one `WHERE k IN (…)`, so one read is counted here too.
    getMany: (keys) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.reads += 1;
        const out = new Map<string, CacheEntry>();
        for (const key of new Set(keys)) {
          const hit = read(key, now);
          if (hit) out.set(key, hit); // missing keys are absent (by contract)
        }
        return out;
      }),

    put: (key, value, ttlMs) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.writes += 1;
        entries.set(key, { value, expiresAt: now + ttlMs });
      }),

    // One batch: the real implementation is one D1 `batch()`, so writes goes up by one.
    putMany: (batch) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (batch.length === 0) return;
        store.writes += 1;
        for (const w of batch) entries.set(w.key, { value: w.value, expiresAt: now + w.ttlMs });
      }),
  };
  return store;
}

// Upstream
// Failure injection: set `fail` to an `UpstreamError` and the next call (and every later one) fails with it, so tests verify
// degradation by type rather than a random thrown Error.
interface FakeUpstream extends TokenUpstream {
  readonly calls: string[];
  markets: UpstreamToken[];
  searchResults: UpstreamToken[];
  prices: Map<TokenRef, TokenPrice>;
  series: TokenPricePoint[]; // history leg for the default vsCurrency (USD)
  // History legs per vsCurrency (uppercase), used when fiat history derives "BTC priced in a currency"; a hit wins, else falls back to `series`.
  seriesByVs: Map<string, TokenPricePoint[]>;
  globalRefIndex: { rows: TokenRefIndexRow[]; unmatchedPlatforms: string[]; skipped: number };
  fail: UpstreamError | undefined;
}

export const upstreamDown = (upstream = "src"): UpstreamError =>
  new UpstreamUnavailableError({ upstream, where: "/fake", status: 503 });

function fakeUpstream(id = "src"): FakeUpstream {
  const src: FakeUpstream = {
    id,
    calls: [],
    markets: [],
    searchResults: [],
    prices: new Map(),
    series: [],
    seriesByVs: new Map(),
    globalRefIndex: { rows: [], unmatchedPlatforms: [], skipped: 0 },
    fail: undefined,

    fetchMarkets: ({ topN }) => gate(src, `fetchMarkets:${topN}`, () => src.markets.slice(0, topN)),

    searchTokens: (query) => gate(src, `searchTokens:${query}`, () => src.searchResults),

    fetchPrices: (refs) =>
      gate(src, `fetchPrices:${refs.join(",")}`, () => {
        const out = new Map<TokenRef, TokenPrice>();
        for (const ref of refs) {
          const p = src.prices.get(ref);
          if (p) out.set(ref, p);
        }
        return out;
      }),

    // Refs upstream does not list are absent from the result (by contract).
    fetchTokens: (refs) =>
      gate(src, `fetchTokens:${refs.join(",")}`, () =>
        src.markets.filter((t) => refs.includes(t.ref)),
      ),

    fetchPriceSeries: (ref, fromMs, toMs, vsCurrency = "usd") => {
      const vs = vsCurrency.toUpperCase();
      return gate(src, `fetchPriceSeries:${ref}:${vs}`, () => {
        const all = src.seriesByVs.get(vs) ?? src.series;
        return all.filter((p) => p.atMs >= fromMs && p.atMs <= toMs);
      });
    },

    fetchRefIndex: () => gate(src, "fetchRefIndex", () => src.globalRefIndex),
  };
  return src;
}

// Records a call, then succeeds or fails per `fail`.
const gate = <A>(
  src: { calls: string[]; fail: UpstreamError | undefined },
  call: string,
  value: () => A,
): Effect.Effect<A, UpstreamError> =>
  Effect.suspend(() => {
    src.calls.push(call);
    return src.fail ? Effect.fail(src.fail) : Effect.sync(value);
  });

// Fx upstream
interface FakeFxUpstream extends FxUpstream {
  fetches: number;
  rates: Map<string, number>;
  fail: UpstreamError | undefined;
  readonly calls: string[];
}

function fakeFxUpstream(rates: Record<string, number> = {}, id = "src"): FakeFxUpstream {
  const src: FakeFxUpstream = {
    id,
    fetches: 0,
    calls: [],
    fail: undefined,
    rates: new Map(Object.entries(rates)),
    // BTC base of the derivation and cache key of the BTC/USD history leg. Leg fetches go through the token upstream's fetchPriceSeries, not FxUpstream; only the base is declared here.
    btcRef: `${id}/issued:bitcoin`,
    fetchRates: () =>
      gate(src, "fetchRates", () => {
        src.fetches += 1;
        return new Map(src.rates);
      }),
  };
  return src;
}

// Platform upstream
interface FakePlatformUpstream extends PlatformUpstream {
  fetches: number;
  chains: PlatformMeta[];
  fail: UpstreamError | undefined;
  readonly calls: string[];
}

function fakePlatformUpstream(chains: PlatformMeta[] = [], id = "src"): FakePlatformUpstream {
  const src: FakePlatformUpstream = {
    id,
    fetches: 0,
    calls: [],
    fail: undefined,
    chains,
    fetchChains: () =>
      gate(src, "fetchChains", () => {
        src.fetches += 1;
        return src.chains;
      }),
  };
  return src;
}

// Shared test harness
// Copying the `provide` tail into each test file bit us before (client tests forgot the rate-limit tier and silently ran on the shared
// cursor tier, leaking across cases), so there is one entry: `const h = harness(); await h.run(Effect.flatMap(TokenService, ...))`.
// `run` provides fakes of all ports + the four real services (three per-user + global maintenance) + `TestContext` (virtual clock),
// with the clock at `now0` (fixed base so day buckets are deterministic). Logs are collected too: degradation must leave a trace,
// and that only counts if it can be asserted.
interface LogEntry {
  level: string;
  message: string;
  annotations: Record<string, unknown>;
}

export interface Harness {
  readonly store: FakeTokenStore;
  readonly prices: FakeTokenPriceStore;
  readonly cache: FakeCacheStore;
  readonly globalRefIndex: FakeGlobalRefIndexStore;
  readonly upstream: FakeUpstream;
  readonly fxUpstream: FakeFxUpstream;
  readonly platformUpstream: FakePlatformUpstream;
  // Logs emitted during this `run`, in order.
  readonly logs: LogEntry[];
  // Run an effect that uses the reference layer. Tests and production share one construction path (Tag to Layer).
  run<A, E>(
    effect: Effect.Effect<
      A,
      E,
      OraclePorts | OracleServices | GlobalRefIndexService | CandidateSource | DbRequest
    >,
  ): Promise<A>;
}

export interface HarnessOpts {
  seedRows?: TokenInfo[];
  namer?: string;
  globalRefIndexSeed?: Record<string, TokenRef>;
  rates?: Record<string, number>;
  chains?: PlatformMeta[];
  // symbol to upstream id curated table (`Namer.overrides`).
  overrides?: Readonly<Record<string, string>>;
  // Replaces the real candidate source (mint's cases must count how often it is asked: reaching the symbol tier is itself asserted). Real one if omitted.
  candidates?: CandidateSource["Service"];
}

// The "this request" in the harness. Fake stores do not bucket by user, so it is just a name.
const HARNESS_USER = "harness-user";
// Fake stores never touch D1; this connection only satisfies the types, and a real query would blow up in `drizzle` at once.
const unreachableD1 = { DB: {} } as DbEnv;

export function harness(opts: HarnessOpts = {}): Harness {
  const namer = opts.namer ?? "src";
  const store = fakeTokenStore(opts.seedRows, namer);
  const prices = fakeTokenPriceStore();
  const cache = fakeCacheStore();
  const globalRefIndex = fakeGlobalRefIndexStore(opts.globalRefIndexSeed, namer);
  const upstream = fakeUpstream(namer);
  const fxUpstream = fakeFxUpstream(opts.rates, namer);
  const platformUpstream = fakePlatformUpstream(opts.chains, namer);

  const logs: LogEntry[] = [];
  const logger = Logger.layer([
    Logger.make(({ message, logLevel, fiber }) => {
      logs.push({
        level: logLevel.toUpperCase(),
        message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
        annotations: { ...fiber.getRef(References.CurrentLogAnnotations) },
      });
    }),
  ]);

  const ports = Layer.mergeAll(
    // The local slices are db tickets, not ports (the contract is the db implementations). Fakes only cover fields the code under test
    // touches; `GlobalDatabase.accounts` is the cron's user scan, which the reference layer never uses.
    Layer.succeed(DatabaseForOracle, {
      tokens: store,
      tokenPrices: prices,
      cache,
    } as unknown as DatabaseForOracle["Service"]),
    Layer.succeed(GlobalDatabase, {
      refIndex: globalRefIndex,
      accounts: { listUserIds: () => Effect.succeed([]) },
    } as unknown as GlobalDatabase["Service"]),
    Layer.succeed(Ports.TokenUpstream, upstream),
    Layer.succeed(Ports.FxUpstream, fxUpstream),
    Layer.succeed(Ports.PlatformUpstream, platformUpstream),
    Layer.succeed(Ports.Namer, { id: namer, overrides: opts.overrides ?? {} }),
  );
  // `provideMerge` so ports are also exposed: cases get both services and fake ports (`readPlatforms(h.cache, …)` unit tests use ports directly).
  // `CandidateSource.layer` is exposed too: `oracleLayer` consumes it, but it has its own tests ("does the write path egress") needing the service.
  // Defaults to production's `oracleLayer` (so whole-assembly is covered by every case); only when a case replaces the candidate source
  // are the three services assembled by hand, since merging a same-Tag layer from outside is ambiguous about who wins.
  const services = opts.candidates
    ? Layer.mergeAll(
        // The aggregate `Oracle` must be present too: it holds these three services themselves, so `provideMerge` them rather than
        // building a second set after the candidate source is replaced.
        Layer.provideMerge(
          Oracle.layer,
          Layer.mergeAll(
            Layer.provide(TokenService.layer, Layer.succeed(CandidateSource, opts.candidates)),
            FxService.layer,
            PlatformService.layer,
          ),
        ),
        GlobalRefIndexService.layer,
        Layer.succeed(CandidateSource, opts.candidates),
      )
    : Layer.mergeAll(oracleLayer, CandidateSource.layer, GlobalRefIndexService.layer);
  const everything = Layer.provideMerge(services, ports);

  return {
    store,
    prices,
    cache,
    globalRefIndex,
    upstream,
    fxUpstream,
    platformUpstream,
    logs,
    run: (effect) =>
      Effect.runPromise(
        // Start at the fixed base (deterministic day buckets); cases advance time with `yield* TestClock.adjust(…)`.
        Effect.andThen(TestClock.setTime(NOW0), effect).pipe(
          Effect.provide(everything),
          // The two parts of a request, same as production's assembly point. Fake stores read neither; supplied because the layer's
          // `R` truthfully says "needs a request" and omitting them fails to compile.
          provideCurrentUser(HARNESS_USER),
          provideDbClient(unreachableD1),
          Effect.provide(logger),
          Effect.provide(TestClock.layer()),
        ),
      ),
  };
}
