import { afterEach, describe, expect, it } from "vitest";
import type { Incoming } from "../src/bridge.js";
import { SignalTransport } from "../src/signal.js";

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake signal-cli-rest-api: answers by path, records every call. */
function fakeSignal(handler: (c: Call) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const c: Call = {
      method: init?.method ?? "GET",
      path: decodeURIComponent(url.pathname),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    return (await handler(c)) ?? new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchFn };
}

const json = (v: unknown) => Response.json(v);

async function waitFor(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const transports: SignalTransport[] = [];
afterEach(async () => {
  for (const t of transports.splice(0)) await t.stop();
});

function make(handler: Parameters<typeof fakeSignal>[0], pollMs = 10) {
  const f = fakeSignal(handler);
  const t = new SignalTransport({
    url: "http://signal.test/",
    number: "+390001",
    fetch: f.fetch,
    pollMs,
  });
  transports.push(t);
  return { t, calls: f.calls };
}

describe("SignalTransport", () => {
  it("refuses to start when the service is unreachable", async () => {
    const t = new SignalTransport({
      url: "http://signal.test",
      number: "+390001",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(t.start(async () => {})).rejects.toThrow("fetch failed");
    const { t: t2 } = make(() => new Response("down", { status: 502 }));
    await expect(t2.start(async () => {})).rejects.toThrow(/502/);
  });

  it("turns envelopes into messages: text, group, voice note", async () => {
    let served = false;
    const { t } = make((c) => {
      if (c.path === "/v1/about") return json({ versions: ["v1", "v2"] });
      if (c.path === "/v1/receive/+390001") {
        if (served) return json([]);
        served = true;
        return json([
          { envelope: { sourceNumber: "+391111", sourceName: "Ada", typingMessage: {} } },
          {
            envelope: {
              source: "+391111",
              sourceNumber: "+391111",
              sourceName: "Ada",
              dataMessage: { message: "hello" },
            },
          },
          {
            envelope: {
              sourceNumber: null,
              sourceUuid: "uuid-2",
              dataMessage: { message: "in group", groupInfo: { groupId: "GRP==" } },
            },
          },
          {
            envelope: {
              sourceNumber: "+391111",
              dataMessage: {
                message: null,
                attachments: [
                  { id: "voice1", contentType: "audio/aac" },
                  { id: "pic1", contentType: "image/png", filename: "p.png" },
                ],
              },
            },
          },
        ]);
      }
      if (c.path === "/v1/attachments/voice1") return new Response(new Uint8Array([1, 2, 3]));
      if (c.path === "/v1/attachments/pic1") return new Response(new Uint8Array([9]));
      return undefined;
    });
    const got: Incoming[] = [];
    await t.start(async (m) => {
      got.push(m);
    });
    await waitFor(() => got.length === 3);
    expect(got[0]).toEqual({
      userId: "+391111",
      chatId: "+391111",
      username: "Ada",
      text: "hello",
    });
    expect(got[1]).toMatchObject({ userId: "uuid-2", chatId: "group.GRP==", text: "in group" });
    expect(got[2]?.text).toBeUndefined();
    expect(got[2]?.audio?.mime).toBe("audio/aac");
    expect([...(got[2]?.audio?.data ?? [])]).toEqual([1, 2, 3]);
    expect(got[2]?.files).toEqual([{ name: "p.png", data: Buffer.from([9]), mime: "image/png" }]);
  });

  it("never overlaps polls, and stop stops them", async () => {
    let active = 0;
    let most = 0;
    let polls = 0;
    const { t, calls } = make(async (c) => {
      if (c.path === "/v1/about") return json({});
      if (c.path.startsWith("/v1/receive/")) {
        polls++;
        active++;
        most = Math.max(most, active);
        // Slower than the poll interval: an interval timer would start the next one meanwhile.
        await new Promise((r) => setTimeout(r, 30));
        active--;
        return json([]);
      }
      return undefined;
    }, 1);
    await t.start(async () => {});
    await waitFor(() => polls >= 4);
    expect(most).toBe(1);
    await t.stop();
    const after = calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(calls.length).toBe(after);
  });

  it("sends text, files and typing with the right payloads", async () => {
    const { t, calls } = make((c) => {
      if (c.path === "/v2/send") return json({ timestamp: 1700000000123 });
      if (c.path.startsWith("/v1/typing-indicator/")) return new Response(null, { status: 204 });
      return undefined;
    });
    expect(await t.send("+391111", "hi", [{ id: "a", label: "A" }])).toBe("1700000000123");
    expect(await t.send("group.GRP==", "all")).toBe("1700000000123");
    await t.sendFile("+391111", Buffer.from("data"), "r.txt", "text/plain", "the report");
    await t.typing("group.GRP==");
    expect(calls).toEqual([
      {
        method: "POST",
        path: "/v2/send",
        body: { message: "hi", number: "+390001", recipients: ["+391111"] },
      },
      {
        method: "POST",
        path: "/v2/send",
        body: { message: "all", number: "+390001", recipients: ["GRP=="] },
      },
      {
        method: "POST",
        path: "/v2/send",
        body: {
          message: "the report",
          base64_attachments: [
            `data:text/plain;filename=r.txt;base64,${Buffer.from("data").toString("base64")}`,
          ],
          number: "+390001",
          recipients: ["+391111"],
        },
      },
      { method: "PUT", path: "/v1/typing-indicator/+390001", body: { recipient: "GRP==" } },
    ]);
    expect(t.buttons).toBe(false);
    expect(t.maxLength).toBe(4000);
    expect(t.platform).toBe("signal");
  });
});
