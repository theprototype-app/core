// 85 I2: the press curve, the Press Button offset, the Highlight glow and the hover source
import { describe, it, expect } from 'vitest';
// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { pressDepthAt } from '../../src/lib/motion/tweenCore.js';
import { applyPress, applyHighlight, prunePressNodes, pressNodesDebug } from '../../src/lib/motion/pressNodes.js';
import { setHover, isHovered, hoverDebug, clearHovers } from '../../src/lib/hoverState.js';
import { runParkHooks } from '../../src/lib/parkHooks.js';

describe('pressDepthAt', () => {
	const d = { down: 0.1, hold: 0.2, up: 0.4 };
	it('is untouched before a press and after it settles', () => {
		expect(pressDepthAt(NaN, d)).toBe(0);
		expect(pressDepthAt(-1, d)).toBe(0);
		expect(pressDepthAt(0.7, d)).toBe(0);
		expect(pressDepthAt(100, d)).toBe(0);
	});
	it('goes in, holds, springs back with a small overshoot', () => {
		expect(pressDepthAt(0.05, d)).toBeGreaterThan(0.5);
		expect(pressDepthAt(0.15, d)).toBe(1);
		expect(pressDepthAt(0.29, d)).toBe(1);
		const back = [0.35, 0.45, 0.55, 0.65].map((t) => pressDepthAt(t, d));
		expect(back[0]).toBeLessThan(1);
		expect(Math.min(...back)).toBeLessThan(0); // the overshoot past rest
		expect(Math.min(...back)).toBeGreaterThan(-0.15);
	});
});

describe('applyPress', () => {
	it('moves the object along its OWN axis by depth x the curve', () => {
		const o = new THREE.Object3D();
		o.rotation.set(Math.PI / 2, 0, 0); // -y local = -z... after a quarter turn about x, local -y points to world -z
		o.updateMatrix();
		const f = applyPress(o, { axis: '-y', depth: 0.1, down: 0.1, hold: 0.2, up: 0.4 }, 10.2, 10);
		expect(f).toBe(1);
		expect(o.position.x).toBeCloseTo(0, 9);
		expect(o.position.y).toBeCloseTo(0, 9);
		expect(o.position.z).toBeCloseTo(-0.1, 9);
	});
	it('does nothing with no press', () => {
		const o = new THREE.Object3D();
		expect(applyPress(o, {}, 5, null)).toBe(0);
		expect(o.position.toArray()).toEqual([0, 0, 0]);
	});
});

describe('Highlight', () => {
	const mesh = () => {
		const m = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0x808080 }));
		m.material.emissive.setHex(0x102030);
		m.material.emissiveIntensity = 0.5;
		return m;
	};
	it('fades in and out, and hands the authored glow back exactly', () => {
		const m = mesh();
		const key = 'hl|' + m.uuid;
		expect(applyHighlight(m, { fade: 0.2 }, 0, key, true)).toBe(0);
		expect(applyHighlight(m, { fade: 0.2 }, 0.1, key, true)).toBeCloseTo(0.5, 9);
		expect(applyHighlight(m, { fade: 0.2 }, 0.3, key, true)).toBe(1);
		expect(m.material.emissiveIntensity).toBe(1);
		expect(m.material.emissive.getHex()).not.toBe(0x102030);
		applyHighlight(m, { fade: 0.2 }, 0.6, key, false);
		expect(m.material.emissive.getHex()).toBe(0x102030);
		expect(m.material.emissiveIntensity).toBe(0.5);
	});
	it('a save sees the authored glow, a node that goes away restores it', () => {
		const m = mesh();
		const key = 'hl2|' + m.uuid;
		applyHighlight(m, { fade: 0 }, 1, key, true);
		const lit = m.material.emissive.getHex();
		const un = runParkHooks();
		expect(m.material.emissive.getHex()).toBe(0x102030);
		un?.();
		expect(m.material.emissive.getHex()).toBe(lit);
		prunePressNodes(new Set());
		expect(m.material.emissive.getHex()).toBe(0x102030);
		expect(m.material.emissiveIntensity).toBe(0.5);
		expect(pressNodesDebug()[key]).toBeUndefined();
	});
});

describe('hoverState', () => {
	it('tracks each pointer by source', () => {
		clearHovers();
		setHover('vr0', 'a');
		setHover('play', 'b');
		expect(isHovered('a') && isHovered('b')).toBe(true);
		setHover('vr0', null);
		expect(isHovered('a')).toBe(false);
		expect(hoverDebug()).toEqual({ play: 'b' });
	});
});
