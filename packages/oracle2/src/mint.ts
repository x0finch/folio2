import type { CgkRefStore, TokenSource, TokenStore } from "./stores";
import type { TokenRef, TokenSeed } from "./types";

export interface MintDeps {
  store: TokenStore;
  cgkRefs: CgkRefStore;
  source: TokenSource;
}

// 写路径要的那一步:拿一条 tokenRef 换出一个 `token_id`。**全程不碰网络** —— 查的是本地
// `token_refs`,miss 才查本地 `cgk_refs`。写快照之前必须先过这里(快照行的 token_id 必填)。
export interface Mint {
  // 一批 ref → 各自的 token_id。seed 是 provider 报的元信息(建行时用)。
  of(inputs: readonly MintInput[]): Promise<Map<TokenRef, string>>;
}

export interface MintInput {
  ref: TokenRef;
  seed: TokenSeed;
}

export function createMint({ store }: MintDeps): Mint {
  return {
    async of(inputs) {
      if (inputs.length === 0) return new Map();
      // 第一步:查 `token_refs`。绝大多数同步全部停在这里 —— 纯本地一次批量点查。
      return store.findByRefs([...new Set(inputs.map((i) => i.ref))]);
    },
  };
}
