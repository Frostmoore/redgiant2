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
  infraData,
  parentDomain,
  subnetOf,
  tailscaleSubnet,
  traefikBlock,
} from "../src/own-infra.js";

const calls: [string, unknown[]][] = [];
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));
const { OwnInfra } = await import("../src/components/OwnInfra.js");

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
