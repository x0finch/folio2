import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  // 手机上验证要走 `cloudflared tunnel --url http://localhost:3000`,而 vite 的 host 校验(防 DNS
  // rebinding)默认只放 localhost → 隧道域名会被 "This host is not allowed" 挡掉。只放通
  // trycloudflare 后缀,dev-only;同时记得把 .dev.vars 的 BETTER_AUTH_URL 换成隧道 URL ——
  // passkey 的 rpID 从它派生,不换的话手机上所有 WebAuthn ceremony 都会 rpID 不匹配。
  server: { allowedHosts: [".trycloudflare.com"] },
  plugins: [
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
