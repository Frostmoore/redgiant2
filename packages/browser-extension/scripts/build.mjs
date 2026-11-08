// Builds the browser extension (G36.21): one script per part with Vite (IIFE, no modules: a
// content script cannot be one), the manifests for Chromium (Chrome, Edge, Brave, Opera) and
// Firefox, `_locales` from src/i18n.ts, the drawn icons, and the two zips. Both zips are also
// copied next to the web page (`packages/web/dist/redgiant-keychain-*.zip`), so every RedGiant
// serves the extension it can link to. Same input, same zip: dates inside are fixed.
//
//   node scripts/build.mjs            the extension in dist/
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";
import { build } from "vite";
import { iconPng } from "./icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(root, "dist");
const chromium = join(dist, "chromium");
const firefox = join(dist, "firefox");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// A release passes its own version (`v3.4.0` → 3.4.0); the manifest takes only digits and dots.
const version =
  (process.env.REDGIANT_VERSION ?? pkg.version).replace(/^v/, "").replace(/[^0-9.]/g, "") ||
  "0.1.0";

await rm(dist, { recursive: true, force: true });
await mkdir(chromium, { recursive: true });

for (const part of ["background", "content", "popup", "offscreen"])
  await build({
    configFile: false,
    logLevel: "warn",
    root,
    build: {
      outDir: chromium,
      emptyOutDir: false,
      target: "es2022",
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      lib: {
        entry: join(root, "src", `${part}.ts`),
        formats: ["iife"],
        name: `redgiant_${part}`,
        fileName: () => `${part}.js`,
      },
    },
  });

for (const f of ["popup.html", "popup.css", "offscreen.html"])
  await cp(join(root, "static", f), join(chromium, f));

// Icons and words.
await mkdir(join(chromium, "icons"));
for (const size of [16, 32, 48, 128])
  await writeFile(join(chromium, "icons", `icon-${size}.png`), iconPng(size));
const i18n = await readFile(join(root, "src", "i18n.ts"), "utf8");
const word = (lang, key) => {
  const block = i18n.slice(i18n.indexOf(lang === "en" ? "const en = {" : "const it: Record"));
  const m = block.match(new RegExp(`\\n  ${key}:\\s*\\n?\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) throw new Error(`No ${key} for ${lang} in src/i18n.ts`);
  return JSON.parse(`"${m[1]}"`);
};
for (const lang of ["en", "it"]) {
  await mkdir(join(chromium, "_locales", lang), { recursive: true });
  const messages = Object.fromEntries(
    ["extName", "extDescription"].map((k) => [k, { message: word(lang, k) }]),
  );
  await writeFile(
    join(chromium, "_locales", lang, "messages.json"),
    `${JSON.stringify(messages, null, 2)}\n`,
  );
}

const icons = {
  16: "icons/icon-16.png",
  32: "icons/icon-32.png",
  48: "icons/icon-48.png",
  128: "icons/icon-128.png",
};
const base = {
  manifest_version: 3,
  name: "__MSG_extName__",
  description: "__MSG_extDescription__",
  default_locale: "en",
  version,
  icons,
  action: {
    default_popup: "popup.html",
    default_title: "__MSG_extName__",
    default_icon: { 16: icons[16], 32: icons[32] },
  },
  content_scripts: [
    {
      matches: ["http://*/*", "https://*/*"],
      js: ["content.js"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  // RedGiant's own address is whatever the person types, at home or away: the background must be
  // allowed to reach any http(s) host. The same hosts the content script already runs on.
  host_permissions: ["http://*/*", "https://*/*"],
};
const manifests = {
  chromium: {
    ...base,
    minimum_chrome_version: "116",
    background: { service_worker: "background.js" },
    permissions: ["storage", "alarms", "scripting", "clipboardWrite", "offscreen"],
  },
  firefox: {
    ...base,
    background: { scripts: ["background.js"] },
    permissions: ["storage", "alarms", "scripting", "clipboardWrite"],
    browser_specific_settings: {
      gecko: { id: "keychain@redgiant.local", strict_min_version: "121.0" },
    },
  },
};
await writeFile(
  join(chromium, "manifest.json"),
  `${JSON.stringify(manifests.chromium, null, 2)}\n`,
);
await cp(chromium, firefox, { recursive: true });
await rm(join(firefox, "offscreen.html"));
await rm(join(firefox, "offscreen.js"));
await writeFile(join(firefox, "manifest.json"), `${JSON.stringify(manifests.firefox, null, 2)}\n`);

/** Every file of a folder, sorted, with a fixed date: the same zip from the same files. */
async function zipOf(dir) {
  const { readdir } = await import("node:fs/promises");
  const files = {};
  const walk = async (d) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else
        files[relative(dir, p).split("\\").join("/")] = [
          await readFile(p),
          { mtime: new Date(Date.UTC(2026, 0, 1)) },
        ];
    }
  };
  await walk(dir);
  return zipSync(files, { level: 9 });
}
const zips = {
  chromium: join(dist, "redgiant-keychain-chromium.zip"),
  firefox: join(dist, "redgiant-keychain-firefox.zip"),
};
await writeFile(zips.chromium, await zipOf(chromium));
await writeFile(zips.firefox, await zipOf(firefox));

const web = join(root, "..", "web", "dist");
if (await stat(web).catch(() => null))
  for (const z of Object.values(zips)) await cp(z, join(web, basename(z)));
console.log(
  `browser extension ${version}: ${relative(process.cwd(), zips.chromium)}, ${relative(process.cwd(), zips.firefox)}`,
);
