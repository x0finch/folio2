import type {
  GlobalTokenRefIndexStore,
  ProviderTokenSeed,
  TokenCandidate,
  TokenRef,
  TokenRefHit,
  TokenStore,
} from "@folio/oracle-basic";
import { FIAT_NAMER, fiatSeed, normalizeSymbol } from "@folio/oracle-basic";
import {
  tokenRef as buildRef,
  hasTrustedSymbol,
  type ParsedTokenRef,
  parseTokenRef,
} from "@folio/oracle-ref";
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
    parsed: ParsedTokenRef,
    seed: ProviderTokenSeed,
  ): Promise<TokenRef | undefined> {
    // **这条 ref 本身就是上游的命名** —— 手记里用户选了币,报的就是 `<上游>/<id>`。
    // 它已经是锚,直接返回:不查映射表(那张表只装链上地址)、更不掉回 symbol 去猜一个
    // 用户已经明说了的答案。老 oracle 有这条短路,重写时漏了。
    if (parsed.kind === "issued" && parsed.namer === namer) return ref;

    // 全局表按地址查到的就是**整条** upstream ref(#228:表给整条,不再回半截让这里拼)。
    const upstreamRef = (await refIndex.lookup(namer, [ref])).get(ref);
    if (upstreamRef) return upstreamRef;

    // **symbol 那一档只放行「有背书人」的形状**(`native` / `issued`)—— 判据在文法里,
    // 见 `hasTrustedSymbol`。这里只剩一行,因为被挡掉的三种落在同一条理由下:
    // 合约的 symbol 是部署者随手填的,手敲的(`custom:`)压根没有背书人,读不懂的什么都不知道。
    //
    // 挡不住的代价是无声的:一个 symbol 写着 `USDC` 的山寨合约、或者用户在「找不到?手动输入」
    // 里敲的 `USDC`,会被策展表或市值排名判成「有把握」并进真 USDC —— 总枚数凭空多一百万,
    // 盯市的行直接多出一百万美元,而且认定冻进快照、永不重判(ADR 0020 第三、四轮)。
    if (!hasTrustedSymbol(parsed)) return undefined;

    const symbol = normalizeSymbol(seed.symbol);
    const override = overrides?.[symbol];
    if (override) return buildRef.issued(namer, override);
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

    const parsed = parseTokenRef(ref);

    // —— 法币:身份自锚,**绝不**查上游 / 按 symbol 猜(法币没有上游价,ADR 0025) ——
    // 白名单内(`SUPPORTED_CURRENCIES` 的 fiat)→ 建 / 复用一条 canonical 行(`symbol=CODE`、
    // 内嵌 logo);`fiat/` 但非白名单(或 `fiat/native` 之类畸形)→ 按未知处理:一条 plain 行、
    // 不乱认、不锚 canonical。**幂等**:同一法币复用同一行 —— 靠 `fiat/issued:CODE` 这条 ref 反查
    //(法币行没有当前源那一档 ref,故 `hit.linked` 恒 false,收敛点在这里而非上面那条短路)。
    if (parsed.kind !== "unknown" && parsed.namer === FIAT_NAMER) {
      if (hit) return hit.tokenId;
      const canonical = parsed.kind === "issued" ? fiatSeed(parsed.id) : undefined;
      return store.create(canonical ?? seed, [ref]);
    }

    const upstreamRef = await upstreamRefOf(ref, parsed, seed);

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
