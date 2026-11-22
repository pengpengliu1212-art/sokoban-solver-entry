// SPDX-License-Identifier: MIT
// sokoban-solver-01 entry: a push-optimal solver built around the make.fun generator's level shape.
//
// The generator lays a one-square-wide hallway across the board (where the player starts) and one to four rooms off
// it, each opening through one door and holding 3 or 4 boxes with as many goals. A box pushed into the hallway can
// never come back (the square a player would need to stand on is wall), so every box stays in its room and the
// level's push optimum is the sum of its rooms' optima.
//
// The solver cuts the dead squares (from which a lone box reaches no goal) of the player's row out of the floor;
// each part that holds boxes is a room. Each room is solved on its own by a breadth-first search over pushes: a
// state is the boxes' squares and the player's reachable region (named by its lowest square), states are expanded in
// order of pushes made, so the first solved state met is push-optimal. Two deadlocks a box can never leave are
// pruned: a dead square, and a frozen 2x2 block of walls and boxes holding a box off its goal. Neither prunes a
// solvable state, so the optimum stands. All optimal solutions of a room are kept (up to a cap); composing the level
// picks, room by room over a few orders, solutions that leave the player a way out through the hallway, so the next
// room stays reachable. The composed moves are replayed on the level before they are written, and a whole-level
// search stands behind the room decomposition as a fallback. Pure: no clock, no randomness; ties go by square order,
// so two executions write the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one room search keeps before it gives up: work, never the clock. */
const ROOM_STATES = 250_000;
/** The most states the whole-level fallback search keeps. */
const WHOLE_STATES = 800_000;
/** A level in XSB text: its width, walls (short rows and the outermost frame padded as walls), goals, boxes and player. */
function parseLevel(text) {
  const rows = text.split('\n').map((r) => r.replace(/\r$/, '')).filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const wall = new Uint8Array(size).fill(1);
  const goals = [];
  const boxes = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level) {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [];
  for (const g of goals) { live[g] = 1; queue.push(g); }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi];
    for (const d of [-w, w, -1, 1]) {
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) { live[y] = 1; queue.push(y); }
    }
  }
  return live;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box among them off its goal. */
function frozenBlock(wall, occupied, goal, t, w) {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** A region maker over `wall`: at(occupied, from) marks the player's reachable squares in `arr` with a fresh stamp
 * and returns { stamp, low } (the region's lowest square names it). */
function makeRegion(wall, w) {
  const arr = new Int32Array(wall.length);
  const stack = new Int32Array(wall.length);
  let stamp = 0;
  const at = (occupied, from) => {
    const s = ++stamp;
    let low = from;
    let n = 0;
    stack[n++] = from;
    arr[from] = s;
    while (n > 0) {
      const p = stack[--n];
      if (p < low) low = p;
      for (let k = 0; k < 4; k++) {
        const q = k === 0 ? p - w : k === 1 ? p + w : k === 2 ? p - 1 : p + 1;
        if (wall[q] === 0 && occupied[q] === 0 && arr[q] !== s) {
          arr[q] = s;
          stack[n++] = q;
        }
      }
    }
    return { stamp: s, low };
  };
  return { at, arr };
}

/**
 * The push-optimal search over `level`: states in order of pushes made, each state the boxes' squares and the
 * player's region, so the first solved state met is push-optimal. Returns { pushes, boxesArr, playerArr, chain }
 * (the state path of the solution), or null when the search gives up (or the level has no solution).
 */
function solvePushOptimal(level, maxStates) {
  const { w, wall, goals, boxes: initBoxes, player: initPlayer } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  if (initBoxes.some((b) => !live[b])) return null;
  const isSolved = (bs) => bs.every((b) => goal[b] === 1);

  // Two makers: one names each expanded state's region, the other each child's.
  const region = makeRegion(wall, w);
  const childRegion = makeRegion(wall, w);
  const occupied = new Uint8Array(wall.length);
  for (const b of initBoxes) occupied[b] = 1;
  const root = region.at(occupied, initPlayer);

  const boxesArr = [initBoxes];
  const playerArr = [initPlayer];
  const parentArr = [-1];
  const index = new Map([[root.low + '|' + initBoxes.join(','), 0]]);
  let found = -1;
  if (isSolved(initBoxes)) return { pushes: 0, boxesArr, playerArr, chain: [] };

  const setOccupied = (bs, v) => { for (const b of bs) occupied[b] = v; };

  for (let head = 0; head < boxesArr.length && found < 0; head++) {
    const bs = boxesArr[head];
    setOccupied(bs, 1);
    const here = region.at(occupied, playerArr[head]);
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi];
      for (const d of [-w, w, -1, 1]) {
        const t = b + d;
        if (region.arr[b - d] !== here.stamp || wall[t] === 1 || occupied[t] === 1 || live[t] === 0) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        let next = null;
        let key = null;
        if (!frozenBlock(wall, occupied, goal, t, w)) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = childRegion.at(occupied, b).low + '|' + next.join(',');
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (next === null || index.has(key)) continue;
        if (boxesArr.length >= maxStates) { setOccupied(bs, 0); return null; }
        index.set(key, boxesArr.length);
        boxesArr.push(next);
        playerArr.push(b);
        parentArr.push(head);
        if (isSolved(next)) { found = boxesArr.length - 1; break; }
      }
    }
    setOccupied(bs, 0);
  }
  if (found < 0) return null;
  const chain = [];
  for (let s = found; s > 0; s = parentArr[s]) chain.push(s);
  chain.reverse();
  return { pushes: chain.length, boxesArr, playerArr, chain };
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (the first direction first on ties). */
function walkTo(wall, w, occupied, from, to) {
  if (from === to) return '';
  const size = wall.length;
  const prev = new Int32Array(size).fill(-1);
  const how = new Array(size);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi];
    if (p === to) break;
    for (let k = 0; k < 4; k++) {
      const d = k === 0 ? -w : k === 1 ? w : k === 2 ? -1 : 1;
      const letter = k === 0 ? 'u' : k === 1 ? 'd' : k === 2 ? 'l' : 'r';
      const q = p + d;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let p = to; p !== from; p = prev[p]) s = how[p] + s;
  return s;
}

/** A replay of `moves` on `level`: whether every step is legal and every box ends on a goal, and the pushes made. */
function replay(level, moves) {
  const { w, wall, goals, boxes, player: start } = level;
  const goal = new Uint8Array(wall.length);
  for (const g of goals) goal[g] = 1;
  const box = new Uint8Array(wall.length);
  for (const b of boxes) box[b] = 1;
  let p = start;
  let pushes = 0;
  for (const ch of moves) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
    const next = p + d;
    if (wall[next]) return { legal: false, solved: false, pushes };
    if (box[next]) {
      const beyond = next + d;
      if (wall[beyond] || box[beyond]) return { legal: false, solved: false, pushes };
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    p = next;
  }
  for (let i = 0; i < box.length; i++) if (box[i] && !goal[i]) return { legal: true, solved: false, pushes };
  return { legal: true, solved: true, pushes };
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway) out of the floor, and each part left
 * that holds a box is a room. Null when the level is no set of rooms: a box in the hallway, a goal off every room,
 * or a part whose boxes and goals disagree.
 */
function roomsOf(level) {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const d of [-w, w, -1, 1]) {
        const q = squares[i] + d;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]].boxes.push(b);
  if (goals.some((g) => part[g] < 0)) return null;
  for (const g of goals) rooms[part[g]].goals.push(g);
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  const kept = rooms.filter((r) => r.boxes.length > 0);
  if (kept.length === 0) return null;
  return kept;
}


/** The moves of one room's chain, walked from `startPlayer` on the sub-level the search ran on. */
function materialize(sub, search, chain, startPlayer) {
  const { w, wall } = sub;
  let player = startPlayer;
  let boxes = search.boxesArr[0];
  let moves = '';
  const occupied = new Uint8Array(wall.length);
  for (const s of chain) {
    const nextBoxes = search.boxesArr[s];
    let from = -1;
    let to = -1;
    for (const b of boxes) if (!nextBoxes.includes(b)) { from = b; break; }
    for (const c of nextBoxes) if (!boxes.includes(c)) { to = c; break; }
    const d = to - from;
    for (const b of boxes) occupied[b] = 1;
    const walk = walkTo(wall, w, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    if (walk === null) return null;
    moves += walk;
    moves += d === -w ? 'u' : d === w ? 'd' : d === -1 ? 'l' : 'r';
    player = from;
    boxes = nextBoxes;
  }
  return { moves, player };
}

/** Every order of n rooms, the search's own order first, its reverse second, then the rest lexicographically. */
function allOrders(n) {
  const rest = [];
  const perm = (prefix, left) => {
    if (left.length === 0) { rest.push(prefix); return; }
    for (let i = 0; i < left.length; i++) perm(prefix.concat(left[i]), left.slice(0, i).concat(left.slice(i + 1)));
  };
  perm([], Array.from({ length: n }, (_, i) => i));
  const first = Array.from({ length: n }, (_, i) => i);
  const orders = [first, first.slice().reverse()];
  const seen = new Set([first.join(), first.slice().reverse().join()]);
  for (const o of rest) if (!seen.has(o.join())) { seen.add(o.join()); orders.push(o); }
  return orders;
}

/** One order of rooms solved in turn: each room searched on the board with the other rooms' boxes standing as
 * walls where they stand now (a solved room's boxes sit on its goals), the player walking on from where the last
 * room left it. The composed moves, or null when a room's search fails or the replay breaks. */
function attemptOrder(level, rooms, order) {
  const w = level.w;
  const h = level.h;
  let player = level.player;
  let moves = '';
  const where = rooms.map((room) => room.boxes.slice().sort((a, b) => a - b));
  for (const k of order) {
    const wall = level.wall.slice();
    for (let j = 0; j < rooms.length; j++) {
      if (j === k) continue;
      for (const b of where[j]) wall[b] = 1;
    }
    const sub = { w, h, wall, goals: rooms[k].goals.slice().sort((a, b) => a - b), boxes: where[k], player };
    const search = solvePushOptimal(sub, ROOM_STATES);
    if (search === null) return null;
    const r = materialize(sub, search, search.chain, player);
    if (r === null) return null;
    moves += r.moves;
    player = r.player;
    where[k] = search.chain.length > 0
      ? search.boxesArr[search.chain[search.chain.length - 1]]
      : where[k];
  }
  const rep = replay(level, moves);
  return rep.legal && rep.solved ? { moves, pushes: rep.pushes } : null;
}

/** The level solved room by room over a few orders of the rooms, the composed moves replayed for safety. Null when
 * no order composes. */
function solveByRooms(level) {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  for (const order of allOrders(rooms.length)) {
    const done = attemptOrder(level, rooms, order);
    if (done !== null) return done;
  }
  return null;
}

/** The level's answer: the room-by-room solution, the whole-level search behind it, or an empty answer. */
function solve(text) {
  const level = parseLevel(text);
  if (level.boxes.length === 0 || level.player < 0) return '';
  const byRooms = solveByRooms(level);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePushOptimal(level, WHOLE_STATES);
  if (whole !== null) {
    const r = materialize(level, whole, whole.chain, level.player);
    if (r !== null) {
      const rep = replay(level, r.moves);
      if (rep.legal && rep.solved) return r.moves;
    }
  }
  return '';
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  let moves = '';
  try {
    moves = solve(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  } catch {
    moves = '';   // An unparseable level still deserves an answer in the stated format.
  }
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
