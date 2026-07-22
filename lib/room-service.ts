import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { getChatGPTUser } from "../app/chatgpt-auth";
import { ensureDatabase, getDb } from "../db";
import {
  builds,
  messages,
  roomMembers,
  rooms,
  users,
  votes,
} from "../db/schema";
import { makeStarterArtifact, secureArtifactHtml } from "./starter-artifact";

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
};

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

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
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
      id: crypto.randomUUID(),
      roomId: room.id,
      version: 1,
      status: "published",
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
      html: secureArtifactHtml(makeStarterArtifact(name)),
      createdBy: room.ownerId,
      publishedAt: nowSql(),
    }).onConflictDoNothing({ target: [builds.roomId, builds.version] }),
  ]);
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

function serializeBuild(build: typeof builds.$inferSelect | undefined) {
  if (!build) return null;
  return {
    id: build.id,
    version: build.version,
    status: build.status,
    name: build.name,
    proposalTitle: build.proposalTitle,
    rationale: build.rationale,
    summary: build.summary,
    changes: parseStringArray(build.changesJson),
    sourceMessageIds: parseStringArray(build.sourceMessageIdsJson),
    html: build.html,
    createdBy: build.createdBy,
    createdAt: build.createdAt,
    publishedAt: build.publishedAt,
  };
}

export async function getRoomState(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();

  const [messageRows, memberRows, buildRows, roomRows, forkCountRows] =
    await Promise.all([
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
    ]);

  const published = buildRows.find((build) => build.status === "published");
  const staged = buildRows.find((build) => build.status === "staged");
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

  const threshold = Math.max(1, Math.floor(memberRows.length / 2) + 1);

  return {
    room: {
      id: room.id,
      slug: room.slug,
      name: room.name,
      note: room.note,
      parentRoomId: room.parentRoomId,
      forkCount: Number(forkCountRows[0]?.count ?? 0),
      canInvite: room.ownerId === identity.id,
    },
    user: identity,
    rooms: roomRows,
    messages: messageRows.reverse(),
    members: memberRows.map((member) => ({
      ...member,
      online:
        Date.now() - new Date(`${member.lastSeenAt.replace(" ", "T")}Z`).getTime() <
        120_000,
    })),
    published: serializeBuild(published),
    staged: serializeBuild(staged),
    activity: buildRows.slice(0, 8).map((build) => ({
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
      id: crypto.randomUUID(),
      roomId: id,
      version: 1,
      status: "published",
      name,
      proposalTitle: "Starter artifact",
      rationale: "A room needs something real to react to before the first synthesis.",
      summary: "A small interactive starting point.",
      changesJson: JSON.stringify(["Created the room", "Added a working artifact", "Opened the build history"]),
      sourceMessageIdsJson: "[]",
      html: secureArtifactHtml(makeStarterArtifact(name)),
      createdBy: identity.id,
      publishedAt: nowSql(),
    }),
  ]);
  return slug;
}

export async function toggleVote(slugValue: string, identity: Identity) {
  const room = await getRoomForUser(slugValue, identity);
  const db = getDb();
  const [staged] = await db
    .select()
    .from(builds)
    .where(and(eq(builds.roomId, room.id), eq(builds.status, "staged")))
    .orderBy(desc(builds.createdAt))
    .limit(1);
  if (!staged) throw new RoomError("There is no staged build to vote on.", 409);

  const [existing] = await db
    .select()
    .from(votes)
    .where(and(eq(votes.buildId, staged.id), eq(votes.userId, identity.id)))
    .limit(1);
  if (existing) {
    await db.batch([
      db
        .delete(votes)
        .where(and(eq(votes.buildId, staged.id), eq(votes.userId, identity.id))),
      db
        .update(rooms)
        .set({ revision: sql`${rooms.revision} + 1` })
        .where(eq(rooms.id, room.id)),
    ]);
  } else {
    await db.batch([
      db.insert(votes).values({ buildId: staged.id, userId: identity.id }),
      db
        .update(rooms)
        .set({ revision: sql`${rooms.revision} + 1` })
        .where(eq(rooms.id, room.id)),
    ]);
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
  ) / 2 + 1)`;
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
      .where(eq(rooms.id, room.id)),
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

  const id = crypto.randomUUID();
  const slug = `${normalizeSlug(sourceRoom.name)}-${id.slice(0, 6)}`;
  const name = `${sourceRoom.name} / fork`;
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
      id: crypto.randomUUID(),
      roomId: id,
      version: 1,
      status: "published",
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
  ]);
  return slug;
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
      .select({ id: builds.id })
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
      .select({ id: builds.id })
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
  const html = secureArtifactHtml(artifact.html);
  const roomIsCurrent = sql`EXISTS (
    SELECT 1 FROM rooms
    WHERE id = ${room.id} AND revision = ${expected.roomRevision}
  )`;
  const stagedBuild = db
    .select({
      id: sql<string>`${buildId}`.as("id"),
      roomId: sql<string>`${room.id}`.as("room_id"),
      version: sql<number>`${published.version + 1}`.as("version"),
      status: sql<string>`${"staged"}`.as("status"),
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
      parentBuildId: sql<string>`${published.id}`.as("parent_build_id"),
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

  await db.batch([
    db
      .delete(builds)
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
    .select({ id: builds.id })
    .from(builds)
    .where(eq(builds.id, buildId))
    .limit(1);
  if (!staged) {
    throw new RoomError(
      "The room changed while Kimi was building. Synthesize again from the latest state.",
      409,
    );
  }
}
