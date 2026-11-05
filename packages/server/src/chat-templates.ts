// RedGiant's own chat templates for local models (2026-11-05). gpt-oss's template drops past
// reasoning once an answer follows it, so the conversation's text changes at every new message
// and llama.cpp reads it again from there (seen on Rig: 5,400 of 8,500 tokens re-read, 72 s).
// Ours keeps it: the conversation only grows at its end and the KV cache is reused.

import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The packaged templates (next to `dist/`). */
const SOURCE = fileURLToPath(new URL("../templates/", import.meta.url));

/** The template a model needs, by its file's name; none for the others (their own is fine). */
export function templateFor(model: string): string | undefined {
  return /gpt-oss/i.test(model) ? "redgiant-gpt-oss.jinja" : undefined;
}

/** Copies a template where the engine reads it; returns its path there. */
export async function installTemplate(name: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const to = join(dir, name);
  await copyFile(join(SOURCE, name), to);
  return to;
}
