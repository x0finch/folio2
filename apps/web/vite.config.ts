import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// vite 的 host 校验(防 DNS rebinding)默认只放 localhost,从别的域名访问本地 server 会被
// "This host is not allowed" 挡掉。要额外放通哪个域名由启动脚本注入(`pnpm dev:tunnel` 用它传隧道
// 域名)—— 命名隧道用的是各人的私有域名,不写进仓库。随机的 trycloudflare 后缀是通用的,直接留着。
//
// rpID 不在这里管:它从 worker 的 BETTER_AUTH_URL 派生,而 worker 的环境变量只能来自 wrangler 配置或
// .dev.vars —— 由 dev:tunnel 脚本运行期临时改那个文件、退出时按散列校验还原,见脚本头部。
const allowedHosts = [".trycloudflare.com", process.env.DEV_ALLOWED_HOST].filter(
  (host): host is string => !!host,
);

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { allowedHosts },
  // preview 也要:`dev:tunnel --preview` 跑的是构建产物。
  preview: { allowedHosts },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
