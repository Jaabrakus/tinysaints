import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL,
    last_generated_at TEXT,
    generation_window_started_at TEXT,
    generation_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY NOT NULL,
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    owner_id TEXT NOT NULL REFERENCES users(id),
    parent_room_id TEXT,
    invite_token_hash TEXT,
    generation_lease_id TEXT,
    generation_locked_until TEXT,
    last_generated_at TEXT,
    presented_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS rooms_slug_unique ON rooms(slug)`,
  `CREATE INDEX IF NOT EXISTS rooms_parent_idx ON rooms(parent_room_id)`,
  `CREATE TABLE IF NOT EXISTS room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'maker',
    joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(room_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS room_members_user_idx ON room_members(user_id)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS messages_room_created_idx ON messages(room_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS builds (
    id TEXT PRIMARY KEY NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    source_kind TEXT NOT NULL DEFAULT 'legacy',
    agent_label TEXT,
    name TEXT NOT NULL,
    proposal_title TEXT NOT NULL,
    rationale TEXT NOT NULL,
    summary TEXT NOT NULL,
    changes_json TEXT NOT NULL DEFAULT '[]',
    source_message_ids_json TEXT NOT NULL DEFAULT '[]',
    html TEXT NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    parent_build_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS builds_room_version_unique ON builds(room_id, version)`,
  `CREATE INDEX IF NOT EXISTS builds_room_status_idx ON builds(room_id, status)`,
  `CREATE TABLE IF NOT EXISTS build_files (
    build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK(
      length(path) BETWEEN 1 AND 120 AND
      path NOT LIKE '/%' AND
      path NOT LIKE '%/' AND
      path NOT LIKE '%//%'
    ),
    content TEXT NOT NULL,
    language TEXT NOT NULL CHECK(language IN ('html', 'css', 'javascript', 'json', 'markdown', 'text')),
    sha256 TEXT NOT NULL CHECK(
      length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    byte_count INTEGER NOT NULL CHECK(byte_count >= 0 AND byte_count <= 65536),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(build_id, path)
  )`,
  `CREATE TABLE IF NOT EXISTS votes (
    build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(build_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS votes_user_idx ON votes(user_id)`,
] as const;

const roomColumns = [
  ["invite_token_hash", "ALTER TABLE rooms ADD COLUMN invite_token_hash TEXT"],
  ["generation_lease_id", "ALTER TABLE rooms ADD COLUMN generation_lease_id TEXT"],
  ["generation_locked_until", "ALTER TABLE rooms ADD COLUMN generation_locked_until TEXT"],
  ["last_generated_at", "ALTER TABLE rooms ADD COLUMN last_generated_at TEXT"],
  ["presented_at", "ALTER TABLE rooms ADD COLUMN presented_at TEXT"],
  ["revision", "ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"],
] as const;

const userColumns = [
  ["last_generated_at", "ALTER TABLE users ADD COLUMN last_generated_at TEXT"],
  ["generation_window_started_at", "ALTER TABLE users ADD COLUMN generation_window_started_at TEXT"],
  ["generation_count", "ALTER TABLE users ADD COLUMN generation_count INTEGER NOT NULL DEFAULT 0"],
] as const;

const buildColumns = [
  ["source_kind", "ALTER TABLE builds ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'legacy'"],
  ["agent_label", "ALTER TABLE builds ADD COLUMN agent_label TEXT"],
] as const;

let initialized = false;

function getD1() {
  if (!env.DB) {
    throw new Error(
      "The room database is not available yet. Publish the D1-enabled version before using collaboration.",
    );
  }
  return env.DB;
}

export function getDb() {
  return drizzle(getD1(), { schema });
}

export async function ensureDatabase() {
  if (initialized) return;
  const d1 = getD1();
  await d1.batch(schemaStatements.map((statement) => d1.prepare(statement)));

  const columnInfo = await d1.prepare("PRAGMA table_info(rooms)").all<{ name: string }>();
  const existingColumns = new Set(columnInfo.results.map((column) => column.name));
  for (const [name, statement] of roomColumns) {
    if (existingColumns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
  const userColumnInfo = await d1.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  const existingUserColumns = new Set(userColumnInfo.results.map((column) => column.name));
  for (const [name, statement] of userColumns) {
    if (existingUserColumns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
  const buildColumnInfo = await d1.prepare("PRAGMA table_info(builds)").all<{ name: string }>();
  const existingBuildColumns = new Set(buildColumnInfo.results.map((column) => column.name));
  for (const [name, statement] of buildColumns) {
    if (existingBuildColumns.has(name)) continue;
    try {
      await d1.prepare(statement).run();
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("duplicate column name")) {
        throw error;
      }
    }
  }
  initialized = true;
}
