// Drivable car (K-F): body + 4 wheels as REPLICATED primitives, held together
// by P-B's motorized revolute joints and driven through P-A's simulation.
// Sync model = AUTHORITATIVE (golden rule 8, never mixed): whoever started the
// physics sim steps the world; the DRIVER (whoever claimed the car by clicking
// its body) broadcasts {op:'drive', throttle, steer} at ~20Hz and ONLY the
// initiator applies wheel motors (differential/tank steering v1 — steered
// front knuckles are a backlog item). Claims live in module state (late
// joiners adopt them) and free when the claimant disconnects (pong's paddle
// pattern). Driver != initiator adds ~150-250ms input latency — acceptable
// for a prototype toy, by design.

export default {
	id: 'car',
	name: 'Drivable Car',
	version: '1.0.0',
	description: 'Spawn a jointed demo car; click its body to claim it, WASD drives (needs a running simulation).',
	/** @param {any} api */
	register(api) {
		const THREE = api.THREE;
		/** @type {Record<string, string>} car body uuid -> driver peerId */
		const claims = {};
		const MAX_VEL = 14; // rad/s wheel speed at full throttle
		const STEER_VEL = 8;
		const FORCE = 300;
		let lastDrive = 0;

		api.registerBindings([
			{ label: 'Drive claimed car (needs a running sim)', keys: 'W / S' },
			{ label: 'Steer claimed car', keys: 'A / D' }
		]);

		// body geometry so '/create Carbody' replicates like any primitive
		api.registerPrimitive('Carbody', () => {
			const geometry = new THREE.BoxGeometry(2, 0.6, 3);
			geometry.translate(0, 0.3, 0); // rest on y=0 like the other builders
			return geometry;
		});

		const spawnDemoCar = () => {
			Promise.all([
				import('../../lib/commandsHandler.svelte'),
				import('../../lib/joints'),
				import('../../stores/appStore'),
				import('svelte/store')
			]).then(async ([commands, joints, appStore, svelteStore]) => {
				const group = api.objectsGroup();
				const before = new Set(group?.children.map((/** @type {any} */ c) => c.uuid));
				commands.sceneCommand('/create Carbody');
				for (let i = 0; i < 4; i++) commands.sceneCommand('/create Cylinder 0.4 0.4 0.3');
				const fresh = group?.children.filter((/** @type {any} */ c) => !before.has(c.uuid)) ?? [];
				const body = fresh.find((/** @type {any} */ c) => c.name === 'Carbody');
				const wheels = fresh.filter((/** @type {any} */ c) => c.name === 'Cylinder');
				if (!body || wheels.length !== 4) {
					api.toast('Car spawn failed — try again');
					return;
				}
				const peer = svelteStore.get(appStore.peers);
				body.position.set(0, 0.55, 0);
				body.userData.physics = { mode: 'dynamic', mass: 20, friction: 0.3 };
				body.userData.car = true;
				const corners = [
					[1.15, -1.0],
					[-1.15, -1.0],
					[1.15, 1.0],
					[-1.15, 1.0]
				];
				wheels.forEach((/** @type {any} */ wheel, /** @type {number} */ index) => {
					wheel.position.set(corners[index][0], 0.4, corners[index][1]);
					wheel.rotation.z = Math.PI / 2; // cylinder axis Y -> X (the axle)
					wheel.updateMatrix();
					wheel.userData.physics = { mode: 'dynamic', mass: 2, collider: 'hull', friction: 1.4 };
				});
				// replicate the placements + physics params
				[body, ...wheels].forEach((/** @type {any} */ object) => {
					peer?.send({
						type: 'move',
						uuid: object.uuid,
						pos: object.position.toArray(),
						rot: [object.rotation.x, object.rotation.y, object.rotation.z],
						scale: object.scale.toArray()
					});
					peer?.send({ type: 'objectParameters', parameter: 'physics', uuid: object.uuid, physics: object.userData.physics });
				});
				// axle hinges: revolute about the BODY's local X, anchored at each wheel
				wheels.forEach((/** @type {any} */ wheel) => joints.createJoint('revolute', body.uuid, wheel.uuid, 'x', { vel: 0, maxForce: FORCE }));
				api.toast('Car spawned — ▶ start a simulation, click the body to claim, WASD drives');
			});
		};

		api.registerMenu('Car: spawn demo car', spawnDemoCar);

		/** claim/release by clicking the body (walk up from the hit mesh).
		 * The car-body KIND derives from the NAME the replicated create assigns
		 * (deterministic on every peer — userData set locally would not be). */
		api.registerClickHandler((/** @type {any} */ object) => {
			const group = api.objectsGroup();
			let current = object;
			while (current && current.parent !== group) current = current.parent;
			if (current?.name !== 'Carbody') return false;
			const me = api.peerId() ?? 'me';
			const holder = claims[current.uuid];
			if (holder && holder !== me) {
				api.toast('Someone else is driving that car');
				return true;
			}
			const next = holder === me ? '' : me; // toggle
			applyClaim(current.uuid, next);
			api.send({ op: 'claim', carId: current.uuid, peerId: next });
			api.toast(next ? 'Car claimed — WASD drives (sim must be running)' : 'Car released');
			return true;
		});

		const applyClaim = (/** @type {string} */ carId, /** @type {string} */ peerId) => {
			if (peerId) claims[carId] = peerId;
			else delete claims[carId];
		};

		/** the initiator turns a drive op into wheel motor velocities */
		const applyDrive = (/** @type {string} */ carId, /** @type {number} */ throttle, /** @type {number} */ steer) => {
			if (!api.physics.isInitiator()) return;
			api.physics.joints().then((/** @type {any[]} */ defs) => {
				for (const def of defs) {
					if (def.a !== carId || def.kind !== 'revolute') continue;
					// differential steering: the axle side comes from the attach-time
					// body-local anchor's X sign
					const side = (def.anchorA?.[0] ?? 0) >= 0 ? 1 : -1;
					api.physics.setJointMotor(def.id, throttle * MAX_VEL + side * steer * STEER_VEL, FORCE);
				}
			});
		};

		// the driver forwards INPUT at ~20Hz; every peer sees the op, only the
		// initiator applies motors (driver == initiator short-circuits the same path)
		api.registerFrameTask(() => {
			const me = api.peerId() ?? 'me';
			const mine = Object.entries(claims).find(([, peerId]) => peerId === me);
			if (!mine) return;
			const now = performance.now();
			if (now - lastDrive < 50) return;
			lastDrive = now;
			const { codes, axes } = api.input();
			const dead = (/** @type {number} */ v) => (Math.abs(v) > 0.15 ? v : 0);
			const throttle = Math.max(-1, Math.min(1, (codes.has('KeyW') ? 1 : 0) - (codes.has('KeyS') ? 1 : 0) - dead(axes.ly)));
			const steer = Math.max(-1, Math.min(1, (codes.has('KeyD') ? 1 : 0) - (codes.has('KeyA') ? 1 : 0) + dead(axes.lx)));
			api.send({ op: 'drive', carId: mine[0], throttle, steer });
			applyDrive(mine[0], throttle, steer); // local (driver may BE the initiator)
		});

		api.onMessage((/** @type {any} */ data) => {
			if (data.op === 'claim') applyClaim(data.carId, data.peerId);
			else if (data.op === 'drive') applyDrive(data.carId, data.throttle ?? 0, data.steer ?? 0);
		});

		api.registerStateSync({
			getState: () => ({ claims: { ...claims } }),
			applyState: (/** @type {any} */ state) =>
				Object.entries(state?.claims ?? {}).forEach(([carId, peerId]) => applyClaim(carId, /** @type {string} */ (peerId)))
		});

		// free a disconnected driver's claim (pong's userdata pattern)
		import('../../stores/appStore').then(({ userdata }) =>
			userdata.subscribe((/** @type {any[]} */ users) => {
				const ids = new Set(users.map((u) => u[0]));
				for (const [carId, peerId] of Object.entries(claims))
					if (peerId !== (api.peerId() ?? 'me') && !ids.has(peerId)) delete claims[carId];
			})
		);
	}
};
