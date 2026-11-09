import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenPages } from "../src/ws.js";
import { OTHER, startServer, wsClient } from "./helpers.js";

type Server = Awaited<ReturnType<typeof startServer>>;
let s: Server | undefined;
afterEach(async () => {
  await s?.close();
  s = undefined;
  vi.unstubAllEnvs();
});

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("never");
};

describe("pages after an update (3.5.3)", () => {
  it("counts pages per owner, each taken away once", () => {
    const pages = new OpenPages();
    const a = pages.add("me");
    const b = pages.add("me");
    pages.add("someone-else");
    expect(pages.count("me")).toBe(2);
    a();
    a();
    expect(pages.count("me")).toBe(1);
    b();
    expect(pages.count("me")).toBe(0);
    expect(pages.count("someone-else")).toBe(1);
  });

  it("tells the page its version and counts only pages that reload by themselves", async () => {
    vi.stubEnv("REDGIANT_VERSION", "3.5.3");
    const server = await startServer([]);
    s = server;
    const pages = async (token?: string) =>
      (await server.api<{ pages: number }>("GET", "/api/pages", undefined, token)).body.pages;
    expect(await pages()).toBe(0);
    const old = await wsClient(server.url);
    expect((await old.waitFor("welcome")).version).toBe("3.5.3");
    // A page from before 3.5.3 does not reload: it is not counted, the launcher opens a new one.
    expect(await pages()).toBe(0);
    const page = await wsClient(server.url, undefined, { reloads: true });
    await page.waitFor("welcome");
    expect(await pages()).toBe(1);
    // Only the asker's own pages.
    expect(await pages(OTHER)).toBe(0);
    page.close();
    await until(async () => (await pages()) === 0);
    old.close();
  });

  it("needs the sign-in", async () => {
    s = await startServer([]);
    const r = await fetch(`${s.url}/api/pages`);
    expect(r.status).toBe(401);
  });
});
