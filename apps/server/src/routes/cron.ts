import { Router } from "express";
import { runHeartbeatTicks } from "../session.ts";
import type { SpectrumApp } from "@runner-mobile/spectrum";

const ET = "America/New_York";

function isQuietHours(now = new Date()): boolean {
  const hour = Number(
    now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: ET }),
  );
  return hour < 9 || hour >= 20;
}

export function makeCronRouter(getSpectrumApp: () => SpectrumApp | null): Router {
  const router = Router();

  router.post("/tick", async (req, res) => {
    const provided = req.header("authorization")?.replace(/^Bearer /, "");
    const expected = process.env.CRON_SHARED_SECRET;
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    if (isQuietHours()) {
      res.json({ skipped: "quiet_hours" });
      return;
    }

    const spectrumApp = getSpectrumApp();
    if (!spectrumApp) {
      res.status(503).json({ error: "spectrum_unavailable" });
      return;
    }

    const result = await runHeartbeatTicks(spectrumApp);
    res.json(result);
  });

  return router;
}
