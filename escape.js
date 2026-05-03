let ws;
let myState = {
  solvedCount: 0,
  totalPuzzles: 3,
  currentPuzzle: null,
};
let roomId = null;
let winner = null;
let timeLeft = 300;
let playerEmoji = '';

const EMOJIS = ['🕵️','🕵️‍♀️','🧑‍💻','👩‍🔬','🧙','🦸'];

function assignEmoji() {
  return EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
}

document.getElementById("createBtn").addEventListener("click", createRoom);
document.getElementById("joinBtn").addEventListener("click", joinRoom);
document.getElementById("roomInput").addEventListener("keydown", e => { if (e.key==='Enter') joinRoom(); });
document.getElementById("submitAnswer").addEventListener("click", submitAnswer);
document.getElementById("answerInput").addEventListener("keydown", e => { if (e.key==='Enter') submitAnswer(); });

function getPlayerName() {
  return document.getElementById("nameInput").value.trim() || "Detective";
}

async function createRoom() {
  const res = await fetch("/api/create-escape-room", { method: "POST" });
  const data = await res.json();
  roomId = data.roomId;
  playerEmoji = assignEmoji();
  connect(roomId);
}

function joinRoom() {
  const input = document.getElementById("roomInput");
  roomId = input.value.trim().toUpperCase();
  if (!roomId) return;
  playerEmoji = assignEmoji();
  connect(roomId);
}

function connect(roomId) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${protocol}//${location.host}/escape-room/${roomId}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "setName", name: getPlayerName() }));
    showGame();
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "yourState":
        myState.solvedCount = msg.solvedCount;
        myState.totalPuzzles = msg.totalPuzzles;
        myState.currentPuzzle = msg.currentPuzzle;
        winner = msg.winner;
        if (msg.timeLeft !== undefined) timeLeft = msg.timeLeft;
        updatePuzzleDisplay();
        break;
      case "wrong":
        showMessage(msg.message, true);
        break;
      case "win":
        winner = msg.playerName;
        document.getElementById("winBanner").classList.remove("hidden");
        document.getElementById("winBanner").textContent = `🏆 ${winner} escapes! 🏆`;
        document.getElementById("puzzleBox").style.opacity = "0.5";
        break;
      case "timer":
        timeLeft = msg.timeLeft;
        updateTimer();
        break;
      case "timeUp":
        winner = "no one";
        document.getElementById("winBanner").classList.remove("hidden");
        document.getElementById("winBanner").textContent = "⏰ Time's up! Nobody escaped.";
        document.getElementById("puzzleBox").style.opacity = "0.5";
        break;
      case "progress":
        updateLeaderboard(msg.players);
        break;
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

function updatePuzzleDisplay() {
  const questionEl = document.getElementById("puzzleQuestion");
  const inputEl = document.getElementById("answerInput");
  const submitBtn = document.getElementById("submitAnswer");

  if (winner) {
    questionEl.textContent = "Game over!";
    inputEl.disabled = true;
    submitBtn.disabled = true;
    return;
  }
  if (!myState.currentPuzzle) {
    questionEl.textContent = "You solved all puzzles! Waiting for others...";
    inputEl.disabled = true;
    submitBtn.disabled = true;
    return;
  }
  questionEl.textContent = myState.currentPuzzle.question;
  inputEl.disabled = false;
  submitBtn.disabled = false;
  inputEl.value = "";
  inputEl.focus();
}

function submitAnswer() {
  const input = document.getElementById("answerInput");
  const answer = input.value.trim();
  if (!answer || !ws) return;
  ws.send(JSON.stringify({ type: "answer", answer }));
}

function showMessage(text, isError = false) {
  const area = document.getElementById("messageArea");
  area.textContent = text;
  area.style.color = isError ? "#ff6b6b" : "#00ff88";
  if (isError) {
    document.getElementById("answerInput").classList.add("wrongShake");
    setTimeout(() => document.getElementById("answerInput").classList.remove("wrongShake"), 300);
  }
}

function updateTimer() {
  const mins = Math.floor(timeLeft / 60);
  const secs = timeLeft % 60;
  document.getElementById("timerDisplay").textContent = `${mins.toString().padStart(2,'0')}:${secs.toString().padStart(2,'0')}`;
  const percent = (timeLeft / 300) * 100;
  document.getElementById("timerFill").style.width = percent + "%";
}

function updateLeaderboard(players) {
  const list = document.getElementById("progressList");
  list.innerHTML = "";
  players.sort((a,b) => b.solvedCount - a.solvedCount).forEach(p => {
    const div = document.createElement("div");
    div.className = "progress-item";
    const emoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)]; // deterministic would be better
    div.innerHTML = `
      <span class="player-avatar">${emoji}</span>
      <span class="progress-name">${p.name}</span>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${(p.solvedCount/myState.totalPuzzles)*100}%"></div>
      </div>
      <span>${p.solvedCount}/${myState.totalPuzzles}</span>
    `;
    list.appendChild(div);
  });
}