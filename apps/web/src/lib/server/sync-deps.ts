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
import type { FetchOutcome, SyncDeps } from "@folio/sync";
import type { ProviderAsset, Tokens } from "@folio/tokens";
import { getLogger } from "@logtape/logtape";
import type { InputSpec } from "../creds";
import { isComplete, openCreds } from "../creds";
import { revalue } from "../revalue";
import { db } from "./db";
import { warmFx } from "./fx";
import { warmPlatformsForUser } from "./platforms";
import { buildTokens, warmTokens } from "./tokens";

// provider 自带代币元信息的采集(canonical P1):合约形 tokenKey 的行 → ProviderAsset,
// 喂 tokens.noteProviderAssets(seed 孤儿 / 刷新备用 logo)。native/无标识行不 seed(原生币走 symbol 解析)。
// logo/name 只在取数瞬时存在,不落快照行 —— 参考层是其 home。
function toProviderAssets(rows: Balance[]): ProviderAsset[] {
  const out: ProviderAsset[] = [];
  for (const b of rows) {
    const id = b.tokenKey;
    // 只 seed 合约形(erc20/token);native:/coingecko: 无需 seed(前者走 symbol,后者已是 CGK)。
    if (!id || !(id.includes("/erc20:") || id.includes("/token:"))) continue;
    out.push({ tokenId: id, symbol: b.symbol, name: b.name, logo: b.logo });
  }
  return out;
}

// server-only 编排装配(引 cloudflare:workers)。独立于 sync.ts —— triggerSync(server fn,被客户端 import)
// 只在其 handler 内引用本模块,handler 被剥离后客户端不会拉进 cloudflare:workers。cron(server.ts)直接引本模块。
// 数据访问经全局 db 门面;密钥/全局 key/tokens 走 cloudflare:workers 全局 env(fetch 与 scheduled 均可用)。

// 同步后预热代币缓存:取该用户最新快照的全部余额 → warm(top-N + 逐 spot/manual 行懒解析)。
// best-effort(warmTokens 内部吞错),让下次总览能 cache-only 富化出价/logo/涨跌。cron 与手动 sync 共用。
export async function warmTokensForUser(userId: string): Promise<void> {
  const snapshots = await db.getLatestSnapshotByUser(userId);
  await warmTokens(
    buildTokens(env),
    snapshots.flatMap((s) => s.balances),
  );
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
  return { status: "ok", balances: rows, totalUsd, note };
}

// 装配编排器的注入式依赖。真正的 DI 缝是这里返回的 SyncDeps(syncUser 只认注入的 deps);
// triggerSync(手动)与 cron(scheduled)共用。
export function buildSyncDeps(): SyncDeps {
  const tokens = buildTokens(env);
  return {
    // 归档账户跳过同步(不产生新快照);过滤在此,syncUser 只见活跃账户。
    listAccounts: async (userId) =>
      (await db.listAccountsByUser(userId)).filter((a) => a.archivedAt == null),
    listRawCreds: (userId) => db.listRawCredsByUser(userId), // 批量取全用户 creds(消 syncAccount 的 N+1)
    writeSnapshot: (userId, accountId, input) => db.writeSnapshot(userId, accountId, input),
    // 取余额:account.connectorId → connector manifest → fetchViaConnector(缺凭据/解密/校验/取数在其内);
    // SECRETS_KEY 只在本层(app)见。connectorId 直接即 connector 的 id;无 manifest 视为数据错误
    //(由 syncAccount 逐账户隔离,不阻断其余)。
    fetchBalances: async (account, stored) => {
      const cid = account.connectorId;
      const manifest = getConnector(connectorRegistry, cid);
      if (!manifest) throw new Error(`no connector for connectorId ${cid}`);
      return fetchViaConnector(cid, manifest, account, stored, tokens);
    },
    // 结构化日志:sync 的每账户结果/重试经此 logger 记(userId 显式带;请求路径还会经 withContext 带 ALS 上下文)。
    log: getLogger(["folio", "sync"]),
    // 写快照前重估(P7.4.2):盯市语义由 connector 的 manifest.valuation 声明(不再靠 app 硬编码名单)。
    // 据 connectorId 查 manifest → 传 markToMarket 布尔给 revalue(@folio/sync 不依赖 token/connector 层,注入在此)。
    revalue: (connectorId, rows) =>
      revalue(
        tokens,
        getConnector(connectorRegistry, connectorId)?.valuation === "mark-to-market",
        rows,
      ),
  };
}
