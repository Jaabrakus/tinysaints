import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  lastGeneratedAt: text("last_generated_at"),
  generationWindowStartedAt: text("generation_window_started_at"),
  generationCount: integer("generation_count").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const rooms = sqliteTable(
  "rooms",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    parentRoomId: text("parent_room_id"),
    inviteTokenHash: text("invite_token_hash"),
    generationLeaseId: text("generation_lease_id"),
    generationLockedUntil: text("generation_locked_until"),
    lastGeneratedAt: text("last_generated_at"),
    presentedAt: text("presented_at"),
    revision: integer("revision").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("rooms_slug_unique").on(table.slug),
    index("rooms_parent_idx").on(table.parentRoomId),
  ],
);

export const roomMembers = sqliteTable(
  "room_members",
  {
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("maker"),
    joinedAt: text("joined_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.roomId, table.userId] }),
    index("room_members_user_idx").on(table.userId),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    authorId: text("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("messages_room_created_idx").on(table.roomId, table.createdAt),
  ],
);

export const builds = sqliteTable(
  "builds",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    sourceKind: text("source_kind").notNull().default("legacy"),
    agentLabel: text("agent_label"),
    name: text("name").notNull(),
    proposalTitle: text("proposal_title").notNull(),
    rationale: text("rationale").notNull(),
    summary: text("summary").notNull(),
    changesJson: text("changes_json").notNull().default("[]"),
    sourceMessageIdsJson: text("source_message_ids_json").notNull().default("[]"),
    html: text("html").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    parentBuildId: text("parent_build_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    publishedAt: text("published_at"),
  },
  (table) => [
    uniqueIndex("builds_room_version_unique").on(table.roomId, table.version),
    index("builds_room_status_idx").on(table.roomId, table.status),
  ],
);

export const buildFiles = sqliteTable(
  "build_files",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    path: text("path").notNull(),
    content: text("content").notNull(),
    language: text("language").notNull(),
    sha256: text("sha256").notNull(),
    byteCount: integer("byte_count").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.buildId, table.path] }),
    check("build_files_path_length_check", sql`length(${table.path}) BETWEEN 1 AND 120`),
    check("build_files_path_start_check", sql`${table.path} NOT LIKE '/%'`),
    check("build_files_path_end_check", sql`${table.path} NOT LIKE '%/'`),
    check("build_files_path_slashes_check", sql`${table.path} NOT LIKE '%//%'`),
    check(
      "build_files_language_check",
      sql`${table.language} IN ('html', 'css', 'javascript', 'json', 'markdown', 'text')`,
    ),
    check(
      "build_files_byte_count_check",
      sql`${table.byteCount} >= 0 AND ${table.byteCount} <= 65536`,
    ),
    check(
      "build_files_sha256_check",
      sql`length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const votes = sqliteTable(
  "votes",
  {
    buildId: text("build_id")
      .notNull()
      .references(() => builds.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.buildId, table.userId] }),
    index("votes_user_idx").on(table.userId),
  ],
);
