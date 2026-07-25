// @folio/oracle-ref —— 代币命名法 `tokenRef`(ADR 0020)。零依赖、零 IO:
// 只做造串、拆串、拼回去,不查库、不认识 tokenId。

export {
  formatTokenRef,
  normalizeAddress,
  type ParsedTokenRef,
  parseTokenRef,
  type TokenRef,
  tokenRef,
} from "./token-ref";
