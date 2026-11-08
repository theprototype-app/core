// 98 P1 — RUN A BAKE on this device: collect → plan (Worker) → trace (N Workers, progress, the
// tier's time cap) → finish (Worker: denoise, dilate, PNGs) → the PNGs into the Explorer by
// content hash → ONE `setBakeRecord` (one Undo step, replicated, bytes pushed).
//
// Never blocks the UI: the main thread only gathers typed arrays and moves them between workers.
// Cancel terminates every worker and changes NOTHING in the scene. Lazy: loaded by the Bake
// button / the agent, never in the editor's first load or /play.

import { get } from 'svelte/store';
import { bakeJob, bakeRecord, setBakeRecord } from '../sceneBake';
import { objectsGroup } from '../../stores/sceneStore';
import { collectBakeScene, deviceBakeTier, freeChannel } from './bakeScene.js';
import { bakeBudget, objectSig, lightsSig, LITE_SIDE, bakeErrorText } from './bakeRecordCore.js';

/** @type {Worker[]} */
let workers = [];
let cancelled = false;
let seq = 0;
/** rejecters of every pending `ask`: a terminated worker never answers, so Cancel settles them @type {Set<(e: Error) => void>} */
const pending = new Set();
/** e2e only (via the debug hooks): caps that keep a bake short on a software-GL headless box @type {{ atlas?: number, rays?: number, ms?: number } | null} */
let testLimits = null;
/** @param {{ atlas?: number, rays?: number, ms?: number } | null} limits */
export function setBakeTestLimits(limits) {
	testLimits = limits && typeof limits === 'object' ? { ...limits } : null;
}

const makeWorker = () => new Worker(new URL('./bake.worker.js', import.meta.url), { type: 'module' });

/** @param {Worker} w @param {any} msg @param {Transferable[]} transfer @param {(m: any) => void} [onProgress] @returns {Promise<any>} */
function ask(w, msg, transfer, onProgress) {
	const id = ++seq;
	return new Promise((resolve, reject) => {
		/** @param {Error} e */
		const fail = (e) => {
			pending.delete(fail);
			w.removeEventListener('message', onMessage);
			reject(e);
		};
		pending.add(fail);
		/** @param {MessageEvent} e */
		const onMessage = (e) => {
			const data = e.data;
			if (data?.id !== id) return;
			if (data.op === 'progress') {
				onProgress?.(data);
				return;
			}
			pending.delete(fail);
			w.removeEventListener('message', onMessage);
			if (data.error) reject(new Error(data.error));
			else resolve(data);
		};
		w.addEventListener('message', onMessage);
		w.addEventListener('error', (e) => fail(new Error(e.message || 'the bake worker failed')), { once: true });
		w.postMessage({ ...msg, id }, transfer);
	});
}

/** @param {Partial<ReturnType<typeof get<any>>>} patch */
function job(patch) {
	bakeJob.update((j) => ({ ...j, ...patch }));
}

export function isBaking() {
	return get(bakeJob).running;
}

/** Stop the running bake. Nothing in the scene changes. */
export function cancelBake() {
	if (!get(bakeJob).running) return false;
	cancelled = true;
	for (const w of workers) w.terminate();
	workers = [];
	// a terminated worker never answers: settle every pending ask so runBake() returns `cancelled`
	for (const fail of [...pending]) fail(new Error('cancelled'));
	job({ running: false, phase: '', progress: 0, error: '', notes: ['Bake cancelled — nothing changed.'] });
	return true;
}

/**
 * @param {{ quality?: string, ms?: number }} [opts] `ms` overrides the tier's time cap (tests)
 * @returns {Promise<{ ok: true, record: any, notes: string[], ms: number } | { ok: false, cancelled?: boolean, error: string }>}
 */
export async function runBake(opts = {}) {
	if (get(bakeJob).running) return { ok: false, error: 'a bake is already running' };
	cancelled = false;
	const started = performance.now();
	job({ running: true, phase: 'Looking at the scene', progress: 0.01, startedAt: Date.now(), error: '', notes: [] });
	/** @type {'pc'|'phone'|'quest'} */
	let tier = 'pc';
	try {
		tier = await deviceBakeTier();
		const budget = bakeBudget(tier, opts.quality, navigator.hardwareConcurrency || 2);
		if (testLimits?.atlas) {
			budget.atlas = Math.min(budget.atlas, testLimits.atlas);
			budget.pad = Math.max(2, Math.ceil((2 * budget.atlas) / LITE_SIDE));
		}
		if (testLimits?.rays) budget.rays = Math.min(budget.rays, testLimits.rays);
		const timeCap = Math.min(opts.ms ?? budget.timeCapMs, testLimits?.ms ?? Infinity);
		const scene = collectBakeScene();
		// ONE uv channel for the whole bake: uv2 unless some receiver already uses uv2 for itself
		const ch = scene.receivers.some((o) => freeChannel(o.geometry) === 3) ? 3 : 2;
		for (const m of scene.meshes) {
			if (!m.receive) continue;
			const o = scene.receivers.find((r) => r.uuid === m.key);
			const free = freeChannel(o?.geometry);
			if (free !== ch && !(ch === 3 && free === 2 && !o?.geometry?.attributes?.uv3)) {
				m.receive = false;
				scene.skipped.push({ uuid: m.key, name: o?.name || 'object', reason: 'no free UV channel' });
			}
		}
		if (!scene.meshes.some((m) => m.receive)) throw new Error(scene.skipped.length ? 'nothing to bake: ' + summarize(scene.skipped) : 'nothing to bake: the scene has no static objects');
		if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };

		// ---- plan
		job({ phase: 'Unwrapping lightmap UVs', progress: 0.03 });
		const planner = makeWorker();
		workers = [planner];
		/** @type {Transferable[]} */
		const transfer = [];
		for (const m of scene.meshes) for (const k of ['pos', 'index', 'normal', 'uv0', 'uv1']) if (m[k]) transfer.push(m[k].buffer);
		const plan = await ask(planner, { op: 'plan', meshes: scene.meshes, budget }, transfer);
		if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };
		const count = plan.texelOf.length;

		// ---- trace, split across workers
		job({ phase: 'Baking light', progress: 0.1 });
		const n = Math.max(1, Math.min(budget.workers, Math.ceil(count / 4096)));
		const tracers = Array.from({ length: n }, (_, i) => (i === 0 ? planner : makeWorker()));
		workers = tracers;
		const per = Math.ceil(count / n);
		const doneBy = new Array(n).fill(0);
		const timeLeftMs = Math.max(1000, timeCap - (performance.now() - started));
		const results = await Promise.all(
			tracers.map((w, i) => {
				const from = i * per, to = Math.min(count, from + per);
				return ask(
					w,
					{
						op: 'trace',
						tris: plan.tris,
						albedo: plan.albedo,
						lights: scene.lights,
						samples: plan.samples.slice(from * 6, to * 6),
						aoOnly: plan.aoOnly.slice(from, to),
						rays: budget.rays,
						aoDistance: plan.aoDistance,
						bias: plan.bias,
						far: plan.far,
						bounce: scene.lights.length > 0,
						timeLeftMs
					},
					[],
					(p) => {
						doneBy[i] = p.done;
						const total = doneBy.reduce((a, b) => a + b, 0);
						job({ progress: 0.1 + 0.85 * (total / count) });
					}
				).then((r) => ({ ...r, from }));
			})
		);
		if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };
		for (const w of tracers.slice(1)) w.terminate();
		workers = [planner];

		// ---- compact what was traced (a time-capped bake keeps what it has)
		let done = 0;
		for (const r of results) done += r.done;
		const texelOf = new Uint32Array(done);
		const ao = new Float32Array(done);
		const light = new Float32Array(done * 3);
		let k = 0;
		for (const r of results) {
			texelOf.set(plan.texelOf.subarray(r.from, r.from + r.done), k);
			ao.set(r.ao.subarray(0, r.done), k);
			light.set(r.light.subarray(0, r.done * 3), k * 3);
			k += r.done;
		}
		const capped = done < count;

		// ---- finish: PNGs
		job({ phase: 'Writing the lightmap', progress: 0.96 });
		const finished = await ask(planner, { op: 'finish', texelOf, ao, light, count: done, side: plan.side, liteSide: plan.side > LITE_SIDE ? LITE_SIDE : 0 }, [texelOf.buffer, ao.buffer, light.buffer]);
		planner.terminate();
		workers = [];
		if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };

		// ---- into the library by content hash
		const { addItemFromBytes } = await import('../explorer');
		const fullItem = await addItemFromBytes(finished.full.png, 'Baked light.png', null, { imported: true });
		const liteItem = finished.lite ? await addItemFromBytes(finished.lite.png, 'Baked light (small).png', null, { imported: true }) : null;
		if (!fullItem?.hash) throw new Error('could not store the lightmap');

		/** @type {any} */
		const root = get(objectsGroup);
		const objects = plan.objects.map((/** @type {any} */ o) => {
			const mesh = root?.getObjectByProperty?.('uuid', o.key);
			return {
				uuid: o.key,
				src: o.src,
				mode: o.mode,
				pad: o.pad,
				x: o.x,
				y: o.y,
				s: o.s,
				ch,
				sig: mesh ? objectSig(mesh.matrixWorld.elements, mesh.geometry.attributes.position.count) : ''
			};
		});
		const previous = get(bakeRecord);
		const ms = Math.round(performance.now() - started);
		const record = {
			full: { hash: fullItem.hash, side: finished.full.side, bytes: finished.full.png.byteLength },
			lite: liteItem ? { hash: liteItem.hash, side: finished.lite.side, bytes: finished.lite.png.byteLength } : null,
			lightScale: finished.lightScale,
			intensity: previous?.intensity ?? { light: 1, ao: 1 },
			objects,
			lightsSig: lightsSig(scene.lights),
			bakedAt: Date.now(),
			stats: { ms, tier, quality: budget.quality, rays: budget.rays, samples: count, traced: done, capped, workers: n, side: plan.side, lights: scene.lights.length }
		};
		setBakeRecord(record, { label: 'Bake light' });

		const notes = [];
		const aoOnly = plan.objects.filter((/** @type {any} */ o) => o.mode === 'ao').length;
		if (aoOnly) notes.push(aoOnly + (aoOnly === 1 ? ' object has' : ' objects have') + ' overlapping UVs, so ' + (aoOnly === 1 ? 'it gets' : 'they get') + ' soft corner shadows (AO) but no baked light.');
		const left = [...scene.skipped, ...plan.skipped.map((/** @type {any} */ s) => ({ uuid: s.key, name: '', reason: s.reason }))];
		if (left.length) notes.push(summarize(left));
		if (capped) notes.push('The bake hit this device\'s time limit and kept ' + Math.round((100 * done) / count) + '% of the samples; Bake again on a faster device for a cleaner result.');
		if (!scene.lights.length) notes.push('The scene has no lights, so only the corner shadows (AO) were baked.');
		job({ running: false, phase: '', progress: 1, notes });
		return { ok: true, record: get(bakeRecord), notes, ms };
	} catch (error) {
		for (const w of workers) w.terminate();
		workers = [];
		if (cancelled) return { ok: false, cancelled: true, error: 'cancelled' };
		const message = bakeErrorText(String(/** @type {any} */ (error)?.message ?? error), tier, opts.quality);
		job({ running: false, phase: '', progress: 0, error: message, notes: [] });
		return { ok: false, error: message };
	}
}

/** "4 objects left out: 3 move with physics, 1 has an animation" @param {{ reason: string }[]} list */
function summarize(list) {
	/** @type {Map<string, number>} */
	const by = new Map();
	for (const s of list) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
	return list.length + (list.length === 1 ? ' object' : ' objects') + ' left out: ' + [...by].map(([r, n]) => n + ' ' + r).join(', ') + '.';
}

/** Remove the bake from the scene (one Undo step). */
export function clearBake() {
	if (!get(bakeRecord)) return false;
	return setBakeRecord(null, { label: 'Clear baked light' });
}

/** Change the baked light / AO strength (one Undo step, replicated). @param {{ light?: number, ao?: number }} patch */
export function setBakeIntensity(patch) {
	const record = get(bakeRecord);
	if (!record) return false;
	return setBakeRecord({ ...record, intensity: { ...record.intensity, ...patch } }, { label: 'Baked light strength' });
}
