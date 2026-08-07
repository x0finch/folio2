import type { Drizzle } from "../connect";

// D1 没有交互式事务 → 原子多写只能走 `db.batch([...])`,而 drizzle 的 batch 要求非空
// `[Stmt, ...Stmt[]]`。这个包装把「空列表 = no-op」这件事收在一处,免得每个调用点各写一遍。
//
// 只有 `queries/` 这半在用(3 处)。Effect 那半的同一件事在 `Database.batch` 里(见 stores/service.ts)。
type Stmt = Parameters<Drizzle["batch"]>[0][number]; // drizzle BatchItem

export async function batchWrite(db: Drizzle, stmts: Stmt[]): Promise<void> {
  const [first, ...rest] = stmts;
  if (first) await db.batch([first, ...rest]);
}
