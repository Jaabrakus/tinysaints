import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { ensureDatabase, getDb } from "../db";
import {
  buildFiles,
  builds,
  messages,
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
} from "./starter-artifact";
import { mergeForkSourceSnapshots } from "./fork-merge";

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

export async function getIdentity(): Promise<Identity | null> {
  const user = await getChatGPTUser();
  if (!user) return null;
  return {
    id: await hashIdentity(user.email),
    displayName: cleanText(user.displayName, 80),
  };
}

export function isKimiConfigured() {
  return Boolean(
    process.env.MOONSHOT_API_KEY ??
      process.env.KIMI_API_KEY ??
      process.env.AI_API_KEY,
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

export async function getHomeRoomState(identity: Identity) {
  await ensureDatabase();
  await upsertUser(identity);
  const db = getDb();
  let [home] = await db
    .select({ slug: rooms.slug })
    .from(roomMembers)
    .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
    .where(eq(roomMembers.userId, identity.id))
    .orderBy(desc(rooms.updatedAt))
    .limit(1);

  if (!home) {
    const [roomCount] = await db.select({ count: sql<number>`count(*)` }).from(rooms);
    if (Number(roomCount?.count ?? 0) === 0) {
      await createSeedRoom(identity);
      [home] = await db
        .select({ slug: rooms.slug })
        .from(roomMembers)
        .innerJoin(rooms, eq(roomMembers.roomId, rooms.id))
        .where(eq(roomMembers.userId, identity.id))
        .orderBy(desc(rooms.updatedAt))
        .limit(1);
    }
  }

  if (!home) {
    throw new RoomError("Open a valid invite link to join your first room.", 403);
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
    model: {
      configured: isKimiConfigured(),
      name: process.env.AI_MODEL ?? "kimi-k3",
    },
  };
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

export async function createRoom(
  identity: Identity,
  rawName: string,
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
  const source = makeStarterProject(name);
  const fileRows = await sourceRows(buildId, source);
  await db.batch([
    db.insert(rooms).values({
      id,
      slug,
      name,
      note: `Building ${name} together.`,
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
      proposalTitle: "Starter artifact",
      rationale: "A room needs something real to react to before the first synthesis.",
      summary: "A small interactive starting point.",
      changesJson: JSON.stringify(["Created the room", "Added a working artifact", "Opened the build history"]),
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
  let sourcePath: string;
  try {
    sourcePath = validateArtifactPath(input.path);
  } catch (error) {
    throw new RoomError(error instanceof Error ? error.message : "That file path is invalid.");
  }
  if (input.content !== null && typeof input.content !== "string") {
    throw new RoomError("Source content must be plain text.");
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    throw new RoomError("The source revision is invalid.");
  }
  if (!input.baseBuildId.trim()) {
    throw new RoomError("The source build is missing.");
  }
  const agentLabel = input.agentLabel
    ? cleanText(input.agentLabel, 80)
    : null;

  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
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
  const existingFile = baseFiles.find((file) => file.path === sourcePath);
  const isRemoval = input.content === null;
  if (isRemoval && (sourcePath === "index.html" || sourcePath === "styles.css")) {
    throw new RoomError("index.html and styles.css are required project files.");
  }
  if (isRemoval && !existingFile) {
    throw new RoomError("That project file no longer exists.", 409);
  }
  const nextFiles = validateArtifactFiles(
    isRemoval
      ? baseFiles.filter((file) => file.path !== sourcePath)
      : existingFile
      ? baseFiles.map((file) =>
          file.path === sourcePath ? { ...file, content: input.content! } : file,
        )
      : [
          ...baseFiles,
          {
            path: sourcePath,
            content: input.content!,
            language: inferArtifactLanguage(sourcePath),
          },
        ],
  );
  let html: string;
  try {
    html = assembleArtifactFiles(nextFiles, base.name);
  } catch (error) {
    throw new RoomError(
      error instanceof Error
        ? error.message
        : "The source patch failed safety validation.",
    );
  }
  if (
    nextFiles.every(
      (file, index) => file.content === baseFiles[index]?.content,
    )
  ) {
    return;
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
      sourceKind: sql<string>`${agentLabel ? "personal-agent" : "manual"}`.as("source_kind"),
      agentLabel: sql<string | null>`${agentLabel}`.as("agent_label"),
      name: sql<string>`${base.name}`.as("name"),
      proposalTitle: sql<string>`${`${agentLabel ? `${agentLabel}: ` : ""}${isRemoval ? "Remove" : existingFile ? "Edit" : "Add"} ${sourcePath}`}`.as("proposal_title"),
      rationale: sql<string>`${agentLabel ? `${identity.displayName}'s personal agent proposed this source change for the room to review.` : `${identity.displayName} saved a source-level change for the room to review.`}`.as("rationale"),
      summary: sql<string>`${`${isRemoval ? "Removed" : existingFile ? "Updated" : "Added"} ${sourcePath} from ${agentLabel ?? "the shared editor"}.`}`.as("summary"),
      changesJson: sql<string>`${JSON.stringify([
        `${isRemoval ? "Removed" : existingFile ? "Changed" : "Added"} ${sourcePath}`,
        "Created an immutable source snapshot",
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
  const merge = mergeForkSourceSnapshots(ancestorFiles, parentFiles, branchFiles);
  if (merge.branchChangedPaths.length === 0) {
    throw new RoomError("This fork has no published source changes to combine yet.", 409);
  }
  if (merge.conflicts.length > 0) {
    throw new RoomError(
      `The parent and fork both changed ${merge.conflicts.join(
        " and ",
      )}. The fork is still safe; reconcile that file before combining.`,
      409,
    );
  }
  if (merge.mergedPaths.length === 0) {
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
  const mergedPathLabel = merge.mergedPaths.join(" and ");
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

  return parentRoom.slug;
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
      agentLabel: sql<string | null>`${"Kimi K3"}`.as("agent_label"),
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
