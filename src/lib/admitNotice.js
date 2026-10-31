// F-5 (roadmap 55 "Fixes for 54", test flight T14): an automatic admission is never silent.
// The cloud rooms plugin admits guests to a listed room with "Allow guests to join
// automatically" on, and the host saw nothing at all — no card, no toast, no history. Core
// now tells the host about EVERY automatic admission; the auth provider may say why and
// offer to switch the setting off (authProvider.admitNotice). Pure: no stores, no peers.

/** @param {string} peerId */
export function shortPeer(peerId) {
	return String(peerId ?? '').slice(0, 6).toUpperCase();
}

/**
 * @param {string} peerId
 * @param {any} provided what `authProvider.admitNotice(peerId, cloudMeta)` returned (or threw → null)
 * @returns {{ text: string, turnOff: (() => void) | null, turnOffLabel: string }}
 */
export function composeAdmitNotice(peerId, provided) {
	const p = provided && typeof provided === 'object' ? provided : null;
	const text =
		String(p?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) ||
		shortPeer(peerId) + ' joined automatically — your session settings let them in without approval.';
	const turnOff = typeof p?.turnOff === 'function' ? p.turnOff : null;
	const turnOffLabel = String(p?.turnOffLabel ?? '').trim().slice(0, 24) || 'Turn off';
	return { text, turnOff, turnOffLabel };
}
