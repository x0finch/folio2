import { applyD1Migrations, env } from "cloudflare:test";
import { resetLimitsForTests, setSleepForTests } from "@folio/ratelimit";
import { beforeEach } from "vitest";

// setup 在每个测试存储隔离之外运行,可能多次执行;applyD1Migrations 只应用未应用的迁移,幂等安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 限速闸:这套测试跑的是**应用的真实接线**(oracle2 的 cgConfig → CoinGecko client),那条路上
// 没有测试参数可传。不把等待换成即时的话,无 key 档(10 次/分钟)会让这里真等 —— 实测这套
// 从 15s 涨到 35s+。而且上一个用例撞出来的冷却会漏给下一个:isolate 跨用例存活,冷却也跟着。
setSleepForTests(async () => {});
beforeEach(() => resetLimitsForTests());
