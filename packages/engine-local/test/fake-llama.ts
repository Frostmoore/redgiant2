import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

/**
 * A llama.cpp server in miniature: slots hold the rendered prompt; the prefix shared with
 * the next prompt is "cached" (4 characters = 1 token); slot files are saved to and
 * restored from a directory. Restarting = a new instance with empty slots.
 */
export async function fakeLlama(o: {
  slots: number;
  dir: string;
  model?: string;
  delayMs?: number;
}) {
  const slots: string[] = Array(o.slots).fill("");
  const requests: { slot: number; cached: number; processed: number }[] = [];
  const render = (body: {
    messages: { role: string; content: string | null; reasoning_content?: string }[];
  }) =>
    `${body.messages.map((m) => `<${m.role}>${m.content ?? ""}</${m.role}>`).join("")}<assistant>`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let raw = "";
    for await (const c of req) raw += c;
    const body = raw ? JSON.parse(raw) : {};
    const json = (v: unknown) =>
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
    if (url.pathname === "/props")
      return json({
        model_path: o.model ?? "/models/fake.gguf",
        total_slots: o.slots,
        build_info: "fake",
        default_generation_settings: { n_ctx: 4096 },
      });
    if (url.pathname === "/v1/models")
      return json({ data: [{ id: "fake", meta: { n_ctx: 4096 } }] });
    const slotMatch = url.pathname.match(/^\/slots\/(\d+)$/);
    if (slotMatch) {
      const slot = Number(slotMatch[1]);
      const action = url.searchParams.get("action");
      if (action === "save") {
        await writeFile(join(o.dir, body.filename), slots[slot] ?? "");
        return json({
          id_slot: slot,
          filename: body.filename,
          n_saved: Math.ceil((slots[slot] ?? "").length / 4),
          n_written: (slots[slot] ?? "").length,
          timings: { save_ms: 1 },
        });
      }
      if (action === "restore") {
        slots[slot] = await readFile(join(o.dir, body.filename), "utf8");
        return json({
          id_slot: slot,
          filename: body.filename,
          n_restored: Math.ceil(slots[slot].length / 4),
          n_read: slots[slot].length,
          timings: { restore_ms: 2 },
        });
      }
    }
    if (url.pathname === "/v1/chat/completions") {
      const slot = body.id_slot as number;
      const prompt = render(body);
      const old = slots[slot] ?? "";
      let common = 0;
      while (common < old.length && common < prompt.length && old[common] === prompt[common])
        common++;
      const cached = Math.floor(common / 4);
      const total = Math.ceil(prompt.length / 4);
      requests.push({ slot, cached, processed: total - cached });
      if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
      slots[slot] = `${prompt}ok</assistant>`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], timings: { cache_n: cached, prompt_n: total - cached, prompt_ms: total - cached, predicted_n: 1, predicted_ms: 1 } })}\n\n`,
      );
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    slots,
    close: () => new Promise((ok) => server.close(ok)),
  };
}
