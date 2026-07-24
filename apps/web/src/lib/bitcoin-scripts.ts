// Bitcoin add-account 的脚本类型 UI 辅助(客户端安全:纯字符串,不引 @scure 派生库)。
// ScriptType 本地定义(与 @folio/bitcoin-derive 的 provider 侧同口径;那份含 @scure 派生库,不能进客户端 bundle)。

// bitcoin 派生脚本类型(与 blockbook/@folio/bitcoin-derive 一致的四值)。
export type ScriptType = "native" | "nested" | "taproot" | "legacy";

// 下拉选项(推荐项排前);label 走 Inputs i18n,addressPrefix 提示该类型派生地址的开头(语言无关,直接展示)。
export const BTC_SCRIPT_OPTIONS: { value: ScriptType; label: string; addressPrefix: string }[] = [
  { value: "native", label: "Native SegWit", addressPrefix: "bc1q…" },
  { value: "nested", label: "Nested SegWit", addressPrefix: "3…" },
  { value: "taproot", label: "Taproot", addressPrefix: "bc1p…" },
  { value: "legacy", label: "Legacy", addressPrefix: "1…" },
];

const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

// 是否扩展公钥(xpub/ypub/zpub)。
export const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id.trim());
// 是否裸 xpub —— 只有它脚本类型才歧义、需用户选;ypub/zpub 前缀已定,展示为只读。
export const isBareXpub = (id: string): boolean => id.trim().startsWith("xpub");

// 前缀预选/识别:ypub→Nested、zpub→Native、裸 xpub→Native(与 provider recommendedScript 一致)。
export function recommendedScript(id: string): ScriptType {
  return id.trim().startsWith("ypub") ? "nested" : "native";
}
