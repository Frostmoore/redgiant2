// @vitest-environment jsdom
// G39.7: the first access without friction. At a first start without a password the sign-in page
// is «Create your access» (a password, then in); from outside the local network it says where to
// open it; the token is never a step for people (only folded away for apps and the command
// line); `#token=…` links sign in and leave the address bar clean.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lang } from "../src/i18n.js";

const signedIn: string[] = [];
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  signIn: async (token: string) => {
    signedIn.push(token);
  },
}));

const { Login } = await import("../src/components/Login.js");
const { takeFromLink } = await import("../src/state.js");

let methods: Record<string, unknown> = {};
let firstAccess: { status: number; body: unknown } = { status: 200, body: { token: "rgs_new" } };
const posted: [string, unknown][] = [];

beforeEach(() => {
  lang.value = "it";
  signedIn.length = 0;
  posted.length = 0;
  firstAccess = { status: 200, body: { token: "rgs_new" } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/auth/methods") return new Response(JSON.stringify(methods));
      if (init?.body) posted.push([url, JSON.parse(String(init.body))]);
      if (url === "/api/auth/first-access")
        return new Response(JSON.stringify(firstAccess.body), { status: firstAccess.status });
      return new Response("{}");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every input the person can see (the folded «apps and command line» part is not open). */
const visibleInputs = (root: Element) =>
  [...root.querySelectorAll("input")].filter((i) => !i.closest("details:not([open])"));

describe("«Create your access» (G39.7)", () => {
  it("asks only for a password, twice, and the page is in", async () => {
    methods = { password: false, code: false, setupCode: false, firstAccess: "password" };
    const r = render(<Login />);
    await waitFor(() => r.getByText("Crea il tuo accesso"));
    const text = r.container.textContent ?? "";
    // No token, no code, no console: nothing to copy from anywhere.
    expect(text).not.toMatch(/token|codice|console/i);
    expect(r.container.querySelector(".ui-advanced")).toBeNull();
    const [pw, again] = visibleInputs(r.container);
    expect(visibleInputs(r.container)).toHaveLength(2);
    expect(pw?.getAttribute("autocomplete")).toBe("new-password");
    // A weak or mismatched password is said on the page, nothing is sent.
    fireEvent.input(pw as HTMLInputElement, { target: { value: "corta" } });
    fireEvent.input(again as HTMLInputElement, { target: { value: "corta" } });
    fireEvent.click(r.getByText("Crea ed entra"));
    await waitFor(() =>
      expect(r.container.querySelector(".notice.error")?.textContent).toMatch(/Almeno 10/),
    );
    expect(posted).toHaveLength(0);
    fireEvent.input(pw as HTMLInputElement, { target: { value: "una-password-lunga" } });
    fireEvent.input(again as HTMLInputElement, { target: { value: "una-password-lungA" } });
    fireEvent.click(r.getByText("Crea ed entra"));
    await waitFor(() => expect(posted).toHaveLength(0));
    fireEvent.input(again as HTMLInputElement, { target: { value: "una-password-lunga" } });
    fireEvent.click(r.getByText("Crea ed entra"));
    await waitFor(() => expect(signedIn).toEqual(["rgs_new"]));
    expect(posted).toEqual([["/api/auth/first-access", { password: "una-password-lunga" }]]);
  });

  it("shows the usual sign-in when someone else created it a moment ago", async () => {
    methods = { password: false, code: false, firstAccess: "password" };
    firstAccess = { status: 403, body: { error: "closed", code: "closed" } };
    const r = render(<Login />);
    await waitFor(() => r.getByText("Crea il tuo accesso"));
    const [pw, again] = visibleInputs(r.container);
    fireEvent.input(pw as HTMLInputElement, { target: { value: "una-password-lunga" } });
    fireEvent.input(again as HTMLInputElement, { target: { value: "una-password-lunga" } });
    methods = { password: true, code: false };
    fireEvent.click(r.getByText("Crea ed entra"));
    await waitFor(() => expect(r.queryByText("Crea il tuo accesso")).toBeNull());
    expect(r.getAllByText("Accedi").length).toBeGreaterThan(0);
    expect(signedIn).toHaveLength(0);
  });

  it("from outside the local network says where to open it, and asks nothing", async () => {
    methods = { password: false, code: false, firstAccess: "not_here" };
    const r = render(<Login />);
    await waitFor(() => r.getByText("Il primo accesso si crea da casa"));
    expect(visibleInputs(r.container)).toHaveLength(0);
    expect(r.container.textContent).not.toMatch(/token/i);
  });

  it("asks for the setup code only when the installation requires it", async () => {
    methods = { password: false, code: false, setupCode: false, firstAccess: "code" };
    const r = render(<Login />);
    await waitFor(() => r.getByText("Primo avvio"));
    expect(r.getByPlaceholderText("ABCDE-FGHJK")).toBeTruthy();
    expect(r.container.textContent).not.toMatch(/token/i);
  });

  it("with a password: only the password, remembered on the device; the token folded away", async () => {
    methods = { password: true, code: false };
    const r = render(<Login />);
    await waitFor(() => r.getByPlaceholderText("Password"));
    expect(visibleInputs(r.container)).toHaveLength(1);
    expect(r.getByText(/resta dentro/)).toBeTruthy();
    // The token is there for apps and the command line, closed, never the way people go.
    const folded = r.container.querySelector("details.ui-advanced");
    expect(folded?.hasAttribute("open")).toBe(false);
    expect(folded?.textContent).toMatch(/app e riga di comando/i);
  });
});

describe("links with #token= (G39.7)", () => {
  it("takes the token out of the address bar and keeps the rest", () => {
    history.replaceState(null, "", "/?x=1#token=rgs_abc&view=files");
    expect(takeFromLink()).toEqual({ token: "rgs_abc" });
    expect(location.pathname + location.search + location.hash).toBe("/?x=1#view=files");
    history.replaceState(null, "", "/#tavola=b1.0123456789ab&token=tok");
    expect(takeFromLink()).toEqual({ token: "tok", board: "b1.0123456789ab" });
    expect(location.hash).toBe("");
    expect(location.href).not.toContain("tok");
    history.replaceState(null, "", "/#ui-gallery");
    expect(takeFromLink()).toEqual({});
    expect(location.hash).toBe("#ui-gallery");
    history.replaceState(null, "", "/#token=");
    expect(takeFromLink()).toEqual({});
    expect(location.hash).toBe("");
  });
});
