// 31-towers P2: TOWERS — twelve levels, a dozen piece shapes, star ratings and an unlock chain
// for the Towers game template ("more than hooray", the Quest note). A CORE module (it ships
// with the app, like pong), dormant in every scene that does not carry the `Towers game`
// marker object.
//
// WHAT LIVES WHERE
//   levels.js (pure leaf)  the level table, the star rule, unlocks, the rack layout, the tower
//                          measure, the judge, the wind schedule — vitest-covered
//   this file              the scene half: find the arena BY NAME (the def owns the geometry),
//                          deal pieces, judge the round, push gusts, rock the wobble plate,
//                          publish HUD text through a value node, save progress
//   the template def       the arena, the piece TEMPLATES (parked under the floor), the HUD
//                          screens and a small graph: the buttons, P pause, the music, the
//                          Character Controller (walk + jump) — scripts/author-templates.cjs
//
// WHO DECIDES (golden rule 8: one simulator). Everything that CHANGES the shared game — the
// level, the pieces, the verdict, a gust — is done by ONE authority: the physics initiator
// (29-F's lower-id rule settles a race), else, with no simulation anywhere, the lowest peer id.
// A HUD press does not say who pressed, so every peer sees the stamp and only the authority
// acts on it. Everything else is DERIVED per peer from what already replicates — the game
// singleton (state + `tw*` variables), the pieces (ordinary transient duplicates + moves),
// the synced clock — so this module adds NO message of its own except one: a level picked in
// the game shell's own picker (`api.game.levels`, a local callback) is forwarded to the
// authority.
//
// THE PIECES are TRANSIENT duplicates of the templates (B7's spawner shape): the initiator
// makes them, peers receive the ordinary `duplicate`, they never enter undo, and a stopped
// simulation sweeps them. A level change removes the last level's pieces the same way.
//
// This is a core module, so it reaches the spawner's parts (duplicateObject, physicsAddBody,
// removeTransientObject) and the game state setter through PRIMED dynamic imports — never
// static ones: those modules sit in history's import family and a static edge from here would
// close the TDZ cycle (the moduleSDK rule). `api.spawn` deliberately still does not exist
// (the R29 ruling); a core module is allowed the internals, the pong precedent.

import {
	LEVELS, SHAPES, ZONES, RACKS, STATUS, levelById, nextLevelId, supplyCount, goalHeight, starsFor,
	starsText, formatTime, normalizeProgress, mergeResult, isUnlocked, totalStars, layoutSupply, towerPieces,
	towerTop, isOutside, outlineCells, cellsFilled, gustAt, gust, windFrom, judge, verdictTitle, statusName,
	LOST_AFTER, REST_SPEED
} from './levels.js';

/** the marker object that says "this scene is a Towers game" */
const MARKER = 'Towers game';
/** the moving markers */
const GOAL_RING = 'Goal ring';
const YARD_RING = 'Yard ring';
const GHOST_WALL = 'Ghost wall';
/** the Yard ring is authored at this radius; a zone's yard scales it */
const YARD_RING_RADIUS = 3.4;
/** where a marker waits when the level does not use it */
const PARKED = [0, -9, 0];
/** the authority judges ~10x a second */
const JUDGE_EVERY = 0.1;
/** a button stamp older than this (seconds) when first noticed is history, not a press */
const FRESH_PRESS = 2.5;
/** a gust is announced this many seconds before it arrives */
const GUST_WARNING = 1.3;
/** the game variables (the replicated game singleton), all written by the authority only */
const V = {
	level: 'twLevel',
	status: 'twStatus',
	height: 'twHeight', // the tower top now, centimetres
	peak: 'twPeak', // the best this round, centimetres
	left: 'twLeft', // pieces still where they were dealt
	lost: 'twLost',
	hold: 'twHold', // the hold countdown, whole seconds (0 = not holding)
	stars: 'twStars',
	time: 'twTime', // the finishing time, tenths of a second
	used: 'twUsed', // pieces in the finished tower
	filled: 'twFilled', // outline cells filled
	dealt: 'twDealt' // the round the pieces were dealt for
};

export default {
	id: 'towers',
	name: 'Towers',
	version: '2.0.0',
	description:
		'The Towers game: twelve levels of stacking with different shapes, limited reach, jumping, wind and a wobbling plate — stars and unlocks saved on this device.',

	/** @param {any} api */
	register(api) {
		// ---- primed core internals (see the header) -----------------------------------------
		/** @type {any} */ let gs = null; // gameState
		/** @type {any} */ let actions = null; // objectActions
		/** @type {any} */ let phys = null; // physics
		/** @type {any} */ let transient = null; // transientObjects
		/** @type {any} */ let stores = null; // svelte/store get
		Promise.all([
			import('../../lib/gameState'),
			import('../../lib/objectActions'),
			import('../../lib/physics'),
			import('../../lib/transientObjects'),
			import('svelte/store')
		]).then(([a, b, c, d, e]) => {
			gs = a;
			actions = b;
			phys = c;
			transient = d;
			stores = e;
		});
		const THREE = api.THREE;

		// ---- local state (never replicated: everything shared is a game variable) -----------
		/** hudbutton node id -> the stamp we last acted on (the first-sight rule) */
		/** @type {Map<string, number>} */ const seenStamps = new Map();
		/** @type {any} */ let memo = null; // the judge's memory, authority only
		let memoRound = -1;
		let lastJudge = 0;
		let lastGustPushed = -1;
		let gustRound = -1;
		let gustWarned = -1;
		let gustBlown = -1;
		/** uuid -> when it was first seen resting outside the yard */
		/** @type {Map<string, number>} */ const outsideSince = new Map();
		/** uuid -> the last known pose, for the poof when a piece disappears, and landing knocks */
		/** @type {Map<string, {pos: number[], vy: number, t: number}>} */ const lastPose = new Map();
		let announcedRound = -1;
		let finishedRound = -1;
		let starLostRound = -1;
		let progress = normalizeProgress(api.storage?.get?.('progress', null));

		// ---- reading the world --------------------------------------------------------------
		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		const game = () => (gs && stores ? stores.get(gs.gameState) : null);
		/** @param {string} name @param {number=} fallback */
		const v = (name, fallback = 0) => {
			const n = Number(api.game.getVar(name, fallback));
			return Number.isFinite(n) ? n : fallback;
		};
		/** @param {string} name @param {number} value — authority only, and only on change */
		const setV = (name, value) => {
			if (v(name, NaN) !== value) api.game.setVar(name, value);
		};
		const currentLevel = () => levelById(v(V.level, 0));

		/** @param {any} object */
		const worldBox = (object) => {
			object.updateMatrixWorld(true);
			return new THREE.Box3().setFromObject(object);
		};
		/** the zone a level builds on, measured @param {any} level */
		const zoneOf = (level) => {
			const z = ZONES[level?.zone] ?? ZONES.pad;
			const object = byName(z.object);
			if (!object) return { center: [0, 0, 0], top: 0.2, footprint: z.footprint, yard: z.yard };
			const box = worldBox(object);
			return {
				center: [(box.min.x + box.max.x) / 2, 0, (box.min.z + box.max.z) / 2],
				top: box.max.y,
				footprint: z.footprint,
				yard: z.yard
			};
		};
		/** every rack object's world box, by name */
		const rackBoxes = () => {
			/** @type {Record<string, {min: number[], max: number[]}>} */
			const out = {};
			for (const names of Object.values(RACKS))
				for (const name of names) {
					const object = byName(name);
					if (!object) continue;
					const b = worldBox(object);
					out[name] = { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
				}
			return out;
		};
		/** each shape's template object and world size */
		const templates = () => {
			/** @type {Record<string, any>} */ const objects = {};
			/** @type {Record<string, number[]>} */ const sizes = {};
			for (const [shape, def] of Object.entries(SHAPES)) {
				const object = byName(def.template);
				if (!object) continue;
				objects[shape] = object;
				const b = worldBox(object);
				sizes[shape] = [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z];
			}
			return { objects, sizes };
		};
		/** the live pieces: transient copies of a piece template */
		const pieces = () =>
			(group()?.children ?? []).filter(
				(/** @type {any} */ c) => c.userData?.transient && /^Piece /.test(String(c.name ?? ''))
			);
		/** @param {any} object @returns {string} */
		const shapeOf = (object) => {
			const base = String(object.name ?? '').replace(/ copy$/, '');
			return Object.keys(SHAPES).find((k) => SHAPES[k].template === base) ?? 'cube';
		};

		// ---- authority -----------------------------------------------------------------------
		const authority = () => {
			if (!phys || !stores) return false;
			if (stores.get(phys.simulating)) return phys.isInitiator();
			if (stores.get(phys.remoteSimulating)) return false;
			const me = api.peerId();
			if (!me) return true;
			const ids = [me, ...api.peerIds()].filter(Boolean).sort();
			return ids[0] === me;
		};

		// ---- the level lifecycle (authority) --------------------------------------------------
		/** move a marker, replicated (`move`) — only when it is not already there
		 * @param {string} name @param {number[]} pos @param {number[]=} scale */
		const place = (name, pos, scale) => {
			const object = byName(name);
			if (!object) return;
			const same =
				Math.hypot(object.position.x - pos[0], object.position.y - pos[1], object.position.z - pos[2]) < 1e-3 &&
				(!scale || Math.abs(object.scale.x - scale[0]) < 1e-3);
			if (!same) api.moveObject(object.uuid, { pos, ...(scale ? { scale } : {}) });
		};
		/** @param {any} level */
		const placeMarkers = (level) => {
			const zone = zoneOf(level);
			const goal = goalHeight(level);
			if (level.goal.type === 'outline') {
				place(GOAL_RING, PARKED);
				place(GHOST_WALL, [zone.center[0], zone.top + 0.6, zone.center[2]]);
			} else {
				place(GOAL_RING, [zone.center[0], goal, zone.center[2]]);
				place(GHOST_WALL, PARKED);
			}
			const k = zone.yard / YARD_RING_RADIUS;
			place(YARD_RING, [zone.center[0], 0.02, zone.center[2]], [k, k, 1]);
		};

		/** @param {number} id */
		const startLevel = (id) => {
			const level = levelById(id);
			if (!level || !gs) return false;
			if (!isUnlocked(progress, id)) {
				api.announce('Level ' + id + ' is locked', { sub: 'Earn a star on level ' + (id - 1) + ' first', ms: 2200, color: '#ffb86b' });
				return false;
			}
			setV(V.level, id);
			setV(V.status, STATUS.playing);
			for (const key of [V.height, V.peak, V.lost, V.hold, V.stars, V.time, V.used, V.filled]) setV(key, 0);
			setV(V.dealt, -1);
			setV(V.left, supplyCount(level));
			// ENTER playing from elsewhere so the round bumps and the clock restarts (setGameState
			// is a no-op when already playing — the Restart chain's own reason for a detour)
			const state = game()?.state;
			if (state === 'playing' || state === 'paused') gs.setGameState('menu', { outcome: '' });
			gs.setGameState('playing', { outcome: '' });
			placeMarkers(level);
			return true;
		};
		const toMenu = () => {
			if (!gs) return;
			setV(V.status, STATUS.none);
			setV(V.level, 0);
			gs.setGameState('menu', { outcome: '' });
			// the level select stands in an empty arena: the last level's pieces go
			clearPieces();
			place(GOAL_RING, [0, goalHeight(levelById(1)), 0]);
			place(GHOST_WALL, PARKED);
		};
		/** remove every live piece (a new level, a restart) */
		const clearPieces = () => {
			if (!transient || !phys) return;
			for (const object of pieces()) {
				phys.physicsRemoveBody?.(object.uuid);
				transient.removeTransientObject(object.uuid);
			}
		};
		/** deal the level's supply onto the racks — the initiator only (it owns the bodies) */
		/** @param {any} level @param {number} round */
		const deal = (level, round) => {
			if (!actions || !phys || !phys.isInitiator()) return false;
			const { objects, sizes } = templates();
			const slots = layoutSupply(level, rackBoxes(), sizes);
			clearPieces();
			for (const slot of slots) {
				const template = objects[slot.shape];
				if (!template) continue;
				// a slot names where the piece's BOX goes; a building block's origin is on its floor,
				// so carry the template's origin-to-centre offset across
				const tb = worldBox(template);
				const at = [
					slot.pos[0] + template.position.x - (tb.min.x + tb.max.x) / 2,
					slot.pos[1] + template.position.y - (tb.min.y + tb.max.y) / 2,
					slot.pos[2] + template.position.z - (tb.min.z + tb.max.z) / 2
				];
				const clone = actions.duplicateObject(template.uuid, { select: false, history: false, transient: true, at });
				if (!clone) continue;
				if (slot.yaw) api.moveObject(clone.uuid, { rot: [0, slot.yaw, 0] });
				phys.physicsAddBody(clone.uuid);
			}
			setV(V.dealt, round);
			setV(V.left, slots.length);
			return true;
		};

		/** the authority's round judge, ~10x a second */
		/** @param {number} time */
		const judgeRound = (time) => {
			const g = game();
			const level = currentLevel();
			if (!g || g.state !== 'playing' || !level || v(V.status) !== STATUS.playing) return;
			if (time - lastJudge < JUDGE_EVERY) return;
			lastJudge = time;
			if (memoRound !== g.round) {
				memo = null;
				memoRound = g.round;
				outsideSince.clear();
			}
			// deal once per round (and again if a restarted simulation swept the pieces)
			const live = pieces();
			if (v(V.dealt, -1) !== g.round || live.length === 0) {
				if (phys?.isInitiator()) deal(level, g.round);
				return;
			}
			if (!phys?.isInitiator()) return; // only the stepping peer knows speeds and holds
			const bodies = new Map((phys.physicsDebug?.() ?? []).map((/** @type {any} */ b) => [b.uuid, b]));
			const zone = zoneOf(level);
			const racks = Object.values(rackBoxes());
			const elapsed = gs.gameElapsed();
			/** @type {any[]} */
			const snapshot = live.map((/** @type {any} */ object) => {
				const box = worldBox(object);
				const b = bodies.get(object.uuid);
				const lv = b?.linvel;
				return {
					object,
					uuid: object.uuid,
					shape: shapeOf(object),
					pos: [(box.min.x + box.max.x) / 2, (box.min.y + box.max.y) / 2, (box.min.z + box.max.z) / 2],
					min: [box.min.x, box.min.y, box.min.z],
					max: [box.max.x, box.max.y, box.max.z],
					top: box.max.y,
					bottom: box.min.y,
					speed: lv ? Math.hypot(lv.x, lv.y, lv.z) : 0,
					held: !!b?.hold,
					dealtAt: object.userData?.towersSlot ?? null
				};
			});
			// LOST: resting on the floor outside the yard for a moment — it poofs
			let lost = v(V.lost);
			let starLost = false;
			for (const p of snapshot) {
				if (!isOutside(p, zone, racks)) {
					outsideSince.delete(p.uuid);
					continue;
				}
				const since = outsideSince.get(p.uuid) ?? elapsed;
				outsideSince.set(p.uuid, since);
				if (elapsed - since < LOST_AFTER) continue;
				outsideSince.delete(p.uuid);
				if (p.shape === 'star') starLost = true;
				else lost++;
				phys.physicsRemoveBody?.(p.uuid);
				transient.removeTransientObject(p.uuid);
			}
			setV(V.lost, lost);
			const remaining = snapshot.filter((p) => group()?.getObjectByProperty('uuid', p.uuid));
			const top = towerTop(remaining, zone);
			const yardHeld = remaining.some(
				(p) => p.held && Math.hypot(p.pos[0] - zone.center[0], p.pos[2] - zone.center[2]) <= zone.yard
			);
			const cells = level.goal.type === 'outline' ? outlineCells(zone) : [];
			const filled = cells.length ? cellsFilled(cells, remaining) : 0;
			const starPiece = remaining.find((p) => p.shape === 'star');
			const tower = towerPieces(remaining, zone);
			const star = starPiece
				? { top: starPiece.top, inTower: tower.includes(starPiece) }
				: null;
			const r = judge(level, { elapsed, top, filled, cells: cells.length, star, anyHeld: yardHeld, lost, starLost }, memo);
			memo = r.memo;
			setV(V.height, Math.round(top * 100));
			setV(V.peak, Math.round(r.memo.peak * 100));
			setV(V.hold, r.hold);
			setV(V.filled, filled);
			// pieces still on the racks = resting over a rack box, above it
			setV(
				V.left,
				remaining.filter((p) => racks.some((b) => p.pos[0] >= b.min[0] && p.pos[0] <= b.max[0] && p.pos[2] >= b.min[2] && p.pos[2] <= b.max[2] && p.bottom >= b.max[1] - 0.05)).length
			);
			// the wind: the stepping peer pushes; every peer warns and shows it (below)
			if (level.wind) {
				if (gustRound !== g.round) {
					gustRound = g.round;
					lastGustPushed = -1;
				}
				const gNow = gustAt(level, elapsed);
				if (gNow && gNow.index > lastGustPushed) {
					lastGustPushed = gNow.index;
					for (const p of remaining) {
						if (p.held || p.top < 0.9) continue;
						const mass = Number(p.object.userData?.physics?.mass) || 1;
						// higher pieces feel more of it
						const k = gNow.strength * mass * Math.min(1.6, 0.5 + p.top / 3);
						api.physics.applyImpulse(p.uuid, [gNow.dir[0] * k, 0.05 * k, gNow.dir[2] * k]);
					}
				}
			}
			if (r.verdict) finish(level, r.verdict, { elapsed, pieces: tower.length });
		};

		/** @param {any} level @param {string} verdict @param {{elapsed: number, pieces: number}} result */
		const finish = (level, verdict, result) => {
			const won = verdict === 'won';
			const stars = starsFor(level, { won, time: result.elapsed, pieces: result.pieces });
			setV(V.stars, stars);
			setV(V.time, Math.round(result.elapsed * 10));
			setV(V.used, result.pieces);
			setV(V.hold, 0);
			setV(V.status, STATUS[/** @type {keyof typeof STATUS} */ (verdict)] ?? STATUS.time);
			gs.setGameState('over', { outcome: verdictTitle(verdict) });
		};

		// ---- the buttons: every peer watches the stamps, the authority acts ------------------
		/** hudbutton element -> what it does */
		/** @param {string} element */
		const onPress = (element) => {
			const level = v(V.level, 0);
			const lvl = /^lvl-(\d+)$/.exec(element);
			if (lvl) return startLevel(Number(lvl[1]));
			if (element === 'retry-btn' || element === 'restart-btn') return level ? startLevel(level) : false;
			if (element === 'next-btn') {
				const next = nextLevelId(level);
				if (next && isUnlocked(progress, next)) return startLevel(next);
				if (!next) {
					api.announce('That was the last level', { sub: 'Every level is yours — try for three stars', ms: 2400, color: '#ffd45e' });
					return toMenu();
				}
				api.announce('Level ' + next + ' is locked', { sub: 'Win this level to open it', ms: 2200, color: '#ffb86b' });
				return false;
			}
			if (element === 'levels-btn' || element === 'quit-btn') return toMenu();
			return false;
		};
		/** each peer: find FRESH presses; the authority applies them */
		const watchButtons = () => {
			const amAuthority = authority();
			for (const node of api.flow.nodes('hudbutton')) {
				const element = String(node.data?.element ?? '');
				if (!/^(lvl-\d+|next-btn|retry-btn|levels-btn|restart-btn|quit-btn)$/.test(element)) continue;
				const entry = api.flow.triggerStamp(node.id);
				const stamp = Number(entry?.stamp) || 0;
				// FIRST SIGHT: whatever the node already carries is history, never a press
				if (!seenStamps.has(node.id)) {
					seenStamps.set(node.id, stamp);
					continue;
				}
				if (stamp === seenStamps.get(node.id)) continue;
				// ...and so is a stamp that ARRIVES old (a joiner's trigger-log reply)
				const fresh = Number(entry?.age ?? 0) < FRESH_PRESS;
				seenStamps.set(node.id, stamp);
				// a locked level says so on the peer that sees it, whoever decides
				const lvl = /^lvl-(\d+)$/.exec(element);
				if (!fresh) continue;
				if (lvl && !amAuthority && !isUnlocked(progress, Number(lvl[1])))
					api.announce('Level ' + lvl[1] + ' is locked', { sub: 'Earn a star on level ' + (Number(lvl[1]) - 1) + ' first', ms: 2200, color: '#ffb86b' });
				if (amAuthority) onPress(element);
			}
		};

		// ---- every peer: the moments ---------------------------------------------------------
		/** @param {number} time */
		const moments = (time) => {
			const g = game();
			const level = currentLevel();
			if (!g || !level) return;
			const status = v(V.status);
			// a round starts: the intro banner
			if (g.state === 'playing' && status === STATUS.playing && announcedRound !== g.round) {
				announcedRound = g.round;
				finishedRound = -1;
				const goal = level.goal.type === 'outline' ? 'Fill the ghost wall' : level.goal.type === 'deliver' ? 'The star on top at ' + goalHeight(level).toFixed(1) + ' m' : 'Tower to ' + goalHeight(level).toFixed(1) + ' m';
				api.announce('Level ' + level.id + ' · ' + level.name, { sub: goal + ' — ' + level.intro, ms: 4200, color: '#ffd45e' });
				api.playSound('whistle');
			}
			// the wind: warn, then show it
			if (g.state === 'playing' && level.wind && gs) {
				const elapsed = gs.gameElapsed();
				const current = gustAt(level, elapsed);
				const nextIndex = current ? current.index + 1 : 0;
				const next = gust(level, nextIndex);
				if (next.at - elapsed <= GUST_WARNING && gustWarned < nextIndex + g.round * 1000) {
					gustWarned = nextIndex + g.round * 1000;
					api.announce('Gust from the ' + windFrom(next.dir) + '!', { ms: 1300, color: '#9ee6ff' });
				}
				if (current && gustBlown < current.index + g.round * 1000) {
					gustBlown = current.index + g.round * 1000;
					api.playSound('whoosh');
					const zone = zoneOf(level);
					api.effects.burst([zone.center[0] - current.dir[0] * 1.5, Math.max(1, v(V.height) / 100), zone.center[2] - current.dir[2] * 1.5], { kind: 'smoke', count: 48 });
				}
			}
			// a round ends: stars saved on THIS device (every peer earns them), the moment
			if (g.state === 'over' && finishedRound !== g.round && status >= STATUS.won) {
				finishedRound = g.round;
				if (status === STATUS.won) {
					const stars = v(V.stars);
					progress = mergeResult(progress, level.id, { stars, time: v(V.time) / 10, pieces: v(V.used) });
					api.storage?.set?.('progress', progress);
					publishLevels();
					api.playSound('levelup');
					api.hapticPattern('success');
					const zone = zoneOf(level);
					api.effects.burst([zone.center[0], Math.max(1.2, v(V.height) / 100), zone.center[2]], { kind: 'confetti', count: 96 });
				} else {
					api.playSound('fail');
					api.hapticPattern('fail');
				}
			}
			// pieces: a poof where one vanished mid-round, a knock where one landed
			const now = pieces();
			const alive = new Set(now.map((/** @type {any} */ o) => o.uuid));
			for (const [uuid, pose] of lastPose) {
				if (alive.has(uuid)) continue;
				lastPose.delete(uuid);
				if (g.state === 'playing' && time - pose.t < 1) {
					api.effects.burst(pose.pos, { kind: 'smoke', count: 36 });
					api.playSound('pop', pose.pos);
				}
			}
			for (const object of now) {
				const p = object.position;
				const was = lastPose.get(object.uuid);
				const dt = was ? Math.max(1e-3, time - was.t) : 0;
				const vy = was ? (p.y - was.pos[1]) / dt : 0;
				if (was && was.vy < -2.4 && vy > -0.6 && g.state === 'playing') api.playSound('hit', [p.x, p.y, p.z]);
				lastPose.set(object.uuid, { pos: [p.x, p.y, p.z], vy, t: time });
			}
		};

		// ---- the HUD's words: one value node, every peer computes the same line ---------------
		/** @param {any} data @returns {any} */
		const info = (data) => {
			const read = String(data?.read ?? 'title');
			const level = currentLevel();
			if (read === 'levelStars') {
				const id = Number(data?.level) || 0;
				if (!levelById(id)) return '';
				if (!isUnlocked(progress, id)) return '🔒 locked';
				const row = progress.levels[String(id)];
				return row ? starsText(row.stars) : '☆☆☆';
			}
			if (read === 'levelName') {
				const l = levelById(Number(data?.level) || 0);
				return l ? l.id + ' · ' + l.name : '';
			}
			if (read === 'menuLine') return 'Stars earned: ' + totalStars(progress) + ' / ' + LEVELS.length * 3;
			if (!level) return read === 'progress' || read === 'height' || read === 'goal' ? 0 : '';
			const goal = goalHeight(level);
			const height = v(V.height) / 100;
			switch (read) {
				case 'title':
					return 'Level ' + level.id + ' · ' + level.name;
				case 'goalText':
					// short: the VR strip keeps lines of 28 characters or fewer
					if (level.goal.type === 'outline') return 'Ghost wall ' + v(V.filled) + ' / 6 filled';
					if (level.goal.type === 'deliver') return 'Star on top · ' + goal.toFixed(1) + ' m';
					return 'Goal ' + goal.toFixed(1) + ' m · now ' + height.toFixed(1) + ' m';
				case 'goal':
					return goal;
				case 'height':
					return height;
				case 'progress':
					return level.goal.type === 'outline' ? v(V.filled) / 6 : goal > 0 ? Math.min(1, height / goal) : 0;
				case 'pieces':
					return 'Rack ' + v(V.left) + ' · lost ' + v(V.lost) + '/' + level.lost;
				case 'clock': {
					const g = game();
					const elapsed = g?.state === 'playing' && gs ? gs.gameElapsed() : 0;
					return formatTime(level.limit - elapsed);
				}
				case 'hold': {
					const n = v(V.hold);
					return n > 0 ? 'Hold steady… ' + n : '';
				}
				case 'rule':
					return level.rule ?? 'Reach is limited to your arm — carry pieces close. Jump: Space / A.';
				case 'result':
					return verdictTitle(statusName(v(V.status)));
				case 'resultStars':
					return v(V.status) === STATUS.won ? starsText(v(V.stars)) : '☆☆☆';
				case 'resultLine': {
					if (v(V.status) !== STATUS.won) {
						const why = { time: 'The clock ran out.', fell: 'It came down — build wider at the bottom.', lost: 'Too many pieces fell outside the yard.', star: 'The star fell outside the yard.' }[statusName(v(V.status))] ?? '';
						return why + '  Best tower ' + (v(V.peak) / 100).toFixed(1) + ' m.';
					}
					return 'Time ' + formatTime(v(V.time) / 10) + ' (par ' + formatTime(level.par.time) + ')   ·   ' + v(V.used) + ' pieces (par ' + level.par.pieces + ')';
				}
				case 'resultBest': {
					const row = progress.levels[String(level.id)];
					return row ? 'Best on this device: ' + starsText(row.stars) + '  ' + formatTime(row.time) : '';
				}
				default:
					return '';
			}
		};
		// an EMPTY string would reach HUD Text as an empty format, which prints the value ("0");
		// a space draws nothing and the VR overlay drops whitespace-only lines
		api.registerValueNode(
			'towersinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);

		// ---- the wobble plate: a module effect, so the runtime makes it KINEMATIC -------------
		api.registerEffect('towerswobble', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data, /** @type {number} */ time) => {
			const level = currentLevel();
			const on = level?.zone === 'wobble' && game()?.state === 'playing';
			const amp = on ? Number(data?.amplitude ?? 0.07) || 0 : 0;
			const period = Math.max(1, Number(data?.period ?? 3.4) || 3.4);
			// the runtime's base is {pos, rot: [x, y, z], scale} — plain arrays
			const rot = base?.rot ?? [0, 0, 0];
			object.rotation.x = rot[0] + amp * Math.sin((2 * Math.PI * time) / period);
			object.rotation.z = rot[2] + amp * 0.7 * Math.sin((2 * Math.PI * time) / (period * 1.37) + 1.1);
		});

		api.registerNodeGroup({
			group: 'Towers',
			items: [
				{
					type: 'towersinfo',
					label: 'Towers info',
					defaults: { read: 'title', level: 1 },
					params: [
						{ key: 'read', kind: 'select', options: ['title', 'goalText', 'goal', 'height', 'progress', 'pieces', 'clock', 'hold', 'rule', 'result', 'resultStars', 'resultLine', 'resultBest', 'levelName', 'levelStars', 'menuLine'] },
						{ key: 'level', kind: 'range', min: 1, max: LEVELS.length, step: 1 }
					]
				},
				{
					type: 'towerswobble',
					label: 'Towers wobble',
					defaults: { amplitude: 0.07, period: 3.4 },
					params: [
						{ key: 'amplitude', kind: 'range', min: 0, max: 0.2, step: 0.01 },
						{ key: 'period', kind: 'range', min: 1, max: 10, step: 0.1 }
					]
				}
			]
		});

		// ---- the game shell's level picker, when the app has one (31-game-shell) -------------
		/** @type {any} */ let levelsOff = null;
		const publishLevels = () => {
			if (typeof api.game?.levels !== 'function' || !active()) return;
			try {
				levelsOff = api.game.levels({
					list: LEVELS.map((l) => ({
						id: String(l.id),
						label: l.id + ' · ' + l.name,
						locked: !isUnlocked(progress, l.id),
						stars: progress.levels[String(l.id)]?.stars ?? 0
					})),
					current: v(V.level, 0) ? String(v(V.level, 0)) : undefined,
					onPick: (/** @type {any} */ id) => pick(Number(id))
				});
			} catch (error) {
				console.log('towers: level picker', error);
			}
		};
		/** a level chosen on THIS peer outside the HUD (the shell's picker, its Restart) — the
		 * authority applies it, so a non-authority forwards it @param {number} id */
		const pick = (id) => {
			if (!levelById(id)) return;
			if (authority()) startLevel(id);
			else api.send({ op: 'pick', level: id });
		};
		// the shell's Restart restarts the level you are on; its How to play is ours
		if (typeof api.game?.onRestart === 'function')
			api.game.onRestart(() => {
				if (active() && v(V.level, 0)) pick(v(V.level, 0));
			});
		const HELP = [
			'Build a tower to the gold ring. Carry pieces from the racks to the glowing zone.',
			'You can only grab what is close to your body (about 1.3 m): build steps, climb them, and JUMP (Space / A) to reach higher.',
			'A finished tower must hold still for 3 seconds. Pieces left outside the glowing yard are lost.',
			'Stars: one for finishing, one for par pieces, one for par time. A star opens the next level.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		api.onMessage((/** @type {any} */ msg) => {
			if (msg?.op === 'pick' && authority()) startLevel(Number(msg.level));
		});

		// ---- the frame --------------------------------------------------------------------------
		let wasActive = false;
		api.registerFrameTask((/** @type {number} */ time) => {
			if (!gs || !stores) return;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on) publishLevels();
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				if (!on && helpOff) {
					helpOff();
					helpOff = null;
				}
				if (!on && typeof levelsOff === 'function') {
					levelsOff();
					levelsOff = null;
				}
			}
			if (!on) return;
			watchButtons();
			if (authority()) judgeRound(time);
			moments(time);
		});
		api.onSceneClear(() => {
			// 33 (L4): the scene that was a Towers game is going — its levels and How to play
			// leave the shell WITH it. Resetting `wasActive` alone left both registered (the
			// frame's edge saw false -> false), so the next game's pause menu showed Towers'
			// twelve levels.
			if (helpOff) {
				helpOff();
				helpOff = null;
			}
			if (typeof levelsOff === 'function') {
				levelsOff();
				levelsOff = null;
			}
			seenStamps.clear();
			lastPose.clear();
			outsideSince.clear();
			memo = null;
			announcedRound = -1;
			finishedRound = -1;
			wasActive = false;
		});

		// the suites' window onto the module (read-only, plus a scripted start)
		/** @type {any} */ (globalThis).__towers = {
			levels: LEVELS,
			progress: () => progress,
			resetProgress: () => {
				progress = normalizeProgress(null);
				api.storage?.remove?.('progress');
				publishLevels();
			},
			/** a suite's shortcut to a progress state, written through api.storage like a win */
			setProgress: (/** @type {any} */ raw) => {
				progress = normalizeProgress(raw);
				api.storage?.set?.('progress', progress);
				publishLevels();
				return progress;
			},
			reloadProgress: () => {
				progress = normalizeProgress(api.storage?.get?.('progress', null));
				return progress;
			},
			authority,
			pieces: () => pieces().map((/** @type {any} */ o) => ({ uuid: o.uuid, name: o.name, shape: shapeOf(o), pos: o.position.toArray() })),
			info,
			vars: () => Object.fromEntries(Object.values(V).map((k) => [k, api.game.getVar(k, null)])),
			zone: () => zoneOf(currentLevel()),
			startLevel,
			/** evidence shots: end the running level with a verdict, the judge's own path */
			finishNow: (/** @type {string} */ verdict) => {
				const level = currentLevel();
				if (level && gs && game()?.state === 'playing') finish(level, verdict, { elapsed: gs.gameElapsed(), pieces: Math.min(level.par.pieces, supplyCount(level)) });
			}
		};
	}
};
