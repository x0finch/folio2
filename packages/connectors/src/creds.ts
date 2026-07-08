import type { StandardSchemaV1 } from "@standard-schema/spec";

// 【creds 字段】—— 账户级(account.creds)与 provider 级(provider.creds)通用的字段声明。
// 沿用旧 @folio/balances 的 ProviderInput 形状:校验器用 Standard Schema(库无关,zod v4 等均实现)。
// - type = 单轴暴露级别(at-rest 一律加密落库,type 只决定"导出/输入框怎么处理"):
//     public = 全留(文本框、导出原样、导入可重建,如地址);
//     semi   = 部分留(文本框、导出打码保留、供补录识别,如 apiKey);
//     secret = 不留(password、导出剥离,如签名 secret / passphrase)。
// - validator 推断值类型 T(string / number / …);CredsOf 据此推出 creds 的精确形状。
export type CredFieldType = "public" | "semi" | "secret";

export interface CredField<T = unknown> {
  readonly key: string;
  readonly type: CredFieldType;
  readonly validator: StandardSchemaV1<unknown, T>;
  // 人类可读标签,兼作 i18n key(源串即 key);缺翻译回退英文。desc 同理。
  readonly label: string;
  readonly desc?: string;
}

// 从 const 字面量 creds 推出该 creds 的精确形状:每字段 → 其 validator 输出类型(异构)。
export type CredsOf<C extends readonly CredField[]> = {
  readonly [E in C[number] as E["key"]]: E extends CredField<infer T> ? T : never;
};

// 按暴露级别分类(导出/重建/补录据此处理)。
export function secretKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "secret").map((f) => f.key);
}
export function semiKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "semi").map((f) => f.key);
}
export function publicKeys(fields: readonly CredField[]): string[] {
  return fields.filter((f) => f.type === "public").map((f) => f.key);
}

// 把凭据值打码成可识别但不泄露的片段(首尾各留一小段)。纯字符串、确定性、无 crypto。
export function maskCredential(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "…";
  const head = value.length >= 12 ? 4 : 2;
  const tail = value.length >= 12 ? 4 : 2;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export class CredentialValidationError extends Error {}

// 逐字段跑各 CredField 的 Standard Schema 校验,产出已校验 creds(只含声明字段);任一不过即抛。
// 创建账户与同步(构造 FetchContext 前)共用 → ctx.creds 运行时即保证符合声明,给 CredsOf 运行时背书。
// 输入恒为字符串 map(表单 / 解密后的 creds);各 validator 把 string coerce 成各自输出类型(如 number)。
export async function validateCredentials(
  fields: readonly CredField[],
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    let result = field.validator["~standard"].validate(values[field.key]);
    if (result instanceof Promise) result = await result;
    if (result.issues) {
      const msg = result.issues.map((iss) => iss.message).join("; ");
      throw new CredentialValidationError(`${field.key}: ${msg}`);
    }
    out[field.key] = result.value;
  }
  return out;
}
