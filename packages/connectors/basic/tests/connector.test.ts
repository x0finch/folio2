import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Defi, Spot } from "../src/balance";
import { defineConnector } from "../src/connector";
import type { CredField } from "../src/creds";

// 一个 spot·defi 子集的示例 connector(骨架片无真实 connector,这里就地造一个验契约/推断)。
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
      // 出口是 Effect —— 这里用 `Effect.succeed` 直接给,不必绕 `promiseProvider`
      // (那个垫片是给「实现内部还是 Promise」的 9 个 provider 用的)。
      {
        id: "demo",
        label: "Demo",
        creds: [],
        // fetchBalances 返回 { balances }(窄化到 spot|defi:写 spot/defi 通过);仅供展示的 note 挂在各 balance 上。
        fetchBalances: (ctx) =>
          Effect.succeed({
            balances: [
              {
                kind: "spot",
                symbol: ctx.account.creds.address,
                tokenRef: `evm:1/${ctx.account.creds.address}`,
                amount: 1,
                value: 1,
                note: { title: "Note", content: "demo note" },
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

describe("defineConnector", () => {
  it("产出擦除版 manifest(id/label/logo/account.creds/balance)", () => {
    expect(evmLike.id).toBe("evm-like");
    expect(evmLike.account.creds.map((c) => c.key)).toEqual(["address"]);
    expect(evmLike.balance.providers).toHaveLength(1);
  });

  it("account.creds 经 const 泛型 → ctx.account.creds.address 有编译期类型", async () => {
    const p = evmLike.balance.providers[0];
    const out = await Effect.runPromise(
      p.fetchBalances({
        account: { id: "a", label: "l", connectorId: "evm-like", creds: { address: "0xabc" } },
        creds: {},
      }),
    );
    expect(out.balances[0]).toMatchObject({ kind: "spot", symbol: "0xabc" });
    // 仅供展示的 note(单个 Note)挂在该 balance 上(per-balance)。
    expect(out.balances[0]?.note).toEqual({ title: "Note", content: "demo note" });
  });
});
