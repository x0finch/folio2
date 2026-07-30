import type { getDb } from "./client";

// 各 store 共用的 D1 原语:分块(D1 的绑定参数上限)与批量写。
// 原来还有一个 `selectByKeys`(按主键列分块 inArray 点查),只有 platform / fx 两个全局缓存
// store 在用 —— 它们随 #202b 搬进 oracle 的 per-user KV 之后就没有调用方了,一并删。

type Db = ReturnType<typeof getDb>;
type Stmt = Parameters<Db["batch"]>[0][number]; // drizzle BatchItem

// D1 ~100 绑定参数上限 → inArray 列表分块。
const IN_CHUNK = 90;
export function chunk<T>(arr: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// drizzle 的 batch 要求非空 [Stmt, ...Stmt[]];空 → no-op。
export async function batchWrite(db: Db, stmts: Stmt[]): Promise<void> {
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
}
