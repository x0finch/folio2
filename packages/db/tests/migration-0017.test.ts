import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { user } from "../src/auth-schema";
import { getDb } from "../src/client";

// 迁移 0017 DATA 部分的聚焦证明。
// 标准 applyD1Migrations 把全部迁移应用到【空】accounts 表 → 0017 的 UPDATE 无行可迁,证明不了正确性。
// 故本测试:先按【pre-0017 老形态】种子数据(列已是 rename 后的 connector_id,但持【旧值】+ 老 creds 键),
// 再手工执行 0017 的 DATA 语句(值迁移 + creds-key 迁移,与迁移文件同序同 SQL),断言变换结果。
// 只验 DATA DML;RENAME COLUMN 已由 setup 的 applyD1Migrations 落地(schema 列即 connector_id)。

const USER = "mig-user";

// 与 drizzle/0017_flowery_meteorite.sql 的 DATA 语句逐条对齐(去掉首条 RENAME COLUMN,列已改名)。
const VALUE_MIGRATIONS = [
  ["evm", "onchain_evm"],
  ["bitcoin", "onchain_bitcoin"],
  ["solana", "onchain_solana"],
  ["sui", "onchain_sui"],
  ["cosmos", "onchain_cosmos"],
  ["binance", "exchange_binance"],
  ["okx", "exchange_okx"],
  ["hyperliquid", "perp_hyperliquid"],
] as const;

// creds-key: identifier → address(链上非 bitcoin + perp),identifier → addressOrXpub(bitcoin)。值原样搬。
const CREDS_KEY_ADDRESS = `UPDATE accounts
  SET enc_credentials = json_set(json_remove(enc_credentials, '$.identifier'), '$.address', json_extract(enc_credentials, '$.identifier'))
  WHERE connector_id IN ('evm','solana','sui','cosmos','hyperliquid')
    AND json_extract(enc_credentials, '$.identifier') IS NOT NULL`;
const CREDS_KEY_ADDRESS_OR_XPUB = `UPDATE accounts
  SET enc_credentials = json_set(json_remove(enc_credentials, '$.identifier'), '$.addressOrXpub', json_extract(enc_credentials, '$.identifier'))
  WHERE connector_id = 'bitcoin'
    AND json_extract(enc_credentials, '$.identifier') IS NOT NULL`;

async function runDataMigration(): Promise<void> {
  // 值迁移(与文件同序:先值,后 creds-key)。
  for (const [to, from] of VALUE_MIGRATIONS) {
    await env.DB.prepare("UPDATE accounts SET connector_id = ? WHERE connector_id = ?")
      .bind(to, from)
      .run();
  }
  await env.DB.prepare(CREDS_KEY_ADDRESS).run();
  await env.DB.prepare(CREDS_KEY_ADDRESS_OR_XPUB).run();
}

// 用【旧形态】种子一行:connector_id 持旧值,enc_credentials 为老键 JSON(或 NULL)。
async function seed(id: string, connectorId: string, encCredentials: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, network, label, enc_credentials, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, USER, connectorId, null, id, encCredentials, 0, null)
    .run();
}

async function read(
  id: string,
): Promise<{ connectorId: string; creds: Record<string, string> | null }> {
  const row = await env.DB.prepare(
    "SELECT connector_id AS cid, enc_credentials AS creds FROM accounts WHERE id = ?",
  )
    .bind(id)
    .first<{ cid: string; creds: string | null }>();
  if (!row) throw new Error(`row not found: ${id}`);
  return { connectorId: row.cid, creds: row.creds ? JSON.parse(row.creds) : null };
}

beforeEach(async () => {
  const db = getDb(env);
  // 清 user(级联清 accounts),再插干净 user 行(满足 accounts.user_id 外键)。
  await db.delete(user).where(eq(user.id, USER));
  await db.insert(user).values({
    id: USER,
    name: USER,
    email: `${USER}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

describe("migration 0017 — account.type→connectorId value + creds-key migration", () => {
  it("migrates connector_id values and renames identifier→address/addressOrXpub, values verbatim", async () => {
    await seed(
      "evm-1",
      "onchain_evm",
      JSON.stringify({ identifier: "0xABCdef0000000000000000000000000000000001" }),
    );
    await seed("sol-1", "onchain_solana", JSON.stringify({ identifier: "SoLWalletAddr111" }));
    await seed(
      "btc-1",
      "onchain_bitcoin",
      JSON.stringify({ identifier: "bc1qexampleaddr", scriptType: "native" }),
    );
    await seed(
      "okx-1",
      "exchange_okx",
      JSON.stringify({ apiKey: "KEY123", secret: "ENC_SECRET", passphrase: "ENC_PASS" }),
    );
    await seed(
      "man-1",
      "manual",
      JSON.stringify({ symbol: "BTC", amount: "1.5", unitPrice: "50000", identifier: "bitcoin" }),
    );
    await seed("hl-1", "perp_hyperliquid", JSON.stringify({ identifier: "0xHLaddr" }));
    await seed("nul-1", "onchain_evm", null); // needs-credentials: enc_credentials NULL

    await runDataMigration();

    // 1) 值迁移:onchain_*/exchange_*/perp_* → 干净 connectorId;manual 不变。
    const evm = await read("evm-1");
    expect(evm.connectorId).toBe("evm");
    // identifier → address,值原样(未解密、未改动)。
    expect(evm.creds).toEqual({ address: "0xABCdef0000000000000000000000000000000001" });
    expect(evm.creds).not.toHaveProperty("identifier");

    const sol = await read("sol-1");
    expect(sol.connectorId).toBe("solana");
    expect(sol.creds).toEqual({ address: "SoLWalletAddr111" });

    // 2) bitcoin:identifier → addressOrXpub,scriptType 保留。
    const btc = await read("btc-1");
    expect(btc.connectorId).toBe("bitcoin");
    expect(btc.creds).toEqual({ addressOrXpub: "bc1qexampleaddr", scriptType: "native" });
    expect(btc.creds).not.toHaveProperty("identifier");

    // 3) CEX:值迁移到 okx,creds 完全不动(apiKey/secret/passphrase 原样,无 address)。
    const okx = await read("okx-1");
    expect(okx.connectorId).toBe("okx");
    expect(okx.creds).toEqual({ apiKey: "KEY123", secret: "ENC_SECRET", passphrase: "ENC_PASS" });

    // 4) manual:connector_id 不变;creds 不动 —— 其 identifier 是 CGK id(语义不同),保留不改名。
    const man = await read("man-1");
    expect(man.connectorId).toBe("manual");
    expect(man.creds).toEqual({
      symbol: "BTC",
      amount: "1.5",
      unitPrice: "50000",
      identifier: "bitcoin",
    });

    // 5) perp:hyperliquid,identifier → address。
    const hl = await read("hl-1");
    expect(hl.connectorId).toBe("hyperliquid");
    expect(hl.creds).toEqual({ address: "0xHLaddr" });

    // 6) NULL creds:值迁移仍生效(evm),creds-key UPDATE 的 IS NOT NULL 守卫 → 不报错、保持 NULL。
    const nul = await read("nul-1");
    expect(nul.connectorId).toBe("evm");
    expect(nul.creds).toBeNull();
  });
});
