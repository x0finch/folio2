import { env } from "cloudflare:test";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { DbClient, dbClientLayer } from "../src/client";
import { CurrentUser } from "../src/current-user";

// **一次请求只有一个 drizzle 句柄。** 这条是红线(ADR 0044/0045,#504 T13),而它以前只被一个
// **一次性探针**验过 —— 探针跑完就删了,于是「哪天有人把两次 provide 拆开」这件事没有任何东西
// 会红。#504 复验清单点出的正是这个缺口:代码形状对,但没有可回归的断言。
//
// 钉的是**机制本身**,不是某个调用点。而写这两条用例时**实测纠正了一个说法**:边界是
// **「一次构建」,不是「一次 `Layer.provide`」**。
//   · 同一个引用在**一张 layer 图里**被 `Layer.provide` 两次 → 仍然一份(memo 表按构建走)
//   · 分成**两次构建**(两次 `Effect.provide` / 两个根 fiber)→ 两份,哪怕引用相同
//
// 后一条才是会出事的那半,也正是 T12 在日志层上撞到的同一个性质:根 fiber 不继承外层的
// provide,它自己那次装配就是第二次构建。
//
// 为什么这两条足够:app 侧那个 `userLayer(userId)`(`apps/web/src/lib/server/runtime.ts`)做的
// 就是「建一个 `perRequest` 引用,在**一次**装配里分给聚合与参考层」。它的正确性全部落在
// 下面这条性质上 —— 而这条性质在 db 这边才观测得到:`DbClient` 只在包内流通(原则 #6),
// 包外拿不到那个对象,也就没法在 app 的测试里比对身份。

// 捕获「我这一层拿到的是哪个 DbClient」。两个**不同**的服务,因为一个服务在一次构建里本来就
// 只建一次 —— 要看的是两个消费者会不会共用同一份。
class ProbeA extends Effect.Service<ProbeA>()("test/ProbeA", {
  effect: Effect.map(DbClient, (client) => ({ client })),
}) {}

class ProbeB extends Effect.Service<ProbeB>()("test/ProbeB", {
  effect: Effect.map(DbClient, (client) => ({ client })),
}) {}

// 与生产同款的那两样底料(ADR 0044):一个句柄 + 「这次请求是谁的」。
const perRequest = () => Layer.merge(dbClientLayer(env), Layer.succeed(CurrentUser, "user-probe"));

const bothFrom = (layer: Layer.Layer<ProbeA | ProbeB>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.all([Effect.map(ProbeA, (a) => a.client), Effect.map(ProbeB, (b) => b.client)]),
      layer,
    ),
  );

describe("一次请求一个 DbClient", () => {
  it("两个消费者在同一次装配里 → 同一份句柄", async () => {
    const shared = perRequest();
    const [a, b] = await bothFrom(
      Layer.provide(Layer.mergeAll(ProbeA.Default, ProbeB.Default), shared),
    );
    expect(a).toBe(b);
  });

  // 同一次构建里 `Layer.provide` 两次也还是一份 —— 这条是**实测出来的**,写这个文件之前
  // `runtime.ts` 的注释说的是「分两次 provide 就是两份」,那句话按字面读是错的(已改)。
  it("同一次构建里 provide 两次 → 还是一份", async () => {
    const shared = perRequest();
    const [a, b] = await bothFrom(
      Layer.merge(Layer.provide(ProbeA.Default, shared), Layer.provide(ProbeB.Default, shared)),
    );
    expect(a).toBe(b);
  });

  // **负对照。** 少了它,上面两条在「每次都新建一份」的实现下也会绿(两份句柄各自可用、行为
  // 一样,只是白开一条连接,而且这一层将来长出状态时会被悄悄劈成两半)。
  //
  // 两次 `runPromise` = 两次构建。这就是 `/api/sync` 那个后台任务的形状(#504 T12):
  // 它另起一条根 fiber,于是自己又装配了一次。
  it("分两次构建 → 两份句柄,哪怕 layer 引用相同", async () => {
    const shared = perRequest();
    const clientOf = (probe: typeof ProbeA) =>
      Effect.runPromise(
        Effect.provide(
          Effect.map(probe, (p) => p.client),
          Layer.provide(probe.Default, shared),
        ),
      );
    expect(await clientOf(ProbeA)).not.toBe(await clientOf(ProbeA));
  });
});
