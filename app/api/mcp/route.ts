import {
  authenticateAgentToken,
  getAgentConvergenceSnapshot,
  getAgentProjectSnapshot,
  RoomError,
  stageAgentProjectPatch,
} from "../../../lib/room-service";

export const runtime = "edge";

type RpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const tools = [
  {
    name: "get_project",
    title: "Read Make Room project",
    description: "Read the complete current project snapshot and recent room context before proposing code.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { room: { type: "string", description: "The Make Room slug." } },
      required: ["room"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "submit_project_patch",
    title: "Submit Make Room patch",
    description: "Stage one atomic multi-file proposal. This never publishes; the room must review and ship it.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
        baseBuildId: { type: "string" },
        agentLabel: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              content: { type: ["string", "null"] },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["room", "expectedRevision", "baseBuildId", "changes"],
    },
  },
  {
    name: "get_convergence_context",
    title: "Compare presented team forks",
    description: "Read the main project plus complete changes from every fork its owner explicitly presented.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { room: { type: "string", description: "The parent Make Room slug." } },
      required: ["room"],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "submit_convergence_patch",
    title: "Submit combined team proposal",
    description: "After comparing every presented fork, stage one combined multi-file proposal for human review.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        room: { type: "string" },
        expectedRevision: { type: "integer", minimum: 0 },
        baseBuildId: { type: "string" },
        title: { type: "string" },
        summary: { type: "string" },
        rationale: { type: "string" },
        changes: {
          type: "array",
          minItems: 1,
          maxItems: 40,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              content: { type: ["string", "null"] },
            },
            required: ["path", "content"],
          },
        },
      },
      required: ["room", "expectedRevision", "baseBuildId", "changes"],
    },
  },
] as const;

function result(id: RpcRequest["id"], value: unknown) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result: value }, {
    headers: { "cache-control": "no-store" },
  });
}

function rpcError(id: RpcRequest["id"], code: number, message: string, status = 400) {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: Request) {
  let rpc: RpcRequest = {};
  try {
    if (!request.headers.get("content-type")?.includes("application/json")) {
      return rpcError(null, -32600, "Use a JSON MCP request.", 415);
    }
    rpc = (await request.json()) as RpcRequest;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return rpcError(rpc.id, -32600, "Invalid JSON-RPC request.");
    }
    const identity = await authenticateAgentToken(request);
    if (rpc.method === "initialize") {
      return result(rpc.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "make-room", version: "1.0.0" },
      });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") return result(rpc.id, { tools });
    if (rpc.method === "tools/call") {
      const name = rpc.params?.name;
      const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "get_project") {
        const snapshot = await getAgentProjectSnapshot(String(args.room ?? ""), identity);
        return result(rpc.id, { content: [{ type: "text", text: JSON.stringify(snapshot) }] });
      }
      if (name === "get_convergence_context") {
        const snapshot = await getAgentConvergenceSnapshot(String(args.room ?? ""), identity);
        return result(rpc.id, { content: [{ type: "text", text: JSON.stringify(snapshot) }] });
      }
      if (name === "submit_project_patch") {
        const room = String(args.room ?? "");
        await stageAgentProjectPatch(room, identity, {
          expectedRevision: Number(args.expectedRevision ?? -1),
          baseBuildId: String(args.baseBuildId ?? ""),
          changes: Array.isArray(args.changes)
            ? args.changes as Array<{ path: string; content: string | null }>
            : [],
          agentLabel: String(args.agentLabel ?? "Connected agent"),
          title: typeof args.title === "string" ? args.title : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
        });
        return result(rpc.id, {
          content: [{ type: "text", text: "Patch staged for room review. It is not published." }],
        });
      }
      if (name === "submit_convergence_patch") {
        const room = String(args.room ?? "");
        const context = await getAgentConvergenceSnapshot(room, identity);
        const expectedRevision = Number(args.expectedRevision ?? -1);
        const baseBuildId = String(args.baseBuildId ?? "");
        if (
          context.room.revision !== expectedRevision ||
          context.baseBuild.id !== baseBuildId
        ) {
          throw new RoomError("The parent or a presented fork changed. Read the convergence context again.", 409);
        }
        await stageAgentProjectPatch(room, identity, {
          expectedRevision,
          baseBuildId,
          changes: Array.isArray(args.changes)
            ? args.changes as Array<{ path: string; content: string | null }>
            : [],
          sourceKind: "convergence",
          title: typeof args.title === "string" ? args.title : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          rationale: typeof args.rationale === "string" ? args.rationale : undefined,
        });
        return result(rpc.id, {
          content: [{ type: "text", text: "Combined fork proposal staged for human review. It is not published." }],
        });
      }
      return rpcError(rpc.id, -32602, "Unknown tool.");
    }
    return rpcError(rpc.id, -32601, "Method not found.");
  } catch (error) {
    if (error instanceof RoomError) return rpcError(rpc.id, -32001, error.message, error.status);
    console.error("MCP gateway failed", error);
    return rpcError(rpc.id, -32603, "The MCP gateway hit an unexpected problem.", 500);
  }
}
