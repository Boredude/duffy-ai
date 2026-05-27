/**
 * Minimal DB query CLI — used by the /query-db skill and tech-support agent.
 *
 * Usage:
 *   pnpm tsx scripts/query-db.ts "SELECT * FROM brands"
 *   pnpm tsx scripts/query-db.ts --tables
 *   echo "SELECT id FROM brands" | pnpm tsx scripts/query-db.ts
 *
 * Always outputs newline-delimited JSON (one object per row) so results can
 * be piped to `jq`.
 */

import 'dotenv/config';
import { getPool } from '../src/db/client.js';
import process from 'node:process';

const LIST_TABLES_SQL = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
  ORDER BY table_name
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let sql: string;

  if (args[0] === '--tables') {
    sql = LIST_TABLES_SQL;
  } else if (args.length > 0 && args[0] !== '-') {
    sql = args.join(' ');
  } else {
    // Read from stdin
    sql = await new Promise<string>((resolve, reject) => {
      let buf = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buf += chunk; });
      process.stdin.on('end', () => resolve(buf.trim()));
      process.stdin.on('error', reject);
    });
  }

  if (!sql) {
    console.error('Usage: pnpm tsx scripts/query-db.ts "<SQL>"');
    console.error('       pnpm tsx scripts/query-db.ts --tables');
    process.exit(1);
  }

  const pool = getPool();
  try {
    const result = await pool.query(sql);
    for (const row of result.rows) {
      console.log(JSON.stringify(row));
    }
    if (result.rows.length === 0) {
      console.error('(0 rows)');
    } else {
      console.error(`(${result.rows.length} row${result.rows.length === 1 ? '' : 's'})`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message ?? String(err));
  process.exit(1);
});
