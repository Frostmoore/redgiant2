// OpenRaster (G34.4): the open copy of a PSD (or a GIMP/Krita export) with its layers. Each layer
// is a PNG in the ZIP; they are stacked here as pictures in the order of stack.xml (the first is
// on top), with their place, opacity and blending, and each can be switched off and on. Groups
// pass their visibility and opacity to what they hold.
import { useEffect, useMemo, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconEye, IconLayers } from "../../icons.js";
import { unzip } from "../../viewers/office.js";
import { bytesText, useBytes, type ViewerProps } from "../../viewers/source.js";

export interface OraLayer {
  /** Its place in the stack, from the bottom (0). */
  index: number;
  name: string;
  src: string;
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  /** CSS mix-blend-mode, from the svg:* composite operation. */
  blend: string;
  /** How deep in groups it is (0: at the top level). */
  depth: number;
}

export interface OraImage {
  width: number;
  height: number;
  /** Bottom first, as they are drawn. */
  layers: OraLayer[];
}

const BLENDS = new Set([
  "multiply",
  "screen",
  "overlay",
  "darken",
  "lighten",
  "color-dodge",
  "color-burn",
  "hard-light",
  "soft-light",
  "difference",
  "exclusion",
  "hue",
  "saturation",
  "color",
  "luminosity",
]);

const num = (v: string | null, d: number) => {
  const n = v === null ? Number.NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

/** The layers of an OpenRaster stack.xml (pure). */
export function parseStack(xml: string): OraImage {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const image = doc.querySelector("image");
  const top: OraLayer[] = [];
  const walk = (el: Element, depth: number, opacity: number, visible: boolean) => {
    for (const c of [...el.children]) {
      const o = opacity * num(c.getAttribute("opacity"), 1);
      const v = visible && c.getAttribute("visibility") !== "hidden";
      if (c.tagName === "stack") walk(c, depth + 1, o, v);
      else if (c.tagName === "layer" && c.getAttribute("src")) {
        const op = (c.getAttribute("composite-op") ?? "").replace(/^svg:/, "");
        top.push({
          index: 0,
          name: c.getAttribute("name") ?? "",
          src: c.getAttribute("src") ?? "",
          x: num(c.getAttribute("x"), 0),
          y: num(c.getAttribute("y"), 0),
          opacity: o,
          visible: v,
          blend: BLENDS.has(op) ? op : "normal",
          depth,
        });
      }
    }
  };
  const root = image?.querySelector(":scope > stack");
  if (root) walk(root, 0, 1, true);
  const layers = top.reverse().map((l, index) => ({ ...l, index }));
  return {
    width: num(image?.getAttribute("w") ?? null, 0),
    height: num(image?.getAttribute("h") ?? null, 0),
    layers,
  };
}

interface Opened extends OraImage {
  urls: Record<string, string>;
  merged?: string;
}

export function OraView({ src }: ViewerProps) {
  const { value: bytes, error } = useBytes(src.url);
  const opened = useMemo<Opened | { error: string } | undefined>(() => {
    if (!bytes) return undefined;
    try {
      const files = unzip(bytes);
      const stack = files["stack.xml"];
      if (!stack) return { error: t("vwOraBroken") };
      const image = parseStack(new TextDecoder().decode(stack));
      const urls: Record<string, string> = {};
      for (const l of image.layers) {
        const b = files[l.src];
        if (b && !urls[l.src])
          urls[l.src] = URL.createObjectURL(new Blob([b as BlobPart], { type: "image/png" }));
      }
      const m = files["mergedimage.png"];
      return {
        ...image,
        urls,
        ...(m && { merged: URL.createObjectURL(new Blob([m as BlobPart], { type: "image/png" })) }),
      };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [bytes]);
  useEffect(
    () => () => {
      if (opened && "urls" in opened) {
        for (const u of Object.values(opened.urls)) URL.revokeObjectURL(u);
        if (opened.merged) URL.revokeObjectURL(opened.merged);
      }
    },
    [opened],
  );
  // The layers switched by hand, for this file only (a new file starts as it was saved).
  const [switched, setSwitched] = useState<{ of?: unknown; h: Record<number, boolean> }>({ h: {} });
  const hidden = switched.of === opened ? switched.h : {};
  /** Each layer picture's own width in pixels, once loaded (its share of the image's width). */
  const [wide, setWide] = useState<Record<string, number>>({});
  if (error || (opened && "error" in opened))
    return <div class="vw-empty">{error ?? (opened as { error: string }).error}</div>;
  if (!opened) return <div class="vw-empty dim">{t("loading")}</div>;
  const { width, height, layers, urls } = opened;
  const shown = (l: OraLayer) => (hidden[l.index] === undefined ? l.visible : !hidden[l.index]);
  const ratio = width > 0 && height > 0 ? `${width} / ${height}` : "1";
  return (
    <div class="vw-ora">
      <div class="vw-ora-stage">
        <div
          class="vw-ora-picture"
          style={{
            aspectRatio: ratio,
            width: height > 0 ? `min(100%, ${((width / height) * 62).toFixed(2)}vh)` : "100%",
          }}
        >
          {layers.length === 0 && opened.merged && <img src={opened.merged} alt="" />}
          {layers.map(
            (l) =>
              shown(l) &&
              urls[l.src] && (
                <img
                  key={l.index}
                  src={urls[l.src]}
                  alt=""
                  onLoad={(e) => {
                    const w = e.currentTarget.naturalWidth;
                    setWide((x) => (x[l.src] === w ? x : { ...x, [l.src]: w }));
                  }}
                  style={{
                    width: wide[l.src] ? `${((wide[l.src] ?? 0) / width) * 100}%` : "0",
                    visibility: wide[l.src] ? "visible" : "hidden",
                    left: `${(l.x / width) * 100}%`,
                    top: `${(l.y / height) * 100}%`,
                    opacity: l.opacity,
                    mixBlendMode: l.blend,
                  }}
                />
              ),
          )}
        </div>
      </div>
      <aside class="vw-ora-layers" aria-label={t("vwOraLayers")}>
        <div class="vw-ora-head">
          <IconLayers size={14} />
          <strong>{t("vwOraLayers")}</strong>
          <span class="dim">
            {width} × {height}
            {src.size !== undefined && ` · ${bytesText(src.size)}`}
          </span>
        </div>
        <ul>
          {[...layers].reverse().map((l) => (
            <li key={l.index} style={{ paddingLeft: `${8 + l.depth * 14}px` }}>
              <button
                type="button"
                class={`vw-ora-layer ${shown(l) ? "on" : "off"}`}
                aria-pressed={shown(l)}
                title={shown(l) ? t("vwOraHide") : t("vwOraShow")}
                onClick={() => setSwitched({ of: opened, h: { ...hidden, [l.index]: shown(l) } })}
              >
                <span class="vw-ora-eye">
                  <IconEye size={14} />
                </span>
                {urls[l.src] && <img src={urls[l.src]} alt="" />}
                <span class="vw-ora-name" title={l.name}>
                  {l.name || t("vwOraUnnamed")}
                </span>
                {l.blend !== "normal" && <span class="dim vw-ora-blend">{l.blend}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
