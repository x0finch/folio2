// @folio/oracle-ref —— 代币命名法 `tokenRef`(ADR 0020)。零依赖、零 IO:
// 只做切斜杠、解右段、拼回去,不查库、不认识 tokenId、也不给命名者分类。

export {
  formatTokenRef,
  type ParsedTokenRef,
  parseTokenRef,
  type TokenRef,
} from "./token-ref";
