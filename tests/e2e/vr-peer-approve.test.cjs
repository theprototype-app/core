// Phase 211: VR peer approve/deny. A pending connection request, while the local
// user is presenting, pops a controller-anchored follower panel (vr-approve-panel
// with vrapprove-yes / vrapprove-no meshes). Approve routes through the shared
// approvePeer path (whitelist + connect back); Deny drops the request. Desktop
// keeps this card closed (the Toasts approval card handles it there). On-device
// ray+trigger feel is the user's manual check.
const h = require('./helpers.cjs');

const read = (A, path) =>
	A.page.evaluate((p) => {
		let v;
		const store = p.split('.').reduce((o, k) => o[k], window.__stores);
		store.subscribe((x) => (v = x))();
		return v;
	}, path);

const panelMeshes = (A) =>
	A.page.evaluate(
		() =>
			new Promise((resolve) => {
				window.__stores.globalScene.subscribe((scene) => {
					const panel = scene?.getObjectByName('vr-approve-panel');
					const names = [];
					panel?.traverse((o) => {
						if (o.name?.startsWith('vrapprove-')) names.push(o.name);
					});
					resolve({ present: !!panel, names });
				})();
			})
	);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// raycast is gated: nothing to hit before a request arrives
	const gatedClosed = await A.page.evaluate(() => window.__stores.vrControls.raycastApprove(0));
	h.check(gatedClosed === null, 'raycastApprove is null with no pending request');

	// enter VR + fake a pending connection request
	await A.page.evaluate(() => {
		window.__stores.isVRMode.set(true);
		window.__stores.pendingApprovals.set([{ peerId: 'peer-alpha-0001' }]);
	});
	await A.page.waitForTimeout(350);

	h.check((await read(A, 'vrApprovePanelOpen')) === true, 'panel gate opens for a pending request in VR');
	const meshes = await panelMeshes(A);
	h.check(
		meshes.present && meshes.names.includes('vrapprove-yes') && meshes.names.includes('vrapprove-no'),
		`approval card renders with Approve + Deny meshes (${meshes.names.join(',')})`
	);

	// two queued: Deny drops the FIRST, the next request stays
	await A.page.evaluate(() =>
		window.__stores.pendingApprovals.set([{ peerId: 'peer-alpha-0001' }, { peerId: 'peer-beta-0002' }])
	);
	await A.page.waitForTimeout(150);
	const afterDeny = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('approve:no'); // denies the first
		let v;
		window.__stores.pendingApprovals.subscribe((x) => (v = x))();
		return v.map((p) => p.peerId);
	});
	h.check(
		afterDeny.length === 1 && afterDeny[0] === 'peer-beta-0002',
		`Deny drops the first request, the next queues (${afterDeny.join(',')})`
	);

	// Approve whitelists the remaining peer and clears the queue
	const afterApprove = await A.page.evaluate(() => {
		window.__stores.vrControls.executeVRMenuAction('approve:yes');
		let pend;
		window.__stores.pendingApprovals.subscribe((x) => (pend = x))();
		let users;
		window.__stores.userdata.subscribe((x) => (users = x))();
		return { pending: pend.map((p) => p.peerId), whitelisted: users.some((u) => u[0] === 'peer-beta-0002') };
	});
	h.check(
		afterApprove.pending.length === 0 && afterApprove.whitelisted,
		'Approve whitelists the peer and clears the queue'
	);

	// with nothing pending the card leaves the scene
	await A.page.waitForTimeout(300);
	h.check((await read(A, 'vrApprovePanelOpen')) === false, 'panel closes once no requests remain');
	h.check(!(await panelMeshes(A)).present, 'the approval card leaves the scene when empty');

	// desktop keeps the VR card closed even with a pending request
	await A.page.evaluate(() => {
		window.__stores.isVRMode.set(false);
		window.__stores.pendingApprovals.set([{ peerId: 'peer-gamma-0003' }]);
	});
	await A.page.waitForTimeout(250);
	h.check((await read(A, 'vrApprovePanelOpen')) === false, 'desktop keeps the VR card closed (Toasts handles it there)');

	await A.page.evaluate(() => window.__stores.pendingApprovals.set([]));
	await h.finish(browser);
});
