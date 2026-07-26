import { tokenRef as buildRef, parseTokenRef } from "@folio/oracle-ref";
import type {
  GlobalTokenRefIndexStore,
  ProviderTokenSeed,
  TokenCandidate,
  TokenRef,
  TokenRefHit,
  TokenStore,
} from "@folio/oracle2-basic";
import { normalizeSymbol } from "@folio/oracle2-basic";
import { pickByConfidence } from "./confidence";

// symbol 消歧的候选源。候选恒是 warm 集的子集 → 由 cache 从同一个 blob 里筛(见 cache.ts),
// 不单独存。做成端口是为了让 mint **在类型上就够不着网络**(见下)。
export interface CandidateSource {
  bySymbol(symbol: string): Promise<TokenCandidate[]>;
}

export interface MintDeps {
  store: TokenStore;
  refIndex: GlobalTokenRefIndexStore;
  candidates: CandidateSource;
  // 当前源的标识 —— 它同时是 ref 的 namer 与全局映射表的 `namer` 列。由门面从注入的 upstream 取。
  namer: string;
  // symbol → 上游 id 的策展小表(majors + 已知撞名),优先于市值排名。防山寨撞名。
  // **由 adapter 提供** —— 逐条写的都是某一家的 id,不该硬编码在中立的这一层(ADR 0023)。
  overrides?: Readonly<Record<string, string>>;
}

// 写路径要的那一步:拿一条 tokenRef 换出一个 `token_id`。
//
// **全程不碰网络** —— 这不是约定而是类型事实:MintDeps 里根本没有 upstream。查的是本地 ref 行,
// miss 才查本地全局映射,再 miss 才按 symbol 猜。写快照之前必须先过这里(快照行的 token_id 必填),
// 所以它必须是本地的、快的。
export interface Mint {
  // 一批 (ref, provider 报的元信息) → 各自的 token_id。输入里重复的 ref 只处理一次。
  of(inputs: readonly MintInput[]): Promise<Map<TokenRef, string>>;
}

export interface MintInput {
  ref: TokenRef;
  seed: ProviderTokenSeed;
}

export function createMint({ store, refIndex, candidates, namer, overrides }: MintDeps): Mint {
  // 这条 ref 在当前上游那里叫什么 —— **地址优先于 symbol**。
  // 地址是权威答案,symbol 只是猜:换序会把假 USDC 并进真 USDC。
  async function upstreamRefOf(
    ref: TokenRef,
    seed: ProviderTokenSeed,
  ): Promise<TokenRef | undefined> {
    // **这条 ref 本身就是上游的命名** —— 手记里用户选了币,报的就是 `<上游>/<id>`。
    // 它已经是锚,直接返回:不查映射表(那张表只装链上地址)、更不掉回 symbol 去猜一个
    // 用户已经明说了的答案。老 oracle 有这条短路,重写时漏了。
    const parsed = parseTokenRef(ref);
    if (parsed.kind === "opaque" && parsed.namer === namer) return ref;

    const byAddress = (await refIndex.lookup(namer, [ref])).get(ref);
    if (byAddress) return buildRef.opaque(namer, byAddress);

    // **合约不许按 symbol 猜。** 合约的 symbol 字段是部署者随手填的 —— 地址那一档查不到,
    // 就该老实认不出来,而不是拿一个可以伪造的字符串去认。一个 symbol 写着 `USDC` 的山寨合约
    // 若走到下面,会被策展表或市值排名判成「有把握」并进真 USDC:总枚数凭空多一百万,盯市的行
    // 直接多出一百万美元,而且认定冻进快照、永不重判(ADR 0020 第三轮)。
    // 原生币与场馆代号相反:`bitcoin/native` 的 BTC、`binance/USDC` 的上架代号都可信,而原生币
    // 按设计不进全局映射表(ADR 0022),symbol 是它们**唯一**的一条路 —— 所以放行那两支。
    // 读不懂的串一并挡掉:关于它我们什么都不知道,凭一个来源不明的 symbol 认币是最坏的一种猜。
    if (parsed.kind === "contract" || parsed.kind === "unknown") return undefined;

    const symbol = normalizeSymbol(seed.symbol);
    const override = overrides?.[symbol];
    if (override) return buildRef.opaque(namer, override);
    // 没把握的(同名混战的小币)返回 undefined → 各自独立建行、不链上游。
    return pickByConfidence(await candidates.bySymbol(symbol));
  }

  // 一条 ref 的完整决策树。返回它最终指向的 token_id。
  async function mintOne(
    ref: TokenRef,
    seed: ProviderTokenSeed,
    hit?: TokenRefHit,
  ): Promise<string> {
    // 已经认出来过(有当前源的 ref 行)→ 什么都不用做,绝大多数行停在这。
    if (hit?.linked) return hit.tokenId;

    const upstreamRef = await upstreamRefOf(ref, seed);

    // 还是认不出来。
    if (!upstreamRef) {
      // 已有行:保持原样(只有 provider 那条 ref),下次 sync 再白查一次本地表自动补链。
      if (hit) return hit.tokenId;
      // 新行:只写 provider 那条 ref,快照照写 —— 不卡在上游上。
      return store.create(seed, [ref]);
    }

    const owner = (await store.findByRefs([upstreamRef])).get(upstreamRef);

    // —— 认出来了 ——
    if (!hit) {
      // 这条 ref 头一次见。已有别的链的同一个币 → **只加一条 ref**(多链归一在这);
      // 否则建行 + 两条 ref(provider 的 + 上游的)。
      if (owner) {
        // 归一到已有 Token:**不覆盖**它已有的元信息(那可能是上游的好数据),只填空槽。
        await store.fillInfo(owner.tokenId, { name: seed.name, providerLogo: seed.providerLogo });
        return store.linkRef(owner.tokenId, ref);
      }
      // 去重:ref 本身就是上游命名时两者相同(手记选币),而 ref 行的主键是 (namer, localName)
      // —— 同一批插两条相同的行会撞主键、整批写失败。
      return store.create(seed, [...new Set([ref, upstreamRef])]);
    }

    // —— 事后才认出来:合并 ——
    // 上次全局映射还没收录它,于是建了个只有 provider ref 的行;这次本地表认出来了。
    if (owner && owner.tokenId !== hit.tokenId) {
      // 已有别的行占着这个币 → 把旧行并进去:ref 改指、**历史快照的 token_id 一并改指**、旧行删。
      // 不改历史行的话,曲线会在合并那一刻断成两段。
      await store.merge(hit.tokenId, owner.tokenId);
      return owner.tokenId;
    }
    // 没人占着 → 就地补上上游那条 ref,行不动(它的历史、它的图都还在)。
    await store.linkRef(hit.tokenId, upstreamRef);
    return hit.tokenId;
  }

  return {
    async of(inputs) {
      const out = new Map<TokenRef, string>();
      if (inputs.length === 0) return out;

      // 同一批里重复的 ref 只处理一次(一个钱包同一个币多笔持仓很常见)。
      const byRef = new Map<TokenRef, ProviderTokenSeed>();
      for (const i of inputs) if (!byRef.has(i.ref)) byRef.set(i.ref, i.seed);

      // 第一步:一次批量点查本地 ref 行。绝大多数同步全部停在这里 —— 纯本地。
      const hits = await store.findByRefs([...byRef.keys()]);

      // 逐条走决策树。**不加 barrier** —— 账户是并发跑的,同一条 ref 可能被同时 mint,
      // 靠 store 的 upsert-then-read 幂等收敛(见 TokenStore.create),不靠「先统一 mint 再并发写」。
      for (const [ref, seed] of byRef) {
        out.set(ref, await mintOne(ref, seed, hits.get(ref)));
      }
      return out;
    },
  };
}
