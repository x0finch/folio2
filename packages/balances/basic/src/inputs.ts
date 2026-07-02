import type { ProviderInput } from "./provider";

// ProviderInput[] 的纯工具(库无关:只用 Standard Schema 接口,不依赖 zod)。

// 按暴露级别分类字段(导出 / 重建 / 补录据此处理):
// secret = 导出剥离;semi = 导出打码保留;public = 导出原样保留、导入可重建。
export function secretKeys(inputs: readonly ProviderInput[]): string[] {
  return inputs.filter((i) => i.type === "secret").map((i) => i.key);
}
export function semiKeys(inputs: readonly ProviderInput[]): string[] {
  return inputs.filter((i) => i.type === "semi").map((i) => i.key);
}
export function publicKeys(inputs: readonly ProviderInput[]): string[] {
  return inputs.filter((i) => i.type === "public").map((i) => i.key);
}

// 把一个凭据值打码成可识别但不泄露的片段(首尾各留一小段,中间省略)。纯字符串、确定性、无 crypto。
// 通用于所有 semi 字段(不针对 apiKey):既当导出/展示的"身份提示",也当补录时的首尾比对依据。
export function maskCredential(value: string): string {
  if (!value) return "";
  if (value.length <= 6) return "…"; // 太短:不露任何真实字符
  const head = value.length >= 12 ? 4 : 2;
  const tail = value.length >= 12 ? 4 : 2;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export class CredentialValidationError extends Error {}

// 逐字段跑各 input 的 Standard Schema 校验,产出已校验的 creds(只含 inputs 声明的字段);任一不过
// 即抛 CredentialValidationError(`<key>: <message>`)。创建账户与同步(构造 FetchContext 前)共用 →
// ctx.creds 在运行时即保证符合 inputs,给 CredsOf 类型以运行时背书。
// 输入恒为字符串 map(表单 / 解密后的 creds);各 validator 把 string coerce 成各自输出类型(如 number),
// 故返回是异构 Record<string,unknown>(供 provider 按 CredsOf 消费)。
export async function validateCredentials(
  inputs: readonly ProviderInput[],
  values: Record<string, string>,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const input of inputs) {
    let result = input.validator["~standard"].validate(values[input.key]);
    if (result instanceof Promise) result = await result;
    if (result.issues) {
      const msg = result.issues.map((iss) => iss.message).join("; ");
      throw new CredentialValidationError(`${input.key}: ${msg}`);
    }
    out[input.key] = result.value;
  }
  return out;
}
