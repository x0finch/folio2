import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildGainLines,
  computeGain24h,
  GAIN_WINDOW_MS,
} from "../../src/lib/server/portfolio/gain-24h";
import { dbFor } from "./db-effect";
import { addManualActivities, loadManualGainHistory } from "./manual-fns";

// manual 账户的 24h 盈亏走**账本**,不迁就快照网格(ADR 0040 / #447 第 3 片)。
//
// 上一片里 manual 的线只有一个当下点 → 一律「算不出」:它从不写快照(ADR 0018)。但它手上的东西
// 比快照更好 —— 账本记着每笔什么时候买的、多少钱买的。这组验的就是那些点确实被产出来了、
// 而且产在对的时刻上。
//
// 网络无关:全用**无 identifier** 的 token(未选币)→ `buildHistoricalPriceAt` 直接跳过、不回源,
// 价走账本里那笔活动记的价(降级链第 ②档)。与 manual-grid 那组同一个手法。
const USER = "user-gain-manual";
const NOW = 1_700_000_000_000;
const FROM = NOW - GAIN_WINDOW_MS;
const HOUR = 60 * 60 * 1000;

// 无 identifier → 不触发 oracle,价取账本
const localBtc = { symbol: "BTC", unitPrice: 100 };
const localEth = { symbol: "ETH", unitPrice: 10 };

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

const emptyAccount = (label = "M") =>
  dbFor(USER).accounts.create({
    connectorId: "manual",
    label,
    creds: JSON.stringify({ tokens: "[]" }),
  });

describe("按账本产观测点", () => {
  it("窗口起点那一刻直接产点 —— 账本能算任意时刻,不用等快照落在哪儿", async () => {
    const acc = await emptyAccount();
    // 两天前建的仓:窗口起点时它已经在了
    await addManualActivities(USER, acc.id, [
      {
        token: localBtc,
        kind: "add",
        amount: 2,
        occurredAt: FROM - 2 * GAIN_WINDOW_MS,
        price: 100,
      },
    ]);

    const rows = await loadManualGainHistory(USER, [acc], NOW, FROM);
    const basis = rows.find((r) => r.takenAt === FROM);
    expect(basis).toBeDefined();
    expect(basis?.amount).toBe(2);
    expect(basis?.usdValue).toBe(200); // 2 × 账本记的价 100
  });

  it("窗口内每一笔活动的时刻都产点 —— 切口就在你动手的那一刻", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM - HOUR, price: 100 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM + 12 * HOUR, price: 105 },
    ]);

    const rows = await loadManualGainHistory(USER, [acc], NOW, FROM);
    const times = [...new Set(rows.map((r) => r.takenAt))].sort((a, b) => a - b);
    expect(times).toEqual([FROM, FROM + 12 * HOUR]);
    // 中午那一刻数量已是 2,价按那笔活动记的 105
    const noon = rows.find((r) => r.takenAt === FROM + 12 * HOUR);
    expect(noon?.amount).toBe(2);
    expect(noon?.usdValue).toBe(210);
  });

  it("每个币在每个观测时刻都产行 —— 少一行,持仓会在别的币交易那一刻被清零", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM - HOUR, price: 100 },
      // ETH 在窗口内动了一笔 —— 那个时刻 BTC 没有活动,但它**还在**
      { token: localEth, kind: "add", amount: 5, occurredAt: FROM + 6 * HOUR, price: 10 },
    ]);

    const rows = await loadManualGainHistory(USER, [acc], NOW, FROM);
    const btcAtEthTime = rows.find(
      (r) => r.takenAt === FROM + 6 * HOUR && r.usdValue === 100 && r.amount === 1,
    );
    // 这就是那条容易漏的行:BTC 在 ETH 交易的时刻仍有 1 枚
    expect(btcAtEthTime).toBeDefined();
  });

  it("窗口开始之后才建的仓 —— 起点那一刻数量是 0,于是不算成赚", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM + 3 * HOUR, price: 100 },
    ]);

    const rows = await loadManualGainHistory(USER, [acc], NOW, FROM);
    expect(rows.find((r) => r.takenAt === FROM)?.amount).toBe(0);
  });

  it("空账户不产行", async () => {
    const acc = await emptyAccount();
    expect(await loadManualGainHistory(USER, [acc], NOW, FROM)).toEqual([]);
  });

  it("归档账户不参与 —— 封存之后不再产生 24h 盈亏(ADR 0039)", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM - HOUR, price: 100 },
    ]);
    await dbFor(USER).accounts.setArchived(acc.id, true);
    const archived = await dbFor(USER).accounts.getById(acc.id);

    expect(await loadManualGainHistory(USER, [archived!], NOW, FROM)).toEqual([]);
  });
});

describe("端到端:manual 账户从「算不出」变成真数字", () => {
  it("没有账本原料时是算不出(上一片的行为)", () => {
    // 只有当下点 → 没有基准
    const lines = buildGainLines(
      [],
      [{ accountId: "m1", tokenId: "t", amount: 1, value: 110 }],
      NOW,
    );
    expect(computeGain24h(lines.get("t") ?? [], NOW)).toBeNull();
  });

  it("接上账本之后算得出,且当天新买那笔的本金不算成赚", async () => {
    const acc = await emptyAccount();
    await addManualActivities(USER, acc.id, [
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM - HOUR, price: 100 },
      { token: localBtc, kind: "add", amount: 1, occurredAt: FROM + 12 * HOUR, price: 105 },
    ]);
    const history = await loadManualGainHistory(USER, [acc], NOW, FROM);
    const tokenId = history[0].tokenId as string;

    // 当下:2 枚,盯市 110 一枚
    const lines = buildGainLines(
      history,
      [{ accountId: acc.id, tokenId, amount: 2, value: 220 }],
      NOW,
    );
    const gain = computeGain24h(lines.get(tokenId) ?? [], NOW);

    expect(gain).not.toBeNull();
    // 旧那枚 100→110 赚 10;中午那枚 105→110 赚 5。中午投进去的 105 本金不算。
    expect(gain?.amount).toBeCloseTo(15, 6);
    // 连乘:(1 + 5/100) × (1 + 10/210) − 1 = 10.0%,而不是 15/100 = 15%
    expect(gain?.pct).toBeCloseTo(10, 4);
    expect(gain?.pct).not.toBeCloseTo(15, 1);
  });
});
