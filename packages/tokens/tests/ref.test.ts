import { describe, expect, it } from "vitest";
import { TokenError } from "../src/errors";
import { parseRefKey, refKey } from "../src/ref";
import type { CoinId, TokenRef } from "../src/types";

const ref = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

describe("refKey / parseRefKey", () => {
  it("serializes to `source:coinId`", () => {
    expect(refKey(ref("bitcoin"))).toBe("coingecko:bitcoin");
    expect(refKey(ref("usd-coin"))).toBe("coingecko:usd-coin");
  });

  it("round-trips", () => {
    for (const id of ["bitcoin", "usd-coin", "the-open-network"]) {
      expect(parseRefKey(refKey(ref(id)))).toEqual(ref(id));
    }
  });

  it("throws TokenError(PARSE_ERROR) on invalid keys", () => {
    for (const bad of ["nocolon", ":bitcoin", "coingecko:", "unknown:foo"]) {
      expect(() => parseRefKey(bad)).toThrow(TokenError);
    }
    try {
      parseRefKey("nocolon");
    } catch (e) {
      expect((e as TokenError).code).toBe("PARSE_ERROR");
    }
  });
});
