// 74 VH3 — WHERE AN AI AGENT IS WORKING. Two real peers: A watches (desktop first, then an EMULATED QUEST on
// IWER), B is the agent — its roster row on A carries 55's `{kind: 'agent'}` slot, and it edits through the
// same AI tools an agent session drives (create_objects / update_objects / create_flow_nodes), so every
// edit reaches A as the ordinary replicated messages. Nothing new travels; A reads them as they apply.
//   D. B creates a box: on A a bot icon + "Helper" + "editing Crate" stands above the box's top
//   M. B moves the box: the marker follows it; B edits ANOTHER object: the marker moves there
//   G. B edits an object's logic (an object graph): the marker stands on that object
//   N. the same edits from a PERSON (no agent slot) draw nothing, and demoting the row drops the marker
//   F. idle: full strength while working, fading after 20 s to a floor (never gone), a new edit restores it
//   P. the LOCAL switch (55's `agents:cameraMarker`) hides it; switched back it returns
//   V. in the headset: the XR camera draws the helper layer the marker sits on, the marker stands over the
//      box in the view, and Play hides it like every editor helper
//   X. B leaves the session: the marker goes with it
// Run: APP_URL=https://theprototype.app:5631/ node tests/e2e/agent-presence.test.cjs   (SHOTS_DIR=… for evidence)
const h = require('./helpers.cjs');
const iwer = require('./iwer.cjs');
const fs = require('fs');
const path = require('path');
const SHOTS = process.env.SHOTS_DIR || '';

/** h.eventually returns nothing: this one hands back the value it accepted (or the last one) */
async function until(fn, predicate, label, timeout = 10000) {
	const start = Date.now();
	let last;
	while (Date.now() - start < timeout) {
		last = await fn();
		if (predicate(last)) {
			h.check(true, label);
			return last;
		}
		await new Promise((r) => setTimeout(r, 300));
	}
	console.log('  last: ' + JSON.stringify(last));
	h.check(false, label);
	return last;
}

h.run(async () => {
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A', { init: iwer.initScript(), context: { viewport: { width: 1280, height: 720 } } });
	const B = await h.setupPage(browser, 'B', { context: { viewport: { width: 1280, height: 720 } } });
	await h.connect(B, A);
	const a = A.page;
	const dbg = () => a.evaluate(() => window.__stores.agentPresence.agentPresenceDebug());
	const markerOf = async () => (await dbg()).markers.find((m) => m.peerId === B.id) || null;
	const tool = (name, args) => B.page.evaluate(([n, ar]) => window.__stores.aiTools.executeAiTool(n, ar), [name, args]);
	const objectOn = (p, uuid) =>
		p.evaluate((u) => {
			let g;
			window.__stores.objectsGroup.subscribe((v) => (g = v))();
			const o = g.getObjectByProperty('uuid', u);
			if (!o) return null;
			const T = window.__stores.THREE;
			const box = new T.Box3().setFromObject(o);
			return { name: o.name, top: box.max.y, cx: (box.min.x + box.max.x) / 2, cz: (box.min.z + box.max.z) / 2 };
		}, uuid);
	/** A's roster row for B carries (or loses) the agent slot — 55's contract */
	const setAgent = (on) =>
		a.evaluate(
			([id, flag]) => {
				window.__stores.userdata.update((rows) =>
					rows.map((r) => {
						if (!Array.isArray(r) || r[0] !== id) return r;
						const row = [...r];
						while (row.length < 7) row.push(null);
						row[1] = 'Helper';
						row[6] = flag ? { kind: 'agent' } : null;
						return row;
					})
				);
				let v;
				window.__stores.userdata.subscribe((x) => (v = x))();
				return v.some((r) => r[0] === id);
			},
			[B.id, on]
		);
	const shot = async (name) => {
		if (!SHOTS) return;
		const url = await a.evaluate((id) => window.__stores.agentPresence.agentMarkerImage(id), B.id);
		if (url) fs.writeFileSync(path.join(SHOTS, name + '-marker.png'), Buffer.from(url.split(',')[1], 'base64'));
		await a.screenshot({ path: path.join(SHOTS, name + '-A.png') }).catch(() => {});
	};
	const created = (res) => (typeof res === 'string' ? JSON.parse(res) : res)?.created?.map((c) => c.uuid) ?? [];

	console.log('\n=== 0. B is an agent on A ===');
	h.check(await setAgent(true), `premise: A's roster holds B (${B.id})`);
	const before = await dbg();
	h.check(before.on && before.markers.length === 0, `no marker before the agent does anything (${JSON.stringify(before.markers)})`);

	// ---- D. create ---------------------------------------------------------------------------------------
	console.log('\n=== D. the agent creates a box ===');
	const [crate] = created(await tool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Box', name: 'Crate', position: [1, 0.5, -2] }] }));
	h.check(!!crate, `premise: B created a box (${crate})`);
	await h.eventually(() => objectOn(a, crate), (o) => o && o.name === 'Crate', 'premise: A holds the box, named Crate', 15000);
	let m = await until(markerOf, (x) => x && x.visible && x.uuid === crate, 'a marker appears on A for B', 8000);
	const box = await objectOn(a, crate);
	h.check(m && m.label === 'Helper' && /editing Crate/.test(m.sig), `it says who and what: ${m?.sig}`);
	h.check(m && Math.abs(m.point[0] - box.cx) < 0.01 && Math.abs(m.point[2] - box.cz) < 0.01 && m.point[1] > box.top && m.point[1] < box.top + 0.5, `it stands above the box's top (${JSON.stringify(m?.point)} vs top ${box.top})`);
	h.check(m && m.opacity === 1 && !m.idle, 'full strength while the agent works');
	h.check(m && m.layer === 1 << 30, `a helper (layer 30 only): mask ${m?.layer}`);
	await shot('vh3-D');

	// ---- M. move, then another object ----------------------------------------------------------------------
	console.log('\n=== M. the marker follows the work ===');
	await tool('update_objects', { updates: [{ uuid: crate, position: [-1.5, 0.5, -3] }] });
	m = await until(markerOf, (x) => x && Math.abs(x.point[0] + 1.5) < 0.05 && Math.abs(x.point[2] + 3) < 0.05, 'the marker follows the moved box', 8000);
	h.check(!!m, `at ${JSON.stringify(m?.point)}`);
	const [lamp] = created(await tool('create_objects', { objects: [{ kind: 'primitive', primitive: 'Sphere', name: 'Lamp', position: [2, 1, -1] }] }));
	await h.eventually(() => objectOn(a, lamp), (o) => !!o, 'premise: A holds the sphere', 15000);
	await tool('update_objects', { updates: [{ uuid: crate, color: '#ff8800' }] });
	await tool('update_objects', { updates: [{ uuid: lamp, color: '#00aaff' }] });
	m = await until(markerOf, (x) => x && x.uuid === lamp && /editing Lamp/.test(x.sig), 'editing another object moves the marker there', 8000);
	h.check(!!m && (await dbg()).markers.length === 1, 'still ONE marker per agent');

	// ---- G. logic ---------------------------------------------------------------------------------------
	console.log('\n=== G. editing an object graph ===');
	await tool('create_flow_nodes', { graph: crate, nodes: [{ ref: 's', type: 'spin' }] });
	m = await until(markerOf, (x) => x && x.uuid === crate, 'an edit in the box\'s own flow puts the marker on the box', 8000);
	h.check(!!m, `uuid ${m?.uuid}`);

	// ---- N. a person draws nothing -----------------------------------------------------------------------
	console.log('\n=== N. a person is not an agent ===');
	await setAgent(false);
	m = await until(markerOf, (x) => x === null, 'demoting the row drops the marker', 5000);
	h.check(m === null, 'gone');
	const taps0 = (await dbg()).taps;
	await tool('update_objects', { updates: [{ uuid: lamp, position: [2, 4, -1] }] });
	await h.eventually(() => objectOn(a, lamp), (o) => o && o.top > 4, 'premise: the person\'s move landed on A', 8000);
	const dn = await dbg();
	h.check(dn.markers.length === 0 && dn.taps === taps0, `a person's edits draw nothing (${dn.markers.length} markers, taps ${taps0} → ${dn.taps})`);
	await setAgent(true);

	// ---- F. idle fade --------------------------------------------------------------------------------------
	console.log('\n=== F. idle ===');
	await tool('update_objects', { updates: [{ uuid: lamp, position: [2, 1, -1] }] });
	await h.eventually(markerOf, (x) => x && x.visible && x.uuid === lamp, 'premise: the marker is back', 8000);
	await a.evaluate(() => window.__stores.agentPresence.ageAgentMarkersForTest(25000));
	m = await until(markerOf, (x) => x && x.idle && x.opacity < 0.9 && x.opacity > 0.4, 'after 25 s idle it is fading', 4000);
	h.check(m && /was editing Lamp/.test(m.sig), `and says so: ${m?.sig} (${m?.opacity?.toFixed(2)})`);
	await shot('vh3-F-idle');
	await a.evaluate(() => window.__stores.agentPresence.ageAgentMarkersForTest(120000));
	m = await until(markerOf, (x) => x && Math.abs(x.opacity - 0.3) < 0.01, 'long idle holds the floor', 4000);
	h.check(m && m.visible, `still there at ${m?.opacity?.toFixed(2)}`);
	await tool('update_objects', { updates: [{ uuid: lamp, color: '#22cc66' }] });
	m = await until(markerOf, (x) => x && x.opacity === 1 && !x.idle && /^Helper\|editing Lamp/.test(x.sig), 'a new edit restores it', 6000);
	h.check(!!m, 'full again');

	// ---- P. the local switch -------------------------------------------------------------------------------
	console.log('\n=== P. the switch ===');
	await a.evaluate(() => localStorage.setItem('agents:cameraMarker', 'false'));
	m = await until(markerOf, (x) => x && !x.visible, 'off: hidden', 4000);
	h.check(!!m, 'hidden');
	await a.evaluate(() => localStorage.removeItem('agents:cameraMarker'));
	m = await until(markerOf, (x) => x && x.visible, 'on: back', 4000);
	h.check(!!m, 'visible');

	// ---- V. headset ---------------------------------------------------------------------------------------
	console.log('\n=== V. in the headset ===');
	h.check(await iwer.installed(a), 'IWER owns navigator.xr');
	const st = await iwer.enter(a);
	h.check(st.presenting, `the IWER session presents (${JSON.stringify(st)})`);
	await iwer.pose(a, 'head', [2, 1.6, 2]);
	await iwer.frames(a, 8);
	await tool('update_objects', { updates: [{ uuid: lamp, position: [2, 1, -1] }] });
	await iwer.frames(a, 8);
	const xr = await until(
		() =>
			a.evaluate((id) => {
				let r, sc;
				window.__stores.globalRenderer.subscribe((v) => (r = v))();
				window.__stores.globalScene.subscribe((v) => (sc = v))();
				const T = window.__stores.THREE;
				let sprite = null;
				sc.traverse((o) => {
					if (o.userData?.agentMarker === id) sprite = o;
				});
				if (!sprite) return null;
				const cam = r.xr.getCamera();
				cam.updateMatrixWorld();
				const ndc = sprite.getWorldPosition(new T.Vector3()).project(cam.cameras?.[0] || cam);
				return { presenting: r.xr.isPresenting, layer: cam.layers.test(sprite.layers), visible: sprite.visible, ndc: [ndc.x, ndc.y, ndc.z], h: sprite.scale.y };
			}, B.id),
		(x) => x && x.presenting && x.visible,
		'the marker is in the XR scene',
		8000
	);
	h.check(xr && xr.layer, `the XR camera draws the helper layer it sits on (${JSON.stringify(xr)})`);
	h.check(xr && Math.abs(xr.ndc[0]) < 1 && Math.abs(xr.ndc[1]) < 1 && xr.ndc[2] < 1, `it stands in the view, over the sphere (ndc ${xr?.ndc?.map((v) => v.toFixed(2))})`);
	h.check(xr && xr.h > 0.1 && xr.h < 0.6, `readable size at ~3 m (${xr?.h?.toFixed(2)} m tall)`);
	await shot('vh3-V');
	// Play hides editor helpers: the editor camera (which the XR camera copies) loses the layer
	await a.evaluate(() => window.__stores.isLocked.set(true));
	await iwer.frames(a, 6);
	const inPlay = await a.evaluate(() => {
		let r;
		window.__stores.globalRenderer.subscribe((v) => (r = v))();
		return r.xr.getCamera().layers.isEnabled(30);
	});
	h.check(inPlay === false, `in Play the helper layer is off, so the marker is not drawn (layer 30 on: ${inPlay})`);
	await a.evaluate(() => window.__stores.isLocked.set(false));
	await iwer.frames(a, 4);

	// ---- X. leaves ----------------------------------------------------------------------------------------
	console.log('\n=== X. the agent leaves ===');
	const cost = await dbg();
	h.check(cost.draws < 30, `repaints only on a change of text (${cost.draws} draws over ${cost.ticks} checks, ${cost.taps} taps)`);
	await B.page.close();
	m = await until(markerOf, (x) => x === null, 'the marker leaves with the agent', 30000);
	h.check(m === null, 'gone');
	await browser.close();
});
