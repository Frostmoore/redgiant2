// @vitest-environment jsdom
// G39.4: Settings > Nodes. The page shows this machine's fingerprint, the tree with each node's
// status, capabilities and who may command it; a pair waiting shows the six digits and both
// fingerprints and is confirmed only on the person's click (on the node with the rights chosen with
// our switches); a code for a new node; control given with our drawn choices and taken away after
// our own window; unpairing asks first. No native checkboxes, radios or dialogs. The chat's tool
// cards say «sul nodo <name>».
import type { NodesState } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const SELF = "SHA256:se1fse1fse1fse1fse1fse1fse1fse1fse1fse1fse1";
const RIG = "SHA256:r1gr1gr1gr1gr1gr1gr1gr1gr1gr1gr1gr1gr1gr1gr";
const MON = "SHA256:m0nm0nm0nm0nm0nm0nm0nm0nm0nm0nm0nm0nm0nm0nm0";
const caps = {
  sandbox: { ok: true, kind: "host", cpus: 24, memoryMb: 65536 },
  models: [{ provider: "local", models: ["qwen", "gemma"] }],
  storage: { ok: true, freeBytes: 900 * 1024 ** 3, totalBytes: 2000 * 1024 ** 3 },
  load: { cpu: 12, memoryUsedPct: 40 },
};
let state: NodesState;
const base = (): NodesState => ({
  self: { fingerprint: SELF, name: "severino", ready: true },
  tree: {
    fingerprint: SELF,
    name: "severino",
    relation: "self",
    status: "online",
    grants: [
      {
        id: "grant_1",
        controller: RIG,
        controllerName: "rig",
        target: SELF,
        targetName: "severino",
        rights: ["use", "admin"],
        grantedAt: "2026-11-13T08:00:00Z",
        grantedFrom: SELF,
      },
    ],
    children: [
      {
        fingerprint: RIG,
        name: "rig",
        relation: "child",
        status: "online",
        capabilities: caps,
        grants: [
          {
            id: "grant_2",
            controller: SELF,
            controllerName: "severino",
            target: RIG,
            targetName: "rig",
            rights: ["use"],
            grantedAt: "2026-11-13T08:00:00Z",
            grantedFrom: RIG,
          },
        ],
        children: [],
      },
      {
        fingerprint: MON,
        name: "monnezza",
        relation: "child",
        status: "offline",
        lastSeen: "2026-11-13T07:00:00Z",
        grants: [],
        children: [],
      },
    ],
  },
  pending: [],
  grants: [
    {
      id: "grant_1",
      controller: RIG,
      controllerName: "rig",
      target: SELF,
      targetName: "severino",
      rights: ["use", "admin"],
      grantedAt: "2026-11-13T08:00:00Z",
      grantedFrom: SELF,
    },
  ],
  placements: [],
});
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "nodes") return Promise.resolve(state);
        if (name === "nodeCode")
          return Promise.resolve({
            code: "K7QM-4TZP",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          });
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
  refresh: () => Promise.resolve(),
}));

const { Nodes } = await import("../src/components/Nodes.js");
const { ToolLine } = await import("../src/components/Chat.js");
const { Dialogs } = await import("../src/components/dialogs.js");
const { t } = await import("../src/i18n.js");

const NATIVE = 'input[type="checkbox"], input[type="radio"]';

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
  state = base();
});
afterEach(cleanup);

describe("Settings › Nodes (G39.4)", () => {
  it("shows the tree with status, capabilities and who may command each machine", async () => {
    const r = render(<Nodes />);
    await waitFor(() => expect(r.getAllByText("rig").length).toBeGreaterThan(0));
    expect(r.container.textContent).toContain(SELF);
    expect(r.getByText(t("ndOnline"))).toBeTruthy();
    expect(r.getByText(t("ndOffline"))).toBeTruthy();
    expect(r.container.textContent).toContain(t("ndCpu", { n: "24" }));
    expect(r.container.textContent).toContain(t("ndModels", { n: "2" }));
    expect(r.container.textContent).toContain(t("ndLoad", { n: "12" }));
    // Control is shown apart from the tree: rig commands severino, severino only uses rig.
    expect(r.container.textContent).toContain(`severino ${t("ndUse")}`);
    expect(r.container.textContent).toContain(`rig ${t("ndAdmin")}`);
    expect(r.container.querySelectorAll(NATIVE).length).toBe(0);
  });

  it("a pair waiting: six digits and fingerprints, confirmed on click with the rights chosen", async () => {
    state = {
      ...base(),
      tree: { ...base().tree, children: [] },
      pending: [
        {
          fingerprint: RIG,
          name: "severino-2",
          sas: "123 456",
          side: "node",
          at: "2026-11-13T08:00:00Z",
        },
      ],
    };
    const r = render(<Nodes />);
    await waitFor(() => expect(r.getByText("123 456")).toBeTruthy());
    expect(r.container.textContent).toContain(RIG);
    expect(calls.some(([n]) => n === "confirmNode")).toBe(false);
    // Our switch, not a checkbox: «Gestirla» off.
    fireEvent.click(r.getByRole("switch", { name: t("ndRightAdmin") }));
    fireEvent.click(r.getByText(t("ndConfirm")));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "confirmNode")?.[1]).toEqual([RIG, ["use"]]),
    );
    expect(r.container.querySelectorAll(NATIVE).length).toBe(0);
  });

  it("shows a one-time code to add a node", async () => {
    const r = render(<Nodes />);
    await waitFor(() => expect(r.getByText(t("ndAddButton"))).toBeTruthy());
    state = {
      ...state,
      code: { code: "K7QM-4TZP", expiresAt: new Date(Date.now() + 600_000).toISOString() },
    };
    fireEvent.click(r.getByText(t("ndAddButton")));
    await waitFor(() => expect(r.getByText("K7QM-4TZP")).toBeTruthy());
    expect(r.container.textContent).toContain(t("ndCodeExpires", { min: "10" }));
  });

  it("gives control with our drawn choices; takes it away and unpairs only after our window", async () => {
    const r = render(
      <>
        <Nodes />
        <Dialogs />
      </>,
    );
    await waitFor(() => expect(r.getAllByText(t("ndControl")).length).toBe(3));
    // Control of monnezza (third row): the person picks rig and «Gestirla».
    fireEvent.click(r.getAllByText(t("ndControl"))[2] as HTMLElement);
    await waitFor(() =>
      expect(r.getByText(t("ndControlTitle", { name: "monnezza" }))).toBeTruthy(),
    );
    fireEvent.click(r.getByRole("button", { name: "rig" }));
    fireEvent.click(r.getByRole("button", { name: t("ndRightAdmin") }));
    fireEvent.click(r.getByText(t("ndGive")));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "grantNode")?.[1]).toEqual([
        { controller: RIG, target: MON, rights: ["use", "admin"] },
      ]),
    );
    // Taking away what rig may do here: our window first.
    fireEvent.click(r.getAllByText(t("ndRevoke"))[0] as HTMLElement);
    await waitFor(() => expect(r.getByText(t("ndRevokeQ", { name: "rig" }))).toBeTruthy());
    expect(calls.some(([n]) => n === "revokeNodeGrant")).toBe(false);
    const yes = [...r.container.querySelectorAll("button")]
      .filter((b) => b.textContent === t("ndRevoke"))
      .at(-1);
    fireEvent.click(yes as HTMLElement);
    await waitFor(() =>
      expect(calls.find(([n]) => n === "revokeNodeGrant")?.[1]).toEqual([SELF, "grant_1"]),
    );
    // Unpairing asks first.
    fireEvent.click(r.getAllByText(t("ndUnpair"))[0] as HTMLElement);
    await waitFor(() => expect(r.getByText(t("ndUnpairQ", { name: "rig" }))).toBeTruthy());
    expect(calls.some(([n]) => n === "unpairNode")).toBe(false);
  });

  it("pairs this machine under another one with the address and the code", async () => {
    state = { ...base(), tree: { ...base().tree, children: [] }, grants: [] };
    const r = render(<Nodes />);
    await waitFor(() => expect(r.getByText(t("ndJoinTitle"))).toBeTruthy());
    fireEvent.input(r.getByPlaceholderText(t("ndAddressPh")), {
      target: { value: "192.168.1.12:3000" },
    });
    fireEvent.input(r.getByPlaceholderText(t("ndCodePh")), { target: { value: "k7qm-4tzp" } });
    fireEvent.click(r.getByText(t("ndPair")));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "pairNode")?.[1]).toEqual([
        { address: "192.168.1.12:3000", code: "K7QM-4TZP" },
      ]),
    );
  });

  it("the chat's tool card says on which node", () => {
    const r = render(
      <ToolLine
        agentId="a"
        item={{
          kind: "tool",
          key: "k",
          callId: "c",
          tool: "node_run",
          input: { command: "npm test" },
          result: { ok: true, output: "Node: rig\nExit code: 0" },
        }}
      />,
    );
    expect(r.container.textContent).toContain(t("toolOnNode", { name: "rig" }));
    expect(t("toolOnNode", { name: "rig" })).toBe("sul nodo rig");
  });
});
