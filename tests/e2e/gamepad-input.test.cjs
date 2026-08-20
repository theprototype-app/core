// 21-E5 — the gamepad: polling, the two nodes, the default mapping and the pad ring.
//
// A pad cannot be pressed headlessly, so `navigator.getGamepads` is STUBBED with a
// mutable fake pad the test drives. That is honest rather than convenient: the poll is
// the single seam that owns this device (which is also why the connect/disconnect toast
// comes from the poll and not from the `gamepadconnected` event), so a stub at that seam
// exercises every consumer — edges, axes, the default mapping, the HUD ring — through the
// real code path. What is NOT testable here is FEEL: whether 2.5 rad/s is the right look
// rate, and whether a real thumbstick's dead centre needs more than 0.15. Those are the
// user's on-device checks.
//
// GPU_ARGS IS LOAD-BEARING, not decoration. A software-rendered headless page runs at
// ~2.5 fps, and the poll rides flowRuntime's per-frame tick — so without the GPU args a
// "the stick moved the camera over N frames" check measures the host's rAF cadence
// rather than the mapping.
//
// Run: $env:APP_URL='https://localhost:5204/'; npm run e2e -- gamepad-input
//      (the peer section additionally needs PEER_CONFIG)
const h = require('./helpers.cjs');

// standard-mapping button indices, so the test speaks the same language as the poll
const A_BTN = 0;
const B_BTN = 1;
const DPAD_UP = 12;
const DPAD_DOWN = 13;
const DPAD_RIGHT = 15;

/** install the fake pad (and its mutators) in the page */
async function stubPad(page) {
	await page.evaluate(() => {
		const w = /** @type {any} */ (window);
		w.__pad = {
			id: 'Fake Pad (STANDARD GAMEPAD Vendor: 0000 Product: 0001)',
			index: 0,
			connected: true,
			mapping: 'standard',
			axes: [0, 0, 0, 0],
			// 17 entries: the standard mapping's 16 plus the guide button
			buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }))
		};
		w.__padPresent = true;
		// getGamepads hands back a SNAPSHOT array in a real engine, so returning the live
		// object is if anything more forgiving than reality — the poll re-reads it anyway
		Object.defineProperty(navigator, 'getGamepads', {
			configurable: true,
			value: () => (w.__padPresent ? [w.__pad] : [])
		});
		w.__padPress = (/** @type {number} */ i) => {
			w.__pad.buttons[i].pressed = true;
			w.__pad.buttons[i].value = 1;
		};
		w.__padRelease = (/** @type {number} */ i) => {
			w.__pad.buttons[i].pressed = false;
			w.__pad.buttons[i].value = 0;
		};
		w.__padAxes = (/** @type {number[]} */ values) => {
			w.__pad.axes = values;
		};
		w.__padIdle = () => {
			w.__pad.axes = [0, 0, 0, 0];
			w.__pad.buttons.forEach((/** @type {any} */ b) => {
				b.pressed = false;
				b.value = 0;
			});
		};
	});
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const page = A.page;
	await page.waitForFunction(() => !!window.__stores?.gamepadPrefs, { timeout: 30000 });

	// gamepadPrefs is a MODULE in the debug hook, so the STORE is one level in
	// (__stores.viewPrefs.viewPrefs is the same shape) — the documented naming trap
	const prefs = () =>
		page.evaluate(() => {
			let v;
			window.__stores.gamepadPrefs.gamepadPrefs.subscribe((x) => (v = x))();
			return v;
		});
	const toasts = () =>
		page.evaluate(() => {
			let t;
			window.__stores.toastStore.subscribe((v) => (t = v))();
			return t.map((x) => (typeof x === 'string' ? x : x.text));
		});

	// ---- 0. premise: real frames, and the poll sees the pad --------------------
	const frames = await page.evaluate(
		() =>
			new Promise((r) => {
				let n = 0;
				const t0 = performance.now();
				const step = () => {
					n++;
					if (performance.now() - t0 < 1000) requestAnimationFrame(step);
					else r(n);
				};
				requestAnimationFrame(step);
			})
	);
	h.check(frames > 30, `premise: the page runs at a real frame rate (${frames} frames/s) — the poll rides that tick`);

	await stubPad(page);
	await page.waitForTimeout(700);
	const seen = await page.evaluate(() => window.__stores.inputRuntime.gamepadName());
	h.check(!!seen && seen.startsWith('Fake Pad'), `the per-frame poll picked the pad up (${seen})`);
	const connectToasts = await toasts();
	h.check(
		connectToasts.some((t) => /^Gamepad connected: Fake Pad$/.test(t)),
		`and said so once, with the vendor tail trimmed (${JSON.stringify(connectToasts.filter((t) => /Gamepad/.test(t)))})`
	);

	// ---- 1. the graph fixture --------------------------------------------------
	// deselect FIRST: the node editor's scope follows the selection, so creating nodes
	// with something selected writes them into that object's own (empty) graph
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		window.__stores.flowGraphClose.set(false);
		window.__stores.bottomDock.activateDock('flow');
	});
	await page.waitForTimeout(1300);
	const scope = await page.evaluate(() => {
		let v;
		window.__stores.activeGraphId.subscribe((x) => (v = x))();
		return v;
	});
	h.check(scope === 'scene', `premise: nodes land in the SCENE graph (${scope})`);

	await page.evaluate(() => {
		const s = window.__stores;
		const mk = (id, type, data) =>
			s.nodesHandler.createFlowNode({ id, type, position: { x: 40, y: 40 }, data: { type, ...data } });
		mk('gp-down', 'gamepadbutton', { button: 'GamepadA', edge: 'down', pulse: 0.3 });
		mk('gp-up', 'gamepadbutton', { button: 'GamepadA', edge: 'up', pulse: 0.3 });
		mk('gp-held', 'gamepadbutton', { button: 'GamepadA', edge: 'held', pulse: 0.3 });
		mk('gp-other', 'gamepadbutton', { button: 'GamepadB', edge: 'down', pulse: 0.3 });
		mk('gp-key', 'keypress', { code: 'KeyJ', edge: 'down', pulse: 0.3 });
		mk('gp-ax', 'gamepadaxis', { axis: 'lx', deadzone: 0, invert: false, scale: 1 });
	});
	await page.waitForTimeout(600);
	const built = await page.evaluate(() => {
		let g;
		window.__stores.flowGraphs.subscribe((x) => (g = x))();
		return (g.scene?.nodes ?? []).filter((n) => n.id.startsWith('gp-')).length;
	});
	h.check(built === 6, `premise: six fixture nodes exist (${built})`);

	// ---- 2. button EDGES: down / up / held ------------------------------------
	// the keypress model verbatim, so the same three readings must hold
	const edges = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		const stamp = (id) => {
			let t;
			s.flowTriggers.subscribe((v) => (t = v))();
			return t[id]?.lastT ?? null;
		};
		w.__padPress(0); // GamepadA
		// long enough to cross the ~3/s held re-stamp window, which is where an 'up' node
		// firing early would show up
		await new Promise((r) => setTimeout(r, 700));
		const down = stamp('gp-down');
		const upWhileHeld = stamp('gp-up');
		const heldLevel = (() => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			return v['gp-held'];
		})();
		const otherWhileHeld = stamp('gp-other');
		const keyWhileHeld = stamp('gp-key');
		w.__padRelease(0);
		await new Promise((r) => setTimeout(r, 400));
		const up = stamp('gp-up');
		await new Promise((r) => setTimeout(r, 500));
		const heldAfter = (() => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			return v['gp-held'];
		})();
		return { down, upWhileHeld, up, heldLevel, heldAfter, otherWhileHeld, keyWhileHeld };
	});
	h.check(edges.down !== null, 'edge:down fires on the press');
	h.check(edges.upWhileHeld === null, 'edge:up stays SILENT while held — the re-stamp skips it, as for a key');
	h.check(edges.up !== null, 'and fires on the release');
	h.check(edges.heldLevel === 1, `edge:held reads a steady 1 while the button is down (${edges.heldLevel})`);
	h.check(edges.heldAfter === 0, `and falls back to 0 once the pulse expires after release (${edges.heldAfter})`);
	h.check(edges.otherWhileHeld === null, 'a node bound to a DIFFERENT button did not fire');
	h.check(
		edges.keyWhileHeld === null,
		'and a Key Press node cannot be fired by a pad — the two devices read from separate sets'
	);

	// ---- 3. the axis: deadzone, invert, scale, and the node's own gate ---------
	const axis = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		const read = () => {
			let v;
			s.flowValues.subscribe((x) => (v = x))();
			return v['gp-ax'];
		};
		const settle = () => new Promise((r) => setTimeout(r, 500));
		w.__padAxes([0.1, 0, 0, 0]);
		await settle();
		const under = read();
		w.__padAxes([0.5, 0, 0, 0]);
		await settle();
		const over = read();
		w.__padAxes([-0.5, 0, 0, 0]);
		await settle();
		const negative = read();
		w.__padAxes([1, 0, 0, 0]);
		await settle();
		const full = read();
		// the node's own params
		w.__padAxes([0.5, 0, 0, 0]);
		s.nodesHandler.setNodeData('gp-ax', { invert: true });
		await settle();
		const inverted = read();
		s.nodesHandler.setNodeData('gp-ax', { invert: false, scale: 2 });
		await settle();
		const scaled = read();
		// a GAME-side threshold on top of the device's dead centre
		s.nodesHandler.setNodeData('gp-ax', { scale: 1, deadzone: 0.6 });
		await settle();
		const gated = read();
		s.nodesHandler.setNodeData('gp-ax', { deadzone: 0 });
		// a different axis reads its own channel
		w.__padAxes([0.5, 0, -0.8, 0]);
		s.nodesHandler.setNodeData('gp-ax', { axis: 'rx' });
		await settle();
		const rightStick = read();
		s.nodesHandler.setNodeData('gp-ax', { axis: 'lx' });
		w.__padIdle();
		await settle();
		return { under, over, negative, full, inverted, scaled, gated, rightStick, idle: read() };
	});
	// 0.15 is the default device deadzone; beyond it the range is RESCALED, so
	// 0.5 -> (0.5 - 0.15) / 0.85
	const expected = (0.5 - 0.15) / 0.85;
	h.check(axis.under === 0, `0.1 under a 0.15 deadzone reads exactly 0 (${axis.under})`);
	h.check(
		Math.abs(axis.over - expected) < 1e-6,
		`and 0.5 reads RESCALED, not merely gated (${axis.over} ~ ${expected.toFixed(5)})`
	);
	h.check(Math.abs(axis.negative + expected) < 1e-6, `symmetric on the negative side (${axis.negative})`);
	h.check(
		Math.abs(axis.full - 1) < 1e-6,
		`full deflection still reads 1 — the rescale does not cost the top of the range (${axis.full})`
	);
	h.check(Math.abs(axis.inverted + expected) < 1e-6, `invert flips the sign (${axis.inverted})`);
	h.check(Math.abs(axis.scaled - expected * 2) < 1e-6, `scale multiplies it (${axis.scaled})`);
	h.check(axis.gated === 0, `the node's own deadzone gates the already-scaled value (${axis.gated})`);
	const expectedRx = -(0.8 - 0.15) / 0.85; // that channel is pushed further than lx
	h.check(
		Math.abs(axis.rightStick - expectedRx) < 1e-6,
		`and the axis picker reads its OWN channel, not lx (rx ${axis.rightStick} ~ ${expectedRx.toFixed(5)})`
	);
	h.check(axis.idle === 0, `a released stick reads 0 (${axis.idle})`);

	// ---- 4. the HUD fixture: a game screen and a MENU screen ------------------
	const hud = await page.evaluate(() => {
		const s = window.__stores;
		s.hudDocs.setHudDocFor('scene', {
			screens: [
				{
					id: 'play',
					name: 'Playing',
					elements: [{ id: 'hud-score', kind: 'text', label: 'Score', anchor: 'top-left', x: 20, y: 20, w: 120, h: 24 }]
				},
				{
					id: 'menu',
					name: 'Pause menu',
					input: 'menu',
					elements: [
						{ id: 'b-one', kind: 'button', label: 'One', anchor: 'center', x: 0, y: -60, w: 160, h: 36 },
						{ id: 'b-two', kind: 'button', label: 'Two', anchor: 'center', x: 0, y: 0, w: 160, h: 36 },
						{ id: 'b-three', kind: 'button', label: 'Three', anchor: 'center', x: 0, y: 60, w: 160, h: 36 }
					]
				}
			],
			active: 'play'
		});
		const mk = (id, type, data) =>
			s.nodesHandler.createFlowNode({ id, type, position: { x: 300, y: 300 }, data: { type, ...data } });
		mk('hb-one', 'hudbutton', { element: 'b-one' });
		mk('hb-three', 'hudbutton', { element: 'b-three' });
		mk('c-one', 'counter', { step: 1, op: 'up' });
		mk('c-three', 'counter', { step: 1, op: 'up' });
		s.nodesHandler.createFlowEdge({ id: 'e1', source: 'hb-one', target: 'c-one', targetHandle: 'pulse' });
		s.nodesHandler.createFlowEdge({ id: 'e3', source: 'hb-three', target: 'c-three', targetHandle: 'pulse' });
		return true;
	});
	h.check(hud === true, 'premise: a game screen, a menu screen and two counted buttons exist');

	// ---- 5. the DEFAULT MAPPING moves the play camera -------------------------
	const moved = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		s.isLocked.set(true);
		await new Promise((r) => setTimeout(r, 600));
		let cam;
		s.playerCam.subscribe((v) => (cam = v))();
		const at = () => [cam.position.x, cam.position.y, cam.position.z];
		const dist = (a, b) => Math.hypot(a[0] - b[0], a[2] - b[2]);
		// push the MOVE stick forward: on the standard mapping that is a NEGATIVE y
		const before = at();
		w.__padAxes([0, -1, 0, 0]);
		await new Promise((r) => setTimeout(r, 900));
		const after = at();
		w.__padIdle();
		await new Promise((r) => setTimeout(r, 500));
		const parked = at();
		await new Promise((r) => setTimeout(r, 500));
		const stillParked = at();
		return {
			walked: dist(before, after),
			coast: dist(after, parked),
			drift: dist(parked, stillParked)
		};
	});
	h.check(moved.walked > 0.5, `the left stick walks the play camera (${moved.walked.toFixed(3)} units)`);
	h.check(
		moved.drift < 1e-6,
		`and STOPS when the stick centres — nothing moves in the second half-second (${moved.drift})`
	);
	// the poll rides flowRuntime's rAF and the movement threlte's task loop, so one frame
	// can act on the previous snapshot: 0.1 = exactly one moveSpeed step. Bounded, and
	// what "continuous input read once per frame" means.
	h.check(
		moved.coast <= 0.11,
		`releasing costs at most ONE frame of latency, not a slide (${moved.coast.toFixed(3)} <= 0.11)`
	);

	// the LOOK stick turns the view, and invertY flips the pitch
	const looked = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		let cam;
		s.playerCam.subscribe((v) => (cam = v))();
		const pitch = () => {
			const e = new window.__stores.THREE.Euler(0, 0, 0, 'YXZ');
			e.setFromQuaternion(cam.quaternion);
			return { x: e.x, y: e.y };
		};
		const sweep = async (rx, ry) => {
			const from = pitch();
			w.__padAxes([0, 0, rx, ry]);
			await new Promise((r) => setTimeout(r, 700));
			w.__padIdle();
			await new Promise((r) => setTimeout(r, 200));
			const to = pitch();
			return { dx: to.x - from.x, dy: to.y - from.y };
		};
		const yaw = await sweep(1, 0);
		const up = await sweep(0, -1); // stick pushed UP
		s.gamepadPrefs.gamepadPrefs.update((p) => ({ ...p, invertY: true }));
		await new Promise((r) => setTimeout(r, 200));
		const upInverted = await sweep(0, -1);
		s.gamepadPrefs.gamepadPrefs.update((p) => ({ ...p, invertY: false }));
		return { yaw: yaw.dy, pitchUp: up.dx, pitchInverted: upInverted.dx };
	});
	h.check(Math.abs(looked.yaw) > 0.1, `the right stick turns the view (yaw ${looked.yaw.toFixed(3)} rad)`);
	h.check(looked.pitchUp > 0.1, `pushing the look stick UP looks up, the console default (pitch +${looked.pitchUp.toFixed(3)})`);
	h.check(
		looked.pitchInverted < -0.1,
		`and Invert look Y reverses exactly that (pitch ${looked.pitchInverted.toFixed(3)})`
	);

	// ---- 6. a menu open makes the sticks DEAD --------------------------------
	// the E3 substate, from the pad's side: a player must not be able to stroll out of
	// their own menu
	const inMenu = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		s.hudDocs.showHudScreen('scene', 'menu');
		await new Promise((r) => setTimeout(r, 700));
		let free;
		s.playPointerFree.subscribe((v) => (free = v))();
		let cam;
		s.playerCam.subscribe((v) => (cam = v))();
		const before = [cam.position.x, cam.position.z];
		w.__padAxes([0, -1, 1, 0]);
		await new Promise((r) => setTimeout(r, 900));
		const after = [cam.position.x, cam.position.z];
		w.__padIdle();
		return { free, moved: Math.hypot(after[0] - before[0], after[1] - before[1]) };
	});
	h.check(inMenu.free === true, 'premise: a screen marked input:menu freed the pointer');
	h.check(inMenu.moved < 1e-6, `the sticks are DEAD over a menu (${inMenu.moved})`);

	// ---- 7. the ring walks on the d-pad and A activates ----------------------
	const counts = () =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			return { one: t?.['c-one']?.count ?? 0, three: t?.['c-three']?.count ?? 0 };
		});
	const focusedLabel = () =>
		page.evaluate(() => document.querySelector('#hud-layer .hud-focused .hud-el')?.textContent ?? null);

	const first = await focusedLabel();
	h.check(first === 'One', `premise: the ring starts on the first button (${first})`);
	const padTap = async (index) => {
		await page.evaluate((i) => window.__padPress(i), index);
		await page.waitForTimeout(160);
		await page.evaluate((i) => window.__padRelease(i), index);
		await page.waitForTimeout(160);
	};
	await padTap(DPAD_DOWN);
	const second = await focusedLabel();
	h.check(second === 'Two', `d-pad down walks the ring forward (${second})`);
	await padTap(DPAD_UP);
	const back = await focusedLabel();
	h.check(back === 'One', `d-pad up walks it back (${back})`);
	await padTap(DPAD_UP);
	const wrapped = await focusedLabel();
	h.check(wrapped === 'Three', `and it WRAPS rather than sticking (${wrapped})`);

	await padTap(DPAD_RIGHT);
	const rightWalk = await focusedLabel();
	h.check(rightWalk === 'One', `d-pad right walks forward too, wrapping past the end (${rightWalk})`);
	await padTap(DPAD_DOWN);
	await padTap(DPAD_DOWN);

	const beforePress = await counts();
	await padTap(A_BTN);
	await page.waitForTimeout(500);
	const afterA = await counts();
	h.check(
		afterA.three === beforePress.three + 1,
		`A fires the FOCUSED button through the replicated nodetrigger path (${beforePress.three} -> ${afterA.three})`
	);
	h.check(afterA.one === beforePress.one, `and only that one (button One stayed ${afterA.one})`);

	// B is deliberately unbound: "back" is a screen-STACK concern, and hiding the screen
	// would strand a player whose menu is showWhile-bound
	const ringBeforeB = await focusedLabel();
	await padTap(B_BTN);
	await page.waitForTimeout(300);
	const afterB = await counts();
	const ringAfterB = await focusedLabel();
	h.check(
		ringAfterB === ringBeforeB && afterB.three === afterA.three,
		`B does nothing yet — no move, no press (${ringAfterB})`
	);

	// ---- 8. enabled = false kills every pad path ----------------------------
	const off = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		s.gamepadPrefs.gamepadPrefs.update((p) => ({ ...p, enabled: false }));
		await new Promise((r) => setTimeout(r, 300));
		const ringBefore = document.querySelector('#hud-layer .hud-focused .hud-el')?.textContent ?? null;
		let t0;
		s.flowTriggers.subscribe((v) => (t0 = v))();
		const stampBefore = t0['gp-down']?.lastT ?? null;
		// walk back to the game screen so the sticks would otherwise be live
		s.hudDocs.showHudScreen('scene', 'play');
		await new Promise((r) => setTimeout(r, 500));
		let cam;
		s.playerCam.subscribe((v) => (cam = v))();
		const from = [cam.position.x, cam.position.z];
		w.__padAxes([0, -1, 0, 0]);
		w.__padPress(0);
		w.__padPress(13);
		await new Promise((r) => setTimeout(r, 800));
		const to = [cam.position.x, cam.position.z];
		let t1;
		s.flowTriggers.subscribe((v) => (t1 = v))();
		const stampAfter = t1['gp-down']?.lastT ?? null;
		w.__padIdle();
		s.hudDocs.showHudScreen('scene', 'menu');
		await new Promise((r) => setTimeout(r, 400));
		const ringAfter = document.querySelector('#hud-layer .hud-focused .hud-el')?.textContent ?? null;
		let v;
		s.flowValues.subscribe((x) => (v = x))();
		const axisRead = v['gp-ax'];
		s.gamepadPrefs.gamepadPrefs.update((p) => ({ ...p, enabled: true }));
		return { moved: Math.hypot(to[0] - from[0], to[1] - from[1]), stampBefore, stampAfter, ringBefore, ringAfter, axisRead };
	});
	h.check(off.moved < 1e-6, `switched off, the sticks move nothing (${off.moved})`);
	h.check(off.stampAfter === off.stampBefore, 'no node fires');
	h.check(off.ringAfter === off.ringBefore, `and the ring does not walk (${off.ringBefore} -> ${off.ringAfter})`);
	h.check(off.axisRead === 0, `the axis node reads 0 rather than a stale value (${off.axisRead})`);

	// ---- 9. disconnect: released, zeroed, and announced ---------------------
	const gone = await page.evaluate(async () => {
		const w = /** @type {any} */ (window);
		const s = window.__stores;
		w.__padAxes([0.9, 0, 0, 0]);
		w.__padPress(0);
		await new Promise((r) => setTimeout(r, 500));
		let t0;
		s.flowTriggers.subscribe((v) => (t0 = v))();
		const upBefore = t0['gp-up']?.lastT ?? null;
		w.__padPresent = false; // unplugged with the stick pushed and a button held
		await new Promise((r) => setTimeout(r, 600));
		let t1;
		s.flowTriggers.subscribe((v) => (t1 = v))();
		let v;
		s.flowValues.subscribe((x) => (v = x))();
		const held = s.inputRuntime.getGamepadButtons().size;
		const axes = s.inputRuntime.getGamepadAxes();
		let toastList;
		s.toastStore.subscribe((x) => (toastList = x))();
		w.__padIdle();
		w.__padPresent = true;
		return {
			name: s.inputRuntime.gamepadName(),
			held,
			axisRead: v['gp-ax'],
			lx: axes.lx,
			upFired: (t1['gp-up']?.lastT ?? null) !== upBefore,
			toasts: toastList.map((x) => (typeof x === 'string' ? x : x.text))
		};
	});
	h.check(gone.name === null, 'unplugging clears the device');
	h.check(gone.held === 0 && gone.lx === 0, `held buttons are RELEASED and the sticks zeroed (${gone.held} held, lx ${gone.lx})`);
	h.check(gone.upFired, 'the release travels as a real up edge, so an edge:up node still fires');
	h.check(gone.axisRead === 0, `and a pushed stick cannot keep driving after the pad is gone (${gone.axisRead})`);
	h.check(gone.toasts.some((t) => t === 'Gamepad disconnected'), 'and it says so');

	// ---- 10. Settings ▸ Input, through the real modal ------------------------
	await page.evaluate(() => {
		window.__stores.isLocked.set(null);
		window.__stores.hudDocs.showHudScreen('scene', 'play');
		window.__stores.settingsSection.set('input');
		window.__stores.settingsOpen.set(true);
	});
	await page.waitForTimeout(900);
	const rows = await page.evaluate(() => ({
		toggle: !!document.querySelector('#gamepad-enabled'),
		swap: !!document.querySelector('#gamepad-swap'),
		invert: !!document.querySelector('#gamepad-invert-y'),
		deadzone: /** @type {any} */ (document.querySelector('#gamepad-deadzone'))?.value ?? null,
		sensitivity: /** @type {any} */ (document.querySelector('#gamepad-sensitivity'))?.value ?? null
	}));
	h.check(
		rows.toggle && rows.swap && rows.invert,
		`Settings ▸ Input renders its three switches (${JSON.stringify([rows.toggle, rows.swap, rows.invert])})`
	);
	h.check(rows.deadzone === '0.15', `with the deadzone field showing the default (${rows.deadzone})`);
	h.check(rows.sensitivity === '1', `and the sensitivity field (${rows.sensitivity})`);

	// drive the REAL field, not the store: a pref nobody can reach is not a pref
	await page.locator('#gamepad-deadzone').fill('0.3');
	await page.locator('#gamepad-deadzone').dispatchEvent('change');
	await page.waitForTimeout(300);
	const typed = (await prefs()).deadzone;
	h.check(typed === 0.3, `typing in the field writes the pref (${typed})`);
	// out of range is CLAMPED at the store boundary, not trusted
	await page.locator('#gamepad-deadzone').fill('9');
	await page.locator('#gamepad-deadzone').dispatchEvent('change');
	await page.waitForTimeout(300);
	const clamped = (await prefs()).deadzone;
	h.check(clamped === 0.4, `and a silly value is clamped rather than handed to the camera maths (${clamped})`);
	// ---- 11. the prefs are LOCAL and survive a reload -----------------------
	// Close the modal FIRST: a number input can fire a change on BLUR, and a stray
	// commit here would make "the pref did not persist" and "the pref was never
	// written" look identical (measured: the first version read 0.4 back).
	await page.evaluate(() => window.__stores.settingsOpen.set(false));
	await page.waitForTimeout(400);
	await page.evaluate(() => window.__stores.gamepadPrefs.setGamepadPrefs({ deadzone: 0.35 }));
	await page.waitForTimeout(300);
	const beforeReload = await prefs();
	h.check(beforeReload.deadzone === 0.35, `premise: the pref reads 0.35 before the reload (${beforeReload.deadzone})`);
	const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('gamepadPrefs') || '{}').deadzone);
	h.check(stored === 0.35, `and localStorage carries it — a LOCAL pref, never a scene field (${stored})`);

	await h.freshReload(A);
	await page.waitForFunction(() => !!window.__stores?.gamepadPrefs, { timeout: 30000 });
	// a reload gives the page a NEW peer id — re-read it before the connect below
	A.id = await page.evaluate(
		() => new Promise((r) => window.__stores.peers.subscribe((x) => r(x?.peer?.id))())
	);
	const persisted = await prefs();
	h.check(persisted.deadzone === 0.35, `the deadzone survives a reload (${persisted.deadzone})`);
	h.check(persisted.enabled === true, 'and so does the master switch');
	await page.evaluate(() => window.__stores.gamepadPrefs.setGamepadPrefs({ deadzone: 0.15 }));

	// ---- 12. an AXIS IS LOCAL, and that is the design ----------------------
	// The one judgement in this phase worth a two-peer guard: a stick reading is derived
	// from hardware only this peer has, so a peer holding the SAME graph must read its
	// own (absent) pad rather than mine. A shared axis is E6's controller authority.
	const B = await h.setupPage(browser, 'B');
	await B.page.waitForFunction(() => !!window.__stores?.gamepadPrefs, { timeout: 30000 });
	await h.connect(B, A);
	await stubPad(page); // the reload dropped the stub
	await page.evaluate(() => {
		window.__stores.objectActions.deselectObject();
		const s = window.__stores;
		s.nodesHandler.createFlowNode({
			id: 'gp-local',
			type: 'gamepadaxis',
			position: { x: 40, y: 200 },
			data: { type: 'gamepadaxis', axis: 'lx', deadzone: 0, invert: false, scale: 1 }
		});
	});
	await page.waitForTimeout(600);
	// createFlowNode is the APPLIER and does not broadcast (the flowNodes.set trap), so
	// PUSH the graph rather than waiting on nodesync's periodic hash compare
	await page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	let heldByPeer = false;
	for (let i = 0; i < 24 && !heldByPeer; i++) {
		heldByPeer = await B.page.evaluate(() => {
			let g;
			window.__stores.flowGraphs.subscribe((x) => (g = x))();
			return (g.scene?.nodes ?? []).some((n) => n.id === 'gp-local');
		});
		if (!heldByPeer) await B.page.waitForTimeout(300);
	}
	h.check(heldByPeer, 'premise: the peer holds the same graph');

	await page.evaluate(() => window.__padAxes([1, 0, 0, 0]));
	await page.waitForTimeout(800);
	const mine = await page.evaluate(() => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v['gp-local'];
	});
	const theirs = await B.page.evaluate(() => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v['gp-local'];
	});
	h.check(Math.abs(mine - 1) < 1e-6, `premise: my stick is at full deflection (${mine})`);
	h.check(
		theirs === 0,
		`the peer evaluates the same node against ITS OWN pad, so a stick never leaks through the graph (${theirs})`
	);

	// a BUTTON, by contrast, is meant to replicate — it rides the trigger-stamp channel
	await page.evaluate(() => {
		window.__padAxes([0, 0, 0, 0]);
		window.__stores.nodesHandler.createFlowNode({
			id: 'gp-shared',
			type: 'gamepadbutton',
			position: { x: 40, y: 320 },
			data: { type: 'gamepadbutton', button: 'GamepadX', edge: 'down', pulse: 0.3 }
		});
	});
	await page.waitForTimeout(400);
	await page.evaluate((peerId) => window.__stores.nodesHandler.sendNodes(peerId), B.id);
	await B.page.waitForTimeout(1200);
	await page.evaluate(() => window.__padPress(2)); // X
	await page.waitForTimeout(800);
	const stampB = await B.page.evaluate(() => {
		let t;
		window.__stores.flowTriggers.subscribe((v) => (t = v))();
		return t['gp-shared']?.lastT ?? null;
	});
	await page.evaluate(() => window.__padRelease(2));
	h.check(
		stampB !== null,
		`a pad PRESS does replicate, as a trigger stamp — the same channel a key press uses (${stampB})`
	);

	const errs = h.pageErrors(A).concat(h.pageErrors(B));
	h.check(errs.length === 0, `no page errors across the run (${errs.slice(0, 2).join(' | ')})`);

	await h.finish(browser);
});
