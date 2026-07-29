import {
  COOLDOWN_CACHE_NAME,
  COOLDOWN_DEFAULT_MS,
  COOLDOWN_MAX_MS,
  COOLDOWN_URL_PREFIX,
} from "./constants";
import { RateLimitedError } from "./errors";
import type { CooldownStore, LimitPolicy } from "./types";

// 冷却标记 —— colo 档。**存的是「冷却到什么时候」,不是「还剩几个令牌」**,这一点是设计的核心:
//
// Cache API 没有原子读改写。两个 isolate 同时 match 都看到"剩 3 个"、各自 put"剩 2",少扣一次。
// 令牌桶恰恰是读改写,所以"caches 版令牌桶"不是慢,是**不准,而且往松的方向不准**。
// 换成存一个时刻就天然对了:
//   · 免疫竞态 —— 大家写的值几乎一样,谁覆盖谁都对
//   · 最终一致够用 —— 传播那几十毫秒漏几个请求,无所谓
//   · 被驱逐也只是退化成今天的行为,不会出错
//
// 所以它**只止损,不管配额**:避免撞墙靠 isolate 档的桶,这一层管的是「撞了之后同一个数据中心
// 的 isolate 一起收手」。治的是累积效应 —— rabby 实测撞过之后继续打,恢复得更慢。
//
// **作用域是按数据中心的,不是全局的**:同 colo 共享,跨 colo 不共享。对按出口 IP 算额度的上游
// (rabby、blockbook、binance 的公开端点)反而对得上 —— Workers 从所在 colo 出口,per-colo ≈
// 按出口 IP 分组。对按 key 算的(CGK、coinstats)对不上,那种要精确得等 DO(见 #17)。

// isolate 层:总是有,而且比 colo 层快一个数量级(同步读一个 Map)。colo 层是它的补充。
const coolUntilByKey = new Map<string, number>();

// Cache API 到底生效没有 —— 每个 isolate 探一次。
// **必须探**:`*.workers.dev` 上 Cache API 的每次 put/match 都是**静默 no-op**
// (见 apps/web/DEPLOY.md),而 DEPLOY.md 的默认部署路径正是 workers.dev。不探的话这一档
// 看着在跑、实际一次都没生效,而且下次查限流问题会查错方向。
type ProbeState = "unknown" | "effective" | "noop" | "absent";
let probe: ProbeState = "unknown";
let storePromise: Promise<CooldownStore | undefined> | undefined;
const warned = new Set<string>();

// 缓存 key 里的一段「代」号。**这不是花活,是让重置真的有效**:清内存 Map 清不掉已经写进
// Cache API 的条目(那是真缓存,没有清空接口),于是在 workerd 里跑的测试会被上一个用例
// 留下的冷却污染 —— 而且只有真撞过 429 的用例才会暴露。改代号让旧条目直接找不到,
// 比逐个删干净、也比让测试各用不同的 key 干净(生产 key 是固定的,测试没法换)。
let generation = 0;

export function resetCooldownForTests(): void {
  coolUntilByKey.clear();
  probe = "unknown";
  storePromise = undefined;
  warned.clear();
  generation++;
}

function warnOnce(policy: LimitPolicy, tag: string, message: string): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  policy.log?.(message, { key: policy.key, scope: policy.scope });
}

function urlFor(fullKey: string): string {
  const suffix = generation === 0 ? "" : `?g=${generation}`;
  return `${COOLDOWN_URL_PREFIX}${encodeURIComponent(fullKey)}${suffix}`;
}

async function resolveStore(policy: LimitPolicy): Promise<CooldownStore | undefined> {
  if (policy.cache) return policy.cache;
  const cacheStorage = (globalThis as { caches?: { open(name: string): Promise<CooldownStore> } })
    .caches;
  if (!cacheStorage) {
    probe = "absent";
    warnOnce(
      policy,
      "absent",
      "ratelimit: no Cache API in this runtime — colo-scoped cooldown is off, isolate gate only",
    );
    return undefined;
  }
  storePromise ??= cacheStorage.open(COOLDOWN_CACHE_NAME);
  return storePromise;
}

// 冷却期内 → 抛(调用方的 onCooldown 或 RateLimitedError)。**绝不因为缓存不可用而让请求失败** ——
// 拿不到 store 就当没有冷却,退化成只用 isolate 档。
export async function readCooldown(
  policy: LimitPolicy,
  clock: () => number,
  fullKey: string,
): Promise<void> {
  const now = clock();

  const local = coolUntilByKey.get(fullKey);
  if (local !== undefined) {
    if (local > now) reject(policy, fullKey, local - now);
    else coolUntilByKey.delete(fullKey); // 过期即清,免得 Map 无界增长
  }

  if ((policy.scope ?? "isolate") === "isolate") return;

  const store = await resolveStore(policy);
  if (!store) return;

  let coolUntil: number | undefined;
  try {
    const hit = await store.match(urlFor(fullKey));
    if (hit) {
      const parsed = Number(await hit.text());
      if (Number.isFinite(parsed)) coolUntil = parsed;
    }
  } catch {
    return; // 缓存读炸了就当没冷却 —— 限速器不该是新的故障源
  }

  if (coolUntil !== undefined && coolUntil > now) {
    coolUntilByKey.set(fullKey, coolUntil); // 本 isolate 后续调用不必再读缓存
    reject(policy, fullKey, coolUntil - now);
  }
}

export async function writeCooldown(
  policy: LimitPolicy,
  clock: () => number,
  fullKey: string,
  ms: number | undefined,
): Promise<void> {
  const span =
    Math.min(COOLDOWN_MAX_MS, Math.max(0, ms ?? COOLDOWN_DEFAULT_MS)) || COOLDOWN_DEFAULT_MS;
  const now = clock();
  const coolUntil = now + span;

  // 已经在冷却、而且冷得比这次更久 → 什么都不用做。**这条不只是省一次缓存写**:冷却期内被拒的
  // 调用会带着「剩余时长」再来写一次,不挡住的话每次被拒都在续期,冷却就永远不结束了。
  const previous = coolUntilByKey.get(fullKey);
  if (previous !== undefined && previous > now && previous >= coolUntil) return;

  // isolate 层无条件写 —— 就算 scope 是 isolate,自己这一格也该收手。
  coolUntilByKey.set(fullKey, coolUntil);

  if ((policy.scope ?? "isolate") === "isolate") return;

  const store = await resolveStore(policy);
  if (!store) return;

  const url = urlFor(fullKey);
  try {
    await store.put(url, cooldownResponse(coolUntil, span));
    // 写完顺手探一次生效性(每 isolate 一次)—— 这是 workers.dev 静默 no-op 的唯一警报。
    if (probe === "unknown") {
      probe = (await store.match(url)) ? "effective" : "noop";
      if (probe === "noop") {
        warnOnce(
          policy,
          "noop",
          "ratelimit: Cache API writes are not sticking — colo-scoped cooldown is off. " +
            "On *.workers.dev every cache put/match is a silent no-op; bind a custom domain to enable it.",
        );
      }
    }
  } catch {
    // 写不进去无所谓 —— isolate 层已经记下了,退化成今天的行为。
  }
}

function cooldownResponse(coolUntil: number, spanMs: number): Response {
  return new Response(String(coolUntil), {
    headers: {
      // Cache API 靠 max-age 自己过期,不用我们清理。至少 1 秒(0 会被当成不可缓存)。
      "cache-control": `max-age=${Math.max(1, Math.ceil(spanMs / 1000))}`,
      "content-type": "text/plain",
    },
  });
}

function reject(policy: LimitPolicy, fullKey: string, remainingMs: number): never {
  if (policy.onCooldown) policy.onCooldown(remainingMs, fullKey);
  throw new RateLimitedError(fullKey, remainingMs);
}
