// Copied from @better-auth/passkey's commonAuthenticatorNames: that export lives in the server
// entry, and importing it would bundle SimpleWebAuthn into the client.

// All-zero aaguid = the authenticator doesn't disclose its model.
const ANONYMOUS_AAGUID = "00000000-0000-0000-0000-000000000000";

const COMMON_AUTHENTICATOR_NAMES: Record<string, string> = {
  "ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
  "fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
  "dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
  "08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
  "9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
  "6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
  "bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
  "d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
  "531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
  "b78a0a55-6ef8-d246-a042-ba0f6d55050c": "LastPass",
  "b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
  "50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
  "0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
  "53414d53-554e-4700-0000-000000000000": "Samsung Pass",
};

export function getAuthenticatorName(aaguid?: string | null): string | undefined {
  const normalized = aaguid?.trim().toLowerCase();
  if (!normalized || normalized === ANONYMOUS_AAGUID) return undefined;
  return COMMON_AUTHENTICATOR_NAMES[normalized];
}

export type PasskeyKind = "synced" | "platform" | "security-key" | "cross-device" | "unknown";

export function passkeyKind(pk: {
  backedUp?: boolean | null;
  transports?: string | null;
}): PasskeyKind {
  const transports = pk.transports?.split(",").map((s) => s.trim()) ?? [];
  if (transports.includes("usb") || transports.includes("nfc") || transports.includes("ble")) {
    return "security-key";
  }
  if (pk.backedUp) return "synced";
  if (transports.includes("hybrid")) return "cross-device";
  if (transports.includes("internal")) return "platform";
  return "unknown";
}

// Default name stored at registration (passkeys carry no browser info). Order matters: Chrome's UA
// contains "Safari" and Edge's contains "Chrome", so the more specific checks come first.
export function detectDeviceLabel(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Mac OS X|Macintosh/.test(ua)
        ? "macOS"
        : /Windows/.test(ua)
          ? "Windows"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? "Passkey";
}
