// Drawn icons: the interface uses no emoji and no symbol characters as icons (user's request,
// 2026-11-01). Stroke icons that follow the text colour; shapes in the style of Feather (MIT).
import type { ComponentChildren } from "preact";

type P = { size?: number };

function Svg({
  size = 18,
  children,
  fill = false,
}: {
  size?: number;
  children: ComponentChildren;
  fill?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"}
      stroke={fill ? "none" : "currentColor"}
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      class="icon"
    >
      {children}
    </svg>
  );
}

export const IconMenu = ({ size = 22 }: P) => (
  <Svg size={size}>
    <path d="M4 6h16M4 12h16M4 18h16" />
  </Svg>
);
export const IconSearch = ({ size = 19 }: P) => (
  <Svg size={size}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.3-4.3" />
  </Svg>
);
export const IconBell = ({ size = 19 }: P) => (
  <Svg size={size}>
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </Svg>
);
export const IconFolder = ({ size = 16 }: P) => (
  <Svg size={size}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </Svg>
);
export const IconFolderPlus = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    <path d="M12 11v6M9 14h6" />
  </Svg>
);
export const IconFile = ({ size = 16 }: P) => (
  <Svg size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </Svg>
);
export const IconFilePlus = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6M12 18v-6M9 15h6" />
  </Svg>
);
export const IconTerminal = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M4 17l6-6-6-6M12 19h8" />
  </Svg>
);
export const IconUpload = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
  </Svg>
);
export const IconDownload = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
  </Svg>
);
export const IconRefresh = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M23 4v6h-6M1 20v-6h6" />
    <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
  </Svg>
);
export const IconClose = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M18 6L6 18M6 6l12 12" />
  </Svg>
);
export const IconPlus = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);
export const IconChevron = ({ open, size = 14 }: P & { open: boolean }) => (
  <Svg size={size}>{open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 18l6-6-6-6" />}</Svg>
);
export const IconCheck = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M20 6L9 17l-5-5" />
  </Svg>
);
export const IconX = IconClose;
export const IconSpinner = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M21 12a9 9 0 1 1-6.2-8.6" />
  </Svg>
);
export const IconAlert = ({ size = 15 }: P) => (
  <Svg size={size}>
    <path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </Svg>
);
export const IconInfo = ({ size = 15 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 16v-4M12 8h.01" />
  </Svg>
);
export const IconSettings = ({ size = 14 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </Svg>
);
/** God: the crown over the platform. */
export const IconCrown = ({ size = 16 }: P) => (
  <Svg size={size}>
    <path d="M3 7l4 4 5-7 5 7 4-4-2 11H5z" />
    <path d="M5 21h14" />
  </Svg>
);
/** The daily chat. */
export const IconChat = ({ size = 16 }: P) => (
  <Svg size={size}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
/** A project's orchestrator and its tree of agents. */
export const IconTree = ({ size = 16 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="5" r="2" />
    <circle cx="5" cy="19" r="2" />
    <circle cx="19" cy="19" r="2" />
    <path d="M12 7v4M12 11H5v6M12 11h7v6" />
  </Svg>
);
export const IconBoard = ({ size = 14 }: P) => (
  <Svg size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9h10M7 13h6" />
  </Svg>
);
/** The read-only inspector: an eye. */
export const IconEye = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);
export const IconPin = ({ size = 13, filled = false }: P & { filled?: boolean }) => (
  <Svg size={size} fill={filled}>
    <path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4z" />
  </Svg>
);
export const IconArchive = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4" />
  </Svg>
);
export const IconTrash = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </Svg>
);
export const IconPencil = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
  </Svg>
);
export const IconPaperclip = ({ size = 17 }: P) => (
  <Svg size={size}>
    <path d="M21.4 11.1l-8.5 8.5a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" />
  </Svg>
);
export const IconMic = ({ size = 18 }: P) => (
  <Svg size={size}>
    <rect x="9" y="2" width="6" height="12" rx="3" />
    <path d="M19 10v1a7 7 0 0 1-14 0v-1M12 18v4M8 22h8" />
  </Svg>
);
export const IconSend = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4z" />
  </Svg>
);
export const IconStop = ({ size = 14 }: P) => (
  <Svg size={size} fill>
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Svg>
);
export const IconShield = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
  </Svg>
);
export const IconTool = ({ size = 13 }: P) => (
  <Svg size={size}>
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
  </Svg>
);
export const IconClock = ({ size = 14 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </Svg>
);
export const IconArrowDown = ({ size = 18 }: P) => (
  <Svg size={size}>
    <path d="M12 5v14M19 12l-7 7-7-7" />
  </Svg>
);
export const IconCopy = ({ size = 13 }: P) => (
  <Svg size={size}>
    <rect x="9" y="9" width="13" height="13" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Svg>
);
export const IconSun = ({ size = 15 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  </Svg>
);
export const IconMoon = ({ size = 15 }: P) => (
  <Svg size={size}>
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
  </Svg>
);
export const IconMonitor = ({ size = 15 }: P) => (
  <Svg size={size}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" />
  </Svg>
);
export const IconPhone = ({ size = 15 }: P) => (
  <Svg size={size}>
    <rect x="6" y="2" width="12" height="20" rx="2.5" />
    <path d="M11 18h2" />
  </Svg>
);
export const IconCard = ({ size = 15 }: P) => (
  <Svg size={size}>
    <rect x="2" y="5" width="20" height="14" rx="2" />
    <path d="M2 10h20M6 15h4" />
  </Svg>
);
export const IconLogout = ({ size = 15 }: P) => (
  <Svg size={size}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
  </Svg>
);
export const IconPlay = ({ size = 13 }: P) => (
  <Svg size={size} fill>
    <path d="M7 4l13 8-13 8z" />
  </Svg>
);
export const IconDollar = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </Svg>
);
export const IconSend2 = IconSend;
export const IconPuzzle = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M20 13h-1.5a2 2 0 1 0 0 4H20v3a1 1 0 0 1-1 1h-3v-1.5a2 2 0 1 0-4 0V21H9a1 1 0 0 1-1-1v-3H6.5a2 2 0 1 1 0-4H8v-3a1 1 0 0 1 1-1h3V7.5a2 2 0 1 1 4 0V9h3a1 1 0 0 1 1 1z" />
  </Svg>
);
export const IconTelegram = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M22 3L2 11l7 2 2 7 4-5 5 4z" />
    <path d="M9 13l13-10" />
  </Svg>
);
export const IconCpu = ({ size = 14 }: P) => (
  <Svg size={size}>
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
  </Svg>
);
export const IconCompass = ({ size = 14 }: P) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="10" />
    <path d="M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3z" />
  </Svg>
);
export const IconLayers = ({ size = 14 }: P) => (
  <Svg size={size}>
    <path d="M12 2L2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
  </Svg>
);

/** The RedGiant mark, drawn: a red giant star with its glow. */
export const Logo = ({ size = 22 }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" class="logo">
    <circle cx="12" cy="12" r="11" fill="var(--accent-soft)" />
    <circle cx="12" cy="12" r="7.5" fill="var(--accent)" />
    <circle cx="9.5" cy="9.5" r="2.4" fill="#fff" opacity=".35" />
  </svg>
);
