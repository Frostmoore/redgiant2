import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { defineConfig, type Plugin } from "vite";
import { patchSvgcanvas } from "./svgcanvas-patch.js";

// In development the API and the live channels are proxied to a running server.
const server = process.env.REDGIANT_URL ?? "http://127.0.0.1:7600";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** The drawing editor's engine with our changes (G37.6, svgcanvas-patch.ts). */
const svgcanvasPatch = (): Plugin => ({
  name: "redgiant-svgcanvas-patch",
  enforce: "pre",
  transform(code, id) {
    const out = patchSvgcanvas(id, code);
    return out === undefined ? null : { code: out, map: null };
  },
});

export default defineConfig({
  // React stays React: the sheet editor's Univer (G37.3) runs its own React in its own chunk.
  plugins: [svgcanvasPatch(), preact({ reactAliasesEnabled: false })],
  resolve: {
    alias: {
      // svgcanvas imports these without declaring them (G37.6): its PDF export is never used (the
      // server makes PDFs), and its path polyfill (BSD-3-Clause) is ours to give.
      jspdf: here("./src/viewers/svgcanvas-stubs/jspdf.js"),
      "svg2pdf.js": here("./src/viewers/svgcanvas-stubs/svg2pdf.js"),
      pathseg: here("./node_modules/pathseg/pathseg.js"),
    },
  },
  server: {
    proxy: {
      "/api": server,
      "/ws": { target: server.replace(/^http/, "ws"), ws: true },
      "/term": { target: server.replace(/^http/, "ws"), ws: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, manifest: true, chunkSizeWarningLimit: 1500 },
});
