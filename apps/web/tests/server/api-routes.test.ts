import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Enqueued } from "@/lib/server/jobs/queue";
import { Route as ExportRoute } from "@/routes/api/export";
import { Route as ImportRoute } from "@/routes/api/import";
import { Route as SyncRoute } from "@/routes/api/sync";
import { db } from "./_kit/db";
import { appRequest, type SignedIn, signUp } from "./_kit/session";

// `/api/export`、`/api/import`、`/api/sync` 三个**路由 handler**(不是 server fn)的 HTTP 契约:
//   · 没登录 → 401,且什么都不做;
//   · 认人只认会话 cookie(真 better-auth 会话,见 `_kit/session.ts`),数据按那个人隔离;
//   · 导入的三种下场映射成 200 / 400 / 500,导出的文件能原样导进另一个人的空库;
//   · 同步开轮、把活投给运行器、回这一轮此刻的样子;重复 POST 不叠第二轮。
// 运行器那个 Durable Object 在测试 Worker 里没有绑定 —— 换成一个把投来的活收进数组的假绑定
// (它是这个 Worker 的出口,与假 fetch 同一个位置)。

type Handler = (ctx: { request: Request }) => Promise<Response>;
const handler = (route: unknown, method: "GET" | "POST"): Handler =>
  (route as { options: { server: { handlers: Record<string, Handler> } } }).options.server.handlers[
    method
  ] as Handler;

const exportGet = handler(ExportRoute, "GET");
const importPost = handler(ImportRoute, "POST");
const syncPost = handler(SyncRoute, "POST");

// —— 假运行器绑定 ——
let sent: Enqueued[] = [];
const runnerEnv = env as unknown as { JOB_RUNNER?: unknown };
beforeEach(() => {
  sent = [];
  runnerEnv.JOB_RUNNER = {
    idFromName: (name: string) => name,
    get: () => ({
      enqueue: async (batch: Enqueued[]) => void sent.push(...batch),
      poke: async () => {},
    }),
  };
});
afterEach(() => {
  delete runnerEnv.JOB_RUNNER;
});

const ndjson = (records: unknown[]) => records.map((r) => `${JSON.stringify(r)}\n`).join("");

/** 把文本切成小块喂进流 —— 行跨块、最后一行不带换行,都是真上传会遇到的形状。 */
const chunkedBody = (text: string, size = 7): ReadableStream<Uint8Array> => {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + size));
      at += size;
    },
  });
};

const exportOf = async (who: SignedIn): Promise<string> => {
  const res = await exportGet({ request: appRequest("/api/export", {}, who) });
  return new TextDecoder().decode(await res.arrayBuffer());
};

let alice: SignedIn;
let bob: SignedIn;
beforeEach(async () => {
  alice = await signUp("api-routes-alice@example.test");
  bob = await signUp("api-routes-bob@example.test");
});

describe("没登录", () => {
  it("三个端点都回 401,不碰任何人的数据", async () => {
    await db(alice.userId).accounts.create({ connectorId: "manual", label: "A", creds: null });
    const body = ndjson([{ type: "meta", version: 3 }]);

    const res = await Promise.all([
      exportGet({ request: appRequest("/api/export") }),
      importPost({ request: appRequest("/api/import", { method: "POST", body }) }),
      syncPost({ request: appRequest("/api/sync", { method: "POST", body: "{}" }) }),
    ]);

    expect(res.map((r) => r.status)).toEqual([401, 401, 401]);
    expect(sent).toEqual([]);
  });

  it("伪造的 cookie 不算登录", async () => {
    const forged = { userId: alice.userId, cookie: "better-auth.session_token=forged.sig" };
    const res = await exportGet({ request: appRequest("/api/export", {}, forged) });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/export", () => {
  it("回一份 NDJSON 附件,只含本人的账户", async () => {
    await db(alice.userId).accounts.create({
      connectorId: "manual",
      label: "Alice Cash",
      creds: null,
    });
    await db(bob.userId).accounts.create({ connectorId: "manual", label: "Bob Cash", creds: null });

    const res = await exportGet({ request: appRequest("/api/export", {}, alice) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const lines = new TextDecoder()
      .decode(await res.arrayBuffer())
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; label?: string });
    expect(lines[0]?.type).toBe("meta");
    expect(lines.filter((l) => l.type === "account").map((l) => l.label)).toEqual(["Alice Cash"]);
  });
});

describe("POST /api/import", () => {
  it("别人导出的文件能导进我的空库:回计数、行落在我名下、原主不受影响", async () => {
    await db(alice.userId).accounts.create({ connectorId: "manual", label: "Cash", creds: null });
    await db(alice.userId).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });
    const file = await exportOf(alice);

    const res = await importPost({
      request: appRequest(
        "/api/import",
        // 去掉末尾换行:最后一行只能靠流读完后的那一次解析收进来。
        { method: "POST", body: chunkedBody(file.trimEnd()) },
        bob,
      ),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      imported: { tokens: 0, accounts: 2, snapshots: 0, activities: 0 },
    });
    const mine = await db(bob.userId).accounts.list();
    expect(mine.map((a) => a.label).sort()).toEqual(["Cash", "Wallet"]);
    // 公开字段(地址)按真字段规格原样带过来 —— 钱包导进来就能同步,不用补录。
    const wallet = mine.find((a) => a.label === "Wallet");
    expect(
      JSON.parse((await db(bob.userId).accounts.getRawCreds(wallet?.id ?? "")) ?? "{}"),
    ).toEqual({ address: "0xabc" });
    expect((await db(alice.userId).accounts.list()).map((a) => a.label).sort()).toEqual([
      "Cash",
      "Wallet",
    ]);
  });

  it("文件头不对 → 400 带上原因,一行都不写", async () => {
    const body = ndjson([{ type: "account", id: "a1", connectorId: "manual", label: "X" }]);
    const res = await importPost({
      request: appRequest("/api/import", { method: "POST", body }, bob),
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("missing meta header");
    expect(await db(bob.userId).accounts.list()).toEqual([]);
  });

  it("版本不对 → 400", async () => {
    const res = await importPost({
      request: appRequest(
        "/api/import",
        { method: "POST", body: ndjson([{ type: "meta", version: 999 }]) },
        bob,
      ),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unsupported export version");
  });

  it("写库那一步炸了(坏快照)→ 500,不把内部错误回给客户端", async () => {
    const file = await exportOf(alice);
    const meta = file.split("\n")[0];
    const body = [
      meta,
      JSON.stringify({ type: "account", id: "a1", connectorId: "manual", label: "M" }),
      JSON.stringify({
        type: "snapshot",
        accountId: "a1",
        takenAt: "not-a-time",
        totalUsd: 1,
        balances: [],
      }),
    ].join("\n");

    const res = await importPost({
      request: appRequest("/api/import", { method: "POST", body }, bob),
    });

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("import failed");
  });

  it("没有请求体 → 400", async () => {
    const res = await importPost({
      request: appRequest("/api/import", { method: "POST" }, bob),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/sync", () => {
  const seedWallet = (who: SignedIn) =>
    db(who.userId).accounts.create({
      connectorId: "evm",
      platform: "evm:1",
      label: "Wallet",
      creds: JSON.stringify({ address: "0xabc" }),
    });

  it("开一轮:回这一轮此刻的样子(不可缓存),本人的账户各投一条同步活", async () => {
    const wallet = await seedWallet(alice);
    await seedWallet(bob);

    // 坏 JSON 当默认(默认组合、手动全量),不 400。
    const res = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{not json" }, alice),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const view = (await res.json()) as {
      state: string;
      total: number;
      statuses: Record<string, string>;
    };
    expect(view.state).toBe("running");
    expect(view.statuses).toEqual({ [wallet.id]: "pending" });
    const syncJobs = sent.filter((m) => m.job.kind === "sync-account");
    expect(syncJobs).toHaveLength(1);
    expect(syncJobs[0]?.job).toMatchObject({ userId: alice.userId, accountId: wallet.id });
  });

  it("轮还在跑时再点一次 → 原样回那一轮,不叠第二拨活", async () => {
    await seedWallet(alice);
    const first = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{}" }, alice),
    });
    const before = sent.length;

    const second = await syncPost({
      request: appRequest("/api/sync", { method: "POST", body: "{}" }, alice),
    });

    expect(second.status).toBe(200);
    const [a, b] = (await Promise.all([first.json(), second.json()])) as { roundId: string }[];
    expect(b?.roundId).toBe(a?.roundId);
    expect(sent.length).toBe(before);
  });
});
