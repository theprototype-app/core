// Roadmap 55 A2 — `window.tpAgent`, the supported in-page agent API (contract: ./contract.js). Reached
// ONLY by the dynamic import in App.svelte when agentMode.js says the page asked for it, so a normal
// session carries none of this.

import { TP_AGENT_VERSION } from './contract.js';
import { getAiTools, executeAiTool, buildSystemPrompt, summarizeScene } from '$lib/ai/tools.js';

/** Build the object (phase 1: the contract's shape; behaviour is filled in by the next phases). */
export function createTpAgent() {
	return Object.freeze({
		version: TP_AGENT_VERSION,
		tools: () => getAiTools(),
		systemPrompt: () => buildSystemPrompt(),
		exec: (/** @type {string} */ name, /** @type {any} */ args) => executeAiTool(name, args ?? {}),
		snapshot: (/** @type {number} */ cap = 1000) => summarizeScene(cap),
		status: () => ({ version: TP_AGENT_VERSION }),
		waitForEdit: async () => ({ changed: false, timedOut: true }),
		screenshot: async () => null,
		pendingOffers: () => [],
		accept: () => ({ ok: false, error: 'not implemented yet' }),
		leave: async () => {}
	});
}

/** Install `window.tpAgent` (idempotent). */
export function installTpAgent() {
	if (typeof window === 'undefined') return null;
	/** @type {any} */
	const w = window;
	if (!w.tpAgent) w.tpAgent = createTpAgent();
	return w.tpAgent;
}
