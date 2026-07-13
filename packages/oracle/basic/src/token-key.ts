// 代币寻址标识(TokenKey):带命名空间前缀、用来定位"这是哪个代币"的字符串 —— 全体系统一的
// 代币寻址方式,也是代币参考层(tokens/token_index)的索引键(唯一实现,勿再复制)。
// 不是"链上寻址"专属:标识空间跨多种寻址方案(链寻址 + 厂商寻址),来源不同、空间同一 ——
// Zerion 从 implementations、CoinStats 从 contractAddress、CGK/manual 从 coin id 都能产出它;
// vendor 私有 id(CgkCoinId)只是一种寻址方案,不比链寻址更"正统"。
//
// 文法(参照 CAIP-19:<namespace>/<asset_namespace>:<reference>):
//   eip155:<chainId>/erc20:<addr>    有数字 chainId 的 EVM 合约(标准形)
//   chain:<slug>/token:<addr>        无数字 chainId 的链寻址兜底(slug = source 链命名;稳定唯一)
//   eip155:<chainId>/native:<sym>    原生 gas 币(每链唯一 → chainId 已定身份,symbol 仅可读标签,不撞)
//   chain:<slug>/native:<sym>        无数字 chainId 的原生币兜底
//   coingecko:<coin-id>              厂商寻址:仅有 CGK coin id、无链上地址时(manual 选币/CEX 解析结果)
//   …/erc721:<addr>/<tokenId>        NFT(预留)
// 链/合约/symbol 小写归一,存查同口径。

export interface TokenKeyInput {
  chain?: string;
  chainId?: number;
  contract?: string;
  native?: boolean; // 该链原生 gas 币(无合约);symbol 作可读 reference
  symbol?: string; // 仅 native 用作 reference
  cgkId?: string; // CGK coin id(无链上寻址时的身份来源)
}

// chainId 有则 eip155,否则 slug 兜底;两者都缺 → 无链前缀可用。
function chainPrefix(input: TokenKeyInput): string | undefined {
  if (input.chainId != null && Number.isFinite(input.chainId)) return `eip155:${input.chainId}`;
  const chain = input.chain?.trim().toLowerCase();
  return chain ? `chain:${chain}` : undefined;
}

export function buildTokenKey(input: TokenKeyInput): string | undefined {
  const prefix = chainPrefix(input);
  const contract = input.contract?.trim().toLowerCase();
  if (contract && prefix) {
    return `${prefix}/${input.chainId != null ? "erc20" : "token"}:${contract}`;
  }
  // 原生币:chainId 唯一确定身份,symbol 仅作可读标签(每链原生币唯一,不撞名)。
  const sym = input.symbol?.trim().toLowerCase();
  if (input.native && prefix && sym) return `${prefix}/native:${sym}`;

  const cgkId = input.cgkId?.trim().toLowerCase();
  if (cgkId) return `coingecko:${cgkId}`;
  return undefined; // 无任何寻址 → 不产标识
}

// 解析 tokenKey(buildTokenKey 的逆):
//   chainRef = eip155 的数字 chainId 串 / chain: 的 slug —— 喂 source.fetchByContract(该函数按 slug 或
//   chainId 都能映射到 CGK 平台;用数字 chainId 反而更可靠,如 Arbitrum slug≠CGK平台名)。
export interface ParsedTokenKey {
  chainRef?: string;
  contract?: string;
  native?: boolean;
  cgkId?: string;
}
export function parseTokenKey(id: string): ParsedTokenKey {
  if (id.startsWith("coingecko:")) return { cgkId: id.slice("coingecko:".length) };
  const slash = id.indexOf("/");
  if (slash < 0) return {};
  const chainPart = id.slice(0, slash); // eip155:42161 | chain:solana
  const assetPart = id.slice(slash + 1); // erc20:0x… | token:… | native:eth
  const chainRef = chainPart.startsWith("eip155:")
    ? chainPart.slice("eip155:".length)
    : chainPart.startsWith("chain:")
      ? chainPart.slice("chain:".length)
      : undefined;
  const colon = assetPart.indexOf(":");
  if (colon < 0) return { chainRef };
  const ns = assetPart.slice(0, colon);
  const ref = assetPart.slice(colon + 1);
  if (ns === "native") return { chainRef, native: true };
  return { chainRef, contract: ref };
}
