import { defineConfig } from "vitest/config";

// 独立配置:本包 `vitest run` 用自己的设置,不继承根 `projects`。
// 根 runner(`pnpm test:packages`)靠这个配置文件发现本包。
export default defineConfig({
  test: {
    environment: "node",
  },
});
