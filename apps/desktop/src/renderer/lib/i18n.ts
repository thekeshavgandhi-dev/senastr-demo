/**
 * Lightweight i18n layer (parity: pi-desktop's `en` + `zh-CN` catalogues).
 *
 * Strings are keyed, not extracted per component: `t("sidebar.newTask")`
 * falls back to English when a locale is missing a key, so a partially
 * translated language still renders a complete UI.
 */

export const LOCALES = [
  { id: "en", label: "English" },
  { id: "zh-CN", label: "简体中文" },
] as const;

export type LocaleId = (typeof LOCALES)[number]["id"];

type Catalogue = Record<string, string>;

const en: Catalogue = {
  "app.name": "senastr",
  "nav.chat": "Chat",
  "nav.settings": "Settings",
  "sidebar.newTask": "New task",
  "sidebar.search": "Search",
  "sidebar.projects": "Projects",
  "sidebar.sessions": "Sessions",
  "sidebar.pinned": "Pinned",
  "sidebar.archived": "Archived",
  "sidebar.noSessions": "No sessions yet",
  "sidebar.openProject": "Open project…",
  "sidebar.fork": "Fork",
  "sidebar.rename": "Rename",
  "sidebar.delete": "Delete",
  "sidebar.pin": "Pin",
  "sidebar.archive": "Archive",
  "sidebar.groupByProject": "Group by project",
  "topbar.build": "Agent",
  "topbar.plan": "Plan",
  "topbar.goal": "Goal",
  "topbar.thinking": "Reasoning",
  "topbar.permissions": "Permissions",
  "composer.placeholder": "Ask senastr to change something… (/ for commands, @ for files)",
  "composer.queueHint": "Type to queue the next prompt…",
  "composer.send": "Send",
  "composer.stop": "Stop",
  "composer.attach": "Attach files",
  "composer.attachImage": "Attach images",
  "composer.enhance": "Improve prompt",
  "composer.model": "Model",
  "palette.title": "Command palette",
  "palette.placeholder": "Type a command…",
  "palette.noResults": "No matching commands",
  "settings.general": "General",
  "settings.appearance": "Appearance",
  "settings.language": "Language",
  "settings.network": "Network",
  "settings.proxy": "Proxy",
  "settings.usage": "Usage",
  "settings.projects": "Projects",
  "settings.import": "Import",
  "settings.updates": "Updates",
  "settings.about": "About",
  "usage.title": "Token usage",
  "usage.today": "Tokens today",
  "usage.month": "Last 30 days",
  "usage.turns": "Turns",
  "usage.empty": "No completed turns recorded yet",
  "import.title": "Import sessions",
  "import.subtitle": "Bring sessions over from Claude Code, Codex, OpenCode or Pi",
  "import.scan": "Scan for sessions",
  "import.none": "Nothing to import",
  "import.run": "Import selected",
  "updates.check": "Check for updates",
  "updates.current": "Current version",
  "updates.available": "Update available",
  "updates.download": "Download",
  "updates.install": "Restart and install",
  "updates.idle": "Up to date",
  "updates.unsupported": "This build cannot self-update",
  "common.cancel": "Cancel",
  "common.save": "Save",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.add": "Add",
  "common.retry": "Retry",
};

const zhCN: Catalogue = {
  "app.name": "senastr",
  "nav.chat": "对话",
  "nav.settings": "设置",
  "sidebar.newTask": "新建任务",
  "sidebar.search": "搜索",
  "sidebar.projects": "项目",
  "sidebar.sessions": "会话",
  "sidebar.pinned": "已固定",
  "sidebar.archived": "已归档",
  "sidebar.noSessions": "还没有会话",
  "sidebar.openProject": "打开项目…",
  "sidebar.fork": "分叉",
  "sidebar.rename": "重命名",
  "sidebar.delete": "删除",
  "sidebar.pin": "固定",
  "sidebar.archive": "归档",
  "sidebar.groupByProject": "按项目分组",
  "topbar.build": "代理",
  "topbar.plan": "计划",
  "topbar.goal": "目标",
  "topbar.thinking": "推理等级",
  "topbar.permissions": "权限",
  "composer.placeholder": "让 senastr 做点什么…（/ 命令，@ 文件）",
  "composer.queueHint": "输入内容以排队下一条提示…",
  "composer.send": "发送",
  "composer.stop": "停止",
  "composer.attach": "添加文件",
  "composer.attachImage": "添加图片",
  "composer.enhance": "润色提示",
  "composer.model": "模型",
  "palette.title": "命令面板",
  "palette.placeholder": "输入命令…",
  "palette.noResults": "没有匹配的命令",
  "settings.general": "通用",
  "settings.appearance": "外观",
  "settings.language": "语言",
  "settings.network": "网络",
  "settings.proxy": "代理",
  "settings.usage": "用量",
  "settings.projects": "项目",
  "settings.import": "导入",
  "settings.updates": "更新",
  "settings.about": "关于",
  "usage.title": "Token 用量",
  "usage.today": "今日 Token",
  "usage.month": "最近 30 天",
  "usage.turns": "轮次",
  "usage.empty": "还没有记录完成的轮次",
  "import.title": "导入会话",
  "import.subtitle": "从 Claude Code、Codex、OpenCode 或 Pi 导入会话",
  "import.scan": "扫描会话",
  "import.none": "没有可导入的内容",
  "import.run": "导入所选",
  "updates.check": "检查更新",
  "updates.current": "当前版本",
  "updates.available": "有可用更新",
  "updates.download": "下载",
  "updates.install": "重启并安装",
  "updates.idle": "已是最新",
  "updates.unsupported": "此版本无法自动更新",
  "common.cancel": "取消",
  "common.save": "保存",
  "common.close": "关闭",
  "common.delete": "删除",
  "common.add": "添加",
  "common.retry": "重试",
};

const CATALOGUES: Record<string, Catalogue> = { en, "zh-CN": zhCN };

export function isLocale(value: unknown): value is LocaleId {
  return typeof value === "string" && LOCALES.some((locale) => locale.id === value);
}

/** Translate a key for a locale, falling back to English then the key itself. */
export function translate(locale: string, key: string, vars?: Record<string, string | number>): string {
  const catalogue = CATALOGUES[isLocale(locale) ? locale : "en"] ?? en;
  const raw = catalogue[key] ?? en[key] ?? key;
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (_match, name: string) =>
    vars[name] !== undefined ? String(vars[name]) : `{${name}}`,
  );
}

/** Bound translator for a locale. */
export function translator(locale: string): (key: string, vars?: Record<string, string | number>) => string {
  return (key, vars) => translate(locale, key, vars);
}
