// 57: test characters built from scratch (nothing third-party is committed): a Mixamo-named humanoid
// made in-page with three's exporter, and the same rig turned into a VRM 1.0 or 0.x by writing the
// VRM extension into its GLB JSON here in node.

/** A Mixamo-named humanoid (no clips) as GLB bytes. `hair` adds a two-bone chain under the head (spring bones). */
function mixamoGlb(page, { hair = false, clip = false } = {}) {
	return page.evaluate(
		({ hair, clip }) =>
			new Promise((resolve) => {
				const THREE = window.__stores.THREE;
				const { GLTFExporter } = window.__stores.GLTFExporterModule;
				const bones = {};
				const mk = (name, parent, x, y, z) => {
					const b = new THREE.Bone();
					b.name = 'mixamorig' + name;
					b.position.set(x, y, z);
					if (parent) bones[parent].add(b);
					bones[name] = b;
				};
				mk('Hips', null, 0, 1, 0);
				mk('Spine', 'Hips', 0, 0.1, 0);
				mk('Spine1', 'Spine', 0, 0.12, 0);
				mk('Spine2', 'Spine1', 0, 0.12, 0);
				mk('Neck', 'Spine2', 0, 0.15, 0);
				mk('Head', 'Neck', 0, 0.1, 0);
				if (hair) {
					mk('Hair1', 'Head', 0, 0.15, -0.05);
					mk('Hair2', 'Hair1', 0, -0.1, -0.05);
				}
				for (const [S, x] of [
					['Left', 1],
					['Right', -1]
				]) {
					mk(S + 'Shoulder', 'Spine2', 0.05 * x, 0.1, 0);
					mk(S + 'Arm', S + 'Shoulder', 0.1 * x, 0, 0);
					mk(S + 'ForeArm', S + 'Arm', 0.25 * x, 0, 0);
					mk(S + 'Hand', S + 'ForeArm', 0.25 * x, 0, 0);
					mk(S + 'UpLeg', 'Hips', 0.1 * x, -0.05, 0);
					mk(S + 'Leg', S + 'UpLeg', 0, -0.45, 0);
					mk(S + 'Foot', S + 'Leg', 0, -0.45, 0);
					mk(S + 'ToeBase', S + 'Foot', 0, -0.05, 0.1);
				}
				const list = Object.values(bones);
				const geo = new THREE.BoxGeometry(0.4, 1.6, 0.3, 1, 4, 1);
				geo.translate(0, 0.8, 0);
				const n = geo.attributes.position.count;
				const si = new Uint16Array(n * 4);
				const sw = new Float32Array(n * 4);
				const leg = list.indexOf(bones.LeftUpLeg);
				for (let i = 0; i < n; i++) {
					sw[i * 4] = 1;
					// the lower left quarter rides the left thigh, so a walk visibly bends the mesh
					if (geo.attributes.position.getY(i) < 0.6 && geo.attributes.position.getX(i) > 0)
						si[i * 4] = leg;
				}
				geo.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
				geo.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
				const mesh = new THREE.SkinnedMesh(
					geo,
					new THREE.MeshStandardMaterial({ color: 0x88aacc })
				);
				mesh.name = 'Body';
				const root = new THREE.Group();
				root.add(bones.Hips);
				root.add(mesh);
				root.updateMatrixWorld(true);
				mesh.bind(new THREE.Skeleton(list));
				const animations = [];
				if (clip) {
					const q0 = new THREE.Quaternion();
					const q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -0.8);
					animations.push(
						new THREE.AnimationClip('Kick', 1, [
							new THREE.QuaternionKeyframeTrack(
								'mixamorigLeftUpLeg.quaternion',
								[0, 0.5, 1],
								[...q0.toArray(), ...q1.toArray(), ...q0.toArray()]
							),
							new THREE.VectorKeyframeTrack('mixamorigHips.position', [0, 1], [0, 1, 0, 0, 1, 0.5])
						])
					);
				}
				new GLTFExporter().parse(
					root,
					(buf) => resolve(Array.from(new Uint8Array(buf))),
					() => resolve(null),
					{ binary: true, animations }
				);
			}),
		{ hair, clip }
	);
}

/** @param {number[] | Uint8Array} bytes */
function readGlb(bytes) {
	const b = Buffer.from(bytes);
	const jsonLen = b.readUInt32LE(12);
	const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString('utf8'));
	const binStart = 20 + jsonLen;
	const bin =
		binStart < b.length
			? b.subarray(binStart + 8, binStart + 8 + b.readUInt32LE(binStart))
			: Buffer.alloc(0);
	return { json, bin };
}

/** @param {any} json @param {Buffer} bin */
function writeGlb(json, bin) {
	let j = Buffer.from(JSON.stringify(json), 'utf8');
	const pad = (4 - (j.length % 4)) % 4;
	j = Buffer.concat([j, Buffer.alloc(pad, 0x20)]);
	const bpad = (4 - (bin.length % 4)) % 4;
	const B = Buffer.concat([bin, Buffer.alloc(bpad, 0)]);
	const total = 12 + 8 + j.length + (B.length ? 8 + B.length : 0);
	const head = Buffer.alloc(12);
	head.writeUInt32LE(0x46546c67, 0);
	head.writeUInt32LE(2, 4);
	head.writeUInt32LE(total, 8);
	const jh = Buffer.alloc(8);
	jh.writeUInt32LE(j.length, 0);
	jh.writeUInt32LE(0x4e4f534a, 4);
	const parts = [head, jh, j];
	if (B.length) {
		const bh = Buffer.alloc(8);
		bh.writeUInt32LE(B.length, 0);
		bh.writeUInt32LE(0x004e4942, 4);
		parts.push(bh, B);
	}
	return Buffer.concat(parts);
}

const MIXAMO_TO_VRM = {
	Hips: 'hips',
	Spine: 'spine',
	Spine1: 'chest',
	Spine2: 'upperChest',
	Neck: 'neck',
	Head: 'head',
	LeftShoulder: 'leftShoulder',
	LeftArm: 'leftUpperArm',
	LeftForeArm: 'leftLowerArm',
	LeftHand: 'leftHand',
	RightShoulder: 'rightShoulder',
	RightArm: 'rightUpperArm',
	RightForeArm: 'rightLowerArm',
	RightHand: 'rightHand',
	LeftUpLeg: 'leftUpperLeg',
	LeftLeg: 'leftLowerLeg',
	LeftFoot: 'leftFoot',
	LeftToeBase: 'leftToes',
	RightUpLeg: 'rightUpperLeg',
	RightLeg: 'rightLowerLeg',
	RightFoot: 'rightFoot',
	RightToeBase: 'rightToes'
};

/**
 * Turn a mixamoGlb (with hair) into a VRM. `version` '1' (VRMC_vrm + VRMC_springBone) or '0' (VRM).
 * @param {number[]} glb @param {{version?: '0'|'1', meta?: any}} [opts] @returns {number[]}
 */
function toVrm(glb, { version = '1', meta = {} } = {}) {
	const { json, bin } = readGlb(glb);
	const idx = (name) => json.nodes.findIndex((n) => n.name === 'mixamorig' + name);
	json.extensionsUsed = [...(json.extensionsUsed ?? [])];
	json.extensions = json.extensions ?? {};
	if (version === '1') {
		const humanBones = {};
		for (const [m, v] of Object.entries(MIXAMO_TO_VRM))
			if (idx(m) >= 0) humanBones[v] = { node: idx(m) };
		json.extensionsUsed.push('VRMC_vrm', 'VRMC_springBone');
		json.extensions.VRMC_vrm = {
			specVersion: '1.0',
			meta: {
				name: 'Test Avatar',
				version: '1',
				authors: ['theprototype tests'],
				licenseUrl: 'https://vrm.dev/licenses/1.0/',
				avatarPermission: 'onlyAuthor',
				commercialUsage: 'personalNonProfit',
				allowRedistribution: false,
				modification: 'prohibited',
				creditNotation: 'required',
				...meta
			},
			humanoid: { humanBones },
			expressions: {
				preset: { happy: { morphTargetBinds: [] }, blink: { morphTargetBinds: [] } },
				custom: { wink: { morphTargetBinds: [] } }
			}
		};
		if (idx('Hair1') >= 0)
			json.extensions.VRMC_springBone = {
				specVersion: '1.0',
				springs: [
					{
						name: 'hair',
						joints: [
							{
								node: idx('Hair1'),
								hitRadius: 0.02,
								stiffness: 0.5,
								gravityPower: 1,
								dragForce: 0.4
							},
							{
								node: idx('Hair2'),
								hitRadius: 0.02,
								stiffness: 0.5,
								gravityPower: 1,
								dragForce: 0.4
							}
						]
					}
				]
			};
	} else {
		json.extensionsUsed.push('VRM');
		json.extensions.VRM = {
			exporterVersion: 'tests',
			specVersion: '0.0',
			meta: {
				title: 'Old Avatar',
				version: '1',
				author: 'theprototype tests',
				allowedUserName: 'OnlyAuthor',
				violentUssageName: 'Disallow',
				sexualUssageName: 'Disallow',
				commercialUssageName: 'Disallow',
				licenseName: 'Redistribution_Prohibited',
				...meta
			},
			humanoid: {
				humanBones: Object.entries(MIXAMO_TO_VRM)
					.filter(([m]) => idx(m) >= 0)
					.map(([m, v]) => ({ bone: v, node: idx(m), useDefaultValues: true }))
			},
			blendShapeMaster: {
				blendShapeGroups: [{ name: 'Joy', presetName: 'joy', binds: [], materialValues: [] }]
			},
			secondaryAnimation: { boneGroups: [], colliderGroups: [] },
			firstPerson: { firstPersonBone: idx('Head'), meshAnnotations: [] },
			materialProperties: []
		};
	}
	return Array.from(writeGlb(json, bin));
}

/**
 * An init script for `h.setupPage(browser, name, { init: FULL_RESOURCE_TIMING })`: the browser keeps
 * only 250 resource-timing entries, and the dev server's boot alone fetches more modules than that,
 * so a "was this lazy chunk fetched?" check against the default buffer reads false whatever loads.
 */
function FULL_RESOURCE_TIMING() {
	performance.setResourceTimingBufferSize(100000);
}

module.exports = { mixamoGlb, toVrm, readGlb, writeGlb, FULL_RESOURCE_TIMING };
