import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
// Importing must not start HTTP/WS listeners or leave timers running.
const { GameEngine, Hex, generateMap } = require('../../server.js');
const classes = ['warrior', 'archer', 'mage', 'support'];
const createEngine = () =>
  new GameEngine({ numTeams: 2, turnDuration: 15, fogEnabled: true }, 42);
const startEngine = () => {
  const engine = createEngine();
  engine.confirmClasses(classes, 0);
  engine.confirmClasses(classes, 1);
  return engine;
};

// Set up a small controlled neighborhood, independently of random terrain/events.
function movementFixture() {
  const engine = startEngine();
  const team = engine.state.teams[0];
  const neighbors = Hex.neighbors(team.col, team.row);
  for (const [col, row] of neighbors) {
    Object.assign(engine.state.map.cells[`${col},${row}`], {
      terrain: 'plains',
      item: null,
      neutral: null,
    });
  }
  return { engine, team, neighbors };
}

describe('hex geometry', () => {
  it.each([0, 1, 8, 9])('has six unique adjacent cells in row %i', (row) => {
    const neighbors = Hex.neighbors(10, row);
    expect(new Set(neighbors.map(String)).size).toBe(6);
    for (const [col, r] of neighbors) {
      expect(Hex.distance(10, row, col, r)).toBe(1);
      expect(Hex.neighbors(col, r)).toContainEqual([10, row]);
    }
  });
});

describe('map generation', () => {
  it.each([
    [2, 40],
    [3, 60],
    [4, 80],
  ])('generates the %i-team map', (teams, size) => {
    const map = generateMap(teams, 42);
    expect(map.size).toBe(size);
    expect(Object.keys(map.cells)).toHaveLength(size * size);
    expect(map.cells[`${map.grailCol},${map.grailRow}`].terrain).toBe(
      'grailzone',
    );
    for (const cell of Object.values(map.cells)) {
      if (cell.item || cell.neutral) expect(cell.terrain).not.toBe('water');
      if (cell.neutral) expect(cell.item).toBeNull();
    }
  });

  it('repeats a seed independently of intervening generation', () => {
    const first = generateMap(2, 42);
    generateMap(3, 99);
    expect(generateMap(2, 42)).toEqual(first);
    expect(generateMap(2, 43)).not.toEqual(first);
  });
});

describe('class selection and turns', () => {
  it('rejects class selection by the wrong team without changing state', () => {
    const engine = createEngine();
    const before = engine.serialize();
    expect(engine.confirmClasses(classes, 1).ok).toBe(false);
    expect(engine.serialize()).toEqual(before);
  });

  it('starts the map only after both teams confirm and preserves class stats', () => {
    const engine = createEngine();
    expect(engine.confirmClasses(classes, 0).ok).toBe(true);
    expect(engine.state.phase).toBe('CLASS_SELECTION');
    expect(engine.state.classSetup.teamIdx).toBe(1);
    expect(engine.confirmClasses(classes, 1).ok).toBe(true);
    expect(engine.state.phase).toBe('GLOBAL_MAP');
    expect(engine.state.classSetup).toBeNull();
    expect(
      engine.state.teams[0].players.map((p) => [p.classId, p.hp, p.baseAtk]),
    ).toEqual([
      ['warrior', 14, 5],
      ['archer', 9, 6],
      ['mage', 7, 4],
      ['support', 9, 3],
    ]);
  });

  it('advances to the next team after all four player turns', () => {
    const engine = startEngine();
    expect(engine.endTurn(1).ok).toBe(false);
    for (let i = 0; i < 4; i++) expect(engine.endTurn(0).ok).toBe(true);
    expect(engine.state.activeTeamIdx).toBe(1);
    expect(engine.state.activePlayerIdx).toBe(0);
    expect(engine.state.turnTimeLeft).toBe(15);
  });

  it('advances on timeout but pauses the map timer during item voting', () => {
    const engine = startEngine();
    expect(engine.tick(14)).toBe(false);
    expect(engine.state.turnTimeLeft).toBe(1);
    expect(engine.tick(1)).toBe(true);
    expect(engine.state.activePlayerIdx).toBe(1);
    engine.state.pendingItem = { teamIdx: 0 };
    expect(engine.tick(15)).toBe(false);
    expect(engine.state.turnTimeLeft).toBe(15);
  });
});

describe('squad movement and items', () => {
  it('rejects a nonadjacent move without mutating state', () => {
    const { engine } = movementFixture();
    const before = engine.serialize();
    expect(engine.moveSquad(0, 0, 0).ok).toBe(false);
    expect(engine.serialize()).toEqual(before);
  });

  it.each([
    ['water', 'boat'],
    ['mountain', 'rope'],
  ])('requires %s traversal equipment', (terrain, item) => {
    const { engine, team, neighbors } = movementFixture();
    const [col, row] = neighbors[0];
    engine.state.map.cells[`${col},${row}`].terrain = terrain;
    expect(engine.getValidSquadMoves(0)).not.toContainEqual({ col, row });
    team.players[2].items.push(item);
    expect(engine.getValidSquadMoves(0)).toContainEqual({ col, row });
    expect(engine.moveSquad(col, row, 0).ok).toBe(true);
    expect(team.players.every((p) => p.col === col && p.row === row)).toBe(
      true,
    );
    expect(team.fogReveal.has(`${col},${row}`)).toBe(true);
  });

  it('assigns a voted item and removes it from the map', () => {
    const { engine, team, neighbors } = movementFixture();
    const [col, row] = neighbors[0];
    engine.state.map.cells[`${col},${row}`].item = 'sword';
    expect(engine.moveSquad(col, row, 0)).toEqual({ ok: true, event: 'item' });
    expect(engine.itemVote(1, 0, 'give', 2).ok).toBe(false);
    engine.itemVote(0, 0, 'give', 2);
    engine.itemVote(0, 1, 'give', 2);
    expect(engine.resolveItemVotes(false).ok).toBe(true);
    expect(team.players[2].items).toContain('sword');
    expect(engine.state.map.cells[`${col},${row}`].item).toBeNull();
    expect(engine.state.pendingItem).toBeNull();
  });

  it('captures the grail and serializes fog without exposing mutable state', () => {
    const { engine, team, neighbors } = movementFixture();
    const [col, row] = neighbors[0];
    engine.state.map.grailCol = col;
    engine.state.map.grailRow = row;
    expect(engine.moveSquad(col, row, 0)).toEqual({
      ok: true,
      event: 'victory',
    });
    expect(engine.state.phase).toBe('VICTORY');
    expect(engine.state.winner.idx).toBe(team.idx);
    const serialized = engine.serialize();
    expect(Array.isArray(serialized.teams[0].fogReveal)).toBe(true);
    serialized.teams[0].players[0].hp = 0;
    expect(team.players[0].hp).toBe(14);
  });
});

describe('combat setup and progression', () => {
  it('applies equipment bonuses and starts combat in initiative order', () => {
    const engine = startEngine();
    const [teamA, teamB] = engine.state.teams;
    teamA.players[0].items = ['sword', 'shield'];
    engine._triggerCombat(teamA, teamB);
    const combat = engine.state.combat;
    expect(combat.phase).toBe('ARRANGE');
    const warrior = combat.fightersA.find((f) => f.player.idx === 0);
    expect(warrior).toMatchObject({ atk: 8, hp: 17, maxHp: 17, row: 'front' });
    expect(engine.combatAction(0, 0).ok).toBe(false);
    engine.confirmArrange(0, []);
    expect(combat.phase).toBe('ARRANGE');
    engine.confirmArrange(1, []);
    expect(combat.phase).toBe('ACTIVE');
    expect(combat.turnQueue[0]).toMatchObject({
      classId: 'archer',
      initiative: 10,
    });
    const initiatives = combat.turnQueue.map((f) => f.initiative);
    expect(initiatives).toEqual([...initiatives].sort((a, b) => b - a));
    const before = engine.serialize();
    expect(engine.combatAction(1, 0).ok).toBe(false);
    expect(engine.serialize()).toEqual(before);
    expect(engine.combatAction(0, 0).ok).toBe(true);
    expect(combat.fightersB.find((f) => f.player.idx === 0).hp).toBeLessThan(
      14,
    );
  });

  it('auto-confirms arrangement on timeout', () => {
    const engine = startEngine();
    engine._triggerCombat(...engine.state.teams);
    expect(engine.tick(9)).toBe(false);
    expect(engine.state.combat.phase).toBe('ARRANGE');
    expect(engine.tick(1)).toBe(true);
    expect(engine.state.combat.phase).toBe('ACTIVE');
  });

  it('levels up at XP thresholds and caps the level', () => {
    const engine = startEngine();
    const player = engine.state.teams[0].players[0];
    engine._grantXP(player, 29);
    expect(player.level).toBe(1);
    engine._grantXP(player, 1);
    expect(player).toMatchObject({ level: 2, xp: 30, hp: 16, maxHp: 16 });
    engine._grantXP(player, 10000);
    expect(player.level).toBe(10);
    expect(player.maxHp).toBe(32);
  });
});
