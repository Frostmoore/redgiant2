// Pictures (G34.2): fitted to the panel or at their real size, zoomed with the buttons or the
// wheel, on a checkered ground that shows the transparent parts. An SVG is shown as a picture
// (an <img> never runs its scripts), so a drawing from anywhere is safe to look at.
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconMinus, IconPlus } from "../../icons.js";
import { useOrders, useReport } from "../../viewers/live.js";
import { download, type ViewerProps } from "../../viewers/source.js";

type Ground = "check" | "light" | "dark";
const GROUNDS: Ground[] = ["check", "light", "dark"];

/** The next zoom step up or down (25% … 800%). */
export function zoomStep(scale: number, up: boolean): number {
  const steps = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
  return up
    ? (steps.find((s) => s > scale + 1e-6) ?? 8)
    : ([...steps].reverse().find((s) => s < scale - 1e-6) ?? 0.1);
}

export function ImageView({ src }: ViewerProps) {
  // null: fitted to the panel.
  const [scale, setScale] = useState<number | null>(null);
  const [ground, setGround] = useState<Ground>("check");
  const [natural, setNatural] = useState<{ w: number; h: number }>();
  const [failed, setFailed] = useState(false);
  const shown = scale ?? 1;
  // The zoom is part of where the person is (G36.12); an agent may zoom.
  const report = useReport();
  useEffect(() => report({ zoom: scale === null ? undefined : Math.round(scale * 100) }), [scale]);
  useOrders((d) => {
    if (d.zoom === undefined) return false;
    setScale(d.zoom === "fit" ? null : d.zoom / 100);
    return true;
  });
  return (
    <div class="vw-image">
      <div class="vw-bar">
        <div class="vw-seg">
          <button
            type="button"
            class={scale === null ? "on" : ""}
            aria-pressed={scale === null}
            onClick={() => setScale(null)}
          >
            {t("vwFit")}
          </button>
          <button
            type="button"
            class={scale === 1 ? "on" : ""}
            aria-pressed={scale === 1}
            onClick={() => setScale(1)}
          >
            100%
          </button>
        </div>
        <div class="vw-seg">
          <button
            type="button"
            title={t("vwZoomOut")}
            aria-label={t("vwZoomOut")}
            onClick={() => setScale(zoomStep(shown, false))}
          >
            <IconMinus size={14} />
          </button>
          <span class="vw-seg-label">
            {scale === null ? t("vwFit") : `${Math.round(shown * 100)}%`}
          </span>
          <button
            type="button"
            title={t("vwZoomIn")}
            aria-label={t("vwZoomIn")}
            onClick={() => setScale(zoomStep(shown, true))}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <div class="spacer" />
        {natural && (
          <span class="dim">
            {natural.w} × {natural.h}
          </span>
        )}
        <div class="vw-seg">
          {GROUNDS.map((g) => (
            <button
              key={g}
              type="button"
              class={`vw-ground-pick vw-ground-${g} ${g === ground ? "on" : ""}`}
              aria-pressed={g === ground}
              title={t(`vwGround_${g}`)}
              aria-label={t(`vwGround_${g}`)}
              onClick={() => setGround(g)}
            />
          ))}
        </div>
      </div>
      <div
        class={`vw-stage vw-ground-${ground} ${scale === null ? "fit" : ""}`}
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setScale(zoomStep(shown, e.deltaY < 0));
        }}
      >
        {failed ? (
          <div class="vw-empty">
            <strong>{t("vwImageNo")}</strong>
            <button type="button" class="vw-btn" onClick={() => download(src.url, src.name)}>
              {t("vwDownload")}
            </button>
          </div>
        ) : (
          <img
            src={src.url}
            alt={src.name}
            draggable={false}
            onLoad={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              setNatural({ w: img.naturalWidth, h: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
            style={
              scale === null || !natural
                ? undefined
                : { width: `${natural.w * scale}px`, height: `${natural.h * scale}px` }
            }
          />
        )}
      </div>
    </div>
  );
}
