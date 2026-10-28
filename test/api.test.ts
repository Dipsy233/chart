import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, checkEqual, finish, section } from "./harness.ts";
import { createApiServer } from "../scripts/api.ts";
import type { Server } from "node:http";
import type { RulePack } from "../src/regimen/rule.ts";

/**
 * The API is the seam an agent uses to edit rules, so it gets the same treatment
 * as the store: start it on a real (temp) directory, drive it over HTTP, and
 * assert the files it leaves behind.
 */

const dir = await mkdtemp(join(tmpdir(), "chart-api-"));
// A port nothing listens on: the Absence hop is checked against a fake in
// `absence.test.ts`, and this suite must not depend on a real Absence running.
const server: Server = createApiServer({ dir, absenceBase: "http://127.0.0.1:9" });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address ? address.port : 0;
const base = `http://127.0.0.1:${port}`;

interface Reply {
  status: number;
  body: unknown;
}

async function call(method: string, path: string, body?: unknown): Promise<Reply> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // keep the text
  }
  return { status: response.status, body: parsed };
}

const rule = (id: string, level: "low" | "medium" | "high" = "low", threshold = 1): RulePack["rules"][number] => ({
  id,
  name: id,
  when: { conditions: [{ field: "facts.commands.failed", op: "gte", value: threshold }] },
  emit: { level, title: `${id} fired` },
});

try {
  section("api: health and catalog");

  {
    const health = await call("GET", "/api/health");
    check("health is 200", health.status === 200);
    check("health says ok", (health.body as { ok?: boolean }).ok === true);
    check(
      "health lists the endpoints",
      Array.isArray((health.body as { endpoints?: unknown[] }).endpoints),
    );

    const catalog = await call("GET", "/api/catalog");
    const fields = (catalog.body as { fields?: unknown[] }).fields ?? [];
    check("the catalog is 200", catalog.status === 200);
    check("the catalog has fields", fields.length > 30);
    check(
      "the catalog has window measures",
      Array.isArray((catalog.body as { windowMeasures?: unknown[] }).windowMeasures),
    );
    check("the catalog has operators", Array.isArray((catalog.body as { operators?: unknown[] }).operators));
  }

  section("api: packs");

  {
    const empty = await call("GET", "/api/packs");
    checkEqual("no packs yet", empty.body, []);

    const created = await call("PUT", "/api/packs/work", {
      version: 1,
      name: "work",
      rules: [rule("a"), rule("b", "high", 2), rule("c")],
    });
    check("PUT creates a pack", created.status === 200);
    checkEqual(
      "the response returns the pack",
      (created.body as { pack: RulePack }).pack.rules.map((candidate) => candidate.id),
      ["a", "b", "c"],
    );
    check("no issues on a valid pack", ((created.body as { issues: unknown[] }).issues ?? []).length === 0);

    const listed = await call("GET", "/api/packs");
    const summaries = listed.body as Array<{ name: string; rules: number; issues: unknown[] }>;
    checkEqual("the pack is listed", summaries.map((summary) => summary.name), ["work"]);
    checkEqual("with its rule count", summaries[0]?.rules, 3);
    check("and it is valid", (summaries[0]?.issues ?? []).length === 0);

    const loaded = await call("GET", "/api/packs/work");
    checkEqual("the pack reads back", (loaded.body as RulePack).rules.length, 3);
  }

  section("api: validation");

  {
    const invalid = await call("PUT", "/api/packs/broken", {
      version: 1,
      rules: [
        {
          id: "x",
          when: { conditions: [{ field: "facts.commands.failed", op: "nope", value: 1 }] },
          emit: { level: "high", title: "t" },
        },
      ],
    });
    check("an invalid pack is refused", invalid.status === 422);
    const issues = (invalid.body as { issues?: unknown[] }).issues ?? [];
    check("with its issues", issues.length > 0);

    const missing = await call("GET", "/api/packs/broken");
    check("and it was not written", missing.status === 404);

    const forced = await call("PUT", "/api/packs/broken?force=1", {
      version: 1,
      rules: [
        {
          id: "x",
          when: { conditions: [{ field: "facts.commands.failed", op: "nope", value: 1 }] },
          emit: { level: "high", title: "t" },
        },
      ],
    });
    check("force writes it anyway", forced.status === 200);
    check("and reports the issues", (((forced.body as { issues?: unknown[] }).issues ?? []).length) > 0);
    await call("DELETE", "/api/packs/broken");
  }

  section("api: rules");

  {
    const added = await call("POST", "/api/packs/work/rules", rule("d"));
    check("POST adds a rule", added.status === 200);
    checkEqual(
      "at the end",
      (added.body as { pack: RulePack }).pack.rules.map((candidate) => candidate.id),
      ["a", "b", "c", "d"],
    );

    const patched = await call("PATCH", "/api/packs/work/rules/a", {
      description: "what it is for",
      emit: { tags: ["run", "failure"] },
    });
    check("PATCH merges", patched.status === 200);
    const merged = (patched.body as { rule: RulePack["rules"][number] }).rule;
    checkEqual("the description lands", merged.description, "what it is for");
    checkEqual("the tags land", merged.emit.tags, ["run", "failure"]);
    checkEqual("and the title is untouched", merged.emit.title, "a fired");

    const moved = await call("POST", "/api/packs/work/rules/d/move", { index: 0 });
    check("move is a 200", moved.status === 200);
    checkEqual(
      "the rule is first",
      (moved.body as { pack: RulePack }).pack.rules.map((candidate) => candidate.id),
      ["d", "a", "b", "c"],
    );

    const replaced = await call("PUT", "/api/packs/work/rules/b", rule("b", "medium", 9));
    check("PUT replaces", replaced.status === 200);
    const b = (replaced.body as { rule: RulePack["rules"][number] }).rule;
    checkEqual("with the new level", b.emit.level, "medium");

    const mismatch = await call("PUT", "/api/packs/work/rules/a", rule("other"));
    check("a mismatched id is refused", mismatch.status === 400);

    const removed = await call("DELETE", "/api/packs/work/rules/c");
    check("DELETE removes", removed.status === 200);
    checkEqual(
      "the rule is gone",
      (removed.body as { pack: RulePack }).pack.rules.map((candidate) => candidate.id),
      ["d", "a", "b"],
    );

    const notFound = await call("DELETE", "/api/packs/work/rules/nope");
    check("a missing rule is 404", notFound.status === 404);
  }

  section("api: active pointer");

  {
    const activated = await call("POST", "/api/packs/work/activate");
    check("activate is 200", activated.status === 200);
    const active = await call("GET", "/api/active");
    checkEqual("the pointer moved", (active.body as { active: string }).active, "work");

    await call("DELETE", "/api/active");
    const cleared = await call("GET", "/api/active");
    checkEqual("and can be cleared", (cleared.body as { active: unknown }).active, null);

    const missing = await call("POST", "/api/packs/nope/activate");
    check("activating a missing pack is 404", missing.status === 404);
  }

  section("api: static files are optional");

  {
    const noStatic = await call("GET", "/");
    check("without --static the root is 404", noStatic.status === 404);
  }

  section("api: absence is unreachable when nothing is listening");

  {
    // The host answers `available: false` with a reason, not a 500: Absence not
    // running is the normal case for an editor opened on its own.
    const probe = await call("GET", "/api/absence/sessions");
    check("the probe answers 200", probe.status === 200);
    checkEqual("and says Absence is unavailable", (probe.body as { available: boolean }).available, false);
    check(
      "with a reason a person can act on",
      typeof (probe.body as { error?: unknown }).error === "string",
    );

    const snapshot = await call("GET", "/api/absence/sessions/sess_nope/snapshot");
    checkEqual("a snapshot of nothing is also unavailable", (snapshot.body as { available: boolean }).available, false);
  }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
}

finish();
