#!/usr/bin/env node
// Copies the game's data from one PostgreSQL database to another — Render to
// Supabase, in practice. Run it with both URLs in the environment:
//
//   SOURCE_DATABASE_URL="postgresql://…render.com/…"   (Render: the EXTERNAL url)
//   TARGET_DATABASE_URL="postgresql://…supabase.com:6543/postgres"
//   node backend/scripts/copy-database.mjs
//
// Safe to run more than once: every row is inserted with ON CONFLICT DO
// NOTHING, so a second run copies only what the first one missed. It never
// deletes anything, and it never writes to the source.
//
// Run it AFTER the new database has been through the app once, so the schema
// exists there (deploy the API, or start the backend against it).

import { Pool } from "pg";

const sourceUrl = process.env.SOURCE_DATABASE_URL;
const targetUrl = process.env.TARGET_DATABASE_URL;

if (!sourceUrl || !targetUrl) {
  console.error("Set SOURCE_DATABASE_URL and TARGET_DATABASE_URL first.");
  process.exit(1);
}

// Order matters only for readability — these tables have no foreign keys.
// Columns are listed explicitly so a schema that later gains one still copies.
const TABLES = [
  {
    name: "check_in_streaks",
    columns: ["address", "streak", "last_check_in_at", "updated_at"],
    why: "daily check-in streaks"
  },
  {
    name: "runs",
    columns: [
      "id",
      "tx_hash",
      "address",
      "mode",
      "level",
      "score",
      "cells",
      "moves",
      "won",
      "recorded_at"
    ],
    sequence: "id",
    why: "every saved run"
  },
  {
    name: "player_bests",
    columns: ["address", "mode", "level", "score", "cells", "moves", "tx_hash", "updated_at"],
    why: "best run per board"
  },
  {
    // The one that costs money if it goes missing: without these rows a balance
    // is purchases minus nothing, and every buyer gets their spent revives
    // back for free. Ids are copied so a re-run cannot double-count a spend.
    name: "revive_usage",
    columns: ["id", "address", "used_at", "request_id"],
    sequence: "id",
    why: "revives already spent"
  },
  {
    name: "recorded_runs",
    columns: ["address", "first_run_at"],
    optional: true,
    why: "legacy table, kept for history"
  }
];

// Which database is which, without printing the password. "Not in the source"
// is almost always the wrong URL rather than an empty database, so say out loud
// what is being read from and written to.
function describe(url) {
  try {
    const parsed = new URL(url);

    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "unparseable URL";
  }
}

const ssl = { rejectUnauthorized: false };
const source = new Pool({ connectionString: sourceUrl, ssl });
const target = new Pool({ connectionString: targetUrl, ssl });

async function tableExists(pool, name) {
  const result = await pool.query("SELECT to_regclass($1) AS oid", [`public.${name}`]);
  return result.rows[0]?.oid !== null;
}

async function copyTable(table) {
  if (!(await tableExists(source, table.name))) {
    console.log(`- ${table.name}: not in the source, skipped`);
    return;
  }

  if (!(await tableExists(target, table.name))) {
    throw new Error(
      `${table.name} is missing in the target. Let the app create its schema there first.`
    );
  }

  const columns = table.columns.join(", ");
  const { rows } = await source.query(`SELECT ${columns} FROM ${table.name}`);

  if (rows.length === 0) {
    console.log(`- ${table.name}: empty`);
    return;
  }

  const before = await target.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);
  // Batched inserts are plenty at this size; a bigger dataset would want COPY.
  const batchSize = 500;

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values = [];
    const placeholders = batch.map((row) => {
      const slots = table.columns.map((column) => {
        values.push(row[column]);
        return `$${values.length}`;
      });

      return `(${slots.join(", ")})`;
    });

    await target.query(
      `INSERT INTO ${table.name} (${columns}) VALUES ${placeholders.join(", ")}
       ON CONFLICT DO NOTHING`,
      values
    );
  }

  const after = await target.query(`SELECT COUNT(*)::int AS count FROM ${table.name}`);

  // A copied id leaves the sequence behind it, and the next insert would
  // collide. Move it past the highest id.
  if (table.sequence) {
    await target.query(
      `SELECT setval(
         pg_get_serial_sequence($1, $2),
         GREATEST((SELECT COALESCE(MAX(${table.sequence}), 0) FROM ${table.name}), 1)
       )`,
      [table.name, table.sequence]
    );
  }

  const added = after.rows[0].count - before.rows[0].count;
  copied += rows.length;
  console.log(
    `- ${table.name}: ${rows.length} in source, ${added} new here (${after.rows[0].count} total) — ${table.why}`
  );
}

try {
  console.log("Copying game data. The source is only ever read.\n");

  for (const table of TABLES) {
    try {
      await copyTable(table);
    } catch (error) {
      if (!table.optional) {
        throw error;
      }

      console.log(`- ${table.name}: skipped (${error.message})`);
    }
  }

  console.log(
    "\nDone. Sessions are deliberately not copied: players sign in again, " +
      "which costs them one wallet signature and nothing else."
  );
} catch (error) {
  console.error("\nCopy failed:", error.message);
  process.exitCode = 1;
} finally {
  await source.end();
  await target.end();
}
