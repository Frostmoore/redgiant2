// The picture editor's left bar as Photoshop's (p3.5.7): one slot per group of tools, showing
// the group's tool in use; a small corner triangle marks the groups with more tools, which open
// in a flyout on a long press or a right click. At the bottom the foreground and background
// colours, with the swap (X) and the default colours (D).
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
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
  const [at, setAt] = useState({ x: 0, y: 0, up: false });
  /**
   * The flyout opens beside its slot (fixed: the bar scrolls and would cut it); above it when the
   * bar lies at the bottom (a phone, 3.5.11), kept inside the window.
   */
  const setOpen = (id: string | undefined, el?: Element | null) => {
    if (id && el) {
      const r = el.getBoundingClientRect();
      if (bar.current?.closest(".compact"))
        setAt({
          x: Math.max(4, Math.min(r.left, window.innerWidth - 224)),
          y: r.top - 6,
          up: true,
        });
      else setAt({ x: r.right + 6, y: r.top, up: false });
    }
    setOpenNow(id);
  };
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (!(e.target as HTMLElement).closest?.(".img-flyout, .img-tool-slot")) setOpen(undefined);
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
                setOpen(g.id, e.currentTarget);
              }}
              onClick={() => {
                if (open === g.id) return;
                onTool(here);
              }}
            >
              {toolIcon(here)}
            </button>
            {open === g.id && (
              <div
                class="img-flyout"
                role="menu"
                aria-label={toolName(here)}
                style={{
                  left: `${at.x}px`,
                  top: `${at.y}px`,
                  ...(at.up && { transform: "translateY(-100%)" }),
                }}
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
      <div class="img-colors">
        <button
          type="button"
          class="img-color-swatch fg"
          style={{ background: fg }}
          title={`${t("imgFg")} ${fg}`}
          aria-label={t("imgFg")}
          onClick={() => fgIn.current?.click()}
        />
        <button
          type="button"
          class="img-color-swatch bg"
          style={{ background: bg }}
          title={`${t("imgBg")} ${bg}`}
          aria-label={t("imgBg")}
          onClick={() => bgIn.current?.click()}
        />
        <button
          type="button"
          class="img-color-swap"
          title={t("imgSwap")}
          aria-label={t("imgSwap")}
          onClick={onSwap}
        >
          <IconSwap size={11} />
        </button>
        <button
          type="button"
          class="img-color-default"
          title={t("imgDefaultColors")}
          aria-label={t("imgDefaultColors")}
          onClick={onDefault}
        >
          <IconColorsDefault size={11} />
        </button>
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
