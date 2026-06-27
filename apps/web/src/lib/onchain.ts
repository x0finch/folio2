import { encrypt } from "@folio/core";

// 纯逻辑(无 server-only import → 可单测、可被客户端侧 validator 安全引用)。

// EVM 地址:0x + 40 hex。供 onchain_evm 的 zod 校验地址格式用(其余链格式交各 provider/API 判定)。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// 把只读地址组装成加密凭据(地址=非私钥只读凭据,加密入库;见 arch §3)。链无关。
export function buildAddressCredentials(address: string, secretsKey: string): Promise<string> {
  return encrypt(JSON.stringify({ identifier: address }), secretsKey);
}
