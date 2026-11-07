#!/usr/bin/env node
// A test server for differential updates (G36.18), shaped like GitHub's release downloads:
// /download/<name> answers 302 to /blob/<name>, which serves one byte range (206) and refuses
// several in one request (501). /release.json is a release as GitHub's API describes it, with
// the sha256 "digest" of every asset. Counts the bytes it served (GET /served).
//
//   node packaging/update/range-server.mjs <folder with the assets> <port> [version]
import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const [dir, port = "18765", version = "0.0.1"] = process.argv.slice(2);
let served = 0;
const base = () => `http://127.0.0.1:${port}`;

createServer((req, res) => {
  const url = new URL(req.url, base());
  if (url.pathname === "/served") {
    res.setHeader("content-type", "text/plain");
    return res.end(String(served));
  }
  if (url.pathname === "/release.json") {
    const assets = readdirSync(dir)
      .filter((n) => statSync(join(dir, n)).isFile())
      .map((name) => ({
        name,
        size: statSync(join(dir, name)).size,
        digest: `sha256:${createHash("sha256")
          .update(readFileSync(join(dir, name)))
          .digest("hex")}`,
        browser_download_url: `${base()}/download/${name}`,
      }));
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ tag_name: `v${version}`, assets }));
  }
  const name = decodeURIComponent(url.pathname.split("/").pop() ?? "");
  const file = join(dir, name);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    res.statusCode = 404;
    return res.end();
  }
  if (url.pathname.startsWith("/download/")) {
    res.statusCode = 302;
    res.setHeader("location", `${base()}/blob/${name}?sig=test`);
    return res.end();
  }
  const range = req.headers.range;
  if (!range) {
    res.setHeader("content-length", size);
    served += size;
    return createReadStream(file).pipe(res);
  }
  if (range.includes(",")) {
    res.statusCode = 501;
    return res.end("several ranges are not served");
  }
  const m = /^bytes=(\d+)-(\d*)$/.exec(range);
  if (!m) {
    res.statusCode = 416;
    return res.end();
  }
  const start = Number(m[1]);
  const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  res.statusCode = 206;
  res.setHeader("accept-ranges", "bytes");
  res.setHeader("content-range", `bytes ${start}-${end}/${size}`);
  res.setHeader("content-length", end - start + 1);
  served += end - start + 1;
  createReadStream(file, { start, end }).pipe(res);
}).listen(Number(port), "127.0.0.1", () => console.log(`serving ${dir} on ${base()}`));
