import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

// Preserve SQLite for standalone use; PostgreSQL provides shared durable state
// for serverless instances. The app owns a dedicated database schema.
export async function openDatabase(database, connectionString) {
  if (!connectionString) return new DatabaseSync(database);
  const url = new URL(connectionString);
  url.searchParams.delete('sslmode');
  const pool = new pg.Pool({ connectionString: url.href, max: 3,
    ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000, allowExitOnIdle: true,
    options: '-c search_path=sportstech_webhooks,public' });
  pg.types.setTypeParser(20, value => Number(value));
  const translate = sql => {
    let position = 0;
    return sql.replace(/PRAGMA[^;]+;/g, '')
      .replace(/\browid\b/g, 'sequence')
      .replace('id TEXT PRIMARY KEY, hook_id', 'sequence BIGSERIAL UNIQUE, id TEXT PRIMARY KEY, hook_id')
      .replace(/\?/g, () => `$${++position}`);
  };
  return {
    async exec(sql) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(725431001)');
        await client.query('CREATE SCHEMA IF NOT EXISTS sportstech_webhooks');
        await client.query(translate(sql));
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
    prepare(sql) {
      const run = values => pool.query(translate(sql), values);
      return {
        async run(...values) { const result = await run(values); return { changes: result.rowCount }; },
        async get(...values) { return (await run(values)).rows[0]; },
        async all(...values) { return (await run(values)).rows; }
      };
    },
    async close() { await pool.end(); }
  };
}
