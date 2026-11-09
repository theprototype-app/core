// 93 LP1 — a portal's `show: false`: hidden on THIS peer while it plays, still a trigger, back on leaving Play,
// and never in a save (the park hook every serializer runs).
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { applyPlayVisibility } from '../../src/lib/gameLevels/play.js';
import { runParkHooks } from '../../src/lib/parkHooks.js';

function scene() {
	const root = new THREE.Group();
	const mk = (/** @type {any} */ ud) => {
		const o = new THREE.Mesh(new THREE.BoxGeometry());
		Object.assign(o.userData, ud);
		root.add(o);
		return o;
	};
	return {
		hiddenDoor: mk({ portal: { transition: 'fade', show: false } }),
		shownDoor: mk({ portal: { transition: 'fade', show: true } }),
		pad: mk({ checkpoint: { show: false } })
	};
}

describe('93 LP1 — portal show: false at play time', () => {
	it('hides only a show:false portal while playing, and gives it back on leaving Play', () => {
		const s = scene();
		const all = [s.hiddenDoor, s.shownDoor, s.pad];
		applyPlayVisibility(all, true);
		expect([s.hiddenDoor.visible, s.shownDoor.visible, s.pad.visible]).toEqual([false, true, true]);
		applyPlayVisibility(all, false);
		expect(s.hiddenDoor.visible).toBe(true);
	});
	it('a save mid-play writes it visible, and play resumes hidden', () => {
		const s = scene();
		applyPlayVisibility([s.hiddenDoor], true);
		const restore = runParkHooks();
		expect(s.hiddenDoor.visible).toBe(true);
		expect(s.hiddenDoor.toJSON().object.visible).toBe(true);
		restore();
		expect(s.hiddenDoor.visible).toBe(false);
		applyPlayVisibility([s.hiddenDoor], false);
	});
	it('one hidden by someone else (a Visibility node) is not ours to bring back', () => {
		const s = scene();
		s.hiddenDoor.visible = false;
		applyPlayVisibility([s.hiddenDoor], true);
		applyPlayVisibility([s.hiddenDoor], false);
		expect(s.hiddenDoor.visible).toBe(false);
	});
	it('a portal deleted (or turned back on) while hidden is given back', () => {
		const s = scene();
		applyPlayVisibility([s.hiddenDoor], true);
		applyPlayVisibility([], true);
		expect(s.hiddenDoor.visible).toBe(true);
		applyPlayVisibility([s.hiddenDoor], true);
		s.hiddenDoor.userData.portal.show = true;
		applyPlayVisibility([s.hiddenDoor], true);
		expect(s.hiddenDoor.visible).toBe(true);
	});
});
