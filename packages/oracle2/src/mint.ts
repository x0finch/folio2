import { tokenRef as buildRef } from "@folio/oracle-ref";
import { pickBySymbol } from "./confidence";
import { CGK_NAMER, normalizeSymbol } from "./constants";
import type { CandidateSource, CgkRefStore, TokenRefHit, TokenStore } from "./stores";
import type { TokenRef, TokenSeed } from "./types";

export interface MintDeps {
  store: TokenStore;
  cgkRefs: CgkRefStore;
  candidates: CandidateSource;
  // symbol → CoinGecko coin id 的策展小表(majors + 已知撞名),优先于市值排名。防山寨撞名。
  overrides?: Readonly<Record<string, string>>;
}

// 写路径要的那一步:拿一条 tokenRef 换出一个 `token_id`。
//
// **全程不碰网络** —— 这不是约定而是类型事实:MintDeps 里根本没有 source。查的是本地
// `token_refs`,miss 才查本地 `cgk_refs`,再 miss 才按 symbol 猜。写快照之前必须先过这里
// (快照行的 token_id 必填),所以它必须是本地的、快的。
export interface Mint {
  // 一批 (ref, provider 报的元信息) → 各自的 token_id。输入里重复的 ref 只处理一次。
  of(inputs: readonly MintInput[]): Promise<Map<TokenRef, string>>;
}

export interface MintInput {
  ref: TokenRef;
  seed: TokenSeed;
}

export function createMint({ store, cgkRefs, candidates, overrides }: MintDeps): Mint {
  const cgkRefOf = (coinId: string): TokenRef => buildRef.local(CGK_NAMER, coinId);

  // 这条 ref 是哪个 CoinGecko 币 —— **地址优先于 symbol**。
  // 地址是权威答案,symbol 只是猜:换序会把假 USDC 并进真 USDC。
  async function coinIdOf(ref: TokenRef, seed: TokenSeed): Promise<string | undefined> {
    const byAddress = (await cgkRefs.lookup([ref])).get(ref);
    if (byAddress) return byAddress;

    const symbol = normalizeSymbol(seed.symbol);
    const override = overrides?.[symbol];
    if (override) return override;
    // 没把握的(同名混战的小币)返回 undefined → 各自独立建行、不链 CoinGecko。
    return pickBySymbol(await candidates.bySymbol(symbol));
  }

  // 一条 ref 的完整决策树。返回它最终指向的 token_id。
  async function mintOne(ref: TokenRef, seed: TokenSeed, hit?: TokenRefHit): Promise<string> {
    // 已经认出来过(有 coingecko 那条 ref)→ 什么都不用做,绝大多数行停在这。
    if (hit?.linked) return hit.tokenId;

    const coinId = await coinIdOf(ref, seed);

    // 还是认不出来。
    if (!coinId) {
      // 已有行:保持原样(只有 provider 那条 ref),下次 sync 再白查一次本地表自动补链。
      if (hit) return hit.tokenId;
      // 新行:只写 provider 那条 ref,快照照写 —— 不卡在 CoinGecko 上。
      return store.create(seed, [ref]);
    }

    const cgkRef = cgkRefOf(coinId);
    const owner = (await store.findByRefs([cgkRef])).get(cgkRef);

    // —— 认出来了 ——
    if (!hit) {
      // 这条 ref 头一次见。已有别的链的同一个币 → **只加一条 ref**(多链归一在这);
      // 否则建行 + 两条 ref(provider 的 + CoinGecko 的)。
      if (owner) {
        // 归一到已有 Token:**不覆盖**它已有的元信息(那可能是 CoinGecko 的好数据),只填空槽。
        await store.fillInfo(owner.tokenId, { name: seed.name, providerLogo: seed.logo });
        return store.linkRef(owner.tokenId, ref);
      }
      return store.create(seed, [ref, cgkRef]);
    }

    // —— 事后才认出来:合并 ——
    // 上次 `cgk_refs` 还没收录它,于是建了个只有 provider ref 的行;这次本地表认出来了。
    if (owner && owner.tokenId !== hit.tokenId) {
      // 已有别的行占着这个币 → 把旧行并进去:ref 改指、**历史快照的 token_id 一并改指**、旧行删。
      // 不改历史行的话,曲线会在合并那一刻断成两段。
      await store.merge(hit.tokenId, owner.tokenId);
      return owner.tokenId;
    }
    // 没人占着 → 就地补上 CoinGecko 那条 ref,行不动(它的历史、它的图都还在)。
    await store.linkRef(hit.tokenId, cgkRef);
    return hit.tokenId;
  }

  return {
    async of(inputs) {
      const out = new Map<TokenRef, string>();
      if (inputs.length === 0) return out;

      // 同一批里重复的 ref 只处理一次(一个钱包同一个币多笔持仓很常见)。
      const byRef = new Map<TokenRef, TokenSeed>();
      for (const i of inputs) if (!byRef.has(i.ref)) byRef.set(i.ref, i.seed);

      // 第一步:一次批量点查 `token_refs`。绝大多数同步全部停在这里 —— 纯本地。
      const hits = await store.findByRefs([...byRef.keys()]);

      // 逐条走决策树。**不加 barrier** —— 账户是并发跑的,同一条 ref 可能被同时 mint,
      // 靠 store 的 upsert-then-read 幂等收敛(见 TokenStore.create),不靠"先统一 mint 再并发写"。
      for (const [ref, seed] of byRef) {
        out.set(ref, await mintOne(ref, seed, hits.get(ref)));
      }
      return out;
    },
  };
}
