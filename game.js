let ws;
let state = {
  board: [],
  pool: [],
  rows: 4,
  cols: 3,
  players: [],
};
let selectedPiece = null;
let roomId = null;
let playerEmoji = '';

// Emoji pool for players
const EMOJIS = ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮'];

// Image that will be used as puzzle (can be any URL)
const PUZZLE_IMAGE_URL = 'https://picsum.photos/id/100/400/300'; // replace with your own

function assignRandomEmoji() {
  const idx = Math.floor(Math.random() * EMOJIS.length);
  return EMOJIS[idx];
}

document.getElementById("createBtn").addEventListener("click", createRoom);
document.getElementById("joinBtn").addEventListener("click", joinRoom);
document.getElementById("roomInput").addEventListener("keydown", e => { if (e.key==='Enter') joinRoom(); });

function getPlayerName() {
  return document.getElementById("nameInput").value.trim() || "Player";
}

async function createRoom() {
  const res = await fetch("/api/create-room", { method: "POST" });
  const data = await res.json();
  roomId = data.roomId;
  playerEmoji = assignRandomEmoji();
  connect(roomId);
}

function joinRoom() {
  const input = document.getElementById("roomInput");
  roomId = input.value.trim().toUpperCase();
  if (!roomId) return;
  playerEmoji = assignRandomEmoji();
  connect(roomId);
}

function connect(roomId) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/room/${roomId}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "setName", name: getPlayerName() }));
    showGame();
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'state') {
      state.board = msg.board;
      state.pool = msg.pool;
      state.rows = msg.rows;
      state.cols = msg.cols;
      state.players = msg.players;
      document.documentElement.style.setProperty('--board-rows', state.rows);
      document.documentElement.style.setProperty('--board-cols', state.cols);
      render();
    } else if (msg.type === 'placed') {
      state.board = msg.board;
      state.pool = msg.pool;
      selectedPiece = null;
      render();
    } else if (msg.type === 'players') {
      state.players = msg.players;
      renderPlayers();
    } else if (msg.type === 'win') {
      celebrateWin();
    }
  };
  ws.onerror = () => alert("Connection error");
  ws.onclose = () => alert("Disconnected");
}

function showGame() {
  document.getElementById("lobby").classList.add("hidden");
  document.getElementById("game").classList.remove("hidden");
  document.getElementById("roomCodeDisplay").textContent = `Room: ${roomId}`;
}

function render() {
  renderBoard();
  renderPool();
  renderPlayers();
}

function renderBoard() {
  const boardEl = document.getElementById("board");
  boardEl.innerHTML = "";
  for (let r = 0; r < state.rows; r++) {
    for (let c = 0; c < state.cols; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const pieceId = state.board[r][c];
      if (pieceId !== null) {
        cell.classList.add("filled");
        // Use background image with correct tile
        cell.style.backgroundImage = `url(${PUZZLE_IMAGE_URL})`;
        cell.style.backgroundSize = `${state.cols*100}% ${state.rows*100}%`;
        cell.style.backgroundPosition = `${(c/(state.cols-1))*100}% ${(r/(state.rows-1))*100}%`;
        // Add player's emoji who placed it (we don't track who placed, so just put a random emoji from any player)
        if (state.players.length > 0) {
          const emoji = EMOJIS[pieceId % EMOJIS.length]; // deterministic per piece
          const span = document.createElement("span");
          span.className = "piece-emoji";
          span.textContent = emoji;
          cell.appendChild(span);
        }
      }
      cell.addEventListener("click", () => attemptPlace(r, c));
      boardEl.appendChild(cell);
    }
  }
}

function renderPool() {
  const container = document.getElementById("piecesContainer");
  container.innerHTML = "";
  const indicator = document.getElementById("selectedIndicator");
  state.pool.forEach(id => {
    const piece = document.createElement("div");
    piece.className = "piece";
    if (selectedPiece === id) piece.classList.add("selected");
    // Use piece image with correct tile background
    piece.style.backgroundImage = `url(${PUZZLE_IMAGE_URL})`;
    piece.style.backgroundSize = `${state.cols*100}% ${state.rows*100}%`;
    const pieceRow = Math.floor(id / state.cols);
    const pieceCol = id % state.cols;
    piece.style.backgroundPosition = `${(pieceCol/(state.cols-1))*100}% ${(pieceRow/(state.rows-1))*100}%`;
    piece.addEventListener("click", (e) => {
      e.stopPropagation();
      selectedPiece = selectedPiece === id ? null : id;
      renderPool();
    });
    container.appendChild(piece);
  });
  indicator.textContent = selectedPiece !== null ? `Selected: piece ${selectedPiece} ${playerEmoji}` : "Select a piece to place";
}

function renderPlayers() {
  const el = document.getElementById("playersList");
  el.textContent = state.players.length ? "🟢 " + state.players.join(", ") : "Just you";
}

function attemptPlace(row, col) {
  if (selectedPiece === null) return;
  ws.send(JSON.stringify({ type: "place", pieceId: selectedPiece, row, col }));
  selectedPiece = null;
  renderPool();
}

function celebrateWin() {
  document.getElementById("winOverlay").classList.remove("hidden");
  // Launch confetti
  const container = document.getElementById("confettiContainer");
  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement("div");
    confetti.style.position = "absolute";
    confetti.style.left = Math.random() * 100 + "%";
    confetti.style.top = "-10%";
    confetti.style.width = "10px";
    confetti.style.height = "10px";
    confetti.style.background = `hsl(${Math.random() * 360}, 80%, 60%)`;
    confetti.style.animation = `fall ${2 + Math.random() * 3}s linear infinite`;
    container.appendChild(confetti);
  }
}

// Add confetti keyframes dynamically
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes fall {
    to { transform: translateY(110vh) rotate(720deg); opacity: 0; }
  }
`;
document.head.appendChild(styleSheet);