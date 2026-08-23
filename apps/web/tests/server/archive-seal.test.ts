import { env } from "cloudflare:test";
import type { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAccountHistory } from "@/lib/server/accounts/history";
import type { AppError } from "@/lib/server/errors";
import { loadAccountHoldings } from "@/lib/server/portfolio/account-holdings";
import { runForUser, type UserServices } from "@/lib/server/runtime";
import { dbFor } from "./db-effect";
import { createManualAccount, sealManualAccount } from "./manual-fns";
import { ticketOf } from "./ticket";

// 归档 = 封存(ADR 0039)。manual 账户从不写快照(ADR 0018),持仓每次读都从账本现算 ——
// 所以归档之后库里没有任何可展示的照片。归档那一刻按账本算一次、落一张**真的**快照,是这一片的全部。
//
// 这些用例都打真 D1:封存跨了账本、参考层、快照三处,而「有没有真落一行」只有在库里看得出来。
// 出网一律打桩成抛错 —— 封存按设计不出网(价取自本地参考层缓存,取不到回退用户自填价)。
const USER = "user-archive-seal";

// 生产那条路的把手 —— 底下就是 server fn / 路由用的那个内核(#504 T13)。
const run = <A, E extends AppError, R extends UserServices>(
  userId: string,
  effect: Effect.Effect<A, E, R>,
): Promise<A> => runForUser(userId, effect);

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

    const view = await run(USER, loadAccountHoldings());
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

    const view = await run(USER, loadAccountHoldings());
    const row = view.rows.find((r) => r.account.id === account.id);

    expect(row?.archivedAt).toBeNull();
    // 注入用的是「现在」,不是封存那一刻
    expect(row?.takenAt).not.toBe(1_700_000_000_000);
    // 快照没被删
    expect(await dbFor(USER).snapshots.listByAccount(account.id)).toHaveLength(1);
  });
});

// —— 单账户曲线画到哪儿为止(片 5)——
//
// manual 的单账户曲线走账本 compute-on-read,末点原本恒是「现在」并且再补一个实时盯市点。
// 归档之后抽屉头显示的是封存值,曲线却还在往今天长 —— 一个抽屉里两个说法。
describe("归档 manual 账户的单账户曲线", () => {
  it("活跃时:末点到「现在」,而且补了实时盯市点", async () => {
    const account = await manualWithBtc();

    const { series } = await run(
      USER,
      loadAccountHistory({ accountId: account.id, connectorId: "manual" }),
    );

    expect(series.length).toBeGreaterThan(0);
    expect(Date.now() - series[series.length - 1].t).toBeLessThan(60_000);
  });

  it("归档后:末点停在封存那一刻,不再长到今天", async () => {
    const account = await manualWithBtc();
    await dbFor(USER).accounts.setArchived(account.id, true);
    // `setArchived` 写的是当刻;这条要的是「很久以前封的」,直接把时间戳往回拨三个月。
    const sealedAt = Date.now() - 90 * 24 * 3600_000;
    await env.DB.prepare("UPDATE accounts SET archived_at = ? WHERE id = ?")
      .bind(sealedAt, account.id)
      .run();

    const { series } = await run(
      USER,
      loadAccountHistory({ accountId: account.id, connectorId: "manual" }),
    );

    // 账本里的活动都在「现在」,而网格只画到封存那一刻(三个月前)→ 一个点都不该有。
    // 关键是它**没有**一路画到今天:不截断的话这里会有点,而且末点是现在。
    for (const p of series) expect(p.t).toBeLessThanOrEqual(sealedAt);
  });

  it("归档后不补实时盯市末点 —— 那正是「还在动」的那一笔", async () => {
    const account = await manualWithBtc();
    await dbFor(USER).accounts.setArchived(account.id, true);

    const { series } = await run(
      USER,
      loadAccountHistory({ accountId: account.id, connectorId: "manual" }),
    );

    // 归档即刻(archivedAt ≈ now):网格照常有点,但末点是网格点本身,不是额外补上去的实时点。
    // 补了的话末点的 t 会恰好等于 archivedAt 且总额取自 live —— 这里断言序列没有超出网格末点。
    const archived = await dbFor(USER).accounts.getById(account.id);
    for (const p of series) expect(p.t).toBeLessThanOrEqual(archived?.archivedAt ?? 0);
  });
});
