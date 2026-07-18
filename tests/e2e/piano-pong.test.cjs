// Phase 34: piano notes replicate; pong claim/paddle/ball/score sync; spawn-remove toggles.
const h = require('./helpers.cjs');

const clickMenu = (page, label) =>
	page.evaluate(
		(label) =>
			new Promise((resolve) => {
				window.__stores.moduleSDK.moduleMenuItems.subscribe((items) => {
					items.find((i) => i.label === label)?.action();
					resolve();
				})();
			}),
		label
	);

const groupData = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const group = scene?.getObjectByName(name);
					resolve(group ? JSON.parse(JSON.stringify(group.userData ?? {})) : null);
				})();
			}),
		name
	);

const objectPos = (page, name) =>
	page.evaluate(
		(name) =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const object = scene?.getObjectByName(name);
					resolve(object ? object.position.toArray() : null);
				})();
			}),
		name
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// ---- piano ----
	await clickMenu(A.page, 'Piano: spawn / remove');
	await h.eventually(() => groupData(A.page, 'piano-module'), (d) => d !== null, 'piano spawned on A');
	await h.eventually(() => groupData(B.page, 'piano-module'), (d) => d !== null, 'piano replicated to B');

	// front edge of a white key (black keys sit further back)
	const keyPixel = await h.projectPoint(A.page, [-1 + 2 * 0.24, 0.93, -2.5 + 0.35]);
	await A.page.mouse.click(keyPixel.x, keyPixel.y);
	await h.eventually(
		() => groupData(A.page, 'piano-module'),
		(d) => d?.lastNote?.midi != null,
		'key press registered on A'
	);
	const played = (await groupData(A.page, 'piano-module')).lastNote.midi;
	await h.eventually(
		() => groupData(B.page, 'piano-module'),
		(d) => d?.lastNote?.midi === played,
		`note replicated to B (midi ${played})`
	);

	// ---- pong ----
	await clickMenu(A.page, 'Pong: spawn / remove');
	await h.eventually(() => groupData(A.page, 'pong-module'), (d) => d !== null, 'pong spawned on A');
	await h.eventually(() => groupData(B.page, 'pong-module'), (d) => d !== null, 'pong replicated to B');

	const paddlePixel = await h.projectPoint(B.page, await objectPos(B.page, 'pong-paddle-right'));
	await B.page.mouse.click(paddlePixel.x, paddlePixel.y);
	await h.eventually(
		() => groupData(A.page, 'pong-module'),
		(d) => d?.paddles?.right === B.id,
		'B claimed the right paddle (visible on A)'
	);

	const target = await h.projectPoint(B.page, [2.8, 0.9, 1.2]);
	for (let i = 0; i < 6; i++) {
		await B.page.mouse.move(target.x + i, target.y);
		await B.page.waitForTimeout(120);
	}
	await h.eventually(
		() => objectPos(A.page, 'pong-paddle-right'),
		(p) => p && p[2] > 0.5,
		'B moving the mouse moves their paddle on A'
	);

	const b1 = await objectPos(B.page, 'pong-ball');
	await B.page.waitForTimeout(600);
	const b2 = await objectPos(B.page, 'pong-ball');
	h.check(b1 && b2 && (b1[0] !== b2[0] || b1[2] !== b2[2]), 'ball moves on B');

	await h.eventually(
		() => groupData(A.page, 'pong-module'),
		(d) => d && (d.score[0] > 0 || d.score[1] > 0),
		'a point was scored on A',
		45000
	);
	const aScore = (await groupData(A.page, 'pong-module')).score;
	await h.eventually(
		() => groupData(B.page, 'pong-module'),
		(d) => d && d.score[0] + d.score[1] >= aScore[0] + aScore[1] - 1 && d.score[0] + d.score[1] > 0,
		'score replicated to B'
	);

	await clickMenu(A.page, 'Pong: spawn / remove');
	await h.eventually(() => groupData(A.page, 'pong-module'), (d) => d === null, 'pong removed on A');
	await h.eventually(() => groupData(B.page, 'pong-module'), (d) => d === null, 'pong removal replicated to B');

	await h.finish(browser);
});
