// With REC armed, a MATERIAL edit keys the channel it changed.
//
// Reported twice: "changing colour used to apply immediately, now I have to click
// the object before the animation pane adds the channels". The Inspector's rows go
// through `fanOn`, which keys them — but the object COLOUR picker writes the
// material inline (it owns a debounced gesture so a colour drag is ONE undo entry),
// so it was the single edit that never keyed. The channel only appeared later, when
// clicking the object happened to run a capture and notice the difference.
//
// The hook is at `recordMaterialChange`, the one funnel every material edit already
// passes through for undo — which is what makes this general rather than one more
// special case.
const h = require('./helpers.cjs');

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	const uuid = await A.page.evaluate(async () => {
		const w = window.__stores;
		w.commandsHandler.sceneCommand('/create box 1 1 1');
		await new Promise((r) => setTimeout(r, 800));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		// auto-key records INTO a clip: a fresh object has none, and captureAutoKey
		// bails. Establish one first, which is the state the report describes (the user
		// had created a clip).
		w.animationPreview.addTrack(o.uuid, 'pos.y', o);
		return o.uuid;
	});
	h.check(!!uuid, 'a box (premise)');

	const channelsOf = () =>
		A.page.evaluate((id) => {
			let set;
			window.__stores.animationPreview.animations.subscribe((v) => (set = v))();
			const s = set[id];
			const clip = s ? s.clips[s.active] : null;
			return (clip?.tracks ?? []).map((t) => t.channel).sort();
		}, uuid);

	// ---- 1. NOT armed: a colour change keys nothing ------------------------
	const before = await A.page.evaluate((id) => {
		const w = window.__stores;
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		const was = '#' + m.color.getHexString();
		m.color.set('#00ff00');
		// exactly what the picker's debounced gesture does at the end of a drag
		w.materialsHandler.recordMaterialChange(id, 'color', null, was, '#00ff00');
		return was;
	}, uuid);
	await A.page.waitForTimeout(300);
	const idle = await channelsOf();
	h.check(
		!idle.some((c) => c.startsWith('color')),
		`with REC off, a colour change adds no COLOUR channels (${JSON.stringify(idle)})`
	);

	// ---- 2. ARMED: the same edit keys the colour, with no click ------------
	const armed = await A.page.evaluate((id) => {
		const w = window.__stores;
		const ap = w.animationPreview;
		ap.setAutoKey(id); // REC
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.getObjectByProperty('uuid', id);
		const m = Array.isArray(o.material) ? o.material[0] : o.material;
		const was = '#' + m.color.getHexString();
		m.color.set('#ff0000');
		w.materialsHandler.recordMaterialChange(id, 'color', null, was, '#ff0000');
		return { was };
	}, uuid);
	await A.page.waitForTimeout(400);
	const keyed = await channelsOf();
	// only the components that CHANGED are keyed - green->red moves r and g and
	// leaves b where it was, which is the same rule every other channel follows
	h.check(
		keyed.includes('color.r') && keyed.includes('color.g'),
		`THE FIX: the colour channels appear without touching the object (${JSON.stringify(keyed)})`
	);
	h.check(
		armed.was !== '#ff0000',
		`premise: the colour really changed (${armed.was} -> #ff0000)`
	);

	// the keys hold the NEW colour, not the old one
	const values = await A.page.evaluate((id) => {
		let set;
		window.__stores.animationPreview.animations.subscribe((v) => (set = v))();
		const s = set[id];
		const clip = s.clips[s.active];
		const out = {};
		for (const track of clip.tracks)
			out[track.channel] = track.keys[track.keys.length - 1].v;
		return out;
	}, uuid);
	h.check(
		Math.abs(values['color.r'] - 1) < 1e-3 && values['color.g'] < 1e-3,
		`and they hold the colour that was picked (r=${values['color.r']}, g=${values['color.g']})`
	);

	// ---- 3. any OTHER tracked material option keys too ---------------------
	const other = await A.page.evaluate(async (id) => {
		const w = window.__stores;
		w.materialsHandler.setMaterialParam(id, 'roughness', 0.2);
		await new Promise((r) => setTimeout(r, 300));
		let set;
		w.animationPreview.animations.subscribe((v) => (set = v))();
		const s = set[id];
		const clip = s.clips[s.active];
		w.animationPreview.setAutoKey(null);
		return (clip?.tracks ?? []).map((t) => t.channel);
	}, uuid);
	h.check(
		other.includes('roughness'),
		`a roughness edit keys its channel the same way (${JSON.stringify(other)})`
	);

	// ---- REC with NO CLIP: the first change creates one -----------------------
	// Arming REC creates nothing (a clip is replicated, saved data - toggling REC
	// must not litter a scene with empty ones), but the first change must not vanish
	// either, which is what used to happen. Blender's model: switching auto-keying on
	// does nothing, and the first keyed change creates the Action.
	const fresh = await A.page.evaluate(async () => {
		const w = window.__stores;
		const ap = w.animationPreview;
		w.commandsHandler.sceneCommand('/create sphere');
		await new Promise((r) => setTimeout(r, 700));
		let g;
		w.objectsGroup.subscribe((v) => (g = v))();
		const o = g.children[g.children.length - 1];
		const clipsOf = () => {
			let set;
			ap.animations.subscribe((v) => (set = v))();
			return Object.keys(set[o.uuid]?.clips ?? {}).length;
		};
		ap.setAutoKey(o.uuid);
		await new Promise((r) => setTimeout(r, 200));
		const afterArming = clipsOf();
		// the first change: move it
		o.position.y = 3;
		ap.captureAutoKey(o.uuid, 0);
		await new Promise((r) => setTimeout(r, 300));
		let set;
		ap.animations.subscribe((v) => (set = v))();
		const s = set[o.uuid];
		const clip = s ? s.clips[s.active] : null;
		ap.setAutoKey(null);
		return {
			afterArming,
			afterChange: clipsOf(),
			channels: (clip?.tracks ?? []).map((t) => t.channel),
			undoRemovesIt: (() => {
				w.history.undo();
				return clipsOf();
			})()
		};
	});
	h.check(fresh.afterArming === 0, `arming REC alone creates NO clip (${fresh.afterArming})`);
	h.check(fresh.afterChange === 1, `the first change creates one (${fresh.afterChange})`);
	h.check(
		fresh.channels.includes('pos.y'),
		`...and the change is keyed into it rather than lost (${JSON.stringify(fresh.channels)})`
	);
	h.check(
		fresh.undoRemovesIt === 0,
		`ONE undo takes the clip and its keys back together (${fresh.undoRemovesIt} clips)`
	);
	h.check(h.pageErrors(A).length === 0, `no page errors (${JSON.stringify(h.pageErrors(A))})`);
	await h.finish(browser);
});
