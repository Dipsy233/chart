/**
 * Globs, compiled to whole-string RegExps.
 *
 * Tiny on purpose: `*` matches within a path segment, `**` across them, `?` one
 * character. Chart is a library that will be embedded in a browser bundle, so a
 * glob dependency would be more weight than the whole matcher.
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
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
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
