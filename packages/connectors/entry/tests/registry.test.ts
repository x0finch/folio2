import { type CredField, Defi, defineConnector, Spot } from "@folio/connectors-basic";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildRegistry, getConnector, registry, selectProvider } from "../src/registry";

// A sample connector built in place (spot + defi subset) to verify registry assembly (buildRegistry/getConnector/selectProvider).
const address = [
  { key: "address", type: "public", validator: z.string().min(1), label: "Address" },
] as const satisfies readonly CredField[];

const evmLike = defineConnector({
  id: "evm-like",
  label: "EVM-like",
  logo: "",
  account: { creds: address },
  balance: {
    schema: z.discriminatedUnion("kind", [Spot, Defi]),
    providers: [
      {
        id: "demo",
        label: "Demo",
        creds: [],
        fetchBalances: (ctx) =>
          Effect.succeed({
            balances: [
              {
                kind: "spot",
                symbol: ctx.account.creds.address,
                tokenRef: `evm:1/${ctx.account.creds.address}`,
                amount: 1,
                value: 1,
              },
              {
                kind: "defi",
                symbol: "x",
                tokenRef: "evm:1/0xdef",
                amount: 1,
                value: 1,
                meta: { protocol: "demo" },
              },
            ],
          }),
        validateAccount: () => Effect.succeed(true),
      },
    ],
  },
});

describe("registry", () => {
  it("buildRegistry builds a table by id; a duplicate id throws", () => {
    const reg = buildRegistry([evmLike]);
    expect(getConnector(reg, "evm-like")?.id).toBe("evm-like");
    expect(getConnector(reg, "nope")).toBeUndefined();
    expect(() => buildRegistry([evmLike, evmLike])).toThrow(/duplicate/);
  });

  it("selectProvider takes the first eligible one (defaultEnabled !== false)", () => {
    const providers = evmLike.balance.providers;
    expect(selectProvider(evmLike)?.id).toBe("demo");

    // A manifest with defaultEnabled:false first and true later; asserts the disabled one is skipped.
    const twoProv = {
      ...evmLike,
      balance: {
        ...evmLike.balance,
        providers: [
          { ...providers[0], id: "off", defaultEnabled: false },
          { ...providers[0], id: "on" },
        ],
      },
    };
    expect(selectProvider(twoProv)?.id).toBe("on");
  });
});

describe("real registry: evm's data sources", () => {
  it("evm uses rabby by default; zerion is registered but does not take part in fetching", () => {
    // Switching evm's default source to rabby (no key, all chains at once) is deliberate; reordering providers or dropping
    // zerion's defaultEnabled turns this red.
    const evm = getConnector(registry, "evm");
    expect(evm).toBeDefined();
    expect(selectProvider(evm!)?.id).toBe("rabby");
    expect(evm?.balance.providers.map((p) => p.id)).toEqual(["rabby", "zerion"]);
    expect(evm?.balance.providers.find((p) => p.id === "zerion")?.defaultEnabled).toBe(false);
  });
});
