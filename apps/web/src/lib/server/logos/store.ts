import { PLATFORM_TTL_MS } from "@folio/oracle-basic";
import { CacheStore } from "@folio/oracle-basic/ports";
import { Effect, Option, Schema } from "effect";

// DeFi 协议 logo 的名址:protocol → 上游图 URL。**住在 app,不在参考层**。
//
// 为什么:参考层管的是外面世界的公开知识(币 / 链 / 汇率),而这份数据来自**用户自己同步下来的
// 余额 meta** —— 没有上游、不出网,只是同步时塞进 `user_cache`、图片端点再读出来。它当初挂在
// oracle 上是照着 platform logo 顺手挂的(#126),而边界其实早就写在类型里:那个服务的 `R` 里
// 一个上游都没有。
//
// 键仍是 `defi-logo:<协议>`(同一张 per-user 表,数据不用搬)。TTL 复用平台那档长的:近静态,
// 过期不删(`user_cache` 语义),值照读,下次同步重写刷新 TTL。
//
// **写那个动词叫 `record` 不叫 `warm`。** 「预热」的意思是「去把外面的数据取回来」;这里的数据是
// 调用方递进来的,一次网络都不发 —— 以前叫 `warm` 是为了跟 fx / platform 对齐,但对齐的只是名字。
const key = (protocol: string) => `defi-logo:${protocol}`;

const decodeUrl = Schema.decodeUnknownOption(Schema.String);

// 单个协议的图 URL(缓存命中且是个字符串 → URL;否则 `none` → 调用方走首字母兜底)。
export const readDefiLogo = (
  protocol: string,
): Effect.Effect<Option.Option<string>, never, CacheStore> =>
  Effect.flatMap(CacheStore, (cache) =>
    Effect.map(cache.get(key(protocol)), (hit) =>
      Option.flatMap(hit, (entry) => decodeUrl(entry.value)),
    ),
  );

// 同步后记账:把 (protocol, logo) 对写回缓存。同协议取首个带图者;**一个批次**(与 platform 同理:
// 逐键往返会把一次 D1 变成 N 次)。没图就不写 —— 这里**没有否定缓存**,读不到就是没有。
export const recordDefiLogos = (
  entries: readonly { protocol: string; logo: string }[],
): Effect.Effect<void, never, CacheStore> =>
  Effect.flatMap(CacheStore, (cache) => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (e.logo && !seen.has(e.protocol)) seen.set(e.protocol, e.logo);
    }
    if (seen.size === 0) return Effect.void;
    return cache.putMany(
      [...seen].map(([protocol, logo]) => ({
        key: key(protocol),
        value: logo,
        ttlMs: PLATFORM_TTL_MS,
      })),
    );
  });
