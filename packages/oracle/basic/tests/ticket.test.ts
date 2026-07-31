import { describe, expect, it } from "vitest";
import { tokenTicket } from "../src";

// 票 = tokenRef 交给浏览器时的不透明形。往返 + 「从网络上来的东西不能信」两件事。
//
// 「不能信」有两层,别混:
//   ① 解不开 / 解出来不是一条合规 ref  → undefined(文法层面)
//   ② 解得开、是合规 ref,但**不是我们发的那位命名者** → undefined(信任层面)
// ② 是解票必须收 `namer` 的理由 —— 见 src/ticket.ts 那段注释。

const NAMER = "coingecko";

// 各自的命名者跟着 ref 走(往返与命名者无关,只要报对是谁发的)。
const REFS: [ref: string, namer: string][] = [
  ["coingecko/issued:usd-coin", "coingecko"],
  ["evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "evm:1"],
  ["bitcoin/native", "bitcoin"],
  ["binance/issued:BTC", "binance"],
  ["manual/custom:MY-PRIVATE-TOKEN", "manual"],
];

describe("往返", () => {
  it.each(REFS)("%s 编回来还是自己", (ref, namer) => {
    expect(tokenTicket.decode(tokenTicket.encode(ref), namer)).toBe(ref);
  });

  it("编出来的串能直接进 URL —— 没有 + / = 这三个要转义的字符", () => {
    for (const [ref] of REFS) {
      expect(tokenTicket.encode(ref)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("非 ASCII 的 symbol 也往返得回来(TextEncoder,不是 charCode)", () => {
    const ref = "manual/custom:比特币";
    expect(tokenTicket.decode(tokenTicket.encode(ref), "manual")).toBe(ref);
  });

  it("不同 ref 编出不同的票 —— 前端拿它当 key / 判同一个币", () => {
    expect(new Set(REFS.map(([ref]) => tokenTicket.encode(ref))).size).toBe(REFS.length);
  });

  // 解出来给的是**规范形**,不是原样回抛 —— 这条 ref 会被直接拿去 mint、落进 token_refs,
  // 而表里只能有规范形(否则同一个东西大小写不同就是两行)。
  it("非规范形的票 → 解出规范形", () => {
    expect(tokenTicket.decode(tokenTicket.encode("CoinGecko/ISSUED:usd-coin"), NAMER)).toBe(
      "coingecko/issued:usd-coin",
    );
    expect(tokenTicket.decode(tokenTicket.encode("manual/custom:usdc"), "manual")).toBe(
      "manual/custom:USDC",
    );
  });
});

describe("解不开的一律 undefined —— 票是从网络上来的", () => {
  it("空串 / base64url 之外的字符", () => {
    expect(tokenTicket.decode("", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("!!!not-base64!!!", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("has spaces", NAMER)).toBeUndefined();
    expect(tokenTicket.decode("a+b/c=", NAMER)).toBeUndefined(); // 裸 base64 的三个字符不收
  });

  it("解得开、但里头不是一条合规 ref", () => {
    // 一段 → 没有命名者;三段 → 文法只认两段。
    expect(tokenTicket.decode(tokenTicket.encode("bitcoin"), NAMER)).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode("a/b/c"), NAMER)).toBeUndefined();
    expect(tokenTicket.decode(tokenTicket.encode(""), NAMER)).toBeUndefined();
  });
});

// —— 命名者对不上就不收 ——
//
// 票没有签名(base64url 谁都能编),所以「这是我们发出去的那张」只能靠内容自证:
// 它的命名者必须就是当前那位。缺了这一句,任何人手编一张 `<随便什么>/issued:<随便什么>`
// 都能让 mint 把**用户手敲的 symbol** 重新当成可信线索 —— 那正是 #223 收紧掉的东西
// (`issued` 的含义是「命名者为它负责」,而没人核对过那个命名者我们认不认识)。
describe("命名者对不上 → 不收(#223:issued 是个声明,得验)", () => {
  it("别家的命名者 → undefined,而不是「解开了、随它去」", () => {
    const forged = tokenTicket.encode("evil/issued:whatever");
    expect(tokenTicket.decode(forged, NAMER)).toBeUndefined();
  });

  it("文法四形状一视同仁 —— 换个形状也不能绕过去", () => {
    for (const ref of [
      "evil/native",
      "evil/contract:0xdead",
      "evil/issued:x",
      "evil/custom:USDC",
    ]) {
      expect(tokenTicket.decode(tokenTicket.encode(ref), NAMER)).toBeUndefined();
    }
  });

  it("命名者比较按规范形(大小写 / 空白不影响)", () => {
    const t = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, "CoinGecko")).toBe("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, "  coingecko  ")).toBe("coingecko/issued:usd-coin");
  });

  it("换上游那天,旧票自动失效(而不是静默指向别家的 id)", () => {
    const old = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(old, "someother-source")).toBeUndefined();
  });
});

// —— 一组命名者:我们如今在不止一位命名者下发票(ADR 0025 / #272:上游发加密币、`fiat` 发法币)——
// 传一组 = 「命名者必须是其中之一」。这是法币端到端记账的**关键校验点**:mintHolding 用
// `[coingecko, fiat]` 解票,fiat 票必须能解回 `fiat/issued:<CODE>`,否则提交时掉回 custom、建不出法币行。
describe("一组命名者(#272:法币票也是我们发的)", () => {
  const NAMERS = ["coingecko", "fiat"] as const;

  it("法币票在集合里 → 解回 fiat/issued:<CODE>", () => {
    const t = tokenTicket.encode("fiat/issued:USD");
    expect(tokenTicket.decode(t, NAMERS)).toBe("fiat/issued:USD");
    expect(tokenTicket.decode(t, "fiat")).toBe("fiat/issued:USD");
  });

  it("同一组也照样收当前上游的加密币票", () => {
    const t = tokenTicket.encode("coingecko/issued:usd-coin");
    expect(tokenTicket.decode(t, NAMERS)).toBe("coingecko/issued:usd-coin");
  });

  it("只给 coingecko(旧签名)→ 法币票被拒 —— 正是修复前那条掉回 custom 的路", () => {
    const t = tokenTicket.encode("fiat/issued:USD");
    expect(tokenTicket.decode(t, "coingecko")).toBeUndefined();
  });

  it("不在集合里的别家命名者仍被挡(#223 不因放宽成组而失守)", () => {
    const forged = tokenTicket.encode("evil/issued:whatever");
    expect(tokenTicket.decode(forged, NAMERS)).toBeUndefined();
  });
});
