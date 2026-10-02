// Builds tests/e2e/fixtures/test-door.glb: the contract-P2 test door the pack-behavior suite places.
// A FRAME (one mesh, two posts + a lintel, so the collider has to cut the doorway out of it)
// and a LEAF node whose origin is the hinge (vertices offset to +x), with three clips:
// `idle` (static, FIRST - what anim-kit ships), `open` (0 -> -90 deg about Y over 1 s) and
// `close` (the reverse). The doorway is x in [-0.5, 0.5], y in [0, 2], z in [-0.05, 0.05].
//
// Run (gltf-transform is not a core dependency; any checkout of it works):
//   GLTF_TRANSFORM=/path/to/node_modules/@gltf-transform/core node tests/e2e/fixtures/build-test-door.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const corePath = process.env.GLTF_TRANSFORM;
if (!corePath) throw new Error('set GLTF_TRANSFORM to @gltf-transform/core');
const { Document, NodeIO } = await import(join(corePath, 'dist/index.js'));

const doc = new Document();
const buffer = doc.createBuffer();

/** axis-aligned boxes merged into one primitive: [[minx,miny,minz,maxx,maxy,maxz], ...] */
function boxesPrim(boxes, material) {
	const pos = [];
	const nrm = [];
	const idx = [];
	for (const [x0, y0, z0, x1, y1, z1] of boxes) {
		const faces = [
			[[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
			[[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
			[[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
			[[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
			[[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
			[[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]]
		];
		for (const [n, quad] of faces) {
			const base = pos.length / 3;
			for (const v of quad) {
				pos.push(...v);
				nrm.push(...n);
			}
			idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
		}
	}
	const prim = doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
		.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
		.setMaterial(material);
	return prim;
}

const wood = doc.createMaterial('Wood').setBaseColorFactor([0.55, 0.36, 0.2, 1]).setRoughnessFactor(0.8);
const stone = doc.createMaterial('Stone').setBaseColorFactor([0.6, 0.6, 0.62, 1]).setRoughnessFactor(0.9);

const frameMesh = doc.createMesh('Frame').addPrimitive(
	boxesPrim(
		[
			[-0.65, 0, -0.1, -0.5, 2.15, 0.1], // left post
			[0.5, 0, -0.1, 0.65, 2.15, 0.1], // right post
			[-0.5, 2.0, -0.1, 0.5, 2.15, 0.1] // lintel
		],
		stone
	)
);
const leafMesh = doc.createMesh('Leaf').addPrimitive(boxesPrim([[0.02, 0.01, -0.04, 0.98, 1.98, 0.04]], wood));

const frame = doc.createNode('Frame').setMesh(frameMesh);
const leaf = doc.createNode('Leaf').setMesh(leafMesh).setTranslation([-0.5, 0, 0]);
const root = doc.createNode('TestDoor').addChild(frame).addChild(leaf);
doc.createScene('Scene').addChild(root);

/** a rotation clip about Y on the leaf @param {string} name @param {number[]} times @param {number[]} degs */
function yClip(name, times, degs) {
	const quats = [];
	for (const d of degs) {
		const h = (d * Math.PI) / 360;
		quats.push(0, Math.sin(h), 0, Math.cos(h));
	}
	const input = doc.createAccessor().setType('SCALAR').setArray(new Float32Array(times)).setBuffer(buffer);
	const output = doc.createAccessor().setType('VEC4').setArray(new Float32Array(quats)).setBuffer(buffer);
	const sampler = doc.createAnimationSampler().setInput(input).setOutput(output).setInterpolation('LINEAR');
	const channel = doc.createAnimationChannel().setTargetNode(leaf).setTargetPath('rotation').setSampler(sampler);
	doc.createAnimation(name).addSampler(sampler).addChannel(channel);
}
yClip('idle', [0, 1], [0, 0]);
yClip('open', [0, 1], [0, -90]);
yClip('close', [0, 1], [-90, 0]);

const out = join(dirname(fileURLToPath(import.meta.url)), 'test-door.glb');
writeFileSync(out, await new NodeIO().writeBinary(doc));
console.log('wrote', out);
