import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

// In development the API and the live channels are proxied to a running server.
const server = process.env.REDGIANT_URL ?? "http://127.0.0.1:7600";

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
      "/term": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
