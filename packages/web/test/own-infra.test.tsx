// @vitest-environment jsdom
// G39.8: «You already have your own infrastructure». The blocks to copy are filled with
// RedGiant's data; when RedGiant saw the page come through a proxy it says «You are reachable as
// <host>» and opens the guide; «Skip: I am reachable already» is kept and folds RedGiant's own
// ways. No native checkboxes or radios.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";
import {
  caddyBlock,
  caddyWildcardBlock,
  dnsmasqWildcard,
  healthCheck,
  homeDnsmasq,
  homeHostsLine,
  homeService,
  infraData,
  isTailscaleAddress,
  parentDomain,
  probeVerdict,
  subnetOf,
  tailscaleSubnet,
  traefikBlock,
} from "../src/own-infra.js";

const calls: [string, unknown[]][] = [];
const answers: Record<string, unknown> = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve(answers[name] ?? {});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));
const { OwnInfra, ownInfraFocus } = await import("../src/components/OwnInfra.js");

const NATIVE = 'input[type="checkbox"], input[type="radio"]';
const net = {
  tailscale: { state: "running" as const, name: "coder.tail1234.ts.net" },
  proxyInFront: "proxy",
  proxiesRunning: [],
  localDns: "192.168.1.2",
  hostName: "redgiant.home.example.com",
  reachedAs: { host: "redgiant.home.example.com", https: true, through: "proxy" as const },
  lan: { address: "192.168.1.40", port: 7600 },
};
const state = (reachable?: { url?: string; at: string }) =>
  ({ config: { completed: true, ...(reachable && { reachable }) } }) as never;

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
});
afterEach(cleanup);

describe("the blocks to copy (G39.8)", () => {
  it("are filled with RedGiant's name, address and port", () => {
    const d = infraData("redgiant.home.example.com", "192.168.1.40", 7600);
    expect(caddyBlock(d)).toBe("redgiant.home.example.com {\n\treverse_proxy 192.168.1.40:7600\n}");
    expect(caddyWildcardBlock(d)).toContain("*.home.example.com {");
    expect(caddyWildcardBlock(d)).toContain("@redgiant host redgiant.home.example.com");
    expect(traefikBlock(d)).toContain("rule: Host(`redgiant.home.example.com`)");
    expect(traefikBlock(d)).toContain("url: http://192.168.1.40:7600");
    expect(tailscaleSubnet(d)).toBe("tailscale up --advertise-routes=192.168.1.0/24");
    expect(dnsmasqWildcard(d)).toBe("address=/home.example.com/192.168.1.40");
    expect(healthCheck("https://redgiant.home.example.com/")).toBe(
      "curl -s https://redgiant.home.example.com/api/health",
    );
    expect(parentDomain("redgiant.lan")).toBe("redgiant.lan");
    expect(subnetOf("fd00::1")).toBe("192.168.1.0/24");
    // What is not known reads as a placeholder, never empty.
    expect(infraData("", null, undefined)).toEqual({
      name: "redgiant.example.com",
      address: "192.168.1.50",
      port: 7600,
    });
  });
});

describe("the guide (G39.8)", () => {
  it("says the page is reachable already and shows the guide filled with what was seen", async () => {
    const r = render(<OwnInfra s={state()} onChange={() => {}} net={net} />);
    await waitFor(() => r.getByText(/Sei già raggiungibile come redgiant.home.example.com/));
    const text = r.container.textContent ?? "";
    expect(text).toContain("reverse_proxy 192.168.1.40:7600");
    expect(text).toContain("curl -s https://redgiant.home.example.com/api/health");
    // Forward auth: why RedGiant's own password is better, and what to leave out.
    expect(text).toContain("Authelia");
    expect(text).toContain("/api/ e /ws");
    // The other parts: Tailscale (seen running here) and the home DNS.
    fireEvent.click(r.getByText("Tailscale o un'altra VPN"));
    expect(r.container.textContent).toContain("coder.tail1234.ts.net");
    expect(r.container.textContent).toContain("tailscale up --advertise-routes=192.168.1.0/24");
    fireEvent.click(r.getByText("DNS di casa"));
    expect(r.container.textContent).toContain("address=/home.example.com/192.168.1.40");
    expect(r.container.querySelector(NATIVE)).toBeNull();
  });

  it("is folded when nothing was seen, and «skip» is sent with the address", async () => {
    const onChange = vi.fn();
    const r = render(
      <OwnInfra
        s={state()}
        onChange={onChange}
        net={{ ...net, reachedAs: null, hostName: null, lan: { address: null, port: 7600 } }}
      />,
    );
    expect(r.queryByText(/Sei già raggiungibile/)).toBeNull();
    fireEvent.click(r.getByText("Mostra la guida"));
    expect(r.container.textContent).toContain("redgiant.example.com {");
    const name = r.getByPlaceholderText("redgiant.example.com");
    fireEvent.input(name, { target: { value: "rg.casa.example.org" } });
    fireEvent.click(r.getByText("Salta: sono già raggiungibile"));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(calls).toContainEqual(["setReachable", [true, "https://rg.casa.example.org"]]);
  });

  it("in Settings starts folded even when reachable, and opens and folds from its bar (3.7.2)", async () => {
    const r = render(
      <OwnInfra
        s={state({ url: "https://redgiant.home.example.com", at: "2026-11-14T10:00:00Z" })}
        onChange={() => {}}
        net={net}
        folded
      />,
    );
    await waitFor(() => r.getByText(/già raggiungibile a https:\/\/redgiant.home.example.com/));
    const bar = r.getByRole("button", { name: "Mostra la guida" });
    expect(bar.getAttribute("aria-expanded")).toBe("false");
    expect(r.container.textContent).not.toContain("reverse_proxy");
    fireEvent.click(bar);
    expect(r.container.textContent).toContain("reverse_proxy 192.168.1.40:7600");
    fireEvent.click(r.getByRole("button", { name: "Nascondi la guida" }));
    expect(r.container.textContent).not.toContain("reverse_proxy");
  });

  it("once skipped, says so and can ask again", async () => {
    const r = render(
      <OwnInfra
        s={state({ url: "https://redgiant.home.example.com", at: "2026-11-14T10:00:00Z" })}
        onChange={() => {}}
        net={net}
      />,
    );
    await waitFor(() => r.getByText(/già raggiungibile a https:\/\/redgiant.home.example.com/));
    expect(r.queryByText("Salta: sono già raggiungibile")).toBeNull();
    fireEvent.click(r.getByText("Chiedimelo di nuovo"));
    await waitFor(() => expect(calls).toContainEqual(["setReachable", [false, undefined]]));
  });
});

describe("your home services seen by RedGiant (p3.7.3)", () => {
  it("fills the DNS lines with the service's name and the proxy's local address", () => {
    const h = homeService(" Git.Home.Varitest.ovh ", "192.168.1.12");
    expect(homeDnsmasq(h)).toBe("address=/git.home.varitest.ovh/192.168.1.12");
    expect(homeHostsLine(h)).toBe("192.168.1.12 git.home.varitest.ovh");
    expect(homeService("", null)).toEqual({ name: "git.home.example.com", proxy: "192.168.1.12" });
  });

  it.each([
    ["100.64.0.1", true],
    ["100.101.10.4", true],
    ["100.127.255.254", true],
    ["100.128.0.1", false],
    ["100.63.0.1", false],
    ["192.168.1.12", false],
    ["fd7a:115c:a1e0::1", true],
  ])("%s is Tailscale's: %s", (a, yes) => expect(isTailscaleAddress(a)).toBe(yes));

  const p = (o: object) =>
    ({
      name: "git.home.example.com",
      address: null,
      reachable: false,
      status: null,
      why: "ok",
      ...o,
    }) as never;
  it.each([
    [p({ why: "not_found" }), "oiProbeNotFound", false],
    [p({ why: "dns_failed" }), "oiProbeDnsFailed", false],
    [p({ address: "192.168.1.12", reachable: true, status: 200 }), "oiProbeOk", true],
    [p({ address: "100.101.1.2", why: "timeout" }), "oiProbeTailscale", false],
    [p({ address: "192.168.1.12", why: "unreachable" }), "oiProbeUnreachable", false],
    [p({ address: "10.9.0.4", why: "timeout" }), "oiProbeTimeout", false],
    [p({ address: "192.168.1.12", reachable: true, why: "tls" }), "oiProbeTls", false],
  ])("%j says %s", (probe, key, ok) => {
    expect(probeVerdict(probe)).toMatchObject({ key, ok });
  });

  it("explains, fills the blocks and tries a name through the server", async () => {
    answers.probeName = {
      name: "git.home.varitest.ovh",
      address: null,
      reachable: false,
      status: null,
      why: "not_found",
    };
    const r = render(<OwnInfra s={state()} onChange={() => {}} net={net} />);
    await waitFor(() => r.getByText("I tuoi servizi di casa"));
    fireEvent.click(r.getByText("I tuoi servizi di casa"));
    const text = () => r.container.textContent ?? "";
    expect(text()).toContain("visti da RedGiant");
    expect(text()).toContain("resolvectl status");
    expect(text()).toContain("RedGiant chiede i nomi a 192.168.1.2.");
    expect(text()).toContain("Tailscale (100.…)");
    expect(text()).toContain("Cache=no-negative");
    const [name, proxy] = [...r.container.querySelectorAll(".oi-home input")];
    fireEvent.input(name as Element, { target: { value: "git.home.varitest.ovh" } });
    fireEvent.input(proxy as Element, { target: { value: "192.168.1.12" } });
    expect(text()).toContain("address=/git.home.varitest.ovh/192.168.1.12");
    expect(text()).toContain("192.168.1.12 git.home.varitest.ovh");
    fireEvent.click(r.getByText("Prova git.home.varitest.ovh"));
    await waitFor(() => r.getByText(/Il DNS che usa RedGiant non conosce git.home.varitest.ovh/));
    expect(calls.find(([n]) => n === "probeName")?.[1]).toEqual(["git.home.varitest.ovh"]);
    expect(r.container.querySelector(NATIVE)).toBeNull();
    delete answers.probeName;
  });

  it("opens unfolded on this part when asked from elsewhere (Gitea's error)", async () => {
    ownInfraFocus.value = "home";
    const r = render(<OwnInfra s={state()} onChange={() => {}} net={null} folded />);
    await waitFor(() => r.getByText("I tuoi servizi di casa (Gitea, NAS…) visti da RedGiant"));
    expect(ownInfraFocus.value).toBeNull();
  });
});
