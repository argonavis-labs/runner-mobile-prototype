import cors from "cors";
import express from "express";
import { consumeInboundMessages, createSpectrumApp } from "@runner-mobile/spectrum";
import { handleInboundMessage } from "./session.ts";
import { linkRouter } from "./routes/link.ts";
import { makeCronRouter } from "./routes/cron.ts";
import { memoryRouter } from "./routes/memory.ts";

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  const spectrumApp = await createSpectrumApp();

  // Background loop — never returns under normal operation.
  consumeInboundMessages(spectrumApp, async ({ phoneNumber, text }) => {
    await handleInboundMessage({ spectrumApp, phoneNumber, text });
  }).catch((err) => {
    console.error("Spectrum consumer crashed:", err);
    process.exit(1);
  });

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "25mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/link", linkRouter);
  app.use("/api/cron", makeCronRouter(spectrumApp));
  app.use("/api/memory", memoryRouter);

  app.listen(PORT, () => {
    console.log(`server listening on :${PORT}`);
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
