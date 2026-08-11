// Painting must not silently re-map an IMPORTED texture.
//
// install() and applyMap() replace material.map preserving only colorSpace, so on
// the first stroke over a GLB three things changed at once:
//   1. flipY  false (glTF convention) -> true  = the image flips vertically
//   2. wrap   RepeatWrapping (glTF default) -> ClampToEdge = tiling stops, edges smear
//   3. aspect a square POT canvas built from max(w,h) STRETCHED a 2:1 texture
// Any one of them reads as "the UV map broke".
//
// The ORIENTATION check below is also the arbiter for a genuine ambiguity: with
// flipY preserved as false, does the stroke's canvas-y stay (1-v) or become v?
// Reasoning went both ways, so the test decides - paint a known UV quadrant and
// require the paint to land where that quadrant SAMPLES from.
const h = require('./helpers.cjs');

/** an imported-style textured mesh: flipY=false + RepeatWrapping, and a texture
 * with four distinct quadrants so orientation is observable. `w` x `hgt` lets the
 * same helper build a non-square texture. */
const importedMesh = (page, w = 64, hgt = 64) =>
	page.evaluate(
		async ({ w: tw, hgt: th }) => {
			const s = window.__stores;
			const c = document.createElement('canvas');
			c.width = tw;
			c.height = th;
			const ctx = c.getContext('2d');
			// TOP-LEFT red, TOP-RIGHT green, BOTTOM-LEFT blue, BOTTOM-RIGHT yellow
			ctx.fillStyle = '#ff0000'; ctx.fillRect(0, 0, tw / 2, th / 2);
			ctx.fillStyle = '#00ff00'; ctx.fillRect(tw / 2, 0, tw / 2, th / 2);
			ctx.fillStyle = '#0000ff'; ctx.fillRect(0, th / 2, tw / 2, th / 2);
			ctx.fillStyle = '#ffff00'; ctx.fillRect(tw / 2, th / 2, tw / 2, th / 2);
			const tex = new s.THREE.CanvasTexture(c);
			tex.colorSpace = s.THREE.SRGBColorSpace;
			// what GLTFLoader does to every imported texture
			tex.flipY = false;
			tex.wrapS = s.THREE.RepeatWrapping;
			tex.wrapT = s.THREE.RepeatWrapping;
			tex.anisotropy = 4;
			const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
			const mesh = new s.THREE.Mesh(
				new s.THREE.BoxGeometry(1, 1, 1),
				new s.THREE.MeshStandardMaterial({ map: tex })
			);
			mesh.name = 'importedish';
			g.add(mesh);
			s.objectsGroup.update((v) => v);
			s.objectActions.selectObject(mesh.uuid);
			s.uvEditorClose.set(false);
			s.bottomDock.activateDock('uv');
			return mesh.uuid;
		},
		{ w, hgt }
	);

/** the live map's sampler state */
const mapState = (page, uuid) =>
	page.evaluate(async (uuid) => {
		const s = window.__stores;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const m = g.getObjectByProperty('uuid', uuid).material;
		const t = m.map;
		return t
			? {
					flipY: t.flipY,
					repeatWrap: t.wrapS === s.THREE.RepeatWrapping && t.wrapT === s.THREE.RepeatWrapping,
					anisotropy: t.anisotropy,
					w: t.image?.width ?? 0,
					hgt: t.image?.height ?? 0
				}
			: null;
	}, uuid);

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');

	// ---------- 1. sampler state survives a stroke ----------
	const uuid = await importedMesh(A.page);
	await A.page.waitForTimeout(700);
	const before = await mapState(A.page, uuid);
	h.check(
		before.flipY === false && before.repeatWrap,
		`premise: an imported-style texture is flipY=false + RepeatWrapping (${before.flipY}, ${before.repeatWrap})`
	);

	await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		await s.uvEditor.beginPaintStroke(uuid, 0);
		for (let i = 0; i <= 6; i++) s.uvEditor.paintMove(0.55 + i * 0.05, 0.8, '#ffffff', 10);
		s.uvEditor.endPaintStroke('#ffffff', 10);
		await new Promise((r) => setTimeout(r, 900));
	}, uuid);
	const after = await mapState(A.page, uuid);
	h.check(after.flipY === false, `THE BUG: flipY survives the stroke (${before.flipY} -> ${after.flipY})`);
	h.check(after.repeatWrap, `THE BUG: RepeatWrapping survives the stroke (${after.repeatWrap})`);
	h.check(after.anisotropy === before.anisotropy, `anisotropy survives (${before.anisotropy} -> ${after.anisotropy})`);

	// ---------- 2. ORIENTATION: the arbiter ----------
	// The stroke above was painted at v=0.8, u~0.55-0.85 - the TOP-RIGHT of UV
	// space. For a flipY=false texture, v=0 samples the image's TOP row, so v=0.8
	// samples NEAR THE BOTTOM of the image: the stroke must land in the image's
	// BOTTOM-RIGHT quadrant, which started YELLOW.
	const landed = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const url = g.getObjectByProperty('uuid', uuid).material.userData.mapDataUrl;
		const img = await new Promise((res, rej) => {
			const i = new Image();
			i.onload = () => res(i);
			i.onerror = rej;
			i.src = url;
		});
		const c = document.createElement('canvas');
		c.width = img.width;
		c.height = img.height;
		c.getContext('2d').drawImage(img, 0, 0);
		const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
		// count near-white per image quadrant
		const q = { tl: 0, tr: 0, bl: 0, br: 0 };
		for (let y = 0; y < c.height; y++)
			for (let x = 0; x < c.width; x++) {
				const i = (y * c.width + x) * 4;
				if (data[i] > 230 && data[i + 1] > 230 && data[i + 2] > 230) {
					const key = (y < c.height / 2 ? 't' : 'b') + (x < c.width / 2 ? 'l' : 'r');
					q[key]++;
				}
			}
		return { q, w: c.width, hgt: c.height };
	}, uuid);
	const q = landed.q;
	h.check(
		q.br > 20,
		`ORIENTATION: a stroke at v=0.8 on a flipY=false texture lands in the image's BOTTOM-right (br=${q.br}, tr=${q.tr}, tl=${q.tl}, bl=${q.bl})`
	);
	h.check(
		q.br > q.tr * 3,
		`...and NOT mirrored into the top-right (br=${q.br} vs tr=${q.tr})`
	);

	// ---------- 3. a non-square texture keeps its aspect ----------
	await A.page.evaluate(() => window.__stores.commandsHandler.sceneCommand('/clear all'));
	await A.page.waitForTimeout(400);
    const wideUuid = await importedMesh(A.page, 128, 64);
	await A.page.waitForTimeout(600);
	await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		await s.uvEditor.beginPaintStroke(uuid, 0);
		for (let i = 0; i <= 4; i++) s.uvEditor.paintMove(0.3 + i * 0.05, 0.5, '#ffffff', 8);
		s.uvEditor.endPaintStroke('#ffffff', 8);
		await new Promise((r) => setTimeout(r, 900));
	}, wideUuid);
	const wide = await mapState(A.page, wideUuid);
	h.check(
		wide.w === wide.hgt * 2,
		`THE BUG: a 2:1 texture stays 2:1 through a stroke (${wide.w}x${wide.hgt})`
	);

	// ---------- 4. a cancelled stroke restores the original map ----------
	const cancelled = await A.page.evaluate(async (uuid) => {
		const s = window.__stores;
		const g = await new Promise((r) => s.objectsGroup.subscribe(r)());
		const mesh = g.getObjectByProperty('uuid', uuid);
		const original = mesh.material.map;
		await s.uvEditor.beginPaintStroke(uuid, 0);
		s.uvEditor.paintMove(0.5, 0.5, '#000000', 20);
		s.uvEditor.cancelPaintStroke();
		await new Promise((r) => setTimeout(r, 250));
		return { restored: mesh.material.map === original };
	}, wideUuid);
	h.check(cancelled.restored, 'THE BUG: cancelling a stroke puts the original texture back');

	await h.finish(browser);
});
