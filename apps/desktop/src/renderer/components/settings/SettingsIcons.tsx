import type { SVGProps } from "react";

export type SettingsIconName =
  | "arrow-left"
  | "search"
  | "sparkles"
  | "book"
  | "server"
  | "plug"
  | "shield"
  | "info"
  | "plus"
  | "edit"
  | "trash"
  | "test"
  | "refresh"
  | "terminal"
  | "globe"
  | "check"
  | "x"
  | "folder"
  | "key"
  | "chevron"
  | "sliders"
  | "keyboard"
  | "chart"
  | "download";

export function SettingsIcon({ name, size = 16, ...props }: { name: SettingsIconName; size?: number } & SVGProps<SVGSVGElement>) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    ...props,
  };
  switch (name) {
    case "arrow-left":
      return <svg {...common}><path d="m15 18-6-6 6-6" /></svg>;
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.3-3.3" /></svg>;
    case "sparkles":
      return <svg {...common}><path d="m12 3-1.2 3.8L7 8l3.8 1.2L12 13l1.2-3.8L17 8l-3.8-1.2L12 3Z" /><path d="m5 14-.7 2.3L2 17l2.3.7L5 20l.7-2.3L8 17l-2.3-.7L5 14Z" /><path d="m19 13-.6 1.9-1.9.6 1.9.6L19 18l.6-1.9 1.9-.6-1.9-.6L19 13Z" /></svg>;
    case "book":
      return <svg {...common}><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v17H6.5A2.5 2.5 0 0 0 4 22V5.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v17h4.5A2.5 2.5 0 0 1 20 22V5.5Z" /></svg>;
    case "server":
      return <svg {...common}><rect x="3" y="4" width="18" height="6" rx="2" /><rect x="3" y="14" width="18" height="6" rx="2" /><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7" /></svg>;
    case "plug":
      return <svg {...common}><path d="M8 12h8v2a4 4 0 0 1-4 4v3" /><path d="M9 3v5M15 3v5M7 8h10v4H7z" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case "info":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></svg>;
    case "plus":
      return <svg {...common}><path d="M12 5v14M5 12h14" /></svg>;
    case "edit":
      return <svg {...common}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4L16.5 3.5Z" /></svg>;
    case "trash":
      return <svg {...common}><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5" /></svg>;
    case "test":
      return <svg {...common}><path d="m8 5 11 7-11 7V5Z" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 11a8 8 0 0 0-14.9-4M4 4v5h5M4 13a8 8 0 0 0 14.9 4M20 20v-5h-5" /></svg>;
    case "terminal":
      return <svg {...common}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="m7 9 3 3-3 3M13 15h4" /></svg>;
    case "globe":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
    case "chart":
      return <svg {...common}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>;
    case "download":
      return <svg {...common}><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 20h16" /></svg>;
    case "check":
      return <svg {...common}><path d="m5 12 4 4L19 6" /></svg>;
    case "x":
      return <svg {...common}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    case "folder":
      return <svg {...common}><path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6Z" /></svg>;
    case "key":
      return <svg {...common}><circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l2 2M14 9l2 2" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
  }
}
