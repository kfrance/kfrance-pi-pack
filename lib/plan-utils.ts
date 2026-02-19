/**
 * Shared plan output directory resolution utilities.
 *
 * Used by both plan.ts and code.ts extensions to resolve the plan output
 * directory via the same precedence chain:
 *   1. Explicit flag value (if provided)
 *   2. plan.outputDir in .pi/settings.json
 *   3. .plan/ (default)
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_OUTPUT_DIR = ".plan";

/**
 * Read plan.outputDir from .pi/settings.json if it exists.
 */
export function readOutputDirFromSettings(cwd: string): string | null {
  const settingsPath = path.join(cwd, ".pi", "settings.json");
  try {
    const content = fs.readFileSync(settingsPath, "utf-8");
    const settings = JSON.parse(content);
    const outputDir = settings?.plan?.outputDir;
    return typeof outputDir === "string" && outputDir.trim() ? outputDir.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the output directory using the precedence chain:
 *   1. flagValue (from parsed args, if provided)
 *   2. plan.outputDir in .pi/settings.json
 *   3. .plan/ (default)
 */
export function resolveOutputDir(flagValue: string | null, cwd: string): string {
  if (flagValue) return flagValue;
  const fromSettings = readOutputDirFromSettings(cwd);
  if (fromSettings) return fromSettings;
  return DEFAULT_OUTPUT_DIR;
}
