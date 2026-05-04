import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4173,
  },
  preview: {
    port: 4173,
    // Allow Railway's auto-generated domains and any custom domain.
    allowedHosts: true,
  },
});
