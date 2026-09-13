import type { SVGProps } from "react";

export interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number;
}

function base({ size = 16, ...rest }: IconProps): SVGProps<SVGSVGElement> {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
    ...rest,
  };
}

const I = (path: React.ReactNode) =>
  function Icon(p: IconProps) {
    return <svg {...base(p)}>{path}</svg>;
  };

export const IconSidebar = I(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="9" y1="3" x2="9" y2="21" />
  </>,
);
export const IconPanel = I(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="15" y1="3" x2="15" y2="21" />
  </>,
);
export const IconSearch = I(
  <>
    <circle cx="11" cy="11" r="7" />
    <line x1="16.5" y1="16.5" x2="21" y2="21" />
  </>,
);
export const IconPlus = I(
  <>
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </>,
);
export const IconNewSession = I(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </>,
);
export const IconX = I(
  <>
    <line x1="6" y1="6" x2="18" y2="18" />
    <line x1="18" y1="6" x2="6" y2="18" />
  </>,
);
export const IconCheck = I(<polyline points="4 12.5 9.5 18 20 6.5" />);
export const IconChevronDown = I(<polyline points="6 9 12 15 18 9" />);
export const IconChevronRight = I(<polyline points="9 6 15 12 9 18" />);
export const IconChevronLeft = I(<polyline points="15 6 9 12 15 18" />);
export const IconSettings = I(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.64 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.05a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
  </>,
);
export const IconPin = I(
  <>
    <path d="M9 4h6l-1 7 3 3H7l3-3-1-7Z" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </>,
);
export const IconArchive = I(
  <>
    <rect x="3" y="4" width="18" height="4" rx="1" />
    <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" />
    <line x1="10" y1="12" x2="14" y2="12" />
  </>,
);
export const IconPencil = I(
  <>
    <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
  </>,
);
export const IconTrash = I(
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </>,
);
export const IconFolder = I(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </>,
);
export const IconFolderOpen = I(
  <>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2" />
    <path d="M3 7v9a2 2 0 0 0 2 2h16" />
  </>,
);
export const IconFile = I(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
    <polyline points="14 2 14 8 20 8" />
  </>,
);
export const IconDiff = I(
  <>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="12" y1="3" x2="12" y2="21" />
    <line x1="6" y1="9" x2="9" y2="9" />
    <line x1="6" y1="13" x2="9" y2="13" />
    <line x1="15" y1="9" x2="18" y2="9" />
    <line x1="15" y1="13" x2="18" y2="13" />
  </>,
);
export const IconBot = I(
  <>
    <rect x="5" y="10" width="14" height="10" rx="2" />
    <path d="M12 10V4" />
    <circle cx="12" cy="3" r="1" />
    <circle cx="9.5" cy="14.5" r="0.6" />
    <circle cx="14.5" cy="14.5" r="0.6" />
    <line x1="2" y1="14" x2="5" y2="14" />
    <line x1="19" y1="14" x2="22" y2="14" />
  </>,
);
export const IconSparkles = I(
  <>
    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z" />
  </>,
);
export const IconShield = I(
  <>
    <path d="M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5Z" />
    <polyline points="9 11.5 11.2 13.7 15.5 9.4" />
  </>,
);
export const IconTerminal = I(
  <>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <polyline points="7 9 10 12 7 15" />
    <line x1="12" y1="15" x2="17" y2="15" />
  </>,
);
export const IconMore = I(
  <>
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="12" cy="12" r="1.2" />
    <circle cx="19" cy="12" r="1.2" />
  </>,
);
export const IconSun = I(
  <>
    <circle cx="12" cy="12" r="4" />
    <line x1="12" y1="2" x2="12" y2="5" />
    <line x1="12" y1="19" x2="12" y2="22" />
    <line x1="2" y1="12" x2="5" y2="12" />
    <line x1="19" y1="12" x2="22" y2="12" />
    <line x1="4.9" y1="4.9" x2="7" y2="7" />
    <line x1="17" y1="17" x2="19.1" y2="19.1" />
    <line x1="4.9" y1="19.1" x2="7" y2="17" />
    <line x1="17" y1="7" x2="19.1" y2="4.9" />
  </>,
);
export const IconMoon = I(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />);
export const IconSend = I(
  <>
    <line x1="22" y1="2" x2="11" y2="13" />
    <polygon points="22 2 15 22 11 13 2 9 22 2" />
  </>,
);
export const IconStop = I(<rect x="6" y="6" width="12" height="12" rx="2" />);
export const IconCopy = I(
  <>
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </>,
);
export const IconPlug = I(
  <>
    <path d="M9 7V3" />
    <path d="M15 7V3" />
    <path d="M7 7h10v4a5 5 0 0 1-10 0Z" />
    <line x1="12" y1="16" x2="12" y2="21" />
  </>,
);
export const IconServer = I(
  <>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <line x1="7" y1="7.5" x2="7" y2="7.6" />
    <line x1="7" y1="16.5" x2="7" y2="16.6" />
  </>,
);
export const IconBook = I(
  <>
    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z" />
    <path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" />
  </>,
);
export const IconInfo = I(
  <>
    <circle cx="12" cy="12" r="9" />
    <line x1="12" y1="11" x2="12" y2="16" />
    <line x1="12" y1="8" x2="12" y2="8.1" />
  </>,
);
export const IconAlert = I(
  <>
    <path d="M12 3l10 17H2Z" />
    <line x1="12" y1="10" x2="12" y2="13.5" />
    <line x1="12" y1="17" x2="12" y2="17.1" />
  </>,
);
export const IconBranch = I(
  <>
    <circle cx="6" cy="5" r="2" />
    <circle cx="6" cy="19" r="2" />
    <circle cx="18" cy="9" r="2" />
    <path d="M6 7v10" />
    <path d="M18 11c0 4-6 3-9 5" />
  </>,
);
export const IconClock = I(
  <>
    <circle cx="12" cy="12" r="9" />
    <polyline points="12 7 12 12 15.5 14" />
  </>,
);
export const IconKeyboard = I(
  <>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <line x1="6" y1="10" x2="6" y2="10.1" />
    <line x1="10" y1="10" x2="10" y2="10.1" />
    <line x1="14" y1="10" x2="14" y2="10.1" />
    <line x1="18" y1="10" x2="18" y2="10.1" />
    <line x1="7" y1="14" x2="17" y2="14" />
  </>,
);
export const IconSliders = I(
  <>
    <line x1="4" y1="7" x2="20" y2="7" />
    <circle cx="9" cy="7" r="2.2" />
    <line x1="4" y1="17" x2="20" y2="17" />
    <circle cx="15" cy="17" r="2.2" />
  </>,
);
export const IconDownload = I(
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>,
);
export const IconUndo = I(
  <>
    <polyline points="9 14 4 9 9 4" />
    <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
  </>,
);
export const IconRefresh = I(
  <>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.5 15a9 9 0 1 1-2-9.4L23 10" />
  </>,
);
export const IconEye = I(
  <>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </>,
);
export const IconZap = I(<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />);
export const IconMessage = I(
  <>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
  </>,
);
export const IconExternal = I(
  <>
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
    <polyline points="15 3 21 3 21 9" />
    <line x1="10" y1="14" x2="21" y2="3" />
  </>,
);
export const IconStar = I(
  <polygon points="12 2 15.1 8.3 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 8.9 8.3 12 2" />,
);
export const IconFork = I(
  <>
    <circle cx="12" cy="18" r="2.5" />
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="6" r="2.5" />
    <path d="M12 15.5V11a3 3 0 0 0-3-3H6.5" />
    <path d="M12 15.5V11a3 3 0 0 1 3-3h2.5" />
  </>,
);
export const IconHelp = I(
  <>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.2 9a2.8 2.8 0 0 1 5.5.8c0 1.8-2.7 2.2-2.7 3.7" />
    <line x1="12" y1="17" x2="12" y2="17.1" />
  </>,
);
export const IconBell = I(
  <>
    <path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
    <path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </>,
);
export const IconUsers = I(
  <>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.9" />
    <path d="M16 3.1a4 4 0 0 1 0 7.8" />
  </>,
);
export const IconActivity = I(<polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />);
export const IconPlay = I(<polygon points="6 3 20 12 6 21 6 3" />);
export const IconHistory = I(
  <>
    <path d="M3 3v5h5" />
    <path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" />
    <polyline points="12 7 12 12 15.5 14" />
  </>,
);
