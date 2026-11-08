// The toolbar popup: linking with a code, the credentials of the tab's site (search, fill, copy
// with the clipboard emptied after 30 seconds), a password generator, the link's state.

import type { BrowserExtEntry, BrowserExtSite } from "@redgiant/protocol";
import { h } from "./dom.js";
import { ext } from "./ext.js";
import { type Key, t } from "./i18n.js";
import { icon, mark } from "./icons.js";
import { BROWSER_LABEL, browserKind, serverOrigin } from "./link.js";
import type { Failure, Request, Status } from "./messages.js";
import { generatePassword, type PasswordKind } from "./password.js";

const app = document.getElementById("app") as HTMLElement;
const ask = <T>(m: Request) =>
  ext.runtime
    .sendMessage<T>(m)
    .catch((err: Error) => ({ error: err.message, code: "failed" }) as Failure);
const isFailure = (x: unknown): x is Failure => typeof x === "object" && x !== null && "error" in x;

const ERRORS: Record<string, Key> = {
  bad_server: "badServer",
  insecure: "insecureServer",
  no_server: "noServer",
  bad_code: "badCode",
  too_many: "tooMany",
  refused: "refused",
  unlinked: "unlinked",
  offline: "offline",
  vault_closed: "closed",
  no_form: "noForm",
  moved: "noForm",
  not_web: "notWeb",
};
const say = (f: Failure | null | undefined) =>
  f?.code && ERRORS[f.code] ? t(ERRORS[f.code] as Key) : t("failed", { why: f?.error ?? "?" });

/** The tab the popup is for (a test may name it: `popup.html?tab=<id>`). */
async function currentTab(): Promise<chrome.tabs.Tab | undefined> {
  const named = Number(new URLSearchParams(location.search).get("tab"));
  if (named) return ext.tabs.get(named).catch(() => undefined);
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function header(sub?: string) {
  return h(
    "header",
    { class: "top" },
    mark(30),
    h("div", { class: "top-text" }, h("b", {}, t("extName")), sub ? h("small", {}, sub) : null),
  );
}

function notice(text: string, kind: "info" | "warn" | "ok" = "info") {
  return h(
    "p",
    { class: `notice ${kind}`, role: "status" },
    kind === "warn" ? icon("alert", 16) : null,
    h("span", {}, text),
  );
}

// ---------------------------------------------------------------------------------------------
// Linking

async function linkView(why?: string) {
  const stored = (await ext.storage.local.get("lastServer")).lastServer;
  const server = h("input", {
    class: "field",
    id: "server",
    value: typeof stored === "string" ? stored : "",
    placeholder: "http://localhost:7650",
    autocomplete: "off",
    spellcheck: "false",
  });
  const code = h("input", {
    class: "field code",
    id: "code",
    placeholder: "ABCD-EFGH",
    autocomplete: "off",
    spellcheck: "false",
    maxlength: "12",
  });
  const name = h("input", {
    class: "field",
    id: "name",
    value: BROWSER_LABEL[browserKind()] ?? "Browser",
    maxlength: "60",
  });
  const remember = h("input", { type: "checkbox", id: "remember", checked: true });
  const out = h("div", { class: "out" });
  const goLabel = h("span", {}, t("link"));
  const go = h("button", { type: "submit", class: "btn primary wide" }, icon("link", 17), goLabel);
  const form = h(
    "form",
    {
      class: "stack",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        out.replaceChildren();
        const s = serverOrigin(server.value);
        if (!s.ok) {
          out.append(notice(t(s.why === "insecure" ? "insecureServer" : "badServer"), "warn"));
          return;
        }
        go.disabled = true;
        goLabel.textContent = t("linking");
        const r = await ask<{ ok: true } | Failure>({
          type: "pair",
          server: s.origin,
          code: code.value,
          name: name.value,
          remember: remember.checked,
        });
        go.disabled = false;
        goLabel.textContent = t("link");
        if (isFailure(r)) {
          out.append(notice(say(r), "warn"));
          return;
        }
        await ext.storage.local.set({ lastServer: s.origin });
        void render();
      },
    },
    h(
      "label",
      { class: "row", for: "server" },
      h("span", {}, t("server")),
      server,
      h("small", {}, t("serverHelp")),
    ),
    h("label", { class: "row", for: "code" }, h("span", {}, t("code")), code),
    h("label", { class: "row", for: "name" }, h("span", {}, t("deviceName")), name),
    h("label", { class: "check" }, remember, h("span", {}, t("remember"))),
    out,
    go,
  );
  app.replaceChildren(
    ...[
      header(t("linkTitle")),
      why ? notice(why, "warn") : null,
      h("p", { class: "lead" }, t("linkLead")),
      form,
    ].filter((n): n is HTMLElement => n !== null),
  );
}

// ---------------------------------------------------------------------------------------------
// Linked: the tab's credentials

function entryRow(e: BrowserExtEntry, tabId: number, out: HTMLElement) {
  const act = (label: string, name: Parameters<typeof icon>[0], run: () => Promise<void>) =>
    h(
      "button",
      {
        type: "button",
        class: "ico-btn",
        title: label,
        "aria-label": label,
        onClick: () => void run(),
      },
      icon(name, 17),
    );
  return h(
    "li",
    { class: "entry" },
    h("span", { class: "entry-ico" }, icon(e.category === "api" ? "key" : "user", 17)),
    h("span", { class: "entry-text" }, h("b", {}, e.service), h("small", {}, e.username || e.site)),
    h(
      "span",
      { class: "entry-acts" },
      act(t("fill"), "fill", async () => {
        const r = await ask<{ ok: boolean; code?: string } | Failure>({
          type: "fill",
          id: e.id,
          tabId,
        });
        out.replaceChildren(
          isFailure(r) || !r.ok
            ? notice(say(isFailure(r) ? r : { error: "", code: r.code ?? "no_form" }), "warn")
            : notice(t("filled"), "ok"),
        );
        if (!isFailure(r) && r.ok) setTimeout(() => window.close(), 600);
      }),
      e.username
        ? act(t("copyUser"), "user", async () => {
            await navigator.clipboard.writeText(e.username);
            out.replaceChildren(notice(t("copiedUser"), "ok"));
          })
        : null,
      act(t("copyPassword"), "copy", async () => {
        const r = await ask<{ value: string } | Failure>({ type: "copy", id: e.id, tabId });
        if (isFailure(r)) {
          out.replaceChildren(notice(say(r), "warn"));
          return;
        }
        await navigator.clipboard.writeText(r.value);
        await ask({ type: "copied" });
        out.replaceChildren(notice(t("copied"), "ok"));
      }),
    ),
  );
}

function generator(tabId: number | undefined, out: HTMLElement) {
  let kind: PasswordKind = "symbols";
  let length = 20;
  const made = h("code", { class: "gen-out", id: "generated" });
  const lenLabel = h("span", { class: "gen-len" });
  const again = () => {
    made.textContent = generatePassword(length, kind);
    lenLabel.textContent = t("genLength", { n: String(length) });
  };
  const slider = h("input", {
    type: "range",
    min: "8",
    max: "64",
    step: "1",
    value: String(length),
    "aria-label": t("genLength", { n: "" }).trim(),
  });
  slider.addEventListener("input", () => {
    length = Number(slider.value);
    again();
  });
  const kinds: [PasswordKind, Key][] = [
    ["symbols", "genSymbols"],
    ["letters", "genLetters"],
    ["digits", "genDigits"],
  ];
  const seg = h(
    "div",
    { class: "seg", role: "radiogroup" },
    ...kinds.map(([k, label]) =>
      h(
        "button",
        {
          type: "button",
          role: "radio",
          "aria-checked": String(k === kind),
          class: k === kind ? "on" : "",
          onClick: (ev: MouseEvent) => {
            kind = k;
            if (k === "digits") {
              length = Math.min(length, 12);
              slider.max = "12";
              slider.min = "4";
            } else {
              slider.max = "64";
              slider.min = "8";
              length = Math.max(length, 8);
            }
            slider.value = String(length);
            for (const b of seg.children) {
              b.classList.toggle("on", b === ev.currentTarget);
              b.setAttribute("aria-checked", String(b === ev.currentTarget));
            }
            again();
          },
        },
        t(label),
      ),
    ),
  );
  again();
  return h(
    "details",
    { class: "gen" },
    h("summary", {}, icon("spark", 17), h("span", {}, t("generator"))),
    seg,
    h("div", { class: "gen-slider" }, slider, lenLabel),
    made,
    h(
      "div",
      { class: "acts" },
      h(
        "button",
        { type: "button", class: "btn", onClick: again },
        icon("refresh", 15),
        t("genAgain"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onClick: async () => {
            await navigator.clipboard.writeText(made.textContent ?? "");
            await ask({ type: "copied" });
            out.replaceChildren(notice(t("copied"), "ok"));
          },
        },
        icon("copy", 15),
        t("genCopy"),
      ),
      tabId !== undefined
        ? h(
            "button",
            {
              type: "button",
              class: "btn primary",
              onClick: async () => {
                const r = await ask<{ ok: boolean; code?: string } | Failure>({
                  type: "fill-new",
                  tabId,
                  value: made.textContent ?? "",
                });
                out.replaceChildren(
                  isFailure(r) || !r.ok
                    ? notice(
                        say(isFailure(r) ? r : { error: "", code: r.code ?? "no_form" }),
                        "warn",
                      )
                    : notice(t("genFilled"), "ok"),
                );
              },
            },
            icon("fill", 15),
            t("genFill"),
          )
        : null,
    ),
  );
}

async function linkedView(st: Status) {
  const tab = await currentTab();
  const web = tab?.url && /^https?:/.test(tab.url) && tab.id !== undefined;
  const out = h("div", { class: "out" });
  const list = h("ul", { class: "entries" });
  const body = h("section", { class: "site" });
  const foot = h(
    "footer",
    { class: "foot" },
    h("small", {}, t("linkedTo", { server: st.server ?? "", name: st.name ?? "" })),
    h(
      "button",
      {
        type: "button",
        class: "btn small",
        onClick: async () => {
          await ask({ type: "unpair" });
          void render();
        },
      },
      icon("unlink", 15),
      t("unlink"),
    ),
  );
  app.replaceChildren(header(), body, out, generator(web ? tab?.id : undefined, out), foot);
  if (!st.reachable) {
    body.append(notice(t("offline"), "warn"));
    return;
  }
  if (!st.ready) {
    body.append(notice(t("closed"), "warn"));
    return;
  }
  if (!web || tab?.id === undefined) {
    body.append(notice(t("notWeb")));
    return;
  }
  const tabId = tab.id;
  const show = (s: BrowserExtSite | Failure) => {
    list.replaceChildren();
    if (isFailure(s)) {
      list.append(h("li", { class: "empty" }, say(s)));
      return;
    }
    if (!s.secure && s.entries.length === 0)
      list.append(h("li", { class: "empty" }, t("notSecure")));
    else if (s.entries.length === 0) list.append(h("li", { class: "empty" }, t("noneHere")));
    for (const e of s.entries) list.append(entryRow(e, tabId, out));
  };
  const first = await ask<BrowserExtSite | Failure>({ type: "site", tabId });
  const host = isFailure(first) ? "" : first.host;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const search = h("input", {
    class: "field",
    type: "search",
    placeholder: t("search"),
    "aria-label": t("search"),
  });
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(
      async () =>
        show(await ask<BrowserExtSite | Failure>({ type: "site", tabId, q: search.value })),
      200,
    );
  });
  body.append(
    h(
      "div",
      { class: "site-head" },
      icon(isFailure(first) || first.secure ? "lock" : "alert", 16),
      h("span", { class: "site-host" }, host ? t("forSite", { host }) : ""),
    ),
    h("label", { class: "search" }, icon("search", 16), search),
    list,
  );
  show(first);
}

async function render() {
  const st = await ask<Status | Failure>({ type: "status" });
  if (isFailure(st)) return linkView(say(st));
  if (!st.linked) return linkView();
  return linkedView(st);
}

document.documentElement.lang = t("title") === "Portachiavi" ? "it" : "en";
document.title = t("extName");
void render();
