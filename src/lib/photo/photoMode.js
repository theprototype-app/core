// Roadmap 98 P2 (lane 98-photo) — PHOTO MODE, the controller: the panel's state, Start / Stop, Download,
// "Save to scene shots", and the HAND-OFF (a Quest or a weak phone asks a PC peer to render its view and
// send the PNG back). Reached by dynamic import only (the Look panel button, the agent's `run {photo}`, a
// peer's `photoreq`), so none of it is in the editor's first load; the tracer itself is a further chunk
// (photoRender.loadTracer).
//
// The hand-off wire (validated in wireValidate by photoCore's shapes; NOT room-scoped on the wire, the
// answerer checks sameRoomOrUnknown itself — a photo of a room you are not in would leak its content):
//   photoreq  {id, pos, quat, fov, near, far, width, height, samples, seconds, denoise}  asker -> PC
//   photores  {id, progress?, samples?}  progress pings, ~1/s           PC -> asker
//   photores  {id, png: Uint8Array, samples, ms} | {id, error}         PC -> asker, once
//   photostop {id}                                                      asker -> PC (Stop pressed)
// ONE request at a time per answering machine; a second gets "busy". The PC's person sees a toast with
// Stop, so nobody's GPU is borrowed silently, and the peer limits (photoCore.PEER_LIMITS) cap the cost.
import { writable, get } from 'svelte/store';
import { peers, showToast } from '../../stores/appStore';
import { globalCamera, globalRenderer, isVRMode } from '../../stores/sceneStore';
import { peerFacts } from '$lib/peerFacts.js';
import { peerName } from '$lib/peerActions.js';
import { sameRoomOrUnknown } from '$lib/peerScenes.js';
import { currentLevel } from '$lib/levels.js';
import { isPhoneDevice } from '$lib/qualityGovernor.js';
import { photoOpen, photoPrefs } from './photoOpen.js';
import { photoPlace, photoPlan, photoFileName, isQuestUa, isPng, validPhotoRequest, validPhotoResult, personName } from './photoCore.js';

/**
 * @typedef {{
 *   status: 'idle'|'rendering'|'done'|'error',
 *   place: 'here'|'peer'|'raster',
 *   why: string,
 *   samples: number, target: number, fraction: number, elapsedMs: number, compiling: boolean,
 *   reason: string, error: string,
 *   url: string, blob: Blob|null, width: number, height: number, ms: number,
 *   notes: {kind: string, count: number, note: string}[],
 *   saved: string
 * }} PhotoState
 */

/** @returns {PhotoState} */
const idle = () => ({ status: 'idle', place: 'here', why: '', samples: 0, target: 0, fraction: 0, elapsedMs: 0, compiling: false, reason: '', error: '', url: '', blob: null, width: 0, height: 0, ms: 0, notes: [], saved: '' });

/** the panel's state (LOCAL: nothing here replicates or saves) */
export const photoState = writable(idle());
export { photoOpen, photoPrefs };

/** @type {AbortController | null} */
let running = null;
/** the hand-off request this tab waits on @type {{id: string, peer: string, resolve: (v: any) => void, reject: (e: any) => void, timer: any} | null} */
let asking = null;

/** the view's size in device pixels, scaled */
function canvasSize(scale = 1) {
	/** @type {any} */
	const r = get(globalRenderer);
	const c = r?.domElement;
	const w = c?.width || 1280;
	const h = c?.height || 720;
	return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

/** connected peers in this room, with their device word */
function roomPeers() {
	/** @type {any} */
	const p = get(peers);
	const facts = /** @type {Record<string, any>} */ (get(peerFacts));
	const ids = Object.keys(p?.connections ?? {}).filter((id) => p.connections[id]?.open && sameRoomOrUnknown(id));
	return ids.map((id) => ({ id, device: facts[id]?.device, name: peerName(id) }));
}

/** where a photo of this view would be made right now (the panel shows it before Start) */
export async function photoWhere() {
	const { canTraceHere } = await import('./photoRender.js');
	const prefs = get(photoPrefs);
	/** @type {any} */
	const r = get(globalRenderer);
	return photoPlace({
		xr: !!(get(isVRMode) || r?.xr?.isPresenting),
		quest: typeof navigator !== 'undefined' && isQuestUa(navigator.userAgent),
		phone: isPhoneDevice(),
		floatTargets: canTraceHere(r),
		force: prefs.force,
		peers: roomPeers()
	});
}

/** @param {Partial<PhotoState>} patch */
function patch(patch) {
	photoState.update((s) => ({ ...s, ...patch }));
}

/** @param {Blob|null} blob */
function setResult(blob) {
	const s = get(photoState);
	if (s.url) URL.revokeObjectURL(s.url);
	return blob ? URL.createObjectURL(blob) : '';
}

/**
 * Take a photo of the current view: here, on a PC peer, or (nowhere) the best raster still.
 * @param {{samples?: number, seconds?: number, denoise?: boolean, width?: number, height?: number, preview?: HTMLCanvasElement|null}} [req]
 * @returns {Promise<PhotoState>}
 */
export async function startPhoto(req = {}) {
	if (running || asking) stopPhoto();
	const prefs = get(photoPrefs);
	const size = canvasSize(prefs.scale);
	const plan = photoPlan({ samples: req.samples ?? prefs.samples, seconds: req.seconds ?? prefs.seconds, denoise: req.denoise ?? prefs.denoise, width: req.width ?? size.width, height: req.height ?? size.height });
	const where = await photoWhere();
	const ctl = new AbortController();
	running = ctl;
	photoState.set({ ...idle(), status: 'rendering', place: where.place, why: where.why, target: plan.samples, width: plan.width, height: plan.height });
	try {
		if (where.place === 'here') {
			const { renderPhoto } = await import('./photoRender.js');
			const r = await renderPhoto(plan, {
				signal: ctl.signal,
				preview: req.preview ?? null,
				onProgress: (p) => patch({ samples: p.samples, fraction: p.fraction, elapsedMs: p.elapsedMs, compiling: p.compiling })
			});
			patch({ status: 'done', samples: r.samples, fraction: 1, reason: r.reason, ms: r.ms, notes: r.notes, blob: r.blob, url: setResult(r.blob), width: r.width, height: r.height });
		} else if (where.place === 'peer' && where.peer) {
			const r = await askPeer(where.peer, plan, ctl.signal);
			patch({ status: 'done', samples: r.samples, fraction: 1, reason: r.reason, ms: r.ms, blob: r.blob, url: setResult(r.blob) });
		} else {
			const { rasterPhoto } = await import('./photoRender.js');
			const blob = await rasterPhoto(plan);
			if (!blob) throw new Error('No view to take a still of.');
			patch({ status: 'done', reason: 'raster', fraction: 1, blob, url: setResult(blob) });
		}
	} catch (e) {
		patch({ status: 'error', error: String(/** @type {any} */ (e)?.message ?? e).slice(0, 200) });
	} finally {
		if (running === ctl) running = null;
	}
	return get(photoState);
}

/** Stop: the still so far is kept (a local render) or the PC is told to stop and send what it has */
export function stopPhoto() {
	running?.abort();
	if (asking) sendTo(asking.peer, { type: 'photostop', id: asking.id });
}

/** Download the last still as a PNG */
export function downloadPhoto() {
	const s = get(photoState);
	if (!s.blob) return false;
	const a = document.createElement('a');
	a.href = s.url || URL.createObjectURL(s.blob);
	a.download = photoFileName(/** @type {any} */ (get(currentLevel))?.name ?? '');
	document.body.appendChild(a);
	a.click();
	a.remove();
	return true;
}

/** "Save to scene shots": the PNG into the Library under Scene shots/<scene>, shared like any file, undoable */
export async function savePhotoToScene() {
	const s = get(photoState);
	if (!s.blob) return null;
	const scene = /** @type {any} */ (get(currentLevel))?.name || 'Untitled scene';
	const { fileIntoLibrary } = await import('$lib/ai/importFile.js');
	const bytes = new Uint8Array(await s.blob.arrayBuffer());
	const r = await fileIntoLibrary(bytes, photoFileName(scene), 'Scene shots/' + scene.replace(/[/\\]/g, '-'));
	patch({ saved: r.folder });
	showToast('Photo saved to the Library: ' + r.folder + '.');
	return { hash: r.item.hash, folder: r.folder, name: r.item.name };
}

/** close the panel and forget the still */
export function closePhoto() {
	stopPhoto();
	const s = get(photoState);
	if (s.url) URL.revokeObjectURL(s.url);
	photoState.set(idle());
	photoOpen.set(false);
}

// ---------------------------------------------------------------- the hand-off

/** @param {string} peerId @param {any} msg */
function sendTo(peerId, msg) {
	/** @type {any} */
	const p = get(peers);
	const conn = p?.connections?.[peerId];
	if (!conn?.open) return false;
	p.sendTo ? p.sendTo(peerId, conn, msg) : conn.send(msg);
	return true;
}

/**
 * Ask a PC peer to render this view.
 * @param {string} peerId @param {ReturnType<typeof photoPlan>} plan @param {AbortSignal} signal
 * @returns {Promise<{blob: Blob, samples: number, ms: number, reason: string}>}
 */
function askPeer(peerId, plan, signal) {
	return import('./photoRender.js').then(
		(m) =>
			new Promise((resolve, reject) => {
				const id = Math.random().toString(36).slice(2, 12);
				const pose = m.poseOf(get(globalCamera));
				const sent = sendTo(peerId, { type: 'photoreq', id, ...pose, width: plan.width, height: plan.height, samples: plan.samples, seconds: plan.seconds, denoise: plan.denoise });
				if (!sent) return reject(new Error('The PC left the session.'));
				const fail = (/** @type {string} */ why) => {
					if (asking?.id !== id) return;
					clearTimeout(asking.timer);
					asking = null;
					reject(new Error(why));
				};
				asking = { id, peer: peerId, resolve, reject, timer: setTimeout(() => fail('The PC did not answer in time.'), (Math.min(plan.seconds, 90) + 60) * 1000) };
				signal.addEventListener('abort', () => sendTo(peerId, { type: 'photostop', id }), { once: true });
			})
	);
}

/** the request this machine is rendering FOR a peer @type {{id: string, from: string, ctl: AbortController} | null} */
let answering = null;

/**
 * A hand-off message from a peer (peerHandler's dispatch, after wireValidate).
 * @param {any} data @param {string} from
 */
export async function onPhotoMessage(data, from) {
	if (data.type === 'photores') {
		if (!asking || data.id !== asking.id || from !== asking.peer || !validPhotoResult(data)) return;
		if (data.png === undefined && data.error === undefined) {
			patch({ samples: data.samples ?? 0, fraction: data.progress ?? 0 });
			return;
		}
		const a = asking;
		clearTimeout(a.timer);
		asking = null;
		if (data.error !== undefined) return a.reject(new Error(String(data.error)));
		const bytes = new Uint8Array(data.png);
		if (!isPng(bytes)) return a.reject(new Error('The PC sent something that is not a PNG.'));
		a.resolve({ blob: new Blob([bytes], { type: 'image/png' }), samples: data.samples ?? 0, ms: data.ms ?? 0, reason: 'peer' });
		return;
	}
	if (data.type === 'photostop') {
		if (answering && answering.id === data.id && answering.from === from) answering.ctl.abort();
		return;
	}
	if (data.type !== 'photoreq' || !validPhotoRequest(data)) return;
	const reply = (/** @type {any} */ m) => sendTo(from, { type: 'photores', id: data.id, ...m });
	if (!sameRoomOrUnknown(from)) return reply({ error: 'That PC is in another scene.' });
	if (answering || running) return reply({ error: 'That PC is busy with another photo.' });
	const where = await photoWhere();
	if (where.place !== 'here') return reply({ error: 'That PC cannot path-trace either.' });
	const plan = photoPlan(data, { peer: true });
	const ctl = new AbortController();
	answering = { id: data.id, from, ctl };
	const who = personName(peerName(from), from) || 'someone in this session';
	showToast('Rendering a photo for ' + who + '…', [{ label: 'Stop', action: () => ctl.abort() }]);
	let lastPing = 0;
	try {
		const { renderPhoto } = await import('./photoRender.js');
		const r = await renderPhoto(plan, {
			pose: data,
			signal: ctl.signal,
			onProgress: (p) => {
				if (p.elapsedMs - lastPing < 1000) return;
				lastPing = p.elapsedMs;
				reply({ progress: p.fraction, samples: p.samples });
			}
		});
		const bytes = new Uint8Array(await r.blob.arrayBuffer());
		reply({ png: bytes, samples: r.samples, ms: r.ms });
		showToast('Photo sent to ' + who + '.');
	} catch (e) {
		reply({ error: String(/** @type {any} */ (e)?.message ?? e).slice(0, 200) });
	} finally {
		answering = null;
	}
}

/** test seam (photo-mode suite): the hand-off state */
export function photoDebug() {
	return { running: !!running, asking: asking ? { id: asking.id, peer: asking.peer } : null, answering: answering ? { id: answering.id, from: answering.from } : null };
}
