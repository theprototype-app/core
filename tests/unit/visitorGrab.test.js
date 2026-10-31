// Roadmap 71 TR6 — the visitor grab default: viewers cannot grab unless the scene allows it, and then
// only an unlocked dynamic body. A build with no roles plugin is unchanged.
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { rolesInfo } from '../../src/lib/cloudHooks';
import { setScenePhysics, normalizeScenePhysics } from '../../src/lib/scenePhysics';
import { globalScene, lockedObjects, objectsGroup } from '../../src/stores/sceneStore';
import { mayGrab, visitorMessageAllowed, visitorsCanGrab } from '../../src/lib/visitorGrab';

/** @param {string} mode */
function body(mode) {
	const o = new THREE.Object3D();
	o.userData.physics = { mode };
	return o;
}
const group = new THREE.Group();
const crate = body('dynamic');
const statue = body('static');
group.add(crate, statue);
const scene = new THREE.Scene();
scene.add(group);

const move = (/** @type {any} */ uuid, /** @type {any} */ extra = {}) => ({ type: 'move', uuid, pos: [1, 1, 1], ...extra });

beforeEach(() => {
	globalScene.set(/** @type {any} */ (scene));
	objectsGroup.set(/** @type {any} */ (group));
	lockedObjects.set(/** @type {any} */ ([]));
	rolesInfo.set(/** @type {any} */ ({ myRole: 'viewer' }));
	setScenePhysics({ play: { visitorsGrab: false } });
});

describe('the switch in the scene block', () => {
	it('is written only when on, so an older scene stays byte-identical', () => {
		const off = normalizeScenePhysics({ play: { visitorsGrab: false } });
		expect('visitorsGrab' in off.play).toBe(false);
		expect('visitorsGrab' in normalizeScenePhysics({ play: { visitorsGrab: 'yes' } }).play).toBe(false);
		expect(normalizeScenePhysics({ play: { visitorsGrab: true } }).play.visitorsGrab).toBe(true);
	});
	it('a publisher can say so too', () => {
		const mod = new THREE.Object3D();
		mod.userData.play = { visitorsGrab: true };
		expect(visitorsCanGrab()).toBe(false);
		scene.add(mod);
		expect(visitorsCanGrab()).toBe(true);
		scene.remove(mod);
		expect(visitorsCanGrab()).toBe(false);
	});
});

describe('mayGrab', () => {
	it('a viewer cannot grab by default', () => {
		expect(mayGrab(crate)).toBe(false);
	});
	it('the switch allows dynamic bodies only', () => {
		setScenePhysics({ play: { visitorsGrab: true } });
		expect(mayGrab(crate)).toBe(true);
		expect(mayGrab(statue)).toBe(false);
	});
	it('a locked body stays out of reach', () => {
		setScenePhysics({ play: { visitorsGrab: true } });
		lockedObjects.set(/** @type {any} */ ([['someone', crate.uuid]]));
		expect(mayGrab(crate)).toBe(false);
	});
	it("a viewer's own local object is theirs", () => {
		const mine = body('static');
		mine.userData.__localOnly = true;
		expect(mayGrab(mine)).toBe(true);
	});
	it('no roles plugin, or an editor: as before', () => {
		rolesInfo.set(null);
		expect(mayGrab(statue)).toBe(true);
		rolesInfo.set(/** @type {any} */ ({ myRole: 'editor' }));
		expect(mayGrab(statue)).toBe(true);
	});
});

describe('visitorMessageAllowed', () => {
	it('is off with the switch', () => {
		expect(visitorMessageAllowed(move(crate.uuid))).toBe(false);
		expect(visitorMessageAllowed({ type: 'hit', uuid: crate.uuid })).toBe(false);
	});
	it('with the switch: a dynamic body, not a static or unknown one', () => {
		setScenePhysics({ play: { visitorsGrab: true } });
		expect(visitorMessageAllowed(move(crate.uuid))).toBe(true);
		expect(visitorMessageAllowed({ type: 'throw', uuid: crate.uuid })).toBe(true);
		expect(visitorMessageAllowed({ type: 'hit', uuid: crate.uuid })).toBe(true);
		expect(visitorMessageAllowed(move(statue.uuid))).toBe(false);
		expect(visitorMessageAllowed(move('nobody'))).toBe(false);
		expect(visitorMessageAllowed({ type: 'move' })).toBe(false);
		expect(visitorMessageAllowed(null)).toBe(false);
	});
	it('a carry never resizes', () => {
		setScenePhysics({ play: { visitorsGrab: true } });
		expect(visitorMessageAllowed(move(crate.uuid, { scale: [1, 1, 1] }))).toBe(true);
		expect(visitorMessageAllowed(move(crate.uuid, { scale: [9, 9, 9] }))).toBe(false);
		expect(visitorMessageAllowed(move(crate.uuid, { scale: 'big' }))).toBe(false);
	});
	it('a locked body is refused', () => {
		setScenePhysics({ play: { visitorsGrab: true } });
		lockedObjects.set(/** @type {any} */ ([['someone', crate.uuid]]));
		expect(visitorMessageAllowed(move(crate.uuid))).toBe(false);
	});
});
