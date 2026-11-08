// @vitest-environment jsdom
// G36.21: finding sign-in forms and filling them like typing, on pages written the many ways sites do.
import { describe, expect, it } from "vitest";
import {
  fill,
  fillNew,
  findLoginForms,
  formOf,
  type LoginForm,
  sentCredentials,
} from "../src/forms.js";

const page = (html: string) => {
  document.body.innerHTML = html;
  return findLoginForms(document, { layout: false });
};
/** The only (or first) form of a page, which must be there. */
const one = (html: string): LoginForm => {
  const [f] = page(html);
  if (!f) throw new Error("no form found");
  return f;
};
const field = (sel: string) => document.querySelector(sel) as HTMLInputElement;

describe("findLoginForms", () => {
  it("finds a plain sign-in form", () => {
    const [f, ...rest] = page(`
      <form><input name="q" placeholder="Search"><input type="email" name="email">
      <input type="password" name="pw"><button>Sign in</button></form>`);
    expect(rest).toEqual([]);
    expect(f?.kind).toBe("login");
    expect(f?.username).toBe(field('[name="email"]'));
    expect(f?.password).toBe(field('[name="pw"]'));
    expect(f?.newPasswords).toEqual([]);
  });

  it("prefers autocomplete=username and skips search and one-time code fields", () => {
    const [f] = page(`
      <form><input name="login" autocomplete="username"><input name="nickname">
      <input name="otp" autocomplete="one-time-code"><input type="password"></form>`);
    expect(f?.username).toBe(field('[name="login"]'));
    const [g] = page(`<form><input name="cerca"><input type="password"></form>`);
    expect(g?.username).toBeNull();
  });

  it("reads Italian labels", () => {
    const [f] = page(`
      <form><label for="a">Nome utente</label><input id="a"><label>Codice promo <input id="b"></label>
      <input type="password" id="c"></form>`);
    // The promo code comes after the user name and is not one.
    expect(f?.username).toBe(field("#a"));
  });

  it("finds fields that stand alone, without a form", () => {
    const [f] = page(
      `<div><input type="text" id="u"><input type="password" id="p"><div role="button">Accedi</div></div>`,
    );
    expect(f?.root).toBe(document);
    expect(f?.username).toBe(field("#u"));
    expect(f?.password).toBe(field("#p"));
  });

  it("tells a sign-up from a change of password", () => {
    const [up] = page(`
      <form><input type="email" id="e"><input type="password" id="a" autocomplete="new-password">
      <input type="password" id="b" autocomplete="new-password"></form>`);
    expect(up?.kind).toBe("signup");
    expect(up?.password).toBeNull();
    expect(up?.newPasswords).toEqual([field("#a"), field("#b")]);

    const [change] = page(`
      <form><input type="password" id="old" name="current_password">
      <input type="password" id="n1" name="new_password"><input type="password" id="n2" name="confirm_password"></form>`);
    expect(change?.kind).toBe("change");
    expect(change?.password).toBe(field("#old"));
    expect(change?.newPasswords).toEqual([field("#n1"), field("#n2")]);

    const [unmarked] = page(
      `<form><input id="u"><input type="password" id="x"><input type="password" id="y"></form>`,
    );
    expect(unmarked?.kind).toBe("signup");
    const [three] = page(
      `<form><input type="password" id="x"><input type="password" id="y"><input type="password" id="z"></form>`,
    );
    expect(three?.kind).toBe("change");
    expect(three?.password).toBe(field("#x"));
  });

  it("finds the first step of a two-step sign-in", () => {
    const [f] = page(`<form><input type="email" name="identifier"><button>Next</button></form>`);
    expect(f?.kind).toBe("username");
    expect(f?.password).toBeNull();
    // A newsletter box is not a sign-in.
    expect(page(`<form><input name="city"><button>Go</button></form>`)).toEqual([]);
  });

  it("ignores hidden and disabled fields", () => {
    expect(
      page(`
      <form style="display:none"><input id="u"><input type="password"></form>
      <form><input type="hidden" name="u"><input type="password" disabled></form>
      <div hidden><input type="password"></div>
      <form><input type="password" style="visibility:hidden"></form>`),
    ).toEqual([]);
    const [f] = page(
      `<form><input id="u" aria-hidden="true"><input id="v"><input type="password"></form>`,
    );
    expect(f?.username).toBe(field("#v"));
  });

  it("finds a field's form", () => {
    const forms = page(
      `<form><input id="u"><input type="password" id="p"></form><input id="other">`,
    );
    expect(formOf(forms, field("#p"))).toBe(forms[0]);
    expect(formOf(forms, field("#other"))).toBeUndefined();
  });
});

describe("filling", () => {
  it("writes like typing: input and change events", () => {
    const f = one(`<form><input id="u"><input type="password" id="p"></form>`);
    const seen: string[] = [];
    for (const el of [field("#u"), field("#p")])
      for (const type of ["input", "change"])
        el.addEventListener(type, () => seen.push(`${el.id}:${type}`));
    expect(fill(f, "ada", "s3cret")).toBe(true);
    expect(field("#u").value).toBe("ada");
    expect(field("#p").value).toBe("s3cret");
    expect(seen).toEqual(["u:input", "u:change", "p:input", "p:change"]);
  });

  it("reaches through a framework's own value property", () => {
    const f = one(`<form><input id="u"><input type="password" id="p"></form>`);
    // As React does: a value property on the element itself that records what it last saw.
    const p = field("#p");
    let tracked = "";
    Object.defineProperty(p, "value", {
      configurable: true,
      get: () => tracked,
      set: (v: string) => {
        tracked = v;
      },
    });
    fill(f, "", "from-the-keychain");
    // The prototype's setter wrote the real value; the framework's tracker did not hide the change.
    expect(tracked).toBe("");
    expect(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.get?.call(p)).toBe(
      "from-the-keychain",
    );
  });

  it("puts a generated password in the new fields only", () => {
    const f = one(`
      <form><input type="password" id="old" autocomplete="current-password">
      <input type="password" id="a" autocomplete="new-password"><input type="password" id="b" autocomplete="new-password"></form>`);
    expect(fillNew(f, "Gen-123")).toBe(true);
    expect([field("#old").value, field("#a").value, field("#b").value]).toEqual([
      "",
      "Gen-123",
      "Gen-123",
    ]);
  });

  it("reads what a form sent: the new password on a change", () => {
    const f = one(`
      <form><input id="u" value="ada"><input type="password" id="old" name="current-password" value="old">
      <input type="password" id="n" name="new-password" value="new"></form>`);
    expect(sentCredentials(f)).toEqual({ username: "ada", password: "new" });
    const g = one(`<form><input id="u" value=" bob "><input type="password" value="pw"></form>`);
    expect(sentCredentials(g)).toEqual({ username: "bob", password: "pw" });
    const empty = one(`<form><input id="u" value="x"><input type="password" value="  "></form>`);
    expect(sentCredentials(empty)).toBeNull();
  });
});
