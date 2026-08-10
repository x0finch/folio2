import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountHoldings } from "../../src/lib/server/internal/account-holdings";
import { runRequest } from "../../src/lib/server/internal/oracle";
import { dbFor } from "./db-effect";
import { createManualAccount, sealManualAccount } from "./manual-fns";
import { ticketOf } from "./ticket";

// 归档 = 封存(ADR 0039)。manual 账户从不写快照(ADR 0018),持仓每次读都从账本现算 ——
// 所以归档之后库里没有任何可展示的照片。归档那一刻按账本算一次、落一张**真的**快照,是这一片的全部。
//
// 这些用例都打真 D1:封存跨了账本、参考层、快照三处,而「有没有真落一行」只有在库里看得出来。
// 出网一律打桩成抛错 —— 封存按设计不出网(价取自本地参考层缓存,取不到回退用户自填价)。
const USER = "user-archive-seal";

let outbound: string[] = [];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`封存不该出网,却请求了 ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const manualWithBtc = (label = "M") =>
  createManualAccount(
    USER,
    label,
    JSON.stringify([{ symbol: "BTC", unitPrice: "100", amount: "2", ticket: ticketOf("bitcoin") }]),
  );

describe("归档 manual 账户 = 落一张封存快照", () => {
  it("封存之前:一张快照都没有(这正是本片存在的理由)", async () => {
    const account = await manualWithBtc();
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toEqual([]);
  });

  it("封存之后:库里真的多了一张,金额取自账本", async () => {
    const account = await manualWithBtc();

    const sealed = await sealManualAccount(USER, account, 1_700_000_000_000);

    expect(sealed).toBe(true);
    const snaps = await dbFor(USER).snapshots.listByAccount(account.id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].takenAt).toBe(1_700_000_000_000);
    // 2 枚 × 自填价 100(参考层缓存是冷的,现价取不到 → 回退自填价,与注入那条路同门)
    expect(snaps[0].totalUsd).toBe(200);
    expect(outbound).toEqual([]);
  });

  // 封存那条路复用「合成注入」,而注入按「未归档」过滤 —— 先打标记再封存会一无所获。
  // 这条把「顺序不是风格问题」钉死。
  it("已经打上归档标记之后再封存 → 什么都落不下来", async () => {
    const account = await manualWithBtc();
    await dbFor(USER).accounts.setArchived(account.id, true);

    const sealed = await sealManualAccount(USER, { ...account, archivedAt: Date.now() });

    expect(sealed).toBe(false);
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toEqual([]);
  });

  it("非 manual 账户不落 —— 它们本来就有快照,补一张没有新信息", async () => {
    const account = await dbFor(USER).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });

    expect(await sealManualAccount(USER, account)).toBe(false);
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toEqual([]);
  });

  // 封存 + 打标记之后,账户页那条读路径终于能显示它 —— 这是片 2 与片 3 合起来才成立的事,
  // 所以在这里端到端走一遍,而不是各自信各自那半。
  it("封存 + 归档之后,按账户明细里有它,数字是封存那一刻的", async () => {
    const account = await manualWithBtc();
    await sealManualAccount(USER, account, 1_700_000_000_000);
    await dbFor(USER).accounts.setArchived(account.id, true);

    const view = await runRequest(USER, loadAccountHoldings());
    const row = view.rows.find((r) => r.account.id === account.id);

    expect(row?.archivedAt).not.toBeNull();
    expect(row?.totalUsd).toBe(200);
    expect(row?.takenAt).toBe(1_700_000_000_000);
    expect(row?.balances).toHaveLength(1);
  });

  // 取消归档之后合成注入重新接管 → 数字回到实时,封存快照被盖掉(它沉进历史,不删)。
  it("取消归档 → 数字回到实时,那张封存快照仍留在库里", async () => {
    const account = await manualWithBtc();
    await sealManualAccount(USER, account, 1_700_000_000_000);
    await dbFor(USER).accounts.setArchived(account.id, true);
    await dbFor(USER).accounts.setArchived(account.id, false);

    const view = await runRequest(USER, loadAccountHoldings());
    const row = view.rows.find((r) => r.account.id === account.id);

    expect(row?.archivedAt).toBeNull();
    // 注入用的是「现在」,不是封存那一刻
    expect(row?.takenAt).not.toBe(1_700_000_000_000);
    // 快照没被删
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toHaveLength(1);
  });
});
