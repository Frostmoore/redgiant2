// Reaching RedGiant from outside home (G24.6), three ways, each a container next to RedGiant:
//   tailscale   a private network of one's own devices, nothing opened on the router (HTTPS by
//               `tailscale serve`); the sign-in page comes from `tailscale status`
//   cloudflare  a Cloudflare Tunnel to one's own domain, nothing opened on the router
//   caddy       one's own domain with ports 80 and 443 opened on the router (experts)
// The containers reach RedGiant inside Docker (`http://redgiant:7600`).

import type Docker from "dockerode";
import { JobFailure, type JobHandle } from "./jobs.js";

export type RemoteRequest =
  | { way: "tailscale" }
  | { way: "cloudflare"; token: string; hostname: string }
  | { way: "caddy"; domain: string };

export const REMOTE_STEPS: Record<RemoteRequest["way"], string[]> = {
  tailscale: ["remote_image", "remote_start", "remote_login", "remote_https"],
  cloudflare: ["remote_image", "remote_start", "remote_connect"],
  caddy: ["remote_image", "remote_start", "remote_cert"],
};

const NAMES: Record<RemoteRequest["way"], string> = {
  tailscale: "redgiant-tailscale",
  cloudflare: "redgiant-cloudflared",
  caddy: "redgiant-caddy",
};

export interface RemoteOptions {
  /** Secrets that must never reach the log (the tunnel's token). */
  hide?: (name: string, value: string) => void;
  docker: Docker;
  network: string;
  /** RedGiant as the containers reach it. */
  target?: string;
  images?: Partial<Record<RemoteRequest["way"], string>>;
  /** Pulls an image, reporting progress (the engine's own). */
  pull: (image: string, h?: JobHandle) => Promise<void>;
  exec: (c: Docker.Container, cmd: string[]) => Promise<{ code: number; out: string }>;
  pollMs?: number;
}

const IMAGES: Record<RemoteRequest["way"], string> = {
  tailscale: "tailscale/tailscale:stable",
  cloudflare: "cloudflare/cloudflared:latest",
  caddy: "caddy:2",
};

async function logs(c: Docker.Container): Promise<string> {
  const raw = (await c
    .logs({ stdout: true, stderr: true, tail: 200 })
    .catch(() => Buffer.from(""))) as unknown as Buffer;
  let out = "";
  for (let i = 0; i + 8 <= raw.length; ) {
    const size = raw.readUInt32BE(i + 4);
    out += raw.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out || raw.toString("utf8");
}

/** Stops every way out (the one being replaced, or all of them). */
export async function stopRemote(o: RemoteOptions, except?: RemoteRequest["way"]): Promise<void> {
  for (const [way, name] of Object.entries(NAMES))
    if (way !== except)
      await o.docker
        .getContainer(name)
        .remove({ force: true })
        .catch(() => {});
}

/** Starts one way out and follows it until RedGiant is reachable; returns its address. */
export async function startRemote(
  o: RemoteOptions,
  req: RemoteRequest,
  h?: JobHandle,
): Promise<{ url: string }> {
  await stopRemote(o, req.way);
  const name = NAMES[req.way];
  const image = o.images?.[req.way] ?? IMAGES[req.way];
  const target = o.target ?? "redgiant:7600";
  const old = o.docker.getContainer(name);
  await old.remove({ force: true }).catch(() => {});
  const present = await o.docker
    .getImage(image)
    .inspect()
    .then(() => true)
    .catch(() => false);
  if (present) h?.skip("remote_image");
  else {
    h?.step("remote_image");
    await o.pull(image, h);
  }
  h?.step("remote_start");
  const base = {
    name,
    Image: image,
    Labels: { "io.redgiant.remote": req.way },
  };
  const host = { RestartPolicy: { Name: "unless-stopped" }, NetworkMode: o.network };
  let spec: Docker.ContainerCreateOptions;
  if (req.way === "tailscale")
    spec = {
      ...base,
      // Userspace networking: no /dev/net/tun nor extra privileges needed.
      Env: ["TS_USERSPACE=true", "TS_HOSTNAME=redgiant", "TS_STATE_DIR=/var/lib/tailscale"],
      HostConfig: {
        ...host,
        Mounts: [{ Type: "volume", Source: "redgiant-tailscale", Target: "/var/lib/tailscale" }],
      },
    };
  else if (req.way === "cloudflare") {
    o.hide?.("cloudflare", req.token);
    spec = {
      ...base,
      Cmd: ["tunnel", "--no-autoupdate", "run"],
      // The tunnel's token as a variable, not on the command line `docker ps` shows.
      Env: [`TUNNEL_TOKEN=${req.token}`],
      HostConfig: host,
    };
  } else
    spec = {
      ...base,
      Cmd: ["caddy", "reverse-proxy", "--from", req.domain, "--to", target],
      ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
      HostConfig: {
        ...host,
        PortBindings: { "80/tcp": [{ HostPort: "80" }], "443/tcp": [{ HostPort: "443" }] },
        Mounts: [{ Type: "volume", Source: "redgiant-caddy", Target: "/data" }],
      },
    };
  const c = await o.docker.createContainer(spec);
  try {
    await c.start();
  } catch (err) {
    throw new JobFailure(
      /port is already allocated|address already in use/i.test(String(err))
        ? "ports_busy"
        : "start",
      (err as Error).message,
    );
  }
  const poll = o.pollMs ?? 2000;
  const wait = () => new Promise((r) => setTimeout(r, poll));
  const until = Date.now() + 15 * 60_000;

  if (req.way === "tailscale") {
    h?.step("remote_login");
    let dns = "";
    for (;;) {
      if (h?.signal.aborted) throw new Error("cancelled");
      const st = await o.exec(c, ["tailscale", "status", "--json"]);
      const s = (() => {
        try {
          return JSON.parse(st.out) as {
            BackendState?: string;
            AuthURL?: string;
            Self?: { DNSName?: string };
          };
        } catch {
          return {};
        }
      })();
      if (s.BackendState === "NeedsLogin" && s.AuthURL) h?.info({ url: s.AuthURL });
      if (s.BackendState === "Running" && s.Self?.DNSName) {
        dns = s.Self.DNSName.replace(/\.$/, "");
        break;
      }
      if (Date.now() > until)
        throw new JobFailure("login_timeout", "Nobody signed in to Tailscale within 15 minutes");
      await wait();
    }
    h?.step("remote_https");
    const serve = await o.exec(c, [
      "tailscale",
      "serve",
      "--bg",
      "--https=443",
      `http://${target}`,
    ]);
    if (serve.code !== 0)
      throw new JobFailure(
        /https|cert/i.test(serve.out) ? "tailscale_https" : "start",
        serve.out.slice(-800),
      );
    return { url: `https://${dns}` };
  }
  if (req.way === "cloudflare") {
    h?.step("remote_connect");
    for (;;) {
      const text = await logs(c);
      if (/Registered tunnel connection/i.test(text)) return { url: `https://${req.hostname}` };
      if (/Unauthorized|invalid tunnel|token is not valid|failed to unmarshal/i.test(text))
        throw new JobFailure("token_rejected", text.slice(-800));
      if (Date.now() > until) throw new JobFailure("connect_timeout", text.slice(-800));
      await wait();
    }
  }
  h?.step("remote_cert");
  // Let's Encrypt is asked several times before Caddy gives up: errors count after 3 minutes.
  const patient = Date.now() + 3 * 60_000;
  for (;;) {
    const text = await logs(c);
    if (
      /certificate obtained successfully|certificate already|found cached certificate/i.test(text)
    )
      return { url: `https://${req.domain}` };
    if (
      (Date.now() > patient &&
        /could not get certificate|challenge failed|no solvers/i.test(text)) ||
      Date.now() > until
    )
      throw new JobFailure("cert", text.slice(-1200));
    await wait();
  }
}
