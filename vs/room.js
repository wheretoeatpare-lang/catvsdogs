/**
 * ═══════════════════════════════════════════════════════════
 *  Cat & Dog Co-op Escape — GameRoom Durable Object (room.js)
 * ═══════════════════════════════════════════════════════════
 *
 *  Each GameRoom instance manages ONE game room:
 *    - Accepts up to 2 WebSocket connections
 *    - Assigns roles (cat / dog)
 *    - Relays messages between the two players
 *    - Tracks basic world state (door, box position)
 *
 *  Durable Objects guarantee:
 *    - Single-threaded execution (no race conditions)
 *    - Persistent state via this.storage
 *    - WebSocket hibernation support
 */

export class GameRoom {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;

    /**
     * players Map: playerId → { ws, role, lastSeen }
     * max 2 entries (cat + dog)
     */
    this.players = new Map();

    /** Simple game state synced to all clients */
    this.worldState = {
      doorOpen:   false,
      boxPosition: { x: -3, y: 0, z: -3 },
    };

    this._idCounter = 0;
  }

  // ── Entry point for all HTTP/WS requests to this DO ──
  async fetch(request) {
    const upgradeHeader = request.headers.get('Upgrade');

    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      return this._handleWebSocket(request);
    }

    // Non-WS: return room info (useful for debugging)
    return new Response(JSON.stringify({
      room:    request.headers.get('X-Room-Id') || 'unknown',
      players: this.players.size,
      world:   this.worldState,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── WebSocket upgrade + session management ──────────────
  async _handleWebSocket(request) {
    // Reject if room is full
    if (this.players.size >= 2) {
      return new Response('Room full', { status: 429 });
    }

    // Create a WebSocket pair (CF-specific API)
    const { 0: clientWs, 1: serverWs } = new WebSocketPair();

    const playerId = `p${++this._idCounter}`;
    const role     = this.players.size === 0 ? 'cat' : 'dog';

    // Track this player
    this.players.set(playerId, {
      ws:       serverWs,
      role,
      lastSeen: Date.now(),
    });

    // Accept the WS on the server side
    serverWs.accept();

    // Welcome message → tells client their role
    this._send(serverWs, {
      type:     'welcome',
      role,
      playerId,
      roomSize: this.players.size,
    });

    // Notify the other player (if any) that a peer joined
    if (this.players.size === 2) {
      this._broadcast('peerJoined', { role }, playerId);
      // Also tell the new player the game can start
      this._send(serverWs, { type: 'startGame' });
    }

    // Send current world state to new joiner
    this._send(serverWs, {
      type:  'worldSync',
      world: this.worldState,
    });

    // ── Message handler ──
    serverWs.addEventListener('message', async event => {
      try {
        const msg = JSON.parse(event.data);
        await this._handleMessage(playerId, msg);
      } catch (e) {
        console.error('[GameRoom] Bad message:', e);
      }
    });

    // ── Close handler ──
    serverWs.addEventListener('close', () => {
      this.players.delete(playerId);
      this._broadcast('peerLeft', { role }, null);
      console.log(`[GameRoom] ${role} (${playerId}) disconnected. Players: ${this.players.size}`);
    });

    serverWs.addEventListener('error', err => {
      console.error('[GameRoom] WS error:', err);
      this.players.delete(playerId);
    });

    return new Response(null, {
      status:  101, // Switching Protocols
      webSocket: clientWs,
    });
  }

  // ── Message routing ──────────────────────────────────────
  async _handleMessage(fromId, msg) {
    const player = this.players.get(fromId);
    if (!player) return;

    player.lastSeen = Date.now();

    switch (msg.type) {

      /**
       * playerMove — position/rotation sync
       * Just relay to the other player, attaching sender role.
       */
      case 'playerMove':
        this._broadcast('playerMove', {
          x:    msg.x  || 0,
          y:    msg.y  || 0,
          z:    msg.z  || 0,
          ry:   msg.ry || 0,
          vx:   msg.vx || 0,
          vy:   msg.vy || 0,
          vz:   msg.vz || 0,
          role: player.role,
        }, fromId);
        break;

      /**
       * worldEvent — door switch, box push, etc.
       * Update server-side world state, relay to all.
       */
      case 'worldEvent':
        await this._handleWorldEvent(fromId, msg);
        break;

      /**
       * ping — keep-alive
       */
      case 'ping':
        this._send(player.ws, { type: 'pong', t: msg.t });
        break;

      /**
       * chat — simple text relay
       */
      case 'chat':
        this._broadcast('chat', {
          role:    player.role,
          message: String(msg.message || '').slice(0, 200),
        }, null); // send to ALL including sender
        break;

      default:
        console.warn('[GameRoom] Unknown message type:', msg.type);
    }
  }

  async _handleWorldEvent(fromId, msg) {
    const player = this.players.get(fromId);

    switch (msg.event) {
      case 'switchActivated':
        // Cat can only activate if door isn't already open
        if (!this.worldState.doorOpen && player.role === 'cat') {
          this.worldState.doorOpen = true;
          // Persist (survives hibernation)
          await this.state.storage.put('doorOpen', true);
          // Tell EVERYONE
          this._broadcast('worldEvent', { event: 'switchActivated' }, null);
        }
        break;

      case 'boxMoved':
        this.worldState.boxPosition = {
          x: msg.x || 0,
          y: msg.y || 0,
          z: msg.z || 0,
        };
        // Only relay, don't need to persist box position
        this._broadcast('worldEvent', {
          event: 'boxMoved',
          x:     msg.x,
          y:     msg.y,
          z:     msg.z,
        }, fromId);
        break;
    }
  }

  // ── Helpers ──────────────────────────────────────────────

  /** Send a JSON message to a single WebSocket */
  _send(ws, data) {
    try {
      if (ws.readyState === 1) { // OPEN
        ws.send(JSON.stringify(data));
      }
    } catch (e) {
      console.error('[GameRoom] Send error:', e);
    }
  }

  /**
   * Broadcast to all players except optionally one.
   * @param {string} type
   * @param {object} data
   * @param {string|null} excludeId - playerId to skip (null = send to all)
   */
  _broadcast(type, data, excludeId) {
    const msg = JSON.stringify({ type, ...data });
    for (const [id, p] of this.players) {
      if (excludeId !== null && id === excludeId) continue;
      try {
        if (p.ws.readyState === 1) p.ws.send(msg);
      } catch (e) {
        console.error('[GameRoom] Broadcast error to', id, e);
      }
    }
  }
}
