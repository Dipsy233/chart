import { check, checkEqual, finish, section } from "./harness.ts";
import {
  PackInvalidError,
  PackStore,
  assertPackName,
  parsePack,
  serializePack,
  type PackIO,
} from "../src/store/packStore.ts";
import type { RulePack } from "../src/regimen/rule.ts";
import { DEFAULT_PACK } from "../src/regimen/defaults.ts";

/** An in-memory store, so the tests do not touch the filesystem. */
function memoryIO(initial: Record<string, string> = {}): PackIO & { files: Record<string, string> } {
  const files: Record<string, string> = { ...initial };
  let active: string | undefined;
  return {
    files,
    async list() {
      return Object.keys(files);
    },
    async read(name) {
      const text = files[name];
      if (text === undefined) throw Object.assign(new Error(`ENOENT: ${name}`), { code: "ENOENT" });
      return text;
    },
    async write(name, text) {
      files[name] = text;
    },
    async remove(name) {
      delete files[name];
    },
    async readActive() {
      return active;
    },
    async writeActive(name) {
      active = name;
    },
  };
}

function packOf(rules: RulePack["rules"], name = "test"): RulePack {
  return { version: 1, name, rules };
}

section("store: names");

check("a slug is accepted", (assertPackName("work-2024"), true));
check("a path traversal is rejected", throws(() => assertPackName("../etc/passwd")));
check("an empty name is rejected", throws(() => assertPackName("")));
check("`active` is reserved", throws(() => assertPackName("active")));

section("store: save and load");

{
  const io = memoryIO();
  const store = new PackStore(io);
  const issues = await store.save("work", DEFAULT_PACK);
  check("a valid pack saves", issues.length === 0);
  check("the file is on disk", "work" in io.files);
  check("the file ends with a newline", io.files["work"]!.endsWith("\n"));

  const loaded = await store.load("work");
  checkEqual("the round trip is faithful", loaded.rules.length, DEFAULT_PACK.rules.length);
  check("the name survives", loaded.name === DEFAULT_PACK.name);

  const list = await store.list();
  checkEqual("the list has it", list.map((summary) => summary.name), ["work"]);
  check("not active yet", list[0]?.active === false);
  check("the summary counts rules", list[0]?.rules === DEFAULT_PACK.rules.length);
  check("the summary counts phases", (list[0]?.live ?? 0) > 0 && (list[0]?.settled ?? 0) > 0);
  check("the summary is valid", list[0]?.issues.length === 0);
}

section("store: invalid packs are refused");

{
  const io = memoryIO();
  const store = new PackStore(io);
  const broken = packOf([
    {
      id: "bad",
      when: { conditions: [{ field: "facts.commands.failed", op: "zzz" as never, value: 1 }] },
      emit: { level: "high", title: "x" },
    },
  ]);
  let error: unknown;
  try {
    await store.save("broken", broken);
  } catch (caught) {
    error = caught;
  }
  check("saving an invalid pack throws", error instanceof PackInvalidError);
  check("nothing was written", !("broken" in io.files));
  check("the error lists the problem path", (error as PackInvalidError).issues[0]?.path.endsWith(".op") === true);

  const issues = await store.save("broken", broken, { force: true });
  check("force writes it anyway", "broken" in io.files);
  check("and still reports the issues", issues.length === 1);
  const list = await store.list();
  check("the list shows it as invalid", (list[0]?.issues.length ?? 0) > 0);
}

{
  const io = memoryIO({ corrupt: "{ not json" });
  const store = new PackStore(io);
  const list = await store.list();
  check("a corrupt pack is listed, not hidden", list.length === 1);
  check("with the parse error", list[0]?.issues[0]?.message.includes("JSON") === true);
}

section("store: activate");

{
  const io = memoryIO();
  const store = new PackStore(io);
  await store.save("a", packOf([], "a"));
  await store.save("b", packOf([], "b"));
  await store.activate("a");
  checkEqual("the pointer moved", await store.activeName(), "a");
  checkEqual("load() follows the pointer", (await store.load()).name, "a");
  checkEqual("load(name) overrides it", (await store.load("b")).name, "b");

  await store.activate("b");
  const list = await store.list();
  check("exactly one pack is active", list.filter((summary) => summary.active).length === 1);
  check("and it is the right one", list.find((summary) => summary.active)?.name === "b");

  await store.deactivate();
  checkEqual("deactivate clears the pointer", await store.activeName(), undefined);
  checkEqual("load() falls back to the defaults", (await store.load()).name, DEFAULT_PACK.name);
}

{
  const io = memoryIO();
  const store = new PackStore(io);
  const broken = packOf([
    { id: "bad", when: { conditions: [{ field: "a", op: "zzz" as never, value: 1 }] }, emit: { level: "low", title: "x" } },
  ]);
  await store.save("broken", broken, { force: true });
  check("activating an invalid pack is refused", await throwsAsync(() => store.activate("broken")));
  check("the pointer did not move", (await store.activeName()) === undefined);
}

section("store: create and delete");

{
  const io = memoryIO();
  const store = new PackStore(io);
  const created = await store.create("mine");
  check("create copies the defaults", created.rules.length === DEFAULT_PACK.rules.length);
  check("and names the pack", created.name === "mine");
  checkEqual("and activates it", await store.activeName(), "mine");

  await store.remove("mine");
  check("remove deletes the file", !("mine" in io.files));
  checkEqual("and clears the pointer", await store.activeName(), undefined);
}

{
  // Mutating a loaded pack must not corrupt the shared default.
  const io = memoryIO();
  const store = new PackStore(io);
  const loaded = await store.load();
  loaded.rules.length = 1;
  check("load returns a copy, not the default object", DEFAULT_PACK.rules.length > 1);
}

section("store: serialization");

{
  const text = serializePack(DEFAULT_PACK);
  check("2-space JSON", text.includes('\n  "version": 1'));
  checkEqual("a round trip is stable", serializePack(parsePack(text)), text);
  check("parse rejects a non-object", throws(() => parsePack("[]")));
  check("parse rejects a missing version", throws(() => parsePack('{"rules":[]}')));
  check("parse rejects a missing rules array", throws(() => parsePack('{"version":1}')));
  check("parse rejects bad JSON", throws(() => parsePack("{")));
}

section("store: a broken pointer");

{
  const io = memoryIO();
  const store = new PackStore(io);
  await store.save("a", packOf([], "a"));
  await io.writeActive("ghost");
  check("activating a missing pack throws", await throwsAsync(() => store.activate("ghost")));
  check("loading a dangling active pack throws rather than guessing", await throwsAsync(() => store.load(undefined)));
  checkEqual("an explicit name still works", (await store.load("a")).name, "a");
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

async function throwsAsync(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch {
    return true;
  }
}

finish();
