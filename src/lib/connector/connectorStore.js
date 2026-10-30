// Roadmap 86 B1/B2 — what the UI knows about the Claude connector, as a LEAF (svelte/store + cloudHooks):
// the AI window's button, the top-bar chip and Settings ▸ Connected apps read it without loading the
// connector itself, which is a dynamic import (connector.js) pulled in only by a Connect Claude press.

import { writable, derived } from 'svelte/store';
import { connectorProvider } from '../cloudHooks.js';

/**
 * @typedef {{phase: 'idle'|'pairing'|'connecting'|'connected'|'reconnecting'|'closed'|'error', reason: string, message: string,
 *   connections: {id: string, client: string, scopes: string[], lastUsed: number}[], retryAt: number,
 *   hidden: boolean, throttled: boolean, busy: number, lastCall: {tool: string, at: number, ok: boolean} | null}} ConnectorView
 */

/** @type {ConnectorView} */
export const CONNECTOR_IDLE = {
	phase: 'idle',
	reason: '',
	message: '',
	connections: [],
	retryAt: 0,
	hidden: false,
	throttled: false,
	busy: 0,
	lastCall: null
};

/** @type {import('svelte/store').Writable<ConnectorView>} */
export const connectorState = writable(CONNECTOR_IDLE);

/** a signed-in cloud build installed the connector's account half — the OSS build never shows the button */
export const connectorAvailable = derived(connectorProvider, (p) => !!p);

/** the words for one phase, for the chip and the window (one place, so the two never disagree) @param {ConnectorView} s */
export function connectorLine(s) {
	switch (s.phase) {
		case 'pairing':
		case 'connecting':
			return 'Connecting Claude…';
		case 'connected':
			return 'Claude connected · this tab';
		case 'reconnecting':
			return 'Claude reconnecting…';
		default:
			return '';
	}
}

/** the Connect Claude press */
export async function connectClaude() {
	const m = await import('./connector.js');
	m.connect();
}

/** the kill switch: stops every in-flight call and forgets the link */
export async function disconnectClaude() {
	const m = await import('./connector.js');
	m.disconnect();
}
