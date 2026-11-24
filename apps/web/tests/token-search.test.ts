import { describe, expect, it } from "vitest";
import {
  buildOwnedOptions,
  buildTokenSections,
  type LivePrice,
  LOCAL_SEARCH_ENOUGH,
  mergeSearchResults,
  needsRemoteSearch,
  PRICE_STALE_MS,
  searchCatalogue,
  staleTickets,
} from "@/components/token-search";
import type { TokenOption } from "@/lib/core/token-model";

const opt = (symbol: string, name: string): TokenOption => ({
  ticket: `t-${symbol}-${name}`.toLowerCase().replace(/\s+/g, "-"),
  symbol,
  name,
});

//
const CATALOGUE: TokenOption[] = [
  opt("BTC", "Bitcoin"), // 1
  opt("USDT", "Tether"),
  opt("WETH", "Wrapped Ether"),
  opt("BITCI", "Bitcicoin"),
  opt("ETHW", "EthereumPoW"),
  opt("ETH", "Ethereum"),
  opt("SOL", "Solana"), // 7
  opt("WBTC", "Wrapped Bitcoin"), // 8
  opt("TBTC", "tBTC"), // 9
  opt("SOLV", "Solv Protocol"), // 10
];

describe("local filter: tiers, then market cap within a tier", () => {
  it("exact, then prefix, then substring; market cap only within a tier", () => {
    expect(searchCatalogue(CATALOGUE, "eth").map((t) => t.symbol)).toEqual([
      "ETH",
      "ETHW",
      "USDT",
      "WETH",
    ]);
  });

  it("a hit on symbol or name ranks equally: typing bitc puts Bitcoin first, not Bitcicoin", () => {
    const got = searchCatalogue(CATALOGUE, "bitc").map((t) => t.symbol);
    expect(got).toEqual(["BTC", "BITCI", "WBTC"]);
  });

  it("substrings in names are searchable too: users often search by full name", () => {
    expect(searchCatalogue(CATALOGUE, "wrapped").map((t) => t.symbol)).toEqual(["WETH", "WBTC"]);
  });

  it("case and surrounding whitespace insensitive", () => {
    expect(searchCatalogue(CATALOGUE, "  EtH  ")[0]?.symbol).toBe("ETH");
  });

  it("empty query: empty (the default list is another path: top N of the catalogue, no filtering)", () => {
    expect(searchCatalogue(CATALOGUE, "")).toEqual([]);
    expect(searchCatalogue(CATALOGUE, "   ")).toEqual([]);
  });

  it('a term matching nothing: empty, not "everything"', () => {
    expect(searchCatalogue(CATALOGUE, "zzzzz")).toEqual([]);
  });

  it("truncated to the limit, dropping the later ones", () => {
    expect(searchCatalogue(CATALOGUE, "eth", 2).map((t) => t.symbol)).toEqual(["ETH", "ETHW"]);
  });

  it("catalogue not loaded yet (prefetch pending): empty, no crash", () => {
    expect(searchCatalogue([], "btc")).toEqual([]);
  });
});

describe("when upstream gets involved", () => {
  it("enough local results: no outbound call, which is the request this change saves", () => {
    const enough = Array.from({ length: LOCAL_SEARCH_ENOUGH }, (_, i) => opt(`X${i}`, `Coin ${i}`));
    expect(needsRemoteSearch(enough)).toBe(false);
  });

  it("not enough local results: user is probably after a long-tail token, one /search is worth it", () => {
    expect(needsRemoteSearch([])).toBe(true);
    expect(needsRemoteSearch([opt("BTC", "Bitcoin")])).toBe(true);
  });
});

describe("merging the upstream additions", () => {
  const local = [opt("BTC", "Bitcoin"), opt("WBTC", "Wrapped Bitcoin")];

  it("local first (already tiered by market cap), upstream appended after", () => {
    const remote = [opt("BTCX", "Bitcoin X")];
    expect(mergeSearchResults(local, remote).map((t) => t.symbol)).toEqual(["BTC", "WBTC", "BTCX"]);
  });

  it("deduped by ticket: the same token returned by upstream does not repeat", () => {
    const dup = opt("BTC", "Bitcoin");
    expect(mergeSearchResults(local, [dup, opt("BTCX", "Bitcoin X")])).toHaveLength(3);
  });

  it("truncated to the limit on the upstream side (local is already sorted)", () => {
    const remote = Array.from({ length: 30 }, (_, i) => opt(`R${i}`, `Remote ${i}`));
    const got = mergeSearchResults(local, remote, 5);
    expect(got).toHaveLength(5);
    expect(got.slice(0, 2)).toEqual(local);
  });

  it("upstream did not answer / failed: only the local results", () => {
    expect(mergeSearchResults(local, [])).toEqual(local);
  });
});

describe("token picker groups: owned tokens, Tokens, fiat", () => {
  const OWNED: TokenOption[] = [opt("ETH", "Ethereum"), opt("MYC", "My Custom Coin")];
  const keys = (secs: ReturnType<typeof buildTokenSections>) => secs.map((s) => s.key);
  const items = (secs: ReturnType<typeof buildTokenSections>, key: string) =>
    secs.find((s) => s.key === key)?.items.map((t) => t.symbol) ?? [];

  it("not searching: owned tokens on top, Tokens below; owned tokens in full, catalogue cut to topN", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(secs)).toEqual(["owned", "catalogue"]);
    expect(items(secs, "owned")).toEqual(["ETH", "MYC"]);
    expect(items(secs, "catalogue")).toEqual(["BTC", "USDT", "WETH"]);
  });

  it("fiat group last (when non-empty the order is owned tokens, Tokens, fiat)", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [opt("USD", "US Dollar")],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 2,
    });
    expect(keys(secs)).toEqual(["owned", "catalogue", "fiat"]);
  });

  it("empty groups are omitted: no fiat means no fiat group; no owned tokens means starting with Tokens", () => {
    const withOwned = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(withOwned)).not.toContain("fiat");

    const noOwned = buildTokenSections({
      owned: [],
      fiat: [],
      catalogue: CATALOGUE,
      query: "",
      catalogueTopN: 3,
    });
    expect(keys(noOwned)).toEqual(["catalogue"]);
  });

  it("the two groups are not deduped: the same token appears once in owned tokens and once in Tokens", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "eth",
      catalogueTopN: 3,
    });
    expect(items(secs, "owned")).toContain("ETH");
    expect(items(secs, "catalogue")).toContain("ETH");
  });

  it("search: sources with no match produce no section", () => {
    const secs = buildTokenSections({
      owned: OWNED,
      fiat: [],
      catalogue: CATALOGUE,
      query: "myc",
      catalogueTopN: 3,
    });
    expect(keys(secs)).toEqual(["owned"]);
    expect(items(secs, "owned")).toEqual(["MYC"]);
  });

  it("search: exact hit floats to the top (even fiat): searching USD puts USD (Cash) above USDC/USDT", () => {
    const secs = buildTokenSections({
      owned: [],
      fiat: [opt("USD", "US Dollar")],
      catalogue: [opt("USDC", "USD Coin"), opt("USDT", "Tether")],
      query: "usd",
      catalogueTopN: 5,
    });
    expect(keys(secs)).toEqual(["fiat", "catalogue"]);
    expect(items(secs, "fiat")).toEqual(["USD"]);
    expect(items(secs, "catalogue")).toEqual(["USDC", "USDT"]);
  });

  it("adjacent sectioning: sorting separates same-type items, so that type appears in several sections", () => {
    const owned = [{ ...opt("COW", "Cow"), rank: 2 }];
    const catalogue = [
      { ...opt("CAT", "Cat"), rank: 1 },
      { ...opt("COB", "Cobra"), rank: 3 },
    ];
    const secs = buildTokenSections({ owned, fiat: [], catalogue, query: "c", catalogueTopN: 5 });
    expect(keys(secs)).toEqual(["catalogue", "owned", "catalogue"]);
    expect(secs.map((s) => s.items.map((t) => t.symbol))).toEqual([["CAT"], ["COW"], ["COB"]]);
  });

  it("total order of score tiers: exact symbol > exact name > symbol prefix > name prefix > symbol substring > name substring", () => {
    const secs = buildTokenSections({
      owned: [],
      fiat: [],
      catalogue: [
        opt("EGOLD", "Ccc"),
        opt("XXX", "Gold"),
        opt("ZZZ", "My Gold"),
        opt("GOLD", "Aaa"),
        opt("YYY", "Gold Rush"),
        opt("GOLDEN", "Bbb"),
      ],
      query: "gold",
      catalogueTopN: 10,
    });
    expect(items(secs, "catalogue")).toEqual(["GOLD", "XXX", "GOLDEN", "YYY", "EGOLD", "ZZZ"]);
  });

  it("type-neutral: an exact catalogue hit beats a substring hit among owned tokens (no favouring of own tokens)", () => {
    const secs = buildTokenSections({
      owned: [opt("XETHX", "X")],
      fiat: [],
      catalogue: [opt("ETH", "Ethereum")],
      query: "eth",
      catalogueTopN: 5,
    });
    expect(keys(secs)).toEqual(["catalogue", "owned"]);
  });

  it("same tier falls back to market cap rank, items without rank go last (fiat does not win by sitting earlier in the pool)", () => {
    const secs = buildTokenSections({
      owned: [],
      fiat: [opt("USD", "US Dollar")],
      catalogue: [{ ...opt("UNI", "Uniswap"), rank: 5 }],
      query: "u",
      catalogueTopN: 5,
    });
    expect(keys(secs)).toEqual(["catalogue", "fiat"]);
  });

  it("during search the upstream additions merge into the Tokens group (local first)", () => {
    const secs = buildTokenSections({
      owned: [],
      fiat: [],
      catalogue: [opt("BTC", "Bitcoin")],
      query: "btc",
      catalogueTopN: 3,
      remote: [opt("BTCX", "Bitcoin X")],
    });
    expect(items(secs, "catalogue")).toEqual(["BTC", "BTCX"]);
  });
});

describe("picking tickets to refresh prices for on display", () => {
  const NOW = 1_700_000_000_000;
  const withPrice = (symbol: string, over: Partial<TokenOption> = {}): TokenOption => ({
    ...opt(symbol, symbol),
    ...over,
  });
  const noLive = new Map<string, LivePrice>();
  const noReq = new Set<string>();

  it("fresh ones are not refreshed; stale ones and ones missing a price are", () => {
    const tokens = [
      withPrice("FRESH", { asOf: NOW - 1000 }),
      withPrice("OLD", { asOf: NOW - PRICE_STALE_MS - 1000 }),
      withPrice("NONE"),
    ];
    expect(staleTickets(tokens, noLive, noReq, NOW)).toEqual([
      tokens[1]?.ticket,
      tokens[2]?.ticket,
    ]);
  });

  it("refreshed (live) price overrides the ticket's old price: once topped up it no longer counts as stale", () => {
    const tk = withPrice("OLD", { asOf: NOW - PRICE_STALE_MS - 1000 });
    const live = new Map<string, LivePrice>([[tk.ticket, { price: 1, asOf: NOW }]]);
    expect(staleTickets([tk], live, noReq, NOW)).toEqual([]);
  });

  it("already requested tickets are not picked again: topped up once per opening, preventing a refresh loop", () => {
    const tk = withPrice("NORESP");
    expect(staleTickets([tk], noLive, new Set([tk.ticket]), NOW)).toEqual([]);
  });
});

describe("buildOwnedOptions", () => {
  const meta = new Map([
    ["BTC", { name: "Bitcoin", logo: "b.png" }],
    ["EUR", { name: "Euro", logo: "e.png" }],
  ]);

  it("tickets become options; ones without a ticket (custom symbol) are excluded", () => {
    const owned = buildOwnedOptions(
      [
        { ticket: "t-btc", symbol: "BTC" },
        { ticket: "t-eur", symbol: "EUR" },
        { ticket: null, symbol: "PRIV" },
      ],
      meta,
    );
    expect(owned.map((o) => o.symbol)).toEqual(["BTC", "EUR"]);
    expect(owned.map((o) => o.ticket)).toEqual(["t-btc", "t-eur"]);
  });

  it("name/logo come from meta (by uppercase symbol); missing: name falls back to symbol, logo empty", () => {
    const owned = buildOwnedOptions(
      [
        { ticket: "t-btc", symbol: "btc" },
        { ticket: "t-xyz", symbol: "XYZ" },
      ],
      meta,
    );
    expect(owned[0]).toEqual({ ticket: "t-btc", symbol: "btc", name: "Bitcoin", logo: "b.png" });
    expect(owned[1]).toEqual({ ticket: "t-xyz", symbol: "XYZ", name: "XYZ", logo: undefined });
  });
});
