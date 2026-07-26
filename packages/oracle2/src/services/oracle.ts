import type {
  CacheStore,
  GlobalTokenRefIndexStore,
  TokenPriceStore,
  TokenRefIndexSource,
  TokenSource,
  TokenStore,
} from "../contract";
import { createMint, type Mint } from "./mint";
import { createTokens, type Tokens } from "./tokens";

// 装配。**store 与 source 一样,都是初始化时注入的惰性工厂**(ADR 0023):
// 是工厂不是实例,因为门面只建被碰到的那一个子服务 —— 否则 app 一拼 config 就把所有 store
// 全 new 出来(各含 getDb),`oracle.tokens` 也白建另一批。
//
// **没有 `apiKey`、没有默认源** —— 老 oracle 那句 `source ?? createCoinGeckoSource({ apiKey })`
// 就是服务层永久依赖某一家的根。这里 source 必须由调用方给,本包的 `dependencies` 里
// 因此不需要(也不许有)任何 client / source 包。
export interface OracleConfig {
  createTokenStore(userId: string): TokenStore;
  createTokenPriceStore(userId: string): TokenPriceStore;
  createCacheStore(userId: string): CacheStore;
  // 全局知识,与用户无关 → 零参(ADR 0022)。
  createRefIndexStore(): GlobalTokenRefIndexStore;
  createSource(): TokenSource;
  // symbol → 上游 id 的策展小表。由 adapter 提供(它逐条写的是那一家的 id)。
  overrides?: Readonly<Record<string, string>>;
  now?: () => number;
}

// 一个用户的参考层。子服务按**领域**分(ADR 0012 的口径),不按能力切碎:
//   · `tokens` 读路径 —— 富化 / 现价 / 历史价 / 橱窗 / 搜索
//   · `mint`   写路径 —— tokenRef → token_id,写快照之前必须先过这一步
//
// 「info 数据 vs 价格数据」的分离落在**端口**上(`TokenStore` / `TokenPriceStore`),
// 不在门面上再切一遍(ADR 0023)。
export interface Oracle {
  readonly tokens: Tokens;
  readonly mint: Mint;
}

// 显式工厂 —— **这是原语**,不是糖。
//
// 参考层现在装的是**用户私有**数据(他认识哪些币、他的币叫什么名),拿错用户就是数据泄露。
// 做成参数,编译期就挡住了;`requireAuth` 那种把它绑进 ctx 的写法只是外面一层糖。
// cron 没有 auth 上下文,得逐用户自己 `oracleFor(u)` —— 那正是本签名想让它显而易见的事。
export type OracleFor = (userId: string) => Oracle;

export function createOracleFor(cfg: OracleConfig): OracleFor {
  return (userId: string): Oracle => {
    let tokens: Tokens | undefined;
    let mint: Mint | undefined;

    // 子服务经 getter 首访即建、建后记忆。调用方常只用其一(logo 端点只碰 tokens),
    // 不该为此把另一套 store 也 new 出来。
    return {
      get tokens() {
        tokens ??= createTokens({
          store: cfg.createTokenStore(userId),
          prices: cfg.createTokenPriceStore(userId),
          cache: cfg.createCacheStore(userId),
          source: cfg.createSource(),
          now: cfg.now,
        });
        return tokens;
      },
      get mint() {
        const source = cfg.createSource();
        mint ??= createMint({
          store: cfg.createTokenStore(userId),
          refIndex: cfg.createRefIndexStore(),
          // 候选与橱窗同一份 warm rows(不额外存);经 tokens 子服务拿,复用它的 SWR。
          candidates: this.tokens.candidates,
          namer: source.id,
          overrides: cfg.overrides,
        });
        return mint;
      },
    };
  };
}

// —— 全局维护任务 ——
// 刷全局映射表跟 userId 毫无关系,挂在 `oracleFor(u)` 上本来就别扭 —— 单独一个不带 user 的
// 工厂给 cron 用,不必先假造一个用户。动词沿用项目现成的 `warm`。
export interface OracleWarmConfig {
  createRefIndexStore(): GlobalTokenRefIndexStore;
  createSource(): TokenRefIndexSource;
  // 失配是**静默故障**(那条链的币从此没价没图,却不报错)→ 必须喊出来。
  // 做成回调而不是引日志库:这一层不该知道日志怎么落,cron 那头知道。
  onWarn?(message: string, meta: Record<string, unknown>): void;
}

export interface OracleWarm {
  // cron 调用点:拉 → 转换(在 adapter 里)→ 一次整份灌。返回这轮的账,供调用方记日志。
  warmRefIndex(
    now: number,
  ): Promise<{ rows: number; unmatchedPlatforms: string[]; skipped: number }>;
  // 某个源最近一次成功刷新的时刻;从未刷过 → null(首次部署要手动触发一次)。
  refIndexRefreshedAt(): Promise<number | null>;
}

export function createOracleWarm(cfg: OracleWarmConfig): OracleWarm {
  return {
    async warmRefIndex(now) {
      const source = cfg.createSource();
      const result = await source.fetchRefIndex();
      if (result.unmatchedPlatforms.length > 0) {
        cfg.onWarn?.("global_token_ref_index: 链对照失配,这些链的币将没价没图", {
          namer: source.id,
          platforms: result.unmatchedPlatforms,
        });
      }
      await cfg.createRefIndexStore().putAll(result.rows, now);
      return {
        rows: result.rows.length,
        unmatchedPlatforms: result.unmatchedPlatforms,
        skipped: result.skipped,
      };
    },

    refIndexRefreshedAt() {
      return cfg.createRefIndexStore().refreshedAt(cfg.createSource().id);
    },
  };
}
