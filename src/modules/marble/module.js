// 35 MARBLE MAZE — the ENGINE for the Marble Maze game template (scripts/templates/marble-maze.cjs).
// 36 (U10): THE RULES — the maze table, par times, stars, the tilt limits, what a fall costs and the
// menu buttons — are the "Marble Maze rules" behaviour on the Main graph
// (scripts/templates/rules/marble-maze.rules.js). This engine lends them the `marble` piece: it reports
// a coin, a fall and the goal (`marble.coin` / `fell` / `goal`), takes the tilt limits (`tune`), starts a
// run on a maze (`startRun`) and stores what they write (`setVars`).
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
/** the tilt limit, radians (±15°) — the rules' maxTilt param replaces it (kit.marble.tune) */
let MAX_TILT = (15 * Math.PI) / 180;
const WALL_H = 0.09;
/** the most the board turns per second (rad/s): a faster swing throws the marble over the walls —
 * the rules' maxRate param replaces it */
let MAX_RATE = 2.0;
/** the mazes the template builds (the rules' table names them) */
const MAZE_COUNT = 5;
const V = {
	level: 'mmLevel',
	status: 'mmStatus', // 0 none, 1 playing, 2 won
	coins: 'mmCoins', // bitmask of the coins taken this run
	falls: 'mmFalls',
	time: 'mmTime', // the finishing time, tenths
	stars: 'mmStars',
	par: 'mmPar' // the maze's par time (s), as the rules said
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

export default {
	id: 'marble',
	name: 'Marble Maze',
	version: '2.0.0',
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
		/** the maze in play, as the rules' level table names it: {id, name, par} */
		const currentMaze = () => {
			const id = v(V.level, 0);
			const row = id ? kit.levels.level?.(String(id)) : null;
			if (!row) return null;
			return { id, name: String(row.label ?? '').replace(/^\s*\S+\s*·\s*/, ''), par: Number(row.par?.time) || v(V.par, 0) };
		};
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
			if (msg?.op === 'tell') tellHere(msg);
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
			else if (now - remote.at < 400) target = { x: clamp(remote.x, -MAX_TILT, MAX_TILT), z: clamp(remote.z, -MAX_TILT, MAX_TILT) };
			const k = Math.min(1, dt * 12);
			const step = MAX_RATE * dt;
			cur.x += clamp((target.x - cur.x) * k, -step, step);
			cur.z += clamp((target.z - cur.z) * k, -step, step);
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
				// parked under the floor (the def's parking spots: maze 1 is AUTHORED at the board, so its
				// base would leave an invisible collider under every other maze) and not drawn
				const p = data?.gate ? base?.pos ?? [0, -4, 0] : [(k - 3) * 1.2, -4, 2];
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
		/** held marbles to let go: a hold must outlive at least one PHYSICS STEP (the step reads the
		 * kinematic target from the object), so it is released after a few frames — releasing on the
		 * next frame task ran before the step and the body snapped back (measured: no reset landed)
		 * @type {Map<string, number>} */
		const holds = new Map();
		const releaseNext = { add: (/** @type {string} */ uuid) => holds.set(uuid, 4) };
		const resetMarble = (k = shownMaze()) => {
			const m = marble();
			const start = byName('Maze ' + k)?.getObjectByName('Start ' + k)?.position ?? null;
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
		// ---- the engine piece the rules drive -------------------------------------------------
		const marblePiece = api.kit.provide(
			{
				piece: 'marble',
				group: 'Marble Maze (engine)',
				calls: [
					{ name: 'setVars', kind: 'action', label: 'Write the run state', doc: 'Writes these fields (level, status, coins, falls, time, stars, par) into the replicated game variables.', args: [{ key: 'patch', type: 'object' }], node: false },
					{ name: 'startRun', kind: 'action', label: 'Put the marble on a maze', doc: 'The marble on maze N\'s start pad; `run` also starts the simulation and holds the marble while the maze swings in.', args: [{ key: 'maze', type: 'number' }, { key: 'run', type: 'boolean' }], node: false },
					{ name: 'tune', kind: 'action', label: 'Tune the tilt', doc: '{maxTilt (degrees), maxRate (degrees a second)}', args: [{ key: 'settings', type: 'object' }], node: false },
					{ name: 'tell', kind: 'action', label: 'Tell every player', doc: 'A banner on every screen.', args: [{ key: 'text', type: 'string' }, { key: 'sub', type: 'string' }], node: false },
					{ name: 'progress', kind: 'value', label: 'This device\'s maze progress store', vtype: 'any', node: false },
					{ name: 'vars', kind: 'value', label: 'The run state', vtype: 'any', node: false },
					{ name: 'coin', kind: 'event', label: 'On the marble taking a coin', node: false },
					{ name: 'fell', kind: 'event', label: 'On the marble falling (a hole, over the rim)', node: false },
					{ name: 'goal', kind: 'event', label: 'On the marble reaching the gold ring', node: false }
				]
			},
			{
				setVars: (/** @type {any} */ patch) => {
					for (const [k, value] of Object.entries(patch ?? {})) {
						const name = /** @type {any} */ (V)[k];
						const n = Number(value);
						if (name && Number.isFinite(n)) setV(name, n);
					}
				},
				startRun: (/** @type {any} */ maze, /** @type {any} */ run) => {
					const k = Math.max(1, Math.min(MAZE_COUNT, Number(maze) || 1));
					if (run) {
						ensureSim();
						settleUntil = performance.now() + 900;
					}
					resetMarble(k);
				},
				tune: (/** @type {any} */ t) => {
					const tilt = Number(t?.maxTilt);
					const rate = Number(t?.maxRate);
					if (Number.isFinite(tilt) && tilt > 0) MAX_TILT = (tilt * Math.PI) / 180;
					if (Number.isFinite(rate) && rate > 0) MAX_RATE = (rate * Math.PI) / 180;
				},
				tell: (/** @type {any} */ text, /** @type {any} */ sub) => {
					const msg = { op: 'tell', text: String(text ?? ''), sub: String(sub ?? '') };
					api.send(msg);
					tellHere(msg);
				},
				progress: () => ({
					get: () => api.storage?.get?.('progress', null),
					set: (/** @type {any} */ p) => api.storage?.set?.('progress', p)
				}),
				vars: () => Object.fromEntries(Object.entries(V).map(([k, name]) => [k, v(name)]))
			}
		);
		/** @param {any} msg */
		const tellHere = (msg) => {
			if (msg?.text) api.announce(String(msg.text), { sub: String(msg.sub ?? ''), ms: 2400, color: '#ffd45e' });
		};
		/** the rules node on Main (the suites call its methods) */
		const rulesNode = () => api.flow.nodes('behaviour').find((/** @type {any} */ n) => /Marble Maze rules/.test(String(n.data?.name ?? n.data?.label ?? '')))?.id ?? null;
		/** @param {string} method @param {any[]} args */
		const callRules = async (method, ...args) => {
			const m = await import('../../lib/behaviours/app.js');
			return m.behavioursDebug?.().call(rulesNode(), method, ...args);
		};
		let goalSent = -1;
		/** @param {number} n */
		const countBits = (n) => {
			let c = 0;
			for (let i = 0; i < 3; i++) if (n & (1 << i)) c++;
			return c;
		};
		/** maze k's holes: local centre + the half size the marble's centre must be inside
		 * @type {Map<number, any>} */
		const holeCache = new Map();
		/** @param {number} k */
		const holesOf = (k) => {
			const mz = byName('Maze ' + k);
			if (!mz) return [];
			if (!holeCache.has(k) || holeCache.get(k)?.mz !== mz) {
				/** @type {any} */ const list = [];
				list.mz = mz;
				for (const c of mz.children) {
					if (!/^Hole \d+\.\d+$/.test(String(c.name))) continue;
					c.geometry?.computeBoundingBox?.();
					const bb = c.geometry?.boundingBox;
					const size = bb ? (bb.max.x - bb.min.x) * c.scale.x : 0.1;
					list.push({ x: c.position.x, z: c.position.z, half: Math.max(0.01, size / 2 - 0.012) });
				}
				holeCache.set(k, list);
			}
			return holeCache.get(k) ?? [];
		};
		/** a marble dropping through a hole: held, sunk along the board's down for 300 ms
		 * @type {null | {at: number, x: number, z: number, uuid: string}} */
		let falling = null;
		const judge = () => {
			if (!playingNow()) {
				if (falling) {
					releaseNext.add(falling.uuid);
					falling = null;
				}
				return;
			}
			const now = performance.now();
			if (falling) {
				const t = (now - falling.at) / 300;
				const m = marble();
				if (m && t < 1) {
					m.position.copy(toWorld({ x: falling.x, y: 0.035 - t * 0.12, z: falling.z }));
					m.updateMatrixWorld();
					return;
				}
				falling = null;
				resetMarble();
				settleUntil = now + 500;
				return;
			}
			const p = marbleLocal();
			if (!p) return;
			if (now < settleUntil) {
				// the first moments of a run: HOLD the marble on the start pad (kinematic) while the new
				// maze swings in — a maze arriving from its parking spot moves through the marble's
				// place in one step, and a dynamic marble there is launched over the walls
				resetMarble();
				return;
			}
			// over a hole: the marble DROPS through it (a short fall), then back to the start
			const k0 = shownMaze();
			for (const hole of holesOf(k0)) {
				if (Math.abs(p.x - hole.x) < hole.half && Math.abs(p.z - hole.z) < hole.half && p.y < 0.06) {
					const m = marble();
					if (m && phys?.holdBody?.(m.uuid)) {
						falling = { at: now, x: hole.x, z: hole.z, uuid: m.uuid };
						marblePiece.emit('fell', { how: 'hole' });
						return;
					}
				}
			}
			// off the board (a hop over the rim)
			if (p.y < -0.08 || Math.abs(p.x) > 0.7 || Math.abs(p.z) > 0.7) {
				marblePiece.emit('fell', { how: 'rim' });
				resetMarble();
				settleUntil = now + 500;
				return;
			}
			const k = shownMaze();
			const mask = v(V.coins);
			for (let i = 0; i < 3; i++) {
				if (mask & (1 << i)) continue;
				const c = localOf('Coin ' + k + '.' + (i + 1));
				if (c && Math.hypot(p.x - c.x, p.z - c.z) < 0.055 && p.y < 0.12) marblePiece.emit('coin', { index: i });
			}
			const goal = localOf('Goal ' + k);
			const round = Number(game()?.round ?? 0);
			if (goal && goalSent !== round && Math.hypot(p.x - goal.x, p.z - goal.z) < 0.045 && p.y < 0.08) {
				goalSent = round;
				marblePiece.emit('goal', {});
			}
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
				if (m) api.announce('Maze ' + m.id, { sub: m.name + ' — roll to the gold ring, par ' + formatTime(m.par), ms: 2400, color: '#ffd45e' });
				api.playSound('whistle');
				aimDesktopCamera();
			}
		};
		/** desktop: stand at the board and look DOWN at it (the free cursor never turns the view).
		 * Applied for a few frames after a run starts — the shell respawns the player on a restart. */
		let aimFrames = 0;
		const aimDesktopCamera = () => {
			aimFrames = 20;
		};
		/** the desktop eye: 0.62 m back from the board and 0.72 m above it */
		const DESK_EYE = [BOARD[0], BOARD[1] + 0.72, BOARD[2] + 0.62];
		const applyAim = () => {
			if (aimFrames <= 0) return;
			aimFrames--;
			if (isVR() || !scene || !stores) return;
			const cam = stores.get(scene.playerCam);
			if (!cam?.isObject3D) return;
			const target = new THREE.Vector3(...DESK_EYE);
			if (cam.parent) {
				cam.parent.updateWorldMatrix(true, false);
				cam.parent.worldToLocal(target);
			}
			cam.position.copy(target);
			const pitch = -Math.atan2(DESK_EYE[1] - BOARD[1], DESK_EYE[2] - BOARD[2]);
			cam.quaternion.setFromEuler(new THREE.Euler(pitch, 0, 0, 'YXZ'));
			cam.updateMatrixWorld(true);
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
				const table = kit.levels.table?.() ?? [];
				const total = table.reduce((/** @type {number} */ a, /** @type {any} */ r) => a + (prog().levels?.[String(r.id)]?.stars ?? 0), 0);
				return 'Stars earned: ' + total + ' / ' + (table.length || MAZE_COUNT) * 3;
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
						{ key: 'level', kind: 'range', min: 1, max: MAZE_COUNT, step: 1 }
					]
				},
				{
					type: 'marbletilt',
					label: 'Marble tilt',
					defaults: { maze: 1, gate: false, lx: 0, lz: 0, phase: 0 },
					params: [
						{ key: 'maze', kind: 'range', min: 1, max: MAZE_COUNT, step: 1 },
						{ key: 'phase', kind: 'range', min: 0, max: 1, step: 0.05 }
					]
				}
			]
		});

		// a marble you GRAB is no marble maze: refuse it (and the boards) on every grab path
		kit.rules.onGrabRequest?.((/** @type {any} */ req) => {
			if (!active()) return;
			if (/^(Marble|Maze \d|Gate \d)/.test(String(req.name ?? ''))) req.refuse('Tilt the board — grip the handles');
		});

		// ---- the frame --------------------------------------------------------------------------
		let wasActive = false;
		/** @type {null | (() => void)} */ let helpOff = null;
		// 36 U8: touch — no stick and no look: a drag on the canvas IS the tilt (the module's own drag)
		/** @type {null | (() => void)} */ let touchOff = null;
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
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				if (on) touchOff = api.input?.actions?.([], { preset: 'custom', stick: false, look: false }) ?? null;
				if (!on && touchOff) {
					touchOff();
					touchOff = null;
				}
				if (!on) {
					helpOff?.();
					helpOff = null;
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
			for (const [uuid, n] of holds) {
				if (falling?.uuid === uuid) continue;
				if (n > 1) {
					holds.set(uuid, n - 1);
					continue;
				}
				phys?.releaseBody?.(uuid, { linvel: new THREE.Vector3(), angvel: new THREE.Vector3() });
				holds.delete(uuid);
			}
			readInput(dt);
			updateTilt(dt);
			if (authority()) judge();
			moments();
			applyAim();
		});
		api.onSceneClear(() => {
			helpOff?.();
			helpOff = null;
			touchOff?.();
			touchOff = null;
			wasActive = false;
			goalSent = -1;
			announcedRound = -1;
			lastMask = lastFalls = lastStatus = 0;
			cur.x = cur.z = 0;
		});

		// the suites' window onto the module
		/** @type {any} */ (globalThis).__marble = {
			mazes: () => kit.levels.table?.() ?? [],
			authority,
			rulesNode,
			startLevel: (/** @type {number} */ id) => callRules('startMaze', id),
			toMenu: () => callRules('toMenu'),
			info,
			tilt: () => ({ ...cur }),
			eye: () => (scene && stores ? stores.get(scene.playerCam)?.getWorldPosition?.(new THREE.Vector3())?.toArray() : null),
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
			/** put the marble over hole i of the maze on the board (the judge drops it) */
			toHole: (/** @type {number} */ i) => {
				const m = marble();
				const hole = holesOf(shownMaze())[i];
				if (!m || !hole) return false;
				settleUntil = 0;
				const w = toWorld({ x: hole.x, y: 0.04, z: hole.z });
				const held = phys?.holdBody?.(m.uuid);
				m.position.copy(w);
				if (held) releaseNext.add(m.uuid);
				return true;
			},
			holes: () => holesOf(shownMaze()).map((/** @type {any} */ h) => ({ x: h.x, z: h.z, half: h.half })),
			/** a coin taken, for a scripted three-star win */
			takeCoins: () => [0, 1, 2].forEach((i) => marblePiece.emit('coin', { index: i })),
			/** a suite's shortcut to a progress state (written through api.storage like a win) */
			setProgress: (/** @type {any} */ raw) => {
				api.storage?.set?.('progress', raw);
				kit.levels.refresh?.();
				return prog();
			},
			resetProgress: () => {
				api.storage?.remove?.('progress');
				kit.levels.refresh?.();
			}
		};
	}
};
