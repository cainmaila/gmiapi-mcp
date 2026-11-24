import { existsSync, readFileSync } from "node:fs";

export type Presets = Record<string, Record<string, unknown>>;

/** Load per-model default payload params from a JSON file ({ "<model>": { ...payload } }). */
export function loadPresets(file: string | undefined, log: (...a: unknown[]) => void): Presets {
  if (!file || !existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const out: Presets = {};
    for (const [k, v] of Object.entries(raw)) {
      if (k.startsWith("$")) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) out[k] = v as Record<string, unknown>;
    }
    return out;
  } catch (e) {
    log(`warning: could not read presets file ${file}: ${(e as Error).message}`);
    return {};
  }
}
