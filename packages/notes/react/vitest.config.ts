import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 组件 smoke 跑 jsdom + @testing-library/react(与 apps/web 同套)。
export default defineConfig({
  plugins: [viteReact()],
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
  },
});
