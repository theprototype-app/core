// 71 AS3 — the block toast offers the real fix. A session block holds a peer id, and a guest
// comes back with a new one: blocking a guest says so and offers Require approval to join (and,
// where a plugin can, Signed-in people only). A signed-in person's toast stays the plain one.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$lib/notifyPrefs', () => ({ notifyOn: () => true }));

const mod = await import('../../src/lib/peerModeration.js');
const { roomAccess, setRoomAccess } = await import('../../src/lib/cloudHooks.js');
const { sessionHost } = await import('../../src/lib/connectionState.js');
const { toastStore } = await import('../../src/stores/appStore.js');

const labels = (/** @type {any} */ t) => t.actions.map((/** @type {any} */ a) => a.label);
const press = (/** @type {any} */ t, /** @type {string} */ label) => t.actions.find((/** @type {any} */ a) => a.label === label).action();

beforeEach(() => {
	setRoomAccess(null);
	sessionHost.set(null); // we host
	mod.resetModeration();
	toastStore.set([]);
});

describe('71 AS3 blockToast', () => {
	it('OSS (no plugin): the guest line and Require approval only', () => {
		const t = mod.blockToast('cccc3', 'Cleo');
		expect(t.text).toMatch(/Cleo was removed and blocked for this session/);
		expect(t.text).toMatch(/new id/);
		expect(labels(t)).toEqual(['Allow back', 'Require approval to join']);
	});
	it('Require approval turns the session flag on (and offers Undo)', () => {
		const t = mod.blockToast('cccc3', 'Cleo');
		press(t, 'Require approval to join');
		expect(get(mod.requireApproval)).toBe(true);
		const last = get(toastStore).at(-1);
		expect(last.text).toMatch(/needs your approval to join/);
		last.actions[0].action(); // Undo
		expect(get(mod.requireApproval)).toBe(false);
	});
	it('already on: no button for it, and the line says the new id lands on a card', () => {
		mod.setRequireApproval(true, { quiet: true });
		const t = mod.blockToast('cccc3', 'Cleo');
		expect(labels(t)).toEqual(['Allow back']);
		expect(t.text).toMatch(/lands on an approval card/);
	});
	it('a cloud build: both fixes, and the plugin also makes the room ask', async () => {
		const calls = /** @type {string[]} */ ([]);
		setRoomAccess({
			isGuest: () => true,
			requireApproval: () => calls.push('gated'),
			signedInOnly: () => calls.push('signedIn'),
			state: () => ({})
		});
		const t = mod.blockToast('cccc3', 'Cleo');
		expect(labels(t)).toEqual(['Allow back', 'Require approval to join', 'Signed-in people only']);
		press(t, 'Require approval to join');
		press(t, 'Signed-in people only');
		await Promise.resolve();
		expect(calls).toEqual(['gated', 'signedIn']);
		expect(get(mod.requireApproval)).toBe(true);
	});
	it('the room is already signed-in only: that button is left out', () => {
		setRoomAccess({ signedInOnly: () => {}, state: () => ({ signedInOnly: true }) });
		expect(labels(mod.blockToast('cccc3', 'Cleo'))).toEqual(['Allow back', 'Require approval to join']);
	});
	it('a signed-in person: the plain toast (the account block list holds across sessions)', () => {
		setRoomAccess({ isGuest: () => false, signedInOnly: () => {} });
		const t = mod.blockToast('cccc3', 'Cleo');
		expect(t.text).toBe('Cleo was removed and blocked for this session.');
		expect(labels(t)).toEqual(['Allow back']);
	});
	it('not the host (an admin elsewhere in the mesh): no fix to offer', () => {
		sessionHost.set('aaaa1');
		expect(labels(mod.blockToast('cccc3', 'Cleo'))).toEqual(['Allow back']);
	});
	it('a throwing plugin degrades to the OSS toast', () => {
		setRoomAccess({ isGuest: () => { throw new Error('x'); }, state: () => { throw new Error('y'); } });
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(labels(mod.blockToast('cccc3', 'Cleo'))).toEqual(['Allow back', 'Require approval to join']);
		spy.mockRestore();
	});
	it('a malformed provider is dropped', () => {
		setRoomAccess('nope');
		expect(get(roomAccess)).toBe(null);
	});
	it('leaving the session turns Require approval off', () => {
		mod.setRequireApproval(true, { quiet: true });
		mod.resetModeration();
		expect(get(mod.requireApproval)).toBe(false);
	});
});
