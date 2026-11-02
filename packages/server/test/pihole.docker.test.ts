// Pi-hole for real (G24.14c): started by the same code as the server, it answers for the domain
// with the server's home address; stopped, it is gone. Run with REDGIANT_DOCKER_TESTS=1 pnpm test:docker.
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { runtimeHooks } from "../src/runtime.js";

const on = process.env.REDGIANT_DOCKER_TESTS === "1";
const inContainer = existsSync("/.dockerenv");
const docker = new Docker();
const tag = `rg-test-pihole-${Date.now()}`;

afterAll(async () => {
  if (!on) return;
  await docker
    .getContainer(tag)
    .remove({ force: true })
    .catch(() => {});
  await docker
    .getVolume(`${tag}-etc`)
    .remove()
    .catch(() => {});
});

describe.skipIf(!on || !inContainer)("Pi-hole", () => {
  it("answers for the domain with the server's home address", { timeout: 300_000 }, async () => {
    const hooks = runtimeHooks({
      core: {} as never,
      providers: {} as never,
      db: {} as never,
      redactor: { addSecret: () => {} } as never,
      telegram: {},
      engine: {
        docker,
        image: { cpu: "x", cuda: "x", vulkan: "x" },
        network: `container:${hostname()}`,
        modelsVolume: "x",
        kvVolume: "x",
        kvDir: "/tmp",
        pihole: { bind: "", checkAt: "127.0.0.1", webPort: 18053, name: tag, volumePrefix: tag },
      },
    });
    const steps: string[] = [];
    const r = await hooks.pihole?.(
      { lanIp: "192.168.1.50", domain: "casa.example.org", password: "pw-test-123" },
      {
        step: (s: string) => steps.push(s),
        skip: (s: string) => steps.push(`skip:${s}`),
        progress: () => {},
        info: () => {},
        signal: new AbortController().signal,
      } as never,
    );
    expect(r).toEqual({ adminUrl: "http://192.168.1.50:8053/admin/" });
    expect(steps).toContain("pihole_check");
    const page = await fetch("http://127.0.0.1:18053/admin/", { redirect: "manual" });
    expect([200, 302]).toContain(page.status);
    await hooks.pihole?.(null);
    expect(
      await docker
        .getContainer(tag)
        .inspect()
        .then(
          () => true,
          () => false,
        ),
    ).toBe(false);
  });
});
