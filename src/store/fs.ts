/**
 * The Node adapter for `PackStore`: one directory, one JSON file per pack, plus
 * an `active.json` pointer — the same layout Absence uses for egg-filters.
 *
 * Writes are atomic (temp file + rename) because a half-written pack is worse
 * than no pack: the next load would fail and the user would not know which edit
 * broke it.
 *
 * This module imports `node:fs`, so it is a *subpath* export (`chart/store/fs`),
 * never part of the main entry — a browser bundle must not pull it in.
 */

import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PackIO } from "./packStore.ts";

const ACTIVE = "active.json";

export interface FsPackOptions {
  /** The directory holding `*.json`. Created on first write. */
  dir: string;
}

export function fsPackIO(options: FsPackOptions): PackIO {
  const dir = options.dir;

  const file = (name: string) => join(dir, `${name}.json`);

  const ensureDir = async () => {
    await mkdir(dir, { recursive: true });
  };

  /** Write through a temp file in the same directory, then rename over. */
  const atomicWrite = async (path: string, text: string) => {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temp, text, "utf8");
    await rename(temp, path);
  };

  return {
    async list() {
      try {
        const entries = await readdir(dir);
        return entries
          .filter((entry) => entry.endsWith(".json") && entry !== ACTIVE)
          .map((entry) => entry.slice(0, -".json".length));
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },

    async read(name) {
      return readFile(file(name), "utf8");
    },

    async write(name, text) {
      await ensureDir();
      await atomicWrite(file(name), text);
    },

    async remove(name) {
      await rm(file(name), { force: true });
    },

    async readActive() {
      try {
        const text = await readFile(join(dir, ACTIVE), "utf8");
        const parsed = JSON.parse(text) as { active?: unknown };
        return typeof parsed.active === "string" && parsed.active.length > 0 ? parsed.active : undefined;
      } catch (error) {
        if (isMissing(error)) return undefined;
        // A corrupt pointer should not take the app down; fall back to defaults.
        return undefined;
      }
    },

    async writeActive(name) {
      await ensureDir();
      if (!name) {
        await rm(join(dir, ACTIVE), { force: true });
        return;
      }
      await atomicWrite(join(dir, ACTIVE), `${JSON.stringify({ active: name }, null, 2)}\n`);
    },
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}
