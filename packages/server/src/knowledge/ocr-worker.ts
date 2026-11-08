// The OCR's worker thread (G36.6): tesseract.js's own worker script, with its core (the
// WebAssembly build RedGiant downloaded, `corePath`) and its languages read from this computer.
// Never a request to the network from here: a language that is missing is an error.
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { parentPort } from "node:worker_threads";
import { gunzipSync } from "node:zlib";

// Tesseract says it looked for optional word lists the «best_int» data does not carry: not news.
for (const k of ["log", "error", "warn"] as const) {
  const say = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    if (/failed to load \.\/\w+\.(special-words|user-words|user-patterns)/.test(String(args[0])))
      return;
    say(...args);
  };
}

const require = createRequire(import.meta.url);
const worker = require("tesseract.js/src/worker-script") as {
  dispatchHandlers(packet: unknown, send: (o: unknown) => void): void;
  setAdapter(a: Record<string, unknown>): void;
};

parentPort?.on("message", (packet) =>
  worker.dispatchHandlers(packet, (o) => parentPort?.postMessage(o)),
);

worker.setAdapter({
  getCore: async (
    _lstmOnly: boolean,
    corePath: string,
    res: { progress(p: { status: string; progress: number }): void },
  ) => {
    res.progress({ status: "loading tesseract core", progress: 0 });
    const core = require(corePath);
    res.progress({ status: "loading tesseract core", progress: 1 });
    return core;
  },
  gunzip: gunzipSync,
  fetch: () => {
    throw new Error("The OCR reads its languages from this computer only");
  },
  readCache: readFile,
  writeCache: writeFile,
  deleteCache: (p: string) => unlink(p).catch(() => {}),
  checkCache: (p: string) =>
    access(p).then(
      () => true,
      () => false,
    ),
});
