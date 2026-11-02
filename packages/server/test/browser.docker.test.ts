// The agents' browser for real (G24.14b): Chromium in the Playwright image, a page served here,
// the agents' tools, the screen, the person's click. Run with REDGIANT_DOCKER_TESTS=1 pnpm test:docker.
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { Browsers, browserTools, DockerBrowserLauncher, type ScreenFrame } from "../src/browser.js";

const on = process.env.REDGIANT_DOCKER_TESTS === "1";
// Inside a container the browser shares its network (127.0.0.1); elsewhere, the default bridge.
const inContainer = existsSync("/.dockerenv");

const PAGE = `<!doctype html><title>Shop</title>
<h1>Your cart</h1>
<label>Email <input name="email"></label>
<label>Password <input type="password" name="pw"></label>
<button onclick="document.title='Paid'">Pay now</button>
<button onclick="document.body.dataset.next='yes';document.title='Next'">Next step</button>`;

describe.skipIf(!on)("agents' browser in Docker", () => {
  const docker = new Docker();
  const site = createServer((_, res) => res.end(PAGE));
  // Inside a container: the browser's own network, joined by this container (as in production).
  const net = `rg-browser-test-net-${process.pid}`;
  const launcher = new DockerBrowserLauncher({
    docker,
    network: inContainer ? net : "bridge",
    prefix: `rg-browser-test-${process.pid}`,
    ...(inContainer && { join: hostname() }),
  });
  const browsers = new Browsers(launcher);
  afterAll(async () => {
    await browsers.shutdown();
    site.close();
    if (inContainer) {
      await docker
        .getNetwork(net)
        .disconnect({ Container: hostname(), Force: true })
        .catch(() => {});
      await docker
        .getNetwork(net)
        .remove()
        .catch(() => {});
    }
    await docker
      .getVolume(`rg-browser-test-${process.pid}-me-profile`)
      .remove()
      .catch(() => {});
  });

  it("reads and clicks by name, keeps passwords out, shows the screen, lets the person click", {
    timeout: 300_000,
  }, async () => {
    await new Promise<void>((ok) => site.listen(0, "0.0.0.0", ok));
    const port = (site.address() as { port: number }).port;
    // This container's address on the browser's network serves the page.
    const me = inContainer
      ? (await docker.getContainer(hostname()).inspect()).NetworkSettings.Networks[net]?.IPAddress
      : undefined;
    const b = browsers.get("me");
    await b.pageLike();
    const self = inContainer
      ? (await docker.getContainer(hostname()).inspect()).NetworkSettings.Networks[net]?.IPAddress
      : me;
    const url = inContainer ? `http://${self}:${port}/` : `http://host.docker.internal:${port}/`;
    // The browser is on its own network only.
    const box = await docker.getContainer(`rg-browser-test-${process.pid}-me`).inspect();
    expect(Object.keys(box.NetworkSettings.Networks)).toEqual([inContainer ? net : "bridge"]);
    const tools = browserTools(b);
    const run = async (name: string, input: unknown) => {
      const out = await tools.find((t) => t.def.name === name)?.run(input as never, {} as never);
      return typeof out === "string" ? out : (out?.content ?? "");
    };
    expect(await run("browser_open", { url })).toMatch(/Shop/);
    // The person signs in: their typing reaches the page, never the agent.
    const frames: ScreenFrame[] = [];
    const off = await b.watch((e) => e.type === "frame" && frames.push(e.frame));
    b.setControl("person");
    const page = await b.pageLike();
    await (page as unknown as { page: import("playwright-core").Page }).page
      .getByLabel("Password")
      .click();
    await b.input({ kind: "text", text: "s3cret-pw" });
    b.setControl("agents");
    const read = await run("browser_read", {});
    expect(read).toContain("Pay now");
    expect(read).not.toContain("s3cret-pw");
    expect(await run("browser_type", { field: "Password", text: "x" })).toMatch(/take control/);
    await run("browser_type", { field: "Email", text: "marta@example.com" });
    expect(await run("browser_click", { name: "Next step" })).toMatch(/Next/);
    for (let i = 0; i < 40 && frames.length === 0; i++)
      await new Promise((r) => setTimeout(r, 250));
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]?.width).toBeGreaterThan(100);
    // A click of the person's, by position on the screen.
    b.setControl("person");
    await b.input({ kind: "click", x: 0.02, y: 0.02 });
    b.setControl("agents");

    // Teach a task: what the person does is written down, never their password.
    const pw = (page as unknown as { page: import("playwright-core").Page }).page;
    const at = async (sel: string) => {
      const box = await pw.locator(sel).boundingBox();
      const vp = pw.viewportSize() ?? { width: 1280, height: 800 };
      return {
        x: ((box?.x ?? 0) + (box?.width ?? 0) / 2) / vp.width,
        y: ((box?.y ?? 0) + (box?.height ?? 0) / 2) / vp.height,
      };
    };
    b.startTeaching("asst_1");
    await b.goto(url);
    await b.input({ kind: "click", ...(await at("input[name=email]")) });
    await b.input({ kind: "text", text: "marta" });
    await b.input({ kind: "text", text: "@example.com" });
    await b.input({ kind: "click", ...(await at("input[name=pw]")) });
    await b.input({ kind: "text", text: "s3cret-pw" });
    await b.input({ kind: "click", ...(await at("text=Pay now")) });
    const taught = b.stopTeaching();
    expect(taught?.steps).toEqual([
      expect.stringMatching(/^start at /),
      `open ${url}`,
      expect.stringMatching(/^click field "Email/),
      'type "marta@example.com"',
      "click the password field",
      "the person typed their password (ask them)",
      'click button "Pay now"',
    ]);
    expect(JSON.stringify(taught)).not.toContain("s3cret");
    off();
  });
});
