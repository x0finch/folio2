import { env } from "cloudflare:workers";
import {
  type ConnectorId,
  registry as connectorRegistry,
  getConnector,
  selectProvider,
  validateCredentials,
} from "@folio/connectors";
import type { InputSpec } from "../../creds";
import { platformLogoUrl } from "../../logo";

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
  if (!(await provider.validateAccount(ctx))) {
    throw new Error("could not verify these credentials — please check them and try again");
  }
}
