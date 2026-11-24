// @folio/oracle-ref: the `tokenRef` naming scheme. Zero dependencies, zero IO: only builds and parses strings.
// `TokenRef` is the string form in circulation; `TokenRefParts` is the split structure.

export {
  formatTokenRef,
  hasTrustedSymbol,
  normalizeNamer,
  type ParsedTokenRef,
  parseTokenRef,
  type TokenRef,
  type TokenRefParts,
  tokenRef,
} from "./token-ref";
