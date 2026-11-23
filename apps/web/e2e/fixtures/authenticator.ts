import type { CDPSession, Page } from "@playwright/test";

/**
 * CDP virtual authenticator: lets WebAuthn run full ceremonies unattended in CI.
 * Unit tests can only mock `authClient.passkey.*`, so what the browser and authenticator decide (whether registration really restricts to platform,
 * whether unlock really requires user verification) goes unchecked. The DevTools Protocol's WebAuthn domain gives a software authenticator that can
 * create credentials, sign assertions and be set to fail user verification, on the same path as real hardware.
 * `transport: "internal"` is a platform authenticator; testing that the unrestricted plus button also accepts a security key needs a separate
 * `transport: "usb"` one (see addAuthenticator's options).
 */
export interface VirtualAuthenticator {
  id: string;
  /** Makes the next ceremony's user verification fail (simulates a fingerprint mismatch / user cancel). */
  setUserVerified(verified: boolean): Promise<void>;
  /** The credentials currently on this authenticator (to assert registration really landed locally). */
  credentials(): Promise<
    Array<{ credentialId: string; rpId: string; isResidentCredential: boolean }>
  >;
  /**
   * Clears the credentials but keeps the authenticator: "this device has no passkey at all".
   * Don't change this to `remove()`: tearing the whole authenticator down flips `isConditionalMediationAvailable()` to false, so the login page's autofill
   * never even requests options, and `gotoHydrated("/login")` uses that request as its "client is alive" signal (see HYDRATION_PROBE in fixtures/app.ts)
   * and would time out. Keeping the authenticator and clearing credentials lets autofill start as usual with no credential to answer.
   */
  clearCredentials(): Promise<void>;
  remove(): Promise<void>;
}

export interface AuthenticatorOptions {
  /** internal = platform authenticator (Touch ID kind); usb = hardware security key. */
  transport?: "internal" | "usb";
  /** Discoverable credential. The login page sets no allowCredentials, so this is what lets it be listed. */
  hasResidentKey?: boolean;
  /** Whether the authenticator itself supports user verification. false simulates old "just tap" security keys. */
  hasUserVerification?: boolean;
  /** Whether user verification has passed in the initial state. */
  isUserVerified?: boolean;
}

// CDP emits standard base64 (with +/=) while WebAuthn and better-auth use base64url throughout; comparing it directly with the credentialID
// in localStorage never matches, so convert at the fixture layer instead of in every test.
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
      // Auto-"press": otherwise every ceremony needs explicit user-presence simulation and the test hangs waiting for a finger that never comes.
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
    async clearCredentials() {
      await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    },
    async remove() {
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
    },
  };
}
