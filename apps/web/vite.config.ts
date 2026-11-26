import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Vite's host check (DNS-rebinding guard) only allows localhost by default. Extra hosts are
// injected by the launch script (`pnpm dev:tunnel`); named-tunnel domains are private, so not in the repo.
const allowedHosts = [".trycloudflare.com", process.env.DEV_ALLOWED_HOST].filter(
  (host): host is string => !!host,
);

// Whether the local server uses https is decided solely by BETTER_AUTH_URL: better-auth checks
// passkey expectedOrigin against the full origin (scheme included), so the scheme must match.
// Reads `.dev.vars.<CLOUDFLARE_ENV>` when set (as @cloudflare/vite-plugin does), else `.dev.vars`.
// Localhost only: under `dev:tunnel` TLS terminates at Cloudflare and cloudflared talks http locally.
function localHttps() {
  const env = process.env.CLOUDFLARE_ENV;
  try {
    const text = readFileSync(new URL(`.dev.vars${env ? `.${env}` : ""}`, import.meta.url), "utf8");
    const url = text.match(/^BETTER_AUTH_URL=(.*)$/m)?.[1]?.trim();
    return /^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url ?? "");
  } catch {
    return false; // no .dev.vars yet
  }
}

// Injected at build time for the settings page footer; falls back to GITHUB_SHA / placeholder without git.
function buildInfo() {
  const sh = (cmd: string) => {
    try {
      return execSync(cmd, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
    } catch {
      return "";
    }
  };
  const commit = (process.env.GITHUB_SHA || sh("git rev-parse HEAD")).slice(0, 7) || "unknown";
  const version = sh("git describe --tags --always --dirty") || commit;
  return { commit, version, builtAt: new Date().toISOString() };
}
const build = buildInfo();

// Stamps the build version into the built sw.js (replaces `__SW_BUILD__`): browsers detect a new
// service worker by byte-diffing sw.js, and normal releases only change /assets hashes.
// public/ isn't in the rollup bundle, so patch it in writeBundle; only the client build has sw.js.
function stampSwVersion(version: string): Plugin {
  return {
    name: "stamp-sw-version",
    apply: "build",
    writeBundle(options) {
      if (!options.dir) return;
      const swPath = join(options.dir, "sw.js");
      let src: string;
      try {
        src = readFileSync(swPath, "utf8");
      } catch {
        return; // no sw.js in this build output
      }
      if (src.includes("__SW_BUILD__")) {
        writeFileSync(swPath, src.replaceAll("__SW_BUILD__", version));
      }
    },
  };
}

const config = defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(build.version),
  },
  resolve: { tsconfigPaths: true },
  server: { allowedHosts },
  // preview too: `dev:tunnel --preview` serves the build output.
  preview: { allowedHosts },
  plugins: [
    // HTTP/2 is the real goal: vite only uses `node:http2` when a cert is configured, and HTTP/1.1's
    // 6-connections-per-host limit makes local timings differ in shape from production.
    // The self-signed cert is untrusted (browser warns once; WebAuthn still works).
    // Skipped for the build-time prerender preview: Node's fetch rejects the self-signed cert
    // (`DEPTH_ZERO_SELF_SIGNED_CERT`), failing the build. TanStack sets `TSS_PRERENDERING` in-process.
    localHttps() && process.env.TSS_PRERENDERING !== "true" && basicSsl(),
    stampSwVersion(build.version),
    devtools(),
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tailwindcss(),
    // The HTML shell is prerendered once at build (`dist/client/index.html`) and served for all
    // navigations, since SSR'ing it per request costs ~9ms of the 10ms CPU budget. outputPath must
    // be `/index`: the platform SPA fallback only recognises index.html. The framework's shell-mode
    // shortcut doesn't apply in CF's prerender worker, so the root route must take no server input.
    tanstackStart({ spa: { enabled: true, prerender: { outputPath: "/index" } } }),
    viteReact(),
  ],
});

export default config;
