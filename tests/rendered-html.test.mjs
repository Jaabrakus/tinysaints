import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("requires identity and drives the product from persisted room state", async () => {
  const [page, client, roomRoute, roomService] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/RoomClient.tsx"),
    source("../app/api/room/route.ts"),
    source("../lib/room-service.ts"),
  ]);

  assert.match(page, /requireChatGPTUser\("\/"\)/);
  assert.match(page, /<RoomClient/);
  assert.match(page, /key=\{initialSlug \|\| "home"\}/);
  assert.match(roomRoute, /await authenticatedIdentity\(\)/);
  assert.match(roomRoute, /addMessage/);
  assert.match(roomRoute, /toggleVote/);
  assert.match(roomRoute, /shipBuild/);
  assert.match(roomRoute, /forkRoom/);
  assert.match(roomRoute, /joinRoom/);
  assert.match(roomRoute, /createRoomInvite/);
  assert.match(roomRoute, /getHomeRoomState/);
  assert.match(roomService, /insert\(messages\)/);
  assert.match(roomService, /insert\(roomMembers\)/);
  assert.match(roomService, /insert\(votes\)/);
  assert.match(roomService, /publishedAt/);
  assert.doesNotMatch(client, /const\s+(messages|rooms|members)\s*=\s*\[/);
});

test("uses canonical server context and fails honestly without Kimi", async () => {
  const [generationRoute, provider] = await Promise.all([
    source("../app/api/generate/route.ts"),
    source("../lib/model-provider.ts"),
  ]);

  assert.match(generationRoute, /await getIdentity\(\)/);
  assert.match(generationRoute, /await getGenerationContext\(slug, identity\)/);
  assert.match(generationRoute, /await acquireGenerationLease\(slug, identity\)/);
  assert.match(generationRoute, /releaseGenerationLease/);
  assert.match(generationRoute, /await stageGeneratedArtifact/);
  assert.doesNotMatch(generationRoute, /payload\.messages|payload\.published/);
  assert.match(generationRoute, /stagedVoterIds/);
  assert.match(generationRoute, /roomRevision: context\.room\.revision/);
  assert.match(await source("../lib/room-service.ts"), /eq\(rooms\.revision, expected\.roomRevision\)/);
  assert.match(provider, /process\.env\.MOONSHOT_API_KEY/);
  assert.match(provider, /model_not_configured/);
  assert.match(provider, /throw new ModelProviderError/);
  assert.doesNotMatch(provider, /demoBuild|local-demo|mode:\s*["']demo["']|fallbackArtifact/);
});

test("keeps secrets server-side and generated code inside an opaque sandbox", async () => {
  const [client, artifact, hosting, migration] = await Promise.all([
    source("../app/RoomClient.tsx"),
    source("../lib/starter-artifact.ts"),
    source("../.openai/hosting.json"),
    source("../drizzle/0000_pale_iron_patriot.sql"),
  ]);

  assert.doesNotMatch(client, /process\.env|NEXT_PUBLIC_.*(?:KEY|TOKEN|SECRET)/);
  assert.match(client, /sandbox=""/);
  assert.doesNotMatch(client, /allow-scripts|allow-same-origin|allow-forms|allow-popups/);
  assert.match(artifact, /default-src 'none'/);
  assert.match(artifact, /connect-src 'none'/);
  assert.match(artifact, /script-src 'none'/);
  assert.doesNotMatch(artifact, /<script>\$\{safeJavascript\}/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(migration, /CREATE TABLE `rooms`/);
  assert.match(migration, /CREATE TABLE `messages`/);
  assert.match(migration, /CREATE TABLE `builds`/);
  assert.match(migration, /CREATE TABLE `votes`/);
});
