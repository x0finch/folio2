import { warmCandidates } from "./cache";
import { type CgkRefs, createCgkRefs } from "./cgk-refs";
import { createMint, type Mint } from "./mint";
import type { CacheStore, CgkRefStore, TokenSource, TokenStore } from "./stores";
import { createTokens, type Tokens } from "./tokens";

// store 工厂。**惰性**(是工厂不是实例):门面只建被碰到的那一个子服务,store 也须延到那时才造 ——
// 否则 app 一拼 config 就把三个 store 全 new 出来(各含 getDb),`oracle.tokens` 也白建另两个。
export interface OracleStores {
  tokens(userId: string): TokenStore;
  cache(userId: string): CacheStore;
  // 全局知识,与用户无关 → 零参(ADR 0022)。
  cgkRefs(): CgkRefStore;
}

export interface OracleConfig {
  stores: OracleStores;
  source: TokenSource;
  // symbol → CoinGecko coin id 的策展小表(majors + 已知撞名)。由上游适配器提供 —— 它是
  // vendor 知识,不该硬编码在 vendor 中立的这一层。
  overrides?: Readonly<Record<string, string>>;
  // 对照失配这类静默故障的出口(见 cgk-refs.ts)。不传 = 不喊。
  onWarn?: (message: string, meta: Record<string, unknown>) => void;
  // 注入便于测 TTL / 日桶;默认 Date.now。
  now?: () => number;
}

// 一个用户的参考层。三个子服务:
//   · `tokens`   读路径 —— 按 token_id 拿名字/图/价/涨跌/排名
//   · `mint`     写路径 —— tokenRef → token_id,写快照之前必须先过这一步
//   · `cgkRefs`  cron —— 全局 contract → coin 映射的刷新与查询
export interface Oracle {
  readonly tokens: Tokens;
  readonly mint: Mint;
  readonly cgkRefs: CgkRefs;
}

// 显式工厂 —— **这是原语**,不是糖。
//
// 为什么是显式传 userId,而不是从某个环境/上下文里摸:参考层现在装的是**用户私有**的数据
// (他认识哪些币、他的币叫什么名),拿错用户就是数据泄露。做成参数,编译期就挡住了;
// `requireAuth` 那种把它绑进 ctx 的写法只是这个原语外面的一层糖,cron 没有 auth 上下文,
// 得逐用户自己 `oracleFor(u)` —— 那正是本签名想让它显而易见的事。
//
// 惰性:三个子服务经 getter 首访即建、建后记忆。调用方常只用其一(logo 端点只碰 tokens、
// cron 刷映射只碰 cgkRefs),不该为此把另两套 store 也 new 出来。
export type OracleFor = (userId: string) => Oracle;

export function createOracleFor(cfg: OracleConfig): OracleFor {
  return (userId: string): Oracle => {
    let tokens: Tokens | undefined;
    let mint: Mint | undefined;
    let cgkRefs: CgkRefs | undefined;

    return {
      get tokens() {
        tokens ??= createTokens({
          store: cfg.stores.tokens(userId),
          cache: cfg.stores.cache(userId),
          source: cfg.source,
          now: cfg.now,
        });
        return tokens;
      },
      get mint() {
        mint ??= createMint({
          store: cfg.stores.tokens(userId),
          cgkRefs: cfg.stores.cgkRefs(),
          candidates: warmCandidates(cfg.stores.cache(userId)),
          overrides: cfg.overrides,
        });
        return mint;
      },
      get cgkRefs() {
        cgkRefs ??= createCgkRefs({
          store: cfg.stores.cgkRefs(),
          source: cfg.source,
          onWarn: cfg.onWarn,
        });
        return cgkRefs;
      },
    };
  };
}
