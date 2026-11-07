// The drawn icon of a file's family (G34.4): the canvas's tabs tell a video from a sheet at a
// glance. No emoji, no symbol characters: the icons of icons.tsx.
import type { JSX } from "preact";
import {
  IconBraces,
  IconCode,
  IconCube,
  IconFile,
  IconFilePdf,
  IconFileText,
  IconFileZip,
  IconFilm,
  IconGlobe,
  IconGrid,
  IconImage,
  IconMusic,
  IconPenTool,
  IconPresentation,
  IconType,
} from "../../icons.js";
import { type TabIcon, tabIconFor } from "../../viewers/kind.js";

const ICONS: Record<TabIcon, (p: { size?: number }) => JSX.Element> = {
  video: IconFilm,
  audio: IconMusic,
  image: IconImage,
  pdf: IconFilePdf,
  document: IconFileText,
  sheet: IconGrid,
  slides: IconPresentation,
  model: IconCube,
  archive: IconFileZip,
  code: IconCode,
  font: IconType,
  data: IconBraces,
  design: IconPenTool,
  site: IconGlobe,
  file: IconFile,
};

export function FileIcon({ name, size = 13 }: { name: string; size?: number }) {
  const kind = tabIconFor(name);
  const I = ICONS[kind];
  return (
    <span class={`file-icon fi-${kind}`} data-kind={kind}>
      <I size={size} />
    </span>
  );
}
