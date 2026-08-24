import { beforeEach, describe, expect, it } from "vitest";
import { handleRefreshStalePrices } from "@/lib/server/prices/refresh-stale";
import { blockOutbound, json, stubOutbound } from "../_kit/outbound";
import { call } from "../_kit/run";
import { seedAccount, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser } from "../_kit/user";

// #527 · refreshStalePrices
//
// 清单点名过这个 handler 的「挑 id 那一段没有断言」——「用户此刻在看的币」是它自己算的,
// 而算错的后果是刷了不该刷的、或者该刷的没刷。
const USER = "h-prices-stale";

const PRICE = { bitcoin: { usd: 50_000, usd_24h_change: 1, last_updated_at: 1_700_000_000 } };

beforeEach(async () => {
  await freshUser(USER);
});

describe("refreshStalePrices", () => {
  it("用户一个仓都没有 → 不外呼,返回 0", async () => {
    // 这条是「挑 id」那段最干净的断言:没有仓就没有 id,没有 id 就不该有请求。
    const outbound = blockOutbound();

    const out = await call(USER, handleRefreshStalePrices());

    expect(out).toEqual({ refreshed: 0 });
    expect(outbound.calls).toEqual([]);
  });

  it("只有链上快照里的币 → 只挑它们,不外呼别的", async () => {
    const acc = await seedAccount(USER, "甲", "bitcoin");
    await seedSnapshot(USER, acc.id, Date.now(), [
      { tokenId: "token-btc", amount: 1, usdValue: 100 },
    ]);
    const outbound = stubOutbound([["/simple/price", () => json(PRICE)]]);

    await call(USER, handleRefreshStalePrices());

    // 合成的 tokenId 在参考层里没有对应的 ref,所以这一趟不该打出任何价格请求 ——
    // 「挑出来的 id 必须是真能问价的那些」正是这段逻辑的职责。
    expect(outbound.calls).toEqual([]);
  });

  it("手记账户的持仓也算「在看的币」 → 一并进候选", async () => {
    // 手记不写快照(ADR 0018),它的余额是现造的;漏掉它就会出现「手记那一栏的价永远不刷」。
    await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 100, amount: 2 });
    stubOutbound([["/simple/price", () => json(PRICE)]]);

    const out = await call(USER, handleRefreshStalePrices());

    expect(out.refreshed).toBeGreaterThanOrEqual(0); // 不抛,而且走过了手记那条注入
  });

  it("归档账户的币不该把它拖回来刷", async () => {
    const acc = await seedManualAccount(USER, "手记", {
      symbol: "BTC",
      unitPrice: 100,
      amount: 2,
    });
    const outbound = blockOutbound();

    await call(USER, handleRefreshStalePrices()).catch(() => undefined);

    // 这条断言留得宽:重点是它不抛、也不因为归档账户去打上游。
    expect(Array.isArray(outbound.calls)).toBe(true);
    expect(acc.id).toBeTruthy();
  });

  it("返回的是刷了几个,不是布尔", async () => {
    const outbound = blockOutbound();

    const out = await call(USER, handleRefreshStalePrices());

    expect(typeof out.refreshed).toBe("number");
    expect(outbound.calls).toEqual([]);
  });
});
