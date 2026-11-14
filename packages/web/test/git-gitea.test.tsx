// @vitest-environment jsdom
// Where the code lives (G24.5, p3.7.2): besides starting Gitea here, the person can connect a
// Gitea they already have (address, user, token); once connected it says where, and disconnecting
// only forgets it. Our own drawn choice, no native radios.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api.js";
import { lang } from "../src/i18n.js";

const calls: [string, unknown[]][] = [];
const fail: { code?: string } = {};
const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([name, args]);
        if (name === "connectGitea" && fail.code)
          return Promise.reject(new ApiError(400, "Gitea did not answer", fail.code));
        return Promise.resolve({});
      };
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { Gitea } = await import("../src/components/GitCode.js");

const state = (gitea?: object) => ({ config: { git: gitea ? { gitea } : {} } }) as never;

beforeEach(() => {
  lang.value = "it";
  calls.length = 0;
});
afterEach(() => cleanup());

describe("a Gitea the person already has", () => {
  it("asks for address, user and token, and sends them to be checked", async () => {
    const changed = vi.fn();
    const r = render(<Gitea s={state()} onChange={changed} />);
    expect(r.container.querySelector('input[type="radio"], input[type="checkbox"]')).toBeNull();
    fireEvent.click(r.getByText("Un Gitea che hai già"));
    const text = r.container.textContent ?? "";
    for (const label of [
      "L'indirizzo del tuo Gitea",
      "Il tuo nome utente lì",
      "Un token di accesso",
    ])
      expect(text).toContain(label);
    const [url, user, token] = [...r.container.querySelectorAll("form input")];
    fireEvent.input(url as Element, { target: { value: "https://git.example.org" } });
    fireEvent.input(user as Element, { target: { value: "marta" } });
    fireEvent.input(token as Element, { target: { value: "un-token-lungo" } });
    expect((token as HTMLInputElement).type).toBe("password");
    fireEvent.click(r.getByText("Prova e collega"));
    await waitFor(() =>
      expect(calls.find(([n]) => n === "connectGitea")?.[1]).toEqual([
        "https://git.example.org",
        "marta",
        "un-token-lungo",
      ]),
    );
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(calls.some(([n]) => n === "startGitea")).toBe(false);
  });

  it("once connected says where, and disconnecting only forgets it", async () => {
    const r = render(
      <Gitea
        s={state({ user: "marta", publicUrl: "https://git.example.org", external: true })}
        onChange={() => {}}
      />,
    );
    expect(r.container.textContent).toContain("Collegato a https://git.example.org, utente marta");
    expect(r.queryByText("Spegni")).toBeNull();
    fireEvent.click(r.getByText("Scollega"));
    await waitFor(() => expect(calls.some(([n]) => n === "stopGitea")).toBe(true));
  });
});

describe("a Gitea whose name RedGiant cannot use (p3.7.3)", () => {
  const tryIt = async (code: string) => {
    fail.code = code;
    const r = render(<Gitea s={state()} onChange={() => {}} />);
    fireEvent.click(r.getByText("Un Gitea che hai già"));
    const [url, user, token] = [...r.container.querySelectorAll("form input")];
    fireEvent.input(url as Element, { target: { value: "https://git.home.varitest.ovh" } });
    fireEvent.input(user as Element, { target: { value: "marta" } });
    fireEvent.input(token as Element, { target: { value: "un-token-lungo" } });
    fireEvent.click(r.getByText("Prova e collega"));
    return r;
  };
  afterEach(() => {
    delete fail.code;
  });

  it("says the name is unknown to its DNS, and leads to the guide", async () => {
    const r = await tryIt("name_not_found");
    await waitFor(() => r.getByText(/RedGiant non trova git.home.varitest.ovh/));
    expect(r.container.textContent).not.toContain("fetch failed");
    expect(r.getByText("Apri «I tuoi servizi di casa»")).toBeTruthy();
  });

  it("says the address does not answer from here, and leads to the guide", async () => {
    const r = await tryIt("host_unreachable");
    await waitFor(() => r.getByText(/RedGiant trova git.home.varitest.ovh, ma da qui/));
    expect(r.getByText("Apri «I tuoi servizi di casa»")).toBeTruthy();
  });
});
