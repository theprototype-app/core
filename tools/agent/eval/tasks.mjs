// Roadmap 2.0 N3a — THE 15 TASKS. Each one is what real scenes do (cloud roadmap-2.0 § Revision 4: the scenes-repo
// scan): a spoken-style request, a start scene (built through the connector's own tools before the agent starts)
// and a CHECK that plays the result as a person would (player.mjs) and scores it:
//
//   1   works
//   0.5 works for one person only (a sync task) / works only after a reload (results.mjs retries a failed
//       single-player check once after reloading the tab)
//   0   does not work
//
// A check reads OUTCOMES (where the door is, whether the star is brighter, what the HUD says, who sees the coin),
// never which nodes or behaviour made them, so nodes, node text and a behaviour all count the same.
//
// `sync`: 'pair' = a second peer (B) joins before the check starts (both play); 'late' = the check joins B itself.
import * as P from './player.mjs';

/** @typedef {{call: (tool: string, args: any) => Promise<any>, make: (objects: any[]) => Promise<Record<string, any>>, refs: Record<string, {uuid: string, name: string}>}} Setup */
/** @typedef {{A: any, B: any | null, refs: Record<string, {uuid: string, name: string}>, base: Record<string, any>, note: (s: string) => void, joinB: () => Promise<any>}} Check */
/** @typedef {{score: number, why: string}} Verdict */

const FLOOR = {
	kind: 'primitive',
	primitive: 'Box',
	name: 'Floor',
	params: [24, 0.2, 24],
	position: [0, -0.1, 0],
	color: '#8a8f98'
};

/** floor + spawn + `objects`; remembers each by name @param {Setup} S @param {any[]} objects @param {{at?: number[], facing?: number[]}} [spawn] */
async function room(S, objects, spawn = {}) {
	await S.make([FLOOR, ...objects]);
	await S.call('place_spawn', {
		position: spawn.at ?? [0, 0, 8],
		facing: spawn.facing ?? [0, 1, 0]
	});
	// a GAME, the way every finished scene is one: pressing Play starts a round (the game shell's `playing`)
	// a GAME, the way every kit game is one: pressing Play starts a round (kit.round, which drives the game
	// shell's state, perRound latches, the pause menu's Restart and a behaviour's roundStart)
	await S.call('create_flow_nodes', {
		graph: 'scene',
		text: 'p = onplaystart\nc = kit-round-configure {intro: 0}\ns = kit-round-start\np -> c.trigger\np -> s.trigger'
	});
}

// 2.0-eval2: every wait is FOR a condition, and its time box stretches with the page's frame time (P.until)
const until = P.until;

/** @param {number} score @param {string} why @returns {Verdict} */
const v = (score, why) => ({ score, why });

/** some number in `after` is `k` more than a number in `before` (and new) @param {number[]} before @param {number[]} after @param {number} k */
export const rose = (before, after, k) =>
	after.some((b) => !before.includes(b) && before.some((a) => Math.abs(b - a - k) < 1e-6));

/** a team's score in HUD text: the first number right after the team's name, inside one HUD element (the
 * reader joins elements with " | ") @param {string} text @param {string} team @returns {number | null} */
export function teamScore(text, team) {
	const m = new RegExp('\\b' + team + '\\b[^\\d|]{0,10}(\\d+)', 'i').exec(text);
	return m ? Number(m[1]) : null;
}

/** the HUD tells this person THEIR team: the team's name is on it outside the score lines, the other team's is
 * not @param {string} text @param {string} team 'red' | 'blue' */
export function showsOwnTeam(text, team) {
	const rest = text.replace(/\b(red|blue)\b[^\d|]{0,10}\d+/gi, ' ');
	const other = team === 'red' ? 'blue' : 'red';
	return new RegExp('\\b' + team + '\\b', 'i').test(rest) && !new RegExp('\\b' + other + '\\b', 'i').test(rest);
}

const STARS = [-4, -2, 0, 2, 4].map((x, i) => ({
	kind: 'primitive',
	primitive: 'Octahedron',
	name: 'Star ' + (i + 1),
	params: [0.4],
	position: [x, 1.5, -3],
	color: '#5a5a5a'
}));
const starRefs = (/** @type {Check} */ C) => [1, 2, 3, 4, 5].map((i) => C.refs['Star ' + i]);

/** is the win showing: words on the HUD or the game shell over with a win */
async function winShowing(/** @type {any} */ page) {
	const h = await P.hud(page);
	const g = await P.game(page);
	if (
		/\b(you\s*win|you\s*won|win|won|victory)\b/i.test(
			h.text + ' ' + Object.values(h.values).join(' ')
		)
	)
		return true;
	if (g?.state === 'over' && /win|won/i.test(String(g?.outcome ?? ''))) return true;
	// a 3D "You win!" sign in the scene counts too: a person sees it
	return (await P.sceneSays(page, '\\byou\\s*(win|won)|\\bvictory|\\bwinner')).length > 0;
}

/** health as a fraction 0..1 (a bar), else the first number the HUD shows @param {any} h */
function healthOf(h) {
	if (h.bars.length) return h.bars[0];
	const keyed = Object.entries(h.values).find(
		([k, x]) => /health|hp|life/i.test(k) && typeof x === 'number'
	);
	if (keyed) return /** @type {number} */ (keyed[1]);
	const m = /(?:health|hp|life)\D{0,6}(\d+(?:\.\d+)?)/i.exec(h.text);
	if (m) return Number(m[1]);
	const n = P.numbersIn(h);
	return n.length ? n[0] : null;
}

/**
 * stand at `p` until the game moves the player away (a respawn) or `ms` passes; re-asserts the pose only while
 * the player is still there @returns {Promise<number[] | null>} where the player was moved to
 */
function standUntilMoved(
	/** @type {any} */ page,
	/** @type {number[]} */ p,
	/** @type {number} */ ms,
	/** @type {(() => Promise<void>) | null} */ each = null
) {
	return (async () => {
		const t0 = Date.now();
		while (Date.now() - t0 < ms) {
			const at = await P.playerPos(page);
			if (Math.hypot(at[0] - p[0], at[2] - p[2]) > 2) return at;
			await P.stay(page, p, 300);
			if (each) await each();
		}
		return null;
	})();
}

/** @type {{id: string, sync?: 'pair'|'late', reloadRetry?: boolean, say: string, setup: (S: Setup) => Promise<void>, check: (C: Check) => Promise<Verdict>}[]} */
export const TASKS = [
	{
		id: 'door-near',
		say: 'Make the door open when I walk up to it, and close again three seconds after I walk away.',
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Wall Left',
					params: [4, 3, 0.3],
					position: [-2.6, 1.5, -4],
					color: '#c8c0b0'
				},
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Wall Right',
					params: [4, 3, 0.3],
					position: [2.6, 1.5, -4],
					color: '#c8c0b0'
				},
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Door',
					params: [1.2, 2.2, 0.15],
					position: [0, 1.1, -4],
					color: '#7a4a2a'
				}
			]),
		check: async (C) => {
			const A = C.A;
			const door = C.refs.Door;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			const base = C.base.Door;
			await P.stay(A, [0, 0, 8], 1500);
			if (P.opened(base, await P.look(A, door)))
				return v(0, 'the door is open with nobody near it');
			await P.walk(A, [[0, 0, -2.5]]);
			const openedIn = await until(A, async () => P.opened(base, await P.look(A, door)), 4000);
			if (openedIn < 0) return v(0, 'the door did not open when the player stood 1.5 m from it');
			C.note('opened ' + openedIn + ' ms after arriving');
			await P.stay(A, [0, 0, -2.5], 1500);
			if (!P.opened(base, await P.look(A, door)))
				return v(0, 'the door closed again while the player was still at it');
			// walk away at a normal pace while watching (in the page): "away" = more than 5 m from the door (z > 1)
			const raw = await P.walkWatch(A, [[0, 0, 8]], 3, { door }, 8000);
			const line = raw.map((x) => ({
				t: x.t,
				z: +x.at[2].toFixed(1),
				open: P.opened(base, x.looks.door),
				closed: P.closedAgain(base, x.looks.door)
			}));
			C.note(
				'timeline ' +
					line
						.filter((_x, i) => i % 6 === 0)
						.map((x) => x.t + ':' + x.z + (x.open ? 'o' : x.closed ? 'c' : '-'))
						.join(' ')
			);
			const away = line.find((x) => x.z > 1)?.t ?? -1;
			const shut = line.find((x) => x.t >= away && x.closed)?.t ?? -1;
			const shutStart = line.find((x) => !x.open)?.t ?? -1;
			C.note(
				'away at ' +
					away +
					' ms, started closing ' +
					(shutStart - away) +
					' ms after, closed ' +
					(shut >= 0 ? shut - away : 'never') +
					' ms after'
			);
			if (shutStart >= 0 && shutStart < away + 1200)
				return v(
					0,
					'the door closed at once when the player walked away (' +
						(shutStart - away) +
						' ms after, not ~3 s)'
				);
			if (shut < 0) return v(0, 'the door never closed after the player walked away');
			if (shut - away > 7000)
				return v(0, 'the door closed far later than 3 s (' + (shut - away) + ' ms)');
			return v(1, 'opens near, closes about 3 s after leaving');
		}
	},
	{
		id: 'star-once',
		say: 'When I click a star it should light up and stay lit for the rest of the round — clicking it again does nothing. When a new round starts, all the stars go dark again.',
		setup: (S) => room(S, STARS, { facing: [0, 1.5, -3] }),
		check: async (C) => {
			const A = C.A;
			const [s1, s2, s3] = starRefs(C);
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.click(A, s1);
			if ((await until(A, async () => P.lit(C.base['Star 1'], await P.look(A, s1)), 2500)) < 0)
				return v(0, 'a clicked star did not light up');
			if (P.lit(C.base['Star 2'], await P.look(A, s2)))
				return v(0, 'clicking one star lit another');
			await P.click(A, s1);
			if (!(await P.holds(A, async () => P.lit(C.base['Star 1'], await P.look(A, s1)), 1200)))
				return v(0, 'clicking a lit star again turned it off');
			await P.click(A, s3);
			if ((await until(A, async () => P.lit(C.base['Star 3'], await P.look(A, s3)), 2500)) < 0)
				return v(0, 'a second star did not light up');
			C.note('before ' + JSON.stringify(await P.roundDiag(A)));
			const r = await P.newRound(A);
			C.note('restart ' + JSON.stringify(r));
			C.note('after ' + JSON.stringify(await P.roundDiag(A)));
			const dark = await until(
				A,
				async () =>
					!P.lit(C.base['Star 1'], await P.look(A, s1)) &&
					!P.lit(C.base['Star 3'], await P.look(A, s3)),
				3000
			);
			if (dark < 0) return v(0, 'the stars stayed lit into the new round');
			await P.click(A, s1);
			if ((await until(A, async () => P.lit(C.base['Star 1'], await P.look(A, s1)), 2500)) < 0)
				return v(0, 'a star could not be lit again in the new round');
			return v(1, 'lights once, stays lit, dark again next round');
		}
	},
	{
		id: 'win-five',
		say: 'Each star lights up when I click it. When all five stars are lit, I win — show "You win!" big on the screen.',
		setup: (S) => room(S, STARS, { facing: [0, 1.5, -3] }),
		check: async (C) => {
			const A = C.A;
			const stars = starRefs(C);
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			for (const s of stars.slice(0, 4)) {
				await P.click(A, s);
				await P.sleep(A, 300);
			}
			let litN = 0;
			await until(
				A,
				async () => {
					litN = 0;
					for (let i = 0; i < 4; i++)
						if (P.lit(C.base['Star ' + (i + 1)], await P.look(A, stars[i]))) litN++;
					return litN === 4;
				},
				3000
			);
			if (litN < 4) return v(0, 'only ' + litN + ' of 4 clicked stars lit up');
			if (!(await P.holds(A, async () => !(await winShowing(A)), 1200)))
				return v(0, 'the win shows with only four stars lit');
			await P.click(A, stars[4]);
			if ((await until(A, () => winShowing(A), 4000)) < 0)
				return v(0, 'no win after all five stars were lit');
			return v(1, 'win shows only once all five are lit');
		}
	},
	{
		id: 'score-round',
		say: 'Every time I click the target I get a point. Show my score at the top of the screen, and put it back to zero when a new round starts.',
		setup: (S) =>
			room(
				S,
				[
					{
						kind: 'primitive',
						primitive: 'Sphere',
						name: 'Target',
						params: [0.5],
						position: [0, 1.5, -3],
						color: '#d03030'
					}
				],
				{ facing: [0, 1.5, -3] }
			),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// the HUD is drawn by the page's frames: wait for a number to be on it (a score of 0) before counting
			await until(A, async () => P.numbersIn(await P.hud(A)).length > 0, 2500);
			const n0 = P.numbersIn(await P.hud(A));
			for (let i = 0; i < 3; i++) {
				await P.click(A, C.refs.Target);
				await P.sleep(A, 500);
			}
			/** @type {any} */
			let h1 = null;
			await until(A, async () => rose(n0, P.numbersIn((h1 = await P.hud(A))), 3), 2500);
			const n1 = P.numbersIn(h1);
			C.note(
				'hud before ' +
					JSON.stringify(n0) +
					' after 3 clicks ' +
					JSON.stringify(h1.text).slice(0, 160)
			);
			if (!rose(n0, n1, 3))
				return v(0, 'the score on screen did not go up by 3 after three clicks');
			await P.newRound(A);
			const zeroed = await until(
				A,
				async () => {
					const n = P.numbersIn(await P.hud(A));
					return n.includes(0) && !n1.filter((x) => !n0.includes(x)).some((x) => n.includes(x));
				},
				3000
			);
			if (zeroed < 0) return v(0, 'the score did not go back to zero in the new round');
			const n2 = P.numbersIn(await P.hud(A));
			await P.click(A, C.refs.Target);
			if ((await until(A, async () => rose(n2, P.numbersIn(await P.hud(A)), 1), 2500)) < 0)
				return v(0, 'clicking after the reset did not count');
			return v(1, 'counts clicks, shows the score, resets per round');
		}
	},
	{
		id: 'round-timer',
		say: 'Give the round a two-minute timer on the screen that counts down while we play.',
		setup: (S) => room(S, []),
		check: async (C) => {
			const A = C.A;
			// the scene sits in the editor a few seconds before Play, as it does while a person reads the answer.
			// It makes the verdict on a timer that counts from when the page first SAW it (an autostart HUD Timer
			// counts in the editor too: probe 2026-11-21, 120 -> 114 s in 6 s of editing) the same at any load:
			// that clock is >= 6 s off every round start, so it is not "a two-minute timer while we play"
			await P.sleep(A, 6000);
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// 2.0-eval2: the clock is judged against the ROUND START THE SCENE EMITS (the game shell's own round
			// clock), never against when the harness pressed Play: on a page drawing 3 frames a second the time
			// between "Play pressed" and "HUD read" is 25 s, which is the harness, not the timer. A timer that
			// starts with the first Play round or with a restarted round both count — each is a round start.
			const r0 = await P.roundRef(A);
			await P.newRound(A);
			const r1 = await P.roundRef(A);
			const starts = [r0, r1].filter((x) => !!x);
			if (!starts.length) return v(0, 'no round started when Play was pressed (the game shell has no round)');
			const want = (/** @type {any} */ s, /** @type {number} */ now) => 120 - (now - s.start) / 1000;
			/** the clock on screen that reads 2:00 counted from one of the round starts, within 5 s */
			const match = (/** @type {number[]} */ clocks, /** @type {number} */ now) => {
				for (const c of clocks)
					for (const s of starts) if (Math.abs(c - want(s, now)) <= 5) return { c, s };
				return null;
			};
			/** @type {any} */
			let first = null;
			/** @type {any} */
			let seen = null;
			await until(
				A,
				async () => {
					seen = await P.hudAt(A);
					first = match(P.clocksIn(seen.h), seen.now);
					return !!first;
				},
				3000
			);
			const shown = seen ? P.clocksIn(seen.h) : [];
			const wants = starts.map((s) => Math.round(want(s, seen?.now ?? 0)));
			C.note('round starts ' + starts.map((s) => 'r' + s.round).join(',') + '; clock ' + JSON.stringify(shown) + ', 2:00 from the round start = ' + JSON.stringify(wants));
			if (!first)
				return v(
					0,
					shown.length
						? 'the clock on screen (' + shown.join(', ') + ' s) is not a 2:00 count from the round start (' + wants.join(' or ') + ' s now)'
						: 'no clock on the screen (' + seen?.h?.text?.slice(0, 100) + ')'
				);
			// it counts DOWN, at the round's pace: a reading 5 s later is again 2:00 from the same start, and lower
			await P.sleep(A, 5000);
			const later = await P.hudAt(A);
			const c2 = P.clocksIn(later.h);
			const ok = c2.some((x) => Math.abs(x - want(first.s, later.now)) <= 5 && first.c - x >= 3);
			C.note('then ' + JSON.stringify(c2) + ' (want ' + Math.round(want(first.s, later.now)) + ')');
			if (!ok) return v(0, 'the clock did not count down with the round (' + first.c + ' then ' + JSON.stringify(c2) + ')');
			return v(1, 'a 2:00 clock counts down');
		}
	},
	{
		id: 'pause-p',
		say: 'Let me pause the game by pressing P, and press P again to carry on.',
		setup: async (S) => {
			await room(
				S,
				[
					{
						kind: 'primitive',
						primitive: 'Box',
						name: 'Fan',
						params: [2.4, 0.1, 0.3],
						position: [0, 1.6, -3],
						color: '#3070c0'
					}
				],
				{ facing: [0, 1.6, -3] }
			);
			await S.call('create_flow_nodes', {
				graph: S.refs.Fan.uuid,
				nodes: [{ type: 'spin', data: { axis: 'y', speed: 0.5 } }]
			});
		},
		check: async (C) => {
			const A = C.A;
			const fan = C.refs.Fan;
			const turning = async (ms) => {
				const a = await P.look(A, fan);
				await P.sleep(A, ms);
				return P.turned(a, await P.look(A, fan));
			};
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			const t0 = await turning(1000);
			if (t0 < 5)
				return v(0, 'the fan was not turning in Play to begin with (' + t0.toFixed(1) + '°/s)');
			await A.locator('body')
				.focus()
				.catch(() => {});
			await P.press(A, 'p');
			// wait FOR the fan to stand still (a 1 s window with no turn), not 600 ms
			let t1 = 99;
			await until(A, async () => (t1 = await turning(1000)) <= 2, 3000, 0);
			const g1 = await P.game(A);
			C.note('after P: fan ' + t1.toFixed(1) + '° in 1.5 s, game ' + g1?.state);
			// 2.0-int: where a press stops (the behaviour input pass, the behaviour runtime, its state)
			C.note('trace ' + (await A.evaluate(() => {
				try {
					const t = window.__tp.test.v1;
					const d = t.behaviours?.behavioursDebug?.();
					const live = (d?.loaded ?? []).map((/** @type {string} */ id) => {
						try {
							const l = d.live(id);
							return { id, state: l?.state ?? null, keys: l ? Object.keys(l).slice(0, 12) : null };
						} catch (e) {
							return { id, err: String(e) };
						}
					});
					return JSON.stringify({ input: t.flowRuntime?.behaviourInputStats, status: d?.status, stats: d?.stats, authority: d?.authority, me: d?.me, live }).slice(0, 1800);
				} catch (e) {
					return 'trace failed: ' + e;
				}
			})));
			if (t1 > 2) return v(0, 'P did not pause: the fan kept turning');
			await P.press(A, 'p');
			let t2 = 0;
			await until(A, async () => (t2 = await turning(1000)) >= 5, 3000, 0);
			if (t2 < 5) return v(0, 'P again did not carry on: the fan stayed still');
			return v(1, 'P pauses, P resumes');
		}
	},
	{
		id: 'best-time',
		reloadRetry: false,
		say: 'Time how long it takes me to get from the start to the flag once the round starts, and keep my best time even after the page is reloaded. Show the best time on the screen.',
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Cylinder',
					name: 'Flag',
					params: [0.08, 0.08, 3],
					position: [0, 1.5, -8],
					color: '#e0e0e0'
				},
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Flag Cloth',
					params: [1, 0.6, 0.05],
					position: [0.55, 2.7, -8],
					color: '#e03030'
				}
			]),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.newRound(A);
			const round = await P.roundRef(A);
			await P.stay(A, [0, 0, 8], 1000);
			const left = await P.pageNow(A);
			await P.walk(A, [[0, 0, -7.6]], 3);
			const arrived = await P.pageNow(A);
			// 2.0-eval2: a time is right when it lies between the WALK itself (start line left -> flag) and the
			// round start -> flag, as this page measured them (+-1.5 s), not inside a fixed 4-14 s window
			const lo = (arrived - left) / 1000 - 1.5;
			const hi = (arrived - (round?.start ?? left)) / 1000 + 1.5;
			C.note('walk ' + ((arrived - left) / 1000).toFixed(1) + ' s, round start to flag ' + ((arrived - (round?.start ?? left)) / 1000).toFixed(1) + ' s');
			/** @type {number[]} */
			let times = [];
			/** @type {any} */
			let h1 = null;
			const standing = P.stay(A, [0, 0, -7.6], 2500 * (await P.loadScale(A)));
			await until(
				A,
				async () => {
					h1 = await P.hud(A);
					times = [...P.numbersIn(h1), ...P.clocksIn(h1)].filter((x) => x >= lo && x <= hi);
					return times.length > 0;
				},
				2500
			);
			await standing;
			C.note('after the run: ' + JSON.stringify(h1.text).slice(0, 160));
			if (!times.length)
				return v(0, 'no time of ' + lo.toFixed(1) + '-' + hi.toFixed(1) + ' s on the screen after reaching the flag');
			await P.leavePlay(A);
			await A.evaluate(() => window.__tp.test.v1.autosave.saveNow?.());
			await P.sleep(A, 2500);
			await C.reload();
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start after the reload');
			let kept = false;
			await until(
				A,
				async () => {
					const h = await P.hud(A);
					kept = [...P.numbersIn(h), ...P.clocksIn(h)].some((x) =>
						times.some((t) => Math.abs(t - x) <= 0.6)
					);
					return kept;
				},
				4000
			);
			if (!kept)
				return v(
					0,
					'the best time was gone after the reload (' + (await P.hud(A)).text.slice(0, 100) + ')'
				);
			return v(1, 'times the run and keeps the best across a reload');
		}
	},
	{
		id: 'pickup-own',
		sync: 'pair',
		say: "Make the coin a pickup: whoever walks into it collects it. It disappears for everyone, and only that person's coin count goes up. Show each person their own coin count on the screen.",
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Cylinder',
					name: 'Coin',
					params: [0.5, 0.5, 0.1],
					position: [0, 1, 0],
					rotation: [Math.PI / 2, 0, 0],
					color: '#f0c020'
				}
			]),
		check: async (C) => {
			const { A, B } = C;
			const coin = C.refs.Coin;
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B)))
				return v(0, 'Play did not start on both');
			// the count is drawn by each page's frames: wait for a number on both screens before anyone walks
			await until(A, async () => P.numbersIn(await P.hud(A)).length > 0, 2500);
			await until(B, async () => P.numbersIn(await P.hud(B)).length > 0, 2500);
			const [a0, b0] = [P.numbersIn(await P.hud(A)), P.numbersIn(await P.hud(B))];
			await P.walk(B, [[0, 0, 0]]);
			await P.stay(B, [0, 0, 0], 1500);
			await P.walk(B, [[0, 0, -4]]);
			const gone = async (/** @type {any} */ page) => {
				const l = await P.look(page, coin);
				return !l || !l.shown || l.opacity < 0.2;
			};
			const read = async () => {
				const [goneA, goneB] = [await gone(A), await gone(B)];
				const [a1, b1] = [P.numbersIn(await P.hud(A)), P.numbersIn(await P.hud(B))];
				return { goneA, goneB, upA: rose(a0, a1, 1), upB: rose(b0, b1, 1) };
			};
			// wait FOR the whole outcome (gone on both, B's count up), then A's count must STAY where it was
			let st = await read();
			await until(A, async () => ((st = await read()), st.goneA && st.goneB && st.upB), 3000);
			if (st.goneA && st.goneB && st.upB && (await P.holds(A, async () => !(st = await read()).upA, 1500)))
				return v(1, 'the toucher collects it, gone for everyone, only their count rises');
			const { goneA, goneB, upA, upB } = st;
			C.note(`B walked through: gone A=${goneA} B=${goneB}; count up A=${upA} B=${upB}`);
			if (goneB && upB)
				return v(
					0.5,
					'works for the toucher only: ' +
						(!goneA ? 'the other player still sees the coin' : 'the other player counted it too')
				);
			// B's touch did nothing for B: does it work for the host?
			if (!goneA) {
				await P.walk(A, [[0, 0, 0]]);
				await P.stay(A, [0, 0, 0], 1500);
				if ((await until(A, async () => (await gone(A)) && rose(a0, P.numbersIn(await P.hud(A)), 1), 3000)) >= 0)
					return v(0.5, 'works for the host only, not for a joined player');
			}
			return v(0, 'walking into the coin did not collect it');
		}
	},
	{
		id: 'toggle-shared',
		sync: 'pair',
		say: 'The lamp is on. Clicking the button switches the lamp off, and clicking it again switches it back on — for everyone in the session. If two of us press it at the same moment, we must all still see the same thing.',
		setup: (S) =>
			room(
				S,
				[
					{
						kind: 'primitive',
						primitive: 'Box',
						name: 'Button',
						params: [0.6, 0.3, 0.6],
						position: [0, 1, -2],
						color: '#c02020'
					},
					{
						kind: 'light',
						light: 'point',
						name: 'Lamp',
						position: [0, 3, -3],
						color: '#ffd8a0',
						intensity: 4,
						distance: 10
					}
				],
				{ facing: [0, 1, -2] }
			),
		check: async (C) => {
			const { A, B } = C;
			const lamp = C.refs.Lamp;
			const btn = C.refs.Button;
			const on = async (/** @type {any} */ page) => {
				const l = await P.look(page, lamp);
				return !!l && l.shown && (l.intensity ?? 0) > 0.05;
			};
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B)))
				return v(0, 'Play did not start on both');
			if (!(await on(A)) || !(await on(B))) return v(0, 'the lamp is not on at the start of Play');
			await P.click(A, btn);
			const offA = await until(A, async () => !(await on(A)), 3000);
			const offB = await until(B, async () => !(await on(B)), 3000);
			if (offA < 0 && offB < 0)
				return v(0, "the host's click did not switch the lamp off anywhere");
			if (offA < 0 || offB < 0)
				return v(
					0.5,
					'the click switched the lamp only on ' +
						(offA >= 0 ? "the presser's" : "the other player's") +
						' screen'
				);
			await P.click(B, btn);
			const onA = await until(A, () => on(A), 3000);
			const onB = await until(B, () => on(B), 3000);
			if (onA < 0 || onB < 0)
				return v(
					0.5,
					"the joined player's click did not switch it back on for everyone (A " +
						(onA >= 0) +
						', B ' +
						(onB >= 0) +
						')'
				);
			await Promise.all([P.click(A, btn), P.click(B, btn)]);
			// the two screens must END UP agreeing (and stay so): wait for it, then hold it
			await P.sleep(A, 500);
			await until(A, async () => (await on(A)) === (await on(B)), 2500);
			await P.holds(A, async () => (await on(A)) === (await on(B)), 1000);
			const [sa, sb] = [await on(A), await on(B)];
			C.note('both pressed together: A ' + (sa ? 'on' : 'off') + ', B ' + (sb ? 'on' : 'off'));
			if (sa !== sb)
				return v(0.5, 'two presses at once left the two players seeing different lamps');
			return v(1, 'toggles for everyone, both directions, agrees after a double press');
		}
	},
	{
		id: 'platform-loop',
		say: 'Make the platform slide back and forth between where it is now and five metres to the right, over and over.',
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Platform',
					params: [3, 0.3, 3],
					position: [0, 1, 0],
					color: '#3060a0'
				}
			]),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			const start = C.base.Platform.pos;
			const s = await P.sample(A, () => P.look(A, C.refs.Platform), 14000, 200);
			const xs = s.map((x) => x.v?.pos ?? start);
			const d = xs.map((p) => p[0] - start[0]);
			const range = Math.max(...d) - Math.min(...d);
			let reversals = 0;
			let dir = 0;
			let anchor = d[0];
			for (const x of d) {
				if (dir >= 0 && x < anchor - 0.3)
					((reversals += dir > 0 ? 1 : 0), (dir = -1), (anchor = x));
				else if (dir <= 0 && x > anchor + 0.3)
					((reversals += dir < 0 ? 1 : 0), (dir = 1), (anchor = x));
				else if ((dir > 0 && x > anchor) || (dir < 0 && x < anchor)) anchor = x;
			}
			const late = d.slice(-15);
			const stillMoving = Math.max(...late) - Math.min(...late) > 0.5;
			const right = Math.max(...d) > 3.5;
			C.note(
				`x range ${range.toFixed(2)} m, max right ${Math.max(...d).toFixed(2)}, reversals ${reversals}, still moving ${stillMoving}`
			);
			if (range < 3.5)
				return v(0, 'the platform did not travel about 5 m (' + range.toFixed(2) + ' m)');
			if (!right) return v(0, 'the platform did not go to the right (+x)');
			if (reversals < 2 || !stillMoving)
				return v(0, 'the platform did not keep going back and forth');
			return v(1, 'slides ~5 m right and back, repeatedly');
		}
	},
	{
		id: 'countdown',
		say: 'When a round starts, count down 3, 2, 1 on the screen, then open the gate so we can go through.',
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Gate',
					params: [4, 3, 0.3],
					position: [0, 1.5, 0],
					color: '#606060'
				},
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Fence Left',
					params: [8, 1.5, 0.3],
					position: [-6, 0.75, 0],
					color: '#909090'
				},
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Fence Right',
					params: [8, 1.5, 0.3],
					position: [6, 0.75, 0],
					color: '#909090'
				}
			]),
		check: async (C) => {
			const A = C.A;
			const gate = C.refs.Gate;
			const base = C.base.Gate;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// whatever the first entry started has run out: the gate is open (or 7 s of the page's frames passed)
			await until(A, async () => P.opened(base, await P.look(A, gate)), 7000);
			await P.sleep(A, 500);
			// the pause menu's Restart, sampled from the press on (a countdown is over in 3 s)
			await P.restartRound(A, 0);
			const t0 = Date.now();
			/** @type {string[]} */
			const seen = [];
			let openAt = -1;
			let closedAgainAfterRestart = false;
			const box = 8000 * (await P.loadScale(A));
			while (Date.now() - t0 < box) {
				const h = await P.hud(A);
				const words =
					(h.text + ' ' + Object.values(h.values).join(' ')).match(/\b[123]\b|\bgo\b/gi) ?? [];
				for (const w of words)
					if (seen[seen.length - 1] !== w.toLowerCase()) seen.push(w.toLowerCase());
				const now = await P.look(A, gate);
				if (!P.opened(base, now)) closedAgainAfterRestart = true;
				if (openAt < 0 && closedAgainAfterRestart && P.opened(base, now)) openAt = Date.now() - t0;
				await P.sleep(A, 150);
			}
			C.note('seen ' + seen.join(',') + '; gate opened at ' + openAt + ' ms after the restart');
			const order = seen.filter((w) => ['3', '2', '1'].includes(w));
			const descending =
				order.some((w, i) => i > 0 && Number(order[i - 1]) - Number(w) >= 1) ||
				order.join('').includes('32') ||
				order.join('').includes('21');
			if (!descending) return v(0, 'no 3-2-1 countdown on the screen at the round start');
			if (!closedAgainAfterRestart) return v(0, 'the gate was already open during the countdown');
			if (openAt < 0) return v(0, 'the gate did not open after the countdown');
			if (openAt < 1500)
				return v(0, 'the gate opened before the countdown ended (' + openAt + ' ms)');
			return v(1, '3-2-1 then the gate opens');
		}
	},
	{
		id: 'hit-sound',
		say: 'Play a ding when I hit the bell — clicking it counts as a hit — but never more than once every half second, even if I click like crazy.',
		setup: (S) =>
			room(
				S,
				[
					{
						kind: 'primitive',
						primitive: 'Cone',
						name: 'Bell',
						params: [0.6, 0.8],
						position: [0, 1.5, -3],
						color: '#d4a020'
					}
				],
				{ facing: [0, 1.5, -3] }
			),
		check: async (C) => {
			const A = C.A;
			const bell = C.refs.Bell;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.sleep(A, 1500);
			let t = await P.pageNow(A);
			await P.sleep(A, 1500);
			const background = (await P.soundsSince(A, t)).length;
			t = await P.pageNow(A);
			await P.click(A, bell);
			await until(A, async () => (await P.soundsSince(A, t)).length > 0, 1000);
			const one = (await P.soundsSince(A, t)).length;
			if (one < 1) return v(0, 'no sound when the bell was hit');
			await P.sleep(A, 800);
			t = await P.pageNow(A);
			for (let i = 0; i < 13; i++) {
				await P.click(A, bell);
				await P.sleep(A, 80);
			}
			const span = (await P.pageNow(A)) - t;
			await P.sleep(A, 400);
			const frame = await P.frameMs(A);
			const dings = await P.soundsSince(A, t);
			const burst = dings.length;
			// the rule as asked: never two dings closer than half a second. A sound starts on the frame after its
			// pulse, so a gap is only known to within a frame: allow one frame (+60 ms) of slack, and a count over the
			// measured span as well (at a few fps the clicks themselves come slower than the limit)
			const gaps = dings.slice(1).map((x, i) => x - dings[i]);
			const minGap = gaps.length ? Math.min(...gaps) : Infinity;
			const floor = 500 - frame - 60;
			C.note(
				`background ${background}/1.5 s, one hit ${one}, 13 hits in ${(span / 1000).toFixed(1)} s → ${burst} sounds, closest ${Number.isFinite(minGap) ? Math.round(minGap) + ' ms' : '-'} apart; frame ${Math.round(frame)} ms`
			);
			if (frame > 120) C.note('low frame rate: the half-second rule is judged coarsely here');
			if (background > 0) C.note('sounds play with nobody hitting the bell');
			if (!background && minGap < floor)
				return v(
					0,
					`two dings ${Math.round(minGap)} ms apart while clicking fast (${burst} in ${(span / 1000).toFixed(1)} s)`
				);
			if (burst > Math.floor(span / 500) + 2 + background)
				return v(
					0,
					`more dings than one per half second (${burst} in ${(span / 1000).toFixed(1)} s)`
				);
			if (burst < 1) return v(0, 'no ding at all while clicking fast');
			return v(1, 'dings, at most one per 0.5 s');
		}
	},
	{
		id: 'health-respawn',
		say: 'Give me a health bar on the screen. Standing on the spikes hurts and drains my health; when it runs out I go back to the start with full health.',
		setup: (S) =>
			room(S, [
				{
					kind: 'primitive',
					primitive: 'Box',
					name: 'Spikes',
					params: [3, 0.5, 3],
					position: [0, 0.25, -3],
					color: '#701010'
				}
			]),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// the start is where Play puts you (the agent may have moved the spawn)
			const start = await P.playerPos(A);
			// wait FOR a health reading on screen
			await until(A, async () => (healthOf(await P.hud(A)) ?? 0) > 0, 2500);
			const h0 = healthOf(await P.hud(A));
			if (h0 === null || !(h0 > 0))
				return v(0, 'no health shown on the screen (' + (await P.hud(A)).text.slice(0, 100) + ')');
			let low = h0;
			await P.walk(A, [[0, 0, -3]]);
			const movedTo = await standUntilMoved(A, [0, 0, -3], 30000, async () => {
				const x = healthOf(await P.hud(A));
				if (x !== null && x < low) low = x;
			});
			C.note(
				`health ${h0} → lowest ${low}; moved to ${JSON.stringify(movedTo?.map((n) => +n.toFixed(1)))}`
			);
			if (!(low < h0)) return v(0, 'standing on the spikes did not lower the health');
			if (!movedTo)
				return v(0, 'the player was not sent back when the health ran out (30 s on the spikes)');
			if (Math.hypot(movedTo[0] - start[0], movedTo[2] - start[2]) > 2.5)
				return v(0, 'the player was moved, but not back to the start');
			let full = false;
			await until(
				A,
				async () => {
					const x = healthOf(await P.hud(A));
					full = x !== null && x >= h0 * 0.9;
					return full;
				},
				3000
			);
			if (!full) return v(0, 'health was not full again after the respawn');
			return v(1, 'drains on the spikes, respawns at the start with full health');
		}
	},
	{
		id: 'checkpoint',
		say: "Make the green pad a checkpoint: once I've stepped on it, touching the lava sends me back to the pad instead of the start. Touching the lava before I reach the pad sends me back to the start.",
		setup: (S) =>
			room(
				S,
				[
					{
						kind: 'primitive',
						primitive: 'Box',
						name: 'Checkpoint',
						params: [2, 0.1, 2],
						position: [6, 0.05, 4],
						color: '#30c040'
					},
					{
						kind: 'primitive',
						primitive: 'Box',
						name: 'Lava',
						params: [6, 0.2, 3],
						position: [0, 0.1, -5],
						color: '#ff4010'
					}
				],
				{ at: [0, 0, 10], facing: [0, 0, -5] }
			),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// the start is where Play puts you (the agent may have moved the spawn)
			const start = await P.playerPos(A);
			await P.walk(A, [[0, 0, -5]]);
			const first = await standUntilMoved(A, [0, 0, -5], 6000);
			if (!first) return v(0, 'touching the lava did nothing');
			if (Math.hypot(first[0] - start[0], first[2] - start[2]) > 2.5)
				return v(
					0,
					'the lava sent the player somewhere other than the start before the checkpoint (' +
						first.map((n) => n.toFixed(1)) +
						')'
				);
			await P.walk(A, [[6, 0, 4]]);
			await P.stay(A, [6, 0, 4], 1200);
			await P.walk(A, [[0, 0, -5]]);
			const second = await standUntilMoved(A, [0, 0, -5], 6000);
			C.note(
				'after lava: ' +
					JSON.stringify(first.map((n) => +n.toFixed(1))) +
					' then ' +
					JSON.stringify(second?.map((n) => +n.toFixed(1))) +
					'; start ' +
					JSON.stringify(start.map((n) => +n.toFixed(1)))
			);
			if (!second) return v(0, 'the lava did nothing the second time');
			if (Math.hypot(second[0] - 6, second[2] - 4) > 2.5)
				return v(0, 'after the checkpoint the lava still sent the player to the start');
			return v(1, 'lava respawns at the start, then at the checkpoint');
		}
	},
	{
		id: 'late-joiner',
		sync: 'late',
		say: 'Clicking a lantern lights it, and it stays lit. Someone who joins the session later must see the lanterns that are already lit.',
		setup: (S) =>
			room(
				S,
				[-3, 0, 3].map((x, i) => ({
					kind: 'primitive',
					primitive: 'Sphere',
					name: 'Lantern ' + (i + 1),
					params: [0.3],
					position: [x, 1.5, -3],
					color: '#505050'
				})),
				{ facing: [0, 1.5, -3] }
			),
		check: async (C) => {
			const A = C.A;
			const L = [1, 2, 3].map((i) => C.refs['Lantern ' + i]);
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.click(A, L[0]);
			await P.sleep(A, 400);
			await P.click(A, L[2]);
			const ok = await until(
				A,
				async () =>
					P.lit(C.base['Lantern 1'], await P.look(A, L[0])) &&
					P.lit(C.base['Lantern 3'], await P.look(A, L[2])),
				3000
			);
			if (ok < 0) return v(0, 'clicked lanterns did not light up');
			await P.leavePlay(A);
			const B = await C.joinB();
			if (!B) return v(0, 'the late joiner could not join');
			// 2.0-eval2: the window starts when the joiner has LOADED (its object batch landed, nothing still asked,
			// every lantern there), not after a fixed 4 s: on a 3 fps page each incoming object takes ~3 s to apply,
			// so 7 objects outlasted the old 4 + 8 s and the check read a scene still arriving (n3b Q9)
			const load = await P.joinLoaded(B, Object.values(C.refs), 120000);
			C.note('joiner loaded in ' + load.ms + ' ms ' + JSON.stringify(load.state));
			if (load.ms < 0) return v(0, 'the late joiner never finished loading the scene (' + JSON.stringify(load.state) + ')');
			await P.enterPlay(B);
			let state = '';
			const same = await until(
				B,
				async () => {
					const l = [];
					for (let i = 0; i < 3; i++)
						l.push(P.lit(C.base['Lantern ' + (i + 1)], await P.look(B, L[i])));
					state = l.map((x) => (x ? 'lit' : 'dark')).join(',');
					return l[0] && !l[1] && l[2];
				},
				8000
			);
			C.note('the late joiner sees ' + state);
			if (same < 0) return v(0, 'the late joiner does not see the lit lanterns (' + state + ')');
			return v(1, 'a late joiner sees exactly the lit lanterns');
		}
	},
	// ---------------------------------------------------------------------------------------- 2.0-eval2: 8 more
	// From what the 39 scenes do and the first 15 did not cover (cloud task-2.0-eval2.md step 5). Same rules: the
	// check reads OUTCOMES a person sees, waits FOR conditions (P.until / P.holds stretch with the page's frame
	// time) and never reads after a fixed sleep.
	{
		id: 'key-door',
		say: 'The door is locked. Put a key on the floor: when I walk over the key I pick it up, and only once I have the key does the door open when I walk up to it.',
		setup: (S) =>
			room(S, [
				{ kind: 'primitive', primitive: 'Box', name: 'Wall Left', params: [4, 3, 0.3], position: [-2.6, 1.5, -4], color: '#c8c0b0' },
				{ kind: 'primitive', primitive: 'Box', name: 'Wall Right', params: [4, 3, 0.3], position: [2.6, 1.5, -4], color: '#c8c0b0' },
				{ kind: 'primitive', primitive: 'Box', name: 'Door', params: [1.2, 2.2, 0.15], position: [0, 1.1, -4], color: '#7a4a2a' },
				{ kind: 'primitive', primitive: 'Box', name: 'Key', params: [0.5, 0.15, 0.2], position: [5, 0.4, 4], color: '#f0c020' }
			]),
		check: async (C) => {
			const A = C.A;
			const door = C.refs.Door;
			const base = C.base.Door;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.walk(A, [[0, 0, -2.5]]);
			const shut = await P.holds(A, async () => !P.opened(base, await P.look(A, door)), 3000);
			if (!shut) return v(0, 'the door opened without the key');
			await P.walk(A, [[0, 0, 4], [5, 0, 4]]);
			await P.stay(A, [5, 0, 4], 1500);
			const k = await P.look(A, C.refs.Key);
			C.note('key after walking over it: ' + (!k || !k.shown ? 'gone' : 'still there'));
			await P.walk(A, [[0, 0, 4], [0, 0, -2.5]]);
			const stand = P.stay(A, [0, 0, -2.5], 4000 * (await P.loadScale(A)));
			const openedIn = await until(A, async () => P.opened(base, await P.look(A, door)), 4000);
			await stand;
			if (openedIn < 0) return v(0, 'with the key, the door still did not open at it');
			return v(1, 'shut without the key, opens with it');
		}
	},
	{
		id: 'lap-counter',
		say: 'This is a race track around the block. Count my laps — one lap each time I come back round across the finish line — and show my lap count and my best lap time on the screen.',
		setup: (S) =>
			room(
				S,
				[
					{ kind: 'primitive', primitive: 'Box', name: 'Finish Line', params: [4, 0.05, 1], position: [0, 0.025, 0], color: '#f4f4f4' },
					{ kind: 'primitive', primitive: 'Box', name: 'Infield', params: [6, 1, 10], position: [4, 0.5, 0], color: '#3a7a3a' }
				],
				{ at: [0, 0, 3], facing: [0, 0, -6] }
			),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// THE LINE IS CROSSED SLOWLY (1 m/s over 2 m): at a loaded page's 2-3 fps a fast walk moves 1-2 m a frame and
			// can step over a 1 m sensor without ever touching it. A crossing's moment = the middle of that slow stretch,
			// by the wall clock; a lap is judged against the measured gap between two crossings, not a nominal speed.
			const crossings = /** @type {number[]} */ ([]);
			const cross = async () => {
				const t0 = Date.now();
				await P.walk(A, [[0, 0, -1]], 1);
				crossings.push((t0 + Date.now()) / 2);
			};
			// one loop from just past the line round the infield and back over it: 38 m at 2 m/s + the slow 2 m.
			// 2.0-eval2: both laps walk at 2 m/s (1 m a frame at 2 fps) and the first one is made SLOWER by a stop at
			// the far corner: a 5 m/s lap moved 2.5 m a frame on a loaded page and stepped over a build's own halfway
			// checkpoint (arms A/B: lap 2 missed at random, |A-B| 0.40)
			// `slow`: stop at the corner for as long as the whole walk takes (the 25 m so far x 40/25), so lap 1 is
			// about twice lap 2 at any load (a fixed stop was only 4 s of a 32 s lap on a 2 fps page)
			const loop = async (/** @type {boolean} */ slow) => {
				const t0 = Date.now();
				await P.walk(A, [[0, 0, -6], [8, 0, -6], [8, 0, 6]], 2);
				if (slow) await P.stay(A, [8, 0, 6], Math.max(12000, ((Date.now() - t0) * 40) / 25));
				await P.walk(A, [[0, 0, 6], [0, 0, 1]], 2);
				await cross();
				return (crossings[crossings.length - 1] - crossings[crossings.length - 2]) / 1000;
			};
			await P.stay(A, [0, 0, 3], 800);
			await until(A, async () => P.numbersIn(await P.hud(A)).length > 0, 2500);
			const n0 = P.numbersIn(await P.hud(A));
			// a lap time on screen near the measured one (1.5 s + 20 %: a build may time laps on the sim clock, which a
			// loaded page runs a little slow)
			// `not`: and nearer this lap than that one (a best that stayed at lap 1 is not lap 2's time)
			const numsNear = (/** @type {any} */ h, /** @type {number} */ want, /** @type {number} */ not = Infinity) =>
				[...P.numbersIn(h), ...P.clocksIn(h)].some((x) => Math.abs(x - want) <= 1.5 + 0.2 * want && Math.abs(x - want) < Math.abs(x - not));
			await P.walk(A, [[0, 0, 1]], 2);
			await cross(); // crossing 1: the race starts
			const lap1 = await loop(true); // ~2x lap 2
			/** @type {any} */
			let h1 = null;
			const after1 = await until(A, async () => ((h1 = await P.hud(A)), rose(n0, P.numbersIn(h1), 1) && numsNear(h1, lap1)), 4000);
			const lap2 = await loop(false); // ~20-32 s
			/** @type {any} */
			let h2 = null;
			const after2 = await until(A, async () => ((h2 = await P.hud(A)), !!h1 && rose(P.numbersIn(h1), P.numbersIn(h2), 1) && numsNear(h2, lap2, lap1)), 4000);
			C.note('laps ' + lap1.toFixed(1) + ' s, ' + lap2.toFixed(1) + ' s; start ' + JSON.stringify(n0) + '; after lap 1 ' + JSON.stringify(h1?.text?.slice(0, 120)) + '; after lap 2 ' + JSON.stringify(h2?.text?.slice(0, 120)));
			if (after1 < 0) {
				if (h1 && rose(n0, P.numbersIn(h1), 1)) return v(0, 'a lap counted, but no lap time near ' + lap1.toFixed(0) + ' s on the screen');
				return v(0, 'no lap counted after one lap round the track');
			}
			if (after2 < 0) {
				if (h2 && numsNear(h2, lap2, lap1)) return v(0, 'the best lap updated, but the lap count did not go up on the second lap');
				return v(0, 'after a faster second lap (' + lap2.toFixed(0) + ' s) the best lap did not become about that');
			}
			return v(1, 'counts laps, keeps the best lap time');
		}
	},
	{
		id: 'spawner-cap',
		say: 'Spawn a new enemy like this one every second, but never have more than 5 alive at once. Each enemy only lives 8 seconds, and new ones keep coming so there are always up to 5.',
		setup: (S) =>
			room(
				S,
				[{ kind: 'primitive', primitive: 'Box', name: 'Enemy', params: [0.8, 0.8, 0.8], position: [0, 0.4, -6], color: '#c02020' }],
				{ facing: [0, 0.4, -6] }
			),
		check: async (C) => {
			const A = C.A;
			const template = C.refs.Enemy.uuid;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			// the enemies a person sees, in either form: visible scene objects called "enemy…" (core Spawn copies; the
			// start scene's own one left out) and kit entities (a behaviour's spawn, drawn in a system group). The two
			// can describe one enemy, so the COUNT is the larger of the two and identity is the union.
			// (1.72: a click on a spawned copy never reaches the template's On Click, so the request asks for a
			// lifetime, not a click kill.)
			const alive = async () => {
				const scene = (await P.visibleNamed(A, 'enem')).filter((e) => e.uuid !== template).map((e) => 's:' + e.uuid);
				const kit = (await P.kitAlive(A)).map((id) => 'k:' + id);
				return { n: Math.max(scene.length, kit.length), ids: [...scene, ...kit] };
			};
			let most = 0;
			let now = { n: 0, ids: /** @type {string[]} */ ([]) };
			const full = await until(A, async () => {
				now = await alive();
				most = Math.max(most, now.n);
				return now.n >= 5 || most > 5;
			}, 9000);
			if (most > 5) return v(0, 'more than 5 enemies alive at once (' + most + ')');
			if (full < 0) return v(0, now.n ? 'only ' + now.n + ' enemies came in 9 s (one a second, up to 5)' : 'no enemies spawned');
			// while it churns: never above 5, the first five go away, and new ones keep it near full
			const first = new Set(now.ids);
			let turned = false;
			const capped = await P.holds(A, async () => {
				now = await alive();
				most = Math.max(most, now.n);
				if (now.n >= 4 && [...first].some((id) => !now.ids.includes(id))) turned = true;
				return now.n <= 5;
			}, 12000);
			C.note('most ' + most + ', turned over ' + turned + ', last ' + now.n);
			if (!capped) return v(0, 'more than 5 enemies alive at once (' + most + ')');
			if (!turned) return v(0.5, 'capped at 5, but the enemies never go away and get replaced');
			return v(1, 'one a second, never more than 5, old ones leave and new ones fill up');
		}
	},
	{
		id: 'team-score',
		sync: 'pair',
		say: "Make it a two-team game, Red against Blue: put each player on a team so the teams stay even, and show each person which team they are on. Clicking the ball scores a point for the clicker's team. Show both team scores on everyone's screen.",
		setup: (S) =>
			room(
				S,
				[{ kind: 'primitive', primitive: 'Sphere', name: 'Ball', params: [0.5], position: [0, 1.5, -3], color: '#f0f0f0' }],
				{ facing: [0, 1.5, -3] }
			),
		check: async (C) => {
			const { A, B } = C;
			const ball = C.refs.Ball;
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B))) return v(0, 'Play did not start on both');
			const read = async (/** @type {any} */ page) => {
				const h = await P.hud(page);
				const text = h.text + ' | ' + Object.values(h.values).join(' | ');
				return { text, red: teamScore(text, 'red'), blue: teamScore(text, 'blue') };
			};
			const both = async () => [await read(A), await read(B)];
			let [ra, rb] = await both();
			await until(A, async () => (([ra, rb] = await both()), ra.red !== null && ra.blue !== null && rb.red !== null && rb.blue !== null), 3000);
			if (ra.red === null || ra.blue === null) return v(0, 'no Red and Blue scores on the screen (' + ra.text.slice(0, 100) + ')');
			if (rb.red === null || rb.blue === null) return v(0.5, "the joined player does not see the team scores (" + rb.text.slice(0, 100) + ')');
			const s0 = { red: ra.red, blue: ra.blue };
			/** which team's score rose by `k` on BOTH screens, from `from` */
			const roseBy = (/** @type {any} */ from, /** @type {any} */ a, /** @type {any} */ b, /** @type {number} */ k) =>
				['red', 'blue'].find((t) => a[t] === from[t] + k && b[t] === from[t] + k && a[t === 'red' ? 'blue' : 'red'] === from[t === 'red' ? 'blue' : 'red']) ?? null;
			await P.click(A, ball);
			let teamA = null;
			await until(A, async () => (([ra, rb] = await both()), (teamA = roseBy(s0, ra, rb, 1)) !== null), 3000);
			if (!teamA) {
				const one = ra.red !== s0.red || ra.blue !== s0.blue || rb.red !== s0.red || rb.blue !== s0.blue;
				return v(one ? 0.5 : 0, one ? 'a click scored, but the two screens disagree (A ' + ra.red + '/' + ra.blue + ', B ' + rb.red + '/' + rb.blue + ')' : "the host's click scored nothing");
			}
			const s1 = { red: ra.red, blue: ra.blue };
			await P.click(B, ball);
			await P.sleep(B, 400);
			await P.click(B, ball);
			let teamB = null;
			await until(A, async () => (([ra, rb] = await both()), (teamB = roseBy(s1, ra, rb, 2)) !== null), 3000);
			C.note('A on ' + teamA + ', B on ' + teamB + '; scores now red ' + ra.red + ' blue ' + ra.blue);
			if (!teamB) return v(0.5, "the joined player's clicks did not score 2 for one team on both screens (A " + ra.red + '/' + ra.blue + ', B ' + rb.red + '/' + rb.blue + ')');
			if (teamA === teamB) return v(0.5, 'both players are on the same team (' + teamA + ')');
			if (!showsOwnTeam(ra.text, teamA) || !showsOwnTeam(rb.text, teamB)) return v(0.5, 'scores work, but a player is not shown which team they are on');
			return v(1, 'two even teams, own team shown, clicks score for the clicker\'s team everywhere');
		}
	},
	{
		id: 'dialogue-own',
		sync: 'pair',
		say: 'When someone walks up to the old man, show the line "Welcome, traveller!" on that person\'s screen. Only the person standing next to him sees it, not everyone else.',
		setup: (S) =>
			room(S, [{ kind: 'primitive', primitive: 'Cylinder', name: 'Old Man', params: [0.35, 0.35, 1.8], position: [0, 0.9, -4], color: '#806040' }]),
		check: async (C) => {
			const { A, B } = C;
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B))) return v(0, 'Play did not start on both');
			const says = async (/** @type {any} */ page) => {
				const h = await P.hud(page);
				if (/welcome/i.test(h.text + ' ' + Object.values(h.values).join(' '))) return true;
				return (await P.sceneSays(page, '\\bwelcome')).length > 0;
			};
			if (!(await P.holds(A, async () => !(await says(A)) && !(await says(B)), 1500)))
				return v(0, 'the line shows with nobody near the old man');
			await P.walk(A, [[0, 0, -2]]);
			const standA = await P.standAt(A, [0, 0, -2]);
			const seenA = await until(A, () => says(A), 4000);
			const onlyA = seenA >= 0 && (await P.holds(B, async () => !(await says(B)), 2000));
			await standA();
			if (seenA < 0) return v(0, 'walking up to the old man showed no line');
			await P.walk(A, [[0, 0, 8]]);
			await P.walk(B, [[0, 0, -2]]);
			const standB = await P.standAt(B, [0, 0, -2]);
			const seenB = await until(B, () => says(B), 4000);
			await standB();
			C.note('A saw it ' + seenA + ' ms after arriving; B saw it while A stood there: ' + !onlyA + '; B on its own: ' + seenB + ' ms');
			if (!onlyA) return v(0.5, 'the line showed for everyone, not only for the person at the old man');
			if (seenB < 0) return v(0.5, 'works for the host only: the joined player never saw the line');
			return v(1, 'the line shows only for whoever walks up');
		}
	},
	{
		id: 'inventory-respawn',
		say: 'Make the gems pickups: walking into one collects it, and my gem count is on the screen. The lava sends me back to the start — but I keep the gems I already have.',
		setup: (S) =>
			room(S, [
				{ kind: 'primitive', primitive: 'Octahedron', name: 'Gem 1', params: [0.35], position: [-3, 0.8, 3], color: '#30a0f0' },
				{ kind: 'primitive', primitive: 'Octahedron', name: 'Gem 2', params: [0.35], position: [3, 0.8, 3], color: '#30a0f0' },
				{ kind: 'primitive', primitive: 'Octahedron', name: 'Gem 3', params: [0.35], position: [6, 0.8, -6], color: '#30a0f0' },
				{ kind: 'primitive', primitive: 'Box', name: 'Lava', params: [4, 0.2, 3], position: [0, 0.1, -4], color: '#ff4010' }
			]),
		check: async (C) => {
			const A = C.A;
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			const start = await P.playerPos(A);
			await until(A, async () => P.numbersIn(await P.hud(A)).length > 0, 2500);
			const n0 = P.numbersIn(await P.hud(A));
			await P.walk(A, [[-3, 0, 3]]);
			await P.stay(A, [-3, 0, 3], 1000);
			await P.walk(A, [[3, 0, 3]]);
			await P.stay(A, [3, 0, 3], 1000);
			if ((await until(A, async () => rose(n0, P.numbersIn(await P.hud(A)), 2), 2500)) < 0)
				return v(0, 'the gem count on screen did not go up by 2 after two gems (' + (await P.hud(A)).text.slice(0, 100) + ')');
			await P.walk(A, [[0, 0, -4]]);
			const moved = await standUntilMoved(A, [0, 0, -4], 6000);
			if (!moved) return v(0, 'touching the lava did nothing');
			if (Math.hypot(moved[0] - start[0], moved[2] - start[2]) > 2.5) return v(0, 'the lava moved the player, but not back to the start');
			const kept = await P.holds(A, async () => rose(n0, P.numbersIn(await P.hud(A)), 2), 2000);
			C.note('after the respawn: ' + JSON.stringify((await P.hud(A)).text.slice(0, 100)));
			if (!kept) return v(0, 'the gems were lost on the respawn');
			await P.walk(A, [[6, 0, 4], [6, 0, -6]]);
			await P.stay(A, [6, 0, -6], 1000);
			if ((await until(A, async () => rose(n0, P.numbersIn(await P.hud(A)), 3), 2500)) < 0)
				return v(0.5, 'the gems were kept, but a gem picked up after the respawn did not count');
			return v(1, 'collects, keeps the count through a lava respawn');
		}
	},
	{
		id: 'day-night',
		sync: 'pair',
		say: 'Add a day and night switch: clicking the lever turns day into night, and clicking it again turns it back into day, for everyone in the session at once.',
		setup: (S) =>
			room(
				S,
				[{ kind: 'primitive', primitive: 'Box', name: 'Lever', params: [0.3, 1.2, 0.3], position: [0, 0.6, -2], color: '#a06030' }],
				{ facing: [0, 0.8, -2] }
			),
		check: async (C) => {
			const { A, B } = C;
			const lever = C.refs.Lever;
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B))) return v(0, 'Play did not start on both');
			const [dayA, dayB] = [await P.skyLook(A), await P.skyLook(B)];
			/** night = clearly darker than the day it started from */
			const dark = (/** @type {any} */ base, /** @type {any} */ now) =>
				now.light < base.light * 0.6 ||
				(base.bg !== null && now.bg !== null && base.bg - now.bg >= 0.25) ||
				now.exposure < base.exposure * 0.6 ||
				now.envIntensity < base.envIntensity * 0.6;
			const back = (/** @type {any} */ base, /** @type {any} */ now) => !dark(base, now) && now.light >= base.light * 0.8;
			C.note('day A ' + JSON.stringify(dayA));
			await P.click(A, lever);
			const nA = await until(A, async () => dark(dayA, await P.skyLook(A)), 4000);
			const nB = await until(B, async () => dark(dayB, await P.skyLook(B)), 3000);
			C.note('night A ' + JSON.stringify(await P.skyLook(A)));
			if (nA < 0 && nB < 0) return v(0, 'clicking the lever did not make it night');
			if (nA < 0 || nB < 0) return v(0.5, 'night came only on ' + (nA >= 0 ? "the presser's" : "the other player's") + ' screen');
			await P.click(B, lever);
			const dA = await until(A, async () => back(dayA, await P.skyLook(A)), 4000);
			const dB = await until(B, async () => back(dayB, await P.skyLook(B)), 3000);
			if (dA < 0 || dB < 0) return v(0.5, "the joined player's click did not bring the day back for everyone (A " + (dA >= 0) + ', B ' + (dB >= 0) + ')');
			return v(1, 'the lever switches day and night for everyone, both ways');
		}
	},
	{
		id: 'two-plates',
		sync: 'pair',
		say: 'The gate only opens while two people are standing on the two pressure plates at the same time. If either of them steps off, the gate closes again.',
		setup: (S) =>
			room(S, [
				{ kind: 'primitive', primitive: 'Box', name: 'Plate Left', params: [2, 0.1, 2], position: [-4, 0.05, 0], color: '#a0a0b0' },
				{ kind: 'primitive', primitive: 'Box', name: 'Plate Right', params: [2, 0.1, 2], position: [4, 0.05, 0], color: '#a0a0b0' },
				{ kind: 'primitive', primitive: 'Box', name: 'Gate', params: [4, 3, 0.3], position: [0, 1.5, -6], color: '#606060' }
			]),
		check: async (C) => {
			const { A, B } = C;
			const gate = C.refs.Gate;
			const base = C.base.Gate;
			if (!(await P.enterPlay(A)) || !(await P.enterPlay(B))) return v(0, 'Play did not start on both');
			const openOn = async (/** @type {any} */ page) => P.opened(base, await P.look(page, gate));
			await P.walk(A, [[-4, 0, 0]]);
			const standA = await P.standAt(A, [-4, 0, 0]);
			try {
				if (!(await P.holds(A, async () => !(await openOn(A)) && !(await openOn(B)), 3000)))
					return v(0, 'the gate opened with only one person on a plate');
				await P.walk(B, [[4, 0, 0]]);
				const standB = await P.standAt(B, [4, 0, 0]);
				const oA = await until(A, () => openOn(A), 4000);
				const oB = await until(B, () => openOn(B), 3000);
				await standB();
				if (oA < 0 && oB < 0) return v(0, 'two people on the plates did not open the gate');
				if (oA < 0 || oB < 0) return v(0.5, 'the gate opened only on ' + (oA >= 0 ? "the host's" : "the joined player's") + ' screen');
				await P.walk(B, [[4, 0, 6]]);
				const cA = await until(A, async () => !(await openOn(A)), 4000);
				const cB = await until(B, async () => !(await openOn(B)), 3000);
				C.note('opened A ' + oA + ' B ' + oB + ' ms; closed A ' + cA + ' B ' + cB + ' ms after one stepped off');
				if (cA < 0 || cB < 0) return v(0.5, 'the gate stayed open after one person stepped off (A ' + (cA >= 0) + ', B ' + (cB >= 0) + ')');
				return v(1, 'opens only with both plates held, closes when one steps off');
			} finally {
				await standA();
			}
		}
	}
];
