#!/usr/bin/env node
// Railway dispatches build + start by RAILWAY_SERVICE_NAME so a single
// monorepo deploys per-service correctly via `railway up --service X`.

import { spawn } from "node:child_process";

const phase = process.argv[2]; // "build" or "start"
const service = process.env.RAILWAY_SERVICE_NAME ?? "";

const matrix = {
  server: {
    build: ["pnpm", ["install", "--frozen-lockfile"]],
    start: [
      "sh",
      [
        "-c",
        "pnpm --filter @runner-mobile/db migrate && pnpm --filter @runner-mobile/server start",
      ],
    ],
  },
  microsite: {
    build: [
      "sh",
      [
        "-c",
        "pnpm install --frozen-lockfile && pnpm --filter @runner-mobile/microsite build",
      ],
    ],
    start: [
      "sh",
      [
        "-c",
        "pnpm --filter @runner-mobile/microsite preview --host 0.0.0.0 --port $PORT",
      ],
    ],
  },
  cron: {
    build: ["pnpm", ["install", "--frozen-lockfile"]],
    start: ["pnpm", ["--filter", "@runner-mobile/cron", "start"]],
  },
};

const cfg = matrix[service];
if (!cfg) {
  console.error(`Unknown RAILWAY_SERVICE_NAME: '${service}'. Set RAILWAY_SERVICE_NAME or run via Railway.`);
  process.exit(1);
}

const [cmd, args] = cfg[phase];
console.log(`[railway-dispatch] ${service} ${phase}: ${cmd} ${args.join(" ")}`);

const child = spawn(cmd, args, { stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error("[railway-dispatch] spawn error:", err);
  process.exit(1);
});
