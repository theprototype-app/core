// 35 TARGET TOSS — throw balls at tin cans, swinging targets, pop-ups and a moving cart.
// A CORE module (the towers precedent: it reaches core internals through PRIMED dynamic imports),
// dormant in every scene that does not carry the `Target Toss game` marker object.
//
// WHO DECIDES (golden rule 8): ONE authority — the physics initiator, else the lowest peer id —
// deals the balls and cans (transient duplicates of the templates parked under the floor), judges
// hits ~every frame, scores through kit.score and ends the stage through kit.round. Everything
// else is DERIVED per peer: the swinging/pop-up/cart targets are module EFFECTS (kinematic, a pure
// function of the clock and the replicated game variables), the HUD words come from one value
// node. Two messages: `throw` (a desktop charge-throw forwarded to the authority) and `fx` (the
// authority's hit moment, so every peer bursts and plays the sound where it happened).
//
// THROWING: VR grabs a ball from the shelf with the grip and throws it (core's grip release
// velocity). Desktop: grab a ball the same way, or HOLD the mouse to charge and RELEASE to throw
// one from the shelf along the view — the authority moves a resting ball to your hand and gives
// it the velocity (physics.applyThrow, the peer-throw path).

import {
	STAGES, stageById, POPUP_COUNT, SWING_COUNT, BALL_SLOTS, POINTS, COMBO_WINDOW, COMBO_MAX,
	pyramid, canCount, targetCount, starsFor, starsText, formatTime, popupsUp, swingOffset, cartOffset
} from './stages.js';

const MARKER = 'Target Toss game';
const BALL_TEMPLATE = 'Ball template';
const CAN_TEMPLATE = 'Can template';
const SHELF = 'Ball shelf';
/** a button stamp older than this (s) when first noticed is history */
const FRESH_PRESS = 2.5;
/** the hit test: a ball this close to a target's centre, moving at least this fast */
const HIT_RADIUS = { swing: 0.42, popup: 0.36, cart: 0.5 };
const HIT_SPEED = 1.2;
/** a ball off the shelf that has rested this long (or fell out of the world) goes back */
const BALL_RETURN_AFTER = 1.6;
/** the desktop charge: full power after this many seconds */
const CHARGE_FULL = 0.9;
const THROW_MIN = 6.5;
const THROW_MAX = 16;
/** game variables (the replicated game singleton), written by the authority only */
const V = {
	stage: 'ttStage',
	status: 'ttStatus', // 0 none, 1 playing, 2 won, 3 lost
	dealt: 'ttDealt',
	cans: 'ttCans', // cans still on the tables
	swing: 'ttSwing', // bitmask of swinging targets hit
	pops: 'ttPops', // pop-ups hit
	popDown: 'ttPopDown', // slot * 16 + bitmask of pop-ups knocked down in this slot
	cart: 'ttCart', // cart hits
	combo: 'ttCombo',
	stars: 'ttStars',
	time: 'ttTime', // finishing time, tenths
	score: 'ttScore'
};
const STATUS = { none: 0, playing: 1, won: 2, lost: 3 };

export default {
	id: 'targettoss',
	name: 'Target Toss',
	version: '1.0.0',
	description: 'The Target Toss game: throw balls at tin-can pyramids, swinging targets, pop-ups and a moving cart — five stages, combos, stars saved on this device.',

	/** @param {any} api */
	register(api) {
		/** @type {any} */ let gs = null;
		/** @type {any} */ let actions = null;
		/** @type {any} */ let phys = null;
		/** @type {any} */ let transient = null;
		/** @type {any} */ let stores = null;
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
		const kit = api.kit;
		kit.score.useGame('targettoss');

		/** @type {Map<string, number>} */ const seenStamps = new Map();
		/** authority-local: the cans already scored, the last hit time, per-ball rest timers */
		/** @type {Set<string>} */ const scored = new Set();
		/** @type {Map<string, number>} */ const restSince = new Map();
		/** @type {Map<string, number>} */ const lastHitAt = new Map();
		let lastComboAt = -99;
		let judgedRound = -1;
		let announcedRound = -1;
		let finishedRound = -1;
		let starting = false;
		/** desktop charge (local) */
		let chargeStart = 0;
		let charging = false;

		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		/** @param {string} name @param {number=} fallback */
		const v = (name, fallback = 0) => {
			const n = Number(api.game.getVar(name, fallback));
			return Number.isFinite(n) ? n : fallback;
		};
		/** @param {string} name @param {number} value */
		const setV = (name, value) => {
			if (v(name, NaN) !== value) api.game.setVar(name, value);
		};
		const stage = () => stageById(v(V.stage, 0));
		const phase = () => String(kit.round.phase?.() ?? '');
		const roundNo = () => Number(kit.round.number?.() ?? 0) || 0;
		const elapsed = () => Number(kit.round.elapsed?.() ?? 0) || 0;
		const now = () => performance.now() / 1000;

		/** @param {any} object */
		const worldBox = (object) => {
			object.updateMatrixWorld(true);
			return new THREE.Box3().setFromObject(object);
		};
		/** @param {any} object @returns {number[]} */
		const worldPos = (object) => {
			object.updateMatrixWorld(true);
			const p = new THREE.Vector3().setFromMatrixPosition(object.matrixWorld);
			return [p.x, p.y, p.z];
		};
		/** live transient copies of a template @param {string} template */
		const copiesOf = (template) =>
			(group()?.children ?? []).filter(
				(/** @type {any} */ c) => c.userData?.transient && String(c.name ?? '').replace(/ copy$/, '') === template
			);
		const balls = () => copiesOf(BALL_TEMPLATE);
		const cans = () => copiesOf(CAN_TEMPLATE);

		const authority = () => {
			if (!phys || !stores) return false;
			if (stores.get(phys.simulating)) return phys.isInitiator();
			if (stores.get(phys.remoteSimulating)) return false;
			const me = api.peerId();
			if (!me) return true;
			const ids = [me, ...api.peerIds()].filter(Boolean).sort();
			return ids[0] === me;
		};
		const stepping = () => !!(phys && stores && stores.get(phys.simulating) && phys.isInitiator());

		// ---- the stage lifecycle (authority) ------------------------------------------------
		const clearCopies = () => {
			if (!transient || !phys) return;
			for (const o of [...balls(), ...cans()]) {
				phys.physicsRemoveBody?.(o.uuid);
				transient.removeTransientObject(o.uuid);
			}
		};
		/** @param {any} s */
		const resetVars = (s) => {
			setV(V.stage, s.id);
			setV(V.status, STATUS.playing);
			for (const k of [V.swing, V.pops, V.popDown, V.cart, V.combo, V.stars, V.time, V.score]) setV(k, 0);
			setV(V.cans, canCount(s));
			setV(V.dealt, -1);
			scored.clear();
			restSince.clear();
			lastHitAt.clear();
			lastComboAt = -99;
		};
		/** @param {number} id @param {boolean=} force skip the unlock rule (suites, evidence) */
		const startStage = (id, force = false) => {
			const s = stageById(id);
			if (!s || !gs) return false;
			const row = kit.levels.table?.().find((/** @type {any} */ r) => r.id === String(id));
			if (row?.locked && !force) {
				api.announce('Stage ' + id + ' is locked', { sub: 'Clear stage ' + (id - 1) + ' first', ms: 2200, color: '#ffb86b' });
				return false;
			}
			resetVars(s);
			kit.levels.select(String(id));
			kit.round.configure(2, s.limit, 'lose', 2);
			starting = true;
			try {
				kit.round.restart();
			} finally {
				starting = false;
			}
			return true;
		};
		const toMenu = () => {
			setV(V.status, STATUS.none);
			setV(V.stage, 0);
			kit.round.toMenu();
			clearCopies();
		};

		/** @param {string} templateName @param {number[]} at */
		const spawnCopy = (templateName, at) => {
			const template = byName(templateName);
			if (!template || !actions || !phys) return null;
			const clone = actions.duplicateObject(template.uuid, { select: false, history: false, transient: true, at });
			if (clone) phys.physicsAddBody(clone.uuid);
			return clone;
		};
		/** the shelf slot positions (world) */
		const shelfSlots = () => {
			const shelf = byName(SHELF);
			if (!shelf) return BALL_SLOTS.map((x) => [x, 1.12, 1.8]);
			const b = worldBox(shelf);
			const cx = (b.min.x + b.max.x) / 2;
			const cz = (b.min.z + b.max.z) / 2;
			return BALL_SLOTS.map((x) => [cx + x, b.max.y + 0.115, cz]);
		};
		/** deal the stage: the cans on their tables, six balls on the shelf (initiator only) */
		/** @param {any} s @param {number} round */
		const deal = (s, round) => {
			if (!stepping()) return false;
			clearCopies();
			for (const stack of s.cans) {
				const table = byName(stack.table);
				if (!table) continue;
				const b = worldBox(table);
				for (const p of pyramid(stack.rows, (b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2)) spawnCopy(CAN_TEMPLATE, p);
			}
			for (const p of shelfSlots()) spawnCopy(BALL_TEMPLATE, p);
			setV(V.dealt, round);
			setV(V.cans, canCount(s));
			return true;
		};

		// ---- the judge (authority, the stepping peer) ----------------------------------------
		/** @param {string} key @param {number} points @param {number[]} at @param {string} kind */
		const score = (key, points, at, kind) => {
			const t = elapsed();
			const combo = t - lastComboAt <= COMBO_WINDOW ? Math.min(COMBO_MAX, v(V.combo, 0) + 1) : 1;
			lastComboAt = t;
			setV(V.combo, combo);
			const pts = points * combo;
			setV(V.score, v(V.score) + pts);
			kit.score.add(pts);
			const fx = { op: 'fx', kind, at, pts, combo };
			api.send(fx);
			moment(fx);
			void key;
		};
		/** @param {any} s */
		const judge = (s) => {
			if (!stepping()) return;
			const bodies = new Map((phys.physicsDebug?.() ?? []).map((/** @type {any} */ b) => [b.uuid, b]));
			const t = now();
			// the cans: on a table = inside its box in x/z and above its top; anything else is down
			const tables = s.cans.map((/** @type {any} */ c) => byName(c.table)).filter(Boolean).map((/** @type {any} */ o) => worldBox(o));
			let standing = 0;
			for (const can of cans()) {
				const p = can.position;
				const on = tables.some((/** @type {any} */ b) => p.x >= b.min.x - 0.02 && p.x <= b.max.x + 0.02 && p.z >= b.min.z - 0.02 && p.z <= b.max.z + 0.02 && p.y > b.max.y);
				if (on) standing++;
				else if (!scored.has(can.uuid)) {
					scored.add(can.uuid);
					score(can.uuid, POINTS.can, [p.x, p.y, p.z], 'can');
				}
			}
			setV(V.cans, standing);
			// the balls: hits on the moving targets, and the return to the shelf
			const slots = shelfSlots();
			const live = balls();
			/** @type {Set<number>} */ const taken = new Set();
			for (const ball of live) {
				const p = ball.position;
				const b = bodies.get(ball.uuid);
				const lv = b?.linvel;
				const speed = lv ? Math.hypot(lv.x, lv.y, lv.z) : 0;
				const held = !!b?.hold;
				// which slot is this ball resting in?
				const slot = slots.findIndex((q) => Math.hypot(p.x - q[0], p.z - q[2]) < 0.14 && Math.abs(p.y - q[1]) < 0.12);
				if (slot >= 0) taken.add(slot);
				if (speed >= HIT_SPEED && !held) hitTest(s, ball, [p.x, p.y, p.z]);
				// back to the shelf: out of the world, or resting off the shelf
				if (slot >= 0 || held) {
					restSince.delete(ball.uuid);
					continue;
				}
				if (p.y < -1.5) restSince.set(ball.uuid, -99);
				else if (speed < 0.35) {
					if (!restSince.has(ball.uuid)) restSince.set(ball.uuid, t);
				} else restSince.delete(ball.uuid);
				const since = restSince.get(ball.uuid);
				if (since !== undefined && t - since >= BALL_RETURN_AFTER) {
					restSince.delete(ball.uuid);
					phys.physicsRemoveBody?.(ball.uuid);
					transient.removeTransientObject(ball.uuid);
				}
			}
			// refill empty slots up to six balls
			let count = balls().length;
			for (let i = 0; i < slots.length && count < slots.length; i++) {
				if (taken.has(i)) continue;
				const q = slots[i];
				const blocked = balls().some((/** @type {any} */ o) => Math.hypot(o.position.x - q[0], o.position.y - q[1], o.position.z - q[2]) < 0.24);
				if (blocked) continue;
				spawnCopy(BALL_TEMPLATE, q);
				count++;
			}
			// cleared?
			const left = remaining(s);
			if (left <= 0) finish(s, true);
		};
		/** @param {any} s */
		const remaining = (s) => {
			const swingLeft = Math.max(0, s.swing - bitCount(v(V.swing) & ((1 << s.swing) - 1)));
			return v(V.cans) + swingLeft + Math.max(0, s.popups - v(V.pops)) + Math.max(0, s.cart - v(V.cart));
		};
		/** @param {number} n */
		const bitCount = (n) => {
			let c = 0;
			for (let k = n >>> 0; k; k >>>= 1) c += k & 1;
			return c;
		};
		/** @param {any} s @param {any} ball @param {number[]} p */
		const hitTest = (s, ball, p) => {
			const t = now();
			/** @param {string} key */
			const cooled = (key) => t - (lastHitAt.get(key) ?? -99) > 0.6;
			// swinging targets
			const swungMask = v(V.swing);
			for (let i = 0; i < Math.min(s.swing, SWING_COUNT); i++) {
				if (swungMask & (1 << i)) continue;
				const o = byName('Swing target ' + (i + 1));
				if (!o) continue;
				const c = worldPos(o);
				if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > HIT_RADIUS.swing) continue;
				setV(V.swing, v(V.swing) | (1 << i));
				score('swing' + i, POINTS.swing, c, 'swing');
			}
			// pop-ups: only the ones up right now
			if (s.popups && v(V.pops) < s.popups) {
				const { slot, up } = popupsUp(s, roundNo(), elapsed());
				const downWord = v(V.popDown);
				const downMask = Math.floor(downWord / 64) === slot ? downWord % 64 : 0;
				for (const i of up) {
					if (downMask & (1 << i)) continue;
					const o = byName('Popup target ' + (i + 1));
					if (!o) continue;
					const c = worldPos(o);
					if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) > HIT_RADIUS.popup) continue;
					setV(V.popDown, slot * 64 + (downMask | (1 << i)));
					setV(V.pops, v(V.pops) + 1);
					score('pop' + i, POINTS.popup, c, 'popup');
					break;
				}
			}
			// the cart
			if (s.cart && v(V.cart) < s.cart && cooled('cart')) {
				const o = byName('Cart target');
				if (o) {
					const c = worldPos(o);
					if (Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= HIT_RADIUS.cart) {
						lastHitAt.set('cart', t);
						setV(V.cart, v(V.cart) + 1);
						score('cart', POINTS.cart, c, 'cart');
					}
				}
			}
			void ball;
		};
		/** @param {any} s @param {boolean} won @param {boolean=} byClock the kit's own time-up ended the round */
		const finish = (s, won, byClock = false) => {
			if (v(V.status) !== STATUS.playing) return;
			const t = elapsed();
			const stars = starsFor(s, won, t);
			setV(V.stars, stars);
			setV(V.time, Math.round(t * 10));
			setV(V.status, won ? STATUS.won : STATUS.lost);
			kit.levels.complete(won, v(V.score), t);
			if (byClock) return;
			if (won) kit.round.win('Stage cleared');
			else kit.round.lose('Time is up');
		};

		// ---- the moments (every peer) ---------------------------------------------------------
		/** @param {any} fx */
		const moment = (fx) => {
			const at = Array.isArray(fx?.at) ? fx.at : [0, 1, 0];
			const kind = String(fx?.kind ?? 'can');
			api.effects?.burst?.(at, { kind: kind === 'can' ? 'sparks' : 'confetti', count: kind === 'can' ? 28 : 56, color: kind === 'cart' ? '#ffd45e' : '' });
			api.playSound?.(kind === 'can' ? 'hit' : kind === 'cart' ? 'coin' : 'ring', at);
			const combo = Number(fx?.combo) || 1;
			if (combo >= 2) api.playSound?.('pop', at);
			api.hapticPattern?.('tap');
		};
		api.onMessage((/** @type {any} */ msg) => {
			if (!active()) return;
			if (msg?.op === 'fx') moment(msg);
			else if (msg?.op === 'throw' && stepping()) doThrow(msg);
		});
		const watchPhases = () => {
			const s = stage();
			const g = gs && stores ? stores.get(gs.gameState) : null;
			const p = phase();
			const r = roundNo();
			if (s && (p === 'intro' || p === 'playing') && announcedRound !== r) {
				announcedRound = r;
				finishedRound = -1;
				api.announce('Stage ' + s.id + ' · ' + s.name, { sub: s.intro, ms: 3600, color: '#ffd45e' });
				api.playSound?.('whistle');
			}
			if (s && g?.state === 'over' && finishedRound !== r) {
				finishedRound = r;
				if (v(V.status) === STATUS.won) {
					api.playSound?.('levelup');
					api.hapticPattern?.('success');
					const shelf = byName(SHELF);
					const at = shelf ? worldPos(shelf) : [0, 1.5, 0];
					api.effects?.burst?.([at[0], at[1] + 1.2, at[2] - 3], { kind: 'confetti', count: 96 });
				} else {
					api.playSound?.('fail');
					api.hapticPattern?.('fail');
				}
			}
		};

		// ---- desktop charge-throw -------------------------------------------------------------
		/** @param {any} msg {pos, dir, speed} */
		const doThrow = (msg) => {
			if (!phys?.applyThrow) return;
			const pos = msg.pos;
			const dir = msg.dir;
			if (!Array.isArray(pos) || !Array.isArray(dir)) return;
			const speed = Math.max(THROW_MIN, Math.min(THROW_MAX, Number(msg.speed) || THROW_MIN));
			const bodies = new Map((phys.physicsDebug?.() ?? []).map((/** @type {any} */ b) => [b.uuid, b]));
			const slots = shelfSlots();
			// a ball resting in a shelf slot, not held
			const ball = balls().find((/** @type {any} */ o) => {
				const b = bodies.get(o.uuid);
				if (b?.hold) return false;
				return slots.some((q) => Math.hypot(o.position.x - q[0], o.position.z - q[2]) < 0.16 && Math.abs(o.position.y - q[1]) < 0.15);
			});
			if (!ball) return;
			phys.applyThrow({ uuid: ball.uuid, pos, rot: [0, 0, 0], linvel: [dir[0] * speed, dir[1] * speed + 0.6, dir[2] * speed], angvel: [0, 0, 0] });
		};
		const canCharge = () => active() && api.isPlaying() && !api.isVR() && phase() === 'playing';
		/** does the crosshair point at a ball close enough to grab? (then the grab owns the press) */
		const aimingAtBall = () => {
			const rc = api.pointerRay?.();
			if (!rc) return false;
			const hits = rc.intersectObjects(balls(), true);
			return hits.length > 0 && hits[0].distance < 2.2;
		};
		/** @param {MouseEvent} e */
		const onDown = (e) => {
			// a press on the HUD or the menu is not a throw: only a press on the viewport canvas
			const target = /** @type {any} */ (e.target);
			if (e.button !== 0 || target?.tagName !== 'CANVAS' || !canCharge() || aimingAtBall()) return;
			charging = true;
			chargeStart = now();
		};
		/** @param {MouseEvent} e */
		const onUp = (e) => {
			if (e.button !== 0 || !charging) return;
			charging = false;
			if (!canCharge()) return;
			throwNow(Math.min(1, (now() - chargeStart) / CHARGE_FULL));
		};
		/** throw one ball from the shelf along the view @param {number} power 0..1 */
		const throwNow = (power) => {
			const rc = api.pointerRay?.();
			if (!rc) return false;
			const o = rc.ray.origin;
			const d = rc.ray.direction;
			const msg = {
				op: 'throw',
				pos: [o.x + d.x * 0.45, o.y + d.y * 0.45 - 0.12, o.z + d.z * 0.45],
				dir: [d.x, d.y, d.z],
				speed: THROW_MIN + (THROW_MAX - THROW_MIN) * power
			};
			api.playSound?.('whoosh');
			if (stepping()) doThrow(msg);
			else api.send(msg);
			return true;
		};
		api.listen(window, 'mousedown', onDown, true);
		api.listen(window, 'mouseup', onUp, true);

		// ---- the moving targets: module effects (kinematic, LOCAL pose per peer) ---------------
		const HIDDEN_DROP = 30;
		api.registerEffect('tossswing', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data, /** @type {number} */ time) => {
			const s = stage();
			const i = Math.max(0, (Number(data?.index) || 1) - 1);
			const pos = base?.pos ?? [0, 0, 0];
			const rot = base?.rot ?? [0, 0, 0];
			const on = !!s && i < s.swing && !(v(V.swing) & (1 << i)) && v(V.status) === STATUS.playing;
			const off = swingOffset(i, time, s?.swingSpeed ?? 1);
			object.position.set(pos[0] + off.x, (on ? pos[1] : pos[1] - HIDDEN_DROP) + off.y, pos[2]);
			object.rotation.set(rot[0], rot[1], rot[2] + off.rz);
		});
		api.registerEffect('tosspopup', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data) => {
			const s = stage();
			const i = Math.max(0, (Number(data?.index) || 1) - 1);
			const pos = base?.pos ?? [0, 0, 0];
			let up = false;
			if (s && s.popups && v(V.status) === STATUS.playing && phase() === 'playing' && v(V.pops) < s.popups) {
				const { slot, up: ups } = popupsUp(s, roundNo(), elapsed());
				const downWord = v(V.popDown);
				const downMask = Math.floor(downWord / 64) === slot ? downWord % 64 : 0;
				up = ups.includes(i) && !(downMask & (1 << i));
			}
			object.position.set(pos[0], up ? pos[1] : pos[1] - 1.1, pos[2]);
		});
		api.registerEffect('tosscart', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data, /** @type {number} */ time) => {
			const s = stage();
			const pos = base?.pos ?? [0, 0, 0];
			const on = !!s && s.cart > 0 && v(V.status) === STATUS.playing;
			const done = on && v(V.cart) >= s.cart;
			const x = cartOffset(time, s?.cartSpeed || 0.7);
			object.position.set(pos[0] + x, on ? pos[1] - (done ? 0.6 : 0) : pos[1] - HIDDEN_DROP, pos[2]);
			void data;
		});

		// ---- the HUD's words ----------------------------------------------------------------
		/** @param {any} data */
		const info = (data) => {
			const read = String(data?.read ?? 'title');
			const s = stage();
			const table = kit.levels.table?.() ?? [];
			if (read === 'levelStars') {
				const row = table.find((/** @type {any} */ r) => r.id === String(Number(data?.level) || 0));
				if (!row) return '';
				return row.locked ? '🔒 locked' : starsText(row.stars);
			}
			if (read === 'menuLine') {
				const total = table.reduce((/** @type {number} */ a, /** @type {any} */ r) => a + (r.stars || 0), 0);
				return 'Stars earned: ' + total + ' / ' + STAGES.length * 3;
			}
			if (read === 'charge') return charging ? Math.min(1, (now() - chargeStart) / CHARGE_FULL) : 0;
			if (!s) return read === 'progress' ? 0 : '';
			switch (read) {
				case 'title':
					return 'Stage ' + s.id + ' · ' + s.name;
				case 'targets': {
					/** @type {string[]} */ const parts = [];
					const nc = canCount(s);
					if (nc) parts.push('Cans ' + (nc - v(V.cans)) + '/' + nc);
					if (s.swing) parts.push('Swingers ' + bitCount(v(V.swing) & ((1 << s.swing) - 1)) + '/' + s.swing);
					if (s.popups) parts.push('Pop-ups ' + v(V.pops) + '/' + s.popups);
					if (s.cart) parts.push('Cart ' + v(V.cart) + '/' + s.cart);
					return parts.join(' · ');
				}
				case 'progress': {
					const all = targetCount(s);
					return all ? 1 - remaining(s) / all : 0;
				}
				case 'score':
					return 'Score ' + v(V.score);
				case 'combo': {
					const c = v(V.combo);
					return c >= 2 && elapsed() - lastComboSeen() <= COMBO_WINDOW ? 'Combo x' + c : ' ';
				}
				case 'clock':
					return formatTime(Number(kit.round.remaining?.() ?? 0));
				case 'result':
					return v(V.status) === STATUS.won ? 'Stage cleared!' : 'Time is up';
				case 'resultStars':
					return starsText(v(V.status) === STATUS.won ? v(V.stars) : 0);
				case 'resultLine':
					return v(V.status) === STATUS.won
						? 'Score ' + v(V.score) + '  ·  time ' + formatTime(v(V.time) / 10) + ' of ' + formatTime(s.limit)
						: 'Score ' + v(V.score) + '  ·  ' + remaining(s) + ' target' + (remaining(s) === 1 ? '' : 's') + ' left standing';
				case 'best': {
					const best = Number(kit.score.best?.() ?? 0) || 0;
					return best > 0 ? 'Best score on this stage: ' + best : ' ';
				}
				default:
					return '';
			}
		};
		/** the combo label fades when no hit came for a while: every peer tracks when the combo
		 * variable last CHANGED (local), which is close enough for a label */
		let comboSeen = { value: 0, at: -99 };
		const lastComboSeen = () => {
			const c = v(V.combo);
			if (c !== comboSeen.value) comboSeen = { value: c, at: elapsed() };
			return comboSeen.at;
		};
		api.registerValueNode(
			'tossinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		api.registerNodeGroup({
			group: 'Target Toss',
			items: [
				{
					type: 'tossinfo',
					label: 'Target Toss info',
					defaults: { read: 'title', level: 1 },
					params: [
						{ key: 'read', kind: 'select', options: ['title', 'targets', 'progress', 'score', 'combo', 'clock', 'charge', 'result', 'resultStars', 'resultLine', 'best', 'levelStars', 'menuLine'] },
						{ key: 'level', kind: 'range', min: 1, max: STAGES.length, step: 1 }
					]
				},
				{ type: 'tossswing', label: 'Swinging target', defaults: { index: 1 }, params: [{ key: 'index', kind: 'range', min: 1, max: SWING_COUNT, step: 1 }] },
				{ type: 'tosspopup', label: 'Pop-up target', defaults: { index: 1 }, params: [{ key: 'index', kind: 'range', min: 1, max: POPUP_COUNT, step: 1 }] },
				{ type: 'tosscart', label: 'Moving cart', defaults: {}, params: [] }
			]
		});

		// ---- the buttons: every peer watches the stamps, the authority acts --------------------
		/** @param {string} element */
		const onPress = (element) => {
			const cur = v(V.stage, 0);
			const lvl = /^lvl-(\d+)$/.exec(element);
			if (lvl) return startStage(Number(lvl[1]));
			if (element === 'retry-btn' || element === 'restart-btn') return cur ? startStage(cur) : false;
			if (element === 'next-btn') {
				const next = cur + 1;
				if (!stageById(next)) {
					api.announce('That was the last stage', { sub: 'Go back for three stars on each', ms: 2400, color: '#ffd45e' });
					return toMenu();
				}
				return startStage(next);
			}
			if (element === 'levels-btn' || element === 'quit-btn') return toMenu();
			return false;
		};
		const watchButtons = () => {
			const amAuthority = authority();
			for (const node of api.flow.nodes('hudbutton')) {
				const element = String(node.data?.element ?? '');
				if (!/^(lvl-\d+|next-btn|retry-btn|levels-btn|restart-btn|quit-btn)$/.test(element)) continue;
				const entry = api.flow.triggerStamp(node.id);
				const stamp = Number(entry?.stamp) || 0;
				if (!seenStamps.has(node.id)) {
					seenStamps.set(node.id, stamp);
					continue;
				}
				if (stamp === seenStamps.get(node.id)) continue;
				const fresh = Number(entry?.age ?? 0) < FRESH_PRESS;
				seenStamps.set(node.id, stamp);
				if (fresh && amAuthority) onPress(element);
			}
		};

		// ---- levels, help, rules ------------------------------------------------------------
		/** @type {any} */ let levelsOff = null;
		const defineLevels = () => {
			if (typeof levelsOff === 'function') levelsOff();
			levelsOff = kit.levels.define({
				id: 'targettoss',
				list: STAGES.map((s) => ({ id: String(s.id), label: s.id + ' · ' + s.name })),
				unlock: 'sequential',
				stars: (/** @type {any} */ row, /** @type {any} */ r) => starsFor(stageById(Number(row.id)) ?? STAGES[0], !!r.won, Number(r.time) || 0)
			});
		};
		kit.levels.onSelected((/** @type {any} */ p) => {
			if (p?.game !== 'targettoss' || !active() || !authority()) return;
			const id = Number(p.level);
			if (stageById(id) && v(V.stage, 0) !== id) startStage(id);
		});
		kit.round.onStarted(() => {
			if (starting || !active() || !authority()) return;
			const s = stage();
			if (!s) return kit.round.toMenu();
			resetVars(s);
		});
		const HELP = [
			'Knock down every target before the clock runs out: tin cans off their tables, swinging targets, pop-ups and a moving cart.',
			'VR: grab a ball from the shelf with the grip and throw it. Desktop: HOLD the mouse to charge, RELEASE to throw (or grab a ball and flick it).',
			'Hits in quick succession build a COMBO (up to x5). Balls come back to the shelf by themselves.',
			'Stars: clear the stage for one, with half the clock left for three. A star opens the next stage.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		let rulesSet = false;

		// ---- the frame ----------------------------------------------------------------------
		let wasActive = false;
		api.registerFrameTask(() => {
			if (!gs || !stores) return;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on) defineLevels();
				if (on) {
					kit.rules.set({ reach: 1.6 });
					rulesSet = true;
				} else if (rulesSet) {
					kit.rules.clearRules();
					rulesSet = false;
				}
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
			const s = stage();
			const p = phase();
			if (s && authority() && v(V.status) === STATUS.playing) {
				const r = roundNo();
				if ((p === 'intro' || p === 'playing') && (v(V.dealt, -1) !== r || (stepping() && balls().length === 0))) deal(s, r);
				else if (p === 'playing') judge(s);
				else if ((p === 'lost' || p === 'results') && judgedRound !== r) {
					judgedRound = r;
					finish(s, false, true);
				}
			}
			watchPhases();
		});
		api.onSceneClear(() => {
			if (helpOff) {
				helpOff();
				helpOff = null;
			}
			if (typeof levelsOff === 'function') {
				levelsOff();
				levelsOff = null;
			}
			rulesSet = false;
			seenStamps.clear();
			scored.clear();
			restSince.clear();
			announcedRound = -1;
			finishedRound = -1;
			wasActive = false;
		});

		/** the suites' window onto the module */
		/** @type {any} */ (globalThis).__targetToss = {
			stages: STAGES,
			vars: () => Object.fromEntries(Object.values(V).map((k) => [k, api.game.getVar(k, null)])),
			authority,
			stepping,
			startStage,
			toMenu,
			info,
			balls: () => balls().map((/** @type {any} */ o) => ({ uuid: o.uuid, pos: o.position.toArray() })),
			cans: () => cans().map((/** @type {any} */ o) => ({ uuid: o.uuid, pos: o.position.toArray() })),
			/** a scripted throw (power 0..1) along the current view */
			throwNow,
			/** a scripted throw from a point at a point */
			throwAt: (/** @type {number[]} */ from, /** @type {number[]} */ to, /** @type {number} */ speed = 12) => {
				const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
				const len = Math.hypot(d[0], d[1], d[2]) || 1;
				const msg = { op: 'throw', pos: from, dir: [d[0] / len, d[1] / len, d[2] / len], speed };
				if (stepping()) doThrow(msg);
				else api.send(msg);
			},
			/** knock every can off its table (the judge then scores them): evidence + suites */
			sweepCans: () => {
				if (!stepping()) return 0;
				let n = 0;
				for (const can of cans()) {
					phys.applyThrow({ uuid: can.uuid, pos: [can.position.x, can.position.y + 0.05, can.position.z + 0.6], rot: [0, 0, 0], linvel: [0, 1, 3], angvel: [0, 0, 0] });
					n++;
				}
				return n;
			},
			finishNow: (/** @type {boolean} */ won) => {
				const s = stage();
				if (s) finish(s, won !== false);
			}
		};
	}
};
