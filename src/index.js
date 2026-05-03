import { getAssetFromKV } from "@cloudflare/kv-asset-handler";

function randomCode() { ... }

// ---- PUZZLE PARTY DURABLE OBJECT ----
export class Room { ... }

// ---- ESCAPE ROOM DURABLE OBJECT ----
export class EscapeRoom { ... }

// ---- WORKER ENTRY POINT (the block you’re asking about) ----
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Create jigsaw puzzle room
    if (url.pathname === "/api/create-room" && request.method === "POST") {
      const roomId = randomCode();
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      await stub.fetch(new Request("https://dummy/init", {
        method: "POST",
        body: JSON.stringify({ rows: 4, cols: 3 }),
      }));
      return new Response(JSON.stringify({ roomId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 2. WebSocket for jigsaw puzzle
    if (url.pathname.startsWith("/room/")) {
      const roomId = url.pathname.split("/room/")[1];
      if (!roomId) return new Response("Missing room ID", { status: 400 });
      const doId = env.ROOM.idFromName(roomId);
      const stub = env.ROOM.get(doId);
      return stub.fetch(request);
    }

    // 3. Create escape room
    if (url.pathname === "/api/create-escape-room" && request.method === "POST") {
      const roomId = randomCode();
      const doId = env.ESCAPE_ROOM.idFromName(roomId);
      return new Response(JSON.stringify({ roomId }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // 4. WebSocket for escape room
    if (url.pathname.startsWith("/escape-room/")) {
      const roomId = url.pathname.split("/escape-room/")[1];
      if (!roomId) return new Response("Missing room ID", { status: 400 });
      const doId = env.ESCAPE_ROOM.idFromName(roomId);
      const stub = env.ESCAPE_ROOM.get(doId);
      return stub.fetch(request);
    }

    // 5. Serve static files (at the very end)
    try {
      return await getAssetFromKV(
        { request, waitUntil: (p) => request.waitUntil?.(p) },
        { mapRequestToAsset: (req) => new Request(new URL(req.url).pathname, req) }
      );
    } catch (e) {
      return new Response("Not found", { status: 404 });
    }
  },
};