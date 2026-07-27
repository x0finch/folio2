// @folio/oracle-ref —— 代币命名法 `tokenRef`(ADR 0020)。零依赖、零 IO:
// 只做造串、拆串、拼回去,不查库、不认识 tokenId。
//
// `TokenRef` = 串(系统里流通的形式);`TokenRefParts` = 拆开的结构。

export {
  formatTokenRef,
  joinTokenRef,
  type ParsedTokenRef,
  parseTokenRef,
  type TokenRef,
  type TokenRefParts,
  tokenRef,
} from "./token-ref";
