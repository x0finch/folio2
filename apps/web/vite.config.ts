import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
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

// 本地 server 要不要 https,**由 BETTER_AUTH_URL 一个人说了算** —— 开关只有一处,两边不可能打架。
//
// 为什么是它:better-auth 校验 passkey 的 expectedOrigin 是**完整 origin**(带 scheme),scheme 一旦
// 和实际访问的对不上,每个 ceremony 都失败且没有有用的报错。既然 scheme 本来就必须一致,那就让配置
// 从它派生,而不是让人记着「改了这个还要改那个」。
//
// 读哪个文件跟着 @cloudflare/vite-plugin 的规矩走:`CLOUDFLARE_ENV=x` 时它**只**加载 `.dev.vars.x`
// (e2e 就是 `CLOUDFLARE_ENV=test`),否则是 `.dev.vars`。
//
// **只认 localhost**:`dev:tunnel` 会把 BETTER_AUTH_URL 临时改成隧道的 https 域名,但那条链上 TLS 是
// 在 Cloudflare 那头终结的,cloudflared 连本地用的仍是 http —— 那时候本地 server 自己发 TLS 反而连不上。
function localHttps() {
  const env = process.env.CLOUDFLARE_ENV;
  try {
    const text = readFileSync(new URL(`.dev.vars${env ? `.${env}` : ""}`, import.meta.url), "utf8");
    const url = text.match(/^BETTER_AUTH_URL=(.*)$/m)?.[1]?.trim();
    return /^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url ?? "");
  } catch {
    return false; // 还没配 .dev.vars —— 这时候 auth 本来也跑不起来,别再加一层证书告警
  }
}

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  server: { allowedHosts },
  // preview 也要:`dev:tunnel --preview` 跑的是构建产物。
  preview: { allowedHosts },
  plugins: [
    // **要的其实是 HTTP/2**:vite 只在配了证书时才用 `node:http2` 起 server,否则是 `node:http`
    // (HTTP/1.1)—— 而 HTTP/1.1 同域最多 6 条连接,超出的排队,线上的 Cloudflare 是 HTTP/2 多路
    // 复用、没有这个上限。差的时间不多(一次首页导航约 200ms),但它会让**本地测出来的形状和线上不是
    // 一回事** —— 查 #485 时就差点把「排队」当成「查询慢」。
    //
    // 证书是现签的自签名证书(缓存在 node_modules/.vite),没有 CA 认它:浏览器第一次会拦一下,点
    // 「继续前往」之后地址栏会一直挂着 Not Secure —— 只是提示,`isSecureContext` 仍为真,WebAuthn
    // 照常。dev 和 preview 都配上:e2e 在 CI 上跑的正是 preview。
    localHttps() && basicSsl(),
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
});

export default config;
