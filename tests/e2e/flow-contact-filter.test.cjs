// 36 X6: On Impact / On Enter / On Exit gain a `filter` object input (fire only when
// the OTHER body is that object) and an `other` object output. Two balls drop — one on
// the ground, one on a Target box: the filtered node fires only for the Target hit
// (an unfiltered node on the ground ball is the counterfactual: it fires, other = '');
// the `other` output wired into a Distance node measures to the Target; a sensor's On
// Enter filtered to one of two balls fires for that ball only; and the other body rides
// the replicated stamp, so a PEER reads the same uuid.
const fs = require('fs');
const path = require('path');
const h = require('./helpers.cjs');

const EVIDENCE = process.env.EVIDENCE_DIR || path.join(process.env.HOME || '', '.code/lanes-30/after-36/36-colliders');

h.run(async () => {
	const browser = await h.launch();
	{
		const warm = await h.setupPage(browser, 'warm');
		await warm.page.evaluate(() => window.__stores.physics.warmup().catch(() => {}));
		await warm.page.waitForTimeout(4000);
		await warm.ctx.close();
	}
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	const ids = await A.page.evaluate(() => {
		const s = window.__stores;
		const cmd = s.commandsHandler.sceneCommand;
		cmd('/create Box 2 0.5 2');
		cmd('/create Sphere 0.2');
		cmd('/create Sphere 0.2');
		cmd('/create Box 2 0.6 2');
		cmd('/create Sphere 0.2');
		cmd('/create Sphere 0.2');
		let g;
		s.objectsGroup.subscribe((v) => (g = v))();
		const [target, ballA, ballB, zone, ballC, ballD] = g.children.slice(-6);
		const place = (o, x, y, z, physics) => {
			o.position.set(x, y, z);
			o.updateMatrixWorld(true);
			s.physics.setPhysicsFor(o.uuid, physics);
		};
		const dyn = { mode: 'dynamic', mass: 1, collider: 'sphere' };
		place(target, 0, 0.25, 0, { mode: 'static' });
		place(ballA, 5, 3, 0, dyn); // lands on the ground only
		place(ballB, 0, 3, 0, dyn); // lands on the Target
		place(zone, -6, 1.5, 0, { mode: 'static', sensor: true });
		place(ballC, -6.5, 4, 0, dyn); // both fall through the sensor
		place(ballD, -5.5, 4, 0, dyn);
		target.name = 'Target';
		window.__x6 = { target, ballA, ballB, zone, ballC, ballD };
		return { target: target.uuid, ballA: ballA.uuid, ballB: ballB.uuid, zone: zone.uuid, ballC: ballC.uuid, ballD: ballD.uuid };
	});

	/** the graph, built identically on a page (flowNodes.set does not broadcast, and the
	 * peer only needs the ids: the other body arrives with the stamp) @param {any} page */
	const buildGraph = (page) =>
		page.evaluate((u) => {
			const sel = (id, uuid, x, y) => ({ id, type: 'objectselector', position: { x, y }, data: { label: 'Object', selected: uuid } });
			const nodes = [
				{ id: 'imp1', type: 'onimpact', position: { x: 0, y: 0 }, data: { label: 'On Impact', pulse: 0.3, minStrength: 0.5 } },
				{ id: 'imp2', type: 'onimpact', position: { x: 0, y: 160 }, data: { label: 'On Impact', pulse: 0.3, minStrength: 0.5 } },
				{ id: 'imp3', type: 'onimpact', position: { x: 0, y: 320 }, data: { label: 'On Impact', pulse: 0.3, minStrength: 0.5 } },
				{ id: 'oe1', type: 'onenter', position: { x: 0, y: 480 }, data: { label: 'On Enter', pulse: 0.3 } },
				{ id: 'oe2', type: 'onenter', position: { x: 0, y: 640 }, data: { label: 'On Enter', pulse: 0.3 } },
				{ id: 'dist1', type: 'distance', position: { x: 520, y: 160 }, data: { label: 'Distance' } },
				sel('selA', u.ballA, 300, 0),
				sel('selB', u.ballB, 300, 160),
				sel('selA2', u.ballA, 300, 320),
				sel('selZ', u.zone, 300, 480),
				sel('selZ2', u.zone, 300, 640),
				sel('selT', u.target, -300, 80),
				sel('selD', u.ballD, -300, 560),
				sel('selB2', u.ballB, 300, 240)
			];
			const edges = [
				{ id: 'e-imp1-selA', source: 'imp1', target: 'selA' }, // On Impact of ballA ...
				{ id: 'e-selT-imp1.filter', source: 'selT', target: 'imp1', targetHandle: 'filter' }, // ... only with Target
				{ id: 'e-imp2-selB', source: 'imp2', target: 'selB' },
				{ id: 'e-selT-imp2.filter', source: 'selT', target: 'imp2', targetHandle: 'filter' },
				{ id: 'e-imp3-selA2', source: 'imp3', target: 'selA2' }, // the unfiltered counterfactual
				{ id: 'e-oe1-selZ', source: 'oe1', target: 'selZ' },
				{ id: 'e-selD-oe1.filter', source: 'selD', target: 'oe1', targetHandle: 'filter' },
				{ id: 'e-oe2-selZ2', source: 'oe2', target: 'selZ2' },
				{ id: 'e-imp2.other-dist1.a', source: 'imp2', sourceHandle: 'other', target: 'dist1', targetHandle: 'a' },
				{ id: 'e-selB2-dist1.b', source: 'selB2', target: 'dist1', targetHandle: 'b' }
			];
			window.__stores.flowNodes.set(nodes);
			window.__stores.flowEdges.set(edges);
		}, ids);
	await buildGraph(A.page);
	await buildGraph(B.page);
	await A.page.waitForTimeout(400);

	const typed = await A.page.evaluate(() => {
		const fs = window.__stores.flowSockets;
		return {
			filter: fs.inputType('onimpact', 'filter'),
			other: fs.outputHandleType('onimpact', 'other'),
			sensorFilter: fs.inputType('onenter', 'filter')
		};
	});
	h.check(typed.filter === 'object' && typed.sensorFilter === 'object', `filter is an OBJECT input (${JSON.stringify(typed)})`);
	h.check(typed.other === 'object', `other is an OBJECT output (${typed.other})`);

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.eventually(
		() => A.page.evaluate(() => {
			const { ballA, ballB, ballC, ballD } = window.__x6;
			return [ballA.position.y, ballB.position.y, ballC.position.y, ballD.position.y];
		}),
		(ys) => ys[0] < 0.4 && ys[1] < 0.9 && ys[1] > 0.5 && ys[2] < 0.4 && ys[3] < 0.4,
		'premise: ballA on the ground, ballB on the Target, ballC and ballD through the sensor',
		20000
	);
	await A.page.waitForTimeout(500);

	const read = (page) =>
		page.evaluate(() => {
			let t;
			window.__stores.flowTriggers.subscribe((v) => (t = v))();
			const fr = window.__stores.flowRuntime;
			const stamp = (id) => t[id]?.lastT ?? null;
			return {
				imp1: stamp('imp1'),
				imp2: stamp('imp2'),
				imp3: stamp('imp3'),
				oe1: stamp('oe1'),
				oe2: stamp('oe2'),
				other2: fr.contactOtherOf('imp2'),
				other3: fr.contactOtherOf('imp3'),
				otherE1: fr.contactOtherOf('oe1')
			};
		});
	const a = await read(A.page);
	h.check(a.imp1 === null, `a filtered On Impact does NOT fire for a ground landing (${a.imp1})`);
	h.check(a.imp3 !== null && a.other3 === '', `COUNTERFACTUAL: the unfiltered one fires, other = '' (the ground) (${a.imp3}, "${a.other3}")`);
	h.check(a.imp2 !== null && a.other2 === ids.target, `the filtered On Impact fires for the Target hit, other = Target (${a.other2 === ids.target})`);
	h.check(a.oe2 !== null, 'COUNTERFACTUAL: an unfiltered On Enter fires for the balls');
	h.check(a.oe1 !== null && a.otherE1 === ids.ballD, `the filtered On Enter fires for ballD only (other = ${a.otherE1 === ids.ballD ? 'ballD' : a.otherE1})`);

	const dist = await A.page.evaluate(() => {
		let v;
		window.__stores.flowValues.subscribe((x) => (v = x))();
		return v.dist1;
	});
	h.check(typeof dist === 'number' && dist > 0.2 && dist < 1, `the other output wired into Distance measures ballB to the Target (${dist})`);

	await h.eventually(
		() => read(B.page),
		(b) => b.other2 === ids.target && b.other3 === '' && b.otherE1 === ids.ballD,
		'the peer reads the same other bodies from the replicated stamps'
	);

	// evidence: the contact cards in the node editor
	try {
		fs.mkdirSync(EVIDENCE, { recursive: true });
		await A.page.evaluate(() => {
			window.__stores.objectActions.deselectObject(); // the editor follows the selection
			window.__stores.flowGraphClose?.set?.(false);
		});
		await A.page.waitForTimeout(1500);
		await A.page.screenshot({ path: path.join(EVIDENCE, '04-contact-filter-nodes.png') });
	} catch (e) {
		console.log('screenshot skipped: ' + e.message);
	}

	await A.page.evaluate(() => window.__stores.physics.toggleSimulation());
	await h.finish(browser);
});
