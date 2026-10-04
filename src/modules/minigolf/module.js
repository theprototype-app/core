// 35-mini-golf: MINI GOLF — six holes (ramp, windmill, bank shot, sand, a hump), putting with
// the mouse (drag back from the ball, let go) or a held putter in VR (the club head's speed is
// the putt), strokes and par per hole, a scorecard at the end. A CORE module (the Towers
// precedent: it ships with the app and reaches core internals through PRIMED dynamic imports),
// dormant in every scene that does not carry the `Mini golf game` marker object.
//
// WHO DECIDES (golden rule 8): the ball is a dynamic body, so the PHYSICS INITIATOR owns it —
// it counts strokes (a ball going from rest to moving IS a stroke, whatever moved it: a mouse
// putt, a held putter, a VR hand's knock), catches the ball in the cup, sends it back on
// out-of-bounds (+1) and writes the `mg*` game variables. A non-initiator's mouse putt is
// forwarded as a module message. Every peer derives the rest (the HUD words through the
// `golfinfo` value node, the moments, the teleport to the next tee) from the replicated game
// singleton.

import {
	HOLES, holeById, teeOf, spawnOf, outOfBounds, inSand, inCup, scoreName, relText, puttSpeed,
	PUTT_MAX, MAX_STROKES, PAR_TOTAL, BALL_R
} from './holes.js';

const MARKER = 'Mini golf game';
const BALL = 'Golf ball';
const AIM = 'golf-aim';
/** a button stamp older than this (seconds) when first noticed is history */
const FRESH_PRESS = 2.5;
/** game variables, written by the authority only */
const V = { hole: 'mgHole', strokes: 'mgStrokes', phase: 'mgPhase', oob: 'mgOob', sunk: 'mgSunk' };
/** per-hole score vars */
const S = (/** @type {number} */ i) => 'mgS' + i;
/** phases */
const READY = 0;
const ROLLING = 1;
const SUNK = 2;

export default {
	id: 'minigolf',
	name: 'Mini Golf',
	version: '1.0.0',
	description: 'The Mini Golf game: six holes with a ramp, a windmill, a bank shot, sand and a hump — putt with the mouse or a VR putter.',

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
		const kit = api.kit;

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
		const currentHole = () => holeById(v(V.hole, 0));
		const playing = () => game()?.state === 'playing';

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

		// ---- the ball -------------------------------------------------------------------------
		const ball = () => byName(BALL);
		/** @returns {number[]} */
		const ballPos = () => {
			const b = ball();
			if (!b) return [0, -10, 0];
			const p = new THREE.Vector3();
			b.getWorldPosition(p);
			return [p.x, p.y, p.z];
		};
		/** put the ball somewhere, at rest (authority); `body: false` parks it in a cup with no body
		 * @param {number[]} pos @param {{body?: boolean}} [opts] */
		const placeBall = (pos, opts = {}) => {
			const b = ball();
			if (!b) return;
			if (simRunning()) phys.physicsRemoveBody?.(b.uuid);
			api.moveObject(b.uuid, { pos, rot: [0, 0, 0] });
			if (simRunning() && opts.body !== false) {
				phys.physicsAddBody?.(b.uuid);
				phys.setBodyVelocity?.(b.uuid, [0, 0, 0], [0, 0, 0]);
			}
			lastRest = pos.slice();
			restSince = -1;
		};
		/** the ball's velocity (the initiator's body, else the pose stream) */
		let prevBall = /** @type {null | {p: number[], t: number}} */ (null);
		let derivedVel = [0, 0, 0];
		/** @param {number} time */
		const ballVel = (time) => {
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

		// ---- the course (authority) -------------------------------------------------------------
		let lastRest = /** @type {number[]} */ ([0, 0, 0]);
		let restSince = -1;
		let sunkAt = -1;
		let lastSimAsk = -10;
		/** when the last putt was applied (ms) — a ball that starts rolling on its own (it
		 * came to rest on a slope) is SETTLING, not a stroke */
		let lastPuttAt = -1e9;
		/** @param {number} id */
		const setupHole = (id) => {
			const hole = holeById(id);
			if (!hole) return;
			setV(V.hole, id);
			setV(V.strokes, 0);
			setV(V.phase, READY);
			sunkAt = -1;
			placeBall(teeOf(hole));
		};
		/** @param {number} [from] the first hole (the Levels page starts a round anywhere) */
		const startRound = (from = 1) => {
			if (!gs) return;
			for (const h of HOLES) setV(S(h.id), 0);
			setV(V.oob, 0);
			setV(V.sunk, 0);
			kit.round.configure(0, 0, 'lose', 1);
			starting = true;
			try {
				kit.round.restart();
			} finally {
				starting = false;
			}
			setupHole(holeById(from) ? from : 1);
		};
		/** startRound is restarting the kit round itself */
		let starting = false;
		// the shell's Restart (pause menu): after its reset, a fresh round from hole 1
		api.game?.onRestart?.(() => {
			if (!active()) return;
			if (authority()) startRound(1);
			else api.send({ op: 'pick', hole: 1 });
		});
		// a kit round restarted some other way (a Kit node): a fresh card from hole 1
		kit.round.onStarted?.(() => {
			if (starting || !active() || !authority()) return;
			for (const h of HOLES) setV(S(h.id), 0);
			setupHole(1);
		});
		const toMenu = () => {
			setV(V.hole, 0);
			kit.round.toMenu();
		};
		/** the hole is done (sunk, or picked up at the stroke limit) @param {number} strokes */
		const holeDone = (strokes) => {
			const hole = currentHole();
			if (!hole) return;
			setV(S(hole.id), strokes);
			setV(V.phase, SUNK);
			setV(V.sunk, v(V.sunk) + 1);
		};
		/** next hole, or the scorecard */
		const advance = () => {
			const hole = currentHole();
			if (!hole) return;
			const next = holeById(hole.id + 1);
			if (next) setupHole(next.id);
			else {
				const total = HOLES.reduce((s, h) => s + v(S(h.id)), 0);
				kit.score.set?.(total);
				kit.round.win(relText(total - PAR_TOTAL) + ' · ' + total + ' strokes');
			}
		};
		/** a putt: the ball takes this velocity (authority, ball at rest) @param {number[]} vel */
		const putt = (vel) => {
			lastPuttAt = performance.now();
			const b = ball();
			if (!b || !playing() || v(V.phase) !== READY) return false;
			if (!simRunning()) return false;
			const sp = Math.hypot(vel[0], vel[2]);
			const k = sp > PUTT_MAX ? PUTT_MAX / sp : 1;
			const lin = [vel[0] * k, 0, vel[2] * k];
			// a rolling ball spins about the axis perpendicular to its travel
			const ang = [lin[2] / BALL_R, 0, -lin[0] / BALL_R];
			return phys.setBodyVelocity(b.uuid, lin, ang.map((a) => a * 0.6));
		};
		/** any peer: ask for a putt */
		/** @param {number[]} vel */
		const requestPutt = (vel) => {
			if (authority()) putt(vel);
			else api.send({ op: 'putt', vel });
		};
		api.onMessage((/** @type {any} */ msg) => {
			if (msg?.op === 'putt' && Array.isArray(msg.vel) && authority()) putt(msg.vel.map(Number));
			if (msg?.op === 'pick' && authority()) startRound(Number(msg.hole) || 1);
		});
		/** the shell's Levels page (desktop + VR board): every hole, start a round there */
		/** @type {any} */ let levelsOff = null;
		const defineLevels = () => {
			if (typeof api.game?.levels !== 'function') return;
			levelsOff = api.game.levels({
				list: HOLES.map((h) => ({ id: String(h.id), label: h.id + ' · ' + h.name + ' (par ' + h.par + ')' })),
				current: String(v(V.hole, 0) || 1),
				onPick: (/** @type {any} */ id) => {
					const hole = Number(id) || 1;
					if (authority()) startRound(hole);
					else api.send({ op: 'pick', hole });
				}
			});
		};

		/** putters held in VR: the club head touching the ball at speed is a putt */
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
				if (near && Math.hypot(vel[0], vel[2]) > 0.4 && v(V.phase) === READY) {
					lastClub = time;
					putt([vel[0] * 1.1, 0, vel[2] * 1.1]);
				}
			}
		};

		/** the authority's judge, every frame @param {number} time */
		const judge = (time) => {
			const g = game();
			if (!g || g.state !== 'playing') return;
			const hole = currentHole();
			if (!hole) return;
			// a game in play needs its simulation; the first press of Play asks for it, this is
			// the fallback for Interact (no Play press) — throttled, never a toggle-off
			if (!simRunning() && !(stores && stores.get(phys.remoteSimulating))) {
				if (time - lastSimAsk > 2) {
					lastSimAsk = time;
					phys.toggleSimulation?.();
				}
				return;
			}
			const b = ball();
			if (!b) return;
			const p = ballPos();
			const vel = ballVel(time);
			const speed = Math.hypot(vel[0], vel[2]);
			const phase = v(V.phase);
			if (phase === SUNK) {
				if (sunkAt < 0) sunkAt = time;
				if (time - sunkAt > 2.2) advance();
				return;
			}
			clubs(time);
			if (phase === READY) {
				if (speed > 0.3) {
					// a putt, a putter or a hand knock (fast) is a stroke; a slow creep off a
					// slope after the rest snap is the ball settling, and costs nothing
					if (performance.now() - lastPuttAt < 1000 || speed > 1) setV(V.strokes, v(V.strokes) + 1);
					setV(V.phase, ROLLING);
					restSince = -1;
				}
				return;
			}
			// ROLLING
			if (inCup(hole, p, speed)) {
				placeBall([hole.cup[0], hole.cup[1] + BALL_R - 0.05, hole.cup[2]], { body: false });
				holeDone(v(V.strokes));
				sunkAt = time;
				return;
			}
			if (outOfBounds(hole, p)) {
				setV(V.strokes, v(V.strokes) + 1);
				setV(V.oob, v(V.oob) + 1);
				placeBall(lastRest);
				setV(V.phase, READY);
				return;
			}
			const sand = inSand(hole, p);
			if (sand && speed > 0.05) phys.setBodyVelocity(b.uuid, [vel[0] * 0.86, vel[1], vel[2] * 0.86], null);
			else if (speed < 0.45 && speed > 0.02) phys.setBodyVelocity(b.uuid, [vel[0] * 0.96, vel[1], vel[2] * 0.96], null);
			if (speed < 0.06 && Math.abs(vel[1]) < 0.1) {
				if (restSince < 0) restSince = time;
				if (time - restSince > 0.35) {
					phys.setBodyVelocity(b.uuid, [0, 0, 0], [0, 0, 0]);
					lastRest = p;
					restSince = -1;
					if (v(V.strokes) >= MAX_STROKES) {
						api.announce('Picked up', { sub: MAX_STROKES + ' strokes is the most a hole takes', ms: 1800, color: '#ffb86b' });
						holeDone(MAX_STROKES);
					} else setV(V.phase, READY);
				}
			} else restSince = -1;
		};

		// ---- desktop putting: drag back from the ball, let go ------------------------------------
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
		/** @type {null | {rect: any, drag: number[]}} */ let aiming = null;
		/** may this desktop pointer putt right now */
		const desktopPutting = () => {
			if (!scene || !stores || !active() || !playing()) return false;
			if (stores.get(scene.isVRMode)) return false;
			const locked = stores.get(scene.isLocked) === true;
			const interact = stores.get(scene.editorMode) === 'interact';
			return (locked || interact) && v(V.phase) === READY;
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
			aiming = { rect: null, drag: [0, 0, 0] };
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
				const shown = Math.min(2.5, len);
				a.position.set(b[0], b[1] + 0.01, b[2]);
				a.rotation.set(0, Math.atan2(-aiming.drag[0], -aiming.drag[2]), 0);
				a.children[0].scale.z = shown;
				a.children[0].position.z = -shown / 2;
				a.children[1].position.z = -shown - 0.1;
				const t = shown / 2.5;
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
			const len = Math.hypot(drag[0], drag[2]);
			if (len < 0.12) return;
			const sp = puttSpeed(len);
			requestPutt([(drag[0] / len) * sp, 0, (drag[2] / len) * sp]);
		};
		api.listen(window, 'pointerdown', onDown, true);
		api.listen(window, 'pointermove', onMove, true);
		api.listen(window, 'pointerup', onUp, true);

		// the ball is putted, never carried; a desktop never carries a putter
		kit.rules.onGrabRequest?.((/** @type {any} */ req) => {
			if (!active()) return;
			if (req.name === BALL) req.refuse('Putt the ball — drag back from it and let go');
			else if (/^Putter/.test(String(req.name)) && req.hand === 'desktop') req.refuse('Drag back from the ball to putt');
		});

		// ---- the buttons: every peer watches the stamps, the authority acts ---------------------
		/** @type {Map<string, number>} */ const seenStamps = new Map();
		/** @param {string} element */
		const onPress = (element) => {
			if (element === 'start-btn' || element === 'again-btn') return startRound();
			if (element === 'menu-btn') return toMenu();
			if (element === 'skip-btn' && playing() && v(V.phase) !== SUNK) {
				holeDone(MAX_STROKES);
				return;
			}
		};
		const watchButtons = () => {
			const amAuthority = authority();
			for (const node of api.flow.nodes('hudbutton')) {
				const element = String(node.data?.element ?? '');
				if (!/^(start-btn|again-btn|menu-btn|skip-btn)$/.test(element)) continue;
				const entry = api.flow.triggerStamp(node.id);
				const stamp = Number(entry?.stamp) || 0;
				if (!seenStamps.has(node.id)) {
					seenStamps.set(node.id, stamp);
					continue;
				}
				if (stamp === seenStamps.get(node.id)) continue;
				seenStamps.set(node.id, stamp);
				if (Number(entry?.age ?? 0) >= FRESH_PRESS) continue;
				if (amAuthority) onPress(element);
			}
		};

		// ---- every peer: the moments ---------------------------------------------------------
		let seenHole = -1;
		let seenRound = -1;
		let seenOob = -1;
		let seenSunk = -1;
		let seenStrokes = -1;
		let finishedRound = -1;
		/** a bounce off a rail or an obstacle: the ball turned sharply at speed (every peer, from the
		 * pose it sees) */
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
		/** @param {number} time */
		const moments = (time) => {
			const g = game();
			if (!g) return;
			if (g.state === 'playing') bounces(time);
			const hole = currentHole();
			if (g.state === 'playing' && hole && (seenHole !== hole.id || seenRound !== g.round)) {
				seenHole = hole.id;
				seenRound = g.round;
				// the tee: every peer walks itself there (a spawn is local)
				const s = spawnOf(hole);
				api.setSpawn?.(s, 0, { teleport: true });
				api.announce('Hole ' + hole.id + ' · ' + hole.name, { sub: 'Par ' + hole.par + ' — ' + hole.tip, ms: 3600, color: '#ffe066' });
				api.playSound('whistle');
				seenOob = v(V.oob);
				seenSunk = v(V.sunk);
				seenStrokes = v(V.strokes);
			}
			if (g.state !== 'playing' || !hole) return;
			const strokes = v(V.strokes);
			if (strokes > seenStrokes && v(V.oob) === seenOob) {
				api.playSound('kick', ballPos());
				api.hapticPattern?.('tap');
			}
			seenStrokes = strokes;
			if (v(V.oob) > seenOob) {
				seenOob = v(V.oob);
				api.playSound('fail');
				api.announce('Out of bounds', { sub: '+1 stroke — back to your last spot', ms: 1600, color: '#ff8a6b' });
			}
			if (v(V.sunk) > seenSunk) {
				seenSunk = v(V.sunk);
				const n = v(S(hole.id));
				const name = n >= MAX_STROKES ? 'Picked up' : scoreName(n, hole.par);
				api.playSound(n <= hole.par ? 'goal' : 'coin', hole.cup);
				if (n <= hole.par) api.playSound('cheer');
				api.hapticPattern?.('success');
				api.effects?.burst?.([hole.cup[0], hole.cup[1] + 0.3, hole.cup[2]], { kind: n <= hole.par ? 'confetti' : 'sparkle', count: n === 1 ? 140 : 70 });
				api.announce(name, { sub: n + (n === 1 ? ' stroke' : ' strokes') + ' · par ' + hole.par, ms: 2000, color: '#7dffb0' });
			}
		};
		const roundEnd = () => {
			const g = game();
			if (g?.state === 'over' && finishedRound !== g.round) {
				finishedRound = g.round;
				const total = HOLES.reduce((s, h) => s + v(S(h.id)), 0);
				if (total > 0) {
					const best = Number(api.storage?.get?.('best', 0)) || 0;
					if (!best || total < best) api.storage?.set?.('best', total);
					api.playSound('levelup');
				}
			}
		};

		// ---- the HUD's words -------------------------------------------------------------------
		/** @param {any} data */
		const info = (data) => {
			const read = String(data?.read ?? 'title');
			const hole = currentHole();
			const total = HOLES.reduce((s, h) => s + v(S(h.id)), 0);
			const parSoFar = HOLES.filter((h) => v(S(h.id)) > 0).reduce((s, h) => s + h.par, 0);
			switch (read) {
				case 'title':
					return hole ? 'Hole ' + hole.id + ' of ' + HOLES.length + ' · ' + hole.name : '';
				case 'par':
					return hole ? 'Par ' + hole.par : '';
				case 'strokes':
					return hole ? 'Strokes ' + v(V.strokes) : '';
				case 'total':
					return 'Total ' + total + ' (' + relText(total - parSoFar) + ')';
				case 'tip':
					return hole ? hole.tip : '';
				case 'card': {
					const row = Number(data?.hole) || 0;
					const h = holeById(row);
					if (!h) return '';
					const n = v(S(h.id));
					return h.id + '. ' + h.name + ' — par ' + h.par + ' — ' + (n ? n + ' (' + relText(n - h.par) + ')' : '–');
				}
				case 'result':
					return 'Course complete!';
				case 'resultLine':
					return total + ' strokes · par ' + PAR_TOTAL + ' · ' + relText(total - PAR_TOTAL);
				case 'best': {
					const best = Number(api.storage?.get?.('best', 0)) || 0;
					return best ? 'Best on this device: ' + best + ' (' + relText(best - PAR_TOTAL) + ')' : 'First round on this device';
				}
				case 'menuBest': {
					const best = Number(api.storage?.get?.('best', 0)) || 0;
					return best ? 'Your best: ' + best + ' strokes (' + relText(best - PAR_TOTAL) + ')' : 'Six holes · par ' + PAR_TOTAL;
				}
				default:
					return '';
			}
		};
		api.registerValueNode(
			'golfinfo',
			(/** @type {any} */ data) => {
				const out = info(data);
				return out === '' ? ' ' : out;
			},
			{ vtype: 'any' }
		);
		api.registerNodeGroup({
			group: 'Mini Golf',
			items: [
				{
					type: 'golfinfo',
					label: 'Mini golf info',
					defaults: { read: 'title', hole: 1 },
					params: [
						{ key: 'read', kind: 'select', options: ['title', 'par', 'strokes', 'total', 'tip', 'card', 'result', 'resultLine', 'best', 'menuBest'] },
						{ key: 'hole', kind: 'range', min: 1, max: HOLES.length, step: 1 }
					]
				}
			]
		});

		// ---- the frame -------------------------------------------------------------------------
		const HELP = [
			'Sink the ball in as few strokes as you can. Six holes; par is shown for each.',
			'Desktop: press on the ball, drag BACK (away from where you want it to go) and let go — the further you drag, the harder the putt. WASD walks.',
			'VR: pick up the putter lying beside the tee (grip) and swing it through the ball. Or knock the ball with your hand.',
			'Out of bounds costs a stroke and puts the ball back where it last stopped. Eight strokes and the ball is picked up.'
		];
		/** @type {null | (() => void)} */ let helpOff = null;
		// 36 U8: touch — the stick walks to the ball, the look aims, the putt is the module's own drag on the ball
		/** @type {null | (() => void)} */ let touchOff = null;
		let wasActive = false;
		api.registerFrameTask((/** @type {number} */ time) => {
			if (!gs || !stores || !phys) return;
			const on = active();
			if (on !== wasActive) {
				wasActive = on;
				if (on && typeof api.game?.setHelp === 'function') helpOff = api.game.setHelp(HELP);
				if (on) touchOff = api.input?.actions?.([], { preset: 'golf' }) ?? null;
				if (!on && touchOff) {
					touchOff();
					touchOff = null;
				}
				if (on) defineLevels();
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
			if (authority()) judge(time);
			moments(time);
			roundEnd();
		});
		api.onSceneClear(() => {
			if (helpOff) {
				helpOff();
				helpOff = null;
			}
			touchOff?.();
			touchOff = null;
			if (typeof levelsOff === 'function') {
				levelsOff();
				levelsOff = null;
			}
			seenStamps.clear();
			headPrev.clear();
			seenHole = -1;
			seenRound = -1;
			finishedRound = -1;
			wasActive = false;
			aiming = null;
			if (aim) aim.visible = false;
		});

		// the suites' window onto the module
		/** @type {any} */ (globalThis).__minigolf = {
			holes: HOLES,
			authority,
			info,
			vars: () => ({ ...Object.fromEntries(Object.values(V).map((k) => [k, api.game.getVar(k, null)])), ...Object.fromEntries(HOLES.map((h) => [S(h.id), api.game.getVar(S(h.id), null)])) }),
			ball: () => ({ pos: ballPos() }),
			startRound,
			setupHole,
			putt: requestPutt,
			/** a raw velocity, y included (a suite's out-of-bounds lob) @param {number[]} vel */
			lob: (vel) => {
				const b = ball();
				if (!b || !authority() || !simRunning()) return false;
				return phys.setBodyVelocity(b.uuid, vel, null);
			},
			/** aim straight at the cup with a speed (a scripted putt) @param {number} speed */
			puttAtCup: (speed = 3) => {
				const hole = currentHole();
				if (!hole) return false;
				const b = ballPos();
				const d = [hole.cup[0] - b[0], 0, hole.cup[2] - b[2]];
				const l = Math.hypot(d[0], d[2]) || 1;
				requestPutt([(d[0] / l) * speed, 0, (d[2] / l) * speed]);
				return true;
			}
		};
	}
};
