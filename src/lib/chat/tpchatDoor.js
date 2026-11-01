// Roadmap 56 C10 (fork F5) — a SAVED scene file as an outward door may carry it. A library `.tpscene`
// is the scene's own save, so it holds every AI chat; handing that file to somebody else — the
// Explorer's Download, a .tp project export, a multi-file .zip — keeps only the chats switched to
// "Include when publishing". fflate is a dynamic import (the .tpscene precedent).

import { payloadForDoor, privateChatCount } from './tpchatCore.js';

/**
 * @param {Uint8Array} bytes a .tpscene (zip) or anything else
 * @returns {Promise<{bytes: Uint8Array, changed: boolean, dropped: number}>} the same bytes when there
 *   is nothing private in them (or they are not a readable scene zip)
 */
export async function sceneBytesForDoor(bytes) {
	const same = { bytes, changed: false, dropped: 0 };
	try {
		if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return same; // not a zip
		const { unzipSync, zipSync, strFromU8, strToU8 } = await import('fflate');
		const entries = unzipSync(bytes);
		const json = entries['session.json'];
		if (!json) return same;
		const text = strFromU8(json);
		if (!text.includes('"chats"')) return same;
		const payload = JSON.parse(text);
		const dropped = privateChatCount(payload);
		if (!dropped) return same;
		entries['session.json'] = strToU8(JSON.stringify(payloadForDoor(payload, 'published')));
		return { bytes: zipSync(entries, { level: 6 }), changed: true, dropped };
	} catch {
		return same;
	}
}

/** the Blob form, for a download @param {Blob} blob @param {string} [name] @returns {Promise<{blob: Blob, dropped: number}>} */
export async function sceneBlobForDoor(blob, name = '') {
	if (!/\.tpscene$/i.test(name)) return { blob, dropped: 0 };
	const out = await sceneBytesForDoor(new Uint8Array(await blob.arrayBuffer()));
	if (!out.changed) return { blob, dropped: 0 };
	return { blob: new Blob([/** @type {BlobPart} */ (out.bytes)], { type: blob.type || 'application/zip' }), dropped: out.dropped };
}
