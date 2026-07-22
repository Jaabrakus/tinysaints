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

  database.prepare("DELETE FROM builds WHERE id = ?").run("build-1");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM build_files").get().count,
    0,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});
