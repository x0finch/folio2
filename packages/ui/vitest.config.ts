import { defineConfig } from "vitest/config";

// @folio/ui 收纳的是 shadcn vendored 组件(由 shadcn 维护),不为其写单元测试。
// 保留空配置让根 test 运行器干净地识别本包为"无测试"。组件样式/渲染由 apps/web
// 构建产物验证(见 P1.5 验收)。
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});
