import type { ScriptType } from "@folio/balances";

// Bitcoin add-account 的脚本类型 UI 辅助(客户端安全:纯字符串,不引 @scure 派生库)。
// ScriptType 由 provider 定义、经 @folio/balances type-only 转发(单一事实源);此处只做前缀识别与预选,
// 与 provider 的 recommendedScript 同口径(那份含派生库,不能进客户端 bundle)。

export type { ScriptType };

// 脚本类型枚举值(anchored 到 provider 的 ScriptType):客户端下拉 + 服务端 z.enum 校验同源,
// 避免 accounts.ts 硬编码字面量漂移。本模块无 @scure 运行时,client/server 皆可 import。
export const SCRIPT_TYPE_VALUES = [
  "native",
  "nested",
  "taproot",
  "legacy",
] as const satisfies readonly ScriptType[];

// 下拉选项(推荐项排前);label 走 Inputs i18n。
export const BTC_SCRIPT_OPTIONS: { value: ScriptType; label: string }[] = [
  { value: "native", label: "Native SegWit" },
  { value: "nested", label: "Nested SegWit" },
  { value: "taproot", label: "Taproot" },
  { value: "legacy", label: "Legacy" },
];

const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

// 是否扩展公钥(xpub/ypub/zpub)—— 决定是否显示脚本类型下拉。
export const isExtendedPubkey = (id: string): boolean => EXT_PUBKEY_RE.test(id.trim());

// 前缀预选:ypub→Nested、zpub→Native、裸 xpub→Native(与 provider recommendedScript 一致)。
export function recommendedScript(id: string): ScriptType {
  return id.trim().startsWith("ypub") ? "nested" : "native";
}
