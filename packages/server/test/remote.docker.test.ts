// The ways in from outside home, for real (G24.6): Tailscale up to its sign-in page, a Cloudflare
// tunnel with a wrong token. Run with REDGIANT_DOCKER_TESTS=1 pnpm test:docker.
import Docker from "dockerode";
import { afterAll, describe, expect, it } from "vitest";
import { Jobs, REMOTE_STEPS, startRemote, stopRemote } from "../src/index.js";

const on = process.env.REDGIANT_DOCKER_TESTS === "1";
const docker = new Docker();
const exec = async (c: Docker.Container, cmd: string[]) => {
  const ex = await c.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await ex.start({});
  const chunks: Buffer[] = [];
  await new Promise<void>((ok) => {
    stream.on("data", (d: Buffer) => chunks.push(d));
    stream.on("end", ok);
  });
  const raw = Buffer.concat(chunks);
  let out = "";
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return { code: (await ex.inspect()).ExitCode ?? 1, out };
};
const o = {
  docker,
  network: "bridge",
  pull: async (image: string) => {
    await new Promise<void>((ok, ko) =>
      docker.pull(image, (err: Error | null, s: NodeJS.ReadableStream) =>
        err ? ko(err) : docker.modem.followProgress(s, (e) => (e ? ko(e) : ok())),
      ),
    );
  },
  exec,
  pollMs: 500,
};

afterAll(async () => {
  if (on) await stopRemote(o);
});

describe.skipIf(!on)("ways in from outside", () => {
  it("Tailscale shows its sign-in page, and waits for it", async () => {
    const jobs = new Jobs();
    const job = jobs.start("me", "remote", REMOTE_STEPS.tailscale, (h) =>
      startRemote(o, { way: "tailscale" }, h),
    );
    let seen = jobs.get("me", job.id);
    for (let i = 0; i < 120 && !seen?.vars.url; i++) {
      await new Promise((r) => setTimeout(r, 500));
      seen = jobs.get("me", job.id);
    }
    expect(seen?.vars.url).toMatch(/^https:\/\/login\.tailscale\.com\/a\/\w+/);
    expect(seen?.steps.find((s) => s.id === "remote_login")?.state).toBe("running");
    jobs.cancel("me", job.id);
    expect((await jobs.settled(job.id))?.state).toBe("cancelled");
  });

  it("Cloudflare refuses a wrong tunnel token, and that is said", async () => {
    const jobs = new Jobs();
    const job = jobs.start("me", "remote", REMOTE_STEPS.cloudflare, (h) =>
      startRemote(
        o,
        { way: "cloudflare", token: "x".repeat(60), hostname: "redgiant.example.com" },
        h,
      ),
    );
    const end = await jobs.settled(job.id);
    expect(end?.state).toBe("failed");
    expect(end?.error?.code).toBe("token_rejected");
  });
});
