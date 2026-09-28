import type { RemoteStatement } from "@folio/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createD1HttpSql,
  D1_API_BASE,
  MAX_BOUND_PARAMS,
  MAX_REQUEST_BYTES,
} from "../scripts/ref-index/d1-http";

// D1 REST 传输(FOL-85):请求长什么样、批怎么发、错误怎么报、token 绝不出现在错误里。
// 真 Cloudflare 一次都不碰 —— fetch 是 mock 的。

const TOKEN = "cf-secret-token-do-not-print";
const CFG = { accountId: "acc-1", databaseId: "db-1", token: TOKEN };
const URL_RAW = `${D1_API_BASE}/accounts/acc-1/d1/database/db-1/raw`;

const select = (params: unknown[] = ["coingecko"]): RemoteStatement => ({
  sql: "select chain_ref from global_token_ref_index where upstream = ?",
  params,
  method: "all",
});
const write = (i: number): RemoteStatement => ({
  sql: "insert into t values (?, ?)",
  params: [i, `v${i}`],
  method: "run",
});

const ok = (result: unknown[]) => Response.json({ success: true, errors: [], result });
const rows = (r: unknown[][]) => ({ results: { columns: ["chain_ref"], rows: r }, success: true });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body));

describe("createD1HttpSql", () => {
  it("单条:POST /raw,Bearer token,{ sql, params } → 行是值数组", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok([rows([["evm:1/contract:0xa"], ["evm:1/contract:0xb"]])]));
    const out = await createD1HttpSql(CFG).query(select());
    expect(out).toEqual([["evm:1/contract:0xa"], ["evm:1/contract:0xb"]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(URL_RAW);
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    });
    expect(bodyOf(fetch.mock.calls[0])).toEqual({ sql: select().sql, params: ["coingecko"] });
  });

  it("一批 = 一次请求,{ batch: [...] },结果与语句一一对应", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(ok([rows([]), rows([]), rows([])]));
    const out = await createD1HttpSql(CFG).batch([write(1), write(2), write(3)]);
    expect(out).toEqual([[], [], []]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bodyOf(fetch.mock.calls[0])).toEqual({
      batch: [1, 2, 3].map((i) => ({ sql: write(i).sql, params: [i, `v${i}`] })),
    });
  });

  it("空批不发请求", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    expect(await createD1HttpSql(CFG).batch([])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it(`一条语句绑定超过 ${MAX_BOUND_PARAMS} 个参数 → 本地就拒,一发都不出`, async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const big = select(Array.from({ length: MAX_BOUND_PARAMS + 1 }, (_, i) => i));
    await expect(createD1HttpSql(CFG).query(big)).rejects.toThrow(/binds 101 params/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("请求体超过上限 → 本地就拒", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const huge = "x".repeat(MAX_REQUEST_BYTES);
    await expect(
      createD1HttpSql(CFG).batch([write(1), { ...write(2), params: [huge] }]),
    ).rejects.toThrow(/request body is \d+ bytes/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("4xx → 不重试,报 Cloudflare 的 errors[];token 不在消息里", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          { success: false, errors: [{ code: 7003, message: "Could not route" }], result: [] },
          { status: 400 },
        ),
      );
    const err = await createD1HttpSql(CFG)
      .query(select())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("D1 API 400: 7003 Could not route");
    expect(String((err as Error).stack)).not.toContain(TOKEN);
    expect(JSON.stringify(err)).not.toContain(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("200 但 success:false(SQL 错)→ 同样报错", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ success: false, errors: [{ code: 7500, message: "SQLITE_ERROR" }] }),
    );
    await expect(createD1HttpSql(CFG).query(select())).rejects.toThrow(
      "D1 API 200: 7500 SQLITE_ERROR",
    );
  });

  it("429 / 5xx / 网络断 → 退避重发,成功就返回", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("busy", { status: 429 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(ok([rows([["a"]])]));
    const pending = createD1HttpSql(CFG).query(select());
    await vi.runAllTimersAsync();
    expect(await pending).toEqual([["a"]]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("一直 5xx → 试满次数后报最后那次", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("down", { status: 503 }));
    const pending = createD1HttpSql(CFG)
      .query(select())
      .catch((e: unknown) => e);
    await vi.runAllTimersAsync();
    const err = (await pending) as Error;
    expect(err.message).toMatch(/^D1 API 503/);
    expect(err.message).not.toContain(TOKEN);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("结果条数与语句对不上 → 报错(不把错位的行交给上层)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(ok([rows([])]));
    await expect(createD1HttpSql(CFG).batch([write(1), write(2)])).rejects.toThrow(
      /1 result\(s\) for 2 statement\(s\)/,
    );
  });
});
