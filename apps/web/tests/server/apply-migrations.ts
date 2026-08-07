import { applyD1Migrations, env } from "cloudflare:test";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { beforeEach } from "vitest";

// setup 在每个测试存储隔离之外运行,可能多次执行;applyD1Migrations 只应用未应用的迁移,幂等安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 限速闸整体旁路。**现在只剩一个消费者**:oracle 那条路上的 `@folio/coingecko-client`
// (还是 Promise + `@folio/shared` 的老形状,退场排在 #376 C 批)。connector 那边的闸已经全部
// 搬进 `@folio/client-core`,不归这个开关管了。
//
// 为什么要旁路:这套测试跑的是**应用的真实接线**,那条路上没有测试参数可传;而闸真等的话
// 这套会从 1 秒涨到几十秒。限速本身在 `@folio/shared` 的单测里用假时钟验过,不该重复付那个成本。
bypassRateLimitsForTests(true);
beforeEach(() => resetRateLimitsForTests());
