// Videos and sounds (G34.2): the browser's own player, with the speed and the time in words. A
// format the browser cannot play says so plainly and offers an open copy it can play (G34.4:
// WebM or Opus, made beside the original), or the file itself.
import { useRef, useState } from "preact/hooks";
import { t } from "../../i18n.js";
import { IconAlert, IconDownload, IconMic, IconRefresh } from "../../icons.js";
import { playable } from "../../viewers/kind.js";
import { useOrders, useReport } from "../../viewers/live.js";
import { download, type ViewerProps } from "../../viewers/source.js";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/** 75 → "1:15", 3725 → "1:02:05". */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor(seconds / 60) % 60;
  const h = Math.floor(seconds / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

export function MediaView({ src, convert }: ViewerProps) {
  const video = src.kind === "video";
  const ref = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  const [failed, setFailed] = useState(
    () =>
      playable(src.format, (type) =>
        typeof document === "undefined"
          ? "maybe"
          : document.createElement(video ? "video" : "audio").canPlayType(type),
      ) === "no",
  );
  const [rate, setRate] = useState(1);
  const [time, setTime] = useState({ at: 0, total: 0 });
  const [size, setSize] = useState<string>();
  const seeking = useRef(false);
  const [loaded, setLoaded] = useState(false);
  // Where the person is (G36.12), and an agent's moves: a time, play, pause.
  const report = useReport();
  const tell = () => {
    const el = ref.current;
    if (el)
      report({
        time: el.currentTime,
        duration: Number.isFinite(el.duration) ? el.duration : undefined,
        playing: !el.paused,
      });
  };
  useOrders((d) => {
    const el = ref.current;
    if (!el || (d.time === undefined && d.play === undefined)) return false;
    if (d.time !== undefined) el.currentTime = d.time;
    if (d.play === true) void el.play()?.catch(() => {});
    if (d.play === false) el.pause();
    tell();
    return true;
  }, loaded && !failed);
  if (failed)
    return (
      <div class="vw-empty">
        <IconAlert size={28} />
        <strong>{t("vwMediaNo", { format: src.format.toUpperCase() || "?" })}</strong>
        <p class="dim">{t(convert ? "vwMediaConvertNow" : "vwMediaConvert")}</p>
        <div class="vw-row">
          {convert && (
            <button type="button" class="vw-btn primary" onClick={convert}>
              <IconRefresh size={16} />
              {t("vwConvertToSee")}
            </button>
          )}
          <button type="button" class="vw-btn" onClick={() => download(src.url, src.name)}>
            <IconDownload size={16} />
            {t("vwDownload")}
          </button>
        </div>
      </div>
    );
  const events = {
    ref,
    src: src.url,
    controls: true,
    preload: "metadata" as const,
    onError: () => setFailed(true),
    onLoadedMetadata: () => {
      const el = ref.current;
      if (!el) return;
      el.playbackRate = rate;
      // Files recorded by a browser often carry no duration: a seek to the end makes it known.
      if (el.duration === Number.POSITIVE_INFINITY) {
        seeking.current = true;
        el.currentTime = Number.MAX_SAFE_INTEGER;
      }
      setTime({ at: el.currentTime, total: el.duration });
      if (video && el.videoWidth) setSize(`${el.videoWidth} × ${el.videoHeight}`);
      setLoaded(true);
      tell();
    },
    onPlay: tell,
    onPause: tell,
    onTimeUpdate: () => {
      const el = ref.current;
      if (!el) return;
      if (seeking.current && Number.isFinite(el.duration)) {
        seeking.current = false;
        el.currentTime = 0;
      }
      setTime({ at: seeking.current ? 0 : el.currentTime, total: el.duration });
      tell();
    },
  };
  return (
    <div class={`vw-media ${video ? "vw-video" : "vw-audio"}`}>
      {video ? (
        <video {...events} playsInline />
      ) : (
        <div class="vw-audio-face">
          <span class="vw-audio-icon">
            <IconMic size={40} />
          </span>
          <strong title={src.name}>{src.name}</strong>
          <audio {...events} />
        </div>
      )}
      <div class="vw-bar">
        <span class="vw-time">
          {clock(time.at)}
          {Number.isFinite(time.total) && time.total > 0 && ` / ${clock(time.total)}`}
        </span>
        {size && <span class="dim">{size}</span>}
        <div class="spacer" />
        <span class="dim">{t("vwSpeed")}</span>
        <div class="vw-seg">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              class={s === rate ? "on" : ""}
              aria-pressed={s === rate}
              onClick={() => {
                setRate(s);
                if (ref.current) ref.current.playbackRate = s;
              }}
            >
              {String(s).replace(".", t("vwDecimal"))}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
