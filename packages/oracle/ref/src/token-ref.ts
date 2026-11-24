// tokenRef: the only token naming in the system, `<namer>/<localName>`, exactly two segments.
// `namer` is "who gave the name" (`evm:42161` / `bitcoin` / `binance` / `coingecko`) and is mostly opaque here; the one exception
// is contract address case normalisation (`normalizeAddress`), which must know whether it is EVM.
// `localName` has four marked shapes (`native` is a full reserved word):
//   native              native gas coin
//   contract:<address>  contract address on a chain
//   issued:<id>         identifier the namer vouches for (venue ticker / upstream coin id / vendor id)
//   custom:<name>       caller-made name with no registry behind it (a user-typed symbol)
//   anything else       unknown
// Parsing is an allowlist: the fallback blocks. `binance/USDC` and `manual/USDC` are byte-identical, so only a marker tells them apart,
// and a forgotten marker must fail safe: marking the trusted side means a missed marker is untrusted (own row, no live price,
// visible and fixable), while marking the untrusted side would silently merge into the real USDC.
// The markers are fixed grammar constants, not producer-chosen words; the symbol tier must know what the right half is
// (`hasTrustedSymbol`). Not `erc20:` (SPL / Coin elsewhere), not `manual:` (an app connector id), not `symbol:`
// (`binance/issued:USDC` is a symbol too: the real divide is registry backing).
// Build with the `tokenRef.*` constructors; `parseTokenRef` / `formatTokenRef` round-trip. Only canonical forms are read; anything else is
// `unknown`, never a throw.

const SEP = "/";
// Reserved word: `native` appears only as a full localName (full match, not a fallback branch).
const NATIVE = "native";
// Valid localName markers; any other word (including the old grammar's `erc20:` / `token:`) is unknown.
const CONTRACT = "contract:";
const ISSUED = "issued:";
const CUSTOM = "custom:";
const EVM_NAMER_PREFIX = "evm:";

// Serialized form, the one in circulation: carried by Balance, stored, used as map key. An alias, not bare string, to say a tokenRef is wanted.
export type TokenRef = string;

// The four parsed branches. Build with `tokenRef.*`; this type is for parse, change a field, format back.
export type TokenRefParts =
  | { kind: "native"; namer: string }
  | { kind: "contract"; namer: string; address: string }
  | { kind: "issued"; namer: string; id: string }
  | { kind: "custom"; namer: string; name: string };

// Two-segment form: just left and right, no claim about the right half; the table storing two columns reads and writes this shape.
export interface TokenRefSegments {
  namer: string;
  localName: string;
}

// parse output: each branch also carries `localName` (the right segment's canonical form), plus `unknown` so any unreadable string has
// a home and parse never throws. `localName` is included because the two-column `token_refs` table needs it and parse already computes it;
// `TokenRefParts` is the constructor input, where carrying localName would give two contradictory ways to say one thing.
export type ParsedTokenRef =
  | (TokenRefParts & { localName: string })
  | { kind: "unknown"; raw: string };

/** Contract address case is per chain: EVM hex is case-insensitive and lowercased to a stable key; base58 / bech32 (Solana, Bitcoin, Tron) are case-sensitive and kept as is. The only place that must know the namer. */
function normalizeAddress(namer: string, address: string): string {
  const addr = address.trim();
  return namer.startsWith(EVM_NAMER_PREFIX) ? addr.toLowerCase() : addr;
}

/** Builds a tokenRef string; the caller gives the structure and `kind` is set here. Choosing a constructor declares the ref's evidence strength (see `hasTrustedSymbol`). Put into `issued` only what the namer really issued, not what a user typed. */
export const tokenRef = {
  native: (namer: string): TokenRef => `${normalizeNamer(namer)}${SEP}${NATIVE}`,

  contract: (namer: string, address: string): TokenRef => {
    const n = normalizeNamer(namer);
    return `${n}${SEP}${CONTRACT}${normalizeAddress(n, address)}`;
  },

  // Namer-issued ids are kept verbatim; normalisation is the producer's job.
  issued: (namer: string, id: string): TokenRef =>
    `${normalizeNamer(namer)}${SEP}${ISSUED}${id.trim()}`,

  // Caller-made names are uppercased by the grammar (like EVM address lowercasing), or `custom:usdc` and `custom:USDC` would be two rows.
  custom: (namer: string, name: string): TokenRef =>
    `${normalizeNamer(namer)}${SEP}${CUSTOM}${normalizeCustom(name)}`,
} as const;

/**
 * Whether the symbol this ref carries has a voucher; the shape is the evidence strength.
 * `native`: the chain's own symbol; native coins are not in the global map, so symbol is their only route.
 * `issued`: the namer vouches via a registry. `contract`: deployer-chosen symbol, a fake USDC must not merge into the real one.
 * `custom`: no voucher (typing `USDC` means "not the listed one"). `unknown`: a symbol of unknown origin is the worst guess.
 */
export function hasTrustedSymbol(parsed: ParsedTokenRef): boolean {
  return parsed.kind === "native" || parsed.kind === "issued";
}

/** Builds from either a semantic form `{kind, namer, address|id|name}` or a two-segment form `{namer, localName}` (for the two-column `token_refs` table, so storage need not know the right half's grammar). Both give the same parse output; the two-segment form does no grammar validation, since the table holds canonical forms only. */
export function formatTokenRef(ref: TokenRefParts | TokenRefSegments): TokenRef {
  // `kind` tells whether the caller made a claim about the right half: the semantic form has it, the two-segment form does not.
  const isSemantic = "kind" in ref;
  if (!isSemantic) return `${normalizeNamer(ref.namer)}${SEP}${ref.localName.trim()}`;
  switch (ref.kind) {
    case "native":
      return tokenRef.native(ref.namer);
    case "contract":
      return tokenRef.contract(ref.namer, ref.address);
    case "issued":
      return tokenRef.issued(ref.namer, ref.id);
    case "custom":
      return tokenRef.custom(ref.namer, ref.name);
  }
}

export function parseTokenRef(raw: TokenRef): ParsedTokenRef {
  const unknown = { kind: "unknown", raw } as const;
  // Exactly two segments: three (e.g. an NFT tokenId) mean nothing in this grammar and are unknown, not folded into localName.
  const segments = raw.trim().split(SEP);
  if (segments.length !== 2) return unknown;

  const namer = normalizeNamer(segments[0] ?? "");
  const localName = (segments[1] ?? "").trim();
  if (!namer || !localName) return unknown;

  // Every branch's localName is the canonical form (lowercase markers, `native`, EVM address; uppercase custom names), since it is written straight into the table.
  const lower = localName.toLowerCase();
  if (lower === NATIVE) return { kind: "native", namer, localName: NATIVE };

  if (lower.startsWith(CONTRACT)) {
    const address = normalizeAddress(namer, localName.slice(CONTRACT.length));
    return address ? { kind: "contract", namer, address, localName: CONTRACT + address } : unknown;
  }

  if (lower.startsWith(ISSUED)) {
    const id = localName.slice(ISSUED.length).trim();
    return id ? { kind: "issued", namer, id, localName: ISSUED + id } : unknown;
  }

  if (lower.startsWith(CUSTOM)) {
    const name = normalizeCustom(localName.slice(CUSTOM.length));
    return name ? { kind: "custom", namer, name, localName: CUSTOM + name } : unknown;
  }

  // No known marker matched: old grammar (`erc20:` / `token:` / `native:`), a producer-invented word, or a bare string (`manual/USDC`). The fallback blocks.
  // Silently reading it as a trusted opaque id was the hole this grammar closes.
  return unknown;
}

/** The namer's canonical form, also used to normalise the left segment when parsing; compare namers through it (`CoinGecko` vs `coingecko`). */
export function normalizeNamer(s: string): string {
  return s.trim().toLowerCase();
}

function normalizeCustom(s: string): string {
  return s.trim().toUpperCase();
}
