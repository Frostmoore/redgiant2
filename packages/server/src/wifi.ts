// Wi-Fi on RedGiant OS (G39.1): what the OS helper's wifi-status and wifi-scan give back — iwd's
// D-Bus objects as `busctl --json=short` prints them, the networks by signal
// (Station.GetOrderedNetworks) and `ip -j addr` — read into what the page shows. Pure, tested as
// a table (test/wifi.test.ts). Passwords never come back from the helper: there is nothing to hide.
import type { WifiNetwork, WifiState } from "@redgiant/protocol";

type Variant = { type?: string; data?: unknown };
type Props = Record<string, Variant | undefined>;
type Objects = Record<string, Record<string, Props | undefined>>;

const IWD = "net.connman.iwd";
const str = (v: Variant | undefined) => (typeof v?.data === "string" ? v.data : undefined);
const bool = (v: Variant | undefined) => v?.data === true;

/** dBm (iwd gives 100 × dBm) to 0–100: -100 dBm and below is 0, -50 and above is 100. */
export function signalPercent(hundredthsDbm: number): number {
  const dbm = hundredthsDbm / 100;
  return Math.max(0, Math.min(100, Math.round((dbm + 100) * 2)));
}

const SECURITY = new Set(["open", "psk", "8021x", "wep"]);

interface IpAddr {
  ifname?: string;
  link_type?: string;
  operstate?: string;
  addr_info?: { family?: string; local?: string; scope?: string }[];
}

/** The helper's reply (wifi-status, wifi-scan) as the page shows it. */
export function parseWifi(reply: Record<string, unknown>): WifiState {
  const o = (reply.objects as { data?: unknown[] } | undefined)?.data?.[0];
  if (!o || typeof o !== "object") return { available: false, why: "failed" };
  const objects = o as Objects;
  const entries = Object.entries(objects);
  const station = entries.find(([, v]) => v[`${IWD}.Station`]);
  if (!station) return { available: false, why: "no_wifi" };
  const [stationPath, stationIfs] = station;
  const st = stationIfs[`${IWD}.Station`] ?? {};
  const device = str(stationIfs[`${IWD}.Device`]?.Name) ?? "wlan0";
  const knownNames = entries
    .map(([, v]) => str(v[`${IWD}.KnownNetwork`]?.Name))
    .filter((n): n is string => !!n);
  const known = new Set(knownNames);
  // Signal by network object, from GetOrderedNetworks: [[[path, signal], …]].
  const ordered = (reply.ordered as { data?: unknown[] } | null | undefined)?.data?.[0];
  const signal = new Map<string, number>();
  if (Array.isArray(ordered))
    for (const pair of ordered)
      if (Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
        signal.set(pair[0], pair[1]);
  const networks: WifiNetwork[] = [];
  const seen = new Set<string>();
  for (const [path, ifs] of entries) {
    const n = ifs[`${IWD}.Network`];
    if (!n) continue;
    const ssid = str(n.Name);
    const dev = str(n.Device);
    if (!ssid || (dev && dev !== stationPath)) continue;
    const type = str(n.Type) ?? "other";
    const key = `${ssid}\u0000${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    networks.push({
      ssid,
      security: (SECURITY.has(type) ? type : "other") as WifiNetwork["security"],
      signal: signal.has(path) ? signalPercent(signal.get(path) ?? -10000) : 0,
      connected: bool(n.Connected),
      known: known.has(ssid) || !!str(n.KnownNetwork),
    });
  }
  // The one in use first, then the strongest; names break ties so the order does not jump.
  networks.sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) ||
      b.signal - a.signal ||
      a.ssid.localeCompare(b.ssid),
  );
  const connectedPath = str(st.ConnectedNetwork);
  const connected =
    (connectedPath && str(objects[connectedPath]?.[`${IWD}.Network`]?.Name)) ||
    networks.find((n) => n.connected)?.ssid ||
    null;
  const links = Array.isArray(reply.links) ? (reply.links as IpAddr[]) : [];
  const v4 = (l: IpAddr) =>
    l.addr_info?.find((a) => a.family === "inet" && a.scope !== "host")?.local ?? null;
  const wifiLink = links.find((l) => l.ifname === device);
  // A cable: an Ethernet card that is up with an address (Docker's bridges and veths are not).
  const wired = links.some(
    (l) =>
      l.link_type === "ether" &&
      l.ifname !== device &&
      !/^(docker|br-|veth|virbr)/.test(l.ifname ?? "") &&
      l.operstate === "UP" &&
      v4(l) !== null,
  );
  return {
    available: true,
    device,
    state: str(st.State) ?? "unknown",
    connected,
    networks,
    known: [...known].sort((a, b) => a.localeCompare(b)),
    wired,
    address: wifiLink ? v4(wifiLink) : null,
  };
}

/** What the helper's error codes mean for Wi-Fi being there at all. */
export function wifiUnavailable(code: string): WifiState {
  const why =
    code === "no_wifi" || code === "wifi_off" || code === "not_installed" ? code : "failed";
  return { available: false, why };
}
