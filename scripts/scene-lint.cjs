#!/usr/bin/env node
// 34 B3 — SCENE-LINT: what a saved scene (.tpscene) can get silently wrong, caught before a
// player or a reviewer does. Static, no browser, ~ms per scene.
//
//   node scripts/scene-lint.cjs <file.tpscene | dir> [...] [--packs <packs checkout>] [--json]
//                               [--strict]   (warnings fail too)
//
// A directory is searched for every `scene.tpscene` under it (a scenes checkout, static/templates).
// Exit 1 when any ERROR is found (or any warning with --strict). author-templates.cjs runs the same
// rules on every scene it writes (`lintBytes`), and CI runs this over the scenes repo + core's seed.
//
// THE RULES (id — severity — what it catches; the receipts are roadmap-32 §1 / proposal B3):
//  node-unknown        error  a flow node type no core catalog knows, in a scene that declares no
//                             module (it renders as the "unknown node" card and DOES NOTHING)
//  customnode-def      warn   a Custom node whose def is not a declared module's (a saved scene
//                             carries no custom defs — it loads as an empty node)
//  object-type         error  a three object type ObjectLoader does not know (it loads as nothing)
//  env-unknown         error  environment.preset not a preset (the `dusk` -> `studio` silent fallback)
//  layer-helper        error  a saved object on the editor HELPER layer (30): invisible in
//                             Interact/Play, picked as a helper (584995a: 41 meshes)
//  layer-one-eye       error  an object on three's XR eye layer 1 or 2 but not 0: ONE EYE ONLY in a
//                             headset (30b 616d6d2)
//  spawn-bounds        error  play.spawn outside play.bounds (the player starts where teleport refuses)
//  spawn-collider      error/warn  play.spawn inside an object's box (error for a primitive, warn
//                             for a mesh/kit piece whose box may hold a doorway)
//  shell-duplicate     warn   a pause menu of the graph's own (hudscreen 'pause', a 'paused' state)
//                             — the game shell (31 K3) already gives every game Resume/Restart/
//                             Levels/Settings/Main menu
//  script-nondeterministic  error  a Script node reading Math.random / Date.now / new Date /
//                             performance.now / local- or sessionStorage: every peer runs the graph
//                             and gets a different answer
//  budget-static       warn   more than 150 separately drawn meshes (kit pieces instance, so they are
//                             not counted) — the Quest budget before any culling; info: more than
//                             300k triangles in the scene's own geometry + kit pieces (before culling
//                             and LOD — the measured gate is perf-games.cjs --check)
//  pack-behavior       error  a kit piece whose row's `behavior` normalizeBehavior() rejects (P2)
//  pack-lod-missing    warn   a kit piece over the pack tool's LOD threshold (2000 tris) without
//                             `lods` and not allow-listed by the pack tool
//  pack-flicker        info   kit pieces with known coplanar overlap (the pack tool's render-judged
//                             baseline) and pieces with double-sided materials — a summary
//
// VR panels "on top" (proposal B3) are NOT a saved-scene rule: every VR panel is runtime-only
// (vrPanelOverlay.js marks them at render time; none is ever in objects[]), so there is nothing
// in a file to check — the vr-panels-on-top and vr-eye-shots suites hold that contract.
const fs = require('fs');
const path = require('path');
const { unzipSync, strFromU8 } = require('fflate');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ---- the catalogs, read from core's own sources (so they cannot drift) ----------------------
/** every flow node type core renders or runs */
function coreNodeTypes() {
	const types = new Set(['customnode']);
	// the editor's renderer table — a type outside it (and outside every module) is the unknown card
	const nodes = read('src/components/editors/Nodes.svelte');
	const block = nodes.slice(nodes.indexOf('const CORE_NODE_TYPES'), nodes.indexOf('};', nodes.indexOf('const CORE_NODE_TYPES')));
	for (const m of block.matchAll(/^\s*([a-z0-9_]+):/gm)) types.add(m[1]);
	// the palette, and the info line per node
	for (const m of read('src/lib/nodeCatalog.js').matchAll(/\btype: '([a-z0-9_]+)'/g)) types.add(m[1]);
	for (const k of Object.keys(require('../src/lib/nodeDocs.js').NODE_DOCS)) types.add(k);
	return types;
}
/** environment presets (environment.js ENVIRONMENT_PRESETS) + 'custom' */
function envPresets() {
	const src = read('src/lib/environment.js');
	const start = src.indexOf('export const ENVIRONMENT_PRESETS');
	const body = src.slice(start, src.indexOf('\n};', start));
	const out = new Set(['custom']);
	for (const m of body.matchAll(/^\t([a-z]+): \{/gm)) out.add(m[1]);
	return out;
}
const HELPER_LAYER = Number(/export const HELPER_LAYER = (\d+)/.exec(read('src/lib/helperLayer.js'))[1]);
// three's ObjectLoader.parseObject switch (an unknown type silently becomes an Object3D)
const OBJECT_TYPES = new Set(
	('Scene PerspectiveCamera OrthographicCamera AmbientLight DirectionalLight PointLight RectAreaLight SpotLight HemisphereLight ' +
		'LightProbe SkinnedMesh Mesh InstancedMesh BatchedMesh LOD Line LineLoop LineSegments PointCloud Points Sprite Group Bone Object3D')
		.split(' ')
);

let CATALOGS = null;
const catalogs = () => (CATALOGS ??= { nodes: coreNodeTypes(), env: envPresets() });

// ---- small math (column-major 4x4, three's layout) ------------------------------------------
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function mul(a, b) {
	const o = new Array(16).fill(0);
	for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
	return o;
}
const apply = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
/** world AABB of a local box under a matrix @returns {number[]} [minx,miny,minz,maxx,maxy,maxz] */
function boxToWorld(m, b) {
	const out = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
	for (const x of [b[0], b[3]]) for (const y of [b[1], b[4]]) for (const z of [b[2], b[5]]) {
		const p = apply(m, [x, y, z]);
		for (let i = 0; i < 3; i++) {
			out[i] = Math.min(out[i], p[i]);
			out[i + 3] = Math.max(out[i + 3], p[i]);
		}
	}
	return out;
}
/** a geometry JSON's local box + triangle estimate, or null */
function geometryInfo(g) {
	if (!g) return null;
	const t = g.type;
	const n = (v, d) => (Number.isFinite(v) ? v : d);
	if (t === 'BoxGeometry') {
		const [w, h, d] = [n(g.width, 1), n(g.height, 1), n(g.depth, 1)];
		return { box: [-w / 2, -h / 2, -d / 2, w / 2, h / 2, d / 2], tris: 12, solid: true };
	}
	if (t === 'SphereGeometry' || t === 'IcosahedronGeometry' || t === 'DodecahedronGeometry') {
		const r = n(g.radius, 1);
		return { box: [-r, -r, -r, r, r, r], tris: t === 'SphereGeometry' ? 2 * n(g.widthSegments, 32) * n(g.heightSegments, 16) : 60, solid: true };
	}
	if (t === 'CylinderGeometry' || t === 'ConeGeometry') {
		const r = Math.max(n(g.radiusTop, n(g.radius, 1)), n(g.radiusBottom, n(g.radius, 1)));
		const h = n(g.height, 1);
		return { box: [-r, -h / 2, -r, r, h / 2, r], tris: 4 * n(g.radialSegments, 32), solid: true };
	}
	if (t === 'CapsuleGeometry') {
		const r = n(g.radius, 1);
		const h = n(g.height ?? g.length, 1) / 2 + r;
		return { box: [-r, -h, -r, r, h, r], tris: 512, solid: true };
	}
	const pos = g.data?.attributes?.position;
	if (pos?.array?.length) {
		const a = pos.array;
		const s = pos.itemSize || 3;
		const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
		for (let i = 0; i + 2 < a.length; i += s)
			for (let k = 0; k < 3; k++) {
				box[k] = Math.min(box[k], a[i + k]);
				box[k + 3] = Math.max(box[k + 3], a[i + k]);
			}
		const idx = g.data.index?.array?.length;
		return { box, tris: Math.round((idx ?? a.length / s) / 3), solid: false };
	}
	return null;
}

// ---- pack metadata (optional: a packs checkout) ----------------------------------------------
function findPacks(dir) {
	const cands = dir ? [dir] : [process.env.PACKS_DIR, path.join(ROOT, '..', 'packs'), path.join(ROOT, '..', 'theprototype.app-packs')].filter(Boolean);
	return cands.find((p) => fs.existsSync(path.join(p, 'index.json'))) ?? null;
}
/** a GLB's JSON chunk → triangles drawn + double-sided materials */
function glbInfo(file) {
	try {
		const b = fs.readFileSync(file);
		if (b.readUInt32LE(0) !== 0x46546c67) return null;
		const len = b.readUInt32LE(12);
		const j = JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
		let tris = 0;
		for (const node of j.nodes ?? []) {
			const mesh = node.mesh != null ? j.meshes?.[node.mesh] : null;
			for (const p of mesh?.primitives ?? []) {
				if ((p.mode ?? 4) !== 4) continue;
				const acc = p.indices != null ? j.accessors[p.indices] : j.accessors[p.attributes?.POSITION];
				tris += Math.round((acc?.count ?? 0) / 3);
			}
		}
		const doubleSided = (j.materials ?? []).filter((m) => m.doubleSided).map((m) => m.name || '(unnamed)');
		return { tris, doubleSided };
	} catch {
		return null;
	}
}
function makePackIndex(dir) {
	if (!dir) return null;
	const rows = new Map();
	const tool = path.join(dir, 'tools', 'kit-build');
	const json = (f) => {
		try {
			return JSON.parse(fs.readFileSync(f, 'utf8'));
		} catch {
			return null;
		}
	};
	const policy = json(path.join(tool, 'packs.json'));
	const allow = json(path.join(tool, 'allow.json'))?.allow ?? [];
	const flicker = json(path.join(tool, 'flicker-baseline.json'))?.files ?? {};
	return {
		dir,
		lodOver: policy?.limits?.lodRequiredOver ?? 2000,
		hasTool: !!policy,
		row(pack, item) {
			const key = pack + '/' + item;
			if (!rows.has(key)) {
				const list = json(path.join(dir, pack, 'default.json'));
				rows.set(key, Array.isArray(list) ? (list.find((r) => r.name === item) ?? null) : null);
			}
			return rows.get(key);
		},
		glb: (rel) => glbInfo(path.join(dir, rel)),
		lodAllowed: (pack, item) => allow.find((a) => a.pack === pack && a.item === item && a.check === 'lods') ?? null,
		flicker: (rel) => flicker[rel] ?? null
	};
}

// ---- the lint ---------------------------------------------------------------------------------
/**
 * @param {any} session the parsed session.json
 * @param {{packs?: any, source?: string}} [opts]
 * @returns {{rule: string, severity: 'error'|'warn'|'info', where: string, message: string}[]}
 */
function lintSession(session, opts = {}) {
	const { nodes: NODE_TYPES, env: ENV } = catalogs();
	const out = [];
	const add = (rule, severity, where, message) => out.push({ rule, severity, where, message });
	const modules = (session.modules ?? []).map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);

	// -- graphs
	const graphs = Object.entries(session.graphs ?? {});
	if (!graphs.length && Array.isArray(session.nodes)) graphs.push(['scene', { nodes: session.nodes, edges: session.edges }]);
	const moduleTypes = new Set();
	for (const [gid, g] of graphs) {
		const gname = gid === 'scene' ? 'scene graph' : `graph ${gid.slice(0, 8)}`;
		let pause = null;
		for (const n of g?.nodes ?? []) {
			const where = `${gname} node ${n.id} (${n.type})`;
			if (!NODE_TYPES.has(n.type)) {
				if (modules.length) moduleTypes.add(n.type);
				else add('node-unknown', 'error', where, `"${n.type}" is not a core node and the scene declares no module — it does nothing`);
			}
			if (n.type === 'customnode') {
				const def = String(n.data?.defId ?? '');
				if (!modules.some((m) => def.startsWith(`mod-${m}-`))) add('customnode-def', 'warn', where, `custom def "${def}" belongs to no declared module — a saved scene does not carry custom defs`);
			}
			if (n.type === 'script') {
				const hits = [...String(n.data?.code ?? '').matchAll(/\b(Math\.random|Date\.now|new Date|performance\.now|localStorage|sessionStorage)\b/g)].map((m) => m[1]);
				if (hits.length) add('script-nondeterministic', 'error', where, `reads ${[...new Set(hits)].join(', ')} — every peer runs this graph and would get a different answer (use the node's seeded rand / the session clock)`);
			}
			if ((n.type === 'hudscreen' && n.data?.screen === 'pause') || (n.type === 'setgamestate' && n.data?.state === 'paused')) pause ??= where;
		}
		if (pause) add('shell-duplicate', 'warn', pause, 'a pause menu of its own — the game shell (31 K3) already gives every game Resume / Restart / Levels / Settings / Main menu (Esc, the VR menu button)');
	}
	if (moduleTypes.size) add('node-module', 'info', 'graphs', `${moduleTypes.size} node type(s) left to the declared modules (${modules.join(', ')}): ${[...moduleTypes].slice(0, 12).join(', ')}`);

	// -- environment
	const env = session.environment;
	if (env?.preset !== undefined && !ENV.has(env.preset)) add('env-unknown', 'error', 'environment', `preset "${env.preset}" is not one of ${[...ENV].join(', ')} — it falls back to studio silently`);
	if (env?.preset === 'custom' && !env.customPreset) add('env-unknown', 'error', 'environment', 'preset "custom" without a customPreset — it falls back to studio silently');

	// -- objects: types, layers, boxes, triangles
	const boxes = [];
	let drawn = 0;
	let tris = 0;
	const kit = new Map();
	const walk = (o, geos, parentM, top) => {
		const m = mul(parentM, o.matrix ?? IDENTITY);
		const where = `object "${o.name || o.uuid}"` + (top !== o ? ` (in "${top.name || top.uuid}")` : '');
		if (o.type && !OBJECT_TYPES.has(o.type)) add('object-type', 'error', where, `three type "${o.type}" — ObjectLoader does not know it`);
		const mask = o.layers ?? 1;
		if (mask & (1 << HELPER_LAYER)) add('layer-helper', 'error', where, `saved on the editor helper layer ${HELPER_LAYER} — invisible in Interact/Play`);
		else if (!(mask & 1) && (mask & 0b110) && (mask & 0b110) !== 0b110) add('layer-one-eye', 'error', where, `on XR eye layer ${mask & 0b10 ? '1 (LEFT eye only)' : '2 (RIGHT eye only)'} and not layer 0`);
		const ref = o.userData?.packRef;
		if (ref && o === top) {
			const k = ref.pack + '/' + ref.item;
			const e = kit.get(k) ?? { ref, count: 0 };
			e.count++;
			kit.set(k, e);
			if (Array.isArray(ref.box) && ref.box.length === 6) boxes.push({ box: boxToWorld(m, ref.box), solid: false, where, sensor: !!o.userData?.physics?.sensor, visible: o.visible !== false });
		}
		if (o.type === 'Mesh' || o.type === 'SkinnedMesh' || o.type === 'Line' || o.type === 'Points') {
			drawn++;
			const g = geometryInfo(geos.get(o.geometry));
			if (g) {
				tris += g.tris;
				boxes.push({ box: boxToWorld(m, g.box), solid: g.solid, where, sensor: !!top.userData?.physics?.sensor, visible: o.visible !== false && top.visible !== false });
			}
		}
		for (const c of o.children ?? []) walk(c, geos, m, top);
	};
	for (const entry of session.objects ?? []) {
		const o = entry?.object;
		if (!o) continue;
		const geos = new Map((entry.geometries ?? []).map((g) => [g.uuid, g]));
		walk(o, geos, IDENTITY, o);
	}

	// -- play.spawn / play.bounds
	const play = session.physics?.play ?? session.play ?? null;
	const sp = play?.spawn;
	const at = Array.isArray(sp?.position) ? sp.position : Array.isArray(sp?.pos) ? sp.pos : null;
	if (at && at.length === 3 && at.every(Number.isFinite)) {
		const b = play.bounds;
		if (b && Array.isArray(b.min) && Array.isArray(b.max)) {
			const outside = [0, 1, 2].filter((i) => at[i] < b.min[i] - 1e-6 || at[i] > b.max[i] + 1e-6);
			if (outside.length) add('spawn-bounds', 'error', 'play.spawn', `[${at.join(', ')}] is outside play.bounds [${b.min.join(', ')}]..[${b.max.join(', ')}] (axis ${outside.map((i) => 'xyz'[i]).join('')})`);
		}
		// the player's body: feet at the spawn, the chest 0.9 m above — inside a box (shrunk 2 cm)?
		const chest = [at[0], at[1] + 0.9, at[2]];
		const e = 0.02;
		for (const c of boxes) {
			if (c.sensor || !c.visible) continue;
			const B = c.box;
			if (chest[0] > B[0] + e && chest[0] < B[3] - e && chest[1] > B[1] + e && chest[1] < B[4] - e && chest[2] > B[2] + e && chest[2] < B[5] - e)
				add('spawn-collider', c.solid ? 'error' : 'warn', 'play.spawn', `the player's body at [${chest.map((v) => +v.toFixed(2)).join(', ')}] is inside ${c.where}` + (c.solid ? '' : ' — its bounding box (fine only if that is a doorway or an opening)'));
		}
	}

	// -- kit pieces: pack rows, LODs, flicker, double-sided, triangles
	const packs = opts.packs ?? null;
	let kitTris = 0;
	let kitTrisKnown = true;
	const flick = [];
	const dbl = [];
	for (const [k, { ref, count }] of kit) {
		if (!packs) {
			kitTrisKnown = false;
			continue;
		}
		const row = packs.row(ref.pack, ref.item);
		if (row?.behavior) {
			const { normalizeBehavior } = require('../src/lib/behaviorCore.js');
			if (!normalizeBehavior(row.behavior)) add('pack-behavior', 'error', `kit ${k}`, `behavior ${JSON.stringify(row.behavior)} is rejected by normalizeBehavior (contract P2) — the piece will not act`);
		}
		const g = packs.glb(ref.path);
		if (!g) {
			kitTrisKnown = false;
			continue;
		}
		kitTris += g.tris * count;
		if (g.tris > packs.lodOver && !(row?.lods?.length)) {
			const al = packs.lodAllowed(ref.pack, ref.item);
			if (!al) add('pack-lod-missing', 'warn', `kit ${k}`, `${g.tris} tris (> ${packs.lodOver}) × ${count} placed, no LODs in its pack row`);
		}
		const f = packs.flicker(ref.path);
		if (f) flick.push(`${k} (${f.cm2 ?? '?'} cm², ${f.px ?? '?'} px)`);
		if (g.doubleSided.length) dbl.push(`${k} [${g.doubleSided.join(', ')}]`);
	}
	const few = (list) => list.slice(0, 6).join('; ') + (list.length > 6 ? `; … ${list.length - 6} more` : '');
	if (flick.length) add('pack-flicker', 'info', 'kit pieces', `${flick.length} piece type(s) with known coplanar overlap (render-judged by the pack tool): ${few(flick)}`);
	if (dbl.length) add('pack-flicker', 'info', 'kit pieces', `${dbl.length} of ${kit.size} piece type(s) with double-sided materials: ${few(dbl)}`);
	if (kit.size && !packs) add('pack-data', 'info', 'kit pieces', `${kit.size} kit piece type(s) not checked — no packs checkout (--packs <dir> or PACKS_DIR)`);

	// -- the static budget (B2 measures the real one)
	const kitDrawn = [...kit.values()].reduce((a, e) => a + e.count, 0);
	if (drawn > 150) add('budget-static', 'warn', 'objects', `${drawn} separately drawn meshes (+ ${kitDrawn} kit pieces, which instance) — more than the Quest budget of 150 calls before any culling`);
	const total = tris + kitTris;
	if (total > 300000) add('budget-static', 'info', 'objects', `≈${Math.round(total / 1000)}k triangles in the scene's own geometry${kitTrisKnown ? ' and kit pieces' : ''} (budget 300k visible; culling and LOD cut it — the measured gate is perf-games.cjs --check)`);
	return out;
}

/**
 * An AUTHORING def (scripts/templates/*.cjs) — what the saved file can no longer show: the author
 * path hands an unknown preset to setEnvironment, which saves `studio`, so the file looks clean.
 * @param {any} def @returns {ReturnType<typeof lintSession>}
 */
function lintDef(def) {
	const { env: ENV } = catalogs();
	const out = [];
	const env = def?.env;
	const preset = typeof env === 'string' ? env : env?.preset;
	if (preset !== undefined && !ENV.has(preset)) out.push({ rule: 'env-unknown', severity: 'error', where: `def ${def.slug} env`, message: `preset "${preset}" is not one of ${[...ENV].join(', ')} — the author path would save studio silently` });
	if (env && typeof env === 'object' && env.base !== undefined && (!ENV.has(env.base) || env.base === 'custom'))
		out.push({ rule: 'env-unknown', severity: 'error', where: `def ${def.slug} env.base`, message: `base "${env.base}" is not a preset` });
	return out;
}

/** a .tpscene's bytes → its session @param {Uint8Array|Buffer} bytes */
function sessionOf(bytes) {
	const z = unzipSync(new Uint8Array(bytes));
	if (!z['session.json']) throw new Error('no session.json in the zip');
	return JSON.parse(strFromU8(z['session.json']));
}
/** lint a .tpscene's bytes @param {Uint8Array|Buffer} bytes @param {{packs?: any}} [opts] */
function lintBytes(bytes, opts) {
	return lintSession(sessionOf(bytes), opts);
}

/** print findings for one scene; returns the counts */
function print(label, findings, { quiet = false } = {}) {
	const n = { error: 0, warn: 0, info: 0 };
	for (const f of findings) n[f.severity]++;
	if (!quiet || n.error || n.warn) {
		console.log(`${n.error ? 'FAIL' : n.warn ? 'WARN' : 'ok  '} ${label} — ${n.error} error(s), ${n.warn} warning(s)`);
		for (const f of findings) if (!quiet || f.severity !== 'info') console.log(`  ${f.severity.toUpperCase().padEnd(5)} ${f.rule.padEnd(24)} ${f.where}: ${f.message}`);
	}
	return n;
}

function scenesUnder(p) {
	const st = fs.statSync(p);
	if (st.isFile()) return [p];
	const out = [];
	for (const e of fs.readdirSync(p, { withFileTypes: true })) {
		if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
		const full = path.join(p, e.name);
		if (e.isDirectory()) out.push(...scenesUnder(full));
		else if (e.name.endsWith('.tpscene')) out.push(full);
	}
	return out;
}

module.exports = { lintSession, lintBytes, lintDef, sessionOf, print, makePackIndex, findPacks, glbInfo, coreNodeTypes, envPresets, HELPER_LAYER };

if (require.main === module) {
	const argv = process.argv.slice(2);
	const val = (name) => {
		const i = argv.indexOf('--' + name);
		return i >= 0 ? argv.splice(i, 2)[1] : null;
	};
	const flag = (name) => {
		const i = argv.indexOf('--' + name);
		return i >= 0 ? (argv.splice(i, 1), true) : false;
	};
	const packsDir = findPacks(val('packs'));
	const json = flag('json');
	const strict = flag('strict');
	const quiet = flag('quiet');
	if (!argv.length) {
		console.error('usage: node scripts/scene-lint.cjs <file.tpscene | dir> [...] [--packs <dir>] [--json] [--strict] [--quiet]');
		process.exit(2);
	}
	const packs = makePackIndex(packsDir);
	const files = argv.flatMap((p) => scenesUnder(path.resolve(p)));
	const report = [];
	const total = { error: 0, warn: 0, info: 0 };
	for (const f of files) {
		let findings;
		try {
			findings = lintBytes(fs.readFileSync(f), { packs });
		} catch (e) {
			findings = [{ rule: 'unreadable', severity: 'error', where: 'file', message: String(/** @type {any} */ (e)?.message ?? e) }];
		}
		report.push({ file: path.relative(process.cwd(), f), findings });
		if (!json) {
			const n = print(path.relative(process.cwd(), f), findings, { quiet });
			for (const k of Object.keys(total)) total[k] += n[k];
		} else for (const x of findings) total[x.severity]++;
	}
	if (json) console.log(JSON.stringify({ packs: packsDir, files: report, total }, null, 1));
	else console.log(`\nscene-lint: ${files.length} scene(s), ${total.error} error(s), ${total.warn} warning(s)${packsDir ? '' : ' — no packs checkout, kit rules skipped'}`);
	process.exit(total.error || (strict && total.warn) ? 1 : 0);
}
