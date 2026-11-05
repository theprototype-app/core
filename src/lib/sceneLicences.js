// 57 M7 — the licences a set of scene objects carries, for the Export / Download / Publish warnings
// and the CREDITS a bundle writes. An object counts with its own provenance AND the licences of the
// clips applied to it (a CC-BY walk on a CC0 character still needs its credit), and a group counts
// with everything under it. Reads the scene; replicates nothing.

import { get } from 'svelte/store';
import { objectsGroup } from '../stores/sceneStore';
import { collectLicenceWarnings, creditsText, normalizeLicence } from './provenance.js';

/** @typedef {{uuid: string, name: string, userData: any, extra: any[]}} LicensedAsset */

/**
 * Every object (and descendant) with a provenance record or applied-clip licences.
 * @param {string[] | null} [uuids] null = the whole scene @returns {LicensedAsset[]}
 */
export function licensedAssets(uuids = null) {
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group) return [];
	const roots = uuids
		? uuids.map((u) => group.getObjectByProperty('uuid', u)).filter(Boolean)
		: group.children;
	/** @type {LicensedAsset[]} */
	const out = [];
	const seen = new Set();
	for (const root of roots) {
		root.traverse((/** @type {any} */ o) => {
			if (seen.has(o.uuid)) return;
			seen.add(o.uuid);
			const ud = o.userData ?? {};
			const clips = Array.isArray(ud.character?.clips) ? ud.character.clips : [];
			const extra = clips
				.map((/** @type {any} */ c) => normalizeLicence(c?.licence))
				.filter(Boolean);
			// 64-text TX3b: a text drawn with a font whose OS/2 fsType forbids embedding — an export
			// carries the font file, so it is a "no redistribution" licence in the same dialog
			const font = ud.textPath && typeof ud.textPath === 'object' && ud.textPath.fontAsset ? ud.textPath : null;
			if (font?.fontMeta?.noEmbed)
				extra.push(
					normalizeLicence({
						id: 'font-no-embedding',
						title: (font.fontName || 'Font') + ' (font)',
						url: font.fontMeta.url || undefined,
						redistribution: false,
						note: 'The font’s embedding bits (OS/2 fsType) forbid carrying it inside a file.'
					})
				);
			if (!ud.provenance && !extra.length) return;
			out.push({ uuid: o.uuid, name: o.name || o.type || 'Object', userData: ud, extra });
		});
	}
	return out;
}

/** @param {string[] | null} uuids @param {'export'|'download'|'publish'} where */
export function licenceWarningsFor(uuids, where) {
	return collectLicenceWarnings(licensedAssets(uuids), where);
}

/** the CREDITS.txt body for these objects ('' = nothing to credit) @param {string[] | null} [uuids] */
export function creditsFor(uuids = null) {
	const assets = licensedAssets(uuids);
	// an applied clip is credited as its own line
	const clipRows = assets.flatMap((a) =>
		a.extra.map((lic) => ({
			name: (lic.title || 'Animation clip') + ' (on ' + a.name + ')',
			userData: { provenance: [{ tool: 'retarget', licence: lic, date: '' }] }
		}))
	);
	return creditsText([...assets, ...clipRows]);
}
