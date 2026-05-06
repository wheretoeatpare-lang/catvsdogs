/**
 * ═══════════════════════════════════════════════════════════
 *  Cat & Dog Co-op Escape — Cloudflare Worker (worker.js)
 * ═══════════════════════════════════════════════════════════
 *
 *  Routes:
 *    GET /room/:roomId  → WebSocket upgrade → GameRoom Durable Object
 *    GET /              → health check
 *
 *  Durable Object "GameRoom" handles all per-room logic.
 *  Each room lives in exactly one DO instance, identified
 *  by the roomId. This guarantees all WebSocket messages
 *  for the same room land in the same process.
 */

export { GameRoom } from './room.js';

export default {
  /**
   * fetch() is the Worker's entry point.
   * The Worker receives the HTTP request and decides
   * whether to handle it directly or forward to a DO.
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── CORS headers (allow browser WS connections) ──
    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Upgrade',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Health check ──
    if (url.pathname === '/') {
      return new Response(JSON.stringify({
        status: 'ok',
        game:   'Cat & Dog Co-op Escape',
        time:   Date.now(),
      }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── WebSocket room endpoint: /room/:roomId ──
    const match = url.pathname.match(/^\/room\/([^/]+)$/);
    if (match) {
      const roomId = decodeURIComponent(match[1]);

      // Validate roomId (alphanumeric + basic chars)
      if (!/^[a-zA-Z0-9_-]{1,30}$/.test(roomId)) {
        return new Response('Invalid room ID', { status: 400 });
      }

      // Get or create a Durable Object instance for this room
      const roomStub = env.GAME_ROOM.get(
        env.GAME_ROOM.idFromName(roomId)
      );

      // Forward the request (with the room ID in the header)
      const newReq = new Request(request, {
        headers: {
          ...Object.fromEntries(request.headers),
          'X-Room-Id': roomId,
        },
      });

      return roomStub.fetch(newReq);
    }

    return new Response('Not found', { status: 404 });
  },
};
