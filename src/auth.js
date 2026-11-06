// Sign-in, sessions and roles. Session tokens live only in an httpOnly cookie; the database keeps a SHA-256 of the token.
import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 }; // OWASP Password Storage Cheat Sheet, Argon2id minimum
export const SESSION_IDLE_MS = 60 * 60 * 1000;      // 1 hour idle
export const SESSION_ABSOLUTE_MS = 24 * 3600 * 1000; // 24 hours absolute
const LOCK_AFTER = 5;
const LOCK_MINUTES = 5;

export const hashPassword = (pw) => hash(pw, ARGON);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const cookieName = (secure) => (secure ? '__Host-hp_session' : 'hp_session');

export function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function login(q, username, password) {
  const u = (await q.query('select * from users where username=$1', [String(username || '').toLowerCase()])).rows[0];
  // Same work whether or not the account exists, so response time does not reveal valid usernames.
  const ok = u ? await verify(u.password_hash, String(password || '')).catch(() => false) : (await hashPassword('timing-equaliser'), false);
  if (u && u.locked_until && new Date(u.locked_until) > new Date()) return { error: 'Too many attempts. Wait a few minutes and try again.', status: 429 };
  if (!ok) {
    if (u) await q.query(`update users set failed_count=failed_count+1, locked_until=case when failed_count+1>=$2 then now()+interval '${LOCK_MINUTES} minutes' else locked_until end where username=$1`, [u.username, LOCK_AFTER]);
    return { error: 'That username and password do not match.', status: 401 };
  }
  await q.query('update users set failed_count=0, locked_until=null where username=$1', [u.username]);
  const token = crypto.randomBytes(32).toString('base64url');
  await q.query('insert into sessions (token_hash, username) values ($1,$2)', [sha(token), u.username]);
  return { token, user: { username: u.username, display_name: u.display_name, role: u.role } };
}

export async function sessionUser(q, token) {
  if (!token) return null;
  const s = (await q.query('select s.*, u.display_name, u.role from sessions s join users u using (username) where token_hash=$1', [sha(token)])).rows[0];
  if (!s) return null;
  const now = Date.now();
  if (now - new Date(s.created_at).getTime() > SESSION_ABSOLUTE_MS || now - new Date(s.last_seen_at).getTime() > SESSION_IDLE_MS) {
    await q.query('delete from sessions where token_hash=$1', [sha(token)]);
    return null;
  }
  await q.query('update sessions set last_seen_at=now() where token_hash=$1', [sha(token)]);
  return { username: s.username, display_name: s.display_name, role: s.role };
}

export const logout = (q, token) => (token ? q.query('delete from sessions where token_hash=$1', [sha(token)]) : null);

// Who may do what. Checked on the server for every write.
export const CAN = {
  approve: (user, ticket) => {
    if (ticket.flags.some((f) => f.code === 'SECURITY_INJECTION')) return user.role === 'admin';
    if (ticket.flags.some((f) => ['CREDIT_BLOCK', 'PRICE_DISPUTE'].includes(f.code))) return ['credit', 'admin'].includes(user.role);
    return true;
  },
  reset: (user) => user.role === 'admin',
};
