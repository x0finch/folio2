import { env } from "cloudflare:test";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { deriveAmount } from "../../src/lib/manual-activity";
import { NAMER } from "../../src/lib/server/internal/oracle";
import { dbFor } from "./db-effect";
import { createAccountFor, createManualAccount } from "./manual-fns";
import { ticketOf } from "./ticket";

// manual 创建往返的真实 D1 集成测试(jsdom 单测覆盖不到的服务端编排)。
// 这套 pool 版本不隔离每测存储 → beforeEach 重置(删 user 级联清账户/token/活动)。
const USER = "user-manual-it";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run(); // cascade → accounts/tokens → activity
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

beforeEach(resetUser);

// 该账户的持仓(定义 + 账本折叠出的数量)。#203 起这是唯一事实源 —— 没有 creds.tokens 那个投影了。
async function holdings(accountId: string) {
  const rows = await dbFor(USER).manual.listHoldings(accountId, NAMER);
  return Promise.all(
    rows.map(async (r) => ({
      symbol: r.symbol,
      ref: r.ref,
      amount: deriveAmount(await dbFor(USER).manual.listActivityByToken(accountId, r.id)),
    })),
  );
}

// 账户的 creds 里**不该**再有持仓数据(物化那一步删了)。
async function credsOf(accountId: string): Promise<Record<string, unknown>> {
  const raw = await dbFor(USER).accounts.getRawCreds(accountId);
  return JSON.parse(raw ?? "{}");
}

describe("createManualAccount (D1 round-trip)", () => {
  it("认币 → 落声明 → 一条开仓 set 活动", async () => {
    const tokens = JSON.stringify([
      { symbol: "BTC", unitPrice: "64000", ticket: ticketOf("bitcoin"), amount: "0.5" },
    ]);
    const account = await createManualAccount(USER, "My BTC", tokens);

    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", ref: `${NAMER}/issued:bitcoin`, amount: 0.5 },
    ]);
  });

  // 用户选了币 → 票解出来的 ref 在 mint 里本身就是锚 → 直接认出来,不查映射表、也不按 symbol 猜。
  it("选了币 → 票解出来的那条 ref 定身份", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "XBT", unitPrice: "1", amount: "1", ticket: ticketOf("bitcoin") }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBe(`${NAMER}/issued:bitcoin`); // 哪怕 symbol 敲成了 XBT
  });

  // 票是从网络上来的 —— 解不开就当没选币(退回 `manual/custom:<名字>`),而不是崩掉或写脏。
  it("票损坏 → 当作没选币,自己一行", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "XBT", unitPrice: "1", amount: "1", ticket: "!!!not-base64!!!" }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBeNull(); // 没有上游命名 → 自己一行,用他填的单价估值
  });

  // **手编一张合规但别家命名者的票**(#223)。票没有签名,谁都能自己编一张;而 `issued` 的
  // 含义是「命名者为它负责」—— 不核对命名者的话,这张票会让 mint 掉回 symbol 那一档,
  // 用户敲的 `BTC` 就又被拿去认币了,正是这一票收紧掉的东西。
  //
  // 用 BTC + 一张 `evil/issued:whatever`:BTC 在候选里认得出来,所以「有没有挡住」看得见 ——
  // 挡住了就是自己一行,没挡住就会挂上上游那条 BTC 的 ref。
  it("票合规但命名者是别家 → 也当作没选币,且不按 symbol 认", async () => {
    const forged = tokenTicket.encode("evil/issued:whatever");
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1", ticket: forged }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    expect(h.ref).toBeNull();
  });

  // creds 里那个 `tokens` 字段只剩一个空壳:它是**创建表单的入参声明**,不再是持仓的存储处。
  it("持仓数据不再写进 creds", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "1", amount: "1" }]),
    );
    expect((await credsOf(account.id)).tokens).toBe("[]");
  });

  it("rejects an empty tokens array (form always sends one; z.array admits [])", async () => {
    await expect(createManualAccount(USER, "M", "[]")).rejects.toThrow();
  });

  // #272 端到端:选法币 → 票携带 `fiat/issued:USD` → mintHolding 解票(命名者集合含 fiat)→
  // mint 建 canonical 法币行。身份落在 **fiat 命名者**下(coingecko 那档恒空,法币无上游 ref)。
  // 把 manual.ts 的 decode 改回只收 NAMER,这条会红(fiat 票掉回 custom、fiat ref 变 null)——
  // 正是本票要打通的那一跳。
  it("选中法币 → 票解出 fiat 身份 → 建出 canonical 法币行", async () => {
    const account = await createManualAccount(
      USER,
      "Cash",
      JSON.stringify([
        {
          symbol: "USD",
          unitPrice: "1",
          amount: "500",
          ticket: tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "USD")),
        },
      ]),
    );
    const [underFiat] = await dbFor(USER).manual.listHoldings(account.id, FIAT_NAMER);
    expect(underFiat.symbol).toBe("USD");
    expect(underFiat.ref).toBe("fiat/issued:USD");
    // 数量落库;coingecko 命名者那档无 ref(法币不链上游)。
    expect(await holdings(account.id)).toEqual([{ symbol: "USD", ref: null, amount: 500 }]);
  });

  it("没选币 → 那位命名者那条 ref 为空(没认出来),照样落库", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "PRIVATETOKEN", unitPrice: "3200", amount: "2" }]),
    );
    expect(await holdings(account.id)).toEqual([{ symbol: "PRIVATETOKEN", ref: null, amount: 2 }]);
  });
});

// #1:createAccount handler 的分派逻辑(createAccountFor)—— manual 经**统一** validateAccountCreds 校验
// (provider 的 manualToken schema)+ 分派到账本创建。此前只直调 createManualAccount、绕过了这段。
describe("createAccountFor (manual: shared validate + dispatch)", () => {
  it("rejects manual creds missing symbol (runs through validateAccountCreds)", async () => {
    await expect(
      createAccountFor(USER, "manual", "M", {
        tokens: JSON.stringify([{ unitPrice: "1", amount: "1" }]),
      }),
    ).rejects.toThrow();
  });

  it("rejects when tokens is absent", async () => {
    await expect(createAccountFor(USER, "manual", "M", {})).rejects.toThrow();
  });

  it("合法入参 → 账户 + 持仓声明 + 开仓活动", async () => {
    const account = await createAccountFor(USER, "manual", "My BTC", {
      tokens: JSON.stringify([
        { symbol: "BTC", unitPrice: "64000", amount: "0.5", ticket: ticketOf("bitcoin") },
      ]),
    });
    expect(await holdings(account.id)).toEqual([
      { symbol: "BTC", ref: `${NAMER}/issued:bitcoin`, amount: 0.5 },
    ]);
  });
});

// #203:数量一律 compute-on-read。原来这里测的是「物化那一步把账本折叠写回 creds」——
// 那一步删了,于是「忘了重跑物化 → 显示 stale」这类 bug 面也整个消失。
describe("数量随账本即时变化(无物化)", () => {
  it("补一笔活动后,读出来的数量立刻是新的", async () => {
    const account = await createManualAccount(
      USER,
      "M",
      JSON.stringify([{ symbol: "BTC", unitPrice: "60000", amount: "1" }]),
    );
    const [h] = await dbFor(USER).manual.listHoldings(account.id, NAMER);
    await dbFor(USER).manual.recordActivity(account.id, h.id, {
      kind: "add",
      amount: 0.5,
      occurredAt: Date.now() + 1,
    });
    expect((await holdings(account.id))[0].amount).toBe(1.5);
  });
});
