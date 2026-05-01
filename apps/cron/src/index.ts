// Heartbeat cron. Posts to the server's /api/cron/tick endpoint, which does
// the actual work (so Spectrum runtime + Postgres pool stay in one process).
//
// Railway cron schedule: every 15 minutes. Quiet-hours filter lives in the server.

const SERVER_URL = process.env.SERVER_PUBLIC_URL ?? "http://localhost:3001";
const SECRET = process.env.CRON_SHARED_SECRET;

if (!SECRET) {
  console.error("CRON_SHARED_SECRET is required");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${SERVER_URL}/api/cron/tick`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${SECRET}`,
    },
  });
  const body = await res.text();
  if (!res.ok) {
    console.error(`tick failed: ${res.status} ${body}`);
    process.exit(1);
  }
  console.log(`tick ok: ${body}`);
}

main().catch((err) => {
  console.error("cron crashed:", err);
  process.exit(1);
});
