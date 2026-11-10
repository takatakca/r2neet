// Codex — assistant OpenAI · 2026-10-29
const allowed: Record<string, string[]> = {
  facebook: ['www.facebook.com', 'facebook.com'], instagram: ['www.instagram.com', 'instagram.com'],
  twitter: ['x.com', 'twitter.com', 'www.twitter.com'], pinterest: ['www.pinterest.com', 'pinterest.com', 'ca.pinterest.com'],
  youtube: ['www.youtube.com', 'youtube.com'],
};
export function publicProfiles(raw: string | undefined): { platform: string; url: string }[] {
  const profiles: Record<string, unknown> = { facebook: 'https://www.facebook.com/r2nette', instagram: 'https://www.instagram.com/r2nette.ca/' };
  try { Object.assign(profiles, JSON.parse(raw || '{}')); } catch { /* Invalid optional config never fabricates a link. */ }
  return Object.entries(profiles).flatMap(([platform, value]) => {
    if (typeof value !== 'string' || !allowed[platform]) return [];
    try { const url = new URL(value); return url.protocol === 'https:' && allowed[platform].includes(url.hostname) && !url.username && !url.password ? [{ platform, url: url.href }] : []; } catch { return []; }
  });
}
