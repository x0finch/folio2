import {
  CacheStore,
  GlobalTokenRefIndexStore,
  TokenPriceStore,
  TokenStore,
} from "@folio/oracle-basic/ports";
import { Layer } from "effect";
import type { DbClient } from "../client";
import type { CurrentUser } from "../current-user";
import { makeUserCacheStore } from "./cache";
import { makeGlobalTokenRefIndexStore } from "./global-ref-index";
import { makeUserTokenStore } from "./token";
import { makeUserTokenPriceStore } from "./token-price";

// 参考层四个端口的 D1 实现。**薄壳**。
//
// 这半实现的接口不是 db 自己定的 —— 是 `@folio/oracle-basic` 的四个端口(ADR 0021/0022/0023)。
// 目录名说的就是这件事:`stores/` 只说了「是存东西的」,`oracle-ports/` 说清了「实现的是谁的契约」。
//
// **四个文件各只写实现,绑 Tag 全在本文件**(#504 T5,同 `domains/` 的 make + 聚合):
// 「这份 D1 实现顶的是谁的契约」在一处看得全,不必翻四个文件的末尾。
//
// 出口是 **Layer 而不是工厂**:「怎么变成那个端口」归实现方,装配点只管把它接上。
// 四个 layer 共用同一个 `DbClient`(`../client.ts`),`env` 只在 `dbClientLayer(env)` 一处被读。

export interface OraclePortsOpts {
  /**
   * 当前上游自报的 id(`TokenUpstream.id` / `Namer.id`)。
   *
   * db 层不预设任何厂商(表名列名零 vendor 字样,#199),所以凡是要按命名者点查 `token_refs`
   * 的读、以及历史日价那条全局键,都由装配点把它传进来。**不从 `Namer` 端口里 `yield`**:
   * 那会让 db 反过来消费参考层的一个服务,而装配点已经手握这个常量。
   */
  readonly namer: string;
}

/**
 * 全局映射表那一个端口,**单独可拿**。
 *
 * cron 刷 `global_token_ref_index` 是系统级路径:那张表跟任何用户无关(ADR 0022),所以它
 * 只要 `DbClient`,不经 `CurrentUser`,也不该为了拿它把 per-user 那三张一起建出来。
 */
export const globalTokenRefIndexStoreLayer: Layer.Layer<GlobalTokenRefIndexStore, never, DbClient> =
  Layer.effect(GlobalTokenRefIndexStore, makeGlobalTokenRefIndexStore);

/**
 * **参考层要的一整套端口,一行给全。**
 *
 * 以前是四个 layer(其中两个还是带 opts 的工厂)各自从包出口露出去,装配点逐个列举 ——
 * 每加一个端口,每个装配点都得跟着改一行。现在包外只认这一张。
 *
 * **不自己开连接、也不自己收 userId**:`R` 声明 `DbClient | CurrentUser`,和聚合 `Database`
 * 同一条红线 —— 一次请求一个 drizzle 句柄,谁装配谁给(ADR 0044/0045)。
 */
export const oraclePortsLayer = ({
  namer,
}: OraclePortsOpts): Layer.Layer<
  CacheStore | GlobalTokenRefIndexStore | TokenPriceStore | TokenStore,
  never,
  CurrentUser | DbClient
> =>
  Layer.mergeAll(
    Layer.effect(TokenStore, makeUserTokenStore(namer)),
    Layer.effect(TokenPriceStore, makeUserTokenPriceStore(namer)),
    Layer.effect(CacheStore, makeUserCacheStore),
    globalTokenRefIndexStoreLayer,
  );
