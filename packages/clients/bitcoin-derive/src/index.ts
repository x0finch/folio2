import { sha256 } from "@noble/hashes/sha2";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";

// @folio/bitcoin-derive —— 扩展公钥 → 派生地址(纯离线,无网络)。
// @scure/bip32 解析 + 非硬化派生,@scure/btc-signer 编码地址(含 BIP341 taproot)。
// 脚本类型由调用方选,与扩展公钥前缀解耦(见 recommendedScript)。

export type ScriptType = "legacy" | "nested" | "native" | "taproot";
export const SCRIPT_TYPES = ["legacy", "nested", "native", "taproot"] as const;
export const isScriptType = (v: unknown): v is ScriptType =>
  typeof v === "string" && (SCRIPT_TYPES as readonly string[]).includes(v);

export class BitcoinDeriveError extends Error {
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "BitcoinDeriveError";
  }
}

// SLIP-132 前缀 → 推荐脚本类型(UI 预选、缺省兜底)。
// ypub→Nested SegWit、zpub→Native SegWit;裸 xpub 歧义 → Native(今日多数资金为 segwit,可改)。
export function recommendedScript(ext: string): ScriptType {
  return ext.startsWith("ypub") ? "nested" : "native";
}

// BIP purpose(脚本类型 → 派生路径 purpose)。
const PURPOSE: Record<ScriptType, number> = { legacy: 44, nested: 49, native: 84, taproot: 86 };
export const derivationPath = (script: ScriptType, chain: number, index: number): string =>
  `m/${PURPOSE[script]}'/0'/0'/${chain}/${index}`;

// SLIP-132 版本字节(mainnet 公钥):脚本类型 ↔ 前缀一一对应。
const VERSION_HEX: Record<Exclude<ScriptType, "taproot">, string> = {
  legacy: "0488b21e", // xpub
  nested: "049d7cb2", // ypub
  native: "04b24746", // zpub
};
const b58c = base58check(sha256);
const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)));

// 任意扩展公钥 → 换成目标版本字节(公钥材料不变,仅换前缀语义)。base58 非法 → BitcoinDeriveError。
function reVersion(ext: string, versionHex: string): string {
  let raw: Uint8Array;
  try {
    raw = b58c.decode(ext);
  } catch (cause) {
    throw new BitcoinDeriveError("invalid extended public key", { cause });
  }
  raw.set(hexToBytes(versionHex), 0);
  return b58c.encode(raw);
}

// @scure/bip32 校验版本字节,直接吃 ypub/zpub 会 "Version mismatch" → 统一归成 xpub 再解析。
const toXpub = (ext: string): string => reVersion(ext, VERSION_HEX.legacy);

// 按脚本类型产出发给 Blockbook 的 token:legacy/nested/native → 对应 SLIP-132 前缀(xpub/ypub/zpub),
// 让 Blockbook 服务端按该脚本派生(与用户所选一致,不受粘贴前缀左右);taproot 无 SLIP-132 前缀 → tr(...) descriptor。
export function blockbookToken(ext: string, script: ScriptType): string {
  if (script === "taproot") return `tr(${toXpub(ext)})`;
  return reVersion(ext, VERSION_HEX[script]);
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
  if (!payment.address) throw new BitcoinDeriveError("failed to encode bitcoin address");
  return payment.address;
}

// 从账户级扩展公钥造派生器:解析一次,按 (chain, index) 出地址;chain 0=外部收款、1=找零。
// 缓存两条链节点,避免每次从 root 重派生。非法扩展公钥 → BitcoinDeriveError。
export function makeDeriver(
  ext: string,
  script: ScriptType,
): (chain: number, index: number) => string {
  const xpub = toXpub(ext);
  let root: HDKey;
  try {
    root = HDKey.fromExtendedKey(xpub);
  } catch (cause) {
    throw new BitcoinDeriveError("invalid extended public key", { cause });
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
    if (!child.publicKey) throw new BitcoinDeriveError("no public key derived");
    return encodeAddress(child.publicKey, script);
  };
}
