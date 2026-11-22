# sokoban-solver-01 entry: push-optimal room-by-room solver

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/pengpengliu1212-art/sokoban-solver-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/pengpengliu1212-art/sokoban-solver-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

SPDX-License-Identifier: MIT

Entry for make.fun's [`sokoban-solver-01-run-20261121`](https://make.fun/bounty/sokoban-solver-01-run-20261121) bounty. One run answers the set's five instances: each `/input/<id>/level.txt` (XSB) in, `/output/<id>/solution.txt`
out, the moves in lower LURD. Run: `node main.ts` (Node 22; `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` stand in
for `/input` and `/output` outside the sandbox).

## How it works

The generator's levels are a one-square-wide hallway plus one to four rooms, each opening through one door and
holding 3 or 4 boxes with as many goals; a box pushed into the hallway can never come back. So the level's push
optimum is the sum of its rooms' optima, and the solver works room by room:

- Cut the dead squares (from which a lone box reaches no goal) of the player's row out of the floor; each part
  that holds boxes is a room.
- Solve each room by a breadth-first search over pushes: a state is the boxes' squares and the player's
  reachable region (named by its lowest square); states expand in order of pushes made, so the first solved
  state met is push-optimal. Two deadlocks are pruned — a dead square, and a frozen 2x2 block of walls and
  boxes holding a box off its goal; neither prunes a solvable state, so the optimum stands.
- Compose the level room by room over a few orders: each room searched on the board with the other rooms'
  boxes standing as walls where they stand now, the player walking on from where the last room left it (walking
  is free; only pushes count). The composed moves are replayed on the level before they are written.
- Behind the decomposition stands a whole-level push search as a fallback; if everything gives up, an empty
  answer is written, which is still valid.

## Determinism and budget

Pure: no clock, no randomness; ties go by square order, so two executions write the same bytes. All budgets are
work (state counts), never the wall clock. Every level is answered even when its search gives up, so the run
always completes well inside the 60-second wall for the whole set.
