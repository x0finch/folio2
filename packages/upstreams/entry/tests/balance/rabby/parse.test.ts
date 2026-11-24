import { describe, expect, it } from "vitest";
import {
  parseChainIds,
  type RabbyChain,
  type RabbyProtocol,
  type RabbyToken,
} from "../../../src/balance/rabby/api";
import { DUST_USD } from "../../../src/balance/rabby/constants";
import { parseProtocols, parseTokens } from "../../../src/balance/rabby/parse";
import tokenList from "./fixtures/cache-token-list.json";
import chainList from "./fixtures/chain-list.json";
import protocolList from "./fixtures/complex-protocol-list.json";
import expected from "./fixtures/expected-balances.json";

// The fixture is cut from real responses (rows kept verbatim, only a few picked), each row there to cover one rule:
//   eth ETH  native, large              kept, evm:1/native
//   op  ETH  native of another chain    kept, evm:10/native (the namer follows the chain)
//   op  OPP  contract token $8177        kept, evm:10/contract:0x…
//   bsc vitalik.eth contract $16214      kept
//   eth DOJE price=0                    dropped (typical junk upstream cannot price)
//   op  TUX  $0.0025                    dropped (dust)
//   op  TKN  $0.2629                    dropped (the gate is $1, not $0.01)
//   op  WLD  $1.5948                    kept (just past the gate: the boundary is not "keep only large")
//   bb  BB   native ~ $0                kept (native coins are exempt from the dust gate)
const chains = chainList as RabbyChain[];
const tokens = tokenList as RabbyToken[];
const protocols = protocolList as RabbyProtocol[];

describe("parseChainIds", () => {
  it("slug to community_id (the canonical EVM chainId)", () => {
    const ids = parseChainIds(chains);
    expect(ids.eth).toBe(1);
    expect(ids.op).toBe(10);
    expect(ids.bsc).toBe(56);
    expect(ids.bb).toBe(6001);
  });

  it("entries missing id or community_id are skipped, no half mapping", () => {
    const ids = parseChainIds([{ id: "x" }, { community_id: 7 }, { id: "ok", community_id: 8 }]);
    expect(ids).toEqual({ ok: 8 });
  });
});

describe("parseTokens", () => {
  const ids = parseChainIds(chains);

  it("native coin gives a native ref, contract token a contract ref", () => {
    const rows = parseTokens(tokens, ids);
    const refs = rows.map((r) => r.tokenRef);
    expect(refs).toContain("evm:1/native"); // eth ETH
    expect(refs).toContain("evm:10/native"); // op ETH: the namer follows the chain
    expect(refs).toContain("evm:6001/native"); // bb BB
    expect(refs.some((r) => r.startsWith("evm:10/contract:0x"))).toBe(true);
  });

  it("value = amount x price (upstream gives no usd_value)", () => {
    const rows = parseTokens(tokens, ids);
    const eth = rows.find((r) => r.tokenRef === "evm:1/native");
    expect(eth?.amount).toBeCloseTo(6.632200430120325, 12);
    expect(eth?.price).toBeCloseTo(1908.68, 6);
    expect(eth?.value).toBeCloseTo(6.632200430120325 * 1908.68, 6);
  });

  it("dust gate: contract tokens below DUST_USD are dropped, and so are those with price 0", () => {
    const rows = parseTokens(tokens, ids);
    expect(rows.some((r) => r.symbol === "TUX")).toBe(false); // $0.0025, dust
    expect(rows.some((r) => r.symbol === "TKN")).toBe(false); // $0.2629: the gate is $1, not $0.01
    expect(rows.some((r) => r.symbol === "DOJE")).toBe(false); // price 0
    expect(rows.some((r) => r.symbol === "WLD")).toBe(true); // $1.5948, just past the gate
  });

  it('filters by value only, not by "token quality"', () => {
    // On this endpoint is_core/is_verified/is_wallet are all true (an isCore filter would do nothing), and credit_score separates but
    // would drop memecoins that have a price (see parse.ts). Pins that a token with credit_score=0, no cex_ids and a junk-looking name stays if its value suffices.
    const rows = parseTokens(
      [
        {
          id: "0xdeadbeef00000000000000000000000000000000",
          chain: "eth",
          symbol: "SOMEMEME",
          amount: 1000,
          price: 0.01, // = $10, past the gate
        },
      ],
      ids,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBeCloseTo(10, 10);
  });

  it("native coins are exempt from the dust gate: kept however small (or a chain would vanish entirely)", () => {
    const rows = parseTokens(tokens, ids);
    const bb = rows.find((r) => r.tokenRef === "evm:6001/native");
    expect(bb).toBeDefined();
    expect(bb?.value).toBeLessThan(DUST_USD);
  });

  it("all spot, with no meta (the Spot schema has no meta field)", () => {
    for (const r of parseTokens(tokens, ids)) {
      expect(r.kind).toBe("spot");
      expect(r).not.toHaveProperty("meta");
    }
  });

  it("carries name / logo for the reference layer", () => {
    const rows = parseTokens(tokens, ids);
    const opp = rows.find((r) => r.symbol === "OPP");
    expect(opp?.name).toBeTruthy();
  });

  it("scam / suspicious are dropped outright", () => {
    const rows = parseTokens(
      [
        { id: "0x1", chain: "eth", symbol: "S", amount: 1, price: 100, is_scam: true },
        { id: "0x2", chain: "eth", symbol: "T", amount: 1, price: 100, is_suspicious: true },
        { id: "0x3", chain: "eth", symbol: "U", amount: 1, price: 100 },
      ],
      ids,
    );
    expect(rows.map((r) => r.symbol)).toEqual(["U"]);
  });

  it("rows without symbol are skipped (they would not produce a viewable row)", () => {
    expect(parseTokens([{ id: "0x1", chain: "eth", amount: 1, price: 100 }], ids)).toEqual([]);
  });

  it("no numeric chainId: throws, never degrading to the slug fallback form", () => {
    // Failing means nothing is produced: a forked identifier like `chain:op` would pollute the token index, far worse than retrying the whole round.
    expect(() =>
      parseTokens([{ id: "0x1", chain: "nope", symbol: "X", amount: 1, price: 1 }], ids),
    ).toThrow();
  });
});

describe("parseProtocols", () => {
  const ids = parseChainIds(chains);

  it("supply legs are positive, borrow legs take a negative amount and keep a positive unit price", () => {
    // The sign can only sit on amount: downstream revalue recomputes positive quantity x positive price, and a sign on value would be wiped.
    const rows = parseProtocols(protocols, ids);
    const borrow = rows.find((r) => r.amount < 0);
    expect(borrow).toBeDefined();
    expect(borrow?.symbol).toBe("USDT");
    expect(borrow?.price).toBeGreaterThan(0);
    expect(borrow?.value).toBeLessThan(0);
    expect(borrow?.value).toBeCloseTo(borrow!.amount * borrow!.price!, 10);

    const supply = rows.find((r) => r.symbol === "WBTC");
    expect(supply?.amount).toBeGreaterThan(0);
    expect(supply?.value).toBeGreaterThan(0);
  });

  it("all defi, meta carries protocol + positionType", () => {
    // Reconciliation (measured on vitalik's address): sum of wallet + sum of protocol net value ~ upstream total_usd_value; cache_token_list has only
    // wallet holdings and complex_protocol_list only protocol holdings, so neither parser may produce the other's rows.
    const rows = parseProtocols(protocols, ids);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.kind).toBe("defi");
    const lending = rows.find((r) => r.symbol === "WBTC");
    expect(lending?.meta.positionType).toBe("Lending");
    expect(lending?.meta.protocol).toBeTruthy();
  });

  it("meta carries the protocol's top-level logo (collects p.logo_url as protocolLogo)", () => {
    const rows = parseProtocols(protocols, ids);
    const lending = rows.find((r) => r.symbol === "WBTC");
    // The fixture's first protocol (aave3) carries a top-level logo_url, which lands in meta.protocolLogo of each of its rows.
    expect(lending?.meta.protocolLogo).toContain("static.debank.com");
    expect(lending?.meta.protocolLogo).toContain("aave3");
  });

  it("accepts the singular `token` shape (the old types.ts missed it)", () => {
    const rows = parseProtocols(protocols, ids);
    expect(rows.some((r) => r.meta.positionType === "Vesting")).toBe(true);
  });

  it("reward legs are produced positive (claimable yield, not debt)", () => {
    const rows = parseProtocols(protocols, ids);
    // compound3 in the fixture carries reward_token_list
    expect(
      rows.filter((r) => r.meta.positionType === "Lending" && r.amount > 0).length,
    ).toBeGreaterThan(1);
  });

  it("defi rows skip the dust gate: protocol positions are already filtered, and filtering again would make net worth disagree with the account", () => {
    const tiny: RabbyProtocol[] = [
      {
        id: "p",
        name: "P",
        portfolio_item_list: [
          {
            name: "Lending",
            detail: {
              supply_token_list: [{ id: "0x1", chain: "eth", symbol: "X", amount: 1e-9, price: 1 }],
            },
          },
        ],
      },
    ];
    expect(parseProtocols(tiny, ids)).toHaveLength(1);
  });

  it("no numeric chainId: throws", () => {
    const bad: RabbyProtocol[] = [
      {
        id: "p",
        portfolio_item_list: [
          {
            name: "L",
            detail: {
              supply_token_list: [{ id: "0x1", chain: "nope", symbol: "X", amount: 1, price: 1 }],
            },
          },
        ],
      },
    ];
    expect(() => parseProtocols(bad, ids)).toThrow();
  });
});

describe("golden: recorded responses in, pinned rows out", () => {
  it("wallet rows then protocol rows", () => {
    const ids = parseChainIds(chains);
    expect([...parseTokens(tokens, ids), ...parseProtocols(protocols, ids)]).toEqual(expected);
  });
});
