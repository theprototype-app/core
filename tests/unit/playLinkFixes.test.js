// @ts-nocheck — plain fixtures
// fix-play-link: the pure rules behind the play-link fixes found on real devices (device lab
// 2026-11-05): the player page's modules ask (Q1 + "Load anyway" remembered per module + version),
// a joining eye stepping clear of another player's avatar, a centred HUD menu shrinking to fit a
// folded phone, and the sky picker's Max label saying what Max loads.
import { describe, it, expect, beforeEach } from 'vitest';
import { planPlayerAsk, rememberLoadAnyway, answeredAnyway, askKey, ANYWAY_KEY } from '../../src/lib/play/moduleAsk.js';
import { clearOfAvatars, AVATAR_CLEARANCE } from '../../src/lib/playSpawn.js';
import { hudCenterFit } from '../../src/lib/play/hudSafeArea.js';
import { skyMaxLabel, skyFileTier } from '../../src/lib/hdri/hdriCore.js';
import { safeStorage } from '../../src/lib/safeStorage';

describe('player page modules ask', () => {
	beforeEach(() => safeStorage.removeItem(ANYWAY_KEY));

	it('installs an official module without asking and asks about nothing else', () => {
		const plan = planPlayerAsk({ fetchable: [{ id: 'collectible', version: '1.0.0' }], disabled: [], official: ['collectible', 'waves'] });
		expect(plan.autoInstall.map((e) => e.id)).toEqual(['collectible']);
		expect(plan.skipAsk).toBe(true);
	});

	it('asks about a module the official repo does not list, and a switched-off one', () => {
		const plan = planPlayerAsk({
			fetchable: [{ id: 'collectible', version: '1.0.0' }, { id: 'someones-mod', version: '0.3.0' }],
			disabled: [{ id: 'waves', version: '2.2.0' }],
			official: new Set(['collectible', 'waves'])
		});
		expect(plan.autoInstall.map((e) => e.id)).toEqual(['collectible']);
		expect(plan.ask.fetchable.map((e) => e.id)).toEqual(['someones-mod']);
		// switched off is the player's own choice: never auto-enabled, even when official
		expect(plan.ask.disabled.map((e) => e.id)).toEqual(['waves']);
		expect(plan.skipAsk).toBe(false);
	});

	it('remembers Load anyway per module AND version', () => {
		rememberLoadAnyway([{ id: 'someones-mod', version: '0.3.0' }]);
		expect(answeredAnyway([{ id: 'someones-mod', version: '0.3.0' }])).toHaveLength(1);
		// a newer version is a different answer to give
		expect(answeredAnyway([{ id: 'someones-mod', version: '0.4.0' }])).toHaveLength(0);
		const plan = planPlayerAsk({ fetchable: [{ id: 'someones-mod', version: '0.3.0' }], disabled: [], official: [] });
		expect(plan.skipAsk).toBe(true);
		const newer = planPlayerAsk({ fetchable: [{ id: 'someones-mod', version: '0.4.0' }], disabled: [], official: [] });
		expect(newer.skipAsk).toBe(false);
	});

	it('survives garbage in storage and keys an unversioned entry', () => {
		safeStorage.setItem(ANYWAY_KEY, '{not json');
		expect(answeredAnyway([{ id: 'a', version: '1' }])).toEqual([]);
		expect(askKey({ id: 'a' })).toBe('a@');
		safeStorage.setItem(ANYWAY_KEY, '"a string"');
		expect(answeredAnyway([{ id: 'a', version: '1' }])).toEqual([]);
	});

	it('with the gallery unreachable (no official ids) everything is asked, as before', () => {
		const plan = planPlayerAsk({ fetchable: [{ id: 'collectible', version: '1.0.0' }], disabled: [], official: [] });
		expect(plan.autoInstall).toEqual([]);
		expect(plan.ask.fetchable).toHaveLength(1);
	});
});

describe('a joining eye steps clear of other avatars', () => {
	const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

	it('keeps an eye that is already clear', () => {
		const eye = [0, 1.7, 0];
		expect(clearOfAvatars(eye, [[5, 1.7, 0]])).toBe(eye);
		expect(clearOfAvatars(eye, [])).toBe(eye);
	});

	it('moves an eye inside an avatar head to a clear spot behind the facing, same height', () => {
		const head = [0, 1.7, 0];
		const spot = clearOfAvatars([0.1, 1.7, 0], [head], 0);
		expect(dist(spot, head)).toBeGreaterThanOrEqual(AVATAR_CLEARANCE);
		expect(spot[1]).toBe(1.7);
		// yaw 0 faces -Z, so behind is +Z: the other player is in front, in view
		expect(spot[2]).toBeGreaterThan(0.5);
	});

	it('respects the facing and walks the ring when behind is taken', () => {
		const a = [0, 1.7, 0];
		const behind = [0, 1.7, 1.2];
		const spot = clearOfAvatars([0, 1.7, 0], [a, behind], 0);
		for (const o of [a, behind]) expect(dist(spot, o)).toBeGreaterThanOrEqual(AVATAR_CLEARANCE);
		const turned = clearOfAvatars([0, 1.7, 0], [a], Math.PI / 2);
		// facing -X (yaw +90 deg): behind is +X
		expect(turned[0]).toBeGreaterThan(0.5);
	});

	it('gives up gracefully in a crowd (keeps the eye rather than jumping far)', () => {
		const crowd = [];
		for (let x = -5; x <= 5; x += 0.5) for (let z = -5; z <= 5; z += 0.5) crowd.push([x, 1.7, z]);
		const eye = [0, 1.7, 0];
		expect(clearOfAvatars(eye, crowd)).toBe(eye);
	});
});

describe('a centred HUD menu fits a folded phone', () => {
	// the Towers menu: a 640 x 520 panel 20 px below the middle, a 580 px wide description
	const towers = [
		{ anchor: 'center', x: 0, y: 20, w: 640, h: 520, kind: 'panel' },
		{ anchor: 'center', x: 0, y: -154, w: 580, h: 44, kind: 'text' },
		{ anchor: 'top-left', x: 12, y: 12, w: 900, h: 40, kind: 'text' }
	];

	it('leaves a desktop alone', () => {
		expect(hudCenterFit(towers, 1600, 900)).toBe(1);
	});

	it('shrinks to the folded N6 width (corner elements do not count)', () => {
		const k = hudCenterFit(towers, 384, 800);
		expect(k).toBeLessThan(1);
		// the panel's half-width after the scale fits inside half the screen less the margin
		expect(320 * k).toBeLessThanOrEqual(384 / 2 - 12 + 0.5);
	});

	it('fits the height too (a landscape phone)', () => {
		const k = hudCenterFit(towers, 900, 400);
		expect((20 + 260) * k).toBeLessThanOrEqual(400 / 2 - 12 + 0.5);
	});

	it('counts the player text size growth', () => {
		const plain = hudCenterFit([{ anchor: 'center', x: 0, y: 0, w: 300, h: 40 }], 384, 800);
		const grown = hudCenterFit([{ anchor: 'center', x: 0, y: 0, w: 300, h: 40 }], 384, 800, () => 1.5);
		expect(plain).toBe(1);
		expect(grown).toBeLessThan(1);
	});

	it('is 1 with no centred elements or no viewport', () => {
		expect(hudCenterFit([{ anchor: 'top-left', w: 2000, h: 50 }], 384, 800)).toBe(1);
		expect(hudCenterFit(towers, 0, 0)).toBe(1);
	});
});

describe('the sky picker says what Max loads', () => {
	it('names 8K exactly where skyFileTier would load the 8K file', () => {
		const tiers = ['1k', '2k', '4k', '8k'];
		for (const facts of [{ memoryGB: 8 }, { memoryGB: 16, phone: true }, { memoryGB: 4 }, {}]) {
			const loads8k = skyFileTier('max', tiers, facts) === '8k';
			expect(skyMaxLabel(facts).includes('8K')).toBe(loads8k);
		}
		expect(skyMaxLabel({ memoryGB: 4 })).toBe('Max (4K)');
	});
});
