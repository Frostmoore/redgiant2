import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startServer } from "./helpers.js";

describe("stopping the server (2026-11-05)", () => {
  it("does not wait for a connection left open, as an open page keeps one", async () => {
    const s = await startServer(() => ({ text: "OK" }));
    const { port } = new URL(s.url);
    // A request begun and never finished: the server keeps the connection for it.
    const socket = connect(Number(port), "127.0.0.1");
    await new Promise<void>((ok) => socket.once("connect", () => ok()));
    socket.write("GET /api/health HTTP/1.1\r\nHost: x\r\n");
    socket.on("error", () => {});
    const started = Date.now();
    await s.close();
    // Before: the stop waited for it, past RedGiant.exe's 30 s, and Postgres was left running.
    expect(Date.now() - started).toBeLessThan(5000);
    socket.destroy();
  }, 30_000);
});
