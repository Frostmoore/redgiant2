import { afterEach, describe, expect, it } from "vitest";
import { OTHER, startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
});

describe("paired devices", () => {
  it("pair by code once, sign in with their own token, and stop working when revoked", async () => {
    s = await startServer([]);
    const pair = await s.api<{ code: string; expiresAt: string }>("POST", "/api/devices/pair");
    expect(pair.body.code).toMatch(/^[2-9A-HJ-NP-Z]{10}$/);
    const claim = (code: string) =>
      fetch(`${s?.url}/api/devices/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Pixel 9" }),
      });
    const first = await claim(pair.body.code.toLowerCase());
    const { token, device } = (await first.json()) as {
      token: string;
      device: { id: string; name: string };
    };
    expect(token).toMatch(/^rgd_/);
    expect(device.name).toBe("Pixel 9");
    // Once only.
    expect((await claim(pair.body.code)).status).toBe(403);

    expect((await s.api("GET", "/api/projects", undefined, token)).status).toBe(200);
    const ws = await wsClient(s.url, token);
    expect((await ws.waitFor("welcome")).ownerId).toBe("me");
    ws.close();
    const list = await s.api<{ id: string; lastSeenAt: string | null }[]>("GET", "/api/devices");
    expect(list.body).toHaveLength(1);
    expect(list.body[0]?.lastSeenAt).toBeTruthy();

    // Someone else cannot revoke it; the owner can, and it stops at once.
    expect((await s.api("DELETE", `/api/devices/${device.id}`, undefined, OTHER)).status).toBe(404);
    expect((await s.api("DELETE", `/api/devices/${device.id}`)).status).toBe(200);
    expect((await s.api("GET", "/api/projects", undefined, token)).status).toBe(401);
    expect((await s.api<unknown[]>("GET", "/api/devices")).body).toEqual([]);
  });
});
