# Agent eval — baseline v1.72.0 (23 tasks)

The gate number for the 2.0 lanes: **18.65 / 23**. It is the sum of the per-task means over 10 full runs of the unchanged v1.72.0 build. It replaces 10.00 / 15 (v1.68.0, below).

**Gate rule.** A candidate run of 5 must pass two tests:
- Its total mean must not be lower than 18.65.
- No task's mean may be lower than the baseline mean by more than twice that task's spread. The spread is the sd over the 10 baseline runs.

Floor: a task with spread 0 may drop by one run in five (0.20) before it counts as down. Without the floor, a single bad agent run on any always-passing task would fail the gate (see QUESTIONS Q5 of lane 2.0-eval2).

What was run (lane 2.0-eval2, 2026-11-22):
- Two arms, A and B, each 5 × `node eval/results.mjs --runs 1 --label armX-rN --catalog-dir <catalog-v172>`, interleaved A1 B1 A2 B2 …, on one Deck local slot (software GL, 2-5 fps).
- Model sonnet, max 60 turns. Catalog synced from the v1.72.0 core (39 tools). The harness was this branch.
- The two arms are the noise measurement. Together they are the baseline.

Score: 1 works for both people · 0.5 works for one person only, or only after a reload · 0 does not work.

| task | A mean | B mean | \|A-B\| | spread (sd) | baseline mean | runs |
|---|---|---|---|---|---|---|
| door-near | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| star-once | 0.80 | 0.80 | 0.00 | 0.42 | 0.80 | 10 |
| win-five | 0.60 | 0.40 | 0.20 | 0.53 | 0.50 | 10 |
| score-round | 0.80 | 1.00 | 0.20 | 0.32 | 0.90 | 10 |
| round-timer | 0.00 | 0.00 | 0.00 | 0.00 | 0.00 | 10 |
| pause-p | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| best-time | 1.00 | 0.80 | 0.20 | 0.32 | 0.90 | 10 |
| pickup-own | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| toggle-shared | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| platform-loop | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| countdown | 0.80 | 0.80 | 0.00 | 0.35 | 0.80 | 10 |
| hit-sound | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| health-respawn | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| checkpoint | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| late-joiner | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| key-door | 0.60 | 0.60 | 0.00 | 0.52 | 0.60 | 10 |
| lap-counter * | 0.60 | 0.80 | 0.20 | 0.48 | 0.70 | 10 |
| spawner-cap | 0.40 | 0.50 | 0.10 | 0.37 | 0.45 | 10 |
| team-score | 0.50 | 0.50 | 0.00 | 0.00 | 0.50 | 10 |
| dialogue-own | 0.50 | 0.50 | 0.00 | 0.00 | 0.50 | 10 |
| inventory-respawn | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| day-night | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| two-plates | 1.00 | 1.00 | 0.00 | 0.00 | 1.00 | 10 |
| **total** | **18.60** | **18.70** | 0.10 | | **18.65** / 23 | |

**Noise.** No task's arm means differ by more than 0.20. Four tasks sit exactly at 0.20: win-five, score-round, best-time and lap-counter.

**lap-counter (\*).** The first arms measured lap-counter at 0.40 apart. The cause was the harness: a 5 m/s lap moved 2.5 m per frame and stepped over the agents' own halfway checkpoint. Its row above is the 5+5 rerun with both laps at 2 m/s.

The check in this branch goes one step further. Lap 1's corner stop lasts as long as the walk, so lap 1 is about twice lap 2. The lap-2 best must also sit nearer lap 2 than lap 1. That check is verified: control 1, empty start scene 0, one agent run 1. Its own 5+5 rerun was stopped by memory pressure on the Deck and is owed. Rerun it before the first gate that leans on this row.

**Rows held down by the app, not the agent:**
- **round-timer 0.00.** Every agent builds an autostart HUD Timer. It counts from the editor, not from the round, so it is 15-25 s off the round start. A control wired `kit-round-started -> hudtimer.start` scores 1.
- **team-score 0.50.** There is no per-person output for behaviour state, so "show each person their team" cannot be built. The best possible score, the hand-built control, is also 0.5.
- **dialogue-own 0.50.** Agents use `onenter -> hudscreen`, which shows for everyone. The per-peer form, `proximity {to: "player"} -> visibility`, scores 1 as a control.

**Cost.** 2.38 USD and 44 min per full 23-task run, the mean of 10 (Deck local slot). The lane's whole eval spend was 25.4 USD.

**What changed in the harness** (so 1.68 numbers do not compare):
- The late joiner waits for its own LOAD through `__tp.test.v1`, not a fixed 12 s. The old check scored a correct build 0/5 at 2-4 fps; the new one scores it 10/10.
- round-timer is judged against the round-start event the scene emits.
- Every fixed sleep and wall-clock floor in the other checks is scaled by the measured frame time (`P.loadScale`).
- There are 8 new tasks: key-door, lap-counter, spawner-cap, team-score, dialogue-own, inventory-respawn, day-night and two-plates. Their controls are in `controls-eval2.json`; run them with `npm run eval:controls2`, which leaves out team-score at 0.5.

---

# Previous baseline — v1.68.0 (15 tasks, old harness)

The gate number for roadmap 2.0 N3b and N3c: **10.00 / 15** (3 runs, totals 9 · 10 · 11, so the spread is 2 points).

What was run: `node eval/results.mjs --runs 3 --label baseline-v1.68.0`

- Model: sonnet, max 60 turns.
- Catalog: cloud origin/main a306d28368, 39 tools.
- App: v1.68.0 plus eval-only commits, Deck local slot (software GL, 2-5 fps).
- Started 2026-11-20 02:38 UTC.

Score: 1 works for both people · 0.5 works for one person only, or only after a reload · 0 does not work.

The run's own table (from `table.md`):

| task           | r1  | r2  | r3  | mean | calls (mean) | refused | agent s (mean) | tokens (mean) | form                                         |
| -------------- | --- | --- | --- | ---- | ------------ | ------- | -------------- | ------------- | -------------------------------------------- |
| door-near      | 1   | 0   | 1   | 0.67 | 10           | 1       | 31             | 498098        | node text                                    |
| star-once      | 0   | 0   | 0   | 0.00 | 13           | 0       | 30             | 510656        | node text                                    |
| win-five       | 1   | 0   | 1   | 0.67 | 19           | 0       | 66             | 863830        | node text, behaviour                         |
| score-round    | 0   | 1   | 1   | 0.67 | 10           | 0       | 25             | 442671        | hud, node text, behaviour, nodes             |
| round-timer    | 1   | 1   | 1   | 1.00 | 5            | 0       | 14             | 241567        | hud, nodes                                   |
| pause-p        | 0   | 0   | 0   | 0.00 | 8            | 0       | 24             | 452670        | node text                                    |
| best-time      | 0   | 1   | 1   | 0.67 | 18           | 1       | 44             | 697480        | hud, node text, game_setup                   |
| pickup-own     | 0   | 0   | 1   | 0.33 | 13           | 0       | 30             | 648470        | nodes, hud, node text                        |
| toggle-shared  | 1   | 1   | 1   | 1.00 | 10           | 0       | 28             | 461597        | behaviour, nodes, node text                  |
| platform-loop  | 1   | 1   | 1   | 1.00 | 2            | 0       | 8              | 202756        | nodes                                        |
| countdown      | 1   | 1   | 1   | 1.00 | 12           | 0       | 34             | 549203        | hud, nodes, behaviour                        |
| hit-sound      | 1   | 1   | 1   | 1.00 | 15           | 0       | 59             | 586929        | behaviour, nodes, node text                  |
| health-respawn | 0   | 1   | 0   | 0.33 | 20           | 1       | 56             | 833640        | hud, behaviour, nodes, node text, game_setup |
| checkpoint     | 1   | 1   | 1   | 1.00 | 14           | 1       | 30             | 524166        | game_setup, node text                        |
| late-joiner    | 1   | 1   | 0   | 0.67 | 18           | 0       | 54             | 720869        | behaviour, node text, nodes                  |

**Total** per run: r1 9 · r2 10 · r3 11 of 15 → mean **10.00 / 15**, spread 9-11 (2.0 points).
Tokens per full run (15 tasks, mean of 3): total 8,234,600 (input 272, cache write 132,124, cache read 8,068,419, output 33,786); uncached (input + cache write + output) 166,182; cost reported 1.67 USD.

## Why each zero happened

The zeros for star-once, pause-p, pickup-own, health-respawn and late-joiner were read against their calls logs. Each is a real agent or app failure, not a check artefact. For the other four rows, only what the check saw is given; those builds were not re-read. The same checks were vetted on validate2 and on the hand-built controls.

| task           | runs at 0 | what the agent built, and why it fails                                                                                                                                                                                                                                                                                                     |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| star-once      | r1 r2 r3  | All three wrote `latch {perRound: true}`. **App bug:** `create_flow_nodes` drops any param that has no default (`src/lib/ai/flowTools.js:351`, and the same rule in `update_flow_nodes`). So perRound arrives as false, and the stars stay lit into the next round. A hand-built control with `kit-round-started -> latch.reset` scores 1. |
| pause-p        | r1 r2 r3  | r1/r2: `keypress P -> latch.toggle -> setgamestate paused`, then `NOT -> setgamestate playing`. P pauses, but pressing P again never resumes the game. Cause not traced. r3: P never paused.                                                                                                                                               |
| pickup-own     | r1 r2     | The toucher's count rises, but the coin stays visible for everyone. Kit `collect` does not hide a pickup; it has to be wired `kit-pickups-available -> visibility`.                                                                                                                                                                        |
| health-respawn | r1 r3     | Health never drops. r1 hit the rule that edges must stay in one graph, so the agent moved the sensor's enter/exit into the scene graph as `objectselector -> onenter.filter`. That never fires for the player. The same behaviour fed by `onenter` in the sensor's own graph works (control).                                              |
| door-near      | r2        | What the check saw: the door did not open at 1.5 m.                                                                                                                                                                                                                                                                                        |
| win-five       | r2        | What the check saw: no win after all five stars were lit.                                                                                                                                                                                                                                                                                  |
| score-round    | r1        | What the check saw: the score did not go back to zero in the new round.                                                                                                                                                                                                                                                                    |
| best-time      | r1        | What the check saw: the best time was gone after a reload (`Best: 0.00 s`).                                                                                                                                                                                                                                                                |
| late-joiner    | r3        | The joiner sees all three lanterns lit, including the one nobody clicked. Hidden glow spheres are driven by behaviour outputs, and they show before the joiner has the state.                                                                                                                                                              |

**The three weakest tasks:**

1. star-once (0.00)
2. pause-p (0.00)
3. pickup-own and health-respawn, tied at 0.33

## Cost

One full run (15 tasks, mean of 3):

- 8.23 M tokens in all, of which 8.07 M are cache reads.
- **166 k uncached** (input + cache write + output).
- 1.67 USD reported.

That is well under the ~2 M uncached stop line.

## Re-scoring and controls

- `--replay test-results/2.0-n3a/eval/baseline-v1.68.0` re-scores these builds with no model.
- `npm run eval:smoke` runs the hand-built controls and must score 1 on all five.
