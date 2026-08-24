import { vi } from "vitest";

// **出网一律先掐掉,再按用例需要放开一条缝。**
//
// 为什么默认掐掉而不是不管:这套清单里很多条的要点是「这条路径**不该**出网」
// (点中不建行、价全新鲜就一发都不发、手记账户跳过同步)。不掐掉的话这些用例会静默地
// 真去打上游 —— 慢、flaky,而且断言不到「没打」这件事。

export interface Outbound {
  /** 被请求过的 URL,按顺序。 */
  readonly calls: string[];
}

/** 任何外呼都抛错。返回的 `calls` 让用例能断言「一发都没有」或者「打的正是这个」。 */
export const blockOutbound = (): Outbound => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    throw new Error(`本用例不该出网,却请求了 ${url}`);
  });
  return { calls };
};

/**
 * 按 URL 片段给答案;没匹配到的照旧抛错。
 *
 * 形状故意选「片段 → 响应」而不是完整 URL:上游 URL 带 key、时间戳、排序参数,写全会让
 * 用例在无关的地方红。
 */
export const stubOutbound = (
  routes: ReadonlyArray<readonly [match: string, respond: () => Response]>,
): Outbound => {
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    for (const [match, respond] of routes) {
      if (url.includes(match)) return respond();
    }
    throw new Error(`没有为这个 URL 准备答案:${url}`);
  });
  return { calls };
};

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
