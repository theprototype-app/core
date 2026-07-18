// Pure unit tests for the agent message builders + registry (no browser, no
// network). Run: node test/messages.test.mjs
import assert from 'node:assert';
import {
	createMsg,
	lightMsg,
	moveMsg,
	colorMsg,
	nameMsg,
	deleteMsg,
	groupCreateMsg,
	groupReparentMsg,
	materialTypeMsg,
	normalizePrimitive,
	normalizeLight,
	DEFAULT_PARAMS
} from '../src/messages.js';
import { Registry } from '../src/registry.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
	try {
		fn();
		pass++;
		console.log('PASS ' + name);
	} catch (e) {
		fail++;
		console.log('FAIL ' + name + ' :: ' + e.message);
	}
}

check('createMsg builds a /create command with given params', () => {
	const m = createMsg('u1', 'box', [2, 2, 2]);
	assert.equal(m.type, 'create');
	assert.equal(m.command, '/create Box 2 2 2');
	assert.equal(m.uuid, 'u1');
});

check('createMsg falls back to catalog defaults', () => {
	const m = createMsg('u2', 'Sphere');
	assert.equal(m.command, '/create Sphere ' + DEFAULT_PARAMS.Sphere.join(' '));
});

check('createMsg rejects unknown primitive', () => {
	assert.throws(() => createMsg('u', 'banana'));
});

check('normalizePrimitive is case-insensitive', () => {
	assert.equal(normalizePrimitive('torusknot'), 'TorusKnot');
	assert.equal(normalizePrimitive('nope'), null);
});

check('lightMsg + normalizeLight', () => {
	assert.equal(lightMsg('l1', 'Point').command, '/light point');
	assert.equal(normalizeLight('SPOT'), 'spot');
	assert.throws(() => lightMsg('l', 'sun'));
});

check('moveMsg coerces to 3-arrays', () => {
	const m = moveMsg('u', [1, 2, 3], [0, 0, 0], [1, 1, 1]);
	assert.deepEqual(m.pos, [1, 2, 3]);
	assert.equal(m.type, 'move');
});

check('color/name/delete/group builders', () => {
	assert.equal(colorMsg('u', '#ff0000').color, '#ff0000');
	assert.equal(nameMsg('u', 'Wall').name, 'Wall');
	assert.equal(deleteMsg('u', 'peer1').peerId, 'peer1');
	assert.equal(groupCreateMsg('g', 'My Group').command, '/group My_Group');
	assert.equal(groupReparentMsg('u', 'g').group, 'g');
	assert.equal(materialTypeMsg('u', 'meshphongmaterial').material, 'MeshPhongMaterial');
});

check('registry tracks create/move/color/delete', () => {
	const r = new Registry();
	r.observe(createMsg('a', 'Box', [1, 1, 1]), 'peerX');
	assert.equal(r.size, 1);
	assert.equal(r.objects.get('a').primitive, 'Box');
	r.observe(moveMsg('a', [0, 1, 0], [0, 0, 0], [1, 1, 1]));
	assert.deepEqual(r.objects.get('a').pos, [0, 1, 0]);
	r.observe(colorMsg('a', '#123456'));
	assert.equal(r.objects.get('a').color, '#123456');
	r.observe(deleteMsg('a', 'peerX'));
	assert.equal(r.size, 0);
});

check('registry stubs GLTF object messages', () => {
	const r = new Registry();
	r.observe({ type: 'object', uuids: ['x', 'y'] }, 'peerX');
	assert.equal(r.size, 2);
	assert.equal(r.objects.get('x').tracked, 'stub');
});

check('registry own-create is marked self', () => {
	const r = new Registry();
	r.observeOutgoing(createMsg('own', 'Cone'));
	assert.equal(r.objects.get('own').by, 'self');
});

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
