/**
 * A same-site path taken from an address someone asked for (`?returnTo=…`), or null.
 *
 * Comparing origins is not enough: `https://r2nette.ca//evil.example` has this site's origin but the path
 * `//evil.example`, and a browser told to go to `//evil.example` leaves for that other site. The same goes for
 * `/\evil.example`. Only a path that starts with a single `/` is returned.
 */
export function sameSitePath(requested: string, origin: string): string | null {
  try {
    const target = new URL(requested, origin);
    if (target.origin !== new URL(origin).origin) return null;
    const path = target.pathname + target.search + target.hash;
    if (/^\/[\/\\]/.test(path)) return null;
    return path;
  } catch {
    return null;
  }
}
