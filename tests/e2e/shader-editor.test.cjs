// SH3: the Shader dock tab. Asserts what RENDERED, not only what the stores hold — a
// component that crashes on mount is invisible to store-reading checks (helpers also
// fails the run on a render crash).
// Run: $env:APP_URL='https://localhost:5197/'; npm run e2e -- shader-editor
const h = require('./helpers.cjs');

function stats(rgba) {
	let r = 0, g = 0, b = 0, sum = 0;
	const n = rgba.length / 4;
	for (let i = 0; i < rgba.length; i += 4) {
		r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2];
		sum += (rgba[i] + rgba[i + 1] + rgba[i + 2]) / 3;
	}
	return { mean: sum / n, r: r / n, g: g / n, b: b / n };
}

h.run(async () => {
	const browser = await h.launch({
		args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist']
	});
	const peer = await h.setupPage(browser, 'shader-editor');
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.shaderGraph, { timeout: 30000 });

	// a cube, selected, with a neutral base so a colour change is unambiguous
	await page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/create box'));
	await page.waitForTimeout(1400);
	const uuid = await page.evaluate(async () => {
		const S = window.__stores;
		const read = (s) => new Promise((r) => s.subscribe((v) => r(v))());
		const group = await read(S.objectsGroup);
		const camera = await read(S.globalCamera);
		const renderer = await read(S.globalRenderer);
		const scene = await read(S.globalScene);
		const THREE = S.THREE;
		let mesh = null;
		group.traverse((n) => { if (n.isMesh && !mesh) mesh = n; });
		if (mesh.material?.color?.setRGB) mesh.material.color.setRGB(1, 1, 1);
		S.objectActions.flyTo(new THREE.Vector3(2.6, 2.0, 3.0), new THREE.Vector3(0, 0.5, 0), 400);
		S.objectActions.selectObject(mesh.uuid);
		const rt = new THREE.WebGLRenderTarget(renderer.domElement.width, renderer.domElement.height);
		window.__e = { mesh, scene, camera, renderer, rt, THREE };
		window.__e.sample = () => {
			const r = renderer, prev = r.getRenderTarget();
			r.setRenderTarget(rt);
			r.render(scene, window.__e.camera);
			r.render(scene, window.__e.camera);
			r.setRenderTarget(prev);
			const v = new THREE.Vector3();
			mesh.getWorldPosition(v); v.project(window.__e.camera);
			const W = rt.width, H = rt.height, s = 20;
			const x = Math.round((v.x * 0.5 + 0.5) * W - s / 2), y = Math.round((v.y * 0.5 + 0.5) * H - s / 2);
			if (x < 0 || y < 0 || x + s > W || y + s > H) return { px: [], onScreen: false };
			const buf = new Uint8Array(s * s * 4);
			r.readRenderTargetPixels(rt, x, y, s, s, buf);
			return { px: Array.from(buf), onScreen: true };
		};
		return mesh.uuid;
	});
	await page.waitForTimeout(1600);

	// ---- 1. the tab is REACHABLE from the UI, then renders --------------------
	// Opening it by setting the store (what this suite used to do) proves the panel
	// works and proves NOTHING about whether a user can get to it — the first build
	// shipped with no entry point at all and every check here still passed.
	await page.locator('p[title="Node editor (N)"]').click();
	await page.waitForTimeout(1200);
	// BY ID, not by its glyph: the strip's add button used to render the literal '＋' and
	// now renders a lucide <Plus> SVG with no text at all, so a hasText selector silently
	// matches nothing and this premise fails before the feature is ever exercised. The id
	// repeats once per docked panel, hence :visible — only the showing panel draws a strip.
	const addBtn = page.locator('#dock-add-view:visible').first();
	h.check(await addBtn.count() === 1, 'premise — the dock tab strip has its + button');
	await addBtn.click();
	await page.waitForTimeout(500);
	const shaderItem = page.getByRole('menuitem', { name: /Shader editor/ });
	h.check(await shaderItem.count() >= 1, 'the + menu OFFERS Shader editor (this is what was missing)');
	await shaderItem.first().click();
	await page.waitForTimeout(1200);
	await page.waitForTimeout(900);
	h.check(await page.locator('#shader-editor').count() === 1, 'the Shader tab renders in the dock');
	const scopeText = await page.locator('#shader-scope').innerText().catch(() => '');
	h.check(/own material/i.test(scopeText), 'scope follows the SELECTION: "' + scopeText + '"');
	h.check(await page.locator('#shader-empty-state').count() === 1, 'with no graph it shows ONE centred call to action');
	const occupant = await page.evaluate(
		() => new Promise((r) => window.__stores.bottomDock.dockOccupants.subscribe((o) => r(!!o.shader?.present))())
	);
	h.check(occupant, 'and it registers as a dock occupant, so it appears in the tab strip');

	// ---- 2. Create shader, through the BUTTON ---------------------------------
	const before = await page.evaluate(() => window.__e.sample().px);
	await page.locator('#shader-create-btn').click();
	await page.waitForTimeout(1200);
	h.check(await page.locator('#shader-empty-state').count() === 0, 'creating a graph replaces the empty state');
	const nodeCount = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(nodeCount === 2, 'the starter graph RENDERS its two nodes: ' + nodeCount);
	const edgeCount = await page.locator('#shader-editor .svelte-flow__edge').count();
	h.check(edgeCount === 1, 'and the edge between them: ' + edgeCount);
	const driven = await page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);
	h.check(driven, 'the object became shader-driven from the UI alone');

	// ---- 3. a param edit in the node card reaches the PICTURE ----------------
	const colourInput = page.locator('#shader-editor input[type="color"]').first();
	h.check(await colourInput.count() === 1, 'the Colour node renders a colour input');
	await colourInput.evaluate((el) => {
		el.value = '#1030e0';
		el.dispatchEvent(new Event('input', { bubbles: true }));
	});
	await page.waitForTimeout(900);
	const after = await page.evaluate(() => window.__e.sample().px);
	const sB = stats(before), sA = stats(after);
	h.check(
		sA.b > sA.r + 8 && sA.b > sB.b - 60,
		'editing the node card drives the OBJECT — r/b ' + sB.r.toFixed(1) + '/' + sB.b.toFixed(1) +
			' -> ' + sA.r.toFixed(1) + '/' + sA.b.toFixed(1) + ' (blue-dominant)'
	);

	// ---- 4. the LEFT PALETTE adds a node ------------------------------------
	h.check(await page.locator('#shader-palette').count() === 1, 'the palette sidebar renders');
	const groups = await page.locator('#shader-palette .shader-palette-group').count();
	h.check(groups >= 3, 'grouped by catalog group: ' + groups + ' groups');
	await page.locator('#shader-palette button', { hasText: 'Fresnel' }).first().click();
	await page.waitForTimeout(900);
	const afterAdd = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(afterAdd === 3, 'clicking a palette entry adds a node to the canvas: ' + afterAdd);

	// ---- 4b. RIGHT-CLICKING the pane opens the searchable add menu ----------
	const pane = await page.locator('#shader-editor .svelte-flow__pane').first().boundingBox();
	await page.mouse.click(pane.x + pane.width * 0.3, pane.y + pane.height * 0.75, { button: 'right' });
	await page.waitForTimeout(500);
	h.check((await page.locator('.ctx-filter-input').count()) >= 1, 'the pane menu carries the shared search filter');
	const rows = await page.getByRole('menuitem').count();
	h.check(rows >= 4, 'and the catalog GROUPS as submenu rows: ' + rows);
	await page.locator('.ctx-filter-input').first().fill('poster');
	await page.waitForTimeout(500);
	const matches = await page.locator('.ctx-match').count();
	h.check(matches >= 1, 'typing filters the flattened catalog: ' + matches + ' match(es) for poster');
	await page.locator('.ctx-match').first().click();
	await page.waitForTimeout(900);
	const afterMenuAdd = await page.locator('#shader-editor .svelte-flow__node').count();
	h.check(afterMenuAdd === 4, 'picking a match adds that node: ' + afterMenuAdd);

	// ---- 4c. a WIRE can be removed (right-click -> Disconnect) --------------
	const wiresBefore = await page.locator('#shader-editor .svelte-flow__edge').count();
	const wireBox = await page.locator('#shader-editor .svelte-flow__edge').first().boundingBox();
	await page.mouse.click(wireBox.x + wireBox.width / 2, wireBox.y + wireBox.height / 2, { button: 'right' });
	await page.waitForTimeout(500);
	const disconnect = page.getByRole('menuitem', { name: /Disconnect/ });
	h.check((await disconnect.count()) >= 1, 'right-clicking a wire offers Disconnect');
	await disconnect.first().click();
	await page.waitForTimeout(900);
	const wiresAfter = await page.locator('#shader-editor .svelte-flow__edge').count();
	h.check(wiresAfter === wiresBefore - 1, 'and the wire is gone: ' + wiresBefore + ' -> ' + wiresAfter);

	// ---- 5. a compile error is SHOWN, and the object keeps its material -----
	const kept = await page.evaluate((u) => {
		const S = window.__stores.shaderGraph;
		const good = window.__e.sample().px;
		S.setShaderGraphFor(u, {
			nodes: [{ id: 'm1', type: 'mix', data: {} }, { id: 's1', type: 'surface', data: {} }],
			edges: [{ id: 'e1', source: 'm1', sourceHandle: 'out', target: 's1', targetHandle: 'albedo' }]
		});
		return good;
	}, uuid);
	await page.waitForTimeout(1000);
	h.check(await page.locator('#shader-errors').count() === 1, 'a broken graph shows an error strip in the tab');
	const errText = await page.locator('#shader-errors').innerText();
	h.check(/needs its "a" input/.test(errText), 'naming the actual problem: "' + errText.trim() + '"');
	const stillGood = stats(await page.evaluate(() => window.__e.sample().px));
	const wasGood = stats(kept);
	h.check(
		Math.abs(stillGood.mean - wasGood.mean) < 3,
		'and the object keeps its last good material while the error stands (' +
			wasGood.mean.toFixed(1) + ' -> ' + stillGood.mean.toFixed(1) + ')'
	);

	// ---- 6. Detach puts it back --------------------------------------------
	await page.locator('#shader-remove').click();
	await page.waitForTimeout(900);
	h.check(await page.locator('#shader-empty-state').count() === 1, 'Detach returns the tab to its empty state');
	const afterDetach = await page.evaluate((u) => window.__stores.shaderGraph.isShaderDriven(u), uuid);
	h.check(!afterDetach, 'and the object is no longer shader-driven');

	// ---- 7. scope follows the SELECTION, with no scope control -------------
	await page.evaluate(() => window.__stores.objectActions.deselectObject());
	await page.waitForTimeout(800);
	const sceneScope = await page.locator('#shader-scope').innerText();
	h.check(/scene default/i.test(sceneScope), 'deselecting switches to the scene shader: "' + sceneScope + '"');
	h.check(
		(await page.locator('#shader-scope-scene').count()) === 0 &&
			(await page.locator('#shader-scope-object').count()) === 0,
		'and there is NO scope control to get wrong — the selection is the control'
	);
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
	await page.waitForTimeout(800);
	const backToObject = await page.locator('#shader-scope').innerText();
	h.check(/own material/i.test(backToObject), 'reselecting the object switches back: "' + backToObject + '"');

	// ---- 8. the properties sidebar ---------------------------------------
	h.check((await page.locator('#shader-props').count()) === 1, 'the properties sidebar renders');
	h.check(
		(await page.locator('#shader-props-graph').count()) === 1,
		'with NO node selected it shows the GRAPH settings (edges / background / grid / minimap)'
	);
	h.check(
		(await page.locator('#shader-props-graph select').count()) >= 2,
		'including the edge-style and background controls'
	);


	// ---- 9. the Texture node's PICKER, through the real UI -------------------
	//
	// The store-level pipeline is covered in shader-graph; what this section exists for is
	// the entry point (the SH3 lesson: the Shader tab shipped with 20 green checks and no
	// way for a user to open it). A Texture node with no picker is exactly that shape of
	// bug — the hash could only be set by a test.
	await page.evaluate((u) => window.__stores.objectActions.selectObject(u), uuid);
	await page.waitForTimeout(600);
	// a fresh graph on this object, so the section does not inherit earlier wiring
	await page.evaluate((u) => {
		const S = window.__stores.shaderGraph;
		S.setShaderGraphFor(u, {
			nodes: [
				{ id: 'tx', type: 'texture', position: { x: 80, y: 60 }, data: {} },
				{ id: 'sf', type: 'surface', position: { x: 360, y: 90 }, data: {} }
			],
			edges: [{ id: 'et', source: 'tx', sourceHandle: 'rgb', target: 'sf', targetHandle: 'albedo' }]
		});
	}, uuid);
	await page.waitForTimeout(900);

	const picker = page.locator('#shader-editor .shader-tex').first();
	h.check((await picker.count()) === 1, 'the Texture node card renders a picker');
	h.check(
		(await picker.getAttribute('data-state')) === 'empty',
		'which starts EMPTY: ' + (await picker.getAttribute('data-state'))
	);
	const fileInput = page.locator('#shader-editor .shader-tex-file').first();
	h.check((await fileInput.count()) === 1, 'with a real file input inside it');

	// Build the png IN THE PAGE with canvas.toBlob and hand the bytes back to Node, so the
	// file the input receives is a guaranteed-decodable image. A hand-assembled base64 can
	// pass the PNG signature check and still not decode — Image tolerates a broken one,
	// createImageBitmap and the texture upload do not.
	const redBytes = await page.evaluate(async () => {
		const c = document.createElement('canvas');
		c.width = 8;
		c.height = 8;
		const ctx = c.getContext('2d');
		ctx.fillStyle = 'rgb(230,20,20)';
		ctx.fillRect(0, 0, 8, 8);
		const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
		return Array.from(new Uint8Array(await blob.arrayBuffer()));
	});
	h.check(redBytes.length > 40 && redBytes[0] === 0x89, 'built a real png in-page: ' + redBytes.length + ' bytes');
	await fileInput.setInputFiles({
		name: 'picked-red.png',
		mimeType: 'image/png',
		buffer: Buffer.from(redBytes)
	});
	await page.waitForTimeout(2200);

	const picked = await page.evaluate((u) => {
		const S = window.__stores;
		const read = (st) => new Promise((r) => st.subscribe((v) => r(v))());
		return read(S.shaderGraph.shaderGraphs).then(async (all) => {
			const doc = all[u];
			const tx = (doc?.nodes ?? []).find((n) => n.type === 'texture');
			const items = await read(S.explorer.explorerItems);
			return {
				hash: tx?.data?.hash ?? null,
				inExplorer: items.some((it) => it.hash === tx?.data?.hash && it.name === 'picked-red.png'),
				resolved: !!(tx?.data?.hash && S.shaderTextures.shaderTextureFor(tx.data.hash))
			};
		});
	}, uuid);
	h.check(!!picked.hash, 'choosing a file writes a content HASH into the node: ' + String(picked.hash).slice(0, 12) + '…');
	h.check(picked.inExplorer, 'and the image is IMPORTED into the Explorer, so it is reusable and shareable');
	h.check(picked.resolved, 'the hash resolves to a decoded texture');
	h.check(
		(await picker.getAttribute('data-state')) === 'ready',
		'the picker reports itself ready: ' + (await picker.getAttribute('data-state'))
	);
	const label = await picker.locator('.shader-tex-state').innerText();
	h.check(/picked-red/i.test(label), 'and names the image it is using: "' + label.trim() + '"');

	// DROPPING an Explorer card is the other way textures are assigned everywhere else
	const dropped = await page.evaluate(async (uuid) => {
		const S = window.__stores;
		const read = (st) => new Promise((r) => st.subscribe((v) => r(v))());
		const c = document.createElement('canvas');
		c.width = 8;
		c.height = 8;
		const ctx = c.getContext('2d');
		ctx.fillStyle = 'rgb(20,20,230)';
		ctx.fillRect(0, 0, 8, 8);
		const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
		const made = await S.explorer.importFiles([new File([blob], 'dropped-blue.png', { type: 'image/png' })]);
		const item = made[0];
		const target = document.querySelector('#shader-editor .shader-tex');
		const dt = new DataTransfer();
		dt.setData('application/x-explorer-item', JSON.stringify({ id: item.id, kind: item.kind, name: item.name }));
		target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
		target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
		await new Promise((r) => setTimeout(r, 1200));
		const all = await read(S.shaderGraph.shaderGraphs);
		const doc = all[uuid];
		const tx = (doc?.nodes ?? []).find((n) => n.type === 'texture');
		return { wanted: item.hash, got: tx?.data?.hash ?? null };
	}, uuid);
	h.check(
		dropped.got === dropped.wanted,
		'DRAGGING an Explorer image onto the picker assigns it too: ' + String(dropped.got).slice(0, 12) + '…'
	);

	// clearing it goes back to the neutral state rather than leaving a dead reference
	await page.locator('#shader-editor .shader-tex-clear').first().click();
	await page.waitForTimeout(900);
	h.check(
		(await picker.getAttribute('data-state')) === 'empty',
		'and the ✕ clears it: ' + (await picker.getAttribute('data-state'))
	);


	// ---- 10. a vec2/vec3 PARAM edits as numbers, not as text -----------------
	//
	// This is a regression guard on a bug that shipped with the tab: an array-valued param
	// (Vector 2, Vector 3, and now Tiling and Panner) had no branch of its own, so it fell
	// through to the generic TEXT input. That rendered [1,1] as "1,1" and wrote the string
	// straight back - and uniformValue treats a string as a COLOUR, so a vec2 became
	// [1,1,1], which is not something three can upload to a vec2.
	await page.evaluate((u) => {
		window.__stores.shaderGraph.setShaderGraphFor(u, {
			nodes: [
				{ id: 'tl', type: 'tilingOffset', position: { x: 70, y: 60 }, data: {} },
				{ id: 'sf', type: 'surface', position: { x: 380, y: 90 }, data: {} }
			],
			// wired into albedo: an unconnected Surface is a compile ERROR, so without this
			// no material installs and there is no uniform to inspect further down
			edges: [{ id: 'e1', source: 'tl', sourceHandle: 'out', target: 'sf', targetHandle: 'albedo' }]
		});
	}, uuid);
	await page.waitForTimeout(900);

	const vecInputs = page.locator('#shader-editor .shader-vec input');
	const vecCount = await vecInputs.count();
	h.check(
		vecCount === 4,
		'a node with two vec2 params renders FOUR number fields (x/y each), not a text box: ' + vecCount
	);
	// #20 P2 made these DragRows, THE numeric field, and DragRow is `type="text"` ON
	// PURPOSE — the native number spinner fights its own arrow-key steps. The contract
	// this check defends is "a NUMERIC field per component, not the generic text fallback
	// that rendered the array as 1,1 and wrote that string back", so it now asserts the
	// things that actually carry it: a DragRow wrapper and a decimal inputmode (which is
	// also what gives touch a numeric keypad).
	const vecShape = await page.evaluate(() => {
		const first = document.querySelector('#shader-editor .shader-vec input');
		return {
			inDragRow: !!first?.closest('.dn-wrap'),
			inputmode: first?.getAttribute('inputmode') ?? null,
			// and it must be a scrub-safe field inside an xyflow card
			nodrag: !!first?.closest('.dn-wrap.nodrag')
		};
	});
	h.check(vecShape.inDragRow, 'each component is a DragRow, the app-wide numeric field');
	h.check(
		vecShape.inputmode === 'decimal',
		'with a decimal inputmode, so it is numeric and touch gets a number pad: ' + vecShape.inputmode
	);
	h.check(vecShape.nodrag, 'and carries nodrag, so scrubbing it cannot drag the node card');

	// type into the first component and check what the DOCUMENT stores
	await vecInputs.first().fill('3');
	await page.waitForTimeout(800);
	const written = await page.evaluate((u) => {
		const read = (st) => new Promise((r) => st.subscribe((v) => r(v))());
		return read(window.__stores.shaderGraph.shaderGraphs).then((all) => {
			const node = (all[u]?.nodes ?? []).find((n) => n.type === 'tilingOffset');
			return { tiling: node?.data?.tiling ?? null };
		});
	}, uuid);
	h.check(
		Array.isArray(written.tiling),
		'editing one component writes an ARRAY, never a comma string: ' + JSON.stringify(written.tiling)
	);
	h.check(
		written.tiling && written.tiling.length === 2 && written.tiling[0] === 3,
		'with the edited component set and the other one preserved: ' + JSON.stringify(written.tiling)
	);

	// and it must reach three as a 2-wide uniform, which is the part the old bug broke
	const uniformValue = await page.evaluate((u) => {
		const mat = window.__stores.shaderGraph;
		const read = (st) => new Promise((r) => st.subscribe((v) => r(v))());
		return read(window.__stores.objectsGroup).then(async (group) => {
			const obj = group.getObjectByProperty('uuid', u);
			await mat.compileAndApply(u);
			const uniforms = obj?.material?.userData?.shaderUniforms ?? {};
			const key = Object.keys(uniforms).find((k) => k.endsWith('_tiling'));
			return key ? uniforms[key].value : null;
		});
	}, uuid);
	h.check(
		Array.isArray(uniformValue) && uniformValue.length === 2 && uniformValue[0] === 3,
		'and three receives a 2-wide vec2 uniform: ' + JSON.stringify(uniformValue)
	);


	// ---- 11. the texture HOVER CARD, and the node card staying narrow --------
	//
	// A long filename must never widen the node (xyflow sizes a node to its content), so
	// the name is CLAMPED on the card and the full one lives in the hover preview. Both
	// halves of that trade are asserted here.
	await page.evaluate((u) => {
		window.__stores.shaderGraph.setShaderGraphFor(u, {
			nodes: [
				{ id: 'tx', type: 'texture', position: { x: 80, y: 60 }, data: {} },
				{ id: 'sf', type: 'surface', position: { x: 420, y: 90 }, data: {} }
			],
			edges: [{ id: 'et', source: 'tx', sourceHandle: 'rgb', target: 'sf', targetHandle: 'albedo' }]
		});
	}, uuid);
	await page.waitForTimeout(900);

	const texNode = page.locator('#shader-editor .svelte-flow__node').filter({ hasText: 'Texture' }).first();

	// A 24px two-colour image, with the corner colour VARIED per call. The bytes have to
	// differ between the two picks: a texture is content-addressed, so two files with
	// identical bytes are the same hash and the second pick would silently be a no-op
	// (which made the width comparison pass while measuring the first image twice).
	const makeBytes = (corner) =>
		page.evaluate(async (rgb) => {
			const c = document.createElement('canvas');
			c.width = 24;
			c.height = 24;
			const ctx = c.getContext('2d');
			ctx.fillStyle = 'rgb(40,180,90)';
			ctx.fillRect(0, 0, 24, 24);
			ctx.fillStyle = rgb;
			ctx.fillRect(0, 0, 12, 12);
			const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
			return Array.from(new Uint8Array(await blob.arrayBuffer()));
		}, corner);
	const pick = async (name, corner) => {
		await page.locator('#shader-editor .shader-tex-file').first().setInputFiles({
			name,
			mimeType: 'image/png',
			buffer: Buffer.from(await makeBytes(corner))
		});
		await page.waitForTimeout(2000);
		return (await texNode.boundingBox())?.width ?? 0;
	};

	// The question is not "is the filled node wider than the empty one" — it is, and it
	// should be (a thumbnail and a clear button appear). The requirement is that the width
	// does not track the NAME LENGTH, so measure a short name against a long one.
	// The property is BOUNDED, not constant: a short name legitimately gives a narrower
	// node (the label is content-sized up to its cap). What must never happen is the width
	// tracking the name — so compare a long name against a much longer one, where both are
	// past the cap, and hold an absolute ceiling as well.
	const longName = 'a-really-long-texture-filename-that-would-stretch-the-card.png';
	const longWidth = await pick(longName, 'rgb(60,80,240)');
	const absurdName = 'z'.repeat(180) + '.png';
	const absurdWidth = await pick(absurdName, 'rgb(200,40,160)');
	h.check(
		longWidth > 0 && absurdWidth > 0,
		'premise — the Texture node is measurable with both names: ' + longWidth.toFixed(0) + ' / ' + absurdWidth.toFixed(0)
	);
	h.check(
		Math.abs(absurdWidth - longWidth) <= 2,
		'a ' + absurdName.length + '-character filename is no wider than a ' + longName.length +
			'-character one: ' + longWidth.toFixed(0) + 'px vs ' + absurdWidth.toFixed(0) + 'px'
	);
	h.check(
		absurdWidth < 170,
		'and the node stays compact whatever the name: ' + absurdWidth.toFixed(0) + 'px'
	);
	// and prove the clamp is what is doing it: the label really is overflowing its box.
	// innerText cannot see this — it returns the full string whatever the CSS clips.
	const clipped = await page.locator('#shader-editor .shader-tex-state').first().evaluate((el) => ({
		scroll: el.scrollWidth,
		client: el.clientWidth
	}));
	h.check(
		clipped.scroll > clipped.client,
		'the name is genuinely clipped by the card, not merely short: content ' +
			clipped.scroll + 'px in a ' + clipped.client + 'px box'
	);

	// no card until you hover
	h.check(
		(await page.locator('[data-shader-tex-card]').count()) === 0,
		'no hover card is mounted while nothing is hovered'
	);

	await page.locator('#shader-editor .shader-tex-slot').first().hover();
	await page.waitForTimeout(500);
	const card = page.locator('[data-shader-tex-card]');
	h.check((await card.count()) === 1, 'hovering the swatch opens ONE preview card');
	// portaled to <body>: xyflow transforms its pane, and a transform makes that element
	// the containing block for position:fixed, so a card rendered in place would be
	// positioned against the panned/zoomed pane and clipped by the node
	const parentTag = await card.evaluate((el) => el.parentElement?.tagName ?? '');
	h.check(parentTag === 'BODY', 'and it is portaled to <body>, clear of the transformed pane: ' + parentTag);

	const cardText = await card.innerText();
	h.check(
		cardText.includes(absurdName),
		'the card shows the FULL filename, wrapped rather than clipped: ' +
			cardText.split('\n')[0].length + ' chars vs ' + absurdName.length + ' in the name'
	);
	h.check(/24\s*×\s*24\s*px/.test(cardText), 'with the pixel dimensions of the decoded image');
	h.check(/\d+(\.\d+)?\s*(B|KB|MB)/.test(cardText), 'and the file size');
	h.check(/repeat/i.test(cardText), 'and the wrap mode, which is what makes Tiling and Panner behave');

	// the preview must be SCALED UP, not shown at its natural 24px
	const previewBox = await card.locator('img').first().boundingBox();
	h.check(
		!!previewBox && previewBox.width > 80,
		'the preview is scaled up rather than drawn at the image size: ' + (previewBox ? previewBox.width.toFixed(0) + 'px' : 'none')
	);
	const pixelated = await card.locator('img').first().evaluate((el) => getComputedStyle(el).imageRendering);
	h.check(
		pixelated === 'pixelated',
		'a small (24px) source renders nearest-neighbour so it stays crisp when upscaled: ' + pixelated
	);
	h.check(
		await card.evaluate((el) => getComputedStyle(el).pointerEvents === 'none'),
		'the card is pointer-inert, so it cannot swallow the click that opens the file picker'
	);

	// and it goes away again
	await page.mouse.move(4, 4);
	await page.waitForTimeout(400);
	h.check((await page.locator('[data-shader-tex-card]').count()) === 0, 'leaving the swatch closes the card');

	const errs = h.pageErrors ? h.pageErrors(peer) : [];
	h.check(errs.length === 0, 'no page errors (a mount crash would be invisible to store checks): ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
