import { describe, expect, it } from "vitest";
import {
  formatTokenRef,
  hasTrustedSymbol,
  parseTokenRef,
  type TokenRefParts,
  tokenRef,
} from "../src";
import cases from "./fixtures/token-ref-cases.json" with { type: "json" };

// tokenRef 文法(ADR 0020)。**用例表在 fixtures/token-ref-cases.json** —— 输入、期望输出、
// 每条为什么在那里,都在那一个文件里排着,一眼扫得完;本文件只说「拿这张表怎么断言」。
//
// 分成两张表,因为造串与拆串是两个方向、期望的形状不同:
//   construct:给结构 → 期望一个串(归一规则在这里看:哪个命名者小写地址、什么被 trim)
//   parse:    给串 → 期望一个结构(`parsed: null` = 读不懂)
// 每条 parse 用例被**三种**断言吃:拆出这个结构 / 语义形拼回去 / 两段形拼回去 —— 后两者
// 是同一个 `formatTokenRef` 的两种入参,结果必须一致(见 src 里那段注释)。

interface ConstructCase {
  note: string;
  kind: "native" | "contract" | "issued" | "custom";
  namer: string;
  value?: string;
  ref: string;
}

interface ParseCase {
  note: string;
  raw: string;
  // 缺省即等于 raw;给了就表示 raw 不是规范形,拼回去会变成它。
  canonical?: string;
  // null = 读不懂(kind 为 unknown)。
  parsed: Record<string, string> | null;
}

const { construct, parse } = cases as { construct: ConstructCase[]; parse: ParseCase[] };

// 表本身也要有个下限:哪天有人把 fixture 清空了,下面每个 `it.each` 都会「零条用例全绿」。
describe("用例表", () => {
  it("两张表都不为空(空表会让下面所有 it.each 静默零断言)", () => {
    expect(construct.length).toBeGreaterThan(5);
    expect(parse.filter((c) => c.parsed !== null).length).toBeGreaterThan(5);
    expect(parse.filter((c) => c.parsed === null).length).toBeGreaterThan(5);
  });
});

// —— 造串:调用方给结构,`kind` 由构造函数定,不手写 ——
describe("tokenRef.* 构造", () => {
  const build = ({ kind, namer, value }: ConstructCase): string => {
    switch (kind) {
      case "native":
        return tokenRef.native(namer);
      case "contract":
        return tokenRef.contract(namer, value as string);
      case "issued":
        return tokenRef.issued(namer, value as string);
      case "custom":
        return tokenRef.custom(namer, value as string);
    }
  };

  it.each(construct)("$kind — $note", (c) => {
    expect(build(c)).toBe(c.ref);
  });

  it("造出来的串拆回去就是同一个结构(构造与解析同一套归一)", () => {
    for (const c of construct) {
      const parsed = parseTokenRef(c.ref);
      expect(parsed.kind).toBe(c.kind);
      if (parsed.kind !== "unknown") expect(formatTokenRef(parsed)).toBe(c.ref);
    }
  });
});

// —— 拆串 ——
const readable = parse.filter((c) => c.parsed !== null);
const unreadable = parse.filter((c) => c.parsed === null);

describe("parseTokenRef", () => {
  it.each(readable)("$raw — $note", ({ raw, parsed }) => {
    expect(parseTokenRef(raw)).toEqual(parsed);
  });

  // 读不懂的一律 unknown 且**永不 throw** —— 任何串都得有个去处。
  it.each(unreadable)("$raw → unknown — $note", ({ raw }) => {
    expect(() => parseTokenRef(raw)).not.toThrow();
    expect(parseTokenRef(raw)).toEqual({ kind: "unknown", raw });
  });
});

// —— 拼回去:同一个 formatTokenRef,两种入参,结果必须一致 ——
// 语义形是「知道这是个什么东西」时用的(改一个字段再拼回去);两段形是按两列存的表用的
// (`token_refs`,ADR 0022)—— 存储层因此不必认识 `native` / `contract:`,也不必知道分隔符是斜杠。
describe("formatTokenRef", () => {
  it.each(readable)("$raw — 两种入参拼出同一个规范形", ({ raw, canonical, parsed }) => {
    const want = canonical ?? raw;
    const got = parseTokenRef(raw);
    expect(got.kind).not.toBe("unknown");
    if (got.kind === "unknown") return;

    expect(formatTokenRef(got)).toBe(want); // 语义形
    expect(formatTokenRef({ namer: got.namer, localName: got.localName })).toBe(want); // 两段形
    // localName 与那一支自己的字段说的是同一件事(不该有两个说法)。
    expect(got.localName).toBe((parsed as Record<string, string>).localName);
  });

  it("归一幂等 —— 拆过再拼再拆,结果不再变", () => {
    for (const { raw } of readable) {
      const once = parseTokenRef(raw);
      if (once.kind === "unknown") continue;
      expect(parseTokenRef(formatTokenRef(once))).toEqual(once);
    }
  });

  // 反方向:从**构造入参**出发(`TokenRefParts`,不带 localName)。parse 的输出是它的超集,
  // 所以是「在构造字段上」恒等,不是整个对象相等。
  it("parse ∘ format 在构造字段上是恒等", () => {
    const parts: TokenRefParts[] = [
      { kind: "contract", namer: "evm:1", address: "0xabc" },
      {
        kind: "contract",
        namer: "solana",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      },
      { kind: "native", namer: "bitcoin" },
      { kind: "issued", namer: "coingecko", id: "usd-coin" },
      { kind: "custom", namer: "manual", name: "MYCOIN" },
    ];
    for (const p of parts) {
      const parsed = parseTokenRef(formatTokenRef(p));
      expect(parsed).toMatchObject(p);
    }
  });
});

// —— 「这条 ref 带来的 symbol 有没有背书人」——
// 判据收在文法里(而不是留给每个调用方自己 switch),因为它问的就是形状:选哪个构造函数,
// 就是在声明这条 ref 的证据强度。表是手写的字面表,不从 kind 反算 —— 否则它只会跟着实现走。
describe("hasTrustedSymbol", () => {
  const table = [
    {
      ref: "bitcoin/native",
      trusted: true,
      note: "原生币:symbol 是链自己的,而且原生币按设计不进映射表 —— symbol 是它唯一的一条路",
    },
    { ref: "binance/issued:USDC", trusted: true, note: "场馆上架代号:binance 为这个标识负责" },
    { ref: "coingecko/issued:usd-coin", trusted: true, note: "上游 coin id:命名者就是发它的人" },
    {
      ref: "evm:1/contract:0xabc",
      trusted: false,
      note: "合约的 symbol 是部署者随手填的 —— 山寨合约照样能写 USDC",
    },
    {
      ref: "manual/custom:USDC",
      trusted: false,
      note: "用户自己敲的,没有注册表背书 —— 这一条正是第四轮的由来",
    },
    { ref: "nonsense", trusted: false, note: "读不懂 → 关于它我们什么都不知道,最不该猜" },
  ];

  it.each(table)("$ref → $trusted — $note", ({ ref, trusted }) => {
    expect(hasTrustedSymbol(parseTokenRef(ref))).toBe(trusted);
  });

  it("表里两档都有(全 true 或全 false 的表等于没测)", () => {
    expect(table.some((c) => c.trusted)).toBe(true);
    expect(table.some((c) => !c.trusted)).toBe(true);
  });
});
