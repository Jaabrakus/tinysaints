import { and, asc, desc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { ensureDatabase, getDb } from "../db";
import {
  agentTokens,
  buildFiles,
  builds,
  contributionLinks,
  contributionReactions,
  contributions,
  editorPresence,
  fileLeases,
  guestSessions,
  liveFileDrafts,
  messages,
  playtestFeedback,
  playtestLinks,
  projectAssets,
  roomMembers,
  rooms,
  users,
  votes,
} from "../db/schema";
import {
  assembleArtifactFiles,
  extractArtifactSource,
  inferArtifactLanguage,
  makeStarterProject,
  sourceFilesFromGenerated,
  validateArtifactFiles,
  validateArtifactPath,
  type ArtifactSourceFile,
  type ProjectTemplate,
} from "./starter-artifact";
import { mergeForkSourceSnapshots } from "./fork-merge";
import { projectChangesBetween } from "./convergence";

export class RoomError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export type Identity = {
  id: string;
  displayName: string;
};

export const GUEST_COOKIE_NAME = "make_room_guest";

export type GeneratedArtifact = {
  name: string;
  proposalTitle: string;
  rationale: string;
  summary: string;
  changes: string[];
  html: string;
  files: ArtifactSourceFile[];
};

const MAX_BUILDS_PER_ROOM = 500;
const MAX_ASSETS_PER_ROOM = 60;
const MAX_ROOM_ASSET_BYTES = 25 * 1024 * 1024;

function nowSql() {
  return sql`CURRENT_TIMESTAMP`;
}

function parseStringArray(value: string) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 60);
}

function cleanText(value: string, maxLength: number) {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sourceRows(buildId: string, files: ArtifactSourceFile[]) {
  return Promise.all(
    files.map(async (file) => ({
      buildId,
      path: file.path,
      content: file.content,
      language: file.language,
      sha256: await sha256(file.content),
      byteCount: byteLength(file.content),
    })),
  );
}

function asArtifactSourceFiles(
  rows: Array<{
    path: string;
    content: string;
    language: string;
  }>,
): ArtifactSourceFile[] {
  try {
    return validateArtifactFiles(
      rows.map((row) => ({
        path: row.path,
        content: row.content,
        language: row.language as ArtifactSourceFile["language"],
      })),
    );
  } catch (error) {
    throw new RoomError(
      error instanceof Error
        ? error.message
        : "This build does not have a complete project snapshot.",
      409,
    );
  }
}

async function validateStoredBuildFiles(
  build: typeof builds.$inferSelect,
  rows: Array<typeof buildFiles.$inferSelect>,
) {
  const files = asArtifactSourceFiles(rows);
  const expectedRows = await sourceRows(build.id, files);
  for (const expected of expectedRows) {
    const stored = rows.find((row) => row.path === expected.path);
    if (
      !stored ||
      stored.language !== expected.language ||
      stored.sha256 !== expected.sha256 ||
      stored.byteCount !== expected.byteCount
    ) {
      throw new RoomError("This build's source snapshot failed its integrity check.", 409);
    }
  }
  let compiled: string;
  try {
    compiled = assembleArtifactFiles(files, build.name);
  } catch {
    throw new RoomError("This build's source snapshot failed safety validation.", 409);
  }
  if (build.sourceKind !== "legacy" && compiled !== build.html) {
    throw new RoomError("This build's preview does not match its source snapshot.", 409);
  }
  return rows;
}

async function ensureBuildFiles(build: typeof builds.$inferSelect) {
  const db = getDb();
  let rows = await db
    .select()
    .from(buildFiles)
    .where(eq(buildFiles.buildId, build.id))
    .orderBy(asc(buildFiles.path));
  if (rows.length > 0) return validateStoredBuildFiles(build, rows);

  let files: ArtifactSourceFile[];
  try {
    files = sourceFilesFromGenerated(extractArtifactSource(build.html));
    assembleArtifactFiles(files, build.name);
  } catch (error) {
    throw new RoomError(
      error instanceof Error
        ? error.message
        : "The stored artifact could not be converted into source files.",
      409,
    );
  }
  await db
    .insert(buildFiles)
    .values(await sourceRows(build.id, files))
    .onConflictDoNothing();
  rows = await db
    .select()
    .from(buildFiles)
    .where(eq(buildFiles.buildId, build.id))
    .orderBy(asc(buildFiles.path));
  if (rows.length < 2) {
    throw new RoomError("The build source snapshot could not be initialized.", 500);
  }
  return validateStoredBuildFiles(build, rows);
}

async function hashIdentity(email: string) {
  const hex = await sha256(email.trim().toLowerCase());
  return `usr_${hex.slice(0, 28)}`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tokenPrefix(token: string) {
  return `${token.slice(0, 15)}…`;
}

export async function getIdentity(): Promise<Identity | null> {
  const user = await getChatGPTUser();
  if (user) {
    return {
      id: await hashIdentity(user.email),
      displayName: cleanText(user.displayName, 80),
    };
  }
  const token = (await cookies()).get(GUEST_COOKIE_NAME)?.value ?? "";
  if (!/^guest_[0-9a-f]{64}$/.test(token)) return null;
  await ensureDatabase();
  const db = getDb();
  const tokenHash = await sha256(token);
  const [session] = await db
    .select({ userId: guestSessions.userId, displayName: users.displayName })
    .from(guestSessions)
    .innerJoin(users, eq(guestSessions.userId, users.id))
    .where(and(eq(guestSessions.tokenHash, tokenHash), sql`${guestSessions.expiresAt} > CURRENT_TIMESTAMP`))
    .limit(1);
  if (!session) return null;
  await db
    .update(guestSessions)
    .set({ lastSeenAt: nowSql() })
    .where(and(
      eq(guestSessions.tokenHash, tokenHash),
      sql`${guestSessions.lastSeenAt} < datetime('now', '-1 minute')`,
    ));
  return { id: session.userId, displayName: session.displayName };
}

export async function createGuestSession(rawDisplayName: string) {
  await ensureDatabase();
  const displayName = cleanText(rawDisplayName, 40);
  if (displayName.length < 2) throw new RoomError("Choose a name with at least two characters.");
  const token = `guest_${randomToken()}`;
  const identity = { id: `gst_${crypto.randomUUID()}`, displayName };
  const db = getDb();
  await db.batch([
    db.insert(users).values({ id: identity.id, displayName }),
    db.insert(guestSessions).values({
      tokenHash: await sha256(token),
      userId: identity.id,
      expiresAt: sql`datetime('now', '+30 days')`,
    }),
  ]);
  return { token, identity };
}

export async function revokeGuestSession(rawToken: string) {
  if (!/^guest_[0-9a-f]{64}$/.test(rawToken)) return;
  await ensureDatabase();
  await getDb().delete(guestSessions).where(eq(guestSessions.tokenHash, await sha256(rawToken)));
}

export async function createAgentToken(identity: Identity, rawName: string) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  const name = cleanText(rawName, 50) || "Personal coding agent";
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(agentTokens)
    .where(and(eq(agentTokens.userId, identity.id), isNull(agentTokens.revokedAt)));
  if (Number(countRow?.count ?? 0) >= 8) {
    throw new RoomError("Revoke an old agent key before creating another one.", 409);
  }
  const token = `mr_live_${randomToken()}`;
  await db.insert(agentTokens).values({
    id: crypto.randomUUID(),
    userId: identity.id,
    name,
    tokenHash: await sha256(token),
    tokenPrefix: tokenPrefix(token),
  });
  return token;
}

export async function revokeAgentToken(identity: Identity, tokenId: string) {
  await ensureDatabase();
  const [revoked] = await getDb()
    .update(agentTokens)
    .set({ revokedAt: nowSql() })
    .where(
      and(
        eq(agentTokens.id, tokenId.trim()),
        eq(agentTokens.userId, identity.id),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning({ id: agentTokens.id });
  if (!revoked) throw new RoomError("That agent key is already revoked or missing.", 404);
}

export async function authenticateAgentToken(request: Request): Promise<Identity> {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(mr_live_[a-f0-9]{64})$/i);
  if (!match) throw new RoomError("Use a valid Make Room bearer token.", 401);
  await ensureDatabase();
  const db = getDb();
  const tokenHash = await sha256(match[1]);
  const [record] = await db
    .select({
      id: agentTokens.id,
      userId: users.id,
      displayName: users.displayName,
    })
    .from(agentTokens)
    .innerJoin(users, eq(agentTokens.userId, users.id))
    .where(and(eq(agentTokens.tokenHash, tokenHash), isNull(agentTokens.revokedAt)))
    .limit(1);
  if (!record) throw new RoomError("This agent token is invalid or revoked.", 401);
  await db
    .update(agentTokens)
    .set({ lastUsedAt: nowSql() })
    .where(
      and(
        eq(agentTokens.id, record.id),
        sql`(${agentTokens.lastUsedAt} IS NULL OR ${agentTokens.lastUsedAt} < datetime('now', '-1 minute'))`,
      ),
    );
  return { id: record.userId, displayName: record.displayName };
}

export function isKimiConfigured() {
  return Boolean(
    process.env.MOONSHOT_API_KEY ??
      process.env.KIMI_API_KEY ??
      process.env.AI_API_KEY ??
      (process.env.AI_ALLOW_UNAUTHENTICATED === "true" ? process.env.AI_BASE_URL : undefined),
  );
}

async function upsertUser(identity: Identity) {
  const db = getDb();
  await db
    .insert(users)
    .values({ id: identity.id, displayName: identity.displayName })
    .onConflictDoUpdate({
      target: users.id,
      set: { displayName: identity.displayName, updatedAt: nowSql() },
      setWhere: ne(users.displayName, identity.displayName),
    });
}

async function createSeedRoom(identity: Identity) {
  const db = getDb();
  const roomId = crypto.randomUUID();
  const name = "tiny plans";
  const source = makeStarterProject(name);
  const buildId = crypto.randomUUID();

  await db
    .insert(rooms)
    .values({
      id: roomId,
      slug: "tiny-plans",
      name,
      note: "Making spontaneous plans feel spontaneous again.",
      ownerId: identity.id,
    })
    .onConflictDoNothing({ target: rooms.slug });

  const [room] = await db
    .select({ id: rooms.id, ownerId: rooms.ownerId })
    .from(rooms)
    .where(eq(rooms.slug, "tiny-plans"))
    .limit(1);
  if (!room) throw new RoomError("The first room could not be created.", 500);

  if (room.ownerId !== identity.id) return;

  await db.batch([
    db.insert(roomMembers).values({
      roomId: room.id,
      userId: identity.id,
      role: "owner",
    }).onConflictDoNothing(),
    db.insert(builds).values({
      id: buildId,
      roomId: room.id,
      version: 1,
      status: "published",
      sourceKind: "starter",
      name,
      proposalTitle: "A useful place to begin",
      rationale: "Every room starts with a small working artifact, then earns its complexity through conversation.",
      summary: "The first interactive artifact for this room.",
      changesJson: JSON.stringify([
        "Added a working three-choice interaction",
        "Kept every dependency inside the artifact",
        "Prepared the room for its first Kimi synthesis",
      ]),
      sourceMessageIdsJson: "[]",
      html: assembleArtifactFiles(source, name),
      createdBy: room.ownerId,
      publishedAt: nowSql(),
    }).onConflictDoNothing({ target: [builds.roomId, builds.version] }),
  ]);

  const [seedBuild] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, room.id), eq(builds.version, 1)))
    .limit(1);
  if (seedBuild) await ensureBuildFiles(seedBuild);
}

async function getRoomForUser(slugValue: string, identity: Identity) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  const slug = normalizeSlug(slugValue) || "tiny-plans";
  let [room] = await db.select().from(rooms).where(eq(rooms.slug, slug)).limit(1);

  if (!room && slug === "tiny-plans") {
    await createSeedRoom(identity);
    [room] = await db.select().from(rooms).where(eq(rooms.slug, slug)).limit(1);
  }

  if (!room) throw new RoomError("That room does not exist.", 404);

  let [membership] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, room.id),
        eq(roomMembers.userId, identity.id),
      ),
    )
    .limit(1);
  if (!membership && slug === "tiny-plans" && room.ownerId === identity.id) {
    await createSeedRoom(identity);
    [membership] = await db
      .select({ role: roomMembers.role })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, room.id),
          eq(roomMembers.userId, identity.id),
        ),
      )
      .limit(1);
  }
  if (!membership) {
    throw new RoomError("You need a valid room invite before you can enter.", 403);
  }

  if (slug === "tiny-plans" && room.ownerId === identity.id) {
    const [seedBuild] = await db
      .select({ id: builds.id })
      .from(builds)
      .where(eq(builds.roomId, room.id))
      .limit(1);
    if (!seedBuild) await createSeedRoom(identity);
  }

  await db
    .update(roomMembers)
    .set({ lastSeenAt: nowSql() })
    .where(
      and(
        eq(roomMembers.roomId, room.id),
        eq(roomMembers.userId, identity.id),
        sql`${roomMembers.lastSeenAt} < datetime('now', '-30 seconds')`,
      ),
    );

  return room;
}

export type ProjectAssetKind = "image" | "audio";

function normalizeAssetName(value: string) {
  return value
    .replace(/[\\/\u0000-\u001f\u007f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

function serializeAsset(asset: typeof projectAssets.$inferSelect, uploaderName?: string) {
  return {
    id: asset.id,
    name: asset.name,
    kind: asset.kind as ProjectAssetKind,
    contentType: asset.contentType,
    byteCount: asset.byteCount,
    sha256: asset.sha256,
    sourceAssetId: asset.sourceAssetId,
    uploadedBy: asset.uploadedBy,
    uploadedByName: uploaderName ?? "Maker",
    createdAt: asset.createdAt,
  };
}

export async function createProjectAssetRecord(
  slugValue: string,
  identity: Identity,
  input: {
    name: string;
    kind: ProjectAssetKind;
    contentType: string;
    objectKey: string;
    sha256: string;
    byteCount: number;
  },
) {
  const room = await getRoomForUser(slugValue, identity);
  const name = normalizeAssetName(input.name);
  if (!name) throw new RoomError("Give the asset a file name.");
  if (!/^[0-9a-f]{64}$/.test(input.sha256) || input.objectKey !== `objects/${input.sha256}`) {
    throw new RoomError("The uploaded asset failed its integrity check.");
  }
  if (!Number.isInteger(input.byteCount) || input.byteCount < 1 || input.byteCount > 5 * 1024 * 1024) {
    throw new RoomError("Assets must be between 1 byte and 5 MB.", 413);
  }

  const db = getDb();
  const [existing, totals] = await Promise.all([
    db
      .select()
      .from(projectAssets)
      .where(and(eq(projectAssets.roomId, room.id), eq(projectAssets.sha256, input.sha256)))
      .limit(1),
    db
      .select({
        count: sql<number>`count(*)`,
        bytes: sql<number>`coalesce(sum(${projectAssets.byteCount}), 0)`,
      })
      .from(projectAssets)
      .where(eq(projectAssets.roomId, room.id)),
  ]);
  if (existing[0]) return serializeAsset(existing[0], identity.displayName);
  if (Number(totals[0]?.count ?? 0) >= MAX_ASSETS_PER_ROOM) {
    throw new RoomError("This room already has 60 assets. Remove one before uploading another.", 409);
  }
  if (Number(totals[0]?.bytes ?? 0) + input.byteCount > MAX_ROOM_ASSET_BYTES) {
    throw new RoomError("This room reached its 25 MB shared asset limit.", 413);
  }

  const asset = {
    id: crypto.randomUUID(),
    roomId: room.id,
    uploadedBy: identity.id,
    sourceAssetId: null,
    name,
    kind: input.kind,
    contentType: input.contentType,
    objectKey: input.objectKey,
    sha256: input.sha256,
    byteCount: input.byteCount,
  };
  await db.batch([
    db.insert(projectAssets).values(asset),
    db
      .update(rooms)
      .set({ updatedAt: nowSql(), revision: sql`${rooms.revision} + 1` })
      .where(eq(rooms.id, room.id)),
  ]);
  return serializeAsset({ ...asset, createdAt: new Date().toISOString() }, identity.displayName);
}

export async function getProjectAssetRecord(
  slugValue: string,
  identity: Identity,
  assetId: string,
) {
  const room = await getRoomForUser(slugValue, identity);
  const [asset] = await getDb()
    .select()
    .from(projectAssets)
    .where(and(eq(projectAssets.id, assetId.trim()), eq(projectAssets.roomId, room.id)))
    .limit(1);
  if (!asset) throw new RoomError("That asset is not in this room.", 404);
  return asset;
}

export async function deleteProjectAssetRecord(
  slugValue: string,
  identity: Identity,
  assetId: string,
) {
  const room = await getRoomForUser(slugValue, identity);
  const asset = await getProjectAssetRecord(slugValue, identity, assetId);
  if (asset.uploadedBy !== identity.id && room.ownerId !== identity.id) {
    throw new RoomError("Only the uploader or room owner can remove this asset.", 403);
  }
  const db = getDb();
  await db.batch([
    db
      .delete(projectAssets)
      .where(and(eq(projectAssets.id, asset.id), eq(projectAssets.roomId, room.id))),
    db
      .update(rooms)
      .set({ updatedAt: nowSql(), revision: sql`${rooms.revision} + 1` })
      .where(eq(rooms.id, room.id)),
  ]);
  const [remaining] = await db
    .select({ count: sql<number>`count(*)` })
    .from(projectAssets)
    .where(eq(projectAssets.objectKey, asset.objectKey));
  return { objectKey: asset.objectKey, orphaned: Number(remaining?.count ?? 0) === 0 };
}

async function copyProjectAssets(sourceRoomId: string, targetRoomId: string) {
  const db = getDb();
  const [sourceRows, targetRows] = await Promise.all([
    db.select().from(projectAssets).where(eq(projectAssets.roomId, sourceRoomId)),
    db
      .select({ sha256: projectAssets.sha256 })
      .from(projectAssets)
      .where(eq(projectAssets.roomId, targetRoomId)),
  ]);
  const targetHashes = new Set(targetRows.map((asset) => asset.sha256));
  const additions = sourceRows.filter((asset) => !targetHashes.has(asset.sha256));
  if (additions.length === 0) return;
  await db.insert(projectAssets).values(
    additions.map((asset) => ({
      id: crypto.randomUUID(),
      roomId: targetRoomId,
      uploadedBy: asset.uploadedBy,
      sourceAssetId: asset.sourceAssetId ?? asset.id,
      name: asset.name,
      kind: asset.kind,
      contentType: asset.contentType,
      objectKey: asset.objectKey,
      sha256: asset.sha256,
      byteCount: asset.byteCount,
    })),
  );
}

export async function syncEditorPresence(
  slugValue: string,
  identity: Identity,
  input: {
    path: string;
    baseBuildId: string;
    cursorLine?: number;
    cursorColumn?: number;
    selectionEndLine?: number;
    selectionEndColumn?: number;
    content?: string;
    expectedDraftRevision?: number;
  },
) {
  const room = await getRoomForUser(slugValue, identity);
  let path: string;
  try {
    path = validateArtifactPath(input.path);
  } catch (error) {
    throw new RoomError(error instanceof Error ? error.message : "That editor path is invalid.");
  }
  if (!input.baseBuildId.trim()) throw new RoomError("The editor build is missing.");
  if (input.content !== undefined && new TextEncoder().encode(input.content).byteLength > 65_536) {
    throw new RoomError("A live file draft may be at most 64 KB.", 413);
  }
  const number = (value: number | undefined) =>
    Number.isSafeInteger(value) ? Math.max(1, Math.min(Number(value), 1_000_000)) : 1;
  const db = getDb();
  const [build] = await db
    .select({ id: builds.id })
    .from(builds)
    .where(and(eq(builds.id, input.baseBuildId), eq(builds.roomId, room.id)))
    .limit(1);
  if (!build) throw new RoomError("The room moved to a different source build.", 409);
  const [baseFile] = await db
    .select({ content: buildFiles.content })
    .from(buildFiles)
    .where(and(eq(buildFiles.buildId, build.id), eq(buildFiles.path, path)))
    .limit(1);

  await db.batch([
    db.delete(fileLeases).where(sql`${fileLeases.expiresAt} < CURRENT_TIMESTAMP`),
    db
      .delete(fileLeases)
      .where(and(eq(fileLeases.roomId, room.id), eq(fileLeases.userId, identity.id), ne(fileLeases.path, path))),
    db
      .insert(editorPresence)
      .values({
        roomId: room.id,
        userId: identity.id,
        path,
        cursorLine: number(input.cursorLine),
        cursorColumn: number(input.cursorColumn),
        selectionEndLine: number(input.selectionEndLine),
        selectionEndColumn: number(input.selectionEndColumn),
      })
      .onConflictDoUpdate({
        target: [editorPresence.roomId, editorPresence.userId],
        set: {
          path,
          cursorLine: number(input.cursorLine),
          cursorColumn: number(input.cursorColumn),
          selectionEndLine: number(input.selectionEndLine),
          selectionEndColumn: number(input.selectionEndColumn),
          updatedAt: nowSql(),
        },
      }),
    db
      .insert(fileLeases)
      .values({
        roomId: room.id,
        path,
        userId: identity.id,
        expiresAt: sql`datetime('now', '+15 seconds')`,
      })
      .onConflictDoUpdate({
        target: [fileLeases.roomId, fileLeases.path],
        set: {
          userId: identity.id,
          expiresAt: sql`datetime('now', '+15 seconds')`,
          updatedAt: nowSql(),
        },
        setWhere: or(
          eq(fileLeases.userId, identity.id),
          sql`${fileLeases.expiresAt} < CURRENT_TIMESTAMP`,
        ),
      }),
  ]);

  let [draft] = await db
    .select()
    .from(liveFileDrafts)
    .where(and(eq(liveFileDrafts.roomId, room.id), eq(liveFileDrafts.path, path)))
    .limit(1);
  if (!draft || draft.baseBuildId !== build.id) {
    await db
      .insert(liveFileDrafts)
      .values({
        roomId: room.id,
        path,
        baseBuildId: build.id,
        content: baseFile?.content ?? "",
        revision: 0,
        updatedBy: identity.id,
      })
      .onConflictDoUpdate({
        target: [liveFileDrafts.roomId, liveFileDrafts.path],
        set: {
          baseBuildId: build.id,
          content: baseFile?.content ?? "",
          revision: 0,
          updatedBy: identity.id,
          updatedAt: nowSql(),
        },
      });
    [draft] = await db
      .select()
      .from(liveFileDrafts)
      .where(and(eq(liveFileDrafts.roomId, room.id), eq(liveFileDrafts.path, path)))
      .limit(1);
  }

  const [lease] = await db
    .select({ userId: fileLeases.userId, displayName: users.displayName })
    .from(fileLeases)
    .innerJoin(users, eq(fileLeases.userId, users.id))
    .where(and(eq(fileLeases.roomId, room.id), eq(fileLeases.path, path), sql`${fileLeases.expiresAt} >= CURRENT_TIMESTAMP`))
    .limit(1);
  let conflict = false;
  if (input.content !== undefined) {
    if (lease?.userId !== identity.id) {
      throw new RoomError(`${lease?.displayName ?? "Another maker"} owns ${path} right now.`, 423);
    }
    const expected = Number.isSafeInteger(input.expectedDraftRevision)
      ? Number(input.expectedDraftRevision)
      : draft?.revision ?? 0;
    const [saved] = await db
      .update(liveFileDrafts)
      .set({
        content: input.content,
        revision: sql`${liveFileDrafts.revision} + 1`,
        updatedBy: identity.id,
        updatedAt: nowSql(),
      })
      .where(and(
        eq(liveFileDrafts.roomId, room.id),
        eq(liveFileDrafts.path, path),
        eq(liveFileDrafts.baseBuildId, build.id),
        eq(liveFileDrafts.revision, expected),
      ))
      .returning();
    if (saved) draft = saved;
    else {
      conflict = true;
      [draft] = await db
        .select()
        .from(liveFileDrafts)
        .where(and(eq(liveFileDrafts.roomId, room.id), eq(liveFileDrafts.path, path)))
        .limit(1);
    }
  }

  const collaborators = await db
    .select({
      userId: editorPresence.userId,
      displayName: users.displayName,
      path: editorPresence.path,
      cursorLine: editorPresence.cursorLine,
      cursorColumn: editorPresence.cursorColumn,
      selectionEndLine: editorPresence.selectionEndLine,
      selectionEndColumn: editorPresence.selectionEndColumn,
      updatedAt: editorPresence.updatedAt,
    })
    .from(editorPresence)
    .innerJoin(users, eq(editorPresence.userId, users.id))
    .where(and(eq(editorPresence.roomId, room.id), sql`${editorPresence.updatedAt} >= datetime('now', '-20 seconds')`))
    .orderBy(asc(users.displayName));
  return {
    conflict,
    draft: draft
      ? { content: draft.content, revision: draft.revision, baseBuildId: draft.baseBuildId, updatedBy: draft.updatedBy }
      : null,
    lease: lease ? { userId: lease.userId, displayName: lease.displayName, mine: lease.userId === identity.id } : null,
    collaborators,
  };
}

export async function getHomeRoomState(identity: Identity) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  const [home] = await db
    .select({ slug: rooms.slug })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .where(eq(roomMembers.userId, identity.id))
    .orderBy(desc(rooms.updatedAt))
    .limit(1);

  if (!home) {
    const slug = await createRoom(identity, "My first room");
    return getRoomState(slug, identity);
  }
  return getRoomState(home.slug, identity);
}

export async function joinRoom(
  slugValue: string,
  identity: Identity,
  rawToken: string,
) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  const slug = normalizeSlug(slugValue) || "tiny-plans";
  const [room] = await db.select().from(rooms).where(eq(rooms.slug, slug)).limit(1);
  if (!room) throw new RoomError("That room does not exist.", 404);

  const [membership] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, room.id),
        eq(roomMembers.userId, identity.id),
      ),
    )
    .limit(1);
  if (membership) return;

  const token = rawToken.trim();
  if (!token || !room.inviteTokenHash || (await sha256(token)) !== room.inviteTokenHash) {
    throw new RoomError("That room invite is invalid or has been replaced.", 403);
  }

  await db.batch([
    db
      .insert(roomMembers)
      .values({ roomId: room.id, userId: identity.id, role: "maker" })
      .onConflictDoNothing(),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(eq(rooms.id, room.id)),
  ]);
}

export async function createRoomInvite(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  if (room.ownerId !== identity.id) {
    throw new RoomError("Only the room owner can create an invite.", 403);
  }

  const token = randomToken();
  await getDb()
    .update(rooms)
    .set({ inviteTokenHash: await sha256(token), updatedAt: nowSql() })
    .where(eq(rooms.id, room.id));
  return token;
}

export async function acquireGenerationLease(
  slugValue: string,
  identity: Identity,
) {
  const room = await getRoomForUser(slugValue, identity);
  const leaseId = crypto.randomUUID();
  const [claimed] = await getDb()
    .update(rooms)
    .set({
      generationLeaseId: leaseId,
      generationLockedUntil: sql`datetime('now', '+3 minutes')`,
      lastGeneratedAt: nowSql(),
    })
    .where(
      and(
        eq(rooms.id, room.id),
        sql`(${rooms.generationLockedUntil} IS NULL OR ${rooms.generationLockedUntil} < CURRENT_TIMESTAMP)`,
        sql`(${rooms.lastGeneratedAt} IS NULL OR ${rooms.lastGeneratedAt} < datetime('now', '-30 seconds'))`,
      ),
    )
    .returning({ id: rooms.id });

  if (!claimed) {
    throw new RoomError(
      "This room already has a build in progress or just finished one. Try again shortly.",
      429,
    );
  }

  const windowIsExpired = sql`(${users.generationWindowStartedAt} IS NULL OR ${users.generationWindowStartedAt} < datetime('now', '-1 day'))`;
  const [userClaimed] = await getDb()
    .update(users)
    .set({
      lastGeneratedAt: nowSql(),
      generationWindowStartedAt: sql`CASE WHEN ${windowIsExpired} THEN CURRENT_TIMESTAMP ELSE ${users.generationWindowStartedAt} END`,
      generationCount: sql`CASE WHEN ${windowIsExpired} THEN 1 ELSE ${users.generationCount} + 1 END`,
    })
    .where(
      and(
        eq(users.id, identity.id),
        sql`(${users.lastGeneratedAt} IS NULL OR ${users.lastGeneratedAt} < datetime('now', '-30 seconds'))`,
        sql`(${windowIsExpired} OR ${users.generationCount} < 20)`,
      ),
    )
    .returning({ id: users.id });

  if (!userClaimed) {
    await getDb()
      .update(rooms)
      .set({ generationLeaseId: null, generationLockedUntil: null })
      .where(and(eq(rooms.id, room.id), eq(rooms.generationLeaseId, leaseId)));
    throw new RoomError(
      "You have reached the current synthesis cooldown or daily founder limit.",
      429,
    );
  }
  return { roomId: room.id, leaseId, userId: identity.id };
}

export async function releaseGenerationLease(
  roomId: string,
  leaseId: string,
  userId: string,
) {
  const db = getDb();
  await db.batch([
    db
      .update(rooms)
      .set({
        generationLeaseId: null,
        generationLockedUntil: null,
        lastGeneratedAt: nowSql(),
      })
      .where(and(eq(rooms.id, roomId), eq(rooms.generationLeaseId, leaseId))),
    db
      .update(users)
      .set({ lastGeneratedAt: nowSql() })
      .where(eq(users.id, userId)),
  ]);
}

function serializeBuild(
  build: typeof builds.$inferSelect | undefined,
  files: Array<typeof buildFiles.$inferSelect> = [],
) {
  if (!build) return null;
  return {
    id: build.id,
    version: build.version,
    status: build.status,
    sourceKind: build.sourceKind,
    agentLabel: build.agentLabel,
    name: build.name,
    proposalTitle: build.proposalTitle,
    rationale: build.rationale,
    summary: build.summary,
    changes: parseStringArray(build.changesJson),
    sourceMessageIds: parseStringArray(build.sourceMessageIdsJson),
    html: build.html,
    createdBy: build.createdBy,
    parentBuildId: build.parentBuildId,
    createdAt: build.createdAt,
    publishedAt: build.publishedAt,
    files: files
      .filter((file) => file.buildId === build.id)
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((file) => ({
        path: file.path,
        content: file.content,
        language: file.language,
        sha256: file.sha256,
        byteCount: file.byteCount,
      })),
  };
}

export async function getRoomState(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();

  const [
    messageRows,
    memberRows,
    historyBuildRows,
    activeBuildRows,
    roomRows,
    forkCountRows,
    parentRoomRows,
    branchRoomRows,
    personalAgentRows,
    assetRows,
  ] = await Promise.all([
      db
        .select({
          id: messages.id,
          body: messages.body,
          createdAt: messages.createdAt,
          authorId: messages.authorId,
          authorName: users.displayName,
        })
        .from(messages)
        .innerJoin(users, eq(messages.authorId, users.id))
        .where(eq(messages.roomId, room.id))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(100),
      db
        .select({
          id: users.id,
          displayName: users.displayName,
          role: roomMembers.role,
          lastSeenAt: roomMembers.lastSeenAt,
        })
        .from(roomMembers)
        .innerJoin(users, eq(roomMembers.userId, users.id))
        .where(eq(roomMembers.roomId, room.id))
        .orderBy(asc(roomMembers.joinedAt)),
      db
        .select()
        .from(builds)
        .where(eq(builds.roomId, room.id))
        .orderBy(desc(builds.version), desc(builds.createdAt))
        .limit(20),
      db
        .select()
        .from(builds)
        .where(
          and(
            eq(builds.roomId, room.id),
            sql`${builds.status} IN ('published', 'staged')`,
          ),
        )
        .orderBy(desc(builds.version), desc(builds.createdAt)),
      db
        .select({
          slug: rooms.slug,
          name: rooms.name,
          updatedAt: rooms.updatedAt,
          role: roomMembers.role,
        })
        .from(roomMembers)
        .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
        .where(eq(roomMembers.userId, identity.id))
        .orderBy(desc(rooms.updatedAt))
        .limit(20),
      db
        .select({ count: sql<number>`count(*)` })
        .from(rooms)
        .where(eq(rooms.parentRoomId, room.id)),
      db
        .select({
          slug: rooms.slug,
          name: rooms.name,
          updatedAt: rooms.updatedAt,
        })
        .from(roomMembers)
        .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
        .where(
          and(
            eq(roomMembers.userId, identity.id),
            eq(rooms.id, room.parentRoomId ?? ""),
          ),
        )
        .limit(1),
      db
        .select({
          slug: rooms.slug,
          name: rooms.name,
          updatedAt: rooms.updatedAt,
          ownerName: users.displayName,
          role: roomMembers.role,
          presentedAt: rooms.presentedAt,
        })
        .from(rooms)
        .innerJoin(users, eq(rooms.ownerId, users.id))
        .leftJoin(
          roomMembers,
          and(
            eq(roomMembers.roomId, rooms.id),
            eq(roomMembers.userId, identity.id),
          ),
        )
        .where(eq(rooms.parentRoomId, room.id))
        .orderBy(desc(rooms.updatedAt)),
      db
        .select({
          id: agentTokens.id,
          name: agentTokens.name,
          tokenPrefix: agentTokens.tokenPrefix,
          createdAt: agentTokens.createdAt,
          lastUsedAt: agentTokens.lastUsedAt,
          revokedAt: agentTokens.revokedAt,
        })
        .from(agentTokens)
        .where(eq(agentTokens.userId, identity.id))
        .orderBy(desc(agentTokens.createdAt))
        .limit(12),
      db
        .select({
          asset: projectAssets,
          uploaderName: users.displayName,
        })
        .from(projectAssets)
        .innerJoin(users, eq(projectAssets.uploadedBy, users.id))
        .where(eq(projectAssets.roomId, room.id))
        .orderBy(desc(projectAssets.createdAt), desc(projectAssets.id))
        .limit(MAX_ASSETS_PER_ROOM),
    ]);

  const published = activeBuildRows.find((build) => build.status === "published");
  const staged = activeBuildRows.find((build) => build.status === "staged");
  const activeFileRows = (
    await Promise.all(
      [published, staged]
        .filter((build): build is typeof builds.$inferSelect => Boolean(build))
        .map((build) => ensureBuildFiles(build)),
    )
  ).flat();
  let voteCount = 0;
  let myVote = false;
  let voterIds: string[] = [];

  if (staged) {
    const voteRows = await db
      .select({ userId: votes.userId })
      .from(votes)
      .where(eq(votes.buildId, staged.id));
    voterIds = voteRows.map((vote) => vote.userId);
    voteCount = voterIds.length;
    myVote = voterIds.includes(identity.id);
  }

  const showcase = (
    await Promise.all(
      branchRoomRows
        .filter((branch) => Boolean(branch.presentedAt))
        .slice(0, 6)
        .map(async (branch) => {
          const [showcaseBuild] = await db
            .select()
            .from(builds)
            .innerJoin(rooms, eq(builds.roomId, rooms.id))
            .where(
              and(
                eq(rooms.slug, branch.slug),
                eq(builds.status, "published"),
              ),
            )
            .orderBy(desc(builds.version))
            .limit(1);
          if (!showcaseBuild) return null;
          const files = await ensureBuildFiles(showcaseBuild.builds);
          return {
            slug: branch.slug,
            name: branch.name,
            ownerName: branch.ownerName,
            presentedAt: branch.presentedAt!,
            build: serializeBuild(showcaseBuild.builds, files),
          };
        }),
    )
  ).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  const threshold = Math.max(1, Math.floor(memberRows.length / 2) + 1);

  return {
    room: {
      id: room.id,
      slug: room.slug,
      name: room.name,
      note: room.note,
      revision: room.revision,
      parentRoomId: room.parentRoomId,
      parentRoom: parentRoomRows[0] ?? null,
      presentedAt: room.presentedAt,
      forkCount: Number(forkCountRows[0]?.count ?? 0),
      canInvite: room.ownerId === identity.id,
      isCore: Boolean(process.env.CORE_ROOM_SLUG && room.slug === process.env.CORE_ROOM_SLUG),
    },
    user: identity,
    rooms: roomRows,
    branches: branchRoomRows,
    showcase,
    messages: messageRows.reverse(),
    members: memberRows.map((member) => ({
      ...member,
      online:
        Date.now() - new Date(`${member.lastSeenAt.replace(" ", "T")}Z`).getTime() <
        120_000,
    })),
    published: serializeBuild(published, activeFileRows),
    staged: serializeBuild(staged, activeFileRows),
    activity: historyBuildRows.slice(0, 8).map((build) => ({
      id: build.id,
      version: build.version,
      status: build.status,
      title: build.proposalTitle,
      summary: build.summary,
      createdAt: build.createdAt,
    })),
    votes: { count: voteCount, myVote, threshold, voterIds },
    agentTokens: personalAgentRows,
    assets: assetRows.map((row) => ({
      ...serializeAsset(row.asset, row.uploaderName),
      canDelete: row.asset.uploadedBy === identity.id || room.ownerId === identity.id,
    })),
    model: {
      configured: isKimiConfigured(),
      name: process.env.AI_MODEL ?? "kimi-k2.5",
    },
  };
}

export async function getAgentProjectSnapshot(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [activeRows, messageRows, assetRows] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(
        and(
          eq(builds.roomId, room.id),
          sql`${builds.status} IN ('published', 'staged')`,
        ),
      )
      .orderBy(desc(builds.version)),
    db
      .select({
        body: messages.body,
        author: users.displayName,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(eq(messages.roomId, room.id))
      .orderBy(desc(messages.createdAt))
      .limit(30),
    db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.roomId, room.id))
      .orderBy(desc(projectAssets.createdAt)),
  ]);
  const base = activeRows.find((build) => build.status === "staged") ??
    activeRows.find((build) => build.status === "published");
  if (!base) throw new RoomError("This room has no project snapshot yet.", 409);
  const files = await ensureBuildFiles(base);
  return {
    room: {
      slug: room.slug,
      name: room.name,
      note: room.note,
      revision: room.revision,
    },
    baseBuild: {
      id: base.id,
      version: base.version,
      status: base.status,
      sourceKind: base.sourceKind,
    },
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
      language: file.language,
      sha256: file.sha256,
      byteCount: file.byteCount,
    })),
    recentConversation: messageRows.reverse(),
    assets: assetRows.map((asset) => ({
      ...serializeAsset(asset),
      readEndpoint: `/api/assets?room=${encodeURIComponent(room.slug)}&asset=${encodeURIComponent(asset.id)}`,
    })),
    submit: {
      method: "POST",
      endpoint: "/api/agent",
      required: ["room", "expectedRevision", "baseBuildId", "changes"],
      changeShape: { path: "relative/file.txt", content: "complete replacement or null" },
      note: "A submission stages one immutable proposal. It never publishes without room review.",
    },
  };
}

export async function getExportProjectSnapshot(
  slugValue: string,
  identity: Identity,
  requestedStatus: "published" | "staged",
) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [build] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, room.id), eq(builds.status, requestedStatus)))
    .orderBy(desc(builds.version))
    .limit(1);
  if (!build) {
    throw new RoomError(
      requestedStatus === "staged"
        ? "This room has no staged proposal to export."
        : "This room has no published project to export.",
      404,
    );
  }
  return {
    room: { slug: room.slug, name: room.name, revision: room.revision },
    build: { id: build.id, version: build.version, status: build.status },
    files: asArtifactSourceFiles(await ensureBuildFiles(build)),
    assets: await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.roomId, room.id))
      .orderBy(asc(projectAssets.name), asc(projectAssets.id)),
  };
}

export async function getPlayableProjectSnapshot(
  slugValue: string,
  identity: Identity,
  requestedBuildId?: string,
) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  const slug = normalizeSlug(slugValue);
  const [room] = await db.select().from(rooms).where(eq(rooms.slug, slug)).limit(1);
  if (!room) throw new RoomError("That playable room does not exist.", 404);

  const [membership] = await db
    .select({ role: roomMembers.role })
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, room.id), eq(roomMembers.userId, identity.id)))
    .limit(1);
  let presentedViewer = false;
  if (!membership) {
    if (!room.parentRoomId || !room.presentedAt) {
      throw new RoomError("You need room access before playing this build.", 403);
    }
    const [parentMembership] = await db
      .select({ role: roomMembers.role })
      .from(roomMembers)
      .where(
        and(
          eq(roomMembers.roomId, room.parentRoomId),
          eq(roomMembers.userId, identity.id),
        ),
      )
      .limit(1);
    if (!parentMembership) throw new RoomError("You need parent-room access before playing this fork.", 403);
    presentedViewer = true;
  }

  const conditions = [eq(builds.roomId, room.id)];
  if (requestedBuildId?.trim()) conditions.push(eq(builds.id, requestedBuildId.trim()));
  if (presentedViewer) conditions.push(eq(builds.status, "published"));
  else conditions.push(sql`${builds.status} IN ('published', 'staged')`);
  const [build] = await db
    .select()
    .from(builds)
    .where(and(...conditions))
    .orderBy(desc(builds.version), desc(builds.createdAt))
    .limit(1);
  if (!build) throw new RoomError("That playable build is no longer available.", 404);

  return {
    room: { slug: room.slug, name: room.name },
    build: { id: build.id, version: build.version, status: build.status, name: build.name },
    files: asArtifactSourceFiles(await ensureBuildFiles(build)),
    assets: await db
      .select()
      .from(projectAssets)
      .where(eq(projectAssets.roomId, room.id))
      .orderBy(asc(projectAssets.createdAt), asc(projectAssets.id)),
  };
}

export async function createPlaytestLink(
  slugValue: string,
  identity: Identity,
  rawLabel: string,
) {
  const room = await getRoomForUser(slugValue, identity);
  if (room.ownerId !== identity.id) throw new RoomError("Only the room owner can create public playtests.", 403);
  const db = getDb();
  const [build] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, room.id), eq(builds.status, "published")))
    .orderBy(desc(builds.version))
    .limit(1);
  if (!build) throw new RoomError("Publish a build before sharing a playtest.", 409);
  const [count] = await db
    .select({ count: sql<number>`count(*)` })
    .from(playtestLinks)
    .where(and(eq(playtestLinks.roomId, room.id), isNull(playtestLinks.revokedAt)));
  if (Number(count?.count ?? 0) >= 12) throw new RoomError("Revoke an older playtest link first.", 409);
  const token = `play_${randomToken()}`;
  const link = {
    id: crypto.randomUUID(),
    roomId: room.id,
    buildId: build.id,
    createdBy: identity.id,
    label: cleanText(rawLabel, 60) || `Playtest v${build.version}`,
    tokenHash: await sha256(token),
    tokenPrefix: `${token.slice(0, 14)}…`,
    expiresAt: sql<string>`datetime('now', '+14 days')`,
  };
  await db.insert(playtestLinks).values(link);
  return { token, buildVersion: build.version, label: link.label };
}

export async function revokePlaytestLink(slugValue: string, identity: Identity, linkId: string) {
  const room = await getRoomForUser(slugValue, identity);
  if (room.ownerId !== identity.id) throw new RoomError("Only the room owner can revoke playtests.", 403);
  await getDb()
    .update(playtestLinks)
    .set({ revokedAt: nowSql() })
    .where(and(eq(playtestLinks.id, linkId.trim()), eq(playtestLinks.roomId, room.id)));
}

export async function getPlaytestDashboard(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const links = await db
    .select({
      id: playtestLinks.id,
      label: playtestLinks.label,
      tokenPrefix: playtestLinks.tokenPrefix,
      buildId: playtestLinks.buildId,
      version: builds.version,
      expiresAt: playtestLinks.expiresAt,
      revokedAt: playtestLinks.revokedAt,
      createdAt: playtestLinks.createdAt,
    })
    .from(playtestLinks)
    .innerJoin(builds, eq(playtestLinks.buildId, builds.id))
    .where(eq(playtestLinks.roomId, room.id))
    .orderBy(desc(playtestLinks.createdAt))
    .limit(30);
  const feedback = await db
    .select({
      id: playtestFeedback.id,
      linkId: playtestFeedback.linkId,
      displayName: playtestFeedback.displayName,
      rating: playtestFeedback.rating,
      body: playtestFeedback.body,
      createdAt: playtestFeedback.createdAt,
    })
    .from(playtestFeedback)
    .innerJoin(playtestLinks, eq(playtestFeedback.linkId, playtestLinks.id))
    .where(eq(playtestLinks.roomId, room.id))
    .orderBy(desc(playtestFeedback.createdAt))
    .limit(100);
  return { canManage: room.ownerId === identity.id, links, feedback };
}

export async function getPublicPlaytestSnapshot(rawToken: string) {
  await ensureDatabase();
  const token = rawToken.trim();
  if (!/^play_[0-9a-f]{64}$/.test(token)) throw new RoomError("That playtest link is invalid.", 404);
  const db = getDb();
  const [link] = await db
    .select({
      id: playtestLinks.id,
      label: playtestLinks.label,
      roomId: playtestLinks.roomId,
      roomSlug: rooms.slug,
      roomName: rooms.name,
      buildId: playtestLinks.buildId,
      expiresAt: playtestLinks.expiresAt,
      revokedAt: playtestLinks.revokedAt,
    })
    .from(playtestLinks)
    .innerJoin(rooms, eq(playtestLinks.roomId, rooms.id))
    .where(and(
      eq(playtestLinks.tokenHash, await sha256(token)),
      isNull(playtestLinks.revokedAt),
      sql`${playtestLinks.expiresAt} > CURRENT_TIMESTAMP`,
    ))
    .limit(1);
  if (!link) throw new RoomError("That playtest expired or was revoked.", 404);
  const [build] = await db.select().from(builds).where(eq(builds.id, link.buildId)).limit(1);
  if (!build) throw new RoomError("That playable build is unavailable.", 404);
  return {
    link: { id: link.id, label: link.label, expiresAt: link.expiresAt },
    room: { slug: link.roomSlug, name: link.roomName },
    build: { id: build.id, version: build.version, status: build.status, name: build.name },
    files: asArtifactSourceFiles(await ensureBuildFiles(build)),
    assets: await db.select().from(projectAssets).where(eq(projectAssets.roomId, link.roomId)).orderBy(asc(projectAssets.createdAt)),
  };
}

export async function submitPlaytestFeedback(
  rawToken: string,
  input: { displayName: string; rating: number; body: string },
) {
  const snapshot = await getPublicPlaytestSnapshot(rawToken);
  const rating = Number(input.rating);
  const body = cleanText(input.body, 1200);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !body) {
    throw new RoomError("Add a 1–5 rating and a short playtest note.");
  }
  const db = getDb();
  const [count] = await db
    .select({ count: sql<number>`count(*)` })
    .from(playtestFeedback)
    .where(eq(playtestFeedback.linkId, snapshot.link.id));
  if (Number(count?.count ?? 0) >= 250) throw new RoomError("This playtest has collected enough feedback.", 409);
  await db.insert(playtestFeedback).values({
    id: crypto.randomUUID(),
    linkId: snapshot.link.id,
    displayName: cleanText(input.displayName, 60) || "Playtester",
    rating,
    body,
  });
}

export async function addMessage(
  slugValue: string,
  identity: Identity,
  rawBody: string,
) {
  const room = await getRoomForUser(slugValue, identity);
  const body = cleanText(rawBody, 1200);
  if (!body) throw new RoomError("Write something before sending it.");

  const db = getDb();
  await db.batch([
    db.insert(messages).values({
      id: crypto.randomUUID(),
      roomId: room.id,
      authorId: identity.id,
      body,
    }),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(eq(rooms.id, room.id)),
  ]);
}

export async function addContextCapsule(
  slugValue: string,
  identity: Identity,
  input: { agentLabel?: string; files?: string[]; summary?: string; recommendation?: string },
) {
  const agentLabel = cleanText(input.agentLabel ?? "Human context", 80) || "Human context";
  const files = (input.files ?? [])
    .filter((path): path is string => typeof path === "string")
    .map((path) => cleanText(path, 120))
    .filter(Boolean)
    .slice(0, 12);
  const summary = cleanText(input.summary ?? "", 1200);
  const recommendation = cleanText(input.recommendation ?? "", 600);
  if (!summary) throw new RoomError("Add the useful context your teammate or AI found.");
  await addMessage(
    slugValue,
    identity,
    [
      "[CONTEXT CAPSULE]",
      `SOURCE: ${agentLabel}`,
      `FILES: ${files.length ? files.join(", ") : "whole project"}`,
      `FOUND: ${summary}`,
      `NEXT: ${recommendation || "Compare this with the room before deciding."}`,
    ].join("\n"),
  );
}

const contributionKinds = new Set(["context", "patch", "asset", "test", "fork"]);
const contributionReactionsAllowed = new Set(["useful", "test", "implement", "clarify"]);
const contributionRelations = new Set(["supports", "conflicts", "supersedes", "implements", "tests"]);

export async function createContribution(
  slugValue: string,
  identity: Identity,
  input: {
    kind?: string;
    providerLabel?: string;
    title?: string;
    summary?: string;
    recommendation?: string;
    files?: string[];
    lineRefs?: Array<{ path: string; start: number; end?: number }>;
    payload?: Record<string, unknown>;
    baseBuildId?: string;
    parentContributionId?: string;
    share?: boolean;
  },
) {
  const room = await getRoomForUser(slugValue, identity);
  const kind = contributionKinds.has(input.kind ?? "") ? input.kind! : "context";
  const title = cleanText(input.title ?? "Untitled contribution", 100);
  const summary = cleanText(input.summary ?? "", 2000);
  if (!summary) throw new RoomError("Add a useful contribution before saving it.");
  const files = (input.files ?? []).filter((file): file is string => typeof file === "string")
    .map((file) => cleanText(file, 120)).filter(Boolean).slice(0, 20);
  const lineRefs = (input.lineRefs ?? []).filter((ref) => ref && typeof ref.path === "string")
    .slice(0, 30).map((ref) => ({
      path: cleanText(ref.path, 120),
      start: Math.max(1, Math.floor(Number(ref.start) || 1)),
      end: Math.max(1, Math.floor(Number(ref.end ?? ref.start) || 1)),
    }));
  const payloadJson = JSON.stringify(input.payload ?? {});
  if (payloadJson.length > 65_536) throw new RoomError("That contribution payload is too large.");
  const shared = input.share === true;
  const id = crypto.randomUUID();
  await getDb().insert(contributions).values({
    id,
    roomId: room.id,
    ownerId: identity.id,
    kind,
    visibility: shared ? "shared" : "private",
    status: shared ? "shared" : "inbox",
    providerLabel: cleanText(input.providerLabel ?? "Human", 80) || "Human",
    title: title || "Untitled contribution",
    summary,
    recommendation: cleanText(input.recommendation ?? "", 800),
    filesJson: JSON.stringify(files),
    lineRefsJson: JSON.stringify(lineRefs),
    payloadJson,
    baseBuildId: cleanText(input.baseBuildId ?? "", 80) || null,
    parentContributionId: cleanText(input.parentContributionId ?? "", 80) || null,
    sharedAt: shared ? nowSql() : null,
  });
  return id;
}

export async function listContributions(slugValue: string, identity: Identity, query = "") {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const search = cleanText(query, 120).toLowerCase();
  const [rows, reactionRows, linkRows] = await Promise.all([
    db.select({
      id: contributions.id,
      ownerId: contributions.ownerId,
      ownerName: users.displayName,
      kind: contributions.kind,
      visibility: contributions.visibility,
      status: contributions.status,
      providerLabel: contributions.providerLabel,
      title: contributions.title,
      summary: contributions.summary,
      recommendation: contributions.recommendation,
      filesJson: contributions.filesJson,
      lineRefsJson: contributions.lineRefsJson,
      payloadJson: contributions.payloadJson,
      baseBuildId: contributions.baseBuildId,
      parentContributionId: contributions.parentContributionId,
      createdAt: contributions.createdAt,
      updatedAt: contributions.updatedAt,
      sharedAt: contributions.sharedAt,
    }).from(contributions).innerJoin(users, eq(contributions.ownerId, users.id))
      .where(and(eq(contributions.roomId, room.id), or(ne(contributions.visibility, "private"), eq(contributions.ownerId, identity.id))))
      .orderBy(desc(contributions.createdAt)).limit(200),
    db.select().from(contributionReactions),
    db.select().from(contributionLinks),
  ]);
  return rows.filter((row) => !search || [row.title, row.summary, row.recommendation, row.providerLabel, row.filesJson]
    .some((value) => value.toLowerCase().includes(search))).map((row) => ({
      ...row,
      files: parseStringArray(row.filesJson),
      lineRefs: (() => { try { return JSON.parse(row.lineRefsJson); } catch { return []; } })(),
      payload: (() => { try { return JSON.parse(row.payloadJson); } catch { return {}; } })(),
      mine: row.ownerId === identity.id,
      reactions: reactionRows.filter((reaction) => reaction.contributionId === row.id),
      links: linkRows.filter((link) => link.sourceId === row.id || link.targetId === row.id),
    }));
}

export async function shareContribution(slugValue: string, identity: Identity, id: string) {
  const room = await getRoomForUser(slugValue, identity);
  const result = await getDb().update(contributions).set({ visibility: "shared", status: "shared", sharedAt: nowSql(), updatedAt: nowSql() })
    .where(and(eq(contributions.id, id), eq(contributions.roomId, room.id), eq(contributions.ownerId, identity.id))).returning({ id: contributions.id });
  if (!result[0]) throw new RoomError("That private contribution is unavailable.", 404);
}

export async function setContributionStatus(slugValue: string, identity: Identity, id: string, status: string) {
  const room = await getRoomForUser(slugValue, identity);
  const allowed = new Set(["backlog", "active", "review", "blocked"]);
  if (!allowed.has(status)) throw new RoomError("Choose a valid board lane.");
  const result = await getDb().update(contributions).set({ payloadJson: JSON.stringify({ boardLane: status }), updatedAt: nowSql() })
    .where(and(eq(contributions.id, id), eq(contributions.roomId, room.id), ne(contributions.visibility, "private")))
    .returning({ id: contributions.id });
  if (!result[0]) throw new RoomError("That shared board item is unavailable.", 404);
}

export async function getCoreProposalForRelease(slugValue: string, identity: Identity, id: string) {
  const room = await getRoomForUser(slugValue, identity);
  if (room.ownerId !== identity.id) throw new RoomError("Only the Core Studio owner can promote a proposal.", 403);
  const db = getDb();
  const [proposal] = await db.select({
    id: contributions.id,
    providerLabel: contributions.providerLabel,
    kind: contributions.kind,
    visibility: contributions.visibility,
    payloadJson: contributions.payloadJson,
  }).from(contributions).where(and(eq(contributions.id, id), eq(contributions.roomId, room.id))).limit(1);
  if (!proposal || proposal.providerLabel !== "Core repository" || proposal.kind !== "patch" || proposal.visibility === "private") throw new RoomError("That Core Studio proposal is unavailable.", 404);
  let payload: { repository?: string; branch?: string; commitSha?: string } = {};
  try { payload = JSON.parse(proposal.payloadJson); } catch { /* invalid proposal metadata is rejected below */ }
  if (!payload.branch || !payload.commitSha || !payload.repository) throw new RoomError("That proposal is missing its protected repository metadata.", 409);
  const [memberCount, voteCount] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(roomMembers).where(eq(roomMembers.roomId, room.id)),
    db.select({ count: sql<number>`count(*)` }).from(contributionReactions).where(and(eq(contributionReactions.contributionId, proposal.id), eq(contributionReactions.reaction, "useful"))),
  ]);
  const threshold = Math.max(1, Math.floor(Number(memberCount[0]?.count ?? 0) / 2) + 1);
  const backing = Number(voteCount[0]?.count ?? 0);
  if (backing < threshold) throw new RoomError(`This Core proposal needs ${threshold} useful vote${threshold === 1 ? "" : "s"} before release.`, 409);
  return { ...payload, backing, threshold } as { repository: string; branch: string; commitSha: string; backing: number; threshold: number };
}

export async function toggleContributionReaction(slugValue: string, identity: Identity, id: string, reaction: string) {
  const room = await getRoomForUser(slugValue, identity);
  if (!contributionReactionsAllowed.has(reaction)) throw new RoomError("That reaction is not supported.");
  const db = getDb();
  const target = await db.select({ id: contributions.id }).from(contributions)
    .where(and(eq(contributions.id, id), eq(contributions.roomId, room.id), ne(contributions.visibility, "private"))).limit(1);
  if (!target[0]) throw new RoomError("That shared contribution is unavailable.", 404);
  const existing = await db.select().from(contributionReactions)
    .where(and(eq(contributionReactions.contributionId, id), eq(contributionReactions.userId, identity.id), eq(contributionReactions.reaction, reaction))).limit(1);
  if (existing[0]) await db.delete(contributionReactions).where(and(eq(contributionReactions.contributionId, id), eq(contributionReactions.userId, identity.id), eq(contributionReactions.reaction, reaction)));
  else await db.insert(contributionReactions).values({ contributionId: id, userId: identity.id, reaction });
}

export async function linkContributions(slugValue: string, identity: Identity, sourceId: string, targetId: string, relation: string) {
  const room = await getRoomForUser(slugValue, identity);
  if (sourceId === targetId || !contributionRelations.has(relation)) throw new RoomError("Choose two contributions and a valid relationship.");
  const visible = await getDb().select({ id: contributions.id }).from(contributions)
    .where(and(eq(contributions.roomId, room.id), ne(contributions.visibility, "private"), or(eq(contributions.id, sourceId), eq(contributions.id, targetId))));
  if (new Set(visible.map((row) => row.id)).size !== 2) throw new RoomError("Both linked contributions must be shared.", 404);
  await getDb().insert(contributionLinks).values({ sourceId, targetId, relation, createdBy: identity.id }).onConflictDoNothing();
}

export async function createRoom(
  identity: Identity,
  rawName: string,
  template: ProjectTemplate = "app",
) {
  await ensureDatabase();
  await upsertUser(identity);
  const name = cleanText(rawName, 50);
  if (name.length < 2) throw new RoomError("Give the room a short name.");

  const db = getDb();
  const id = crypto.randomUUID();
  const slugBase = normalizeSlug(name) || "room";
  const slug = `${slugBase}-${id.slice(0, 6)}`;
  const buildId = crypto.randomUUID();
  const projectTemplate: ProjectTemplate = template === "game" ? "game" : "app";
  const source = makeStarterProject(name, projectTemplate);
  const fileRows = await sourceRows(buildId, source);
  await db.batch([
    db.insert(rooms).values({
      id,
      slug,
      name,
      note:
        projectTemplate === "game"
          ? `Building and playtesting ${name} together.`
          : `Building ${name} together.`,
      ownerId: identity.id,
    }),
    db.insert(roomMembers).values({ roomId: id, userId: identity.id, role: "owner" }),
    db.insert(builds).values({
      id: buildId,
      roomId: id,
      version: 1,
      status: "published",
      sourceKind: "starter",
      name,
      proposalTitle: projectTemplate === "game" ? "Playable game starter" : "Starter application",
      rationale: "A room needs something real to play with or use before the first proposal.",
      summary:
        projectTemplate === "game"
          ? "A playable Phaser 4.2 project with team work lanes."
          : "A small interactive application starting point.",
      changesJson: JSON.stringify(
        projectTemplate === "game"
          ? ["Created a playable game", "Opened logic, world, art, audio, and playtest lanes", "Started the build history"]
          : ["Created the room", "Added a working application", "Opened the build history"],
      ),
      sourceMessageIdsJson: "[]",
      html: assembleArtifactFiles(source, name),
      createdBy: identity.id,
      publishedAt: nowSql(),
    }),
    db.insert(buildFiles).values(fileRows),
  ]);
  return slug;
}

export async function editArtifactFile(
  slugValue: string,
  identity: Identity,
  input: {
    path: string;
    content: string | null;
    expectedRevision: number;
    baseBuildId: string;
    agentLabel?: string;
  },
) {
  return stageAgentProjectPatch(slugValue, identity, {
    changes: [{ path: input.path, content: input.content }],
    expectedRevision: input.expectedRevision,
    baseBuildId: input.baseBuildId,
    agentLabel: input.agentLabel,
  });
}

export async function stageAgentProjectPatch(
  slugValue: string,
  identity: Identity,
  input: {
    changes: Array<{ path: string; content: string | null }>;
    expectedRevision: number;
    baseBuildId: string;
    agentLabel?: string;
    title?: string;
    summary?: string;
    sourceKind?: "personal-agent" | "project-agent" | "convergence";
    rationale?: string;
    changeNotes?: string[];
  },
) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RoomError("The source revision is invalid.");
  }
  if (!input.baseBuildId.trim()) {
    throw new RoomError("The source build is missing.");
  }
  if (!Array.isArray(input.changes) || input.changes.length < 1 || input.changes.length > 40) {
    throw new RoomError("An agent proposal must change 1–40 project files.");
  }
  const changes = input.changes.map((change) => {
    if (!change || typeof change !== "object") {
      throw new RoomError("Every project change needs a path and content.");
    }
    let path: string;
    try {
      path = validateArtifactPath(change.path);
    } catch (error) {
      throw new RoomError(error instanceof Error ? error.message : "That file path is invalid.");
    }
    if (change.content !== null && typeof change.content !== "string") {
      throw new RoomError(`${path} must contain plain text or null for deletion.`);
    }
    return { path, content: change.content };
  });
  if (new Set(changes.map((change) => change.path)).size !== changes.length) {
    throw new RoomError("An agent proposal cannot change the same path twice.");
  }
  const isConvergence = input.sourceKind === "convergence";
  const isProjectAgent = input.sourceKind === "project-agent";
  const isPersonalAgent = !isConvergence && !isProjectAgent && Boolean(input.agentLabel?.trim());
  const agentLabel = isConvergence
    ? "Convergence agent"
    : isProjectAgent
    ? "Shared project AI"
    : isPersonalAgent
    ? cleanText(input.agentLabel!, 80) || "Personal agent"
    : "Shared editor";
  const suppliedChangeNotes = Array.isArray(input.changeNotes)
    ? input.changeNotes
        .filter((note): note is string => typeof note === "string")
        .map((note) => cleanText(note, 140))
        .filter(Boolean)
        .slice(0, 12)
    : [];

  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  if (!input.sourceKind) {
    for (const change of changes) {
      const [lease] = await db
        .select({ userId: fileLeases.userId, displayName: users.displayName })
        .from(fileLeases)
        .innerJoin(users, eq(fileLeases.userId, users.id))
        .where(and(
          eq(fileLeases.roomId, room.id),
          eq(fileLeases.path, change.path),
          sql`${fileLeases.expiresAt} >= CURRENT_TIMESTAMP`,
        ))
        .limit(1);
      if (lease && lease.userId !== identity.id) {
        throw new RoomError(`${lease.displayName} owns ${change.path} right now. Wait for the live lease or work in a fork.`, 423);
      }
    }
  }
  const [publishedRows, stagedRows, maxVersionRows] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
      .orderBy(desc(builds.createdAt))
      .limit(1),
    db
      .select({ value: sql<number>`max(${builds.version})` })
      .from(builds)
      .where(eq(builds.roomId, room.id)),
  ]);
  const published = publishedRows[0];
  const staged = stagedRows[0];
  const base = staged ?? published;
  if (!published || !base) {
    throw new RoomError("Publish a starting build before editing source.", 409);
  }
  if (
    room.revision !== input.expectedRevision ||
    base.id !== input.baseBuildId
  ) {
    throw new RoomError(
      "Someone changed this room while you were editing. Your draft is still here; reload the latest source before saving.",
      409,
    );
  }

  const baseFiles = asArtifactSourceFiles(await ensureBuildFiles(base));
  const nextByPath = new Map(baseFiles.map((file) => [file.path, file]));
  const changeLabels: string[] = [];
  for (const change of changes) {
    const existing = nextByPath.get(change.path);
    if (change.content === null) {
      if (change.path === "index.html" || change.path === "styles.css") {
        throw new RoomError("index.html and styles.css are required project files.");
      }
      if (!existing) throw new RoomError(`${change.path} no longer exists.`, 409);
      nextByPath.delete(change.path);
      changeLabels.push(`Removed ${change.path}`);
      continue;
    }
    nextByPath.set(change.path, {
      path: change.path,
      content: change.content,
      language: inferArtifactLanguage(change.path),
    });
    changeLabels.push(`${existing ? "Changed" : "Added"} ${change.path}`);
  }
  let nextFiles: ArtifactSourceFile[];
  let html: string;
  try {
    nextFiles = validateArtifactFiles(Array.from(nextByPath.values()));
    html = assembleArtifactFiles(nextFiles, base.name);
  } catch (error) {
    throw new RoomError(
      error instanceof Error
        ? error.message
        : "The source patch failed safety validation.",
    );
  }
  if (nextFiles.every((file, index) =>
    file.path === baseFiles[index]?.path && file.content === baseFiles[index]?.content
  )) {
    throw new RoomError("The agent proposal did not change the project.", 409);
  }

  const buildId = crypto.randomUUID();
  const nextVersion = Number(maxVersionRows[0]?.value ?? 0) + 1;
  if (nextVersion > MAX_BUILDS_PER_ROOM) {
    throw new RoomError(
      "This room reached the founder source-history limit. Fork the published app to keep building.",
      409,
    );
  }
  const fileRows = await sourceRows(buildId, nextFiles);
  const sourceMessageIdsJson = base.sourceMessageIdsJson;
  const roomIsCurrent = sql`EXISTS (
    SELECT 1 FROM rooms
    WHERE id = ${room.id} AND revision = ${input.expectedRevision}
  )`;
  const stagedBuild = db
    .select({
      id: sql<string>`${buildId}`.as("id"),
      roomId: sql<string>`${room.id}`.as("room_id"),
      version: sql<number>`${nextVersion}`.as("version"),
      status: sql<string>`${"staged"}`.as("status"),
      sourceKind: sql<string>`${isConvergence ? "convergence" : isProjectAgent ? "project-agent" : isPersonalAgent ? "personal-agent" : "manual"}`.as("source_kind"),
      agentLabel: sql<string | null>`${isPersonalAgent || isProjectAgent || isConvergence ? agentLabel : null}`.as("agent_label"),
      name: sql<string>`${base.name}`.as("name"),
      proposalTitle: sql<string>`${cleanText(input.title ?? `${agentLabel}: ${changes.length} file proposal`, 100)}`.as("proposal_title"),
      rationale: sql<string>`${cleanText(input.rationale ?? (isConvergence ? `${agentLabel} compared the team's presented forks and submitted one combined patch for room review.` : isPersonalAgent || isProjectAgent ? `${identity.displayName}'s ${agentLabel} submitted a whole-project patch for room review.` : `${identity.displayName} saved a source-level change for the room to review.`), 500)}`.as("rationale"),
      summary: sql<string>`${cleanText(input.summary ?? `${changes.length} project file${changes.length === 1 ? "" : "s"} proposed by ${agentLabel}.`, 240)}`.as("summary"),
      changesJson: sql<string>`${JSON.stringify([
        ...(suppliedChangeNotes.length > 0 ? suppliedChangeNotes : changeLabels.slice(0, 12)),
        "Created one immutable whole-project snapshot",
        "Reset backing so the room can review this exact patch",
      ])}`.as("changes_json"),
      sourceMessageIdsJson: sql<string>`${sourceMessageIdsJson}`.as(
        "source_message_ids_json",
      ),
      html: sql<string>`${html}`.as("html"),
      createdBy: sql<string>`${identity.id}`.as("created_by"),
      parentBuildId: sql<string>`${base.id}`.as("parent_build_id"),
      createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      publishedAt: sql<string | null>`${null}`.as("published_at"),
    })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, room.id),
        eq(rooms.revision, input.expectedRevision),
      ),
    )
    .limit(1);
  const stagedFileRows = fileRows.map((file) =>
    db
      .select({
        buildId: sql<string>`${buildId}`.as("build_id"),
        path: sql<string>`${file.path}`.as("path"),
        content: sql<string>`${file.content}`.as("content"),
        language: sql<string>`${file.language}`.as("language"),
        sha256: sql<string>`${file.sha256}`.as("sha256"),
        byteCount: sql<number>`${file.byteCount}`.as("byte_count"),
        createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1),
  );

  await db.batch([
    db
      .update(builds)
      .set({ status: "superseded" })
      .where(
        and(
          eq(builds.roomId, room.id),
          eq(builds.status, "staged"),
          staged ? eq(builds.id, staged.id) : sql`0`,
          roomIsCurrent,
        ),
      ),
    db.insert(builds).select(stagedBuild),
    ...stagedFileRows.map((row) => db.insert(buildFiles).select(row)),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(
        and(
          eq(rooms.id, room.id),
          eq(rooms.revision, input.expectedRevision),
          sql`EXISTS (
            SELECT 1 FROM builds
            WHERE id = ${buildId} AND room_id = ${room.id} AND status = 'staged'
          )`,
        ),
      ),
  ]);

  const [saved] = await db
    .select({
      id: builds.id,
      files: sql<number>`(
        SELECT count(*) FROM build_files WHERE build_id = ${buildId}
      )`,
    })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.status, "staged")))
    .limit(1);
  if (!saved || Number(saved.files) !== nextFiles.length) {
    throw new RoomError(
      "Someone changed this room while you were editing. Your draft is still here; reload the latest source before saving.",
      409,
    );
  }
}

export async function toggleVote(
  slugValue: string,
  identity: Identity,
  expected: { roomRevision: number; buildId: string },
) {
  if (!Number.isSafeInteger(expected.roomRevision) || expected.roomRevision < 0) {
    throw new RoomError("The vote revision is invalid.");
  }
  if (!expected.buildId.trim()) {
    throw new RoomError("The proposal to vote on is missing.");
  }
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [staged] = await db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.id, expected.buildId),
        eq(builds.roomId, room.id),
        eq(builds.status, "staged"),
      ),
    )
    .limit(1);
  if (!staged || room.revision !== expected.roomRevision) {
    throw new RoomError(
      "The proposal changed before your vote was recorded. Review the latest patch and try again.",
      409,
    );
  }

  const [existing] = await db
    .select()
    .from(votes)
    .where(and(eq(votes.buildId, staged.id), eq(votes.userId, identity.id)))
    .limit(1);
  const proposalIsCurrent = sql`EXISTS (
    SELECT 1 FROM rooms
    WHERE id = ${room.id} AND revision = ${expected.roomRevision}
  ) AND EXISTS (
    SELECT 1 FROM builds
    WHERE id = ${staged.id} AND room_id = ${room.id} AND status = 'staged'
  )`;
  let updatedRooms: Array<{ revision: number }>;
  if (existing) {
    const result = await db.batch([
      db
        .delete(votes)
        .where(
          and(
            eq(votes.buildId, staged.id),
            eq(votes.userId, identity.id),
            proposalIsCurrent,
          ),
        ),
      db
        .update(rooms)
        .set({ revision: sql`${rooms.revision} + 1` })
        .where(
          and(
            eq(rooms.id, room.id),
            eq(rooms.revision, expected.roomRevision),
            sql`EXISTS (
              SELECT 1 FROM builds
              WHERE id = ${staged.id} AND room_id = ${room.id} AND status = 'staged'
            )`,
          ),
        )
        .returning({ revision: rooms.revision }),
    ]);
    updatedRooms = result[1];
  } else {
    const guardedVote = db
      .select({
        buildId: sql<string>`${staged.id}`.as("build_id"),
        userId: sql<string>`${identity.id}`.as("user_id"),
        createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      })
      .from(rooms)
      .where(
        and(
          eq(rooms.id, room.id),
          eq(rooms.revision, expected.roomRevision),
          sql`EXISTS (
            SELECT 1 FROM builds
            WHERE id = ${staged.id} AND room_id = ${room.id} AND status = 'staged'
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM votes
            WHERE build_id = ${staged.id} AND user_id = ${identity.id}
          )`,
        ),
      )
      .limit(1);
    const result = await db.batch([
      db.insert(votes).select(guardedVote),
      db
        .update(rooms)
        .set({ revision: sql`${rooms.revision} + 1` })
        .where(
          and(
            eq(rooms.id, room.id),
            eq(rooms.revision, expected.roomRevision),
            sql`EXISTS (
              SELECT 1 FROM builds
              WHERE id = ${staged.id} AND room_id = ${room.id} AND status = 'staged'
            )`,
            sql`EXISTS (
              SELECT 1 FROM votes
              WHERE build_id = ${staged.id} AND user_id = ${identity.id}
            )`,
          ),
        )
        .returning({ revision: rooms.revision }),
    ]);
    updatedRooms = result[1];
  }
  if (updatedRooms.length !== 1) {
    throw new RoomError(
      "The proposal changed before your vote was recorded. Review the latest patch and try again.",
      409,
    );
  }
}

export async function shipBuild(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [staged] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
    .orderBy(desc(builds.createdAt))
    .limit(1);
  if (!staged) throw new RoomError("There is no staged build to ship.", 409);
  const stagedFiles = await ensureBuildFiles(staged);

  const [memberCountRow, voteCountRow] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)` })
      .from(roomMembers)
      .where(eq(roomMembers.roomId, room.id)),
    db
      .select({ count: sql<number>`count(*)` })
      .from(votes)
      .where(eq(votes.buildId, staged.id)),
  ]);
  const memberCount = Number(memberCountRow[0]?.count ?? 0);
  const voteCount = Number(voteCountRow[0]?.count ?? 0);
  const threshold = Math.max(1, Math.floor(memberCount / 2) + 1);
  if (voteCount < threshold) {
    throw new RoomError(`This patch needs ${threshold} vote${threshold === 1 ? "" : "s"} before it can ship.`, 409);
  }

  const stagedStillHasQuorum = sql`(
    SELECT count(*) FROM votes WHERE build_id = ${staged.id}
  ) >= ((
    SELECT count(*) FROM room_members WHERE room_id = ${room.id}
  ) / 2 + 1) AND (
    SELECT count(*) FROM build_files WHERE build_id = ${staged.id}
  ) = ${stagedFiles.length} AND EXISTS (
    SELECT 1 FROM rooms WHERE id = ${room.id} AND revision = ${room.revision}
  )`;
  await db.batch([
    db
      .update(builds)
      .set({ status: "archived" })
      .where(
        and(
          eq(builds.roomId, room.id),
          eq(builds.status, "published"),
          sql`EXISTS (
            SELECT 1 FROM builds AS candidate
            WHERE candidate.id = ${staged.id}
              AND candidate.room_id = ${room.id}
              AND candidate.status = 'staged'
              AND ${stagedStillHasQuorum}
          )`,
        ),
      ),
    db
      .update(builds)
      .set({ status: "published", publishedAt: nowSql() })
      .where(
        and(
          eq(builds.id, staged.id),
          eq(builds.roomId, room.id),
          eq(builds.status, "staged"),
          stagedStillHasQuorum,
        ),
      ),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(
        and(
          eq(rooms.id, room.id),
          eq(rooms.revision, room.revision),
          sql`EXISTS (
            SELECT 1 FROM builds
            WHERE id = ${staged.id} AND room_id = ${room.id} AND status = 'published'
          )`,
        ),
      ),
  ]);

  const [shipped] = await db
    .select({ status: builds.status })
    .from(builds)
    .where(eq(builds.id, staged.id))
    .limit(1);
  if (shipped?.status !== "published") {
    throw new RoomError(
      "The room changed before this build could ship. Review the latest proposal and try again.",
      409,
    );
  }
}

export async function forkRoom(slugValue: string, identity: Identity) {
  const sourceRoom = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [published] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, sourceRoom.id), eq(builds.status, "published")))
    .orderBy(desc(builds.version))
    .limit(1);
  if (!published) throw new RoomError("This room has no published build to fork.", 409);
  const publishedFiles = asArtifactSourceFiles(await ensureBuildFiles(published));

  const id = crypto.randomUUID();
  const buildId = crypto.randomUUID();
  const slug = `${normalizeSlug(sourceRoom.name)}-${id.slice(0, 6)}`;
  const name = `${sourceRoom.name} / fork`;
  const forkFileRows = await sourceRows(buildId, publishedFiles);
  await db.batch([
    db.insert(rooms).values({
      id,
      slug,
      name,
      note: `Forked from ${sourceRoom.name}. Keep what works; change what does not.`,
      ownerId: identity.id,
      parentRoomId: sourceRoom.id,
    }),
    db.insert(roomMembers).values({ roomId: id, userId: identity.id, role: "owner" }),
    db.insert(builds).values({
      id: buildId,
      roomId: id,
      version: 1,
      status: "published",
      sourceKind: "fork",
      name: published.name,
      proposalTitle: `Forked ${published.name}`,
      rationale: "A fork preserves the working artifact and gives this room an independent history.",
      summary: `Forked from ${sourceRoom.name} at v${published.version}.`,
      changesJson: JSON.stringify(["Copied the published artifact", "Created an independent room", "Reset version history to v1"]),
      sourceMessageIdsJson: "[]",
      html: published.html,
      createdBy: identity.id,
      parentBuildId: published.id,
      publishedAt: nowSql(),
    }),
    db.insert(buildFiles).values(forkFileRows),
  ]);
  await copyProjectAssets(sourceRoom.id, id);
  return slug;
}

export async function presentForkToParent(
  slugValue: string,
  identity: Identity,
) {
  const branchRoom = await getRoomForUser(slugValue, identity);
  if (!branchRoom.parentRoomId) {
    throw new RoomError("Only a fork can be presented to a parent room.", 409);
  }
  if (branchRoom.ownerId !== identity.id) {
    throw new RoomError("Only the fork owner can present this branch.", 403);
  }
  const db = getDb();
  const [parent] = await db
    .select({ slug: rooms.slug, id: rooms.id })
    .from(rooms)
    .where(eq(rooms.id, branchRoom.parentRoomId))
    .limit(1);
  if (!parent) throw new RoomError("The parent room no longer exists.", 409);
  await getRoomForUser(parent.slug, identity);

  const [published, staged] = await Promise.all([
    db
      .select({ id: builds.id })
      .from(builds)
      .where(and(eq(builds.roomId, branchRoom.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select({ id: builds.id })
      .from(builds)
      .where(and(eq(builds.roomId, branchRoom.id), eq(builds.status, "staged")))
      .limit(1),
  ]);
  if (!published[0]) throw new RoomError("Publish the fork before presenting it.", 409);
  if (staged[0]) {
    throw new RoomError("Ship or replace the fork's staged proposal before presenting it.", 409);
  }

  await db.batch([
    db
      .update(rooms)
      .set({
        presentedAt: nowSql(),
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(eq(rooms.id, branchRoom.id)),
    db
      .update(rooms)
      .set({ updatedAt: nowSql(), revision: sql`${rooms.revision} + 1` })
      .where(eq(rooms.id, parent.id)),
  ]);
  return parent.slug;
}

export async function mergeForkToParent(
  slugValue: string,
  identity: Identity,
) {
  const branchRoom = await getRoomForUser(slugValue, identity);
  if (!branchRoom.parentRoomId) {
    throw new RoomError("This room is not a fork, so it has no parent to merge into.", 409);
  }

  const db = getDb();
  const [parentLookup] = await db
    .select({ slug: rooms.slug })
    .from(rooms)
    .where(eq(rooms.id, branchRoom.parentRoomId))
    .limit(1);
  if (!parentLookup) throw new RoomError("The parent room no longer exists.", 409);

  // A fork can only converge into a parent that the contributor can still open.
  const parentRoom = await getRoomForUser(parentLookup.slug, identity);
  const [
    branchPublishedRows,
    branchStagedRows,
    branchRootRows,
    parentPublishedRows,
    parentStagedRows,
    maxVersionRows,
  ] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, branchRoom.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, branchRoom.id), eq(builds.status, "staged")))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, branchRoom.id), eq(builds.version, 1)))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, parentRoom.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, parentRoom.id), eq(builds.status, "staged")))
      .orderBy(desc(builds.createdAt))
      .limit(1),
    db
      .select({ value: sql<number>`max(${builds.version})` })
      .from(builds)
      .where(eq(builds.roomId, parentRoom.id)),
  ]);

  if (branchStagedRows[0]) {
    throw new RoomError(
      "Ship the fork's current proposal before combining it back into the parent.",
      409,
    );
  }

  const branchPublished = branchPublishedRows[0];
  const branchRoot = branchRootRows[0];
  const parentPublished = parentPublishedRows[0];
  const parentStaged = parentStagedRows[0];
  const parentWorking = parentStaged ?? parentPublished;
  if (!branchPublished || !branchRoot || !parentPublished || !parentWorking) {
    throw new RoomError("Both rooms need a published source snapshot before they can combine.", 409);
  }
  if (branchRoot.sourceKind !== "fork" || !branchRoot.parentBuildId) {
    throw new RoomError("This fork is missing its branch-point snapshot.", 409);
  }

  const [ancestor] = await db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.id, branchRoot.parentBuildId),
        eq(builds.roomId, parentRoom.id),
      ),
    )
    .limit(1);
  if (!ancestor) throw new RoomError("The fork's branch point is no longer available.", 409);

  const [ancestorFiles, parentFiles, branchFiles] = await Promise.all([
    ensureBuildFiles(ancestor).then(asArtifactSourceFiles),
    ensureBuildFiles(parentWorking).then(asArtifactSourceFiles),
    ensureBuildFiles(branchPublished).then(asArtifactSourceFiles),
  ]);
  const [branchAssetRows, parentAssetRows] = await Promise.all([
    db.select().from(projectAssets).where(eq(projectAssets.roomId, branchRoom.id)),
    db
      .select({ sha256: projectAssets.sha256 })
      .from(projectAssets)
      .where(eq(projectAssets.roomId, parentRoom.id)),
  ]);
  const parentAssetHashes = new Set(parentAssetRows.map((asset) => asset.sha256));
  const newBranchAssets = branchAssetRows.filter((asset) => !parentAssetHashes.has(asset.sha256));
  const merge = mergeForkSourceSnapshots(ancestorFiles, parentFiles, branchFiles);
  if (merge.branchChangedPaths.length === 0 && newBranchAssets.length === 0) {
    throw new RoomError("This fork has no published source or asset changes to combine yet.", 409);
  }
  if (merge.conflicts.length > 0) {
    throw new RoomError(
      `The parent and fork both changed ${merge.conflicts.join(
        " and ",
      )}. The fork is still safe; reconcile that file before combining.`,
      409,
    );
  }
  if (merge.mergedPaths.length === 0 && newBranchAssets.length === 0) {
    throw new RoomError("The parent already contains this fork's published changes.", 409);
  }

  let html: string;
  try {
    html = assembleArtifactFiles(merge.files, parentWorking.name);
  } catch (error) {
    throw new RoomError(
      error instanceof Error ? error.message : "The combined source failed safety validation.",
    );
  }

  const buildId = crypto.randomUUID();
  const nextVersion = Number(maxVersionRows[0]?.value ?? 0) + 1;
  if (nextVersion > MAX_BUILDS_PER_ROOM) {
    throw new RoomError(
      "The parent room reached the founder source-history limit. Ship or fork again before combining more work.",
      409,
    );
  }
  const fileRows = await sourceRows(buildId, merge.files);
  const parentIsCurrent = sql`EXISTS (
    SELECT 1 FROM rooms
    WHERE id = ${parentRoom.id} AND revision = ${parentRoom.revision}
  )`;
  const branchIsCurrent = sql`EXISTS (
      SELECT 1 FROM rooms AS branch_room
      WHERE branch_room.id = ${branchRoom.id}
        AND branch_room.revision = ${branchRoom.revision}
    ) AND EXISTS (
      SELECT 1 FROM builds AS branch_build
      WHERE branch_build.id = ${branchPublished.id}
        AND branch_build.room_id = ${branchRoom.id}
        AND branch_build.status = 'published'
    ) AND NOT EXISTS (
      SELECT 1 FROM builds AS branch_stage
      WHERE branch_stage.room_id = ${branchRoom.id}
        AND branch_stage.status = 'staged'
    )`;
  const mergedPathLabel = merge.mergedPaths.length > 0
    ? merge.mergedPaths.join(" and ")
    : `${newBranchAssets.length} shared asset${newBranchAssets.length === 1 ? "" : "s"}`;
  const stagedBuild = db
    .select({
      id: sql<string>`${buildId}`.as("id"),
      roomId: sql<string>`${parentRoom.id}`.as("room_id"),
      version: sql<number>`${nextVersion}`.as("version"),
      status: sql<string>`${"staged"}`.as("status"),
      sourceKind: sql<string>`${"fork-merge"}`.as("source_kind"),
      agentLabel: sql<string | null>`${null}`.as("agent_label"),
      name: sql<string>`${parentWorking.name}`.as("name"),
      proposalTitle: sql<string>`${`Merge ${branchRoom.name}`}`.as("proposal_title"),
      rationale: sql<string>`${`${identity.displayName} proposed the fork's published work back into ${parentRoom.name}.`}`.as("rationale"),
      summary: sql<string>`${`Combined ${mergedPathLabel} from fork v${branchPublished.version}.`}`.as("summary"),
      changesJson: sql<string>`${JSON.stringify([
        ...merge.mergedPaths.map((path) => `Merged ${path} from ${branchRoom.name}`),
        ...(newBranchAssets.length > 0
          ? [`Carried ${newBranchAssets.length} new game asset${newBranchAssets.length === 1 ? "" : "s"} into the parent library`]
          : []),
        "Preserved non-overlapping work already in the parent",
        "Created one reviewable convergence snapshot",
      ])}`.as("changes_json"),
      sourceMessageIdsJson: sql<string>`${parentWorking.sourceMessageIdsJson}`.as(
        "source_message_ids_json",
      ),
      html: sql<string>`${html}`.as("html"),
      createdBy: sql<string>`${identity.id}`.as("created_by"),
      parentBuildId: sql<string>`${parentWorking.id}`.as("parent_build_id"),
      createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      publishedAt: sql<string | null>`${null}`.as("published_at"),
    })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, parentRoom.id),
        eq(rooms.revision, parentRoom.revision),
        branchIsCurrent,
      ),
    )
    .limit(1);
  const stagedFileRows = fileRows.map((file) =>
    db
      .select({
        buildId: sql<string>`${buildId}`.as("build_id"),
        path: sql<string>`${file.path}`.as("path"),
        content: sql<string>`${file.content}`.as("content"),
        language: sql<string>`${file.language}`.as("language"),
        sha256: sql<string>`${file.sha256}`.as("sha256"),
        byteCount: sql<number>`${file.byteCount}`.as("byte_count"),
        createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1),
  );

  await db.batch([
    db
      .update(builds)
      .set({ status: "superseded" })
      .where(
        and(
          eq(builds.roomId, parentRoom.id),
          eq(builds.status, "staged"),
          parentStaged ? eq(builds.id, parentStaged.id) : sql`0`,
          parentIsCurrent,
          branchIsCurrent,
        ),
      ),
    db.insert(builds).select(stagedBuild),
    ...stagedFileRows.map((row) => db.insert(buildFiles).select(row)),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(
        and(
          eq(rooms.id, parentRoom.id),
          eq(rooms.revision, parentRoom.revision),
          sql`EXISTS (
            SELECT 1 FROM builds
            WHERE id = ${buildId} AND room_id = ${parentRoom.id} AND status = 'staged'
          )`,
        ),
      ),
  ]);

  const [saved] = await db
    .select({
      id: builds.id,
      files: sql<number>`(
        SELECT count(*) FROM build_files WHERE build_id = ${buildId}
      )`,
    })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.status, "staged")))
    .limit(1);
  if (!saved || Number(saved.files) !== merge.files.length) {
    throw new RoomError(
      "The parent changed while this fork was combining. Nothing was lost; try the merge again.",
      409,
    );
  }

  await copyProjectAssets(branchRoom.id, parentRoom.id);

  return parentRoom.slug;
}

export async function getConvergenceContext(
  slugValue: string,
  identity: Identity,
) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [publishedRows, stagedRows, recentMessages, presentedRooms] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select({ id: builds.id })
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
      .limit(1),
    db
      .select({
        id: messages.id,
        author: users.displayName,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(eq(messages.roomId, room.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(30),
    db
      .select({
        id: rooms.id,
        slug: rooms.slug,
        name: rooms.name,
        ownerName: users.displayName,
        presentedAt: rooms.presentedAt,
      })
      .from(rooms)
      .innerJoin(users, eq(rooms.ownerId, users.id))
      .where(and(eq(rooms.parentRoomId, room.id), isNotNull(rooms.presentedAt)))
      .orderBy(desc(rooms.presentedAt))
      .limit(6),
  ]);
  const published = publishedRows[0];
  if (!published) throw new RoomError("Publish a starting build before convergence.", 409);
  if (stagedRows[0]) {
    throw new RoomError("Ship or replace the current staged proposal before converging team forks.", 409);
  }
  if (presentedRooms.length === 0) {
    throw new RoomError("A teammate must present a published fork before convergence.", 409);
  }

  const currentFiles = asArtifactSourceFiles(await ensureBuildFiles(published));
  const branchContexts = (
    await Promise.all(
      presentedRooms.map(async (branchRoom) => {
        const [branchPublishedRows, branchRootRows] = await Promise.all([
          db
            .select()
            .from(builds)
            .where(and(eq(builds.roomId, branchRoom.id), eq(builds.status, "published")))
            .orderBy(desc(builds.version))
            .limit(1),
          db
            .select()
            .from(builds)
            .where(and(eq(builds.roomId, branchRoom.id), eq(builds.version, 1)))
            .limit(1),
        ]);
        const branchPublished = branchPublishedRows[0];
        const branchRoot = branchRootRows[0];
        if (!branchPublished || !branchRoot?.parentBuildId) return null;
        const [ancestor] = await db
          .select()
          .from(builds)
          .where(
            and(
              eq(builds.id, branchRoot.parentBuildId),
              eq(builds.roomId, room.id),
            ),
          )
          .limit(1);
        if (!ancestor) return null;
        const [ancestorFiles, branchFiles] = await Promise.all([
          ensureBuildFiles(ancestor).then(asArtifactSourceFiles),
          ensureBuildFiles(branchPublished).then(asArtifactSourceFiles),
        ]);
        const changes = projectChangesBetween(ancestorFiles, branchFiles);
        if (changes.length === 0) return null;
        return {
          slug: branchRoom.slug,
          name: branchRoom.name,
          ownerName: branchRoom.ownerName,
          presentedAt: branchRoom.presentedAt!,
          version: branchPublished.version,
          branchPointBuildId: ancestor.id,
          changes,
        };
      }),
    )
  ).filter((branch): branch is NonNullable<typeof branch> => Boolean(branch));
  if (branchContexts.length === 0) {
    throw new RoomError("The presented forks do not contain changes to converge.", 409);
  }
  recentMessages.reverse();
  return {
    room,
    published,
    currentFiles,
    branches: branchContexts,
    messages: recentMessages,
  };
}

export async function getAgentConvergenceSnapshot(slugValue: string, identity: Identity) {
  const context = await getConvergenceContext(slugValue, identity);
  return {
    room: {
      slug: context.room.slug,
      name: context.room.name,
      note: context.room.note,
      revision: context.room.revision,
    },
    baseBuild: {
      id: context.published.id,
      version: context.published.version,
      files: context.currentFiles,
    },
    presentedForks: context.branches,
    recentConversation: context.messages,
    submit: {
      tool: "submit_convergence_patch",
      required: ["room", "expectedRevision", "baseBuildId", "changes"],
      note: "Submit one combined proposal after comparing every presented fork. Humans still review and ship it.",
    },
  };
}

export async function getGenerationContext(
  slugValue: string,
  identity: Identity,
) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [publishedRows, stagedRows, recentMessages] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
      .orderBy(desc(builds.createdAt))
      .limit(1),
    db
      .select({
        id: messages.id,
        author: users.displayName,
        body: messages.body,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(eq(messages.roomId, room.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(30),
  ]);
  const published = publishedRows[0];
  if (!published) throw new RoomError("Publish a starting build before synthesizing.", 409);
  const working = stagedRows[0] ?? published;
  const workingFiles = asArtifactSourceFiles(await ensureBuildFiles(working));

  recentMessages.reverse();
  if (recentMessages.length === 0) {
    throw new RoomError("The room needs at least one message before Kimi can synthesize it.", 409);
  }

  const stagedVoterIds = stagedRows[0]
    ? (
        await db
          .select({ userId: votes.userId })
          .from(votes)
          .where(eq(votes.buildId, stagedRows[0].id))
          .orderBy(asc(votes.userId))
      ).map((vote) => vote.userId)
    : [];

  return {
    room,
    published,
    working,
    workingFiles,
    stagedId: stagedRows[0]?.id ?? null,
    stagedVoterIds,
    messages: recentMessages,
  };
}

export async function getProjectAgentContext(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [workingRows, recentMessages] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), sql`${builds.status} IN ('staged', 'published')`))
      .orderBy(sql`CASE WHEN ${builds.status} = 'staged' THEN 0 ELSE 1 END`, desc(builds.version))
      .limit(1),
    db
      .select({ author: users.displayName, body: messages.body })
      .from(messages)
      .innerJoin(users, eq(messages.authorId, users.id))
      .where(eq(messages.roomId, room.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(30),
  ]);
  const working = workingRows[0];
  if (!working) throw new RoomError("Publish a starting build before asking the project AI.", 409);
  recentMessages.reverse();
  return {
    room,
    working,
    files: asArtifactSourceFiles(await ensureBuildFiles(working)),
    messages: recentMessages,
  };
}

export async function stageGeneratedArtifact(
  slugValue: string,
  identity: Identity,
  artifact: GeneratedArtifact,
  expected: {
    roomRevision: number;
    publishedBuildId: string;
    stagedBuildId: string | null;
    stagedVoterIds: string[];
    sourceMessageIds: string[];
  },
) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [publishedRows, stagedRows] = await Promise.all([
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "published")))
      .orderBy(desc(builds.version))
      .limit(1),
    db
      .select()
      .from(builds)
      .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
      .orderBy(desc(builds.createdAt))
      .limit(1),
  ]);
  const published = publishedRows[0];
  if (!published) throw new RoomError("The published build disappeared.", 409);
  const [currentMessageRows, currentVoteRows] = await Promise.all([
    db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.roomId, room.id))
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(30),
    expected.stagedBuildId
      ? db
          .select({ userId: votes.userId })
          .from(votes)
          .where(eq(votes.buildId, expected.stagedBuildId))
          .orderBy(asc(votes.userId))
      : Promise.resolve([]),
  ]);
  const currentMessageIds = currentMessageRows.reverse().map((message) => message.id);
  const currentVoterIds = currentVoteRows.map((vote) => vote.userId);
  if (
    room.revision !== expected.roomRevision ||
    published.id !== expected.publishedBuildId ||
    (stagedRows[0]?.id ?? null) !== expected.stagedBuildId ||
    JSON.stringify(currentMessageIds) !== JSON.stringify(expected.sourceMessageIds) ||
    JSON.stringify(currentVoterIds) !== JSON.stringify(expected.stagedVoterIds)
  ) {
    throw new RoomError(
      "The room changed while Kimi was building. Synthesize again from the latest state.",
      409,
    );
  }

  const buildId = crypto.randomUUID();
  const name = cleanText(artifact.name, 50) || published.name;
  const proposalTitle = cleanText(artifact.proposalTitle, 80);
  const rationale = cleanText(artifact.rationale, 320);
  const summary = cleanText(artifact.summary, 320);
  const changesJson = JSON.stringify(artifact.changes.slice(0, 5));
  const sourceMessageIdsJson = JSON.stringify(expected.sourceMessageIds);
  const generatedFiles = asArtifactSourceFiles(artifact.files);
  const workingBuild = stagedRows[0] ?? published;
  const workingFiles = asArtifactSourceFiles(await ensureBuildFiles(workingBuild));
  const generatedByPath = new Map(
    generatedFiles.map((file) => [file.path, file] as const),
  );
  const files = validateArtifactFiles(
    workingFiles.map((file) => generatedByPath.get(file.path) ?? file),
  );
  const html = assembleArtifactFiles(files, name);
  const fileRows = await sourceRows(buildId, files);
  const [maxVersionRow] = await db
    .select({ value: sql<number>`max(${builds.version})` })
    .from(builds)
    .where(eq(builds.roomId, room.id));
  const nextVersion = Number(maxVersionRow?.value ?? 0) + 1;
  if (nextVersion > MAX_BUILDS_PER_ROOM) {
    throw new RoomError(
      "This room reached the founder source-history limit. Fork the published app to keep building.",
      409,
    );
  }
  const roomIsCurrent = sql`EXISTS (
    SELECT 1 FROM rooms
    WHERE id = ${room.id} AND revision = ${expected.roomRevision}
  )`;
  const stagedBuild = db
    .select({
      id: sql<string>`${buildId}`.as("id"),
      roomId: sql<string>`${room.id}`.as("room_id"),
      version: sql<number>`${nextVersion}`.as("version"),
      status: sql<string>`${"staged"}`.as("status"),
      sourceKind: sql<string>`${"kimi"}`.as("source_kind"),
      agentLabel: sql<string | null>`${process.env.AI_MODEL ?? "Kimi K2.5"}`.as("agent_label"),
      name: sql<string>`${name}`.as("name"),
      proposalTitle: sql<string>`${proposalTitle}`.as("proposal_title"),
      rationale: sql<string>`${rationale}`.as("rationale"),
      summary: sql<string>`${summary}`.as("summary"),
      changesJson: sql<string>`${changesJson}`.as("changes_json"),
      sourceMessageIdsJson: sql<string>`${sourceMessageIdsJson}`.as(
        "source_message_ids_json",
      ),
      html: sql<string>`${html}`.as("html"),
      createdBy: sql<string>`${identity.id}`.as("created_by"),
      parentBuildId: sql<string>`${expected.stagedBuildId ?? published.id}`.as(
        "parent_build_id",
      ),
      createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      publishedAt: sql<string | null>`${null}`.as("published_at"),
    })
    .from(rooms)
    .where(
      and(
        eq(rooms.id, room.id),
        eq(rooms.revision, expected.roomRevision),
      ),
    )
    .limit(1);

  const stagedFileRows = fileRows.map((file) =>
    db
      .select({
        buildId: sql<string>`${buildId}`.as("build_id"),
        path: sql<string>`${file.path}`.as("path"),
        content: sql<string>`${file.content}`.as("content"),
        language: sql<string>`${file.language}`.as("language"),
        sha256: sql<string>`${file.sha256}`.as("sha256"),
        byteCount: sql<number>`${file.byteCount}`.as("byte_count"),
        createdAt: sql<string>`CURRENT_TIMESTAMP`.as("created_at"),
      })
      .from(builds)
      .where(eq(builds.id, buildId))
      .limit(1),
  );

  await db.batch([
    db
      .update(builds)
      .set({ status: "superseded" })
      .where(
        and(
          eq(builds.roomId, room.id),
          eq(builds.status, "staged"),
          expected.stagedBuildId
            ? eq(builds.id, expected.stagedBuildId)
            : sql`0`,
          roomIsCurrent,
        ),
      ),
    db.insert(builds).select(stagedBuild),
    ...stagedFileRows.map((row) => db.insert(buildFiles).select(row)),
    db
      .update(rooms)
      .set({
        updatedAt: nowSql(),
        revision: sql`${rooms.revision} + 1`,
      })
      .where(
        and(
          eq(rooms.id, room.id),
          eq(rooms.revision, expected.roomRevision),
        ),
      ),
  ]);

  const [staged] = await db
    .select({
      id: builds.id,
      files: sql<number>`(
        SELECT count(*) FROM build_files WHERE build_id = ${buildId}
      )`,
    })
    .from(builds)
    .where(and(eq(builds.id, buildId), eq(builds.status, "staged")))
    .limit(1);
  if (!staged || Number(staged.files) !== files.length) {
    throw new RoomError(
      "The room changed while Kimi was building. Synthesize again from the latest state.",
      409,
    );
  }
}
