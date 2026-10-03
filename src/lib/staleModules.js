// 34 R1 — THE STALE-MODULE WARNING. An installed user module never updates itself, so a
// device that installed Waves 2.1.0 for one preview kept it on the next, and its old bug
// read as a regression of the new core (CLAUDE.md gotcha; roadmap 34 R1). The app now
// KNOWS the module versions it was released with — `moduleVersions.json`, written at
// release by `scripts/module-versions.cjs` from the modules index — and an installed
// module OLDER than that gets:
//   - one sticky toast per session naming it, with Update (all) and Open Modules;
//   - a row at the top of the Modules manager's User tab with its own Update button;
//   - a `stale-module` marker {id, installed, expected} in the perf ring, so a beacon
//     report from that device says why it may be slow or broken (the cloud's
//     perf-reports script counts them).
// A module this build does not know (a third-party one) is never stale; a NEWER one is fine.
import { writable, derived, get } from 'svelte/store';
import { userModules, installUrl, updateUserModule } from './userModules';
import { versionNewer, loadModuleGallery, galleryModules, galleryInstallUrl } from './moduleGallery';
import { showInfoToast, dismissToastById, modulesOpen } from '../stores/appStore';
import { perfMark } from './perf/perfMarks.js';
import shipped from './moduleVersions.json';

/** the versions this build was released with @type {Record<string, string>} */
export const EXPECTED_MODULES = /** @type {any} */ (shipped).modules ?? {};

/**
 * Installed modules older than expected. Pure.
 * @param {{id: string, version?: string, name?: string}[]} installed
 * @param {Record<string, string>} expected
 * @returns {{id: string, name: string, installed: string, expected: string}[]}
 */
export function staleModules(installed, expected) {
	/** @type {{id: string, name: string, installed: string, expected: string}[]} */
	const out = [];
	for (const record of installed ?? []) {
		const want = expected?.[record?.id];
		if (!want || !record?.version) continue;
		if (versionNewer(want, record.version)) out.push({ id: record.id, name: record.name || record.id, installed: String(record.version), expected: String(want) });
	}
	return out;
}

/** The stale list, live. */
export const staleModuleList = derived(userModules, ($records) => staleModules($records, EXPECTED_MODULES));

/** ids being updated right now (the row's button reads it) @type {import('svelte/store').Writable<string[]>} */
export const updatingModules = writable([]);

const TOAST = 'stale-modules';

/**
 * Update one stale module: from the gallery when it lists it (zip installs too), else
 * re-fetch its own URL. Resolves true when the install went through.
 * @param {string} id
 */
export async function updateStaleModule(id) {
	updatingModules.update((l) => [...l, id]);
	try {
		await loadModuleGallery();
		const found = get(galleryModules).find((/** @type {any} */ item) => item.id === id);
		if (found) return !!(await installUrl(galleryInstallUrl(found)));
		const record = get(userModules).find((/** @type {any} */ r) => r.id === id);
		if (!record) return false;
		await updateUserModule(record);
		return true;
	} finally {
		updatingModules.update((l) => l.filter((x) => x !== id));
	}
}

/** Update every stale module, one after another. */
export async function updateAllStale() {
	let ok = 0;
	for (const s of get(staleModuleList)) if (await updateStaleModule(s.id)) ok++;
	return ok;
}

/** the set already announced this session (a re-announce only when it changes) */
let announced = '';
/** @type {(() => void) | null} */
let off = null;

/** Boot: watch the installed list against what this build expects. Idempotent. */
export function startStaleModuleWatch() {
	if (off) return;
	off = staleModuleList.subscribe((list) => {
		const key = list.map((s) => s.id + '@' + s.installed).join(',');
		if (!list.length) {
			if (announced) dismissToastById(TOAST);
			announced = '';
			return;
		}
		if (key === announced) return;
		announced = key;
		for (const s of list) perfMark('stale-module', { id: s.id, installed: s.installed, expected: s.expected });
		const names = list.map((s) => `${s.name} ${s.installed} (this app expects ${s.expected})`).join(', ');
		showInfoToast(
			TOAST,
			(list.length === 1 ? 'An installed module is older than this app expects: ' : 'Installed modules are older than this app expects: ') +
				names +
				'. Old modules can bring back bugs that are already fixed.',
			[
				{
					label: list.length === 1 ? 'Update' : 'Update all',
					action: () => {
						dismissToastById(TOAST);
						void updateAllStale();
					}
				},
				{
					label: 'Open Modules',
					action: () => {
						dismissToastById(TOAST);
						modulesOpen.set(true);
					}
				}
			]
		);
	});
}
