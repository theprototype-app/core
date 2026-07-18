// Phase 40: lock visibility + request-control (approve hands over, deny refuses).
const h = require('./helpers.cjs');

const locks = (page) =>
	page.evaluate(
		() => new Promise((r) => window.__stores.lockedObjects.subscribe((l) => r(l.map((x) => [...x])))())
	);

const highlightCount = (page) =>
	page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					resolve(scene?.getObjectByName('lock-highlights')?.children.length ?? 0);
				})();
			})
	);

const toasts = (page) =>
	page.evaluate(
		() =>
			new Promise((r) =>
				window.__stores.toastStore.subscribe((t) =>
					r(t.map((x) => (typeof x === 'string' ? x : x.text)))
				)()
			)
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const B = await h.setupPage(browser, 'B');
	await h.connect(B, A);

	// A creates a box -> auto-selected -> A holds the lock
	const uuid = await A.page.evaluate(() => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		return new Promise((resolve) =>
			window.__stores.objectsGroup.subscribe((g) => resolve(g.children[g.children.length - 1].uuid))()
		);
	});
	await h.eventually(
		() => locks(B.page),
		(l) => l.some((x) => x[0] === A.id && x[1] === uuid),
		'B sees A holding the lock'
	);
	await h.eventually(
		() => highlightCount(B.page),
		(n) => n === 1,
		'B renders a lock highlight box'
	);
	h.check((await highlightCount(A.page)) === 0, 'A has no highlight for its own lock');

	// B requests control; A approves via the toast button
	await B.page.evaluate((uuid) => window.__stores.lockControl.requestControl(uuid), uuid);
	await h.eventually(
		() => toasts(A.page),
		(t) => t.some((x) => x.includes('asks to control')),
		'holder gets the request toast'
	);
	await A.page.getByRole('button', { name: 'Approve', exact: true }).click();
	await h.eventually(
		() => locks(A.page),
		(l) => l.some((x) => x[0] === B.id && x[1] === uuid) && !l.some((x) => x[0] === A.id),
		'approve hands the lock to B (visible on A)'
	);
	const bSelected = await B.page.evaluate(
		() => new Promise((r) => window.__stores.selectedObject.subscribe((s) => r(s?.uuid))())
	);
	h.check(bSelected === uuid, 'requester auto-selected the object');
	await h.eventually(
		() => highlightCount(A.page),
		(n) => n === 1,
		'A now sees the highlight (B holds it)'
	);

	// A requests it back; B denies
	await A.page.evaluate((uuid) => window.__stores.lockControl.requestControl(uuid), uuid);
	await h.eventually(
		() => toasts(B.page),
		(t) => t.some((x) => x.includes('asks to control')),
		'B gets the request toast'
	);
	await B.page.getByRole('button', { name: 'Deny', exact: true }).click();
	await h.eventually(
		() => toasts(A.page),
		(t) => t.some((x) => x.includes('denied')),
		'deny reaches the requester'
	);
	const stillB = await locks(A.page);
	h.check(stillB.some((x) => x[0] === B.id && x[1] === uuid), 'lock stays with B after deny');

	await h.finish(browser);
});
