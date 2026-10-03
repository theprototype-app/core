// 35 MARBLE MAZE — the rules for the Marble Maze game template (scripts/templates/marble-maze.cjs).
// A CORE module, the Towers precedent: dormant in every scene without the `Marble Maze game`
// marker object.
//
// WHAT LIVES WHERE
//   the template def   the room, the five maze GROUPS (each one compound collider, parked under the
//                      floor but the first), the marble, the gates, the HUD screens and a small graph
//                      (the buttons, the music, one `marbletilt` effect per maze and gate)
//   this file          the tilt (desktop keys/mouse, VR grips/stick), the board pose (a module effect,
//                      so the runtime makes each maze a KINEMATIC platform), the judge (coins, holes,
//                      the goal), the levels (kit.levels + kit.round), the HUD words (a value node)
//
// WHO DECIDES (golden rule 8: one simulator). The judge runs on ONE authority: the physics
// initiator, else the lowest peer id — it owns the marble's body. Everything it decides is a
// game variable (`mm*`), so every peer derives the coins, the moments and the words. The TILT is
// the one thing a person does: each peer sends its own input (`{op:'tilt'}`, ~15 Hz while it
// changes) and every peer poses the board from the latest one, so the board looks the same
// everywhere and the initiator's physics follows the same pose.

/** the marker object that says "this scene is a Marble Maze game" */
const MARKER = 'Marble Maze game';
/** where the board stands while you play (the def's BOARD) */
const BOARD = [0, 1.1, -0.75];
/** the tilt limit, radians (±15°) */
const MAX_TILT = (15 * Math.PI) / 180;
const WALL_H = 0.07;
/** a button stamp older than this (seconds) when first noticed is history, not a press */
const FRESH_PRESS = 2.5;
/** the maze table: names and par times (seconds) — the geometry is the def's */
const MAZES = [
	{ id: 1, name: 'First roll', par: 25 },
	{ id: 2, name: 'Pits', par: 35 },
	{ id: 3, name: 'Labyrinth', par: 50 },
	{ id: 4, name: 'Gatehouse', par: 60 },
	{ id: 5, name: 'The gauntlet', par: 75 }
];
const V = {
	level: 'mmLevel',
	status: 'mmStatus', // 0 none, 1 playing, 2 won
	coins: 'mmCoins', // bitmask of the coins taken this run
	falls: 'mmFalls',
	time: 'mmTime', // the finishing time, tenths
	stars: 'mmStars'
};
const STATUS = { none: 0, playing: 1, won: 2 };
const HELP = [
	'Tilt the board to roll the marble to the gold ring.',
	'Desktop: WASD or the arrow keys tilt the board; or hold the mouse button and drag.',
	'VR: grip both handles and twist or tip the board (one hand works too), or tilt with the left stick.',
	'A hole sends the marble back to the start and puts the coins back. Gates on mazes 4 and 5 rise and sink — time your run.',
	'Stars: one for reaching the goal, one for all three coins, one for beating the par time.'
];

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** @param {number} n */
const starsText = (n) => '★'.repeat(n) + '☆'.repeat(Math.max(0, 3 - n));
/** @param {number} s */
const formatTime = (s) => {
	const t = Math.max(0, s);
	const m = Math.floor(t / 60);
	return m + ':' + String(Math.floor(t % 60)).padStart(2, '0') + '.' + Math.floor((t * 10) % 10);
};
/** the stars a finished run earns @param {any} maze @param {{time: number, coins: number}} r */
export const marbleStars = (maze, r) => 1 + (r.coins >= 3 ? 1 : 0) + (r.time <= (maze?.par ?? 0) ? 1 : 0);

export default {
	id: 'marble',
	name: 'Marble Maze',
	version: '1.0.0',
	description: 'The Marble Maze game: tilt the board and roll the marble to the goal — five mazes, holes, coins, gates and stars saved on this device.',

	/** @param {any} api */
	register(api) {
		/** @type {any} */ let gs = null;
		/** @type {any} */ let phys = null;
		/** @type {any} */ let stores = null;
		/** @type {any} */ let scene = null;
		Promise.all([import('../../lib/gameState'), import('../../lib/physics'), import('svelte/store'), import('../../stores/sceneStore')]).then(([a, b, c, d]) => {
			gs = a;
			phys = b;
			stores = c;
			scene = d;
		});
		const THREE = api.THREE;
		const kit = api.kit;
		kit.score.useGame?.('marble');

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
		/** @param {string} name @param {number} value */
		const setV = (name, value) => {
			if (v(name, NaN) !== value) api.game.setVar(name, value);
		};
		const currentMaze = () => MAZES.find((m) => m.id === v(V.level, 0)) ?? null;
		/** the maze on the board: the current one, else maze 1 (the menu shows it) */
		const shownMaze = () => v(V.level, 0) || 1;
		const prog = () => kit.levels.progress?.() ?? { levels: {} };
		const isVR = () => !!api.isVR?.();
		const playingNow = () => game()?.state === 'playing' && v(V.status) === STATUS.playing;

		const authority = () => {
			if (!phys || !stores) return false;
			if (stores.get(phys.simulating)) return phys.isInitiator();
			if (stores.get(phys.remoteSimulating)) return false;
			const me = api.peerId();
			if (!me) return true;
			const ids = [me, ...api.peerIds()].filter(Boolean).sort();
			return ids[0] === me;
		};

		// ---- the tilt ------------------------------------------------------------------------
		/** the pose every peer draws (smoothed toward `target`) */
		const cur = { x: 0, z: 0 };
		/** what MY input says this frame, or null when I am not touching the board */
		/** @type {{x: number, z: number} | null} */ let mine = null;
		/** the latest tilt another peer sent, and when it arrived (performance.now ms) */
		let remote = { x: 0, z: 0, at: -1e9 };
		let lastSent = 0;
		let sentZero = true;
		/** the desktop mouse drag */
		/** @type {{x0: number, y0: number, x: number, y: number} | null} */ let drag = null;
		/** the VR grab: hand quats + tilt when the grips closed */
		/** @type {any} */ let grab = null;
		const keyTilt = { x: 0, z: 0 };
		/** where a VR hand is read from (a suite swaps it: headless XR never PRESENTS, so the SDK's
		 * vrHand answers null there) @type {(hand: 'left'|'right') => any} */
		let handSource = (hand) => api.vrHand?.(hand) ?? null;

		api.onMessage((/** @type {any} */ msg) => {
			if (msg?.op === 'tilt' && Number.isFinite(msg.x) && Number.isFinite(msg.z))
				remote = { x: clamp(msg.x, -MAX_TILT, MAX_TILT), z: clamp(msg.z, -MAX_TILT, MAX_TILT), at: performance.now() };
			if (msg?.op === 'pick' && authority()) startLevel(Number(msg.level));
		});

		const listen = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn) => {
			if (typeof api.listen === 'function') return api.listen(target, type, fn);
			target.addEventListener(type, fn);
			return () => target.removeEventListener(type, fn);
		};
		if (typeof window !== 'undefined') {
			listen(window, 'pointerdown', (/** @type {PointerEvent} */ e) => {
				if (!active() || !playingNow() || isVR() || e.button !== 0) return;
				if (!(e.target instanceof HTMLCanvasElement)) return; // a HUD button is not a tilt
				drag = { x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY };
			});
			listen(window, 'pointermove', (/** @type {PointerEvent} */ e) => {
				if (drag) {
					drag.x = e.clientX;
					drag.y = e.clientY;
				}
			});
			listen(window, 'pointerup', () => (drag = null));
		}

		/** my input this frame -> `mine` @param {number} dt */
		const readInput = (dt) => {
			mine = null;
			if (!playingNow()) {
				grab = null;
				drag = null;
				return;
			}
			const input = api.input?.() ?? { codes: new Set(), axes: {} };
			const codes = input.codes ?? new Set();
			// keys: hold to tilt, release to level (eased)
			const kx = (codes.has('KeyS') || codes.has('ArrowDown') ? 1 : 0) - (codes.has('KeyW') || codes.has('ArrowUp') ? 1 : 0);
			const kz = (codes.has('KeyA') || codes.has('ArrowLeft') ? 1 : 0) - (codes.has('KeyD') || codes.has('ArrowRight') ? 1 : 0);
			const k = Math.min(1, dt * 6);
			keyTilt.x += (kx * MAX_TILT - keyTilt.x) * k;
			keyTilt.z += (kz * MAX_TILT - keyTilt.z) * k;
			if (kx || kz || Math.abs(keyTilt.x) > 0.002 || Math.abs(keyTilt.z) > 0.002) mine = { x: keyTilt.x, z: keyTilt.z };
			if (drag) {
				mine = {
					x: clamp((drag.y - drag.y0) / 160, -1, 1) * MAX_TILT,
					z: clamp(-(drag.x - drag.x0) / 160, -1, 1) * MAX_TILT
				};
			}
			if (!isVR()) return;
			// VR: the left stick tilts; the grips TWIST the board
			const ax = input.axes ?? {};
			const sx = Number(ax.lx) || 0;
			const sy = Number(ax.ly) || 0;
			if (Math.abs(sx) > 0.15 || Math.abs(sy) > 0.15) mine = { x: sy * MAX_TILT, z: -sx * MAX_TILT };
			const L = handSource('left');
			const R = handSource('right');
			const near = (/** @type {any} */ h) =>
				h?.gripped && h.position && Math.hypot(h.position[0] - BOARD[0], h.position[2] - BOARD[2]) < 0.75 && Math.abs(h.position[1] - BOARD[1]) < 0.5;
			const hands = [L, R].filter(near);
			if (!hands.length) {
				grab = null;
				return;
			}
			const key = hands.map((h) => (h === L ? 'L' : 'R')).join('');
			const q = (/** @type {any} */ h) => new THREE.Quaternion(h.quaternion[0], h.quaternion[1], h.quaternion[2], h.quaternion[3]);
			const roll = () => Math.atan2(R.position[1] - L.position[1], Math.hypot(R.position[0] - L.position[0], R.position[2] - L.position[2]));
			if (!grab || grab.key !== key) {
				grab = { key, q0: hands.map((h) => q(h)), roll0: key === 'LR' ? roll() : 0, x0: cur.x, z0: cur.z };
				api.hapticPattern?.('tap', hands.length === 2 ? 'both' : hands[0] === L ? 'left' : 'right');
			}
			let px = 0;
			let pz = 0;
			hands.forEach((h, i) => {
				const d = q(h).multiply(grab.q0[i].clone().invert());
				const e = new THREE.Euler().setFromQuaternion(d, 'XYZ');
				px += e.x / hands.length;
				pz += e.z / hands.length;
			});
			if (key === 'LR') pz = roll() - grab.roll0;
			mine = { x: clamp(grab.x0 + px, -MAX_TILT, MAX_TILT), z: clamp(grab.z0 + pz, -MAX_TILT, MAX_TILT) };
		};

		/** the tilt this frame: mine, else a peer's (fresh), else level @param {number} dt */
		const updateTilt = (dt) => {
			const now = performance.now();
			/** @type {{x: number, z: number}} */ let target = { x: 0, z: 0 };
			if (mine) target = { x: clamp(mine.x, -MAX_TILT, MAX_TILT), z: clamp(mine.z, -MAX_TILT, MAX_TILT) };
			else if (now - remote.at < 400) target = remote;
			const k = Math.min(1, dt * 12);
			cur.x += (target.x - cur.x) * k;
			cur.z += (target.z - cur.z) * k;
			// tell the others (only while I touch, plus one zero when I let go)
			if (mine && now - lastSent > 66) {
				lastSent = now;
				sentZero = false;
				api.send({ op: 'tilt', x: +target.x.toFixed(4), z: +target.z.toFixed(4) });
			} else if (!mine && !sentZero) {
				sentZero = true;
				api.send({ op: 'tilt', x: 0, z: 0 });
			}
		};

		// ---- the board pose: a module effect -> a kinematic platform per maze and gate --------
		const tiltQuat = () => new THREE.Quaternion().setFromEuler(new THREE.Euler(cur.x, 0, cur.z, 'XYZ'));
		const boardMatrix = () => new THREE.Matrix4().compose(new THREE.Vector3(...BOARD), tiltQuat(), new THREE.Vector3(1, 1, 1));
		/** a gate's rise: 0 = up (blocking), 1 = sunk; 3 s a cycle @param {number} time @param {number} phase */
		const gateSink = (time, phase) => {
			const t = (((time / 3 + phase) % 1) + 1) % 1;
			const s = (/** @type {number} */ a) => a * a * (3 - 2 * a);
			if (t < 0.4) return 0;
			if (t < 0.5) return s((t - 0.4) / 0.1);
			if (t < 0.9) return 1;
			return 1 - s((t - 0.9) / 0.1);
		};
		api.registerEffect('marbletilt', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data, /** @type {number} */ time) => {
			if (!active()) return;
			const k = Number(data?.maze) || 1;
			if (k !== shownMaze()) {
				// parked where the def put it, and not drawn
				const p = base?.pos ?? [0, -4, 0];
				object.position.set(p[0], p[1], p[2]);
				object.rotation.set(0, 0, 0);
				object.visible = false;
				return;
			}
			object.visible = true;
			const q = tiltQuat();
			const local = data?.gate
				? new THREE.Vector3(Number(data.lx) || 0, WALL_H / 2 - gateSink(time, Number(data.phase) || 0) * (WALL_H + 0.01), Number(data.lz) || 0)
				: new THREE.Vector3(0, 0, 0);
			local.applyQuaternion(q);
			object.position.set(BOARD[0] + local.x, BOARD[1] + local.y, BOARD[2] + local.z);
			object.quaternion.copy(q);
		});

		// ---- the judge (authority) -----------------------------------------------------------
		const maze = () => byName('Maze ' + shownMaze());
		/** a child's local position in its maze @param {string} name @returns {any} */
		const localOf = (name) => maze()?.getObjectByName(name)?.position ?? null;
		const marble = () => byName('Marble');
		/** the marble in the board's frame */
		const marbleLocal = () => {
			const m = marble();
			if (!m) return null;
			return m.position.clone().applyMatrix4(boardMatrix().invert());
		};
		/** local -> world on the board @param {any} p */
		const toWorld = (p) => new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(boardMatrix());
		/** uuid -> release the hold next frame */
		/** @type {Set<string>} */ const releaseNext = new Set();
		const resetMarble = () => {
			const m = marble();
			const start = localOf('Start ' + shownMaze());
			if (!m || !start) return;
			const w = toWorld({ x: start.x, y: 0.045, z: start.z });
			const held = phys?.holdBody?.(m.uuid);
			m.position.copy(w);
			m.quaternion.identity();
			m.updateMatrixWorld();
			if (held) releaseNext.add(m.uuid);
			else api.moveObject(m.uuid, { pos: [w.x, w.y, w.z] });
		};
		const ensureSim = () => {
			if (!phys || !stores) return;
			if (!stores.get(phys.simulating) && !stores.get(phys.remoteSimulating)) phys.toggleSimulation?.();
		};
		let settleUntil = 0;
		/** @param {number} id */
		const startLevel = (id) => {
			const m = MAZES.find((x) => x.id === id);
			if (!m || !gs) return false;
			if (!(kit.levels.unlocked?.(String(id)) ?? true)) {
				api.announce('Maze ' + id + ' is locked', { sub: 'Finish maze ' + (id - 1) + ' first', ms: 2200, color: '#ffb86b' });
				return false;
			}
			setV(V.level, id);
			setV(V.status, STATUS.playing);
			setV(V.coins, 0);
			setV(V.falls, 0);
			setV(V.time, 0);
			setV(V.stars, 0);
			kit.levels.select(String(id));
			kit.round.configure(0, 0, 'lose', 2);
			starting = true;
			try {
				kit.round.restart();
			} finally {
				starting = false;
			}
			ensureSim();
			settleUntil = performance.now() + 900;
			resetMarble();
			return true;
		};
		let starting = false;
		const toMenu = () => {
			setV(V.status, STATUS.none);
			setV(V.level, 0);
			kit.round.toMenu();
			resetMarble();
		};
		const finish = () => {
			const m = currentMaze();
			if (!m || !gs) return;
			const elapsed = gs.gameElapsed();
			const coins = countBits(v(V.coins));
			const stars = marbleStars(m, { time: elapsed, coins });
			setV(V.stars, stars);
			setV(V.time, Math.round(elapsed * 10));
			setV(V.status, STATUS.won);
			kit.levels.complete(true, coins, elapsed, String(m.id), { coins, falls: v(V.falls) });
			kit.round.win('Maze cleared!');
		};
		/** @param {number} n */
		const countBits = (n) => {
			let c = 0;
			for (let i = 0; i < 3; i++) if (n & (1 << i)) c++;
			return c;
		};
		const judge = () => {
			if (!playingNow()) return;
			const now = performance.now();
			const p = marbleLocal();
			if (!p) return;
			if (now < settleUntil) {
				// the first moments of a run: hold the marble on the start pad while the sim wakes
				if (p.y < -0.03 || Math.hypot(p.x - (localOf('Start ' + shownMaze())?.x ?? 0), p.z - (localOf('Start ' + shownMaze())?.z ?? 0)) > 0.2) resetMarble();
				return;
			}
			// fell through a hole (or off the board)
			if (p.y < -0.08 || Math.abs(p.x) > 0.7 || Math.abs(p.z) > 0.7) {
				setV(V.falls, v(V.falls) + 1);
				setV(V.coins, 0);
				resetMarble();
				settleUntil = now + 500;
				return;
			}
			const k = shownMaze();
			let mask = v(V.coins);
			for (let i = 0; i < 3; i++) {
				if (mask & (1 << i)) continue;
				const c = localOf('Coin ' + k + '.' + (i + 1));
				if (c && Math.hypot(p.x - c.x, p.z - c.z) < 0.055 && p.y < 0.12) mask |= 1 << i;
			}
			setV(V.coins, mask);
			const goal = localOf('Goal ' + k);
			if (goal && Math.hypot(p.x - goal.x, p.z - goal.z) < 0.045 && p.y < 0.08) finish();
		};

		// ---- every peer: what the variables mean on screen -------------------------------------
		let lastMask = 0;
		let lastFalls = 0;
		let lastStatus = 0;
		let announcedRound = -1;
		const moments = () => {
			const k = shownMaze();
			const mz = maze();
			const mask = v(V.coins);
			for (let i = 0; i < 3; i++) {
				const coin = mz?.getObjectByName('Coin ' + k + '.' + (i + 1));
				if (coin) {
					coin.visible = !(mask & (1 << i));
					if (coin.visible) coin.rotation.y += 0.05;
				}
				if (mask & (1 << i) && !(lastMask & (1 << i)) && coin) {
					const w = coin.getWorldPosition(new THREE.Vector3());
					api.playSound('coin', [w.x, w.y, w.z]);
					api.effects?.burst?.([w.x, w.y, w.z], { kind: 'sparkle', color: '#ffd34d', count: 24 });
					api.hapticPattern?.('tap');
				}
			}
			lastMask = mask;
			const falls = v(V.falls);
			if (falls > lastFalls && playingNow()) {
				api.playSound('fail');
				api.hapticPattern?.('fail');
				api.announce('Into the hole!', { sub: 'Back to the start — the coins are back too', ms: 1600, color: '#ff9a7a' });
			}
			lastFalls = falls;
			const status = v(V.status);
			if (status === STATUS.won && lastStatus !== STATUS.won) {
				const goal = mz?.getObjectByName('Goal ' + k)?.getWorldPosition(new THREE.Vector3());
				api.playSound('levelup');
				if (goal) api.effects?.burst?.([goal.x, goal.y, goal.z], { kind: 'confetti', count: 60 });
				api.hapticPattern?.('success');
			}
			lastStatus = status;
			const g = game();
			if (g?.state === 'playing' && status === STATUS.playing && announcedRound !== g.round) {
				announcedRound = g.round;
				const m = currentMaze();
				if (m) api.announce('Maze ' + m.id + ' · ' + m.name, { sub: 'Roll to the gold ring — par ' + formatTime(m.par), ms: 2600, color: '#ffd45e' });
				api.playSound('whistle');
				aimDesktopCamera();
			}
		};
		/** desktop: look DOWN at the board (the free cursor never turns the view) */
		const aimDesktopCamera = () => {
			if (isVR() || !scene || !stores) return;
			const cam = stores.get(scene.playerCam);
			if (!cam?.isObject3D) return;
			const eye = cam.getWorldPosition(new THREE.Vector3());
			const pitch = -Math.atan2(eye.y - BOARD[1], Math.max(0.3, eye.z - BOARD[2]));
			cam.quaternion.setFromEuler(new THREE.Euler(pitch, 0, 0, 'YXZ'));
			cam.updateMatrixWorld(true);
		};

		// ---- the buttons: every peer watches the stamps, the authority acts ------------------
		/** @type {Map<string, number>} */ const seenStamps = new Map();
		/** @param {string} element */
		const onPress = (element) => {
			const level = v(V.level, 0);
			const lvl = /^lvl-(\d+)$/.exec(element);
			if (lvl) return startLevel(Number(lvl[1]));
			if (element === 'start-btn') {
				// the first maze without three stars yet, else maze 1
				const next = MAZES.find((m) => (kit.levels.unlocked?.(String(m.id)) ?? true) && !((prog().levels?.[String(m.id)]?.stars ?? 0) >= 3));
				return startLevel(next?.id ?? 1);
			}
			if (element === 'retry-btn') return startLevel(level || 1);
			if (element === 'next-btn') {
				const next = MAZES.find((m) => m.id === level + 1);
				if (next) return startLevel(next.id);
				api.announce('That was the last maze', { sub: 'Go back for three stars on every one', ms: 2400, color: '#ffd45e' });
				return toMenu();
			}
			if (element === 'levels-btn') return toMenu();
			return false;
		};
		const watchButtons = () => {
			const amAuthority = authority();
			for (const node of api.flow.nodes('hudbutton')) {
				const element = String(node.data?.element ?? '');
				if (!/^(lvl-\d+|start-btn|next-btn|retry-btn|levels-btn)$/.test(element)) continue;
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

		// ---- the HUD words ----------------------------------------------------------------------
		/** @param {any} data @returns {any} */
		const info = (data) => {
			const read = String(data?.read ?? 'title');
			if (read === 'levelStars') {
				const id = Number(data?.level) || 0;
				if (!(kit.levels.unlocked?.(String(id)) ?? true)) return '🔒 locked';
				const row = prog().levels?.[String(id)];
				return row ? starsText(row.stars ?? 0) : '☆☆☆';
			}
			if (read === 'menuLine') {
				const total = MAZES.reduce((a, m) => a + (prog().levels?.[String(m.id)]?.stars ?? 0), 0);
				return 'Stars earned: ' + total + ' / ' + MAZES.length * 3;
			}
			const m = currentMaze();
			if (!m) return '';
			switch (read) {
				case 'title':
					return 'Maze ' + m.id + ' · ' + m.name;
				case 'clock': {
					const elapsed = game()?.state === 'playing' && gs ? gs.gameElapsed() : v(V.time) / 10;
					return formatTime(elapsed) + ' / par ' + formatTime(m.par);
				}
				case 'coins':
					return 'Coins ' + countBits(v(V.coins)) + ' / 3';
				case 'falls':
					return v(V.falls) ? 'Falls: ' + v(V.falls) : ' ';
				case 'hint':
					return isVR() ? 'Grip both handles and twist · left stick tilts' : 'WASD / arrows tilt · or hold the mouse and drag';
				case 'result':
					return v(V.status) === STATUS.won ? 'Maze ' + m.id + ' cleared!' : 'Run over';
				case 'resultStars':
					return starsText(v(V.stars));
				case 'resultLine':
					return 'Time ' + formatTime(v(V.time) / 10) + ' (par ' + formatTime(m.par) + ') · coins ' + countBits(v(V.coins)) + '/3 · falls ' + v(V.falls);
				case 'resultBest': {
					const row = prog().levels?.[String(m.id)];
					return row ? 'Best on this device: ' + starsText(row.stars ?? 0) : '';
				}
				default:
					return '';
			}
		};
		api.registerValueNode(
			'marbleinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		api.registerNodeGroup({
			group: 'Marble Maze',
			items: [
				{
					type: 'marbleinfo',
					label: 'Marble info',
					defaults: { read: 'title', level: 1 },
					params: [
						{ key: 'read', kind: 'select', options: ['title', 'clock', 'coins', 'falls', 'hint', 'result', 'resultStars', 'resultLine', 'resultBest', 'levelStars', 'menuLine'] },
						{ key: 'level', kind: 'range', min: 1, max: MAZES.length, step: 1 }
					]
				},
				{
					type: 'marbletilt',
					label: 'Marble tilt',
					defaults: { maze: 1, gate: false, lx: 0, lz: 0, phase: 0 },
					params: [
						{ key: 'maze', kind: 'range', min: 1, max: MAZES.length, step: 1 },
						{ key: 'phase', kind: 'range', min: 0, max: 1, step: 0.05 }
					]
				}
			]
		});

		// ---- the levels: kit.levels (the table, unlocks, stars, the K3 picker) -----------------
		/** @type {any} */ let levelsOff = null;
		const defineLevels = () => {
			if (typeof levelsOff === 'function') levelsOff();
			levelsOff = kit.levels.define({
				id: 'marble',
				list: MAZES.map((m) => ({ id: String(m.id), label: m.id + ' · ' + m.name })),
				unlock: 'sequential',
				stars: (/** @type {any} */ row, /** @type {any} */ r) => marbleStars(MAZES.find((m) => String(m.id) === String(row.id)), { time: r.time, coins: Number(r.coins ?? r.score ?? 0) }),
				store: {
					get: () => api.storage?.get?.('progress', null),
					set: (/** @type {any} */ progress) => api.storage?.set?.('progress', progress)
				}
			});
		};
		kit.levels.onSelected((/** @type {any} */ p) => {
			if (p?.game !== 'marble' || !active() || !authority()) return;
			const id = Number(p.level);
			if (MAZES.some((m) => m.id === id) && v(V.level, 0) !== id) startLevel(id);
		});
		kit.round.onStarted(() => {
			if (starting || !active() || !authority()) return;
			const m = currentMaze();
			if (!m) return kit.round.toMenu();
			setV(V.status, STATUS.playing);
			setV(V.coins, 0);
			setV(V.falls, 0);
			settleUntil = performance.now() + 900;
			ensureSim();
			resetMarble();
		});
		// a marble you GRAB is no marble maze: refuse it (and the boards) on every grab path
		kit.rules.onGrabRequest?.((/** @type {any} */ req) => {
			if (!active()) return;
			if (/^(Marble|Maze \d|Gate \d)/.test(String(req.name ?? ''))) req.refuse('Tilt the board — grip the handles');
		});

		// ---- the frame --------------------------------------------------------------------------
		let wasActive = false;
		/** @type {null | (() => void)} */ let helpOff = null;
		let claimed = false;
		let lastT = performance.now();
		api.registerFrameTask(() => {
			if (!gs || !stores) return;
			const now = performance.now();
			const dt = Math.min(0.1, (now - lastT) / 1000);
			lastT = now;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on) defineLevels();
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				if (!on) {
					helpOff?.();
					helpOff = null;
					if (typeof levelsOff === 'function') levelsOff();
					levelsOff = null;
				}
			}
			// while a maze runs the keys and the stick tilt the board, never walk
			const want = on && playingNow();
			if (want !== claimed) {
				claimed = want;
				if (want) {
					api.claimInput('keys');
					api.claimInput('locomotion');
				} else {
					api.releaseInput?.('keys');
					api.releaseInput?.('locomotion');
				}
			}
			if (!on) return;
			for (const uuid of releaseNext) {
				phys?.releaseBody?.(uuid, { linvel: new THREE.Vector3(), angvel: new THREE.Vector3() });
				releaseNext.delete(uuid);
			}
			readInput(dt);
			updateTilt(dt);
			watchButtons();
			if (authority()) judge();
			moments();
		});
		api.onSceneClear(() => {
			helpOff?.();
			helpOff = null;
			if (typeof levelsOff === 'function') levelsOff();
			levelsOff = null;
			seenStamps.clear();
			wasActive = false;
			announcedRound = -1;
			lastMask = lastFalls = lastStatus = 0;
			cur.x = cur.z = 0;
		});

		// the suites' window onto the module
		/** @type {any} */ (globalThis).__marble = {
			mazes: MAZES,
			authority,
			startLevel,
			toMenu,
			info,
			tilt: () => ({ ...cur }),
			setHandSource: (/** @type {any} */ fn) => (handSource = fn ?? ((/** @type {'left'|'right'} */ hand) => api.vrHand?.(hand) ?? null)),
			setTilt: (/** @type {number} */ x, /** @type {number} */ z) => (remote = { x, z, at: performance.now() + 1e6 }),
			vars: () => Object.fromEntries(Object.values(V).map((k) => [k, api.game.getVar(k, null)])),
			marbleLocal: () => marbleLocal()?.toArray() ?? null,
			/** a scripted win: put the marble on the goal (the judge does the rest) */
			toGoal: () => {
				const m = marble();
				const goal = localOf('Goal ' + shownMaze());
				if (!m || !goal) return false;
				settleUntil = 0;
				const w = toWorld({ x: goal.x, y: 0.04, z: goal.z });
				const held = phys?.holdBody?.(m.uuid);
				m.position.copy(w);
				if (held) releaseNext.add(m.uuid);
				return true;
			},
			/** a coin taken, for a scripted three-star win */
			takeCoins: () => setV(V.coins, 7),
			resetProgress: () => {
				api.storage?.remove?.('progress');
				kit.levels.refresh?.();
			}
		};
	}
};
