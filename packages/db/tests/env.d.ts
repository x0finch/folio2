// 测试环境绑定:DB(Miniflare D1)+ 注入的迁移数组。
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
