// The settings panel (ADR-0018): opened by /status, /config, /usage, /cost and /help. It
// rises from the bottom of the screen in place of the prompt box, has tabs to move between,
// and closes with Esc, leaving nothing behind in the conversation.
import { type Style, wrap } from "./text";

export const PANEL_TABS = ["Status", "Config", "Usage", "Help"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

// A setting on the Config tab. Enter or Space moves it to its next value.
export type ConfigItem = { label: string; value: string; hint?: string; change?: () => void };

export type PanelContent = {
  status: [string, string][];
  config: ConfigItem[];
  usage: string[];
  help: string[];
};

export function renderPanel(tab: PanelTab, selected: number, content: PanelContent, s: Style, cols: number): string[] {
  const rule = s.gray("─".repeat(Math.max(10, cols - 1)));
  const tabs = PANEL_TABS.map((t) => (t === tab ? s.inverse(` ${t} `) : s.dim(` ${t} `))).join(" ");
  const pairs = (rows: [string, string][]) => {
    const w = Math.max(0, ...rows.map(([k]) => k.length));
    return rows.map(([k, v]) => `  ${s.dim(k.padEnd(w))}  ${v}`);
  };
  let body: string[];
  let keys = "←/→ or Tab to switch · Esc to close";
  if (tab === "Status") body = pairs(content.status);
  else if (tab === "Usage") body = content.usage.map((l) => `  ${l}`);
  else if (tab === "Help") body = content.help.map((l) => `  ${l}`);
  else {
    const w = Math.max(0, ...content.config.map((c) => c.label.length));
    body = content.config.map((c, i) => {
      const mark = i === selected ? s.cyan("❯") : " ";
      const value = c.change ? s.bold(c.value) : c.value;
      return `${mark} ${c.label.padEnd(w)}  ${value}${c.hint ? `  ${s.dim(c.hint)}` : ""}`;
    });
    keys = `↑/↓ to select · Enter to change · ${keys}`;
  }
  const fitted = body.flatMap((l) => wrap(l, Math.max(10, cols - 1)));
  return [rule, ` ${s.bold("Settings")}  ${tabs}`, "", ...fitted, "", s.dim(`  ${keys}`)];
}
