import { env } from "cloudflare:workers";
import { FolioHttpClient } from "@folio/client-core";
import {
  type ConnectorId,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import { type ConnectorError, isRetryable, retryAfterOf } from "@folio/connectors-basic";
import { Duration, Effect, Schedule } from "effect";
import type { InputSpec } from "../../creds";
import { platformLogoUrl } from "../../logo";

// 探活重试参数(原则 #8)。**刻意比 sync 的 3 次 / 5s 紧得多**:那条路是后台同步,没人在等;
// 这条路用户正盯着表单提交。1 次重试只为躲瞬时抖动;单次最多等 1.5s —— 再久就不如让他自己再点
// 一次(上游给的 Retry-After 超过它就直接失败,不把表单挂死)。
const VALIDATE_RETRY_ATTEMPTS = 2; // 总尝试次数(1 + 1 次重试)
const VALIDATE_RETRY_MAX_WAIT_MS = 1500;
const VALIDATE_RETRY_BASE_MS = 200;

// 加账户时的探活重试。**用户在等**,所以只赔一次往返、封顶 1.5 秒 —— 与后台同步那份
// (`@folio/sync` 的 `retryPolicy`,没人等所以宁可多等)刻意不同,不共用。
//
// 形状照抄它替掉的那个手搓 `withRetry`,三条语义一条不改:
const validateRetryPolicy = Schedule.exponential(Duration.millis(VALIDATE_RETRY_BASE_MS)).pipe(
  // ① 只重试可重试的;**并且上游建议的等待超过我们肯等的上限就直接放弃**。
  //    夹到 1.5 秒再打大概率还是 429,白赔一次往返,而用户正盯着表单 —— 抛出去让表单报错更好。
  //    这是 `withRetry` 的 `exceedsMaxWait: "throw"`,与后台同步那份的 clamp 语义**刻意相反**:
  //    那边没人等,夹住继续等更划算。(第一版我写成了 clamp,是行为退化。)
  //    **必须排在 passthrough 前** —— 它负责把输入类型钉成 ConnectorError。
  Schedule.whileInput((e: ConnectorError) => {
    if (!isRetryable(e)) return false;
    const suggested = retryAfterOf(e);
    return suggested === undefined || suggested <= VALIDATE_RETRY_MAX_WAIT_MS;
  }),
  // 把输出换成输入(错误本身),下一行才看得见 Retry-After。
  Schedule.passthrough,
  // ② 上游说了等多久就听它的,没说才用指数值;两者都夹在单次上限内。
  Schedule.modifyDelay((err, computed) => {
    const suggested = retryAfterOf(err);
    return Duration.min(
      Duration.millis(VALIDATE_RETRY_MAX_WAIT_MS),
      suggested !== undefined ? Duration.millis(suggested) : computed,
    );
  }),
  // ③ 抖动**不是可选的**:同一把 key 上常有多个调用者同时撞 429,都按同一个 Retry-After 醒来
  //    会精确地再撞一次。加性(+0~baseMs)不用 Effect 自带的 `jittered`(乘性会让退避短于基数)。
  Schedule.addDelay(() => Duration.millis(Math.random() * VALIDATE_RETRY_BASE_MS)),
  Schedule.intersect(Schedule.recurs(VALIDATE_RETRY_ATTEMPTS - 1)),
);

// app 侧 connector 分派中枢(server-only,引 cloudflare:workers)。集中管:
// 字段规格投影(credentialSpecs)、创建时凭据校验(validateAccountCreds)、目录(connectorCatalog)。
// 【只被 server fn 的 handler 体引用】—— 引 cloudflare:workers,绝不可进客户端 bundle;对外的 server fn
// 门面在 ./connectors(handler 体经编译剥离,故本模块不入客户端)。
// account.connectorId 直接就是 connectorId(#37d 后并存期分派表已退场)。
// 安全边界(原则 #5):此处【不碰 SECRETS_KEY】—— 创建/校验拿到的是表单明文,只做形状闸 + 可选活性探活;
// 存库前的加密塑形在 lib/creds.ts。

export interface ConnectorCatalogEntry {
  label: string;
  // 已代理:http 图 → /api/logo/platform/<cid>,manual 的 data: 直挂(platformLogoUrl);无图 → undefined。
  logo?: string;
}

// connector 展示目录(connectorId → {label, logo}):遍历 registry(单一事实源),供前端网格/徽章展示。
// logo 取 manifest 自带图并经 platformLogoUrl 代理(privacy,ADR 0008)—— /api/logo/platform 对场馆/manual
// 键即按 connectorId 认 manifest(见 connectorPlatformMeta),故这里直接拿 cid 当代理 key。
export function connectorCatalog(): Record<string, ConnectorCatalogEntry> {
  const out: Record<string, ConnectorCatalogEntry> = {};
  for (const [cid, manifest] of connectorRegistry) {
    out[cid] = { label: manifest.label, logo: platformLogoUrl(cid, manifest.logo) };
  }
  return out;
}

// 各 connectorId 的账户输入规格(可序列化):遍历 connector registry → 取 manifest 的 account.creds(CredField[]),
// 投影成 {key,type,label,desc}(剥掉不可序列化的 validator)。业务层据 type 做 seal/mask/complete/categorize。
export function credentialSpecs(): Partial<Record<ConnectorId, InputSpec[]>> {
  const specs: Partial<Record<ConnectorId, InputSpec[]>> = {};
  for (const [cid, manifest] of connectorRegistry) {
    specs[cid as ConnectorId] = manifest.account.creds.map((f) => ({
      key: f.key,
      type: f.type,
      label: f.label,
      desc: f.desc,
    }));
  }
  return specs;
}

// 创建/补录时的凭据校验:按 connector 的 account.creds 跑形状闸;opts.liveness 时再 provider.validateAccount 探活。
// 不过即抛。SECRETS_KEY 不参与(拿到的是表单明文,只校验形状 + 活性)。
export async function validateAccountCreds(
  connectorId: string,
  values: Record<string, string>,
  opts?: { liveness?: boolean; label?: string },
): Promise<void> {
  const manifest = getConnector(connectorRegistry, connectorId);
  if (!manifest) throw new Error(`no connector for connectorId ${connectorId}`);

  // 形状闸:逐字段跑 CredField 的 Standard Schema(脏/缺 → 抛 CredentialValidationError)。
  const validated = await validateCredentials(manifest.account.creds, values);
  if (!opts?.liveness) return;

  // **没有 provider 的 connector 没有「探活」这回事**(manual:无外部 API,#203 起它连 provider 都没了)。
  // 形状闸已经过了,直接放行。与「声明了 provider 却选不出来」区分开 —— 那是配置错误,仍要抛。
  if (manifest.balance.providers.length === 0) return;
  const provider = selectProvider(manifest);
  if (!provider) throw new Error(`no provider for connector ${connectorId}`);
  // PC 注入:从 env 按 provider 声明的 creds key 取默认值(最小权限:只注入声明的 key)——与 sync 的 fetchViaConnector 同形。
  const providerCreds: Record<string, string> = {};
  for (const f of provider.creds) {
    const v = (env as unknown as Record<string, string | undefined>)[f.key];
    if (v != null) providerCreds[f.key] = v;
  }
  const ctx = {
    account: { id: "new", label: opts.label ?? "", connectorId, creds: validated },
    creds: providerCreds,
  };
  // 探活加一次重试。这条路**不走 @folio/sync 的编排**,所以 sync 那套退避重试完全没覆盖它 ——
  // 上游一次瞬时 429 / 5xx 就让用户看到「添加失败」,而他填的东西完全没错。
  //
  // 参数比 sync 紧得多(见常量注释),而且**不加限速闸**:用户正盯着表单,"提交后转 5 秒圈"
  // 比"失败请重试"更糟 —— 他不知道还要等多久。探活也是一次性单发,不存在突发。
  //
  // 重试只吃「够不到上游」这一类:`validateAccount` 的契约(#240,见 connectors/basic 的 connector.ts)
  // 是 —— 凭据被拒**成功返回 `false`**、传输故障(429/5xx/网络)走错误通道。于是这里:
  // 瞬时 429 → 错误通道 + `isRetryable` 为真 → 再打一发;凭据真错 → 返回 false(不是失败)→
  // 压根进不了重试、直接报「could not verify」。**不**改成「false 也重试」:false 现在只剩
  // 「这个 key 就是错的」,给它多赔往返还会拿着错凭据再打上游。
  // tests/server/validate-retry.test.ts 钉住这两条。
  //
  // 策略从 `@folio/shared` 的手搓 `withRetry` 换成 Effect 的 `Schedule`(**这是 shared 的第一个
  // 消费者被摘掉**,它整体退场在 #362 第 3 站)。判据同样是 `_tag`,与 `@folio/sync` 那份用的是
  // 同一个 `isRetryable` —— 两处重试对「什么值得再打一发」必须给同一个答案,所以那个函数住在
  // 契约包里而不是各自抄一遍。
  const alive = await Effect.runPromise(
    provider
      .validateAccount(ctx)
      .pipe(Effect.retry(validateRetryPolicy), Effect.provide(FolioHttpClient)),
  );
  if (!alive) {
    throw new Error("could not verify these credentials — please check them and try again");
  }
}
