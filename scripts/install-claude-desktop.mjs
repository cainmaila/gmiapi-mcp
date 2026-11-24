#!/usr/bin/env node
// Register this MCP server in Claude Desktop's config (macOS / Windows / Linux).
// Uses the Node binary that runs this script, so nvm/fnm paths are handled.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const name = process.argv[2] || "gmi";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, "dist", "index.js");
if (!existsSync(entry)) {
  console.error(`找不到 ${entry}，請先執行 npm run build`);
  process.exit(1);
}

const home = os.homedir();
const dir =
  process.platform === "darwin"
    ? path.join(home, "Library", "Application Support", "Claude")
    : process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Claude")
      : path.join(home, ".config", "Claude");
const file = path.join(dir, "claude_desktop_config.json");

let config = {};
if (existsSync(file)) {
  const raw = readFileSync(file, "utf8");
  try {
    config = raw.trim() ? JSON.parse(raw) : {};
  } catch (e) {
    console.error(`${file} 不是合法 JSON，未做任何修改：${e.message}`);
    process.exit(1);
  }
  const backup = `${file}.bak-${Date.now()}`;
  copyFileSync(file, backup);
  console.log(`已備份原設定 → ${backup}`);
} else {
  mkdirSync(dir, { recursive: true });
}

config.mcpServers ??= {};
const existed = Boolean(config.mcpServers[name]);
config.mcpServers[name] = { command: process.execPath, args: [entry] };
writeFileSync(file, JSON.stringify(config, null, 2) + "\n");

console.log(`${existed ? "已更新" : "已新增"} MCP server "${name}" → ${file}`);
console.log(JSON.stringify({ [name]: config.mcpServers[name] }, null, 2));
console.log("請用 Cmd+Q 完全結束 Claude Desktop 後重新開啟。");
