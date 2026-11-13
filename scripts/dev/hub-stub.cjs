// Claude (Anthropic) · 2026-11-13 — a stand-in for the TAKATAK hub (Supabase Auth), for checking the r2nette.ca
// sign-in in a real browser on one machine. Never used in production. It implements only the endpoints this
// site calls, and it enforces the password rule the real hub enforces (observed 2026-11-12), written here
// separately from src/shared/password-policy.ts so a mistake in one shows up as a failure against the other.
//
//   node scripts/dev/hub-stub.cjs            # listens on 127.0.0.1:3200 (PORT=… to change)
//
// No email is sent: any 6-digit code verifies, except 000000. "Google" comes straight back with a code for the
// address chosen with /__google?email=… (default google.client@example.test).
//
// Test helpers (not part of the hub): /__approve?email=&redirect_uri= (pretend the customer approved this site
// before), /__google?email=, /__users (who exists, whether a password is set, never the password), /__reset.
const http = require('node:http');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3200);
const authorizations = new Map(); // id -> { redirect_uri, state, approved }
const sessions = new Map(); // access token -> { id, email }
const users = new Map(); // email -> { id, password: string|null, google: boolean }
const approvedPairs = new Set(); // like the real hub: an earlier approval answers with redirect_url at once
let googleEmail = 'google.client@example.test';

const uid = (email) => 'stub-user-' + crypto.createHash('sha1').update(String(email).toLowerCase()).digest('hex').slice(0, 10);
const b32 = () => { const a = 'abcdefghijklmnopqrstuvwxyz234567'; let s = ''; for (let i = 0; i < 32; i++) s += a[crypto.randomInt(32)]; return s; };
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readText = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => resolve(d)); });
const readBody = async (req) => { try { const d = await readText(req); return d ? JSON.parse(d) : {}; } catch { return {}; } };

/** The hub's rule: 12+ characters; lower, upper, digit and one of these symbols; bcrypt reads 72 bytes at most. */
function weakness(password) {
  if (typeof password !== 'string') return 'not text';
  if ([...password].length < 12) return 'Password should be at least 12 characters.';
  if (Buffer.byteLength(password) > 72) return 'Password cannot be longer than 72 bytes.';
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password) || !/[!@#$%^&*()_+\-=\[\]{};':"\\|<>?,.\/`~]/.test(password)) {
    return 'Password should contain at least one character of each: abcdefghijklmnopqrstuvwxyz, ABCDEFGHIJKLMNOPQRSTUVWXYZ, 0123456789, !@#$%^&*()_+-=[]{};\':"|<>?,./`~.';
  }
  return null;
}

function userFor(email, patch = {}) {
  const key = String(email).toLowerCase();
  const user = users.get(key) || { id: uid(key), password: null, google: false };
  Object.assign(user, patch);
  users.set(key, user);
  return user;
}
function sessionFor(email, extra = {}) {
  const user = userFor(email);
  const token = 'at-' + crypto.randomUUID();
  sessions.set(token, { id: user.id, email: String(email).toLowerCase() });
  return { access_token: token, user: { id: user.id, email: String(email).toLowerCase(), email_confirmed_at: new Date().toISOString(), phone: null, ...extra } };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');

  if (p === '/__approve') { approvedPairs.add(uid(url.searchParams.get('email')) + '|' + url.searchParams.get('redirect_uri')); return json(res, 200, { ok: true }); }
  if (p === '/__google') { googleEmail = String(url.searchParams.get('email') || googleEmail).toLowerCase(); return json(res, 200, { googleEmail }); }
  if (p === '/__users') return json(res, 200, [...users].map(([email, u]) => ({ email, hasPassword: u.password !== null, google: u.google })));
  if (p === '/__reset') { users.clear(); sessions.clear(); authorizations.clear(); approvedPairs.clear(); return json(res, 200, { ok: true }); }

  if (p === '/auth/v1/.well-known/openid-configuration') return json(res, 404, {});

  if (p === '/auth/v1/otp') {
    const b = await readBody(req);
    userFor(b.email);
    console.log('[hub] otp for', b.email, 'redirect_to', url.searchParams.get('redirect_to'));
    return json(res, 200, {});
  }

  if (p === '/auth/v1/verify') {
    const b = await readBody(req);
    if (!/^\d{6}$/.test(String(b.token)) || String(b.token) === '000000') return json(res, 400, { error: 'otp_expired' });
    return json(res, 200, sessionFor(b.email));
  }

  if (p === '/auth/v1/authorize' && url.searchParams.get('provider') === 'google') {
    const back = new URL(url.searchParams.get('redirect_to'));
    back.searchParams.set('code', 'gcode'); // the real hub keeps its own state for Google: none of ours comes back
    res.writeHead(302, { location: back.toString() });
    return res.end();
  }

  if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
    userFor(googleEmail, { google: true });
    return json(res, 200, sessionFor(googleEmail, { identities: [{ provider: 'google' }] }));
  }

  if (p === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
    const b = await readBody(req);
    const user = users.get(String(b.email || '').toLowerCase());
    // One answer for an unknown address, a customer with no password, and a wrong password.
    if (!user || user.password === null || user.password !== b.password) return json(res, 400, { error: 'invalid_grant', error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
    return json(res, 200, sessionFor(b.email));
  }

  if (p === '/auth/v1/user' && req.method === 'PUT') {
    const s = sessions.get(bearer);
    if (!s) return json(res, 401, { error_code: 'bad_jwt' });
    const b = await readBody(req);
    const why = weakness(b.password);
    if (why) return json(res, 422, { error_code: 'weak_password', msg: why });
    const user = userFor(s.email);
    if (user.password === b.password) return json(res, 422, { error_code: 'same_password', msg: 'New password should be different from the old password.' });
    user.password = b.password;
    return json(res, 200, { id: user.id, email: s.email });
  }

  if (p === '/auth/v1/oauth/authorize') {
    const id = b32();
    authorizations.set(id, { redirect_uri: url.searchParams.get('redirect_uri'), state: url.searchParams.get('state'), approved: false });
    res.writeHead(302, { location: `https://takatak.ca/oauth/consent?authorization_id=${id}` });
    return res.end();
  }

  const m = p.match(/^\/auth\/v1\/oauth\/authorizations\/([a-z2-7]{32})(\/consent)?$/);
  if (m) {
    const a = authorizations.get(m[1]);
    const s = sessions.get(bearer);
    if (!a || !s) return json(res, 404, {});
    if (!m[2] && approvedPairs.has(s.id + '|' + a.redirect_uri)) {
      const back = new URL(a.redirect_uri);
      back.searchParams.set('code', 'code-' + m[1]);
      back.searchParams.set('state', a.state);
      a.email = s.email;
      return json(res, 200, { redirect_url: back.toString() });
    }
    if (!m[2]) return json(res, 200, { authorization_id: m[1], client: { name: 'R2NETTE' }, redirect_uri: a.redirect_uri, scope: 'openid email profile phone', user: { id: s.id, email: s.email } });
    const b = await readBody(req);
    const back = new URL(a.redirect_uri);
    if (b.action === 'approve') { back.searchParams.set('code', 'code-' + m[1]); a.email = s.email; approvedPairs.add(s.id + '|' + a.redirect_uri); }
    else back.searchParams.set('error', 'access_denied');
    back.searchParams.set('state', a.state);
    return json(res, 200, { redirect_url: back.toString() });
  }

  if (p === '/auth/v1/oauth/token') {
    const form = Object.fromEntries(new URLSearchParams(await readText(req)));
    const a = authorizations.get(String(form.code).replace('code-', ''));
    if (!a) return json(res, 400, {});
    const t = 'oauth-' + crypto.randomUUID();
    sessions.set(t, { id: uid(a.email), email: a.email });
    return json(res, 200, { access_token: t });
  }
  if (p === '/auth/v1/oauth/userinfo') {
    const s = sessions.get(bearer);
    if (!s) return json(res, 401, {});
    return json(res, 200, { sub: s.id, email: s.email, email_verified: true, name: 'Test Client' });
  }
  if (p === '/auth/v1/logout') { res.writeHead(204); return res.end(); }

  console.log('[hub] unhandled', req.method, p);
  json(res, 404, {});
}).listen(PORT, '127.0.0.1', () => console.log(`hub stand-in on ${PORT}`));
