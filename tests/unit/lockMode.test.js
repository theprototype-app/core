// 80a K15: who may set the room's lock mode, and which `lockmode` is followed.
import { describe, it, expect, beforeEach } from 'vitest';
import { get } from 'svelte/store';
import { lockMode, setLockMode, applyLockMode, lockModeMessage, resetLockMode, maySetLockMode, speaksForLockMode, isLockMode } from '../../src/lib/lockMode.js';
import { sessionHost } from '../../src/lib/connectionState.js';
import { rolesInfo } from '../../src/lib/cloudHooks.js';

describe('lock mode', () => {
	beforeEach(() => {
		sessionHost.set(null);
		rolesInfo.set(null);
		resetLockMode();
	});
	it('defaults to lock while selected, and says nothing on the wire until changed', () => {
		expect(get(lockMode).mode).toBe('select');
		expect(lockModeMessage()).toBe(null);
	});
	it('the host sets it; a joiner may not', () => {
		expect(maySetLockMode()).toBe(true);
		expect(setLockMode('edit')).toBe(true);
		expect(get(lockMode).mode).toBe('edit');
		expect(lockModeMessage()?.mode).toBe('edit');
		sessionHost.set('host-1');
		expect(maySetLockMode()).toBe(false);
		expect(setLockMode('select')).toBe(false);
	});
	it('an admin under a roles plugin may set it, a viewer host may not', () => {
		sessionHost.set('host-1');
		rolesInfo.set(/** @type {any} */ ({ amAdmin: true, myRole: 'admin', roleOf: () => 'editor' }));
		expect(maySetLockMode()).toBe(true);
		sessionHost.set(null);
		rolesInfo.set(/** @type {any} */ ({ amAdmin: false, myRole: 'viewer', roleOf: () => 'editor' }));
		expect(maySetLockMode()).toBe(false);
	});
	it('follows the host (or an admin) only, latest stamp wins', () => {
		sessionHost.set('host-1');
		expect(speaksForLockMode('host-1')).toBe(true);
		expect(speaksForLockMode('someone')).toBe(false);
		applyLockMode({ mode: 'edit', at: 10 }, 'someone');
		expect(get(lockMode).mode).toBe('select');
		applyLockMode({ mode: 'edit', at: 10 }, 'host-1');
		expect(get(lockMode).mode).toBe('edit');
		applyLockMode({ mode: 'select', at: 5 }, 'host-1');
		expect(get(lockMode).mode).toBe('edit');
		rolesInfo.set(/** @type {any} */ ({ amAdmin: false, myRole: 'editor', roleOf: (/** @type {string} */ id) => (id === 'adm' ? 'admin' : 'editor') }));
		applyLockMode({ mode: 'select', at: 20 }, 'adm');
		expect(get(lockMode).mode).toBe('select');
	});
	it('refuses anything that is not a mode', () => {
		expect(isLockMode('edit')).toBe(true);
		expect(isLockMode('take')).toBe(false);
		expect(setLockMode(/** @type {any} */ ('take'))).toBe(false);
	});
});
