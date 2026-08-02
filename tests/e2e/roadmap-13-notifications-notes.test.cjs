// Roadmap #13 Batch E — notification center + scene-notes drawer.
//   E1  every toast lands in the notification history + bumps the unread badge;
//       opening the panel clears the badge and lists entries; Clear empties it;
//       connection-request toasts render in the CRITICAL container (above modals)
//       while info toasts render in the REGULAR container (below modals).
//   E2  the notes drawer lists every annotation and can be toggled.
const h = require('./helpers.cjs');

const notifCount = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.notifications.subscribe((n) => r(n.length))()));
const unread = (peer) =>
	peer.page.evaluate(() => new Promise((r) => window.__stores.notificationsUnread.subscribe((n) => r(n))()));

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// start from a clean history
	await A.page.evaluate(() => {
		window.__stores.notifications.set([]);
		window.__stores.notificationsUnread.set(0);
	});

	// --- E1: toasts feed history + unread ------------------------------------
	await A.page.evaluate(() => {
		window.__stores.showToast('First message');
		window.__stores.showToast('Second message');
	});
	await A.page.waitForTimeout(200);
	h.check((await notifCount(A)) === 2, 'E1: toasts append to the notification history');
	h.check((await unread(A)) === 2, 'E1: unread badge counts new notifications');

	// --- E1: opening the panel clears the badge + lists entries --------------
	await A.page.locator('#notif-bell').click({ force: true });
	await A.page.waitForTimeout(300);
	h.check(await A.page.locator('#notif-panel').first().isVisible(), 'E1: bell opens the notification panel');
	h.check((await unread(A)) === 0, 'E1: opening the panel clears the unread badge');
	h.check(await A.page.locator('#notif-panel', { hasText: 'Second message' }).first().isVisible(), 'E1: panel lists the notifications');

	// --- E1: clear all --------------------------------------------------------
	await A.page.locator('#notif-panel button', { hasText: 'Clear all' }).click();
	await A.page.waitForTimeout(200);
	h.check((await notifCount(A)) === 0, 'E1: Clear all empties the history');
	await A.page.evaluate(() => window.__stores.notificationCenterOpen.set(false));

	// --- E1: z-tier split — approvals critical, info regular -----------------
	const containers = await A.page.evaluate(() => ({
		critical: !!document.querySelector('.toasts-critical'),
		regular: !!document.querySelector('.toasts-regular')
	}));
	h.check(containers.critical && containers.regular, 'E1: separate critical + regular toast containers exist');

	await A.page.evaluate(() => {
		const cur = [];
		window.__stores.pendingApprovals.set([{ peerId: 'peer-xyz', status: 'new' }]);
		void cur;
	});
	await A.page.waitForTimeout(300);
	const approvalInCritical = await A.page.evaluate(() => {
		const c = document.querySelector('.toasts-critical');
		// 15-P: the card reads "Connection request <PEERID>" — it never said
		// "from peer", so this assertion was stale and failing before the rework
		return !!c && /Connection request/.test(c.textContent || '');
	});
	h.check(approvalInCritical, 'E1: connection-request toast renders in the critical (above-modals) container');
	await A.page.evaluate(() => window.__stores.pendingApprovals.set([]));

	// --- E2: notes drawer lists annotations ----------------------------------
	await A.page.evaluate(async () => {
		window.__stores.commandsHandler.sceneCommand('/create box');
		const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
		const box = g.children[g.children.length - 1];
		const ah = window.__stores.annotationsHandler;
		ah.addAnnotation(box.uuid);
		let active; ah.activeAnnotation.subscribe((v) => (active = v))();
		if (active?.draft) { active.draft.text = 'Fix this face'; ah.setAnnotation(active.draft); }
		ah.activeAnnotation.set(null);
		window.__stores.notesDrawerOpen.set(true);
	});
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#notes-drawer').first().isVisible(), 'E2: notes drawer opens');
	h.check(await A.page.locator('#notes-drawer', { hasText: 'Fix this face' }).first().isVisible(), 'E2: drawer lists the annotation');

	await h.finish(browser);
});
