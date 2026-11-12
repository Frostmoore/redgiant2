// @vitest-environment jsdom
// G38.6: Settings › External agents (ACP) — the workers of the projects, the window that adds one
// (ready commands, variables that refuse keys, «Try»), the editors' snippets; and the chat line of
// an external agent's own action.
import { ACP_PRESETS } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "acpWorkers")
          return Promise.resolve({
            workers: [
              {
                agentId: "agent_1",
                name: "Claude Code",
                projectId: "shop",
                status: "active",
                command: "npx",
                args: ["-y", "@agentclientprotocol/claude-agent-acp"],
                env: {},
              },
            ],
            presets: ACP_PRESETS,
          });
        if (name === "projects") return Promise.resolve([{ id: "shop", name: "Shop" }]);
        if (name === "tryAcpWorker")
          return Promise.resolve({
            name: "Codex",
            version: "2.6.0",
            loadSession: true,
            signIn: [],
          });
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { ExternalAgents, zedSnippet } = await import("../src/components/ExternalAgents.js");
const { toolHead } = await import("../src/components/Chat.js");

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("Settings › External agents (G38.6)", () => {
  it("lists the workers with their project and command, and shows the editors' snippets", async () => {
    lang.value = "it";
    const r = render(<ExternalAgents />);
    await waitFor(() => expect(r.getByText("Claude Code")).toBeTruthy());
    expect(r.getByText("In Shop.")).toBeTruthy();
    expect(r.getByText("npx -y @agentclientprotocol/claude-agent-acp")).toBeTruthy();
    expect(r.getByText("RedGiant dentro il tuo editor")).toBeTruthy();
    expect(JSON.parse(zedSnippet()).agent_servers.RedGiant).toEqual({
      type: "custom",
      command: "redgiant-acp",
      args: [],
      env: {},
    });
    expect(r.container.querySelector("input[type=checkbox], input[type=radio]")).toBeNull();
  });

  it("adds one from a ready command, refuses a key among its variables, tries it", async () => {
    lang.value = "en";
    const r = render(<ExternalAgents />);
    await waitFor(() => expect(r.getByText("Add an external agent")).toBeTruthy());
    fireEvent.click(r.getByText("Add an external agent"));
    fireEvent.click(r.getByText("Codex"));
    const command = r.getByDisplayValue("npx") as HTMLInputElement;
    expect(command).toBeTruthy();
    expect((r.getByDisplayValue(/codex-acp/) as HTMLTextAreaElement).value).toBe(
      "-y\n@agentclientprotocol/codex-acp",
    );
    fireEvent.click(r.getByText("Add a variable"));
    const [name, value] = [
      ...r.container.querySelectorAll(".acp-env-row input"),
    ] as HTMLInputElement[];
    fireEvent.input(name as HTMLInputElement, { target: { value: "OPENAI_API_KEY" } });
    fireEvent.input(value as HTMLInputElement, { target: { value: "x" } });
    await waitFor(() => expect(r.getByText(/looks like a key: keys go in/)).toBeTruthy());
    const save = r.getByText("Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.input(name as HTMLInputElement, { target: { value: "CODEX_HOME" } });
    fireEvent.input(value as HTMLInputElement, { target: { value: "/home/me/.codex" } });
    fireEvent.click(r.getByText("Try"));
    await waitFor(() => expect(r.getByText("Codex 2.6.0 answered.")).toBeTruthy());
    expect(calls.find(([n]) => n === "tryAcpWorker")?.[1][0]).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      env: { CODEX_HOME: "/home/me/.codex" },
    });
    fireEvent.click(r.getByText("Save"));
    await waitFor(() => expect(calls.some(([n]) => n === "createAcpWorker")).toBe(true));
    expect(calls.find(([n]) => n === "createAcpWorker")?.[1][0]).toMatchObject({
      name: "Codex",
      projectId: "shop",
      command: "npx",
    });
  });

  it("names an external agent's actions in the chat by their kind and title, in both languages", () => {
    lang.value = "it";
    expect(toolHead("acp_execute", { title: "npm test", command: "npm test" })).toEqual({
      name: "comando",
      summary: "npm test",
    });
    expect(toolHead("acp_whatever", { title: "Something" }).name).toBe("azione");
    lang.value = "en";
    expect(toolHead("acp_read", { title: "Read a.ts", paths: ["/p/a.ts"] })).toEqual({
      name: "read",
      summary: "Read a.ts",
    });
    expect(toolHead("bash", { command: "ls" })).toEqual({ name: "bash", summary: "ls" });
    expect(dictionaries.it.acpSection).toBe("Agenti esterni (ACP)");
  });
});
