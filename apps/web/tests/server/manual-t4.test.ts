import { env } from "cloudflare:test";
import { FIAT_NAMER, tokenTicket } from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { beforeEach, describe, expect, it } from "vitest";
import { buildOwnedOptions } from "@/components/token-search";
import { dbFor } from "./db-effect";
import {
  addManualActivities,
  createManualAccount,
  editManualActivity,
  loadManualAccountDetail,
} from "./manual-fns";
import { ticketOf } from "./ticket";

// T4(#156)服务端支撑:抽屉读路径 loadManualAccountDetail(token 定义 + 折叠 amount + 全部活动)+ fee 落库 round-trip。
// 真实 D1(Miniflare);不隔离每测存储 → beforeEach 重置。开仓 set = Date.now(),后续活动用远未来 LATER 排其后。
const USER = "user-manual-t4";
const LATER = 4_000_000_000_000;

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}
beforeEach(resetUser);

async function seedAccount() {
  return createManualAccount(
    USER,
    "M",
    JSON.stringify([
      { symbol: "BTC", unitPrice: "60000", ticket: ticketOf("bitcoin"), amount: "1" },
    ]),
  );
}

describe("loadManualAccountDetail", () => {
  it("返回 token(带 DB id + 折叠 amount)+ 全部活动(带 tokenId)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);

    expect(detail.tokens).toHaveLength(1);
    const [btc] = detail.tokens;
    expect(btc.symbol).toBe("BTC");
    expect(btc.ticket).toBe(ticketOf("bitcoin"));
    expect(btc.amount).toBe(1.5); // 开仓 set 1 + add 0.5
    expect(typeof btc.id).toBe("string");

    // 活动:开仓 set + add,均挂在该 token 上。
    expect(detail.activities.map((a) => a.kind).sort()).toEqual(["add", "set"]);
    expect(detail.activities.every((a) => a.tokenId === btc.id)).toBe(true);
  });

  it("空账户(无 token)→ 空 detail", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "manual",
      label: "empty",
      creds: JSON.stringify({ tokens: "[]" }),
    });
    const detail = await loadManualAccountDetail(USER, account.id);
    expect(detail).toEqual({ tokens: [], activities: [] });
  });

  // 法币持仓的票走 **fiat 命名者**(coingecko 那档恒空)—— 不给的话前端拿不到票:预填/再选会掉进
  // 「手动输入」→ mint 成自定义币而非原法币,还被 ownedOptions 的「有票才收」滤掉(用户报的两个 bug)。
  it("法币持仓:ticket 走 fiat ref,可解回同一条法币身份", async () => {
    const eurTicket = tokenTicket.encode(tokenRef.issued(FIAT_NAMER, "EUR"));
    const account = await createManualAccount(
      USER,
      "Cash",
      JSON.stringify([{ symbol: "EUR", unitPrice: "1.15", amount: "1000", ticket: eurTicket }]),
    );
    const detail = await loadManualAccountDetail(USER, account.id);

    expect(detail.tokens).toHaveLength(1);
    const [eur] = detail.tokens;
    expect(eur.symbol).toBe("EUR");
    // 有票(非 null)且解回 fiat/issued:EUR —— 再选它 mint 回同一条(不是 custom)。
    expect(eur.ticket).not.toBeNull();
    expect(tokenTicket.decode(eur.ticket ?? "", FIAT_NAMER)).toBe("fiat/issued:EUR");
  });

  // #269 端到端:侧边栏「加 activity」的「已有代币」组数据 = loadManualAccountDetail → buildOwnedOptions。
  // 钉住(1)有票的都收(2)**已清仓(0 余额)的旧持仓仍在**(刻意不看余额)(3)自定义(无票)排除。
  it("已有代币组:含已清仓(0 余额)的有票持仓,排除自定义(无票)", async () => {
    const account = await seedAccount(); // BTC 开仓 set 1(ticket=bitcoin)
    await addManualActivities(USER, account.id, [
      // BTC 全部卖出 → 余额 0,但仍是账户里的持仓(有 activity + 票)。
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "reduce",
        amount: 1,
        occurredAt: LATER + 1,
      },
      // 手敲的自定义币(没选币 → 无票)。
      { token: { symbol: "PRIV", unitPrice: 5 }, kind: "add", amount: 3, occurredAt: LATER + 2 },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);
    expect(detail.tokens.find((t) => t.symbol === "BTC")?.amount).toBe(0); // 已清仓
    expect(detail.tokens.find((t) => t.symbol === "PRIV")?.ticket).toBeNull(); // 自定义无票

    const owned = buildOwnedOptions(detail.tokens, new Map());
    // BTC(0 余额、有票)在;PRIV(无票)不在。
    expect(owned.map((o) => o.symbol)).toEqual(["BTC"]);
  });
});

describe("fee 落库 round-trip", () => {
  it("批量加活动带 fee → 存库可读回", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        price: 60000,
        fee: 12.5,
      },
    ]);
    const detail = await loadManualAccountDetail(USER, account.id);
    const added = detail.activities.find((a) => a.kind === "add");
    expect(added?.fee).toBe(12.5);
    expect(added?.price).toBe(60000);
  });

  it("编辑活动可改 fee(含清空为 null)", async () => {
    const account = await seedAccount();
    await addManualActivities(USER, account.id, [
      {
        token: { symbol: "BTC", unitPrice: 60000, ticket: ticketOf("bitcoin") },
        kind: "add",
        amount: 0.5,
        occurredAt: LATER + 1,
        fee: 5,
      },
    ]);
    const added = (await loadManualAccountDetail(USER, account.id)).activities.find(
      (a) => a.kind === "add",
    );
    if (!added) throw new Error("add missing");

    // 改 fee 5 → 20
    let res = await editManualActivity(USER, added.id, { fee: 20 });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBe(20);

    // 清空 fee → null
    res = await editManualActivity(USER, added.id, { fee: null });
    expect(res.ok).toBe(true);
    expect(
      (await loadManualAccountDetail(USER, account.id)).activities.find((a) => a.id === added.id)
        ?.fee,
    ).toBeNull();
  });
});
