import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseCcSwitchRow, publicCcSwitch } from "../src/ccswitch-parse.ts";
import type { CcSwitchEntry } from "../src/ccswitch-parse.ts";

export interface PublicCcSwitch {
  providers: Array<ReturnType<typeof publicCcSwitch>>;
  detail: string;
}

export function readCcSwitch(): PublicCcSwitch {
  const file = databasePath();
  if (!file) return { providers: [], detail: "这台电脑还没有 CC Switch 数据库。" };
  try {
    const providers = loadRows(file).map(publicCcSwitch);
    const usable = providers.filter((item) => item.canImport).length;
    return { providers, detail: usable ? `读到 ${providers.length} 个提供方，其中 ${usable} 个可以直接导入。` : `读到 ${providers.length} 个提供方，还没有可导入的密钥。` };
  } catch (error) {
    const message = error instanceof Error ? error.message : "读取失败";
    return { providers: [], detail: `没有打开本机 CC Switch 数据库：${message}` };
  }
}

export function takeCcSwitch(key: string): CcSwitchEntry | null {
  const file = databasePath();
  if (!file) return null;
  return loadRows(file).find((item) => item.key === key) ?? null;
}

function loadRows(file: string): CcSwitchEntry[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, app_type, name, icon, icon_color, website_url, is_current, settings_config
      FROM providers
      ORDER BY is_current DESC, name
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => parseCcSwitchRow({
      id: text(row.id),
      app: text(row.app_type),
      name: text(row.name),
      icon: text(row.icon).startsWith("data:") ? "" : text(row.icon),
      iconColor: text(row.icon_color),
      website: text(row.website_url),
      current: Boolean(row.is_current),
      settings: text(row.settings_config),
    })).sort((left, right) => Number(right.current) - Number(left.current) || Number(right.canImport) - Number(left.canImport));
  } finally {
    db.close();
  }
}

function databasePath(): string {
  const home = process.env.USERPROFILE || os.homedir();
  const file = path.join(home, ".cc-switch", "cc-switch.db");
  return fs.existsSync(file) ? file : "";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}
