// Phase 129: avatar v2 — resolveAvatar defaults + per-shape hat anchor
// (pure), and the rig renders a photo as a camera-facing card (no sphere),
// the label above the head with a toggle, and the chosen head shape. Visual
// polish is the user's manual check.
const h = require('./helpers.cjs');

// 1x1 png
const PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// --- pure model ---
	const model = await A.page.evaluate(() => {
		const m = window.__stores.avatarModel;
		const d = m.resolveAvatar(null);
		return {
			shape: d.shape,
			showLabel: d.showLabel,
			merged: m.resolveAvatar({ shape: 'box' }).shape,
			anchors: [m.hatAnchorY('sphere'), m.hatAnchorY('cone')],
			card: m.usesPhotoCard({ face: 'image' }, 'x') && !m.usesPhotoCard({ face: 'label' }, 'x')
		};
	});
	h.check(model.shape === 'sphere' && model.showLabel === true, 'defaults: sphere head + label shown');
	h.check(model.merged === 'box', 'a stored shape overrides the default');
	h.check(model.anchors[1] > model.anchors[0], 'the hat anchor rises for a cone vs a sphere');
	h.check(model.card, 'usesPhotoCard is true only for a photo face');

	// --- inject a fake box-headed peer with a crown + label ---
	await A.page.evaluate(() => {
		const ud = [];
		window.__stores.userdata.subscribe((v) => ud.push(...(v ?? [])))();
		window.__stores.userdata.set([
			...ud,
			['peerBox', 'Zoe', null, null, null, { shape: 'box', hat: 'crown', showLabel: true }]
		]);
	});
	await A.page.waitForTimeout(500);
	const boxPeer = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.globalScene.subscribe((s) => {
					const body = s?.getObjectByName('peerBox-body');
					r({
						hasBody: !!body,
						bodyGeo: body?.geometry?.type,
						hasLabel: !!s?.getObjectByName('peerBox-label'),
						hasHat: !!s?.getObjectByName('peerBox-hat'),
						noCard: !s?.getObjectByName('peerBox-face-card')
					});
				})();
			})
	);
	h.check(boxPeer.hasBody && boxPeer.bodyGeo === 'BoxGeometry', `box shape renders a box head (${boxPeer.bodyGeo})`);
	h.check(boxPeer.hasLabel && boxPeer.hasHat && boxPeer.noCard, 'label + hat render, no photo card');

	// --- a photo peer renders a card instead of a head ---
	await A.page.evaluate((png) => {
		const ud = [];
		window.__stores.userdata.subscribe((v) => ud.push(...(v ?? [])))();
		window.__stores.userdata.set([
			...ud,
			['peerPhoto', 'Max', png, null, null, { face: 'image', showLabel: false }]
		]);
	}, PNG);
	await A.page.waitForTimeout(800);
	const photoPeer = await A.page.evaluate(
		() =>
			new Promise((r) => {
				window.__stores.globalScene.subscribe((s) => {
					r({
						hasCard: !!s?.getObjectByName('peerPhoto-face-card'),
						noBody: !s?.getObjectByName('peerPhoto-body'),
						noLabel: !s?.getObjectByName('peerPhoto-label')
					});
				})();
			})
	);
	h.check(photoPeer.hasCard && photoPeer.noBody, 'a photo avatar renders a card, not a sphere');
	h.check(photoPeer.noLabel, 'showLabel:false hides the name label');

	await h.finish(browser);
});
