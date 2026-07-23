import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("requires identity and drives the product from persisted room state", async () => {
  const [page, client, roomRoute, roomService, convergenceRoute, playRoute, presenceRoute, projectAgentRoute, publicPlayRoute] = await Promise.all([
    source("../app/page.tsx"),
    source("../app/RoomClient.tsx"),
    source("../app/api/room/route.ts"),
    source("../lib/room-service.ts"),
    source("../app/api/converge/route.ts"),
    source("../app/api/play/route.ts"),
    source("../app/api/presence/route.ts"),
    source("../app/api/project-agent/route.ts"),
    source("../app/api/public-play/route.ts"),
  ]);

  assert.match(page, /requireChatGPTUser\("\/"\)/);
  assert.match(page, /<RoomClient/);
  assert.match(page, /key=\{initialSlug \|\| "home"\}/);
  assert.match(roomRoute, /await authenticatedIdentity\(\)/);
  assert.match(roomRoute, /addMessage/);
  assert.match(roomRoute, /toggleVote/);
  assert.match(roomRoute, /shipBuild/);
  assert.match(roomRoute, /forkRoom/);
  assert.match(roomRoute, /mergeForkToParent/);
  assert.match(roomRoute, /action === "merge-parent"/);
  assert.match(roomRoute, /presentForkToParent/);
  assert.match(roomRoute, /action === "present-parent"/);
  assert.match(roomRoute, /action === "agent-file"/);
  assert.match(roomRoute, /action === "delete-file"/);
  assert.match(roomRoute, /joinRoom/);
  assert.match(roomRoute, /createRoomInvite/);
  assert.match(roomRoute, /editArtifactFile/);
  assert.match(roomRoute, /createAgentToken/);
  assert.match(roomRoute, /revokeAgentToken/);
  assert.match(roomRoute, /getHomeRoomState/);
  assert.match(roomService, /insert\(messages\)/);
  assert.match(roomService, /insert\(roomMembers\)/);
  assert.match(roomService, /createRoom\(identity, "My first room"\)/);
  assert.doesNotMatch(roomService, /Open a valid invite link to join your first room/);
  assert.match(roomService, /insert\(votes\)/);
  assert.match(roomService, /publishedAt/);
  assert.match(roomService, /insert\(buildFiles\)/);
  assert.match(roomService, /status: "superseded"/);
  assert.match(roomService, /mergeForkSourceSnapshots/);
  assert.match(roomService, /sourceKind: sql<string>`\$\{"fork-merge"\}`/);
  assert.match(client, /buildDiffLines/);
  assert.match(client, /action:\s*"edit-file"/);
  assert.match(client, /mutateRoom<\{ slug: string \}>\("merge-parent"\)/);
  assert.match(client, /\/api\/chat/);
  assert.match(client, /\/api\/export\?room=/);
  assert.match(client, /agent bridge/);
  assert.match(client, /MCP ENDPOINT/);
  assert.match(client, /converge ·/);
  assert.match(client, /\/api\/converge/);
  assert.match(convergenceRoute, /getConvergenceContext/);
  assert.match(convergenceRoute, /generateConvergencePatch/);
  assert.match(convergenceRoute, /sourceKind: "convergence"/);
  assert.match(roomService, /isNotNull\(rooms\.presentedAt\)/);
  assert.match(client, /sandbox="allow-scripts"/);
  assert.match(client, /activeTab === "showcase"/);
  assert.match(client, /playableUrl/);
  assert.match(playRoute, /getPlayableProjectSnapshot/);
  assert.match(playRoute, /phaser@\$\{PHASER_VERSION\}/);
  assert.match(playRoute, /globalThis\.makeRoomAssets/);
  assert.match(playRoute, /frame-ancestors 'self'/);
  assert.match(roomService, /presentedViewer/);
  assert.match(presenceRoute, /syncEditorPresence/);
  assert.match(client, /remote-cursor-caret/);
  assert.match(client, /\/api\/presence/);
  assert.match(projectAgentRoute, /generateProjectPatch/);
  assert.match(projectAgentRoute, /sourceKind: "project-agent"/);
  assert.match(client, /SHARED WHOLE-PROJECT AI/);
  assert.match(publicPlayRoute, /getPublicPlaytestSnapshot/);
  assert.match(publicPlayRoute, /connect-src 'none'/);
  assert.match(client, /create 14-day link/);
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
  const [client, artifact, hosting, migration, sourceMigration, workspaceMigration, agentMigration, assetMigration, collaborationMigration, agentRoute, assetRoute, mcpRoute, notices] = await Promise.all([
    source("../app/RoomClient.tsx"),
    source("../lib/starter-artifact.ts"),
    source("../.openai/hosting.json"),
    source("../drizzle/0000_pale_iron_patriot.sql"),
    source("../drizzle/0001_collaborative_source.sql"),
    source("../drizzle/0002_previous_krista_starr.sql"),
    source("../drizzle/0003_complex_skaar.sql"),
    source("../drizzle/0004_flat_clea.sql"),
    source("../drizzle/0005_live_collaboration.sql"),
    source("../app/api/agent/route.ts"),
    source("../app/api/assets/route.ts"),
    source("../app/api/mcp/route.ts"),
    source("../THIRD_PARTY_NOTICES.md"),
  ]);

  assert.doesNotMatch(client, /process\.env|NEXT_PUBLIC_.*(?:KEY|TOKEN|SECRET)/);
  assert.match(client, /sandbox="allow-scripts"/);
  assert.doesNotMatch(client, /allow-same-origin|allow-forms|allow-popups/);
  assert.match(artifact, /default-src 'none'/);
  assert.match(artifact, /connect-src 'none'/);
  assert.match(artifact, /script-src 'none'/);
  assert.match(artifact, /script-src 'nonce-\$\{scriptNonce\}'/);
  assert.match(artifact, /forbiddenJavascript/);
  assert.match(hosting, /"d1": "DB"/);
  assert.match(hosting, /"r2": "UPLOADS"/);
  assert.match(migration, /CREATE TABLE `rooms`/);
  assert.match(migration, /CREATE TABLE `messages`/);
  assert.match(migration, /CREATE TABLE `builds`/);
  assert.match(migration, /CREATE TABLE `votes`/);
  assert.match(sourceMigration, /CREATE TABLE `build_files`/);
  assert.match(sourceMigration, /ADD `source_kind`/);
  assert.match(workspaceMigration, /ADD `presented_at`/);
  assert.match(workspaceMigration, /ADD `agent_label`/);
  assert.match(workspaceMigration, /__new_build_files/);
  assert.match(agentMigration, /CREATE TABLE `agent_tokens`/);
  assert.match(assetMigration, /CREATE TABLE `project_assets`/);
  assert.match(collaborationMigration, /CREATE TABLE `editor_presence`/);
  assert.match(collaborationMigration, /CREATE TABLE `live_file_drafts`/);
  assert.match(collaborationMigration, /CREATE TABLE `playtest_links`/);
  assert.match(collaborationMigration, /CREATE TABLE `playtest_feedback`/);
  assert.match(assetRoute, /env\.UPLOADS/);
  assert.match(assetRoute, /5 \* 1024 \* 1024/);
  assert.match(assetRoute, /getProjectAssetRecord/);
  assert.match(agentRoute, /authenticateAgentToken/);
  assert.match(agentRoute, /stageAgentProjectPatch/);
  assert.match(mcpRoute, /submit_project_patch/);
  assert.match(mcpRoute, /get_convergence_context/);
  assert.match(mcpRoute, /submit_convergence_patch/);
  assert.doesNotMatch(client, /OPENAI_API_KEY|ANTHROPIC_API_KEY|VENICE_API_KEY/);
  assert.match(notices, /Copyright \(c\) 2026 Moonshot AI/);
  assert.match(notices, /MIT License/);
});
