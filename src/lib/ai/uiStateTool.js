// Roadmap 107 (lane 107-ui-state) — `ui_state` and `scene_stats`: what the person sees in their own tab, read
// without changing it. A lazy chunk (personTools.js loads it on the first call); the pure rules are in uiStateCore.js.
//
//   ui_state              selection, the Inspector's object, the graph the Flow editor shows, the shader graph the
//                         Shader editor shows, the Timeline's open sequence, the camera pose (and a camera looked
//                         through), the device (phone / desktop / Quest, in a headset or not), Quality (preset,
//                         level, what it lowered by itself), the first-use permissions this tab holds, and `panels`
//                         (107-panels' registry; filled at the int, null until then)
//   scene_stats           the Statistics and Profiler figures under the panels' own names; compare = the Budget
//                         estimate on Quest, phone and desktop in one table; snapshot / diff / snapshots = named
//                         readings of this page; target = switch what Statistics ▸ Budget judges for (a line with Back)
//
// Everything is LOCAL and read-only except `target`, which changes one local display choice of a read-only panel
// (never the scene, never sent) and leaves the person a line with Back.

import { get } from 'svelte/store';
import {
	selectedObjects,
	objectsGroup,
	globalCamera,
	orbitControls,
	globalRenderer,
	isVRMode,
	isLocked
} from '../../stores/sceneStore.js';
import { inspectorClose, inspectorKind, showToastById } from '../../stores/appStore.js';
import { activeGraphId, flowGraphs, SCENE_GRAPH } from '../../stores/flowStore.js';
import {
	compareTargets,
	snapshotOf,
	keepSnapshot,
	diffSnapshots,
	cleanName,
	targetOf,
	TARGET_WORDS,
	grantsList,
	SNAPSHOT_MAX
} from './uiStateCore.js';

const MAX_SELECTION = 20;
/** the Profiler's live window an answer averages over, ms */
const LIVE_MS = 10000;

/** @param {number} n */
const r1 = (n) => Math.round(n * 10) / 10;
/** @param {number[]} v */
const v3 = (v) => v.map((n) => Math.round(n * 100) / 100 + 0);

/** @param {string} uuid */
function objectRef(uuid) {
	/** @type {any} */
	const o = /** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', uuid);
	return o
		? { uuid, name: String(o.name || o.type || '').slice(0, 60) }
		: { uuid, name: '', missing: true };
}

// ---------------------------------------------------------------- ui_state

/** the person in a headset (the renderer's own answer first) */
function inHeadset() {
	/** @type {any} */
	const r = get(globalRenderer);
	try {
		return !!r?.xr?.isPresenting || !!get(isVRMode);
	} catch {
		return !!get(isVRMode);
	}
}

/** phone / desktop / Quest: what this device is, the way the app decides it */
async function deviceView() {
	const q = await import('$lib/qualityGovernor');
	const headset = inHeadset();
	const phone = !!q.isPhoneDevice?.();
	const ua = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
	const quest = /OculusBrowser|Quest/i.test(ua);
	const kind = quest ? 'quest' : phone ? 'phone' : 'desktop';
	return {
		kind,
		name: TARGET_WORDS[kind] ?? kind,
		inHeadset: headset,
		...(phone && q.phoneRefreshHz?.() ? { refreshHz: q.phoneRefreshHz() } : {})
	};
}

/** Quality: the preset, the level held now and what the app lowered by itself (the chip's own words) */
async function qualityView() {
	const q = await import('$lib/qualityGovernor');
	const st = /** @type {any} */ (get(q.qualityState));
	const game = /** @type {any} */ (get(q.gameQualityState));
	const auto = !!get(q.autoQuality);
	const labels = Array.isArray(st?.labels) ? st.labels.slice(0, 12).map(String) : [];
	return {
		preset: String(get(q.qualityPreset) ?? 'auto'),
		auto,
		level: Number(st?.level) || 0,
		max: Number(st?.max) || 0,
		...(labels.length ? { lowered: labels } : {}),
		...(st?.reason ? { reason: String(st.reason).slice(0, 120) } : {}),
		...(st?.pinned ? { pinned: true } : {}),
		...(st?.held ? { held: true } : {}),
		...(game?.level !== null && game?.level !== undefined
			? { game: { preset: String(game.preset), level: game.level } }
			: {}),
		say: labels.length
			? (st?.pinned
					? 'Quality is held at level ' + st.level
					: 'Quality lowered itself to keep the frame rate') +
				': ' +
				labels.join(', ') +
				'.'
			: 'Full quality: nothing is lowered.'
	};
}

/** the editor camera, and a scene camera the person looks through */
async function cameraView() {
	/** @type {any} */
	const cam = get(globalCamera);
	/** @type {any} */
	const controls = get(orbitControls);
	/** @type {any} */
	const out = {};
	if (cam?.position) {
		out.position = v3(cam.position.toArray());
		if (controls?.target) out.target = v3(controls.target.toArray());
		if (Number.isFinite(cam.fov)) out.fov = r1(cam.fov);
	}
	try {
		const { lookingThrough } = await import('../connector/throughCamera.js');
		const through = /** @type {any} */ (
			lookingThrough((/** @type {string} */ u) =>
				/** @type {any} */ (get(objectsGroup))?.getObjectByProperty?.('uuid', u)
			)
		);
		if (through)
			out.through = {
				kind: through.kind,
				...(through.uuid ? { uuid: through.uuid, name: through.name } : {})
			};
	} catch {}
	if (get(isLocked) === true) out.playing = true;
	return out;
}

/** which graph the Flow editor shows, and whether it exists yet */
function flowView() {
	const id = String(get(activeGraphId) ?? SCENE_GRAPH);
	const graphs = /** @type {any} */ (get(flowGraphs)) ?? {};
	const g = graphs[id];
	const nodes = Array.isArray(g?.nodes) ? g.nodes.length : 0;
	if (id === SCENE_GRAPH) return { graph: 'scene', name: 'Scene flow', nodes };
	const ref = objectRef(id);
	return {
		graph: id,
		object: ref,
		name: 'Flow of ' + (ref.name || 'an object'),
		nodes,
		...(g ? {} : { empty: true })
	};
}

/** what the Shader editor is scoped to (an object, one slot, the scene default or a post graph) */
async function shaderView() {
	try {
		const { activeShaderGraph } = await import('$lib/shaderGraph.js');
		const key = /** @type {string | null} */ (get(activeShaderGraph));
		if (!key) return null;
		if (key === 'scene') return { key, name: 'Scene default shader' };
		if (key.startsWith('post:')) return { key, name: 'Post graph' };
		const [uuid, slot] = key.split('/');
		return { key, object: objectRef(uuid), ...(slot ? { slot } : {}) };
	} catch {
		return null;
	}
}

/** the Timeline's open sequence */
async function timelineView() {
	try {
		const { activeSequence, sequenceOf } = await import('$lib/sequences.js');
		const id = /** @type {string | null} */ (get(activeSequence));
		if (!id) return null;
		const s = /** @type {any} */ (sequenceOf(id));
		return {
			id,
			name: String(s?.name ?? ''),
			...(s
				? {
						tracks: Array.isArray(s.tracks) ? s.tracks.length : 0,
						...(Number.isFinite(s.duration) ? { duration: s.duration } : {})
					}
				: { missing: true })
		};
	} catch {
		return null;
	}
}

/** the first-use permissions this tab holds (show's panel / camera / code), for the agent to read */
async function grantsView() {
	try {
		const { showGrants } = await import('./showGrants.js');
		return showGrants();
	} catch {
		return null;
	}
}

/**
 * 107-int: ui_state.panels from 107-panels' registry (src/lib/ai/panels.js readPanels): each panel with its state (open,
 * where, visible, front), the dock and both sidebars, focus mode and the active named layout. The descriptions, the
 * refused surfaces and the saved layouts stay in show {action: "panels"}.
 * @returns {Promise<any>}
 */
async function panelsView() {
	try {
		const { readPanels } = await import('./panels.js');
		const r = await readPanels();
		return {
			open: r.panels
				.filter((/** @type {any} */ p) => p.open)
				.map((/** @type {any} */ p) => ({ id: p.id, title: p.title, where: p.where, visible: !!p.visible, front: !!p.front, ...(p.readOnly ? { readOnly: true } : {}) })),
			closed: r.panels.filter((/** @type {any} */ p) => !p.open).map((/** @type {any} */ p) => p.title),
			dock: r.dock,
			left: r.left,
			right: r.right,
			focusMode: r.focusMode ?? null,
			layout: r.layouts?.active ?? null,
			...(r.playing ? { playing: true } : {}),
			more: 'show {action: "panels"}: what each panel holds, the saved layouts and the surfaces show never opens'
		};
	} catch {
		return null;
	}
}

/** @param {any} _args */
export async function uiState(_args) {
	const sel = /** @type {string[]} */ ([...(get(selectedObjects) ?? [])]);
	const inspector = get(inspectorClose)
		? { open: false }
		: {
				open: true,
				shows: String(get(inspectorKind) ?? 'selection'),
				// the window's own title (inspectorKind 'scene' is Configure Scene, anything else Properties)
				panel: get(inspectorKind) === 'scene' ? 'Configure Scene' : 'Properties',
				...(get(inspectorKind) === 'selection' && sel.length
					? { object: objectRef(sel[sel.length - 1]) }
					: {})
			};
	const [device, quality, camera, shader, timeline, grants, panels] = await Promise.all([
		deviceView(),
		qualityView(),
		cameraView(),
		shaderView(),
		timelineView(),
		grantsView(),
		panelsView()
	]);
	let budgetTarget = null;
	try {
		const bm = await import('$lib/budgetMeter.js');
		budgetTarget = String(get(bm.budgetTarget));
	} catch {}
	return {
		selection: {
			count: sel.length,
			objects: sel.slice(-MAX_SELECTION).map(objectRef),
			...(sel.length > MAX_SELECTION ? { more: sel.length - MAX_SELECTION } : {})
		},
		inspector,
		flow: flowView(),
		...(shader ? { shader } : {}),
		...(timeline ? { timeline } : {}),
		camera,
		device,
		...(budgetTarget
			? {
					statisticsJudgesFor: {
						target: budgetTarget,
						name: TARGET_WORDS[budgetTarget] ?? budgetTarget
					}
				}
			: {}),
		quality,
		...(grants ? { permissions: grants } : {}),
		// 107-int: 107-panels' registry (readPanels), compact: what is open, where, visible and in front
		panels,
		note: "Read-only: nothing on the person's screen changed. scene_stats reads the Statistics and Profiler figures; show changes what they see."
	};
}

// ---------------------------------------------------------------- scene_stats

/** this page's named snapshots, oldest first @type {any[]} */
let snapshots = [];

/** the figures every answer is built from */
async function readFigures() {
	const sb = await import('$lib/sceneBudget.js');
	const bm = await import('$lib/budgetMeter.js');
	const core = await import('$lib/budgetMeterCore.js');
	// the overlay's own last sample (a fresh one only before the first: sampling drains the render counters it reads)
	const last = /** @type {any} */ (get(sb.sceneMetrics));
	const live = /** @type {any} */ (last?.at ? last : sb.sampleSceneMetrics());
	const reading = /** @type {any} */ (bm.sampleBudget());
	const target = /** @type {any} */ (String(get(bm.budgetTarget)));
	const frames = await profilerFrames();
	const q = await import('$lib/qualityGovernor');
	const qs = /** @type {any} */ (get(q.qualityState));
	const totals = reading?.totals ?? {};
	/** @type {Record<string, number>} */
	const figures = {
		...(Number.isFinite(live?.objects) ? { objects: live.objects } : {}),
		...pickNum(totals, [
			'triangles',
			'calls',
			'textureMB',
			'lights',
			'shadowLights',
			'shadowCasters'
		]),
		...(frames ? { frameAvgMs: frames.avg, frameP95Ms: frames.p95 } : {}),
		...(live?.calls > 0 ? { drawnCalls: live.calls } : {}),
		...(live?.triangles > 0 ? { drawnTriangles: live.triangles } : {}),
		...pickNum(live ?? {}, ['textures', 'geometries']),
		qualityLevel: Number(qs?.level) || 0
	};
	const heaviest = reading
		? core.heaviest(
				reading.rows ?? [],
				/** @type {any} */ (bm.TARGETS)[target] ?? bm.TARGETS.quest,
				5
			)
		: [];
	return { sb, bm, core, live, reading, target, frames, figures, heaviest };
}

/** @param {Record<string, any>} from @param {string[]} keys */
function pickNum(from, keys) {
	/** @type {Record<string, number>} */
	const out = {};
	for (const k of keys)
		if (typeof from?.[k] === 'number' && Number.isFinite(from[k])) out[k] = r1(from[k]);
	return out;
}

/** frame time over the Profiler's live window (its light ring), else the Statistics sampler's ring */
async function profilerFrames() {
	try {
		const rec = await import('$lib/perf/recorder.js');
		const win = /** @type {any} */ (rec.lightWindow(LIVE_MS));
		const ms = (win?.frames ?? [])
			.map((/** @type {any} */ f) => Number(f.ms))
			.filter((/** @type {number} */ n) => n > 0);
		if (ms.length >= 10) {
			const sorted = [...ms].sort((a, b) => a - b);
			const avg =
				ms.reduce((/** @type {number} */ a, /** @type {number} */ b) => a + b, 0) / ms.length;
			const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
			return {
				avg: r1(avg),
				p95: r1(p95),
				fps: Math.round(1000 / avg),
				frames: ms.length,
				seconds: LIVE_MS / 1000,
				source: 'Profiler (live)'
			};
		}
	} catch {}
	try {
		const sb = await import('$lib/sceneBudget.js');
		const s = /** @type {any} */ (sb.frameStats());
		if (s?.n >= 10 && s.p50 > 0)
			return {
				avg: r1(s.p50),
				p95: r1(s.p95),
				fps: Math.round(1000 / s.p50),
				frames: s.n,
				source: 'Statistics (median for the average)'
			};
	} catch {}
	return null;
}

/** the memory figures this browser can give */
function memoryView() {
	/** @type {any} */
	const r = get(globalRenderer);
	const info = r?.info?.memory;
	/** @type {any} */
	const perf = typeof performance !== 'undefined' ? /** @type {any} */ (performance).memory : null;
	return {
		...(info ? { geometries: info.geometries, textures: info.textures } : {}),
		...(perf?.usedJSHeapSize ? { jsHeapMB: Math.round(perf.usedJSHeapSize / 1048576) } : {})
	};
}

/** the default answer: Statistics (live + Budget) and Profiler, with the panels' names */
async function readStats() {
	const f = await readFigures();
	const { sb, bm, live, reading, target, frames, heaviest } = f;
	const profile = live?.profile === 'vr' ? 'vr' : 'desktop';
	const phone = (await import('$lib/qualityGovernor')).isPhoneDevice?.() ? 'phone' : null;
	const judged = /** @type {any} */ (phone ?? profile);
	const rows = sb
		.budgetRows(live ?? {}, judged)
		.map((/** @type {any} */ r) => ({
			name: r.label,
			value: r.value === null ? null : r1(r.value),
			...(r.unit ? { unit: r.unit } : {}),
			tier: r.tier,
			green: r.green
		}));
	const verdict = reading ? /** @type {any} */ (bm.verdictFor(reading, target)) : null;
	const quality = await qualityView();
	return {
		statistics: {
			panel: 'Statistics',
			judgedAgainst: judged === 'vr' ? 'VR' : judged,
			tier: sb.worstTier(live ?? {}, judged),
			rows,
			// the window's "Frame" and "Meshes / hidden" lines
			...(Number.isFinite(live?.frameP50)
				? { frame: { p50: r1(live.frameP50), p95: r1(live.frameP95), p99: r1(live.frameP99) } }
				: {}),
			...(Number.isFinite(live?.meshes) ? { meshes: live.meshes, hidden: live.hidden ?? 0 } : {})
		},
		...(verdict
			? {
					budget: {
						panel: 'Statistics ▸ Budget',
						judgeFor: TARGET_WORDS[target] ?? target,
						target,
						tier: verdict.tier,
						percent: verdict.percent,
						worst: verdict.worst?.label,
						rows: verdict.rows.map((/** @type {any} */ r) => ({
							name: r.label,
							value: r1(r.value),
							limit: Number.isFinite(r.limit) ? r.limit : null,
							tier: r.tier
						})),
						...(heaviest.length
							? {
									heaviest: heaviest.map((/** @type {any} */ h) => ({
										uuid: h.uuid,
										name: h.name,
										percent: h.percent,
										by: h.by,
										triangles: h.triangles,
										calls: h.calls
									}))
								}
							: {})
					}
				}
			: {}),
		profiler: {
			panel: 'Profiler',
			...(frames
				? {
						frameAvgMs: frames.avg,
						frameP95Ms: frames.p95,
						fps: frames.fps,
						overSeconds: frames.seconds ?? null,
						from: frames.source
					}
				: { note: 'no frames measured yet (the view may be idle)' }),
			...(recordingNow() ? { recording: recordingNow() } : {})
		},
		memory: memoryView(),
		quality,
		...(snapshots.length ? { snapshots: snapshots.map((s) => s.name) } : {}),
		say: sayStats(verdict, frames, quality, target),
		note: 'Read-only. compare = this scene on Quest, phone and desktop in one table; snapshot {name} then diff {from, to} = what changed.'
	};
}

/** @type {any} */
let recInfo = null;
function recordingNow() {
	return recInfo;
}

/** @param {any} verdict @param {any} frames @param {any} quality @param {string} target */
function sayStats(verdict, frames, quality, target) {
	const parts = [];
	if (verdict)
		parts.push(
			'For ' +
				(TARGET_WORDS[target] ?? target) +
				' the scene is ' +
				verdict.tier +
				' (' +
				verdict.percent +
				'% of the ' +
				String(verdict.worst?.label ?? '').toLowerCase() +
				' budget)'
		);
	if (frames) parts.push('frames ' + frames.avg + ' ms on average, ' + frames.p95 + ' ms p95');
	if (quality?.lowered?.length) parts.push('Quality lowered: ' + quality.lowered.join(', '));
	return parts.length ? parts.join('; ') + '.' : 'No reading yet.';
}

async function compareStats() {
	const f = await readFigures();
	if (!f.reading) return { error: 'The 3D view is not ready yet: try again in a moment.' };
	/** @type {Record<string, any>} */
	const verdicts = {};
	for (const id of f.core.TARGET_IDS) verdicts[id] = f.bm.verdictFor(f.reading, id);
	return {
		panel: 'Statistics ▸ Budget',
		...compareTargets(verdicts, f.target),
		note: "The content estimate (whole scene, full detail), the numbers the perf gate holds games to. Nothing changed on the person's screen."
	};
}

/** @param {any} args */
async function snapshotStats(args) {
	const f = await readFigures();
	const name = cleanName(args?.name) || 'Snapshot ' + (snapshots.length + 1);
	const snap = snapshotOf(
		name,
		f.figures,
		Date.now(),
		f.heaviest.map((/** @type {any} */ h) => ({
			name: h.name,
			triangles: h.triangles,
			calls: h.calls
		}))
	);
	const replaced = snapshots.some((s) => s.name.toLowerCase() === name.toLowerCase());
	snapshots = keepSnapshot(snapshots, snap);
	return {
		saved: snap.name,
		...(replaced ? { replaced: true } : {}),
		figures: snap.figures,
		kept: snapshots.length,
		max: SNAPSHOT_MAX,
		note:
			'Kept on this page until it reloads. diff {from: "' + snap.name + '"} compares it with now.'
	};
}

/** @param {string} name */
const findSnap = (name) =>
	snapshots.find((s) => s.name.toLowerCase() === cleanName(name).toLowerCase()) ?? null;

/** @param {any} args */
async function diffStats(args) {
	if (!snapshots.length)
		return { error: 'no snapshots yet: scene_stats {action: "snapshot", name} keeps one' };
	const from = args?.from ? findSnap(args.from) : snapshots[snapshots.length - 1];
	if (!from)
		return {
			error:
				'no snapshot "' + cleanName(args.from) + '": ' + snapshots.map((s) => s.name).join(', ')
		};
	let to = args?.to ? findSnap(args.to) : null;
	if (args?.to && !to)
		return {
			error: 'no snapshot "' + cleanName(args.to) + '": ' + snapshots.map((s) => s.name).join(', ')
		};
	if (!to) {
		const f = await readFigures();
		to = snapshotOf('now', f.figures, Date.now());
	}
	return diffSnapshots(from, to);
}

/** @param {any} args @param {string} by */
async function setTarget(args, by) {
	const id = targetOf(args?.target);
	if (!id) return { error: 'target: quest, phone or desktop' };
	const bm = await import('$lib/budgetMeter.js');
	const was = String(get(bm.budgetTarget));
	if (was === id) return { target: id, name: TARGET_WORDS[id], changed: false };
	bm.setBudgetTarget(id);
	showToastById(
		'stats-target-line',
		by + ' set Statistics to judge this scene for ' + TARGET_WORDS[id] + '.',
		[{ label: 'Back', action: () => bm.setBudgetTarget(was) }]
	);
	const v = await readStats();
	return {
		target: id,
		name: TARGET_WORDS[id],
		changed: true,
		was,
		budget: /** @type {any} */ (v).budget ?? null,
		note: "Only this device's Statistics view changed (it is not saved in the scene). The person has a Back button."
	};
}

/** @param {any} args @param {{by?: string}} [ctx] */
export async function sceneStats(args, ctx = {}) {
	const a = args && typeof args === 'object' ? args : {};
	const action = String(a.action ?? 'read');
	try {
		const rec = await import('$lib/perf/recorder.js');
		recInfo = rec.recordingInfo?.() ?? null;
	} catch {
		recInfo = null;
	}
	if (action === 'read') return readStats();
	if (action === 'compare') return compareStats();
	if (action === 'snapshot') return snapshotStats(a);
	if (action === 'diff') return diffStats(a);
	if (action === 'snapshots')
		return { snapshots: snapshots.map((s) => ({ name: s.name, at: s.at, figures: s.figures })) };
	if (action === 'target') return setTarget(a, String(ctx.by || 'The assistant'));
	return { error: 'action: read, compare, snapshot, diff, snapshots or target' };
}

/** unit / e2e: forget this page's snapshots */
export function uiStateResetForTest() {
	snapshots = [];
}

export { grantsList };
