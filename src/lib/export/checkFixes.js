// 63 — THE FIX BUTTONS of the shared check list (checkCore.js rows name a fix; the functions are
// here, loaded with the list, never at boot). Two disjoint blocks: `scene-*` (63-publish) and
// `export-*` (63-export). A fix answers what the list should do next:
//   'rerun' — it changed the scene here; run the checks again and stay on the list
//   'leave' — it opened another tool (the node editor, Modules, the touch layout); the
//             Publish / Export dialog closes so that tool is not under it
// Every scene fix goes through the ordinary edit path (replicated, one undo entry), so a fix
// pressed by mistake is one Ctrl+Z away, like any other edit.
import { get } from 'svelte/store';
import { showToast } from '../../stores/appStore';
import { TEXTURE_MAX_PX } from './sceneChecks.js';

/** @typedef {import('./checkCore.js').CheckRow} CheckRow */
/** @typedef {(row: CheckRow, ctx?: any) => Promise<'rerun' | 'leave'>} CheckFix */

/** @type {Record<string, CheckFix>} */
export const CHECK_FIXES = {
	// ------------------------------------------------------------- scene-* (63-publish)
	async 'scene-shrink-textures'(row, ctx) {
		const { gatherSceneFacts } = await import('./sceneFacts.js');
		const facts = ctx?.scene || (await gatherSceneFacts({ bundle: false }));
		const { resizeSlotTexture } = await import('../uvEditor');
		let n = 0;
		for (const t of facts.textures || [])
			if (Math.max(t.width, t.height) > TEXTURE_MAX_PX && (await resizeSlotTexture(t.uuid, t.slot || 0, TEXTURE_MAX_PX))) n++;
		showToast(n ? `Shrank ${n} texture${n === 1 ? '' : 's'} to ${TEXTURE_MAX_PX} px` : 'No texture needed shrinking');
		return 'rerun';
	},
	async 'scene-set-spawn'() {
		const { globalCamera, orbitControls } = await import('../../stores/sceneStore');
		const { setScenePhysics } = await import('../scenePhysics');
		const camera = /** @type {any} */ (get(globalCamera));
		const target = /** @type {any} */ (get(orbitControls))?.target;
		if (!camera || !target) {
			showToast('Open the editor view first, then try again');
			return 'rerun';
		}
		// the Inspector's Set from view (30c): feet at the point the view orbits, facing along the view
		const yaw = Math.atan2(-(target.x - camera.position.x), -(target.z - camera.position.z));
		const r2 = (/** @type {number} */ v) => Math.round(v * 100) / 100;
		setScenePhysics({ play: { spawn: { position: [r2(target.x), r2(target.y), r2(target.z)], yaw: Math.round(yaw * 1000) / 1000 } } });
		showToast('Players now start where the view is centred');
		return 'rerun';
	},
	async 'scene-fetch-assets'(row, ctx) {
		const { requestAsset } = await import('../assetShare');
		const { gatherSceneFacts } = await import('./sceneFacts.js');
		const facts = ctx?.scene || (await gatherSceneFacts({ bundle: false }));
		const gone = (facts.assets || []).filter((/** @type {any} */ a) => a.missing);
		for (const a of gone) requestAsset(a.hash);
		showToast(gone.length ? `Asked connected people for ${gone.length} file${gone.length === 1 ? '' : 's'}. Check again once they arrive.` : 'Nothing is missing now');
		return 'rerun';
	},
	async 'scene-open-modules'() {
		const { modulesOpen } = await import('../../stores/appStore');
		modulesOpen.set(true);
		return 'leave';
	},
	async 'scene-touch-layout'() {
		const { openTouchLayoutEditor } = await import('../touchActions');
		openTouchLayoutEditor();
		return 'leave';
	},
	async 'scene-open-node'(row) {
		const { goToNode } = await import('../codeWorkspace');
		const a = row.fix?.args || {};
		await goToNode(String(a.nodeId || ''), a.graph && a.graph !== 'scene' ? String(a.graph) : undefined);
		return 'leave';
	}
	// ------------------------------------------------------------- export-* (63-export)
};

/**
 * Run a row's fix. An unknown name (a row from a newer build) says so instead of failing.
 * @param {CheckRow} row @param {any} [ctx] @returns {Promise<'rerun' | 'leave'>}
 */
export async function runFix(row, ctx) {
	const fn = row.fix ? CHECK_FIXES[row.fix.name] : null;
	if (!fn) {
		showToast('This fix is not available in this version');
		return 'rerun';
	}
	try {
		return await fn(row, ctx);
	} catch (e) {
		showToast('The fix did not work: ' + String(/** @type {any} */ (e)?.message ?? e).slice(0, 120));
		return 'rerun';
	}
}
