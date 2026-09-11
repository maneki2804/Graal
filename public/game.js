/* ============================================================
   GRAAL HUNT — Multiplayer Client  (public/game.js)
   Подключается к WebSocket-серверу, рендерит состояние.
   Вся игровая логика — на сервере. Клиент только отправляет команды.
   ============================================================ */

'use strict';

// ─── URL сервера ──────────────────────────────────────────────────────────────
// Замени строку ниже на реальный Railway URL после деплоя:
//   'wss://graal-production.up.railway.app'
// При локальном запуске оставь '__RAILWAY_URL__' — подключится к ws://localhost:8765
const RAILWAY_URL = 'wss://graal-production.up.railway.app';

const WS_BASE = (() => {
  if (!RAILWAY_URL.startsWith('__')) return RAILWAY_URL;
  const loc = window.location;
  return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host;
})();

// ============================================================
// КОНСТАНТЫ
// ============================================================
const TEAM_COLORS = ['#2ec4b6', '#f4a017', '#a569e0', '#e05c6a'];
const TEAM_NAMES_RU = ['Бирюза', 'Янтарь', 'Аметист', 'Коралл'];

const ABILITY_DEFS = [
  { id: 'extra_move', icon: '🏃', name: 'Доп. ход',    desc: 'Переместись на 1 гекс дополнительно.' },
  { id: 'saboteur',   icon: '🗡',  name: 'Диверсант',  desc: 'Отключи предмет врага перед боем. Блокирует отступление.' },
  { id: 'duelist',    icon: '⚔',  name: 'Дуэлянт',    desc: '+3 Атаки в бою, нет слабости в массовых схватках.' },
  { id: 'healer',     icon: '💊', name: 'Лекарь',      desc: 'Восстанови 4 HP себе или союзнику (раз за бой).' },
  { id: 'reviver',    icon: '✨', name: 'Воскреситель', desc: 'Воскреси одного павшего союзника после боя (раз за игру).' },
  { id: 'smuggler',   icon: '🎒', name: 'Контрабандист',desc: 'Носи до 2 предметов вместо 1.' },
];
const ITEM_DEFS = {
  rope:   { icon: '🪢', name: 'Верёвка', desc: 'Проход через горы.' },
  boat:   { icon: '⛵', name: 'Лодка',   desc: 'Переплыть воду.' },
  axe:    { icon: '🪓', name: 'Топор',   desc: 'Обычное движение в лесу.' },
  sword:  { icon: '⚔',  name: 'Меч',     desc: '+2 Атаки всей команде.' },
  shield: { icon: '🛡', name: 'Щит',     desc: '+2 Защиты всей команде.' },
  cloak:  { icon: '🧥', name: 'Плащ',    desc: '25% уклонения.' },
  wand:   { icon: '🪄', name: 'Жезл',    desc: '+1 урон по площади.' },
};

// Цвета местности для Canvas
const TERRAIN_COLORS = {
  plains:   '#1c2a1a',
  forest:   '#152810',
  mountain: '#272030',
  water:    '#0c1a38',
  grailzone:'#2a1e08',
};
const TERRAIN_ICONS = { forest: '🌲', mountain: '⛰', water: '〰' };

// ============================================================
// HEX MATH
// ============================================================
const Hex = {
  toPixel(c, r, s) {
    return { x: s * Math.sqrt(3) * (c + 0.5 * (r & 1)), y: s * 1.5 * r };
  },
  distance(c1, r1, c2, r2) {
    const [ax,ay,az] = Hex.toCube(c1,r1), [bx,by,bz] = Hex.toCube(c2,r2);
    return Math.max(Math.abs(ax-bx), Math.abs(ay-by), Math.abs(az-bz));
  },
  toCube(c, r) { const x = c-(r-(r&1))/2, z = r; return [x,-x-z,z]; },
  neighbors(c, r) {
    return (r&1) === 0
      ? [[c-1,r],[c+1,r],[c,r-1],[c-1,r-1],[c,r+1],[c-1,r+1]]
      : [[c-1,r],[c+1,r],[c+1,r-1],[c,r-1],[c+1,r+1],[c,r+1]];
  },
};

// ============================================================
// СОСТОЯНИЕ КЛИЕНТА
// ============================================================
let ws = null;
let myTeamIdx      = null;
let myRoomCode     = null;
let gameState      = null;
let validMoves     = [];
let extraMoveActive = false;
let itemDialogOpen  = false;
let hexSize         = 18;
let camX = 0, camY = 0, targetCamX = 0, targetCamY = 0;
let hoveredHex      = null;
let animTime        = 0;
let lastTime        = performance.now();
let globalCanvas    = null, globalCtx = null;
let combatCanvas    = null;
let isDragging      = false, lastMouse = null;

// ============================================================
// WEBSOCKET
// ============================================================
function connect() {
  ws = new WebSocket(WS_BASE);
  ws.onopen  = () => { console.log('[GH] WS подключён:', WS_BASE); };
  ws.onmessage = (e) => {
    try { handleServerMsg(JSON.parse(e.data)); } catch(err) { console.error(err); }
  };
  ws.onclose = () => {
    showBanner('Соединение потеряно — переподключение...');
    setTimeout(connect, 3000);
  };
  ws.onerror = () => {};
}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ============================================================
// ОБРАБОТЧИК СООБЩЕНИЙ СЕРВЕРА
// ============================================================
function handleServerMsg(msg) {
  switch (msg.type) {
    case 'room_created':
      myRoomCode = msg.roomCode; myTeamIdx = msg.teamIdx;
      showLobbyWaiting(msg.roomCode, msg.config);
      break;
    case 'joined':
      myRoomCode = msg.roomCode; myTeamIdx = msg.teamIdx;
      showLobbyWaiting(msg.roomCode, msg.config);
      break;
    case 'player_joined':
      updateLobbyCount(msg.totalJoined, msg.needed);
      break;
    case 'player_left':
      showBanner(`Команда ${msg.teamIdx + 1} отключилась`);
      break;
    case 'game_started':
      showBanner('Игра началась!');
      break;
    case 'state':
      gameState = msg.state;
      // Патч: использовать наши цвета
      if (gameState) patchTeamColors(gameState);
      onStateUpdate();
      break;
    case 'timer':
      if (gameState) { gameState.turnTimeLeft = msg.value; updateTimerUI(msg.value); }
      break;
    case 'your_turn':
      validMoves = msg.validMoves || [];
      if (globalCanvas) globalCanvas.style.cursor = 'pointer';
      break;
    case 'active_turn':
      if (msg.teamIdx !== myTeamIdx) validMoves = [];
      break;
    case 'your_setup_turn':
      if (gameState) updateAbilityScreen(gameState);
      break;
    case 'ability_setup_turn':
      if (gameState) updateAbilityScreen(gameState);
      break;
    case 'extra_move_mode':
      extraMoveActive = true;
      validMoves = msg.validMoves || [];
      showBanner('Дополнительный ход — кликни на подсвеченный гекс');
      break;
    case 'your_combat_turn':
      updateCombatActionButtons(msg.side);
      break;
    case 'error':
      showBanner(`⚠ ${msg.message}`);
      break;
  }
}

function patchTeamColors(state) {
  if (!state.teams) return;
  state.teams.forEach((t, i) => {
    t.color = TEAM_COLORS[i] || t.color;
    t.name  = TEAM_NAMES_RU[i] || t.name;
  });
}

// ============================================================
// STATE → UI
// ============================================================
function onStateUpdate() {
  const s = gameState;
  if (!s) return;

  switch (s.phase) {
    case 'ABILITY_SELECTION':
      if (document.getElementById('screen-ability').classList.contains('hidden')) {
        showScreen('screen-ability');
        setupAbilityCards();
      }
      updateAbilityScreen(s);
      break;

    case 'GLOBAL_MAP':
      if (document.getElementById('screen-game').classList.contains('hidden')) {
        enterGameScreen(s);
      }
      if (s.pendingItem && !itemDialogOpen) showItemDialog(s);
      updateHUD(s);
      if (!s.pendingItem) updateValidMovesHighlight(s);
      break;

    case 'COMBAT':
      if (document.getElementById('screen-combat').classList.contains('hidden')) {
        enterCombatScreen(s);
      }
      updateCombatHUD(s);
      break;

    case 'VICTORY':
      showVictoryScreen(s);
      break;
  }
}

// ============================================================
// ЛОББИ
// ============================================================
function showLobbyWaiting(code, config) {
  showScreen('screen-lobby');
  document.getElementById('lobby-code').textContent = code;

  const badge = document.getElementById('lobby-team-badge');
  const color = TEAM_COLORS[myTeamIdx] || '#d4a832';
  const name  = TEAM_NAMES_RU[myTeamIdx] || `Команда ${myTeamIdx+1}`;
  badge.textContent = name;
  badge.style.color  = color;
  badge.style.borderColor = color;
  badge.style.background  = color + '22';

  updateLobbyCount(1, config.numTeams);
  renderLobbyDots(1, config.numTeams);
}

function renderLobbyDots(joined, needed) {
  const wrap = document.getElementById('lobby-dots');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (let i = 0; i < needed; i++) {
    const d = document.createElement('div');
    d.className = 'lobby-dot' + (i < joined ? ' filled' : '');
    wrap.appendChild(d);
  }
}

function updateLobbyCount(joined, needed) {
  document.getElementById('lobby-count').textContent = `${joined} / ${needed} команд подключились`;
  const missing = needed - joined;
  document.getElementById('lobby-waiting').textContent =
    missing > 0 ? `Ждём ещё ${missing} ${missing === 1 ? 'команду' : 'команды'}...` : 'Все готовы — начинаем!';
  renderLobbyDots(joined, needed);
}

// ============================================================
// ВЫБОР СПОСОБНОСТЕЙ
// ============================================================
function setupAbilityCards() {
  const grid = document.getElementById('ability-grid');
  grid.innerHTML = '';
  for (const ab of ABILITY_DEFS) {
    const card = document.createElement('div');
    card.className = 'ability-card';
    card.dataset.abilityId = ab.id;
    card.innerHTML = `
      <span class="ability-icon" aria-hidden="true">${ab.icon}</span>
      <div class="ability-name">${ab.name}</div>
      <div class="ability-desc">${ab.desc}</div>`;
    card.addEventListener('click', () => {
      document.querySelectorAll('.ability-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      document.getElementById('btn-confirm-ability').disabled = false;
    });
    grid.appendChild(card);
  }
}

function updateAbilityScreen(state) {
  const setup = state.abilitySetup;
  if (!setup) return;
  const team = state.teams[setup.teamIdx];
  const isMyTurn = setup.teamIdx === myTeamIdx;

  document.getElementById('ability-player-title').textContent =
    `${team.name} — Игрок ${setup.playerIdx + 1}`;

  const badge = document.getElementById('ability-team-badge');
  badge.textContent = team.name;
  badge.style.color = team.color;
  badge.style.borderColor = team.color;
  badge.style.background  = team.color + '22';

  document.getElementById('ability-your-turn-notice').style.display = isMyTurn ? 'block' : 'none';
  document.getElementById('ability-waiting-notice').style.display   = isMyTurn ? 'none'  : 'block';

  const grid = document.getElementById('ability-grid');
  grid.style.pointerEvents = isMyTurn ? 'auto' : 'none';
  grid.style.opacity        = isMyTurn ? '1' : '0.4';
  document.querySelectorAll('.ability-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('btn-confirm-ability').disabled = true;
}

// ============================================================
// ИГРОВОЙ ЭКРАН
// ============================================================
function enterGameScreen(state) {
  showScreen('screen-game');
  const hud = document.getElementById('hud');
  hud.style.display = ''; hud.classList.remove('hidden');

  globalCanvas = document.getElementById('game-canvas');
  globalCtx    = globalCanvas.getContext('2d');
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  const me = state.teams[myTeamIdx];
  if (me) {
    const p = me.players.find(p => p.alive);
    if (p) centerMapOn(p.col, p.row, state.map.size);
  }
  buildTeamStrips(state);
  setupMapEvents();
  startRenderLoop();
}

function resizeCanvas() {
  if (globalCanvas) { globalCanvas.width = innerWidth; globalCanvas.height = innerHeight; }
  if (combatCanvas) { combatCanvas.width = innerWidth; combatCanvas.height = innerHeight; }
}

function centerMapOn(col, row) {
  const { x, y } = Hex.toPixel(col, row, hexSize);
  targetCamX = camX = innerWidth  / 2 - x;
  targetCamY = camY = innerHeight / 2 - y;
}

function setupMapEvents() {
  globalCanvas.addEventListener('mousedown', e => {
    if (e.button === 2) { isDragging = true; lastMouse = { x: e.clientX, y: e.clientY }; }
  });
  globalCanvas.addEventListener('mousemove', e => {
    if (isDragging && lastMouse) {
      targetCamX += e.clientX - lastMouse.x;
      targetCamY += e.clientY - lastMouse.y;
      camX = targetCamX; camY = targetCamY;
      lastMouse = { x: e.clientX, y: e.clientY };
    }
    hoveredHex = screenToHex(e.clientX, e.clientY);
  });
  globalCanvas.addEventListener('mouseup',  () => { isDragging = false; lastMouse = null; });
  globalCanvas.addEventListener('contextmenu', e => e.preventDefault());
  globalCanvas.addEventListener('wheel', e => {
    const f  = e.deltaY > 0 ? 0.9 : 1.1;
    const ns = Math.max(8, Math.min(40, hexSize * f));
    const r  = ns / hexSize;
    targetCamX = e.clientX - (e.clientX - targetCamX) * r;
    targetCamY = e.clientY - (e.clientY - targetCamY) * r;
    camX = targetCamX; camY = targetCamY;
    hexSize = ns;
  });
  // Touch pan
  let lastTouch = null;
  globalCanvas.addEventListener('touchstart', e => {
    if (e.touches.length === 1) lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  globalCanvas.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && lastTouch) {
      const dx = e.touches[0].clientX - lastTouch.x;
      const dy = e.touches[0].clientY - lastTouch.y;
      targetCamX += dx; targetCamY += dy;
      camX = targetCamX; camY = targetCamY;
      lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
  }, { passive: true });
  globalCanvas.addEventListener('touchend', () => { lastTouch = null; });
  globalCanvas.addEventListener('click', e => {
    const s = gameState;
    if (!s || s.phase !== 'GLOBAL_MAP') return;
    if (itemDialogOpen) return;
    if (s.activeTeamIdx !== myTeamIdx) return;
    const hex = screenToHex(e.clientX, e.clientY);
    if (!hex) return;
    const { col, row } = hex;
    if (extraMoveActive) {
      send({ type: 'extra_move', col, row });
      extraMoveActive = false; validMoves = [];
      return;
    }
    if (validMoves.some(m => m.col === col && m.row === row)) {
      send({ type: 'move', col, row });
    }
  });
}

function updateValidMovesHighlight(s) {
  if (s.activeTeamIdx !== myTeamIdx) validMoves = [];
}

function screenToHex(sx, sy) {
  const lx = sx - camX, ly = sy - camY;
  const r = Math.round(ly / (hexSize * 1.5));
  const c = Math.round((lx / (hexSize * Math.sqrt(3))) - 0.5 * (r & 1));
  return { col: c, row: r };
}

// ============================================================
// HUD
// ============================================================
function buildTeamStrips(state) {
  const top = document.getElementById('hud-top');
  top.innerHTML = '';
  for (const team of state.teams) {
    const el = document.createElement('div');
    el.className = 'team-strip';
    el.id = `team-strip-${team.idx}`;
    el.style.setProperty('--team-color', team.color);
    const aliveCount = team.players.filter(p => p.alive).length;
    el.innerHTML = `
      <span class="team-dot" style="background:${team.color}"></span>
      <span class="team-name-label" style="color:${team.color}">${team.name}</span>
      <span class="team-hp-mini" id="team-hp-${team.idx}">${aliveCount}/4</span>`;
    top.appendChild(el);
  }
}

function updateHUD(state) {
  if (state.phase !== 'GLOBAL_MAP') return;
  const ti = state.activeTeamIdx, pi = state.activePlayerIdx;
  const team   = state.teams[ti];
  const player = team?.players[pi];

  document.getElementById('round-num').textContent = state.round;
  updateTimerUI(Math.ceil(state.turnTimeLeft || 0));

  const isMyTurn = ti === myTeamIdx;
  document.getElementById('timer-label').textContent = isMyTurn ? 'ВАШ ХОД' : `ХОД: ${team?.name?.toUpperCase()}`;

  if (player) {
    const isMe = ti === myTeamIdx;
    document.getElementById('active-player-name').textContent =
      isMe ? `Ваша команда — Игрок ${player.idx+1}` : `${team.name} — Игрок ${player.idx+1}`;
    document.getElementById('active-player-name').style.color = team.color;

    const ab = ABILITY_DEFS.find(a => a.id === player.ability);
    document.getElementById('active-ability-name').textContent = ab ? ab.name : '—';

    const slots = document.getElementById('active-item-slots');
    slots.innerHTML = '';
    const maxSlots = player.ability === 'smuggler' ? 2 : 1;
    for (let i = 0; i < maxSlots; i++) {
      const s = document.createElement('div');
      s.className = 'item-slot' + (player.items[i] ? ' filled' : '');
      if (player.items[i]) {
        const d = ITEM_DEFS[player.items[i]];
        s.textContent = d?.icon || '?';
        s.title = d?.name || '';
      }
      slots.appendChild(s);
    }

    const abilityBtn = document.getElementById('btn-ability-use');
    const canUse = isMe && !player.abilityUsed && player.ability === 'extra_move' && !extraMoveActive;
    abilityBtn.disabled = !canUse;
    abilityBtn.textContent = ab ? `${ab.icon} ${ab.name}` : 'Способность';

    document.getElementById('btn-end-turn').disabled = !isMe;
  }

  // Обновляем полоски команд
  for (const t of state.teams) {
    const strip = document.getElementById(`team-strip-${t.idx}`);
    if (!strip) continue;

    // Убираем старые активные метки
    strip.querySelectorAll('.team-turn-badge').forEach(b => b.remove());

    if (t.idx === ti) {
      strip.classList.add('active');
      strip.style.setProperty('--team-color', t.color);
      const b = document.createElement('span');
      b.className = 'team-turn-badge';
      b.textContent = t.idx === myTeamIdx ? 'ВАШ ХОД' : 'ХОДИТ';
      strip.appendChild(b);
    } else {
      strip.classList.remove('active');
    }

    if (t.eliminated) strip.style.opacity = '0.3';
    const aliveCount = t.players.filter(p => p.alive).length;
    const hpEl = document.getElementById(`team-hp-${t.idx}`);
    if (hpEl) hpEl.textContent = `${aliveCount}/4`;
  }
}

function updateTimerUI(t) {
  const tv = document.getElementById('timer-value');
  if (!tv) return;
  tv.textContent = t;
  tv.className = t <= 5 ? 'urgent' : '';
  const dur = gameState?.config?.turnDuration || 15;
  const pct = Math.max(0, Math.min(100, t / dur * 100));
  const bar = document.getElementById('timer-bar');
  if (bar) {
    bar.style.width = pct + '%';
    bar.style.background = t <= 5 ? '#e05c6a' : t <= 8 ? '#f4a017' : 'var(--gold)';
  }
}

// ============================================================
// ДИАЛОГ ПРЕДМЕТА
// ============================================================
function showItemDialog(state) {
  const pi = state.pendingItem;
  if (!pi || pi.teamIdx !== myTeamIdx) return;
  const def = ITEM_DEFS[pi.itemId];
  if (!def) return;
  itemDialogOpen = true;

  const player   = state.teams[pi.teamIdx].players[pi.playerIdx];
  const team     = state.teams[pi.teamIdx];
  const maxSlots = player.ability === 'smuggler' ? 2 : 1;
  const hasFreeSlot = player.items.length < maxSlots;

  document.getElementById('item-found-icon').textContent = def.icon;
  document.getElementById('item-found-name').textContent = def.name;
  document.getElementById('item-found-desc').textContent = def.desc;

  const actions = document.getElementById('item-dialog-actions');
  while (actions.firstChild) actions.removeChild(actions.firstChild);

  const close = () => {
    itemDialogOpen = false;
    document.getElementById('item-dialog').classList.add('hidden');
  };
  const addBtn = (label, isPrimary, cb) => {
    const btn = document.createElement('button');
    btn.className = 'dialog-btn' + (isPrimary ? ' primary' : '');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', e => { e.stopPropagation(); cb(); });
    actions.appendChild(btn);
  };

  if (hasFreeSlot) {
    addBtn(`Взять: ${def.name}`, true, () => { send({ type: 'item_pickup', action: 'take' }); close(); });
  } else {
    addBtn('Заменить текущий предмет', true, () => { send({ type: 'item_pickup', action: 'replace' }); close(); });
  }
  for (const ally of team.players) {
    if (ally.idx === player.idx || !ally.alive) continue;
    const allyMax = ally.ability === 'smuggler' ? 2 : 1;
    if (ally.items.length < allyMax) {
      const ai = ally.idx;
      addBtn(`Отдать игроку ${ai+1}`, false, () => { send({ type: 'item_pickup', action: 'give', targetPlayerIdx: ai }); close(); });
    }
  }
  addBtn('Оставить на месте', false, () => { send({ type: 'item_pickup', action: 'leave' }); close(); });

  document.getElementById('item-dialog').classList.remove('hidden');
}

// ============================================================
// БОЙ
// ============================================================
function enterCombatScreen(state) {
  showScreen('screen-combat');
  document.getElementById('spectator-overlay').classList.add('hidden');
  if (!combatCanvas) {
    combatCanvas = document.getElementById('combat-canvas');
    combatCanvas.width = innerWidth; combatCanvas.height = innerHeight;
  }
  updateCombatHUD(state);
}

function updateCombatHUD(state) {
  const c = state.combat;
  if (!c) return;

  document.getElementById('ctA-name').textContent = `Команда ${c.teamA.name}`;
  const dotA = document.getElementById('ctA-dot');
  dotA.style.background = c.teamA.color;
  dotA.style.boxShadow  = `0 0 8px ${c.teamA.color}`;

  document.getElementById('ctB-name').textContent = `Команда ${c.teamB.name}`;
  const dotB = document.getElementById('ctB-dot');
  dotB.style.background = c.teamB.color;
  dotB.style.boxShadow  = `0 0 8px ${c.teamB.color}`;

  const sumHp = fts => fts.reduce((s,f) => s + Math.max(0,f.hp), 0);
  const maxHp = fts => fts.reduce((s,f) => s + f.maxHp, 0);
  const pctA  = maxHp(c.fightersA) > 0 ? sumHp(c.fightersA)/maxHp(c.fightersA) : 0;
  const pctB  = maxHp(c.fightersB) > 0 ? sumHp(c.fightersB)/maxHp(c.fightersB) : 0;

  const hpA = document.getElementById('ctA-hp');
  hpA.style.width      = pctA*100 + '%';
  hpA.style.background = c.teamA.color;
  const hpB = document.getElementById('ctB-hp');
  hpB.style.width      = pctB*100 + '%';
  hpB.style.background = c.teamB.color;

  const log = document.getElementById('combat-log');
  log.innerHTML = c.log.slice(-10).map(l => {
    const cls = (l.includes('-') && l.includes('HP')) ? 'damage' : l.includes('+') ? 'heal' : 'system';
    return `<div class="log-entry ${cls}">${escHtml(l)}</div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;

  const mySide = c.teamA.idx === myTeamIdx ? 'A' : (c.teamB.idx === myTeamIdx ? 'B' : null);
  const isMyTeamInCombat = mySide !== null;

  const attackBtn  = document.getElementById('btn-combat-attack');
  const retreatBtn = document.getElementById('btn-combat-retreat');
  const healBtn    = document.getElementById('btn-combat-ability');

  if (c.phase === 'DONE') {
    attackBtn.textContent = 'Завершить бой →';
    attackBtn.disabled    = !isMyTeamInCombat;
    attackBtn.onclick     = () => send({ type: 'combat_dismiss' });
    retreatBtn.style.display = 'none';
    healBtn.style.display    = 'none';
    return;
  }

  if (!isMyTeamInCombat) {
    attackBtn.disabled = true;
    retreatBtn.style.display = 'none';
    healBtn.style.display    = 'none';
    return;
  }

  attackBtn.textContent = 'Атаковать ⚔';
  attackBtn.onclick     = () => send({ type: 'combat_attack' });
  attackBtn.disabled    = false;

  retreatBtn.style.display = (c.phase === 'RETREAT_OFFER' && !c.retreatBlocked) ? '' : 'none';
  retreatBtn.onclick = () => send({ type: 'combat_retreat' });

  const team     = state.teams[myTeamIdx];
  const hasHealer = team?.players.some(p => p.ability === 'healer' && p.alive);
  const healFlag  = mySide === 'A' ? c.healerUsedA : c.healerUsedB;
  healBtn.style.display = hasHealer ? '' : 'none';
  healBtn.disabled      = !!healFlag;
  healBtn.textContent   = healFlag ? '💊 Использовано' : '💊 Лечить союзника';
  healBtn.onclick       = () => send({ type: 'combat_heal' });
}

function updateCombatActionButtons(side) {
  const mySide = gameState?.combat?.teamA?.idx === myTeamIdx ? 'A' : 'B';
  const attackBtn = document.getElementById('btn-combat-attack');
  if (attackBtn) attackBtn.disabled = (side !== mySide);
}

// ============================================================
// ЭКРАН ПОБЕДЫ
// ============================================================
function showVictoryScreen(state) {
  document.getElementById('screen-combat').classList.add('hidden');
  const hud = document.getElementById('hud');
  hud.classList.add('hidden'); hud.style.display = 'none';
  showScreen('screen-victory');

  const winner = state.winner;
  const isMe   = winner && winner.idx === myTeamIdx;
  document.getElementById('victory-team-name').textContent =
    isMe ? '🏆 Ваша команда победила!' : (winner ? `Команда ${winner.name} победила!` : 'Ничья!');
  if (winner) document.getElementById('victory-team-name').style.color = winner.color;
  document.getElementById('stat-rounds').textContent  = state.round;
  document.getElementById('stat-battles').textContent = state.battleCount;
}

// ============================================================
// РЕНДЕР ЦИКЛ
// ============================================================
function startRenderLoop() {
  function loop(ts) {
    requestAnimationFrame(loop);
    const dt = Math.min((ts - lastTime) / 1000, 0.1);
    lastTime = ts; animTime += dt;
    camX += (targetCamX - camX) * 0.12;
    camY += (targetCamY - camY) * 0.12;
    const s = gameState;
    if (!s) return;
    if (s.phase === 'GLOBAL_MAP' || s.phase === 'COMBAT') renderGlobalMap(s);
    if (s.phase === 'COMBAT' && combatCanvas) renderCombat(s.combat, dt);
  }
  lastTime = performance.now();
  requestAnimationFrame(loop);
}

// ============================================================
// РЕНДЕР КАРТЫ
// ============================================================
function renderGlobalMap(state) {
  if (!globalCtx || !globalCanvas) return;
  const ctx = globalCtx;
  const W = globalCanvas.width, H = globalCanvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0c1319'; ctx.fillRect(0, 0, W, H);

  const { map, teams, config, activeTeamIdx } = state;
  const hs = hexSize, fog = config.fogEnabled;
  const myTeam = teams[myTeamIdx];
  const SQRT3  = Math.sqrt(3);

  ctx.save(); ctx.translate(camX, camY);

  const sc = Math.floor((-camX - 60) / (hs * SQRT3));
  const ec = Math.ceil((-camX + W + 60) / (hs * SQRT3));
  const sr = Math.floor((-camY - 60) / (hs * 1.5));
  const er = Math.ceil((-camY + H + 60) / (hs * 1.5));

  const myFog = new Set(Array.isArray(myTeam?.fogReveal) ? myTeam.fogReveal : []);

  for (let r = Math.max(0,sr); r < Math.min(map.size,er); r++) {
    for (let c = Math.max(0,sc); c < Math.min(map.size,ec); c++) {
      const key  = `${c},${r}`;
      const cell = map.cells[key];
      if (!cell) continue;
      const revealed = !fog || myFog.has(key);
      drawHex(ctx, c, r, cell, revealed, hs);
    }
  }

  // Грааль
  const gKey = `${map.grailCol},${map.grailRow}`;
  const gRevealed = !fog || myFog.has(gKey);
  if (gRevealed) drawGrail(ctx, map.grailCol, map.grailRow, hs);

  // Подсветка доступных ходов
  for (const m of validMoves) {
    const { x, y } = Hex.toPixel(m.col, m.row, hs);
    ctx.beginPath(); hexPath(ctx, x, y, hs - 1.5);
    ctx.strokeStyle = 'rgba(212,168,50,0.9)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle   = 'rgba(212,168,50,0.15)'; ctx.fill();
  }

  // Игроки
  for (const team of teams) {
    if (team.eliminated) continue;
    for (const player of team.players) {
      if (!player.alive) continue;
      const pKey = `${player.col},${player.row}`;
      const vis = !fog || team.idx === myTeamIdx || myFog.has(pKey);
      if (!vis) continue;
      const { x, y } = Hex.toPixel(player.col, player.row, hs);
      const isActive = team.idx === activeTeamIdx && player.idx === state.activePlayerIdx;
      drawPlayer(ctx, x, y, player, team, hs, isActive, team.idx === myTeamIdx);
    }
  }

  // Гекс под курсором
  if (hoveredHex) {
    const { x, y } = Hex.toPixel(hoveredHex.col, hoveredHex.row, hs);
    ctx.beginPath(); hexPath(ctx, x, y, hs - 1);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.stroke();
  }

  ctx.restore();
}

function drawHex(ctx, c, r, cell, revealed, hs) {
  const { x, y } = Hex.toPixel(c, r, hs);
  ctx.beginPath(); hexPath(ctx, x, y, hs - 0.8);
  if (!revealed) {
    ctx.fillStyle = '#080d12'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5; ctx.stroke();
    return;
  }
  ctx.fillStyle = TERRAIN_COLORS[cell.terrain] || TERRAIN_COLORS.plains; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 0.7; ctx.stroke();
  if (TERRAIN_ICONS[cell.terrain] && hs > 13) {
    ctx.font = `${Math.floor(hs * 0.65)}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(TERRAIN_ICONS[cell.terrain], x, y);
  }
  if (cell.item) {
    const def = ITEM_DEFS[cell.item];
    if (def && hs > 10) {
      ctx.beginPath(); ctx.arc(x + hs*0.38, y - hs*0.38, hs*0.22, 0, Math.PI*2);
      ctx.fillStyle = '#d4a832'; ctx.fill();
      ctx.font = `${Math.floor(hs*0.32)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, x + hs*0.38, y - hs*0.38);
    }
  }
}

function drawGrail(ctx, c, r, hs) {
  const { x, y } = Hex.toPixel(c, r, hs);
  const g = ctx.createRadialGradient(x, y, 0, x, y, hs * 2.8);
  g.addColorStop(0, 'rgba(212,168,50,0.5)'); g.addColorStop(1, 'rgba(212,168,50,0)');
  ctx.beginPath(); ctx.arc(x, y, hs * 2.8, 0, Math.PI*2);
  ctx.fillStyle = g; ctx.fill();
  ctx.font = `${Math.floor(hs * 1.3)}px serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('⚱', x, y);
}

function drawPlayer(ctx, x, y, player, team, hs, isActive, isMyTeam) {
  const rad = hs * 0.44;
  const bob = isActive ? Math.sin(animTime * 2.2) * 2.5 : 0;

  // Тень
  ctx.beginPath(); ctx.arc(x, y + 2, rad, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();

  // Тело (шестиугольник-значок)
  ctx.beginPath(); hexPath(ctx, x, y + bob, rad);
  ctx.fillStyle = team.color; ctx.fill();

  // Обводка
  const strokeColor = isActive ? '#d4a832' : (isMyTeam ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.28)');
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = isActive ? 2.5 : (isMyTeam ? 1.5 : 0.8);
  ctx.stroke();

  // Номер
  ctx.font = `bold ${Math.floor(hs * 0.52)}px Inter,sans-serif`;
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(player.idx + 1, x, y + bob + 0.5);

  // Иконка способности над активным игроком
  if (isActive) {
    const ab = ABILITY_DEFS.find(a => a.id === player.ability);
    if (ab) {
      ctx.font = `${Math.floor(hs * 0.85)}px serif`;
      ctx.fillText(ab.icon, x, y + bob - hs * 1.15);
    }
    // Пульсирующий контур
    const pulse = (Math.sin(animTime * 3) + 1) / 2;
    ctx.beginPath(); hexPath(ctx, x, y + bob, rad + 3 + pulse * 3);
    ctx.strokeStyle = `rgba(212,168,50,${0.3 + pulse * 0.4})`;
    ctx.lineWidth = 1.5; ctx.stroke();
  }

  // Предметы (мои фишки)
  if (isMyTeam && player.items.length > 0 && hs > 12) {
    player.items.forEach((item, i) => {
      const d = ITEM_DEFS[item];
      if (d) {
        ctx.font = `${Math.floor(hs * 0.45)}px serif`;
        ctx.fillText(d.icon, x - 6 + i * 14, y + bob - hs * 0.75);
      }
    });
  }
}

function hexPath(ctx, cx, cy, size) {
  for (let i = 0; i < 6; i++) {
    const a  = (Math.PI / 180) * (60 * i - 30);
    const px = cx + size * Math.cos(a);
    const py = cy + size * Math.sin(a);
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
}

// ============================================================
// РЕНДЕР БОЯ
// ============================================================
function renderCombat(combat, dt) {
  if (!combatCanvas || !combat) return;
  const ctx = combatCanvas.getContext('2d');
  const W = combatCanvas.width, H = combatCanvas.height;
  ctx.clearRect(0, 0, W, H);

  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#0a1018'); bg.addColorStop(1, '#0e1820');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

  drawArena(ctx, W, H);

  const sp = W / 2, fy = H * 0.5, gap = 90;
  combat.fightersA.forEach((f, i) => {
    const x = sp * 0.33 + (i % 2) * 64 - 32, y = fy + (Math.floor(i/2) - 0.5) * gap;
    drawFighter(ctx, x, y, f, combat.teamA, i);
  });
  combat.fightersB.forEach((f, i) => {
    const x = sp * 1.67 - (i % 2) * 64 + 32, y = fy + (Math.floor(i/2) - 0.5) * gap;
    drawFighter(ctx, x, y, f, combat.teamB, i + 4);
  });

  ctx.beginPath();
  ctx.moveTo(sp, H * 0.08); ctx.lineTo(sp, H * 0.92);
  ctx.strokeStyle = 'rgba(212,168,50,0.12)';
  ctx.lineWidth = 1; ctx.setLineDash([5, 5]); ctx.stroke(); ctx.setLineDash([]);
}

function drawArena(ctx, W, H) {
  const iW = 80, iH = 40, cols = Math.ceil(W / iW) + 2;
  const sx = W/2 - (cols/2)*iW, sy = H * 0.62;
  for (let r = 0; r < 5; r++) for (let c = 0; c < cols; c++) {
    const x = sx + c*iW + (r%2)*(iW/2), y = sy + r*(iH/2);
    ctx.beginPath();
    ctx.moveTo(x,y); ctx.lineTo(x+iW/2,y-iH/2);
    ctx.lineTo(x+iW,y); ctx.lineTo(x+iW/2,y+iH/2); ctx.closePath();
    ctx.fillStyle = (c+r)%2===0 ? '#141e28' : '#18232e'; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 0.5; ctx.stroke();
  }
}

function drawFighter(ctx, x, y, fighter, team, seed) {
  const alive = fighter.alive;
  const bob   = alive ? Math.sin(animTime * 2.2 + seed) * 3 : 0;
  const hp = fighter.hp, maxHp = fighter.maxHp;

  ctx.save();
  if (!alive) ctx.globalAlpha = 0.28;

  // Тень
  ctx.beginPath(); ctx.ellipse(x, y + 35, 22, 9, 0, 0, Math.PI*2);
  ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fill();

  // Тело
  ctx.beginPath(); hexPath(ctx, x, y + bob, 28);
  ctx.fillStyle = team.color; ctx.fill();
  ctx.strokeStyle = alive ? 'rgba(255,255,255,0.6)' : '#444'; ctx.lineWidth = 2; ctx.stroke();

  // Номер
  ctx.font = 'bold 16px Inter,sans-serif'; ctx.fillStyle = '#fff';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(fighter.player.idx + 1, x, y + bob + 1);

  // Способность
  const ab = ABILITY_DEFS.find(a => a.id === fighter.player.ability);
  if (ab) { ctx.font = '18px serif'; ctx.fillText(ab.icon, x, y + bob - 40); }

  // Предметы
  if (fighter.player.items.length > 0) {
    fighter.player.items.forEach((item, i) => {
      const d = ITEM_DEFS[item];
      if (d) { ctx.font = '13px serif'; ctx.fillText(d.icon, x - 8 + i*18, y + bob - 57); }
    });
  }

  // HP-полоска
  const bw = 58, bh = 6, bx = x - bw/2, by = y + bob + 42;
  const pct = maxHp > 0 ? Math.max(0, hp) / maxHp : 0;
  ctx.fillStyle = '#1a2433'; ctx.fillRect(bx, by, bw, bh);
  ctx.fillStyle = pct > 0.5 ? '#2ec4b6' : pct > 0.25 ? '#f4a017' : '#e05c6a';
  ctx.fillRect(bx, by, bw * pct, bh);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);

  ctx.font = '10px Inter,sans-serif'; ctx.fillStyle = '#7a9ab0';
  ctx.fillText(`${Math.max(0, hp)}/${maxHp}`, x, by + bh + 12);
  ctx.restore();
}

// ============================================================
// ВСПОМОГАТЕЛЬНЫЕ
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(id)?.classList.remove('hidden');
}

function showBanner(text) {
  const ex = document.querySelector('.phase-banner');
  if (ex) ex.remove();
  const b = document.createElement('div');
  b.className = 'phase-banner'; b.textContent = text;
  document.body.appendChild(b);
  setTimeout(() => b.remove(), 2600);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
// НАСТРОЙКА UI
// ============================================================
function setupUI() {
  setupSeg('teams-select');
  setupSeg('timer-select');
  setupSeg('fog-select');

  document.getElementById('btn-create-room').addEventListener('click', () => {
    const numTeams     = parseInt(document.querySelector('#teams-select .seg-btn.active')?.dataset.val || 3);
    const turnDuration = parseInt(document.querySelector('#timer-select .seg-btn.active')?.dataset.val || 15);
    const fogEnabled   = document.querySelector('#fog-select .seg-btn.active')?.dataset.val !== 'open';
    send({ type: 'create_room', numTeams, turnDuration, fogEnabled });
  });

  document.getElementById('btn-join-room').addEventListener('click', () => showScreen('screen-join'));

  document.getElementById('btn-do-join').addEventListener('click', () => {
    const code = document.getElementById('join-code-input').value.trim().toUpperCase();
    if (code) send({ type: 'join_room', roomCode: code });
  });

  document.getElementById('join-code-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-do-join').click();
  });

  document.getElementById('btn-back-to-title').addEventListener('click', () => showScreen('screen-title'));

  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('lobby-code').textContent;
    navigator.clipboard?.writeText(code)
      .then(() => showBanner('Код скопирован!'))
      .catch(() => showBanner(`Код: ${code}`));
  });

  document.getElementById('btn-confirm-ability').addEventListener('click', () => {
    const sel = document.querySelector('.ability-card.selected');
    if (!sel) return;
    send({ type: 'set_ability', abilityId: sel.dataset.abilityId });
    document.querySelectorAll('.ability-card').forEach(c => c.classList.remove('selected'));
    document.getElementById('btn-confirm-ability').disabled = true;
  });

  document.getElementById('btn-end-turn').addEventListener('click', () => send({ type: 'end_turn' }));
  document.getElementById('btn-ability-use').addEventListener('click', () => send({ type: 'use_ability' }));
  document.getElementById('btn-play-again').addEventListener('click', () => location.reload());

  setupAbilityCards();
}

function setupSeg(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    el.querySelectorAll('.seg-btn').forEach(b => {
      b.classList.remove('active');
      b.setAttribute('aria-pressed', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-pressed', 'true');
  });
}

// ============================================================
// ЗАПУСК
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  connect();
  showScreen('screen-title');
});

window.GraalHunt = { send, getState: () => gameState };
