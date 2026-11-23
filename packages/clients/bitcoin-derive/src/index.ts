import { sha256 } from "@noble/hashes/sha2";
import { base58check } from "@scure/base";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";

// @folio/bitcoin-derive: extended public key to derived addresses (pure offline, no network). @scure/bip32 parses and derives
// non-hardened; @scure/btc-signer encodes addresses (including BIP341 taproot). The script type is chosen by the caller, decoupled from the key prefix.

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

// SLIP-132 prefix to recommended script type (UI preselection, default fallback): ypub is Nested SegWit, zpub Native SegWit; a bare xpub is ambiguous, so Native (most funds are segwit today).
export function recommendedScript(ext: string): ScriptType {
  return ext.startsWith("ypub") ? "nested" : "native";
}

// BIP purpose (script type to derivation path purpose).
const PURPOSE: Record<ScriptType, number> = { legacy: 44, nested: 49, native: 84, taproot: 86 };
export const derivationPath = (script: ScriptType, chain: number, index: number): string =>
  `m/${PURPOSE[script]}'/0'/0'/${chain}/${index}`;

// SLIP-132 version bytes (mainnet public key): script type and prefix map one to one.
const VERSION_HEX: Record<Exclude<ScriptType, "taproot">, string> = {
  legacy: "0488b21e", // xpub
  nested: "049d7cb2", // ypub
  native: "04b24746", // zpub
};
const b58c = base58check(sha256);
const hexToBytes = (h: string): Uint8Array =>
  Uint8Array.from((h.match(/.{2}/g) ?? []).map((b) => Number.parseInt(b, 16)));

// Any extended public key to the target version bytes (key material unchanged, only the prefix semantics); invalid base58 gives BitcoinDeriveError.
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

// @scure/bip32 validates version bytes and feeding it a ypub/zpub throws "Version mismatch", so normalise to xpub before parsing.
const toXpub = (ext: string): string => reVersion(ext, VERSION_HEX.legacy);

// Input for Blockbook's /xpub endpoint (an extended key or a descriptor, hence not called "token", to distinguish from the address-level XpubToken):
// legacy/nested/native normalise to the matching SLIP-132 prefix so Blockbook derives per that script, matching the user's choice regardless of the pasted prefix;
// taproot has no SLIP-132 prefix, so a tr(...) descriptor.
export function blockbookXpubParam(ext: string, script: ScriptType): string {
  if (script === "taproot") return `tr(${toXpub(ext)})`;
  return reVersion(ext, VERSION_HEX[script]);
}

// Script type to address encoder (map form, like PURPOSE/VERSION_HEX; adding a script type touches only this place). Taproot's internal key is x-only (strip the 33-byte compressed prefix to 32 bytes).
const ENCODERS: Record<ScriptType, (pub: Uint8Array) => { address?: string }> = {
  legacy: (pub) => btc.p2pkh(pub),
  nested: (pub) => btc.p2sh(btc.p2wpkh(pub)),
  native: (pub) => btc.p2wpkh(pub),
  taproot: (pub) => btc.p2tr(pub.slice(1)),
};

function encodeAddress(pub: Uint8Array, script: ScriptType): string {
  const { address } = ENCODERS[script](pub);
  if (!address) throw new BitcoinDeriveError("failed to encode bitcoin address");
  return address;
}

// Builds a deriver from an account-level extended public key: parse once, derive addresses by (chain, index); chain 0 = external, 1 = change.
// Caches the two chain nodes to avoid re-deriving from the root; an invalid key gives BitcoinDeriveError.
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
