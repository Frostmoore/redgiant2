// Fonts (G34.2): TTF, OTF, WOFF and WOFF2 loaded by the browser itself (FontFace), shown with a
// sentence the person can change, at several sizes, and the alphabet.
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { useBytes, type ViewerProps } from "../../viewers/source.js";

const SIZES = [12, 16, 24, 36, 48, 72];
let made = 0;

export function FontView({ src }: ViewerProps) {
  const { value, error } = useBytes(src.url);
  const [family, setFamily] = useState<string>();
  const [failed, setFailed] = useState<string>();
  const [sample, setSample] = useState(() => t("vwFontSample"));
  useEffect(() => {
    if (!value) return;
    const name = `rg-view-font-${++made}`;
    const face = new FontFace(name, value.slice().buffer as ArrayBuffer);
    let live = true;
    void face.load().then(
      (f) => {
        if (!live) return;
        document.fonts.add(f);
        setFamily(name);
      },
      (e: unknown) => live && setFailed((e as Error).message),
    );
    return () => {
      live = false;
      document.fonts.delete(face);
    };
  }, [value]);
  if (error || failed) return <div class="vw-empty">{t("vwFontNo")}</div>;
  if (!family) return <div class="vw-empty dim">{t("loading")}</div>;
  const style = { fontFamily: `"${family}", system-ui` };
  return (
    <div class="vw-font">
      <div class="vw-bar">
        <input
          class="vw-font-input"
          type="text"
          value={sample}
          aria-label={t("vwFontTry")}
          placeholder={t("vwFontTry")}
          onInput={(e) => setSample(e.currentTarget.value)}
        />
      </div>
      <div class="vw-font-body">
        <p class="vw-font-big" style={style}>
          Aa Bb Cc
        </p>
        {SIZES.map((s) => (
          <div key={s} class="vw-font-row">
            <span class="dim">{s}px</span>
            <p style={{ ...style, fontSize: `${s}px` }}>{sample || t("vwFontSample")}</p>
          </div>
        ))}
        <p class="vw-font-abc" style={style}>
          ABCDEFGHIJKLMNOPQRSTUVWXYZ
          <br />
          abcdefghijklmnopqrstuvwxyz
          <br />
          0123456789 àèéìòù .,;:!?()&amp;@
        </p>
      </div>
    </div>
  );
}
