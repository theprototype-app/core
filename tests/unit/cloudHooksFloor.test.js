// 48-int: the capability floor answers every late-joiner REQUEST a viewer-role peer sends —
// a cloud build's just-approved joiner is a viewer until its role grant lands
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { canApply, setCapabilityProvider } from '../../src/lib/cloudHooks.js';

// 49 J1: the six older domains' requests and the replies that must stay content
const J1_REQUESTS = ['gethuds', 'gethudvalues', 'getshadergraphs', 'getanim', 'getscenepost', 'getroomanchor'];
const J1_REPLIES = ['huds', 'hud', 'hudvalues', 'hudvalue', 'shadergraphs', 'shadergraph', 'animations', 'animdata', 'scenepost', 'roomanchor'];

describe('cloudHooks ALWAYS_ALLOWED floor', () => {
	afterEach(() => setCapabilityProvider(null));

	it('lets a viewer request the sequences (48 S2 getseqs), as it does nodes and triggers', () => {
		setCapabilityProvider(() => false);
		for (const t of ['getseqs', 'getnodes', 'gettriggers', 'getobjects']) expect(canApply('v', t)).toBe(true);
	});

	it('keeps the seqs REPLY gateable (content, not protocol)', () => {
		setCapabilityProvider(() => false);
		expect(canApply('v', 'seqs')).toBe(false);
		expect(canApply('v', 'seq')).toBe(false);
	});

	it('lets a viewer request HUDs, HUD values, shader graphs, animation, the look and the room anchor (49 J1)', () => {
		setCapabilityProvider(() => false);
		for (const t of J1_REQUESTS) expect(canApply('v', t), t).toBe(true);
	});

	it('keeps those domains\' REPLIES gateable (49 J1)', () => {
		setCapabilityProvider(() => false);
		for (const t of J1_REPLIES) expect(canApply('v', t), t).toBe(false);
	});

	it('has every request of the late-joiner burst (requestFullState) on the floor', () => {
		const src = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
		const body = src.slice(src.indexOf('requestFullState(conn, opts'), src.indexOf('sendHandshake(conn, peerId'));
		const sent = [...body.matchAll(/type: '(get[a-z]+)'/g)].map((m) => m[1]);
		expect(sent.length).toBeGreaterThan(10);
		setCapabilityProvider(() => false);
		for (const t of sent) expect(canApply('v', t), t).toBe(true);
	});

	it('lets a viewer request the project manifest, an asset and a material preset (fix-live)', () => {
		setCapabilityProvider(() => false);
		for (const t of ['getproject', 'getasset', 'getmatpreset']) expect(canApply('v', t), t).toBe(true);
	});

	it('keeps those REPLIES gateable (fix-live)', () => {
		setCapabilityProvider(() => false);
		for (const t of ['manifest', 'assetfile', 'assetstart', 'assetchunk', 'assetmissing', 'matpresetpart']) expect(canApply('v', t), t).toBe(false);
	});

	it('has every get* REQUEST the dispatcher answers on the floor, bar the recorded few', () => {
		const src = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
		const answered = [...new Set([...src.matchAll(/data\.type == '(get[a-z]+)'/g)].map((m) => m[1]))];
		expect(answered.length).toBeGreaterThan(10);
		// still off the floor, recorded for the orchestrator (fix-live STATUS): each needs its own look
		const KNOWN_OFF = ['gettransport', 'getgame', 'getkitentities', 'getpatch'];
		setCapabilityProvider(() => false);
		for (const t of answered) expect(canApply('v', t), t).toBe(!KNOWN_OFF.includes(t));
	});

	it('allows everything with no provider (the OSS build)', () => {
		expect(canApply('v', 'seqs')).toBe(true);
	});
});
