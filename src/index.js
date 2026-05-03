import { getAssetFromKV } from "@cloudflare/kv-asset-handler";

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ========== PUZZLE PARTY DO (same as before, just adds win broadcast) ==========
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.board = null;
    this.pool = null;
    this.playerNames = new Map();
  }

  async fetch(request) {
    return await handleRoomRequest(this, request);
  }

  async initializeGame(rows, cols) {
    let stored = await this.state.storage.get("board");
    if (stored) {
      this.board = stored.board;
      this.pool = stored.pool;
      this.rows = stored.rows;
      this.cols = stored.cols;
      return;
    }
    this.rows = rows || 4;
    this.cols = cols || 3;
    const total = this.rows * this.cols;
    this.pool = Array.from({ length: total }, (_, i) => i);
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.pool[i], this.pool[j]] = [this.pool[j], this.pool[i]];
    }
    this.board = Array.from({ length: this.rows }, () =>
      Array(this.cols).fill(null)
    );
    await this.persist();
  }

  async persist() {
    await this.state.storage.put({
      board: this.board,
      pool: this.pool,
      rows: this.rows,
      cols: this.cols,
    });
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    this.sessions.forEach(ws => ws.send(data));
  }

  sendState(ws) {
    ws.send(JSON.stringify({
      type: "state",
      board: this.board,
      pool: this.pool,
      rows: this.rows,
      cols: this.cols,
      players: Array.from(this.playerNames.values()),
    }));
  }
}

async function handleRoomRequest(room, request) {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  room.state.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

Room.prototype.webSocketMessage = async function (ws, rawMsg) {
  const msg = JSON.parse(rawMsg);
  switch (msg.type) {
    case "setName": {
      this.playerNames.set(ws, msg.name);
      this.broadcast({
        type: "players",
        players: Array.from(this.playerNames.values()),
      });
      this.sendState(ws);
      break;
    }
    case "place": {
      const { pieceId, row, col } = msg;
      if (row < 0 || row >= this.rows || col < 0 || col >= this.cols) return;
      const correctId = row * this.cols + col;
      if (pieceId !== correctId) return;
      if (this.board[row][col] !== null) return;
      if (!this.pool.includes(pieceId)) return;

      this.pool = this.pool.filter(id => id !== pieceId);
      this.board[row][col] = pieceId;
      await this.persist();

      this.broadcast({
        type: "placed",
        pieceId,
        row,
        col,
        pool: this.pool,
        board: this.board,
      });

      // Check win condition (board fully filled)
      const isFull = this.board.every(row => row.every(cell => cell !== null));
      if (isFull) {
        this.broadcast({ type: "win" });
      }
      break;
    }
  }
};

Room.prototype.webSocketClose = async function (ws) {
  this.sessions = this.sessions.filter(s => s !== ws);
  this.playerNames.delete(ws);
  this.broadcast({
    type: "players",
    players: Array.from(this.playerNames.values()),
  });
};

Room.prototype.webSocketError = function (ws, error) {
  console.error("WebSocket error:", error);
  this.sessions = this.sessions.filter(s => s !== ws);
  this.playerNames.delete(ws);
};

// ========== ESCAPE ROOM DO (with timer) ==========
export class EscapeRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = [];
    this.playerMap = new Map();
    this.winner = null;
    this.gameStarted = false;
    this.timeLeft = 300; // 5 minutes default
    this.timerInterval = null;

    this.puzzles = [
      {
        id: 0,
        question: "Riddle: I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?",
        answer: "echo",
      },
      {
        id: 1,
        question: "Math: What is (12 × 3) + (144 ÷ 12)?",
        answer: "48",
      },
      {
        id: 2,
        question: "Decode this ROT13 cipher: uryyb",
        answer: "hello",
      },
    ];
    this.totalPuzzles = this.puzzles.length;
  }

  async fetch(request) {
    return await handleEscapeRoomRequest(this, request);
  }

  async init() {
    let stored = await this.state.storage.get("winner");
    if (stored) this.winner = stored.winner;
  }

  startTimer() {
    if (this.gameStarted) return;
    this.gameStarted = true;
    this.timerInterval = setInterval(() => {
      if (this.timeLeft <= 0 || this.winner) {
        clearInterval(this.timerInterval);
        if (this.timeLeft <= 0) {
          this.broadcast({ type: "timeUp" });
        }
        return;
      }
      this.timeLeft--;
      this.broadcast({ type: "timer", timeLeft: this.timeLeft });
    }, 1000);
  }

  broadcast(message) {
    const data = JSON.stringify(message);
    this.sessions.forEach(ws => ws.send(data));
  }

  sendPersonalState(ws) {
    const player = this.playerMap.get(ws);
    if (!player) return;
    const currentPuzzle = player.solvedCount < this.totalPuzzles
      ? this.puzzles[player.solvedCount]
      : null;
    ws.send(JSON.stringify({
      type: "yourState",
      solvedCount: player.solvedCount,
      totalPuzzles: this.totalPuzzles,
      currentPuzzle: currentPuzzle ? { id: currentPuzzle.id, question: currentPuzzle.question } : null,
      winner: this.winner,
      timeLeft: this.timeLeft,
    }));
  }

  async submitAnswer(ws, answer) {
    if (this.winner || this.timeLeft <= 0) return;
    const player = this.playerMap.get(ws);
    if (!player || player.solvedCount >= this.totalPuzzles) return;

    const currentPuzzle = this.puzzles[player.solvedCount];
    if (answer.trim().toLowerCase() !== currentPuzzle.answer) {
      ws.send(JSON.stringify({ type: "wrong", message: "Incorrect answer." }));
      return;
    }

    player.solvedCount++;
    this.playerMap.set(ws, player);

    if (player.solvedCount >= this.totalPuzzles) {
      this.winner = player.name;
      await this.state.storage.put("winner", this.winner);
      clearInterval(this.timerInterval);
      this.broadcast({
        type: "win",
        playerName: player.name,
      });
    } else {
      this.sendPersonalState(ws);
      this.broadcastProgress();
    }
  }

  broadcastProgress() {
    const players = [];
    this.playerMap.forEach((p, ws) => {
      players.push({ name: p.name, solvedCount: p.solvedCount });
    });
    this.broadcast({ type: "progress", players });
  }
}

async function handleEscapeRoomRequest(room, request) {
  await room.init();
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  room.state.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

EscapeRoom.prototype.webSocketMessage = async function (ws, rawMsg) {
  const msg = JSON.parse(rawMsg);
  switch (msg.type) {
    case "setName": {
      const id = crypto.randomUUID();
      this.playerMap.set(ws, { id, name: msg.name, solvedCount: 0 });
      if (!this.gameStarted && this.playerMap.size === 1) {
        this.startTimer(); // start on first join
      }
      this.sendPersonalState(ws);
      this.broadcastProgress();
      ws.send(JSON.stringify({ type: "timer", timeLeft: this.timeLeft }));
      break;
    }
    case "answer": {
      await this.submitAnswer(ws, msg.answer);
      break;
    }
  }
};

EscapeRoom.prototype.webSocketClose = async function (ws) {
  this.sessions = this.sessions.filter(s => s !== ws);
  this.playerMap.delete(ws);
  this.broadcastProgress();
};

EscapeRoom.prototype.webSocketError = function (ws, error) {
  console.error("EscapeRoom WS error:", error);
  this.sessions = this.sessions.filter(s => s !== ws);
  this.playerMap.delete(ws);
};

// ========== Worker entry ==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

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