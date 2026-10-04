// 35-sky-obby: SKY RUN — a floating obstacle course you jump through. Three stages of platforms
// in the sky: moving platforms, tiles that vanish and come back, spinning arms to dodge,
// checkpoint flags that catch you when you fall, coins, and a portal at the end. A CORE module
// (the towers/pong precedent), dormant in every scene that does not carry the `Sky Run game`
// marker object.
//
// WHAT LIVES WHERE
//   the template def (scripts/templates/sky-run.cjs) owns the GEOMETRY, named by a convention
//     this file reads: `Sky S<n> start` (the pad a stage starts on), `Sky S<n> flag <k>`,
//     `Sky S<n> coin <k>`, `Sky S<n> portal`, `Sky S<n> spinner <k>` (a rotating arm), plus the
//     graph: the menu buttons -> Go to level, the Character Controller (walk + jump), the mover
//     effect nodes and the HUD text through the `skyruninfo` value node.
//   this file: the mover EFFECT (deterministic from the synced clock, so every peer agrees with
//     no message, and an effect target is a KINEMATIC body, so the walker stands on it), and the
//     RUN — fall/checkpoint/coin/spinner/portal — which is LOCAL per player (each peer watches
//     ITSELF, the playerPosition self-proximity read). The first player through the portal wins
//     the round for everybody through kit.round.win (a kit request: whoever asks, the
//     authority applies it once).
//
// SHARED: the round (kit.round: menu -> intro -> playing -> won -> results) and the stage
// (kit.levels). LOCAL: your checkpoint, your coins (a coin hides only for its collector), your
// time and your best (api.storage, per stage).

/** the marker object that says "this scene is a Sky Run game" */
const MARKER = 'Sky Run game';
const STAGES = [
	{ id: '1', name: 'Cloud Steps', par: 45 },
	{ id: '2', name: 'Spin Cycle', par: 70 },
	{ id: '3', name: 'Sky Gauntlet', par: 100 }
];
/** a fall this far under the stage's start pad puts you back on your checkpoint (metres) */
const FALL_DEPTH = 7;
/** player capsule: eye above the feet, and the touch radius for flags/coins/portal */
const EYE = 1.7;
const TOUCH = 1.25;
const COIN_TOUCH = 1.1;

/** @param {number} s seconds */
const formatTime = (s) => {
	if (!(s > 0)) return '0:00.0';
	const m = Math.floor(s / 60);
	const r = s - m * 60;
	return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
};

export default {
	id: 'skyrun',
	name: 'Sky Run',
	version: '1.0.0',
	description:
		'The Sky Run game: three stages of floating platforms — moving platforms, vanishing tiles, spinners, checkpoints, coins and a finish portal. Best times saved on this device.',

	/** @param {any} api */
	register(api) {
		const THREE = api.THREE;
		const kit = api.kit;
		/** @type {any} */ let walk = null; // primed: charController's platform carry
		import('../../lib/charController.js').then((m) => (walk = m));
		/** slider uuid -> its last world position (the carry is the frame's delta) */
		/** @type {Map<string, number[]>} */ const sliderWas = new Map();
		/** @type {any} */ let settings = null; // primed: gameSettings (a leaf)
		/** @type {any} */ let store = null; // primed: safeStorage (where gameSettings keeps its rows)
		import('../../lib/gameSettings.js').then((m) => (settings = m));
		import('../../lib/safeStorage.js').then((m) => (store = m.safeStorage));
		/** the brief's COMFORT default: a platformer walks with the stick constantly, so the
		 * vignette starts ON for this game — once per device, and only where the player never
		 * chose (no stored shell row yet); Settings > Comfort vignette turns it off */
		const comfortDefault = () => {
			try {
				if (!settings || !store || api.storage?.get?.('vignette-defaulted', false)) return;
				const raw = store.getItem(settings.shellKey(settings.currentGameId()));
				if (!raw) settings.setGameSetting('vignette', true);
				api.storage?.set?.('vignette-defaulted', true);
			} catch {
				/* storage refused: the default stays off */
			}
		};
		/** @type {any} */ let kitRt = null; // primed: the kit's authority (the towers rule: never a static edge)
		import('../../lib/kit/runtime.js').then((m) => (kitRt = m));
		const amAuthority = () => {
			const a = kitRt?.kitAuthorityId?.();
			return !a || a === api.peerId?.();
		};
		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		/** @param {string} prefix */
		const allNamed = (prefix) => (group()?.children ?? []).filter((/** @type {any} */ o) => typeof o.name === 'string' && o.name.startsWith(prefix));
		const stageNo = () => {
			const cur = String(kit.levels.current?.() ?? '');
			return STAGES.some((s) => s.id === cur) ? cur : '1';
		};
		const phase = () => String(kit.round.phase?.() ?? 'menu');
		const tmpBox = new THREE.Box3();
		const tmpV = new THREE.Vector3();
		/** @param {any} o */
		const boxOf = (o) => {
			o.updateMatrixWorld(true);
			return tmpBox.setFromObject(o).clone();
		};
		/** the feet spot on a stage's start pad (+ its yaw: every stage runs toward -Z) @param {string} id */
		const startOf = (id) => {
			const pad = byName('Sky S' + id + ' start');
			if (!pad) return { pos: [0, 10, 0], yaw: 0 };
			const b = boxOf(pad);
			return { pos: [(b.min.x + b.max.x) / 2, b.max.y + 0.05, b.max.z - 1.2], yaw: 0, floor: b.max.y };
		};

		// ---- the run: LOCAL per player -------------------------------------------------------
		const run = {
			key: '', // round number + stage: a change is a new run
			checkpoint: /** @type {number[] | null} */ (null),
			flag: 0,
			coins: 0,
			coinsTotal: 0,
			taken: /** @type {Set<string>} */ (new Set()),
			finished: 0, // my finishing time (s), 0 = not yet
			falls: 0,
			lastHit: -10,
			result: '',
			resultLine: '',
			best: 0
		};
		const bestKey = (/** @type {string} */ id) => 'best-' + id;
		const bestOf = (/** @type {string} */ id) => Number(api.storage?.get?.(bestKey(id), 0)) || 0;
		/** a fresh run: back to the stage start, every coin back @param {string} id */
		const resetRun = (id, teleport = true) => {
			run.checkpoint = null;
			run.flag = 0;
			run.coins = 0;
			run.finished = 0;
			run.falls = 0;
			for (const uuid of run.taken) {
				const o = group()?.getObjectByProperty('uuid', uuid);
				if (o) o.visible = true;
			}
			run.taken.clear();
			run.coinsTotal = allNamed('Sky S' + id + ' coin').length;
			run.best = bestOf(id);
			const s = startOf(id);
			api.setSpawn(s.pos, s.yaw, { teleport });
		};
		const backToCheckpoint = (/** @type {string} */ why) => {
			run.falls++;
			const id = stageNo();
			const s = run.checkpoint ? { pos: run.checkpoint, yaw: 0 } : startOf(id);
			api.setSpawn(s.pos, s.yaw, { teleport: true });
			api.playSound('fail');
			api.hapticPattern?.('fail');
			api.announce(why, { sub: run.checkpoint ? 'Back to your checkpoint' : 'Back to the start', ms: 1200, color: '#ffb86b' });
		};
		/** is the feet point inside the rotating arm (in the arm's own frame)? @param {any} arm @param {number[]} feet */
		const armHits = (arm, feet) => {
			const g = arm.geometry;
			if (!g) return false;
			if (!g.boundingBox) g.computeBoundingBox();
			const bb = g.boundingBox;
			arm.updateMatrixWorld(true);
			// the body is a column from the feet to the eye: test three points along it
			for (const dy of [0.2, 0.9, 1.5]) {
				tmpV.set(feet[0], feet[1] + dy, feet[2]);
				arm.worldToLocal(tmpV);
				if (tmpV.x > bb.min.x - 0.3 && tmpV.x < bb.max.x + 0.3 && tmpV.y > bb.min.y - 0.1 && tmpV.y < bb.max.y + 0.1 && tmpV.z > bb.min.z - 0.3 && tmpV.z < bb.max.z + 0.3) return true;
			}
			return false;
		};
		/** @param {number[]} a @param {any} o @param {number} r */
		const near = (a, o, r) => {
			o.getWorldPosition(tmpV);
			const dx = a[0] - tmpV.x;
			const dz = a[2] - tmpV.z;
			const dy = a[1] + 0.9 - tmpV.y;
			return dx * dx + dz * dz < r * r && Math.abs(dy) < 1.8;
		};

		const tickRun = (/** @type {number} */ time) => {
			const id = stageNo();
			const ph = phase();
			const key = (kit.round.number?.() ?? 0) + ':' + id;
			if (key !== run.key && (ph === 'intro' || ph === 'playing')) {
				run.key = key;
				resetRun(id, true);
				api.announce('Stage ' + id + ' · ' + (STAGES.find((s) => s.id === id)?.name ?? ''), { sub: 'Reach the portal. Flags save your spot.', ms: 2600, color: '#ffd45e' });
			}
			if (ph !== 'playing' || run.finished) return;
			const eye = api.playerPosition();
			if (!eye) return;
			const feet = [eye[0], eye[1] - EYE, eye[2]];
			const start = startOf(id);
			// a fall
			if (feet[1] < (start.floor ?? start.pos[1]) - FALL_DEPTH) {
				backToCheckpoint('You fell!');
				return;
			}
			// a moving platform under the feet carries the player with it
			for (const sl of allNamed('Sky S' + id + ' slider')) {
				sl.getWorldPosition(tmpV);
				const now = tmpV.toArray();
				const was = sliderWas.get(sl.uuid);
				sliderWas.set(sl.uuid, now);
				if (!was) continue;
				const b = boxOf(sl);
				const above = eye[1] - b.max.y;
				if (feet[0] > b.min.x - 0.2 && feet[0] < b.max.x + 0.2 && feet[2] > b.min.z - 0.2 && feet[2] < b.max.z + 0.2 && above > 0.8 && above < 2.3)
					walk?.addWalkCarry?.(now[0] - was[0], now[2] - was[2]);
			}
			// a spinner
			if (time - run.lastHit > 1.2)
				for (const arm of allNamed('Sky S' + id + ' spinner')) {
					if (armHits(arm, feet)) {
						run.lastHit = time;
						api.effects?.burst?.([feet[0], feet[1] + 1, feet[2]], { kind: 'sparks', count: 30 });
						backToCheckpoint('Bonk!');
						return;
					}
				}
			// flags
			const flags = allNamed('Sky S' + id + ' flag');
			for (const f of flags) {
				const k = Number(String(f.name).split(' ').pop()) || 0;
				if (k > run.flag && near(feet, f, TOUCH)) {
					run.flag = k;
					f.getWorldPosition(tmpV);
					const b = boxOf(f);
					// the pole stands 1.2 m left of the platform's middle: respawn on the middle
					run.checkpoint = [tmpV.x + 1.2, b.min.y + 0.05, tmpV.z + 0.8];
					api.setSpawn(run.checkpoint, 0);
					api.playSound('ring');
					api.hapticPattern?.('success');
					api.effects?.burst?.([tmpV.x, b.max.y, tmpV.z], { kind: 'confetti', count: 48 });
					api.announce('Checkpoint ' + k, { ms: 1000, color: '#7dffb0' });
				}
			}
			// coins: hidden only for the one who took it
			for (const c of allNamed('Sky S' + id + ' coin')) {
				if (run.taken.has(c.uuid) || !near(feet, c, COIN_TOUCH)) continue;
				run.taken.add(c.uuid);
				c.visible = false;
				run.coins++;
				c.getWorldPosition(tmpV);
				api.playSound('coin', tmpV.toArray());
				api.hapticPattern?.('tap');
				api.effects?.burst?.(tmpV.toArray(), { kind: 'sparkle', count: 24, color: '#ffd45e' });
			}
			// the portal
			const portal = byName('Sky S' + id + ' portal');
			if (portal && near(feet, portal, 1.6)) finish(id);
		};

		/** @param {string} id */
		const finish = (id) => {
			const t = Math.max(0.1, Number(kit.round.elapsed?.() ?? 0));
			run.finished = t;
			const stage = STAGES.find((s) => s.id === id);
			const was = bestOf(id);
			const isBest = !(was > 0) || t < was;
			if (isBest) api.storage?.set?.(bestKey(id), +t.toFixed(1));
			run.best = bestOf(id);
			const name = api.peerNames?.()?.[api.peerId?.()] ?? 'You';
			run.result = 'Stage ' + id + ' cleared!';
			run.resultLine = name + ' · ' + formatTime(t) + ' · coins ' + run.coins + '/' + run.coinsTotal + (isBest ? ' · new best!' : '');
			api.playSound('levelup');
			api.hapticPattern?.('success');
			const p = api.playerPosition();
			if (p) api.effects?.burst?.(p, { kind: 'confetti', count: 96 });
			// stars: finishing, every coin, par time
			kit.levels.complete(true, run.coins, t, id, { coins: run.coins, coinsTotal: run.coinsTotal, par: stage?.par ?? 60 });
			kit.round.win(name + ' reached the portal in ' + formatTime(t));
		};

		// ---- the mover effect: slide / bob / spin / blink, from the synced clock ---------------
		api.registerEffect('skyrunmove', (/** @type {any} */ object, /** @type {any} */ base, /** @type {any} */ data, /** @type {number} */ time) => {
			const pos = base?.pos ?? [object.position.x, object.position.y, object.position.z];
			const rot = base?.rot ?? [0, 0, 0];
			const period = Math.max(0.5, Number(data?.period ?? 4) || 4);
			const u = (((time + (Number(data?.phase) || 0)) / period) % 1 + 1) % 1;
			const kind = String(data?.kind ?? 'slide');
			const d = Number(data?.distance ?? 3) || 0;
			const axis = String(data?.axis ?? 'x');
			if (kind === 'spin') {
				object.rotation.set(rot[0], rot[1] + u * Math.PI * 2 * (Number(data?.dir) < 0 ? -1 : 1), rot[2]);
				return;
			}
			if (kind === 'blink') {
				// solid 0..0.55, shaking 0.55..0.72 (the warning), gone 0.72..1
				const away = u >= 0.72;
				const shake = u >= 0.55 && !away ? Math.sin(time * 60) * 0.05 : 0;
				object.position.set(pos[0] + shake, pos[1] - (away ? 40 : 0), pos[2]);
				object.visible = !away;
				return;
			}
			// slide / bob: a smooth back-and-forth
			const off = Math.sin(u * Math.PI * 2) * d * 0.5;
			object.position.set(pos[0] + (axis === 'x' ? off : 0), pos[1] + (axis === 'y' ? off : 0), pos[2] + (axis === 'z' ? off : 0));
			if (kind === 'coin') {
				object.rotation.set(rot[0], rot[1] + time * 2.4, rot[2]);
				// the effect runtime restores the base (visibility too) every frame: a coin THIS
				// player took stays hidden here, and only here
				if (run.taken.has(object.uuid)) object.visible = false;
			}
		});

		// ---- the HUD words ---------------------------------------------------------------------
		const info = (/** @type {any} */ data) => {
			const id = stageNo();
			const stage = STAGES.find((s) => s.id === id);
			switch (String(data?.read ?? 'title')) {
				case 'title':
					return 'Stage ' + id + ' · ' + (stage?.name ?? '');
				case 'clock':
					return formatTime(run.finished || Number(kit.round.elapsed?.() ?? 0));
				case 'coins':
					return 'Coins ' + run.coins + ' / ' + (run.coinsTotal || allNamed('Sky S' + id + ' coin').length);
				case 'checkpoint':
					return run.flag ? 'Flag ' + run.flag : 'No flag yet';
				case 'best':
					return run.best > 0 ? 'Best ' + formatTime(run.best) : 'Best —';
				case 'result':
					return run.result || 'Round over';
				case 'resultLine':
					return run.resultLine || String(kit.round.outcome?.() ?? '');
				case 'countdown': {
					const c = Number(kit.round.countdown?.() ?? 0);
					return phase() === 'intro' && c > 0 ? String(c) : '';
				}
				case 'stageBest': {
					const b = bestOf(String(data?.level ?? '1'));
					return b > 0 ? 'best ' + formatTime(b) : 'not cleared yet';
				}
				default:
					return '';
			}
		};
		api.registerValueNode(
			'skyruninfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		api.registerNodeGroup({
			group: 'Sky Run',
			items: [
				{
					type: 'skyruninfo',
					label: 'Sky Run info',
					defaults: { read: 'title', level: '1' },
					params: [
						{ key: 'read', kind: 'select', options: ['title', 'clock', 'coins', 'checkpoint', 'best', 'result', 'resultLine', 'countdown', 'stageBest'] },
						{ key: 'level', kind: 'select', options: ['1', '2', '3'] }
					]
				},
				{
					type: 'skyrunmove',
					label: 'Sky Run mover',
					defaults: { kind: 'slide', axis: 'x', distance: 3, period: 4, phase: 0, dir: 1 },
					params: [
						{ key: 'kind', kind: 'select', options: ['slide', 'spin', 'blink', 'coin'] },
						{ key: 'axis', kind: 'select', options: ['x', 'y', 'z'] },
						{ key: 'distance', kind: 'range', min: 0, max: 12, step: 0.5 },
						{ key: 'period', kind: 'range', min: 0.5, max: 20, step: 0.5 },
						{ key: 'phase', kind: 'range', min: 0, max: 20, step: 0.1 },
						{ key: 'dir', kind: 'range', min: -1, max: 1, step: 2 }
					]
				}
			]
		});

		// ---- levels + round ---------------------------------------------------------------------
		/** @type {any} */ let levelsOff = null;
		const defineLevels = () => {
			if (typeof levelsOff === 'function') levelsOff();
			levelsOff = kit.levels.define({
				id: 'skyrun',
				list: STAGES.map((s) => ({ id: s.id, label: s.id + ' · ' + s.name, par: { time: s.par } })),
				unlock: 'all',
				stars: (/** @type {any} */ row, /** @type {any} */ r) => {
					if (!r?.won) return 0;
					const stage = STAGES.find((s) => s.id === String(row.id));
					let n = 1;
					if ((r.coinsTotal ?? 0) > 0 && (r.coins ?? 0) >= r.coinsTotal) n++;
					if (stage && r.time > 0 && r.time <= stage.par) n++;
					return n;
				},
				store: {
					get: () => api.storage?.get?.('progress', null),
					set: (/** @type {any} */ p) => api.storage?.set?.('progress', p)
				}
			});
		};
		// a stage chosen (a menu button, the shell's picker) starts a fresh round on it
		kit.levels.onSelected?.((/** @type {any} */ p) => {
			if (p?.game !== 'skyrun' || !active() || !amAuthority()) return;
			kit.round.restart();
		});
		const HELP = [
			'Run and jump from platform to platform to the glowing portal at the end of the stage.',
			'Desktop: WASD to move, Space to jump, mouse to look. Touch: the left stick walks, drag on the right to look, the Jump button jumps. VR: left stick walks, A jumps (turn on the Comfort vignette in Settings if motion bothers you).',
			'Touch a flag to save your spot: fall off, or get hit by a spinner, and you start again from the last flag.',
			'Tiles that shake are about to vanish — keep moving. Collect every coin and beat the par time for three stars.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		/** 36 U8: the touch buttons (a stick and Jump) @type {null | (() => void)} */ let touchOff = null;

		let wasActive = false;
		api.registerFrameTask((/** @type {number} */ time) => {
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on) {
					defineLevels();
					kit.rules.set?.({ jump: 1.3 });
					kit.round.configure?.(3, 0, 'lose', 2.5);
					if (typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
					touchOff = api.input?.actions?.(['jump'], { preset: 'platformer' }) ?? null;
					const s = startOf(stageNo());
					api.setSpawn(s.pos, s.yaw);
					comfortDefault();
				} else {
					if (helpOff) helpOff();
					helpOff = null;
					if (touchOff) touchOff();
					touchOff = null;
					if (typeof levelsOff === 'function') levelsOff();
					levelsOff = null;
				}
			}
			if (!on) return;
			tickRun(time);
		});
		api.onSceneClear?.(() => {
			if (helpOff) helpOff();
			helpOff = null;
			if (touchOff) touchOff();
			touchOff = null;
			if (typeof levelsOff === 'function') levelsOff();
			levelsOff = null;
			run.key = '';
			run.taken.clear();
			wasActive = false;
		});

		// the suites' window onto the module
		/** @type {any} */ (globalThis).__skyrun = {
			stages: STAGES,
			run: () => ({ ...run, taken: [...run.taken] }),
			startOf,
			info,
			phase,
			stage: stageNo,
			/** walk the course for a test: put the player on top of a named platform */
			teleportTo: (/** @type {string} */ name) => {
				const o = byName(name);
				if (!o) return false;
				const b = boxOf(o);
				api.setSpawn([(b.min.x + b.max.x) / 2, b.max.y + 0.05, (b.min.z + b.max.z) / 2], 0, { teleport: true });
				return true;
			}
		};
	}
};
