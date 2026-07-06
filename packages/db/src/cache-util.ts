import { inArray } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { getDb } from "./client";

// 全局参考缓存 store(token/platform/fx)共用的 D1 原语。三个 store 都是薄 adapter:
// 声明自己的表 + 行形状,分块点查 / 批量 upsert 的机制集中在这里一处。

type Db = ReturnType<typeof getDb>;
type Stmt = Parameters<Db["batch"]>[0][number]; // drizzle BatchItem

// D1 ~100 绑定参数上限 → inArray 列表分块。
export const IN_CHUNK = 90;
export function chunk<T>(arr: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// 按主键列分块 inArray 点查(自动去重),返回原始行。调用方负责把行映射成领域形状。
export async function selectByKeys<R>(
  db: Db,
  table: SQLiteTable,
  keyCol: AnySQLiteColumn,
  keys: readonly string[],
): Promise<R[]> {
  const out: R[] = [];
  for (const part of chunk([...new Set(keys)])) {
    if (part.length === 0) continue;
    const rows = (await db.select().from(table).where(inArray(keyCol, part))) as R[];
    out.push(...rows);
  }
  return out;
}

// drizzle 的 batch 要求非空 [Stmt, ...Stmt[]];空 → no-op。
export async function batchWrite(db: Db, stmts: Stmt[]): Promise<void> {
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
}
