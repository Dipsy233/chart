/**
 * A `PackIO` over localStorage.
 *
 * The editor has no server, so packs live in the browser. The shape is the same
 * one `fsPackIO` implements — one JSON text per pack plus an active pointer — so
 * export/import is a straight copy and moving to a real backend later means
 * swapping this object, not rewriting the UI.
 */

import type { PackIO } from "../../../src/store/packStore.ts";

const PACKS_KEY = "chart:packs";
const ACTIVE_KEY = "chart:active";

function readPacks(): Record<string, string> {
  try {
    const raw = localStorage.getItem(PACKS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function writePacks(packs: Record<string, string>): void {
  localStorage.setItem(PACKS_KEY, JSON.stringify(packs));
}

export function localStoragePackIO(): PackIO {
  return {
    async list() {
      return Object.keys(readPacks());
    },
    async read(name) {
      const text = readPacks()[name];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
      return text;
    },
    async write(name, text) {
      const packs = readPacks();
      packs[name] = text;
      writePacks(packs);
    },
    async remove(name) {
      const packs = readPacks();
      delete packs[name];
      writePacks(packs);
    },
    async readActive() {
      const value = localStorage.getItem(ACTIVE_KEY);
      return value && value.length > 0 ? value : undefined;
    },
    async writeActive(name) {
      if (!name) localStorage.removeItem(ACTIVE_KEY);
      else localStorage.setItem(ACTIVE_KEY, name);
    },
  };
}

/** Download a pack as a file, so it can be dropped into `.chart/rules/`. */
export function downloadPack(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
