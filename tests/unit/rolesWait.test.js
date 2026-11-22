// A build meant to have roles, before its plugin has spoken: above the floor nothing is allowed, messages wait
// in order, and they go through the gate again when the plugin has spoken.
import { describe, it, expect, afterEach, vi } from 'vitest';

/** a fresh cloudHooks (its wait is one-shot per page), expected or not */
async function hooks(expected = true) {
	vi.resetModules();
	vi.stubEnv('VITE_CLOUD_PLUGIN', expected ? 'https://plugin.example/p.js' : '');
	return import('../../src/lib/cloudHooks.js');
}

describe('waiting for the plugin', () => {
	afterEach(() => vi.unstubAllEnvs());

	it('no plugin expected: nothing waits and everything applies', async () => {
		const c = await hooks(false);
		expect(c.rolesPending()).toBe(false);
		expect(c.canApply('p', 'clearscene')).toBe(true);
		expect(c.knownRoleOf('p')).toBe(null);
	});

	it('plugin expected: above the floor is not allowed until it speaks, the floor is', async () => {
		const c = await hooks();
		expect(c.rolesPending()).toBe(true);
		expect(c.canApply('p', 'clearscene')).toBe(false);
		expect(c.canApply('p', 'lock')).toBe(false);
		expect(c.canApply('p', 'getobjects')).toBe(true);
		expect(c.isFloorMessage('getobjects')).toBe(true);
		expect(c.isFloorMessage('clearscene')).toBe(false);
	});

	it('an unknown role reads as viewer, then as what the plugin says', async () => {
		const c = await hooks();
		expect(c.knownRoleOf('p')).toBe('viewer');
		c.rolesInfo.set({ roleOf: () => 'editor' });
		expect(c.knownRoleOf('p')).toBe('editor');
		c.rolesInfo.set({ roleOf: () => { throw new Error('x'); } });
		expect(c.knownRoleOf('p')).toBe('viewer');
	});

	it('held messages run in order once, after the wait has ended, and see the new state', async () => {
		const c = await hooks();
		/** @type {any[]} */
		const ran = [];
		c.holdUntilRoles('a', {}, () => ran.push(['a1', c.rolesPending()]));
		c.holdUntilRoles('b', {}, () => ran.push(['b1', c.rolesPending()]));
		c.holdUntilRoles('a', {}, () => ran.push(['a2', c.rolesPending()]));
		expect(ran).toEqual([]);
		c.settleRoles();
		expect(ran).toEqual([['a1', false], ['b1', false], ['a2', false]]);
		c.settleRoles();
		expect(ran.length).toBe(3);
		expect(c.rolesPending()).toBe(false);
	});

	it('one throwing message does not lose the rest', async () => {
		const c = await hooks();
		const err = vi.spyOn(console, 'error').mockImplementation(() => {});
		/** @type {string[]} */
		const ran = [];
		c.holdUntilRoles('a', {}, () => { throw new Error('bad'); });
		c.holdUntilRoles('a', {}, () => ran.push('next'));
		c.settleRoles();
		expect(ran).toEqual(['next']);
		err.mockRestore();
	});

	it('the wait has limits: per peer by count and bytes, in all by bytes', async () => {
		const c = await hooks();
		let n = 0;
		while (c.holdUntilRoles('many', {}, () => {}) && n < 5000) n++;
		expect(n).toBe(2000);
		expect(c.holdUntilRoles('other', {}, () => {})).toBe(true);
		const big = { buffer: new ArrayBuffer(40 * 1024 * 1024) };
		expect(c.holdUntilRoles('x', big, () => {})).toBe(true);
		expect(c.holdUntilRoles('x', big, () => {})).toBe(false); // 64 MB per peer
		expect(c.holdUntilRoles('y', big, () => {})).toBe(true);
		expect(c.holdUntilRoles('z', big, () => {})).toBe(true);
		expect(c.holdUntilRoles('w', big, () => {})).toBe(false); // 128 MB in all
	});

	it('a message without a buffer counts by its text, a batch by its items', async () => {
		const c = await hooks();
		const text = { type: 'x', text: 'a'.repeat(40 * 1024 * 1024) };
		expect(c.holdUntilRoles('p', text, () => {})).toBe(true);
		expect(c.holdUntilRoles('p', text, () => {})).toBe(false);
		const batch = { type: 'batch', items: [{ buffer: new ArrayBuffer(70 * 1024 * 1024) }] };
		expect(c.holdUntilRoles('q', batch, () => {})).toBe(false);
	});

	it('the wait has a limit in all by count', async () => {
		const c = await hooks();
		let n = 0;
		for (let peer = 0; peer < 6; peer++) while (c.holdUntilRoles('p' + peer, {}, () => {}) && n < 20000) n++;
		expect(n).toBe(8000);
	});
});

describe('the plugin not coming', () => {
	it('source: every way out of startCloudPlugin ends the wait', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('../../src/lib/cloudPlugin.js', import.meta.url), 'utf8');
		const body = src.slice(src.indexOf('export async function startCloudPlugin'), src.indexOf('/** how long messages may wait'));
		for (const line of body.split('\n')) {
			// a bare return inside the function would leave messages waiting
			if (/^\s*return;/.test(line)) {
				const at = body.indexOf(line);
				expect(body.slice(Math.max(0, at - 160), at), line).toMatch(/withoutRoles/);
			}
		}
		expect(body).toMatch(/settleRoles\(\);\s*\n\s*\} catch/);
		expect(body).toMatch(/PLUGIN_WAIT_MS/);
	});
});
