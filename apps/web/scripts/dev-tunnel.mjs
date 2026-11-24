#!/usr/bin/env node
// Tests this app on a phone: starts a Cloudflare tunnel + the server and stops both together.
//
//   pnpm dev:tunnel              # dev server, hot reload
//   pnpm dev:tunnel --preview    # built output; much faster on a phone (dev serves ~250 unbundled modules at ~130ms each)
//
// The domain goes two places: DEV_ALLOWED_HOST to vite (host allowlist), and BETTER_AUTH_URL in .dev.vars, which is rewritten at runtime and restored on exit (passkey rpID derives from it, and Worker env can only come from wrangler config or that file). The original is stashed in the system temp dir and restored on next start after a SIGKILL.
//
// Restores are conditional: the stash name carries a hash of the content we wrote, and the file is restored only if it still matches; otherwise the user edited it, so it's left alone and the stash path printed.
//
// Note: in --preview mode the .dev.vars snapshot inside the build keeps the tunnel address until the next build.
//
// Default is a random trycloudflare domain, which changes each run (rpID changes, so passkeys must be re-registered on the phone). For a fixed one, create a named tunnel (one-off; needs a domain on Cloudflare):
//
//   cloudflared tunnel login && cloudflared tunnel create folio-local
//   cloudflared tunnel route dns folio-local folio-local.<your-domain>
//
// Then add TUNNEL_NAME=folio-local and TUNNEL_HOSTNAME=https://folio-local.<your-domain> to .dev.vars (local, untracked) or pass them as env vars.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const WEB_ROOT = new URL("..", import.meta.url);
const DEV_VARS = fileURLToPath(new URL(".dev.vars", WEB_ROOT));
const PORT = process.env.PORT ?? "3000";
const usePreview = process.argv.includes("--preview");

function sha(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Stash in the system temp dir (never in the repo), named by a repo-path hash + a hash of the content we wrote into .dev.vars. The latter is the restore token: restore only if the file still has that content. One stash per checkout.
const STASH_PREFIX = `folio-dev-vars-${sha(DEV_VARS).slice(0, 8)}-`;
const stashPath = (contentHash) => join(tmpdir(), STASH_PREFIX + contentHash);

function listStashes() {
  try {
    return readdirSync(tmpdir()).filter((f) => f.startsWith(STASH_PREFIX));
  } catch {
    return [];
  }
}

function readDevVars() {
  try {
    return readFileSync(DEV_VARS, "utf8");
  } catch {
    return null;
  }
}

// After a SIGKILL'd run: restore only if the file still has the content we left.
function recoverStash() {
  const leftovers = listStashes();
  if (!leftovers.length) return;
  const current = readDevVars();
  const mine =
    current === null
      ? undefined
      : leftovers.find((f) => f.slice(STASH_PREFIX.length) === sha(current));
  if (!mine) {
    console.log(
      ".dev.vars doesn't match the previous run's stash (edited since?); leaving it alone. Original at:",
    );
    for (const f of leftovers) console.log(`  ${join(tmpdir(), f)}`);
    return;
  }
  writeFileSync(DEV_VARS, readFileSync(join(tmpdir(), mine), "utf8"));
  // The file is back to a known state, so any other leftover stashes are stale.
  for (const f of leftovers) rmSync(join(tmpdir(), f), { force: true });
  console.log("Previous run didn't exit cleanly; .dev.vars restored.");
}

recoverStash();

// Reads only a few keys and touches nothing else; explicit env vars win.
function conf(key) {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  return (
    readDevVars()
      ?.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]
      ?.trim() || undefined
  );
}

const name = conf("TUNNEL_NAME");
const hostname = conf("TUNNEL_HOSTNAME");
if (name && !hostname) {
  console.error(
    `TUNNEL_NAME=${name} also needs TUNNEL_HOSTNAME (the tunnel's full https address).`,
  );
  process.exit(1);
}

// Restores from the in-memory original; the temp-dir stash is only the SIGKILL fallback.
let originalDevVars = null;
let patchedHash = null;

function overrideAuthUrl(publicUrl) {
  const original = readDevVars();
  if (original === null) return; // no such file: don't create one, the config comes from elsewhere
  const line = `BETTER_AUTH_URL=${publicUrl}`;
  const patched = /^BETTER_AUTH_URL=.*$/m.test(original)
    ? original.replace(/^BETTER_AUTH_URL=.*$/m, line)
    : `${original.replace(/\n?$/, "\n")}${line}\n`;
  if (patched === original) return; // already this address
  patchedHash = sha(patched);
  writeFileSync(stashPath(patchedHash), original);
  writeFileSync(DEV_VARS, patched);
  originalDevVars = original;
}

// Compare before restoring: if you edited .dev.vars during the run (e.g. added a key), that edit matters more than our restore.
function restoreAuthUrl() {
  if (originalDevVars === null) return;
  const current = readDevVars();
  if (current !== null && sha(current) === patchedHash) {
    writeFileSync(DEV_VARS, originalDevVars);
    rmSync(stashPath(patchedHash), { force: true });
  } else {
    console.log(`\n.dev.vars was changed during the run; not restored so your edits survive.`);
    console.log(
      `Original at ${stashPath(patchedHash)}; remember to set BETTER_AUTH_URL back yourself.`,
    );
  }
  originalDevVars = null;
}

const children = [];
let done = false;
function shutdown(code = 0) {
  if (done) return;
  done = true;
  for (const c of children) c.kill("SIGTERM");
  restoreAuthUrl(); // stop the server before restoring so vite doesn't hot-reload on the change
  process.exit(code);
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => shutdown(0));
process.on("exit", restoreAuthUrl); // covers normal exit and thrown errors

function vite(args, host) {
  const child = spawn("pnpm", ["exec", "vite", ...args], {
    stdio: "inherit",
    cwd: WEB_ROOT,
    env: { ...process.env, DEV_ALLOWED_HOST: host },
  });
  children.push(child);
  return child;
}

function startServer(publicUrl) {
  const host = URL.parse?.(publicUrl)?.host ?? publicUrl;
  overrideAuthUrl(publicUrl);

  console.log(`\n  ${publicUrl}  ${usePreview ? "(build)" : "(dev)"}`);
  console.log(
    originalDevVars === null
      ? "  BETTER_AUTH_URL unchanged"
      : "  BETTER_AUTH_URL temporarily points at it (rpID follows), restored on exit",
  );
  if (!name) console.log("  Random domain: re-register passkeys on the phone");
  console.log("  Ctrl+C to stop (tunnel and server together)\n");

  if (!usePreview) {
    vite(["dev", "--port", PORT], host).on("exit", (c) => shutdown(c ?? 0));
    return;
  }
  vite(["build"], host).on("exit", (c) => {
    if (c !== 0) return shutdown(c ?? 1);
    vite(["preview", "--port", PORT], host).on("exit", (c2) => shutdown(c2 ?? 0));
  });
}

const tunnel = spawn(
  "cloudflared",
  name
    ? ["tunnel", "run", "--url", `http://localhost:${PORT}`, name]
    : ["tunnel", "--url", `http://localhost:${PORT}`, "--no-autoupdate"],
  { stdio: ["ignore", "pipe", "pipe"] },
);
children.push(tunnel);

tunnel.on("error", (err) => {
  console.error(
    err.code === "ENOENT"
      ? "cloudflared not found. Install it: brew install cloudflared"
      : `Failed to start cloudflared: ${err.message}`,
  );
  shutdown(1);
});
tunnel.on("exit", (code) => {
  if (!done && code !== 0) {
    console.error(`cloudflared exited (code ${code}).`);
    shutdown(code ?? 1);
  }
});

if (name) {
  startServer(hostname); // a named tunnel's domain is known; no need to wait for it to print
} else {
  // The quick tunnel prints its random domain in a banner on stderr; the first match is enough.
  let started = false;
  for (const stream of [tunnel.stdout, tunnel.stderr]) {
    createInterface({ input: stream }).on("line", (line) => {
      const match = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !started) {
        started = true;
        startServer(match[0]);
      }
    });
  }
  setTimeout(() => {
    if (!started) {
      console.error(
        "No trycloudflare domain after 60s; run cloudflared on its own to see what it reports.",
      );
      shutdown(1);
    }
  }, 60_000).unref();
}
