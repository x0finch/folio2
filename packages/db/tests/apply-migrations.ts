import { applyD1Migrations, env } from "cloudflare:test";

// setup 在每个测试存储隔离之外运行,可能多次执行;applyD1Migrations 只应用未应用的迁移,幂等安全。
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
