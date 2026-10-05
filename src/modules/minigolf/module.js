// 35-mini-golf → 36 (U10): the Mini Golf ENGINE. The game's RULES — holes, par, strokes, the
// cup, out of bounds, sand, picking up, the scorecard — live in the "Mini Golf rules" behaviour
// on the scene's Main graph, where anyone can read and change them. What stays here is the
// physical side the rules cannot be, lent to them as the `golf` engine piece (`kit.golf.*`):
//
//   the ball      a dynamic body only the PHYSICS INITIATOR may move — hit / placeBall /
//                 pocketBall / slow / stop are applied there (forwarded from any other peer)
//   watching it   on the initiator, every frame: rest → moving (`moved`), each rolling frame
//                 (`rolling`), back to rest after 0.35 s still (`stopped`)
//   putting       desktop: press on the ball, drag back, let go — the drag (`putt`) goes to the
//                 rules, which decide the speed; the aim arrow is drawn here, locally
//   the VR club   a held putter's head moving through the ball at speed (`club`)
//   the players   walkTo moves every player behind a tee (a spawn is local, so it is broadcast)
//   feel          the rail-bounce click, the help text, the touch preset, the shell's Restart
//
// A CORE module (the Towers precedent: core internals through PRIMED dynamic imports), dormant
// in every scene without the `Mini golf game` marker object.

const MARKER = 'Mini golf game';
const BALL = 'Golf ball';
const AIM = 'golf-aim';
const BALL_R = 0.06;
/** the rest detector: slower than this (m/s) for REST_S seconds is at rest */
const REST_SPEED = 0.06;
const REST_S = 0.35;
/** faster than this from rest is moving */
const MOVE_SPEED = 0.3;

export default {
	id: 'minigolf',
	name: 'Mini Golf',
	version: '2.0.0',
	description: 'The Mini Golf engine: the ball, putting with the mouse or a VR putter. The rules are the "Mini Golf rules" node on the Main graph.',

	/** @param {any} api */
	register(api) {
		/** @type {any} */ let gs = null;
		/** @type {any} */ let phys = null;
		/** @type {any} */ let stores = null;
		/** @type {any} */ let scene = null;
		/** @type {any} */ let rect = null;
		Promise.all([
			import('../../lib/gameState'),
			import('../../lib/physics'),
			import('svelte/store'),
			import('../../stores/sceneStore'),
			import('../../lib/canvasRect')
		]).then(([a, b, c, d, e]) => {
			gs = a;
			phys = b;
			stores = c;
			scene = d;
			rect = e;
		});
		const THREE = api.THREE;

		const group = () => api.objectsGroup();
		/** @param {string} name */
		const byName = (name) => group()?.getObjectByName(name) ?? null;
		const active = () => !!byName(MARKER);
		const playing = () => !!(gs && stores && stores.get(gs.gameState)?.state === 'playing');
		/** may THIS peer move the ball (the physics initiator; no sim = the lowest peer id) */
		const authority = () => {
			if (!phys || !stores) return false;
			if (stores.get(phys.simulating)) return phys.isInitiator();
			if (stores.get(phys.remoteSimulating)) return false;
			const me = api.peerId();
			if (!me) return true;
			const ids = [me, ...api.peerIds()].filter(Boolean).sort();
			return ids[0] === me;
		};
		const simRunning = () => !!(phys && stores && stores.get(phys.simulating));

		// ---- the ball --------------------------------------------------------------------------
		const ball = () => byName(BALL);
		/** @returns {number[]} */
		const ballPos = () => {
			const b = ball();
			if (!b) return [0, -10, 0];
			const p = new THREE.Vector3();
			b.getWorldPosition(p);
			return [p.x, p.y, p.z];
		};
		let prevBall = /** @type {null | {p: number[], t: number}} */ (null);
		let derivedVel = [0, 0, 0];
		/** the ball's velocity: the initiator's body, else derived from the pose stream @param {number} time */
		const sampleVel = (time) => {
			const b = ball();
			const fromBody = b && simRunning() ? phys.bodyVelocityOf?.(b.uuid) : null;
			const p = ballPos();
			if (prevBall && time > prevBall.t) {
				const dt = time - prevBall.t;
				derivedVel = [(p[0] - prevBall.p[0]) / dt, (p[1] - prevBall.p[1]) / dt, (p[2] - prevBall.p[2]) / dt];
			}
			prevBall = { p, t: time };
			return fromBody ? fromBody.linvel : derivedVel;
		};
		let lastVel = [0, 0, 0];

		/** the watcher's view: 'rest' (waiting), 'moving', 'parked' (in a cup, no body) */
		let watch = 'rest';
		let restSince = -1;
		/** when the last hit was applied (ms): a ball that leaves rest soon after is a putt */
		let lastHitAt = -1e9;

		// ---- the engine piece: what the rules may ask, and what they hear -----------------------
		const v3 = (/** @type {any} */ v) => (Array.isArray(v) ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0] : [0, 0, 0]);
		/** @param {number[]} pos @param {boolean} body */
		const applyPlace = (pos, body) => {
			const b = ball();
			if (!b) return;
			if (simRunning()) phys.physicsRemoveBody?.(b.uuid);
			api.moveObject(b.uuid, { pos, rot: [0, 0, 0] });
			if (simRunning() && body) {
				phys.physicsAddBody?.(b.uuid);
				phys.setBodyVelocity?.(b.uuid, [0, 0, 0], [0, 0, 0]);
			}
			watch = body ? 'rest' : 'parked';
			restSince = -1;
		};
		/** @param {number[]} vel */
		const applyHit = (vel) => {
			const b = ball();
			if (!b || !simRunning()) return false;
			const lin = [vel[0], 0, vel[2]];
			// a rolling ball spins about the axis across its travel
			const ang = [(lin[2] / BALL_R) * 0.6, 0, (-lin[0] / BALL_R) * 0.6];
			lastHitAt = performance.now();
			if (watch === 'parked') watch = 'rest';
			return phys.setBodyVelocity(b.uuid, lin, ang);
		};
		/** @param {number} k */
		const applySlow = (k) => {
			const b = ball();
			if (!b || !simRunning()) return;
			const f = Math.max(0, Math.min(1, Number(k)));
			phys.setBodyVelocity(b.uuid, [lastVel[0] * f, lastVel[1], lastVel[2] * f], null);
		};
		const applyStop = () => {
			const b = ball();
			if (b && simRunning()) phys.setBodyVelocity(b.uuid, [0, 0, 0], [0, 0, 0]);
		};
		/** run on the ball's owner: here when we are it, else ask it @param {string} op @param {any[]} args @param {() => any} here */
		const onOwner = (op, args, here) => {
			if (authority()) return here();
			api.send({ op, args });
			return true;
		};
		/** @param {number[]} pos */
		const walkHere = (pos) => api.setSpawn?.(pos, 0, { teleport: true });
		let aimFull = 2.5;

		const golf = api.kit.provide(
			{
				piece: 'golf',
				group: 'Mini golf (engine)',
				calls: [
					{ name: 'hit', kind: 'action', label: 'Hit the ball', doc: 'Gives the ball this velocity (m/s) — the putt itself.', args: [{ key: 'velocity', type: 'vector3' }], node: false },
					{ name: 'placeBall', kind: 'action', label: 'Place the ball', doc: 'Puts the ball here, at rest, on its body.', args: [{ key: 'position', type: 'vector3' }], node: false },
					{ name: 'pocketBall', kind: 'action', label: 'Drop the ball in the cup', doc: 'Parks the ball here with no body (it sits in the cup).', args: [{ key: 'position', type: 'vector3' }], node: false },
					{ name: 'slow', kind: 'action', label: 'Slow the ball', doc: 'Keeps this share of its speed (sand, a slow roll).', args: [{ key: 'factor', type: 'number', default: 0.9, min: 0, max: 1, step: 0.01 }], node: false },
					{ name: 'stop', kind: 'action', label: 'Stop the ball', node: false },
					{ name: 'walkTo', kind: 'action', label: 'Walk every player to', doc: 'Moves every player here (behind a tee).', args: [{ key: 'position', type: 'vector3' }], node: false },
					{ name: 'aim', kind: 'action', label: 'Scale the aim arrow', doc: 'The drag that reads as a full putt, for the arrow (this device).', args: [{ key: 'fullDrag', type: 'number', default: 2.5 }, { key: 'maxSpeed', type: 'number', default: 7 }], node: false },
					{ name: 'ballPosition', kind: 'value', label: 'Ball position', vtype: 'vector3', node: false },
					{ name: 'ballSpeed', kind: 'value', label: 'Ball speed', vtype: 'number', node: false },
					{ name: 'putt', kind: 'event', label: 'On putt (drag released)', node: false },
					{ name: 'club', kind: 'event', label: 'On VR putter hit', node: false },
					{ name: 'moved', kind: 'event', label: 'On ball moving', node: false },
					{ name: 'rolling', kind: 'event', label: 'Every frame while rolling', node: false },
					{ name: 'stopped', kind: 'event', label: 'On ball stopped', node: false },
					{ name: 'restart', kind: 'event', label: 'On the pause menu\'s Restart', node: false }
				]
			},
			{
				hit: (/** @type {any} */ v) => onOwner('hit', [v3(v)], () => applyHit(v3(v))),
				placeBall: (/** @type {any} */ p) => onOwner('place', [v3(p)], () => applyPlace(v3(p), true)),
				pocketBall: (/** @type {any} */ p) => onOwner('pocket', [v3(p)], () => applyPlace(v3(p), false)),
				slow: (/** @type {any} */ k) => onOwner('slow', [Number(k)], () => applySlow(Number(k))),
				stop: () => onOwner('stop', [], applyStop),
				walkTo: (/** @type {any} */ p) => {
					const pos = v3(p);
					walkHere(pos);
					api.send({ op: 'walk', args: [pos] });
				},
				aim: (/** @type {any} */ full) => {
					aimFull = Math.max(0.2, Number(full) || 2.5);
				},
				ballPosition: () => ballPos(),
				ballSpeed: () => Math.hypot(lastVel[0], lastVel[2])
			}
		);
		/** an event every peer hears (the rules act on the authority's copy) @param {string} name @param {any} payload */
		const emitAll = (name, payload) => {
			golf.emit(name, payload);
			api.send({ op: 'ev', name, payload });
		};
		api.onMessage((/** @type {any} */ msg) => {
			const a = Array.isArray(msg?.args) ? msg.args : [];
			if (msg?.op === 'ev' && typeof msg.name === 'string') golf.emit(msg.name, msg.payload ?? {});
			else if (msg?.op === 'walk') walkHere(v3(a[0]));
			else if (!authority()) return;
			else if (msg.op === 'hit') applyHit(v3(a[0]));
			else if (msg.op === 'place') applyPlace(v3(a[0]), true);
			else if (msg.op === 'pocket') applyPlace(v3(a[0]), false);
			else if (msg.op === 'slow') applySlow(Number(a[0]));
			else if (msg.op === 'stop') applyStop();
		});
		// the pause menu's Restart → the rules start a fresh round
		api.game?.onRestart?.(() => {
			if (active()) emitAll('restart', {});
		});

		// ---- watching the ball (the initiator, every frame) -------------------------------------
		/** putters held in VR: the club head touching the ball at speed */
		/** @type {Map<string, {p: number[], t: number}>} */ const headPrev = new Map();
		let lastClub = -10;
		/** @param {number} time */
		const clubs = (time) => {
			const b = ballPos();
			for (const putter of group()?.children ?? []) {
				if (!/^Putter/.test(String(putter.name))) continue;
				const head = new THREE.Vector3(0, -0.42, 0);
				putter.localToWorld(head);
				const h = [head.x, head.y, head.z];
				const was = headPrev.get(putter.uuid);
				headPrev.set(putter.uuid, { p: h, t: time });
				if (!was || time - lastClub < 0.6) continue;
				const dt = Math.max(1e-3, time - was.t);
				const vel = [(h[0] - was.p[0]) / dt, 0, (h[2] - was.p[2]) / dt];
				const near = Math.hypot(h[0] - b[0], h[1] - b[1], h[2] - b[2]) < 0.16;
				if (near && Math.hypot(vel[0], vel[2]) > 0.4) {
					lastClub = time;
					emitAll('club', { velocity: vel });
				}
			}
		};
		let lastSimAsk = -10;
		/** @param {number} time */
		const watchBall = (time) => {
			// a game in play needs its simulation; Play asks for it, this is the fallback for
			// Interact (no Play press) — throttled, never a toggle-off
			if (playing() && !simRunning() && !(stores && stores.get(phys.remoteSimulating))) {
				if (time - lastSimAsk > 2) {
					lastSimAsk = time;
					phys.toggleSimulation?.();
				}
				return;
			}
			if (!ball() || !simRunning()) return;
			const vel = sampleVel(time);
			lastVel = vel;
			if (watch === 'parked') return;
			const p = ballPos();
			const speed = Math.hypot(vel[0], vel[2]);
			if (watch === 'rest') {
				clubs(time);
				if (speed > MOVE_SPEED) {
					watch = 'moving';
					restSince = -1;
					emitAll('moved', { speed, putted: performance.now() - lastHitAt < 1000, pos: p });
				}
				return;
			}
			// moving: every frame to the rules (the initiator IS the kit's authority while a sim
			// runs — kit/authority.js — so the rules hear it here, with no message)
			golf.emit('rolling', { pos: p, speed, velocity: vel });
			if (watch !== 'moving') return; // the rules pocketed / placed it in that handler
			if (speed < REST_SPEED && Math.abs(vel[1]) < 0.1) {
				if (restSince < 0) restSince = time;
				if (time - restSince > REST_S) {
					applyStop();
					watch = 'rest';
					restSince = -1;
					emitAll('stopped', { pos: p });
				}
			} else restSince = -1;
		};

		// ---- desktop putting: drag back from the ball, let go -----------------------------------
		/** @type {any} */ let aim = null; // the arrow (scene root, local)
		const aimArrow = () => {
			if (aim) return aim;
			aim = new THREE.Group();
			aim.name = AIM;
			const mat = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
			const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.01, 1), mat);
			shaft.position.z = -0.5;
			shaft.name = 'golf-aim-shaft';
			const tip = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 12), mat);
			tip.rotation.x = -Math.PI / 2;
			tip.name = 'golf-aim-tip';
			aim.add(shaft, tip);
			aim.renderOrder = 999;
			aim.visible = false;
			api.scene().add(aim);
			api.own?.(aim);
			return aim;
		};
		/** @type {null | {drag: number[]}} */ let aiming = null;
		/** may this desktop pointer putt right now: playing, the ball at rest */
		const desktopPutting = () => {
			if (!scene || !stores || !active() || !playing()) return false;
			if (stores.get(scene.isVRMode)) return false;
			const locked = stores.get(scene.isLocked) === true;
			const interact = stores.get(scene.editorMode) === 'interact';
			return (locked || interact) && watch === 'rest';
		};
		/** the ray through a client point @param {number} x @param {number} y */
		const rayAt = (x, y) => {
			const cam = scene && stores ? stores.get(scene.globalCamera) : null;
			if (!cam || !rect) return null;
			const ndc = rect.ndcFromClient(x, y);
			const r = new THREE.Raycaster();
			r.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), cam);
			return r;
		};
		/** @param {any} e */
		const onDown = (e) => {
			if (e.button !== 0 || !desktopPutting()) return;
			if (String(e.target?.tagName) !== 'CANVAS') return;
			const r = rayAt(e.clientX, e.clientY);
			if (!r) return;
			const b = ballPos();
			if (r.ray.distanceToPoint(new THREE.Vector3(b[0], b[1], b[2])) > 0.35) return;
			aiming = { drag: [0, 0, 0] };
			e.stopPropagation();
			e.preventDefault();
		};
		/** @param {any} e */
		const onMove = (e) => {
			if (!aiming) return;
			const r = rayAt(e.clientX, e.clientY);
			if (!r) return;
			const b = ballPos();
			const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -b[1]);
			const q = new THREE.Vector3();
			if (!r.ray.intersectPlane(plane, q)) return;
			aiming.drag = [b[0] - q.x, 0, b[2] - q.z];
			const len = Math.hypot(aiming.drag[0], aiming.drag[2]);
			const a = aimArrow();
			a.visible = len > 0.12;
			if (a.visible) {
				const shown = Math.min(aimFull, len);
				a.position.set(b[0], b[1] + 0.01, b[2]);
				a.rotation.set(0, Math.atan2(-aiming.drag[0], -aiming.drag[2]), 0);
				a.children[0].scale.z = shown;
				a.children[0].position.z = -shown / 2;
				a.children[1].position.z = -shown - 0.1;
				const t = shown / aimFull;
				a.children[0].material.color.setRGB(1, 0.95 - 0.75 * t, 0.25 * (1 - t));
			}
			e.stopPropagation();
		};
		/** @param {any} e */
		const onUp = (e) => {
			if (!aiming) return;
			const drag = aiming.drag;
			aiming = null;
			if (aim) aim.visible = false;
			e.stopPropagation();
			const length = Math.hypot(drag[0], drag[2]);
			if (length < 0.12) return;
			// the rules turn the drag into a putt (their shot power, their drag-for-full)
			emitAll('putt', { drag, length });
		};
		api.listen(window, 'pointerdown', onDown, true);
		api.listen(window, 'pointermove', onMove, true);
		api.listen(window, 'pointerup', onUp, true);

		// ---- every peer: a click when the ball turns sharply off a rail --------------------------
		let bounce = /** @type {null | {p: number[], v: number[], t: number}} */ (null);
		let lastBounce = -10;
		/** @param {number} time */
		const bounces = (time) => {
			const p = ballPos();
			if (!bounce || time <= bounce.t) {
				bounce = { p, v: [0, 0, 0], t: time };
				return;
			}
			const dt = time - bounce.t;
			const v = [(p[0] - bounce.p[0]) / dt, 0, (p[2] - bounce.p[2]) / dt];
			const was = bounce.v;
			const a = Math.hypot(was[0], was[2]);
			const b = Math.hypot(v[0], v[2]);
			if (a > 1.2 && b > 0.2 && b < 12 && time - lastBounce > 0.15 && (was[0] * v[0] + was[2] * v[2]) / (a * b) < 0.5) {
				lastBounce = time;
				api.playSound('hit', p);
			}
			bounce = { p, v, t: time };
		};

		// ---- the frame ----------------------------------------------------------------------------
		const HELP = [
			'Sink the ball in as few strokes as you can. Six holes; par is shown for each.',
			'Desktop: press on the ball, drag BACK (away from where you want it to go) and let go — the further you drag, the harder the putt. WASD walks.',
			'VR: pick up the putter lying beside the tee (grip) and swing it through the ball. Or knock the ball with your hand.',
			'Out of bounds costs a stroke and puts the ball back where it last stopped. The rules (strokes, par, shot power) are the "Mini Golf rules" node on the Main graph.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		/** @type {null | (() => void)} */ let touchOff = null;
		let wasActive = false;
		api.registerFrameTask((/** @type {number} */ time) => {
			if (!gs || !stores || !phys) return;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				// 36 U8: touch — the stick walks to the ball, the look aims, the putt is the drag on the ball
				if (on) touchOff = api.input?.actions?.([], { preset: 'golf' }) ?? null;
				if (!on) {
					touchOff?.();
					touchOff = null;
					helpOff?.();
					helpOff = null;
				}
			}
			if (!on) return;
			if (authority()) watchBall(time);
			if (playing()) bounces(time);
		});
		api.onSceneClear(() => {
			helpOff?.();
			helpOff = null;
			touchOff?.();
			touchOff = null;
			headPrev.clear();
			wasActive = false;
			aiming = null;
			watch = 'rest';
			if (aim) aim.visible = false;
		});

		// the suites' window onto the engine (the rules' own state is the behaviour's — see rules())
		/** the rules behaviour node's id on Main @returns {string | null} */
		const rulesNode = () => api.flow.nodes('behaviour').find((/** @type {any} */ n) => /Mini Golf rules/.test(String(n.data?.name ?? n.data?.label ?? '')))?.id ?? null;
		/** @type {any} */ (globalThis).__minigolf = {
			authority,
			watch: () => watch,
			ball: () => ({ pos: ballPos(), speed: Math.hypot(lastVel[0], lastVel[2]) }),
			rulesNode,
			/** a raw velocity, y included (a suite's out-of-bounds lob) @param {number[]} vel */
			lob: (vel) => {
				const b = ball();
				if (!b || !authority() || !simRunning()) return false;
				lastHitAt = performance.now();
				return phys.setBodyVelocity(b.uuid, vel, null);
			},
			/** a putt straight at a point as a DRAG the rules turn into speed @param {number[]} at @param {number} drag metres of drag */
			puttAt: (at, drag = 1) => {
				const b = ballPos();
				const d = [at[0] - b[0], 0, at[2] - b[2]];
				const l = Math.hypot(d[0], d[2]) || 1;
				// the drag vector runs from the pointer to the ball — the way the ball will go
				golf.emit('putt', { drag: [(d[0] / l) * drag, 0, (d[2] / l) * drag], length: drag });
				return true;
			}
		};
	}
};
