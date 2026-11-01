// fix-agenttest item 1 — EVERY LIGHT TYPE SURVIVES EVERY SAVE PATH.
// The autosave scene round-trips through GLTF, and glTF only knows directional/point/spot
// (KHR_lights_punctual): a Hemisphere, Ambient or RectArea light came back from Restore as
// an EMPTY Object3D, and the punctual three lost shadows, decay and their aim. Each light
// now rides beside the snapshot as its own toJSON (lightSnapshot.js). This suite authors
// all six types with non-default params and checks autosave/restore, the session payload,
// a .tpscene and a .tp. Counterfactual: on v1.47.0 the autosave section is red for the
// hemisphere/ambient/rectarea rows (and the punctual shadow/decay rows).
const h = require('./helpers.cjs');

const TYPES = ['ambient', 'directional', 'point', 'spot', 'hemisphere', 'rectarea'];

h.run(async () => {
	const browser = await h.launch();
	const A = await h.setupPage(browser, 'A');
	const page = A.page;

	// what a light looks like, for comparing before and after
	const READ = `(l) => ({
		type: l.type, name: l.name, isLight: !!l.isLight,
		color: l.color?.getHexString(), intensity: +l.intensity.toFixed(3),
		ground: l.groundColor?.getHexString?.() ?? null,
		distance: l.distance ?? null, decay: l.decay ?? null,
		angle: l.angle != null ? +l.angle.toFixed(3) : null, penumbra: l.penumbra ?? null,
		width: l.width ?? null, height: l.height ?? null,
		castShadow: !!l.castShadow, bias: l.shadow ? +l.shadow.bias.toFixed(5) : null,
		mapSize: l.shadow ? l.shadow.mapSize.x : null,
		pos: l.position.toArray().map((v) => +v.toFixed(3)),
		rot: l.quaternion.toArray().map((v) => +v.toFixed(3)),
		tag: l.userData?.tag ?? null
	})`;

	const authored = await page.evaluate(
		async ({ types, read }) => {
			const S = window.__stores;
			const readLight = eval(read);
			const g = await new Promise((r) => S.objectsGroup.subscribe(r)());
			const out = {};
			types.forEach((t, i) => {
				S.commandsHandler.sceneCommand('/light ' + t);
				const l = g.children[g.children.length - 1];
				l.color.setHex(0x112233 + i * 0x101010);
				l.intensity = 1.5 + i * 0.25;
				l.position.set(i, 2 + i, -i);
				l.rotation.set(0.1 * i, 0.2, 0);
				l.userData.tag = 'light-' + t;
				if (l.groundColor) l.groundColor.setHex(0x884422);
				if (l.isPointLight || l.isSpotLight) {
					l.distance = 12;
					l.decay = 1.25;
				}
				if (l.isSpotLight) {
					l.angle = 0.6;
					l.penumbra = 0.4;
				}
				if (l.isRectAreaLight) {
					l.width = 3;
					l.height = 1.5;
				}
				if (l.shadow) {
					l.castShadow = true;
					l.shadow.bias = -0.001;
					l.shadow.mapSize.set(512, 512);
				}
				out[t] = readLight(l);
			});
			// a box too, so a restore has something non-light next to them
			S.commandsHandler.sceneCommand('/create box');
			S.objectActions?.selectObject?.(null);
			return out;
		},
		{ types: TYPES, read: READ }
	);
	h.check(Object.keys(authored).length === 6, 'authored all six light types');

	/** compare the lights in the scene with what was authored, one check per type */
	const compare = async (label) => {
		const now = await page.evaluate(
			async ({ read }) => {
				const readLight = eval(read);
				const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				const out = {};
				g.traverse((o) => {
					const tag = o.userData?.tag;
					if (tag && tag.startsWith('light-')) out[tag.slice(6)] = readLight(o);
				});
				return out;
			},
			{ read: READ }
		);
		for (const t of TYPES) {
			const a = JSON.stringify(authored[t]);
			const b = JSON.stringify(now[t] ?? null);
			h.check(a === b, `${label}: the ${t} light comes back whole` + (a === b ? '' : `\n   was ${a}\n   now ${b}`));
		}
	};

	// ---- 1. AUTOSAVE -> reload -> RESTORE ----------------------------------
	const warns = [];
	page.on('console', (m) => {
		if (m.type() === 'warning' && /GLTFExporter/.test(m.text())) warns.push(m.text());
	});
	await page.evaluate(() => window.__stores.autosave.saveNow());
	h.check(warns.length === 0, 'the autosave export logs no GLTFExporter light warning: ' + JSON.stringify(warns.slice(0, 2)));
	await h.freshReload(A);
	await h.eventually(
		() => page.evaluate(() => new Promise((r) => window.__stores.autosave.restoreAvailable.subscribe((v) => r(!!v))())),
		(v) => v === true,
		'the restore offer appears after reload'
	);
	await page.evaluate(() => window.__stores.autosave.restoreSnapshot());
	await h.eventually(
		() =>
			page.evaluate(async () => {
				const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
				let n = 0;
				g.traverse((o) => o.isLight && n++);
				return n;
			}),
		(n) => n === 6,
		'the restore brings back six LIGHTS (not empty nodes)'
	);
	await compare('autosave');

	// ---- 2. SESSION payload (toJSON) -> applySession ----------------------
	const roundTrip = async (how) =>
		page.evaluate(async (how) => {
			const S = window.__stores;
			let payload = S.sessions.buildSessionPayload('lights-' + how);
			if (how === 'session') payload = JSON.parse(JSON.stringify(payload));
			if (how === 'tpscene') {
				const bytes = await S.sessions.exportSessionZip(payload, { assets: false, packs: false, flow: true });
				payload = await S.sessions.readSessionZip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
			}
			if (how === 'tp') {
				const res = await S.projectFile.exportProjectFromSession(payload);
				const bytes = res.bytes ?? res;
				const { unzipSync } = await import(/* @vite-ignore */ '/node_modules/.vite/deps/fflate.js');
				const entries = unzipSync(new Uint8Array(bytes));
				const name = Object.keys(entries).find((k) => k.endsWith('.tpscene'));
				const scene = entries[name];
				payload = await S.sessions.readSessionZip(scene.buffer.slice(scene.byteOffset, scene.byteOffset + scene.byteLength));
			}
			await S.sessions.applySession(payload, { backup: false });
			return true;
		}, how);
	for (const how of ['session', 'tpscene', 'tp']) {
		const ok = await roundTrip(how).catch((e) => String(e));
		h.check(ok === true, `${how}: saved and loaded back` + (ok === true ? '' : ': ' + ok));
		await h.eventually(
			() =>
				page.evaluate(async () => {
					const g = await new Promise((r) => window.__stores.objectsGroup.subscribe(r)());
					let n = 0;
					g.traverse((o) => o.isLight && String(o.userData?.tag ?? '').startsWith('light-') && n++);
					return n;
				}),
			(n) => n === 6,
			`${how}: six lights in the loaded scene`,
			20000
		);
		await compare(how);
	}

	const errs = h.pageErrors ? h.pageErrors(A) : [];
	h.check(errs.length === 0, 'no page errors: ' + JSON.stringify(errs.slice(0, 3)));
	await h.finish(browser);
});
