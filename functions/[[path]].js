// This is your entire Worker code, unchanged
import { getAssetFromKV } from "@cloudflare/kv-asset-handler";

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ... (copy the full Room and EscapeRoom classes exactly as they are)

export async function onRequest(context) {
  // Pages Functions use a Web Fetch API handler: onRequest({ request, env, ... })
  const { request, env } = context;
  const url = new URL(request.url);

  // ---- API routes ----
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

  if (url.pathname.startsWith("/room/")) {
    const roomId = url.pathname.split("/room/")[1];
    if (!roomId) return new Response("Missing room ID", { status: 400 });
    const doId = env.ROOM.idFromName(roomId);
    const stub = env.ROOM.get(doId);
    return stub.fetch(request);
  }

  if (url.pathname === "/api/create-escape-room" && request.method === "POST") {
    const roomId = randomCode();
    const doId = env.ESCAPE_ROOM.idFromName(roomId);
    return new Response(JSON.stringify({ roomId }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  if (url.pathname.startsWith("/escape-room/")) {
    const roomId = url.pathname.split("/escape-room/")[1];
    if (!roomId) return new Response("Missing room ID", { status: 400 });
    const doId = env.ESCAPE_ROOM.idFromName(roomId);
    const stub = env.ESCAPE_ROOM.get(doId);
    return stub.fetch(request);
  }

  // ---- Fallback to static assets ----
  try {
    return await getAssetFromKV(
      { request, waitUntil: (p) => context.waitUntil(p) },
      {
        mapRequestToAsset: (req) => {
          // Remove leading slash for KV lookup
          const url = new URL(req.url);
          let path = url.pathname;
          if (path.startsWith("/")) path = path.slice(1);
          if (!path) path = "index.html";
          return new Request(path, req);
        },
      }
    );
  } catch (e) {
    return new Response("Not found", { status: 404 });
  }
}