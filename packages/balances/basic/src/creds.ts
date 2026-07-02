import { decrypt, encrypt } from "./crypto";
import { maskCredential } from "./inputs";
import type { ProviderInput } from "./provider";

// 账户凭据的统一存储模型(P6.6.1):一个 creds map,按字段 type 决定加密 —— 只有 secret 加密,
// public/semi 明文。db 当作不透明 blob(不解释内容)。下列函数全部用 provider.inputs 驱动读写,
// 无字段名硬编码。导入待补录账户用 SEMI_PREFIX 占位记录 semi 的打码片段(区分"占位 vs 真值")。
export const SEMI_PREFIX = "semi_";

// creds map 统一是【字符串 map】:存库一律存 string(secret 加密,public/semi 原样)。number 等类型
// 只在 validateCredentials 的【输出】(coerce 后)与 CredsOf 出现,供 provider 消费;存储/导出/导入全程 string。
// 调用方传【原始字符串输入】(validateCredentials 只作校验闸,不把 coerce 输出回灌这里)。
export async function sealCreds(
  inputs: readonly ProviderInput[],
  values: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const v = values[input.key];
    if (v == null) continue;
    out[input.key] = input.type === "secret" ? await encrypt(v, key) : v;
  }
  return out;
}

// 存库 map → creds(给 sync 校验):secret 解密,其余原样(均 string)。validateCredentials 再 coerce 成各自类型。
// 缺失/占位字段不带出(由 isComplete 把关)。
export async function openCreds(
  inputs: readonly ProviderInput[],
  stored: Record<string, string>,
  key: string,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const input of inputs) {
    const v = stored[input.key];
    if (v == null) continue;
    out[input.key] = input.type === "secret" ? await decrypt(v, key) : v;
  }
  return out;
}

// 存库 map → 非密投影(导出 / 给前端 / 补录提示):public 原样、semi 打码、secret 丢弃。无需 key、不解密。
// semi 取真值(打码)或 SEMI_PREFIX 占位(已打码,透传),统一以裸 key 返回。
export function safeView(
  inputs: readonly ProviderInput[],
  stored: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of inputs) {
    if (input.type === "public") {
      if (stored[input.key] != null) out[input.key] = stored[input.key];
    } else if (input.type === "semi") {
      const v = stored[input.key];
      if (v != null) out[input.key] = maskCredential(v);
      else {
        const placeholder = stored[SEMI_PREFIX + input.key];
        if (placeholder != null) out[input.key] = placeholder;
      }
    }
    // secret:丢弃
  }
  return out;
}

// 是否完整(可同步):每个非 public 输入的真 key 都在(占位/缺失 → 不完整 = 缺凭据,导入待补录)。
export function isComplete(
  inputs: readonly ProviderInput[],
  stored: Record<string, string>,
): boolean {
  return inputs.filter((i) => i.type !== "public").every((i) => stored[i.key] != null);
}
