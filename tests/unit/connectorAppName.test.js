// 89 — the tab names the AI app on the other end of the connector: the Worker's TRUSTED per-grant name, "AI app" for
// an unknown callback, and exactly the old words ("Claude") when the Worker is older than 89 (no `app` at all).
import { describe, it, expect } from 'vitest';
import { appNameOf, whoOf, connectorLabelFor, FALLBACK_APP, UNKNOWN_APP } from '../../src/lib/connector/appName.js';
import { closeWords, CLOSE_WORDS } from '../../src/lib/connector/relayClient.js';
import { parseFrame } from '../../src/lib/connector/protocol.js';
import { connectorLine, CONNECTOR_IDLE } from '../../src/lib/connector/connectorStore.js';
const CONNECTOR_LABEL = 'Claude (connector)'; // tpAgent.js's fixed words (importing it pulls the scene runes in)

describe('89 appName', () => {
	it('a grant without app (a Worker before 89) is Claude; empty is "AI app"; odd text never shows', () => {
		expect(appNameOf({})).toBe(FALLBACK_APP);
		expect(appNameOf(null)).toBe('Claude');
		expect(appNameOf({ app: 'ChatGPT' })).toBe('ChatGPT');
		expect(appNameOf({ app: '' })).toBe(UNKNOWN_APP);
		expect(appNameOf({ app: '<img src=x>' })).toBe('AI app');
		expect(appNameOf({ app: 'x'.repeat(41) })).toBe('AI app');
		expect(appNameOf({ app: 7 })).toBe('Claude');
	});
	it('who: the call\'s grant, else the link\'s, else the most recent grant, else Claude', () => {
		const connections = [
			{ id: 'g_1', app: 'Claude', lastUsed: 1 },
			{ id: 'g_2', app: 'ChatGPT', lastUsed: 5 },
			{ id: 'g_3', app: '', lastUsed: 3 }
		];
		expect(whoOf({ connections }, 'g_3')).toBe('AI app');
		expect(whoOf({ connections, connection: { app: 'Claude' } }, 'g_x')).toBe('Claude');
		expect(whoOf({ connections })).toBe('ChatGPT');
		expect(whoOf({ connections: [] })).toBe('Claude');
		expect(whoOf(undefined)).toBe('Claude');
	});
	it('the log / undo label keeps its shape; the default is the old fixed words', () => {
		expect(connectorLabelFor('ChatGPT')).toBe('ChatGPT (connector)');
		expect(connectorLabelFor('Claude')).toBe(CONNECTOR_LABEL);
		expect(connectorLabelFor('')).toBe(CONNECTOR_LABEL);
	});
	it('close words: Claude reads exactly as before, another app is named, the button stays "Connect Claude"', () => {
		for (const r of Object.keys(CLOSE_WORDS)) expect(closeWords(r, 'Claude')).toBe(CLOSE_WORDS[r]);
		expect(closeWords('revoked', 'ChatGPT')).toBe('ChatGPT’s access was revoked (Settings ▸ AI ▸ Connected apps). Press Connect Claude to connect again.');
		expect(closeWords('replaced', 'AI app')).toMatch(/^AI app is now connected in another tab/);
		expect(closeWords('refused', 'ChatGPT')).toBe(CLOSE_WORDS.refused);
		expect(closeWords('nope', 'ChatGPT')).toBeUndefined();
		expect(CLOSE_WORDS.revoked).toMatch(/Settings ▸ AI ▸ Connected apps/);
	});
	it('the ready frame keeps app only when the Worker sent it', () => {
		const old = parseFrame(JSON.stringify({ type: 'ready', connection: { id: 't_1', client: 'Claude', account: 'A' }, connections: [{ id: 'g_1', client: 'Claude' }] }));
		expect(old && 'app' in old.connection).toBe(false);
		expect(old && whoOf(old)).toBe('Claude');
		const neu = parseFrame(JSON.stringify({ type: 'ready', connection: { id: 't_1', client: 'ChatGPT', app: 'ChatGPT', account: 'A' }, connections: [{ id: 'g_1', client: 'ChatGPT', app: 'ChatGPT' }] }));
		expect(neu?.connection.app).toBe('ChatGPT');
		expect(neu?.connections[0].app).toBe('ChatGPT');
		expect(neu && whoOf(neu)).toBe('ChatGPT');
	});
	it('the chip line names the app; the idle view is Claude, so nothing changes until a Worker names another', () => {
		expect(CONNECTOR_IDLE.who).toBe('Claude');
		expect(connectorLine({ ...CONNECTOR_IDLE, phase: 'connected' })).toBe('Claude connected · this tab');
		expect(connectorLine({ ...CONNECTOR_IDLE, phase: 'connected', who: 'ChatGPT' })).toBe('ChatGPT connected · this tab');
		expect(connectorLine({ ...CONNECTOR_IDLE, phase: 'pairing', who: 'AI app' })).toBe('Connecting AI app…');
		expect(connectorLine({ ...CONNECTOR_IDLE, phase: 'reconnecting', who: '' })).toBe('Claude reconnecting…');
	});
});
