import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 命名隧道的域名由 dev:tunnel 脚本传进来(见那里的注释)。取不到就返回空数组 —— 平时 `pnpm dev`
// 根本不需要放通任何额外 host。
function tunnelHost(): string[] {
  const raw = process.env.TUNNEL_HOSTNAME;
  if (!raw) return [];
  try {
    return [new URL(raw).host];
  } catch {
    return [];
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // 手机上验证走隧道(`pnpm dev:tunnel`),而 vite 的 host 校验(防 DNS rebinding)默认只放 localhost
  // → 隧道域名会被 "This host is not allowed" 挡掉。
  //
  // 随机隧道的后缀写死即可;命名隧道用的是各自的私有域名,**不写进仓库** —— 由 dev:tunnel 脚本以
  // TUNNEL_HOSTNAME 环境变量透进来。都是 dev-only,不影响构建产物。
  server: { allowedHosts: [".trycloudflare.com", ...tunnelHost()] },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
