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
}

/** wait until `fn` says yes (polling) @param {any} page @param {() => Promise<boolean>} fn @param {number} ms @param {number} [step] */
async function until(page, fn, ms, step = 200) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) {
		if (await fn()) return Date.now() - t0;
		await P.sleep(page, step);
	}
	return -1;
}

/** @param {number} score @param {string} why @returns {Verdict} */
const v = (score, why) => ({ score, why });

/** some number in `after` is `k` more than a number in `before` (and new) @param {number[]} before @param {number[]} after @param {number} k */
export const rose = (before, after, k) =>
	after.some((b) => !before.includes(b) && before.some((a) => Math.abs(b - a - k) < 1e-6));

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
	return (
		/\b(you\s*win|you\s*won|win|won|victory)\b/i.test(
			h.text + ' ' + Object.values(h.values).join(' ')
		) ||
		(g?.state === 'over' && /win|won/i.test(String(g?.outcome ?? '')))
	);
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
			await P.sleep(A, 1200);
			if (!P.lit(C.base['Star 1'], await P.look(A, s1)))
				return v(0, 'clicking a lit star again turned it off');
			await P.click(A, s3);
			if ((await until(A, async () => P.lit(C.base['Star 3'], await P.look(A, s3)), 2500)) < 0)
				return v(0, 'a second star did not light up');
			const r = await P.restartRound(A);
			C.note('restart ' + JSON.stringify(r));
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
				await P.sleep(A, 500);
			}
			await P.sleep(A, 1200);
			let litN = 0;
			for (let i = 0; i < 4; i++)
				if (P.lit(C.base['Star ' + (i + 1)], await P.look(A, stars[i]))) litN++;
			if (litN < 4) return v(0, 'only ' + litN + ' of 4 clicked stars lit up');
			if (await winShowing(A)) return v(0, 'the win shows with only four stars lit');
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
			await P.sleep(A, 800);
			const n0 = P.numbersIn(await P.hud(A));
			for (let i = 0; i < 3; i++) {
				await P.click(A, C.refs.Target);
				await P.sleep(A, 500);
			}
			await P.sleep(A, 800);
			const h1 = await P.hud(A);
			const n1 = P.numbersIn(h1);
			C.note(
				'hud before ' +
					JSON.stringify(n0) +
					' after 3 clicks ' +
					JSON.stringify(h1.text).slice(0, 160)
			);
			if (!rose(n0, n1, 3))
				return v(0, 'the score on screen did not go up by 3 after three clicks');
			await P.restartRound(A);
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
			await P.sleep(A, 900);
			if (!rose(n2, P.numbersIn(await P.hud(A)), 1))
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
			if (!(await P.enterPlay(A))) return v(0, 'Play did not start');
			await P.restartRound(A);
			/** @type {number[]} */
			let c1 = [];
			await until(
				A,
				async () =>
					(c1 = P.clocksIn(await P.hud(A)).filter((s) => s >= 100 && s <= 120)).length > 0,
				3000
			);
			if (!c1.length)
				return v(
					0,
					'no clock near 2:00 on the screen at the start of a round (' +
						(await P.hud(A)).text.slice(0, 100) +
						')'
				);
			await P.sleep(A, 5000);
			const c2 = P.clocksIn(await P.hud(A));
			const fell = c2.some((x) => c1[0] - x >= 3 && c1[0] - x <= 8);
			C.note('clock ' + c1[0] + ' then ' + JSON.stringify(c2));
			if (!fell) return v(0, 'the clock did not count down over 5 s');
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
			await P.sleep(A, 600);
			const t1 = await turning(1500);
			const g1 = await P.game(A);
			C.note('after P: fan ' + t1.toFixed(1) + '° in 1.5 s, game ' + g1?.state);
			if (t1 > 2) return v(0, 'P did not pause: the fan kept turning');
			await P.press(A, 'p');
			await P.sleep(A, 600);
			const t2 = await turning(1000);
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
			await P.restartRound(A);
			await P.stay(A, [0, 0, 8], 1000);
			await P.walk(A, [[0, 0, -7.6]], 3);
			await P.stay(A, [0, 0, -7.6], 2500);
			const h1 = await P.hud(A);
			const times = [...P.numbersIn(h1), ...P.clocksIn(h1)].filter((x) => x >= 4 && x <= 14);
			C.note('after the run: ' + JSON.stringify(h1.text).slice(0, 160));
			if (!times.length)
				return v(0, 'no time of about 6-7 s on the screen after reaching the flag');
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
			await P.sleep(A, 1000);
			const [a0, b0] = [P.numbersIn(await P.hud(A)), P.numbersIn(await P.hud(B))];
			await P.walk(B, [[0, 0, 0]]);
			await P.stay(B, [0, 0, 0], 1500);
			await P.walk(B, [[0, 0, -4]]);
			await P.sleep(A, 1500);
			const gone = async (/** @type {any} */ page) => {
				const l = await P.look(page, coin);
				return !l || !l.shown || l.opacity < 0.2;
			};
			const [goneA, goneB] = [await gone(A), await gone(B)];
			const [a1, b1] = [P.numbersIn(await P.hud(A)), P.numbersIn(await P.hud(B))];
			const upB = rose(b0, b1, 1);
			const upA = rose(a0, a1, 1);
			C.note(`B walked through: gone A=${goneA} B=${goneB}; count up A=${upA} B=${upB}`);
			if (goneA && goneB && upB && !upA)
				return v(1, 'the toucher collects it, gone for everyone, only their count rises');
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
				await P.sleep(A, 1000);
				if ((await gone(A)) && rose(a0, P.numbersIn(await P.hud(A)), 1))
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
			await P.sleep(A, 2500);
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
			await P.sleep(A, 7000); // whatever the first entry started has run out
			await P.restartRound(A);
			const t0 = Date.now() - 1200; // restartRound waits 1.2 s after the press
			/** @type {string[]} */
			const seen = [];
			let openAt = -1;
			let closedAgainAfterRestart = false;
			while (Date.now() - t0 < 8000) {
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
			await P.sleep(A, 1000);
			const one = (await P.soundsSince(A, t)).length;
			if (one < 1) return v(0, 'no sound when the bell was hit');
			await P.sleep(A, 800);
			t = await P.pageNow(A);
			for (let i = 0; i < 13; i++) {
				await P.click(A, bell);
				await P.sleep(A, 80);
			}
			await P.sleep(A, 400);
			const burst = (await P.soundsSince(A, t)).length;
			C.note(`background ${background}/1.5 s, one hit ${one}, 13 hits in ~1.1 s → ${burst} sounds`);
			if (background > 0) C.note('sounds play with nobody hitting the bell');
			if (burst > 3 + background)
				return v(
					0,
					'more than one ding per half second when clicking fast (' + burst + ' in ~1.5 s)'
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
			await P.sleep(A, 1000);
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
			if (Math.hypot(movedTo[0] - 0, movedTo[2] - 8) > 2.5)
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
			await P.walk(A, [[0, 0, -5]]);
			const first = await standUntilMoved(A, [0, 0, -5], 6000);
			if (!first) return v(0, 'touching the lava did nothing');
			if (Math.hypot(first[0], first[2] - 10) > 2.5)
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
					JSON.stringify(second?.map((n) => +n.toFixed(1)))
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
			await P.sleep(B, 4000);
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
	}
];
