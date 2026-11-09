// @vitest-environment jsdom
// 3.5.3 (collaudo della 3.5.1, punto 9c): beside «Don't ask me anything» the page says that the
// truly dangerous requests always reach the person, in both choices and both languages.
import { DEFAULT_REQUEST_SETTINGS } from "@redgiant/protocol";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dictionaries, lang } from "../src/i18n.js";

const fakeApi = new Proxy(
  {},
  {
    get: (_t, name: string) => {
      if (name === "then") return undefined;
      return () =>
        Promise.resolve(
          name === "requestSettings"
            ? {
                settings: DEFAULT_REQUEST_SETTINGS,
                defaults: DEFAULT_REQUEST_SETTINGS,
                defaultModel: null,
                critical: [],
              }
            : [],
        );
    },
  },
);
vi.mock("../src/state.js", async (orig) => ({
  ...(await orig<typeof import("../src/state.js")>()),
  getApi: () => fakeApi,
}));

const { RequestsPage } = await import("../src/components/RequestsPage.js");

afterEach(cleanup);

describe("Settings › Requests to you (3.5.3)", () => {
  it("says beside the choice that the truly dangerous requests always reach the person", async () => {
    lang.value = "it";
    const r = render(<RequestsPage />);
    const line =
      /le richieste davvero pericolose arrivano sempre a te, ovunque: cancellazioni definitive, file di sistema, segreti che escono, pagamenti veri e le protezioni di RedGiant/;
    await waitFor(() => expect(r.getByText(line)).toBeTruthy());
    fireEvent.click(r.getByText("Non chiedermi niente"));
    expect(r.getByText(line)).toBeTruthy();
    expect(dictionaries.en.rqAlwaysYou).toMatch(/always reach you, everywhere: deletions for good/);
  });
});
