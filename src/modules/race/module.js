// 36-backlog-21c (plan 21-C8 + C4): RACE — drive a car round a circuit, laps, a race clock and a
// leaderboard. A CORE module (the Mini Golf / Sky Run precedent: it ships with the app and reaches
// core through PRIMED dynamic imports), dormant in every scene without the `Race game` marker.
//
// WHAT LIVES WHERE
//   the template (scripts/templates/race.cjs): the circuit — a closed Spline named `Race road`,
//     the ground, the cars `Race car 1..4`, the finish line, the dressing — and the MAIN graph:
//     the buttons -> Kit: Round, the `racerules` node holding every tunable number (laps, top
//     speed, grip…), the HUD words through `raceinfo`, the Leaderboard node over the per-player
//     rows, the finish-line On Enter -> sound.
//   track.js (pure, vitest): checkpoints derived from the road, the arc-length projector, the
//     quadrant lap judge, the standings order, the arcade car step.
//   this file: seats, driving, the lap judge per driver, the grid, the end of the race.
//
// WHO DECIDES (golden rule 8, never mixed):
//   the CAR is a dynamic body, so the PHYSICS INITIATOR moves it — the driver forwards its input
//     at ~20 Hz ({op:'drive'}, the car module's recipe), the initiator turns it into a velocity
//     every frame (driveStep) and the ordinary physics `move` stream carries the pose to everyone.
//   SEATS are module state ({op:'claim'} + registerStateSync), freed when a driver leaves.
//   THE CLOCK is the kit round's: one `startedAt` stamped by the kit authority, every peer derives
//     elapsed — nothing streams (C8's "the clock's zero").
//   LAPS: each driver's peer judges ITS OWN car from the pose it sees (the C4 tracker — a lap
//     needs all four quarters, so reversing over the line counts nothing) and writes its OWN
//     per-player rows (api.peerVars: one writer per row by construction). The Leaderboard node
//     and `raceinfo` derive the board on every peer; nothing new on the wire.
//   THE END: the kit authority ends the round when every seated driver has finished, or 30 s
//     after the first one did.

import { checkpointsFor, makeProjector, newLapState, trackLap, standings, lapTime, driveStep } from './track.js';

const MARKER = 'Race game';
const ROAD = 'Race road';
const CAR = /^Race car (\d+)$/;
/** per-player rows (api.peerVars): laps done, best lap (s), finish time (s, 0 = racing), progress */
const R = { laps: 'rcLaps', best: 'rcBest', finish: 'rcFinish', prog: 'rcProg' };
/** the rules when the scene has no `racerules` node */
const DEFAULT_RULES = { laps: 3, countdown: 3, maxSpeed: 18, accel: 9, brake: 22, turnRate: 1.9, grip: 0.85 };
/** after the first finisher, the others get this long (s) */
const GRACE = 30;

/** @param {any} v @param {number} lo @param {number} hi @param {number} d */
const clampNum = (v, lo, hi, d) => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};

export default {
	id: 'race',
	name: 'Race',
	version: '1.0.0',
	description: 'The Race game: drive a car round the circuit — laps, a race clock, a leaderboard. The road is a spline you can edit; the laps follow it.',

	/** @param {any} api */
	register(api) {
		const THREE = api.THREE;
		const kit = api.kit;
		/** @type {any} */ let phys = null;
		/** @type {any} */ let stores = null;
		/** @type {any} */ let kitRt = null;
		Promise.all([import('../../lib/physics'), import('svelte/store'), import('../../lib/kit/runtime.js')]).then(([a, b, c]) => {
			phys = a;
			stores = b;
			kitRt = c;
		});

		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		const me = () => String(api.peerId?.() ?? '') || 'me';
		const phase = () => String(kit.round.phase?.() ?? 'menu');
		const elapsed = () => Number(kit.round.elapsed?.() ?? 0) || 0;
		/** the kit's authority (round, seats, the end): the towers rule */
		const kitAuthority = () => {
			const a = kitRt?.kitAuthorityId?.();
			return !a || a === api.peerId?.();
		};
		const simRunning = () => !!(phys && stores && stores.get(phys.simulating));
		/** who may move the cars: the physics initiator while a sim runs, else the lowest id */
		const bodyAuthority = () => {
			if (!phys || !stores) return false;
			if (simRunning()) return phys.isInitiator();
			if (stores.get(phys.remoteSimulating)) return false;
			const id = api.peerId?.();
			if (!id) return true;
			return [id, ...(api.peerIds?.() ?? [])].filter(Boolean).sort()[0] === id;
		};
		/** every car in the scene, in grid order @returns {any[]} */
		const cars = () =>
			(group()?.children ?? [])
				.filter((/** @type {any} */ o) => CAR.test(String(o.name)))
				.sort((/** @type {any} */ a, /** @type {any} */ b) => Number(CAR.exec(a.name)?.[1]) - Number(CAR.exec(b.name)?.[1]));
		/** walk up from a hit mesh to the car it belongs to @param {any} object */
		const carOf = (object) => {
			const g = group();
			let cur = object;
			while (cur && cur.parent !== g) cur = cur.parent;
			return cur && CAR.test(String(cur.name)) ? cur : null;
		};

		// ---- the rules: the first `racerules` node in the scene (the readable, editable numbers) ----
		/** @type {{at: number, value: any} | null} */ let rulesMemo = null;
		const rules = () => {
			// read a few times a second, not per call (raceinfo nodes ask every tick)
			const now = performance.now();
			if (rulesMemo && now - rulesMemo.at < 250) return rulesMemo.value;
			rulesMemo = { at: now, value: readRules() };
			return rulesMemo.value;
		};
		const readRules = () => {
			const node = api.flow?.nodes?.('racerules')?.[0];
			const d = node?.data ?? {};
			return {
				laps: Math.round(clampNum(d.laps, 1, 20, DEFAULT_RULES.laps)),
				countdown: Math.round(clampNum(d.countdown, 0, 10, DEFAULT_RULES.countdown)),
				maxSpeed: clampNum(d.maxSpeed, 2, 60, DEFAULT_RULES.maxSpeed),
				accel: clampNum(d.accel, 1, 60, DEFAULT_RULES.accel),
				brake: clampNum(d.brake, 1, 80, DEFAULT_RULES.brake),
				turnRate: clampNum(d.turnRate, 0.2, 6, DEFAULT_RULES.turnRate),
				grip: clampNum(d.grip, 0, 1, DEFAULT_RULES.grip)
			};
		};

		// ---- the road: DERIVED, cached per record + pose ------------------------------------------
		/** @type {{key: string, projector: any, road: any} | null} */ let roadCache = null;
		const roadInfo = () => {
			const road = byName(ROAD);
			const spline = road?.userData?.spline;
			if (!road || !spline) return null;
			road.updateMatrixWorld(true);
			const key = JSON.stringify(spline) + road.matrixWorld.elements.map((/** @type {number} */ n) => n.toFixed(4)).join(',');
			if (!roadCache || roadCache.key !== key) roadCache = { key, projector: makeProjector(spline), road };
			return roadCache.projector ? roadCache : null;
		};
		const tmp = new THREE.Vector3();
		/** where a world point is along the road @param {any} world THREE.Vector3 */
		const progressOf = (world) => {
			const info = roadInfo();
			if (!info) return null;
			tmp.copy(world);
			info.road.worldToLocal(tmp);
			return info.projector.project([tmp.x, tmp.z]);
		};
		/** a pose ON the road at fraction u, in the world (position + yaw facing along the road)
		 * @param {number} u @param {number} back metres behind u @param {number} side metres to the right */
		const poseOnRoad = (u, back = 0, side = 0) => {
			const road = byName(ROAD);
			const spline = road?.userData?.spline;
			if (!road || !spline) return null;
			const cps = checkpointsFor(spline, 400);
			if (!cps.length) return null;
			const info = roadInfo();
			const len = info?.projector?.length ?? 1;
			const uu = (((u - back / len) % 1) + 1) % 1;
			const c = cps[Math.round(uu * 400) % 400];
			road.updateMatrixWorld(true);
			const p = new THREE.Vector3(c.position[0], c.position[1], c.position[2]);
			const t = new THREE.Vector3(c.tangent[0], 0, c.tangent[2]).normalize();
			// local -> world: the road's own frame
			const q = new THREE.Quaternion();
			road.getWorldQuaternion(q);
			const s = new THREE.Vector3();
			road.getWorldScale(s);
			road.localToWorld(p);
			t.applyQuaternion(q).setY(0).normalize();
			const right = new THREE.Vector3(-t.z, 0, t.x);
			p.addScaledVector(right, side);
			// forward is the car's -Z, so a heading along t has yaw atan2(-t.x, -t.z)
			return { pos: [p.x, p.y, p.z], yaw: Math.atan2(-t.x, -t.z), scaleY: s.y };
		};

		// ---- seats --------------------------------------------------------------------------------
		/** @type {Record<string, string>} car uuid -> driver peer id */
		const claims = {};
		const myCar = () => {
			const id = me();
			const hit = Object.entries(claims).find(([, p]) => p === id);
			return hit ? group()?.getObjectByProperty('uuid', hit[0]) ?? null : null;
		};
		/** @param {string} carId @param {string} peerId */
		const applyClaim = (carId, peerId) => {
			if (peerId) {
				// one car per driver
				for (const [c, p] of Object.entries(claims)) if (p === peerId && c !== carId) delete claims[c];
				claims[carId] = peerId;
			} else delete claims[carId];
			syncEngagement();
		};
		/** @param {string} carId @param {string} peerId */
		const claim = (carId, peerId) => {
			applyClaim(carId, peerId);
			api.send({ op: 'claim', carId, peerId });
		};
		api.registerClickHandler(
			(/** @type {any} */ object) => {
				if (!active()) return false;
				const car = carOf(object);
				if (!car) return false;
				const holder = claims[car.uuid];
				if (holder && holder !== me()) {
					api.toast('Someone else is driving that car');
					return true;
				}
				const next = holder === me() ? '' : me();
				claim(car.uuid, next);
				api.playSound('click');
				api.toast(next ? car.name + ' is yours — W/S drive, A/D steer, R puts you back on the road' : 'You left the car');
				return true;
			},
			{ modes: ['interact', 'play'] }
		);
		/** the kit authority seats every peer still on foot, in sorted-id order (deterministic) */
		const seatEveryone = () => {
			const ids = [api.peerId?.() || 'me', ...(api.peerIds?.() ?? [])].filter(Boolean).sort();
			const seated = new Set(Object.values(claims));
			const free = cars().filter((c) => !claims[c.uuid]);
			for (const id of ids) {
				if (seated.has(id)) continue;
				const car = free.shift();
				if (!car) break;
				claim(car.uuid, id);
			}
		};

		// ---- driving: engagement (camera + keys) and the input stream ---------------------------
		let engaged = false;
		const syncEngagement = () => {
			const car = myCar();
			const want = !!car && active() && !!api.isPlaying?.() && ['intro', 'playing'].includes(phase());
			if (want && !engaged) {
				engaged = true;
				api.claimInput('keys');
				api.followCam(car.uuid);
			} else if (!want && engaged) {
				engaged = false;
				api.releaseInput('keys');
				api.stopFollowCam();
			}
		};
		/** @type {Map<string, {t: number, s: number, at: number}>} the initiator's latest input per car */
		const inputs = new Map();
		let lastSend = 0;
		let resetHeld = false;
		/** a suite's scripted input: replaces the keyboard reading in the driver's own stream @type {null | {t: number, s: number}} */
		let scripted = null;
		const sendInput = () => {
			const car = myCar();
			if (!car || !engaged) return;
			const now = performance.now();
			const { codes, axes } = api.input();
			const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
			const keyT = Math.max(-1, Math.min(1, (codes.has('KeyW') || codes.has('ArrowUp') ? 1 : 0) - (codes.has('KeyS') || codes.has('ArrowDown') ? 1 : 0) - dead(axes?.ly ?? 0)));
			const keyS = Math.max(-1, Math.min(1, (codes.has('KeyD') || codes.has('ArrowRight') ? 1 : 0) - (codes.has('KeyA') || codes.has('ArrowLeft') ? 1 : 0) + dead(axes?.lx ?? 0)));
			const t = scripted ? scripted.t : keyT;
			const s = scripted ? scripted.s : keyS;
			const r = codes.has('KeyR');
			if (r && !resetHeld) requestReset(car.uuid);
			resetHeld = r;
			if (now - lastSend < 50) return;
			lastSend = now;
			inputs.set(car.uuid, { t, s, at: now });
			api.send({ op: 'drive', carId: car.uuid, t, s });
		};

		/** put a car somewhere, at rest (the body authority) @param {string} uuid @param {number[]} pos @param {number} yaw */
		const placeCar = (uuid, pos, yaw) => {
			const car = group()?.getObjectByProperty('uuid', uuid);
			if (!car) return;
			if (simRunning()) phys.physicsRemoveBody?.(uuid);
			api.moveObject(uuid, { pos, rot: [0, yaw, 0] });
			if (simRunning()) {
				phys.physicsAddBody?.(uuid);
				phys.setBodyVelocity?.(uuid, [0, 0, 0], [0, 0, 0]);
			}
		};
		/** the grid: two abreast behind the line, 7 m between rows */
		const placeOnGrid = () => {
			cars().forEach((car, i) => {
				const p = poseOnRoad(0, 7 + Math.floor(i / 2) * 7, i % 2 ? -2.2 : 2.2);
				if (p) placeCar(car.uuid, [p.pos[0], p.pos[1] + 0.55, p.pos[2]], p.yaw);
			});
		};
		/** back on the road where the car is (R) @param {string} uuid */
		const resetCar = (uuid) => {
			const car = group()?.getObjectByProperty('uuid', uuid);
			if (!car) return;
			const pr = progressOf(car.getWorldPosition(new THREE.Vector3()));
			const p = poseOnRoad(pr?.u ?? 0, 0, 0);
			if (p) placeCar(uuid, [p.pos[0], p.pos[1] + 0.8, p.pos[2]], p.yaw);
		};
		/** @param {string} uuid */
		const requestReset = (uuid) => {
			if (bodyAuthority()) resetCar(uuid);
			else api.send({ op: 'reset', carId: uuid });
		};

		/** the initiator drives every car from its driver's latest input @param {number} dt */
		const driveCars = (dt) => {
			if (!simRunning() || !phys.isInitiator()) return;
			const ph = phase();
			const p = rules();
			const now = performance.now();
			for (const car of cars()) {
				const v = phys.bodyVelocityOf?.(car.uuid);
				if (!v) continue;
				const lin = v.linvel ?? [0, 0, 0];
				if (ph === 'intro' || ph === 'menu' || ph === 'results') {
					// the grid holds still (gravity keeps its say)
					phys.setBodyVelocity(car.uuid, [0, lin[1], 0], [0, 0, 0]);
					continue;
				}
				if (ph !== 'playing') continue;
				const inp = inputs.get(car.uuid);
				const fresh = inp && now - inp.at < 600 && claims[car.uuid];
				const yaw = new THREE.Euler().setFromQuaternion(car.getWorldQuaternion(new THREE.Quaternion()), 'YXZ').y;
				const out = driveStep({ linvel: lin, yaw, throttle: fresh ? inp.t : 0, steer: fresh ? inp.s : 0, dt }, p);
				phys.setBodyVelocity(car.uuid, out.linvel, [0, out.yawRate, 0]);
			}
		};

		api.onMessage((/** @type {any} */ msg) => {
			if (msg?.op === 'claim' && typeof msg.carId === 'string') applyClaim(msg.carId, String(msg.peerId ?? ''));
			else if (msg?.op === 'drive' && typeof msg.carId === 'string')
				inputs.set(msg.carId, { t: Number(msg.t) || 0, s: Number(msg.s) || 0, at: performance.now() });
			else if (msg?.op === 'reset' && typeof msg.carId === 'string' && bodyAuthority()) resetCar(msg.carId);
			else if (msg?.op === 'grid' && bodyAuthority()) placeOnGrid();
		});
		api.registerStateSync({
			getState: () => ({ claims: { ...claims } }),
			applyState: (/** @type {any} */ s) => Object.entries(s?.claims ?? {}).forEach(([c, p]) => applyClaim(c, String(p)))
		});

		// ---- my lap judge (every driver, its own car) -------------------------------------------
		const mine = {
			round: -1,
			lap: newLapState(),
			lapStart: 0,
			best: 0,
			finish: 0,
			last: 0
		};
		const resetMine = () => {
			mine.lap = newLapState();
			mine.lapStart = 0;
			mine.best = 0;
			mine.finish = 0;
			mine.last = 0;
			api.peerVars.setMine(R.laps, 0);
			api.peerVars.setMine(R.best, 0);
			api.peerVars.setMine(R.finish, 0);
			api.peerVars.setMine(R.prog, 0);
		};
		let lastProgWrite = 0;
		const judgeMine = () => {
			const ph = phase();
			const round = Number(kit.round.number?.() ?? 0);
			if (round !== mine.round && (ph === 'intro' || ph === 'playing')) {
				mine.round = round;
				resetMine();
			}
			if (ph !== 'playing' || mine.finish) return;
			const car = myCar();
			if (!car) return;
			const pr = progressOf(car.getWorldPosition(new THREE.Vector3()));
			if (!pr) return;
			const before = mine.lap.laps;
			const r = trackLap(mine.lap, pr);
			const t = elapsed();
			if (r.lapped && r.laps > before) {
				const lt = t - mine.lapStart;
				mine.lapStart = t;
				mine.last = lt;
				if (!(mine.best > 0) || lt < mine.best) mine.best = lt;
				api.peerVars.setMine(R.laps, r.laps);
				api.peerVars.setMine(R.best, +mine.best.toFixed(2));
				const goal = rules().laps;
				if (r.laps >= goal) {
					mine.finish = t;
					api.peerVars.setMine(R.finish, +t.toFixed(2));
					const was = Number(api.storage?.get?.('best-race', 0)) || 0;
					if (!(was > 0) || t < was) api.storage?.set?.('best-race', +t.toFixed(2));
					const wasLap = Number(api.storage?.get?.('best-lap', 0)) || 0;
					if (!(wasLap > 0) || mine.best < wasLap) api.storage?.set?.('best-lap', +mine.best.toFixed(2));
					api.playSound('levelup');
					api.hapticPattern?.('success');
					api.effects?.burst?.(car.getWorldPosition(new THREE.Vector3()).toArray(), { kind: 'confetti', count: 120 });
					api.announce('Finished!', { sub: lapTime(t) + ' · best lap ' + lapTime(mine.best), ms: 1300, color: '#ffd45e' });
				} else {
					api.playSound('ring');
					api.hapticPattern?.('tap');
					api.announce('Lap ' + (r.laps + 1) + ' / ' + goal, { sub: 'last lap ' + lapTime(lt), ms: 1400, color: '#9ee6ff' });
				}
			}
			const now = performance.now();
			if (now - lastProgWrite > 500) {
				lastProgWrite = now;
				api.peerVars.setMine(R.prog, +(mine.lap.laps + pr.u).toFixed(3));
			}
		};

		// ---- the race order + the end (kit authority) -------------------------------------------
		const drivers = () => {
			const present = new Set([me(), ...(api.peerIds?.() ?? [])]);
			return [...new Set(Object.values(claims))].filter((p) => present.has(p));
		};
		/** a driver's name the same on every peer: the roster's name, never the local "Me" label
		 * @param {string} id @param {any} [rowName] */
		const nameOf = (id, rowName) => {
			const n = api.peerNames?.()?.[id];
			if (n) return String(n);
			if (rowName && rowName !== 'Me') return String(rowName);
			return 'Driver ' + String(id).slice(0, 4);
		};
		/** standings over every driver's own rows @returns {{id: string, name: string, laps: number, u: number, finish: number, best: number}[]} */
		const board = () => {
			const rowsOf = (/** @type {string} */ k) => new Map((api.peerVars.all(k) ?? []).map((/** @type {any} */ r) => [r.me ? me() : String(r.id), r]));
			const laps = rowsOf(R.laps);
			const prog = rowsOf(R.prog);
			const fin = rowsOf(R.finish);
			const best = rowsOf(R.best);
			return standings(
				drivers().map((id) => ({
					id,
					name: nameOf(id, laps.get(id)?.name ?? prog.get(id)?.name),
					laps: Number(laps.get(id)?.value ?? 0),
					u: Number(prog.get(id)?.value ?? 0) % 1,
					finish: Number(fin.get(id)?.value ?? 0),
					best: Number(best.get(id)?.value ?? 0)
				}))
			);
		};
		let firstFinishAt = 0;
		const watchEnd = () => {
			if (phase() !== 'playing' || !kitAuthority()) {
				firstFinishAt = 0;
				return;
			}
			const rows = board();
			if (!rows.length) return;
			const done = rows.filter((r) => r.finish > 0);
			if (!done.length) return;
			if (!firstFinishAt) firstFinishAt = elapsed();
			if (done.length === rows.length || elapsed() - firstFinishAt > GRACE) {
				const w = rows[0];
				// the outcome is the WINNER'S ID; each peer words it ("You win" / "<name> wins")
				kit.round.win('race:' + w.id + ':' + w.finish.toFixed(2));
			}
		};

		// ---- the HUD words (raceinfo) -------------------------------------------------------------
		const info = (/** @type {any} */ data) => {
			const goal = rules().laps;
			const ph = phase();
			switch (String(data?.read ?? 'lap')) {
				case 'lap': {
					if (!myCar()) return '';
					const n = Math.min(goal, mine.lap.laps + 1);
					return mine.finish ? 'Finished' : 'Lap ' + n + ' / ' + goal;
				}
				case 'clock':
					return lapTime(mine.finish || elapsed()) === '–' ? '0:00.0' : lapTime(mine.finish || elapsed());
				case 'lapClock':
					return ph === 'playing' && !mine.finish ? lapTime(elapsed() - mine.lapStart) : '';
				case 'best':
					return mine.best > 0 ? 'Best lap ' + lapTime(mine.best) : 'Best lap –';
				case 'position': {
					const rows = board();
					const i = rows.findIndex((r) => r.id === me());
					return i >= 0 ? 'P' + (i + 1) + ' / ' + rows.length : '';
				}
				case 'countdown': {
					const c = Number(kit.round.countdown?.() ?? 0);
					return ph === 'intro' && c > 0 ? String(c) : ph === 'playing' && elapsed() < 1 ? 'GO!' : '';
				}
				case 'status':
					if (!myCar()) return cars().length ? 'Click a car to take the wheel' : '';
					if (ph === 'menu' || ph === 'results') return 'In the car — press Start';
					return '';
				case 'standings': {
					// one line per place: the HUD text wraps on its own
					return board()
						.map((r, i) => i + 1 + '. ' + r.name + '  ' + (r.finish ? lapTime(r.finish) : 'lap ' + Math.min(goal, r.laps + 1)))
						.join('   ');
				}
				case 'result': {
					const out = String(kit.round.outcome?.() ?? '');
					const m = /^race:(.+):([\d.]+)$/.exec(out);
					if (!m) return out || 'Race over';
					return (m[1] === me() ? 'You win' : nameOf(m[1]) + ' wins') + ' in ' + lapTime(Number(m[2]));
				}
				case 'menuBest': {
					const b = Number(api.storage?.get?.('best-race', 0)) || 0;
					const l = Number(api.storage?.get?.('best-lap', 0)) || 0;
					return b ? 'Your best race ' + lapTime(b) + ' · best lap ' + lapTime(l) : goal + ' laps · first across the line wins';
				}
				default:
					return '';
			}
		};
		api.registerValueNode(
			'raceinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		// the rules node: every tunable number, readable and editable on the Main graph. Its value
		// is the lap count (wire it into a HUD Text to show "3 laps").
		api.registerValueNode('racerules', (/** @type {any} */ data) => Math.round(clampNum(data?.laps, 1, 20, DEFAULT_RULES.laps)), { vtype: 'number' });
		api.registerNodeGroup({
			group: 'Race',
			items: [
				{
					type: 'racerules',
					label: 'Race rules',
					defaults: { ...DEFAULT_RULES },
					params: [
						{ key: 'laps', kind: 'range', min: 1, max: 20, step: 1 },
						{ key: 'countdown', kind: 'range', min: 0, max: 10, step: 1 },
						{ key: 'maxSpeed', kind: 'range', min: 2, max: 60, step: 1 },
						{ key: 'accel', kind: 'range', min: 1, max: 60, step: 1 },
						{ key: 'brake', kind: 'range', min: 1, max: 80, step: 1 },
						{ key: 'turnRate', kind: 'range', min: 0.2, max: 6, step: 0.1 },
						{ key: 'grip', kind: 'range', min: 0, max: 1, step: 0.05 }
					]
				},
				{
					type: 'raceinfo',
					label: 'Race info',
					defaults: { read: 'lap' },
					params: [{ key: 'read', kind: 'select', options: ['lap', 'clock', 'lapClock', 'best', 'position', 'countdown', 'status', 'standings', 'result', 'menuBest'] }]
				}
			]
		});
		api.registerBindings([
			{ label: 'Race: drive / brake', keys: 'W / S' },
			{ label: 'Race: steer', keys: 'A / D' },
			{ label: 'Race: back on the road', keys: 'R' }
		]);

		// a car is driven, never carried (Play's grab would pick one up)
		kit.rules.onGrabRequest?.((/** @type {any} */ req) => {
			if (!active()) return;
			if (CAR.test(String(req.name)) || /^Race car \d+ /.test(String(req.name))) req.refuse('Click the car to take the wheel');
		});

		// ---- the round: a fresh race on every start ----------------------------------------------
		kit.round.onStarted?.(() => {
			if (!active()) return;
			if (kitAuthority()) seatEveryone();
			if (bodyAuthority()) placeOnGrid();
			else api.send({ op: 'grid' });
		});

		const HELP = [
			'Race round the circuit: the first driver to finish every lap wins.',
			'Click a car to take the wheel (Start seats everyone still on foot). W / S drive and brake, A / D steer, R puts you back on the road.',
			'A lap only counts when you have driven all of it — cutting across or reversing over the line does nothing.',
			'Change the laps, top speed or grip on the Race rules node in the Main graph; move the road\'s points and the race follows.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		let wasActive = false;
		let lastSweep = 0;
		let lastTime = 0;
		api.registerFrameTask((/** @type {number} */ time) => {
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on) {
					const r = rules();
					kit.round.configure?.(r.countdown, 0, 'lose', 4);
					if (typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				} else {
					helpOff?.();
					helpOff = null;
					syncEngagement();
				}
			}
			if (!on || !phys || !stores) return;
			const dt = lastTime ? Math.min(0.1, Math.max(0, time - lastTime)) : 1 / 60;
			lastTime = time;
			syncEngagement();
			sendInput();
			driveCars(dt);
			judgeMine();
			watchEnd();
			// free a departed driver's seat (the car module's 1 Hz sweep)
			if (time - lastSweep > 1) {
				lastSweep = time;
				const present = new Set([me(), ...(api.peerIds?.() ?? [])]);
				for (const [c, p] of Object.entries(claims)) if (!present.has(p)) delete claims[c];
			}
		});
		api.onSceneClear?.(() => {
			helpOff?.();
			helpOff = null;
			for (const k of Object.keys(claims)) delete claims[k];
			inputs.clear();
			roadCache = null;
			mine.round = -1;
			wasActive = false;
			if (engaged) {
				engaged = false;
				api.releaseInput('keys');
				api.stopFollowCam();
			}
		});

		// the suites' window onto the module
		/** @type {any} */ (globalThis).__race = {
			rules,
			phase,
			info,
			board,
			claims: () => ({ ...claims }),
			mine: () => ({ ...mine, lap: { ...mine.lap, quadrants: [...mine.lap.quadrants] } }),
			claim: (/** @type {string} */ name) => {
				const car = byName(name);
				if (car) claim(car.uuid, me());
				return !!car;
			},
			seatEveryone,
			placeOnGrid,
			progressOf: (/** @type {number[]} */ p) => progressOf(new THREE.Vector3(p[0], p[1], p[2])),
			poseOnRoad,
			bodyAuthority,
			kitAuthority,
			/** a scripted input for a suite: MY car's driver stream sends it instead of the keys
			 * (the real path — forwarded at 20 Hz, applied by the physics initiator); 0, 0 clears */
			drive: (/** @type {number} */ t, /** @type {number} */ s) => {
				scripted = t || s ? { t, s } : null;
				return !!myCar();
			},
			/** teleport my car to a fraction of the road (a suite's lap driver) */
			putMyCarAt: (/** @type {number} */ u) => {
				const car = myCar();
				const p = poseOnRoad(u, 0, 0);
				if (!car || !p) return false;
				placeCar(car.uuid, [p.pos[0], p.pos[1] + 0.55, p.pos[2]], p.yaw);
				return true;
			}
		};
	}
};
