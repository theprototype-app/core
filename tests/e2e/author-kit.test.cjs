// 30 author-kit: what a template/game DEF can say. The builder (scripts/author-templates.cjs)
// grew primitives, light kinds, physical/toon materials and object flags; each is only real
// if it survives the .tpscene round trip, so this suite AUTHORS a def-under-test through the
// real script (`--def <file> --only <slug> --out <tmp>`), then LOADS the written file back
// through sessions.readSessionZip + applySession — the Templates modal's own read path — and
// reads each object's geometry / material / userData / clip. One check per feature.
//
// Run: APP_URL=https://theprototype.app:5233/ npm run e2e -- author-kit
// (the authoring pass drives its own headless browser against the same APP_URL)
const h = require('./helpers.cjs');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SLUG = 'author-kit-test';

/** The def-under-test: every new field once, on a named object. */
const DEF = {
	kind: 'template',
	slug: SLUG,
	title: 'Author kit test',
	description: 'every author-kit field, once',
	license: 'CC0-1.0',
	author: 'theprototype',
	objects: [
		{ type: 'box', name: 'Floor', color: 0x808890, size: [20, 0.2, 20], pos: [0, -0.1, 0] },
		{ type: 'box', name: 'Rounded', color: 0xd97706, size: [2, 1, 1.2], bevel: 0.2, pos: [-4, 0.5, 0] },
		{ type: 'capsule', name: 'Capsule', color: 0x3b82f6, r: 0.4, h: 1.2, pos: [-2, 1, 0] },
		{ type: 'plane', name: 'Plane', color: 0x22c55e, size: [2, 3], pos: [0, 1.5, -3] },
		{ type: 'ring', name: 'Ring', color: 0xeab308, r: 1, inner: 0.6, pos: [2, 1.5, -3] },
		{ type: 'icosahedron', name: 'Ico', color: 0xa855f7, r: 0.6, detail: 1, pos: [2, 0.6, 0] },
		{ type: 'dodecahedron', name: 'Dodeca', color: 0xec4899, r: 0.6, pos: [4, 0.6, 0] },
		{
			type: 'sphere',
			name: 'Glass',
			color: 0xffffff,
			r: 0.6,
			pos: [0, 0.6, 2],
			clearcoat: 0.8,
			clearcoatRoughness: 0.15,
			transmission: 0.9,
			thickness: 0.5,
			ior: 1.45,
			sheen: 0.4,
			sheenColor: 0xff0000,
			roughness: 0.1
		},
		{ type: 'sphere', name: 'Plain physical', color: 0x999999, r: 0.3, pos: [-2, 0.3, 2], physical: true },
		{ type: 'box', name: 'Glow', color: 0x111111, size: [0.5, 0.5, 0.5], pos: [2, 0.25, 2], emissive: 0x00ffcc, emissiveIntensity: 2.5 },
		{ type: 'cone', name: 'Faceted', color: 0x999999, r: 0.4, h: 0.8, pos: [4, 0.4, 2], flatShading: true, side: 'double' },
		{ type: 'sphere', name: 'Toon', color: 0x44aa88, r: 0.5, pos: [-4, 0.5, 2], toon: true },
		{ type: 'box', name: 'Shell', color: 0xffffff, size: [8, 3, 0.1], pos: [0, 1.5, -5], opacity: 0.1, pick: 'through' },
		{ type: 'cylinder', name: 'Coin', color: 0xfacc15, r: 0.3, h: 0.05, pos: [-4, 1.5, -2], rot: [Math.PI / 2, 0, 0], anim: 'Turntable' },
		{ type: 'box', name: 'Door', color: 0x8b5a2b, size: [1, 2, 0.1], pos: [4, 1, -2], origin: [-0.5, 0, 0], anim: ['door', 'Pulse'] },
		{ type: 'sphere', name: 'Fountain', color: 0x999999, r: 0.2, pos: [0, 0.2, 4], particles: { preset: 'sparkles', count: 33 } },
		{ type: 'box', name: 'Brazier', color: 0x333333, size: [0.4, 0.4, 0.4], pos: [-2, 0.2, 4], particles: 'fire' },
		{ type: 'light', kind: 'spot', name: 'Spot', color: 0xffeecc, intensity: 20, angle: 0.5, penumbra: 0.4, pos: [0, 6, 4], target: [0, 0, 0] },
		{ type: 'light', kind: 'directional', name: 'Key', color: 0xffffff, intensity: 2, pos: [10, 14, 8], target: [0, 0, 0], shadowMapSize: 1024 },
		{ type: 'light', kind: 'hemisphere', name: 'Fill', color: 0xbbddff, groundColor: 0x332211, intensity: 0.6, pos: [0, 5, 0] },
		{ type: 'light', name: 'Bulb', color: 0xffaa55, intensity: 3, distance: 8, pos: [3, 2, 3] }
	]
};

/** Author the def through the real script into a fresh temp folder; returns the .tpscene
 * bytes and the thumbnail bytes. @param {any} def @param {string} tag */
function author(def, tag) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'author-kit-' + tag + '-'));
	const file = path.join(dir, 'def.json');
	fs.writeFileSync(file, JSON.stringify(def));
	const out = path.join(dir, 'out');
	const script = path.join(__dirname, '../../scripts/author-templates.cjs');
	const log = execFileSync('node', [script, '--def', file, '--only', def.slug, '--out', out], {
		env: { ...process.env, APP_URL: h.URL },
		encoding: 'utf8',
		timeout: 240000
	});
	console.log(log.trim().split('\n').filter((l) => /B, thumb|WARN|FATAL|PAGEERROR/.test(l)).join('\n'));
	const section = def.kind === 'game' ? 'games' : def.kind === 'template' ? 'templates' : 'examples';
	const base = path.join(out, section, def.slug);
	return {
		scene: fs.readFileSync(path.join(base, 'scene.tpscene')),
		thumb: fs.existsSync(path.join(base, 'thumb.webp')) ? fs.readFileSync(path.join(base, 'thumb.webp')) : null
	};
}

/** Load a .tpscene into the page through the Templates modal's own read path. */
async function load(page, bytes) {
	return page.evaluate(async (b64) => {
		const s = window.__stores;
		const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
		const payload = await s.sessions.readSessionZip(bin.buffer);
		if (!payload) return false;
		await s.sessions.applySession(payload, { backup: false, replicate: false });
		return true;
	}, bytes.toString('base64'));
}

h.run(async () => {
	// ---- P0: primitives, lights, materials, flags -------------------------------------
	const authored = author(DEF, 'p0');
	check(authored.scene.length > 1000, 'the def authored a .tpscene (' + authored.scene.length + ' B)');

	const browser = await h.launch({ args: h.GPU_ARGS });
	const peer = await h.setupPage(browser, 'author-kit', { context: { viewport: { width: 1540, height: 774 } } });
	const page = peer.page;
	await page.waitForFunction(() => !!window.__stores?.sessions && !!window.__stores?.animationPreview, { timeout: 30000 });
	check(await load(page, authored.scene), 'the authored file loads through readSessionZip + applySession');
	await page.waitForTimeout(800);

	const r = await page.evaluate(() => {
		const s = window.__stores;
		/** @type {any} */ let group;
		s.objectsGroup.subscribe((g) => (group = g))();
		const by = (/** @type {string} */ n) => group.getObjectByName(n);
		const geo = (/** @type {string} */ n) => by(n)?.geometry;
		const mat = (/** @type {string} */ n) => by(n)?.material;
		/** @type {any} */ let anims;
		s.animationPreview.animations.subscribe((v) => (anims = v))();
		const clipNames = (/** @type {string} */ n) => Object.values(anims[by(n)?.uuid]?.clips ?? {}).map((/** @type {any} */ c) => c.name);
		const rounded = geo('Rounded');
		rounded.computeBoundingBox();
		const bb = rounded.boundingBox;
		// a rounded box's corner is CUT: no vertex reaches the sharp corner's |x|+|y|+|z|
		const pos = rounded.attributes.position.array;
		let cornerMax = 0;
		for (let i = 0; i < pos.length; i += 3) cornerMax = Math.max(cornerMax, Math.abs(pos[i]) + Math.abs(pos[i + 1]) + Math.abs(pos[i + 2]));
		const aim = (/** @type {string} */ n, /** @type {number[]} */ t) => {
			const l = by(n);
			l.updateMatrixWorld(true);
			const wp = l.getWorldPosition(new s.THREE.Vector3());
			const fwd = new s.THREE.Vector3(0, 0, -1).applyQuaternion(l.getWorldQuaternion(new s.THREE.Quaternion()));
			return fwd.dot(new s.THREE.Vector3(...t).sub(wp).normalize());
		};
		const key = by('Key');
		const cam = key?.shadow?.camera;
		return {
			roundedType: rounded.type,
			roundedVerts: rounded.attributes.position.count,
			roundedSize: [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z],
			cornerMax,
			capsule: geo('Capsule')?.type,
			capsuleRadius: geo('Capsule')?.parameters?.radius,
			plane: geo('Plane')?.type,
			ring: geo('Ring')?.type,
			ringInner: geo('Ring')?.parameters?.innerRadius,
			ico: geo('Ico')?.type,
			icoDetail: geo('Ico')?.parameters?.detail,
			dodeca: geo('Dodeca')?.type,
			glass: {
				physical: !!mat('Glass')?.isMeshPhysicalMaterial,
				clearcoat: mat('Glass')?.clearcoat,
				clearcoatRoughness: mat('Glass')?.clearcoatRoughness,
				transmission: mat('Glass')?.transmission,
				thickness: mat('Glass')?.thickness,
				ior: mat('Glass')?.ior,
				sheen: mat('Glass')?.sheen,
				sheenColor: mat('Glass')?.sheenColor?.getHexString()
			},
			plainPhysical: !!mat('Plain physical')?.isMeshPhysicalMaterial,
			floorStandard: mat('Floor')?.type,
			glow: { emissive: mat('Glow')?.emissive?.getHexString(), intensity: mat('Glow')?.emissiveIntensity },
			faceted: { flat: mat('Faceted')?.flatShading, side: mat('Faceted')?.side, double: s.THREE.DoubleSide },
			toon: !!mat('Toon')?.isMeshToonMaterial,
			shellPick: by('Shell')?.userData?.pick,
			floorPick: by('Floor')?.userData?.pick ?? null,
			coinClips: clipNames('Coin'),
			doorClips: clipNames('Door'),
			doorOrigin: by('Door')?.userData?.origin,
			fountain: by('Fountain')?.userData?.particles,
			brazier: by('Brazier')?.userData?.particles?.preset,
			spot: {
				is: !!by('Spot')?.isSpotLight,
				angle: by('Spot')?.angle,
				penumbra: by('Spot')?.penumbra,
				shadow: by('Spot')?.castShadow,
				aim: aim('Spot', [0, 0, 0])
			},
			key: {
				is: !!key?.isDirectionalLight,
				shadow: key?.castShadow,
				aim: aim('Key', [0, 0, 0]),
				frustum: cam ? [cam.left, cam.right, cam.bottom, cam.top, cam.near, cam.far] : null,
				mapSize: key?.shadow?.mapSize?.x
			},
			hemi: { is: !!by('Fill')?.isHemisphereLight, ground: by('Fill')?.groundColor?.getHexString() },
			bulb: { is: !!by('Bulb')?.isPointLight, distance: by('Bulb')?.distance }
		};
	});
	console.log(JSON.stringify(r));

	// primitives
	check(r.roundedType === 'BufferGeometry', 'bevel: the rounded box is baked into a plain BufferGeometry (ObjectLoader rebuilds it) — ' + r.roundedType);
	check(r.roundedVerts > 36, 'bevel: it carries the rounded tessellation (' + r.roundedVerts + ' verts)');
	check(r.roundedSize.every((v, i) => Math.abs(v - [2, 1, 1.2][i]) < 1e-3), 'bevel: its outer size is still the authored size ' + r.roundedSize.map((v) => v.toFixed(3)));
	check(r.cornerMax < 2.1 - 0.05, 'bevel: the corners are cut (max |x|+|y|+|z| ' + r.cornerMax.toFixed(3) + ' < a sharp 2.1)');
	check(r.capsule === 'CapsuleGeometry' && Math.abs(r.capsuleRadius - 0.4) < 1e-6, 'capsule: CapsuleGeometry r=0.4 (' + r.capsule + ')');
	check(r.plane === 'PlaneGeometry', 'plane: PlaneGeometry (' + r.plane + ')');
	check(r.ring === 'RingGeometry' && Math.abs(r.ringInner - 0.6) < 1e-6, 'ring: RingGeometry inner 0.6 (' + r.ring + ')');
	check(r.ico === 'IcosahedronGeometry' && r.icoDetail === 1, 'icosahedron: IcosahedronGeometry detail 1 (' + r.ico + ')');
	check(r.dodeca === 'DodecahedronGeometry', 'dodecahedron: DodecahedronGeometry (' + r.dodeca + ')');
	// materials
	check(r.glass.physical, 'physical: a physical-only field makes a MeshPhysicalMaterial');
	check(Math.abs(r.glass.clearcoat - 0.8) < 1e-6, 'physical: clearcoat 0.8 survives (' + r.glass.clearcoat + ')');
	check(Math.abs(r.glass.clearcoatRoughness - 0.15) < 1e-6, 'physical: clearcoatRoughness 0.15 survives');
	check(Math.abs(r.glass.transmission - 0.9) < 1e-6, 'physical: transmission 0.9 survives (' + r.glass.transmission + ')');
	check(Math.abs(r.glass.thickness - 0.5) < 1e-6, 'physical: thickness 0.5 survives');
	check(Math.abs(r.glass.ior - 1.45) < 1e-6, 'physical: ior 1.45 survives (' + r.glass.ior + ')');
	check(Math.abs(r.glass.sheen - 0.4) < 1e-6 && r.glass.sheenColor === 'ff0000', 'physical: sheen 0.4 + sheenColor #ff0000 survive (' + r.glass.sheenColor + ')');
	check(r.plainPhysical, 'physical: `physical: true` alone makes a MeshPhysicalMaterial');
	check(r.floorStandard === 'MeshStandardMaterial', 'an object using none of it stays MeshStandardMaterial (' + r.floorStandard + ')');
	check(r.glow.emissive === '00ffcc' && Math.abs(r.glow.intensity - 2.5) < 1e-6, 'emissive + emissiveIntensity 2.5 survive (' + JSON.stringify(r.glow) + ')');
	check(r.faceted.flat === true, 'flatShading survives');
	check(r.faceted.side === r.faceted.double, "side: 'double' survives as DoubleSide");
	check(r.toon, 'toon: MeshToonMaterial');
	// flags
	check(r.shellPick === 'through', "pick: 'through' lands on userData.pick");
	check(r.floorPick === null, 'an unflagged object carries no pick key');
	check(r.coinClips.includes('Turntable'), 'anim: the Turntable preset is an authored clip on the coin (' + r.coinClips + ')');
	check(r.doorClips.includes('Door') && r.doorClips.includes('Pulse'), 'anim: a list of presets, by key or by name (' + r.doorClips + ')');
	check(Array.isArray(r.doorOrigin) && r.doorOrigin[0] === -0.5, 'origin: the hinge offset lands on userData.origin (' + JSON.stringify(r.doorOrigin) + ')');
	check(r.fountain?.preset === 'sparkles' && r.fountain?.count === 33 && r.fountain?.sprite === 'star', 'particles: a preset + a patch (count 33) on userData.particles');
	check(r.brazier === 'fire', "particles: a bare preset name ('fire')");
	// lights
	check(r.spot.is && Math.abs(r.spot.angle - 0.5) < 1e-6 && Math.abs(r.spot.penumbra - 0.4) < 1e-6, 'spot: SpotLight with angle 0.5 + penumbra 0.4');
	check(r.spot.shadow === true, 'spot: casts shadows by default (createLight convention)');
	check(r.spot.aim > 0.999, 'spot: aimed by rotation at its target (forward . to-target = ' + r.spot.aim.toFixed(4) + ')');
	check(r.key.is && r.key.shadow === true, 'directional: DirectionalLight casting shadows');
	check(r.key.aim > 0.999, 'directional: aimed at its target (' + r.key.aim.toFixed(4) + ')');
	check(
		!!r.key.frustum && r.key.frustum[1] > 5.5 && r.key.frustum[1] < 40 && r.key.frustum[4] > 0.1 && r.key.frustum[5] > r.key.frustum[4] + 10,
		'directional: its shadow frustum is FITTED to the scene, not three\'s default ±5 (' + (r.key.frustum ?? []).map((v) => v.toFixed(1)) + ')'
	);
	check(r.key.mapSize === 1024, 'directional: shadowMapSize 1024 survives (' + r.key.mapSize + ')');
	check(r.hemi.is && r.hemi.ground === '332211', 'hemisphere: HemisphereLight with its ground colour');
	check(r.bulb.is && r.bulb.distance === 8, 'point: the existing point light is unchanged');

	await h.finish(browser);
});

/** @param {boolean} ok @param {string} label */
function check(ok, label) {
	h.check(ok, label);
}
