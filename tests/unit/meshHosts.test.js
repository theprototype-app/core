// fix-agenttest item 5: a handshake's mesh `hosts` never names a closed or reconnecting link (a
// rejoining peer was told about peers that had left, dialled them and got peer-unavailable).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { meshHosts } from '../../src/lib/peerDrop.js';

describe('meshHosts (fix-agenttest 5)', () => {
	it('lists us and the peers we are linked to, never a closed or reconnecting conn', () => {
		const conns = { live: { open: true }, closed: { open: false }, healing: { open: true }, joiner: { open: true } };
		expect(meshHosts('me', 'joiner', conns, new Set(['healing']))).toEqual(['me', 'live']);
		expect(meshHosts('me', 'joiner', {}, new Set())).toEqual(['me']);
	});
});

describe('sendHandshake uses it', () => {
	it('builds hosts from meshHosts, not every key of connections', () => {
		const src = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
		expect(src).toMatch(/let hosts = meshHosts\(id, peerId, this\.connections, this\.reconnecting\)/);
	});
});
