// 36-export (E1) — WHAT AN EXPORTED GAME DOES ON BOOT. The page is this same app build with a
// `play.js` beside index.html (exportBoot reads it): embedMode hides the editor chrome, the
// Peer is an offline stub, no plugin / service worker / update poll / perf beacon runs. This
// module then does the four things only an export needs, in order:
//   1. the user modules the scene needs, from `assets/modules/<id>.zip` (activated for this
//      page only — never stored in the shared itch.io origin);
//   2. the scene, from `scene.tpscene`, through the no-dialog read (`readSessionZip`) and the
//      ordinary apply — no backup slot, no workspace, nothing replicated;
//   3. the export's defaults for the game's own settings (Show FPS, Quality) — only where the
//      player has not chosen already on this device;
//   4. play: a FLAT autoplay (no gesture yet, so a headset session could not start anyway —
//      the start card's Enter VR is the gesture for that).
// A failure is shown on the page (a fixed note), never thrown into the void: an exported game
// has no console its player will read.
import { get } from 'svelte/store';
import { exportConfig, pageUrl } from './exportBoot.js';
import { objectsGroup, globalRenderer } from '../../stores/sceneStore';
import { requestPlay } from '../playMode';

/** @type {{phase: string, error: string, modules: string[]}} for the suite (window.__stores.exportRuntime) */
export const exportRuntimeState = { phase: 'idle', error: '', modules: [] };

/** @param {() => any} probe @param {number} [timeoutMs] */
function waitFor(probe, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const started = Date.now();
		const tick = () => {
			if (probe()) return resolve(true);
			if (Date.now() - started > timeoutMs) return reject(new Error('the engine did not start'));
			setTimeout(tick, 50);
		};
		tick();
	});
}

/** @param {string} rel */
async function fetchBytes(rel) {
	const res = await fetch(pageUrl(rel));
	if (!res.ok) throw new Error(rel + ' — HTTP ' + res.status);
	return res.arrayBuffer();
}

/** @param {string} message */
function showFailure(message) {
	try {
		const note = document.createElement('div');
		note.id = 'export-error';
		note.setAttribute('role', 'alert');
		note.style.cssText =
			'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2000;max-width:calc(100vw - 32px);' +
			'padding:10px 14px;border-radius:10px;font:600 13px/1.4 system-ui,sans-serif;' +
			'background:rgb(var(--surface-rgb, 17 24 39) / 0.92);color:var(--text, #e5e7eb);border:1px solid var(--icon-danger, #f87171)';
		note.textContent = 'This game could not start: ' + message;
		document.body.appendChild(note);
	} catch {
		/* no document — nothing to show */
	}
}

let started = false;

/** Boot the exported game. Idempotent; resolves when play was requested (or it failed). */
export async function startExportRuntime() {
	if (started || !exportConfig) return;
	started = true;
	const cfg = exportConfig;
	try {
		exportRuntimeState.phase = 'engine';
		await waitFor(() => get(objectsGroup) && get(globalRenderer));

		exportRuntimeState.phase = 'modules';
		if (cfg.modules.length) {
			const { activateModuleZip } = await import('../userModules');
			for (const m of cfg.modules) {
				const ok = await activateModuleZip(await fetchBytes(m.file));
				if (ok) exportRuntimeState.modules.push(m.id);
				else console.warn('export: module ' + m.id + ' did not register');
			}
		}

		exportRuntimeState.phase = 'scene';
		const { readSessionZip, applySession } = await import('../sessions');
		const payload = await readSessionZip(await fetchBytes(cfg.scene));
		if (!payload) throw new Error('the scene file is unreadable or from a newer app version');
		if (cfg.title) payload.name = cfg.title;
		await applySession(payload, { backup: false, replicate: false, workspace: false, quiet: true });
		// 36-fb-water S9: an exported simulation scene runs when it opens, as it does in the app
		const { startSimOnLoad } = await import('../sim/simOnLoad.js');
		await startSimOnLoad(payload.physics);

		exportRuntimeState.phase = 'settings';
		await applyGameDefaults(cfg);

		exportRuntimeState.phase = 'play';
		requestPlay({ flat: true });
		exportRuntimeState.phase = 'playing';
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		exportRuntimeState.phase = 'failed';
		exportRuntimeState.error = message;
		console.error('export runtime:', error);
		showFailure(message);
	}
}

/**
 * The export's Show FPS / Quality as the game's DEFAULT: applied ONCE per export per device
 * (a marker keyed by the export id), so a player who then changes them in the game's menu keeps
 * their choice on the next visit. Not "only when nothing is stored": a game module may write its
 * own defaults into the same row while it loads (Sky Run's comfort vignette does).
 * @param {import('./exportBoot.js').ExportConfig} cfg
 */
async function applyGameDefaults(cfg) {
	const { setGameSetting } = await import('../gameSettings');
	const { safeStorage } = await import('../safeStorage');
	const marker = 'tp:export:' + (cfg.id || 'game') + ':defaults';
	if (safeStorage.getItem(marker)) return;
	if (cfg.showFps) setGameSetting('showFps', true);
	if (cfg.quality !== 'auto') setGameSetting('quality', cfg.quality);
	safeStorage.setItem(marker, '1');
}
