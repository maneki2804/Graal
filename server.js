/**
 * Graal Hunt — WebSocket Game Server v2
 * Combat rework: classes, initiative, front/back rows, XP, levels, squad movement, neutrals
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT   = process.env.PORT || 8765;
const PUBLIC = path.join(__dirname, 'public');

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

// Player classes
const CLASS_DEFS = {
  warrior:  { name: 'Воин',       icon: '⚔',  hp: 14, atk: 5, initiative: 7,  row: 'front', atkType: 'melee',  atkMode: 'single' },
  archer:   { name: 'Стрелок',    icon: '🏹', hp: 9,  atk: 6, initiative: 10, row: 'back',  atkType: 'ranged', atkMode: 'single' },
  mage:     { name: 'Маг',        icon: '🔮', hp: 7,  atk: 4, initiative: 4,  row: 'back',  atkType: 'ranged', atkMode: 'area'   },
  support:  { name: 'Поддержка',  icon: '💊', hp: 9,  atk: 3, initiative: 5,  row: 'back',  atkType: 'ranged', atkMode: 'single', heals: 3 },
};
const CLASS_IDS = Object.keys(CLASS_DEFS);

// XP table: XP needed to reach each level (index = level)
const XP_TO_LEVEL = [0, 0, 30, 70, 130, 210, 310, 430, 570, 730, 900];
const MAX_LEVEL = 10;

// Stat gain per level
const LEVEL_ATK_BONUS = 1;   // +1 ATK per level
const LEVEL_HP_BONUS  = 2;   // +2 max HP per level

// Items
const ITEM_DEFS = {
  rope:   { name: 'Верёвка', icon: '🪢', type: 'traverse', desc: 'Проход через горы.' },
  boat:   { name: 'Лодка',   icon: '⛵', type: 'traverse', desc: 'Переплыть воду.' },
  axe:    { name: 'Топор',   icon: '🪓', type: 'traverse', desc: 'Обычное движение в лесу.' },
  sword:  { name: 'Меч',     icon: '⚔',  type: 'combat',   desc: '+3 ATK владельцу в бою.' },
  shield: { name: 'Щит',     icon: '🛡', type: 'combat',   desc: '+3 HP владельцу в бою.' },
  cloak:  { name: 'Плащ',    icon: '🧥', type: 'combat',   desc: '25% уклонения.' },
  wand:   { name: 'Жезл',    icon: '🪄', type: 'combat',   desc: '+2 урона по всему ряду.' },
  amulet: { name: 'Амулет',  icon: '📿', type: 'combat',   desc: '+1 ATK всей команде в бою.' },
};
const ITEM_KEYS = Object.keys(ITEM_DEFS);
const TRAVERSE_ITEMS = ['rope','boat','axe'];
const COMBAT_ITEMS   = ['sword','shield','cloak','wand','amulet'];

const MAP_SIZE    = { 2: 40, 3: 60, 4: 80 };
const GRAIL_ZONE_R = 5;
const TEAM_COLORS = ['#2ec4b6','#f4a017','#a569e0','#e05c6a'];
const TEAM_NAMES  = ['Бирюза','Янтарь','Аметист','Коралл'];

// Neutral camp strength relative to team avg level
const NEUTRAL_BASE_HP  = 8;
const NEUTRAL_BASE_ATK = 3;
const NEUTRAL_COUNT    = { 2: 8, 3: 14, 4: 20 };

// Item distribution: items per team on map
const ITEMS_PER_TEAM = 6;

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
  toCube(c, r) { const x = c-(r-(r&1))/2, z=r; return [x,-x-z,z]; },
  fromCube(x, z) { return [x+(z-(z&1))/2, z]; },
  neighbors(c, r) {
    return (r&1)===0
      ? [[c-1,r],[c+1,r],[c,r-1],[c-1,r-1],[c,r+1],[c-1,r+1]]
      : [[c-1,r],[c+1,r],[c+1,r-1],[c,r-1],[c+1,r+1],[c,r+1]];
  },
  dirTo(c1,r1,c2,r2) {
    const [ax,ay,az]=Hex.toCube(c1,r1),[bx,by,bz]=Hex.toCube(c2,r2);
    const dx=bx-ax,dy=by-ay,dz=bz-az;
    const m=Math.max(Math.abs(dx),Math.abs(ay),Math.abs(az))||1;
    return [Math.round(dx/m),Math.round(dy/m),Math.round(dz/m)];
  },
};

// ============================================================
// MAP GENERATION
// ============================================================
let _seed = 1;
function srnd(n) { const x=Math.sin(n+_seed)*43758.5453; return x-Math.floor(x); }

function generateMap(numTeams, seed) {
  _seed = seed;
  const size = MAP_SIZE[numTeams];
  const cells = {};
  for (let r=0;r<size;r++) for (let c=0;c<size;c++) {
    const k=`${c},${r}`, v=srnd(c*1000+r*37+7);
    let terrain='plains';
    if (v<0.12) terrain='water';
    else if (v<0.22) terrain='mountain';
    else if (v<0.38) terrain='forest';
    cells[k]={ col:c, row:r, terrain, item:null, neutral:null };
  }
  // Grail zone
  const cx=Math.floor(size/2), cy=Math.floor(size/2);
  for (let r=cy-GRAIL_ZONE_R;r<=cy+GRAIL_ZONE_R;r++)
    for (let c=cx-GRAIL_ZONE_R;c<=cx+GRAIL_ZONE_R;c++)
      if (c>=0&&r>=0&&c<size&&r<size&&Hex.distance(c,r,cx,cy)<=GRAIL_ZONE_R)
        cells[`${c},${r}`].terrain='grailzone';

  // Items — scaled by team count
  const totalItems = numTeams * ITEMS_PER_TEAM;
  let placed=0;
  for (let i=0;i<totalItems*5&&placed<totalItems;i++) {
    const c=Math.floor(srnd(i*991+3)*size), r=Math.floor(srnd(i*773+7)*size);
    const k=`${c},${r}`;
    if (cells[k]&&!cells[k].item&&cells[k].terrain!=='grailzone'&&cells[k].terrain!=='water') {
      cells[k].item = ITEM_KEYS[placed % ITEM_KEYS.length];
      placed++;
    }
  }

  // Neutral camps
  const nc = NEUTRAL_COUNT[numTeams];
  let neutralsPlaced=0;
  for (let i=0;i<nc*10&&neutralsPlaced<nc;i++) {
    const c=Math.floor(srnd(i*337+13)*size), r=Math.floor(srnd(i*557+17)*size);
    const k=`${c},${r}`;
    const cell=cells[k];
    if (cell&&!cell.item&&!cell.neutral&&cell.terrain!=='grailzone'&&cell.terrain!=='water'&&
        Hex.distance(c,r,cx,cy)>GRAIL_ZONE_R+3) {
      cell.neutral={ id: neutralsPlaced, defeated: false };
      neutralsPlaced++;
    }
  }
  return { size, cells, grailCol:cx, grailRow:cy };
}

function computeSpawns(numTeams, size) {
  const cx=size/2, cy=size/2, r=Math.floor(size*0.3);
  return Array.from({length:numTeams},(_,i)=>{
    const a=(2*Math.PI*i/numTeams)-Math.PI/2;
    return {
      col: Math.max(2,Math.min(size-3,Math.round(cx+r*Math.cos(a)))),
      row: Math.max(2,Math.min(size-3,Math.round(cy+r*Math.sin(a)))),
    };
  });
}

// ============================================================
// PLAYER FACTORY
// ============================================================
function makePlayer(pi, classId, col, row) {
  const cls = CLASS_DEFS[classId] || CLASS_DEFS.warrior;
  return {
    idx: pi,
    classId,
    ability: classId,  // keep ability = classId for backward compat display
    items: [],
    col, row,
    hp: cls.hp, maxHp: cls.hp,
    baseAtk: cls.atk,
    alive: true,
    xp: 0, level: 1,
    abilityUsed: false,
    abilityUsedMatch: false,
  };
}

// ============================================================
// GAME ENGINE
// ============================================================
class GameEngine {
  constructor(config, seed) {
    this.config = config;
    const map   = generateMap(config.numTeams, seed);
    const spawns= computeSpawns(config.numTeams, map.size);

    // Default class assignment if not provided
    const defaultClasses = ['warrior','archer','mage','support'];

    this.state = {
      phase: 'CLASS_SELECTION',
      config,
      map,
      teams: Array.from({length:config.numTeams},(_,ti)=>{
        const sp = spawns[ti];
        const classes = config.teamClasses?.[ti] || defaultClasses;
        return {
          idx: ti,
          name: TEAM_NAMES[ti],
          color: TEAM_COLORS[ti],
          eliminated: false,
          fogReveal: new Set(),
          col: sp.col, row: sp.row,  // squad position (single hex)
          lastDir: null,             // last move direction for arrow
          players: Array.from({length:4},(_,pi)=>
            makePlayer(pi, classes[pi] || defaultClasses[pi], sp.col, sp.row)
          ),
        };
      }),
      activeTeamIdx: 0,
      activePlayerIdx: 0,
      round: 1,
      turnTimeLeft: config.turnDuration,
      battleCount: 0,
      combat: null,
      pendingItem: null,
      winner: null,
      classSetup: { teamIdx: 0 },  // which team is choosing classes
    };

    this.state.teams.forEach(t=>this._revealAround(t,t.col,t.row));
  }

  // ---- CLASS SELECTION ----
  confirmClasses(classIds, teamIdx) {
    const s = this.state;
    if (s.phase !== 'CLASS_SELECTION') return {ok:false};
    if (s.classSetup.teamIdx !== teamIdx) return {ok:false,error:'Not your turn'};
    const team = s.teams[teamIdx];
    const sp   = { col: team.col, row: team.row };
    team.players = classIds.slice(0,4).map((cid,pi)=>
      makePlayer(pi, CLASS_IDS.includes(cid)?cid:'warrior', sp.col, sp.row)
    );
    // Advance to next team
    let next = teamIdx+1;
    if (next >= s.config.numTeams) {
      s.phase = 'GLOBAL_MAP';
      s.classSetup = null;
      this._startTeamTurn(0);
    } else {
      s.classSetup = { teamIdx: next };
    }
    return {ok:true};
  }

  // ---- SQUAD MOVE (whole team moves together) ----
  moveSquad(col, row, teamIdx) {
    const s = this.state;
    if (s.phase !== 'GLOBAL_MAP') return {ok:false,error:'Wrong phase'};
    if (s.pendingItem) return {ok:false,error:'Pending item'};
    if (s.activeTeamIdx !== teamIdx) return {ok:false,error:'Not your turn'};

    const team = s.teams[teamIdx];
    // Must be adjacent to current squad position
    const valid = this.getValidSquadMoves(teamIdx);
    if (!valid.some(m=>m.col===col&&m.row===row))
      return {ok:false,error:'Invalid move'};

    // Track last direction
    team.lastDir = { fromCol: team.col, fromRow: team.row, toCol: col, toRow: row };

    // Move entire squad
    team.col = col; team.row = row;
    team.players.forEach(p=>{ p.col=col; p.row=row; });
    this._revealAround(team, col, row);

    const cell = s.map.cells[`${col},${row}`];

    // Item pickup
    if (cell?.item) {
      s.pendingItem = {
        teamIdx, col, row, itemId: cell.item,
        votes: {}, // playerIdx → 'take'|playerIdx (give to)
        timerStart: Date.now(),
      };
      return {ok:true,event:'item'};
    }

    // Neutral camp
    if (cell?.neutral && !cell.neutral.defeated) {
      this._triggerNeutral(team, cell.neutral, col, row);
      return {ok:true,event:'combat'};
    }

    // Grail capture
    if (col===s.map.grailCol && row===s.map.grailRow) {
      this._win(team); return {ok:true,event:'victory'};
    }

    // Enemy contact
    for (const et of s.teams) {
      if (et.idx===teamIdx||et.eliminated) continue;
      if (et.col===col && et.row===row) {
        this._triggerCombat(team, et);
        return {ok:true,event:'combat'};
      }
      if (Hex.distance(col,row,et.col,et.row)<=1) {
        this._triggerCombat(team, et);
        return {ok:true,event:'combat'};
      }
    }

    return {ok:true};
  }

  endTurn(teamIdx) {
    const s = this.state;
    if (s.activeTeamIdx !== teamIdx) return {ok:false,error:'Not your turn'};
    this._advancePlayer(teamIdx);
    return {ok:true};
  }

  // ---- ITEM VOTING ----
  itemVote(teamIdx, playerIdx, action, targetPlayerIdx) {
    const s = this.state;
    const pi = s.pendingItem;
    if (!pi || pi.teamIdx !== teamIdx) return {ok:false};
    pi.votes[playerIdx] = action === 'give' ? targetPlayerIdx : action;
    return {ok:true};
  }

  resolveItemVotes(forced) {
    const s = this.state;
    const pi = s.pendingItem;
    if (!pi) return {ok:false};
    const team = s.teams[pi.teamIdx];
    const cell = s.map.cells[`${pi.col},${pi.row}`];

    // Tally votes: majority or random
    const tally = {};
    for (const [pidx, vote] of Object.entries(pi.votes)) {
      const key = String(vote);
      tally[key] = (tally[key]||0)+1;
    }
    let winner = null;
    if (Object.keys(tally).length > 0) {
      winner = Object.entries(tally).sort((a,b)=>b[1]-a[1])[0][0];
    }

    if (winner === null || forced) {
      // Random live player
      const alive = team.players.filter(p=>p.alive);
      winner = String(alive[Math.floor(Math.random()*alive.length)]?.idx ?? 0);
    }

    // Give item
    const recipientIdx = parseInt(winner);
    if (!isNaN(recipientIdx)) {
      const recipient = team.players[recipientIdx];
      if (recipient && recipient.alive) {
        if (recipient.items.length >= 2) recipient.items.shift();
        recipient.items.push(pi.itemId);
        if (cell) cell.item = null;
      }
    } else if (winner === 'leave') {
      // leave on ground
    } else {
      if (cell) cell.item = null;
    }

    s.pendingItem = null;
    return {ok:true};
  }

  // ---- COMBAT SETUP ----
  _triggerCombat(teamA, teamB) {
    const s = this.state;
    s.phase = 'COMBAT';
    s.battleCount++;
    s.combat = this._buildCombat(teamA, teamB);
  }

  _triggerNeutral(team, neutral, col, row) {
    const s = this.state;
    s.phase = 'COMBAT';
    s.battleCount++;
    // Scale neutral strength by team avg level
    const avgLevel = team.players.reduce((sum,p)=>sum+p.level,0)/team.players.length;
    const scale = 1 + (avgLevel-1)*0.3;
    // Build a pseudo-team for neutrals
    const neutralTeam = {
      idx: -1, name: 'Нейтралы', color: '#888888',
      col, row, players: [],
      fogReveal: new Set(), eliminated: false,
    };
    // 2–4 neutral fighters depending on map progress
    const count = Math.min(4, 2+Math.floor(avgLevel/3));
    for (let i=0;i<count;i++) {
      neutralTeam.players.push({
        idx: i, classId: 'warrior', ability: 'warrior',
        items: [], col, row,
        hp: Math.round(NEUTRAL_BASE_HP*scale),
        maxHp: Math.round(NEUTRAL_BASE_HP*scale),
        baseAtk: Math.round(NEUTRAL_BASE_ATK*scale),
        alive: true, xp:0, level:Math.max(1,Math.round(avgLevel)),
        abilityUsed:false, abilityUsedMatch:false,
      });
    }
    s.combat = this._buildCombat(team, neutralTeam, true);
    s.combat.isNeutral = true;
    s.combat.neutralCell = `${col},${row}`;
  }

  _buildCombat(teamA, teamB, autoArrange) {
    // Arrange fighters: warriors front, others back
    const arrange = (team) => {
      const alive = team.players.filter(p=>p.alive);
      const front = alive.filter(p=>CLASS_DEFS[p.classId]?.row==='front');
      const back  = alive.filter(p=>CLASS_DEFS[p.classId]?.row!=='front');
      // If no warriors, sort by hp desc for front
      if (front.length===0) {
        const sorted = [...back].sort((a,b)=>(b.hp+b.level)-(a.hp+a.level));
        return { front: sorted.slice(0,Math.ceil(sorted.length/2)), back: sorted.slice(Math.ceil(sorted.length/2)) };
      }
      return { front, back };
    };
    const rowsA = arrange(teamA);
    const rowsB = arrange(teamB);

    const mkFighter = (p, row) => {
      const cls = CLASS_DEFS[p.classId] || CLASS_DEFS.warrior;
      // Item bonuses
      let bonusAtk=0, bonusHp=0, dodge=0, areaBonus=0, teamAtkBonus=0;
      for (const item of p.items) {
        if (item==='sword')  bonusAtk+=3;
        if (item==='shield') bonusHp+=3;
        if (item==='cloak')  dodge=Math.max(dodge,0.25);
        if (item==='wand')   areaBonus+=2;
        if (item==='amulet') teamAtkBonus+=1;
      }
      const levelAtk = (p.level-1)*LEVEL_ATK_BONUS;
      return {
        player: p, classId: p.classId,
        hp: p.hp + bonusHp, maxHp: p.maxHp + bonusHp,
        atk: p.baseAtk + bonusAtk + levelAtk,
        initiative: cls.initiative + (p.level-1)*0.5,
        atkType: cls.atkType, atkMode: cls.atkMode,
        heals: cls.heals||0,
        alive: true, row,
        dodge, areaBonus, teamAtkBonus,
      };
    };

    const fightersA = [
      ...rowsA.front.map(p=>mkFighter(p,'front')),
      ...rowsA.back.map(p=>mkFighter(p,'back')),
    ];
    const fightersB = [
      ...rowsB.front.map(p=>mkFighter(p,'front')),
      ...rowsB.back.map(p=>mkFighter(p,'back')),
    ];

    return {
      teamA, teamB,
      fightersA, fightersB,
      phase: 'ARRANGE',   // ARRANGE → ACTIVE → DONE
      arrangeTimeLeft: 10,
      arrangeConfirmedA: false, arrangeConfirmedB: false,
      log: [`${teamA.name} vs ${teamB.name}!`],
      isNeutral: false, neutralCell: null,
      winner: null,
      // Combat turn order is computed fresh each round
      turnQueue: [], currentTurnIdx: 0,
    };
  }

  // Confirm arrangement and start combat
  confirmArrange(teamIdx, arrangement) {
    const s = this.state;
    const c = s.combat;
    if (!c || c.phase !== 'ARRANGE') return {ok:false};

    if (arrangement && arrangement.length) {
      // Rearrange fighters for this team
      const side = c.teamA.idx===teamIdx ? 'A' : 'B';
      const fighters = side==='A' ? c.fightersA : c.fightersB;
      // arrangement = array of {playerIdx, row}
      for (const {playerIdx, row} of arrangement) {
        const f = fighters.find(f=>f.player.idx===playerIdx);
        if (f) f.row = row;
      }
    }

    if (c.teamA.idx===teamIdx) c.arrangeConfirmedA=true;
    else if (!c.isNeutral)     c.arrangeConfirmedB=true;
    else                        c.arrangeConfirmedB=true; // neutral auto-confirms

    if (c.arrangeConfirmedA && c.arrangeConfirmedB) {
      this._startCombatRound(c);
    }
    return {ok:true};
  }

  tickArrange(dt) {
    const s = this.state;
    const c = s.combat;
    if (!c || c.phase !== 'ARRANGE') return false;
    c.arrangeTimeLeft -= dt;
    if (c.arrangeTimeLeft <= 0) {
      c.arrangeConfirmedA = true;
      c.arrangeConfirmedB = true;
      this._startCombatRound(c);
      return true;
    }
    return false;
  }

  _startCombatRound(c) {
    c.phase = 'ACTIVE';
    // Build initiative queue from all alive fighters
    const all = [
      ...c.fightersA.filter(f=>f.alive).map(f=>({...f,side:'A'})),
      ...c.fightersB.filter(f=>f.alive).map(f=>({...f,side:'B'})),
    ].sort((a,b)=>b.initiative-a.initiative);
    c.turnQueue    = all;
    c.currentTurnIdx = 0;
  }

  // A fighter takes their combat action (called by bot or human)
  combatAction(teamIdx, targetPlayerIdx) {
    const s = this.state;
    const c = s.combat;
    if (!c||c.phase!=='ACTIVE') return {ok:false};

    const currentFighter = c.turnQueue[c.currentTurnIdx];
    if (!currentFighter) return {ok:false};

    const side = c.teamA.idx===teamIdx ? 'A' : 'B';
    if (currentFighter.side !== side) return {ok:false,error:'Not your fighter'};

    const defFighters = side==='A' ? c.fightersB : c.fightersA;
    const attFighters = side==='A' ? c.fightersA : c.fightersB;
    const attTeamName = side==='A' ? c.teamA.name : c.teamB.name;
    const defTeamName = side==='A' ? c.teamB.name : c.teamA.name;

    if (currentFighter.atkMode === 'area') {
      // Mage: hit entire front row (or all if no front)
      const frontDef = defFighters.filter(f=>f.alive&&f.row==='front');
      const targets  = frontDef.length ? frontDef : defFighters.filter(f=>f.alive);
      let totalDmg=0;
      for (const t of targets) {
        if (Math.random() < t.dodge) { c.log.push(`  ${t.player.idx+1}: уклон!`); continue; }
        const dmg = Math.max(1, currentFighter.atk + (currentFighter.areaBonus||0) - 1);
        t.hp -= dmg; t.player.hp = t.hp;
        totalDmg += dmg;
        if (t.hp<=0){t.hp=0;t.alive=false;t.player.alive=false;t.player.hp=0;}
      }
      c.log.push(`  ${attTeamName}[${currentFighter.player.idx+1}]🔮→ряд: -${totalDmg} урона`);
    } else {
      // Single target: melee hits front row only; ranged hits any
      let pool;
      if (currentFighter.atkType==='melee') {
        const front = defFighters.filter(f=>f.alive&&f.row==='front');
        pool = front.length ? front : defFighters.filter(f=>f.alive);
      } else {
        pool = defFighters.filter(f=>f.alive);
      }
      if (!pool.length) { this._advanceCombatTurn(c); return {ok:true}; }

      let target;
      if (targetPlayerIdx != null) {
        target = pool.find(f=>f.player.idx===targetPlayerIdx) || pool[0];
      } else {
        // AI/auto: pick lowest HP
        target = pool.sort((a,b)=>a.hp-b.hp)[0];
      }

      if (Math.random() < target.dodge) {
        c.log.push(`  ${attTeamName}[${currentFighter.player.idx+1}]→${target.player.idx+1}: уклон!`);
      } else {
        // Support heals instead of attacking — lowest HP ally
        if (currentFighter.heals && currentFighter.heals > 0) {
          const wounded = attFighters.filter(f=>f.alive).sort((a,b)=>a.hp/a.maxHp - b.hp/b.maxHp)[0];
          if (wounded && wounded.hp < wounded.maxHp) {
            const heal = currentFighter.heals + (currentFighter.player.level-1);
            wounded.hp = Math.min(wounded.maxHp, wounded.hp+heal);
            wounded.player.hp = wounded.hp;
            c.log.push(`  💊→${wounded.player.idx+1}: +${heal}HP`);
            this._advanceCombatTurn(c);
            return {ok:true};
          }
        }
        const dmg = Math.max(1, currentFighter.atk + (currentFighter.teamAtkBonus||0));
        target.hp -= dmg; target.player.hp = target.hp;
        c.log.push(`  ${attTeamName}[${currentFighter.player.idx+1}]→${defTeamName}[${target.player.idx+1}]: -${dmg}HP`);
        if (target.hp<=0){
          target.hp=0;target.alive=false;target.player.alive=false;target.player.hp=0;
          c.log.push(`  ${target.player.idx+1} повержен!`);
        }
      }
    }

    this._checkCombatEnd(c);
    if (c.phase==='ACTIVE') this._advanceCombatTurn(c);
    return {ok:true};
  }

  _advanceCombatTurn(c) {
    c.currentTurnIdx++;
    // Skip dead fighters
    while (c.currentTurnIdx < c.turnQueue.length && !c.turnQueue[c.currentTurnIdx].alive) {
      c.currentTurnIdx++;
    }
    if (c.currentTurnIdx >= c.turnQueue.length) {
      // All fighters have acted — start new round
      this._startCombatRound(c);
    }
  }

  _checkCombatEnd(c) {
    const aAlive = c.fightersA.filter(f=>f.alive).length;
    const bAlive = c.fightersB.filter(f=>f.alive).length;
    if (aAlive===0&&bAlive===0) { c.log.push('Ничья!'); this._endCombat(null,c); }
    else if (aAlive===0) { c.log.push(`${c.teamB.name} победили!`); this._endCombat(c.teamB,c); }
    else if (bAlive===0) { c.log.push(`${c.teamA.name} победили!`); this._endCombat(c.teamA,c); }
  }

  _endCombat(winner, c) {
    const s = this.state;
    c.winner = winner; c.phase = 'DONE';

    // Grant XP: everyone who participated gains XP
    const xpGain = winner ? 40 : 15; // win gives more XP
    for (const f of [...c.fightersA,...c.fightersB]) {
      if (!c.isNeutral || f.side!=='B') {
        const p = f.player;
        this._grantXP(p, xpGain);
      }
    }
    // Also grant XP to dead players on winning team
    if (winner && winner.idx >= 0) {
      for (const p of winner.players) {
        if (!p.alive) this._grantXP(p, xpGain/2);
      }
    }

    // Neutral: mark defeated, leave item on cell
    if (c.isNeutral && winner && winner.idx >= 0) {
      const cell = s.map.cells[c.neutralCell];
      if (cell && cell.neutral) cell.neutral.defeated = true;
    }

    // Update alive status on teams
    for (const team of [c.teamA, c.teamB]) {
      if (team.idx < 0) continue; // neutral
      if (!team.eliminated && team.players.every(p=>!p.alive)) {
        team.eliminated=true;
        c.log.push(`Команда ${team.name} выбыла!`);
      }
    }
    const surviving = s.teams.filter(t=>!t.eliminated);
    if (surviving.length===1) this._win(surviving[0]);
  }

  _grantXP(player, amount) {
    if (player.level >= MAX_LEVEL) return;
    player.xp = (player.xp||0) + amount;
    while (player.level < MAX_LEVEL && player.xp >= XP_TO_LEVEL[player.level+1]) {
      player.level++;
      // Increase max HP and restore some HP on levelup
      player.maxHp += LEVEL_HP_BONUS;
      player.hp = Math.min(player.maxHp, player.hp + LEVEL_HP_BONUS);
      // Log is just in console — client can infer from state diff
    }
  }

  dismissCombat() {
    const s = this.state;
    if (!s.combat||s.combat.phase!=='DONE') return {ok:false};
    const c = s.combat;
    s.combat = null;
    s.phase = 'GLOBAL_MAP';
    // If neutral and winner is the player team — show item vote if neutral had items
    // (handled via pendingItem set before dismissCombat if needed)
    this._startTeamTurn(s.activeTeamIdx);
    return {ok:true};
  }

  // ---- MAP HELPERS ----
  getValidSquadMoves(teamIdx) {
    const s = this.state;
    const team = s.teams[teamIdx];
    // Any player can traverse if team has rope/boat/axe
    const teamItems = team.players.flatMap(p=>p.items);
    return Hex.neighbors(team.col, team.row)
      .filter(([nc,nr])=>{
        if (nc<0||nr<0||nc>=s.map.size||nr>=s.map.size) return false;
        const cell = s.map.cells[`${nc},${nr}`];
        if (!cell) return false;
        if (cell.terrain==='water'    && !teamItems.includes('boat')) return false;
        if (cell.terrain==='mountain' && !teamItems.includes('rope')) return false;
        return true;
      })
      .map(([col,row])=>({col,row}));
  }

  // ---- TURN MANAGEMENT ----
  _startTeamTurn(ti) {
    const s = this.state;
    s.activeTeamIdx = ti;
    // Find first alive player
    const pi = s.teams[ti].players.findIndex(p=>p.alive);
    s.activePlayerIdx = pi >= 0 ? pi : 0;
    s.turnTimeLeft = s.config.turnDuration;
  }

  _advancePlayer(ti) {
    const s = this.state;
    const team = s.teams[ti];
    let next = s.activePlayerIdx + 1;
    while (next < 4 && !team.players[next].alive) next++;
    if (next < 4) {
      s.activePlayerIdx = next;
      s.turnTimeLeft = s.config.turnDuration;
    } else {
      this._advanceTeam(ti);
    }
  }

  _advanceTeam(ti) {
    const s = this.state;
    let next=(ti+1)%s.teams.length;
    let guard=s.teams.length;
    while (s.teams[next].eliminated&&--guard>0) next=(next+1)%s.teams.length;
    if (next<=ti) { s.round++; this._moveGrail(); }
    this._startTeamTurn(next);
  }

  _moveGrail() {
    const s=this.state;
    const {grailCol:gc,grailRow:gr,size}=s.map;
    const cx=Math.floor(size/2),cy=Math.floor(size/2);
    const candidates=[...Hex.neighbors(gc,gr),[gc,gr]];
    let best=-1,bc=gc,br=gr;
    for (const [nc,nr] of candidates) {
      if (nc<0||nr<0||nc>=size||nr>=size) continue;
      if (Hex.distance(nc,nr,cx,cy)>GRAIL_ZONE_R) continue;
      let minD=Infinity;
      for (const t of s.teams) {
        if (t.eliminated) continue;
        const d=Hex.distance(nc,nr,t.col,t.row);
        if (d<minD) minD=d;
      }
      if (minD>best){best=minD;bc=nc;br=nr;}
    }
    s.map.grailCol=bc;s.map.grailRow=br;
  }

  _revealAround(team,col,row) {
    team.fogReveal.add(`${col},${row}`);
    for (const [nc,nr] of Hex.neighbors(col,row)) {
      team.fogReveal.add(`${nc},${nr}`);
      for (const [nc2,nr2] of Hex.neighbors(nc,nr)) team.fogReveal.add(`${nc2},${nr2}`);
    }
  }

  _win(team) { this.state.phase='VICTORY'; this.state.winner=team; }

  // ---- TIMER TICK ----
  tick(dt) {
    const s=this.state;
    if (s.phase==='COMBAT'&&s.combat?.phase==='ARRANGE') {
      return this.tickArrange(dt);
    }
    if (s.phase!=='GLOBAL_MAP'||s.pendingItem) return false;
    s.turnTimeLeft-=dt;
    if (s.turnTimeLeft<=0){
      s.turnTimeLeft=0;
      this._advancePlayer(s.activeTeamIdx);
      return true;
    }
    return false;
  }

  serialize() {
    return JSON.parse(JSON.stringify(this.state,(key,val)=>{
      if (val instanceof Set) return [...val];
      return val;
    }));
  }
}

// ============================================================
// BOT AI (updated for new mechanics)
// ============================================================
class BotController {
  constructor(room, botTeamIdxs) {
    this.room = room;
    this.botTeamIdxs = new Set(botTeamIdxs);
    this._scheduled = false;
  }

  tick() {
    if (this._scheduled) return;
    const s = this.room.engine?.state;
    if (!s) return;
    if (!this._isBotTurn(s)) return;
    this._scheduled = true;
    // Fast: 100–200ms delay
    setTimeout(()=>{ this._scheduled=false; this._step(); }, 100+Math.random()*100);
  }

  _isBotTurn(s) {
    if (s.phase==='CLASS_SELECTION') return s.classSetup && this.botTeamIdxs.has(s.classSetup.teamIdx);
    if (s.phase==='GLOBAL_MAP') return this.botTeamIdxs.has(s.activeTeamIdx);
    if (s.phase==='COMBAT') {
      const c=s.combat;
      if (!c||c.phase==='DONE') return false;
      if (c.phase==='ARRANGE') {
        return (this.botTeamIdxs.has(c.teamA.idx)&&!c.arrangeConfirmedA) ||
               (this.botTeamIdxs.has(c.teamB?.idx)&&!c.arrangeConfirmedB);
      }
      if (c.phase==='ACTIVE'&&c.turnQueue?.length) {
        const cur=c.turnQueue[c.currentTurnIdx];
        if (!cur) return false;
        const team=cur.side==='A'?c.teamA:c.teamB;
        return this.botTeamIdxs.has(team.idx);
      }
    }
    return false;
  }

  _step() {
    const room=this.room, e=room.engine;
    if (!e) return;
    const s=e.state;
    try {
      if (s.phase==='CLASS_SELECTION') this._doClassSelect(e,s,room);
      else if (s.phase==='GLOBAL_MAP') this._doMap(e,s,room);
      else if (s.phase==='COMBAT') this._doCombat(e,s,room);
    } catch(err){ console.error('[Bot]',err); }
  }

  _doClassSelect(e,s,room) {
    const ti=s.classSetup.teamIdx;
    if (!this.botTeamIdxs.has(ti)) return;
    // Pick balanced team
    const classes=['warrior','warrior','archer','mage'];
    const r=e.confirmClasses(classes,ti);
    if (!r.ok) return;
    room._broadcastState();
    if (e.state.phase==='CLASS_SELECTION') room._notifyClassSetup();
    else room._notifyActiveTurn();
    this.tick();
  }

  _doMap(e,s,room) {
    const ti=s.activeTeamIdx;
    if (!this.botTeamIdxs.has(ti)) return;

    // Handle pending item vote — always take for first alive player
    if (s.pendingItem&&s.pendingItem.teamIdx===ti) {
      const team=s.teams[ti];
      const firstAlive=team.players.find(p=>p.alive);
      if (firstAlive) {
        e.itemVote(ti,firstAlive.idx,String(firstAlive.idx));
        e.resolveItemVotes(true);
        room._broadcastState();
        room._notifyActiveTurn();
        this.tick();
      }
      return;
    }

    const moves=e.getValidSquadMoves(ti);
    if (!moves.length){ const r=e.endTurn(ti); if(r.ok){room._broadcastState();room._notifyActiveTurn();} this.tick(); return; }

    const map=s.map;
    const gc=map.grailCol,gr=map.grailRow;
    let best=null,bestScore=-Infinity;
    for (const m of moves) {
      let score=0;
      const cell=map.cells[`${m.col},${m.row}`];
      if (m.col===gc&&m.row===gr) score+=10000;
      if (cell?.item) score+=500;
      if (cell?.neutral&&!cell.neutral.defeated) score+=200;
      score -= Hex.distance(m.col,m.row,gc,gr)*2;
      score += Math.random()*3;
      if (score>bestScore){bestScore=score;best=m;}
    }

    const r=e.moveSquad(best.col,best.row,ti);
    room._broadcastState();

    if (e.state.phase==='COMBAT') {
      this.tick(); return;
    }
    if (e.state.pendingItem) { room._broadcastState(); this.tick(); return; }
    if (e.state.phase==='GLOBAL_MAP') {
      const r2=e.endTurn(ti);
      if (r2.ok){room._broadcastState();room._notifyActiveTurn();}
    }
    this.tick();
  }

  _doCombat(e,s,room) {
    const c=s.combat;
    if (!c) return;

    if (c.phase==='ARRANGE') {
      if (this.botTeamIdxs.has(c.teamA.idx)&&!c.arrangeConfirmedA) {
        e.confirmArrange(c.teamA.idx, null);
      }
      if (c.teamB&&this.botTeamIdxs.has(c.teamB.idx)&&!c.arrangeConfirmedB) {
        e.confirmArrange(c.teamB.idx, null);
      }
      // neutral auto-confirm
      if (c.isNeutral&&!c.arrangeConfirmedB) {
        c.arrangeConfirmedB=true;
        if (c.arrangeConfirmedA) e._startCombatRound?.(c)||this._startCombatRound(e,c);
      }
      room._broadcastState();
      this.tick();
      return;
    }

    if (c.phase==='DONE') {
      const r=e.dismissCombat();
      if (r.ok){room._broadcastState();room._notifyActiveTurn();}
      this.tick(); return;
    }

    if (c.phase==='ACTIVE'&&c.turnQueue?.length) {
      const cur=c.turnQueue[c.currentTurnIdx];
      if (!cur) return;
      const team=cur.side==='A'?c.teamA:c.teamB;
      if (!this.botTeamIdxs.has(team.idx)) return;
      e.combatAction(team.idx, null); // null = auto-pick target
      room._broadcastState();
      if (e.state.combat?.phase==='DONE') {
        setTimeout(()=>{
          const r2=e.dismissCombat();
          if (r2.ok){room._broadcastState();room._notifyActiveTurn();this.tick();}
        },150);
      } else {
        this.tick();
      }
    }
  }

  _startCombatRound(e,c) {
    // Fallback if private method not accessible
    c.phase='ACTIVE';
    const all=[
      ...c.fightersA.filter(f=>f.alive).map(f=>({...f,side:'A'})),
      ...c.fightersB.filter(f=>f.alive).map(f=>({...f,side:'B'})),
    ].sort((a,b)=>b.initiative-a.initiative);
    c.turnQueue=all; c.currentTurnIdx=0;
  }
}

// ============================================================
// ROOM
// ============================================================
const rooms = new Map();

function genCode() {
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({length:5},()=>chars[Math.floor(Math.random()*chars.length)]).join('');
}

class Room {
  constructor(code, config) {
    this.code=code; this.config=config;
    this.engine=null; this.started=false;
    this.clients=new Map();
    this.allClients=new Set();
    this.bots=null;
  }

  addClient(ws,teamIdx) {
    if (this.clients.has(teamIdx)) return false;
    this.clients.set(teamIdx,ws);
    this.allClients.add(ws);
    ws._teamIdx=teamIdx; ws._roomCode=this.code;
    return true;
  }

  removeClient(ws) {
    if (ws._teamIdx!=null) this.clients.delete(ws._teamIdx);
    this.allClients.delete(ws);
  }

  broadcast(msg) {
    const data=JSON.stringify(msg);
    for (const ws of this.allClients) if (ws.readyState===WebSocket.OPEN) ws.send(data);
  }

  send(teamIdx,msg) {
    const ws=this.clients.get(teamIdx);
    if (ws&&ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  canStart() { return this.clients.size>=this.config.numTeams&&!this.started; }

  startGame() {
    this.started=true;
    const seed=Date.now()&0xffff;
    this.engine=new GameEngine(this.config,seed);
    this.broadcast({type:'game_started'});
    this._broadcastState();
    this._notifyClassSetup();
    this._startTimer();
    if (this.bots) this.bots.tick();
  }

  startBotGame(ws) {
    this.config.numTeams=2;
    this.started=true;
    this.addClient(ws,0);
    send(ws,{type:'room_created',roomCode:this.code,teamIdx:0,config:this.config});
    send(ws,{type:'player_joined',teamIdx:1,totalJoined:2,needed:2});
    this.bots=new BotController(this,[1]);
    const seed=Date.now()&0xffff;
    this.engine=new GameEngine(this.config,seed);
    this.broadcast({type:'game_started'});
    this._broadcastState();
    this._notifyClassSetup();
    this._startTimer();
    this.bots.tick();
  }

  /** Start instant battle test: human=team0 with chosen classes, bot=team1 */
  startBattleTest(ws, humanClasses) {
    this.config.numTeams=2;
    this.started=true;
    this.addClient(ws,0);
    send(ws,{type:'room_created',roomCode:this.code,teamIdx:0,config:this.config});
    this.bots=new BotController(this,[1]);
    const seed=Date.now()&0xffff;
    this.engine=new GameEngine(this.config,seed);
    // Immediately set classes
    this.engine.confirmClasses(humanClasses,0);
    this.engine.confirmClasses(['warrior','warrior','archer','mage'],1);
    // Jump straight to combat between the two teams
    const s=this.engine.state;
    const teamA=s.teams[0], teamB=s.teams[1];
    s.phase='COMBAT';
    s.battleCount++;
    s.combat=this.engine._buildCombat(teamA,teamB);
    this.broadcast({type:'game_started'});
    this._broadcastState();
    this._notifyBattleArrange();
    this._startTimer();
    this.bots.tick();
  }

  _broadcastState() {
    this.broadcast({type:'state',state:this.engine.serialize()});
  }

  _notifyClassSetup() {
    const s=this.engine.state;
    if (s.phase!=='CLASS_SELECTION') return;
    const {teamIdx}=s.classSetup;
    this.send(teamIdx,{type:'your_class_turn',teamIdx});
    this.broadcast({type:'class_setup_turn',teamIdx});
  }

  _notifyActiveTurn() {
    const s=this.engine.state;
    if (s.phase!=='GLOBAL_MAP') return;
    const {activeTeamIdx:ti,activePlayerIdx:pi}=s;
    const moves=this.engine.getValidSquadMoves(ti);
    this.send(ti,{type:'your_turn',teamIdx:ti,playerIdx:pi,validMoves:moves});
    this.broadcast({type:'active_turn',teamIdx:ti,playerIdx:pi});
  }

  _notifyBattleArrange() {
    this.broadcast({type:'battle_arrange',arrangeTimeLeft:10});
  }

  _notifyCombatTurn() {
    const s=this.engine.state;
    const c=s.combat;
    if (!c||!c.turnQueue?.length) return;
    const cur=c.turnQueue[c.currentTurnIdx];
    if (!cur) return;
    const team=cur.side==='A'?c.teamA:c.teamB;
    this.send(team.idx,{type:'your_combat_turn',side:cur.side,fighterIdx:cur.player.idx});
    this.broadcast({type:'combat_turn',side:cur.side,teamIdx:team.idx,fighterIdx:cur.player.idx});
  }

  _startTimer() {
    if (this._timerInterval) clearInterval(this._timerInterval);
    this._timerInterval=setInterval(()=>{
      if (!this.engine) return;
      const s=this.engine.state;
      if (s.phase==='VICTORY'){clearInterval(this._timerInterval);return;}

      const changed=this.engine.tick(1);
      if (changed) {
        this._broadcastState();
        if (s.phase==='COMBAT'&&s.combat?.phase==='ACTIVE') this._notifyCombatTurn();
        else if (s.phase==='GLOBAL_MAP') this._notifyActiveTurn();
        if (this.bots) this.bots.tick();
      } else {
        const data=JSON.stringify({type:'timer',value:Math.ceil(s.turnTimeLeft||0)});
        for (const ws of this.allClients) if (ws.readyState===WebSocket.OPEN) ws.send(data);
        // Arrange countdown
        if (s.phase==='COMBAT'&&s.combat?.phase==='ARRANGE') {
          const arr=JSON.stringify({type:'arrange_timer',value:Math.ceil(s.combat.arrangeTimeLeft)});
          for (const ws of this.allClients) if (ws.readyState===WebSocket.OPEN) ws.send(arr);
        }
      }
    },1000);
  }

  handleMessage(ws,msg) {
    const teamIdx=ws._teamIdx;
    const e=this.engine;

    switch(msg.type) {
      case 'set_classes': {
        if (!e) return;
        const classes=(msg.classes||[]).map(c=>CLASS_IDS.includes(c)?c:'warrior');
        const r=e.confirmClasses(classes.slice(0,4).concat(['warrior','warrior','warrior','warrior']).slice(0,4),teamIdx);
        if (!r.ok) return send(ws,{type:'error',message:r.error||'Cannot set classes'});
        this._broadcastState();
        if (e.state.phase==='CLASS_SELECTION') this._notifyClassSetup();
        else this._notifyActiveTurn();
        if (this.bots) this.bots.tick();
        break;
      }

      case 'move': {
        if (!e) return;
        const r=e.moveSquad(msg.col,msg.row,teamIdx);
        if (!r.ok) return send(ws,{type:'error',message:r.error});
        this._broadcastState();
        if (e.state.phase==='COMBAT') {
          this._notifyBattleArrange();
          if (this.bots) this.bots.tick();
        } else if (e.state.pendingItem) {
          // notify team for item vote
          this.send(teamIdx,{type:'item_vote_start',item:e.state.pendingItem});
        } else if (e.state.phase==='GLOBAL_MAP') {
          this._notifyActiveTurn();
        }
        break;
      }

      case 'end_turn': {
        if (!e) return;
        const r=e.endTurn(teamIdx);
        if (!r.ok) return send(ws,{type:'error',message:r.error});
        this._broadcastState();
        this._notifyActiveTurn();
        if (this.bots) this.bots.tick();
        break;
      }

      case 'item_vote': {
        if (!e) return;
        e.itemVote(teamIdx,msg.playerIdx,msg.action,msg.targetPlayerIdx);
        // Check if all alive players voted
        const pi=e.state.pendingItem;
        if (pi) {
          const team=e.state.teams[teamIdx];
          const aliveCount=team.players.filter(p=>p.alive).length;
          if (Object.keys(pi.votes).length>=aliveCount) {
            e.resolveItemVotes(false);
            this._broadcastState();
            this._notifyActiveTurn();
          }
        }
        break;
      }

      case 'confirm_arrange': {
        if (!e) return;
        const r=e.confirmArrange(teamIdx,msg.arrangement||[]);
        if (!r.ok) return;
        this._broadcastState();
        if (e.state.combat?.phase==='ACTIVE') {
          this._notifyCombatTurn();
          if (this.bots) this.bots.tick();
        }
        break;
      }

      case 'combat_action': {
        if (!e) return;
        const r=e.combatAction(teamIdx,msg.targetPlayerIdx??null);
        if (!r.ok) return send(ws,{type:'error',message:r.error||'Not your turn'});
        this._broadcastState();
        if (e.state.combat?.phase==='DONE') {
          if (this.bots) setTimeout(()=>this.bots.tick(),200);
        } else if (e.state.combat?.phase==='ACTIVE') {
          this._notifyCombatTurn();
          if (this.bots) this.bots.tick();
        }
        break;
      }

      case 'combat_dismiss': {
        if (!e) return;
        const r=e.dismissCombat();
        if (!r.ok) return send(ws,{type:'error',message:'Combat not done'});
        this._broadcastState();
        this._notifyActiveTurn();
        if (this.bots) this.bots.tick();
        break;
      }

      case 'get_state': {
        if (!e) return;
        send(ws,{type:'state',state:e.serialize()});
        break;
      }
    }
  }
}

function send(ws,msg) {
  if (ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ============================================================
// HTTP + WS SERVER
// ============================================================
const httpServer = http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.url==='/health'){res.writeHead(200);res.end('ok');return;}
  if (req.url==='/rooms'&&req.method==='GET'){
    res.writeHead(200,{'Content-Type':'application/json'});
    res.end(JSON.stringify([...rooms.values()].map(r=>({
      code:r.code,teams:r.config.numTeams,players:r.clients.size,started:r.started,
    }))));
    return;
  }
  let urlPath=req.url.split('?')[0];
  if (urlPath==='/') urlPath='/index.html';
  const filePath=path.join(PUBLIC,urlPath);
  if (!filePath.startsWith(PUBLIC)){res.writeHead(403);res.end('Forbidden');return;}
  fs.readFile(filePath,(err,data)=>{
    if (err){res.writeHead(404);res.end('Not found');return;}
    res.writeHead(200,{'Content-Type':MIME[path.extname(filePath)]||'application/octet-stream'});
    res.end(data);
  });
});

const wss=new WebSocket.Server({server:httpServer});

wss.on('connection',(ws,req)=>{
  ws._visitorId=req.headers['x-visitor-id']||null;

  ws.on('message',raw=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}

    if (msg.type==='create_room') {
      const config={
        numTeams:Math.min(4,Math.max(2,parseInt(msg.numTeams)||3)),
        turnDuration:Math.min(60,Math.max(5,parseInt(msg.turnDuration)||15)),
        fogEnabled:msg.fogEnabled!==false,
      };
      let code; do{code=genCode();}while(rooms.has(code));
      const room=new Room(code,config);
      rooms.set(code,room);
      room.addClient(ws,0);
      send(ws,{type:'room_created',roomCode:code,teamIdx:0,config});
      setTimeout(()=>{if(!room.started&&room.clients.size===0)rooms.delete(code);},30*60*1000);
      return;
    }

    if (msg.type==='create_bot_game') {
      const config={
        numTeams:2,
        turnDuration:Math.min(60,Math.max(5,parseInt(msg.turnDuration)||15)),
        fogEnabled:msg.fogEnabled!==false,
      };
      let code; do{code=genCode();}while(rooms.has(code));
      const room=new Room(code,config);
      rooms.set(code,room);
      room.startBotGame(ws);
      setTimeout(()=>rooms.delete(code),2*60*60*1000);
      return;
    }

    if (msg.type==='create_battle_test') {
      const config={numTeams:2,turnDuration:30,fogEnabled:false};
      let code; do{code=genCode();}while(rooms.has(code));
      const room=new Room(code,config);
      rooms.set(code,room);
      const classes=(msg.classes||['warrior','archer','mage','support'])
        .map(c=>CLASS_IDS.includes(c)?c:'warrior');
      room.startBattleTest(ws,classes);
      setTimeout(()=>rooms.delete(code),2*60*60*1000);
      return;
    }

    if (msg.type==='join_room') {
      const room=rooms.get(msg.roomCode?.toUpperCase());
      if (!room) return send(ws,{type:'error',message:'Комната не найдена'});
      if (room.started) return send(ws,{type:'error',message:'Игра уже началась'});
      let slot=null;
      for (let i=0;i<room.config.numTeams;i++){if(!room.clients.has(i)){slot=i;break;}}
      if (slot===null) return send(ws,{type:'error',message:'Комната заполнена'});
      room.addClient(ws,slot);
      send(ws,{type:'joined',teamIdx:slot,roomCode:room.code,config:room.config});
      room.broadcast({type:'player_joined',teamIdx:slot,totalJoined:room.clients.size,needed:room.config.numTeams});
      if (room.canStart()) room.startGame();
      return;
    }

    if (ws._roomCode) {
      const room=rooms.get(ws._roomCode);
      if (room) room.handleMessage(ws,msg);
    }
  });

  ws.on('close',()=>{
    if (ws._roomCode){
      const room=rooms.get(ws._roomCode);
      if (room){
        room.removeClient(ws);
        if (room.allClients.size===0){
          if (room._timerInterval) clearInterval(room._timerInterval);
          rooms.delete(ws._roomCode);
        } else {
          room.broadcast({type:'player_left',teamIdx:ws._teamIdx});
        }
      }
    }
  });

  ws.on('error',()=>{});

  ws._pingInterval=setInterval(()=>{
    if (ws.readyState===WebSocket.OPEN) ws.ping();
    else clearInterval(ws._pingInterval);
  },25000);
});

httpServer.listen(PORT,'0.0.0.0',()=>{
  console.log(`Graal Hunt WS server listening on port ${PORT}`);
});
