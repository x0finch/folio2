import { credentialSpecs } from "./registry";

// 各 connector 的账户输入规格(录入/补录表单动态生成字段用:secret→password、OKX 才有 passphrase)。
export function handleGetConnectorCredentialSpecs() {
  return credentialSpecs();
}
