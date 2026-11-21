// 102 M7 — constraints + IK end to end, two peers:
//   0. feature unused = zero change: a scene with no constraints is never touched (no owners, no
//      bases, poses identical after a few seconds);
//   1. a two-bone IK arm (Upper > Lower > Hand groups) reaches a target on BOTH peers from the one
//      replicated `constraints` parameter, and the hand follows a moving target (A streams moves,
//      each peer solves locally — no per-frame bone traffic);
//   2. the weight keyed 0 -> 1 on the Timeline (first key through the Inspector's key button),
//      scrubbed on both peers: the hand moves from rest to the target and the peers agree;
//   3. a save carries the AUTHORED pose (parked) and the list; a GLTF export bakes the IK pose only
//      when "Bake constraints" is asked for;
//   4. two-peer + reload: B reloads, rejoins and solves the same pose again;
//   5. a file saved by this lane opens in the newest release (production) unchanged, and a
//      scene saved by that release opens here unchanged (PROD_URL, default theprototype.pages.dev).
const h = require('./helpers.cjs');

const PROD_URL = process.env.CONSTRAINTS_PROD_URL || 'https://theprototype.pages.dev/';
const TOL = 0.01;

/** in-page helpers (installed after every reload) */
async function install(page) {
	await page.evaluate(() => {
		const t = /** @type {any} */ (window).__tp?.test?.v1 ?? /** @type {any} */ (window).__stores;
		const get = (s) => new Promise((r) => s.subscribe(r)());
		/** @type {any} */ (window).__ik = {
			t,
			get,
			group: () => get(t.objectsGroup),
			async byName(name) {
				const g = await get(t.objectsGroup);
				return g.getObjectByName(name);
			},
			async world(name) {
				const g = await get(t.objectsGroup);
				const o = g.getObjectByName(name);
				if (!o) return null;
				o.updateWorldMatrix(true, false);
				const e = o.matrixWorld.elements;
				return [e[12], e[13], e[14]];
			},
			async quat(name) {
				const g = await get(t.objectsGroup);
				const o = g.getObjectByName(name);
				return o ? o.quaternion.toArray() : null;
			}
		};
	});
}

/** freshReload with a slow-boot grace: its own wait is 30 s, and a remote slot or a loaded Deck boots the dev app slower */
async function reload(peer) {
	try {
		await h.freshReload(peer);
	} catch (e) {
		if (!/Timeout/.test(String(e?.message ?? e))) throw e;
		console.log('  (slow boot: waiting up to 150 s more for the debug hook)');
		await peer.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 150000 });
	}
}

const dist = (a, b) => (a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : Infinity);
const world = (peer, name) => peer.page.evaluate((n) => window.__ik.world(n), name);

/** A builds the arm + target through replicated commands, returns the uuids */
async function buildArm(A) {
	return A.page.evaluate(async () => {
		const { t, get, byName } = window.__ik;
		const cmd = t.commandsHandler.sceneCommand;
		const peer = await get(t.peers);
		const place = async (name, pos) => {
			cmd('/group ' + name);
			const o = await byName(name + ' Group');
			o.position.set(pos[0], pos[1], pos[2]);
			o.updateMatrixWorld(true);
			peer.send({ type: 'move', uuid: o.uuid, pos, rot: [0, 0, 0], scale: [1, 1, 1] });
			return o.uuid;
		};
		const upper = await place('Upper', [0, 1, 0]);
		const lower = await place('Lower', [1, 1, 0]);
		const hand = await place('Hand', [2, 1, 0]);
		const target = await place('Target', [1.2, 2.2, 0]);
		t.objectActions.moveObjectToGroup(lower, upper);
		t.objectActions.moveObjectToGroup(hand, lower);
		t.objectActions.applySelectionSet?.([]);
		return { upper, lower, hand, target };
	});
}

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	// collapse the dev-server dual module instance before connecting (physics-kinematic's note)
	for (const peer of [A, B]) {
		await reload(peer);
		await h.answerRestore(peer).catch(() => {});
		await install(peer.page);
	}
	await h.connect(B, A);

	const ids = await buildArm(A);
	await h.eventually(() => world(B, 'Hand Group'), (p) => dist(p, [2, 1, 0]) < 1e-3, 'B holds the arm at rest');

	// --- 0. feature unused = zero change -----------------------------------------------------------
	await A.page.waitForTimeout(2500);
	const idle = await A.page.evaluate(async () => {
		const { t, quat, world } = window.__ik;
		return { state: t.constraints.constraintRuntimeState(), hand: await world('Hand Group'), q: await quat('Upper Group') };
	});
	h.check(idle.state.owners.length === 0 && idle.state.bases === 0, `no constraints: the runtime owns nothing (${JSON.stringify(idle.state)})`);
	h.check(dist(idle.hand, [2, 1, 0]) < 1e-6 && idle.q[3] === 1, 'no constraints: poses untouched');

	// --- 1. two-bone IK on both peers; the hand follows a moving target ----------------------------
	const cid = await A.page.evaluate(
		({ upper, target }) => window.__ik.t.constraintEdit.addConstraint(upper, 'ik2', { bone: 'Hand Group', target: { uuid: target } })?.id,
		ids
	);
	h.check(typeof cid === 'string', `two-bone IK added (${cid})`);
	for (const [label, peer] of [['A', A], ['B', B]])
		await h.eventually(() => world(peer, 'Hand Group'), (p) => dist(p, [1.2, 2.2, 0]) < TOL, `${label}: the hand reaches the target`, 15000);

	let worstA = 0;
	for (let i = 1; i <= 12; i++) {
		const pos = [1.2 - i * 0.05, 2.2 - i * 0.04, i * 0.05];
		await A.page.evaluate(
			async ({ uuid, pos }) => {
				const { t, get, group } = window.__ik;
				const o = (await group()).getObjectByProperty('uuid', uuid);
				o.position.set(pos[0], pos[1], pos[2]);
				(await get(t.peers)).send({ type: 'move', uuid, pos, rot: [0, 0, 0], scale: [1, 1, 1] });
			},
			{ uuid: ids.target, pos }
		);
		// three frames (headless runs at a few fps: a fixed wait can land before the next tick)
		await A.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))));
		worstA = Math.max(worstA, dist(await world(A, 'Hand Group'), await world(A, 'Target Group')));
	}
	h.check(worstA < 0.03, `A: the hand follows the moving target (worst ${worstA.toFixed(4)} m)`);
	const last = await world(A, 'Target Group');
	await h.eventually(() => world(B, 'Hand Group'), (p) => dist(p, last) < TOL, 'B: the hand ends on the moved target');
	const handA = await world(A, 'Hand Group');
	const handB = await world(B, 'Hand Group');
	h.check(dist(handA, handB) < TOL, `the peers agree on the hand (${dist(handA, handB).toFixed(5)} m)`);
	const traffic = await B.page.evaluate(() => window.__ik.t.constraints.constraintRuntimeState());
	h.check(traffic.owners.length === 1, `B evaluates locally (owners ${traffic.owners.length})`);

	// --- 2. weight keyed 0 -> 1 on the Timeline -----------------------------------------------------
	await A.page.evaluate(({ upper }) => window.__ik.t.objectActions.selectObject(upper, true), ids);
	await A.page.evaluate(({ upper, cid }) => window.__ik.t.constraintEdit.updateConstraint(upper, cid, { weight: 0 }), { ...ids, cid });
	const keyBtn = A.page.locator(`[data-constraint="${cid}"] [data-constraint-key]`);
	await keyBtn.waitFor({ state: 'visible', timeout: 30000 });
	h.check((await A.page.locator('#constraints-section').count()) === 1, 'Inspector shows the Constraints section');
	await keyBtn.click();
	const readTrack = () =>
			A.page.evaluate(async ({ upper, cid }) => {
				const { t, get } = window.__ik;
				const id = await get(t.sequences.activeSequence);
				const s = id ? (await get(t.sequences.sequences))[id] : null;
				const tr = s?.tracks?.find((x) => x.kind === 'prop' && x.target === upper && x.path === `constraint.${cid}.weight`);
				return tr ? { id, keys: tr.keys } : null;
			}, { ...ids, cid });
	await h.eventually(readTrack, (v) => v && v.keys.length === 1 && v.keys[0].v === 0, 'the key button made a weight track with a key at 0');
	const seq = await readTrack();
	if (!seq) throw new Error('no weight track');
	// the second key: weight 1 at t = 1 (the sequence write path the track editor uses)
	await A.page.evaluate(
		async ({ seqId, upper, cid }) => {
			const { t, get } = window.__ik;
			const s = (await get(t.sequences.sequences))[seqId];
			const tracks = s.tracks.map((x) => (x.kind === 'prop' && x.target === upper && x.path === `constraint.${cid}.weight` ? { ...x, keys: [...x.keys, { t: 1, v: 1 }] } : x));
			t.sequences.setSequence(seqId, { tracks, duration: Math.max(2, s.duration) });
		},
		{ seqId: seq.id, ...ids, cid }
	);
	await h.eventually(
		() => B.page.evaluate(async (id) => (await window.__ik.get(window.__ik.t.sequences.sequences))[id]?.tracks?.[0]?.keys?.length ?? 0, seq.id),
		(n) => n === 2,
		'B received the keyed track'
	);
	const scrubAt = async (peer, at) => {
		await peer.page.evaluate(({ id, at }) => window.__ik.t.sequencePlayer.scrubSequence(id, at), { id: seq.id, at });
		await peer.page.waitForTimeout(250);
		return world(peer, 'Hand Group');
	};
	const restA = await scrubAt(A, 0);
	const midA = await scrubAt(A, 0.5);
	const fullA = await scrubAt(A, 1);
	const tgt = await world(A, 'Target Group');
	h.check(dist(restA, [2, 1, 0]) < TOL, `weight 0 at t=0: the arm at rest (${restA.map((v) => v.toFixed(3))})`);
	h.check(dist(midA, [2, 1, 0]) > 0.05 && dist(midA, tgt) > 0.05, 'weight 0.5 at t=0.5: between rest and target');
	h.check(dist(fullA, tgt) < TOL, 'weight 1 at t=1: on the target');
	const midB = await scrubAt(B, 0.5);
	h.check(dist(midA, midB) < TOL, `t=0.5 on B matches A (${dist(midA, midB).toFixed(5)} m)`);
	for (const peer of [A, B]) await peer.page.evaluate(() => window.__ik.t.sequencePlayer.releaseScrub());
	await A.page.evaluate(({ upper, cid }) => window.__ik.t.constraintEdit.updateConstraint(upper, cid, { weight: 1 }), { ...ids, cid });
	for (const [label, peer] of [['A', A], ['B', B]])
		await h.eventually(() => world(peer, 'Hand Group'), (p) => dist(p, tgt) < TOL, `weight back to 1 on ${label}`);

	// --- 3. saves park, GLTF bakes only when asked --------------------------------------------------
	const saved = await A.page.evaluate(async () => {
		const { t, quat } = window.__ik;
		// Lower carries the elbow bend (Upper can sit near its rest when the elbow already lies 1 m from the target)
		const live = await quat('Lower Group');
		const payload = t.sessions.buildSessionPayload('ik-proof');
		const after = await quat('Lower Group');
		const json = JSON.stringify(payload);
		return { live, after, json, hasList: json.includes('"constraints"') && json.includes('"ik2"') };
	});
	h.check(saved.live[3] < 0.999 && Math.abs(saved.after[3] - saved.live[3]) < 1e-9, `the live pose is posed before and after a save (${saved.live.map((v) => v.toFixed(3))} / ${saved.after.map((v) => v.toFixed(3))})`);
	h.check(saved.hasList, 'the save carries the constraint list');
	const exportRot = async (bake) =>
		A.page.evaluate(
			async ({ upper, bake }) => {
				const { t, group } = window.__ik;
				const root = (await group()).getObjectByProperty('uuid', upper);
				const bytes = await t.fileHandler.gltfBytesFor([root], { binary: false, bakeConstraints: bake });
				const doc = JSON.parse(new TextDecoder().decode(bytes));
				// GLTFExporter writes a node MATRIX (trs off): the largest off-identity of the 3x3 part, over the arm
				let turn = 0;
				for (const n of doc.nodes.filter((n) => /^(Upper|Lower|Hand) Group$/.test(n.name))) {
					const m = n.matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
					turn = Math.max(turn, Math.abs(m[0] - 1), Math.abs(m[5] - 1), Math.abs(m[10] - 1), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[4]), Math.abs(m[6]), Math.abs(m[8]), Math.abs(m[9]));
				}
				return { turn, nodes: doc.nodes.length };
			},
			{ ...ids, bake }
		);
	const plainR = await exportRot(false);
	const bakedR = await exportRot(true);
	h.check(plainR.turn < 1e-6, `GLTF without Bake constraints carries the authored pose (turn ${plainR.turn.toFixed(4)})`);
	h.check(bakedR.turn > 0.05, `GLTF with Bake constraints carries the IK pose (turn ${bakedR.turn.toFixed(4)})`);

	// --- 4. two-peer + reload --------------------------------------------------------------------
	await reload(B);
	await h.eventually(
		() => B.page.evaluate(() => new Promise((r) => window.__tp.test.v1.peers.subscribe((p) => r(p?.openedPeers?.size ?? 0))())),
		(n) => n >= 1,
		'B rejoined after the reload',
		60000
	);
	await install(B.page);
	const tgtNow = await world(A, 'Target Group');
	await h.eventually(() => world(B, 'Hand Group'), (p) => dist(p, tgtNow) < TOL, 'after the reload B solves the same pose', 30000);
	const list = await B.page.evaluate(async () => (await window.__ik.byName('Upper Group'))?.userData?.constraints?.length ?? 0);
	h.check(list === 1, 'after the reload B holds the list');
	await h.closePeer(B);

	// --- 5. across releases (production = the newest release) -----------------------------------
	if (PROD_URL === 'off') {
		console.log('  SKIP section 5 (CONSTRAINTS_PROD_URL=off)');
		return h.finish(browser);
	}
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const P = await ctx.newPage();
	const prodErrors = [];
	P.on('pageerror', (e) => prodErrors.push(String(e)));
	await P.addInitScript(() => {
		try {
			localStorage.setItem('debugStores', 'true');
		} catch {}
	});
	await P.goto(PROD_URL, { waitUntil: 'load', timeout: 120000 });
	await P.waitForFunction(() => !!window.__stores?.sessions?.applySession, null, { timeout: 120000 });
	const version = await P.evaluate(() => fetch('/version.json').then((r) => r.json()).then((j) => j.version).catch(() => '?'));
	// a scene saved by that release (built first, in its own empty scene) — opened here further down
	const oldJson = await P.evaluate(async () => {
		const s = window.__stores;
		s.commandsHandler.sceneCommand('/create Box 1 1 1');
		s.commandsHandler.sceneCommand('/group Old');
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const box = g.children.find((c) => c.isMesh);
		const old = g.getObjectByName('Old Group');
		box.position.set(0.5, 0.7, -0.3);
		box.rotation.set(0.2, 0.4, 0.1);
		old.position.set(-1, 2, 3);
		old.rotation.set(0, 1, 0);
		return JSON.stringify(s.sessions.buildSessionPayload('old-scene'));
	});
	const opened = await P.evaluate(async (json) => {
		const s = window.__stores;
		await s.sessions.applySession(JSON.parse(json), { backup: false, replicate: false });
		await new Promise((r) => setTimeout(r, 1500));
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const up = g.getObjectByName('Upper Group');
		const hand = g.getObjectByName('Hand Group');
		hand?.updateWorldMatrix(true, false);
		const e = hand?.matrixWorld.elements ?? [];
		return { list: up?.userData?.constraints?.length ?? 0, q: up?.quaternion.toArray(), hand: [e[12], e[13], e[14]] };
	}, saved.json);
	h.check(opened.list === 1 && Math.abs(opened.q[3] - 1) < 1e-6 && dist(opened.hand, [2, 1, 0]) < 1e-4, `a lane file opens in ${version}: list kept, authored pose (${JSON.stringify(opened)})`);
	h.check(prodErrors.length === 0, `no page errors on ${version} (${prodErrors.slice(0, 2).join(' | ')})`);
	await ctx.close();
	const here = await A.page.evaluate(async (json) => {
		const { t, group } = window.__ik;
		const payload = JSON.parse(json);
		await t.sessions.applySession(payload, { backup: false, replicate: false });
		await new Promise((r) => setTimeout(r, 2500));
		const g = await group();
		const mats = {};
		g.traverse((o) => {
			if (o !== g && o.name && (o.isMesh || o.type === 'Group')) mats[o.name] = o.matrix.elements.map((v) => +v.toFixed(6));
		});
		return { mats, state: t.constraints.constraintRuntimeState() };
	}, oldJson);
	h.check(Object.keys(here.mats).length >= 2, `the ${version} scene opened here (${Object.keys(here.mats).join(', ')})`);
	const old = here.mats['Old Group'];
	h.check(old && Math.abs(old[12] + 1) < 1e-5 && Math.abs(old[13] - 2) < 1e-5 && Math.abs(old[14] - 3) < 1e-5, 'its group pose unchanged');
	h.check(here.state.owners.length === 0 && here.state.bases === 0, `and nothing in it is constrained (${JSON.stringify(here.state)})`);

	h.check(h.pageErrors(A).length === 0, `no page errors on A (${h.pageErrors(A).slice(0, 2).join(' | ')})`);
	await h.finish(browser);
});
