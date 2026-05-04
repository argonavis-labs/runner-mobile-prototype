import { Router } from "express";
import { runHeartbeatTicks, runTaskCheckInTicks } from "../session.ts";
import type { SpectrumApp } from "@runner-mobile/spectrum";

export function makeCronRouter(getSpectrumApp: () => SpectrumApp | null): Router {
  const router = Router();

  router.post("/tick", async (req, res) => {
    const provided = req.header("authorization")?.replace(/^Bearer /, "");
    const expected = process.env.CRON_SHARED_SECRET;
    if (!expected || provided !== expected) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    const spectrumApp = getSpectrumApp();
    if (!spectrumApp) {
      res.status(503).json({ error: "spectrum_unavailable" });
      return;
    }

    // runTaskCheckInTicks reports back which users it already serviced this
    // tick, so runHeartbeatTicks can either skip them (already woken) or
    // batch the heartbeat into the same synthetic message via the shared
    // session.
    const taskTicks = await runTaskCheckInTicks(spectrumApp);
    const heartbeatTicks = await runHeartbeatTicks(spectrumApp, {
      skipUsers: taskTicks.runForPhones,
    });
    res.json({ task: taskTicks, heartbeat: heartbeatTicks });
  });

  return router;
}
