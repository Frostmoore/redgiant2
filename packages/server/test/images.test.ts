import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { imageCost, imageFileName } from "../src/index.js";
import { startServer, wsClient } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");

/** The Images API in miniature: streams two previews, then the picture with its usage. */
async function fakeOpenAI() {
  const asked: { auth: string | undefined; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw) as Record<string, unknown>;
    asked.push({ auth: req.headers.authorization, body });
    if (String(body.prompt).includes("forbidden")) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ error: { message: "Your request was rejected by the safety system." } }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const i of [0, 1])
      res.write(
        `data: ${JSON.stringify({ type: "image_generation.partial_image", partial_image_index: i, b64_json: PNG })}\n\n`,
      );
    res.end(
      `data: ${JSON.stringify({
        type: "image_generation.completed",
        b64_json: PNG,
        usage: { input_tokens: 20, output_tokens: 1000, input_tokens_details: { text_tokens: 20 } },
      })}\n\n`,
    );
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, asked, close: () => new Promise((ok) => server.close(ok)) };
}

let cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

describe("generate_image", () => {
  it("prices images from their tokens and names files after the prompt", () => {
    expect(imageCost({ input_tokens: 20, output_tokens: 1000 })).toBeCloseTo(0.0301, 6);
    expect(imageCost(undefined)).toBeNull();
    expect(imageFileName("Un gatto rosso sul tetto, stile acquerello!")).toBe(
      "un-gatto-rosso-sul-tetto-stile-acquerell",
    );
  });

  it("draws with previews, saves the PNG, records the cost and reports refusals", async () => {
    const openai = await fakeOpenAI();
    const s = await startServer((req) => {
      const last = req.messages.at(-1);
      const said = last?.parts.find((p) => p.type === "text");
      if (last?.parts.some((p) => p.type === "tool_result")) return { text: "done" };
      return {
        toolCalls: [
          {
            name: "generate_image",
            input: { prompt: said?.type === "text" ? said.text : "", size: "1536x1024" },
          },
        ],
      };
    });
    cleanup.push(s.close, openai.close);
    const god = await s.api<{ id: string }>("POST", "/api/agents", {
      kind: "god",
      parentId: null,
      name: "God",
    });
    const sid = (
      await s.api<{ sessionId: string }>("POST", "/api/sessions", { agentId: god.body.id })
    ).body.sessionId;

    // Not set up: the tool is there and says what to do.
    await (await s.core.send("me", sid, "a red cat")).done;
    const results = async () =>
      (await s.core.history("me", sid)).flatMap((e) =>
        e.type === "tool.result" ? [e.payload] : [],
      );
    expect((await results())[0]).toMatchObject({
      ok: false,
      output: expect.stringMatching(/not set up/),
    });

    s.core.setImages({ key: "sk-images-test-key-123", baseUrl: openai.url });
    const c = await wsClient(s.url);
    cleanup.push(async () => c.close());
    c.send({ type: "session.follow", sessionId: sid });
    await c.waitFor("session.synced");
    await (await s.core.send("me", sid, "a red cat on a roof")).done;
    const progress = c.messages.filter((m) => m.type === "image.progress");
    expect(progress.map((m) => m.type === "image.progress" && m.percent)).toEqual([5, 25, 50, 100]);
    expect(openai.asked[0]).toMatchObject({
      auth: "Bearer sk-images-test-key-123",
      body: { model: "gpt-image-2.5-flare", size: "1536x1024", stream: true, partial_images: 3 },
    });
    const done = (await results())[1];
    expect(done?.ok).toBe(true);
    const rel = done?.output.match(/Saved (images\/\S+\.png)/)?.[1] ?? "";
    expect(rel).toMatch(/^images\/\d{4}-\d{2}-\d{2}\/\d{6}-a-red-cat-on-a-roof\.png$/);
    expect(done?.output).toContain("about $0.030");
    const saved = await readFile(join(s.core.platformPath("me"), rel));
    expect(saved.toString("base64")).toBe(PNG);
    const budget = (
      await s.api<{ scope: string; used: { usd: number } }[]>("GET", "/api/budgets")
    ).body.find((b) => b.scope === "global");
    expect(budget?.used.usd).toBeGreaterThanOrEqual(0.03);

    // OpenAI's refusal reaches the agent in its own words.
    await (await s.core.send("me", sid, "something forbidden")).done;
    expect((await results())[2]).toMatchObject({
      ok: false,
      output: expect.stringContaining("rejected by the safety system"),
    });
  });
});
