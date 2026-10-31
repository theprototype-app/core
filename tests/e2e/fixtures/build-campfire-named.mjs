// 56 C9: builds tests/e2e/fixtures/campfire-named.glb — the shape an img2threejs rebuild exports: a
// root with NAMED pivots and sockets (Logs > Log_1..3, Flame_Pivot > Flame, Socket_Pot as an empty
// node), standard PBR materials only (no custom shaders: they do not survive glTF). The import_model
// suite asserts the peer sees this exact hierarchy.
//   node tests/e2e/fixtures/build-campfire-named.mjs   (uses this checkout's @gltf-transform/core)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';

const doc = new Document();
const buffer = doc.createBuffer();

/** one box primitive @param {number[]} b [x0,y0,z0,x1,y1,z1] @param {any} material */
function box(b, material) {
	const [x0, y0, z0, x1, y1, z1] = b;
	const faces = [
		[[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
		[[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
		[[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
		[[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
		[[0, 0, 1], [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]],
		[[0, 0, -1], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]]]
	];
	const pos = [], nrm = [], idx = [];
	for (const [n, quad] of faces) {
		const base = pos.length / 3;
		for (const v of quad) pos.push(...v), nrm.push(...n);
		idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
	}
	return doc
		.createPrimitive()
		.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buffer))
		.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buffer))
		.setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint16Array(idx)).setBuffer(buffer))
		.setMaterial(material);
}
const wood = doc.createMaterial('Wood').setBaseColorFactor([0.5, 0.32, 0.18, 1]).setRoughnessFactor(0.85);
const fire = doc.createMaterial('Fire').setBaseColorFactor([1, 0.55, 0.1, 1]).setEmissiveFactor([1, 0.4, 0.05]);
const logMesh = doc.createMesh('LogMesh').addPrimitive(box([-0.5, 0, -0.06, 0.5, 0.12, 0.06], wood));
const flameMesh = doc.createMesh('FlameMesh').addPrimitive(box([-0.12, 0, -0.12, 0.12, 0.5, 0.12], fire));

const logs = doc.createNode('Logs');
for (let i = 0; i < 3; i++) {
	const a = (i * Math.PI * 2) / 3;
	logs.addChild(doc.createNode('Log_' + (i + 1)).setMesh(logMesh).setRotation([0, Math.sin(a / 2), 0, Math.cos(a / 2)]));
}
const flamePivot = doc.createNode('Flame_Pivot').setTranslation([0, 0.12, 0]).addChild(doc.createNode('Flame').setMesh(flameMesh));
const socket = doc.createNode('Socket_Pot').setTranslation([0, 0.9, 0]);
const root = doc.createNode('Campfire').addChild(logs).addChild(flamePivot).addChild(socket);
doc.createScene('Campfire').addChild(root);

const out = join(dirname(fileURLToPath(import.meta.url)), 'campfire-named.glb');
writeFileSync(out, await new NodeIO().writeBinary(doc));
console.log('wrote', out);
