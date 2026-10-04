// @ts-nocheck — fakes for the camera, the controls and the placeholder read
// 36 L2: the scene start view — applied at the START of a load, a user's move wins, and a
// "Hold camera until loaded" hold that can never trap anyone.
import { describe, it, expect, beforeEach, vi } from 'vitest';

let stalled = false;
vi.mock('../../src/lib/placeholders.js', () => ({ allPlaceholdersStalled: () => stalled }));

const { globalCamera, orbitControls, isVRMode, isLocked } = await import('../../src/stores/sceneStore.js');
const { specatorMode } = await import('../../src/stores/appStore.js');
const { beginLoad, endLoad, cancelLoad, updateLoad } = await import('../../src/lib/sceneLoader.js');
const { placeholderStuckSeconds } = await import('../../src/lib/loadStates.js');
const { navSuppressors, worldGrabDiverts } = await import('../../src/lib/vr/hooks.js');
const sv = await import('../../src/lib/startView.js');

/** a vector with the three bits startView touches */
function vec(x = 0, y = 0, z = 0) {
	return {
		x,
		y,
		z,
		fromArray(a) {
			this.x = a[0];
			this.y = a[1];
			this.z = a[2];
			return this;
		},
		set(x, y, z) {
			this.x = x;
			this.y = y;
			this.z = z;
		}
	};
}
/** OrbitControls' contract that matters here: update() applies pending motion; damping keeps a remainder */
function fakeControls(camera) {
	return {
		target: vec(),
		enabled: true,
		enableDamping: true,
		pending: [0, 0, 0],
		update() {
			const k = this.enableDamping ? 0.1 : 1;
			camera.position.x += this.pending[0] * k;
			camera.position.y += this.pending[1] * k;
			camera.position.z += this.pending[2] * k;
			this.pending = this.enableDamping ? this.pending.map((v) => v * 0.9) : [0, 0, 0];
		}
	};
}

const VIEW = { position: [4, 3, 8], target: [0, 1, 0] };
let now = 0;
let camera;
let controls;
beforeEach(() => {
	now = 1000;
	stalled = false;
	sv.setStartViewClockForTest(() => now);
	sv.resetStartViewForTest();
	cancelLoad({ superseded: true });
	camera = { position: vec(-10, 10, 10), lookAt() {} };
	controls = fakeControls(camera);
	globalCamera.set(camera);
	orbitControls.set(controls);
	isVRMode.set(false);
	isLocked.set(null);
	specatorMode.set(false);
	placeholderStuckSeconds.set(10);
});

const pose = () => [camera.position.x, camera.position.y, camera.position.z];

describe('the view is applied at the START of the load', () => {
	it('parks the camera before any object exists', () => {
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		expect(pose()).toEqual([4, 3, 8]);
		expect([controls.target.x, controls.target.y, controls.target.z]).toEqual([0, 1, 0]);
	});
	it('flushes momentum left over from a drag that began before the load', () => {
		controls.pending = [5, 0, 0];
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		controls.update(); // the next frame
		expect(pose()).toEqual([4, 3, 8]);
	});
	it('no saved view: nothing moves and nothing is held', () => {
		const job = beginLoad('Selection', 3);
		sv.beginStartView(job, null, { hold: true });
		expect(pose()).toEqual([-10, 10, 10]);
		expect(sv.startViewHeld()).toBe(false);
	});
	it('in VR the headset owns the camera', () => {
		isVRMode.set(true);
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		expect(pose()).toEqual([-10, 10, 10]);
	});
});

describe('start view first (the default): a user move wins', () => {
	it('no move: the settle leaves it on the view, no Back button', () => {
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		sv.tickStartView();
		sv.settleStartView(job);
		endLoad(job);
		sv.tickStartView();
		expect(pose()).toEqual([4, 3, 8]);
		expect(sv.startViewDebug().hint).toBe(null);
	});
	it('a move during the load is never undone, and the Back button appears at the end', () => {
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		camera.position.set(20, 5, -3); // the user orbits mid-load
		sv.tickStartView();
		expect(sv.startViewDebug().moved).toBe(true);
		sv.settleStartView(job); // where the old code applied payload.camera
		expect(pose()).toEqual([20, 5, -3]);
		endLoad(job);
		sv.tickStartView();
		expect(pose()).toEqual([20, 5, -3]);
		expect(sv.startViewDebug().hint?.kind).toBe('back');
	});
	it('a move between two ticks is still caught by the settle itself', () => {
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		camera.position.set(1, 1, 1);
		sv.settleStartView(job);
		expect(pose()).toEqual([1, 1, 1]);
	});
	it('a cancelled load offers no Back button', () => {
		const job = beginLoad('Tavern', 100);
		sv.beginStartView(job, VIEW);
		camera.position.set(1, 1, 1);
		sv.tickStartView();
		cancelLoad();
		sv.tickStartView();
		expect(sv.startViewDebug().hint).toBe(null);
	});
	it('a superseding load takes the camera to ITS view', () => {
		const a = beginLoad('A', 100);
		sv.beginStartView(a, VIEW);
		const b = beginLoad('B', 10);
		sv.beginStartView(b, { position: [1, 2, 3], target: [0, 0, 0] });
		expect(pose()).toEqual([1, 2, 3]);
		sv.settleStartView(a); // the stale load's settle does nothing
		expect(pose()).toEqual([1, 2, 3]);
	});
});

describe('hold camera until loaded', () => {
	const begin = () => {
		const job = beginLoad('Market', 100);
		sv.beginStartView(job, VIEW, { hold: true });
		return job;
	};
	it('input is undone every frame and the controls stand down', () => {
		begin();
		expect(sv.startViewHeld()).toBe(true);
		expect(controls.enabled).toBe(false);
		camera.position.set(9, 9, 9); // fly keys, a trackpad pan…
		sv.tickStartView();
		expect(pose()).toEqual([4, 3, 8]);
		controls.enabled = true; // <TransformControls> writes it back on its own
		sv.tickStartView();
		expect(controls.enabled).toBe(false);
	});
	it('VR locomotion is suppressed through the existing registries', () => {
		begin();
		expect(navSuppressors.some((fn) => fn())).toBe(true);
		expect(worldGrabDiverts.some((h) => h.active())).toBe(true);
		sv.releaseHold('user');
		expect(navSuppressors.some((fn) => fn())).toBe(false);
		expect(worldGrabDiverts.some((h) => h.active())).toBe(false);
	});
	it('"Take control" shows after 1.5 s', () => {
		begin();
		sv.tickStartView();
		expect(sv.startViewDebug().hint).toMatchObject({ kind: 'held', takeControl: false });
		now += 1500;
		sv.tickStartView();
		expect(sv.startViewDebug().hint).toMatchObject({ kind: 'held', takeControl: true });
	});
	it('(a) ends when everything loaded, and the controls come back', () => {
		const job = begin();
		endLoad(job);
		sv.tickStartView();
		expect(sv.startViewHeld()).toBe(false);
		expect(sv.startViewDebug().releasedBy).toBe('loaded');
		expect(controls.enabled).toBe(true);
	});
	it('(b) ends when every remaining piece is stuck or failed — never while the build runs', () => {
		const job = begin();
		stalled = true;
		sv.tickStartView(); // still building ('objects'): not yet
		expect(sv.startViewHeld()).toBe(true);
		updateLoad(job, { phase: 'models' });
		sv.tickStartView();
		expect(sv.startViewHeld()).toBe(false);
		expect(sv.startViewDebug().releasedBy).toBe('stalled');
	});
	it('(c) ends at the stuck threshold, following its setting', () => {
		placeholderStuckSeconds.set(4);
		begin();
		now += 3999;
		sv.tickStartView();
		expect(sv.startViewHeld()).toBe(true);
		now += 1;
		sv.tickStartView();
		expect(sv.startViewHeld()).toBe(false);
		expect(sv.startViewDebug().releasedBy).toBe('cap');
	});
	it('(d) ends on Take control / Esc, and the user move then wins', () => {
		const job = begin();
		sv.releaseHold('user');
		expect(sv.startViewHeld()).toBe(false);
		camera.position.set(7, 7, 7);
		sv.tickStartView();
		sv.settleStartView(job);
		expect(pose()).toEqual([7, 7, 7]);
	});
	it('a held camera that something moved is put back at the settle', () => {
		const job = begin();
		camera.position.set(9, 9, 9);
		sv.settleStartView(job);
		expect(pose()).toEqual([4, 3, 8]);
	});
});

describe('playing or spectating: the 1.21 rule, unchanged', () => {
	it('a load while playing (a travel node) applies the view at the end and never holds', () => {
		isLocked.set(true);
		const job = beginLoad('Level 2', 50);
		sv.beginStartView(job, VIEW, { hold: true });
		expect(pose()).toEqual([-10, 10, 10]);
		expect(sv.startViewHeld()).toBe(false);
		camera.position.set(2, 2, 2); // the player walks
		sv.tickStartView();
		sv.settleStartView(job);
		expect(pose()).toEqual([4, 3, 8]);
		endLoad(job);
		sv.tickStartView();
		expect(sv.startViewDebug().hint).toBe(null);
	});
	it('watching a peer: nothing is placed until the end, nothing held', () => {
		specatorMode.set(true);
		const job = beginLoad('Tavern', 50);
		sv.beginStartView(job, VIEW, { hold: true });
		expect(sv.startViewHeld()).toBe(false);
		expect(pose()).toEqual([-10, 10, 10]);
	});
	it('a hold ends the moment Play starts (a play link)', () => {
		const job = beginLoad('Market', 100);
		sv.beginStartView(job, VIEW, { hold: true });
		expect(sv.startViewHeld()).toBe(true);
		isLocked.set(true);
		camera.position.set(1, 1, 1); // the player camera
		sv.tickStartView();
		expect(sv.startViewHeld()).toBe(false);
		expect(sv.startViewDebug().releasedBy).toBe('play');
		expect(pose()).toEqual([1, 1, 1]);
		void job;
	});
});

describe('helpers', () => {
	it('normalizeStartView', () => {
		expect(sv.normalizeStartView(null)).toBe(null);
		expect(sv.normalizeStartView({ position: [1, 2] })).toBe(null);
		expect(sv.normalizeStartView({ position: [1, 2, 3] })).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
		expect(sv.normalizeStartView({ position: ['1', 2, 3], target: [4, 5, 6] })).toEqual({ position: [1, 2, 3], target: [4, 5, 6] });
	});
	it('sceneHoldsCamera reads only an explicit true', () => {
		expect(sv.sceneHoldsCamera(null)).toBe(false);
		expect(sv.sceneHoldsCamera({ holdCamera: 'yes' })).toBe(false);
		expect(sv.sceneHoldsCamera({ holdCamera: true })).toBe(true);
	});
});
