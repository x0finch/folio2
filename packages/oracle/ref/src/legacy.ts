// 容旧 —— 库里躺着的历史串必须永远读得出来(ADR 0020),这不是过渡期措施。
// 本文件是容旧的**全部**:三条规则各一个函数,`token-ref.ts` 只在三处调用它们。
// 将来真把历史数据迁干净了,删本文件 + 那三处调用即可,规范文法一行不用动。

import { NATIVE } from "./constants";

// 旧的链命名者带 `chain:` 前缀(`chain:bitcoin`),短形去掉它。
// `eip155:<chainId>` 不在此列 —— 那个冒号是名字本身,不是前缀。
const CHAIN_PREFIX = "chain:";

// 旧 refKey 文法 `coingecko:<id>`:唯一的无斜杠合法形。
const SLASHLESS_NAMER = "coingecko";

export function stripLegacyChainPrefix(namer: string): string {
  return namer.startsWith(CHAIN_PREFIX) ? namer.slice(CHAIN_PREFIX.length) : namer;
}

// 无斜杠串按旧 refKey 文法读;不是那个形状则返回 null(调用方判为 unknown)。
export function parseLegacySlashless(
  trimmed: string,
  normalize: (s: string) => string,
): { namer: string; id: string } | null {
  const colon = trimmed.indexOf(":");
  if (colon < 0) return null;
  const namer = normalize(trimmed.slice(0, colon));
  const id = trimmed.slice(colon + 1).trim();
  if (namer !== SLASHLESS_NAMER || !id) return null;
  return { namer, id };
}

// 旧 native 串尾巴挂着 symbol(`native:btc`),从来没被读出来过 → 认出来,丢掉。
export function isLegacyNativeAsset(assetNs: string): boolean {
  return assetNs === NATIVE;
}
