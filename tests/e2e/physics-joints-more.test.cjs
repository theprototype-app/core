// 102b rows 2 + 3: BALL, SLIDER, SPRING and ROPE joints (rapier's own spherical / prismatic / spring /
// rope) beside weld and hinge. Four bobs hang from four static blocks in one run, beside a free bob
// that falls to the ground (the counterfactual): the ball bob swings at a constant distance from its
// pivot, the slider bob drops straight down and stops at its 1 m limit, the spring bob sags a little
// and stays up, the rope bob falls slack until the rope is taut. A mid-run rope edit (the Inspector's
// Joints block, typed into) lowers the bob at once. Then the sync half: every field reaches the peer,
// an edit replicates and undoes in one step, a LATE JOINER gets them all, a kind from a newer build is
// skipped rather than welded, and a RELOAD brings the joints back (autosave had no joints at all
// before 102b — red on v1.70.0 for that reason as well as for every new kind).
const h = require('./helpers.cjs');

const jointsOf = (page) =>
	page.evaluate(() => new Promise((r) => window.__tp.test.v1.joints.sceneJoints.subscribe((j) => r(JSON.parse(JSON.stringify(j))))()));

/** reload ALONE (peers closed first, so nothing can come back from them) and restore the autosave
 * through restoreSnapshot (what the Restore button runs); long waits — a loaded slot boots slowly */
async function reloadAndRestore(peer, others) {
	for (const o of others) await o.ctx.close().catch(() => {});
	await peer.page.evaluate(() => window.__tp.test.v1.autosave.saveNow());
	await peer.page.waitForTimeout(2000);
	await peer.page.reload({ waitUntil: 'domcontentloaded', timeout: 120000 });
	await peer.page.waitForFunction(() => window.__tp?.test.v1 && !!window.__tp.test.v1.moduleSDK, null, { timeout: 180000 });
	await peer.page.waitForFunction(
		() => {
			let v;
			window.__tp.test.v1.autosave.restoreAvailable.subscribe((x) => (v = x))();
			return !!v;
		},
		null,
		{ timeout: 60000, polling: 250 }
	);
	await peer.page.evaluate(() => window.__tp.test.v1.autosave.restoreSnapshot());
}

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__tp.test.v1.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// four static blocks at y 6 and a bob for each, plus a free bob
	const ids = await A.page.evaluate(() => {
		const s = window.__tp.test.v1;
		const cmd = s.commandsHandler.sceneCommand;
		const out = {};
		const make = (name, size, pos, physics) => {
			cmd(`/create Box ${size} ${size} ${size}`);
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const o = g.children[g.children.length - 1];
			o.name = name;
			o.position.set(...pos);
			o.updateMatrixWorld(true);
			s.physics.setPhysicsFor(o.uuid, physics);
			out[name] = o.uuid;
			return o;
		};
		const fixed = { mode: 'static' };
		const bob = { mode: 'dynamic', mass: 1 };
		make('BallPost', 0.4, [-6, 6, 0], fixed);
		make('BallBob', 0.3, [-4.8, 6, 0], bob); // 1.2 m out to the side: it swings down
		make('SliderPost', 0.4, [-2, 6, 0], fixed);
		make('SliderBob', 0.3, [-2, 5, 0], bob);
		make('SpringPost', 0.4, [2, 6, 0], fixed);
		make('SpringBob', 0.3, [2, 4, 0], bob);
		make('RopePost', 0.4, [6, 6, 0], fixed);
		make('RopeBob', 0.3, [6, 5.5, 0], bob); // 0.5 m below, on a 1.5 m rope: slack
		make('FreeBob', 0.3, [10, 6, 0], bob);
		// sync moves so the peer holds the same poses (sceneCommand creates at the origin)
		const peer = (() => {
			let p;
			s.peers.subscribe((v) => (p = v))();
			return p;
		})();
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		for (const uuid of Object.values(out)) {
			const o = g.getObjectByProperty('uuid', uuid);
			peer?.send({ type: 'move', uuid, pos: o.position.toArray(), rot: [0, 0, 0], scale: [1, 1, 1] });
		}
		const J = s.joints;
		const ball = J.createJoint('ball', out.BallPost, out.BallBob, undefined, undefined, { anchor: [-6, 6, 0] });
		const slider = J.createJoint('slider', out.SliderPost, out.SliderBob, 'y', undefined, { limits: [-1, 0], contacts: false });
		const spring = J.createJoint('spring', out.SpringPost, out.SpringBob);
		const rope = J.createJoint('rope', out.RopePost, out.RopeBob, undefined, undefined, { length: 1.5 });
		return { ...out, ball: ball?.id, slider: slider?.id, spring: spring?.id, rope: rope?.id };
	});
	h.check(ids.ball && ids.slider && ids.spring && ids.rope, `four new joints made (${[ids.ball, ids.slider, ids.spring, ids.rope]})`);
	const defs = Object.fromEntries((await jointsOf(A.page)).map((d) => [d.id, d]));
	h.check(defs[ids.ball]?.kind === 'spherical' && defs[ids.slider]?.kind === 'prismatic', `ball / slider stored as rapier's kinds (${defs[ids.ball]?.kind}, ${defs[ids.slider]?.kind})`);
	h.check(JSON.stringify(defs[ids.slider]?.limits) === '[-1,0]' && defs[ids.slider]?.contacts === false, 'the slider keeps its limits in metres and contacts:false');
	h.check(Math.abs(defs[ids.spring]?.rest - 2) < 1e-6 && defs[ids.spring]?.stiffness === 50 && defs[ids.spring]?.damping === 2, `the spring rests at the distance it was made at (${JSON.stringify(defs[ids.spring])})`);
	h.check(defs[ids.rope]?.length === 1.5, 'the rope keeps its length');

	// the peer holds every field
	await h.eventually(
		() => jointsOf(B.page),
		(list) => {
			const m = Object.fromEntries(list.map((d) => [d.id, d]));
			return m[ids.rope]?.length === 1.5 && m[ids.spring]?.stiffness === 50 && JSON.stringify(m[ids.slider]?.limits) === '[-1,0]' && m[ids.ball]?.kind === 'spherical';
		},
		'every joint and field replicates to the peer',
		15000
	);

	const pos = (page, name) =>
		page.evaluate((uuid) => {
			let g;
			window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
			return g.getObjectByProperty('uuid', uuid)?.position.toArray() ?? null;
		}, ids[name]);
	const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);

	// ---- one run ---------------------------------------------------------------------------------
	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await h.eventually(() => A.page.evaluate(() => window.__tp.test.v1.physics.liveJointIds().length), (n) => n >= 4, 'the four joints are live', 15000);
	/** @type {number[]} */
	const ballDists = [];
	let ballLowest = 6;
	let springLowest = 6;
	for (let i = 0; i < 12; i++) {
		await A.page.waitForTimeout(150);
		const b = await pos(A.page, 'BallBob');
		ballDists.push(dist(b, [-6, 6, 0]));
		ballLowest = Math.min(ballLowest, b[1]);
		springLowest = Math.min(springLowest, (await pos(A.page, 'SpringBob'))[1]);
	}
	await A.page.waitForTimeout(1500);
	const free = await pos(A.page, 'FreeBob');
	const slider = await pos(A.page, 'SliderBob');
	const spring = await pos(A.page, 'SpringBob');
	const rope = await pos(A.page, 'RopeBob');
	h.check(free[1] < 0.5, `COUNTERFACTUAL: the free bob falls to the ground (y ${free[1].toFixed(2)})`);
	const dmin = Math.min(...ballDists);
	const dmax = Math.max(...ballDists);
	h.check(ballLowest < 5.4 && dmax - dmin < 0.08, `ball: the bob swings down at a constant 1.2 m from its pivot (lowest y ${ballLowest.toFixed(2)}, distance ${dmin.toFixed(3)}..${dmax.toFixed(3)})`);
	h.check(Math.abs(slider[1] - 4) < 0.08 && Math.abs(slider[0] + 2) < 0.02 && Math.abs(slider[2]) < 0.02, `slider: straight down, stopped at its 1 m limit (${slider.map((v) => v.toFixed(2))})`);
	h.check(spring[1] > 3.2 && spring[1] < 4.05 && springLowest > 3, `spring: sags under gravity and stays up (y ${spring[1].toFixed(2)}, lowest ${springLowest.toFixed(2)})`);
	h.check(Math.abs(rope[1] - 4.5) < 0.1, `rope: falls slack until the 1.5 m rope is taut (y ${rope[1].toFixed(2)})`);

	// mid-run edit through the Inspector's Joints block: a longer rope lowers the bob with no restart
	await A.page.evaluate((u) => window.__tp.test.v1.objectActions.selectObject(u, true), ids.RopeBob);
	await h.eventually(() => A.page.evaluate(() => document.querySelector('#physics-joints')?.dataset.count), (c) => c === '1', 'the Joints block lists the rope', 15000);
	const block = await A.page.evaluate(() => {
		const el = document.querySelector('#physics-joints .physics-joint');
		return { kind: el?.dataset.kind, text: el?.textContent.replace(/\s+/g, ' ').trim(), del: !!el?.querySelector('.physics-joint-delete[aria-label]') };
	});
	h.check(block.kind === 'rope' && /Rope/.test(block.text) && /RopePost/.test(block.text) && block.del, `it names the kind, both ends and a labelled delete (${JSON.stringify(block)})`);
	const gizmo = await A.page.evaluate(() => window.__tp.test.v1.jointHelpers.jointHelpersDebug());
	h.check(gizmo.joints === 1 && gizmo.segments >= 4 && gizmo.visible, `the selected rope draws its gizmo (${JSON.stringify(gizmo)})`);
	const lengthField = A.page.locator('#physics-joints .physics-joint[data-kind="rope"] input[type="text"]').first();
	await lengthField.click();
	await A.page.keyboard.press('Control+A');
	await A.page.keyboard.type('2.5');
	await A.page.keyboard.press('Tab');
	await h.eventually(() => jointsOf(A.page), (l) => l.find((d) => d.id === ids.rope)?.length === 2.5, 'typing 2.5 sets the rope length', 8000);
	await h.eventually(() => pos(A.page, 'RopeBob'), (p) => Math.abs(p[1] - 3.5) < 0.12, 'and the running world lowers the bob to the new length at once', 8000);
	await h.eventually(() => jointsOf(B.page), (l) => l.find((d) => d.id === ids.rope)?.length === 2.5, 'the edit replicates to the peer', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	await A.page.waitForTimeout(300);
	const gizmoOff = await A.page.evaluate(() => window.__tp.test.v1.jointHelpers.jointHelpersDebug());
	h.check(gizmoOff.joints === 0 && !gizmoOff.visible, `with nothing selected no gizmo is drawn (${JSON.stringify(gizmoOff)})`);
	// one undo puts the old length back, everywhere (the typing session was ONE step; before Stop,
	// which records its own entry)
	await A.page.evaluate(() => window.__tp.test.v1.history.undo());
	await h.eventually(() => jointsOf(B.page), (l) => l.find((d) => d.id === ids.rope)?.length === 1.5, 'one undo restores 1.5 m on the peer too', 10000);
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));

	// ---- the other ways in -----------------------------------------------------------------------
	const menu = await A.page.evaluate(([a, b]) => {
		const v = window.__tp.test.v1;
		v.objectActions.applySelectionSet([a, b]);
		const items = v.objectMenu.buildObjectMenuItems(a);
		const physics = v.objectMenu.findMenuItem(items, 'Physics');
		return physics ? physics.children.map((c) => c.label) : [];
	}, [ids.FreeBob, ids.SpringPost]);
	h.check(['Ball joint', 'Slider', 'Spring', 'Rope'].every((l) => menu.includes(l)), `the object menu offers the four new joints (${menu.join(' | ')})`);
	// the Inspector's Add joint with the two selected
	await h.eventually(() => A.page.evaluate(() => !!document.querySelector('#physics-joint-add')), (v) => v, 'Add joint shows for two selected objects', 10000);
	await A.page.evaluate(async () => {
		document.querySelector('#physics-joint-add').click();
		await new Promise((r) => setTimeout(r, 250));
		[...document.querySelectorAll('.ts-list .ts-opt')].find((o) => o.textContent.trim() === 'Spring')?.click();
	});
	await h.eventually(() => jointsOf(A.page), (l) => l.some((d) => d.kind === 'spring' && d.a === ids.FreeBob && d.b === ids.SpringPost), 'Add joint > Spring joins the two', 8000);
	await A.page.evaluate(() => window.__tp.test.v1.objectActions.deselectObject());
	// the agent tool
	const tool = await A.page.evaluate(
		([a, b]) => window.__tp.test.v1.aiTools.executeAiTool('create_joints', { joints: [{ kind: 'rope', a, b, length: 3 }, { kind: 'glue', a, b }] }, { physics: true }),
		[ids.BallPost, ids.FreeBob]
	);
	h.check(tool.joints?.[0]?.kind === 'rope' && tool.joints[0].length === 3 && /unknown joint kind/.test(tool.joints?.[1]?.error ?? ''), `create_joints makes a rope and names the kinds it knows (${JSON.stringify(tool).slice(0, 240)})`);

	// a kind from a NEWER build is skipped, not welded
	await A.page.evaluate(([a, b]) => window.__tp.test.v1.joints.applyJointCreate({ joint: { id: 'future1', kind: 'gear', a, b, anchorA: [0, 0, 0], anchorB: [0, 0, 0] } }), [ids.SpringPost, ids.SpringBob]);
	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await h.eventually(() => A.page.evaluate(() => window.__tp.test.v1.physics.liveJointIds()), (l) => l.length >= 5, 'premise: the run built the joints it knows', 15000);
	const live = await A.page.evaluate(() => window.__tp.test.v1.physics.liveJointIds());
	h.check(!live.includes('future1'), `an unknown kind gets no live joint (${live.length} live)`);
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));
	await A.page.evaluate(() => window.__tp.test.v1.joints.deleteJoint('future1'));

	// ---- a late joiner ---------------------------------------------------------------------------
	const C = await h.setupPage(browser, 'C');
	await h.connect(C, A);
	const expected = await jointsOf(A.page);
	await h.eventually(
		() => jointsOf(C.page),
		(l) => expected.every((e) => JSON.stringify(l.find((d) => d.id === e.id)) === JSON.stringify(e)),
		`a late joiner receives all ${expected.length} joints with every field`,
		20000
	);

	// ---- reload (LAST: a reload gives A a new peer id) -------------------------------------------
	await reloadAndRestore(A, [B, C]);
	await h.eventually(
		() => jointsOf(A.page).catch(() => []),
		(l) => expected.every((e) => JSON.stringify(l.find((d) => d.id === e.id)) === JSON.stringify(e)),
		`after a reload all ${expected.length} joints are back, field for field`,
		30000
	);
	await A.page.evaluate(() => window.__tp.test.v1.physics.toggleSimulation());
	await h.eventually(() => A.page.evaluate(() => window.__tp.test.v1.physics.liveJointIds().length), (n) => n === expected.length, 'and a run after the reload builds every one', 20000);
	await A.page.waitForTimeout(1500);
	const ropeAfter = await pos(A.page, 'RopeBob');
	h.check(Math.abs(ropeAfter[1] - 4.5) < 0.12, `the restored rope still holds its bob at 1.5 m (y ${ropeAfter[1].toFixed(2)})`);
	await A.page.evaluate(() => window.__tp.test.v1.physics.stopSimulation({ reset: true }));

	await h.finish(browser);
});
