#!/usr/bin/env node
// 101-schema step 1 — WHAT OBJECT AND MATERIAL JSON THIS APP ACTUALLY MAKES, SENDS AND SAVES.
//
// Roadmap 101 F2 puts one allowlist (src/lib/sceneSchema.js) in front of every ObjectLoader /
// parseMaterials call fed by a peer or a file. An allowlist is only safe to ship if nothing real
// falls outside it, so this script is the evidence it is written from and the fixture list its
// "0 drops on real content" proof runs over. Two halves:
//
//   (a) SOURCE — what the app can SEND: the `objectParameters` parameters it emits, the three
//       classes it constructs (objects / materials / geometries / textures), and every `userData`
//       key read or written in src/ (and the modules repo when MODULES_REPO is set: modules create
//       objects too).
//   (b) CONTENT — what is SAVED: every ObjectLoader JSON (`metadata.type === 'Object'`) found
//       anywhere inside every .tpscene / .tp / .json given. For each: object, material, geometry
//       and texture TYPES with the FIELDS seen on each, the IMAGE forms (data: mime, asset ref,
//       URL, typed-array image), and every userData key with its JSON shape and largest size.
//
//   node scripts/schema-inventory.cjs [path ...]          # dirs are walked for .tpscene/.tp/.json
//   node scripts/schema-inventory.cjs --out <file.json>   # also write the machine-readable result
//   node scripts/schema-inventory.cjs --md <file.md>      # and a markdown summary
//
// Defaults when no path is given: static/templates, tests/fixtures, and $SCENES_DIR when set.
// Pure Node + fflate (already a dependency); reads files only, never the network.

const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const ROOT = path.resolve(__dirname, '..');

/** a stable label for a path: repo-relative, or `scenes@<ref>/…` under $SCENES_DIR (an extracted scenes repo)
 * @param {string} p */
const rel = (p) => {
	const scenes = process.env.SCENES_DIR ? path.resolve(process.env.SCENES_DIR) : null;
	if (scenes && (p === scenes || p.startsWith(scenes + path.sep)))
		return 'scenes@' + (process.env.SCENES_REF || 'local') + (p === scenes ? '' : '/' + path.relative(scenes, p));
	return path.relative(ROOT, p) || p;
};

// ---------------------------------------------------------------------------------------------
// (a) SOURCE
// ---------------------------------------------------------------------------------------------

/** every .js / .svelte / .ts file under a dir (no node_modules, no build output) @param {string} dir */
function sourceFiles(dir) {
	/** @type {string[]} */
	const out = [];
	/** @param {string} d */
	const walk = (d) => {
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			if (e.name === 'node_modules' || e.name.startsWith('.') || e.name === 'build' || e.name === 'dist') continue;
			const p = path.join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (/\.(js|mjs|cjs|ts|svelte)$/.test(e.name)) out.push(p);
		}
	};
	if (fs.existsSync(dir)) walk(dir);
	return out;
}

/** @param {Map<string, Set<string>>} map @param {string} key @param {string} where */
function note(map, key, where) {
	if (!map.has(key)) map.set(key, new Set());
	/** @type {Set<string>} */ (map.get(key)).add(where);
}

const OBJECT_CTORS = new Set([
	'Object3D', 'Scene', 'Group', 'Mesh', 'SkinnedMesh', 'InstancedMesh', 'BatchedMesh', 'LOD', 'Line', 'LineLoop',
	'LineSegments', 'Points', 'Sprite', 'Bone', 'PerspectiveCamera', 'OrthographicCamera', 'AmbientLight',
	'DirectionalLight', 'PointLight', 'RectAreaLight', 'SpotLight', 'HemisphereLight', 'LightProbe'
]);

/** @param {string[]} files @param {string} label */
function scanSource(files, label) {
	/** @type {Map<string, Set<string>>} */ const parameters = new Map();
	/** @type {Map<string, Set<string>>} */ const appliedParameters = new Map();
	/** @type {Map<string, Set<string>>} */ const objects = new Map();
	/** @type {Map<string, Set<string>>} */ const materials = new Map();
	/** @type {Map<string, Set<string>>} */ const geometries = new Map();
	/** @type {Map<string, Set<string>>} */ const textures = new Map();
	/** @type {Map<string, Set<string>>} */ const userData = new Map();
	/** @type {Map<string, Set<string>>} */ const loaderCalls = new Map();
	for (const file of files) {
		const text = fs.readFileSync(file, 'utf8');
		const where = label + ':' + path.relative(label === 'core' ? ROOT : process.env.MODULES_REPO || ROOT, file);
		for (const m of text.matchAll(/parameter:\s*'(\w+)'/g)) note(parameters, m[1], where);
		for (const m of text.matchAll(/parameter\s*===?\s*'(\w+)'/g)) note(appliedParameters, m[1], where);
		for (const m of text.matchAll(/new\s+(?:THREE\.)?(\w+)\s*\(/g)) {
			const c = m[1];
			if (OBJECT_CTORS.has(c)) note(objects, c, where);
			else if (/Material$/.test(c) && /^[A-Z]/.test(c)) note(materials, c, where);
			else if (/Geometry$/.test(c) && /^[A-Z]/.test(c)) note(geometries, c, where);
			else if (/Texture$/.test(c) && /^[A-Z]/.test(c)) note(textures, c, where);
		}
		// userData.key / userData?.key / userData['key'] / userData["key"]
		for (const m of text.matchAll(/userData\??\.(?!\?)([A-Za-z_$][\w$]*)/g)) note(userData, m[1], where);
		for (const m of text.matchAll(/userData\??\.?\[\s*['"]([^'"\]]+)['"]\s*\]/g)) note(userData, m[1], where);
		for (const m of text.matchAll(/(new\s+(?:THREE\.)?ObjectLoader\(\)|\.parseMaterials\(|new\s+(?:THREE\.)?MaterialLoader\(|\.parseTextures\(|\.parseImages\(|\.parseGeometries\(|\.parseObject\()/g))
			note(loaderCalls, m[1].replace(/\s+/g, ' '), where);
	}
	return { parameters, appliedParameters, objects, materials, geometries, textures, userData, loaderCalls };
}

// ---------------------------------------------------------------------------------------------
// (b) CONTENT
// ---------------------------------------------------------------------------------------------

/** a JSON value's shape, one level deep for objects (key list) @param {any} v @returns {string} */
function shapeOf(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) {
		const inner = new Set(v.slice(0, 50).map((x) => (x === null ? 'null' : Array.isArray(x) ? 'array' : typeof x)));
		return 'array<' + ([...inner].sort().join('|') || 'empty') + '>';
	}
	if (typeof v === 'object') return 'object{' + Object.keys(v).sort().join(',') + '}';
	return typeof v;
}

/** how an image is carried @param {any} url */
function imageForm(url) {
	if (typeof url === 'string') {
		const d = /^data:([^;,]*)[;,]/.exec(url);
		if (d) return 'data:' + (d[1] || '(none)');
		if (/^blob:/.test(url)) return 'blob-url';
		if (/^https?:/i.test(url)) return 'http-url';
		if (/^[0-9a-f]{16,}$/i.test(url)) return 'hash';
		return 'other-string';
	}
	if (Array.isArray(url)) return 'array[' + [...new Set(url.map(imageForm))].join('|') + ']';
	if (url && typeof url === 'object') {
		if (url.type && url.data) return 'typed:' + url.type;
		return 'object{' + Object.keys(url).sort().join(',') + '}';
	}
	return url === undefined ? 'absent' : typeof url;
}

function newContent() {
	return {
		files: /** @type {string[]} */ ([]),
		errors: /** @type {string[]} */ ([]),
		elements: 0,
		materialPayloads: 0,
		sessionKeys: new Map(),
		objectTypes: new Map(), // type -> {count, fields:Set, where:Set}
		materialTypes: new Map(),
		geometryTypes: new Map(),
		geometryData: new Map(), // 'data' / 'attribute' / 'index' / 'morphAttribute' rows of BufferGeometry json
		textureTypes: new Map(),
		textureFields: new Map(), // field -> count
		imageForms: new Map(), // form -> {count, maxBytes, where:Set}
		userData: new Map(), // 'object.<key>' / 'material.<key>' / 'geometry.<key>' -> {count, shapes:Set, maxBytes, where:Set}
		topLevelKeys: new Map(), // ObjectLoader JSON top-level keys
		metadataVersions: new Map(),
		maxElementBytes: 0,
		maxDepth: 0,
		maxChildren: 0
	};
}

/** @param {Map<string, any>} map @param {string} type @param {any} json @param {string} where */
function typeRow(map, type, json, where) {
	if (!map.has(type)) map.set(type, { count: 0, fields: new Set(), kinds: {}, where: new Set() });
	const r = map.get(type);
	r.count++;
	for (const [k, v] of Object.entries(json)) {
		r.fields.add(k);
		if (k === 'children' || k === 'userData') continue;
		noteKind(r.kinds, k, v);
	}
	if (r.where.size < 6) r.where.add(where);
}

/** a field's value kinds and range, merged across every sighting @param {Record<string, any>} kinds @param {string} k @param {any} v */
function noteKind(kinds, k, v) {
	const row = (kinds[k] ??= { kinds: [], min: null, max: null, maxLen: 0, values: [] });
	const kind = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
	if (!row.kinds.includes(kind)) row.kinds.push(kind);
	if (kind === 'number') {
		row.min = row.min === null ? v : Math.min(row.min, v);
		row.max = row.max === null ? v : Math.max(row.max, v);
		if (!Number.isFinite(v) && !row.values.includes(String(v))) row.values.push(String(v));
	} else if (kind === 'string') {
		row.maxLen = Math.max(row.maxLen, v.length);
		if (v.length <= 40 && row.values.length < 12 && !row.values.includes(v)) row.values.push(v);
	} else if (kind === 'array') {
		row.maxLen = Math.max(row.maxLen, v.length);
	} else if (kind === 'object') {
		const keys = Object.keys(v).sort().join(',');
		if (row.values.length < 12 && !row.values.includes('{' + keys + '}')) row.values.push('{' + keys + '}');
		try {
			row.maxLen = Math.max(row.maxLen, JSON.stringify(v).length);
		} catch {
			/* parsed JSON is never cyclic */
		}
	}
}

/** @param {ReturnType<typeof newContent>} c @param {string} scope @param {any} ud @param {string} where */
function noteUserData(c, scope, ud, where) {
	if (!ud || typeof ud !== 'object' || Array.isArray(ud)) return;
	for (const [k, v] of Object.entries(ud)) {
		const key = scope + '.' + k;
		if (!c.userData.has(key)) c.userData.set(key, { count: 0, shapes: new Set(), maxBytes: 0, where: new Set() });
		const r = c.userData.get(key);
		r.count++;
		r.shapes.add(shapeOf(v));
		let bytes = 0;
		try {
			bytes = JSON.stringify(v)?.length ?? 0;
		} catch {
			bytes = -1;
		}
		r.maxBytes = Math.max(r.maxBytes, bytes);
		if (r.where.size < 6) r.where.add(where);
	}
}

/** walk one ObjectLoader JSON @param {ReturnType<typeof newContent>} c @param {any} el @param {string} where */
function walkElement(c, el, where, payloadOnly = false) {
	if (!payloadOnly) c.elements++;
	try {
		c.maxElementBytes = Math.max(c.maxElementBytes, JSON.stringify(el).length);
	} catch {
		/* cyclic: impossible for parsed JSON */
	}
	for (const k of Object.keys(el)) c.topLevelKeys.set(k, (c.topLevelKeys.get(k) || 0) + 1);
	if (!payloadOnly) {
		const v = String(el.metadata?.version);
		c.metadataVersions.set(v, (c.metadataVersions.get(v) || 0) + 1);
	}
	for (const g of el.geometries ?? []) {
		typeRow(c.geometryTypes, String(g.type), g, where);
		if (g.data && typeof g.data === 'object') {
			typeRow(c.geometryData, 'data', g.data, where);
			for (const [name, a] of Object.entries(g.data.attributes ?? {})) typeRow(c.geometryData, 'attribute', a, where + ' #' + name);
			if (g.data.index) typeRow(c.geometryData, 'index', g.data.index, where);
			for (const [name, list] of Object.entries(g.data.morphAttributes ?? {}))
				for (const a of /** @type {any[]} */ (list)) typeRow(c.geometryData, 'morphAttribute', a, where + ' #' + name);
		}
		noteUserData(c, 'geometry', g.userData ?? g.data?.userData, where);
	}
	for (const m of el.materials ?? []) {
		typeRow(c.materialTypes, String(m.type), m, where);
		noteUserData(c, 'material', m.userData, where);
	}
	for (const t of el.textures ?? []) {
		for (const k of Object.keys(t)) c.textureFields.set(k, (c.textureFields.get(k) || 0) + 1);
		typeRow(c.textureTypes, String(t.type ?? '(none)'), t, where);
		noteUserData(c, 'texture', t.userData, where);
	}
	for (const img of el.images ?? []) {
		const form = imageForm(img.url);
		if (!c.imageForms.has(form)) c.imageForms.set(form, { count: 0, maxBytes: 0, where: new Set() });
		const r = c.imageForms.get(form);
		r.count++;
		r.maxBytes = Math.max(r.maxBytes, typeof img.url === 'string' ? img.url.length : JSON.stringify(img.url ?? null).length);
		if (r.where.size < 6) r.where.add(where);
	}
	/** @param {any} o @param {number} depth */
	const walkObject = (o, depth) => {
		if (!o || typeof o !== 'object') return;
		c.maxDepth = Math.max(c.maxDepth, depth);
		typeRow(c.objectTypes, String(o.type), o, where);
		noteUserData(c, 'object', o.userData, where);
		const kids = Array.isArray(o.children) ? o.children : [];
		c.maxChildren = Math.max(c.maxChildren, kids.length);
		for (const k of kids) walkObject(k, depth + 1);
	};
	walkObject(el.object, 1);
}

/** find every ObjectLoader JSON inside an arbitrary JSON document @param {ReturnType<typeof newContent>} c @param {any} doc @param {string} where */
function findElements(c, doc, where) {
	/** @param {any} v @param {string} at */
	const visit = (v, at) => {
		if (!v || typeof v !== 'object') return;
		if (!Array.isArray(v) && v.metadata && typeof v.metadata === 'object' && v.metadata.type === 'Object' && v.object) {
			walkElement(c, v, where + (at ? ' @' + at : ''));
			return;
		}
		// an `objectParameters` materials payload: {materials[], textures[], images[]} with no metadata
		if (!Array.isArray(v) && Array.isArray(v.materials) && !v.metadata && (v.textures || v.images) && v.materials.every((/** @type {any} */ m) => m && typeof m.type === 'string')) {
			c.materialPayloads++;
			walkElement(c, { materials: v.materials, textures: v.textures ?? [], images: v.images ?? [] }, where + ' @' + (at || 'materials') + ' (payload)', true);
			return;
		}
		// a glTF document is not ObjectLoader JSON: not walked here
		if (!Array.isArray(v) && v.asset && typeof v.asset === 'object' && typeof v.asset.version === 'string') return;
		if (Array.isArray(v)) v.forEach((x, i) => visit(x, at.replace(/\[\d+\]$/, '') + '[]'));
		else for (const [k, x] of Object.entries(v)) visit(x, at ? at + '.' + k : k);
	};
	visit(doc, '');
}

/** @param {ReturnType<typeof newContent>} c @param {Uint8Array} bytes @param {string} where */
function readZip(c, bytes, where) {
	const z = unzipSync(bytes);
	for (const [name, data] of Object.entries(z)) {
		if (name === 'session.json' || (name.endsWith('.json') && !name.startsWith('assets/'))) {
			let doc;
			try {
				doc = JSON.parse(strFromU8(data));
			} catch (e) {
				c.errors.push(where + '!' + name + ': ' + /** @type {Error} */ (e).message);
				continue;
			}
			if (name === 'session.json') for (const k of Object.keys(doc)) c.sessionKeys.set(k, (c.sessionKeys.get(k) || 0) + 1);
			findElements(c, doc, where + (name === 'session.json' ? '' : '!' + name));
		} else if (name.endsWith('.tpscene')) {
			readZip(c, data, where + '!' + name);
		}
	}
}

/** @param {ReturnType<typeof newContent>} c @param {string} file */
function readFile(c, file) {
	const where = rel(file);
	c.files.push(where);
	const bytes = new Uint8Array(fs.readFileSync(file));
	try {
		if (bytes[0] === 0x50 && bytes[1] === 0x4b) readZip(c, bytes, where);
		else findElements(c, JSON.parse(strFromU8(bytes)), where);
	} catch (e) {
		c.errors.push(where + ': ' + /** @type {Error} */ (e).message);
	}
}

/** @param {string} p @returns {string[]} */
function contentFiles(p) {
	if (!fs.existsSync(p)) return [];
	const st = fs.statSync(p);
	if (st.isFile()) return [p];
	/** @type {string[]} */
	const out = [];
	for (const e of fs.readdirSync(p, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const q = path.join(p, e.name);
		if (e.isDirectory()) out.push(...contentFiles(q));
		else if (/\.(tpscene|tp)$/.test(e.name) || (/\.json$/.test(e.name) && !/^(package|manifest|index|known|tsconfig|inventory)/.test(e.name))) out.push(q);
	}
	return out.sort();
}

// ---------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------

/** @param {Map<string, any>} map */
function rows(map) {
	return Object.fromEntries(
		[...map.entries()]
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([k, v]) => [
				k,
				v instanceof Set
					? [...v].sort()
					: typeof v === 'object'
						? Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, vv instanceof Set ? [...vv].sort() : vv]))
						: v
			])
	);
}

function main() {
	const args = process.argv.slice(2);
	/** @type {string|null} */ let out = null;
	/** @type {string|null} */ let md = null;
	/** @type {string[]} */ const paths = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--out') out = args[++i];
		else if (args[i] === '--md') md = args[++i];
		else paths.push(path.resolve(args[i]));
	}
	if (!paths.length) {
		paths.push(path.join(ROOT, 'static/templates'), path.join(ROOT, 'tests/fixtures'));
		if (process.env.SCENES_DIR) paths.push(path.resolve(process.env.SCENES_DIR));
	}

	const core = scanSource(sourceFiles(path.join(ROOT, 'src')), 'core');
	const modules = process.env.MODULES_REPO ? scanSource(sourceFiles(process.env.MODULES_REPO), 'modules') : null;

	const content = newContent();
	for (const p of paths) for (const f of contentFiles(p)) readFile(content, f);

	const result = {
		generatedBy: 'scripts/schema-inventory.cjs',
		inputs: paths.map(rel),
		source: {
			core: Object.fromEntries(Object.entries(core).map(([k, v]) => [k, rows(v)])),
			modules: modules ? Object.fromEntries(Object.entries(modules).map(([k, v]) => [k, rows(v)])) : null
		},
		content: {
			files: content.files,
			errors: content.errors,
			elements: content.elements,
			materialPayloads: content.materialPayloads,
			maxElementBytes: content.maxElementBytes,
			maxDepth: content.maxDepth,
			maxChildren: content.maxChildren,
			metadataVersions: rows(content.metadataVersions),
			sessionKeys: rows(content.sessionKeys),
			topLevelKeys: rows(content.topLevelKeys),
			objectTypes: rows(content.objectTypes),
			materialTypes: rows(content.materialTypes),
			geometryTypes: rows(content.geometryTypes),
			geometryData: rows(content.geometryData),
			textureTypes: rows(content.textureTypes),
			textureFields: rows(content.textureFields),
			imageForms: rows(content.imageForms),
			userData: rows(content.userData)
		}
	};
	if (out) fs.writeFileSync(out, JSON.stringify(result, null, '\t') + '\n');
	const summary = markdown(result);
	if (md) fs.writeFileSync(md, summary);
	if (!out && !md) process.stdout.write(summary);
	else
		console.log(
			`schema-inventory: ${content.files.length} files, ${content.elements} object elements, ` +
				`${content.objectTypes.size} object / ${content.materialTypes.size} material / ${content.geometryTypes.size} geometry types, ` +
				`${content.userData.size} userData keys, ${content.errors.length} errors`
		);
	return result;
}

/** @param {any} r */
function markdown(r) {
	const c = r.content;
	/** @type {string[]} */
	const L = [];
	L.push('# Schema inventory (101-schema step 1)', '');
	L.push(`Inputs: ${r.inputs.join(', ')}  `, `Files: ${c.files.length} · object elements: ${c.elements} · largest element: ${c.maxElementBytes} bytes · deepest: ${c.maxDepth} · most children: ${c.maxChildren} · errors: ${c.errors.length}`, '');
	/** @param {string} title @param {Record<string, any>} map */
	const typeTable = (title, map) => {
		L.push(`## ${title}`, '', '| type | count | fields |', '|---|---|---|');
		for (const [k, v] of Object.entries(map)) L.push(`| ${k} | ${v.count} | ${v.fields.join(', ')} |`);
		L.push('');
	};
	L.push(`Material payloads (objectParameters materials): ${c.materialPayloads}`, '');
	typeTable('Object types (content)', c.objectTypes);
	typeTable('Material types (content)', c.materialTypes);
	typeTable('Geometry types (content)', c.geometryTypes);
	typeTable('BufferGeometry data parts (content)', c.geometryData);
	L.push('## Texture fields (content)', '', Object.entries(c.textureFields).map(([k, v]) => `${k} (${v})`).join(', '), '');
	L.push('## Image forms (content)', '', '| form | count | largest bytes |', '|---|---|---|');
	for (const [k, v] of Object.entries(c.imageForms)) L.push(`| ${k} | ${v.count} | ${v.maxBytes} |`);
	L.push('', '## userData keys (content)', '', '| key | count | shapes | largest bytes |', '|---|---|---|---|');
	for (const [k, v] of Object.entries(c.userData)) L.push(`| ${k} | ${v.count} | ${v.shapes.join(' / ').slice(0, 300)} | ${v.maxBytes} |`);
	const s = r.source.core;
	L.push('', '## Source (core src/)', '');
	L.push('- objectParameters sent: ' + Object.keys(s.parameters).join(', '));
	L.push('- objectParameters applied: ' + Object.keys(s.appliedParameters).join(', '));
	L.push('- object classes constructed: ' + Object.keys(s.objects).join(', '));
	L.push('- material classes constructed: ' + Object.keys(s.materials).join(', '));
	L.push('- geometry classes constructed: ' + Object.keys(s.geometries).join(', '));
	L.push('- texture classes constructed: ' + Object.keys(s.textures).join(', '));
	L.push('- userData keys referenced: ' + Object.keys(s.userData).length + ' — ' + Object.keys(s.userData).join(', '));
	L.push('', '### Generic loader call sites (core)', '');
	for (const [k, v] of Object.entries(s.loaderCalls)) L.push(`- \`${k}\`: ${v.join(', ')}`);
	if (r.source.modules) {
		const m = r.source.modules;
		L.push('', '## Source (modules repo)', '');
		L.push('- objectParameters sent: ' + Object.keys(m.parameters).join(', '));
		L.push('- object classes: ' + Object.keys(m.objects).join(', '));
		L.push('- material classes: ' + Object.keys(m.materials).join(', '));
		L.push('- geometry classes: ' + Object.keys(m.geometries).join(', '));
		L.push('- userData keys: ' + Object.keys(m.userData).length + ' — ' + Object.keys(m.userData).join(', '));
	}
	if (c.errors.length) L.push('', '## Errors', '', ...c.errors.map((/** @type {string} */ e) => '- ' + e));
	return L.join('\n') + '\n';
}

if (require.main === module) main();
module.exports = { scanSource, newContent, walkElement, findElements, imageForm, shapeOf };
