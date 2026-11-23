// Kills leftover dev servers of this repo before dev starts (called by package.json `predev`).
//
// `vite dev --port 3000` bumps the port silently when it's taken, so stale servers pile up and new ones land past 3020, breaking everything that targets 3000 (`sync:*:local` curls, callback URLs, tunnels).
//
// Not `pkill -f`: it isn't on every PATH and pattern matching easily runs too wide. `ps` is POSIX; filtering by this repo's absolute path in Node can't hit other projects.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This app's root (one above scripts/). Only vite processes whose command line contains this prefix are killed.
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function staleDevServers() {
  // pid + full command line, split on the first space.
  const out = execFileSync("ps", ["-Ao", "pid=,command="], { encoding: "utf8" });
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const spaceAt = line.indexOf(" ");
      return { pid: Number(line.slice(0, spaceAt)), command: line.slice(spaceAt + 1) };
    })
    .filter(
      ({ pid, command }) =>
        pid !== process.pid &&
        pid !== process.ppid &&
        command.includes(APP_ROOT) &&
        // vite dev servers only; `vite build` / `vite preview` are left alone.
        /\bvite(\.js)?\b.*\bdev\b/.test(command),
    );
}

const stale = staleDevServers();
if (stale.length === 0) process.exit(0);

// SIGTERM first so it can clean up (workerd children, file handles in .wrangler).
for (const { pid } of stale) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}
await sleep(600);

// Follow up on stragglers.
const survivors = staleDevServers();
for (const { pid } of survivors) {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Same.
  }
}

// Say what was killed.
console.log(
  `[dev] killed ${stale.length} stale dev server(s): ${stale.map((s) => s.pid).join(", ")}`,
);
