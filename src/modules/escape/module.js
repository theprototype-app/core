// 35-escape-room: THE ALCHEMIST'S ESCAPE — a three-room escape game. A CORE module (the towers
// precedent), dormant unless the scene carries the `Escape game` marker object.
//
//   Room 1 STUDY     open the desk drawer -> a brass key; the key opens the chest (a crank and the
//                    alchemist's note inside) and the study door. A sun gem waits on the shelf.
//   Room 2 WORKSHOP  set the three dials to the note's numbers -> a hatch opens (the moon gem);
//                    pull the three levers in the note's order -> the star gem rolls out; fit the
//                    crank in its socket and TWIST it (each click / trigger = a quarter turn, eight
//                    turns) to raise the iron gate.
//   Room 3 VAULT     put each gem on its pedestal -> the vault door opens -> step through = win.
//
// WHAT REPLICATES: the puzzle state is a handful of GAME VARIABLES (the replicated game
// singleton), written by whoever clicked; every visual — a door's slide, a gem's visibility, a
// dial's angle, every sound and banner — is DERIVED per peer from those numbers each frame, so a
// joiner and a spectator see exactly what the player sees and this module adds no message. A
// round restart (Start / Restart) zeroes the variables on the lowest peer id.
//
// Puzzle objects are found BY NAME (the template def owns the geometry). Their authored pose is
// the CLOSED pose; the module only offsets from it.

const MARKER = 'Escape game';

/** the state bits (esFlags) */
const F = {
	drawer: 1,
	key: 2,
	chest: 4,
	crank: 8,
	studyDoor: 16,
	sun: 32,
	note: 64,
	fitted: 128,
	hatch: 256,
	moon: 512,
	levers: 1024,
	star: 2048,
	gate: 4096,
	vault: 8192
};
/** pedestal bits (esPlaced) */
const P = { sun: 1, moon: 2, star: 4 };
/** the dial code and the lever order (on the alchemist's note) */
const CODE = [3, 7, 1];
const LEVER_ORDER = ['right', 'left', 'middle'];
const TURNS = 8;
const V = { flags: 'esFlags', placed: 'esPlaced', d1: 'esD1', d2: 'esD2', d3: 'esD3', lev: 'esLev', turns: 'esTurns', start: 'esStart' };
/** the state a stage starts from (the Levels page: practise one room) */
const STAGE_FLAGS = [0, F.drawer | F.key | F.chest | F.crank | F.studyDoor | F.sun | F.note, 0];
STAGE_FLAGS[2] = STAGE_FLAGS[1] | F.fitted | F.hatch | F.moon | F.levers | F.star | F.gate;
/** how long the button is held on the crank per quarter turn (hold-to-twist) */
const TWIST_STEP = 0.32;

const ROOMS = [
	{ name: 'The Study', spawn: [-8, 0, 2.6], yaw: 0, hint: 'The desk drawer sticks, but it opens. A key opens more than one lock.' },
	{ name: 'The Workshop', spawn: [-2.6, 0, 0], yaw: -Math.PI / 2, hint: 'The note says 3 · 7 · 1 for the dials, and RIGHT · LEFT · MIDDLE for the levers. The crank fits the socket by the gate — keep turning it.' },
	{ name: 'The Vault', spawn: [5.4, 0, 0], yaw: -Math.PI / 2, hint: 'Each pedestal wants the gem of its colour: gold sun, pale moon, violet star.' }
];
const NOTE_TEXT = 'The note reads: "DIALS 3 · 7 · 1 — LEVERS right, left, middle — the crank lifts the gate."';
const HINT_AFTER = 60;

export default {
	id: 'escape',
	name: "The Alchemist's Escape",
	version: '1.0.0',
	description: "The Alchemist's Escape: three rooms of drawers, keys, dials, levers and a crank to twist — find the gems and get out. Best time saved on this device.",

	/** @param {any} api */
	register(api) {
		/** @type {any} */ let gs = null;
		/** @type {any} */ let stores = null;
		Promise.all([import('../../lib/gameState'), import('svelte/store')]).then(([a, b]) => {
			gs = a;
			stores = b;
		});
		const THREE = api.THREE;
		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		const game = () => (gs && stores ? stores.get(gs.gameState) : null);
		const running = () => {
			const s = game()?.state;
			return s === 'playing' || s === 'paused' || s === 'over';
		};
		/** @param {string} k @param {number} [fb] */
		const v = (k, fb = 0) => {
			const n = Number(api.game.getVar(k, fb));
			return Number.isFinite(n) ? n : fb;
		};
		/** @param {string} k @param {number} value */
		const setV = (k, value) => {
			if (v(k, NaN) !== value) api.game.setVar(k, value);
		};
		const flags = () => (running() ? v(V.flags) : 0);
		const placed = () => (running() ? v(V.placed) : 0);
		/** @param {number} bit */
		const has = (bit) => (flags() & bit) !== 0;
		/** @param {number} bit */
		const setFlag = (bit) => setV(V.flags, v(V.flags) | bit);
		/** @param {number} bit */
		const clearFlag = (bit) => setV(V.flags, v(V.flags) & ~bit);
		const dials = () => [v(V.d1), v(V.d2), v(V.d3)];
		const amLowest = () => {
			const me = String(api.peerId?.() ?? '');
			const ids = (api.peerIds?.() ?? []).map(String);
			return ids.every((id) => !me || me <= id);
		};
		/** where the player is (camera / VR head), [x, y, z] */
		const playerPos = () => {
			const p = api.playerPosition?.();
			return Array.isArray(p) ? p : null;
		};
		const roomOf = (/** @type {number} */ x) => (x < -4 ? 0 : x < 4 ? 1 : 2);
		const say = (/** @type {string} */ text, /** @type {any} */ opts = {}) => api.announce?.(text, { ms: 2600, color: '#ffd9a0', ...opts });
		const sound = (/** @type {string} */ s, /** @type {any} */ pos) => api.playSound?.(s, pos);
		const posOf = (/** @type {string} */ name) => {
			const o = byName(name);
			if (!o) return undefined;
			const w = new THREE.Vector3();
			o.getWorldPosition(w);
			return [w.x, w.y, w.z];
		};

		// ---- the actions (a click, a VR trigger, a suite's scripted press) ----------------------
		/** @param {string} name the puzzle object's name @returns {boolean} consumed */
		const act = (name) => {
			if (!active()) return false;
			if (game()?.state !== 'playing') return false;
			switch (name) {
				case 'Desk drawer':
					if (!has(F.drawer)) setFlag(F.drawer);
					else if (!has(F.key)) say('A brass key lies in the drawer.');
					else say('An empty drawer.');
					return true;
				case 'Brass key':
					if (has(F.drawer) && !has(F.key)) setFlag(F.key);
					return true;
				case 'Chest lid':
				case 'Chest body':
					if (has(F.chest)) return true;
					if (!has(F.key)) {
						say('The chest is locked.', { sub: 'There is a small brass keyhole.' });
						sound('fail', posOf('Chest body'));
					} else setFlag(F.chest);
					return true;
				case 'Crank':
					if (has(F.chest) && !has(F.crank)) setFlag(F.crank);
					return true;
				case 'Old note':
					if (!has(F.note)) setFlag(F.note);
					say(NOTE_TEXT, { ms: 6500, color: '#f3e3b8' });
					sound('pop', posOf('Old note'));
					return true;
				case 'Sun gem':
					if (!has(F.sun)) setFlag(F.sun);
					return true;
				case 'Study door':
					if (has(F.studyDoor)) return true;
					if (!has(F.key)) {
						say('The study door is locked.', { sub: 'Find its key.' });
						sound('fail', posOf('Study door'));
					} else setFlag(F.studyDoor);
					return true;
				case 'Dial 1':
				case 'Dial 2':
				case 'Dial 3': {
					if (has(F.hatch)) return true;
					const k = name === 'Dial 1' ? V.d1 : name === 'Dial 2' ? V.d2 : V.d3;
					setV(k, (v(k) + 1) % 10);
					sound('click', posOf(name));
					const d = dials();
					if (d[0] === CODE[0] && d[1] === CODE[1] && d[2] === CODE[2]) setFlag(F.hatch);
					return true;
				}
				case 'Moon gem':
					if (has(F.hatch) && !has(F.moon)) setFlag(F.moon);
					return true;
				case 'Lever left':
				case 'Lever middle':
				case 'Lever right': {
					if (has(F.levers)) return true;
					const which = name.slice(6);
					const step = v(V.lev);
					if (LEVER_ORDER[step] === which) {
						setV(V.lev, step + 1);
						if (step + 1 >= LEVER_ORDER.length) setFlag(F.levers);
					} else {
						setV(V.lev, 0);
						say('Clunk — the levers spring back.', { sub: 'Wrong order.', color: '#ffb86b' });
						sound('fail', posOf(name));
					}
					return true;
				}
				case 'Star gem':
					if (has(F.levers) && !has(F.star)) setFlag(F.star);
					return true;
				case 'Crank socket':
				case 'Fitted crank':
					if (has(F.gate)) return true;
					if (!has(F.fitted)) {
						if (!has(F.crank)) {
							say('An empty square socket.', { sub: 'Something with a handle would fit.' });
							sound('fail', posOf('Crank socket'));
						} else setFlag(F.fitted);
						return true;
					}
					{
						const t = v(V.turns) + 1;
						setV(V.turns, t);
						if (t >= TURNS) setFlag(F.gate);
					}
					return true;
				case 'Pedestal sun':
				case 'Pedestal moon':
				case 'Pedestal star': {
					const gem = name.slice(9);
					const bit = gem === 'sun' ? P.sun : gem === 'moon' ? P.moon : P.star;
					const held = gem === 'sun' ? F.sun : gem === 'moon' ? F.moon : F.star;
					if (placed() & bit) return true;
					if (!has(held)) {
						say('This pedestal wants the ' + gem + ' gem.', { color: '#c7b8ff' });
						return true;
					}
					const now = v(V.placed) | bit;
					setV(V.placed, now);
					if (now === 7) setFlag(F.vault);
					return true;
				}
				case 'Hint crystal 1':
				case 'Hint crystal 2':
				case 'Hint crystal 3':
					hint(Number(name.slice(-1)) - 1);
					return true;
				case 'Exit portal':
					if (has(F.vault)) win();
					return true;
			}
			return false;
		};

		/** @type {number[]} when this peer entered each room (seconds of the round) */
		let roomSince = [0, 0, 0];
		let curRoom = 0;
		/** @param {number} [room] */
		const hint = (room = curRoom) => {
			const el = gs ? gs.gameElapsed() : 0;
			const wait = Math.ceil(HINT_AFTER - (el - roomSince[room]));
			if (wait > 0) {
				say('The crystal is still gathering light…', { sub: 'A hint for this room in ' + wait + ' s. Press H then.', color: '#9ee6ff' });
				sound('sparkle');
				return;
			}
			say('Hint — ' + ROOMS[room].name, { sub: ROOMS[room].hint, ms: 7000, color: '#9ee6ff' });
			sound('sparkle');
		};
		const win = () => {
			if (!gs || game()?.state !== 'playing') return;
			gs.setGameState('over', { outcome: 'won' });
		};

		api.registerClickHandler(
			(/** @type {any} */ object) => {
				if (!active()) return false;
				for (let o = object; o && o !== group(); o = o.parent) if (o.name && act(o.name)) return true;
				return false;
			},
			{ modes: ['interact', 'play'] }
		);
		// H = a hint (desktop)
		api.onInput?.((/** @type {string} */ kind, /** @type {string} */ code) => {
			if (!active() || game()?.state !== 'playing') return;
			if (kind === 'down' && code === 'KeyH') hint();
		});

		// ---- the derived world (every peer, every frame) --------------------------------------
		/** uuid -> the authored (closed) pose */
		/** @type {Map<string, {pos: any, rot: any}>} */ const base = new Map();
		/** @param {any} o */
		const baseOf = (o) => {
			let b = base.get(o.uuid);
			if (!b) {
				b = { pos: o.position.clone(), rot: o.rotation.clone() };
				base.set(o.uuid, b);
			}
			return b;
		};
		/** ease an object toward base + offset @param {string} name @param {number[]} dpos @param {number[]} drot @param {number} dt */
		const pose = (name, dpos, drot, dt) => {
			const o = byName(name);
			if (!o) return;
			const b = baseOf(o);
			const k = Math.min(1, dt * 6);
			o.position.x += (b.pos.x + dpos[0] - o.position.x) * k;
			o.position.y += (b.pos.y + dpos[1] - o.position.y) * k;
			o.position.z += (b.pos.z + dpos[2] - o.position.z) * k;
			o.rotation.x += (b.rot.x + drot[0] - o.rotation.x) * k;
			o.rotation.y += (b.rot.y + drot[1] - o.rotation.y) * k;
			o.rotation.z += (b.rot.z + drot[2] - o.rotation.z) * k;
		};
		/** @param {string} name @param {boolean} on */
		const show = (name, on) => {
			const o = byName(name);
			if (o && o.visible !== on) o.visible = on;
		};

		/** the previous frame's state, for the moments (sounds + banners) */
		let prevFlags = -1;
		let prevPlaced = 0;
		let prevTurns = 0;
		let prevLev = 0;
		let prevState = '';
		let prevRound = -1;
		let lastT = 0;
		let fenceAt = 0;
		const moments = () => {
			const f = flags();
			const pl = placed();
			const turns = running() ? v(V.turns) : 0;
			const lev = running() ? v(V.lev) : 0;
			if (prevFlags < 0) {
				prevFlags = f;
				prevPlaced = pl;
				prevTurns = turns;
				prevLev = lev;
				return;
			}
			const rose = (/** @type {number} */ bit) => (f & bit) !== 0 && (prevFlags & bit) === 0;
			if (rose(F.drawer)) sound('lid', posOf('Desk drawer'));
			if (rose(F.key)) {
				say('You take the brass key.', { color: '#ffd45e' });
				sound('coin');
			}
			if (rose(F.chest)) {
				say('Unlocked! The chest creaks open.', { sub: 'A crank and an old note inside.', color: '#ffd45e' });
				sound('lid', posOf('Chest body'));
				sound('success');
			}
			if (rose(F.crank)) {
				say('You take the iron crank.');
				sound('coin');
			}
			if (rose(F.sun)) {
				say('The sun gem!', { sub: '1 of 3 gems', color: '#ffd45e' });
				sound('sparkle');
				api.effects?.burst?.(posOf('Sun gem') ?? [0, 1, 0], { kind: 'sparkle', color: '#ffd45e' });
			}
			if (rose(F.studyDoor)) {
				say('Click — the study door unlocks.', { color: '#ffd45e' });
				sound('door', posOf('Study door'));
			}
			if (rose(F.hatch)) {
				say('A hatch springs open above the dials!', { sub: 'The moon gem.', color: '#cfe6ff' });
				sound('success', posOf('Dial hatch'));
			}
			if (rose(F.moon)) {
				say('The moon gem!', { sub: 'Pale and cold.', color: '#cfe6ff' });
				sound('sparkle');
			}
			if (rose(F.levers)) {
				say('Gears whirr — something rolls into the tray.', { sub: 'The star gem.', color: '#d6b8ff' });
				sound('success', posOf('Star tray'));
			}
			if (rose(F.star)) {
				say('The star gem!', { color: '#d6b8ff' });
				sound('sparkle');
			}
			if (rose(F.fitted)) {
				say('The crank fits the socket.', { sub: 'Now TURN it — click again and again.', color: '#ffd9a0' });
				sound('click', posOf('Crank socket'));
			}
			if (turns > prevTurns && !(f & F.gate)) sound('gate', posOf('Workshop gate'));
			if (rose(F.gate)) {
				say('The iron gate is up!', { sub: 'The vault lies beyond.', color: '#ffd45e' });
				sound('levelup');
			}
			if (lev > prevLev) sound('lever', posOf(['Lever right', 'Lever left', 'Lever middle'][lev - 1]));
			if (pl !== prevPlaced) {
				for (const [gem, bit] of Object.entries(P))
					if (pl & bit && !(prevPlaced & bit)) {
						sound('success', posOf('Pedestal ' + gem));
						api.effects?.burst?.(posOf('Pedestal ' + gem) ?? [0, 1, 0], { kind: 'sparkle' });
					}
			}
			if (rose(F.vault)) {
				say('The vault door grinds open!', { sub: 'Step through to escape.', color: '#7dffb0', ms: 4000 });
				sound('door', posOf('Vault door'));
				api.hapticPattern?.('success');
			}
			prevFlags = f;
			prevPlaced = pl;
			prevTurns = turns;
			prevLev = lev;
		};

		const world = (/** @type {number} */ dt) => {
			const f = flags();
			const pl = placed();
			const d = running() ? dials() : [0, 0, 0];
			const turns = running() ? v(V.turns) : 0;
			const lev = running() ? v(V.lev) : 0;
			const done = (f & F.levers) !== 0;
			pose('Desk drawer', [0, 0, f & F.drawer ? 0.38 : 0], [0, 0, 0], dt);
			show('Brass key', (f & F.drawer) !== 0 && !(f & F.key));
			pose('Brass key', [0, 0, f & F.drawer ? 0.38 : 0], [0, 0, 0], dt);
			pose('Chest lid', [0, 0, 0], [f & F.chest ? -1.9 : 0, 0, 0], dt);
			show('Crank', (f & F.chest) !== 0 && !(f & F.crank));
			show('Sun gem', !(f & F.sun));
			pose('Study door', [0, 0, f & F.studyDoor ? 1.55 : 0], [0, 0, 0], dt);
			for (let i = 0; i < 3; i++) pose('Dial ' + (i + 1), [0, 0, 0], [0, (d[i] * Math.PI * 2) / 10, 0], dt);
			pose('Dial hatch', [0, f & F.hatch ? 0.5 : 0, 0], [0, 0, 0], dt);
			show('Moon gem', (f & F.hatch) !== 0 && !(f & F.moon));
			['right', 'left', 'middle'].forEach((w, i) => pose('Lever ' + w, [0, 0, 0], [done || lev > i ? -1.1 : 0, 0, 0], dt));
			show('Star gem', done && !(f & F.star));
			show('Fitted crank', (f & F.fitted) !== 0);
			pose('Fitted crank', [0, 0, 0], [(-turns * Math.PI) / 2, 0, 0], dt);
			pose('Workshop gate', [0, (2.3 * Math.min(turns, TURNS)) / TURNS, 0], [0, 0, 0], dt);
			for (const [gem, bit] of Object.entries(P)) show('Placed ' + gem, (pl & bit) !== 0);
			pose('Vault door', [0, 0, f & F.vault ? -1.55 : 0], [0, 0, 0], dt);
			show('Exit portal', (f & F.vault) !== 0);
			// the one lamp follows the player from room to room (a lights budget of two)
			const lamp = byName('Room lamp');
			if (lamp) {
				const lx = [-8, 0, 8][running() ? curRoom : 0];
				lamp.position.x += (lx - lamp.position.x) * Math.min(1, dt * 3);
			}
		};

		/** keep the player in the rooms they have opened (desktop walking, VR stick) */
		const fence = (/** @type {number} */ now) => {
			const p = playerPos();
			if (!p || game()?.state !== 'playing' || api.isPlaying?.() === false) return;
			const f = flags();
			const x = p[0];
			let limit = Infinity;
			if (!(f & F.studyDoor)) limit = -4.15;
			else if (!(f & F.gate)) limit = 3.85;
			else if (!(f & F.vault)) limit = 11.85;
			if (x > limit && now - fenceAt > 1) {
				fenceAt = now;
				const r = roomOf(Math.min(x, limit - 0.5));
				api.setSpawn?.(ROOMS[r].spawn, ROOMS[r].yaw);
				api.respawnPlayer?.();
				say('The way is shut.', { ms: 1400, color: '#ffb86b' });
			}
			if (f & F.vault && x > 12.7) win();
			const room = roomOf(x);
			if (room !== curRoom) {
				curRoom = room;
				roomSince[room] = gs ? gs.gameElapsed() : 0;
				api.setSpawn?.(ROOMS[room].spawn, ROOMS[room].yaw);
				say(ROOMS[room].name, { ms: 1800, color: '#f3e3b8' });
			}
		};

		// ---- the HUD words (a value node into HUD Text's format) ------------------------------
		const fmt = (/** @type {number} */ s) => {
			const t = Math.max(0, s);
			return Math.floor(t / 60) + ':' + String(Math.floor(t % 60)).padStart(2, '0');
		};
		const best = () => Number(api.storage?.get?.('best', 0)) || 0;
		const info = (/** @type {any} */ data) => {
			const f = flags();
			const pl = placed();
			switch (String(data?.read ?? 'room')) {
				case 'room':
					return ROOMS[curRoom].name;
				case 'clock':
					return fmt(gs ? gs.gameElapsed() : 0);
				case 'inventory': {
					const items = [];
					if (f & F.key) items.push('Key');
					if (f & F.crank && !(f & F.fitted)) items.push('Crank');
					if (f & F.note) items.push('Note');
					if (f & F.sun && !(pl & P.sun)) items.push('Sun gem');
					if (f & F.moon && !(pl & P.moon)) items.push('Moon gem');
					if (f & F.star && !(pl & P.star)) items.push('Star gem');
					return 'Carrying: ' + (items.length ? items.join(' · ') : 'nothing');
				}
				case 'gems':
					return 'Gems ' + [F.sun, F.moon, F.star].filter((b) => f & b).length + ' / 3';
				case 'goal': {
					if (!(f & F.studyDoor)) return 'Find a way out of the study';
					if (!(f & F.gate)) return 'Open the iron gate · dials ' + dials().join(' · ') + ' · crank ' + Math.min(v(V.turns), TURNS) + '/' + TURNS;
					if (!(f & F.vault)) return 'Place the three gems on their pedestals';
					return 'The door is open — escape!';
				}
				case 'result':
					return 'You escaped in ' + fmt(lastTime);
				case 'best': {
					const b = best();
					return b > 0 ? 'Best escape on this device: ' + fmt(b) : ' ';
				}
				case 'menuBest': {
					const b = best();
					return b > 0 ? 'Your best escape: ' + fmt(b) : 'Three rooms. Three gems. One way out.';
				}
			}
			return ' ';
		};
		let lastTime = 0;
		api.registerValueNode(
			'escapeinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		api.registerNodeGroup({
			group: 'Escape',
			items: [
				{
					type: 'escapeinfo',
					label: 'Escape info',
					defaults: { read: 'room' },
					params: [{ key: 'read', kind: 'select', options: ['room', 'clock', 'inventory', 'gems', 'goal', 'result', 'best', 'menuBest'] }]
				}
			]
		});

		const HELP = [
			"You are locked in the alchemist's house. Three rooms, three gems, one way out.",
			'Click things to use them (VR: point and pull the trigger). What you pick up is listed at the top.',
			'Walk with WASD (VR: stick or teleport). Turn the crank by clicking it again and again.',
			'Stuck? Touch the blue hint crystal in each room, or press H — a hint arrives after a minute in a room.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		const resetPuzzle = () => {
			for (const k of Object.values(V)) setV(k, 0);
		};

		/** start a fresh round in a stage (0 study, 1 workshop, 2 vault) — the Levels page */
		const startStage = (/** @type {number} */ stage) => {
			if (!gs) return;
			pendingStage = stage;
			if (game()?.state === 'playing') gs.setGameState('menu');
			gs.setGameState('playing');
		};
		let pendingStage = -1;
		const applyStage = (/** @type {number} */ stage) => {
			resetPuzzle();
			setV(V.start, stage);
			if (stage <= 0) return;
			setV(V.flags, STAGE_FLAGS[stage]);
			if (stage >= 2) {
				setV(V.d1, CODE[0]);
				setV(V.d2, CODE[1]);
				setV(V.d3, CODE[2]);
				setV(V.lev, 3);
				setV(V.turns, TURNS);
			}
		};
		/** @type {any} */ let levelsOff = null;
		const defineLevels = () => {
			if (typeof api.game?.levels !== 'function') return;
			levelsOff = api.game.levels({
				list: ROOMS.map((r, i) => ({ id: String(i + 1), label: i + 1 + ' · ' + r.name + (i ? ' (practice)' : '') })),
				current: String(curRoom + 1),
				onPick: (/** @type {string} */ id) => startStage(Number(id) - 1)
			});
		};

		// HOLD TO TWIST: the button held on the fitted crank keeps turning it (a quarter turn
		// every TWIST_STEP s); a click is still one turn, and a VR trigger press is one turn
		let twisting = false;
		let twistHeld = 0;
		const onCrank = () => {
			const ray = api.pointerRay?.();
			const crank = byName('Fitted crank');
			if (!ray || !crank || !crank.visible) return false;
			const hit = ray.intersectObject(crank, true)[0];
			return !!hit && hit.distance < 4;
		};
		const down = (/** @type {PointerEvent} */ e) => {
			if (e.button !== 0 || !active() || game()?.state !== 'playing' || !has(F.fitted) || has(F.gate)) return;
			if (onCrank()) {
				twisting = true;
				twistHeld = 0;
			}
		};
		const up = () => (twisting = false);
		window.addEventListener('pointerdown', down, true);
		window.addEventListener('pointerup', up, true);
		api.onUnload?.(() => {
			window.removeEventListener('pointerdown', down, true);
			window.removeEventListener('pointerup', up, true);
		});
		const twist = (/** @type {number} */ dt) => {
			if (!twisting) return;
			if (has(F.gate) || game()?.state !== 'playing') {
				twisting = false;
				return;
			}
			twistHeld += dt;
			// the first turn is the click's own; the hold adds one per step after it
			if (twistHeld >= TWIST_STEP) {
				twistHeld -= TWIST_STEP;
				if (onCrank()) act('Fitted crank');
				else twisting = false;
			}
		};

		let wasActive = false;
		api.registerFrameTask((/** @type {number} */ time) => {
			if (!gs || !stores) return;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				if (!on && helpOff) {
					helpOff();
					helpOff = null;
				}
				if (on) api.game?.onRestart?.(() => amLowest() && applyStage(v(V.start)));
				if (on) defineLevels();
				if (!on && typeof levelsOff === 'function') {
					levelsOff();
					levelsOff = null;
				}
			}
			if (!on) return;
			const dt = Math.min(0.1, Math.max(0, time - lastT));
			lastT = time;
			const g = game();
			// a fresh round (Start / Restart): the lowest peer id zeroes the puzzle
			if (g && g.state === 'playing' && g.round !== prevRound) {
				prevRound = g.round;
				const stage = Math.max(0, pendingStage);
				pendingStage = -1;
				if (amLowest()) applyStage(stage);
				curRoom = stage;
				roomSince = [0, 0, 0];
				prevFlags = -1;
				api.setSpawn?.(ROOMS[stage].spawn, ROOMS[stage].yaw, { teleport: stage > 0 });
				say("The Alchemist's Escape", { sub: 'Find the three gems and get out.', ms: 3200, color: '#ffd45e' });
				api.music?.play?.('dungeon', { volume: 0.35 });
			}
			if (g && g.state !== prevState) {
				if (g.state === 'over' && prevState === 'playing' && g.outcome === 'won') {
					lastTime = gs.gameElapsed();
					const b = best();
					if (v(V.start) === 0 && (!(b > 0) || lastTime < b)) api.storage?.set?.('best', Math.round(lastTime * 10) / 10);
					api.music?.stop?.();
					sound('cheer');
					api.announce?.('You escaped!', { sub: 'in ' + fmt(lastTime), ms: 4000, color: '#7dffb0' });
					api.effects?.burst?.(playerPos() ?? [13, 1.5, 0], { kind: 'confetti' });
				}
				if (g.state === 'menu') api.music?.stop?.();
				prevState = g.state;
			}
			twist(dt);
			world(dt);
			moments();
			fence(time);
		});
		api.onSceneClear(() => {
			if (typeof levelsOff === 'function') {
				levelsOff();
				levelsOff = null;
			}
			twisting = false;
			if (helpOff) {
				helpOff();
				helpOff = null;
			}
			base.clear();
			wasActive = false;
			prevFlags = -1;
			prevRound = -1;
			prevState = '';
		});

		// the suites' window (scripted presses go through the same act())
		/** @type {any} */ (globalThis).__escape = {
			act,
			flags: () => flags(),
			placed: () => placed(),
			info,
			room: () => curRoom,
			best,
			startStage,
			twisting: () => twisting,
			solve: () => {
				for (const n of ['Desk drawer', 'Brass key', 'Chest lid', 'Crank', 'Old note', 'Sun gem', 'Study door']) act(n);
			}
		};
	}
};
