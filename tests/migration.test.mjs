import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function migration(name) {
  return (await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8")).replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

test("upgrades the deployed schema with immutable source snapshots", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(await migration("0000_pale_iron_patriot.sql"));

  database
    .prepare("INSERT INTO users (id, display_name) VALUES (?, ?)")
    .run("user-1", "Maker");
  database
    .prepare("INSERT INTO rooms (id, slug, name, owner_id) VALUES (?, ?, ?, ?)")
    .run("room-1", "room-one", "Room one", "user-1");
  database
    .prepare(
      "INSERT INTO builds (id, room_id, version, status, name, proposal_title, rationale, summary, html, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      "build-1",
      "room-1",
      1,
      "published",
      "Room one",
      "Starter",
      "Reason",
      "Summary",
      "<!doctype html><html><body><main>hello</main></body></html>",
      "user-1",
    );

  database.exec(await migration("0001_collaborative_source.sql"));

  const buildColumns = database.prepare("PRAGMA table_info(builds)").all();
  assert.ok(buildColumns.some((column) => column.name === "source_kind"));
  assert.equal(
    database.prepare("SELECT source_kind FROM builds WHERE id = ?").get("build-1")
      .source_kind,
    "legacy",
  );

  const insertFile = database.prepare(
    "INSERT INTO build_files (build_id, path, content, language, sha256, byte_count) VALUES (?, ?, ?, ?, ?, ?)",
  );
  insertFile.run("build-1", "index.html", "<main>hello</main>", "html", "a".repeat(64), 18);
  insertFile.run("build-1", "styles.css", "main{}", "css", "b".repeat(64), 6);
  assert.throws(
    () => insertFile.run("build-1", "index.html", "again", "html", "c".repeat(64), 5),
    /UNIQUE constraint failed/,
  );
  assert.throws(
    () => insertFile.run("build-1", "app.js", "alert(1)", "js", "c".repeat(64), 8),
    /CHECK constraint failed/,
  );
  assert.throws(
    () => insertFile.run("build-1", "styles.css", "bad", "html", "c".repeat(64), 3),
    /CHECK|UNIQUE constraint failed/,
  );

  database.exec(await migration("0002_previous_krista_starr.sql"));
  const roomColumns = database.prepare("PRAGMA table_info(rooms)").all();
  const upgradedBuildColumns = database.prepare("PRAGMA table_info(builds)").all();
  assert.ok(roomColumns.some((column) => column.name === "presented_at"));
  assert.ok(upgradedBuildColumns.some((column) => column.name === "agent_label"));
  database
    .prepare(
      "INSERT INTO build_files (build_id, path, content, language, sha256, byte_count) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("build-1", "src/app.js", "const ready = true", "javascript", "d".repeat(64), 18);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM build_files").get().count,
    3,
  );
  assert.throws(
    () =>
      database
        .prepare(
          "INSERT INTO build_files (build_id, path, content, language, sha256, byte_count) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("build-1", "/escape.js", "bad", "javascript", "e".repeat(64), 3),
    /CHECK constraint failed/,
  );

  database.exec(await migration("0003_complex_skaar.sql"));
  const tokenColumns = database.prepare("PRAGMA table_info(agent_tokens)").all();
  assert.ok(tokenColumns.some((column) => column.name === "token_hash"));
  database
    .prepare("INSERT INTO users (id, display_name) VALUES (?, ?)")
    .run("user-agent", "Agent owner");
  database
    .prepare(
      "INSERT INTO agent_tokens (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?, ?)",
    )
    .run("token-1", "user-agent", "Laptop agent", "f".repeat(64), "mr_live_ffff…");
  assert.throws(
    () => database
      .prepare(
        "INSERT INTO agent_tokens (id, user_id, name, token_hash, token_prefix) VALUES (?, ?, ?, ?, ?)",
      )
      .run("token-2", "user-agent", "Duplicate", "f".repeat(64), "mr_live_ffff…"),
    /UNIQUE constraint failed/,
  );
  database.prepare("DELETE FROM users WHERE id = ?").run("user-agent");
  assert.equal(database.prepare("SELECT count(*) AS count FROM agent_tokens").get().count, 0);

  database.exec(await migration("0004_flat_clea.sql"));
  const assetColumns = database.prepare("PRAGMA table_info(project_assets)").all();
  assert.ok(assetColumns.some((column) => column.name === "object_key"));
  const insertAsset = database.prepare(
    "INSERT INTO project_assets (id, room_id, uploaded_by, name, kind, content_type, object_key, sha256, byte_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertAsset.run(
    "asset-1",
    "room-1",
    "user-1",
    "player.png",
    "image",
    "image/png",
    "objects/asset-one",
    "a".repeat(64),
    1024,
  );
  assert.throws(
    () => insertAsset.run(
      "asset-2",
      "room-1",
      "user-1",
      "bad.bin",
      "binary",
      "application/octet-stream",
      "objects/asset-two",
      "b".repeat(64),
      1024,
    ),
    /CHECK constraint failed/,
  );

  database.exec(await migration("0005_live_collaboration.sql"));
  database.prepare(
    "INSERT INTO editor_presence (room_id, user_id, path, cursor_line, cursor_column) VALUES (?, ?, ?, ?, ?)",
  ).run("room-1", "user-1", "src/app.js", 4, 9);
  database.prepare(
    "INSERT INTO live_file_drafts (room_id, path, base_build_id, content, updated_by) VALUES (?, ?, ?, ?, ?)",
  ).run("room-1", "src/app.js", "build-1", "const live = true", "user-1");
  database.prepare(
    "INSERT INTO file_leases (room_id, path, user_id, expires_at) VALUES (?, ?, ?, datetime('now', '+15 seconds'))",
  ).run("room-1", "src/app.js", "user-1");
  database.prepare(
    "INSERT INTO playtest_links (id, room_id, build_id, created_by, label, token_hash, token_prefix, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', '+14 days'))",
  ).run("link-1", "room-1", "build-1", "user-1", "Team test", "9".repeat(64), "play_9999…");
  database.prepare(
    "INSERT INTO playtest_feedback (id, link_id, display_name, rating, body) VALUES (?, ?, ?, ?, ?)",
  ).run("feedback-1", "link-1", "Tester", 5, "Movement feels good");
  assert.equal(database.prepare("SELECT cursor_line FROM editor_presence").get().cursor_line, 4);
  assert.throws(
    () => database.prepare(
      "INSERT INTO playtest_feedback (id, link_id, display_name, rating, body) VALUES (?, ?, ?, ?, ?)",
    ).run("feedback-bad", "link-1", "Tester", 6, "bad"),
    /CHECK constraint failed/,
  );
  database.exec(await migration("0006_guest_sessions.sql"));
  database.prepare(
    "INSERT INTO guest_sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+30 days'))",
  ).run("8".repeat(64), "user-1");
  assert.equal(database.prepare("SELECT count(*) AS count FROM guest_sessions").get().count, 1);

  database.exec(await migration("0007_contribution_protocol.sql"));
  database.prepare(
    "INSERT INTO contributions (id, room_id, owner_id, kind, provider_label, title, summary) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("contribution-1", "room-1", "user-1", "context", "Local AI", "Finding", "Use a smaller collision box");
  database.prepare(
    "INSERT INTO contribution_reactions (contribution_id, user_id, reaction) VALUES (?, ?, ?)",
  ).run("contribution-1", "user-1", "useful");
  assert.equal(database.prepare("SELECT visibility FROM contributions WHERE id = ?").get("contribution-1").visibility, "private");
  assert.throws(() => database.prepare(
    "INSERT INTO contribution_reactions (contribution_id, user_id, reaction) VALUES (?, ?, ?)",
  ).run("contribution-1", "user-1", "like"), /CHECK constraint failed/);

  database.prepare("DELETE FROM builds WHERE id = ?").run("build-1");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM build_files").get().count,
    0,
  );
  assert.equal(database.prepare("SELECT count(*) AS count FROM playtest_links").get().count, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM live_file_drafts").get().count, 0);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
