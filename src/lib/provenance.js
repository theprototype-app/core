// 57 M7 — PROVENANCE + LICENCE FLAGS: where an asset came from, and what its licence asks of you.
//
// Every imported, generated, rigged, retargeted or converted asset carries a list of records
// `{tool, model, version, licence, prompt?, date}` — newest last — on its root's
// `userData.provenance` (GLTF extras for a synced object; the `objectfile` message and the save
// entry for a rig that rides its bytes). A record is one STEP: "imported from a .vrm", "rigged by
// UniRig", "clip retargeted from Walk". 56 C9 `import_model` and 58's AI tools write the same
// record (same function), so Credits, the third-party notices and the warnings read ONE field.
//
// A licence is a small object `{id, url?, author?, title?, credit?, commercial?, redistribution?,
// modification?}` — an SPDX-ish id (CC0-1.0, CC-BY-4.0, CC-BY-NC-4.0, …, 'VRM' for a VRM's own
// permission meta, 'unknown') plus the permission bits a VRM states outright. `licenceFlags` turns
// it into the four facts the dialogs warn about. Fork F3 (recommended, taken): WARN, never block —
// there is no reliable way to tell what someone intends to do with a file.
//
// A LEAF (imports nothing), unit-tested.

/** how many steps a root keeps (an asset re-imported a hundred times keeps the newest) */
export const MAX_RECORDS = 12;

/**
 * @typedef {{id: string, url?: string, author?: string, title?: string, credit?: boolean,
 *   commercial?: boolean, redistribution?: boolean, modification?: boolean, note?: string}} Licence
 * @typedef {{tool: string, model?: string, version?: string, licence?: Licence | null,
 *   prompt?: string, date: string, source?: string}} ProvenanceRecord
 */

const str = (/** @type {any} */ v, n = 200) => (typeof v === 'string' ? v.slice(0, n) : undefined);
const bool = (/** @type {any} */ v) => (typeof v === 'boolean' ? v : undefined);

/** @param {any} raw @returns {Licence | null} */
export function normalizeLicence(raw) {
	if (!raw) return null;
	if (typeof raw === 'string') return { id: raw.slice(0, 64) };
	if (typeof raw !== 'object') return null;
	/** @type {Licence} */
	const out = { id: str(raw.id, 64) || 'unknown' };
	for (const k of /** @type {const} */ (['url', 'author', 'title', 'note'])) {
		const v = str(raw[k], k === 'note' ? 400 : 300);
		if (v) out[k] = v;
	}
	for (const k of /** @type {const} */ ([
		'credit',
		'commercial',
		'redistribution',
		'modification'
	])) {
		const v = bool(raw[k]);
		if (v !== undefined) out[k] = v;
	}
	return out;
}

/**
 * One provenance step. `date` defaults to now (ISO, to the second).
 * @param {{tool: string, model?: string, version?: string, licence?: any, prompt?: string, date?: string, source?: string}} r
 * @returns {ProvenanceRecord}
 */
export function provenanceRecord(r) {
	/** @type {ProvenanceRecord} */
	const out = {
		tool: str(r.tool, 60) || 'unknown',
		date: str(r.date, 40) || new Date().toISOString().slice(0, 19) + 'Z'
	};
	const model = str(r.model, 120);
	if (model) out.model = model;
	const version = str(r.version, 40);
	if (version) out.version = version;
	const licence = normalizeLicence(r.licence);
	if (licence) out.licence = licence;
	const prompt = str(r.prompt, 1000);
	if (prompt) out.prompt = prompt;
	const source = str(r.source, 200);
	if (source) out.source = source;
	return out;
}

/** a stored list, cleaned (anything not a record is dropped) @param {any} raw @returns {ProvenanceRecord[]} */
export function normalizeProvenance(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((r) => r && typeof r === 'object' && typeof r.tool === 'string')
		.slice(-MAX_RECORDS)
		.map((r) => provenanceRecord(r));
}

/**
 * Append a step to a userData object (in place) and return the new list.
 * @param {Record<string, any>} userData @param {Parameters<typeof provenanceRecord>[0]} record
 */
export function addProvenance(userData, record) {
	const list = [...normalizeProvenance(userData.provenance), provenanceRecord(record)].slice(
		-MAX_RECORDS
	);
	userData.provenance = list;
	return list;
}

/** the licence that governs an asset: the newest step that names one @param {any} userData @returns {Licence | null} */
export function licenceOf(userData) {
	const list = normalizeProvenance(userData?.provenance);
	for (let i = list.length - 1; i >= 0; i--)
		if (list[i].licence) return /** @type {Licence} */ (list[i].licence);
	return null;
}

/**
 * What a licence asks of you. Unknown = no flags (we cannot tell; a warning that fires on every
 * import from disk would be noise nobody reads).
 * @param {Licence | null | undefined} licence
 * @returns {{credit: boolean, nonCommercial: boolean, noRedistribution: boolean, noModification: boolean, restricted: boolean}}
 */
export function licenceFlags(licence) {
	const id = String(licence?.id ?? '').toUpperCase();
	const cc = /^CC-/.test(id) || /^CC_/.test(id);
	const credit = licence?.credit ?? (cc && /BY/.test(id));
	const nonCommercial =
		licence?.commercial === false ||
		/(^|[-_])NC([-_]|$)/.test(id) ||
		/NONCOMMERCIAL|NON-COMMERCIAL/.test(id);
	const noRedistribution =
		licence?.redistribution === false || /REDISTRIBUTION_PROHIBITED|NO-REDIST/.test(id);
	const noModification = licence?.modification === false || /(^|[-_])ND([-_]|$)/.test(id);
	return {
		credit: !!credit,
		nonCommercial,
		noRedistribution,
		noModification,
		restricted: nonCommercial || noRedistribution || noModification
	};
}

/** a short human label for a licence ("CC BY 4.0", "VRM licence") @param {Licence | null | undefined} licence */
export function licenceLabel(licence) {
	if (!licence) return 'Unknown';
	const id = licence.id || 'unknown';
	if (id === 'VRM') return 'VRM licence (see permissions)';
	if (/^CC0/i.test(id)) return 'CC0 (public domain)';
	const cc = id.match(/^CC[-_](BY(?:[-_](?:SA|NC|ND))*)[-_]?(\d\.\d)?$/i);
	if (cc) return 'CC ' + cc[1].replace(/[-_]/g, '-').toUpperCase() + (cc[2] ? ' ' + cc[2] : '');
	if (id === 'unknown') return 'Unknown';
	return id;
}

/**
 * The sentence a dialog shows for one asset (null when its licence asks nothing special).
 * @param {string} name @param {Licence | null | undefined} licence
 * @param {'export'|'download'|'publish'} where
 */
export function licenceWarning(name, licence, where) {
	const f = licenceFlags(licence);
	if (!f.credit && !f.restricted) return null;
	/** @type {string[]} */
	const parts = [];
	if (f.noRedistribution)
		parts.push(
			where === 'download'
				? 'its licence does not allow passing the file on'
				: 'its licence does not allow redistributing it — a published or exported game passes it on'
		);
	if (f.nonCommercial) parts.push('non-commercial use only');
	if (f.noModification) parts.push('no modified versions');
	if (f.credit)
		parts.push(
			'credit ' + (licence?.author ? licence.author : 'the author') + ' where you share it'
		);
	return '"' + name + '": ' + parts.join('; ') + '.';
}

/**
 * Every warning for a set of assets ({uuid, name, userData}), restricted ones first.
 * @param {{uuid: string, name: string, userData?: any, extra?: (Licence | null)[]}[]} assets
 * @param {'export'|'download'|'publish'} where
 * @returns {{uuid: string, name: string, licence: Licence, text: string, restricted: boolean}[]}
 */
export function collectLicenceWarnings(assets, where) {
	/** @type {{uuid: string, name: string, licence: Licence, text: string, restricted: boolean}[]} */
	const out = [];
	const seen = new Set();
	for (const a of assets) {
		const licences = [licenceOf(a.userData), ...(a.extra ?? [])].filter(Boolean);
		for (const lic of /** @type {Licence[]} */ (licences)) {
			const key = a.uuid + '|' + JSON.stringify(lic);
			if (seen.has(key)) continue;
			seen.add(key);
			const text = licenceWarning(a.name || 'Object', lic, where);
			if (text)
				out.push({
					uuid: a.uuid,
					name: a.name,
					licence: lic,
					text,
					restricted: licenceFlags(lic).restricted
				});
		}
	}
	return out.sort((a, b) => Number(b.restricted) - Number(a.restricted));
}

/**
 * A plain-text CREDITS block for an export / download (one line per credited asset), '' when
 * nothing needs credit.
 * @param {{name: string, userData?: any}[]} assets
 */
export function creditsText(assets) {
	/** @type {string[]} */
	const lines = [];
	for (const a of assets) {
		const list = normalizeProvenance(a.userData?.provenance);
		const lic = licenceOf(a.userData);
		if (!lic || lic.id === 'unknown') continue;
		const step = list[list.length - 1];
		lines.push(
			'- ' +
				(lic.title || a.name || 'Asset') +
				(lic.author ? ' by ' + lic.author : '') +
				' — ' +
				licenceLabel(lic) +
				(lic.url ? ' (' + lic.url + ')' : '') +
				(step?.tool ? ' [' + step.tool + (step.model ? ' / ' + step.model : '') + ']' : '')
		);
	}
	return lines.length ? 'Credits\n=======\n' + lines.join('\n') + '\n' : '';
}

/**
 * A VRM's own meta (0.x or 1.0, as three-vrm parses it) as a licence.
 * VRM 1.0: licenseUrl, commercialUsage ('personalNonProfit' | 'personalProfit' | 'corporation'),
 * allowRedistribution, modification ('prohibited' | 'allowModification' | 'allowModificationRedistribution'),
 * creditNotation ('required' | 'unnecessary'). VRM 0.x: licenseName ('Redistribution_Prohibited',
 * 'CC0', 'CC_BY', 'CC_BY_NC', … 'Other'), commercialUssageName ('Allow' | 'Disallow'), otherPermissionUrl.
 * @param {any} meta @returns {Licence | null}
 */
export function licenceFromVrmMeta(meta) {
	if (!meta || typeof meta !== 'object') return null;
	const title = str(meta.name ?? meta.title, 200);
	const author = Array.isArray(meta.authors)
		? meta.authors
				.filter((/** @type {any} */ a) => typeof a === 'string')
				.join(', ')
				.slice(0, 300)
		: str(meta.author, 300);
	if (meta.metaVersion === '1' || 'licenseUrl' in meta || 'allowRedistribution' in meta) {
		const commercial = meta.commercialUsage
			? meta.commercialUsage !== 'personalNonProfit'
			: undefined;
		const modification = meta.modification ? meta.modification !== 'prohibited' : undefined;
		const lic = normalizeLicence({
			id: 'VRM',
			url: meta.licenseUrl,
			title,
			author,
			credit: meta.creditNotation ? meta.creditNotation === 'required' : undefined,
			commercial,
			redistribution:
				typeof meta.allowRedistribution === 'boolean' ? meta.allowRedistribution : undefined,
			modification
		});
		return lic;
	}
	const name = String(meta.licenseName ?? '');
	const ccMap = /** @type {Record<string, string>} */ ({
		CC0: 'CC0-1.0',
		CC_BY: 'CC-BY-4.0',
		CC_BY_NC: 'CC-BY-NC-4.0',
		CC_BY_SA: 'CC-BY-SA-4.0',
		CC_BY_NC_SA: 'CC-BY-NC-SA-4.0',
		CC_BY_ND: 'CC-BY-ND-4.0',
		CC_BY_NC_ND: 'CC-BY-NC-ND-4.0'
	});
	const id =
		ccMap[name] ?? (name === 'Redistribution_Prohibited' ? 'VRM' : name ? 'VRM' : 'unknown');
	return normalizeLicence({
		id,
		url: meta.otherLicenseUrl || meta.otherPermissionUrl,
		title,
		author,
		commercial: meta.commercialUssageName ? meta.commercialUssageName === 'Allow' : undefined,
		redistribution: name === 'Redistribution_Prohibited' ? false : undefined
	});
}
