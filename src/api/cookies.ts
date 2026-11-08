import type { CookieOptions, Response } from 'express';

/**
 * Flags for every authentication cookie.
 *
 * A clearing Set-Cookie has to repeat these flags. Chrome will not expire a
 * Secure cookie when the clearing header omits Secure, so logout and OAuth
 * cleanup must use the same options as the original Set-Cookie.
 */
export function authCookieOptions(path = '/', extra: CookieOptions = {}): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path,
    ...extra,
  };
}

export function clearAuthCookie(res: Response, name: string, path = '/'): void {
  res.clearCookie(name, authCookieOptions(path));
}
