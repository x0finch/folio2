import { describe, expect, it } from "vitest";
import { tokenTicket } from "../src";

// 票 = tokenRef 交给浏览器时的不透明形。往返 + 「从网络上来的东西不能信」两件事。

const REFS = [
  "coingecko/usd-coin",
  "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  "bitcoin/native",
  "binance/BTC",
  "manual/MY-PRIVATE-TOKEN",
];

describe("往返", () => {
  it.each(REFS)("%s 编回来还是自己", (ref) => {
    expect(tokenTicket.decode(tokenTicket.encode(ref))).toBe(ref);
  });

  it("编出来的串能直接进 URL —— 没有 + / = 这三个要转义的字符", () => {
    for (const ref of REFS) {
      expect(tokenTicket.encode(ref)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("非 ASCII 的 symbol 也往返得回来(TextEncoder,不是 charCode)", () => {
    const ref = "manual/比特币";
    expect(tokenTicket.decode(tokenTicket.encode(ref))).toBe(ref);
  });

  it("不同 ref 编出不同的票 —— 前端拿它当 key / 判同一个币", () => {
    expect(new Set(REFS.map(tokenTicket.encode)).size).toBe(REFS.length);
  });
});

describe("解不开的一律 undefined —— 票是从网络上来的", () => {
  it("空串 / base64url 之外的字符", () => {
    expect(tokenTicket.decode("")).toBeUndefined();
    expect(tokenTicket.decode("!!!not-base64!!!")).toBeUndefined();
    expect(tokenTicket.decode("has spaces")).toBeUndefined();
    expect(tokenTicket.decode("a+b/c=")).toBeUndefined(); // 裸 base64 的三个字符不收
  });

  it("解得开、但里头不是一条合规 ref", () => {
    // 一段 → 没有命名者;三段 → 文法只认两段。
    expect(tokenTicket.decode(tokenTicket.encode("bitcoin"))).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode("a/b/c"))).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode(""))).toBeUndefined();
  });
});
