// 57 M6 — RIG FIX-UPS ON THE FILE: rename a bone, move one in the rest pose, add or delete one,
// mirror one side onto the other, write new skin weights. Each op edits the model's GLB (glbEdit:
// everything else in the file stays as imported) and returns the new bytes; the caller replaces the
// model's bytes on every peer once the operation ends (rigFixes.js). LAZY (rig fix-ups load only
// when the Skeleton view opens), never on a player's boot graph.
//
// THE BIND IS KEPT: a skinned vertex lands at Σ w · (jointWorld · inverseBind) · v, so a joint that
// moves in the REST pose would drag its vertices along. Each op therefore rewrites the inverse bind
// matrices: newIBM = inverse(newJointWorld) · oldJointWorld · oldIBM, which leaves every vertex
// where it was while the joint itself moves (for a new bone, its parent's bind stands in).

import * as THREE from 'three';
import {
	readGlb,
	writeGlb,
	readAccessor,
	appendAccessor,
	nodeIndexByName
} from '../download/glbEdit.js';

/** @typedef {import('../download/glbEdit.js').GlbDoc} GlbDoc */

/** node -> parent index (-1 = a root) @param {any} json */
export function parentsOf(json) {
	const parent = new Int32Array((json.nodes ?? []).length).fill(-1);
	(json.nodes ?? []).forEach((/** @type {any} */ n, /** @type {number} */ i) =>
		(n.children ?? []).forEach((/** @type {number} */ c) => (parent[c] = i))
	);
	return parent;
}

/** a node's local matrix @param {any} n */
export function localMatrix(n) {
	if (Array.isArray(n.matrix)) return new THREE.Matrix4().fromArray(n.matrix);
	return new THREE.Matrix4().compose(
		new THREE.Vector3().fromArray(n.translation ?? [0, 0, 0]),
		new THREE.Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]),
		new THREE.Vector3().fromArray(n.scale ?? [1, 1, 1])
	);
}

/** set a node's local transform from a matrix (TRS form) @param {any} n @param {THREE.Matrix4} m */
function setLocal(n, m) {
	const t = new THREE.Vector3();
	const q = new THREE.Quaternion();
	const s = new THREE.Vector3();
	m.decompose(t, q, s);
	delete n.matrix;
	n.translation = t.toArray().map((v) => +v.toFixed(7));
	n.rotation = q.toArray().map((v) => +v.toFixed(7));
	n.scale = s.toArray().map((v) => +v.toFixed(7));
	if (n.scale.every((/** @type {number} */ v) => Math.abs(v - 1) < 1e-7)) delete n.scale;
	if (Math.abs(n.rotation[3] - 1) < 1e-7) delete n.rotation;
}

/** every node's world matrix @param {any} json @returns {THREE.Matrix4[]} */
export function worldOf(json) {
	const parent = parentsOf(json);
	/** @type {(THREE.Matrix4 | null)[]} */
	const W = (json.nodes ?? []).map(() => null);
	const get = (/** @type {number} */ i) => {
		if (W[i]) return /** @type {THREE.Matrix4} */ (W[i]);
		const m = localMatrix(json.nodes[i]);
		if (parent[i] >= 0) m.premultiply(get(parent[i]));
		W[i] = m;
		return m;
	};
	return (json.nodes ?? []).map((/** @type {any} */ _, /** @type {number} */ i) => get(i));
}

/** @param {GlbDoc} doc @param {number} skin @returns {THREE.Matrix4[]} */
function ibmsOf(doc, skin) {
	const s = doc.json.skins[skin];
	if (s.inverseBindMatrices === undefined) return s.joints.map(() => new THREE.Matrix4());
	const a = readAccessor(doc, s.inverseBindMatrices);
	return s.joints.map((/** @type {number} */ _, /** @type {number} */ k) =>
		new THREE.Matrix4().fromArray(a, k * 16)
	);
}

/** @param {GlbDoc} doc @param {number} skin @param {THREE.Matrix4[]} ibms */
function writeIbms(doc, skin, ibms) {
	const a = new Float32Array(ibms.length * 16);
	ibms.forEach((m, k) => m.toArray(a, k * 16));
	doc.json.skins[skin].inverseBindMatrices = appendAccessor(doc, a, 'MAT4');
}

/**
 * Run an edit of the node graph and keep every skin's bind: `edit` changes nodes (and may add
 * joints, returning their stand-in bind per new joint index).
 * @param {GlbDoc} doc @param {(json: any) => (void | Map<number, number>)} edit returns newJoint -> standInJoint (node indices)
 */
function keepBind(doc, edit) {
	const json = doc.json;
	const oldW = worldOf(json);
	/** @type {Map<number, THREE.Matrix4>[]} bind per joint node, per skin */
	const binds = (json.skins ?? []).map((/** @type {any} */ s, /** @type {number} */ si) => {
		const ibm = ibmsOf(doc, si);
		return new Map(
			s.joints.map((/** @type {number} */ j, /** @type {number} */ k) => [
				j,
				oldW[j].clone().multiply(ibm[k])
			])
		);
	});
	const standIn = edit(json) ?? new Map();
	const newW = worldOf(json);
	(json.skins ?? []).forEach((/** @type {any} */ s, /** @type {number} */ si) => {
		const ibms = s.joints.map((/** @type {number} */ j) => {
			const bind = binds[si].get(j) ?? binds[si].get(standIn.get(j) ?? -1) ?? newW[j].clone();
			return newW[j].clone().invert().multiply(bind);
		});
		writeIbms(doc, si, ibms);
	});
}

/** the node index three calls `name` (sanitized names resolve too) @param {any} json @param {string} name */
export function nodeIndex(json, name) {
	const i = nodeIndexByName(json).get(name);
	if (i === undefined) throw new Error('no bone "' + name + '"');
	return i;
}

/** @param {ArrayBuffer | Uint8Array} bytes @param {(doc: GlbDoc) => void} fn */
function edit(bytes, fn) {
	const doc = readGlb(bytes);
	fn(doc);
	return writeGlb(doc);
}

/** rename a bone (its animations and the VRM humanoid follow: they name it by index) @param {ArrayBuffer | Uint8Array} bytes @param {string} bone @param {string} name */
export function renameBone(bytes, bone, name) {
	const clean = String(name).trim().slice(0, 120);
	if (!clean) throw new Error('a bone needs a name');
	return edit(bytes, (doc) => {
		doc.json.nodes[nodeIndex(doc.json, bone)].name = clean;
	});
}

/**
 * Move a bone in the rest pose (its local translation; its children follow, the mesh does not).
 * @param {ArrayBuffer | Uint8Array} bytes @param {string} bone @param {number[]} translation
 */
export function moveBoneRest(bytes, bone, translation) {
	return edit(bytes, (doc) =>
		keepBind(doc, (json) => {
			const n = json.nodes[nodeIndex(json, bone)];
			const m = localMatrix(n);
			const t = new THREE.Vector3(),
				q = new THREE.Quaternion(),
				s = new THREE.Vector3();
			m.decompose(t, q, s);
			setLocal(n, new THREE.Matrix4().compose(new THREE.Vector3().fromArray(translation), q, s));
		})
	);
}

/**
 * Add a bone under `parent` at a local offset; it joins every skin its parent is in (weightless
 * until weights are painted or recomputed).
 * @param {ArrayBuffer | Uint8Array} bytes @param {string} parent @param {string} name @param {number[]} [offset]
 */
export function addBone(bytes, parent, name, offset = [0, 0.1, 0]) {
	return edit(bytes, (doc) =>
		keepBind(doc, (json) => {
			const p = nodeIndex(json, parent);
			const idx = json.nodes.length;
			json.nodes.push({ name: String(name).trim().slice(0, 120) || 'bone', translation: offset });
			(json.nodes[p].children = json.nodes[p].children ?? []).push(idx);
			for (const s of json.skins ?? []) if (s.joints.includes(p)) s.joints.push(idx);
			return new Map([[idx, p]]);
		})
	);
}

/**
 * Delete a bone: its children move up to its parent (keeping where they are), its weights go to
 * the parent, and it leaves the skeleton. (The node itself stays in the file, detached, so no other
 * index in the file — an animation, a VRM extension — has to change.)
 * @param {ArrayBuffer | Uint8Array} bytes @param {string} bone
 */
export function deleteBone(bytes, bone) {
	return edit(bytes, (doc) => {
		const json = doc.json;
		const i = nodeIndex(json, bone);
		const parent = parentsOf(json)[i];
		if (parent < 0) throw new Error('the root bone cannot be deleted');
		/** @type {{skin: number, gone: number, to: number}[]} */
		const remaps = [];
		keepBind(doc, (j) => {
			const W = worldOf(j);
			const pInv = W[parent].clone().invert();
			for (const c of j.nodes[i].children ?? []) {
				setLocal(j.nodes[c], pInv.clone().multiply(W[c]));
				j.nodes[parent].children.push(c);
			}
			j.nodes[i].children = [];
			j.nodes[parent].children = j.nodes[parent].children.filter(
				(/** @type {number} */ c) => c !== i
			);
			(j.skins ?? []).forEach((/** @type {any} */ s, /** @type {number} */ si) => {
				const k = s.joints.indexOf(i);
				if (k < 0) return;
				const to = s.joints.indexOf(parent);
				remaps.push({ skin: si, gone: k, to: to < 0 ? 0 : to });
			});
		});
		// drop the joint (its IBM row with it) and remap every primitive's JOINTS_0
		for (const { skin, gone, to } of remaps) {
			const s = json.skins[skin];
			const ibm = readAccessor(doc, s.inverseBindMatrices);
			const keep = new Float32Array(ibm.length - 16);
			keep.set(ibm.subarray(0, gone * 16), 0);
			keep.set(ibm.subarray((gone + 1) * 16), gone * 16);
			s.joints.splice(gone, 1);
			s.inverseBindMatrices = appendAccessor(doc, keep, 'MAT4');
			if (s.skeleton === i) s.skeleton = parent;
			for (const prim of primitivesOfSkin(json, skin)) {
				const J = readAccessor(doc, prim.attributes.JOINTS_0);
				const out = new Uint16Array(J.length);
				const target = to > gone ? to - 1 : to;
				for (let v = 0; v < J.length; v++)
					out[v] = J[v] === gone ? target : J[v] > gone ? J[v] - 1 : J[v];
				prim.attributes.JOINTS_0 = appendAccessor(doc, out, 'VEC4');
			}
		}
	});
}

/** the primitives skinned by a skin @param {any} json @param {number} skin @returns {any[]} */
export function primitivesOfSkin(json, skin) {
	const meshes = new Set(
		(json.nodes ?? [])
			.filter((/** @type {any} */ n) => n.skin === skin && n.mesh !== undefined)
			.map((/** @type {any} */ n) => n.mesh)
	);
	return [...meshes].flatMap((m) =>
		(json.meshes[m].primitives ?? []).filter(
			(/** @type {any} */ p) => p.attributes?.JOINTS_0 !== undefined
		)
	);
}

/** the other side's name, or '' (Left/Right, left/right, .l/.r, _l/_r, L_/R_, -l/-r) @param {string} name */
export function mirrorName(name) {
	const rules = /** @type {[RegExp, (m: string) => string][]} */ ([
		[/Left/, () => 'Right'],
		[/Right/, () => 'Left'],
		[/left/, () => 'right'],
		[/right/, () => 'left'],
		[/([._\-])l$/, (m) => m[0] + 'r'],
		[/([._\-])r$/, (m) => m[0] + 'l'],
		[/([._\-])L$/, (m) => m[0] + 'R'],
		[/([._\-])R$/, (m) => m[0] + 'L'],
		[/^L([._\-])/, (m) => 'R' + m[1]],
		[/^R([._\-])/, (m) => 'L' + m[1]],
		[/_L_/, () => '_R_'],
		[/_R_/, () => '_L_']
	]);
	for (const [re, sub] of rules) if (re.test(name)) return name.replace(re, sub);
	return '';
}

/** which side a bone name says it is on ('' = neither) @param {string} name @returns {'left'|'right'|''} */
export function sideOfName(name) {
	if (!mirrorName(name)) return '';
	return /Left|left|[._\-][lL]$|^L[._\-]|_L_/.test(name) ? 'left' : 'right';
}

/**
 * Mirror one side's rest pose onto the other (across the model's X = 0 plane): every bone named
 * for `from` puts its twin at the mirrored place and orientation. Returns the new bytes and the
 * pairs it moved.
 * @param {ArrayBuffer | Uint8Array} bytes @param {'left'|'right'} from
 */
export function mirrorBones(bytes, from = 'left') {
	/** @type {[string, string][]} */
	const pairs = [];
	const out = edit(bytes, (doc) =>
		keepBind(doc, (json) => {
			const isFrom = (/** @type {string} */ n) => !!mirrorName(n) && sideOfName(n) === from;
			const byName = new Map(
				json.nodes.map((/** @type {any} */ n, /** @type {number} */ i) => [n.name, i])
			);
			const S = new THREE.Matrix4().makeScale(-1, 1, 1);
			const parent = parentsOf(json);
			// top-down, so a twin's parent is already in place when it is computed
			const depth = (/** @type {number} */ i) => {
				let d = 0;
				for (let p = parent[i]; p >= 0; p = parent[p]) d++;
				return d;
			};
			const sources = json.nodes
				.map((/** @type {any} */ _, /** @type {number} */ i) => i)
				.filter(
					(/** @type {number} */ i) =>
						isFrom(json.nodes[i].name ?? '') && byName.has(mirrorName(json.nodes[i].name))
				);
			sources.sort((/** @type {number} */ a, /** @type {number} */ b) => depth(a) - depth(b));
			for (const i of sources) {
				const twin = /** @type {number} */ (byName.get(mirrorName(json.nodes[i].name)));
				if (twin === i) continue;
				const W = worldOf(json);
				const want = S.clone().multiply(W[i]).multiply(S);
				const pInv = parent[twin] >= 0 ? W[parent[twin]].clone().invert() : new THREE.Matrix4();
				setLocal(json.nodes[twin], pInv.multiply(want));
				pairs.push([json.nodes[i].name, json.nodes[twin].name]);
			}
		})
	);
	return { bytes: out, pairs };
}

/**
 * Write new weights for one primitive (JOINTS_0 as uint16, WEIGHTS_0 as float).
 * @param {ArrayBuffer | Uint8Array} bytes @param {number} mesh @param {number} primitive
 * @param {Uint16Array} joints @param {Float32Array} weights
 */
export function setPrimitiveWeights(bytes, mesh, primitive, joints, weights) {
	return edit(bytes, (doc) => {
		const prim = doc.json.meshes[mesh].primitives[primitive];
		prim.attributes.JOINTS_0 = appendAccessor(doc, joints, 'VEC4');
		prim.attributes.WEIGHTS_0 = appendAccessor(doc, weights, 'VEC4');
	});
}
