// @ts-nocheck — plain fixtures; the modules under test are typed
// fix-agenttest item 4: a peer whose page said it went HIDDEN (a phone in the background) is not
// dropped by the 7 s consent-silence rule; a peer that said nothing (a crashed tab) still is.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { silenceCloseAllowed, AWAY_GRACE_MS, LINK_SILENT_MS, linkSilence } from '../../src/lib/peerDrop.js';
import { canApply, setCapabilityProvider } from '../../src/lib/cloudHooks.js';
import { validateWireMessage } from '../../src/lib/wireValidate.js';

describe('linkaway', () => {
	afterEach(() => setCapabilityProvider(null));

	it('a silent peer that announced nothing is closed as before (crashed-tab ghosts)', () => {
		const t0 = 1_000_000;
		let v = linkSilence(null, { requestsSent: 10, responsesReceived: 5 }, t0);
		v = linkSilence(v.state, { requestsSent: 14, responsesReceived: 5 }, t0 + LINK_SILENT_MS);
		expect(v.silent).toBe(true);
		expect(silenceCloseAllowed(undefined, t0 + LINK_SILENT_MS)).toBe(true);
	});

	it('a peer that said its page went hidden keeps its link through the grace, then not', () => {
		const hiddenAt = 2_000_000;
		expect(AWAY_GRACE_MS).toBeGreaterThan(LINK_SILENT_MS * 4);
		expect(silenceCloseAllowed(hiddenAt, hiddenAt + LINK_SILENT_MS)).toBe(false);
		expect(silenceCloseAllowed(hiddenAt, hiddenAt + AWAY_GRACE_MS - 1)).toBe(false);
		expect(silenceCloseAllowed(hiddenAt, hiddenAt + AWAY_GRACE_MS)).toBe(true);
	});

	it('is on the capability floor (a viewer phone must be able to say it) and validated', () => {
		setCapabilityProvider(() => false);
		expect(canApply('viewer', 'linkaway')).toBe(true);
		expect(validateWireMessage({ type: 'linkaway', hidden: true })).toBe(true);
		expect(validateWireMessage({ type: 'linkaway', hidden: 'yes' })).toBe(false);
	});

	it('peerHandler announces on visibilitychange and guards the silence close with it', () => {
		const src = readFileSync(new URL('../../src/lib/peerHandler.svelte.js', import.meta.url), 'utf8');
		expect(src).toMatch(/type: 'linkaway', hidden: document\.hidden/);
		const close = src.slice(src.indexOf('const closeSilent ='), src.indexOf("conn.on('iceStateChanged'"));
		expect(close).toMatch(/silenceCloseAllowed\(this\.awayPeers\.get\(conn\.peer\)/);
	});
});
