// 102 — FILE COMPATIBILITY for a lane that touches the save file and sync (the 21 Nov battery rule).
// One page opens a .tpscene and writes a FINGERPRINT of what loaded (per object: uuid, name, pose,
// triangle count, vertex channels, userData keys) plus the scene RE-SAVED as a payload with its
// volatile fields stripped. The same file run on two builds and the two outputs compared proves:
//   · an OLD scene loads unchanged and re-saves identically (feature unused = zero change);
//   · a file SAVED BY THIS LANE (simplify-export writes test-results/simplify-export/simplified.tpscene)
//     opens in the newest release with the simplified triangle count.
// Env: COMPAT_IN = the .tpscene (default POOL_TPSCENE), COMPAT_OUT = the fingerprint json (default test-results/); COMPAT_EXPECT (optional) = a json
// {uuid, tris} the loaded scene must hold.
const h = require('./helpers.cjs');
const fs = require('fs');

const IN = process.env.COMPAT_IN || process.env.POOL_TPSCENE;
const OUT = process.env.COMPAT_OUT || require('path').join(process.cwd(), 'test-results', 'simplify-file-compat', 'fingerprint.json');
if (OUT) fs.mkdirSync(require('path').dirname(OUT), { recursive: true });
const EXPECT = process.env.COMPAT_EXPECT ? JSON.parse(fs.readFileSync(process.env.COMPAT_EXPECT, 'utf8')) : null;

h.run(async () => {
	if (!IN || !OUT) throw new Error('COMPAT_IN (or POOL_TPSCENE) is required');
	const browser = await h.launch({ args: h.GPU_ARGS });
	const A = await h.setupPage(browser, 'A');
	const bytes = [...fs.readFileSync(IN)];
	const ok = await A.page.evaluate(async (bytes) => {
		const ss = window.__tp.test.v1.sessions;
		const payload = await ss.readSessionZip(new Uint8Array(bytes).buffer);
		if (!payload) return false;
		await ss.applySession(payload, { backup: false });
		return true;
	}, bytes);
	h.check(ok, `the file opened (${require('path').basename(IN)})`);

	const fingerprint = () =>
		A.page.evaluate(() => {
			const s = window.__tp.test.v1;
			let g;
			s.objectsGroup.subscribe((x) => (g = x))();
			const r = (n) => Math.round(n * 1000) / 1000;
			return (g?.children ?? [])
				.map((o) => {
					let tris = 0;
					const channels = new Set();
					o.traverse((m) => {
						if (!m.isMesh || !m.geometry?.attributes?.position) return;
						const geo = m.geometry;
						tris += Math.floor((geo.index ? geo.index.count : geo.attributes.position.count) / 3);
						for (const k of Object.keys(geo.attributes)) channels.add(k);
					});
					return {
						uuid: o.uuid,
						name: o.name,
						pose: [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()].map(r),
						tris,
						channels: [...channels].sort(),
						userData: Object.keys(o.userData).filter((k) => !k.startsWith('__')).sort()
					};
				})
				.sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
		});
	// settled = the same fingerprint twice, 3 s apart (models parse after applySession resolves)
	let prev = '';
	let objects = [];
	for (let i = 0; i < 40; i++) {
		objects = await fingerprint();
		const now = JSON.stringify(objects);
		if (now === prev && objects.length) break;
		prev = now;
		await A.page.waitForTimeout(3000);
	}
	h.check(objects.length > 0, `objects loaded (${objects.length}, ${objects.reduce((a, o) => a + o.tris, 0)} triangles)`);

	const resaved = await A.page.evaluate(() => {
		const p = window.__tp.test.v1.sessions.buildSessionPayload('compat');
		const VOLATILE = new Set(['id', 'uuid', 'createdAt', 'updatedAt', 'savedAt', 'thumbnail', 'changedAt', 'startedAt', 'at', 'name', 'appVersion', 'version', 'build']);
		const strip = (v, depth) => {
			if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
			if (v && typeof v === 'object') {
				/** @type {any} */
				const o = {};
				for (const k of Object.keys(v).sort()) if (!(depth === 0 && VOLATILE.has(k)) && k !== 'changedAt' && k !== 'startedAt') o[k] = strip(v[k], depth + 1);
				return o;
			}
			return v;
		};
		const out = strip(p, 0);
		// objects are GLTF/JSON blobs: keep their size and a cheap hash, not megabytes of base64
		const hash = (str) => {
			let x = 2166136261;
			for (let i = 0; i < str.length; i++) x = Math.imul(x ^ str.charCodeAt(i), 16777619) >>> 0;
			return x.toString(16);
		};
		for (const k of Object.keys(out)) {
			const j = JSON.stringify(out[k]);
			if (j && j.length > 4096) out[k] = { bytes: j.length, hash: hash(j) };
		}
		return out;
	});
	if (EXPECT) {
		const hit = objects.find((o) => o.uuid === EXPECT.uuid);
		h.check(hit?.tris === EXPECT.tris, `the lane's simplified object opened with its ${EXPECT.tris} triangles (${hit?.tris ?? 'missing'})`);
		h.check(!!hit?.channels?.includes('uv') && !!hit?.channels?.includes('normal'), `...and its uv + normal (${hit?.channels})`);
	}
	fs.writeFileSync(OUT, JSON.stringify({ objects, resaved }, null, 1));
	h.check(true, `fingerprint written (${OUT})`);
	await h.finish(browser);
});
