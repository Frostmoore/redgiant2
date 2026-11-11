// «Scorciatoie» (p3.5.11, G37.9): the keyboard map of the canvas and its editors, in our window,
// opened with «?» (outside a field or an editor) or the keyboard button in a tab's head. Every
// key listed here works; a test reads this list.
import { signal } from "@preact/signals";
import { type Key, t } from "../i18n.js";
import { Modal } from "./ui.js";

/** Whether the keyboard map is open. */
export const shortcutsOpen = signal(false);

/**
 * The sections of the map: a title and its rows (keys, what they do). Keys are words, never
 * symbols: `@name` is a key's name through t() («Canc» in Italian), anything else is printed as
 * it is (letters, Ctrl+S); « / » separates keys that do the same.
 */
export const SHORTCUTS: { title: Key; rows: [keys: string, what: Key][] }[] = [
  {
    title: "kbGeneral",
    rows: [
      ["?", "kbHelp"],
      ["@kTab / Shift+@kTab", "kbTab"],
      ["@kEsc", "kbEsc"],
      ["Ctrl+S", "kbSave"],
      ["Ctrl+Z / Ctrl+Y", "kbUndo"],
    ],
  },
  {
    title: "kbGroups",
    rows: [
      ["@kArrows", "kbArrows"],
      ["@kHome / @kEnd", "kbHomeEnd"],
      ["@kEnter / @kSpace", "kbActivate"],
      ["@kDown / Shift+F10", "kbMenuOpen"],
    ],
  },
  {
    title: "kbTabs",
    rows: [
      ["@kLeftRight", "kbTabsMove"],
      ["@kDelete", "kbTabsClose"],
    ],
  },
  {
    title: "kbText",
    rows: [
      ["@kTab", "kbTextTab"],
      ["Ctrl+] / Ctrl+[", "kbTextIndent"],
      ["Ctrl+F", "kbTextFind"],
    ],
  },
  {
    title: "kbImage",
    rows: [
      ["V M L W C I B S E G T U H Z", "kbImageTools"],
      ["@kRight / Shift+F10", "kbImageFlyout"],
      ["X / D", "kbImageColors"],
      ["[ / ]", "kbImageBrush"],
      ["@kArrows", "kbImageNudge"],
      ["@kEnter / @kEsc", "kbImageCommit"],
    ],
  },
  {
    title: "kbSvg",
    rows: [
      ["V R E L P T", "kbSvgTools"],
      ["@kArrows", "kbImageNudge"],
      ["Ctrl+G / Ctrl+Shift+G", "kbSvgGroup"],
    ],
  },
  {
    title: "kb3d",
    rows: [
      ["G / R / S", "kb3dModes"],
      ["F", "kb3dFrame"],
      ["@kUpDown", "kb3dTree"],
      ["@kEsc", "kb3dNone"],
    ],
  },
  {
    title: "kbPdf",
    rows: [
      ["@kPageDown / @kPageUp", "kbPdfPages"],
      ["@kHome / @kEnd", "kbPdfEnds"],
    ],
  },
  {
    title: "kbArtifact",
    rows: [["@kTab / Shift+@kTab", "kbArtifactFrame"]],
  },
];

/** A key's printed name: «@kDelete» through t(), the rest as it is. */
export const keyName = (k: string) =>
  k.replace(/@(k[A-Za-z]+)/g, (_, name: string) => t(name as Key));

export function Shortcuts() {
  return (
    <div class="wz-look">
      <Modal
        title={t("kbTitle")}
        onClose={() => (shortcutsOpen.value = false)}
        wide
        class="kb-help"
      >
        <div class="kb-help-grid">
          {SHORTCUTS.map((s) => (
            <section key={s.title}>
              <h3>{t(s.title)}</h3>
              <dl>
                {s.rows.map(([keys, what]) => (
                  <div key={`${keys}-${what}`} class="kb-help-row">
                    <dt>
                      {keys.split(" / ").map((k, i) => (
                        <span key={k}>
                          {i > 0 && <span class="kb-or"> / </span>}
                          <kbd>{keyName(k)}</kbd>
                        </span>
                      ))}
                    </dt>
                    <dd>{t(what)}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </Modal>
    </div>
  );
}
