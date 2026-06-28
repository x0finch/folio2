import type { ProviderInput } from "./provider";

// ProviderInput[] 的纯工具(库无关:只用 Standard Schema 接口,不依赖 zod)。

// 敏感字段(导出时剥离)与公开字段(如 identifier 地址,导出保留)。
export function secretKeys(inputs: readonly ProviderInput[]): string[] {
  return inputs.filter((i) => i.type === "secret").map((i) => i.key);
}
export function publicKeys(inputs: readonly ProviderInput[]): string[] {
  return inputs.filter((i) => i.type !== "secret").map((i) => i.key);
}

export class CredentialValidationError extends Error {}

// 逐字段跑各 input 的 Standard Schema 校验,产出已校验的 creds(只含 inputs 声明的字段);任一不过
// 即抛 CredentialValidationError(`<key>: <message>`)。创建账户与同步(构造 FetchContext 前)共用 →
// ctx.creds 在运行时即保证符合 inputs,给 CredsOf 类型以运行时背书。
export async function validateCredentials(
  inputs: readonly ProviderInput[],
  values: Record<string, unknown>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
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
