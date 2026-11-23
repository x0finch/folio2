import {
  RESOLUTION_TOP_RANK,
  SUPPORTED_CURRENCIES,
  type TokenCandidate,
} from "@folio/oracle-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { MintInput } from "../src";
import { TokenService } from "../src/tokens";
import { CandidateSource } from "../src/tokens/candidates";
import { harness } from "./fakes";

const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SRC_USDC = "src/issued:usd-coin";

const seed = (symbol: string, name?: string, providerLogo?: string) => ({
  symbol,
  name,
  providerLogo,
});

// Candidate source for mint's symbol tier (the real one filters warm rows). Counts calls: "did it reach the symbol tier" is itself asserted.
interface RecordingCandidates extends CandidateSource {
  asked: string[];
}
const candidatesOf = (map: Record<string, TokenCandidate[]>): RecordingCandidates => {
  const asked: string[] = [];
  // `new CandidateSource(…)`: the service is an `Effect.Service` class, so the fake uses its own constructor like production.
  return Object.assign(
    new CandidateSource({
      bySymbol: (symbol) =>
        Effect.sync(() => {
          asked.push(symbol);
          return map[symbol] ?? [];
        }),
    }),
    { asked },
  );
};

// mint goes through Tag to Layer like production; replacing the candidate source swaps that one layer. `mint.of` is a Promise handle.
function setup(opts?: {
  index?: Record<string, string>;
  candidates?: Record<string, TokenCandidate[]>;
  overrides?: Record<string, string>;
}) {
  const candidates = candidatesOf(opts?.candidates ?? {});
  const h = harness({
    globalRefIndexSeed: opts?.index,
    overrides: opts?.overrides,
    candidates,
  });
  const mint = {
    of: (inputs: readonly MintInput[]) =>
      h.run(Effect.flatMap(TokenService, (t) => t.mint(inputs))),
  };
  return { h, store: h.store, globalRefIndex: h.globalRefIndex, candidates, mint };
}

describe("three paths", () => {
  it("1. hit on a local ref row: one local lookup, global map untouched", async () => {
    const { store, globalRefIndex, mint } = setup({ index: { [USDC_ETH]: SRC_USDC } });
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);

    const before = globalRefIndex.lookups;
    expect((await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH)).toBe(id);
    expect(globalRefIndex.lookups).toBe(before); // second call did no lookup
    expect(store.rows.size).toBe(1);
  });

  it("2. merged into an existing Token via the global map: only a ref is added, no row", async () => {
    const { store, mint } = setup({
      index: { [USDC_ETH]: SRC_USDC, [USDC_ARB]: SRC_USDC },
    });
    const a = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const b = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    expect(b).toBe(a);
    expect(store.rows.size).toBe(1); // one Token
    expect(store.refs.size).toBe(3); // three refs: two chains + the upstream's
  });

  it("3. not in the global map either: only the provider's ref is written, the row is still created", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: "evm:1/contract:0xdead", seed: seed("WAT") }])).get(
      "evm:1/contract:0xdead",
    );

    expect(id).toBeDefined();
    expect([...store.refs.keys()]).toEqual(["evm:1/contract:0xdead"]); // no upstream ref
    expect(store.rows.get(id as string)?.ref).toBeNull(); // upstream has not recognised it
  });
});

describe("multi-chain merge", () => {
  it("three chain refs of one token point to the same Token", async () => {
    const { store, mint } = setup({
      index: { [USDC_ETH]: SRC_USDC, [USDC_ARB]: SRC_USDC, [USDC_SOL]: SRC_USDC },
    });
    const got = await mint.of([
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ARB, seed: seed("USDC") },
      { ref: USDC_SOL, seed: seed("USDC") },
    ]);

    expect(new Set(got.values()).size).toBe(1);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_USDC)).toBe(got.get(USDC_ETH));
  });
});

describe("recognised after the fact: merge", () => {
  it("refs repoint, historical snapshot token_ids repoint, the old row is deleted", async () => {
    const { store, globalRefIndex, mint } = setup({ index: { [USDC_ETH]: SRC_USDC } });
    const good = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    const orphan = (
      await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "USD Coin", "arb.png") }])
    ).get(USDC_ARB);
    expect(orphan).not.toBe(good);
    expect(store.rows.size).toBe(2);

    // The history snapshot rows written that round point to the orphan.
    store.snapshotTokenIds.push(orphan as string, orphan as string, good as string);

    // Round two: cron refreshed the table and the local table now recognises it.
    globalRefIndex.set("src", USDC_ARB, SRC_USDC);
    expect((await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB)).toBe(good);

    expect(store.rows.size).toBe(1);
    expect(store.rows.has(orphan as string)).toBe(false);
    expect(store.refs.get(USDC_ARB)).toBe(good); // ref repointed
    expect(store.snapshotTokenIds).toEqual([good, good, good]);
    // The old row's provider logo is kept (a fallback-chain tier).
    expect(store.rows.get(good as string)?.providerLogo).toBe("arb.png");
  });

  it("nobody holds that token: the upstream ref is added in place, the row stays", async () => {
    const { store, globalRefIndex, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB);

    globalRefIndex.set("src", USDC_ARB, SRC_USDC);
    expect((await mint.of([{ ref: USDC_ARB, seed: seed("USDC") }])).get(USDC_ARB)).toBe(id);
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_USDC)).toBe(id);
    expect(store.rows.get(id as string)?.ref).toBe(SRC_USDC); // now recognised
  });
});

// A new token unknown to upstream arrives from chain and exchange. On-chain contract is recognised via the global map once cron refreshes;
// exchange symbol only via symbol, whose candidates are a subset of warm (top-N), so the two rows merge only after it enters the ranking.
const XXA_ETH = "evm:1/contract:0xa0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0";
const XXA_CEX = "binance/issued:XXA";
const XXA_ID = "xxa-token"; // upstream's name for it (map local_name)
const SRC_XXA = `src/issued:${XXA_ID}`; // the ref once built = the anchor

describe("new token: on chain + exchange, upstream lists it later", () => {
  // Round one: upstream has not listed it, so neither ref is recognised and each gets its own row.
  // The caller holds candidateMap, so inserting mid-test means "the token entered the ranking".
  async function firstRound(candidateMap: Record<string, TokenCandidate[]> = {}) {
    const ctx = setup({ candidates: candidateMap });
    const ids = await ctx.mint.of([
      { ref: XXA_ETH, seed: seed("XXA") },
      { ref: XXA_CEX, seed: seed("XXA") },
    ]);
    return { ...ctx, onchain: ids.get(XXA_ETH) as string, cex: ids.get(XXA_CEX) as string };
  }

  const bothRefs = [
    { ref: XXA_ETH, seed: seed("XXA") },
    { ref: XXA_CEX, seed: seed("XXA") },
  ];

  it("upstream has not listed it: two same-named rows, independent, no price", async () => {
    const { store, candidates, onchain, cex } = await firstRound();
    expect(onchain).not.toBe(cex);
    expect(store.rows.size).toBe(2);
    for (const id of [onchain, cex]) {
      expect(store.rows.get(id)?.symbol).toBe("XXA");
      expect(store.rows.get(id)?.ref).toBeNull(); // no upstream ref: no price lookup
    }
    // The contract never asked the judge (gated upstream); the exchange asked but candidates were empty.
    expect(candidates.asked).toEqual(["XXA"]);
  });

  it("upstream lists the contract but it is not ranked yet: only the on-chain row is recognised, still two rows", async () => {
    const { store, globalRefIndex, mint, onchain, cex } = await firstRound();
    globalRefIndex.set("src", XXA_ETH, SRC_XXA); // cron picked up this contract

    const ids = await mint.of(bothRefs);
    // The on-chain row gets the upstream ref in place: row and history stay, and it now has price and logo.
    expect(ids.get(XXA_ETH)).toBe(onchain);
    expect(store.rows.get(onchain)?.ref).toBe(SRC_XXA);
    // The exchange row can only use symbol and it is not in warm: unchanged.
    expect(ids.get(XXA_CEX)).toBe(cex);
    expect(store.rows.get(cex)?.ref).toBeNull();
    expect(store.rows.size).toBe(2);
  });

  it("then enters the top 100 by market cap: the two rows merge (sole-candidate tier, rank ignored)", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, globalRefIndex, mint, onchain, cex } = await firstRound(warm);
    globalRefIndex.set("src", XXA_ETH, SRC_XXA);
    // The history snapshot rows of the first two rounds point to two ids.
    store.snapshotTokenIds.push(onchain, cex);

    warm.XXA = [{ ref: SRC_XXA, marketCapRank: 100 }]; // entered the ranking

    const ids = await mint.of(bothRefs);
    // Which row survives depends on in-batch order; both refs end in one row.
    const merged = ids.get(XXA_CEX);
    expect(ids.get(XXA_ETH)).toBe(merged);
    expect(store.rows.size).toBe(1);
    expect(store.snapshotTokenIds).toEqual([merged, merged]);

    // Rank 100 is outside top-50: it passes as the sole candidate, so this tier is brittle: another XXA token entering
    // the ranking makes the judge unsure and the exchange row falls back to its own row (next case).
    expect(RESOLUTION_TOP_RANK).toBeLessThan(100);
  });

  it("a same-named second token also enters the ranking: rank 100 cannot dominate it, the exchange row stays put", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, globalRefIndex, mint, onchain, cex } = await firstRound(warm);
    globalRefIndex.set("src", XXA_ETH, SRC_XXA);
    // Two candidates: rank 100 vs 300; 3x < the dominance line, so not confident.
    warm.XXA = [
      { ref: SRC_XXA, marketCapRank: 100 },
      { ref: "src/issued:xxa-imposter", marketCapRank: 300 },
    ];

    const ids = await mint.of(bothRefs);
    expect(ids.get(XXA_ETH)).toBe(onchain); // the on-chain ref goes by address, unaffected by namesakes
    expect(ids.get(XXA_CEX)).toBe(cex); // the exchange ref is unrecognised: still its own row without price
    expect(store.rows.size).toBe(2);
  });
});

// Recognised by address on chain and by symbol on the exchange: independent criteria, so even when the contract's symbol differs
// from upstream's current name (MATIC after the POL rename), both sides land on one row. `refreshStaleInfo` fixes the display name.
const POL_ETH = "evm:1/contract:0x455e53cbb86018ac2b8092fdcd39d8444affc3f6";
const POL_CEX = "binance/issued:POL";
const POL_ID = "polygon-ecosystem-token";
const SRC_POL = `src/issued:${POL_ID}`;

describe("on-chain symbol differs from upstream's name", () => {
  it("chain reports the old name, exchange the new: still one row (independent criteria)", async () => {
    const { store, mint } = setup({
      index: { [POL_ETH]: SRC_POL }, // on-chain: recognised by address, symbol ignored
      candidates: { POL: [{ ref: SRC_POL, marketCapRank: 76 }] }, // exchange: recognised by symbol
    });

    const ids = await mint.of([
      { ref: POL_ETH, seed: seed("MATIC", "Matic Network") }, // the contract says the old name
      { ref: POL_CEX, seed: seed("POL") }, // the exchange says the new name
    ]);

    expect(ids.get(POL_CEX)).toBe(ids.get(POL_ETH));
    expect(store.rows.size).toBe(1);
    expect(store.refs.get(SRC_POL)).toBe(ids.get(POL_ETH));
  });

  it("the row keeps the first arrival's name, so upstream must overwrite it", async () => {
    const { store, candidates, mint } = setup({
      index: { [POL_ETH]: SRC_POL },
      candidates: { POL: [{ ref: SRC_POL, marketCapRank: 76 }] },
    });

    const id = (await mint.of([{ ref: POL_ETH, seed: seed("MATIC", "Matic Network") }])).get(
      POL_ETH,
    ) as string;
    // The on-chain ref never asked the judge: recognised by address, symbol is irrelevant.
    expect(candidates.asked).toEqual([]);

    // The row is built with the contract's old name: mint only fixes identity and never fetches.
    expect(store.rows.get(id)).toMatchObject({ symbol: "MATIC", name: "Matic Network" });
    // The exchange ref arrives later and joins the same row: the name is still old.
    expect((await mint.of([{ ref: POL_CEX, seed: seed("POL") }])).get(POL_CEX)).toBe(id);
    expect(store.rows.get(id)?.symbol).toBe("MATIC");
    // `refreshStaleInfo` fixes it (read path, may fetch); infoStale is true at creation.
    expect(store.rows.get(id)?.infoStale).toBe(true);
  });
});

// Upstream and exchange rename at different times. The exchange ref is its ticker (`binance/issued:<ticker>`), so a ticker change arrives
// as a new ref. Either order converges, and convergence is the evidence of a changed name: info must be marked stale then.
describe("upstream and exchange rename at different times", () => {
  const POL_CEX_OLD = "binance/issued:MATIC"; // the ref used before the exchange renamed its ticker

  // Before the rename: chain and exchange are both recognised on one row, already refreshed to upstream's then-name.
  async function beforeAnyRename(warm: Record<string, TokenCandidate[]>) {
    warm.MATIC = [{ ref: SRC_POL, marketCapRank: 76 }];
    const ctx = setup({ index: { [POL_ETH]: SRC_POL }, candidates: warm });
    const ids = await ctx.mint.of([
      { ref: POL_ETH, seed: seed("MATIC", "Matic Network") },
      { ref: POL_CEX_OLD, seed: seed("MATIC") },
    ]);
    const id = ids.get(POL_ETH) as string;
    expect(ids.get(POL_CEX_OLD)).toBe(id);
    expect(ctx.store.rows.size).toBe(1);
    // Pretend refreshStaleInfo ran: upstream was still called MATIC then.
    await ctx.h.run(
      ctx.store.putInfo([{ tokenId: id, symbol: "MATIC", name: "Matic Network" }], 0),
    );
    expect(ctx.store.rows.get(id)?.infoStale).toBe(false);
    return { ...ctx, id };
  }

  it("upstream renames first, exchange later: the new ticker joins the same row and info is marked stale", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, mint, id } = await beforeAnyRename(warm);

    // 1. Upstream renamed; the exchange still reports the old ticker, already recognised, so identity is unchanged and info is NOT
    // marked stale (no local evidence of a rename; only TTL expiry catches this, pinned by the next case).
    delete warm.MATIC;
    warm.POL = [{ ref: SRC_POL, marketCapRank: 76 }];
    expect((await mint.of([{ ref: POL_CEX_OLD, seed: seed("MATIC") }])).get(POL_CEX_OLD)).toBe(id);
    expect(store.rows.get(id)?.infoStale).toBe(false);

    // 2. The exchange renames too: a new ref recognised by symbol, joining the same row; info is marked stale.
    expect((await mint.of([{ ref: POL_CEX, seed: seed("POL") }])).get(POL_CEX)).toBe(id);
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(id)?.infoStale).toBe(true);
  });

  it("only upstream renames, exchange never does: no local evidence, wait for TTL (not marked stale)", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, mint, id } = await beforeAnyRename(warm);
    delete warm.MATIC;
    warm.POL = [{ ref: SRC_POL, marketCapRank: 76 }];

    // Several sync rounds with only known refs: nothing is written.
    for (let i = 0; i < 3; i++) {
      await mint.of([
        { ref: POL_ETH, seed: seed("MATIC") },
        { ref: POL_CEX_OLD, seed: seed("MATIC") },
      ]);
    }
    expect(store.rows.get(id)?.infoStale).toBe(false);
    expect(store.rows.get(id)?.symbol).toBe("MATIC");
    // The display name lags by at most INFO_TTL_MS (30d): accepted, since marking stale needs evidence.
  });

  it("exchange renames first, upstream later: an extra row mid-way; merges once upstream catches up and the winner is marked stale", async () => {
    const warm: Record<string, TokenCandidate[]> = {};
    const { store, mint, id } = await beforeAnyRename(warm);

    // 1. The exchange renamed first: a new ref upstream does not know yet, its own row.
    const orphan = (await mint.of([{ ref: POL_CEX, seed: seed("POL") }])).get(POL_CEX) as string;
    expect(orphan).not.toBe(id);
    expect(store.rows.size).toBe(2); // the user sees two rows in this window
    store.snapshotTokenIds.push(id, orphan); // each of the two rows wrote history

    // 2. Upstream renamed too: recognised next round, merged.
    delete warm.MATIC;
    warm.POL = [{ ref: SRC_POL, marketCapRank: 76 }];
    expect((await mint.of([{ ref: POL_CEX, seed: seed("POL") }])).get(POL_CEX)).toBe(id);
    expect(store.rows.size).toBe(1);
    expect(store.snapshotTokenIds).toEqual([id, id]); // the curve stays continuous
    // The winner keeps its own (old) name, so the merge must mark it stale too.
    expect(store.rows.get(id)?.symbol).toBe("MATIC");
    expect(store.rows.get(id)?.infoStale).toBe(true);
  });
});

describe("concurrency", () => {
  it("the same ref minted concurrently is idempotent: one row (upsert-then-read, no barrier)", async () => {
    const { store, mint } = setup({ index: { [USDC_ETH]: SRC_USDC } });
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => mint.of([{ ref: USDC_ETH, seed: seed("USDC") }])),
    );
    expect(new Set(results.map((r) => r.get(USDC_ETH))).size).toBe(1);
    expect(store.rows.size).toBe(1);
  });

  it("duplicate refs in one batch are processed once", async () => {
    const { store, mint } = setup();
    await mint.of([
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ETH, seed: seed("USDC") },
      { ref: USDC_ETH, seed: seed("USDC") },
    ]);
    expect(store.rows.size).toBe(1);
  });
});

describe("recognition by symbol (fixed at write time)", () => {
  it("address beats symbol: reordering would merge a fake USDC into the real one", async () => {
    const { store, mint } = setup({
      index: { "evm:1/contract:0xfake": "src/issued:fake-usdc" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    await mint.of([{ ref: "evm:1/contract:0xfake", seed: seed("USDC") }]);
    expect(store.refs.has("src/issued:fake-usdc")).toBe(true);
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });

  // A contract is never guessed by symbol.
  it("a contract not in the map never merges into a major by symbol, even if its symbol says USDC", async () => {
    const { store, mint } = setup({
      // Not in the map (deployed yesterday), symbol filled in as USDC.
      overrides: { USDC: "usd-coin" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    // Put the real USDC in first.
    const { mint: mint2, store: store2 } = setup({
      index: { [USDC_ETH]: SRC_USDC },
      overrides: { USDC: "usd-coin" },
    });
    const real = (await mint2.of([{ ref: USDC_ETH, seed: seed("USDC") }])).get(USDC_ETH);
    expect(store2.refs.get(SRC_USDC)).toBe(real);

    const scam = (await mint.of([{ ref: "evm:1/contract:0xdead", seed: seed("USDC") }])).get(
      "evm:1/contract:0xdead",
    );
    expect(scam).toBeDefined();
    // Its own row, no upstream link: no real USDC price and no pollution of that row's total.
    expect(store.rows.get(scam as string)?.ref).toBeNull();
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });

  it("native coins are still recognised by symbol: by design they are not in the map, the only route", async () => {
    const { store, mint } = setup({ overrides: { BTC: "bitcoin" } });
    const id = (await mint.of([{ ref: "bitcoin/native", seed: seed("BTC") }])).get(
      "bitcoin/native",
    );
    expect(store.refs.get("src/issued:bitcoin")).toBe(id);
  });

  it("confident (within top-N): linked upstream; same-named tokens across exchanges merge into one row", async () => {
    const { store, candidates, mint } = setup({
      candidates: { BTC: [{ ref: "src/issued:bitcoin", marketCapRank: 1 }] },
    });
    const got = await mint.of([
      { ref: "binance/issued:BTC", seed: seed("BTC") },
      { ref: "okx/issued:BTC", seed: seed("BTC") },
    ]);
    expect(got.get("binance/issued:BTC")).toBe(got.get("okx/issued:BTC"));
    expect(store.rows.size).toBe(1);
    expect(candidates.asked).toContain("BTC"); // it did reach the judge
  });

  // The judge's branches are tested in confidence.test.ts; here only how "not recognised" propagates into the stored shape.
  // Uses venue-named refs: contracts are gated out earlier and would never reach the judge.
  it("not confident (namesake crowd): each gets its own row, no upstream link", async () => {
    const { store, candidates, mint } = setup({
      candidates: {
        MOON: [
          { ref: "src/issued:moon-a", marketCapRank: 900 },
          { ref: "src/issued:moon-b", marketCapRank: 1000 }, // no domination: not confident enough
        ],
      },
    });
    const got = await mint.of([
      { ref: "binance/issued:MOON", seed: seed("MOON") },
      { ref: "okx/issued:MOON", seed: seed("MOON") },
    ]);
    expect(candidates.asked).toEqual(["MOON", "MOON"]); // both asked the judge
    expect(got.get("binance/issued:MOON")).not.toBe(got.get("okx/issued:MOON"));
    expect([...store.refs.keys()].some((r) => r.startsWith("src/"))).toBe(false);
  });

  // Converse: a gated contract never asks the judge, which keeps a fake USDC out of the real one.
  it("a contract-shaped ref never asks the judge (gated upstream)", async () => {
    const { candidates, mint } = setup({
      candidates: { MOON: [{ ref: "src/issued:moon-a", marketCapRank: 1 }] }, // a candidate that would be recognised
    });
    await mint.of([{ ref: "evm:1/contract:0xmoon1", seed: seed("MOON") }]);
    expect(candidates.asked).toEqual([]);
  });

  it("the curated override table beats market-cap rank (guards namesakes); the adapter supplies it, values are upstream ids", async () => {
    const { store, mint } = setup({
      overrides: { BTC: "bitcoin" },
      candidates: { BTC: [{ ref: "src/issued:scam-btc", marketCapRank: 2 }] },
    });
    await mint.of([{ ref: "binance/issued:BTC", seed: seed("BTC") }]);
    expect(store.refs.has("src/issued:bitcoin")).toBe(true);
  });
});

describe("metadata", () => {
  it("a built row uses the provider's symbol/name/logo; the logo goes to the spare slot, the source's slot stays empty", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin", "p.png") }])).get(
      USDC_ETH,
    );
    expect(store.rows.get(id as string)).toMatchObject({
      symbol: "USDC",
      name: "USD Coin",
      providerLogo: "p.png",
    });
    expect(store.rows.get(id as string)?.logo).toBeUndefined();
  });

  it("merging into an existing Token does not overwrite its metadata, only fills empty slots", async () => {
    const { store, mint } = setup({ index: { [USDC_ETH]: SRC_USDC, [USDC_ARB]: SRC_USDC } });
    const id = (await mint.of([{ ref: USDC_ETH, seed: seed("USDC", "USD Coin") }])).get(USDC_ETH);
    // Pretend upstream later filled in good data.
    const row = store.rows.get(id as string);
    if (row) {
      row.name = "USD Coin (upstream)";
      row.logo = "up.png";
    }

    await mint.of([{ ref: USDC_ARB, seed: seed("USDC", "usdc.e bridged", "arb.png") }]);

    expect(store.rows.get(id as string)).toMatchObject({
      name: "USD Coin (upstream)", // not overwritten
      logo: "up.png", // not overwritten
      providerLogo: "arb.png", // empty slot filled
    });
  });
});

// Fiat identity: ref `fiat/issued:<CODE>`, namer `fiat` vouches for ISO codes. mint builds / fetches a canonical fiat row
// and never queries upstream or guesses by symbol (no upstream price).
const USD_LOGO = SUPPORTED_CURRENCIES.find((c) => c.code === "USD")?.logo;
const CNY_LOGO = SUPPORTED_CURRENCIES.find((c) => c.code === "CNY")?.logo;

describe("fiat identity", () => {
  it("fiat/issued:USD builds a canonical row with symbol=USD and the CMC logo (ref empty: no upstream price)", async () => {
    const { store, mint } = setup();
    // The seed's provider symbol / logo are deliberately wrong: the canonical row comes from SUPPORTED_CURRENCIES.
    const id = (
      await mint.of([{ ref: "fiat/issued:USD", seed: seed("usd", "US Dollars", "wrong.png") }])
    ).get("fiat/issued:USD") as string;

    expect(id).toBeDefined();
    expect(store.rows.get(id)).toMatchObject({ symbol: "USD", providerLogo: USD_LOGO });
    expect(store.rows.get(id)?.ref).toBeNull(); // no current-source ref: coingecko is never asked for a price
    expect([...store.refs.keys()]).toEqual(["fiat/issued:USD"]);
  });

  it("minting the same fiat again reuses the row (looked up by the fiat/issued:CODE ref), no new row", async () => {
    const { store, mint } = setup();
    const first = (await mint.of([{ ref: "fiat/issued:USD", seed: seed("USD") }])).get(
      "fiat/issued:USD",
    );
    const again = (await mint.of([{ ref: "fiat/issued:USD", seed: seed("USD") }])).get(
      "fiat/issued:USD",
    );
    expect(again).toBe(first);
    expect(store.rows.size).toBe(1);
  });

  it("different fiats each get a row", async () => {
    const { store, mint } = setup();
    const got = await mint.of([
      { ref: "fiat/issued:USD", seed: seed("USD") },
      { ref: "fiat/issued:CNY", seed: seed("CNY") },
    ]);
    expect(got.get("fiat/issued:USD")).not.toBe(got.get("fiat/issued:CNY"));
    expect(store.rows.size).toBe(2);
    expect(store.rows.get(got.get("fiat/issued:CNY") as string)).toMatchObject({
      symbol: "CNY",
      providerLogo: CNY_LOGO,
    });
  });

  it("fiat is never pulled along by the symbol tier, even if upstream has a same-symbol token", async () => {
    // Pretend upstream has a crypto with symbol=USD and the curated table points to it; canonical fiat must not merge in.
    const { store, candidates, mint } = setup({
      overrides: { USD: "some-usd-coin" },
      candidates: { USD: [{ ref: "src/issued:some-usd-coin", marketCapRank: 1 }] },
    });
    const id = (await mint.of([{ ref: "fiat/issued:USD", seed: seed("USD") }])).get(
      "fiat/issued:USD",
    );
    expect(candidates.asked).toEqual([]); // the judge was never asked
    expect(store.refs.has("src/issued:some-usd-coin")).toBe(false); // no upstream link
    expect(store.rows.get(id as string)?.ref).toBeNull();
  });

  it("non-whitelisted fiat/issued:XXX is treated as unknown: a plain row, no canonical built", async () => {
    const { store, mint } = setup();
    const id = (await mint.of([{ ref: "fiat/issued:XXX", seed: seed("XXX") }])).get(
      "fiat/issued:XXX",
    ) as string;
    expect(store.rows.get(id)).toMatchObject({ symbol: "XXX" });
    expect(store.rows.get(id)?.providerLogo).toBeUndefined(); // no canonical logo
    expect(store.rows.get(id)?.ref).toBeNull();
    expect([...store.refs.keys()]).toEqual(["fiat/issued:XXX"]);
  });
});

describe("unreadable ref", () => {
  it("does not guess by symbol: we know nothing about it", async () => {
    const { store, mint } = setup({
      overrides: { USDC: "usd-coin" },
      candidates: { USDC: [{ ref: SRC_USDC, marketCapRank: 6 }] },
    });
    const id = (await mint.of([{ ref: "nonsense", seed: seed("USDC") }])).get("nonsense");
    expect(id).toBeDefined(); // the row is still created (the snapshot needs a token_id), but no upstream link
    expect(store.rows.get(id as string)?.ref).toBeNull();
    expect(store.refs.has(SRC_USDC)).toBe(false);
  });
});

// Real output of each producer: the cases above follow decision-tree branches; this group follows sources so each producer's
// ref shape (from its golden fixture) lands on the right token.
describe("each source's ref lands on the right token", () => {
  const USDC_ADDR = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
  const USDC_SOL_ADDR = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // The map lists USDC on two chains, warm has USDC / ETH / BTC / SOL.
  const fullSetup = () =>
    setup({
      index: { [USDC_ADDR]: SRC_USDC, [USDC_SOL_ADDR]: SRC_USDC },
      candidates: {
        USDC: [{ ref: SRC_USDC, marketCapRank: 6 }],
        ETH: [{ ref: "src/issued:ethereum", marketCapRank: 2 }],
        BTC: [{ ref: "src/issued:bitcoin", marketCapRank: 1 }],
        SOL: [{ ref: "src/issued:solana", marketCapRank: 5 }],
      },
    });

  it("USDC from six sources lands on one Token (on-chain contract / exchange / perp / manual pick)", async () => {
    const { store, mint } = fullSetup();
    const got = await mint.of([
      { ref: USDC_ADDR, seed: seed("USDC") }, // zerion: contract
      { ref: USDC_SOL_ADDR, seed: seed("USDC") }, // coinstats: contract
      { ref: "binance/issued:USDC", seed: seed("USDC") }, // binance: listed ticker
      { ref: "okx/issued:USDC", seed: seed("USDC") }, // okx: listed ticker
      { ref: "hyperliquid/issued:USDC", seed: seed("USDC") }, // hyperliquid: margin token
      { ref: SRC_USDC, seed: seed("USDC") }, // manual: the user picked the token, the ref itself is the anchor
    ]);

    expect(new Set(got.values()).size).toBe(1); // all in one Token
    expect(store.rows.size).toBe(1);
    // Six source refs + the anchor (manual's ref equals the anchor, so no duplicate after dedupe)
    expect(store.refs.size).toBe(6);
    expect(store.refs.get(SRC_USDC)).toBe(got.get(USDC_ADDR));
  });

  it("native coins each land on their own Token: not in the map, recognised by symbol", async () => {
    const { store, mint } = fullSetup();
    const got = await mint.of([
      { ref: "evm:1/native", seed: seed("ETH") }, // zerion: ETH
      { ref: "bitcoin/native", seed: seed("BTC") }, // blockbook: BTC
      { ref: "solana/native", seed: seed("SOL") }, // coinstats: SOL
    ]);

    expect(new Set(got.values()).size).toBe(3); // three different tokens
    expect(store.refs.get("src/issued:ethereum")).toBe(got.get("evm:1/native"));
    expect(store.refs.get("src/issued:bitcoin")).toBe(got.get("bitcoin/native"));
    expect(store.refs.get("src/issued:solana")).toBe(got.get("solana/native"));
  });

  it("manual pick: the ref itself is the anchor, no map lookup, no fallback to symbol", async () => {
    // Deliberately point warm and the override table at a different token: falling back to symbol would misrecognise.
    const { store, globalRefIndex, mint } = setup({
      overrides: { USDC: "wrong-coin" },
      candidates: { USDC: [{ ref: "src/issued:wrong-coin", marketCapRank: 1 }] },
    });
    const before = globalRefIndex.lookups;

    const id = (await mint.of([{ ref: SRC_USDC, seed: seed("USDC") }])).get(SRC_USDC);
    expect(globalRefIndex.lookups).toBe(before); // map not queried
    expect(store.refs.get(SRC_USDC)).toBe(id);
    expect(store.refs.has("src/issued:wrong-coin")).toBe(false); // not pulled along by the symbol tier
    // Only one ref: dedupe works (ref equals anchor; without dedupe it hits the (namer, localName) primary key)
    expect([...store.refs.keys()]).toEqual([SRC_USDC]);
    expect(store.rows.get(id as string)?.ref).toBe(SRC_USDC); // already recognised on arrival
  });

  // A hand-typed symbol must not recognise a token (typing BTC under "Can't find it? Enter manually" must not merge into real BTC).
  // `custom:` itself says "no voucher", so the symbol tier does not admit it.
  it("manual without a picked token: even a recognisable symbol does not merge into that Token (not a namer-issued id)", async () => {
    const { store, candidates, mint } = fullSetup();
    const got = await mint.of([
      { ref: "manual/custom:BTC", seed: seed("BTC") },
      { ref: "bitcoin/native", seed: seed("BTC") },
    ]);
    expect(got.get("manual/custom:BTC")).not.toBe(got.get("bitcoin/native"));
    expect(store.rows.size).toBe(2);
    // The hand-typed ref never asked the judge (gated upstream); the native ref did, so they take different tiers.
    expect(candidates.asked).toEqual(["BTC"]);
    // The hand-typed row has no upstream ref so no live price: valued at the user's entered unit price.
    expect(store.rows.get(got.get("manual/custom:BTC") as string)?.ref).toBeNull();
    // An unrecognised ref is still attached to its own row: next round it hits directly instead of creating a new row.
    expect(store.refs.get("manual/custom:BTC")).toBe(got.get("manual/custom:BTC"));
    expect(store.rows.get(got.get("bitcoin/native") as string)?.ref).toBe("src/issued:bitcoin");
  });
});
