// WebAuthn relying-party 参数从 BETTER_AUTH_URL 派生,跟着各自部署域名走(自托管适配,见 ADR 0028)。
// rpID = host(不含协议/端口,WebAuthn 规范要求);origin = 完整 origin(含端口,须匹配浏览器实际 origin)。
// 抽成纯函数是本特性少数能便宜自动化的测试缝(端到端注册/登录靠浏览器 + 真机目视)。

export const RP_NAME = "Folio";

export interface PasskeyRp {
  rpID: string;
  rpName: string;
  origin: string;
}

export function derivePasskeyRp(baseUrl: string): PasskeyRp {
  const url = new URL(baseUrl);
  return { rpID: url.hostname, rpName: RP_NAME, origin: url.origin };
}
