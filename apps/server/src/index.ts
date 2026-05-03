import cors from "cors";
import express from "express";
import { consumeInboundMessages, createSpectrumApp } from "@runner-mobile/spectrum";
import { handleInboundMessage } from "./session.ts";
import { linkRouter } from "./routes/link.ts";
import { makeCronRouter } from "./routes/cron.ts";
import { memoryRouter } from "./routes/memory.ts";

const PORT = Number(process.env.PORT ?? 3001);

type ServiceState = {
  spectrumReady: boolean;
  spectrumError: string | null;
};

async function main() {
  let spectrumApp: Awaited<ReturnType<typeof createSpectrumApp>> | null = null;
  const state: ServiceState = {
    spectrumReady: false,
    spectrumError: null,
  };

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "25mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/readyz", (_req, res) => {
    const ok = state.spectrumReady;
    res.status(ok ? 200 : 503).json({
      ok,
      spectrum: {
        ready: state.spectrumReady,
        error: state.spectrumError,
      },
    });
  });

  app.use("/api/link", linkRouter);
  app.use("/api/cron", makeCronRouter(() => spectrumApp));
  app.use("/api/memory", memoryRouter);

  app.listen(PORT, () => {
    console.log(`server listening on :${PORT}`);
  });

  try {
    spectrumApp = await createSpectrumApp();
    state.spectrumReady = true;
    state.spectrumError = null;

    // Background loop never returns under normal operation.
    consumeInboundMessages(spectrumApp, async ({ phoneNumber, text, images }) => {
      await handleInboundMessage({ spectrumApp: spectrumApp!, phoneNumber, text, images });
    }).catch((err) => {
      state.spectrumReady = false;
      state.spectrumError = err instanceof Error ? err.message : String(err);
      console.error("Spectrum consumer crashed:", err);
    });
  } catch (err) {
    state.spectrumReady = false;
    state.spectrumError = err instanceof Error ? err.message : String(err);
    console.error("Spectrum unavailable:", err);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
