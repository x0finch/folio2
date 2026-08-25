import { beforeEach, describe, expect, it } from "vitest";
import { handleGetSyncStatus } from "@/lib/server/sync/get-status";
import { db } from "../_kit/db";
import { fakeRegistry } from "../_kit/fakes";
import { blockOutbound } from "../_kit/outbound";
import { callWithRegistry } from "../_kit/run";
import { DAY, seedManualAccount, seedSnapshot } from "../_kit/seed";
import { freshUser, otherUser } from "../_kit/user";

// #527 · getSyncStatus
const USER = "h-sync-status";
const BTC = "token-btc";

let NOW = 0;
const status = async () => {
  const { registry } = await fakeRegistry();
  return callWithRegistry(USER, registry, handleGetSyncStatus());
};

const cex = (userId: string, label: string, creds: Record<string, string> | null) =>
  db(userId).accounts.create({
    connectorId: "binance",
    label,
    creds: creds ? JSON.stringify(creds) : null,
  });

beforeEach(async () => {
  blockOutbound();
  await freshUser(USER);
  await freshUser(otherUser(USER));
  NOW = Date.now();
});

describe("getSyncStatus", () => {
  it("缺凭据算失败,「很久没同步」不算 —— 只有两档失败原因", async () => {
    const fresh = await cex(USER, "刚同步", { apiKey: "k", secret: "s" });
    await seedSnapshot(USER, fresh.id, NOW, [{ tokenId: BTC, amount: 1, usdValue: 100 }]);
    const stale = await cex(USER, "很久没同步", { apiKey: "k", secret: "s" });
    await seedSnapshot(USER, stale.id, NOW - 30 * DAY, [
      { tokenId: BTC, amount: 1, usdValue: 100 },
    ]);
    await cex(USER, "缺凭据", { apiKey: "k" });

    const out = await status();

    // 汇总的形状是 `{ accounts, total, ok, failed, lastSyncedAt }`,失败**只有两档**:
    // `missing-credentials` 与 `never-synced`。
    //
    // **实测纠正了我的假设:「30 天没同步」不是失败状态。** 它同步过,所以算 ok ——
    // 新鲜度压根没进这个汇总。这在产品上说得通(界面另有「上次同步于…」那行文案),
    // 但它意味着「这个账户的数据早就过期了」这件事**没有任何汇总数字反映**。
    // 要不要加一档 stale 是你的决定(#527 待定项)。
    expect(out.total).toBe(3);
    expect(out.failed.map((f) => f.reason)).toEqual(["missing-credentials"]);
    expect(out.ok).toBe(2);
    expect(out.lastSyncedAt).toBe(NOW);
  });

  it("手记账户不计入可同步数", async () => {
    // 手记没有上游,把它算进「待同步」会让那个数字永远降不到 0。
    await seedManualAccount(USER, "手记", { symbol: "BTC", unitPrice: 1, amount: 1 });
    await cex(USER, "币安", { apiKey: "k", secret: "s" });

    const out = await status();

    expect(out.total).toBe(1);
  });

  it("一个可同步账户都没有 → 返回零值而不是 null", async () => {
    const out = await status();

    expect(out.total).toBe(0);
    expect(out.ok).toBe(0);
    expect(out.failed).toEqual([]);
    expect(out.lastSyncedAt).toBeNull();
  });

  it("creds 是 null(从没填过)→ 算「缺凭据」", async () => {
    await cex(USER, "空的", null);

    expect((await status()).failed.map((f) => f.reason)).toEqual(["missing-credentials"]);
  });

  it("从没同步过的账户 → 上次同步时刻是空,不是 1970", async () => {
    // 0 会被界面格式化成 1970-01-01,读起来像「同步过、只是很久以前」。
    await cex(USER, "没同步过", { apiKey: "k", secret: "s" });

    const out = await status();

    expect(out.lastSyncedAt).toBeNull();
    expect(out.failed.map((f) => f.reason)).toEqual(["never-synced"]);
  });

  it("别人的账户不进我的汇总", async () => {
    await cex(otherUser(USER), "他们的", { apiKey: "k", secret: "s" });

    expect((await status()).total).toBe(0);
  });
});
