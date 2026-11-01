import { signal } from "@preact/signals";

export type Theme = "system" | "light" | "dark";

const saved = (
  typeof localStorage !== "undefined" ? localStorage.getItem("rg.theme") : null
) as Theme | null;
/** Light, dark, or whatever the device uses (the default). */
export const theme = signal<Theme>(saved === "light" || saved === "dark" ? saved : "system");

export function applyTheme(): void {
  document.documentElement.dataset.theme = theme.value;
}

export function setTheme(t: Theme): void {
  theme.value = t;
  localStorage.setItem("rg.theme", t);
  applyTheme();
}
