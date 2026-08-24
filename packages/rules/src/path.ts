/**
 * Lexical path normalisation, applied to every path a rule matches against.
 *
 * A path that arrives in a watched folder, an archive entry, a WebDAV listing or a mail attachment
 * name is hostile until it has been normalised. This module is not the place that decides whether a
 * path is inside its root — that belongs to the storage layer, which has the root — but a rule
 * engine that matched globs against the raw string would be its own hole: `photos/**` would match
 * `photos/../../etc/shadow`, and a rule that files a document by directory would file it by a lie.
 * So the subject path is normalised first, the rule sees the normalised form, and the trace reports
 * both, along with the fact that a path climbed above its own start.
 *
 * The normalisation is purely lexical. It never touches the filesystem, so it never follows a
 * symlink and never depends on what exists.
 */

export interface NormalisedPath {
  /** The normalised path: forward slashes, no `.` or `..` segments, no repeated separators. */
  readonly path: string;
  readonly absolute: boolean;
  /** True when a `..` segment climbed above the start of the path — the shape of a traversal. */
  readonly escaped: boolean;
  /** True when normalisation changed the string, which is worth showing in a trace. */
  readonly changed: boolean;
}

/**
 * Normalise a path for matching.
 *
 * Backslashes are treated as separators. A POSIX filename may legally contain one, so this is a
 * choice rather than a law: paths reach the rule engine from zip entries, SMB shares and scanner
 * firmware, and reading `a\..\..\etc` as three segments is the reading that cannot be exploited.
 */
export const normalisePath = (raw: string): NormalisedPath => {
  const unified = raw.replace(/\\/gu, '/');
  const absolute = unified.startsWith('/');
  const segments = unified.split('/');
  const out: string[] = [];
  let escaped = false;

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (absolute) {
        escaped = true; // `/..` is `/` on POSIX, but the intent was to climb out
      } else {
        escaped = true;
        out.push('..');
      }
      continue;
    }
    out.push(segment);
  }

  const joined = out.join('/');
  const path = absolute ? `/${joined}` : joined;
  return { path, absolute, escaped, changed: path !== raw };
};

/** The last segment of a normalised path, which is what a `filename` condition matches. */
export const basename = (path: string): string => {
  const normalised = normalisePath(path).path;
  const index = normalised.lastIndexOf('/');
  return index === -1 ? normalised : normalised.slice(index + 1);
};
