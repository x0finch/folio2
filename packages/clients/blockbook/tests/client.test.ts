import { afterEach, describe, expect, it, vi } from "vitest";
import { BlockbookError, createBlockbookClient } from "../src";

const XPUB =
  "zpub6qKdREgeGCnyv5NuoGtRUsQRnBKQKWqYHeRUcdSJHPGAmEBaYJLCxxTN99gU7wusPH29ugJqB9vAw6Wganr2J2t4tbLd5n9HvLwCi5eZJnt";
const XPUB_BODY = {
  address: XPUB,
  balance: "1474326296",
  unconfirmedBalance: "0",
  unconfirmedTxs: 0,
  txs: 40,
  usedTokens: 1,
  tokens: [{ name: "bc1q597", path: "m/84'/0'/0'/0/0", transfers: 2, balance: "1000" }],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => vi.restoreAllMocks());

describe("createBlockbookClient.getXpub", () => {
  it("打 /xpub 带 details=tokenBalances&tokens=used,返回解析后的余额 + tokens", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(XPUB_BODY));
    const res = await createBlockbookClient().getXpub(XPUB);
    expect(res.balance).toBe("1474326296");
    expect(res.tokens?.[0].path).toBe("m/84'/0'/0'/0/0");
    const url = String(spy.mock.calls[0][0]);
    expect(url).toContain("/xpub/");
    expect(url).toContain("details=tokenBalances");
    expect(url).toContain("tokens=used");
  });

  it("descriptor(含括号)正确 URL 编码", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(XPUB_BODY));
    await createBlockbookClient().getXpub("tr(xpub123)");
    expect(String(spy.mock.calls[0][0])).toContain("tr%28xpub123%29");
  });
});

describe("多端点轮询 + 回退", () => {
  it("首个端点 429 → 自动回退下一个端点成功(不依赖轮询起点)", async () => {
    const bases = ["https://a.test/api/v2", "https://b.test/api/v2"];
    let calls = 0;
    // 第一次尝试(无论轮询到哪个端点)429,之后成功 → 回退必被触发,calls 恒 2。
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return calls === 1 ? new Response("", { status: 429 }) : json(XPUB_BODY);
    });
    const res = await createBlockbookClient({ bases }).getXpub(XPUB);
    expect(res.balance).toBe("1474326296");
    expect(calls).toBe(2);
  });

  it("所有端点故障 → 抛 BlockbookError", async () => {
    const bases = ["https://a.test/api/v2", "https://b.test/api/v2"];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 500 }));
    await expect(createBlockbookClient({ bases }).getXpub(XPUB)).rejects.toBeInstanceOf(
      BlockbookError,
    );
  });

  it("不可重试(400 无效 xpub)→ 立抛,不试其它端点", async () => {
    const bases = ["https://a.test/api/v2", "https://b.test/api/v2"];
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls++;
      return new Response("", { status: 400 });
    });
    await expect(createBlockbookClient({ bases }).getXpub("garbage")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(calls).toBe(1); // 未回退
  });
});
