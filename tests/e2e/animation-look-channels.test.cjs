// The LOOK channels (opacity / metalness / roughness / colour / glow), from two
// user reports:
//
//   "if I create an object and add an opacity channel, the animation doesn't apply"
//   "glow channel not working"
//
// Neither was a timing problem. A fresh track seeds its second key with
// `from + 2`, which every 0..1 channel CLAMPS straight back to where it started —
// so the track really was flat. And Glow drives `emissiveIntensity`, which three
// multiplies by the emissive COLOUR, black on every default material: a number
// moved and no pixel did.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const box = async (page) =>
		page.evaluate(async () => {
			const w = window.__stores;
			w.commandsHandler.sceneCommand('/create box 1 1 1');
			await new Promise((r) => setTimeout(r, 700));
			let g;
			w.objectsGroup.subscribe((v) => (g = v))();
			return g.children[g.children.length - 1].uuid;
		});

	// ---- 1. a fresh track must not be FLAT ---------------------------------
	const seeds = await A.page.evaluate(async () => {
		const w = window.__stores;
		const ap = w.animationPreview;
		const out = {};
		for (const channel of ['opacity', 'roughness', 'metalness', 'color.r', 'pos.y']) {
			w.commandsHandler.sceneCommand('/create box 1 1 1');
			await new Promise((r) => setTimeout(r, 350));
			let g;
			w.objectsGroup.subscribe((v) => (g = v))();
			const object = g.children[g.children.length - 1];
			const id = ap.addTrack(object.uuid, channel, object);
			// read the track back off the STORE rather than trusting the return value
			let set;
			ap.animations.subscribe((v) => (set = v))();
			const clips = set[object.uuid]?.clips ?? {};
			const active = set[object.uuid]?.active;
			const track = (clips[active]?.tracks ?? []).find((t) => t.id === id);
			out[channel] = track ? { first: track.keys[0].v, last: track.keys[track.keys.length - 1].v } : null;
		}
		return out;
	});

	for (const channel of ['opacity', 'roughness', 'color.r']) {
		const seed = seeds[channel];
		h.check(!!seed, `${channel}: the seeded track exists (premise)`);
		h.check(
			seed && seed.first !== seed.last,
			`${channel}: its two keys DIFFER after clamping (${JSON.stringify(seed)}) — this is the bug`
		);
		h.check(
			seed && seed.last >= 0 && seed.last <= 1,
			`${channel}: and the target is inside the range the channel clamps to (${seed?.last})`
		);
	}
	h.check(
		seeds['pos.y'] && seeds['pos.y'].last === seeds['pos.y'].first + 2,
		'pos.y is untouched: an unclamped channel still gets the +2 it always had'
	);

	// ---- 2. opacity really moves pixels ------------------------------------
	const uuid = await box(A.page);
	const opacity = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		const material = Array.isArray(object.material) ? object.material[0] : object.material;
		ap.addTrack(id, 'opacity', object);
		const before = { opacity: material.opacity, transparent: !!material.transparent };
		ap.scrub(id, 1.0);
		const during = { opacity: material.opacity, transparent: !!material.transparent };
		ap.stop(id);
		ap.resetPreview(id);
		const after = { opacity: material.opacity, transparent: !!material.transparent };
		return { before, during, after };
	}, uuid);
	h.check(opacity.before.opacity === 1, 'the box starts opaque (premise)');
	h.check(
		opacity.during.opacity < 0.95,
		`scrubbing an opacity track fades it (${opacity.during.opacity.toFixed(3)})`
	);
	h.check(
		opacity.during.transparent,
		'...and switches the transparent flag on, or the fade would not render'
	);
	h.check(
		opacity.after.opacity === 1 && opacity.after.transparent === false,
		'clearing the preview puts BOTH back'
	);

	// ---- 3. glow -----------------------------------------------------------
	const glowUuid = await box(A.page);
	const glow = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.getObjectByProperty('uuid', id);
		const material = Array.isArray(object.material) ? object.material[0] : object.material;
		const before = { hex: material.emissive.getHexString(), intensity: material.emissiveIntensity };
		ap.addTrack(id, 'emissive', object);
		ap.scrub(id, 1.0);
		const during = { hex: material.emissive.getHexString(), intensity: material.emissiveIntensity };
		ap.stop(id);
		ap.resetPreview(id);
		const after = { hex: material.emissive.getHexString(), intensity: material.emissiveIntensity };
		return { before, during, after };
	}, glowUuid);
	h.check(glow.before.hex === '000000', 'a default material has NO emissive colour (premise: the bug)');
	h.check(
		glow.during.intensity > glow.before.intensity,
		`driving Glow raises the intensity (${glow.before.intensity} -> ${glow.during.intensity.toFixed(2)})`
	);
	h.check(
		glow.during.hex !== '000000',
		`...and now lights the emissive colour so it is VISIBLE (${glow.during.hex})`
	);
	h.check(
		glow.after.hex === '000000' && glow.after.intensity === glow.before.intensity,
		'clearing the preview restores the black emissive AND the original intensity'
	);

	// a colour the user (or an imported model) already chose is NOT overwritten
	const tinted = await A.page.evaluate(async () => {
		const w = window.__stores;
		const ap = w.animationPreview;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 500));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const object = g.children[g.children.length - 1];
		const material = Array.isArray(object.material) ? object.material[0] : object.material;
		material.emissive.setHex(0x00ff00); // a green glow the user picked
		ap.addTrack(object.uuid, 'emissive', object);
		ap.scrub(object.uuid, 1.0);
		const during = material.emissive.getHexString();
		ap.stop(object.uuid);
		ap.resetPreview(object.uuid);
		return { during, after: material.emissive.getHexString() };
	});
	h.check(tinted.during === '00ff00', `an emissive colour already set is kept (${tinted.during})`);
	h.check(tinted.after === '00ff00', '...and survives the reset');

	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
