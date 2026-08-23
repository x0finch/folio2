import { env } from "cloudflare:test";
import { type Balance, ConnectorFailure } from "@folio/connectors-basic";
import { Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dbFor, globalDb, oracleDbFor } from "./db-effect";
import { syncOne, syncRound, warmTokensForUser } from "./sync-fns";

// 写路径切到 mint 的端到端测试(#200):喂 provider 余额 → 落库 → 快照行带正确的 token_id。
//
// 走**真 D1**,不是内存假实现 —— 这一片的全部风险都在真表的约束上(`token_refs` 的主键、
// 并发下的 upsert-then-read)。内存 fake 用 Map,这些都测不出来。
//
// 上游一律**打桩到抛错**:mint 按设计全程不碰网络。任何一次外呼都会让用例红,这正是断言之一。

const USER = "user-sync-mint";
const NAMER = "coingecko";
const USDC_ETH = "evm:1/contract:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "evm:42161/contract:0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const USDC_SOL = "solana/contract:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function resetUser(): Promise<void> {
  await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(USER).run();
  await env.DB.prepare("DELETE FROM global_token_ref_index").run();
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO user (id, name, email, email_verified, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(USER, USER, `${USER}@example.com`, 0, now, now)
    .run();
}

// 外呼**计数**,不是抛错。原来这里打桩成抛错、注释写着「任何一次外呼都会让用例红」——
// 那是假的:SWR 把 fetch 的抛错当「上游没有」吞掉,所以真出网了用例照样绿(#216 顺手修)。
// 现在既抛错(让意外的外呼有个响动)又记账,断言看的是记账。
let outbound: string[] = [];

beforeEach(async () => {
  await resetUser();
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    outbound.push(String(input));
    throw new Error(`写路径不该碰网络,却请求了 ${String(input)}`);
  });
});

afterEach(() => vi.restoreAllMocks());

// 预热缓存里放一份 warm 集,让 symbol 那一档在本地就有候选可判(否则它会想回源)。
async function seedWarm(
  rows: { id: string; symbol: string; rank: number }[],
  asOf = Date.now(),
): Promise<void> {
  await dbFor(USER).cache.put(
    "warm",
    {
      asOf,
      rows: rows.map((r) => ({
        info: { ref: `${NAMER}/issued:${r.id}`, symbol: r.symbol, name: r.symbol },
        price: { unitPrice: 1, marketCapRank: r.rank, asOf: Date.now() },
      })),
    },
    60 * 60 * 1000,
  );
}

// 那个 Token 被上游认出来了没 —— 读 `token_refs` 里当前命名者那一行(端口回 `Option`,
// 用例只关心里面那一行,所以在这儿摘掉包装)。
const tokenInfo = async (tokenId: string) =>
  Option.getOrUndefined(await oracleDbFor(USER).tokens.getById(tokenId));

async function seedRefIndex(rows: { ref: string; localName: string }[]): Promise<void> {
  // chainRef → 整条 upstream ref(#228:表存整条,不是裸 id)。
  await globalDb.refIndex.putAll(
    rows.map((r) => ({ chainRef: r.ref, upstreamRef: `${NAMER}/issued:${r.localName}` })),
    Date.now(),
  );
}

async function makeAccount(label = "w"): Promise<string> {
  const account = await dbFor(USER).accounts.create({
    connectorId: "evm",
    label,
    creds: null,
  });
  return account.id;
}

// provider 报的一笔余额(`Balance` 形状 —— 这是编排器收到的东西)。
const bal = (tokenRef: string, symbol: string, over: Record<string, unknown> = {}): Balance =>
  ({
    symbol,
    amount: 1,
    value: 100,
    kind: "spot" as const,
    tokenRef,
    ...over,
  }) as Balance;

// **走真编排器**(#202 之后 mint 是编排里独立的一步,跑在 revalue 之前)。
// 只把取数那一步打桩,mint / revalue / 写快照全用真实现 —— 顺序与 best-effort 语义因此都被覆盖,
// 不必在测试里复刻编排逻辑(复刻的话,编排顺序一改测试还是绿的,那就白测了)。
async function syncWith(balances: Balance[], accountId: string): Promise<string> {
  const accounts = await dbFor(USER).accounts.list();
  const account = accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account ${accountId}`);
  const res = await syncOne(USER, { account, balances });
  if (!res.ok || !res.snapshotId) throw new Error(`sync failed: ${res.error ?? "no snapshot"}`);
  return res.snapshotId;
}

async function balancesOf(snapshotId: string) {
  // symbol / token_ref 不再落快照(#243):身份只剩 token_id,上游叫法反查走 store.getById().ref。
  const { results } = await env.DB.prepare(
    "SELECT token_id as tokenId FROM snapshot_balances WHERE snapshot_id = ?",
  )
    .bind(snapshotId)
    .all<{ tokenId: string | null }>();
  return results;
}

describe("落库后快照行带 token_id", () => {
  it("映射表认得的合约 → 认出上游币,快照行带 token_id", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal(USDC_ETH, "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenId).toBeTruthy();

    // 那个 Token 确实被上游认出来了(有 coingecko 那一档的 ref 行)。
    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBe("coingecko/issued:usd-coin");
  });

  it("映射表没有的合约 → 也建行、快照照写,只是上游没认出来", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("evm:1/contract:0xdeadbeef", "SCAM")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy(); // 认不出来也有 token_id,快照不卡在上游上
    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBeNull();
  });

  it("多链的同一个币 → 一个 Token + 多条 ref", async () => {
    await seedRefIndex([
      { ref: USDC_ETH, localName: "usd-coin" },
      { ref: USDC_ARB, localName: "usd-coin" },
    ]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal(USDC_ETH, "USDC"), bal(USDC_ARB, "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenId).toBe(rows[1].tokenId); // 同一个 Token
    const { results } = await env.DB.prepare("SELECT count(*) as n FROM tokens WHERE user_id = ?")
      .bind(USER)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  it("原生币走 symbol 那一档(它按设计不进映射表)", async () => {
    await seedWarm([{ id: "ethereum", symbol: "ETH", rank: 2 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("evm:1/native", "ETH")], accountId);

    const rows = await balancesOf(snapshotId);
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBe("coingecko/issued:ethereum");
  });

  // 合约的 symbol 是部署者随手填的 —— 地址查不到就该老实认不出来(#210 的闸)。
  it("山寨合约的 symbol 写着 USDC 也不许并进真 USDC", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith(
      [bal(USDC_ETH, "USDC"), bal("evm:1/contract:0xfake", "USDC")],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows[0].tokenId).not.toBe(rows[1].tokenId); // 各占一行
  });

  // **这条曾经只在内存假实现里测过,于是漏掉了一个真 bug**:`coingecko/<id>` 形的 ref 本身
  // 就是上游的命名(手记里用户选了币),它已经是锚 —— 缺了短路的话会把 [ref, upstreamRef]
  // 两条相同的 ref 塞进同一批,真表上 `token_refs` 的主键会冲突、**整个账户的快照写失败**。
  // 内存 fake 用 Map,静静吞掉了这个约束。所以这一支必须在真 D1 上跑。
  it("上游命名形的 ref(手记选了币)→ 自己就是锚,只出一条 ref 行", async () => {
    const accountId = await makeAccount();
    const snapshotId = await syncWith([bal("coingecko/issued:usd-coin", "USDC")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy();

    const info = await tokenInfo(rows[0].tokenId as string);
    expect(info?.ref).toBe("coingecko/issued:usd-coin");
    // 只有一条 ref 行 —— 去重生效(不然主键就撞了)。
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });

  // 六个来源的 USDC 落一个 Token —— 这一组在内存里测过(mint.test.ts),这里验它在真表上也成立:
  // 六条 ref 行、一个 token,而且 `token_refs` 的主键不会在任何一步撞上。
  it("六个来源的 USDC → 一个 Token、六条 ref 行", async () => {
    await seedRefIndex([
      { ref: USDC_ETH, localName: "usd-coin" },
      { ref: USDC_ARB, localName: "usd-coin" },
      { ref: USDC_SOL, localName: "usd-coin" },
    ]);
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount();

    const snapshotId = await syncWith(
      [
        bal(USDC_ETH, "USDC"),
        bal(USDC_ARB, "USDC"),
        bal(USDC_SOL, "USDC"),
        bal("binance/issued:USDC", "USDC"),
        bal("okx/issued:USDC", "USDC"),
        bal("coingecko/issued:usd-coin", "USDC"),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(new Set(rows.map((r) => r.tokenId)).size).toBe(1); // 全落一个 Token
    const { results } = await env.DB.prepare(
      "SELECT count(*) as n FROM token_refs WHERE user_id = ? AND token_id = ?",
    )
      .bind(USER, rows[0].tokenId)
      .all<{ n: number }>();
    expect(results[0].n).toBe(6); // 六条来源各一行
  });
});

describe("perp 两类行都有 token_id", () => {
  it("权益行与单仓位行都拿到 token_id", async () => {
    await seedWarm([{ id: "usd-coin", symbol: "USDC", rank: 6 }]);
    const accountId = await makeAccount("perp");

    const snapshotId = await syncWith(
      [
        bal("hyperliquid/issued:USDC", "USDC", { kind: "perp_equity" }),
        // 单仓位行金额为零、不进聚合,但也该有身份。
        bal("hyperliquid/issued:BTC", "BTC", { kind: "perp_position", usdValue: 0 }),
      ],
      accountId,
    );

    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.tokenId)).toBe(true);
  });
});

describe("每账户独立落库的性质保住", () => {
  it("一个账户失败不影响另一个账户落库", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const bad = await makeAccount("bad");
    const good = await makeAccount("good");
    const accounts = await dbFor(USER).accounts.list();
    const of = (id: string) => accounts.find((a) => a.id === id) as never;

    // **同一轮**里两个账户:坏的取数直接失败(错误通道上给一个 `ConnectorError`)→ syncAccount
    // 收成 ok:false、不落库、不向上抛;好的照样落库、照样带 token_id。
    // 「共用一份 deps」在片 3 之后的形状就是「共用一次装配」—— seed 收集器与估值模式活在这一轮里。
    const [badRes, goodRes] = await syncRound(USER, [
      { account: of(bad), fail: new ConnectorFailure({ message: "provider down" }) },
      { account: of(good), balances: [bal(USDC_ETH, "USDC")] },
    ]);
    expect(badRes.ok).toBe(false);
    expect(goodRes.snapshotId).toBeTruthy();
    expect((await balancesOf(goodRes.snapshotId as string))[0].tokenId).toBeTruthy();
  });

  // 账户并发跑,同一条 ref 会被同时 mint。靠 store 的 upsert-then-read 幂等收敛,不加 barrier。
  it("两个账户并发落同一个币 → 只出一个 Token 行", async () => {
    await seedRefIndex([{ ref: USDC_ETH, localName: "usd-coin" }]);
    const a = await makeAccount("a");
    const b = await makeAccount("b");

    // 各起一轮、同时跑 —— 这正是两个请求同时进来时的样子(片 3 之后一轮 = 一次装配)。
    const [s1, s2] = await Promise.all([
      syncWith([bal(USDC_ETH, "USDC")], a),
      syncWith([bal(USDC_ETH, "USDC")], b),
    ]);

    const [r1, r2] = [await balancesOf(s1), await balancesOf(s2)];
    expect(r1[0].tokenId).toBe(r2[0].tokenId);
    const { results } = await env.DB.prepare("SELECT count(*) as n FROM tokens WHERE user_id = ?")
      .bind(USER)
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);
  });
});

describe("provider 报的元信息进代币行", () => {
  // 名字与图在编排里会被丢掉(快照不落它们),所以是在取到余额那一刻收的 seed。
  it("建行用 provider 报的 name / logo(图落备用槽)", async () => {
    const accountId = await makeAccount();
    // seed 是在 `fetchViaConnector` 里收的;本测试把取余额那一层整个换掉、绕开了它,
    // 所以这里没有 seed —— 正好验「没有 seed 时退回 symbol 一项」这条兜底。
    const snapshotId = await syncWith([bal("evm:1/contract:0xnoseed", "FOO")], accountId);
    const rows = await balancesOf(snapshotId);
    const info = await tokenInfo(rows[0].tokenId as string);
    // 没有 seed 时退回 symbol 一项 —— 名字等于 symbol,不是空。
    expect(info).toMatchObject({ symbol: "FOO", name: "FOO" });
  });
});

// #216:写路径不为目录新鲜度出网。
//
// **symbol 用 LINK 而不是 ETH** —— 主流币都在策展表(OVERRIDES)里,策展查在候选源之前,
// 用 ETH 的话候选源根本不会被问到,断言就空转了(第一版正是这么写的,两条都没验到东西)。
describe("写路径不为目录新鲜度出网(#216)", () => {
  const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

  it("目录是一年前的 → symbol 那一档照样认出来,而且零外呼", async () => {
    await seedWarm([{ id: "chainlink", symbol: "LINK", rank: 15 }], Date.now() - YEAR_MS);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("binance/issued:LINK", "LINK")], accountId);

    const rows = await balancesOf(snapshotId);
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBe("coingecko/issued:chainlink");
    expect(outbound).toEqual([]); // ← 本条的重点
  });

  it("目录里没有这个 symbol → 认不出来,快照照落(不卡在上游上)", async () => {
    await seedWarm([{ id: "chainlink", symbol: "LINK", rank: 15 }], Date.now() - YEAR_MS);
    const accountId = await makeAccount();

    const snapshotId = await syncWith([bal("binance/issued:ZZZ", "ZZZ")], accountId);

    const rows = await balancesOf(snapshotId);
    expect(rows[0].tokenId).toBeTruthy(); // 有身份
    expect((await tokenInfo(rows[0].tokenId as string))?.ref).toBeNull(); // 但上游没认出
    expect(outbound).toEqual([]); // 认不出来也不去问上游
  });
});

// 目录唯一主动跟进的那条路。**断言看 blob 有没有被换掉**,不看网络调用数 ——
// `warmTokensForUser` 里还有旧参考层的预热也在打 `/coins/markets`,按 URL 数数分不清是谁打的。
describe("同步后的预热把目录刷上(#216)", () => {
  const blobAsOf = async (): Promise<number | undefined> => {
    const hit = await dbFor(USER).cache.get("warm");
    return (Option.getOrUndefined(hit)?.value as { asOf: number } | undefined)?.asOf;
  };

  const marketsCalls = () => outbound.filter((u) => u.includes("/coins/markets")).length;
  const LINK = [{ id: "chainlink", symbol: "LINK", rank: 15 }];
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  // **差分**,不是绝对数:`warmTokensForUser` 里还有旧参考层的预热也在打 `/coins/markets`,
  // 按 URL 数绝对值分不清是谁打的。两次跑只有目录的 asOf 不同 → 差出来的那几次就是它。
  it("目录旧了会去刷,还新就不刷", async () => {
    await seedWarm(LINK, Date.now());
    await warmTokensForUser(USER);
    const fresh = marketsCalls();

    outbound.length = 0;
    await seedWarm(LINK, Date.now() - WEEK_MS - 1);
    await warmTokensForUser(USER);
    const stale = marketsCalls();

    expect(stale).toBeGreaterThan(fresh);
  });

  it("还新的那份一个字都没被动过", async () => {
    const fresh = Date.now();
    await seedWarm(LINK, fresh);

    await warmTokensForUser(USER);

    expect(await blobAsOf()).toBe(fresh);
  });

  it("预热去刷但上游挂了 → 旧目录保住,同步收尾不抛(它在 waitUntil 里)", async () => {
    const stale = Date.now() - WEEK_MS - 1;
    await seedWarm(LINK, stale);

    await expect(warmTokensForUser(USER)).resolves.toBeUndefined();

    expect(await blobAsOf()).toBe(stale); // 上游被打桩成抛错 → SWR 保留旧值、不写回
  });
});

describe("多行同批不撞 D1 的参数上限", () => {
  // snapshot_balances 现在 12 列 → 每批 8 行。给 25 行跨 4 批。
  it("25 笔持仓一次落库,全部带 token_id", async () => {
    const accountId = await makeAccount();
    const balances = Array.from({ length: 25 }, (_, i) =>
      bal(`evm:1/contract:0x${(i + 1).toString(16).padStart(40, "0")}`, `T${i}`),
    );
    const snapshotId = await syncWith(balances, accountId);
    const rows = await balancesOf(snapshotId);
    expect(rows).toHaveLength(25);
    expect(rows.every((r) => r.tokenId)).toBe(true);
  });
});
