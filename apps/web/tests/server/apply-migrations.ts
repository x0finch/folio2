import { applyD1Migrations, env } from "cloudflare:test";
import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { beforeEach } from "vitest";

// setup 在每个测试存储隔离之外运行,可能多次执行;applyD1Migrations 只应用未应用的迁移,幂等安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 限速闸整体旁路:这套测试跑的是**应用的真实接线**(oracle2 的 cgConfig → CoinGecko client),
// 那条路上没有测试参数可传;而闸真等的话这套会从 1 秒涨到几十秒。限速本身在
// @folio/shared 的单测里用假时钟验过,这里不该重复付那个成本。
bypassRateLimitsForTests(true);
beforeEach(() => resetRateLimitsForTests());
