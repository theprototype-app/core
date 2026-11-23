// 102 — Gaussian splat e2e fixtures and page helpers, shared by splats / splats-reduce. The fixtures are
// made HERE, procedurally (a coloured shell of splats): no scan data in the repo.
const h = require('./helpers.cjs');

// ---- procedural fixtures ----------------------------------------------------------------------

/** a deterministic PRNG (mulberry32) @param {number} seed */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** n points on a shell of radius r around [0, 0.5, 0], coloured by height @param {number} n @param {number} seed */
function shell(n, seed = 7, r = 0.5) {
	const rand = rng(seed);
	const pts = [];
	for (let i = 0; i < n; i++) {
		const u = rand() * 2 - 1;
		const t = rand() * Math.PI * 2;
		const s = Math.sqrt(1 - u * u);
		const x = r * s * Math.cos(t);
		const y = 0.5 + r * u;
		const z = r * s * Math.sin(t);
		pts.push({ x, y, z, cr: 0.9, cg: 0.2 + 0.6 * ((u + 1) / 2), cb: 0.1 });
	}
	return pts;
}

/** the antimatter15 .splat layout: 32 bytes per splat @param {number} n */
function splatFile(n) {
	const buf = Buffer.alloc(n * 32);
	shell(n).forEach((p, i) => {
		const o = i * 32;
		buf.writeFloatLE(p.x, o);
		buf.writeFloatLE(p.y, o + 4);
		buf.writeFloatLE(p.z, o + 8);
		for (let k = 0; k < 3; k++) buf.writeFloatLE(0.03, o + 12 + k * 4);
		buf[o + 24] = Math.round(p.cr * 255);
		buf[o + 25] = Math.round(p.cg * 255);
		buf[o + 26] = Math.round(p.cb * 255);
		buf[o + 27] = 255;
		buf[o + 28] = 255; // rotation w = 1 (128 + 127)
		buf[o + 29] = 128;
		buf[o + 30] = 128;
		buf[o + 31] = 128;
	});
	return buf;
}

/** a 3DGS .ply (binary, SH degree `sh`) @param {number} n @param {number} sh */
function gaussianPly(n, sh = 0) {
	const rest = [0, 9, 24, 45][sh];
	const props = ['x', 'y', 'z', 'nx', 'ny', 'nz', 'f_dc_0', 'f_dc_1', 'f_dc_2', ...Array.from({ length: rest }, (_, i) => 'f_rest_' + i), 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
	const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => 'property float ' + p).join('\n')}\nend_header\n`;
	const head = Buffer.from(header, 'ascii');
	const body = Buffer.alloc(n * props.length * 4);
	const C0 = 0.28209479177387814;
	let o = 0;
	const w = (/** @type {number} */ v) => {
		body.writeFloatLE(v, o);
		o += 4;
	};
	for (const p of shell(n, 11)) {
		w(p.x), w(p.y), w(p.z), w(0), w(0), w(0);
		w((p.cr - 0.5) / C0), w((p.cg - 0.5) / C0), w((p.cb - 0.5) / C0);
		for (let i = 0; i < rest; i++) w(0.01 * ((i % 5) - 2));
		w(4); // logit opacity: ~0.98
		w(Math.log(0.03)), w(Math.log(0.03)), w(Math.log(0.03));
		w(1), w(0), w(0), w(0);
	}
	return Buffer.concat([head, body]);
}

const MESH_PLY = Buffer.from(
	'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n',
	'ascii'
);

// ---- page helpers -----------------------------------------------------------------------------

/** @param {any} page */
const dbg = (page) => page.evaluate(() => window.__tp.test.v1.splatTick.splatDebug());
/** @param {any} page */
const carriers = (page) =>
	page.evaluate(() => {
		let g;
		window.__tp.test.v1.objectsGroup.subscribe((v) => (g = v))();
		const out = [];
		g.traverse((o) => {
			if (o.isMesh && o.userData?.splat) {
				o.geometry.computeBoundingBox();
				const b = o.geometry.boundingBox;
				out.push({ uuid: o.uuid, name: o.name, splat: JSON.parse(JSON.stringify(o.userData.splat)), box: [...b.min.toArray(), ...b.max.toArray()], pos: o.position.toArray() });
			}
		});
		return out;
	});
/** @param {any} page */
const items = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__tp.test.v1.explorer.explorerItems.subscribe((x) => (v = x))();
		return v.map((it) => ({ id: it.id, name: it.name, kind: it.kind, size: it.size, hash: it.hash }));
	});
/** @param {any} page */
const toasts = (page) =>
	page.evaluate(() => {
		let v = [];
		window.__tp.test.v1.toastStore.subscribe((x) => (v = x))();
		return v.map((t) => String(typeof t === 'string' ? t : (t?.text ?? '')));
	});
/** a real viewport drop of one file (App.svelte handleDrop: the splat route) @param {any} page @param {string} name @param {Buffer} buffer */
const pick = (page, name, buffer) =>
	page.evaluate(
		([n, b]) => {
			const bin = atob(b);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], n, { type: 'application/octet-stream' }));
			let renderer;
			window.__tp.test.v1.globalRenderer.subscribe((r) => (renderer = r))();
			const canvas = renderer.domElement; // the 3D view's own canvas (a panel's canvas is not the viewport)
			const r = canvas.getBoundingClientRect();
			const ev = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 });
			canvas.dispatchEvent(ev);
			return { handled: ev.defaultPrevented, files: dt.files.length, inDom: document.contains(canvas) };
		},
		[name, buffer.toString('base64')]
	).then((r) => {
		console.log(`  drop ${name}: ${JSON.stringify(r)}`);
		return r;
	});
/** @param {any} page @param {string} uuid */
const entry = async (page, uuid) => (await dbg(page)).entries.find((/** @type {any} */ e) => e.uuid === uuid) ?? null;
const near = (/** @type {number} */ a, /** @type {number} */ b, eps = 0.06) => Math.abs(a - b) <= eps;
/** h.eventually that hands back the value it settled on @template T @param {() => Promise<T>} fn @param {(v: T) => boolean} pred @param {string} label @param {number} [timeout] @returns {Promise<T>} */
async function until(fn, pred, label, timeout = 10000) {
	/** @type {any} */
	let last;
	await h.eventually(async () => (last = await fn()), pred, label, timeout);
	return last;
}


module.exports = { rng, shell, splatFile, gaussianPly, MESH_PLY, dbg, carriers, items, toasts, pick, entry, near, until };
