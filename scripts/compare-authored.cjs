// 24-A A3: prove two authored trees are the SAME CONTENT.
//
//   node scripts/compare-authored.cjs <before-dir> <after-dir> [--only <slug[,slug]>]
//
// For every `<section>/<slug>/scene.tpscene` under <before-dir>, the same file must exist
// under <after-dir> and their session.json must agree once the things a build mints
// afresh every run are canonicalised:
//   · the session `id`, `createdAt`, `appVersion` and the inline `thumbnail` (an offscreen
//     render is not bit-stable across GPU drivers — its byte LENGTH is reported instead),
//   · every `changedAt` / `startedAt` / `at` stamp (latest-wins bookkeeping, not content),
//   · every uuid, replaced by `uuid#<n>` in order of FIRST APPEARANCE — so a graph's
//     remapped `selected`/`uuid`/`camera` references still have to point at the same
//     objects in the same order, which is exactly what the remap change must preserve.
// `thumb.webp` is compared by size within 25%, and the index.json row (if both trees
// carry one) with `bytes` dropped. Exit 0 = identical, 1 = a difference (printed).
const fs = require('fs');
const path = require('path');
const { unzipSync } = require('fflate');

const [beforeDir, afterDir] = process.argv.slice(2, 4).map((p) => p && path.resolve(p));
if (!beforeDir || !afterDir) {
	console.error('usage: node scripts/compare-authored.cjs <before-dir> <after-dir>');
	process.exit(2);
}
const onlyFlag = process.argv.indexOf('--only');
const ONLY = onlyFlag !== -1 ? String(process.argv[onlyFlag + 1] ?? '').split(',').filter(Boolean) : null;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const STAMP_KEYS = new Set(['changedAt', 'startedAt', 'at', 'createdAt']);

/** @param {any} value @param {Map<string, string>} uuids @param {string} key */
function canon(value, uuids, key = '') {
	if (typeof value === 'string') {
		return value.replace(UUID, (u) => {
			if (!uuids.has(u)) uuids.set(u, 'uuid#' + uuids.size);
			return uuids.get(u) ?? u;
		});
	}
	if (typeof value === 'number' && STAMP_KEYS.has(key)) return 0;
	if (Array.isArray(value)) return value.map((v) => canon(v, uuids, key));
	if (value && typeof value === 'object') {
		/** @type {Record<string, any>} */ const out = {};
		for (const k of Object.keys(value)) out[k] = canon(value[k], uuids, k);
		return out;
	}
	return value;
}

/** @param {string} file */
function readScene(file) {
	const zip = unzipSync(new Uint8Array(fs.readFileSync(file)));
	const entries = Object.keys(zip).sort();
	const session = JSON.parse(Buffer.from(zip['session.json']).toString('utf8'));
	const thumbLen = typeof session.thumbnail === 'string' ? session.thumbnail.length : 0;
	const { id, createdAt, appVersion, thumbnail, ...rest } = session;
	const others = {};
	for (const name of entries) if (name !== 'session.json') others[name] = Buffer.from(zip[name]).toString('utf8');
	return { entries, thumbLen, canonical: canon(rest, new Map()), others };
}

/** @param {string} dir @returns {string[]} */
function scenes(dir) {
	/** @type {string[]} */ const out = [];
	const walk = (d) => {
		for (const name of fs.readdirSync(d)) {
			const p = path.join(d, name);
			if (fs.statSync(p).isDirectory()) walk(p);
			else if (name === 'scene.tpscene') out.push(path.relative(dir, p));
		}
	};
	walk(dir);
	return out.sort();
}

/** first differing line of two JSON dumps @param {string} a @param {string} b */
function firstDiff(a, b) {
	const la = a.split('\n');
	const lb = b.split('\n');
	for (let i = 0; i < Math.max(la.length, lb.length); i++)
		if (la[i] !== lb[i]) return { line: i + 1, before: la[i] ?? '<end>', after: lb[i] ?? '<end>' };
	return null;
}

let failures = 0;
const list = scenes(beforeDir).filter((rel) => !ONLY || ONLY.some((slug) => rel.includes(path.sep + slug + path.sep)));
if (!list.length) {
	console.error('no scene.tpscene under ' + beforeDir);
	process.exit(2);
}
for (const rel of list) {
	const a = path.join(beforeDir, rel);
	const b = path.join(afterDir, rel);
	if (!fs.existsSync(b)) {
		console.log('MISSING ' + rel + ' in ' + afterDir);
		failures++;
		continue;
	}
	const A = readScene(a);
	const B = readScene(b);
	const ja = JSON.stringify(A.canonical, null, 1);
	const jb = JSON.stringify(B.canonical, null, 1);
	const diff = ja === jb ? null : firstDiff(ja, jb);
	const entriesSame = JSON.stringify(A.entries) === JSON.stringify(B.entries);
	const othersSame = JSON.stringify(A.others) === JSON.stringify(B.others);
	const thumbOk = A.thumbLen === 0 ? B.thumbLen === 0 : Math.abs(A.thumbLen - B.thumbLen) / A.thumbLen < 0.25;
	const dir = path.dirname(rel);
	const thumbA = path.join(beforeDir, dir, 'thumb.webp');
	const thumbB = path.join(afterDir, dir, 'thumb.webp');
	const sizeA = fs.existsSync(thumbA) ? fs.statSync(thumbA).size : 0;
	const sizeB = fs.existsSync(thumbB) ? fs.statSync(thumbB).size : 0;
	const webpOk = sizeA === 0 ? sizeB === 0 : Math.abs(sizeA - sizeB) / sizeA < 0.25;
	const ok = !diff && entriesSame && othersSame && thumbOk && webpOk;
	console.log((ok ? 'SAME ' : 'DIFF ') + rel + ' (' + ja.length + ' canonical chars, thumb ' + A.thumbLen + '/' + B.thumbLen + ', webp ' + sizeA + '/' + sizeB + ')');
	if (diff) console.log('  first difference at canonical line ' + diff.line + ':\n    before: ' + diff.before + '\n    after:  ' + diff.after);
	if (!entriesSame) console.log('  zip entries differ: ' + A.entries.join(',') + ' vs ' + B.entries.join(','));
	if (!othersSame) console.log('  a non-session entry differs');
	if (!thumbOk || !webpOk) console.log('  thumbnail size drifted more than 25%');
	if (!ok) failures++;
}
// the index rows, when both trees carry an index.json
const ia = path.join(beforeDir, 'index.json');
const ib = path.join(afterDir, 'index.json');
if (fs.existsSync(ia) && fs.existsSync(ib)) {
	const strip = (idx) => JSON.stringify(idx, (k, v) => (k === 'bytes' ? undefined : v));
	const same = strip(JSON.parse(fs.readFileSync(ia, 'utf8'))) === strip(JSON.parse(fs.readFileSync(ib, 'utf8')));
	console.log((same ? 'SAME ' : 'DIFF ') + 'index.json (bytes dropped)');
	if (!same) failures++;
}
process.exit(failures ? 1 : 0);
