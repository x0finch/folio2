import { splitTokenRef } from "@folio/oracle-ref";
import type { GlobalTokenRefIndexStore, TokenRef, TokenRefIndexRow } from "@folio/oracle2-basic";
import { and, eq, inArray, max } from "drizzle-orm";
import { batchWrite, chunk } from "./cache-util";
import { type DbEnv, getDb } from "./client";
import { globalTokenRefIndex } from "./schema";

// `GlobalTokenRefIndexStore` 的 D1 实现(ADR 0022,#199)。
//
// **这是全仓唯一没有 userId 的数据访问**(另一处是历史日价表,同一类理由):表里一条用户数据
// 都没有 —— 全是上游的公开知识、可整表重建、删空只是下一轮慢一点。CLAUDE.md 原则 #6 的受控例外。
//
// cron 一天一次整份灌(几万行 → 必须分批);sync 只正查、零网络。

// 每行 4 个绑定参数(ref / namer / local_name / updated_at)→ 一条 batch 里 20 行 = 80 个,
// 稳在 D1 ~100 参数上限内。整份四万行 ≈ 2000 批,cron 里跑得完。
const PUT_ROW_CHUNK = 20;

// 不收 `now`(另外三个 store 都收):本 store 没有一处需要「现在几点」——
// `putAll` 的时刻由调用方给(契约如此,cron 记的是那一轮的时刻),读侧无 TTL 门控。
export function createGlobalTokenRefIndexStore(env: DbEnv): GlobalTokenRefIndexStore {
  const db = getDb(env);

  return {
    // 正查一批:某个命名者对这些链上 ref 的叫法。miss 的键不出现。
    async lookup(namer, refs) {
      const out = new Map<TokenRef, string>();
      if (refs.length === 0) return out;
      // 表里存的是规范形(灌表时经文法构造),查之前把入参也归一一遍 ——
      // 否则同一个地址大小写不同就查不到。读不懂的串不进表,直接跳过。
      const canonical = new Map<TokenRef, TokenRef>(); // 规范形 → 调用方原样给的串
      for (const raw of new Set(refs)) {
        const parts = splitTokenRef(raw);
        if (parts) canonical.set(`${parts.namer}/${parts.localName}`, raw);
      }
      if (canonical.size === 0) return out;

      for (const part of chunk([...canonical.keys()])) {
        if (part.length === 0) continue;
        const rows = await db
          .select({ ref: globalTokenRefIndex.ref, localName: globalTokenRefIndex.localName })
          .from(globalTokenRefIndex)
          .where(and(eq(globalTokenRefIndex.namer, namer), inArray(globalTokenRefIndex.ref, part)));
        // 用调用方原样给的串作键回填 —— 它拿这个键去 .get(),不该被我们的归一改掉。
        for (const r of rows) {
          const key = canonical.get(r.ref);
          if (key !== undefined) out.set(key, r.localName);
        }
      }
      return out;
    },

    // 整份刷新。**不删行**:下架币的旧映射留着无害,`updated_at` 用来看哪些行这轮没被刷到。
    async putAll(rows: readonly TokenRefIndexRow[], updatedAt) {
      for (const part of chunk(rows, PUT_ROW_CHUNK)) {
        if (part.length === 0) continue;
        await batchWrite(
          db,
          part.map((r) =>
            db
              .insert(globalTokenRefIndex)
              .values({
                ref: r.ref,
                namer: r.namer,
                localName: r.localName,
                updatedAt,
              })
              .onConflictDoUpdate({
                target: [globalTokenRefIndex.ref, globalTokenRefIndex.namer],
                set: { localName: r.localName, updatedAt },
              }),
          ),
        );
      }
    },

    // 某个命名者最近一次成功刷新的时刻。从未刷过 → null(首次部署要手动触发一次)。
    // 取该命名者所有行里最大的 updated_at —— 不另存一个标记行,少一处可能与真实数据不一致的状态。
    async refreshedAt(namer) {
      const rows = await db
        .select({ latest: max(globalTokenRefIndex.updatedAt) })
        .from(globalTokenRefIndex)
        .where(eq(globalTokenRefIndex.namer, namer));
      return rows[0]?.latest ?? null;
    },
  };
}
