import { encrypt } from "@folio/core";

// 纯逻辑(无 server-only import → 可单测、不进客户端敏感面)。

// EVM 地址:0x + 40 hex。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// 校验并归一化 EVM 地址;非法抛出清晰错误(不发任何请求)。
export function normalizeEvmAddress(address: string): string {
  const a = address?.trim();
  if (!a || !EVM_ADDRESS_RE.test(a)) {
    throw new Error("invalid EVM address (expected 0x + 40 hex)");
  }
  return a;
}

// 把只读地址组装成加密凭据(地址=非私钥只读凭据,加密入库;见 arch §3)。
export function buildEvmCredentials(address: string, secretsKey: string): Promise<string> {
  return encrypt(JSON.stringify({ identifier: address }), secretsKey);
}
