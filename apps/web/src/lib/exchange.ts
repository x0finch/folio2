import { encrypt } from "@folio/core";

// 纯逻辑(无 server-only import → 可单测)。

export interface ExchangeCredentials {
  apiKey: string;
  secret: string;
  passphrase?: string;
}

// 把交易所只读密钥组装成加密凭据(真 secret,加密入库;见 arch §3)。
// passphrase 仅在提供时带上(binance 无、okx 有)。
export function buildExchangeCredentials(
  creds: ExchangeCredentials,
  secretsKey: string,
): Promise<string> {
  const payload = creds.passphrase
    ? { apiKey: creds.apiKey, secret: creds.secret, passphrase: creds.passphrase }
    : { apiKey: creds.apiKey, secret: creds.secret };
  return encrypt(JSON.stringify(payload), secretsKey);
}
