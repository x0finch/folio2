// 设置页 passkey 列表的展示辅助:认证器友好名(aaguid → 名字)+ 类型/同步类别。
// aaguid 映射数据取自 @better-auth/passkey 的 commonAuthenticatorNames —— 该导出在服务端 index,
// 前端直接 import 会把 SimpleWebAuthn 等服务端依赖一并打进 bundle,故这里复制这张纯数据表。见 ADR 0028。

// 认证器不透露型号时用的全零 aaguid → 视作「无名字」。
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

// aaguid → 友好名;无 / 全零 / 未知型号 → undefined(调用方回退到用户命名或通用「Passkey」)。
export function getAuthenticatorName(aaguid?: string | null): string | undefined {
  const normalized = aaguid?.trim().toLowerCase();
  if (!normalized || normalized === ANONYMOUS_AAGUID) return undefined;
  return COMMON_AUTHENTICATOR_NAMES[normalized];
}

// passkey 的类型/同步类别 —— 从 transports + backedUp 推断,给一个稳定 kind 供 i18n 取标签。
export type PasskeyKind = "synced" | "platform" | "security-key" | "cross-device" | "unknown";

export function passkeyKind(pk: {
  backedUp?: boolean | null;
  transports?: string | null;
}): PasskeyKind {
  const transports = pk.transports?.split(",").map((s) => s.trim()) ?? [];
  // 硬件安全钥匙(明确的物理认证器)优先判。
  if (transports.includes("usb") || transports.includes("nfc") || transports.includes("ble")) {
    return "security-key";
  }
  // 云同步的 passkey(iCloud 钥匙串 / Google 密码管理器等)—— 最有用的一条信息。
  if (pk.backedUp) return "synced";
  if (transports.includes("hybrid")) return "cross-device"; // 扫码跨设备用过
  if (transports.includes("internal")) return "platform"; // 本机生物识别,未同步
  return "unknown";
}
