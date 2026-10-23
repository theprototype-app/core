// 57 M2 — THE HUMANOID MAP: every character's bones named onto VRM 1.0's humanoid bone set.
//
// A humanoid clip (57 M1 `.tpanim`, VRM Animation inside) is stored on these names, so ONE clip
// plays on any character whose bones are mapped: the 36 avatars (KayKit), a VRM (its own map),
// a Mixamo / Meshy / UniRig / Quaternius rig. The map is DETECTED, never typed: names first (the
// conventions below), the HIERARCHY second — which bone is which spine segment is read off the
// path from the hips to the head, not off its name, because Meshy writes its spine top-down
// (Hips > Spine02 > Spine01 > Spine) where Mixamo writes it bottom-up. A rig with no usable names
// at all (UniRig's `bone_0 … bone_n`) falls back to its SHAPE (`structure`): two chains down from
// the hips are legs, the branch above them carries the arms and the head.
//
// A LEAF (imports nothing): a bone list is plain data `{name, parent, pos}` (`pos` = rest position
// in the model's own space, used only by the structural fallback and the left/right check), so
// the unit suite runs it with no three.js. `humanoidRig.js` builds the list from a live model.

/** finger -> its three segments, base first (VRM 1.0: the thumb's first is the metacarpal) */
const FINGER_SEGMENTS = /** @type {[string, string[]][]} */ ([
	['Thumb', ['Metacarpal', 'Proximal', 'Distal']],
	['Index', ['Proximal', 'Intermediate', 'Distal']],
	['Middle', ['Proximal', 'Intermediate', 'Distal']],
	['Ring', ['Proximal', 'Intermediate', 'Distal']],
	['Little', ['Proximal', 'Intermediate', 'Distal']]
]);

/**
 * VRM 1.0 humanoid bones, parent-first, with the NOMINAL parent (the spec's; when a model lacks
 * an optional bone the nearest present ancestor stands in — `presentParent`).
 * @type {{name: string, parent: string | null, required?: boolean}[]}
 */
export const VRM_BONES = [
	{ name: 'hips', parent: null, required: true },
	{ name: 'spine', parent: 'hips', required: true },
	{ name: 'chest', parent: 'spine' },
	{ name: 'upperChest', parent: 'chest' },
	{ name: 'neck', parent: 'upperChest' },
	{ name: 'head', parent: 'neck', required: true },
	{ name: 'leftEye', parent: 'head' },
	{ name: 'rightEye', parent: 'head' },
	{ name: 'jaw', parent: 'head' },
	{ name: 'leftUpperLeg', parent: 'hips', required: true },
	{ name: 'leftLowerLeg', parent: 'leftUpperLeg', required: true },
	{ name: 'leftFoot', parent: 'leftLowerLeg', required: true },
	{ name: 'leftToes', parent: 'leftFoot' },
	{ name: 'rightUpperLeg', parent: 'hips', required: true },
	{ name: 'rightLowerLeg', parent: 'rightUpperLeg', required: true },
	{ name: 'rightFoot', parent: 'rightLowerLeg', required: true },
	{ name: 'rightToes', parent: 'rightFoot' },
	{ name: 'leftShoulder', parent: 'upperChest' },
	{ name: 'leftUpperArm', parent: 'leftShoulder', required: true },
	{ name: 'leftLowerArm', parent: 'leftUpperArm', required: true },
	{ name: 'leftHand', parent: 'leftLowerArm', required: true },
	{ name: 'rightShoulder', parent: 'upperChest' },
	{ name: 'rightUpperArm', parent: 'rightShoulder', required: true },
	{ name: 'rightLowerArm', parent: 'rightUpperArm', required: true },
	{ name: 'rightHand', parent: 'rightLowerArm', required: true },
	...fingerBones('left'),
	...fingerBones('right')
];

/** @param {'left'|'right'} side */
function fingerBones(side) {
	/** @type {{name: string, parent: string}[]} */
	const out = [];
	const hand = side + 'Hand';
	for (const [finger, segs] of FINGER_SEGMENTS) {
		let parent = hand;
		for (const seg of segs) {
			const name = side + finger + seg;
			out.push({ name, parent });
			parent = name;
		}
	}
	return out;
}

/** name -> the spec row @type {Map<string, {name: string, parent: string | null, required?: boolean}>} */
const BY_NAME = new Map(VRM_BONES.map((b) => [b.name, b]));

export const REQUIRED_BONES = VRM_BONES.filter((b) => b.required).map((b) => b.name);

/** @param {string} name */
export function isHumanBone(name) {
	return BY_NAME.has(name);
}

/**
 * The nearest ancestor of `bone` (by the spec's chain) that this map HAS — what a clip's parent
 * means on a model without a chest or a neck. null at the hips.
 * @param {string} bone @param {Record<string, string>} map
 */
export function presentParent(bone, map) {
	let p = BY_NAME.get(bone)?.parent ?? null;
	while (p && !map[p]) p = BY_NAME.get(p)?.parent ?? null;
	// a shoulder's nominal parent is the upper chest; a model with no spine segments above the
	// spine hangs it off whatever is there
	return p;
}

/** the left/right twin of a bone name ('' for a centre bone) @param {string} name */
export function mirrorBone(name) {
	if (name.startsWith('left')) return 'right' + name.slice(4);
	if (name.startsWith('right')) return 'left' + name.slice(5);
	return '';
}

// ---- reading a bone's NAME -------------------------------------------------------------------

/** prefixes that carry no meaning (Mixamo's namespace, VRoid's J_Bip_, Blender's DEF-, 3ds Max's Bip01) */
const PREFIX = /^(mixamorig\d*[:_]?|j_bip_|j_adj_|def[-_.]|bip0*1[\s_]?|armature[|_:])/i;
/** separators a normalized name drops */
const SEP = /[\s_.\-:|]/g;

/** words that name a body part once the side is gone, and what they mean (order matters: finger
 * words before "hand", "upleg"/"thigh" before "leg", "forearm"/"lowerarm" before "arm") */
const PART_RULES = /** @type {[RegExp, string][]} */ ([
	[/(thumb|index|middle|ring|pinky|little)/, 'finger'],
	[/(toe|ball)/, 'toes'],
	[/(foot|ankle)/, 'foot'],
	[/(upleg|thigh|upperleg)/, 'upperLeg'],
	[/(calf|shin|knee|lowerleg|leg)/, 'lowerLeg'],
	[/(clavicle|shoulder|collar)/, 'shoulder'],
	[/(forearm|lowerarm|elbow)/, 'lowerArm'],
	[/(upperarm|arm)/, 'upperArm'],
	[/(hand|wrist|palm|fist)/, 'hand'],
	[/neck/, 'neck'],
	[/eye/, 'eye'],
	[/jaw/, 'jaw'],
	[/head/, 'head'],
	[/(hips|pelvis|hip)/, 'hips'],
	[/(upperchest|chest|spine|torso|abdomen|waist)/, 'spine']
]);

/** a bone that is only an END marker or a helper — never a humanoid bone */
const IGNORE =
	/(end$|_end|top$|front$|nub$|tip$|slot|ik|pole|target|control|roll|twist|socket|weapon|prop|root$|^root|armature|^rig$)/i;

/**
 * Read one bone name: its side and the body part it names.
 * @param {string} raw @returns {{side: 'left'|'right'|'', part: string, rest: string, seg: number}}
 */
export function readBoneName(raw) {
	let n = String(raw ?? '').replace(PREFIX, '');
	/** @type {'left'|'right'|''} */
	let side = '';
	/** @param {string} s */
	const sideOf = (s) => (/^l/i.test(s) ? 'left' : 'right');
	let m;
	if ((m = n.match(/^(left|right)(?=[A-Z_.\-\s]|$)/i)) || (m = n.match(/^(left|right)/i))) {
		side = sideOf(m[1]);
		n = n.slice(m[1].length);
	} else if ((m = n.match(/(left|right)$/i))) {
		side = sideOf(m[1]);
		n = n.slice(0, -m[1].length);
	} else if ((m = n.match(/^([LR])[_.\-\s]/))) {
		side = sideOf(m[1]);
		n = n.slice(2);
	} else if ((m = n.match(/^[cC][_.\-\s]/))) {
		n = n.slice(2); // VRoid's centre marker
	} else if ((m = n.match(/[_.\-\s]([LlRr])$/))) {
		side = sideOf(m[1]);
		n = n.slice(0, -2);
	}
	let rest = n.toLowerCase().replace(SEP, '');
	// three's GLTFLoader drops the '.' from "upperarm.l" ("upperarml"): a known part word followed
	// by a bare l/r is a side too
	if (!side) {
		const tail = rest.match(/^(.*?)([lr])$/);
		if (
			tail &&
			/^(upperarm|lowerarm|forearm|hand|wrist|upperleg|lowerleg|upleg|leg|foot|toes?|shoulder|clavicle|thigh|calf|ball|arm|eye)$/.test(
				tail[1]
			)
		) {
			side = tail[2] === 'l' ? 'left' : 'right';
			rest = tail[1];
		}
	}
	if (IGNORE.test(rest) && !/^(hips?|head|neck)$/.test(rest))
		return { side, part: '', rest, seg: 0 };
	let part = '';
	for (const [re, p] of PART_RULES) {
		if (re.test(rest)) {
			part = p;
			break;
		}
	}
	// a finger's segment: a trailing number (1, 01, 2 …) or a phalanx word
	let seg = 0;
	const num = rest.match(/(\d+)$/);
	if (num) seg = Number(num[1]);
	else if (/metacarpal/.test(rest)) seg = 1;
	else if (/proximal/.test(rest)) seg = part === 'finger' && /thumb/.test(rest) ? 2 : 1;
	else if (/intermediate/.test(rest)) seg = 2;
	else if (/distal/.test(rest)) seg = 3;
	return { side, part, rest, seg };
}

// ---- detecting a map ---------------------------------------------------------------------------

/**
 * @typedef {{name: string, parent: number, pos?: number[]}} BoneEntry `parent` = index in the
 *   same list, -1 for a root. Only bones (or nodes that could be bones) belong in the list.
 * @typedef {{map: Record<string, string>, rig: string, missing: string[], ok: boolean, via: 'names'|'structure'|'file'}} HumanoidMap
 */

/**
 * Guess which convention named this rig — a LABEL for the Inspector ("Mixamo rig"), never what
 * the mapping depends on.
 * @param {string[]} names
 */
export function rigFamily(names) {
	const has = (/** @type {RegExp} */ re) => names.some((n) => re.test(n));
	if (has(/^mixamorig/i)) return 'mixamo';
	if (has(/^J_Bip_/)) return 'vroid';
	if (has(/^(pelvis|clavicle_[lr]|thigh_[lr]|calf_[lr])$/i)) return 'unreal';
	if (has(/^(upperarm\.?l|handslot\.?l|kneeIK\.?l)$/i)) return 'kaykit';
	if (has(/^Spine02$/) && has(/^neck$/) && has(/^head_end$/)) return 'meshy';
	if (has(/^(LeftUpLeg|LeftForeArm)$/)) return 'mixamo';
	if (names.length && names.every((n) => /^(bone|joint)[_.]?\d+$/i.test(n))) return 'unirig';
	return 'generic';
}

/**
 * Detect the humanoid map of a bone list: names first, the hierarchy decides the spine order and
 * which of two candidates is the real joint, the rig's SHAPE when the names say nothing.
 * @param {BoneEntry[]} bones @returns {HumanoidMap}
 */
export function detectHumanoidMap(bones) {
	const names = bones.map((b) => b.name);
	const rig = rigFamily(names);
	const byNames = mapFromNames(bones);
	const missing = REQUIRED_BONES.filter((b) => !byNames[b]);
	if (!missing.length) return { map: byNames, rig, missing, ok: true, via: 'names' };
	const shaped = mapFromStructure(bones);
	const shapeMissing = REQUIRED_BONES.filter((b) => !shaped[b]);
	if (shapeMissing.length < missing.length)
		return {
			map: shaped,
			rig: rig === 'generic' ? 'unirig' : rig,
			missing: shapeMissing,
			ok: !shapeMissing.length,
			via: 'structure'
		};
	return { map: byNames, rig, missing, ok: false, via: 'names' };
}

/** @param {BoneEntry[]} bones */
function childrenOf(bones) {
	/** @type {number[][]} */
	const kids = bones.map(() => []);
	bones.forEach((b, i) => {
		if (b.parent >= 0 && b.parent < bones.length) kids[b.parent].push(i);
	});
	return kids;
}

/** @param {BoneEntry[]} bones @param {number} i */
function depthOf(bones, i) {
	let d = 0;
	for (let p = bones[i].parent; p >= 0 && d < 1000; p = bones[p].parent) d++;
	return d;
}

/** is `a` an ancestor of `b`? @param {BoneEntry[]} bones @param {number} a @param {number} b */
function isAncestor(bones, a, b) {
	for (let p = bones[b].parent, n = 0; p >= 0 && n < 1000; p = bones[p].parent, n++)
		if (p === a) return true;
	return false;
}

/** descendants count @param {number[][]} kids @param {number} i */
function subtreeSize(kids, i) {
	let n = 0;
	const stack = [...kids[i]];
	while (stack.length) {
		const j = /** @type {number} */ (stack.pop());
		n++;
		stack.push(...kids[j]);
	}
	return n;
}

/**
 * The names pass. Every bone is read (side + part); the hips are the 'hips' bone with the most
 * below it; the spine segments are whatever lies on the hips → head path below the neck, in
 * depth order; each limb joint is the candidate that sits below the previous one.
 * @param {BoneEntry[]} bones @returns {Record<string, string>}
 */
export function mapFromNames(bones) {
	const kids = childrenOf(bones);
	const info = bones.map((b) => readBoneName(b.name));
	/** @type {Record<string, string>} */
	const map = {};
	const idx = (/** @type {(i: number) => boolean} */ fn) => bones.map((_, i) => i).filter(fn);
	const hipsCands = idx((i) => info[i].part === 'hips' && !info[i].side);
	hipsCands.sort(
		(a, b) => subtreeSize(kids, b) - subtreeSize(kids, a) || depthOf(bones, a) - depthOf(bones, b)
	);
	const hips = hipsCands[0];
	if (hips === undefined) return map;
	map.hips = bones[hips].name;
	const below = (/** @type {number} */ i) => isAncestor(bones, hips, i);
	const heads = idx((i) => info[i].part === 'head' && !info[i].side && below(i)).sort(
		(a, b) => depthOf(bones, a) - depthOf(bones, b)
	);
	const head = heads[0];
	if (head !== undefined) {
		map.head = bones[head].name;
		/** the path hips -> head, exclusive at both ends, top-down */
		/** @type {number[]} */
		const path = [];
		for (let p = bones[head].parent; p >= 0 && p !== hips; p = bones[p].parent) path.unshift(p);
		const neckAt = path.findIndex((i) => info[i].part === 'neck');
		let spineSegs = path;
		if (neckAt >= 0) {
			map.neck = bones[path[neckAt]].name;
			spineSegs = path.slice(0, neckAt);
		} else if (path.length >= 2 && info[path[path.length - 1]].part !== 'spine') {
			// an unnamed joint right below the head is its neck
			map.neck = bones[path[path.length - 1]].name;
			spineSegs = path.slice(0, -1);
		}
		assignSpine(
			map,
			spineSegs.map((i) => bones[i].name)
		);
	}
	for (const side of /** @type {const} */ (['left', 'right'])) {
		const S = side;
		const pick = (
			/** @type {string} */ part,
			/** @type {number | undefined} */ under,
			/** @type {(i: number) => number} */ rank = () => 0
		) => {
			const c = idx(
				(i) =>
					info[i].side === S &&
					info[i].part === part &&
					(under === undefined ? below(i) : isAncestor(bones, under, i))
			);
			c.sort((a, b) => rank(a) - rank(b) || depthOf(bones, a) - depthOf(bones, b));
			return c[0];
		};
		// legs
		const upLeg = pick('upperLeg', undefined);
		if (upLeg !== undefined) {
			map[side + 'UpperLeg'] = bones[upLeg].name;
			const low = pick('lowerLeg', upLeg);
			if (low !== undefined) {
				map[side + 'LowerLeg'] = bones[low].name;
				const foot = pick('foot', low);
				if (foot !== undefined) {
					map[side + 'Foot'] = bones[foot].name;
					const toes = pick('toes', foot);
					if (toes !== undefined) map[side + 'Toes'] = bones[toes].name;
				}
			}
		}
		// arms: the upper arm is the 'arm' bone that has a forearm below it (Mixamo's LeftArm, not
		// a stray "arm_twist" helper)
		const ups = idx(
			(i) =>
				info[i].side === S &&
				info[i].part === 'upperArm' &&
				below(i) &&
				idx((j) => info[j].side === S && info[j].part === 'lowerArm' && isAncestor(bones, i, j))
					.length > 0
		);
		ups.sort((a, b) => depthOf(bones, a) - depthOf(bones, b));
		const upArm = ups[0] ?? pick('upperArm', undefined);
		if (upArm !== undefined) {
			map[side + 'UpperArm'] = bones[upArm].name;
			const sh = idx(
				(i) => info[i].side === S && info[i].part === 'shoulder' && isAncestor(bones, i, upArm)
			).sort((a, b) => depthOf(bones, b) - depthOf(bones, a))[0];
			if (sh !== undefined) map[side + 'Shoulder'] = bones[sh].name;
			const low = pick('lowerArm', upArm);
			if (low !== undefined) {
				map[side + 'LowerArm'] = bones[low].name;
				// "hand" beats "wrist" when a rig has both (KayKit: wrist.l > hand.l)
				const hand = pick('hand', low, (i) => (/wrist/.test(info[i].rest) ? 1 : 0));
				if (hand !== undefined) {
					map[side + 'Hand'] = bones[hand].name;
					assignFingers(map, side, bones, kids, info, hand);
				}
			}
		}
		const eye = idx(
			(i) =>
				info[i].side === S &&
				info[i].part === 'eye' &&
				(head === undefined || isAncestor(bones, head, i))
		)[0];
		if (eye !== undefined) map[side + 'Eye'] = bones[eye].name;
	}
	if (head !== undefined) {
		const jaw = idx((i) => info[i].part === 'jaw' && isAncestor(bones, head, i))[0];
		if (jaw !== undefined) map.jaw = bones[jaw].name;
	}
	return map;
}

/** spine segments, bottom-up: 1 = spine; 2 = spine, chest; 3+ = spine, a middle one as chest, the
 * top as upper chest @param {Record<string, string>} map @param {string[]} segs */
function assignSpine(map, segs) {
	if (!segs.length) return;
	map.spine = segs[0];
	if (segs.length === 2) map.chest = segs[1];
	else if (segs.length >= 3) {
		map.chest = segs[Math.floor(segs.length / 2)];
		map.upperChest = segs[segs.length - 1];
	}
}

/**
 * @param {Record<string, string>} map @param {'left'|'right'} side @param {BoneEntry[]} bones
 * @param {number[][]} kids @param {ReturnType<typeof readBoneName>[]} info @param {number} hand
 */
function assignFingers(map, side, bones, kids, info, hand) {
	for (const [finger, segs] of FINGER_SEGMENTS) {
		const word = finger === 'Little' ? /(little|pinky)/ : new RegExp(finger.toLowerCase());
		const c = [];
		const stack = [...kids[hand]];
		while (stack.length) {
			const j = /** @type {number} */ (stack.pop());
			if (
				info[j].part === 'finger' &&
				word.test(info[j].rest) &&
				(!info[j].side || info[j].side === side)
			)
				c.push(j);
			stack.push(...kids[j]);
		}
		// numbered (1..3 / 01..03, sometimes 0-based) or by depth when unnumbered
		c.sort((a, b) => info[a].seg - info[b].seg || depthOf(bones, a) - depthOf(bones, b));
		c.slice(0, 3).forEach((j, k) => (map[side + finger + segs[k]] = bones[j].name));
	}
}

/**
 * The SHAPE pass, for a rig whose names say nothing (UniRig's numbered bones). Needs `pos`.
 * The hips: the highest-up bone with two chains going DOWN and one going UP. Legs: the two down
 * chains (left = +X, glTF's facing). The up chain: spine segments to the branch that carries
 * three chains — two sideways (arms) and the one that keeps going up (neck → head).
 * @param {BoneEntry[]} bones @returns {Record<string, string>}
 */
export function mapFromStructure(bones) {
	/** @type {Record<string, string>} */
	const map = {};
	if (!bones.length || bones.some((b) => !Array.isArray(b.pos))) return map;
	const kids = childrenOf(bones);
	const P = (/** @type {number} */ i) => /** @type {number[]} */ (bones[i].pos);
	/** the chain from i following the child with the biggest subtree */
	const chain = (/** @type {number} */ i) => {
		const out = [i];
		let c = i;
		while (kids[c].length) {
			c = kids[c].slice().sort((a, b) => subtreeSize(kids, b) - subtreeSize(kids, a))[0];
			out.push(c);
		}
		return out;
	};
	const extentY = (/** @type {number} */ i) => {
		let lo = Infinity,
			hi = -Infinity;
		const stack = [i];
		while (stack.length) {
			const j = /** @type {number} */ (stack.pop());
			lo = Math.min(lo, P(j)[1]);
			hi = Math.max(hi, P(j)[1]);
			stack.push(...kids[j]);
		}
		return [lo, hi];
	};
	const height = (() => {
		let lo = Infinity,
			hi = -Infinity;
		for (const b of bones) {
			lo = Math.min(lo, /** @type {number[]} */ (b.pos)[1]);
			hi = Math.max(hi, /** @type {number[]} */ (b.pos)[1]);
		}
		return Math.max(1e-6, hi - lo);
	})();
	let hips = -1;
	const order = bones.map((_, i) => i).sort((a, b) => depthOf(bones, a) - depthOf(bones, b));
	for (const i of order) {
		if (kids[i].length < 3) continue;
		const y = P(i)[1];
		const downs = kids[i].filter((c) => extentY(c)[0] < y - height * 0.2);
		const ups = kids[i].filter((c) => extentY(c)[1] > y + height * 0.2);
		if (downs.length >= 2 && ups.length >= 1) {
			hips = i;
			break;
		}
	}
	if (hips < 0) return map;
	map.hips = bones[hips].name;
	const y0 = P(hips)[1];
	const downs = kids[hips]
		.filter((c) => extentY(c)[0] < y0 - height * 0.2)
		.sort((a, b) => P(b)[0] - P(a)[0]);
	const up = kids[hips]
		.filter((c) => extentY(c)[1] > y0 + height * 0.2)
		.sort((a, b) => extentY(b)[1] - extentY(a)[1])[0];
	const legs = [downs[0], downs[downs.length - 1]];
	['left', 'right'].forEach((side, k) => {
		const c = chain(legs[k]);
		const parts = ['UpperLeg', 'LowerLeg', 'Foot', 'Toes'];
		c.slice(0, 4).forEach((j, n) => (map[side + parts[n]] = bones[j].name));
	});
	// the up chain to the branch with arms
	/** @type {number[]} */
	const spine = [];
	let c = up;
	let branch = -1;
	while (c !== undefined) {
		if (kids[c].length >= 3) {
			branch = c;
			spine.push(c);
			break;
		}
		spine.push(c);
		c = kids[c][0];
	}
	if (branch < 0) return map;
	const sideKids = kids[branch].slice().sort((a, b) => P(b)[0] - P(a)[0]);
	const neckKid = kids[branch]
		.slice()
		.sort((a, b) => extentY(b)[1] - extentY(a)[1] || Math.abs(P(a)[0]) - Math.abs(P(b)[0]))[0];
	const arms = [
		sideKids.find((k) => k !== neckKid),
		sideKids
			.slice()
			.reverse()
			.find((k) => k !== neckKid)
	];
	assignSpine(
		map,
		spine.map((i) => bones[i].name)
	);
	const neckChain = chain(neckKid);
	if (neckChain.length >= 2) {
		map.neck = bones[neckChain[0]].name;
		map.head = bones[neckChain[1]].name;
	} else map.head = bones[neckChain[0]].name;
	['left', 'right'].forEach((side, k) => {
		const a = arms[k];
		if (a === undefined) return;
		const ch = chain(a);
		// four joints before the fingers spread = a shoulder first
		const withShoulder =
			ch.length >= 4 &&
			Math.abs(P(ch[1])[0] - P(ch[0])[0]) < Math.abs(P(ch[2])[0] - P(ch[1])[0]) * 1.5;
		const parts = withShoulder
			? ['Shoulder', 'UpperArm', 'LowerArm', 'Hand']
			: ['UpperArm', 'LowerArm', 'Hand'];
		ch.slice(0, parts.length).forEach((j, n) => (map[side + parts[n]] = bones[j].name));
	});
	return map;
}

/**
 * Normalize a stored map: known bone names only, string values, required-bone check.
 * @param {any} raw @returns {Record<string, string>}
 */
export function normalizeHumanoidMap(raw) {
	/** @type {Record<string, string>} */
	const out = {};
	if (!raw || typeof raw !== 'object') return out;
	for (const [k, v] of Object.entries(raw))
		if (BY_NAME.has(k) && typeof v === 'string' && v) out[k] = v;
	return out;
}

/** the required bones a map still lacks @param {Record<string, string>} map */
export function missingRequired(map) {
	return REQUIRED_BONES.filter((b) => !map[b]);
}

/**
 * A detected map with the user's fixes on top (`overrides`: bone -> node name, '' = "not mapped").
 * @param {Record<string, string>} detected @param {Record<string, string> | null | undefined} overrides
 */
export function applyMapOverrides(detected, overrides) {
	const out = { ...detected };
	for (const [k, v] of Object.entries(overrides ?? {})) {
		if (!BY_NAME.has(k)) continue;
		if (v) out[k] = v;
		else delete out[k];
	}
	return out;
}

/** a human label for a bone ("leftUpperArm" -> "Left upper arm") @param {string} bone */
export function boneLabel(bone) {
	const words = bone
		.replace(/([A-Z])/g, ' $1')
		.toLowerCase()
		.trim();
	return words.charAt(0).toUpperCase() + words.slice(1);
}

/** the rig family's label @param {string} rig */
export function rigLabel(rig) {
	return (
		/** @type {Record<string, string>} */ ({
			mixamo: 'Mixamo',
			vroid: 'VRoid',
			unreal: 'Unreal / Quaternius',
			kaykit: 'KayKit',
			meshy: 'Meshy',
			unirig: 'UniRig',
			vrm: 'VRM',
			generic: 'Custom'
		})[rig] ?? 'Custom'
	);
}
