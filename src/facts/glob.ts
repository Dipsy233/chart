/**
 * Globs, compiled to whole-string RegExps — `fnmatch` semantics.
 *
 * `*` matches within a path segment, `**` across them, `?` one character,
 * `[abc]` / `[!abc]` a character class, and a backslash escapes the next
 * character. The same matcher serves file paths *and* arbitrary strings
 * (`payload.command`, `payload.tool`, a process name), which is why the
 * character class and the escape are here: a rule that says
 * `mcp__filesystem__*` or `npm [run] *` should not need a different operator
 * from a path glob.
 *
 * Chart is a library that gets embedded in a browser bundle, so a glob
 * dependency would be more weight than the whole matcher.
 *
 * A pattern without a `/` is also tried against the file *name*, which is what
 * a user means by `*.log`: every log, wherever it lives. A pattern that names a
 * folder (`build/**`) has to match the path.
 */

const MAX_GLOB = 512;

/** Compile one glob. Returns `undefined` when the pattern is unusable. */
export function compileGlob(glob: string): RegExp | undefined {
  const pattern = glob.trim();
  if (pattern.length === 0 || pattern.length > MAX_GLOB) return undefined;
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;

    if (char === "\\") {
      // An escape: the next character is literal.
      const next = pattern[i + 1];
      if (next === undefined) {
        out += escapeRegExp(char);
      } else {
        out += escapeRegExp(next);
        i += 1;
      }
      continue;
    }

    if (char === "[") {
      // A character class, fnmatch style: [abc], [a-z], [!abc], []].
      const close = findClassEnd(pattern, i);
      if (close === -1) {
        out += escapeRegExp(char);
        continue;
      }
      const body = pattern.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      const content = negated ? body.slice(1) : body;
      out += negated ? `[^${sanitizeClass(content)}]` : `[${sanitizeClass(content)}]`;
      i = close;
      continue;
    }

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` also matches nothing, so `**/dist` matches `dist` too.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      continue;
    }

    out += escapeRegExp(char);
  }
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return undefined;
  }
}

/** Whether a path matches a glob (path or bare file name). */
export function matchGlob(glob: string, path: string): boolean {
  const re = compileGlob(glob);
  if (!re) return false;
  const normalised = path.replace(/\\/g, "/");
  if (re.test(normalised)) return true;
  const name = normalised.slice(normalised.lastIndexOf("/") + 1);
  return !glob.includes("/") && re.test(name);
}

/** Whether any of `globs` matches `path`. An empty list matches nothing. */
export function matchAnyGlob(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => matchGlob(glob, path));
}

/** The index of the `]` closing a class that starts at `open`, or -1. */
function findClassEnd(pattern: string, open: number): number {
  let index = open + 1;
  // A `]` in the first position is a literal member, not the terminator.
  if (pattern[index] === "!" || pattern[index] === "^") index += 1;
  if (pattern[index] === "]") index += 1;
  for (; index < pattern.length; index++) {
    if (pattern[index] === "]") return index;
  }
  return -1;
}

/** Keep a class body literal enough for RegExp, without dropping ranges. */
function sanitizeClass(body: string): string {
  return body
    .replace(/\\/g, "\\\\")
    .replace(/\^/g, "\\^")
    .replace(/]/g, "\\]");
}

function escapeRegExp(char: string): string {
  // `*` and `?` are RegExp quantifiers too, and the escape path can hand them
  // to this function when the user wrote `\*` to mean a literal star.
  return char.replace(/[.+^${}()|[\]\\*?]/g, "\\$&");
}
