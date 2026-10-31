// 57 M5 — the OPEN SOURCE AVATARS registry as an Asset Browser source ("Avatars"): free VRM avatars
// listed by github.com/ToxSam/open-source-avatars (the registry itself is CC0). Each COLLECTION states
// its licence; CC0 collections show by default, CC-BY ones only when asked for, and a placed avatar
// keeps its credit (its provenance licence names the collection's author → the M7 warnings and
// CREDITS.txt). The registry JSON comes through the CDN at a PINNED commit (a moved file can never
// change what a row means) and the local response cache; the VRM files are Arweave URLs (CORS *).
// Normalizing is pure (unit-tested); fetching reuses cc0Fetch's cache.

export const OSA_COMMIT = '0f9a1b2fd99894736563d55b2c9dc9125700d081';
export const OSA_BASE =
	'https://cdn.jsdelivr.net/gh/ToxSam/open-source-avatars@' + OSA_COMMIT + '/data';
export const OSA_HOME = 'https://github.com/ToxSam/open-source-avatars';

/** the registry's licence names -> ids @param {any} l */
export function osaLicence(l) {
	const s = String(l ?? '')
		.toUpperCase()
		.replace(/\s+/g, '');
	if (s === 'CC0' || s === 'CC0-1.0') return 'CC0-1.0';
	if (s === 'CC-BY' || s === 'CCBY' || s === 'CC-BY-4.0') return 'CC-BY-4.0';
	return s || 'unknown';
}

/**
 * Projects + their avatar lists -> Asset Browser rows (VRM only, public, not drafts).
 * @param {any[]} projects @param {Record<string, any[]>} avatarsByProject
 * @param {{includeCcBy?: boolean}} [opts]
 * @returns {any[]}
 */
export function normalizeOsa(projects, avatarsByProject, opts = {}) {
	/** @type {any[]} */
	const out = [];
	for (const p of Array.isArray(projects) ? projects : []) {
		const licence = osaLicence(p?.license);
		if (licence !== 'CC0-1.0' && !(opts.includeCcBy && licence === 'CC-BY-4.0')) continue;
		const list = avatarsByProject[p.id] ?? [];
		for (const a of Array.isArray(list) ? list : []) {
			if (!a || a.is_public === false || a.is_draft === true) continue;
			if (
				String(a.format ?? 'VRM').toUpperCase() !== 'VRM' ||
				typeof a.model_file_url !== 'string' ||
				!/^https:\/\//.test(a.model_file_url)
			)
				continue;
			out.push({
				source: 'osa',
				kind: 'avatars',
				id: String(a.id),
				name: String(a.name ?? 'Avatar'),
				thumb: typeof a.thumbnail_url === 'string' ? a.thumbnail_url : '',
				vrm: a.model_file_url,
				authors: [String(p.creator_id ?? '').replace(/-/g, ' ') || String(p.name ?? '')].filter(
					Boolean
				),
				categories: [String(p.id)],
				tags: [String(p.name ?? ''), licence],
				project: String(p.name ?? p.id),
				licence,
				url: OSA_HOME
			});
		}
	}
	return out;
}

/** the projects as categories @param {any[]} projects @param {any[]} rows */
export function osaCategories(projects, rows) {
	return (Array.isArray(projects) ? projects : [])
		.map((p) => ({
			id: String(p.id),
			label: String(p.name ?? p.id),
			count: rows.filter((r) => r.categories[0] === String(p.id)).length
		}))
		.filter((c) => c.count > 0);
}

/** the provenance licence a placed avatar carries @param {any} row */
export function osaProvenance(row) {
	return {
		tool: 'import',
		model: 'Open Source Avatars registry',
		source: row.vrm,
		licence: {
			id: row.licence,
			title: row.name + ' (' + row.project + ')',
			author: row.authors?.[0] || row.project,
			url: OSA_HOME,
			credit: row.licence !== 'CC0-1.0'
		}
	};
}

/**
 * Fetch the registry (projects + each listed collection), cached like the CC0 lists.
 * @param {{fresh?: boolean, includeCcBy?: boolean}} [opts]
 */
export async function osaList(opts = {}) {
	const { cachedJson, CC0_TTL } = await import('../cc0/cc0Fetch.js');
	const projects = await cachedJson(OSA_BASE + '/projects.json', CC0_TTL.list, {
		fresh: opts.fresh
	});
	const list = Array.isArray(projects.data) ? projects.data : (projects.data?.projects ?? []);
	/** @type {Record<string, any[]>} */
	const byProject = {};
	await Promise.all(
		list.map(async (/** @type {any} */ p) => {
			const file = String(p.avatar_data_file ?? p.avatar_file ?? '');
			if (!/^avatars\/[\w.-]+\.json$/.test(file)) return;
			try {
				const r = await cachedJson(OSA_BASE + '/' + file, CC0_TTL.list, { fresh: opts.fresh });
				byProject[p.id] = Array.isArray(r.data) ? r.data : (r.data?.avatars ?? []);
			} catch {
				/* one collection down: the others still list */
			}
		})
	);
	const rows = normalizeOsa(list, byProject, opts);
	return {
		rows,
		categories: osaCategories(list, rows),
		stale: projects.stale,
		at: projects.at,
		error: projects.error
	};
}
