// On every web page (top frame): finds sign-in forms, offers the keychain's credentials of this
// site when the person focuses a field, fills only when they click one (a real click: the page
// cannot click for them), and after a form with a new or changed password proposes to save it.
// The overlay lives in a closed shadow root: the page can neither read nor restyle it.

import type { BrowserExtEntry, BrowserExtSite } from "@redgiant/protocol";
import { h } from "./dom.js";
import { ext } from "./ext.js";
import {
  fill,
  fillNew,
  findLoginForms,
  formOf,
  type LoginForm,
  sentCredentials,
  setValue,
} from "./forms.js";
import { t } from "./i18n.js";
import { icon, mark } from "./icons.js";
import type { Failure, PageMessage, Request, SaveOffer } from "./messages.js";
import { OVERLAY_CSS } from "./overlay-css.js";

/** Words of buttons that send a sign-in or a new password (a page without a real form). */
const SENDS =
  /log ?in|sign ?(in|up)|accedi|entra|continu|next|avanti|submit|invia|save|salva|regist|create|crea|change|cambia|aggiorna|update|ok\b|conferma|confirm/i;
const sends = (b: Element) =>
  b.matches('input[type="submit"], button[type="submit"]') ||
  (b.matches("button:not([type])") && b.closest("form") !== null) ||
  SENDS.test(
    `${b.textContent ?? ""} ${(b as HTMLInputElement).value ?? ""} ${b.getAttribute("aria-label") ?? ""}`,
  );

const ask = <T>(m: Request) => ext.runtime.sendMessage<T>(m).catch(() => null);
const isFailure = (x: unknown): x is Failure => typeof x === "object" && x !== null && "error" in x;

function start() {
  let forms: LoginForm[] = [];
  let site: BrowserExtSite | null | undefined;
  let asking = false;

  // The overlay.
  const host = document.createElement("redgiant-keychain");
  host.style.cssText = "all: initial; position: fixed; inset: 0 auto auto 0; z-index: 2147483647;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.append(h("style", {}, OVERLAY_CSS));
  const layer = h("div", { class: "layer" });
  shadow.append(layer);
  const mount = () => {
    if (!host.isConnected) document.documentElement.append(host);
  };

  // ------------------------------------------------------------------------------------------
  // The chip in a focused field, and its menu

  let anchor: HTMLInputElement | null = null;
  let chip: HTMLButtonElement | null = null;
  let menu: HTMLDivElement | null = null;

  const place = () => {
    if (!anchor || !chip) return;
    const r = anchor.getBoundingClientRect();
    if (r.width === 0) return hideChip();
    chip.style.left = `${Math.round(r.right - 30)}px`;
    chip.style.top = `${Math.round(r.top + (r.height - 24) / 2)}px`;
    if (menu) {
      const w = Math.min(320, window.innerWidth - 16);
      menu.style.width = `${w}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
      menu.style.top = `${Math.round(r.bottom + 6)}px`;
    }
  };
  const hideMenu = () => {
    menu?.remove();
    menu = null;
  };
  const hideChip = () => {
    hideMenu();
    chip?.remove();
    chip = null;
    anchor = null;
  };

  const choose = async (e: BrowserExtEntry, form: LoginForm, note: HTMLElement) => {
    note.textContent = "";
    const v = await ask<{ value: string; username: string } | Failure>({ type: "fill", id: e.id });
    if (!v || isFailure(v)) {
      note.textContent =
        v?.code === "refused"
          ? t("refused")
          : v?.code === "too_many"
            ? t("tooMany")
            : t("failed", { why: v?.error ?? "?" });
      return;
    }
    fill(form, v.username || e.username, form.kind === "username" ? "" : v.value);
    hideChip();
  };

  const openMenu = (form: LoginForm) => {
    if (menu) return hideMenu();
    const entries = site?.entries ?? [];
    const note = h("p", { class: "note", role: "status" });
    menu = h(
      "div",
      { class: "menu", role: "menu" },
      h("div", { class: "menu-head" }, mark(20), h("span", {}, t("menuTitle"))),
      ...entries.map((e) =>
        h(
          "button",
          {
            type: "button",
            class: "item",
            role: "menuitem",
            onClick: (ev: MouseEvent) => {
              if (ev.isTrusted) void choose(e, form, note);
            },
          },
          h("b", {}, e.service),
          h("small", {}, e.username || e.site),
        ),
      ),
      note,
    );
    layer.append(menu);
    place();
  };

  const showChip = (input: HTMLInputElement) => {
    const form = formOf(forms, input);
    if (!form || !site?.entries.length) return;
    if (anchor === input && chip) return;
    hideChip();
    anchor = input;
    mount();
    chip = h(
      "button",
      {
        type: "button",
        class: "chip",
        title: t("chipLabel"),
        "aria-label": t("chipLabel"),
        onMousedown: (ev: MouseEvent) => ev.preventDefault(),
        onClick: (ev: MouseEvent) => {
          if (ev.isTrusted) openMenu(form);
        },
      },
      icon("key", 15),
    );
    layer.append(chip);
    place();
  };

  // ------------------------------------------------------------------------------------------
  // Finding forms (again when the page changes) and asking which credentials fit

  const scan = () => {
    forms = findLoginForms(document);
    if (forms.length > 0 && site === undefined && !asking) {
      asking = true;
      void ask<BrowserExtSite | Failure>({ type: "site" }).then((s) => {
        asking = false;
        site = s && !isFailure(s) ? s : null;
        const focused = document.activeElement;
        if (focused instanceof HTMLInputElement) showChip(focused);
      });
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(scan, 300);
  };
  new MutationObserver(later).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["type", "style", "class", "hidden"],
  });
  scan();

  document.addEventListener(
    "focusin",
    (e) => {
      if (e.target instanceof HTMLInputElement) {
        if (!formOf(forms, e.target)) scan();
        showChip(e.target);
      }
    },
    true,
  );
  document.addEventListener(
    "focusout",
    () =>
      setTimeout(() => {
        if (document.activeElement !== host && !(document.activeElement === anchor)) hideChip();
      }, 200),
    true,
  );
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu();
  });
  window.addEventListener("scroll", place, { passive: true, capture: true });
  window.addEventListener("resize", place, { passive: true });

  // ------------------------------------------------------------------------------------------
  // Saving: a form with a password was sent

  let lastSent = "";
  let card: HTMLDivElement | null = null;
  const sent = (root: HTMLFormElement | Document | null) => {
    forms = findLoginForms(document, { layout: false });
    const form =
      forms.find((f) => f.root === root) ?? forms.find((f) => f.password || f.newPasswords.length);
    if (!form) return;
    const c = sentCredentials(form);
    if (!c) return;
    const key = `${c.username}\0${c.password}`;
    if (key === lastSent) return;
    lastSent = key;
    void ask<{ offer: SaveOffer | null }>({ type: "sent", ...c }).then((r) => {
      if (r?.offer) offerSave(r.offer);
    });
  };
  document.addEventListener("submit", (e) => sent(e.target as HTMLFormElement), true);
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !(e.target instanceof Element)) return;
      const b = e.target.closest(
        'button, input[type="submit"], input[type="button"], [role="button"]',
      );
      if (!b || host.contains(b) || !sends(b)) return;
      const form = b.closest("form");
      // Buttons that send: in a form with a password, or near standalone password fields.
      if (
        form
          ? form.querySelector('input[type="password"]')
          : document.querySelector('input[type="password"]')
      )
        sent(form ?? document);
    },
    true,
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter" && e.isTrusted && e.target instanceof HTMLInputElement)
        sent(e.target.form ?? document);
    },
    true,
  );

  const offerSave = (offer: SaveOffer) => {
    card?.remove();
    mount();
    const update = offer.check.state === "changed";
    const domain = offer.check.domain;
    const service = h("input", { class: "field", value: offer.check.service, maxlength: "80" });
    const user = h("input", { class: "field", value: offer.username, maxlength: "200" });
    const sites = h("input", { class: "field", value: offer.check.hosts.join(", ") });
    const note = h("p", { class: "note", role: "status" });
    const go = h(
      "button",
      {
        type: "button",
        class: "btn primary",
        onClick: async (ev: MouseEvent) => {
          if (!ev.isTrusted) return;
          go.disabled = true;
          const r = await ask<{ state: string } | Failure>({
            type: "save",
            service: service.value,
            username: user.value,
            hosts: sites.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          if (!r || isFailure(r)) {
            go.disabled = false;
            note.textContent =
              r?.code === "refused" ? t("refused") : t("failed", { why: r?.error ?? "?" });
            return;
          }
          lastSent = "";
          note.textContent = r.state === "updated" ? t("updated") : t("saved");
          for (const b of card?.querySelectorAll("button, input") ?? [])
            (b as HTMLButtonElement).disabled = true;
          setTimeout(() => card?.remove(), 2500);
        },
      },
      icon("save", 16),
      update ? t("update") : t("save"),
    );
    const no = () => {
      void ask({ type: "dismiss" });
      card?.remove();
      card = null;
    };
    card = h(
      "div",
      { class: "card", role: "dialog", "aria-label": update ? t("updateTitle") : t("saveTitle") },
      h(
        "div",
        { class: "card-head" },
        mark(26),
        h("b", {}, update ? t("updateTitle") : t("saveTitle")),
        h(
          "button",
          { type: "button", class: "x", "aria-label": t("close"), title: t("close"), onClick: no },
          icon("close", 16),
        ),
      ),
      h(
        "p",
        { class: "lead" },
        update
          ? t("updateLead", { service: offer.check.service, host: offer.host })
          : t("saveLead", { host: offer.host }),
      ),
      !update && h("label", { class: "row" }, h("span", {}, t("saveService")), service),
      h("label", { class: "row" }, h("span", {}, t("saveUser")), user),
      !update &&
        h(
          "label",
          { class: "row" },
          h("span", {}, t("saveSites")),
          sites,
          h("small", {}, t("saveSitesHelp", { domain })),
        ),
      note,
      h(
        "div",
        { class: "acts" },
        h("button", { type: "button", class: "btn", onClick: no }, t("notNow")),
        go,
      ),
    );
    layer.append(card);
  };

  // After the sign-in page went, a save may be waiting for this tab.
  void ask<{ offer: SaveOffer | null }>({ type: "pending" }).then((r) => {
    if (r?.offer) offerSave(r.offer);
  });

  // ------------------------------------------------------------------------------------------
  // The popup's «Fill» and «Put in the page», through the background

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== ext.runtime.id) return undefined;
    const m = message as PageMessage;
    if (m.type !== "do-fill" && m.type !== "do-fill-new") return undefined;
    // The value was fetched for this page's origin: if the page moved meanwhile, nothing is written.
    if (m.origin !== location.origin) {
      sendResponse({ ok: false, code: "moved" });
      return undefined;
    }
    forms = findLoginForms(document);
    const focused =
      document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
    if (m.type === "do-fill") {
      const form =
        formOf(forms, focused) ?? forms.find((f) => f.password) ?? forms.find((f) => f.username);
      const ok = form ? fill(form, m.username, form.kind === "username" ? "" : m.value) : false;
      sendResponse({ ok, ...(!ok && { code: "no_form" }) });
    } else {
      const form = formOf(forms, focused) ?? forms.find((f) => f.newPasswords.length > 0);
      let ok = form ? fillNew(form, m.value) : false;
      if (!ok && focused?.type === "password") {
        setValue(focused, m.value);
        ok = true;
      }
      sendResponse({ ok, ...(!ok && { code: "no_form" }) });
    }
    return undefined;
  });
}

const flag = "__redgiantKeychain";
const g = globalThis as { [flag]?: boolean };
if (!g[flag] && (location.protocol === "https:" || location.protocol === "http:")) {
  g[flag] = true;
  start();
}
