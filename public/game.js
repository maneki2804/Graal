/* ============================================================
   GRAAL HUNT — Client v2 (combat-rework)
   All game logic is server-authoritative.
   This client handles: WS connection, rendering, UI events.
   ============================================================ */
'use strict';

// ─── WS URL ──────────────────────────────────────────────────────────────────
const RAILWAY_URL = 'wss://graal-production.up.railway.app';
const WS_BASE = (() => {
  if (!RAILWAY_URL.startsWith('__')) return RAILWAY_URL;
  const loc = window.location;
  return (loc.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + loc.host;
})();

// ============================================================
// CONSTANTS (mirror server)
// ============================================================
const TEAM_COLORS   = ['#2ec4b6','#f4a017','#a569e0','#e05c6a'];
const TEAM_NAMES_RU = ['Бирюза','Янтарь','Аметист','Коралл'];

const CLASS_DEFS = {
  warrior: { icon:'⚔', name:'Воин',      hp:14, atk:5, row:'front', desc:'Передовой боец. Высокий HP, закрывает задний ряд.' },
  archer:  { icon:'🏹',name:'Стрелок',   hp:9,  atk:6, row:'back',  desc:'Первым ходит (инициатива 10). Точный одиночный удар.' },
  mage:    { icon:'🔮',name:'Маг',       hp:7,  atk:4, row:'back',  desc:'Атакует весь передний ряд врага сразу.' },
  support: { icon:'💊',name:'Поддержка', hp:9,  atk:3, row:'back',  desc:'Лечит союзников вместо атаки. Незаменим в длинных боях.' },
};
const CLASS_IDS = ['warrior','archer','mage','support'];

const ITEM_DEFS = {
  rope:   { icon:'🪢', name:'Верёвка', desc:'Проход через горы.' },
  boat:   { icon:'⛵', name:'Лодка',   desc:'Переплыть воду.' },
  axe:    { icon:'🪓', name:'Топор',   desc:'Обычное движение в лесу.' },
  sword:  { icon:'⚔', name:'Меч',     desc:'+3 ATK в бою.' },
  shield: { icon:'🛡', name:'Щит',    desc:'+3 HP в бою.' },
  cloak:  { icon:'🧥', name:'Плащ',   desc:'25% уклонения.' },
  wand:   { icon:'🪄', name:'Жезл',   desc:'+2 урона по ряду.' },
  amulet: { icon:'📿', name:'Амулет', desc:'+1 ATK всей команде.' },
};

const TERRAIN_COLORS = {
  plains:   '#1c2a1a',
  forest:   '#152810',
  mountain: '#272030',
  water:    '#0c1a38',
  grailzone:'#2a1e08',
};
const TERRAIN_ICONS = { forest:'🌲', mountain:'⛰', water:'〰' };

// ============================================================
// HEX MATH
// ============================================================
const Hex = {
  toPixel(c,r,s){ return { x:s*Math.sqrt(3)*(c+0.5*(r&1)), y:s*1.5*r }; },
  distance(c1,r1,c2,r2){
    const [ax,ay,az]=Hex.toCube(c1,r1),[bx,by,bz]=Hex.toCube(c2,r2);
    return Math.max(Math.abs(ax-bx),Math.abs(ay-by),Math.abs(az-bz));
  },
  toCube(c,r){ const x=c-(r-(r&1))/2,z=r; return [x,-x-z,z]; },
  neighbors(c,r){
    return (r&1)===0
      ?[[c-1,r],[c+1,r],[c,r-1],[c-1,r-1],[c,r+1],[c-1,r+1]]
      :[[c-1,r],[c+1,r],[c+1,r-1],[c,r-1],[c+1,r+1],[c,r+1]];
  },
};

// ============================================================
// CLIENT STATE
// ============================================================
let ws          = null;
let myTeamIdx   = null;
let myRoomCode  = null;
let gameState   = null;
let validMoves  = [];
let timerVal    = 0;
let arrangeTimer= 10;
let isBattleTestMode = false;

// Arrange screen: player positions chosen by user
let myArrangement = []; // [{playerIdx, row}]

// Combat: track which fighters we can click
let combatTargetMode = false;

// ============================================================
// SCREEN ROUTING
// ============================================================
const screens = {};
['title','classpick','join','lobby','ability','arrange','game','combat','victory']
  .forEach(id => { screens[id] = document.getElementById('screen-'+id); });

function showScreen(name) {
  Object.values(screens).forEach(s=>{ if(s){ s.classList.add('hidden'); }});
  const hud = document.getElementById('hud');
  if (hud) { hud.style.display='none'; hud.classList.add('hidden'); }
  if (screens[name]) screens[name].classList.remove('hidden');
  if (name==='game') {
    if (hud) { hud.style.display='flex'; hud.classList.remove('hidden'); }
  }
}

// ============================================================
// WS CONNECTION
// ============================================================
function connect(onOpen) {
  if (ws) { try{ws.close();}catch(e){} }
  ws = new WebSocket(WS_BASE);
  ws.onopen = () => { if(onOpen) onOpen(); };
  ws.onmessage = e => handleMessage(JSON.parse(e.data));
  ws.onerror  = () => {};
  ws.onclose  = () => { if(gameState&&gameState.phase!=='VICTORY') showReconnectHint(); };
}

function send(msg) {
  if (ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function showReconnectHint() {
  // Simple toast
  const t=document.createElement('div');
  t.style.cssText='position:fixed;bottom:2rem;left:50%;transform:translateX(-50%);background:#c0392b;color:#fff;padding:0.7rem 1.4rem;border-radius:8px;font-size:0.9rem;z-index:9999';
  t.textContent='Соединение потеряно. Обновите страницу.';
  document.body.appendChild(t);
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
function handleMessage(msg) {
  switch(msg.type) {

    case 'room_created':
      myTeamIdx  = msg.teamIdx;
      myRoomCode = msg.roomCode;
      if (isBattleTestMode) {
        // Don't show lobby — battle starts immediately after game_started
      } else {
        renderLobby(msg.roomCode, msg.teamIdx, msg.config);
        showScreen('lobby');
      }
      break;

    case 'joined':
      myTeamIdx  = msg.teamIdx;
      myRoomCode = msg.roomCode;
      renderLobby(msg.roomCode, msg.teamIdx, msg.config);
      showScreen('lobby');
      break;

    case 'player_joined':
      updateLobbyCount(msg.totalJoined, msg.needed??3);
      break;

    case 'game_started':
      // Wait for state message to actually render
      break;

    case 'state':
      gameState = msg.state;
      syncToState();
      break;

    case 'timer':
      timerVal = msg.value;
      updateTimer();
      break;

    case 'arrange_timer':
      arrangeTimer = msg.value;
      const cd = document.getElementById('arrange-countdown');
      if (cd) cd.textContent = msg.value;
      break;

    case 'your_turn':
      validMoves = msg.validMoves||[];
      if (screens.game && !screens.game.classList.contains('hidden')) drawMap();
      break;

    case 'active_turn':
      validMoves = [];
      updateHUD();
      break;

    case 'your_class_turn':
      if (msg.teamIdx === myTeamIdx) {
        renderClassSelectionScreen(true);
        showScreen('ability');
      }
      break;

    case 'class_setup_turn':
      if (msg.teamIdx !== myTeamIdx) {
        renderClassSelectionScreen(false);
        showScreen('ability');
      }
      break;

    case 'battle_arrange':
      arrangeTimer = msg.arrangeTimeLeft||10;
      renderArrangeScreen();
      showScreen('arrange');
      break;

    case 'combat_turn':
      updateCombatUI();
      break;

    case 'your_combat_turn':
      updateCombatUI(true);
      break;

    case 'item_vote_start':
      renderItemDialog(msg.item||gameState?.pendingItem);
      break;

    case 'error':
      console.warn('[Server error]', msg.message);
      break;
  }
}

// ============================================================
// STATE SYNC
// ============================================================
function syncToState() {
  if (!gameState) return;
  const s = gameState;

  if (s.phase==='VICTORY') {
    renderVictory(s);
    showScreen('victory');
    return;
  }

  if (s.phase==='CLASS_SELECTION') {
    const isMyTurn = s.classSetup?.teamIdx === myTeamIdx;
    renderClassSelectionScreen(isMyTurn);
    if (!screens.ability.classList.contains('hidden')) return;
    showScreen('ability');
    return;
  }

  if (s.phase==='COMBAT' && s.combat) {
    if (s.combat.phase==='ARRANGE') {
      renderArrangeScreen();
      showScreen('arrange');
    } else {
      renderCombatScreen(s.combat);
      showScreen('combat');
    }
    return;
  }

  if (s.phase==='GLOBAL_MAP') {
    if (s.pendingItem) {
      renderItemDialog(s.pendingItem);
    }
    renderMap();
    showScreen('game');
    updateHUD();
    return;
  }
}

// ============================================================
// LOBBY
// ============================================================
function renderLobby(code, teamIdx, config) {
  document.getElementById('lobby-code').textContent = code;
  const badge = document.getElementById('lobby-team-badge');
  badge.textContent = `Команда ${TEAM_NAMES_RU[teamIdx]}`;
  badge.style.background = TEAM_COLORS[teamIdx];
  badge.style.color = '#fff';
  updateLobbyCount(1, config?.numTeams||3);
}

function updateLobbyCount(joined, needed) {
  const el = document.getElementById('lobby-count');
  if (el) el.textContent = `${joined} / ${needed} команды подключились`;
  const dots = document.getElementById('lobby-dots');
  if (!dots) return;
  dots.innerHTML = '';
  for (let i=0;i<needed;i++) {
    const d=document.createElement('div');
    d.className='lobby-dot'+(i<joined?' filled':'');
    dots.appendChild(d);
  }
}

// ============================================================
// CLASS SELECTION SCREEN
// ============================================================
// For multiplayer: team selects all 4 classes at once
let pickedClasses = ['warrior','archer','mage','support'];

function renderClassSelectionScreen(isMyTurn) {
  const title = document.getElementById('ability-player-title');
  const myNotice = document.getElementById('ability-your-turn-notice');
  const waitNotice = document.getElementById('ability-waiting-notice');
  const btn = document.getElementById('btn-confirm-ability');
  const grid = document.getElementById('ability-grid');

  const teamName = TEAM_NAMES_RU[myTeamIdx]||'';
  if(title) title.textContent = `Команда ${teamName} — выбор классов`;

  const badge = document.getElementById('ability-team-badge');
  if(badge){ badge.textContent=teamName; badge.style.background=TEAM_COLORS[myTeamIdx]; }

  if(myNotice) myNotice.style.display = isMyTurn?'':'none';
  if(waitNotice) waitNotice.style.display = isMyTurn?'none':'';
  if(btn) btn.disabled = !isMyTurn;

  if (!grid) return;
  if (!isMyTurn) {
    grid.innerHTML = '<div style="text-align:center;color:var(--muted);padding:2rem">Ждём другую команду...</div>';
    return;
  }

  // 4 fighter slots, each with a class picker
  grid.innerHTML = '';
  for (let i=0;i<4;i++) {
    const slot = document.createElement('div');
    slot.className = 'ability-card';
    slot.innerHTML = `
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:0.5rem">Боец ${i+1}</div>
      <div class="class-pick-btns" style="display:flex;gap:0.4rem;flex-wrap:wrap;justify-content:center">
        ${CLASS_IDS.map(cid=>`
          <button class="class-pick-btn${pickedClasses[i]===cid?' active':''}"
            data-slot="${i}" data-class="${cid}" title="${CLASS_DEFS[cid].desc}">
            ${CLASS_DEFS[cid].icon} ${CLASS_DEFS[cid].name}
          </button>
        `).join('')}
      </div>
      <div class="class-stat-preview" id="class-preview-${i}">
        ${renderClassPreview(pickedClasses[i])}
      </div>
    `;
    grid.appendChild(slot);
  }

  grid.addEventListener('click', e=>{
    const btn = e.target.closest('.class-pick-btn');
    if (!btn) return;
    const slot = parseInt(btn.dataset.slot);
    const cid  = btn.dataset.class;
    pickedClasses[slot] = cid;
    // Update button states in this slot
    grid.querySelectorAll(`.class-pick-btn[data-slot="${slot}"]`).forEach(b=>{
      b.classList.toggle('active', b.dataset.class===cid);
    });
    const preview = document.getElementById(`class-preview-${slot}`);
    if (preview) preview.innerHTML = renderClassPreview(cid);
  });
}

function renderClassPreview(cid) {
  const cls = CLASS_DEFS[cid];
  if (!cls) return '';
  return `<div style="font-size:0.75rem;color:var(--muted);margin-top:0.4rem">
    ${cls.icon} HP:${cls.hp} ATK:${cls.atk} — ${cls.desc}
  </div>`;
}

// ============================================================
// CLASS PICK SCREEN (Battle Test mode)
// ============================================================
let battleTestClasses = ['warrior','archer','mage','support'];

function renderBattleTestClassPick() {
  const grid = document.getElementById('classpick-slots');
  if (!grid) return;
  grid.innerHTML = '';
  for (let i=0;i<4;i++) {
    const slot = document.createElement('div');
    slot.className = 'classpick-slot';
    slot.innerHTML = `
      <div class="classpick-slot-label">Боец ${i+1}</div>
      <div class="classpick-class-btns">
        ${CLASS_IDS.map(cid=>`
          <button class="class-pick-btn${battleTestClasses[i]===cid?' active':''}"
            data-slot="${i}" data-class="${cid}">
            ${CLASS_DEFS[cid].icon}<br><span style="font-size:0.72rem">${CLASS_DEFS[cid].name}</span>
          </button>
        `).join('')}
      </div>
      <div class="class-stat-preview">${renderClassPreview(battleTestClasses[i])}</div>
    `;
    grid.appendChild(slot);
  }

  grid.addEventListener('click', e=>{
    const btn = e.target.closest('.class-pick-btn');
    if (!btn) return;
    const slot = parseInt(btn.dataset.slot);
    const cid  = btn.dataset.class;
    battleTestClasses[slot] = cid;
    grid.querySelectorAll(`.class-pick-btn[data-slot="${slot}"]`).forEach(b=>{
      b.classList.toggle('active', b.dataset.class===cid);
    });
    const previews = slot.toString(); // refresh
    renderBattleTestClassPick();
  });
}

// ============================================================
// ARRANGE SCREEN
// ============================================================
function renderArrangeScreen() {
  const s = gameState;
  if (!s?.combat) return;
  const c = s.combat;

  const myFighters = myTeamIdx===c.teamA?.idx ? c.fightersA : c.fightersB;
  if (!myFighters?.length) return;

  // Build default arrangement from server state
  myArrangement = myFighters.map(f=>({ playerIdx:f.player.idx, row:f.row }));

  const frontEl = document.getElementById('arrange-front');
  const backEl  = document.getElementById('arrange-back');
  if (!frontEl||!backEl) return;

  function renderRows() {
    frontEl.innerHTML=''; backEl.innerHTML='';
    for (const item of myArrangement) {
      const f = myFighters.find(f=>f.player.idx===item.playerIdx);
      if (!f) continue;
      const cls = CLASS_DEFS[f.classId]||{};
      const card = document.createElement('div');
      card.className = 'arrange-fighter-card';
      card.dataset.playerIdx = item.playerIdx;
      card.innerHTML = `<span class="arrange-fighter-icon">${cls.icon||'?'}</span>
        <span class="arrange-fighter-name">${cls.name||'?'} ${item.playerIdx+1}</span>
        <span class="arrange-fighter-hp">HP:${f.hp}</span>`;

      // Click to toggle row
      card.addEventListener('click', ()=>{
        const a = myArrangement.find(a=>a.playerIdx===item.playerIdx);
        if (a) { a.row = a.row==='front'?'back':'front'; renderRows(); }
      });

      (item.row==='front' ? frontEl : backEl).appendChild(card);
    }
  }
  renderRows();

  const waitNotice = document.getElementById('arrange-waiting');
  if(waitNotice) waitNotice.style.display='none';

  const btn = document.getElementById('btn-confirm-arrange');
  if(btn) btn.disabled=false;

  document.getElementById('arrange-countdown').textContent = Math.ceil(arrangeTimer);
}

// ============================================================
// COMBAT SCREEN
// ============================================================
function renderCombatScreen(c) {
  if (!c) return;

  // Team headers
  const colorA = TEAM_COLORS[c.teamA?.idx]||'#888';
  const colorB = c.isNeutral ? '#888888' : (TEAM_COLORS[c.teamB?.idx]||'#888');
  el('ctA-dot').style.background=colorA;
  el('ctA-name').textContent=c.teamA?.name||'A';
  el('ctB-dot').style.background=colorB;
  el('ctB-name').textContent=c.teamB?.name||'B';

  // HP bars
  const totalA = c.fightersA?.reduce((s,f)=>s+f.maxHp,0)||1;
  const aliveA = c.fightersA?.filter(f=>f.alive).reduce((s,f)=>s+f.hp,0)||0;
  el('ctA-hp').style.width=Math.max(0,aliveA/totalA*100)+'%';

  const totalB = c.fightersB?.reduce((s,f)=>s+f.maxHp,0)||1;
  const aliveB = c.fightersB?.filter(f=>f.alive).reduce((s,f)=>s+f.hp,0)||0;
  el('ctB-hp').style.width=Math.max(0,aliveB/totalB*100)+'%';
  el('ctB-hp').style.background=c.isNeutral?'#888':TEAM_COLORS[c.teamB?.idx]||'var(--gold)';

  // Fighter cards
  renderCombatSide('combat-field-a', c.fightersA, colorA, c);
  renderCombatSide('combat-field-b', c.fightersB, colorB, c);

  // Log
  const log = el('combat-log');
  log.innerHTML = (c.log||[]).slice(-6).map(l=>`<div>${l}</div>`).join('');
  log.scrollTop = log.scrollHeight;

  updateCombatUI();
}

function renderCombatSide(elId, fighters, color, c) {
  const container = document.getElementById(elId);
  if (!container) return;
  container.innerHTML='';

  const front = fighters.filter(f=>f.row==='front');
  const back  = fighters.filter(f=>f.row==='back');

  const renderRow = (list, rowLabel) => {
    if (!list.length) return;
    const rowEl = document.createElement('div');
    rowEl.className='combat-row';
    rowEl.innerHTML=`<div class="combat-row-label">${rowLabel}</div>`;
    for (const f of list) {
      const cls = CLASS_DEFS[f.classId]||{};
      const isActive = isMyActiveFighter(f,c);
      const card = document.createElement('div');
      card.className='combat-fighter-card'+(f.alive?'':' dead')+(isActive?' active-fighter':'');
      card.dataset.playerIdx=f.player.idx;
      card.style.borderColor = f.alive ? color : '#333';

      const hpPct = f.alive ? Math.max(0,(f.hp/f.maxHp)*100) : 0;
      card.innerHTML=`
        <div class="fighter-icon">${cls.icon||'?'}</div>
        <div class="fighter-name">${cls.name||'?'} ${f.player.idx+1}</div>
        <div class="fighter-hp-bar-wrap">
          <div class="fighter-hp-bar" style="width:${hpPct}%;background:${color}"></div>
        </div>
        <div class="fighter-hp-text">${f.alive?f.hp+'/'+f.maxHp:'✕'}</div>
        ${f.alive&&f.player.level>1?`<div class="fighter-level">Ур.${f.player.level}</div>`:''}
      `;
      rowEl.appendChild(card);
    }
    container.appendChild(rowEl);
  };

  renderRow(front,'↑ Передний ряд');
  renderRow(back, '↓ Задний ряд');
}

function isMyActiveFighter(fighter, c) {
  if (!c||c.phase!=='ACTIVE'||!c.turnQueue?.length) return false;
  const cur = c.turnQueue[c.currentTurnIdx];
  if (!cur) return false;
  const team = cur.side==='A'?c.teamA:c.teamB;
  return team.idx===myTeamIdx && cur.player.idx===fighter.player.idx;
}

function updateCombatUI() {
  const s = gameState;
  const c = s?.combat;
  if (!c) return;

  const attackBtn  = el('btn-combat-attack');
  const dismissBtn = el('btn-combat-dismiss');

  if (c.phase==='DONE') {
    if(attackBtn) attackBtn.style.display='none';
    if(dismissBtn) dismissBtn.style.display='';
    return;
  }

  if(dismissBtn) dismissBtn.style.display='none';

  if (c.phase==='ACTIVE') {
    const cur = c.turnQueue?.[c.currentTurnIdx];
    const myTurn = cur && ((cur.side==='A'&&c.teamA.idx===myTeamIdx)||(cur.side==='B'&&c.teamB?.idx===myTeamIdx));
    if(attackBtn){ attackBtn.style.display=''; attackBtn.disabled=!myTurn; }

    // Highlight active fighter & log
    renderCombatScreen(c);
  }
}

function isMyTeamSide(c) {
  return c?.teamA?.idx===myTeamIdx ? 'A' : 'B';
}

// ============================================================
// MAP RENDERING
// ============================================================
const canvas = document.getElementById('game-canvas');
const ctx    = canvas ? canvas.getContext('2d') : null;
let hexSize  = 28;
let camX=0, camY=0;
let isPanning=false, panStartX=0, panStartY=0, camStartX=0, camStartY=0;

function renderMap() {
  if (!gameState||!ctx) return;
  resizeCanvas();
  drawMap();
  centerOnSquad();
}

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

function centerOnSquad() {
  const s = gameState;
  if (!s||myTeamIdx==null) return;
  const team = s.teams[myTeamIdx];
  if (!team) return;
  const { x, y } = Hex.toPixel(team.col, team.row, hexSize);
  camX = canvas.width/2  - x;
  camY = canvas.height/2 - y;
  drawMap();
}

function drawMap() {
  if (!gameState||!ctx) return;
  const s = gameState;
  const { cells, size, grailCol, grailRow } = s.map;
  const myTeam = myTeamIdx!=null ? s.teams[myTeamIdx] : null;
  const revealed = myTeam ? new Set(myTeam.fogReveal||[]) : null;
  const fog = s.config?.fogEnabled;

  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.save();
  ctx.translate(camX, camY);

  // Draw cells
  for (const cell of Object.values(cells)) {
    const { x, y } = Hex.toPixel(cell.col, cell.row, hexSize);
    const key = `${cell.col},${cell.row}`;
    const isRevealed = !fog || (revealed && revealed.has(key));

    drawHex(x, y, hexSize - 2, isRevealed ? TERRAIN_COLORS[cell.terrain]||'#1c2a1a' : '#0a0f0a', isRevealed);
    if (!isRevealed) continue;

    // Terrain icon
    const tIcon = TERRAIN_ICONS[cell.terrain];
    if (tIcon) { ctx.font='10px serif'; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillText(tIcon,x,y); }

    // Item
    if (cell.item) {
      const def = ITEM_DEFS[cell.item]||{};
      ctx.font='11px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(def.icon||'?', x, y+4);
    }

    // Neutral camp
    if (cell.neutral && !cell.neutral.defeated) {
      ctx.font='13px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('💀', x, y);
    }

    // Grail
    if (cell.col===grailCol && cell.row===grailRow) {
      ctx.font='14px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText('🏆', x, y);
    }

    // Valid move highlight
    if (validMoves.some(m=>m.col===cell.col&&m.row===cell.row)) {
      drawHexOutline(x, y, hexSize-1, '#2ec4b6', 2.5);
    }
  }

  // Draw squads
  for (const team of s.teams) {
    if (team.eliminated) continue;
    const { x, y } = Hex.toPixel(team.col, team.row, hexSize);
    const color = TEAM_COLORS[team.idx];
    const isActive = team.idx===s.activeTeamIdx;
    drawSquad(x, y, color, isActive, team);
  }

  ctx.restore();
}

function drawHex(x, y, r, fill, stroke) {
  ctx.beginPath();
  for (let i=0;i<6;i++) {
    const a = (Math.PI/180)*(60*i-30);
    i===0 ? ctx.moveTo(x+r*Math.cos(a),y+r*Math.sin(a)) : ctx.lineTo(x+r*Math.cos(a),y+r*Math.sin(a));
  }
  ctx.closePath();
  ctx.fillStyle=fill;
  ctx.fill();
  if (stroke) { ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.stroke(); }
}

function drawHexOutline(x, y, r, color, lw) {
  ctx.beginPath();
  for (let i=0;i<6;i++) {
    const a=(Math.PI/180)*(60*i-30);
    i===0?ctx.moveTo(x+r*Math.cos(a),y+r*Math.sin(a)):ctx.lineTo(x+r*Math.cos(a),y+r*Math.sin(a));
  }
  ctx.closePath();
  ctx.strokeStyle=color; ctx.lineWidth=lw||2; ctx.stroke();
}

function drawSquad(x, y, color, isActive, team) {
  // Pulsing ring for active
  if (isActive) {
    ctx.beginPath();
    ctx.arc(x,y,hexSize*0.58,0,Math.PI*2);
    ctx.strokeStyle=color+'cc'; ctx.lineWidth=2.5; ctx.stroke();
  }

  // Squad circle
  ctx.beginPath();
  ctx.arc(x,y,hexSize*0.42,0,Math.PI*2);
  ctx.fillStyle=color+'dd';
  ctx.fill();
  ctx.strokeStyle='#fff3'; ctx.lineWidth=1.5; ctx.stroke();

  // Class icons (up to 4 in 2x2)
  const alive = team.players.filter(p=>p.alive);
  if (alive.length===1) {
    const cls = CLASS_DEFS[alive[0].classId]||{};
    ctx.font='13px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    ctx.fillText(cls.icon||'?', x, y);
  } else {
    const offsets=[[-5,-5],[5,-5],[-5,5],[5,5]];
    ctx.font='9px serif'; ctx.textAlign='center'; ctx.textBaseline='middle';
    alive.slice(0,4).forEach((p,i)=>{
      const cls=CLASS_DEFS[p.classId]||{};
      ctx.fillText(cls.icon||'?', x+offsets[i][0], y+offsets[i][1]);
    });
  }

  // Level badge
  const avgLvl = Math.round(team.players.filter(p=>p.alive).reduce((s,p)=>s+p.level,0)/Math.max(1,alive.length));
  if (avgLvl>1) {
    ctx.fillStyle='#fff'; ctx.font='bold 8px sans-serif'; ctx.textAlign='center'; ctx.textBaseline='top';
    ctx.fillText('Ур'+avgLvl, x, y+hexSize*0.28);
  }

  // Direction arrow
  if (team.lastDir) {
    const dx=team.lastDir.toCol-team.lastDir.fromCol;
    const dy=team.lastDir.toRow-team.lastDir.fromRow;
    const angle=Math.atan2(dy,dx);
    const ar=hexSize*0.5;
    ctx.save();
    ctx.translate(x,y); ctx.rotate(angle);
    ctx.strokeStyle='#fff8'; ctx.lineWidth=1.5;
    ctx.beginPath();
    ctx.moveTo(hexSize*0.48,0);
    ctx.lineTo(hexSize*0.48-6,-4);
    ctx.moveTo(hexSize*0.48,0);
    ctx.lineTo(hexSize*0.48-6,4);
    ctx.stroke();
    ctx.restore();
  }
}

// ============================================================
// HUD
// ============================================================
function updateHUD() {
  const s = gameState;
  if (!s||!el('hud')) return;

  el('round-num').textContent = s.round||1;

  // Top strips
  const top = el('hud-top');
  if (top) {
    top.innerHTML='';
    for (const team of s.teams) {
      const strip = document.createElement('div');
      strip.className='hud-team-strip'+(team.idx===s.activeTeamIdx?' active':'')+(team.eliminated?' elim':'');
      strip.style.setProperty('--tc', TEAM_COLORS[team.idx]);
      const alive=team.players.filter(p=>p.alive);
      const totalHp=alive.reduce((s,p)=>s+p.hp,0);
      const maxHp=alive.reduce((s,p)=>s+p.maxHp,0)||1;
      const avgLvl=Math.round(alive.reduce((s,p)=>s+p.level,0)/Math.max(1,alive.length));
      strip.innerHTML=`
        <div class="strip-name">${team.name}</div>
        <div class="strip-level">Ур.${avgLvl}</div>
        <div class="strip-fighters">${alive.map(p=>CLASS_DEFS[p.classId]?.icon||'?').join('')}</div>
        <div class="strip-hpbar"><div class="strip-hpfill" style="width:${totalHp/maxHp*100}%;background:${TEAM_COLORS[team.idx]}"></div></div>
      `;
      top.appendChild(strip);
    }
  }

  // Bottom: active player
  const ti = s.activeTeamIdx, pi = s.activePlayerIdx;
  if (ti==null||!s.teams[ti]) return;
  const team = s.teams[ti];
  const player = team.players[pi];
  const isMyTurn = ti===myTeamIdx;

  const nameEl = el('active-player-name');
  if(nameEl) {
    nameEl.textContent = `${team.name} — Боец ${(pi||0)+1}`;
    nameEl.style.color = TEAM_COLORS[ti];
  }

  const clsEl = el('active-class-icon');
  const abilEl = el('active-ability-name');
  const lvlEl  = el('active-level-badge');
  if(player) {
    const cls=CLASS_DEFS[player.classId]||{};
    if(clsEl) clsEl.textContent=cls.icon||'?';
    if(abilEl) abilEl.textContent=cls.name||'';
    if(lvlEl) lvlEl.textContent=`Ур.${player.level||1}`;
  }

  // Items
  const itemSlots = el('active-item-slots');
  if(itemSlots&&player) {
    itemSlots.innerHTML=(player.items||[]).map(id=>{
      const d=ITEM_DEFS[id]||{}; return `<span class="item-chip" title="${d.name||id}">${d.icon||id}</span>`;
    }).join('');
  }

  const endBtn = el('btn-end-turn');
  if(endBtn) endBtn.disabled=!isMyTurn;
}

function updateTimer() {
  const s = gameState;
  const dur = s?.config?.turnDuration||15;
  el('timer-value').textContent = timerVal;
  el('timer-bar').style.width = Math.max(0,timerVal/dur*100)+'%';
}

// ============================================================
// ITEM DIALOG
// ============================================================
function renderItemDialog(pending) {
  if (!pending) return;
  const dialog = el('item-dialog');
  if (!dialog) return;

  const def = ITEM_DEFS[pending.itemId]||{};
  el('item-found-icon').textContent = def.icon||'?';
  el('item-found-name').textContent = def.name||pending.itemId;
  el('item-found-desc').textContent = def.desc||'';

  const actions = el('item-dialog-actions');
  actions.innerHTML='';

  if (pending.teamIdx===myTeamIdx && gameState) {
    const team = gameState.teams[myTeamIdx];
    if (!team) return;

    team.players.filter(p=>p.alive).forEach(p=>{
      const cls=CLASS_DEFS[p.classId]||{};
      const btn=document.createElement('button');
      btn.className='action-btn';
      btn.textContent=`${cls.icon||''} Бойцу ${p.idx+1}`;
      btn.onclick=()=>{
        send({type:'item_vote',playerIdx:myTeamIdx,action:String(p.idx),targetPlayerIdx:p.idx});
        dialog.classList.add('hidden');
      };
      actions.appendChild(btn);
    });

    const leaveBtn=document.createElement('button');
    leaveBtn.className='action-btn danger';
    leaveBtn.textContent='Оставить на земле';
    leaveBtn.onclick=()=>{
      send({type:'item_vote',playerIdx:myTeamIdx,action:'leave'});
      dialog.classList.add('hidden');
    };
    actions.appendChild(leaveBtn);
  } else {
    actions.innerHTML='<div style="color:var(--muted);font-size:0.85rem">Голосование идёт в другой команде...</div>';
  }

  dialog.classList.remove('hidden');
}

// ============================================================
// VICTORY SCREEN
// ============================================================
function renderVictory(s) {
  const winner = s.winner;
  const nameEl = el('victory-team-name');
  if(nameEl&&winner) {
    nameEl.textContent=`Команда ${winner.name} захватила Грааль!`;
    nameEl.style.color=TEAM_COLORS[winner.idx]||'#fff';
  }
  el('stat-rounds').textContent=s.round||1;
  el('stat-battles').textContent=s.battleCount||0;
}

// ============================================================
// MAP INTERACTIONS
// ============================================================
if (canvas) {
  canvas.addEventListener('click', e=>{
    if (!gameState||gameState.phase!=='GLOBAL_MAP') return;
    if (gameState.activeTeamIdx!==myTeamIdx) return;
    if (gameState.pendingItem) return;

    const bx=e.clientX-camX, by=e.clientY-camY;
    const best = findHexAt(bx, by);
    if (!best) return;
    if (validMoves.some(m=>m.col===best.col&&m.row===best.row)) {
      send({type:'move',col:best.col,row:best.row});
    }
  });

  canvas.addEventListener('mousedown',e=>{
    if (e.button!==1&&e.button!==2) return;
    isPanning=true; panStartX=e.clientX; panStartY=e.clientY;
    camStartX=camX; camStartY=camY;
  });

  window.addEventListener('mousemove',e=>{
    if (!isPanning) return;
    camX=camStartX+(e.clientX-panStartX);
    camY=camStartY+(e.clientY-panStartY);
    drawMap();
  });

  window.addEventListener('mouseup',()=>{ isPanning=false; });

  // Touch pan
  let lastTouchX=0,lastTouchY=0;
  canvas.addEventListener('touchstart',e=>{ if(e.touches.length===1){lastTouchX=e.touches[0].clientX;lastTouchY=e.touches[0].clientY;} });
  canvas.addEventListener('touchmove',e=>{
    if(e.touches.length!==1) return;
    const dx=e.touches[0].clientX-lastTouchX, dy=e.touches[0].clientY-lastTouchY;
    camX+=dx; camY+=dy;
    lastTouchX=e.touches[0].clientX; lastTouchY=e.touches[0].clientY;
    drawMap(); e.preventDefault();
  },{passive:false});

  canvas.addEventListener('wheel',e=>{
    const zoomFactor=e.deltaY<0?1.1:0.91;
    const mx=e.clientX,my=e.clientY;
    camX=(camX-mx)*zoomFactor+mx;
    camY=(camY-my)*zoomFactor+my;
    hexSize=Math.max(14,Math.min(60,hexSize*zoomFactor));
    drawMap();
  });

  window.addEventListener('resize',()=>{ resizeCanvas(); drawMap(); });
}

function findHexAt(bx, by) {
  if (!gameState) return null;
  const cells=gameState.map.cells;
  let best=null, bestDist=hexSize*0.9;
  for (const cell of Object.values(cells)) {
    const {x,y}=Hex.toPixel(cell.col,cell.row,hexSize);
    const d=Math.hypot(x-bx,y-by);
    if (d<bestDist){bestDist=d;best=cell;}
  }
  return best;
}

// ============================================================
// UI EVENT BINDINGS
// ============================================================
function el(id){ return document.getElementById(id); }

// Title
el('btn-battle-test')?.addEventListener('click',()=>{
  isBattleTestMode=true;
  renderBattleTestClassPick();
  showScreen('classpick');
});

el('btn-bot-game')?.addEventListener('click',()=>{
  isBattleTestMode=false;
  const timer = parseInt(document.querySelector('#timer-select .seg-btn.active')?.dataset.val)||15;
  const fogEl = document.querySelector('#fog-select .seg-btn.active');
  const fog   = fogEl?.dataset.val!=='open';
  connect(()=>{ send({type:'create_bot_game',turnDuration:timer,fogEnabled:fog}); });
});

el('btn-create-room')?.addEventListener('click',()=>{
  isBattleTestMode=false;
  const teams= parseInt(document.querySelector('#teams-select .seg-btn.active')?.dataset.val)||3;
  const timer= parseInt(document.querySelector('#timer-select .seg-btn.active')?.dataset.val)||15;
  const fog  = document.querySelector('#fog-select .seg-btn.active')?.dataset.val!=='open';
  connect(()=>{ send({type:'create_room',numTeams:teams,turnDuration:timer,fogEnabled:fog}); });
  showScreen('lobby');
});

el('btn-join-room')?.addEventListener('click',()=>{ showScreen('join'); });
el('btn-back-to-title')?.addEventListener('click',()=>{ showScreen('title'); });
el('btn-do-join')?.addEventListener('click',()=>{
  const code=el('join-code-input')?.value.trim().toUpperCase();
  if (!code||code.length<4) return;
  connect(()=>{ send({type:'join_room',roomCode:code}); });
});

el('btn-copy-code')?.addEventListener('click',()=>{
  if(myRoomCode) navigator.clipboard.writeText(myRoomCode).catch(()=>{});
});

el('btn-play-again')?.addEventListener('click',()=>{ location.reload(); });

// Class pick (battle test)
el('btn-start-battle')?.addEventListener('click',()=>{
  connect(()=>{
    send({type:'create_battle_test', classes:battleTestClasses});
  });
});
el('btn-back-classpick')?.addEventListener('click',()=>{ showScreen('title'); });

// Class selection (multiplayer)
el('btn-confirm-ability')?.addEventListener('click',()=>{
  send({type:'set_classes', classes:pickedClasses});
});

// Arrange
el('btn-confirm-arrange')?.addEventListener('click',()=>{
  send({type:'confirm_arrange', arrangement:myArrangement});
  el('btn-confirm-arrange').disabled=true;
  const w=el('arrange-waiting'); if(w) w.style.display='';
});

// Combat actions
el('btn-combat-attack')?.addEventListener('click',()=>{
  // For now: auto-pick target (click on fighter card for manual)
  send({type:'combat_action'});
});

el('btn-combat-dismiss')?.addEventListener('click',()=>{
  send({type:'combat_dismiss'});
});

// Map end turn
el('btn-end-turn')?.addEventListener('click',()=>{
  if(gameState?.activeTeamIdx===myTeamIdx) send({type:'end_turn'});
});

// Combat: click on enemy fighter card to target
document.addEventListener('click', e=>{
  const card = e.target.closest('.combat-fighter-card');
  if (!card) return;
  const s=gameState;
  if (!s?.combat||s.combat.phase!=='ACTIVE') return;
  const c=s.combat;
  const cur=c.turnQueue?.[c.currentTurnIdx];
  if (!cur) return;
  const myTurn=(cur.side==='A'&&c.teamA.idx===myTeamIdx)||(cur.side==='B'&&c.teamB?.idx===myTeamIdx);
  if (!myTurn) return;
  // Only allow clicking enemy fighters
  const enemySide = cur.side==='A' ? document.getElementById('combat-field-b') : document.getElementById('combat-field-a');
  if (!enemySide?.contains(e.target)) return;
  const pidx=parseInt(card.dataset.playerIdx);
  if (!isNaN(pidx)) send({type:'combat_action',targetPlayerIdx:pidx});
});

// Segmented buttons
document.querySelectorAll('.seg').forEach(seg=>{
  seg.addEventListener('click',e=>{
    const btn=e.target.closest('.seg-btn');
    if (!btn) return;
    seg.querySelectorAll('.seg-btn').forEach(b=>{
      b.classList.toggle('active',b===btn);
      b.setAttribute('aria-pressed',b===btn?'true':'false');
    });
  });
});
