import { env } from "cloudflare:workers";
import {
  type ConnectorManifest,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import type { Balance, Note } from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import type { Tokens, ValuationMode } from "@folio/oracle";
import type { FetchOutcome, SyncDeps } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import type { InputSpec } from "../../creds";
import { isComplete, openCreds } from "../../creds";
import { revalue } from "../../revalue";
import { isSyncableAccount } from "../../syncable";
import { toProviderAssets } from "../../tokens";
import { userDisplayBalances } from "../../user-balances";
import { db } from "./db";
import { warmFx } from "./fx";
import { manualBalancesForWarm } from "./manual";
import { oracle } from "./oracle";
import { oracleFor } from "./oracle2";
import { warmPlatformsForUser } from "./platforms";
import { warmTokens } from "./token-enrich";

// server-only 编排装配(引 cloudflare:workers)。独立于 sync.ts —— triggerSync(server fn,被客户端 import)
// 只在其 handler 内引用本模块,handler 被剥离后客户端不会拉进 cloudflare:workers。cron(server.ts)直接引本模块。
// 数据访问经全局 db 门面;密钥/全局 key/tokens 走 cloudflare:workers 全局 env(fetch 与 scheduled 均可用)。

// 同步后预热代币缓存:取该用户最新快照的全部余额 → warm(top-N + 逐 spot/manual 行懒解析)。
// best-effort(warmTokens 内部吞错),让下次总览能 cache-only 富化出价/logo/涨跌。cron 与手动 sync 共用。
export async function warmTokensForUser(userId: string): Promise<void> {
  const [snapshots, accounts] = await Promise.all([
    db.getLatestSnapshotByUser(userId),
    db.listAccountsByUser(userId),
  ]);
  // manual 已退出快照(ADR 0018)→ 预热额外从 manual 的 creds 收集合成余额,否则纯 manual 用户的币暖不到实时价。
  // 与 refreshStalePrices 经同一 userDisplayBalances 收口(三门同源)。
  const manualBalances = await manualBalancesForWarm(userId, accounts);
  await warmTokens(oracle.tokens, userDisplayBalances(snapshots, manualBalances));
  // 平台元数据 + FX 汇率一并预热(各自失败不拖垮价格预热)。
  try {
    await warmPlatformsForUser(userId);
  } catch (e) {
    getLogger(["folio", "web", "sync"]).warn("warmPlatforms failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    await warmFx();
  } catch (e) {
    getLogger(["folio", "web", "sync"]).warn("warmFx failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// 经 @folio/connectors 取余额。前置(缺凭据 / 校验 / 选 provider)走快回退。
// #37d 起 account.connectorId 直接即 connector 的 id。
async function fetchViaConnector(
  cid: string,
  manifest: ConnectorManifest,
  account: AccountSafe,
  stored: Record<string, string>,
  tokens: Tokens,
  seeds: SeedCollector,
): Promise<FetchOutcome> {
  const specs = manifest.account.creds as unknown as InputSpec[]; // {key,type} 结构 = InputSpec
  if (!isComplete(specs, stored)) return { status: "needs-credentials" };
  const plain = await openCreds(specs, stored, env.SECRETS_KEY);
  // 取数前再跑一次 account.creds 校验闸:脏/畸形 identifier 快速失败
  //(CredentialValidationError 非 ProviderError → 非重试、隔离),不退化成"打坏地址 → 4xx → 白重试"。
  const validated = await validateCredentials(manifest.account.creds, plain);
  const provider = selectProvider(manifest);
  if (!provider) throw new Error(`no provider for connector ${cid}`);
  // PC 注入:从 env 按 provider 声明的 creds key 取默认值(最小权限:只注入声明的 key)。
  const providerCreds: Record<string, string> = {};
  for (const f of provider.creds) {
    const v = (env as unknown as Record<string, string | undefined>)[f.key];
    if (v != null) providerCreds[f.key] = v;
  }
  const ctx = {
    account: { id: account.id, label: account.label, connectorId: cid, creds: validated },
    creds: providerCreds,
  };
  // provider 抛的 @folio/connectors-basic ProviderError 直接向上传播 —— sync 的 withRetry 直接 instanceof 该类。
  // provider.fetchBalances 返回 { balances, note? }(note 重设计):balance 级单个 note 挂各 balance(随 balances
  // 透传 → snapshot_balances.note);顶层 note 为 account 级 Note[](整钱包)→ 透传 outcome.note → snapshots.note。
  const { balances: rows, note } = (await provider.fetchBalances(ctx)) as unknown as {
    balances: Balance[];
    note?: Note[];
  };
  const totalUsd = rows.reduce((s, b) => s + b.value, 0);
  await tokens.noteProviderAssets(toProviderAssets(rows)); // 结构兼容:connectors Balance 同形
  seeds.collect(rows);
  return { status: "ok", balances: rows, totalUsd, note };
}

// provider 报的元信息(名字 / 图)在编排里会被丢掉 —— 快照只落 symbol/amount/value/kind 那几样,
// `SnapshotBalanceInput` 里没有 name/logo。但 mint 建代币行时要用它们(不然新币只剩 symbol、没图)。
//
// 所以在**取到余额那一刻**顺手收一份 seed(就在 noteProviderAssets 旁边,同一处、同一批数据),
// 写快照那一步按 tokenRef 取回。存活范围 = 一个 `SyncDeps` 实例 = 一轮 sync,不跨请求。
// 这样 `@folio/sync` 与 `Balance` 契约都不用动 —— 平台字段那次的教训:派生出来的东西不该让
// provider 再报一遍(#193)。
interface SeedCollector {
  collect(rows: readonly Balance[]): void;
  of(tokenRef: string, symbol: string): { symbol: string; name?: string; providerLogo?: string };
}

function createSeedCollector(): SeedCollector {
  const bySeed = new Map<string, { symbol: string; name?: string; providerLogo?: string }>();
  return {
    collect(rows: readonly Balance[]): void {
      for (const b of rows) {
        if (!b.tokenRef || bySeed.has(b.tokenRef)) continue;
        bySeed.set(b.tokenRef, {
          // 归一(大写)是 store 的 key 口径,归一在调用方做。
          symbol: b.symbol.trim().toUpperCase(),
          name: b.name,
          providerLogo: b.logo,
        });
      }
    },
    // 没收到过(理论上不会:同一轮里 fetch 恒在 write 之前)→ 退回 symbol 一项。
    of(tokenRef: string, symbol: string) {
      return bySeed.get(tokenRef) ?? { symbol: symbol.trim().toUpperCase() };
    },
  };
}

// 装配编排器的注入式依赖。真正的 DI 缝是这里返回的 SyncDeps(syncUser 只认注入的 deps);
// triggerSync(手动)与 cron(scheduled)共用。
export function buildSyncDeps(): SyncDeps {
  const tokens = oracle.tokens;
  // 一轮 sync 共一份 seed 收集器:fetchBalances 那头收,writeSnapshot 那头取(见其定义)。
  const seeds = createSeedCollector();
  // per-user 估值模式:按 userId 记忆化一次读(revalue 逐账户调,避免 N 次 settings 读)。
  // 同一 deps 跨多用户(cron sweep)也正确 —— 按 userId 分桶缓存。
  const modeByUser = new Map<string, Promise<ValuationMode>>();
  const modeFor = (userId: string): Promise<ValuationMode> => {
    let p = modeByUser.get(userId);
    if (!p) {
      p = db.getUserSettings(userId).then((s) => s.valuationMode);
      modeByUser.set(userId, p);
    }
    return p;
  };
  return {
    // 归档账户跳过同步(不产生新快照);manual 不是同步源(ADR 0018:当下值由 creds 现造,不写快照)→ 一并过滤。
    // syncUser 只见活跃的可同步账户(判别走纯 isSyncableAccount)。
    listAccounts: async (userId) => (await db.listAccountsByUser(userId)).filter(isSyncableAccount),
    listRawCreds: (userId) => db.listRawCredsByUser(userId), // 批量取全用户 creds(消 syncAccount 的 N+1)
    // **写快照前先 mint**:每笔余额的 tokenRef 换成 token_id,认定就此冻进快照(ADR 0021 / #200)。
    //
    // 编排在这里而不在 `@folio/sync`:mint 的逻辑归 oracle2,sync 只认注入的 deps,两边都不用动。
    // D1 没有交互式事务,mint 必须先查后写 → 它与写快照注定是两次独立的批。mint 成了而写快照失败
    // 只留下没人引用的 Token 行,无害,下次复用。
    //
    // 不加 barrier:账户是并发跑的,同一条 ref 会被同时 mint,靠 store 的 upsert-then-read 幂等收敛
    // (见 createUserTokenStore.create)。搞「先统一 mint 再并发写」会牺牲「每账户独立落库、
    // 一个失败不影响其他」这条性质。
    writeSnapshot: async (userId, accountId, input) => {
      const rows = input.balances;
      const refs = rows.flatMap((b) =>
        b.tokenRef ? [{ ref: b.tokenRef, seed: seeds.of(b.tokenRef, b.symbol) }] : [],
      );
      let idByRef = new Map<string, string>();
      if (refs.length > 0) {
        try {
          idByRef = await oracleFor(userId).mint.of(refs);
        } catch (e) {
          // best-effort:mint 挂了照样落快照(新列留空,读端退回旧路)。定价/认币故障不该让
          // 整轮同步丢数据 —— 下次同步会把 token_id 补上。
          getLogger(["folio", "web", "sync"]).warn(
            "mint failed; writing snapshot without token_id",
            {
              userId,
              accountId,
              error: e instanceof Error ? e.message : String(e),
            },
          );
        }
      }
      return db.writeSnapshot(userId, accountId, {
        ...input,
        balances: rows.map((b) => ({
          ...b,
          tokenId: b.tokenRef ? idByRef.get(b.tokenRef) : undefined,
        })),
      });
    },
    // 取余额:account.connectorId → connector manifest → fetchViaConnector(缺凭据/解密/校验/取数在其内);
    // SECRETS_KEY 只在本层(app)见。connectorId 直接即 connector 的 id;无 manifest 视为数据错误
    //(由 syncAccount 逐账户隔离,不阻断其余)。
    fetchBalances: async (account, stored) => {
      const cid = account.connectorId;
      const manifest = getConnector(connectorRegistry, cid);
      if (!manifest) throw new Error(`no connector for connectorId ${cid}`);
      return fetchViaConnector(cid, manifest, account, stored, tokens, seeds);
    },
    // 结构化日志:sync 的每账户结果/重试经此 logger 记(userId 显式带;请求路径还会经 withContext 带 ALS 上下文)。
    log: getLogger(["folio", "sync"]),
    // 写快照前重估(oracle 多源 Phase 3):按 mode 定 value + 非盯市类型捕获 selfPrice(原料)。
    // 盯市语义由 connector 的 manifest.valuation 声明(不靠 app 硬编码名单):据 connectorId 查 manifest →
    // 传 markToMarket 布尔。mode 按 userId 解析(记忆化);缺省 self-first(无 settings 行的用户)。
    revalue: async (userId, connectorId, rows) =>
      revalue(
        tokens,
        getConnector(connectorRegistry, connectorId)?.valuation === "mark-to-market",
        rows,
        await modeFor(userId),
      ),
  };
}
