import type { CDPSession, Page } from "@playwright/test";

/**
 * CDP 虚拟认证器 —— 让 WebAuthn 在无人值守的 CI 里跑完整 ceremony(#354)。
 *
 * 单元测试只能 mock `authClient.passkey.*`,于是「注册有没有真限定 platform」「解锁到底要不要过
 * 用户验证」这类**由浏览器和认证器裁决**的事一条都验不到 —— 那恰好是 #353 整套方案的地基。
 * Chrome DevTools Protocol 的 WebAuthn 域给的是一个软件实现的认证器:能建凭据、能签断言、能被
 * 编程地设成「用户验证失败」,行为路径与真硬件同一条。
 *
 * 注意 `transport: "internal"` —— 平台认证器。测「不限 platform 的加号也能收安全钥匙」时要另开一个
 * `transport: "usb"` 的,见 addAuthenticator 的参数。
 */
export interface VirtualAuthenticator {
  id: string;
  /** 让下一次 ceremony 的用户验证失败(模拟指纹认不过 / 用户取消)。 */
  setUserVerified(verified: boolean): Promise<void>;
  /** 这个认证器上现存的凭据(断言注册确实落在了本机)。 */
  credentials(): Promise<
    Array<{ credentialId: string; rpId: string; isResidentCredential: boolean }>
  >;
  remove(): Promise<void>;
}

export interface AuthenticatorOptions {
  /** internal = 平台认证器(Touch ID 那类);usb = 硬件安全钥匙。 */
  transport?: "internal" | "usb";
  /** 可发现凭据。登录页不设 allowCredentials,靠这个才列得出来。 */
  hasResidentKey?: boolean;
  /** 认证器本身支不支持用户验证。false 用来模拟「按一下就行」的老式安全钥匙。 */
  hasUserVerification?: boolean;
  /** 初始状态下用户验证过没有。 */
  isUserVerified?: boolean;
}

// CDP 吐的是标准 base64(带 +/=),而 WebAuthn 和 better-auth 一路用的是 base64url —— 直接拿去和
// localStorage 里存的 credentialID 比会永远不等。在夹具这一层转掉,免得每条测试各自记着。
function toBase64Url(standardBase64: string): string {
  return standardBase64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function addAuthenticator(
  page: Page,
  opts: AuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const {
    transport = "internal",
    hasResidentKey = true,
    hasUserVerification = true,
    isUserVerified = true,
  } = opts;

  const cdp: CDPSession = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport,
      hasResidentKey,
      hasUserVerification,
      isUserVerified,
      // 自动「按下」——否则每次 ceremony 都要显式模拟用户在场,测试会卡住等一个永不到来的手指。
      automaticPresenceSimulation: true,
    },
  });

  return {
    id: authenticatorId,
    async setUserVerified(verified) {
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: verified });
    },
    async credentials() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials.map((c) => ({
        credentialId: toBase64Url(c.credentialId),
        rpId: c.rpId ?? "",
        isResidentCredential: c.isResidentCredential,
      }));
    },
    async remove() {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    },
  };
}
