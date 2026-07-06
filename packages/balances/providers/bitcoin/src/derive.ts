import { ProviderError } from "@folio/balances-basic";
import { sha256 } from "@noble/hashes/sha2";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { XPUB_VERSION_HEX } from "./constants";

// 扩展公钥 → 派生地址(纯离线,无网络)。用 @scure/bip32 解析 + 派生,@scure/btc-signer 编码地址
// (含 BIP341 taproot)。脚本类型由用户选,与扩展公钥前缀解耦(见 recommendedScript)。

export type ScriptType = "legacy" | "nested" | "native" | "taproot";
export const SCRIPT_TYPES = ["legacy", "nested", "native", "taproot"] as const;
export const isScriptType = (v: unknown): v is ScriptType =>
  typeof v === "string" && (SCRIPT_TYPES as readonly string[]).includes(v);

// SLIP-132 前缀 → 推荐脚本类型(add-account 预选、creds 缺省兜底)。
// ypub→Nested SegWit、zpub→Native SegWit;裸 xpub 歧义 → Native(今日多数资金为 segwit,用户可改)。
export function recommendedScript(ext: string): ScriptType {
  if (ext.startsWith("ypub")) return "nested";
  return "native";
}

// BIP purpose(脚本类型 → 派生路径 purpose)。用于展示派生路径(BitcoinMeta.addresses[].path)。
const PURPOSE: Record<ScriptType, number> = { legacy: 44, nested: 49, native: 84, taproot: 86 };
export const derivationPath = (script: ScriptType, chain: number, index: number): string =>
  `m/${PURPOSE[script]}'/0'/0'/${chain}/${index}`;

const b58c = base58check(sha256);
const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)));

// 任意扩展公钥(xpub/ypub/zpub)→ 换成 xpub 版本字节(公钥材料不变)。
// @scure/bip32 会校验版本字节,直接吃 ypub/zpub 报 "Version mismatch";脚本类型另由用户选,与前缀无关。
function toXpub(ext: string): string {
  let raw: Uint8Array;
  try {
    raw = b58c.decode(ext);
  } catch (cause) {
    throw new ProviderError("INVALID_CREDENTIALS", "invalid extended public key", { cause });
  }
  raw.set(hexToBytes(XPUB_VERSION_HEX), 0);
  return b58c.encode(raw);
}

function encodeAddress(pub: Uint8Array, script: ScriptType): string {
  const payment =
    script === "legacy"
      ? btc.p2pkh(pub)
      : script === "nested"
        ? btc.p2sh(btc.p2wpkh(pub))
        : script === "native"
          ? btc.p2wpkh(pub)
          : btc.p2tr(pub.slice(1)); // taproot:内部 key 为 x-only(去掉压缩前缀 → 32 bytes)
  if (!payment.address) {
    throw new ProviderError("PARSE_ERROR", "failed to encode bitcoin address");
  }
  return payment.address;
}

// 从账户级扩展公钥造派生器:解析一次,按 (chain, index) 出地址;chain 0=外部收款、1=找零。
// 缓存两条链节点,避免每次从 root 重派生。
export function makeDeriver(
  ext: string,
  script: ScriptType,
): (chain: number, index: number) => string {
  const xpub = toXpub(ext);
  let root: HDKey;
  try {
    root = HDKey.fromExtendedKey(xpub);
  } catch (cause) {
    throw new ProviderError("INVALID_CREDENTIALS", "invalid extended public key", { cause });
  }
  const chainNodes = new Map<number, HDKey>();
  const chainNode = (chain: number): HDKey => {
    const cached = chainNodes.get(chain);
    if (cached) return cached;
    const node = root.deriveChild(chain);
    chainNodes.set(chain, node);
    return node;
  };
  return (chain, index) => {
    const child = chainNode(chain).deriveChild(index);
    if (!child.publicKey) throw new ProviderError("PARSE_ERROR", "no public key derived");
    return encodeAddress(child.publicKey, script);
  };
}
