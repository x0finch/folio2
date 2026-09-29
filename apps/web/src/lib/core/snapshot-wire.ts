import { Note } from "@folio/connectors-basic";
import type { BalanceRawRow, SnapshotRawRow } from "@folio/db";
import type { AccountSnapshotEntry, BalanceView } from "./portfolio";

// 快照原料的**线上形状**(FOL-92):`getSnapshots` 发的是 D1 回来的原样行(位置元组,note / meta 是
// 未解析的 JSON 字符串),**解析与校验在浏览器这边做** —— 服务端每请求一次只有 10ms CPU,逐行
// `JSON.parse` + zod `safeParse` + 拼对象都不该花在那儿。浏览器解一次,之后全部消费方(总览、账户页、
// 同步胶囊)拿到的还是原来那个 `AccountSnapshotEntry[]`,界面一处不变。
export interface SnapshotsWire {
  snapshots: SnapshotRawRow[];
  balances: BalanceRawRow[];
}

// 账户快照的 note 列(JSON 字符串)→ account 级 Note[]。空 / 损坏 / 形状不对 → undefined
// (与以前服务端 `parseAccountNote` 同口径:一段坏 note 不该让整页打不开)。
function parseAccountNote(raw: string | null): Note[] | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.array().safeParse(JSON.parse(raw));
    return r.success && r.data.length > 0 ? r.data : undefined;
  } catch {
    return undefined;
  }
}

/** 线上原料 → 每账户一张快照(顺序与服务端发来的快照行一致)。 */
export function snapshotsFromWire(wire: SnapshotsWire): AccountSnapshotEntry[] {
  const byAccount = new Map<string, BalanceView[]>();
  for (const [
    accountId,
    id,
    amount,
    usdValue,
    kind,
    selfPrice,
    platform,
    tokenId,
    metaJson,
  ] of wire.balances) {
    const view: BalanceView = {
      id,
      amount,
      usdValue,
      kind,
      selfPrice,
      platform,
      tokenId,
      metaJson,
    };
    const arr = byAccount.get(accountId);
    if (arr) arr.push(view);
    else byAccount.set(accountId, [view]);
  }
  return wire.snapshots.map(([accountId, takenAt, totalUsd, note]) => ({
    accountId,
    takenAt,
    totalUsd,
    note: parseAccountNote(note),
    balances: byAccount.get(accountId) ?? [],
  }));
}
