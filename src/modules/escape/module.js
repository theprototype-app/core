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
// 36 (U10) — THIS FILE IS THE ENGINE, NOT THE RULES. What each drawer, key, dial, lever, crank
// and pedestal DOES, the dial code, the lever order and the crank's turns live in the
// "Escape rules" behaviour on the game's Main graph (scripts/templates/rules/escape-room.rules.js).
// The engine lends them the `escape` piece (api.kit.provide): it reports what a player USED
// (`escape.use` — a click, a VR trigger, a held crank, walking into the portal) and when a fresh
// round starts (`escape.roundStarted`), stores the puzzle state the rules write
// (`kit.escape.setVars`) and says what the rules tell a player (`kit.escape.tell`).
//
// WHAT REPLICATES: the puzzle state is a handful of GAME VARIABLES (the replicated game
// singleton), written by the rules on the session's authority; every visual — a door's slide, a
// gem's visibility, a dial's angle, every sound and banner — is DERIVED per peer from those numbers
// each frame, so a joiner and a spectator see exactly what the player sees. A use travels as one
// module message to every peer (the rules act on the authority's copy).
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
/** the game variables the rules write (kit.escape.setVars keys -> variable names). `code` and
 * `levers` are the note's numbers as digits (371; levers 1 left, 2 middle, 3 right) so the HUD
 * and the hints can say them; `round` is the round the rules last set up. */
const V = {
	flags: 'esFlags',
	placed: 'esPlaced',
	d1: 'esD1',
	d2: 'esD2',
	d3: 'esD3',
	lev: 'esLev',
	turns: 'esTurns',
	start: 'esStart',
	turnsMax: 'esTurnsMax',
	code: 'esCode',
	levers: 'esLevers',
	round: 'esRound'
};
/** everything a player can use (the rules decide what happens) */
const USABLE = new Set([
	'Desk drawer', 'Brass key', 'Chest lid', 'Chest body', 'Crank', 'Old note', 'Sun gem', 'Study door',
	'Dial 1', 'Dial 2', 'Dial 3', 'Moon gem', 'Lever left', 'Lever middle', 'Lever right', 'Star gem',
	'Crank socket', 'Fitted crank', 'Pedestal sun', 'Pedestal moon', 'Pedestal star', 'Workshop gate',
	'Vault door', 'Exit portal'
]);
const LEVER_NAMES = ['', 'left', 'middle', 'right'];
/** how long the button is held on the crank per quarter turn (hold-to-twist) */
const TWIST_STEP = 0.32;

const ROOMS = [
	{ name: 'The Study', spawn: [-8, 0, 2.6], yaw: 0, hint: 'The desk drawer sticks, but it opens. A key opens more than one lock.' },
	{ name: 'The Workshop', spawn: [-2.6, 0, 0], yaw: -Math.PI / 2, hint: 'The note says {code} for the dials, and {levers} for the levers. The crank fits the socket by the gate — keep turning it.' },
	{ name: 'The Vault', spawn: [5.4, 0, 0], yaw: -Math.PI / 2, hint: 'Each pedestal wants the gem of its colour: gold sun, pale moon, violet star.' }
];
const HINT_AFTER = 60;

export default {
	id: 'escape',
	name: "The Alchemist's Escape",
	version: '2.0.0',
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
		/** where the player is (camera / VR head), [x, y, z] */
		const playerPos = () => {
			const p = api.playerPosition?.();
			return Array.isArray(p) ? p : null;
		};
		const roomOf = (/** @type {number} */ x) => (x < -4 ? 0 : x < 4 ? 1 : 2);
		const say = (/** @type {string} */ text, /** @type {any} */ opts = {}) => api.announce?.(text, { ms: 2600, color: '#ffd9a0', ...opts });
		/** @param {string} s @param {any} [pos] */
		const sound = (s, pos) => api.playSound?.(s, pos);
		const posOf = (/** @type {string} */ name) => {
			const o = byName(name);
			if (!o) return undefined;
			const w = new THREE.Vector3();
			o.getWorldPosition(w);
			return [w.x, w.y, w.z];
		};

		// ---- the note's numbers, as the rules last wrote them (for the HUD and the hints) -------
		const digits = (/** @type {number} */ n) => String(Math.max(0, Math.round(n))).split('').map(Number);
		const codeWords = () => {
			const n = v(V.code, -1);
			return n < 0 ? '?' : String(Math.round(n)).padStart(3, '0').split('').join(' · ');
		};
		const leverWords = () =>
			digits(v(V.levers))
				.map((i) => LEVER_NAMES[i] ?? '?')
				.filter(Boolean)
				.map((w) => w.toUpperCase())
				.join(' · ') || '?';
		const turnsMax = () => Math.max(1, v(V.turnsMax, 8));

		// ---- the engine piece the rules drive ------------------------------------------------------
		const me = () => String(api.peerId?.() ?? '');
		/** say what the rules tell a player, here @param {string} text @param {any} [o] */
		const tellHere = (text, o = {}) => {
			if (!text) return;
			say(String(text), {
				...(o.sub ? { sub: String(o.sub) } : {}),
				...(o.ms ? { ms: Number(o.ms) } : {}),
				...(o.color ? { color: String(o.color) } : {})
			});
			if (o.sound) sound(String(o.sound), o.at ? posOf(String(o.at)) : undefined);
		};
		const escape = api.kit.provide(
			{
				piece: 'escape',
				group: "Alchemist's Escape (engine)",
				calls: [
					{ name: 'setVars', kind: 'action', label: 'Write the puzzle state', doc: 'Writes these puzzle fields (flags, placed, d1-d3, lev, turns, start, turnsMax, code, levers, round) into the game variables every peer draws the house from.', args: [{ key: 'patch', type: 'object' }], node: false },
					{ name: 'tell', kind: 'action', label: 'Tell a player', doc: 'A banner (and an optional sound at an object) on the screen of the player who used something.', args: [{ key: 'by', type: 'string' }, { key: 'text', type: 'string' }, { key: 'options', type: 'object' }], node: false },
					{ name: 'vars', kind: 'value', label: 'The puzzle state', vtype: 'any', node: false },
					{ name: 'use', kind: 'event', label: 'On a player using something', node: false },
					{ name: 'roundStarted', kind: 'event', label: 'On a fresh round (Start, Restart, a practice room)', node: false }
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
				tell: (/** @type {any} */ by, /** @type {any} */ text, /** @type {any} */ options) => {
					const who = String(by ?? '');
					if (!who || who === me()) tellHere(text, options ?? {});
					if (who !== me()) api.send({ op: 'tell', to: who, text: String(text ?? ''), options: options ?? {} });
				},
				vars: () => Object.fromEntries(Object.entries(V).map(([k, name]) => [k, v(name)]))
			}
		);
		/** an event every peer hears (the rules act on the authority's copy) @param {string} name @param {any} payload */
		const emitAll = (name, payload) => {
			escape.emit(name, payload);
			api.send({ op: 'ev', name, payload });
		};
		api.onMessage((/** @type {any} */ msg) => {
			if (msg?.op === 'ev' && typeof msg.name === 'string') escape.emit(msg.name, msg.payload ?? {});
			else if (msg?.op === 'tell' && String(msg.to) === me()) tellHere(msg.text, msg.options ?? {});
		});

		// ---- the actions (a click, a VR trigger, a suite's scripted press) ----------------------
		/** @param {string} name the puzzle object's name @returns {boolean} consumed */
		const act = (name) => {
			if (!active()) return false;
			if (game()?.state !== 'playing') return false;
			if (/^Hint crystal [123]$/.test(name)) {
				hint(Number(name.slice(-1)) - 1);
				return true;
			}
			if (!USABLE.has(name)) return false;
			if (!escape.listening('use')) {
				say('Nothing happens.', { sub: 'The rules of this house are not running — open the Escape rules node.', color: '#ffb86b' });
				return true;
			}
			emitAll('use', { name, by: me() });
			return true;
		};

		/** @type {number[]} when this peer entered each room (seconds of the round) */
		let roomSince = [0, 0, 0];
		let curRoom = 0;
		const hintText = (/** @type {number} */ room) => ROOMS[room].hint.replace('{code}', codeWords()).replace('{levers}', leverWords());
		/** @param {number} [room] */
		const hint = (room = curRoom) => {
			const el = gs ? gs.gameElapsed() : 0;
			const wait = Math.ceil(HINT_AFTER - (el - roomSince[room]));
			if (wait > 0) {
				say('The crystal is still gathering light…', { sub: 'A hint for this room in ' + wait + ' s. Press H then.', color: '#9ee6ff' });
				sound('sparkle');
				return;
			}
			say('Hint — ' + ROOMS[room].name, { sub: hintText(room), ms: 7000, color: '#9ee6ff' });
			sound('sparkle');
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
		let prevDials = '';
		let prevState = '';
		let prevRound = -1;
		let lastT = 0;
		let fenceAt = 0;
		let portalAt = 0;
		const moments = () => {
			const f = flags();
			const pl = placed();
			const turns = running() ? v(V.turns) : 0;
			const lev = running() ? v(V.lev) : 0;
			const dialKey = running() ? dials().join(',') : '';
			if (prevFlags < 0) {
				prevDials = dialKey;
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
			if (dialKey !== prevDials && prevDials) {
				const was = prevDials.split(',');
				dials().forEach((d, i) => {
					if (String(d) !== was[i]) sound('click', posOf('Dial ' + (i + 1)));
				});
			}
			prevDials = dialKey;
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
			pose('Workshop gate', [0, (2.3 * Math.min(turns, turnsMax())) / turnsMax(), 0], [0, 0, 0], dt);
			for (const [gem, bit] of Object.entries(P)) show('Placed ' + gem, (pl & bit) !== 0);
			pose('Vault door', [0, 0, f & F.vault ? -1.55 : 0], [0, 0, 0], dt);
			show('Exit portal', (f & F.vault) !== 0);
			// a hint crystal breathes once its room's hint is ready
			const el = gs && running() ? gs.gameElapsed() : 0;
			for (let r = 0; r < 3; r++) {
				const c = byName('Hint crystal ' + (r + 1));
				if (!c) continue;
				const ready = running() && r === curRoom && el - roomSince[r] >= HINT_AFTER;
				const k = ready ? 1 + 0.25 * Math.sin(el * 4) : 1;
				c.scale.setScalar(k);
				c.rotation.y += dt * (ready ? 2 : 0.4);
			}
			// the one lamp follows the player from room to room (a lights budget of two)
			const lamp = byName('Room lamp');
			if (lamp) {
				const pp = playerPos();
				const lx = [-8, 0, 8][pp ? roomOf(Math.min(pp[0], 11.9)) : curRoom];
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
				// a BUMP: back to just before the shut door, facing it, then the room's spawn again
				const r = roomOf(Math.min(x, limit - 0.5));
				api.setSpawn?.([limit - 0.75, 0, Math.max(-0.6, Math.min(0.6, p[2]))], -Math.PI / 2);
				api.respawnPlayer?.();
				api.setSpawn?.(ROOMS[r].spawn, ROOMS[r].yaw);
				say('The way is shut.', { ms: 1400, color: '#ffb86b' });
				api.hapticPattern?.('bump');
			}
			// walking through the open vault: the rules hear it as using the exit portal
			if (f & F.vault && x > 12.7 && now - portalAt > 1) {
				portalAt = now;
				act('Exit portal');
			}
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
					if (!(f & F.gate))
						return (
							'Open the iron gate · dials ' + dials().join(' · ') + ' · crank ' + Math.min(v(V.turns), turnsMax()) + '/' + turnsMax() +
							(f & F.note ? '  —  note: ' + codeWords().replace(/ /g, '') + ', levers ' + leverWords().replace(/([A-Z])[A-Z]*/g, '$1').replace(/ /g, '') : '')
						);
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
		// 36 U8: touch — tap to use what the crosshair is on, and the hint key as a button
		/** @type {null | (() => void)} */ let touchOff = null;
		/** start a fresh round in a stage (0 study, 1 workshop, 2 vault) — the Levels page */
		const startStage = (/** @type {number} */ stage) => {
			if (!gs) return;
			pendingStage = stage;
			if (game()?.state === 'playing') gs.setGameState('menu');
			gs.setGameState('playing');
		};
		let pendingStage = -1;
		/** the stage this peer started the round in, and the round the rules were last asked about */
		let localStage = 0;
		let askedAt = -1;
		let setupRound = -1;
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
		let vrHeldBefore = false;
		const twist = (/** @type {number} */ dt) => {
			// VR: a trigger or GRIP held while pointing at the fitted crank twists it, like the mouse
			if (api.isVR?.()) {
				const b = api.input?.()?.vrButtons ?? {};
				const held = !!(b.rtrigger || b.ltrigger || b.rsqueeze || b.lsqueeze);
				if (held && !vrHeldBefore && has(F.fitted) && !has(F.gate) && game()?.state === 'playing' && onCrank()) {
					twisting = true;
					twistHeld = 0;
				}
				if (!held && vrHeldBefore) twisting = false;
				vrHeldBefore = held;
			}
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
				if (on) touchOff = api.input?.actions?.(['interact', { id: 'hint', label: 'Hint', keys: ['KeyH'] }], { preset: 'explore' }) ?? null;
				if (!on && touchOff) {
					touchOff();
					touchOff = null;
				}
				if (!on && helpOff) {
					helpOff();
					helpOff = null;
				}
				// the pause menu's Restart: the rules set the same room up again
				if (on) api.game?.onRestart?.(() => emitAll('roundStarted', { stage: v(V.start), round: game()?.round ?? 0, restart: true }));
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
			// a fresh round (Start / Restart / a practice room): the RULES set the puzzle up. The peer
			// that picked a practice room tells everyone which; every peer then asks its own rules copy
			// (only the authority's acts) until the puzzle says this round is set up — so a rules node
			// still loading, or an authority that changes hands, cannot leave last round's house standing
			if (g && g.state === 'playing' && g.round !== prevRound) {
				prevRound = g.round;
				const stage = Math.max(0, pendingStage);
				if (pendingStage >= 0) emitAll('roundStarted', { stage, round: g.round });
				pendingStage = -1;
				localStage = stage;
				askedAt = -1;
				curRoom = stage;
				roomSince = [0, 0, 0];
				prevFlags = -1;
				api.setSpawn?.(ROOMS[stage].spawn, ROOMS[stage].yaw, { teleport: stage > 0 });
				say(stage ? ROOMS[stage].name + ' (practice)' : "The Alchemist's Escape", { sub: stage ? 'The rooms before it are already open.' : 'Find the three gems and get out.', ms: 2400, color: '#ffd45e' });
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
			if (g && g.state === 'playing' && v(V.round, -1) !== g.round && (askedAt < 0 || time - askedAt > 0.5)) {
				askedAt = time;
				escape.emit('roundStarted', { stage: localStage, round: g.round });
			}
			// the round is set up: a peer that did not pick the practice room walks into it too
			if (g && g.state === 'playing' && v(V.round, -1) === g.round && setupRound !== g.round) {
				setupRound = g.round;
				const st = Math.max(0, Math.min(2, v(V.start)));
				if (st !== localStage) {
					localStage = st;
					curRoom = st;
					api.setSpawn?.(ROOMS[st].spawn, ROOMS[st].yaw, { teleport: st > 0 });
				}
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
			touchOff?.();
			touchOff = null;
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
			rulesNode: () => api.flow.nodes('behaviour').find((/** @type {any} */ n) => /Escape rules/.test(String(n.data?.name ?? n.data?.label ?? '')))?.id ?? null,
			solve: () => {
				for (const n of ['Desk drawer', 'Brass key', 'Chest lid', 'Crank', 'Old note', 'Sun gem', 'Study door']) act(n);
			}
		};
	}
};
