// Postgres when DATABASE_URL (or POSTGRES_URL from the Vercel Neon integration) is set.
// Embedded PGlite (Postgres compiled to WebAssembly) otherwise: zero setup locally and in CI,
// and a clearly labelled demo fallback on Vercel where /tmp is wiped on a cold start.
import pg from 'pg';

let impl;
export const dbUrl = () => process.env.DATABASE_URL || process.env.POSTGRES_URL || '';

export async function getDb() {
  if (impl) return impl;
  if (dbUrl()) {
    const pool = new pg.Pool({ connectionString: dbUrl(), max: Number(process.env.PG_POOL_MAX || 5), idleTimeoutMillis: 30000 });
    impl = {
      kind: 'postgres',
      durable: true,
      query: (s, p) => pool.query(s, p),
      exec: (s) => pool.query(s),
      tx: async (fn) => {
        const c = await pool.connect();
        try { await c.query('begin'); const r = await fn(c); await c.query('commit'); return r; }
        catch (e) { await c.query('rollback').catch(() => {}); throw e; }
        finally { c.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = process.env.PGLITE_DIR || (process.env.VERCEL ? '/tmp/pgdata' : './.pgdata');
    const db = new PGlite(dir);
    await db.waitReady;
    impl = {
      kind: 'pglite',
      durable: !process.env.VERCEL,
      query: (s, p) => db.query(s, p),
      exec: (s) => db.exec(s),
      tx: (fn) => db.transaction((t) => fn({ query: (s, p) => t.query(s, p), exec: (s) => t.exec(s) })),
      close: () => db.close(),
    };
  }
  return impl;
}
