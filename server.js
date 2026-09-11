/**
 * Graal Hunt — WebSocket Game Server
 * Port 8765
 *
 * Protocol (JSON messages):
 *
 * Client → Server:
 *   { type: 'create_room', config: {numTeams, turnDuration, fogEnabled} }
 *   { type: 'join_room', roomCode, teamIdx }   // join as specific team
 *   { type: 'set_ability', abilityId }          // during ability selection
 *   { type: 'move', col, row }
 *   { type: 'end_turn' }
 *   { type: 'use_ability' }                     // extra_move activate
 *   { type: 'extra_move', col, row }
 *   { type: 'item_pickup', action, targetPlayerIdx }
 *   { type: 'combat_attack' }
 *   { type: 'combat_retreat' }
 *   { type: 'combat_heal' }
 *   { type: 'combat_dismiss' }
 *   { type: 'get_state' }                       // request full state resync
 *
 * Server → Client:
 *   { type: 'room_created', roomCode }
 *   { type: 'joined', teamIdx, playerIdx, roomCode }
 *   { type: 'error', message }
 *   { type: 'state', state }                    // full game state broadcast
 *   { type: 'your_turn', teamIdx, playerIdx }
 *   { type: 'valid_moves', moves }
 *   { type: 'banner', text }
 *   { type: 'ping' }
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT   = process.env.PORT || 8765;
const PUBLIC = path.join(__dirname, 'public');

// MIME types for static file serving
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

// ============================================================
// GAME CONSTANTS
// ============================================================
const ABILITY_DEFS = [
  { id: 'extra_move' }, { id: 'saboteur' }, { id: 'duelist' },
  { id: 'healer' }, { id: 'reviver' }, { id: 'smuggler' },
];
const ITEM_DEFS = {
  rope: { type: 'global' }, boat: { type: 'global' }, axe: { type: 'global' },
  sword: { type: 'combat' }, shield: { type: 'combat' },
  cloak: { type: 'combat' }, wand: { type: 'combat' },
};
const MAP_SIZE  = { 2: 40, 3: 60, 4: 80 };
const GRAIL_ZONE_R = 5;
const TEAM_COLORS = ['#c0392b','#2980b9','#27ae60','#8e44ad'];
const TEAM_NAMES  = ['Red','Blue','Green','Purple'];

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
  toCube(c, r) {
    const x = c - (r - (r & 1)) / 2, z = r;
    return [x, -x - z, z];
  },
  fromCube(x, z) {
    return [x + (z - (z & 1)) / 2, z];
  },
  neighbors(c, r) {
    return (r & 1) === 0
      ? [[c-1,r],[c+1,r],[c,r-1],[c-1,r-1],[c,r+1],[c-1,r+1]]
      : [[c-1,r],[c+1,r],[c+1,r-1],[c,r-1],[c+1,r+1],[c,r+1]];
  },
  dirTo(c1,r1,c2,r2) {
    const [ax,ay,az]=Hex.toCube(c1,r1), [bx,by,bz]=Hex.toCube(c2,r2);
    const dx=bx-ax,dy=by-ay,dz=bz-az;
    const m=Math.max(Math.abs(dx),Math.abs(dy),Math.abs(dz))||1;
    return [Math.round(dx/m),Math.round(dy/m),Math.round(dz/m)];
  },
};

// ============================================================
// MAP GENERATION
// ============================================================
let _seed = 1;
function srnd(n) {
  const x = Math.sin(n + _seed) * 43758.5453;
  return x - Math.floor(x);
}

function generateMap(size, seed) {
  _seed = seed;
  const cells = {};
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const k = `${c},${r}`;
      const v = srnd(c * 1000 + r * 37 + 7);
      let terrain = 'plains';
      if (v < 0.12) terrain = 'water';
      else if (v < 0.22) terrain = 'mountain';
      else if (v < 0.38) terrain = 'forest';
      cells[k] = { col: c, row: r, terrain, item: null };
    }
  }
  const cx = Math.floor(size/2), cy = Math.floor(size/2);
  for (let r = cy-GRAIL_ZONE_R; r <= cy+GRAIL_ZONE_R; r++) {
    for (let c = cx-GRAIL_ZONE_R; c <= cx+GRAIL_ZONE_R; c++) {
      if (c>=0&&r>=0&&c<size&&r<size && Hex.distance(c,r,cx,cy)<=GRAIL_ZONE_R) {
        cells[`${c},${r}`].terrain = 'grailzone';
      }
    }
  }
  // Scatter items
  const itemKeys = Object.keys(ITEM_DEFS);
  let placed = 0;
  for (let i = 0; i < 80 && placed < 40; i++) {
    const c = Math.floor(srnd(i*991+3)*size);
    const r = Math.floor(srnd(i*773+7)*size);
    const k = `${c},${r}`;
    if (cells[k] && !cells[k].item && cells[k].terrain !== 'grailzone') {
      cells[k].item = itemKeys[placed % itemKeys.length];
      placed++;
    }
  }
  return cells;
}

function computeSpawns(numTeams, size) {
  const cx = size/2, cy = size/2, r = Math.floor(size*0.3);
  return Array.from({ length: numTeams }, (_, i) => {
    const a = (2*Math.PI*i/numTeams) - Math.PI/2;
    return {
      col: Math.max(2, Math.min(size-3, Math.round(cx + r*Math.cos(a)))),
      row: Math.max(2, Math.min(size-3, Math.round(cy + r*Math.sin(a)))),
    };
  });
}

// ============================================================
// GAME ENGINE (server-side, authoritative)
// ============================================================
class GameEngine {
  constructor(config, seed) {
    this.config   = config;
    const size    = MAP_SIZE[config.numTeams];
    const cells   = generateMap(size, seed);
    const spawns  = computeSpawns(config.numTeams, size);

    this.state = {
      phase: 'ABILITY_SELECTION',
      config,
      map: {
        size,
        cells,
        grailCol: Math.floor(size/2),
        grailRow: Math.floor(size/2),
      },
      teams: Array.from({ length: config.numTeams }, (_, ti) => {
        const sp = spawns[ti];
        return {
          idx: ti,
          name: TEAM_NAMES[ti],
          color: TEAM_COLORS[ti],
          eliminated: false,
          fogReveal: new Set(),
          players: Array.from({ length: 4 }, (_, pi) => ({
            idx: pi,
            ability: null,
            abilityUsed: false,
            abilityUsedMatch: false,
            items: [],
            col: sp.col + (pi%2===0?0:1),
            row: sp.row + (pi<2?0:1),
            hp: 10, maxHp: 10,
            alive: true,
          })),
        };
      }),
      activeTeamIdx: 0,
      activePlayerIdx: 0,
      round: 1,
      turnTimeLeft: config.turnDuration,
      battleCount: 0,
      combat: null,
      pendingItem: null,
      extraMoveMode: null,
      winner: null,
      abilitySetup: { teamIdx: 0, playerIdx: 0 },
    };

    this.state.teams.forEach(t =>
      t.players.forEach(p => this._revealAround(t, p.col, p.row))
    );
  }

  // ---- ABILITY SELECTION ----
  confirmAbility(abilityId, teamIdx, playerIdx) {
    const s = this.state;
    if (s.phase !== 'ABILITY_SELECTION') return { ok: false };
    const { teamIdx: eti, playerIdx: epi } = s.abilitySetup;
    if (eti !== teamIdx || epi !== playerIdx) return { ok: false, error: 'Not your setup turn' };

    s.teams[eti].players[epi].ability = abilityId;
    let nt = eti, np = epi + 1;
    if (np >= 4) { np = 0; nt++; }
    if (nt >= s.config.numTeams) {
      s.phase = 'GLOBAL_MAP';
      s.abilitySetup = null;
      this._startTeamTurn(0);
    } else {
      s.abilitySetup = { teamIdx: nt, playerIdx: np };
    }
    return { ok: true };
  }

  // ---- MOVE ----
  movePlayer(col, row, teamIdx, playerIdx) {
    const s = this.state;
    if (s.phase !== 'GLOBAL_MAP') return { ok: false, error: 'Wrong phase' };
    if (s.pendingItem) return { ok: false, error: 'Pending item' };
    if (s.activeTeamIdx !== teamIdx || s.activePlayerIdx !== playerIdx)
      return { ok: false, error: 'Not your turn' };

    const team   = s.teams[teamIdx];
    const player = team.players[playerIdx];
    if (!player.alive) return { ok: false, error: 'Player dead' };

    const valid = this.getValidMoves(teamIdx, playerIdx);
    if (!valid.some(m => m.col===col && m.row===row))
      return { ok: false, error: 'Invalid move' };

    player.col = col; player.row = row;
    this._revealAround(team, col, row);

    // Item pickup
    const cell = s.map.cells[`${col},${row}`];
    if (cell?.item) {
      s.pendingItem = { teamIdx, playerIdx, col, row, itemId: cell.item };
      return { ok: true, event: 'item_pickup' };
    }

    // Grail capture
    if (col === s.map.grailCol && row === s.map.grailRow) {
      this._win(team);
      return { ok: true, event: 'victory' };
    }

    // Combat trigger
    for (const et of s.teams) {
      if (et.idx === teamIdx || et.eliminated) continue;
      for (const ep of et.players) {
        if (!ep.alive) continue;
        if (Hex.distance(col, row, ep.col, ep.row) <= 1) {
          this._triggerCombat(team, et);
          return { ok: true, event: 'combat' };
        }
      }
    }

    return { ok: true };
  }

  endTurn(teamIdx, playerIdx) {
    const s = this.state;
    if (s.activeTeamIdx !== teamIdx || s.activePlayerIdx !== playerIdx)
      return { ok: false, error: 'Not your turn' };
    this._endPlayerTurn(teamIdx, playerIdx);
    return { ok: true };
  }

  useAbility(teamIdx, playerIdx) {
    const s = this.state;
    const player = s.teams[teamIdx].players[playerIdx];
    if (player.abilityUsed || player.ability !== 'extra_move') return { ok: false };
    player.abilityUsed = true;
    s.extraMoveMode = { teamIdx, playerIdx };
    return { ok: true };
  }

  applyExtraMove(col, row, teamIdx, playerIdx) {
    const s = this.state;
    const em = s.extraMoveMode;
    if (!em || em.teamIdx !== teamIdx || em.playerIdx !== playerIdx) return { ok: false };
    const player = s.teams[teamIdx].players[playerIdx];
    const cell   = s.map.cells[`${col},${row}`];
    if (!cell || cell.terrain === 'grailzone' || !this._canTraverse(player, cell))
      return { ok: false, error: 'Invalid' };
    const neigh = Hex.neighbors(player.col, player.row);
    if (!neigh.some(([nc,nr]) => nc===col && nr===row)) return { ok: false, error: 'Not adjacent' };
    player.col = col; player.row = row;
    this._revealAround(s.teams[teamIdx], col, row);
    s.extraMoveMode = null;
    return { ok: true };
  }

  resolveItem(action, targetPlayerIdx, teamIdx, playerIdx) {
    const s = this.state;
    const pi = s.pendingItem;
    if (!pi || pi.teamIdx !== teamIdx || pi.playerIdx !== playerIdx) return { ok: false };
    const team   = s.teams[pi.teamIdx];
    const player = team.players[pi.playerIdx];
    const cell   = s.map.cells[`${pi.col},${pi.row}`];

    if (action === 'take') {
      const max = player.ability === 'smuggler' ? 2 : 1;
      if (player.items.length < max) { player.items.push(pi.itemId); cell.item = null; }
    } else if (action === 'replace') {
      cell.item = player.items.shift();
      player.items.push(pi.itemId);
    } else if (action === 'give' && targetPlayerIdx != null) {
      const ally = team.players[targetPlayerIdx];
      const max  = ally.ability === 'smuggler' ? 2 : 1;
      if (ally.items.length < max) { ally.items.push(pi.itemId); cell.item = null; }
    }
    s.pendingItem = null;
    return { ok: true };
  }

  // ---- COMBAT ----
  combatAttack(teamIdx) {
    const s = this.state;
    const c = s.combat;
    if (!c) return { ok: false };
    if (c.phase === 'RETREAT_OFFER') c.phase = 'ACTIVE';

    const side = c.teamA.idx === teamIdx ? 'A' : 'B';
    const attFighters = side==='A' ? c.fightersA : c.fightersB;
    const defFighters = side==='A' ? c.fightersB : c.fightersA;
    const attBonus    = side==='A' ? c.bonusA : c.bonusB;
    const defBonus    = side==='A' ? c.bonusB : c.bonusA;
    const attTeam     = side==='A' ? c.teamA : c.teamB;
    const defTeam     = side==='A' ? c.teamB : c.teamA;

    c.round++;
    const liveAtt = attFighters.filter(f=>f.alive);
    const liveDef = () => defFighters.filter(f=>f.alive);

    for (const att of liveAtt) {
      const targets = liveDef();
      if (!targets.length) break;
      const target = targets[Math.floor(Math.random()*targets.length)];
      let dmg = 2 + Math.floor(Math.random()*4) + attBonus.atk;
      if (att.player.ability === 'duelist') dmg += 3;
      if (Math.random() < defBonus.dodge) {
        c.log.push(`  ${att.player.idx+1}→${target.player.idx+1}: DODGE (Cloak)`);
        continue;
      }
      dmg = Math.max(1, dmg - defBonus.def);
      target.hp -= dmg; target.player.hp = target.hp;
      c.log.push(`  T${attTeam.idx+1}P${att.player.idx+1}→T${defTeam.idx+1}P${target.player.idx+1}: -${dmg}HP`);
      if (target.hp <= 0) {
        target.hp = 0; target.alive = false;
        target.player.alive = false; target.player.hp = 0;
        c.log.push(`  P${target.player.idx+1} defeated!`);
      }
    }
    if (attBonus.area > 0) {
      for (const t of liveDef()) {
        t.hp -= attBonus.area; t.player.hp = t.hp;
        if (t.hp<=0){t.hp=0;t.alive=false;t.player.alive=false;t.player.hp=0;}
      }
      c.log.push(`  Wand area: -${attBonus.area}`);
    }

    this._checkCombatEnd();
    c.turn = side==='A' ? 'B' : 'A';
    return { ok: true };
  }

  combatRetreat(teamIdx) {
    const c = this.state.combat;
    if (!c || c.retreatBlocked || c.phase !== 'RETREAT_OFFER') return { ok: false, error: 'Cannot retreat' };
    const team  = c.teamA.idx===teamIdx ? c.teamA : c.teamB;
    const enemy = c.teamA.idx===teamIdx ? c.teamB : c.teamA;
    const ep    = enemy.players.find(p=>p.alive);
    if (ep) {
      const [dx,dy,dz] = Hex.dirTo(team.players[0].col,team.players[0].row,ep.col,ep.row);
      for (const p of team.players) {
        if (!p.alive) continue;
        let [cx,cy,cz] = Hex.toCube(p.col, p.row);
        for (let i=0;i<3;i++) {
          const nc=cx-dx, ny=cy-dy, nz=cz-dz;
          const [oc,or] = Hex.fromCube(nc,nz);
          if (oc>=0&&or>=0&&oc<this.state.map.size&&or<this.state.map.size){cx=nc;cy=ny;cz=nz;}
        }
        const [fc,fr] = Hex.fromCube(cx,cz);
        p.col=fc; p.row=fr;
        this._revealAround(team,fc,fr);
      }
    }
    c.log.push(`Team ${team.name} retreated`);
    this._endCombat(null);
    return { ok: true };
  }

  combatHeal(teamIdx) {
    const c = this.state.combat;
    if (!c) return { ok: false };
    const side = c.teamA.idx===teamIdx ? 'A' : 'B';
    const flag = side==='A' ? 'healerUsedA' : 'healerUsedB';
    if (c[flag]) return { ok: false, error: 'Healer already used' };
    const fighters = side==='A' ? c.fightersA : c.fightersB;
    const target = fighters.filter(f=>f.alive).sort((a,b)=>(a.hp/a.maxHp)-(b.hp/b.maxHp))[0];
    if (!target) return { ok: false };
    target.hp = Math.min(target.maxHp, target.hp+4);
    target.player.hp = target.hp;
    c.log.push(`Healer: +4 HP to P${target.player.idx+1}`);
    c[flag] = true;
    return { ok: true };
  }

  dismissCombat() {
    const s = this.state;
    if (!s.combat || s.combat.phase !== 'DONE') return { ok: false };
    s.combat = null;
    s.phase = 'GLOBAL_MAP';
    this._startPlayerTurn(s.activeTeamIdx, s.activePlayerIdx);
    return { ok: true };
  }

  // ---- TIMER TICK ----
  tick(dt) {
    const s = this.state;
    if (s.phase !== 'GLOBAL_MAP' || s.pendingItem) return false;
    s.turnTimeLeft -= dt;
    if (s.turnTimeLeft <= 0) {
      s.turnTimeLeft = 0;
      this._endPlayerTurn(s.activeTeamIdx, s.activePlayerIdx);
      return true; // changed
    }
    return false;
  }

  // ---- HELPERS ----
  _startTeamTurn(ti) {
    this.state.activeTeamIdx = ti;
    this.state.activePlayerIdx = 0;
    this._startPlayerTurn(ti, 0);
  }

  _startPlayerTurn(ti, pi) {
    const player = this.state.teams[ti].players[pi];
    player.abilityUsed = false;
    this.state.turnTimeLeft = this.state.config.turnDuration;
  }

  _endPlayerTurn(ti, pi) {
    const s = this.state;
    const team = s.teams[ti];
    let next = pi + 1;
    while (next < 4 && !team.players[next].alive) next++;
    if (next < 4) {
      s.activePlayerIdx = next;
      this._startPlayerTurn(ti, next);
    } else {
      this._advanceTeam(ti);
    }
  }

  _advanceTeam(ti) {
    const s = this.state;
    let next = (ti+1) % s.teams.length;
    let guard = s.teams.length;
    while (s.teams[next].eliminated && --guard>0) next=(next+1)%s.teams.length;
    if (next <= ti) { s.round++; this._moveGrail(); }
    this._startTeamTurn(next);
  }

  _moveGrail() {
    const s = this.state;
    const { grailCol:gc, grailRow:gr, size } = s.map;
    const cx=Math.floor(size/2), cy=Math.floor(size/2);
    const candidates = [...Hex.neighbors(gc,gr), [gc,gr]];
    let best=-1, bc=gc, br=gr;
    for (const [nc,nr] of candidates) {
      if (nc<0||nr<0||nc>=size||nr>=size) continue;
      if (Hex.distance(nc,nr,cx,cy)>GRAIL_ZONE_R) continue;
      let minD = Infinity;
      for (const t of s.teams) {
        if (t.eliminated) continue;
        for (const p of t.players) {
          if (!p.alive) continue;
          const d = Hex.distance(nc,nr,p.col,p.row);
          if (d<minD) minD=d;
        }
      }
      if (minD>best){best=minD;bc=nc;br=nr;}
    }
    s.map.grailCol=bc; s.map.grailRow=br;
  }

  _revealAround(team, col, row) {
    team.fogReveal.add(`${col},${row}`);
    for (const [nc,nr] of Hex.neighbors(col,row)) {
      team.fogReveal.add(`${nc},${nr}`);
      for (const [nc2,nr2] of Hex.neighbors(nc,nr)) team.fogReveal.add(`${nc2},${nr2}`);
    }
  }

  _canTraverse(player, cell) {
    if (cell.terrain==='water'    && !player.items.includes('boat')) return false;
    if (cell.terrain==='mountain' && !player.items.includes('rope')) return false;
    return true;
  }

  getValidMoves(ti, pi) {
    const player = this.state.teams[ti].players[pi];
    if (!player.alive) return [];
    const s = this.state;
    return Hex.neighbors(player.col, player.row)
      .filter(([nc,nr]) => {
        if (nc<0||nr<0||nc>=s.map.size||nr>=s.map.size) return false;
        const cell = s.map.cells[`${nc},${nr}`];
        return cell && this._canTraverse(player, cell);
      })
      .map(([col,row]) => ({ col, row }));
  }

  _teamBonus(team) {
    let atk=0, def=0, dodge=0, area=0;
    for (const p of team.players) {
      for (const item of p.items) {
        if (item==='sword') atk+=2;
        if (item==='shield') def+=2;
        if (item==='cloak') dodge=Math.max(dodge,0.25);
        if (item==='wand') area+=1;
      }
    }
    return {atk,def,dodge,area};
  }

  _triggerCombat(teamA, teamB) {
    const s = this.state;
    s.phase = 'COMBAT';
    s.battleCount++;
    const mkFighters = t => t.players.filter(p=>p.alive).map(p=>({
      player: p, team: t, hp: p.hp, maxHp: p.maxHp, alive: true,
    }));
    s.combat = {
      teamA, teamB,
      bonusA: this._teamBonus(teamA),
      bonusB: this._teamBonus(teamB),
      fightersA: mkFighters(teamA),
      fightersB: mkFighters(teamB),
      retreatBlocked: false,
      phase: 'RETREAT_OFFER',
      turn: 'A', round: 0, winner: null,
      log: [`${teamA.name} vs ${teamB.name} — combat!`],
      healerUsedA: false, healerUsedB: false,
    };
  }

  _checkCombatEnd() {
    const c = this.state.combat;
    const aAlive = c.fightersA.filter(f=>f.alive).length;
    const bAlive = c.fightersB.filter(f=>f.alive).length;
    if (aAlive===0 && bAlive===0) { c.log.push('Draw!'); this._endCombat(null); }
    else if (aAlive===0) { c.log.push(`${c.teamB.name} wins!`); this._endCombat(c.teamB); }
    else if (bAlive===0) { c.log.push(`${c.teamA.name} wins!`); this._endCombat(c.teamA); }
  }

  _endCombat(winner) {
    const c = this.state.combat;
    c.winner = winner; c.phase = 'DONE';
    // Reviver
    for (const team of [c.teamA, c.teamB]) {
      const rev = team.players.find(p=>p.ability==='reviver'&&p.alive&&!p.abilityUsedMatch);
      if (rev) {
        const dead = team.players.find(p=>!p.alive);
        if (dead) { dead.alive=true; dead.hp=1; rev.abilityUsedMatch=true; c.log.push(`${rev.idx+1} revives!`); }
      }
    }
    for (const t of this.state.teams) {
      if (!t.eliminated && t.players.every(p=>!p.alive)) { t.eliminated=true; c.log.push(`Team ${t.name} eliminated!`); }
    }
    const surviving = this.state.teams.filter(t=>!t.eliminated);
    if (surviving.length===1) this._win(surviving[0]);
  }

  _win(team) {
    this.state.phase = 'VICTORY';
    this.state.winner = team;
  }

  // Serialize state for wire — convert Sets to arrays for JSON
  serialize() {
    const s = this.state;
    return JSON.parse(JSON.stringify(s, (key, val) => {
      if (val instanceof Set) return [...val];
      return val;
    }));
  }
}

// ============================================================
// ROOM MANAGER
// ============================================================
const rooms = new Map(); // roomCode → Room

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

class Room {
  constructor(code, config) {
    this.code   = code;
    this.config = config;
    this.engine = null;
    this.started = false;
    // clients[teamIdx] = WebSocket (one per team for now)
    this.clients = new Map(); // teamIdx → ws
    this.allClients = new Set(); // all ws in room (spectators etc)
    // Track which player within team each ws controls
    // For simplicity: a team's WS controls all 4 players of that team
  }

  addClient(ws, teamIdx) {
    if (this.clients.has(teamIdx)) return false; // team taken
    this.clients.set(teamIdx, ws);
    this.allClients.add(ws);
    ws._teamIdx = teamIdx;
    ws._roomCode = this.code;
    return true;
  }

  removeClient(ws) {
    if (ws._teamIdx != null) this.clients.delete(ws._teamIdx);
    this.allClients.delete(ws);
  }

  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.allClients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  send(teamIdx, msg) {
    const ws = this.clients.get(teamIdx);
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  canStart() {
    return this.clients.size >= this.config.numTeams && !this.started;
  }

  startGame() {
    this.started = true;
    const seed = Date.now() & 0xffff;
    this.engine = new GameEngine(this.config, seed);

    this.broadcast({ type: 'game_started' });
    this._broadcastState();
    this._notifyAbilitySetup();
    this._startTimer();
  }

  _broadcastState() {
    const serialized = this.engine.serialize();
    this.broadcast({ type: 'state', state: serialized });
  }

  _notifyAbilitySetup() {
    const s = this.engine.state;
    if (s.phase !== 'ABILITY_SELECTION') return;
    const { teamIdx, playerIdx } = s.abilitySetup;
    this.send(teamIdx, { type: 'your_setup_turn', teamIdx, playerIdx });
    this.broadcast({ type: 'ability_setup_turn', teamIdx, playerIdx });
  }

  _notifyActiveTurn() {
    const s = this.engine.state;
    if (s.phase !== 'GLOBAL_MAP') return;
    const { activeTeamIdx: ti, activePlayerIdx: pi } = s;
    const moves = this.engine.getValidMoves(ti, pi);
    this.send(ti, { type: 'your_turn', teamIdx: ti, playerIdx: pi, validMoves: moves });
    this.broadcast({ type: 'active_turn', teamIdx: ti, playerIdx: pi });
  }

  _startTimer() {
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval = setInterval(() => {
      if (!this.engine) return;
      const s = this.engine.state;
      if (s.phase === 'VICTORY') { clearInterval(this._timerInterval); return; }
      if (s.phase !== 'GLOBAL_MAP') return;

      const changed = this.engine.tick(1); // tick 1 second
      if (changed) {
        this._broadcastState();
        this._notifyActiveTurn();
      } else {
        // Just broadcast timer
        const data = JSON.stringify({ type: 'timer', value: Math.ceil(s.turnTimeLeft) });
        for (const ws of this.allClients) {
          if (ws.readyState === WebSocket.OPEN) ws.send(data);
        }
      }
    }, 1000);
  }

  handleMessage(ws, msg) {
    const teamIdx = ws._teamIdx;
    const e = this.engine;

    switch (msg.type) {

      case 'set_ability': {
        if (!e) return;
        const s = e.state;
        if (s.phase !== 'ABILITY_SELECTION') return;
        const { teamIdx: eti, playerIdx: epi } = s.abilitySetup;
        if (eti !== teamIdx) return send(ws, { type: 'error', message: 'Not your setup turn' });
        const r = e.confirmAbility(msg.abilityId, eti, epi);
        if (!r.ok) return send(ws, { type: 'error', message: r.error });
        this._broadcastState();
        if (e.state.phase === 'ABILITY_SELECTION') {
          this._notifyAbilitySetup();
        } else {
          this._notifyActiveTurn();
        }
        break;
      }

      case 'move': {
        if (!e) return;
        const r = e.movePlayer(msg.col, msg.row, teamIdx, e.state.activePlayerIdx);
        if (!r.ok) return send(ws, { type: 'error', message: r.error });
        this._broadcastState();
        if (e.state.phase === 'GLOBAL_MAP' && !e.state.pendingItem && !e.state.combat) {
          this._notifyActiveTurn();
        }
        if (e.state.phase === 'COMBAT') {
          const c = e.state.combat;
          this.send(c.teamA.idx, { type: 'your_combat_turn', side: 'A', phase: c.phase });
        }
        break;
      }

      case 'end_turn': {
        if (!e) return;
        const r = e.endTurn(teamIdx, e.state.activePlayerIdx);
        if (!r.ok) return send(ws, { type: 'error', message: r.error });
        this._broadcastState();
        this._notifyActiveTurn();
        break;
      }

      case 'use_ability': {
        if (!e) return;
        const r = e.useAbility(teamIdx, e.state.activePlayerIdx);
        if (!r.ok) return send(ws, { type: 'error', message: 'Cannot use ability' });
        const moves = e.getValidMoves(teamIdx, e.state.activePlayerIdx)
          .filter(m => { const c = e.state.map.cells[`${m.col},${m.row}`]; return c && c.terrain !== 'grailzone'; });
        send(ws, { type: 'extra_move_mode', validMoves: moves });
        this._broadcastState();
        break;
      }

      case 'extra_move': {
        if (!e) return;
        const r = e.applyExtraMove(msg.col, msg.row, teamIdx, e.state.activePlayerIdx);
        if (!r.ok) return send(ws, { type: 'error', message: r.error || 'Invalid extra move' });
        this._broadcastState();
        this._notifyActiveTurn();
        break;
      }

      case 'item_pickup': {
        if (!e) return;
        const r = e.resolveItem(msg.action, msg.targetPlayerIdx, teamIdx, e.state.activePlayerIdx);
        if (!r.ok) return send(ws, { type: 'error', message: 'Item resolve failed' });
        this._broadcastState();
        this._notifyActiveTurn();
        break;
      }

      case 'combat_attack': {
        if (!e) return;
        const r = e.combatAttack(teamIdx);
        if (!r.ok) return send(ws, { type: 'error', message: 'Not your combat turn' });
        this._broadcastState();
        if (e.state.combat?.phase !== 'DONE') {
          const c = e.state.combat;
          const nextSide = c.turn;
          const nextTeam = nextSide === 'A' ? c.teamA : c.teamB;
          this.send(nextTeam.idx, { type: 'your_combat_turn', side: nextSide, phase: c.phase });
        }
        break;
      }

      case 'combat_retreat': {
        if (!e) return;
        const r = e.combatRetreat(teamIdx);
        if (!r.ok) return send(ws, { type: 'error', message: r.error || 'Cannot retreat' });
        this._broadcastState();
        if (e.state.phase === 'GLOBAL_MAP') this._notifyActiveTurn();
        break;
      }

      case 'combat_heal': {
        if (!e) return;
        const r = e.combatHeal(teamIdx);
        if (!r.ok) return send(ws, { type: 'error', message: r.error || 'Cannot heal' });
        this._broadcastState();
        break;
      }

      case 'combat_dismiss': {
        if (!e) return;
        const r = e.dismissCombat();
        if (!r.ok) return send(ws, { type: 'error', message: 'Combat not done' });
        this._broadcastState();
        this._notifyActiveTurn();
        break;
      }

      case 'get_state': {
        if (!e) return;
        send(ws, { type: 'state', state: e.serialize() });
        break;
      }
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ============================================================
// HTTP + WEBSOCKET SERVER
// ============================================================
const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  // API routes
  if (req.url === '/health') {
    res.writeHead(200); res.end('ok'); return;
  }
  if (req.url === '/rooms' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const info = [...rooms.values()].map(r => ({
      code: r.code, teams: r.config.numTeams,
      players: r.clients.size, started: r.started,
    }));
    res.end(JSON.stringify(info)); return;
  }

  // Static files from public/
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC, urlPath);
  // Security: prevent path traversal
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Get visitor id from header (injected by Perplexity proxy)
  ws._visitorId = req.headers['x-visitor-id'] || null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create_room') {
      const config = {
        numTeams: Math.min(4, Math.max(2, parseInt(msg.numTeams) || 3)),
        turnDuration: Math.min(60, Math.max(5, parseInt(msg.turnDuration) || 15)),
        fogEnabled: msg.fogEnabled !== false,
      };
      let code;
      do { code = genCode(); } while (rooms.has(code));
      const room = new Room(code, config);
      rooms.set(code, room);
      // Creator joins as team 0
      room.addClient(ws, 0);
      send(ws, { type: 'room_created', roomCode: code, teamIdx: 0, config });
      // Clean up empty rooms after 30min
      setTimeout(() => { if (!room.started && room.clients.size === 0) rooms.delete(code); }, 30*60*1000);
      return;
    }

    if (msg.type === 'join_room') {
      const room = rooms.get(msg.roomCode?.toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'Room not found' });
      if (room.started) return send(ws, { type: 'error', message: 'Game already started' });

      // Find first free team slot
      let slot = null;
      for (let i = 0; i < room.config.numTeams; i++) {
        if (!room.clients.has(i)) { slot = i; break; }
      }
      if (slot === null) return send(ws, { type: 'error', message: 'Room full' });

      room.addClient(ws, slot);
      send(ws, { type: 'joined', teamIdx: slot, roomCode: room.code, config: room.config });
      room.broadcast({ type: 'player_joined', teamIdx: slot, totalJoined: room.clients.size, needed: room.config.numTeams });

      if (room.canStart()) {
        room.startGame();
      }
      return;
    }

    // Route to room
    if (ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) room.handleMessage(ws, msg);
    }
  });

  ws.on('close', () => {
    if (ws._roomCode) {
      const room = rooms.get(ws._roomCode);
      if (room) {
        room.removeClient(ws);
        if (room.allClients.size === 0) {
          if (room._timerInterval) clearInterval(room._timerInterval);
          rooms.delete(ws._roomCode);
        } else {
          room.broadcast({ type: 'player_left', teamIdx: ws._teamIdx });
        }
      }
    }
  });

  ws.on('error', () => {});

  // Keepalive ping every 25s
  ws._pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping();
    else clearInterval(ws._pingInterval);
  }, 25000);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`Graal Hunt WS server listening on port ${PORT}`);
});
