// The picture editor's options bar (p3.5.7): what the tool in use can be set to, as Photoshop's
// bar on top (selection modes, feather and anti-alias, tolerance, brush size, hardness, opacity
// and flow, gradient kind, crop and free transform's Apply and Cancel…), one row of a fixed
// height so the picture never jumps when the tool changes. Our own controls only.
import { DEFAULT_TEXT, TEXT_FONTS } from "@redgiant/protocol";
import type { ComponentChildren } from "preact";
import { useRef } from "preact/hooks";
import { t } from "../../i18n.js";
import {
  IconSelMode,
  IconTextAlign,
  IconTextBold,
  IconTextItalic,
  IconTransform,
} from "../../icons.js";
import type { Brush, Rect } from "../../viewers/image-island.js";
import type { ImageTool, ToolOptions } from "../../viewers/image-tools.js";
import { SmallSwitch } from "../ui.js";

/** The Text tool's options (p3.5.8): a new text's look, or the look of the text being typed. */
export interface TextOptions {
  /** A family of `TEXT_FONTS` (the fonts the page and the server both draw with). */
  font: string;
  size: number;
  align: "left" | "center" | "right";
  bold: boolean;
  italic: boolean;
  /** Times the size. */
  lineHeight: number;
}

export const DEFAULT_TEXT_OPTIONS: TextOptions = {
  font: DEFAULT_TEXT.font,
  size: DEFAULT_TEXT.size,
  align: DEFAULT_TEXT.align,
  bold: false,
  italic: false,
  lineHeight: DEFAULT_TEXT.lineHeight,
};

/** A button that stays pressed while on (bold, italic). */
function Press({
  label,
  on,
  onChange,
  children,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      class={`vw-icon ${on ? "on" : ""}`}
      aria-pressed={on}
      title={label}
      aria-label={label}
      // The text being typed keeps its caret.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!on)}
    >
      {children}
    </button>
  );
}

/** The text's colour: a swatch that opens the colour chooser. */
function TextColor({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <span class="img-text-color">
      <button
        type="button"
        class="img-color-swatch inline"
        style={{ background: value.slice(0, 7) }}
        title={`${t("imgTextColor")} ${value.slice(0, 7)}`}
        aria-label={t("imgTextColor")}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => input.current?.click()}
      />
      <input
        ref={input}
        type="color"
        class="img-color-input"
        tabIndex={-1}
        aria-hidden="true"
        value={value.slice(0, 7)}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
    </span>
  );
}

function Range({
  label,
  value,
  min,
  max,
  step = 1,
  shown,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  shown?: string;
  onChange: (n: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onInput={(e) => onChange(Number((e.target as HTMLInputElement).value))}
      />
      <span class="dim img-val">{shown ?? String(value)}</span>
    </label>
  );
}

function Num({
  label,
  short,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  /** Shown instead of the label (which stays the field's name). */
  short?: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
}) {
  return (
    <label title={short ? label : undefined}>
      <span>{short ?? label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        aria-label={label}
        onChange={(e) => {
          const n = Number((e.target as HTMLInputElement).value);
          if (Number.isFinite(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
      />
    </label>
  );
}

/** Choices drawn as a row of buttons (one pressed). */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; icon?: ComponentChildren }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset class="img-seg" aria-label={label}>
      {options.map((o) => (
        <button
          type="button"
          key={o.id}
          class={`vw-icon ${o.icon ? "" : "text"} ${value === o.id ? "on" : ""}`}
          aria-pressed={value === o.id}
          title={o.label}
          aria-label={o.label}
          onClick={() => onChange(o.id)}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </fieldset>
  );
}

export function ImageOptions({
  tool,
  opts,
  setOpts,
  brush,
  setBrush,
  text,
  setText,
  textColor = "#000000",
  setTextColor = () => {},
  typing = false,
  sel,
  hasMask,
  onMask,
  setOnMask,
  crop,
  transforming,
  act,
}: {
  tool: ImageTool;
  opts: ToolOptions;
  setOpts: (o: Partial<ToolOptions>) => void;
  brush: Brush;
  setBrush: (b: Partial<Brush>) => void;
  text: TextOptions;
  setText: (o: TextOptions) => void;
  /** The colour of the text being typed, else the foreground. */
  textColor?: string;
  setTextColor?: (hex: string) => void;
  /** The person is typing on the picture: the changes go to the whole text. */
  typing?: boolean;
  sel: Rect | undefined;
  hasMask: boolean;
  onMask: boolean;
  setOnMask: (on: boolean) => void;
  crop: Rect | undefined;
  transforming: boolean;
  act: (what: "apply" | "cancel" | "cropFromSel" | "transform") => void;
}) {
  const hint = (k: Parameters<typeof t>[0]) => <span class="dim img-hint">{t(k)}</span>;
  if (transforming)
    return (
      <>
        <button type="button" class="vw-btn small primary" onClick={() => act("apply")}>
          {t("imgApply")}
        </button>
        <button type="button" class="vw-btn small" onClick={() => act("cancel")}>
          {t("imgCancel")}
        </button>
        {hint("imgXformHint")}
      </>
    );
  const selModes = (
    <Segmented
      label={t("imgSelMode_new")}
      value={opts.selMode}
      options={(["new", "add", "subtract", "intersect"] as const).map((m) => ({
        id: m,
        label: t(`imgSelMode_${m}`),
        icon: <IconSelMode size={16} mode={m} />,
      }))}
      onChange={(selMode) => setOpts({ selMode })}
    />
  );
  const size = (
    <Range
      label={t("imgSize")}
      value={brush.size}
      min={1}
      max={500}
      shown={`${brush.size} px`}
      onChange={(n) => setBrush({ size: n })}
    />
  );
  const opacity = (
    <Range
      label={t("imgOpacity")}
      value={brush.opacity}
      min={0.01}
      max={1}
      step={0.01}
      shown={`${Math.round(brush.opacity * 100)}%`}
      onChange={(n) => setBrush({ opacity: n })}
    />
  );
  const hardness = (
    <Range
      label={t("imgHardness")}
      value={brush.hardness}
      min={0}
      max={1}
      step={0.05}
      shown={`${Math.round(brush.hardness * 100)}%`}
      onChange={(n) => setBrush({ hardness: n })}
    />
  );
  const flow = (
    <Range
      label={t("imgFlow")}
      value={brush.flow}
      min={0.01}
      max={1}
      step={0.01}
      shown={`${Math.round(brush.flow * 100)}%`}
      onChange={(n) => setBrush({ flow: n })}
    />
  );
  const tolerance = (
    <Num
      label={t("imgTolerance")}
      value={opts.tolerance}
      min={0}
      max={255}
      onChange={(n) => setOpts({ tolerance: n })}
    />
  );
  const sampleAll = (
    <SmallSwitch
      label={t("imgSampleAll")}
      on={opts.sampleAll}
      onChange={(on) => setOpts({ sampleAll: on })}
    />
  );
  const antialias = (
    <SmallSwitch
      label={t("imgAntialias")}
      on={opts.antialias}
      onChange={(on) => setOpts({ antialias: on })}
    />
  );
  const maskSwitch = hasMask && (
    <SmallSwitch label={t("imgOnMask")} on={onMask} onChange={setOnMask} />
  );
  switch (tool) {
    case "move":
      return (
        <>
          <SmallSwitch
            label={t("imgAutoSelect")}
            on={opts.autoSelect}
            onChange={(on) => setOpts({ autoSelect: on })}
          />
          <button
            type="button"
            class="vw-btn small"
            title={t("imgXform")}
            onClick={() => act("transform")}
          >
            <IconTransform size={14} />
            <span>{t("imgXform")}</span>
          </button>
          {hint(sel ? "imgMoveSelHint" : "imgMoveHint")}
        </>
      );
    case "marquee-rect":
    case "marquee-ellipse":
    case "lasso":
    case "lasso-poly":
    case "lasso-magnetic":
      return (
        <>
          {selModes}
          <Num
            label={t("imgFeather")}
            value={opts.feather}
            min={0}
            max={250}
            onChange={(n) => setOpts({ feather: n })}
          />
          {tool !== "marquee-rect" && antialias}
          {hint(
            tool === "lasso-poly"
              ? "imgPolyHint"
              : tool === "lasso-magnetic"
                ? "imgMagneticHint"
                : "imgSelectHint",
          )}
        </>
      );
    case "quick-select":
      return (
        <>
          <Range
            label={t("imgSize")}
            value={opts.quickSize}
            min={1}
            max={300}
            shown={`${opts.quickSize} px`}
            onChange={(n) => setOpts({ quickSize: n })}
          />
          {tolerance}
          {sampleAll}
          {hint("imgQuickHint")}
        </>
      );
    case "wand":
      return (
        <>
          {selModes}
          {tolerance}
          {antialias}
          <SmallSwitch
            label={t("imgContiguous")}
            on={opts.contiguous}
            onChange={(on) => setOpts({ contiguous: on })}
          />
          {sampleAll}
          {hint("imgWandHint")}
        </>
      );
    case "crop":
      return (
        <>
          <button
            type="button"
            class="vw-btn small"
            disabled={!sel}
            onClick={() => act("cropFromSel")}
          >
            {t("imgCropFromSel")}
          </button>
          <button
            type="button"
            class="vw-btn small primary"
            disabled={!crop}
            onClick={() => act("apply")}
          >
            {t("imgApply")}
          </button>
          <button type="button" class="vw-btn small" disabled={!crop} onClick={() => act("cancel")}>
            {t("imgCancel")}
          </button>
          {crop && <span class="dim img-val">{`${crop.w} × ${crop.h}`}</span>}
          {hint("imgCropHint")}
        </>
      );
    case "eyedropper":
      return (
        <>
          {sampleAll}
          <span class="dim img-hint">
            {t("imgPickHint")} <span class="img-swatch" style={{ background: brush.color }} />{" "}
            {brush.color}
          </span>
        </>
      );
    case "brush":
    case "pencil":
    case "eraser":
      return (
        <>
          {size}
          {tool !== "pencil" && hardness}
          {opacity}
          {tool !== "pencil" && flow}
          {maskSwitch}
          {hint("imgBrushHint")}
        </>
      );
    case "clone":
      return (
        <>
          {size}
          {hardness}
          {opacity}
          {flow}
          <SmallSwitch
            label={t("imgCloneAligned")}
            on={opts.cloneAligned}
            onChange={(on) => setOpts({ cloneAligned: on })}
          />
          {sampleAll}
          {hint("imgCloneHint")}
        </>
      );
    case "gradient":
      return (
        <>
          <Segmented
            label={t("imgTool_gradient")}
            value={opts.gradient}
            options={[
              { id: "linear", label: t("imgGradLinear") },
              { id: "radial", label: t("imgGradRadial") },
            ]}
            onChange={(gradient) => setOpts({ gradient })}
          />
          <SmallSwitch
            label={t("imgGradTransparent")}
            on={opts.gradientTransparent}
            onChange={(on) => setOpts({ gradientTransparent: on })}
          />
          <SmallSwitch
            label={t("imgGradReverse")}
            on={opts.gradientReverse}
            onChange={(on) => setOpts({ gradientReverse: on })}
          />
          {opacity}
          {hint("imgGradientHint")}
        </>
      );
    case "bucket":
      return (
        <>
          {opacity}
          {tolerance}
          <SmallSwitch
            label={t("imgContiguous")}
            on={opts.contiguous}
            onChange={(on) => setOpts({ contiguous: on })}
          />
          {sampleAll}
          {hint("imgBucketHint")}
        </>
      );
    case "text":
      return (
        <>
          <Segmented
            label={t("imgTextFont")}
            value={text.font}
            options={TEXT_FONTS.map((f) => ({ id: f.id as string, label: f.name }))}
            onChange={(font) => setText({ ...text, font })}
          />
          <Num
            label={t("imgTextSize")}
            short={t("imgTextSizeShort")}
            value={text.size}
            min={1}
            max={2000}
            onChange={(n) => setText({ ...text, size: n })}
          />
          <Num
            label={t("imgTextLeading")}
            value={Math.round(text.lineHeight * 100)}
            min={50}
            max={500}
            onChange={(n) => setText({ ...text, lineHeight: n / 100 })}
          />
          <Segmented
            label={t("imgTextAlign")}
            value={text.align}
            options={(["left", "center", "right"] as const).map((a) => ({
              id: a,
              label: t(`imgTextAlign_${a}`),
              icon: <IconTextAlign to={a} size={15} />,
            }))}
            onChange={(align) => setText({ ...text, align })}
          />
          <span class="img-seg">
            <Press
              label={t("imgBold")}
              on={text.bold}
              onChange={(on) => setText({ ...text, bold: on })}
            >
              <IconTextBold size={15} />
            </Press>
            <Press
              label={t("imgItalic")}
              on={text.italic}
              onChange={(on) => setText({ ...text, italic: on })}
            >
              <IconTextItalic size={15} />
            </Press>
          </span>
          <TextColor value={textColor} onChange={setTextColor} />
          {hint(typing ? "imgTextTyping" : "imgTextHint")}
        </>
      );
    case "shape-rect":
    case "shape-ellipse":
    case "shape-line":
      return (
        <>
          {tool !== "shape-line" && (
            <SmallSwitch
              label={t("imgShapeFill")}
              on={opts.shapeFill}
              onChange={(on) => setOpts({ shapeFill: on })}
            />
          )}
          {(tool === "shape-line" || !opts.shapeFill) && (
            <Num
              label={t("imgShapeStroke")}
              value={opts.shapeStroke}
              min={1}
              max={200}
              onChange={(n) => setOpts({ shapeStroke: n })}
            />
          )}
          {hint("imgShapeHint")}
        </>
      );
    case "hand":
      return hint("imgHandHint");
    case "zoom":
      return hint("imgZoomHint");
  }
}
