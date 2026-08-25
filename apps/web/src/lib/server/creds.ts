import { decrypt, encrypt, maskCredential } from "@folio/connectors-basic";

// provider 的 CredField 的可序列化投影(剥掉不可序列化的 validator,前端/塑形只需 key+type+label)。
// 由 lib/server/connectors/registry.ts 的 credentialSpecs() 从 connector manifest 的 account.creds 派生。
export interface InputSpec {
  key: string;
  type: "public" | "semi" | "secret";
  label: string; // 兼作 i18n key;desc 同理
  desc?: string;
}

// 凭据的【存储/导出/导入】塑形 —— 业务层的事(app 拥有 SECRETS_KEY 与 DB)。全部只靠字段的 {key,type}
// (= credentialSpecs() 的 InputSpec)+ 通用 crypto 驱动,不碰 provider/validator。
// 存储模型(P6.6.1):一个 creds map,按字段 type 决定加密 —— 只有 secret 加密,public/semi 明文。
// 导入待补录账户用 SEMI_PREFIX 占位记录 semi 的打码片段(区分"占位 vs 真值")。
export const SEMI_PREFIX = "semi_";

// 库里那一列 raw JSON → creds map。**解不开时给 null,不抛**(#527 裁定 1)。
//
// 坏 JSON 只可能来自迁移或人手改库,概率低 —— 但三个调用点(账户列表 / 同步状态面板 / 导出流)
// 全都是「整页」级别的:一行坏数据以前能让账户页、总览的同步面板、整个导出一起打不开,而屏幕上
// 只有一句 500,连是哪个账户都不说。拿到 null 的调用方按「这个账户没凭据」处理:needsCredentials
// 亮起,用户重填一次就修好了,同时日志里留下 accountId(**只有 id** —— P6.7 红线)。
//
// 非对象的合法 JSON(`"x"` / `123` / `[]`)一并算解不开:它们 parse 得过,但下游 `isComplete` /
// `safeView` 拿它当 map 用会读出一堆 undefined,那是更难查的一种坏。
export function readStoredCreds(raw: string | null | undefined): Record<string, string> | null {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, string>;
  } catch {
    return null;
  }
}

// 原始字符串输入 → 存库 map:secret 加密,public/semi 原样(均 string)。
export async function sealCreds(
  specs: readonly InputSpec[],
  values: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = values[spec.key];
    if (v == null) continue;
    out[spec.key] = spec.type === "secret" ? await encrypt(v, key) : v;
  }
  return out;
}

// 存库 map → 明文 creds(给 connector 取数 / 校验):secret 解密,其余原样。缺失/占位字段不带出。
export async function openCreds(
  specs: readonly InputSpec[],
  stored: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = stored[spec.key];
    if (v == null) continue;
    out[spec.key] = spec.type === "secret" ? await decrypt(v, key) : v;
  }
  return out;
}

// 存库 map → 非密投影(导出 / 前端 / 补录提示):public 原样、semi 打码、secret 丢弃。无需 key、不解密。
export function safeView(
  specs: readonly InputSpec[],
  stored: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    if (spec.type === "public") {
      if (stored[spec.key] != null) out[spec.key] = stored[spec.key];
    } else if (spec.type === "semi") {
      const v = stored[spec.key];
      if (v != null) out[spec.key] = maskCredential(v);
      else {
        const placeholder = stored[SEMI_PREFIX + spec.key];
        if (placeholder != null) out[spec.key] = placeholder;
      }
    }
    // secret:丢弃
  }
  return out;
}

// 是否完整(可同步):每个非 public 字段的真 key 都在(占位/缺失 → 缺凭据,导入待补录)。
export function isComplete(specs: readonly InputSpec[], stored: Record<string, string>): boolean {
  return specs.filter((s) => s.type !== "public").every((s) => stored[s.key] != null);
}

// 按暴露级别分桶(导入重建 creds map 用)。
export function categorizeFields(specs: readonly InputSpec[]): {
  public: string[];
  semi: string[];
  secret: string[];
} {
  const keysOf = (t: InputSpec["type"]) => specs.filter((s) => s.type === t).map((s) => s.key);
  return { public: keysOf("public"), semi: keysOf("semi"), secret: keysOf("secret") };
}
