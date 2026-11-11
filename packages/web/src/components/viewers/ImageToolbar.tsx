// The picture editor's left bar as Photoshop's (p3.5.7): one slot per group of tools, showing
// the group's tool in use; a small corner triangle marks the groups with more tools, which open
// in a flyout on a long press or a right click. At the bottom the foreground and background
// colours, with the swap (X) and the default colours (D).
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { focusMenu } from "../../a11y.js";
import { t } from "../../i18n.js";
import {
  IconBrush,
  IconBucket,
  IconColorsDefault,
  IconCrop,
  IconEllipse,
  IconEraser,
  IconGradient,
  IconHand,
  IconLasso,
  IconLassoMagnetic,
  IconLassoPoly,
  IconLine,
  IconMarquee,
  IconMarqueeEllipse,
  IconMove,
  IconPencil,
  IconPipette,
  IconQuickSelect,
  IconSquare,
  IconStamp,
  IconSwap,
  IconType,
  IconWand,
  IconZoom,
} from "../../icons.js";
import { groupOf, type ImageTool, TOOL_GROUPS } from "../../viewers/image-tools.js";

const ICONS: Record<ImageTool, () => ComponentChildren> = {
  move: () => <IconMove size={16} />,
  "marquee-rect": () => <IconMarquee size={16} />,
  "marquee-ellipse": () => <IconMarqueeEllipse size={16} />,
  lasso: () => <IconLasso size={16} />,
  "lasso-poly": () => <IconLassoPoly size={16} />,
  "lasso-magnetic": () => <IconLassoMagnetic size={16} />,
  "quick-select": () => <IconQuickSelect size={16} />,
  wand: () => <IconWand size={16} />,
  crop: () => <IconCrop size={16} />,
  eyedropper: () => <IconPipette size={16} />,
  brush: () => <IconBrush size={16} />,
  pencil: () => <IconPencil size={16} />,
  clone: () => <IconStamp size={16} />,
  eraser: () => <IconEraser size={16} />,
  gradient: () => <IconGradient size={16} />,
  bucket: () => <IconBucket size={16} />,
  text: () => <IconType size={16} />,
  "shape-rect": () => <IconSquare size={16} />,
  "shape-ellipse": () => <IconEllipse size={16} />,
  "shape-line": () => <IconLine size={16} />,
  hand: () => <IconHand size={16} />,
  zoom: () => <IconZoom size={16} />,
};

export const toolIcon = (tool: ImageTool) => ICONS[tool]();
export const toolName = (tool: ImageTool) => t(`imgTool_${tool}`);
/** «Brush tool (B)». */
export const toolLabel = (tool: ImageTool) =>
  t("imgToolKey", { name: toolName(tool), key: groupOf(tool).key.toUpperCase() });

const LONG_PRESS_MS = 450;
/** The colours' menu, opened like a group's flyout. */
const COLORS = "colors";

export function ImageToolbar({
  tool,
  shown,
  onTool,
  fg,
  bg,
  onColor,
  onSwap,
  onDefault,
}: {
  tool: ImageTool;
  /** The tool each group shows (its last used). */
  shown: Record<string, ImageTool>;
  onTool: (tool: ImageTool) => void;
  fg: string;
  bg: string;
  onColor: (which: "fg" | "bg", hex: string) => void;
  onSwap: () => void;
  onDefault: () => void;
}) {
  const [open, setOpenNow] = useState<string>();
  const [at, setAt] = useState({ x: 0, y: 0 });
  /** The flyout opens beside its slot (fixed: the bar scrolls and would cut it). */
  const setOpen = (id: string | undefined, el?: Element | null) => {
    if (id && el) {
      const r = el.getBoundingClientRect();
      setAt({ x: r.right + 6, y: r.top });
    }
    setOpenNow(id);
  };
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".img-flyout, .img-tool-slot, .img-colors"))
        setOpen(undefined);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(undefined);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", esc, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", esc, true);
    };
  }, [open]);
  const fgIn = useRef<HTMLInputElement>(null);
  const bgIn = useRef<HTMLInputElement>(null);
  return (
    <div
      class="svg-tools img-tools"
      role="toolbar"
      aria-orientation="vertical"
      aria-label={t("imgTools")}
      ref={bar}
    >
      {TOOL_GROUPS.map((g) => {
        const here = g.tools.includes(tool) ? tool : (shown[g.id] ?? (g.tools[0] as ImageTool));
        const more = g.tools.length > 1;
        const label = more ? t("imgToolMore", { name: toolLabel(here) }) : toolLabel(here);
        return (
          <div class="img-tool-slot" key={g.id}>
            <button
              type="button"
              class={`vw-icon svg-tool ${g.tools.includes(tool) ? "on" : ""} ${more ? "more" : ""}`}
              title={label}
              aria-label={toolLabel(here)}
              aria-pressed={g.tools.includes(tool)}
              aria-haspopup={more ? "menu" : undefined}
              aria-expanded={more ? open === g.id : undefined}
              data-group={g.id}
              onPointerDown={(e) => {
                if (!more) return;
                const el = e.currentTarget;
                clearTimeout(press.current);
                press.current = setTimeout(() => setOpen(g.id, el), LONG_PRESS_MS);
              }}
              onPointerUp={() => clearTimeout(press.current)}
              onPointerLeave={() => clearTimeout(press.current)}
              onContextMenu={(e) => {
                if (!more) return;
                e.preventDefault();
                const el = e.currentTarget;
                setOpen(g.id, el);
                // From the keyboard (Shift+F10, the menu key) the focus goes into the flyout.
                if (e.button !== 2 && document.activeElement === el)
                  requestAnimationFrame(() => {
                    const menu = el.parentElement?.querySelector<HTMLElement>("[role=menu]");
                    if (menu) focusMenu(menu);
                  });
              }}
              onClick={() => {
                if (open === g.id) return;
                onTool(here);
              }}
              // The group's other tools from the keyboard (p3.5.11): the right arrow opens them.
              onKeyDown={(e) => {
                if (!more || e.key !== "ArrowRight" || e.altKey || e.ctrlKey || e.metaKey) return;
                e.preventDefault();
                const el = e.currentTarget;
                setOpen(g.id, el);
                requestAnimationFrame(() => {
                  const menu = el.parentElement?.querySelector<HTMLElement>("[role=menu]");
                  if (menu) focusMenu(menu);
                });
              }}
              aria-keyshortcuts={g.key.toUpperCase()}
            >
              {toolIcon(here)}
            </button>
            {open === g.id && (
              <div
                class="img-flyout"
                role="menu"
                aria-label={toolName(here)}
                style={{ left: `${at.x}px`, top: `${at.y}px` }}
              >
                {g.tools.map((x) => (
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={x === here}
                    key={x}
                    class={x === here ? "on" : ""}
                    onClick={() => {
                      setOpen(undefined);
                      onTool(x);
                    }}
                  >
                    {toolIcon(x)}
                    <span>{toolName(x)}</span>
                    <kbd>{g.key.toUpperCase()}</kbd>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {/* The colours as Photoshop draws them (p3.5.7), one target since p3.5.11: a click acts on
          the part clicked, as before; from the keyboard (or a screen reader) it opens a menu with
          the same four actions. Small overlapping squares were too small to hit. */}
      <div class="img-colors">
        <button
          type="button"
          class="img-colors-btn"
          title={`${t("imgFg")} ${fg} · ${t("imgBg")} ${bg}`}
          aria-label={t("imgColorsLabel", { fg, bg })}
          aria-haspopup="menu"
          aria-expanded={open === COLORS}
          onClick={(e) => {
            const part = (e.target as Element).closest?.("[data-part]")?.getAttribute("data-part");
            if (e.detail === 0 || !part) {
              if (open === COLORS) setOpen(undefined);
              else setOpen(COLORS, e.currentTarget);
              return;
            }
            if (part === "fg") fgIn.current?.click();
            else if (part === "bg") bgIn.current?.click();
            else if (part === "swap") onSwap();
            else onDefault();
          }}
        >
          <span class="img-color-swatch fg" data-part="fg" style={{ background: fg }} />
          <span class="img-color-swatch bg" data-part="bg" style={{ background: bg }} />
          <span class="img-color-swap" data-part="swap">
            <IconSwap size={11} />
          </span>
          <span class="img-color-default" data-part="default">
            <IconColorsDefault size={11} />
          </span>
        </button>
        {open === COLORS && (
          <div
            class="img-flyout img-colors-menu"
            role="menu"
            aria-label={t("imgColors")}
            style={{ left: `${at.x}px`, top: `${at.y}px` }}
          >
            {(
              [
                ["fg", t("imgFg"), () => fgIn.current?.click()],
                ["bg", t("imgBg"), () => bgIn.current?.click()],
                ["swap", t("imgSwap"), onSwap],
                ["default", t("imgDefaultColors"), onDefault],
              ] as const
            ).map(([id, label, act]) => (
              <button
                type="button"
                role="menuitem"
                key={id}
                aria-label={label}
                onClick={() => {
                  setOpen(undefined);
                  act();
                }}
              >
                {id === "fg" || id === "bg" ? (
                  <span
                    class="img-color-chip"
                    style={{ background: id === "fg" ? fg : bg }}
                    aria-hidden="true"
                  />
                ) : id === "swap" ? (
                  <IconSwap size={14} />
                ) : (
                  <IconColorsDefault size={14} />
                )}
                <span>{label}</span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={fgIn}
          type="color"
          class="img-color-input"
          tabIndex={-1}
          aria-hidden="true"
          value={fg}
          onInput={(e) => onColor("fg", (e.target as HTMLInputElement).value)}
        />
        <input
          ref={bgIn}
          type="color"
          class="img-color-input"
          tabIndex={-1}
          aria-hidden="true"
          value={bg}
          onInput={(e) => onColor("bg", (e.target as HTMLInputElement).value)}
        />
      </div>
    </div>
  );
}
