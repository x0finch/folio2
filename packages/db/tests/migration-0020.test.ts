import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/client";
import { tokenIndex, tokens, tokenVendorIds } from "../src/schema";

// 迁移 0020 回填部分的聚焦证明(镜像 SQL)。
// 标准 applyD1Migrations 把 0020 应用到【空】tokens → 回填 INSERT…SELECT 无行可迁,证明不了正确性;
// 且 0020 掉了 tokens.source/identifier 列,无法经现表种子老形态。故:插两条真 tokens 行(满足
// token_vendor_ids.token_id 外键),用 scratch 表持 pre-0020 的 (id, source, identifier),跑与
// 0020_foamy_colonel_america.sql 同款的过滤 INSERT(仅把来源表从 tokens 换成 scratch),断言:
// 只回填 coingecko 行、provider 孤儿排除、列映射正确(id→token_id / source→vendor / identifier→vendor_id)。

beforeEach(async () => {
  const db = getDb(env);
  await db.batch([db.delete(tokenIndex), db.delete(tokenVendorIds), db.delete(tokens)]);
});

describe("migration 0020 — token_vendor_ids 回填(去 vendor tag)", () => {
  it("coingecko 行回填成 vendor 映射;provider 孤儿排除;列映射正确", async () => {
    const db = getDb(env);
    // 真 tokens 行(现 schema,无 source/identifier)—— 满足回填的外键。
    await db.insert(tokens).values([
      { id: "cgk-row", symbol: "BTC", name: "Bitcoin", infoExpiresAt: 9_000_000_000_000 },
      { id: "orphan-row", symbol: "ORP", name: "Orphan", infoExpiresAt: 9_000_000_000_000 },
    ]);
    // pre-0020 形态的 (id, source, identifier)。
    await env.DB.prepare("DROP TABLE IF EXISTS _pre0020").run();
    await env.DB.prepare("CREATE TABLE _pre0020 (id TEXT, source TEXT, identifier TEXT)").run();
    await env.DB.prepare("INSERT INTO _pre0020 (id, source, identifier) VALUES (?,?,?),(?,?,?)")
      .bind("cgk-row", "coingecko", "bitcoin", "orphan-row", "provider", "eip155:1/erc20:0xorphan")
      .run();
    // 与 0020 回填语句同款(来源表 tokens → scratch)。
    await env.DB.prepare(
      "INSERT INTO token_vendor_ids (token_id, vendor, vendor_id) SELECT id, source, identifier FROM _pre0020 WHERE source = 'coingecko'",
    ).run();
    await env.DB.prepare("DROP TABLE IF EXISTS _pre0020").run();

    const maps = await db.select().from(tokenVendorIds);
    expect(maps).toHaveLength(1);
    expect(maps[0]).toMatchObject({ tokenId: "cgk-row", vendor: "coingecko", vendorId: "bitcoin" });
  });
});
