import type { ProviderTokenSeed, TokenRef, TokenRefHit } from "@folio/oracle-basic";
import { FIAT_NAMER, fiatSeed, normalizeSymbol } from "@folio/oracle-basic";
import { GlobalTokenRefIndexStore, Namer, TokenStore } from "@folio/oracle-basic/ports";
import {
  tokenRef as buildRef,
  hasTrustedSymbol,
  type ParsedTokenRef,
  parseTokenRef,
} from "@folio/oracle-ref";
import { Context, Effect, Layer, Option } from "effect";
import { pickByConfidence } from "../internal/confidence";
import { CandidateSource } from "./candidates";

// 写路径要的那一步:拿一条 tokenRef 换出一个 `token_id`。
//
// **全程不碰网络** —— 这不是约定而是**类型事实**,而且现在在 `R` 通道上一眼看得见:
// 这个 layer 要的是 `TokenStore | GlobalTokenRefIndexStore | CandidateSource | Namer`,
// 里面没有 `TokenUpstream`。查的是本地 ref 行,miss 才查本地全局映射,再 miss 才按 symbol 猜
// (那一档问 `CandidateSource`,它读的是缓存目录 —— 唯一那条冷启动出网路径收在它自己的 layer 里)。
// 写快照之前必须先过这里(快照行的 token_id 必填),所以它必须是本地的、快的。
export interface TokenMinter {
  // 一批 (ref, provider 报的元信息) → 各自的 token_id。输入里重复的 ref 只处理一次。
  of(inputs: readonly MintInput[]): Effect.Effect<Map<TokenRef, string>>;
}

export interface MintInput {
  ref: TokenRef;
  seed: ProviderTokenSeed;
}

export const TokenMinter = Context.GenericTag<TokenMinter>("oracle/TokenMinter");

const make = Effect.gen(function* () {
  const store = yield* TokenStore;
  const refIndex = yield* GlobalTokenRefIndexStore;
  const candidates = yield* CandidateSource;
  // 当前源的标识 —— 它同时是 ref 的 namer 与全局映射表的 `namer` 列;`overrides` 是它那张
  // symbol → 上游 id 的策展小表(见 `Namer`)。
  const { id: namer, overrides } = yield* Namer;

  // 这条 ref 在当前上游那里叫什么 —— **地址优先于 symbol**。
  // 地址是权威答案,symbol 只是猜:换序会把假 USDC 并进真 USDC。
  const upstreamRefOf = (
    ref: TokenRef,
    parsed: ParsedTokenRef,
    seed: ProviderTokenSeed,
  ): Effect.Effect<Option.Option<TokenRef>> =>
    Effect.gen(function* () {
      // **这条 ref 本身就是上游的命名** —— 手记里用户选了币,报的就是 `<上游>/<id>`。
      // 它已经是锚,直接返回:不查映射表(那张表只装链上地址)、更不掉回 symbol 去猜一个
      // 用户已经明说了的答案。老 oracle 有这条短路,重写时漏了。
      if (parsed.kind === "issued" && parsed.namer === namer) return Option.some(ref);

      // 全局表按地址查到的就是**整条** upstream ref(#228:表给整条,不再回半截让这里拼)。
      const found = yield* refIndex.lookup(namer, [ref]);
      const upstreamRef = Option.fromNullable(found.get(ref));
      if (Option.isSome(upstreamRef)) return upstreamRef;

      // **symbol 那一档只放行「有背书人」的形状**(`native` / `issued`)—— 判据在文法里,
      // 见 `hasTrustedSymbol`。这里只剩一行,因为被挡掉的三种落在同一条理由下:
      // 合约的 symbol 是部署者随手填的,手敲的(`custom:`)压根没有背书人,读不懂的什么都不知道。
      //
      // 挡不住的代价是无声的:一个 symbol 写着 `USDC` 的山寨合约、或者用户在「找不到?手动输入」
      // 里敲的 `USDC`,会被策展表或市值排名判成「有把握」并进真 USDC —— 总枚数凭空多一百万,
      // 盯市的行直接多出一百万美元,而且认定冻进快照、永不重判(ADR 0020 第三、四轮)。
      if (!hasTrustedSymbol(parsed)) return Option.none();

      const symbol = normalizeSymbol(seed.symbol);
      const override = overrides[symbol];
      if (override) return Option.some(buildRef.issued(namer, override));
      // 没把握的(同名混战的小币)返回 none → 各自独立建行、不链上游。
      return Option.fromNullable(pickByConfidence(yield* candidates.bySymbol(symbol)));
    });

  // 一条 ref 的完整决策树。返回它最终指向的 token_id。
  const mintOne = (
    ref: TokenRef,
    seed: ProviderTokenSeed,
    hit: TokenRefHit | undefined,
  ): Effect.Effect<string> =>
    Effect.gen(function* () {
      // 已经认出来过(有当前源的 ref 行)→ 什么都不用做,绝大多数行停在这。
      if (hit?.linked) return hit.tokenId;

      const parsed = parseTokenRef(ref);

      // 法币走独立分支:身份自锚,**绝不**查上游 / 按 symbol 猜(法币没有上游价,ADR 0025)。
      // 必须在 `upstreamRefOf` 之前短路 —— 否则 USD 现金会被 symbol 那档猜进某个叫 USD 的代币。
      const isFiat = parsed.kind !== "unknown" && parsed.namer === FIAT_NAMER;
      if (isFiat) {
        // 同一法币再 mint → 复用既有 canonical 行(靠 `fiat/issued:CODE` 反查)。法币没链上游,
        // 上面那条 `hit?.linked` 短路截不到、收敛在此。`store.create` 本身也按 ref 幂等(撞主键
        // onConflictDoNothing + upsert-then-read),所以这行不是正确性必需 —— 只省掉「白建一行再删
        // 孤行」的 churn,并与下面通用分支同款 `hit → 复用` 保持一致。
        if (hit) return hit.tokenId;
        // 白名单内(`SUPPORTED_CURRENCIES` 的 fiat)→ canonical seed(`symbol=CODE` + 内嵌 logo);
        // 非白名单(含 `fiat/native` 之类畸形)→ 用 provider seed 建一条 plain 行,不乱认、不锚 canonical。
        const canonical = parsed.kind === "issued" ? fiatSeed(parsed.id) : undefined;
        return yield* store.create(canonical ?? seed, [ref]);
      }

      const upstreamRef = yield* upstreamRefOf(ref, parsed, seed);

      // 还是认不出来。
      if (Option.isNone(upstreamRef)) {
        // 已有行:保持原样(只有 provider 那条 ref),下次 sync 再白查一次本地表自动补链。
        if (hit) return hit.tokenId;
        // 新行:只写 provider 那条 ref,快照照写 —— 不卡在上游上。
        return yield* store.create(seed, [ref]);
      }

      const owner = Option.fromNullable(
        (yield* store.findByRefs([upstreamRef.value])).get(upstreamRef.value),
      );

      // —— 认出来了 ——
      if (!hit) {
        // 这条 ref 头一次见。已有别的链的同一个币 → **只加一条 ref**(多链归一在这);
        // 否则建行 + 两条 ref(provider 的 + 上游的)。
        if (Option.isSome(owner)) {
          // 归一到已有 Token:**不覆盖**它已有的元信息(那可能是上游的好数据),只填空槽。
          yield* store.fillInfo(owner.value.tokenId, {
            name: seed.name,
            providerLogo: seed.providerLogo,
          });
          return yield* store.linkRef(owner.value.tokenId, ref);
        }
        // 去重:ref 本身就是上游命名时两者相同(手记选币),而 ref 行的主键是 (namer, localName)
        // —— 同一批插两条相同的行会撞主键、整批写失败。
        return yield* store.create(seed, [...new Set([ref, upstreamRef.value])]);
      }

      // —— 事后才认出来:合并 ——
      // 上次全局映射还没收录它,于是建了个只有 provider ref 的行;这次本地表认出来了。
      if (Option.isSome(owner) && owner.value.tokenId !== hit.tokenId) {
        // 已有别的行占着这个币 → 把旧行并进去:ref 改指、**历史快照的 token_id 一并改指**、旧行删。
        // 不改历史行的话,曲线会在合并那一刻断成两段。
        yield* store.merge(hit.tokenId, owner.value.tokenId);
        return owner.value.tokenId;
      }
      // 没人占着 → 就地补上上游那条 ref,行不动(它的历史、它的图都还在)。
      yield* store.linkRef(hit.tokenId, upstreamRef.value);
      return hit.tokenId;
    });

  const minter: TokenMinter = {
    of: (inputs) =>
      Effect.gen(function* () {
        const out = new Map<TokenRef, string>();
        if (inputs.length === 0) return out;

        // 同一批里重复的 ref 只处理一次(一个钱包同一个币多笔持仓很常见)。
        const byRef = new Map<TokenRef, ProviderTokenSeed>();
        for (const i of inputs) if (!byRef.has(i.ref)) byRef.set(i.ref, i.seed);

        // 第一步:一次批量点查本地 ref 行。绝大多数同步全部停在这里 —— 纯本地。
        const hits = yield* store.findByRefs([...byRef.keys()]);

        // 逐条走决策树。**顺序跑,而且这次是写在代码里的**(以前是一串 `await`,并发度靠读的人
        // 自己看出来)。账户是并发跑的,同一条 ref 可能被同时 mint,靠 store 的 upsert-then-read
        // 幂等收敛(见 `TokenStore.create`),不靠「先统一 mint 再并发写」。
        for (const [ref, seed] of byRef) {
          out.set(ref, yield* mintOne(ref, seed, hits.get(ref)));
        }
        return out;
      }),
  };

  return minter;
});

export const tokenMinterLayer: Layer.Layer<
  TokenMinter,
  never,
  TokenStore | GlobalTokenRefIndexStore | CandidateSource | Namer
> = Layer.effect(TokenMinter, make);
