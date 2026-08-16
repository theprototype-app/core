// 18-C: the Edit Mesh toolbox redesign — element modes as a pinned TAB BAR,
// collapsible sections, and the contextual tool-options pane.
//
// Note the class assertions read the COMPUTED colour, never the class string:
// the toolbox's own styles are unlayered, so a utility class can be present and
// paint nothing (the bug that made the armed fill vanish in the dark theme).
const h = require('./helpers.cjs');

/** open an Edit Mesh session on a fresh box */
async function openSession(page) {
	await page.evaluate(async () => {
		const { commandsHandler, objectsGroup, objectActions, faceEdit } = window.__stores;
		commandsHandler.sceneCommand('/create box');
		await new Promise((r) => setTimeout(r, 700));
		let g = null;
		objectsGroup.subscribe((x) => (g = x))();
		const box = g.children[g.children.length - 1];
		objectActions.selectObject(box.uuid);
		faceEdit.enterFaceEdit(box.uuid);
	});
	await page.waitForTimeout(1000);
}

const submode = (page) =>
	page.evaluate(() => {
		let v = null;
		window.__stores.faceEdit.faceEditSubmode.subscribe((x) => (v = x))();
		const inVertexMode = (() => {
			let o = null;
			window.__stores.meshEdit.editingObject.subscribe((x) => (o = x))();
			return !!o;
		})();
		return { submode: v, inVertexMode };
	});

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	await openSession(A.page);

	// ---------------------------------------------------- 1. the tab bar
	const tabsUp = await A.page.evaluate(() => {
		const bar = document.querySelector('#mesh-edit-popup .tbx-tabs');
		const body = document.querySelector('#mesh-edit-popup .toolbox-body');
		if (!bar || !body) return null;
		return {
			role: bar.getAttribute('role'),
			tabs: [...bar.querySelectorAll('button')].map((b) => b.id),
			// the bar must sit OUTSIDE the scrolling body, or it would scroll away
			insideBody: body.contains(bar),
			aboveBody: bar.getBoundingClientRect().bottom <= body.getBoundingClientRect().top + 1
		};
	});
	h.check(!!tabsUp, 'the toolbox has a tab bar');
	h.check(tabsUp.role === 'tablist', `the bar is a tablist (${tabsUp.role})`);
	h.check(
		JSON.stringify(tabsUp.tabs) === JSON.stringify(['mesh-mode-vertices', 'mesh-mode-edges', 'mesh-mode-faces']),
		`all three modes are tabs (${tabsUp.tabs.join(', ')})`
	);
	h.check(!tabsUp.insideBody && tabsUp.aboveBody, 'the tabs are pinned above the scrolling body');

	// the labels must actually FIT at the default width — "Vertices" truncating
	// to "Vertic…" is the reason the default width was widened
	const labels = await A.page.evaluate(() =>
		[...document.querySelectorAll('#mesh-edit-popup .tbx-tabs button')].map((b) => ({
			id: b.id,
			text: b.textContent.trim(),
			clipped: b.scrollWidth > b.clientWidth + 1
		}))
	);
	for (const l of labels) h.check(!l.clipped, `${l.id} label is not clipped ("${l.text}")`);

	// ------------------------------------------- 2. switching modes via tabs
	for (const [tab, expect] of [
		['mesh-mode-edges', { submode: 'edges', inVertexMode: false }],
		['mesh-mode-faces', { submode: 'faces', inVertexMode: false }],
		['mesh-mode-vertices', { submode: null, inVertexMode: true }]
	]) {
		await A.page.evaluate((id) => document.querySelector('#' + id).click(), tab);
		await A.page.waitForTimeout(500);
		const state = await submode(A.page);
		if (expect.submode)
			h.check(state.submode === expect.submode, `${tab} sets the face submode (${state.submode})`);
		h.check(
			state.inVertexMode === expect.inVertexMode,
			`${tab} ${expect.inVertexMode ? 'enters' : 'leaves'} the vertex session`
		);
		// the ACTIVE tab paints — computed colour, never the class string
		const painted = await A.page.evaluate((id) => {
			const el = document.querySelector('#' + id);
			const bg = getComputedStyle(el).backgroundColor;
			const transparent = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
			return { bg, transparent, selected: el.getAttribute('aria-selected') };
		}, tab);
		h.check(!painted.transparent, `${tab} is visibly active (${painted.bg})`);
		h.check(painted.selected === 'true', `${tab} reports aria-selected`);
	}

	// and the OTHER tabs are not painted at the same time
	const onlyOne = await A.page.evaluate(() => {
		const bar = document.querySelector('#mesh-edit-popup .tbx-tabs');
		return [...bar.querySelectorAll('button')].filter((b) => {
			const bg = getComputedStyle(b).backgroundColor;
			return bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
		}).length;
	});
	h.check(onlyOne === 1, `exactly one tab is active at a time (${onlyOne})`);

	// -------------------------------------- 3. help lives in the header now
	const help = await A.page.evaluate(() => {
		const btn = document.querySelector('#mesh-keys-help');
		const header = document.querySelector('#mesh-edit-popup .toolbox-header');
		return { exists: !!btn, inHeader: !!btn && header.contains(btn) };
	});
	h.check(help.exists && help.inHeader, 'the key cheat-sheet button sits in the window header');
	// ...and still opens the sheet, from any tab
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());
	await A.page.waitForTimeout(400);
	h.check(await A.page.locator('#mesh-keys-popover').count() > 0, 'it still opens the cheat sheet');
	await A.page.evaluate(() => document.querySelector('#mesh-keys-help').click());

	// ------------------------------------------- 4. the tool OPTIONS pane
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(400);
	await A.page.evaluate(() => document.querySelector('#mesh-op-extrude').click());
	await A.page.waitForTimeout(300);
	let pane = await A.page.evaluate(() => ({
		opParams: !!document.querySelector('#mesh-op-params'),
		bevelParams: !!document.querySelector('#bevel-params'),
		loopParams: !!document.querySelector('#loopcut-params')
	}));
	h.check(pane.opParams && !pane.bevelParams, 'arming Extrude shows the amount row and nothing else');

	await A.page.evaluate(() => document.querySelector('#mesh-op-bevel').click());
	await A.page.waitForTimeout(300);
	pane = await A.page.evaluate(() => ({
		opParams: !!document.querySelector('#mesh-op-params'),
		bevelParams: !!document.querySelector('#bevel-params'),
		width: !!document.querySelector('#bevel-width'),
		segments: !!document.querySelector('#bevel-segments'),
		apply: !!document.querySelector('#face-bevel')
	}));
	h.check(pane.bevelParams && pane.width && pane.segments && pane.apply, 'selecting Bevel swaps the pane to its own options');
	h.check(!pane.opParams, 'and the extrude amount row is gone (one tool at a time)');

	// SELECTED, not armed: a ring rather than the armed fill, and the armed op
	// is untouched — clicking a face must not start bevelling
	const bevelState = await A.page.evaluate(() => {
		const btn = document.querySelector('#mesh-op-bevel');
		const style = getComputedStyle(btn);
		let armed = null;
		window.__stores.faceEdit.faceEditOp.subscribe((v) => (armed = v))();
		return {
			ring: style.boxShadow !== 'none',
			filled: style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent',
			armed,
			pressed: btn.getAttribute('aria-pressed')
		};
	});
	h.check(bevelState.ring && !bevelState.filled, `Bevel reads as selected, not armed (ring=${bevelState.ring}, fill=${bevelState.filled})`);
	h.check(bevelState.armed === 'extrude', `the ARMED op is untouched by selecting Bevel (${bevelState.armed})`);
	h.check(bevelState.pressed === 'true', 'and it reports aria-pressed');

	// ---- 19-A P2, THE CONTRACT FLIP: apply-on-click + the adjust panel ----
	// The 18-C contract this suite used to pin ("selecting Bevel commits
	// nothing / Apply commits") is GONE by design: selecting a parameterized op
	// WITH a valid target now applies it immediately (Blender's F9 model), the
	// pane becomes a live adjust, and ✕ Revert undoes it + drops its history
	// entry. Without a target the click still commits nothing — and the pane's
	// hint line says what is missing instead of leaving a dead button.
	const triCount = () =>
		A.page.evaluate(() => {
			let g = null;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			let uuid = null;
			window.__stores.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
			const obj = g.getObjectByProperty('uuid', uuid);
			const geo = obj?.geometry;
			return geo ? (geo.index ? geo.index.count : geo.attributes.position.count) / 3 : -1;
		});
	// a checksum of the vertex positions — "same tri count, different shape" is
	// what a live width re-run looks like
	const geoSum = () =>
		A.page.evaluate(() => {
			let g = null;
			window.__stores.objectsGroup.subscribe((x) => (g = x))();
			let uuid = null;
			window.__stores.faceEdit.faceEditObject.subscribe((v) => (uuid = v))();
			const pos = g.getObjectByProperty('uuid', uuid)?.geometry?.attributes?.position;
			if (!pos) return null;
			let sum = 0;
			for (let i = 0; i < pos.array.length; i++) sum += pos.array[i] * (i + 1);
			return Math.round(sum * 1e4) / 1e4;
		});
	const beforeBevel = await triCount();
	// no target: the grid click applies NOTHING and the pane explains itself
	await A.page.evaluate(() => document.querySelector('#mesh-op-bevel').click());
	await A.page.waitForTimeout(400);
	h.check((await triCount()) === beforeBevel, `without a target the grid click applies nothing (${beforeBevel} tris)`);
	const idlePane = await A.page.evaluate(() => ({
		hint: document.querySelector('#mesh-op-hint')?.textContent?.trim() ?? '',
		revert: !!document.querySelector('#mesh-adjust-revert'),
		apply: !!document.querySelector('#face-bevel')
	}));
	h.check(!!idlePane.hint, `the pane's hint names the missing precondition ("${idlePane.hint}")`);
	h.check(!idlePane.revert && idlePane.apply, 'and it offers Apply, not the adjust ✕');

	// select a face, then the grid click APPLIES IMMEDIATELY
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.highlightFaceByTriangle(0);
		fe.pickFaceUnit?.(0);
	});
	await A.page.waitForTimeout(300);
	await A.page.evaluate(() => document.querySelector('#mesh-op-bevel').click());
	await A.page.waitForTimeout(500);
	const afterApply = await triCount();
	h.check(afterApply > beforeBevel, `click-with-selection applies immediately (${beforeBevel} -> ${afterApply} tris)`);
	const adjustPane = await A.page.evaluate(() => {
		let st = null;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		const labels = [...document.querySelectorAll('#mesh-edit-popup .tbx-label')].map((l) =>
			l.textContent.trim()
		);
		return {
			op: st?.op ?? null,
			adjustingLabel: labels.some((t) => /^Adjusting/i.test(t)),
			revert: !!document.querySelector('#mesh-adjust-revert'),
			apply: !!document.querySelector('#face-bevel')
		};
	});
	h.check(adjustPane.op === 'bevel', `the adjust engine holds the op (${adjustPane.op})`);
	h.check(adjustPane.adjustingLabel, 'the pane label reads "Adjusting"');
	h.check(adjustPane.revert && !adjustPane.apply, 'the primary button is ✕ Revert now');

	// typing a new width into the pane re-runs the op LIVE: same triangle
	// count, different shape
	const sumBefore = await geoSum();
	await A.page.evaluate(() => {
		const input = document.querySelector('#bevel-width');
		input.value = '0.35';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await A.page.waitForTimeout(500); // covers the 300ms typed-input settle too
	const sumAfter = await geoSum();
	h.check((await triCount()) === afterApply, `the re-run keeps the bevel's triangle count (${afterApply})`);
	h.check(sumBefore !== sumAfter, `scrubbing the width re-runs the bevel live (${sumBefore} -> ${sumAfter})`);

	// ✕ reverts to the pre-op geometry and the pane goes back to Apply
	await A.page.evaluate(() => document.querySelector('#mesh-adjust-revert').click());
	await A.page.waitForTimeout(400);
	h.check((await triCount()) === beforeBevel, `✕ Revert restores the pre-op geometry (${beforeBevel} tris)`);
	const afterRevert = await A.page.evaluate(() => ({
		apply: !!document.querySelector('#face-bevel'),
		revert: !!document.querySelector('#mesh-adjust-revert')
	}));
	h.check(afterRevert.apply && !afterRevert.revert, 'the pane returns to Apply after the revert');

	// ------------------------------------------ 5. collapsible sections
	const sections = await A.page.evaluate(() =>
		['cleanup', 'symmetry', 'display'].map((k) => {
			const head = document.querySelector('#mesh-sec-' + k);
			return { k, exists: !!head, expanded: head?.getAttribute('aria-expanded') };
		})
	);
	for (const s of sections) h.check(s.exists, `the ${s.k} section header exists`);
	h.check(
		sections.find((s) => s.k === 'cleanup').expanded === 'false',
		'Cleanup starts collapsed — the tools stay the first thing in the window'
	);
	h.check(
		await A.page.locator('#mesh-fix-normals').count() === 0,
		'so its contents are not rendered while collapsed'
	);
	await A.page.evaluate(() => document.querySelector('#mesh-sec-cleanup').click());
	await A.page.waitForTimeout(300);
	const opened = await A.page.evaluate(() => ({
		normals: !!document.querySelector('#mesh-fix-normals'),
		merge: !!document.querySelector('#mesh-fix-merge'),
		// the threshold belongs WITH its button now, not two sections away
		dist: !!document.querySelector('#mesh-merge-dist'),
		shading: !!document.querySelector('#mesh-shading')
	}));
	h.check(opened.normals && opened.merge && opened.shading, 'opening it reveals the cleanup commands');
	h.check(opened.dist, 'and the merge threshold sits inside the same section as Merge');

	// the open/closed state is a preference — it survives a reload
	await h.freshReload(A);
	await A.page.waitForTimeout(1500);
	await openSession(A.page);
	const persisted = await A.page.evaluate(() => ({
		expanded: document.querySelector('#mesh-sec-cleanup')?.getAttribute('aria-expanded'),
		normals: !!document.querySelector('#mesh-fix-normals')
	}));
	h.check(persisted.expanded === 'true' && persisted.normals, 'the section stays open across a reload');

	// ------------------------- 6. whole-mesh tools are offered in EVERY mode
	await A.page.evaluate(() => document.querySelector('#mesh-mode-vertices').click());
	await A.page.waitForTimeout(500);
	const inVerts = await A.page.evaluate(() => {
		const head = document.querySelector('#mesh-sec-cleanup');
		const normals = document.querySelector('#mesh-fix-normals');
		return {
			section: !!head,
			normals: !!normals,
			// disabled-LOOKING but still clickable: it toasts an explanation rather
			// than vanishing, so the section's contents do not shuffle between tabs
			looksDisabled: normals?.className.includes('tbx-disabled')
		};
	});
	h.check(inVerts.section && inVerts.normals, 'Cleanup is offered in Vertices too (it acts on the whole mesh)');
	h.check(inVerts.looksDisabled, 'but reads as unavailable there, where there is no face session');

	// ------------- 8. TOOLS vs OPERATIONS, and Bridge's own options (18-C5)
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(500);
	const groups = await A.page.evaluate(() => {
		const body = document.querySelector('#mesh-edit-popup .toolbox-body');
		// walk the body in DOM order: each .tbx-label starts a group, the buttons
		// after it belong to it
		const out = {};
		let current = null;
		for (const el of body.children) {
			if (el.classList.contains('tbx-label')) {
				current = el.textContent.trim().toLowerCase();
				out[current] = [];
			} else if (current && el.id?.startsWith('mesh-op-')) out[current].push(el.id.replace('mesh-op-', ''));
		}
		return out;
	});
	h.check(
		JSON.stringify(groups.tools) === JSON.stringify(['move', 'extrude', 'inset', 'knife']),
		`TOOLS holds only the ARMED tools (${(groups.tools ?? []).join(', ')})`
	);
	h.check(
		JSON.stringify(groups.operations) ===
			JSON.stringify(['bevel', 'loopcut', 'bridge', 'subdivide', 'duplicate', 'flip', 'delete']),
		`OPERATIONS holds the selection actions, parameterized first (${(groups.operations ?? []).join(', ')})`
	);

	// Bridge is parameterized: the grid click opens its options — and 19-A P2,
	// with no valid two-piece selection it applies NOTHING while the hint line
	// names the precondition (a selection that qualifies would auto-apply; that
	// path is pinned in mesh-adjust.test.cjs)
	await A.page.evaluate(() => document.querySelector('#mesh-op-bridge').click());
	await A.page.waitForTimeout(350);
	const bridgePane = await A.page.evaluate(() => {
		let st = null;
		window.__stores.faceEdit.opAdjustState.subscribe((v) => (st = v))();
		return {
			params: !!document.querySelector('#bridge-params'),
			cuts: !!document.querySelector('#mesh-bridge-cuts'),
			apply: !!document.querySelector('#mesh-bridge-apply'),
			hint: document.querySelector('#mesh-op-hint')?.textContent?.trim() ?? '',
			applied: !!st,
			ring: getComputedStyle(document.querySelector('#mesh-op-bridge')).boxShadow !== 'none'
		};
	});
	h.check(bridgePane.params && bridgePane.cuts && bridgePane.apply, 'Bridge opens its own options with a cut count');
	h.check(bridgePane.ring, 'and reads as selected, like the other parameterized operations');
	h.check(!bridgePane.applied && !!bridgePane.hint, `an unmet bridge shows the hint instead of applying ("${bridgePane.hint}")`);

	// the cuts actually build extra rings — bridge the same shape at 0 and at 2
	// and compare, on the inset-caps scenario (bridging a unit cube's FULL top and
	// bottom is the degenerate case: the walls land on the cube's own sides)
	const bridged = await A.page.evaluate(async () => {
		const s = window.__stores;
		const fe = s.faceEdit;
		const oddEdges = (tris) => {
			const seen = new Map();
			const key = (p) => [p.x, p.y, p.z].map((v) => Math.round(v * 1e4)).join(',');
			for (const t of tris)
				for (let i = 0; i < 3; i++) {
					const a = key(t[i]);
					const b = key(t[(i + 1) % 3]);
					const e = a < b ? a + '|' + b : b + '|' + a;
					seen.set(e, (seen.get(e) ?? 0) + 1);
				}
			return [...seen.values()].filter((n) => n !== 2).length;
		};
		const run = async (cuts) => {
			s.commandsHandler.sceneCommand('/clear all');
			await new Promise((r) => setTimeout(r, 400));
			s.commandsHandler.sceneCommand('/create Box 1 1 1');
			await new Promise((r) => setTimeout(r, 500));
			let g;
			s.objectsGroup.subscribe((v) => (g = v))();
			const box = g.children[g.children.length - 1];
			fe.enterFaceEdit(box.uuid);
			fe.setFaceGranularity('face');
			// the inset leaves its CAP selected, which is the quad to bridge
			// (mesh-bridge-normals' recipe, verbatim)
			const insetCap = (pick) => {
				const face = fe.currentFaces().find(pick);
				if (!face) return null;
				fe.faceEditSelectedTris.set([...face.triIndices]);
				fe.highlightFaceByTriangle(face.triIndices[0]);
				if (!fe.commitFaceOp('inset', 0.45)) return null;
				let cap;
				fe.faceEditSelectedTris.subscribe((v) => (cap = [...v]))();
				return cap;
			};
			const top = insetCap((f) => f.normal.y > 0.9);
			const bottom = insetCap((f) => f.normal.y < -0.9);
			if (!top?.length || !bottom?.length) return null;
			fe.faceEditSelectedTris.set([...top, ...bottom]);
			fe.highlightFaceByTriangle(top[0], false);
			const before = fe.readTriangles(box.geometry).length;
			// the bridge DELETES both caps as well as adding walls, so the raw
			// delta is walls-minus-caps — count the caps to get the walls alone
			const caps = top.length + bottom.length;
			const ok = fe.commitFaceOp('bridge', cuts);
			const after = fe.readTriangles(box.geometry);
			fe.exitFaceEdit();
			return { ok, before, caps, after: after.length, walls: after.length - before + caps, odd: oddEdges(after) };
		};
		return { zero: await run(0), two: await run(2) };
	});
	h.check(!!bridged.zero?.ok && !!bridged.two?.ok, 'both bridges committed (premise)');
	if (bridged.zero?.ok && bridged.two?.ok) {
		// cuts=2 means 3 segments, so three times the wall triangles of one band
		h.check(
			bridged.two.walls === bridged.zero.walls * 3 && bridged.zero.walls > 0,
			`2 cuts builds three rings instead of one (${bridged.zero.walls} -> ${bridged.two.walls} wall triangles)`
		);
		// and the tunnel is still closed — the single best check for any op that
		// rebuilds geometry
		h.check(bridged.zero.odd === 0, `a plain bridge stays watertight (${bridged.zero.odd} odd edges)`);
		h.check(bridged.two.odd === 0, `and so does a 2-cut bridge (${bridged.two.odd} odd edges)`);
	}
	// ------------------------------------- 12. the header's Cancel is not a
	// second Undo, and Tab owns the element modes
	//
	// One report, two causes: the session-discard button drew Undo2 while
	// sitting immediately beside #mesh-undo's Undo2, and 1/2/3 were spent on
	// element modes (shortcuts.js SUPPRESSED them during a session), so the
	// gizmo's own Move/Rotate/Scale were unreachable mid-edit. This section runs
	// BEFORE the mobile block, which closes A's context.
	// whatever the sections above left behind, these checks need a LIVE
	// session: the header buttons only exist while the toolbox is up
	await openSession(A.page);
	const headerUp = await A.page.evaluate(
		() => !!document.querySelector('#mesh-edit-cancel') && !!document.querySelector('#mesh-undo')
	);
	h.check(headerUp, 'PREMISE: the toolbox header is up with a fresh session');

	const glyphs = await A.page.evaluate(() => {
		// the class lands on the child <svg> (a lucide component forwards it into
		// its own scope) and svg.className is an SVGAnimatedString - read the
		// ATTRIBUTE, the documented icon-assertion rule
		const iconOf = (id) => document.querySelector('#' + id + ' svg')?.getAttribute('class') ?? null;
		return {
			cancel: iconOf('mesh-edit-cancel'),
			undo: iconOf('mesh-undo'),
			redo: iconOf('mesh-redo'),
			done: iconOf('mesh-edit-done'),
			danger: !!document.querySelector('#mesh-edit-cancel')?.className.includes('tbx-danger')
		};
	});
	h.check(!!glyphs.cancel && !!glyphs.undo, 'the header has both a Cancel and an Undo button');
	h.check(
		glyphs.cancel !== glyphs.undo,
		`Cancel no longer draws Undo's glyph (${glyphs.cancel} vs ${glyphs.undo})`
	);
	h.check(glyphs.cancel !== glyphs.redo, "nor Redo's");
	h.check(glyphs.cancel !== glyphs.done, 'and it stays distinct from Done');
	h.check(glyphs.danger, 'the session discard carries the danger tint');
	// askCancel only asks when the session HAS something to throw away — give it
	// one edit, or it just toasts "nothing to revert" and the row never appears
	await A.page.evaluate(() => {
		const fe = window.__stores.faceEdit;
		fe.pickFaceUnit(0);
		fe.commitFaceOp('extrude', 0.3);
	});
	await A.page.waitForTimeout(400);
	await A.page.click('#mesh-edit-cancel');
	await A.page.waitForTimeout(250);
	const confirmUp = await A.page.evaluate(() => !!document.querySelector('#mesh-cancel-confirm'));
	h.check(confirmUp, 'pressing it still ASKS before reverting the session');
	await A.page.click('#mesh-cancel-no');
	await A.page.waitForTimeout(250);

	const modeNow = async () => {
		const st = await submode(A.page);
		return st.inVertexMode ? 'vertices' : st.submode;
	};
	await A.page.evaluate(() => window.__stores.faceEdit.setFaceSubmode('faces'));
	await A.page.waitForTimeout(250);
	h.check((await modeNow()) === 'faces', 'starting the key checks in faces');
	await A.page.keyboard.press('Tab');
	await A.page.waitForTimeout(350);
	const tab1 = await modeNow();
	h.check(tab1 === 'vertices', `Tab wraps faces -> vertices (${tab1})`);
	await A.page.keyboard.press('Tab');
	await A.page.waitForTimeout(350);
	const tab2 = await modeNow();
	h.check(tab2 === 'edges', `Tab again -> edges (${tab2})`);
	await A.page.keyboard.press('Shift+Tab');
	await A.page.waitForTimeout(350);
	const back1 = await modeNow();
	h.check(back1 === 'vertices', `Shift+Tab steps BACK -> vertices (${back1})`);

	// 1/2/3 belong to the gizmo again: they must move the TRANSFORM mode and
	// leave the element mode alone - the whole reason the cycle moved to Tab
	// back to faces through the real tab: Shift+Tab left us in VERTEX mode, which
	// is a meshEdit session — setFaceSubmode cannot get us out of it
	await A.page.click('#mesh-mode-faces');
	await A.page.waitForTimeout(400);
	h.check((await modeNow()) === 'faces', 'PREMISE: back in faces for the gizmo keys');
	const tmode = () =>
		A.page.evaluate(() => {
			let v = null;
			window.__stores.transformMode.subscribe((x) => (v = x))();
			return v;
		});
	await A.page.keyboard.press('Digit2');
	await A.page.waitForTimeout(300);
	const t2 = await tmode();
	h.check(t2 === 'rotate', `2 sets the gizmo to ROTATE during a session (${t2})`);
	h.check((await modeNow()) === 'faces', 'and does NOT change the element mode');
	await A.page.keyboard.press('Digit3');
	await A.page.waitForTimeout(300);
	const t3 = await tmode();
	h.check(t3 === 'scale', `3 sets it to SCALE (${t3})`);
	h.check((await modeNow()) === 'faces', 'element mode still untouched');

	// the cheat sheet has to TEACH the new binding or the keys are invisible
	const sheetText = await A.page.evaluate(async () => {
		document.querySelector('#mesh-keys-help').click();
		await new Promise((r) => setTimeout(r, 400));
		return document.querySelector('#mesh-keys-popover')?.textContent ?? '';
	});
	h.check(/Tab/.test(sheetText), 'the cheat sheet lists Tab');
	h.check(/Shift ?Tab/i.test(sheetText), 'and Shift+Tab for the backwards step');
	h.check(!/Switch to Vertices/.test(sheetText), 'and no longer teaches 1/2/3 as element modes');
	await A.page.evaluate(() => document.querySelector('#mesh-keys-close')?.click());
	await A.page.waitForTimeout(200);

	// ------------------------------------------- 13. themed CHECKBOXES
	// Every boolean option in the toolbox was a raw <input type="checkbox">, and
	// they rendered flowbite BLUE inside an orange palette. The cure cannot be a
	// background: flowbite's plugin puts `appearance: none` on every checkbox (so
	// `accent-color` is inert) and paints the checked state with
	// `background-color: currentColor !important`, which nothing of ours beats at
	// any specificity — so `.tbx-check` drives the fill through `color`. The
	// class string was never the problem, which is why every assertion below
	// reads the COMPUTED colour.
	await openSession(A.page);
	const accentRgb = await A.page.evaluate(() => {
		const tb = document.querySelector('#mesh-edit-popup');
		// resolve --tbx-accent to the rgb() form getComputedStyle reports
		const probe = document.createElement('span');
		probe.style.color = getComputedStyle(tb).getPropertyValue('--tbx-accent').trim();
		document.body.appendChild(probe);
		const rgb = getComputedStyle(probe).color;
		probe.remove();
		return rgb;
	});
	h.check(/^rgb/.test(accentRgb), `the toolbox resolves an accent colour (${accentRgb})`);

	const measureCheckbox = (id) =>
		A.page.evaluate((id) => {
			const el = document.querySelector('#' + id);
			if (!el) return { id, missing: true };
			const was = el.checked;
			el.checked = true;
			const bgOn = getComputedStyle(el).backgroundColor;
			el.checked = was;
			const cs = getComputedStyle(el);
			return {
				id,
				missing: false,
				hasClass: el.classList.contains('tbx-check'),
				color: cs.color,
				bgOn,
				appearance: cs.appearance
			};
		}, id);

	/** @type {any[]} */
	const boxes = [];
	// faces ▸ Extrude carries two of them
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(450);
	await A.page.evaluate(() => document.querySelector('#mesh-op-extrude').click());
	await A.page.waitForTimeout(350);
	boxes.push(await measureCheckbox('mesh-op-autoapply'));
	boxes.push(await measureCheckbox('extrude-individual'));
	// faces ▸ Bridge — with no qualifying selection this only opens the options
	await A.page.evaluate(() => document.querySelector('#mesh-op-bridge').click());
	await A.page.waitForTimeout(350);
	boxes.push(await measureCheckbox('bridge-invert'));
	// vertices ▸ Slide
	await A.page.evaluate(() => document.querySelector('#mesh-mode-vertices').click());
	await A.page.waitForTimeout(550);
	await A.page.evaluate(() => document.querySelector('#mesh-slide').click());
	await A.page.waitForTimeout(350);
	boxes.push(await measureCheckbox('slide-clamp'));
	await A.page.evaluate(() => document.querySelector('#mesh-slide').click()); // back off
	await A.page.waitForTimeout(250);
	// ...and the Gizmo section's grid-snap toggle
	boxes.push(await measureCheckbox('mesh-snap-enabled'));

	h.check(boxes.length === 5, `measured all five toolbox checkboxes (${boxes.length})`);
	h.check(
		boxes[0].appearance === 'none',
		`PREMISE: the forms base strips the native appearance (${boxes[0].appearance}) — which is why the colour has to ride \`color\`, not \`accent-color\``
	);
	for (const b of boxes) {
		h.check(!b.missing, `${b.id} is on screen`);
		if (b.missing) continue;
		h.check(b.hasClass, `${b.id} carries .tbx-check`);
		h.check(b.color === accentRgb, `${b.id} takes the toolbox accent (${b.color})`);
		h.check(b.bgOn === accentRgb, `...and its CHECKED fill paints that accent (${b.bgOn})`);
	}

	// ------------------------------- 14. Move has no options, so no pane
	// "Move options — Drag the gizmo. Its orientation is above." was filler that
	// contradicted the pane's own contract (one tool's PARAMETERS, and nothing
	// when it has none). Arming Move now clears the pane instead of leaving the
	// previous tool's rows describing a tool that is no longer selected.
	await A.page.evaluate(() => document.querySelector('#mesh-mode-faces').click());
	await A.page.waitForTimeout(450);
	await A.page.evaluate(() => document.querySelector('#mesh-op-extrude').click());
	await A.page.waitForTimeout(350);
	h.check(
		await A.page.locator('#mesh-op-params').count() > 0,
		'PREMISE: Extrude leaves its amount row up'
	);
	await A.page.evaluate(() => document.querySelector('#mesh-op-move').click());
	await A.page.waitForTimeout(400);
	const movePane = await A.page.evaluate(() => {
		const body = document.querySelector('#mesh-edit-popup .toolbox-body');
		let focus = null;
		window.__stores.meshToolParams.optionsFocus.subscribe((v) => (focus = v))();
		let armed = null;
		window.__stores.faceEdit.faceEditOp.subscribe((v) => (armed = v))();
		return {
			armed,
			focus,
			text: body.textContent,
			labels: [...body.querySelectorAll('.tbx-label')].map((l) => l.textContent.trim()),
			// no stale rows from the tool that WAS selected
			opParams: !!document.querySelector('#mesh-op-params'),
			bevelParams: !!document.querySelector('#bevel-params')
		};
	});
	h.check(movePane.armed === 'move', `PREMISE: Move is the armed tool (${movePane.armed})`);
	h.check(!/Move options/.test(movePane.text), 'the "Move options" filler label is gone');
	h.check(
		!/Drag the gizmo\. Its orientation is above\./.test(movePane.text),
		'...and so is its one line of text'
	);
	h.check(
		!movePane.opParams && !movePane.bevelParams,
		'the pane is EMPTY for Move — no stale rows from the previous tool'
	);
	h.check(
		!movePane.labels.some((t) => /options$/i.test(t)),
		`no "<tool> options" heading is left behind (${JSON.stringify(movePane.labels)})`
	);

	// ------------------- 15. Gizmo & pivot is ONE collapsible section
	const GIZMO_IDS = [
		'mesh-gizmo-toggle',
		'mesh-gizmo-space',
		'mesh-space-local',
		'mesh-space-world',
		'mesh-snap-enabled',
		'mesh-snap-translate',
		'mesh-snap-rotate',
		'mesh-pivot-row',
		'mesh-pivot-set',
		'mesh-pivot-pick',
		'mesh-pivot-move',
		'mesh-pivot-clear',
		'mesh-pivot-state'
	];
	const gsec = await A.page.evaluate((ids) => {
		const head = document.querySelector('#mesh-sec-gizmo');
		const body = document.querySelector('#mesh-edit-popup .toolbox-body');
		const row = document.querySelector('#mesh-pivot-row');
		return {
			exists: !!head,
			expanded: head?.getAttribute('aria-expanded'),
			missing: ids.filter((i) => !document.querySelector('#' + i)),
			// ToolboxSection renders NO wrapper on purpose — the rows must stay
			// DIRECT grid children or they lose their full-width span
			directChild: row?.parentElement === body,
			headIsGridChild: head?.parentElement === body
		};
	}, GIZMO_IDS);
	h.check(gsec.exists, 'the Gizmo & pivot section header exists');
	h.check(gsec.expanded === 'true', 'it is OPEN by default — everyday controls, like Display');
	h.check(gsec.missing.length === 0, `every existing id survived the move (${gsec.missing.join(', ') || 'none missing'})`);
	h.check(gsec.directChild && gsec.headIsGridChild, 'its rows stay direct children of the toolbox grid');

	// collapsing takes ALL of it away — one control for the whole subject
	await A.page.evaluate(() => document.querySelector('#mesh-sec-gizmo').click());
	await A.page.waitForTimeout(350);
	const gClosed = await A.page.evaluate((ids) => ({
		expanded: document.querySelector('#mesh-sec-gizmo')?.getAttribute('aria-expanded'),
		left: ids.filter((i) => !!document.querySelector('#' + i))
	}), GIZMO_IDS);
	h.check(gClosed.expanded === 'false', 'clicking the header collapses it');
	h.check(gClosed.left.length === 0, `and nothing of it is left in the DOM (${gClosed.left.join(', ') || 'clean'})`);

	// the open/closed state is a preference, like the other sections
	await h.freshReload(A);
	await A.page.waitForTimeout(1500);
	await openSession(A.page);
	const gPersisted = await A.page.evaluate(() => ({
		expanded: document.querySelector('#mesh-sec-gizmo')?.getAttribute('aria-expanded'),
		stored: localStorage.getItem('tbx:sec:gizmo'),
		toggle: !!document.querySelector('#mesh-gizmo-toggle')
	}));
	h.check(
		gPersisted.expanded === 'false' && !gPersisted.toggle,
		'it stays collapsed across a reload'
	);
	h.check(gPersisted.stored === 'closed', `...through the same tbx:sec:<key> idiom (${gPersisted.stored})`);
	await A.page.evaluate(() => document.querySelector('#mesh-sec-gizmo').click());
	await A.page.waitForTimeout(350);

	// ...and it is offered in ALL THREE element modes (the gizmo switch and the
	// orientation used to live inside the faces-only branch)
	for (const tab of ['mesh-mode-vertices', 'mesh-mode-edges', 'mesh-mode-faces']) {
		await A.page.evaluate((id) => document.querySelector('#' + id).click(), tab);
		await A.page.waitForTimeout(550);
		const inMode = await A.page.evaluate((ids) => ({
			head: !!document.querySelector('#mesh-sec-gizmo'),
			missing: ids.filter((i) => !document.querySelector('#' + i))
		}), GIZMO_IDS);
		h.check(
			inMode.head && inMode.missing.length === 0,
			`the whole Gizmo & pivot section is present in ${tab.replace('mesh-mode-', '')} (${inMode.missing.join(', ') || 'all present'})`
		);
	}

	// ------------- 16. the snap row drives the APP-WIDE snapping stores
	// Deliberately the existing `snapEnabled`/`snapSettings`, not a mesh-only
	// twin: `snapping.apply()` writes onto the shared TControls instance the
	// element gizmo attaches its proxy to, so those drags already obeyed it (the
	// real-mouse proof lives in mesh-pivot-gizmo section 3b).
	const snapWas = await A.page.evaluate(() => {
		const s = window.__stores;
		let on;
		let cfg;
		s.snapping.snapEnabled.subscribe((v) => (on = v))();
		s.snapping.snapSettings.subscribe((v) => (cfg = { ...v }))();
		return { on, cfg };
	});
	const readSnap = () =>
		A.page.evaluate(() => {
			const s = window.__stores;
			let on;
			let cfg;
			let controls;
			s.snapping.snapEnabled.subscribe((v) => (on = v))();
			s.snapping.snapSettings.subscribe((v) => (cfg = { ...v }))();
			s.TControls.subscribe((c) => (controls = c))();
			return { on, cfg, translationSnap: controls?.translationSnap ?? null };
		});
	// start from a known state so the click below has somewhere to go
	await A.page.evaluate(() => window.__stores.snapping.snapEnabled.set(false));
	await A.page.waitForTimeout(250);
	await A.page.locator('#mesh-snap-enabled').click();
	await A.page.waitForTimeout(350);
	const snapOn = await readSnap();
	h.check(snapOn.on === true, 'the toolbox checkbox drives the app-wide snapEnabled store');
	h.check(
		snapOn.translationSnap === snapOn.cfg.translate,
		`...and the shared gizmo picks the step up (${snapOn.translationSnap})`
	);
	// the step field writes snapSettings — DragRow applies typing LIVE
	await A.page.evaluate(() => {
		const input = document.querySelector('#mesh-snap-translate');
		input.value = '0.25';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await A.page.waitForTimeout(350);
	const stepped = await readSnap();
	h.check(stepped.cfg.translate === 0.25, `the step field writes snapSettings.translate (${stepped.cfg.translate})`);
	h.check(stepped.translationSnap === 0.25, `...reaching the shared gizmo (${stepped.translationSnap})`);
	await A.page.evaluate(() => {
		const input = document.querySelector('#mesh-snap-rotate');
		input.value = '45';
		input.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await A.page.waitForTimeout(350);
	const angled = await readSnap();
	h.check(angled.cfg.rotateDeg === 45, `the angle field writes snapSettings.rotateDeg (${angled.cfg.rotateDeg})`);
	// the SAME store the scene panel edits — say it in the UI, and prove it here
	const note = await A.page.evaluate(() => document.querySelector('#mesh-snap-note')?.textContent?.trim() ?? '');
	h.check(/app-wide/i.test(note), `the row says it is the app-wide setting ("${note}")`);
	const shared = await A.page.evaluate(() => {
		// drive it from the OTHER end (the scene panel's store) and watch the row
		window.__stores.snapping.snapSettings.update((s) => ({ ...s, translate: 1 }));
		return new Promise((r) =>
			setTimeout(() => r(document.querySelector('#mesh-snap-translate')?.value ?? null), 250)
		);
	});
	h.check(parseFloat(shared) === 1, `and a write from anywhere else shows up in the row (${shared}) — one source of truth`);
	await A.page.evaluate((was) => {
		const s = window.__stores;
		s.snapping.snapSettings.set(was.cfg);
		s.snapping.snapEnabled.set(was.on);
	}, snapWas);
	await A.page.waitForTimeout(200);

	await A.ctx.close();

	// ---------------------------------- 7. the bottom SHEET on a phone (18-C3)
	// A floating palette you have to drag around is unusable on a phone. The
	// breakpoint is width-based, so this IS testable headlessly (the coarse-
	// pointer half of mobile behaviour is not, and is not asserted here).
	const M = await h.setupPage(browser, 'M', {
		context: { viewport: { width: 400, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
	});
	await openSession(M.page);

	const sheet = await M.page.evaluate(() => {
		const el = document.querySelector('#mesh-edit-popup');
		if (!el) return null;
		const r = el.getBoundingClientRect();
		const body = el.querySelector('.toolbox-body');
		const grip = el.querySelector('.dw-resize');
		const grab = el.querySelector('.tbx-sheet-grab');
		const tabs = el.querySelector('.tbx-tabs');
		return {
			left: Math.round(r.left),
			width: Math.round(r.width),
			bottom: Math.round(r.bottom),
			top: Math.round(r.top),
			gripHidden: !grip || getComputedStyle(grip).display === 'none',
			hasGrabber: !!grab && getComputedStyle(grab.parentElement).display !== 'none',
			bodyScrolls: getComputedStyle(body).overflowY === 'auto',
			// tabs must stay OUT of the scrolling area so they are always reachable
			tabsPinned: !body.contains(tabs)
		};
	});
	h.check(!!sheet, 'the toolbox is up on a phone-sized viewport');
	h.check(sheet.left === 0 && sheet.width === 400, `it spans the full width (left ${sheet.left}, w ${sheet.width})`);
	h.check(sheet.bottom === 800, `it is anchored to the bottom (${sheet.bottom})`);
	h.check(sheet.top > 0, `and stops below the top chrome (top ${sheet.top})`);
	h.check(sheet.gripHidden, 'the width grip is gone — a sheet has no width to drag');
	h.check(sheet.hasGrabber, 'a drag grabber takes its place');
	h.check(sheet.bodyScrolls && sheet.tabsPinned, 'the body scrolls while the tabs stay pinned');

	// the grabber resizes and the height persists
	const resized = await M.page.evaluate(async () => {
		const el = document.querySelector('#mesh-edit-popup');
		const handle = el.querySelector('.tbx-sheet-resize');
		const before = Math.round(el.getBoundingClientRect().height);
		const send = (type, y) =>
			handle.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, clientY: y }));
		send('pointerdown', window.innerHeight - before);
		send('pointermove', 300); // drag the top edge up => taller
		send('pointerup', 300);
		await new Promise((r) => setTimeout(r, 250));
		return {
			before,
			after: Math.round(el.getBoundingClientRect().height),
			stored: localStorage.getItem('tbxSheetH:meshToolbox')
		};
	});
	h.check(resized.after > resized.before, `the grabber resizes the sheet (${resized.before} -> ${resized.after})`);
	h.check(!!resized.stored, `and the height persists (${resized.stored})`);

	// back to a desktop viewport: it is a floating window again
	await M.page.setViewportSize({ width: 1200, height: 800 });
	await M.page.waitForTimeout(700);
	const backToWindow = await M.page.evaluate(() => {
		const el = document.querySelector('#mesh-edit-popup');
		const r = el.getBoundingClientRect();
		let stored = null;
		try {
			stored = JSON.parse(localStorage.getItem('win:meshToolbox') ?? 'null');
		} catch {}
		return {
			left: Math.round(r.left),
			width: Math.round(r.width),
			bottom: Math.round(r.bottom),
			sheet: el.className.includes('tbx-sheet'),
			stored
		};
	});
	h.check(!backToWindow.sheet, 'widening the viewport returns it to a floating window');
	h.check(
		backToWindow.width > 0 && backToWindow.width < 400,
		`with its own width back, not the sheet's full width (${backToWindow.width}px)`
	);
	h.check(backToWindow.bottom < 800, `and it is no longer pinned to the bottom (${backToWindow.bottom})`);
	// the sheet's geometry must never be SAVED as the window's — dragWindow is
	// suspended while the toolbox renders as a sheet
	h.check(
		!backToWindow.stored || backToWindow.stored.w === undefined || backToWindow.stored.w < 400,
		`the sheet's full-bleed width was not persisted (${JSON.stringify(backToWindow.stored)})`
	);

	await h.finish(browser);
});
