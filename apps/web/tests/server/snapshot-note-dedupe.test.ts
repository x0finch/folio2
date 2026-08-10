import { env } from "cloudflare:test";
import type { Note } from "@folio/connectors-basic";
import { beforeEach, describe, expect, it } from "vitest";
import { dbFor } from "./db-effect";

// account 级 note 按内容去重(#456)。
//
// **为什么这条非真 D1 不可**:要验的是「库里到底存了几份」,而那正是从代码里看不出来的东西 ——
// 读路径把指针换回内容之后,调用方拿到的跟以前一模一样。换句话说这个改动**成功的样子就是没变化**,
// 只有去数行数才分得清「真去重了」和「白改一场」。
const USER = "user-note-dedupe";

const note = (title: string): Note[] => [{ title, content: [{ label: "derived", value: 42 }] }];

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM snapshot_notes").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
});

const account = async (label: string) => {
  const now = Date.now();
  const id = `acc-${label}`;
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, USER, "bitcoin", label, now)
    .run();
  return id;
};

const noteRows = async (): Promise<number> => {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM snapshot_notes").first<{ n: number }>();
  return r?.n ?? 0;
};

const write = (accountId: string, takenAt: number, n?: Note[]) =>
  dbFor(USER).snapshots.write(accountId, {
    takenAt,
    totalUsd: 100,
    balances: [],
    ...(n ? { note: n } : {}),
  });

describe("account 级 note 去重", () => {
  it("同一份内容写十次,库里只有一行", async () => {
    const acc = await account("a");
    for (let i = 0; i < 10; i++) await write(acc, 1000 + i, note("Unconfirmed"));

    expect(await noteRows()).toBe(1);
    // 十张快照都还在,只是都指向那一行
    expect(await dbFor(USER).snapshots.listByAccount(acc)).toHaveLength(10);
  });

  it("内容变了才多一行", async () => {
    const acc = await account("b");
    await write(acc, 1000, note("Unconfirmed"));
    await write(acc, 2000, note("Unconfirmed"));
    await write(acc, 3000, note("Receiving"));

    expect(await noteRows()).toBe(2);
  });

  it("没有 note 的快照不产生任何行", async () => {
    const acc = await account("c");
    await write(acc, 1000);
    await write(acc, 2000);

    expect(await noteRows()).toBe(0);
  });
});

describe("读路径拿到的还是内容,不是指针", () => {
  it("listByAccount:note 列是那段 JSON,调用方照常 parse", async () => {
    const acc = await account("d");
    await write(acc, 1000, note("Unconfirmed"));

    const [snap] = await dbFor(USER).snapshots.listByAccount(acc);
    expect(snap.note).toBeTruthy();
    expect(JSON.parse(snap.note as string)[0].title).toBe("Unconfirmed");
  });

  it("latest:account 级 note 解析回 Note[]", async () => {
    const acc = await account("e");
    await write(acc, 1000, note("Unconfirmed"));

    const [row] = await dbFor(USER).snapshots.latest();
    expect(row.note?.[0]?.title).toBe("Unconfirmed");
  });

  it("listPage(导出走这条):拿到的是内容 —— 导出文件里不该出现只有本库能解开的 hash", async () => {
    const acc = await account("f");
    await write(acc, 1000, note("Unconfirmed"));

    const [snap] = await dbFor(USER).snapshots.listPage(10, 0);
    expect(snap.note).toContain("Unconfirmed");
    expect(snap.note).not.toMatch(/^[0-9a-f]{64}$/); // 别把 hash 当内容导出去了
  });
});

describe("跨用户隔离", () => {
  it("同一份内容,两个用户各存各的 —— 主键带 user_id", async () => {
    const other = "user-note-dedupe-other";
    await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(other).run();
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(other, other, `${other}@example.com`, 0, now, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("acc-other", other, "bitcoin", "other", now)
      .run();

    const mine = await account("g");
    await write(mine, 1000, note("Unconfirmed"));
    await dbFor(other).snapshots.write("acc-other", {
      takenAt: 1000,
      totalUsd: 1,
      balances: [],
      note: note("Unconfirmed"),
    });

    // 同内容 → 同 hash,但 user_id 不同 → 两行。note 装的是这个用户的钱包细节,不跨用户共用。
    expect(await noteRows()).toBe(2);
    // 而且各自读得到
    const [mineSnap] = await dbFor(USER).snapshots.listByAccount(mine);
    expect(mineSnap.note).toContain("Unconfirmed");
  });
});

describe("省下来的空间在哪 —— 快照行本身不再带内容", () => {
  // **这一条才是这个改动的要害。** 只数去重表有几行是不够的:哪怕内容照旧被塞回每张快照,
  // 去重表也仍然只有一行,测试照样绿。省空间省在「快照那一列空了」,所以得直接去数它。
  //(A/B 时踩到过:把内容写回 `snapshots.note` 之后,上面那几条断言一条都没红。)
  const notedRows = async (): Promise<number> => {
    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM snapshots WHERE note IS NOT NULL",
    ).first<{ n: number }>();
    return r?.n ?? 0;
  };

  it("写十次,十张快照的 note 列都是空的 —— 内容只在去重表里那一份", async () => {
    const acc = await account("h");
    for (let i = 0; i < 10; i++) await write(acc, 1000 + i, note("Unconfirmed"));

    expect(await notedRows()).toBe(0);
    expect(await noteRows()).toBe(1);
  });

  it("每张快照都留着指针,不是把 note 丢了", async () => {
    const acc = await account("i");
    for (let i = 0; i < 3; i++) await write(acc, 1000 + i, note("Unconfirmed"));

    const r = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM snapshots WHERE note_hash IS NOT NULL AND account_id = ?",
    )
      .bind(acc)
      .first<{ n: number }>();
    expect(r?.n).toBe(3);
    // 而且读出来仍然是内容
    const rows = await dbFor(USER).snapshots.listByAccount(acc);
    expect(rows.every((s) => s.note?.includes("Unconfirmed"))).toBe(true);
  });
});
