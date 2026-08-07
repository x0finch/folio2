import { applyD1Migrations, env } from "cloudflare:test";
import { setRateLimitScopeForTests } from "@folio/client-core/testing";

// setup 在每个测试存储隔离之外运行,可能多次执行;applyD1Migrations 只应用未应用的迁移,幂等安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// 限频闸整体放行。**只剩一个消费者**:oracle 那条路上的 CoinGecko client(connector 那边每个
// 上游都由自己的包测,不经这套)。
//
// 为什么要放行:这套测试跑的是**应用的真实接线**,`runPromise` 在被测代码内部,这里够不到那个
// context —— 换句话说没有 provide 服务的位置,只能设进程级默认档。而闸真等的话这套会从 1 秒
// 涨到几十秒(无 key 档是每分钟 10 发)。闸本身在 `@folio/client-core` 的单测里用假时钟验过。
//
// 这是 `@folio/shared` 的 `bypassRateLimitsForTests` 唯一活下来的用途,换了个更小的形状:
// 不是「所有闸一律放行」的布尔,而是「不选档时算哪一档」。
setRateLimitScopeForTests("none");
