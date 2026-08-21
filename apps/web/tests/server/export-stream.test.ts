import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { exportStream } from "../../src/lib/server/io/export-stream";
import { runAtEdge, withRequest } from "../../src/lib/server/internal/oracle";

// 导出那条流的**分页边界**(#394 T7)。
//
// 为什么单独有这个文件:`export-import-roundtrip.test.ts` 测的是「导出的内容能原样导回去」,
// 而它**手写复刻**了一份导出逻辑(`exportRecords`),从来没跑过路由里那条真的流。于是
// `Stream.paginateEffect` 这一段 —— 整份导出里唯一一处会「多取一页 / 漏一页 / 重复一页」的
// 地方 —— 零覆盖。review 时只能靠在旁边照着语义重跑一遍来确认它对,那正是该有测试的信号。
//
// 三个数就够钉住它:0(空库)、恰好一页(50,取完还要再问一次才知道没了)、一页多一条(51)。
// 走**生产那条装配**(`withRequest` → `runAtEdge`),不是自己拼 layer。

const USER = "user-export-stream";
const SNAPSHOT_PAGE = 50; // 与 routes/api/export.ts 同一个常量(那边不导出,这里照抄一份钉住)

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

// 直接塞行,绕开 writeSnapshot —— 这里要的是「有 N 行快照」,不是写路径的语义。
async function seedSnapshots(count: number): Promise<void> {
  if (count === 0) return;
  await env.DB.prepare(
    "INSERT INTO accounts (id, user_id, connector_id, label, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind("acc-export", USER, "evm", "W", Date.now())
    .run();
  await env.DB.batch(
    Array.from({ length: count }, (_, i) =>
      env.DB.prepare(
        "INSERT INTO snapshots (id, account_id, taken_at, total_usd) VALUES (?, ?, ?, ?)",
      ).bind(`snap-${i}`, "acc-export", 1_700_000_000_000 + i, i),
    ),
  );
}

async function exportLines(): Promise<Record<string, unknown>[]> {
  const body = await runAtEdge(withRequest(USER, exportStream()));
  const text = await new Response(body).text();
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeEach(resetUser);

describe("导出流的分页边界", () => {
  it("空库 —— 只有 meta 一行,不会因为「第一页是空的」就抛或者卡住", async () => {
    const lines = await exportLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].type).toBe("meta");
  });

  it("恰好一页 —— 50 条不多不少(这一档要多问一次上游才知道没了)", async () => {
    await seedSnapshots(SNAPSHOT_PAGE);
    const snaps = (await exportLines()).filter((l) => l.type === "snapshot");
    expect(snaps).toHaveLength(SNAPSHOT_PAGE);
    // 不重复:每条快照恰好出现一次。分页写错最典型的症状就是边界那一条来两遍。
    // 按 `takenAt` 认 —— 导出行不带 id(导入侧要重映射,见 lib/export.ts 的 snapshotRecord)。
    expect(new Set(snaps.map((s) => s.takenAt)).size).toBe(SNAPSHOT_PAGE);
  });

  it("一页多一条 —— 51 条全在,末页短页不丢", async () => {
    await seedSnapshots(SNAPSHOT_PAGE + 1);
    const snaps = (await exportLines()).filter((l) => l.type === "snapshot");
    expect(snaps).toHaveLength(SNAPSHOT_PAGE + 1);
    expect(new Set(snaps.map((s) => s.takenAt)).size).toBe(SNAPSHOT_PAGE + 1);
  });

  // 顺序是**格式契约**:导入是单遍的,token 行必须排在引用它的 snapshot / activity 之前
  // (见 lib/import.ts 的 tokenMap)。`Stream.concat` 把这条顺序写进了类型之外的地方,
  // 所以钉一条。
  it("段落顺序:meta 在最前,账户排在快照之前", async () => {
    await seedSnapshots(2);
    const kinds = (await exportLines()).map((l) => l.type);
    expect(kinds[0]).toBe("meta");
    expect(kinds.indexOf("account")).toBeLessThan(kinds.indexOf("snapshot"));
  });
});
