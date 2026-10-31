import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { loadSandbox, newGuest, ENTRY_DEADLINE_MS, fromGuestJson } from '../../src/lib/sandbox/engine.js';
import {
	compileInGuest,
	runEffectInGuest,
	runValueInGuest,
	runPlayerInGuest,
	applyObjectPatch
} from '../../src/lib/sandbox/scripts.js';

// 69 T1: Script nodes run in the QuickJS guest. What a script could reach in the app realm (the
// window, storage, cookies, the network, the live object's parent chain) is not there; what it is
// FOR (moving its object, returning values, the api) works as it did, synchronously.

let n = 0;
/** compile in the guest and hand back the key @param {string} shape @param {string} body */
function compiled(shape, body) {
	const key = 't' + ++n;
	const error = compileInGuest(key, shape, '"use strict";\n' + body);
	if (error) throw new Error(error);
	return key;
}

beforeAll(async () => {
	await loadSandbox();
});

describe('effects move the real object', () => {
	it('a v1 script writes position from base and time', () => {
		const o = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
		o.position.set(1, 2, 3);
		const key = compiled('v1', 'object.position.y = base.pos[1] + Math.sin(time) * 2;');
		runEffectInGuest(key, false, o, { pos: [1, 2, 3], rot: [0, 0, 0], scale: [1, 1, 1], visible: true }, {}, Math.PI / 2, undefined, undefined);
		expect(o.position.toArray()).toEqual([1, 4, 3]);
	});

	it('rotation, scale, visibility and a material colour come back; untouched fields stay', () => {
		const o = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x00ff00 }));
		o.position.set(5, 6, 7);
		const key = compiled('v1', "object.rotation.y = 0.5; object.scale.setScalar(2); object.visible = false; object.material.color.set('#ff0000'); object.material.opacity = 0.4;");
		runEffectInGuest(key, false, o, null, {}, 0);
		expect(o.rotation.y).toBeCloseTo(0.5);
		expect(o.quaternion.y).toBeCloseTo(Math.sin(0.25)); // three re-derived it from the rotation
		expect(o.scale.toArray()).toEqual([2, 2, 2]);
		expect(o.visible).toBe(false);
		expect(o.material.color.getHex()).toBe(0xff0000);
		expect(o.material.opacity).toBeCloseTo(0.4);
		expect(o.position.toArray()).toEqual([5, 6, 7]);
	});

	it('lookAt / rotateY / translateZ match three', () => {
		const real = new THREE.Object3D();
		real.position.set(1, 0, 0);
		real.lookAt(4, 2, -3);
		real.rotateY(0.3);
		real.translateZ(2);
		const o = new THREE.Object3D();
		o.position.set(1, 0, 0);
		const key = compiled('v1', 'object.lookAt(4, 2, -3); object.rotateY(0.3); object.translateZ(2);');
		runEffectInGuest(key, false, o, null, {}, 0);
		o.position.toArray().forEach((v, i) => expect(v).toBeCloseTo(real.position.getComponent(i), 6));
		expect(o.quaternion.angleTo(real.quaternion)).toBeLessThan(1e-6);
	});

	it('userData: read, write a key, delete a key; prototype keys refused', () => {
		const o = new THREE.Object3D();
		o.userData = { hp: 3, keep: 'x', drop: 1 };
		const key = compiled('v1', 'object.userData.hp = object.userData.hp - 1; delete object.userData.drop;');
		runEffectInGuest(key, false, o, null, {}, 0);
		expect(o.userData).toEqual({ hp: 2, keep: 'x' });
		applyObjectPatch(o, JSON.parse('{"ud": {"__proto__": {"polluted": true}}}'));
		expect(/** @type {any} */ ({}).polluted).toBeUndefined();
		expect(Object.getPrototypeOf(o.userData)).toBe(Object.prototype);
	});

	it('a v2 value script returns; a player body returns', () => {
		const key = compiled('value', 'return { out: inputs.a * 2, d: dist([0,0,0], [3,4,0]) };');
		expect(runValueInGuest(key, { a: 21 }, 0)).toEqual({ out: 42, d: 5 });
		const p = compiled('player', 'return { speed: settings.speed * (input.run ? 2 : 1) };');
		expect(runPlayerInGuest(p, { speed: 3 }, { run: true }, 0)).toEqual({ speed: 6 });
	});

	it('the api is the host api, synchronously, errors and all', () => {
		const key = compiled('value', 'return { o: api.object("Box"), k: (() => { try { api.keys(); } catch (e) { return e.message; } })() };');
		const api = {
			object: (/** @type {any} */ ref) => (ref === 'Box' ? { uuid: 'u1', name: 'Box', position: [1, 2, 3] } : null),
			keys: () => {
				throw new Error('api.keys() is this device input');
			}
		};
		expect(runValueInGuest(key, {}, 0, api)).toEqual({ o: { uuid: 'u1', name: 'Box', position: [1, 2, 3] }, k: 'api.keys() is this device input' });
	});
});

describe('hostile scripts reach nothing', () => {
	it('guest JSON never yields a __proto__ key, however it is spelled', () => {
		for (const json of ['{"v":{"__proto__":{"polluted":true},"a":1}}', '{"v":{"\\u005f_proto__":{"polluted":true},"a":1}}']) {
			const out = fromGuestJson(json);
			expect(Object.keys(out.v)).toEqual(['a']);
			expect(/** @type {any} */ (Object.assign({}, out.v)).polluted).toBeUndefined();
		}
	});

	it('no window, document, storage, cookies, network or host realm', () => {
		const key = compiled(
			'value',
			`const g = (0, eval)('this');
			 const viaCtor = (function(){}).constructor('return this')();
			 return {
				names: ['window','document','localStorage','sessionStorage','indexedDB','fetch','XMLHttpRequest','WebSocket','RTCPeerConnection','navigator','location','importScripts','process','require','__host']
					.filter((k) => typeof g[k] !== 'undefined'),
				same: g === viaCtor,
				bridgeHasNoHost: typeof __host === 'undefined'
			 };`
		);
		const out = runValueInGuest(key, {}, 0);
		expect(out.names).toEqual([]);
		expect(out.same).toBe(true);
		expect(out.bridgeHasNoHost).toBe(true);
	});

	it('the object is a view: no parent, no geometry, its constructor is the guest Object', () => {
		const scene = new THREE.Scene();
		const o = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
		scene.add(o);
		const key = compiled('v1', "object.userData.seen = [typeof object.parent, typeof object.geometry, object.constructor.constructor('return typeof document')()].join(',');");
		runEffectInGuest(key, false, o, null, {}, 0);
		expect(o.userData.seen).toBe('undefined,undefined,undefined');
	});

	it('a runaway the loop guard cannot see is stopped at the deadline', async () => {
		const g = newGuest({}, []);
		expect(g).not.toBeNull();
		const started = performance.now();
		expect(() => g?.evalScript('for(;;){}', 'spin.js')).toThrow(/took longer than/);
		expect(performance.now() - started).toBeLessThan(ENTRY_DEADLINE_MS * 4);
		g?.dispose();
	});
});
