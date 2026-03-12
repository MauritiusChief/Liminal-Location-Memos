import pg from 'pg';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

function ensureDbConfig() {
  if (!config.db.enabled || !config.db.host || !config.db.port || !config.db.database || !config.db.user || !config.db.password) {
    throw new Error('PostgreSQL is not configured. Fill PG* or DB_* variables first.');
  }
}

export function getDbPool(): pg.Pool {
  ensureDbConfig();

  if (!pool) {
    pool = new Pool({
      host: config.db.host,
      port: config.db.port,
      database: config.db.database,
      user: config.db.user,
      password: config.db.password,
      ssl: config.db.sslMode && config.db.sslMode !== 'disable' ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return getDbPool().query<T>(text, params);
}

export async function withTransaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getDbPool().connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function checkDatabaseHealth(): Promise<
  | { enabled: false; ok: false; reason: string }
  | { enabled: true; ok: true; tableNames: string | null }
  | { enabled: true; ok: false; reason: string }
> {
  if (!config.db.enabled) {
    return {
      enabled: false,
      ok: false,
      reason: 'database_not_configured',
    };
  }

  const queryContent = [
    "SELECT table_name",
    "FROM information_schema.tables",
    "WHERE table_schema = 'public'",
      "AND table_type = 'BASE TABLE';"
  ].join(' ')

  try {
    // const result = await query<{ postgis_version: string | null }>('SELECT PostGIS_Version() AS postgis_version');
    const result = await query<{ table_name: string | null }>(queryContent);
    // console.log(result.rows.map( r => r.table_name).join(', '));

    return {
      enabled: true,
      ok: true,
      tableNames: result.rows.map( r => r.table_name).join(', ') || null,
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      reason: error instanceof Error ? error.message : 'Unknown database error.',
    };
  }
}
