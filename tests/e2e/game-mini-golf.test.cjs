// 35-mini-golf ACCEPTANCE — the Mini Golf game template, loaded from a REAL authored .tpscene
// (MINIGOLF_TPSCENE=<path>, else the lane's staging tree, else the sibling scenes checkout) and
// driven through the real surfaces: the start menu, Play, a REAL MOUSE putt (press on the ball,
// drag back, let go), a scripted round of hole 1 to the cup and on to hole 2, out of bounds, the
// scorecard, a VR-emulated start (a fake XR session lands a game in Interact; a hand knock is a
// stroke), and the draw-call budget. Skip-never-fail when no authored scene is found.
// 36 (U10): the rules are the "Mini Golf rules" behaviour on the Main graph (its replicated state
// is what this suite reads) and the module is the engine. §9 is the U10 ACCEPTANCE PROBE: shot
// power changed from the graph (the ⓘ property panel) and a hole's par changed in the code view,
// both felt in Play, both still there after a save and a reload.
const h = require('./helpers.cjs');
const xr = require('./fakeXR.cjs');
const fs = require('fs');
const path = require('path');

const CANDIDATES = [
	process.env.MINIGOLF_TPSCENE,
	path.resolve(__dirname, '../../../cloud-lane-30-staging/36-games-graphs/games/mini-golf/scene.tpscene'),
	path.resolve(__dirname, '../../../cloud-lane-30-staging/35-mini-golf/games/mini-golf/scene.tpscene'),
	path.resolve(__dirname, '../../../theprototype.app-scenes/games/mini-golf/scene.tpscene'),
	path.resolve(__dirname, '../../../scenes/games/mini-golf/scene.tpscene')
].filter(Boolean);
const TPSCENE = CANDIDATES.find((p) => fs.existsSync(p));
const SHOTS = process.env.MINIGOLF_SHOTS || '';
/** poll without counting a check @param {() => Promise<any>} fn @param {(v: any) => boolean} pred @param {number} ms */
async function waitFor(fn, pred, ms) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (pred(await fn())) return true;
		await new Promise((r) => setTimeout(r, 300));
	}
	return false;
}

h.run(async () => {
	if (!TPSCENE) {
		console.log('SKIP: no authored games/mini-golf/scene.tpscene (set MINIGOLF_TPSCENE)');
		return;
	}
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { context: { viewport: { width: 1280, height: 720 } } });
	const page = A.page;
	const bytes = Array.from(fs.readFileSync(TPSCENE));
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, bytes);
	await page.waitForTimeout(2000);

	const snap = () =>
		page.evaluate(() => {
			const s = window.__stores;
			const g = (st) => { let v; st.subscribe((x) => (v = x))(); return v; };
			const group = g(s.objectsGroup);
			return {
				names: group.children.map((c) => c.name),
				dynamic: group.children.filter((c) => c.userData?.physics?.mode === 'dynamic').map((c) => c.name),
				sim: !!g(s.physics.simulating),
				state: g(s.gameState.gameState)?.state ?? null,
				play: g(s.scenePhysics.scenePlay),
				screen: s.hudDocs.visibleScreen('scene')?.id ?? null,
				// 36: the rules' replicated state (the behaviour document)
				vars: (() => {
					const id = window.__minigolf?.rulesNode?.();
					const st = id ? s.behaviours?.behaviourState?.(id) : null;
					return st ? JSON.parse(JSON.stringify(st)) : null;
				})(),
				ball: window.__minigolf?.ball?.()?.pos ?? null
			};
		});
	const rulesId = () => page.evaluate(() => window.__minigolf?.rulesNode?.() ?? null);
	const callRules = (method, ...args) => page.evaluate(([m, a]) => window.__stores.behaviours.behavioursDebug().call(window.__minigolf.rulesNode(), m, ...a), [method, args]);
	const pressInput = (name) => page.evaluate((n) => window.__stores.behaviours.behaviourInput(window.__minigolf.rulesNode(), n), name);
	/** a putt toward a point, as the drag the rules turn into speed (drag = speed * fullDrag / shotPower) */
	const puttAt = (at, speed) => page.evaluate(([at, sp]) => window.__minigolf.puttAt(at, Math.min(2.5, (sp * 2.5) / 7)), [at, speed]);
	/** the fastest the ball goes in the first second after a putt */
	const peakSpeed = () =>
		page.evaluate(async () => {
			let peak = 0;
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 33));
				peak = Math.max(peak, window.__minigolf.ball().speed);
			}
			return peak;
		});
	const hud = async () => (await page.locator('#hud-layer').textContent()) ?? '';

	// 1 — the course arrived
	let st = await snap();
	h.check(st.names.includes('Mini golf game'), 'the marker that wakes the minigolf module is in the scene');
	const need = [1, 2, 3, 4, 5, 6].flatMap((n) => ['Green ' + n, 'Cup ' + n, 'Putter ' + n]).concat(['High green', 'Ramp', 'Windmill blade A', 'Bank wall', 'Sand trap', 'Hump up', 'Golf ball']);
	const missing = need.filter((n) => !st.names.includes(n));
	h.check(missing.length === 0, `six holes: greens, cups, putters, ramp, windmill, wall, sand, hump, the ball (${missing.join(', ') || 'all present'})`);
	h.check(st.dynamic.includes('Golf ball') && st.dynamic.filter((n) => /^Putter/.test(n)).length === 6, `the ball and six putters are dynamic (${st.dynamic.join(', ')})`);
	h.check(st.play?.simOnPlay === true && st.play?.cursor === 'free', `play block: simOnPlay, a FREE cursor (${JSON.stringify(st.play)})`);
	h.check(st.state === 'menu' && st.screen === 'menu', `starts on the start menu (${st.state}/${st.screen})`);
	h.check(!!(await page.evaluate(() => window.__minigolf)), 'the core minigolf module (the engine) is awake');
	// 36 U10: the Main graph carries the rules, the engine lends them its helpers
	const main = await page.evaluate(() => {
		let g; window.__stores.flowGraphs.subscribe((v) => (g = v))();
		const nodes = g.scene.nodes;
		const rules = nodes.find((n) => n.type === 'behaviour');
		return {
			rules: rules ? { id: rules.id, name: rules.data.name, main: rules.data.main, lines: String(rules.data.code).split('\n').length } : null,
			groups: nodes.filter((n) => n.type === 'group').map((n) => n.data.label),
			notes: nodes.filter((n) => n.type === 'note').length,
			engineLink: nodes.some((n) => n.type === 'coderef' && n.data.module === 'minigolf')
		};
	});
	h.check(main.rules?.name === 'Mini Golf rules' && main.rules.main === 1 && main.rules.lines > 100, `Main holds the rules behaviour (${JSON.stringify(main.rules)})`);
	h.check(main.groups.length >= 3 && main.notes >= 4 && main.engineLink, `Main has groups (${main.groups.join(', ')}), ${main.notes} notes and a link to the engine's code`);
	await h.eventually(() => page.evaluate(() => window.__stores.behaviours.behavioursDebug().status[window.__minigolf.rulesNode()]?.status), (st) => st === 'running', 'the rules behaviour is running', 10000);
	const engine = await page.evaluate(() => window.__stores.engines.enginesDebug().find((p) => p.piece === 'golf'));
	h.check(engine && engine.calls.includes('action:hit') && engine.listeners.rolling >= 1 && engine.listeners.stopped >= 1, `the golf engine piece is lent to the rules, which listen to it (${JSON.stringify(engine?.listeners)})`);

	// 2 — Play: the sim, the menu, Tee off
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'entering Play starts the simulation', 10000);
	await h.eventually(hud, (t) => /MINI GOLF/.test(t) && /Tee off/.test(t), 'the start menu renders in Play', 6000);
	h.check(/drag BACK/.test(await hud()) && /putter/.test(await hud()), 'the menu says how to putt on a desktop and in VR');
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'menu.png') });
	await page.locator('#hud-layer button', { hasText: 'Tee off' }).click();
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.hole === 1, 'Tee off (wired into the rules) starts the round on hole 1', 6000);
	await h.eventually(hud, (t) => /Hole 1 of 6/.test(t) && /Par 2/.test(t) && /Strokes 0/.test(t), 'the HUD: hole, par, strokes', 6000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] + 12.5) < 0.05 && Math.abs(b[2] - 4.4) < 0.1, 'the ball sits on hole 1 tee', 4000);
	const eye = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		const p = cam.getWorldPosition(new s.THREE.Vector3());
		return [p.x, p.y, p.z].map((n) => +n.toFixed(2));
	});
	h.check(Math.abs(eye[0] + 12.5) < 0.3 && Math.abs(eye[2] - 6.4) < 0.4, `the player stands behind the tee (${eye})`);
	await page.waitForTimeout(800);

	// 3 — a REAL MOUSE putt: press on the ball, drag back toward the camera, let go
	const ballScreen = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.globalCamera.subscribe((v) => (cam = v))();
		let r; s.globalRenderer.subscribe((v) => (r = v))();
		const b = window.__minigolf.ball().pos;
		const v = new s.THREE.Vector3(...b).project(cam);
		const rect = r.domElement.getBoundingClientRect();
		return { x: rect.left + ((v.x + 1) / 2) * rect.width, y: rect.top + ((1 - v.y) / 2) * rect.height };
	});
	const under = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, ballScreen);
	h.check(under === 'CANVAS', `premise: the ball's pixel is the canvas (${under} at ${Math.round(ballScreen.x)},${Math.round(ballScreen.y)})`);
	await page.mouse.move(ballScreen.x, ballScreen.y);
	await page.mouse.down();
	await page.mouse.move(ballScreen.x, ballScreen.y + 40, { steps: 4 });
	await page.mouse.move(ballScreen.x, ballScreen.y + 90, { steps: 4 });
	const arrow = await page.evaluate(() => {
		const s = window.__stores;
		let sc; s.globalScene.subscribe((v) => (sc = v))();
		const a = sc.getObjectByName('golf-aim');
		return a ? { visible: a.visible, len: a.children[0].scale.z } : null;
	});
	h.check(arrow?.visible && arrow.len > 0.2, `dragging back shows the aim arrow (${JSON.stringify(arrow)})`);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'aim.png') });
	await page.mouse.up();
	await h.eventually(() => snap().then((v) => v.vars?.strokes), (n) => n === 1, 'letting go putts: one stroke', 4000);
	await page.waitForTimeout(300);
	const rolled = await snap();
	h.check(rolled.ball[2] < 4.3, `the ball rolled AWAY from the drag, up the lane (z ${rolled.ball[2].toFixed(2)})`);

	// 4 — finish hole 1: scripted putts at the cup until it drops
	for (let i = 0; i < 8; i++) {
		await waitFor(() => snap().then((v) => v.vars?.phase), (p) => p !== 'rolling', 12000);
		const now = await snap();
		if (now.vars.phase === 'sunk' || now.vars.hole !== 1) break;
		const d = Math.hypot(now.ball[0] + 12.5, now.ball[2] + 4.5);
		await puttAt([-12.5, 0.1, -4.5], Math.min(6.5, 1.2 + d * 0.75));
		await page.waitForTimeout(500);
	}
	await h.eventually(() => snap().then((v) => v.vars), (v) => v.scores?.[0] > 0, 'hole 1 is sunk and scored', 12000);
	const s1 = (await snap()).vars.scores[0];
	await h.eventually(() => snap().then((v) => v.vars?.hole), (n) => n === 2, `after the cup, hole 2 (hole 1 took ${s1})`, 8000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] + 7.5) < 0.05 && b[2] > 3.5, 'the ball is on hole 2 tee', 4000);
	await h.eventually(hud, (t) => /Hole 2 of 6/.test(t) && new RegExp('Total ' + s1).test(t), 'the HUD moved on and carries the total', 4000);
	const eye2 = await page.evaluate(() => {
		const s = window.__stores;
		let cam; s.playerCam.subscribe((v) => (cam = v))();
		return cam.getWorldPosition(new s.THREE.Vector3()).x;
	});
	h.check(Math.abs(eye2 + 7.5) < 0.4, `the player was teleported to hole 2 tee (x ${eye2.toFixed(2)})`);

	// 5 — out of bounds: a stroke and back to the last spot
	await page.waitForTimeout(500);
	const beforeOob = (await snap()).vars;
	await page.evaluate(() => window.__minigolf.lob([6, 6, 0]));
	await h.eventually(() => snap().then((v) => v.vars), (v) => v.oob === beforeOob.oob + 1, 'a ball over the rail is out of bounds', 8000);
	const afterOob = await snap();
	h.check(afterOob.vars.strokes === beforeOob.strokes + 2 && Math.abs(afterOob.ball[0] + 7.5) < 0.2, `+1 penalty and the ball is back on its lane (strokes ${afterOob.vars.strokes}, x ${afterOob.ball[0].toFixed(2)})`);

	// 6 — the draw-call budget in Play (<= 150)
	const calls = await page.evaluate(async () => {
		let r; window.__stores.globalRenderer.subscribe((v) => (r = v))();
		// every render() pass of a display frame summed (shadow + composer), the perf-games rule
		const frame = () => new Promise((res) => requestAnimationFrame(res));
		let max = 0;
		r.info.autoReset = false;
		for (let i = 0; i < 6; i++) {
			await frame();
			r.info.reset();
			await frame();
			max = Math.max(max, r.info.render.calls);
		}
		r.info.autoReset = true;
		return max;
	});
	h.check(calls > 0 && calls <= 150, `draw calls in Play <= 150 (${calls})`);
	const helpers = await page.evaluate(() => {
		let sc; window.__stores.globalScene.subscribe((v) => (sc = v))();
		const grid = sc.getObjectByName('editor-grid');
		return grid ? grid.visible : false;
	});
	h.check(!helpers, 'no editor grid in Play');

	// 7 — the scorecard: holes 2-5 scored through the rules' own method, hole 6 putted
	for (let n = 2; n <= 5; n++) {
		await waitFor(() => snap().then((v) => v.vars), (v) => v.hole === n && v.phase !== 'rolling', 12000);
		await callRules('holeDone', 3);
		await h.eventually(() => snap().then((v) => v.vars?.hole), (h2) => h2 === n + 1, `hole ${n} scored 3, on to hole ${n + 1}`, 8000);
	}
	await page.waitForTimeout(400);
	for (let i = 0; i < 10; i++) {
		const now = await snap();
		if (now.state === 'over') break;
		if (now.vars.phase === 'ready') {
			const d = Math.hypot(now.ball[0] - 12.5, now.ball[2] + 5.2);
			await puttAt([12.5, 0.1, -5.2], Math.min(6.5, 1.5 + d * 0.8));
		}
		await page.waitForTimeout(2500);
	}
	await h.eventually(() => snap().then((v) => v.state), (s) => s === 'over', 'after hole 6 the round is over', 30000);
	await h.eventually(hud, (t) => /Course complete/.test(t) && /1\. Straight/.test(t) && /6\. The hump/.test(t) && /Play again/.test(t), 'the scorecard lists all six holes', 6000);
	if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'scorecard.png') });
	await h.eventually(hud, (t) => /Best on this device: \d+/.test(t), "the round is saved as this device's best (Store Value min → the script's words)", 4000);
	const score = await page.evaluate(() => window.__stores.kit?.kit?.impls?.score?.total?.() ?? null);
	h.check(score === (await snap()).vars.total, `the total became the kit score through the graph's Kit node (${score})`);
	await page.locator('#hud-layer button', { hasText: 'Menu' }).click();
	await h.eventually(() => snap().then((v) => v.state), (s) => s === 'menu', 'Menu goes back to the start menu', 6000);

	// 7b — the shell's Levels page lists every hole and starts a round on the one picked
	const lv = await page.evaluate(() => window.__stores.gameKit.gameShell.gameShellDebug().levels);
	h.check(lv?.list?.length === 6 && /Windmill/.test(lv.list[2].label), `the Levels page lists the six holes (${lv?.list?.map((l) => l.label).join(' | ')})`);
	await page.evaluate(() => window.__stores.gameKit.gameShell.pickGameLevel('4'));
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.hole === 4, 'picking hole 4 starts a round there', 6000);
	await h.eventually(() => snap().then((v) => v.ball), (b) => b && Math.abs(b[0] - 2.5) < 0.05 && b[2] > 3.5, 'the ball waits on hole 4 tee', 4000);

	// 7c — the pause menu's Restart: a fresh card from hole 1
	await page.evaluate(() => window.__stores.gameKit.gameShell.restartGame());
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.hole === 1 && v.vars?.strokes === 0 && v.vars?.scores?.[0] === 0, 'the shell Restart starts a fresh round on hole 1', 6000);

	// 9 — THE U10 PROBE: one number from the graph, one from the code; both felt in Play, both kept
	await page.waitForTimeout(800);
	const tee1 = [-12.5, 0.18, 4.4];
	const fullPutt = () => page.evaluate(() => window.__minigolf.puttAt([-12.5, 0.1, -4.5], 2.5));
	await fullPutt();
	const before = await peakSpeed();
	h.check(before > 6 && before < 7.6, `premise: a full-drag putt at the stock shot power runs ~7 m/s (${before.toFixed(2)})`);
	// (a) the GRAPH: select the rules node, the ⓘ tab, Shot power 7 → 3
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	if (!(await page.evaluate(() => !!document.querySelector('.svelte-flow__pane')))) await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1000);
	await page.evaluate(() => window.__stores.bottomDock?.dockHeight?.set(600));
	if (!(await page.locator('#flow-props').count())) await page.locator('#flow-props-toggle').click();
	await page.locator('#flow-tab-info').click();
	const rid = await rulesId();
	await page.evaluate((id) => window.__stores.flowNodes.update((ns) => ns.map((n) => ({ ...n, selected: n.id === id }))), rid);
	await h.eventually(() => page.locator('#flow-prop-shotPower').count(), (n) => n === 1, 'the rules node shows Shot power in its properties panel', 6000);
	await page.locator('#flow-prop-shotPower').fill('3');
	await page.locator('#flow-prop-shotPower').press('Enter');
	const codeNow = () => page.evaluate((id) => { let g; window.__stores.flowGraphs.subscribe((v) => (g = v))(); return g.scene.nodes.find((n) => n.id === id).data.code; }, rid);
	await h.eventually(codeNow, (c) => /shotPower:\s*\{\s*value:\s*3\b/.test(c), 'the knob rewrote the literal in the rules source (shotPower: 3)', 4000);
	// (b) the CODE: open the rules in the code workspace and make hole 1 a par 4
	await page.evaluate((id) => {
		let ns;
		window.__stores.flowNodes.subscribe((v) => (ns = v))();
		const n = ns.find((x) => x.id === id);
		window.__flowViewport?.setViewport({ x: -n.position.x + 300, y: -n.position.y + 60, zoom: 1 });
	}, rid);
	await page.waitForTimeout(600);
	const box = await page.locator(`.svelte-flow__node[data-id="${rid}"]`).boundingBox().catch(() => null);
	if (box) await page.mouse.dblclick(box.x + box.width / 2, box.y + 8);
	else await page.evaluate((id) => window.__stores.codeWorkspace.openCode({ source: 'behaviour', ref: { nodeId: id } }), rid);
	await h.eventually(() => page.locator('[data-pane] .cm-content').count(), (n) => n >= 1, 'double-click opens the rules in the code workspace', 15000);
	const edited = (await codeNow()).replace("{ name: 'Straight', par: 2,", "{ name: 'Straight', par: 4,");
	const paneId = await page.evaluate(() => { let v; window.__stores.codeWorkspace.activeCodeTab.subscribe((x) => (v = x))(); return v; });
	await page.locator(`[data-pane="${paneId}"] .cm-content`).click();
	await page.keyboard.press('Control+A');
	await page.keyboard.insertText(edited);
	await page.keyboard.press('Control+S');
	await h.eventually(codeNow, (c) => /name: 'Straight', par: 4,/.test(c), 'Ctrl+S saved the code onto the node (hole 1 is par 4)', 6000);
	await page.locator('#code-ws-close').click().catch(() => {});
	await h.eventually(() => page.evaluate(() => window.__stores.behaviours.behavioursDebug().status[window.__minigolf.rulesNode()]?.status), (st) => st === 'running', 'the edited rules reloaded and run', 8000);
	// both felt in Play
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await page.waitForTimeout(600);
	await pressInput('teeOff');
	await h.eventually(hud, (t) => /Par 4/.test(t) && /Hole 1 of 6/.test(t), 'Play: hole 1 now says Par 4 (the code change)', 8000);
	await page.waitForTimeout(800);
	await fullPutt();
	const after = await peakSpeed();
	h.check(after > 1.5 && after < 3.4, `Play: the same full-drag putt now runs ~3 m/s (the graph change; ${after.toFixed(2)} vs ${before.toFixed(2)})`);
	// (c) both survive a save and a reload
	const saved = await page.evaluate(async () => {
		const s = window.__stores;
		const payload = s.sessions.buildSessionPayload('Mini Golf probe');
		const zip = await s.sessions.exportSessionZip(payload, { assets: true, packs: false, flow: true });
		return Array.from(zip);
	});
	await page.evaluate(async (arr) => {
		const s = window.__stores;
		s.flowGraphs.set({ scene: { nodes: [], edges: [] } });
		const payload = await s.sessions.readSessionZip(new Uint8Array(arr).buffer);
		await s.sessions.applySession(payload, { backup: false });
	}, saved);
	await page.waitForTimeout(2500);
	const reloaded = await codeNow();
	h.check(/shotPower:\s*\{\s*value:\s*3\b/.test(reloaded) && /name: 'Straight', par: 4,/.test(reloaded), 'after a save and a reload the rules keep shot power 3 and par 4');
	await h.eventually(() => page.evaluate(() => window.__stores.behaviours.behavioursDebug().status[window.__minigolf.rulesNode()]?.status), (st) => st === 'running', 'the reloaded rules run', 10000);
	await page.evaluate(() => window.__stores.isLocked.set(true));
	await h.eventually(() => snap().then((v) => v.sim), (v) => v === true, 'Play again after the reload', 10000);
	await pressInput('teeOff');
	await h.eventually(hud, (t) => /Par 4/.test(t), 'Play after the reload: hole 1 is still par 4', 8000);
	await page.waitForTimeout(800);
	await fullPutt();
	const again = await peakSpeed();
	h.check(again > 1.5 && again < 3.4, `Play after the reload: the putt still runs ~3 m/s (${again.toFixed(2)})`);

	// 8 — VR: a fake session lands the game in Interact; start; a hand knock is a stroke
	await page.evaluate(() => window.__stores.isLocked.set(null));
	await page.waitForTimeout(600);
	await page.evaluate(() => window.__stores.isVRMode.set(true));
	await xr.install(page);
	await xr.installSpace(page, { head: [0, 1.6, 0], yaw: 0 });
	await page.evaluate(() => window.__stores.vrControls.onVRSessionStart());
	await page.waitForTimeout(400);
	const mode = await page.evaluate(() => { let m; window.__stores.editorMode.subscribe((v) => (m = v))(); return m; });
	h.check(mode === 'interact', `a VR session on Mini Golf lands in Interact (${mode})`);
	await pressInput('teeOff');
	await h.eventually(() => snap(), (v) => v.state === 'playing' && v.vars?.hole === 1 && v.sim, 'VR: the round starts on hole 1 with the simulation running', 10000);
	await page.waitForTimeout(800);
	const vrBall = (await snap()).ball;
	// grip the putter lying beside the tee (aim the right controller straight down at it)
	const worldPose = (pos, pitch) =>
		page.evaluate(({ pos, pitch }) => {
			const s = window.__stores;
			const c = window.__fakeXR.renderer.xr.getController(1);
			const q = new s.THREE.Quaternion().setFromEuler(new s.THREE.Euler(pitch, 0, 0, 'YXZ'));
			const world = new s.THREE.Matrix4().compose(new s.THREE.Vector3(...pos), q, new s.THREE.Vector3(1, 1, 1));
			c.parent.updateMatrixWorld(true);
			c.matrix.copy(c.parent.matrixWorld.clone().invert().multiply(world));
			c.updateMatrixWorld(true);
		}, { pos, pitch });
	const putter = await page.evaluate(() => {
		let g; window.__stores.objectsGroup.subscribe((v) => (g = v))();
		const p = g.getObjectByName('Putter 1');
		return { uuid: p.uuid, pos: p.getWorldPosition(new window.__stores.THREE.Vector3()).toArray() };
	});
	await worldPose([putter.pos[0], 0.9, putter.pos[2]], -Math.PI / 2);
	await page.waitForTimeout(200);
	await xr.button(page, 'right', 1, true);
	await page.waitForTimeout(300);
	const held = await page.evaluate(() => window.__stores.vrControls.vrGripDebug());
	h.check(held.grab === putter.uuid, `VR: the grip holds the putter (${held.grab})`);
	// swing: move the hand so the club head passes through the ball toward the cup (-z)
	const offset = await page.evaluate(() => {
		const s = window.__stores;
		let g; s.objectsGroup.subscribe((v) => (g = v))();
		const p = g.getObjectByName('Putter 1');
		const head = p.localToWorld(new s.THREE.Vector3(0, -0.42, 0));
		const c = window.__fakeXR.renderer.xr.getController(1);
		const hand = c.getWorldPosition(new s.THREE.Vector3());
		return [head.x - hand.x, head.y - hand.y, head.z - hand.z];
	});
	for (let k = 0; k <= 16; k++) {
		const z = vrBall[2] + 0.4 - k * 0.05;
		await worldPose([vrBall[0] - offset[0], vrBall[1] - offset[1], z - offset[2]], -Math.PI / 2);
		await page.waitForTimeout(20);
	}
	await h.eventually(() => snap().then((v) => v.vars?.strokes), (n) => n >= 1, 'VR: swinging the held putter through the ball is a stroke', 5000);
	await xr.button(page, 'right', 1, false);
	await page.waitForTimeout(800);
	const vrAfter = (await snap()).ball;
	h.check(vrAfter[2] < vrBall[2] - 0.2, `VR: the ball went up the lane (z ${vrBall[2].toFixed(2)} -> ${vrAfter[2].toFixed(2)})`);
	await xr.setOn(page, false);
	await page.evaluate(() => window.__stores.isVRMode.set(false));

	await h.finish(browser);
});
