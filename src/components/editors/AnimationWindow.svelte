<script>
	// Animation window: a keyframe animator for the selected object. DOCKED mode is a
	// Flow-family tab in the bottom dock; UNDOCKED mode is a floating, resizable
	// window. Left = the object's clips (the ones it was imported with, then the
	// authored ones) and the active clip's tracks; centre = the TIMELINE, either a
	// dope sheet of every track or a value graph of the selected one; right = the
	// selected key and the easing that leaves it.
	//
	// The centre used to be a single fixed 200px easing square, which could only
	// describe one from->to segment. Keys made that a real timeline (17-E A3): drag
	// keys in time (and value, in the graph), double-click to insert, Del to remove.
	// Every gesture is wrapped in beginAnimGesture/endAnimGesture so a drag is ONE
	// undo entry and ONE broadcast instead of dozens.
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import { selectedObject } from '../../stores/sceneStore';
	import { animationClose } from '../../stores/appStore.js';
	import {
		animations, playback, playheads, CHANNELS, EASINGS, STEPPED, channelLabel, isRotChannel,
		activeClip, clipList, addTrack, removeTrack, updateTrack, updateAnim, retimeClip,
		addKey, updateKey, removeKey, moveKeys, sampleTrack, channelValue, channelApplies, isMaterialChannel,
		createClip, renameClip, duplicateClip, deleteClip, setActiveClip, keyTimes,
		beginAnimGesture, endAnimGesture, play, pause, stop, resetPreview, scrub, setSpeed, setRange,
		PRESETS, applyPreset, autoKeyFor, setAutoKey, rememberAutoKeyReference, captureAutoKey,
		bakeAnimations
	} from '$lib/animationPreview';
	import { showToast, openSceneSection } from '../../stores/appStore.js';
	// the clips a model was IMPORTED with are a different system (replicated,
	// posed from the synced clock) — the window used to ignore them entirely, so
	// a rigged model showed "no movements yet" and its own animations were
	// reachable only from the Inspector.
	import { animatedObjects, setAnimationState, clipInfo } from '$lib/animatedImports';
	import {
		SkipBack, SkipForward, StepBack, StepForward, Play, Pause, Square, Rewind, ZoomIn, ZoomOut, Maximize2
	} from '@lucide/svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import DockTabs from '../DockTabs.svelte';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { setDockOccupant, dockHeight, visibleDockKey, activateDock } from '$lib/bottomDock';

	// live-follow the primary selection (keeps a truthy [] before the first select)
	const target = $derived($selectedObject && $selectedObject.uuid ? $selectedObject : null);
	// the ACTIVE clip of the object's set, normalized (a v1 save migrates on read)
	const anim = $derived.by(() => {
		$animations; // the store is the dependency; activeClip reads it with get()
		return target ? activeClip(target.uuid) : null;
	});
	const tracks = $derived(anim?.tracks ?? []);
	const authoredClips = $derived.by(() => {
		$animations;
		return target ? clipList(target.uuid) : [];
	});

	let selId = $state(/** @type {string|null} */ (null));
	const selTrack = $derived(tracks.find((t) => t.id === selId) ?? tracks[0] ?? null);
	let newChannel = $state('pos.y');
	// only offer channels the object actually HAS — a light intensity track on a box,
	// or a metalness track on a material without one, would never animate anything
	const addableChannels = $derived(target ? CHANNELS.filter((c) => channelApplies(target, c)) : CHANNELS);
	/** the selected keys as [trackId, index] pairs — shift-click adds to it, and a
	 *  drag moves every one of them by the same delta */
	let selKeys = $state(/** @type {[string, number][]} */ ([]));
	/** the single selected key, when there is exactly one (the fields on the right) */
	const selKey = $derived(selKeys.length === 1 ? selKeys[0] : null);
	const selKeyObj = $derived.by(() => {
		const sel = selKey;
		if (!sel) return null;
		const track = tracks.find((t) => t.id === sel[0]);
		return track?.keys[sel[1]] ?? null;
	});
	const isKeySelected = (/** @type {string} */ trackId, /** @type {number} */ index) =>
		selKeys.some(([id, i]) => id === trackId && i === index);
	/** the easing being edited: the selected key's, else the first key's */
	const easeKey = $derived(selKeyObj ?? selTrack?.keys?.[0] ?? null);
	const segEase = $derived(easeKey?.ease ?? EASINGS.linear);
	let view = $state(/** @type {'sheet'|'graph'} */ ('sheet'));
	/** 'off' | 'frame' | a step in seconds as a string */
	let snapMode = $state(
		typeof localStorage !== 'undefined' ? (localStorage.getItem('animationSnap') ?? 'frame') : 'frame'
	);
	let renaming = $state(/** @type {string|null} */ (null));
	// how tall the clip list is allowed to be, dragged by the divider under it
	let clipsH = $state(
		typeof localStorage !== 'undefined' ? parseInt(localStorage.getItem('animationClipsH') ?? '96') || 96 : 96
	);
	let clipsResizing = $state(false);
	function startClipsResize(/** @type {any} */ e) {
		clipsResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doClipsResize(/** @type {any} */ e) {
		if (!clipsResizing) return;
		clipsH = Math.min(Math.max(48, clipsH + e.movementY), 360);
	}
	function endClipsResize(/** @type {any} */ e) {
		if (!clipsResizing) return;
		clipsResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('animationClipsH', String(clipsH));
	}

	// imported clips for the selected object (empty for anything not imported
	// with animation). clipInfo reads the live mixer, so it needs the store as a
	// dependency to re-run when an import registers or is dropped.
	const clipState = $derived(target ? ($animatedObjects[target.uuid] ?? null) : null);
	const clips = $derived.by(() => {
		$animatedObjects;
		return target ? clipInfo(target.uuid) : [];
	});

	// transport is per object now (N objects can play at once); the playhead time
	// comes from the per-frame `playheads` store, the transport state does not.
	const pb = $derived(target ? ($playback[target.uuid] ?? null) : null);
	const isPlaying = $derived(!!pb?.playing);
	const curTime = $derived(target ? ($playheads[target.uuid] ?? pb?.pausedAt ?? 0) : 0);
	const duration = $derived(anim?.duration ?? 2);
	const speed = $derived(pb?.speed ?? 1);
	// A/B window: part of the transport, so both peers loop the same seconds
	const rangeIn = $derived(Math.min(Math.max(pb?.rangeIn ?? 0, 0), duration));
	const rangeOut = $derived(Math.min(pb?.rangeOut ?? duration, duration));
	const ranged = $derived(rangeIn > 1e-6 || rangeOut < duration - 1e-6);

	// VIEW window (zoom + pan). Local, and shared by every channel: the sheet and
	// the graph are one time axis, which is the whole point of a dope sheet — a
	// per-channel zoom would stop the rows lining up.
	let viewStart = $state(0);
	let viewEnd = $state(2);
	$effect(() => {
		// follow the clip when it changes length, unless the user has zoomed in
		const d = duration;
		untrack(() => {
			if (viewEnd <= viewStart || viewEnd > d + 1e-6 || (viewStart === 0 && Math.abs(viewEnd - 2) < 1e-9)) {
				viewStart = 0;
				viewEnd = d;
			}
		});
	});
	const viewSpan = $derived(Math.max(viewEnd - viewStart, 0.05));
	/** @param {number} factor @param {number} [around] the time to keep under the cursor */
	function zoomView(factor, around) {
		const centre = around ?? (viewStart + viewEnd) / 2;
		const span = Math.min(Math.max(viewSpan * factor, 0.1), duration);
		let from = centre - (centre - viewStart) * (span / viewSpan);
		from = Math.min(Math.max(from, 0), Math.max(0, duration - span));
		viewStart = from;
		viewEnd = Math.min(from + span, duration);
	}
	function fitView() {
		viewStart = 0;
		viewEnd = duration;
	}
	/**
	 * The WHEEL ZOOMS about the cursor — up zooms in, down zooms out — because that
	 * is what the wheel does over a timeline everywhere else, and it is the gesture
	 * reached for most. Shift+wheel pans, as do right- and middle-drag.
	 */
	function onPlotWheel(/** @type {WheelEvent} */ e) {
		if (!plotEl) return;
		e.preventDefault();
		const r = plotEl.getBoundingClientRect();
		const at = xt(e.clientX - r.left);
		const away = e.deltaY !== 0 ? e.deltaY : e.deltaX;
		if (e.shiftKey) {
			const span = viewSpan;
			const step = away * 0.0015 * span;
			const from = Math.min(Math.max(viewStart + step, 0), Math.max(0, duration - span));
			viewStart = from;
			viewEnd = Math.min(from + span, duration);
			return;
		}
		zoomView(away < 0 ? 1 / 1.2 : 1.2, at);
	}
	// auto-key is armed for ONE object at a time (the one you are posing)
	const recording = $derived(!!target && $autoKeyFor === target.uuid);

	// docked vs floating (starts docked, undockable)
	let docked = $state(true);
	let winW = $state(660);
	let winH = $state(460);
	if (typeof localStorage !== 'undefined') {
		docked = localStorage.getItem('animationDocked') !== 'false';
		winW = parseInt(localStorage.getItem('animationWinW') ?? '660') || 660;
		winH = parseInt(localStorage.getItem('animationWinH') ?? '460') || 460;
	}
	function setDocked(/** @type {boolean} */ v) {
		docked = v;
		localStorage.setItem('animationDocked', String(v));
		if (v) activateDock('animation');
	}

	// tab-grouped windows share one size: show the group's rect so a resize on any
	// member updates every tab, not just the active one.
	const myGroup = $derived($tabGroups.find((g) => g.members.includes('animation')) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		setDockOccupant('animation', !$animationClose && docked, $dockHeight);
		return () => setDockOccupant('animation', false);
	});
	const dockVisible = $derived($visibleDockKey === 'animation');

	// Switching objects LEAVES the previous one where it was: its playhead, its
	// pose and its clip all stay put (they live per uuid in `playback`), so coming
	// back finds the frame you were working on instead of a rewound clip. That was
	// a real complaint — the old code stopped any non-playing preview here, which
	// restored the base pose and threw the time away. ⏹ is how you rewind, and a
	// serializer never sees the previewed pose (parkAuthoredAtBase).
	let prevUuid = /** @type {string|null} */ (null);
	$effect(() => {
		const t = target?.uuid ?? null;
		untrack(() => {
			if (t === prevUuid) return;
			const prev = prevUuid;
			prevUuid = t;
			selKeys = [];
			// auto-key is armed for ONE object; selecting another disarms it rather
			// than silently recording the next thing you drag
			if (prev && prev !== t && get(autoKeyFor) === prev) setAutoKey(null);
		});
	});

	function add() {
		if (!target) return;
		selId = addTrack(target.uuid, newChannel, target);
		selKeys = [];
	}
	function togglePlay() {
		if (!target) return;
		if (isPlaying) pause(target.uuid);
		else play(target.uuid, undefined, { from: Math.max(0, curTime - rangeIn), reverse: false });
	}
	/** play backwards from where the playhead stands */
	function playBack() {
		if (!target) return;
		play(target.uuid, undefined, { from: Math.max(0, rangeOut - curTime), reverse: true });
	}
	/** Step to the previous / next key time. In GRAPH view that means the keys of
	 *  the channel on screen — stepping through every channel's keys while looking at
	 *  one curve lands the playhead where nothing visible happens. */
	function stepKey(/** @type {number} */ dir) {
		if (!target) return;
		const own = view === 'graph' && selTrack ? selTrack.keys.map((k) => k.t) : keyTimes(target.uuid);
		const stops = [...new Set([...own, 0, duration])].sort((a, b) => a - b);
		const here = curTime;
		const next =
			dir < 0
				? [...stops].reverse().find((t) => t < here - 1e-4)
				: stops.find((t) => t > here + 1e-4);
		scrub(target.uuid, next ?? (dir < 0 ? 0 : duration));
	}

	const isRot = (/** @type {string} */ ch) => isRotChannel(ch);
	/** value as the user reads it (degrees for rotation) @param {number|undefined} v */
	function dispVal(v, /** @type {string} */ channel) {
		const n = v ?? 0;
		return isRot(channel) ? Math.round((n * 180) / Math.PI * 100) / 100 : Math.round(n * 1000) / 1000;
	}
	/** the reverse, for typed input @param {number} n */
	function storeVal(n, /** @type {string} */ channel) {
		return isRot(channel) ? (n * Math.PI) / 180 : n;
	}
	function setKeyVal(/** @type {number} */ index, /** @type {string} */ raw) {
		const n = parseFloat(raw);
		if (Number.isNaN(n) || !target || !selTrack) return;
		updateKey(target.uuid, selTrack.id, index, { v: storeVal(n, selTrack.channel) });
	}
	function setKeyTime(/** @type {number} */ index, /** @type {string} */ raw) {
		const n = parseFloat(raw);
		if (Number.isNaN(n) || !target || !selTrack) return;
		updateKey(target.uuid, selTrack.id, index, { t: Math.max(0, n) });
	}

	// --- timeline geometry -------------------------------------------------------
	// x is clip SECONDS across the plot; the dope sheet stacks one row per track and
	// the graph plots the selected track's values.
	let plotW = $state(420);
	let plotVH = $state(220);
	const PAD_X = 10;
	const RULER_H = 16;
	const ROW_H = 22;
	// The graph FILLS the pane instead of sitting at a fixed height: a short dock
	// clipped the curve and grew a scrollbar, and a tall one wasted the room. There
	// is nothing below the curve to reveal, so scrolling was never the answer.
	const GRAPH_H = $derived(Math.max(80, plotVH - RULER_H - 22));
	// plotW is the container's clientWidth, which INCLUDES its 8px padding either
	// side, so sizing the svg from it overflowed the content box by 12px — no visible
	// bar (overflow-x is hidden) but a scrollable width all the same
	const plotAvail = $derived(Math.max(80, plotW - 16));
	const innerW = $derived(Math.max(60, plotAvail - PAD_X * 2));
	const sheetH = $derived(RULER_H + Math.max(1, tracks.length) * ROW_H + 6);
	const plotH = $derived(view === 'graph' ? RULER_H + GRAPH_H + 6 : sheetH);
	// x maps the VISIBLE window, so zooming and panning move every channel together
	const tx = (/** @type {number} */ t) => PAD_X + ((t - viewStart) / viewSpan) * innerW;
	const xt = (/** @type {number} */ x) => viewStart + ((x - PAD_X) / innerW) * viewSpan;
	const rowY = (/** @type {number} */ i) => RULER_H + i * ROW_H + ROW_H / 2;

	// Value range of the selected track, for the graph's y axis. FROZEN while a key
	// is dragged: the range is derived from the keys, so letting it breathe under
	// the cursor moved the value->pixel mapping with the value, and the key barely
	// followed the pointer at all (it looked like the y axis was locked).
	let frozenRange = $state(/** @type {{lo: number, hi: number}|null} */ (null));
	const range = $derived.by(() => {
		if (frozenRange) return frozenRange;
		const keys = selTrack?.keys ?? [];
		if (!keys.length) return { lo: 0, hi: 1 };
		let lo = Infinity;
		let hi = -Infinity;
		for (const k of keys) {
			lo = Math.min(lo, k.v);
			hi = Math.max(hi, k.v);
		}
		if (hi - lo < 1e-6) {
			lo -= 0.5;
			hi += 0.5;
		}
		const pad = (hi - lo) * 0.15;
		return { lo: lo - pad, hi: hi + pad };
	});
	const vy = (/** @type {number} */ v) =>
		RULER_H + GRAPH_H - ((v - range.lo) / (range.hi - range.lo)) * GRAPH_H;
	const yv = (/** @type {number} */ y) =>
		range.lo + ((RULER_H + GRAPH_H - y) / GRAPH_H) * (range.hi - range.lo);

	/** the curve of the selected track, sampled through the real evaluator */
	const curve = $derived.by(() => {
		if (view !== 'graph' || !selTrack) return '';
		const steps = 96;
		let d = '';
		for (let i = 0; i <= steps; i++) {
			const t = viewStart + (i / steps) * viewSpan;
			const v = sampleTrack(selTrack, t);
			if (v === null) continue;
			d += (d ? ' L ' : 'M ') + tx(t).toFixed(2) + ' ' + vy(v).toFixed(2);
		}
		return d;
	});

	/** tick times for the visible window, at a sensible step for its span */
	const ticks = $derived.by(() => {
		const raw = viewSpan / 8;
		const step = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60].find((s) => s >= raw) ?? 60;
		const out = [];
		for (let t = Math.ceil(viewStart / step) * step; t <= viewEnd + 1e-6; t += step) {
			out.push(Math.round(t * 1e4) / 1e4);
		}
		return out;
	});

	// FRAMES. An animator thinks in frames, so the arrow keys step in them and
	// snapping can too. 30 is the default; localStorage overrides it for a 24 or 60
	// fps pipeline (there is nothing else in the app that owns a frame rate yet).
	const FPS = (() => {
		const raw = typeof localStorage !== 'undefined' ? Number(localStorage.getItem('animationFps')) : NaN;
		return Number.isFinite(raw) && raw >= 1 && raw <= 240 ? raw : 30;
	})();
	const frame = 1 / FPS;

	/** @param {number} t */
	function snapT(t) {
		if (snapMode === 'frame') return Math.round(t * FPS) / FPS;
		if (snapMode === 'off') return Math.round(t * 1000) / 1000;
		return Math.round(t / Number(snapMode)) * Number(snapMode);
	}

	/** which transform the selection is under: 1 = move, 2 = scale (mesh tools use
	 *  1/2/3 the same way, so the digits mean "pick a tool" everywhere) */
	let xform = $state(/** @type {'move'|'scale'} */ ('move'));

	// --- moving keys -------------------------------------------------------------
	// Three ways in, one engine:
	//   * left drag  — press a key and pull (shift-click first to take several);
	//   * RIGHT click — a modal GRAB: the selection follows the pointer with no
	//     button held, until a click or Enter commits it and Escape puts it back;
	//   * the number fields on the right, for an exact value.
	// Every one of them moves the WHOLE selection by the same delta and writes it
	// through `moveKeys`, so a drag across two channels is one store write, one
	// broadcast and (through the gesture) one undo entry.
	let plotEl = $state(/** @type {any} */ (null));
	/** the element carrying the key handler — focused on any press in the plot */
	let plotHost = $state(/** @type {any} */ (null));
	/** @type {{origin: {x: number, y: number}, snapshot: any[], modal: boolean, pivot: {t: number, v: number}}|null} */
	let move = null;
	let grabbing = $state(false);

	/** the selected keys with their CURRENT times/values, to apply a delta against */
	function keySnapshot() {
		/** @type {{trackId: string, index: number, t0: number, v0: number, stepped: boolean}[]} */
		const out = [];
		for (const [trackId, index] of selKeys) {
			const track = tracks.find((t) => t.id === trackId);
			const key = track?.keys[index];
			if (!track || !key) continue;
			out.push({ trackId, index, t0: key.t, v0: key.v, stepped: STEPPED.has(track.channel) });
		}
		return out;
	}

	/**
	 * Write the gesture's current offset onto every selected key.
	 *
	 * MOVE shifts them; SCALE stretches them about a pivot — the PLAYHEAD in time
	 * (which is what you want: park the head where the movement should stay put and
	 * pull the rest out) and the selection's own middle in value.
	 * @param {number} dt @param {number|null} dv
	 */
	function applyDelta(dt, dv) {
		if (!target || !move?.snapshot.length) return;
		const scaling = xform === 'scale';
		// a horizontal offset becomes a FACTOR when scaling; 200px doubles it
		const kt = scaling ? Math.max(0.05, 1 + dt / Math.max(viewSpan, 0.001) * 1.5) : 1;
		const kv = scaling && dv !== null ? Math.max(0.05, 1 + dv / Math.max(range.hi - range.lo, 1e-6) * 1.5) : 1;
		const pivotT = move.pivot.t;
		const pivotV = move.pivot.v;
		const moves = move.snapshot.map((s) => {
			const t = scaling ? pivotT + (s.t0 - pivotT) * kt : s.t0 + dt;
			const value = scaling ? pivotV + (s.v0 - pivotV) * kv : s.v0 + (dv ?? 0);
			return {
				trackId: s.trackId,
				index: s.index,
				// SCALE does not snap: near the pivot a whole factor step is worth less
				// than one frame, so snapping rounded it straight back — the horizontal
				// half of the gesture looked dead while the vertical (unsnapped) worked
				t: scaling
					? Math.max(0, Math.min(duration, t))
					: snapT(Math.max(0, Math.min(duration, t))),
				...((scaling || dv !== null) && !s.stepped ? { v: value } : {})
			};
		});
		// keys re-sort as they pass one another; moveKeys reports where each one
		// LANDED, which is the only reliable identity once two of them share a time
		const landed = moveKeys(target.uuid, moves);
		/** @type {[string, number][]} */
		const next = [];
		move.snapshot.forEach((s, i) => {
			const spot = landed[i];
			if (!spot) return;
			s.index = spot.index;
			next.push([spot.trackId, spot.index]);
		});
		if (next.length) selKeys = next;
	}

	/** @param {PointerEvent|MouseEvent} e */
	function deltaFrom(e) {
		if (!plotEl || !move) return { dt: 0, dv: /** @type {number|null} */ (null) };
		const r = plotEl.getBoundingClientRect();
		const x = e.clientX - r.left;
		const y = e.clientY - r.top;
		const dt = xt(x) - xt(move.origin.x);
		const dv = view === 'graph' ? yv(y) - yv(move.origin.y) : null;
		return { dt, dv };
	}

	function beginMove(/** @type {PointerEvent|MouseEvent} */ e, /** @type {boolean} */ modal) {
		if (!target) return;
		const snapshot = keySnapshot();
		if (!snapshot.length) return;
		const r = plotEl?.getBoundingClientRect();
		move = {
			origin: { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) },
			snapshot,
			modal,
			// scale pivots: the playhead in time, the selection's middle in value
			pivot: {
				t: curTime,
				v: snapshot.reduce((sum, s) => sum + s.v0, 0) / snapshot.length
			}
		};
		// hold the y axis still for the whole gesture (see `frozenRange`)
		if (view === 'graph') frozenRange = { lo: range.lo, hi: range.hi };
		beginAnimGesture(target.uuid, selKeys.length > 1 ? 'Move keys' : 'Move key');
		if (modal) {
			grabbing = true;
			window.addEventListener('pointermove', onMoveMove);
			window.addEventListener('pointerdown', grabConfirm, true);
			window.addEventListener('keydown', grabKeys, true);
		} else {
			window.addEventListener('pointermove', onMoveMove);
			window.addEventListener('pointerup', endDrag);
		}
	}
	function onMoveMove(/** @type {PointerEvent} */ e) {
		if (!move) return;
		const { dt, dv } = deltaFrom(e);
		applyDelta(dt, dv);
	}
	function finishMove(/** @type {boolean} */ keep) {
		const open = move;
		move = null;
		grabbing = false;
		frozenRange = null;
		window.removeEventListener('pointermove', onMoveMove);
		window.removeEventListener('pointerup', endDrag);
		window.removeEventListener('pointerdown', grabConfirm, true);
		window.removeEventListener('keydown', grabKeys, true);
		if (!keep && open && target) {
			// put every key back exactly where it was
			moveKeys(
				target.uuid,
				open.snapshot.map((s) => ({ trackId: s.trackId, index: s.index, t: s.t0, v: s.v0 }))
			);
		}
		endAnimGesture(); // one entry either way (none if nothing changed)
	}
	function endDrag() {
		finishMove(true);
	}
	function grabConfirm(/** @type {PointerEvent} */ e) {
		if (!move?.modal) return;
		e.preventDefault();
		e.stopPropagation(); // the committing click must not start a fresh drag
		finishMove(true);
	}
	function grabKeys(/** @type {KeyboardEvent} */ e) {
		if (!move?.modal) return;
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			finishMove(false);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			finishMove(true);
		}
	}

	/**
	 * Press on a key. LEFT selects (shift adds) and drags; MIDDLE locks the selection
	 * to the pointer (the modal grab), which leaves RIGHT free for the menu — the
	 * split you end up wanting once both exist.
	 */
	function keyDown(/** @type {PointerEvent} */ e, /** @type {string} */ trackId, /** @type {number} */ index) {
		if (!target) return;
		if (move?.modal) return; // a grab is running; its own handler commits
		if (e.button === 2) return; // the menu opens on contextmenu, not here
		e.preventDefault();
		e.stopPropagation();
		plotHost?.focus?.({ preventScroll: true }); // so the keyboard works
		selId = trackId;
		if (e.button === 1) {
			if (!isKeySelected(trackId, index)) selKeys = [[trackId, index]];
			beginMove(e, true);
			return;
		}
		if (e.shiftKey) {
			selKeys = isKeySelected(trackId, index)
				? selKeys.filter(([id, i]) => !(id === trackId && i === index))
				: [...selKeys, [trackId, index]];
			return; // shift is for building the set, not for dragging it
		}
		if (!isKeySelected(trackId, index)) selKeys = [[trackId, index]];
		beginMove(e, false);
	}

	/** right-click a key: its menu (and a running grab commits, so the button that
	 *  ends the gesture can be either one) */
	function keyContext(/** @type {MouseEvent} */ e, /** @type {string} */ trackId, /** @type {number} */ index) {
		if (!target) return;
		e.preventDefault();
		e.stopPropagation();
		if (move) return finishMove(true);
		selId = trackId;
		if (!isKeySelected(trackId, index)) selKeys = [[trackId, index]];
		openPlotMenu(e);
	}

	// --- scrubbing by dragging the timeline --------------------------------------
	// A click on the ruler jumped the playhead; a DRAG has to follow the pointer, so
	// you can watch the movement while you sweep through it. The Threlte canvas
	// swallows pointermove/up mid-gesture, so these live on `window` like every
	// other drag in the app.
	let scrubbing = false;
	function scrubAt(/** @type {number} */ clientX) {
		if (!target || !plotEl) return;
		const r = plotEl.getBoundingClientRect();
		// the playhead lands on the snap grid too: a frame grid you can scrub off is
		// not a frame grid, and it showed times no key could ever sit on
		scrub(target.uuid, snapT(Math.max(0, Math.min(duration, xt(clientX - r.left)))));
	}
	/**
	 * Starts a scrub when the press lands in the ruler BAND. It listens on the whole
	 * plot rather than on the ruler rect: the tick lines and their labels are drawn
	 * over that rect as SIBLINGS, so a press on a tick had nothing to bubble to and
	 * silently did nothing (found with elementFromPoint — the pixel reported a
	 * `<line>`, not the rect). Key handles stop propagation, so they still win.
	 */
	function plotDown(/** @type {PointerEvent} */ e) {
		if (!target || !plotEl) return;
		// any press in the plot gives it the keyboard, so the arrows and 1/2 work
		// without hunting for what to click first
		plotEl.parentElement?.parentElement?.focus?.({ preventScroll: true });
		const r = plotEl.getBoundingClientRect();
		// RIGHT or MIDDLE button on the plot body: a pan if the pointer travels, and
		// the context menu if it does not (the Blender split — the view is dragged far
		// more often than the menu is opened, and a menu on press would fight it)
		if (e.button === 2 || e.button === 1) {
			e.preventDefault();
			// capture the SPAN too: it is derived from the two ends we are about to
			// write, so reading it per move feeds the zoom level back into the pan
			pan = { x: e.clientX, y: e.clientY, start: viewStart, span: viewSpan, moved: false };
			window.addEventListener('pointermove', panMove);
			window.addEventListener('pointerup', panUp);
			return;
		}
		if (e.clientY - r.top > RULER_H) return; // below the ruler: not a scrub
		e.preventDefault();
		scrubbing = true;
		scrubAt(e.clientX);
		window.addEventListener('pointermove', rulerMove);
		window.addEventListener('pointerup', rulerUp);
	}

	/** @type {{x: number, y: number, start: number, span: number, moved: boolean}|null} */
	let pan = null;
	function panMove(/** @type {PointerEvent} */ e) {
		if (!pan || !plotEl) return;
		const dx = e.clientX - pan.x;
		if (!pan.moved && Math.abs(dx) < 4 && Math.abs(e.clientY - pan.y) < 4) return;
		pan.moved = true;
		const seconds = (dx / Math.max(innerW, 1)) * pan.span;
		const from = Math.min(Math.max(pan.start - seconds, 0), Math.max(0, duration - pan.span));
		viewStart = from;
		viewEnd = Math.min(from + pan.span, duration);
	}
	// --- the navigator strip -----------------------------------------------------
	/** @type {{el: any, span: number}|null} */
	let navDrag = null;
	function navTo(/** @type {number} */ clientX, /** @type {number} */ span) {
		if (!navDrag) return;
		const r = navDrag.el.getBoundingClientRect();
		const at = ((clientX - r.left) / Math.max(r.width, 1)) * duration;
		const from = Math.min(Math.max(at - span / 2, 0), Math.max(0, duration - span));
		viewStart = from;
		viewEnd = Math.min(from + span, duration);
	}
	function navDown(/** @type {PointerEvent} */ e) {
		e.preventDefault();
		// freeze the span, like the pan: it is derived from the ends we are writing
		navDrag = { el: e.currentTarget, span: viewSpan };
		navTo(e.clientX, navDrag.span);
		window.addEventListener('pointermove', navMove);
		window.addEventListener('pointerup', navUp);
	}
	function navMove(/** @type {PointerEvent} */ e) {
		if (navDrag) navTo(e.clientX, navDrag.span);
	}
	function navUp() {
		navDrag = null;
		window.removeEventListener('pointermove', navMove);
		window.removeEventListener('pointerup', navUp);
	}

	function panUp(/** @type {PointerEvent} */ e) {
		const dragged = pan?.moved;
		pan = null;
		window.removeEventListener('pointermove', panMove);
		window.removeEventListener('pointerup', panUp);
		if (!dragged && e.button === 2) openPlotMenu(e); // a right-click that stayed put
	}
	function rulerMove(/** @type {PointerEvent} */ e) {
		if (scrubbing) scrubAt(e.clientX);
	}
	function rulerUp() {
		scrubbing = false;
		window.removeEventListener('pointermove', rulerMove);
		window.removeEventListener('pointerup', rulerUp);
	}

	/** how close (in pixels) counts as "on" an existing key */
	const PICK_PX = 9;
	/** Is there already a key within a few pixels of this time on `track`? Inserting
	 *  one there would stack two keys nobody can tell apart, and a double-click that
	 *  lands NEAR a key means "that one", not "a new one". @param {any} track */
	function keyNear(track, /** @type {number} */ t) {
		if (!track) return -1;
		let best = -1;
		let bestPx = PICK_PX;
		track.keys.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
			const px = Math.abs(tx(k.t) - tx(t));
			if (px <= bestPx) {
				bestPx = px;
				best = i;
			}
		});
		return best;
	}

	/** double-click on empty space inserts a key; ON (or beside) an existing key it
	 *  selects that one instead of stacking a duplicate on top of it */
	function plotDblClick(/** @type {MouseEvent} */ e) {
		if (!target || !plotEl) return;
		const r = plotEl.getBoundingClientRect();
		const x = e.clientX - r.left;
		const y = e.clientY - r.top;
		if (y <= RULER_H) return; // the ruler scrubs, it does not author
		const t = snapT(Math.max(0, Math.min(duration, xt(x))));
		const track = view === 'graph' ? selTrack : tracks[Math.floor((y - RULER_H) / ROW_H)];
		if (!track) return;
		selId = track.id;
		const near = keyNear(track, t);
		if (near >= 0) {
			selKeys = [[track.id, near]];
			return;
		}
		const v =
			view === 'graph' && !STEPPED.has(track.channel) ? yv(y) : (sampleTrack(track, t) ?? 0);
		addKey(target.uuid, track.id, t, v);
	}

	/** delete every selected key, highest index first so the rest keep their spots */
	function deleteSelectedKeys() {
		if (!target || !selKeys.length) return;
		const doomed = [...selKeys].sort((a, b) => b[1] - a[1]);
		beginAnimGesture(target.uuid, doomed.length > 1 ? 'Remove keys' : 'Remove key');
		for (const [trackId, index] of doomed) removeKey(target.uuid, trackId, index);
		endAnimGesture();
		selKeys = [];
	}

	/** the keys of the channel(s) on screen, at (or nearest) the playhead */
	function keysAtPlayhead() {
		const list = view === 'graph' && selTrack ? [selTrack] : tracks;
		/** @type {[string, number][]} */
		const hits = [];
		for (const track of list) {
			let best = -1;
			let bestGap = frame * 1.5;
			track.keys.forEach((/** @type {any} */ k, /** @type {number} */ i) => {
				const gap = Math.abs(k.t - curTime);
				if (gap <= bestGap) {
					bestGap = gap;
					best = i;
				}
			});
			if (best >= 0) hits.push([track.id, best]);
		}
		return hits;
	}

	/** nudge the selection with the keyboard: X in time, Y in value (graph view),
	 *  through the same gesture machinery so it is one undo entry per press */
	function nudge(/** @type {number} */ dx, /** @type {number} */ dy, /** @type {number} */ mult) {
		if (!target || !selKeys.length) return;
		const snapshot = keySnapshot();
		if (!snapshot.length) return;
		move = {
			origin: { x: 0, y: 0 },
			snapshot,
			modal: false,
			pivot: { t: curTime, v: snapshot.reduce((sum, s) => sum + s.v0, 0) / snapshot.length }
		};
		beginAnimGesture(target.uuid, xform === 'scale' ? 'Scale keys' : 'Move keys');
		if (xform === 'scale') {
			// a keypress is a fixed 2% step per unit, so it reads as a nudge either way
			applyDelta(dx * mult * viewSpan * 0.0133, dy ? dy * mult * (range.hi - range.lo) * 0.0133 : null);
		} else {
			const step = frame * mult;
			const vStep = ((range.hi - range.lo) / 100) * mult;
			applyDelta(dx * step, dy ? dy * vStep : null);
		}
		move = null;
		endAnimGesture();
	}

	/**
	 * The editor's keyboard. Panels swallow DELEGATED handlers, so this is a direct
	 * listener (the DragRow lesson, 16-Q3).
	 *
	 *   ←/→            playhead by one FRAME (Ctrl x10, Shift x100 — the DragRow
	 *                  convention, so the modifiers mean the same thing everywhere)
	 *   Alt+←/→        jump to the previous/next key
	 *   Ctrl+Space     add the key at the playhead to the selection
	 *   Esc            drop the selection (or cancel a grab)
	 *   1 / 2          arm Move / Scale
	 *   Shift+arrows   transform the selection: ←/→ in time, ↑/↓ in value
	 *   Del            remove the selection
	 * @param {HTMLElement} node
	 */
	function keyNav(node) {
		const onKey = (/** @type {KeyboardEvent} */ e) => {
			if (!target) return;
			const tag = /** @type {any} */ (e.target)?.tagName;
			if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
			const mult = e.ctrlKey || e.metaKey ? 10 : e.shiftKey ? 100 : 1;
			const arrow = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] }[e.key];

			if (e.key === 'Delete' || e.key === 'Backspace') {
				if (!selKeys.length) return;
				e.preventDefault();
				deleteSelectedKeys();
				return;
			}
			if (e.key === 'Escape') {
				if (move?.modal) return; // its own handler cancels the grab
				if (!selKeys.length) return;
				e.preventDefault();
				selKeys = [];
				return;
			}
			if (e.key === '1' || e.key === '2') {
				e.preventDefault();
				xform = e.key === '1' ? 'move' : 'scale';
				return;
			}
			if (e.code === 'Space' && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				const hits = keysAtPlayhead();
				if (!hits.length) return;
				const fresh = hits.filter(([id, i]) => !isKeySelected(id, i));
				selKeys = fresh.length ? [...selKeys, ...fresh] : selKeys.filter(([id, i]) => !hits.some(([hid, hi]) => hid === id && hi === i));
				if (hits[0]) selId = hits[0][0];
				return;
			}
			if (!arrow) return;
			e.preventDefault();
			// SHIFT + arrows transform the selection; otherwise the arrows drive the
			// playhead (where Shift is free to be the big multiplier)
			if (e.shiftKey && selKeys.length) {
				nudge(arrow[0], view === 'graph' ? arrow[1] : 0, e.ctrlKey || e.metaKey ? 10 : 1);
				return;
			}
			if (arrow[1] !== 0) return; // up/down does nothing to the playhead
			if (e.altKey) {
				stepKey(arrow[0]);
				return;
			}
			scrub(target.uuid, Math.max(0, Math.min(duration, curTime + arrow[0] * frame * mult)));
		};
		node.addEventListener('keydown', onKey);
		return { destroy: () => node.removeEventListener('keydown', onKey) };
	}

	// --- the "+" menu ------------------------------------------------------------
	let menu = $state(/** @type {any} */ (null));

	/**
	 * The plot's own context menu (a right-click that did not pan). It carries what
	 * you want where you are pointing: the key operations when something is selected,
	 * and the view controls always — a right-click that only produced the BROWSER
	 * menu was the reported gap.
	 * @param {PointerEvent|MouseEvent} e
	 */
	function openPlotMenu(e) {
		if (!target || !plotEl) return;
		const uuid = target.uuid;
		const r = plotEl.getBoundingClientRect();
		const x = e.clientX - r.left;
		const y = e.clientY - r.top;
		const t = snapT(Math.max(0, Math.min(duration, xt(x))));
		const row = view === 'graph' ? selTrack : tracks[Math.floor((y - RULER_H) / ROW_H)];
		const count = selKeys.length;
		/** @type {any[]} */
		const items = [];
		if (count) {
			items.push({ header: count > 1 ? count + ' keys' : 'Key' });
			items.push({
				label: count > 1 ? 'Delete ' + count + ' keys' : 'Delete key',
				danger: true,
				action: () => {
					const doomed = [...selKeys].sort((a, b) => b[1] - a[1]);
					beginAnimGesture(uuid, count > 1 ? 'Remove keys' : 'Remove key');
					for (const [trackId, index] of doomed) removeKey(uuid, trackId, index);
					endAnimGesture();
					selKeys = [];
				}
			});
			items.push({
				label: 'Reset easing (linear)',
				tooltip: 'Drop the curve on the segment leaving each selected key',
				action: () => {
					beginAnimGesture(uuid, 'Reset easing');
					for (const [trackId, index] of selKeys) updateKey(uuid, trackId, index, { ease: null });
					endAnimGesture();
				}
			});
			items.push({
				label: 'Easing',
				children: Object.keys(EASINGS).map((name) => ({
					label: name,
					action: () => {
						beginAnimGesture(uuid, 'Easing');
						for (const [trackId, index] of selKeys) {
							updateKey(uuid, trackId, index, { ease: [...EASINGS[name]] });
						}
						endAnimGesture();
					}
				}))
			});
			items.push({
				label: 'Move to the playhead',
				tooltip: 'Put the selection at ' + curTime.toFixed(2) + 's, keeping their spacing',
				action: () => {
					const first = Math.min(...selKeys.map(([id, i]) => {
						const track = tracks.find((tr) => tr.id === id);
						return track?.keys[i]?.t ?? 0;
					}));
					const shift = snapT(curTime) - first;
					beginAnimGesture(uuid, 'Move keys');
					moveKeys(
						uuid,
						selKeys.map(([id, i]) => {
							const track = tracks.find((tr) => tr.id === id);
							return { trackId: id, index: i, t: Math.max(0, (track?.keys[i]?.t ?? 0) + shift) };
						})
					);
					endAnimGesture();
				}
			});
			items.push({
				label: 'Value from the object now',
				tooltip: 'Read the object as it stands and store that as the key value',
				action: () => {
					beginAnimGesture(uuid, 'Key pose');
					for (const [trackId, index] of selKeys) {
						const track = tracks.find((tr) => tr.id === trackId);
						if (track) updateKey(uuid, trackId, index, { v: channelValue(target, track.channel) });
					}
					endAnimGesture();
				}
			});
			items.push({ section: 'Timeline' });
		}
		items.push({
			label: 'Add key here',
			disabled: !row,
			tooltip: row ? channelLabel(row.channel) + ' at ' + t.toFixed(2) + 's' : 'No channel here',
			action: () => {
				if (!row) return;
				selId = row.id;
				const v = view === 'graph' && !STEPPED.has(row.channel) ? yv(y) : (sampleTrack(row, t) ?? 0);
				addKey(uuid, row.id, t, v);
			}
		});
		items.push({
			label: 'Select every key',
			disabled: !tracks.length,
			action: () => {
				selKeys = tracks.flatMap((track) =>
					view === 'graph' && selTrack && track.id !== selTrack.id
						? []
						: track.keys.map((_, i) => /** @type {[string, number]} */ ([track.id, i]))
				);
			}
		});
		items.push({ section: 'View' });
		items.push({ label: 'Reset view (fit the clip)', action: fitView });
		items.push({
			label: 'Zoom to the selection',
			disabled: selKeys.length < 2,
			action: () => {
				const times = selKeys.map(([id, i]) => {
					const track = tracks.find((tr) => tr.id === id);
					return track?.keys[i]?.t ?? 0;
				});
				const lo = Math.min(...times);
				const hi = Math.max(...times);
				const padding = Math.max((hi - lo) * 0.15, 0.05);
				viewStart = Math.max(0, lo - padding);
				viewEnd = Math.min(duration, hi + padding);
			}
		});
		items.push({
			label: 'Snap to frames',
			checked: snapMode === 'frame',
			tooltip: FPS + ' fps',
			action: () => {
				snapMode = snapMode === 'frame' ? 'off' : 'frame';
				localStorage.setItem('animationSnap', snapMode);
			}
		});
		menu = { x: e.clientX, y: e.clientY, items };
	}
	function openAddMenu(/** @type {MouseEvent} */ e) {
		if (!target) return;
		const uuid = target.uuid;
		const t = curTime;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ header: 'Add' },
				{
					label: 'Channel',
					children: addableChannels.map((c) => ({
						label: channelLabel(c),
						action: () => {
							selId = addTrack(uuid, c, target);
							selKeys = [];
						}
					}))
				},
				{
					label: 'Key at playhead',
					disabled: !selTrack,
					tooltip: 'Insert a key on the selected channel at ' + t.toFixed(2) + 's',
					action: () => {
						if (!selTrack) return;
						addKey(uuid, selTrack.id, snapT(t), sampleTrack(selTrack, t) ?? 0);
					}
				},
				{
					label: 'Keys on every channel',
					disabled: !tracks.length,
					tooltip: 'Hold this frame: drop a key on every channel at once',
					action: () => {
						beginAnimGesture(uuid, 'Add keys');
						for (const track of tracks) {
							addKey(uuid, track.id, snapT(t), sampleTrack(track, t) ?? 0);
						}
						endAnimGesture();
					}
				},
				{
					label: 'Key the current pose',
					tooltip:
						'Read the object as it stands now and key every channel that moved — the same thing REC does after a drag, on demand',
					action: () => {
						// go through auto-key so a channel with no track yet is CREATED,
						// exactly as an armed drag would do it
						const armed = get(autoKeyFor);
						if (armed !== uuid) {
							rememberAutoKeyReference(uuid);
							setAutoKey(uuid);
						}
						beginAnimGesture(uuid, 'Key pose');
						for (const track of tracks) {
							addKey(uuid, track.id, snapT(t), channelValue(target, track.channel));
						}
						endAnimGesture();
						captureAutoKey(uuid, snapT(t));
						if (armed !== uuid) setAutoKey(armed);
					}
				},
				{ section: 'Timing' },
				{
					label: 'Clear the preview',
					tooltip:
						'Put the object back to the pose it had before anything previewed it, and rewind. Stop only returns to where the run began.',
					action: () => resetPreview(uuid)
				},
				{
					label: 'Retime the movement…',
					disabled: !tracks.length,
					tooltip:
						'Stretch or squash every key time by the same ratio, so the movement keeps its shape and only its pace changes',
					children: [0.5, 1, 2, 4, 8].map((seconds) => ({
						label: seconds + 's',
						action: () => {
							retimeClip(uuid, seconds);
							showToast('Retimed the movement to ' + seconds + 's.');
						}
					}))
				},
				{ section: 'Presets' },
				...Object.entries(PRESETS).map(([kind, preset]) => ({
					label: preset.name,
					tooltip: preset.needsOrigin
						? 'Needs its origin on the hinge edge to swing there'
						: 'Adds a ready-made ' + preset.name.toLowerCase() + ' clip',
					action: () => {
						const made = applyPreset(kind, uuid, target);
						selId = null;
						selKeys = [];
						if (made?.needsOrigin) {
							// the swing is only a HINGE once the pivot sits on the edge — say
							// so where the user can act on it
							showToast('Door clip added. Move its origin onto the hinge edge to swing there.', [
								{ label: 'Set origin', action: () => openSceneSection('Transform') }
							]);
						}
					}
				})),
				{ section: 'Clip' },
				{ label: 'New clip', action: () => (selId = null) || createClip(uuid) },
				{
					label: 'Duplicate clip',
					disabled: !authoredClips.length,
					action: () => duplicateClip(uuid, activeClipId ?? '')
				},
				{
					label: 'Rename clip',
					disabled: !authoredClips.length,
					action: () => (renaming = activeClipId)
				},
				{
					label: 'Delete clip',
					danger: true,
					disabled: !authoredClips.length,
					action: () => activeClipId && deleteClip(uuid, activeClipId)
				},
				{ section: 'Export' },
				{
					label: 'Check the GLTF bake',
					disabled: !tracks.length,
					tooltip:
						'Authored clips are sampled into real animation tracks whenever you export GLTF — this reports what this object would carry',
					action: () => {
						const baked = bakeAnimations(target, uuid);
						const names = baked.map((/** @type {any} */ c) => c.name + ' (' + c.duration.toFixed(2) + 's)');
						showToast(
							baked.length
								? 'A GLTF export carries ' + names.join(', ') + ' with this object.'
								: 'This object has no clip that a GLTF export can carry yet.'
						);
					}
				}
			]
		};
	}
	const activeClipId = $derived(authoredClips.find((c) => c.active)?.id ?? null);

	// --- easing (the segment leaving the selected key) ---------------------------
	const SIZE = 132;
	const PAD = 10;
	const INNER = SIZE - 2 * PAD;
	const sx = (/** @type {number} */ x) => PAD + x * INNER;
	const sy = (/** @type {number} */ y) => PAD + (1 - y) * INNER;

	let svgEl = $state(/** @type {any} */ (null));
	let dragIdx = $state(-1); // 0 = P1, 1 = P2
	/** the index of the key whose outgoing segment the curve edits */
	const easeIndex = $derived(selKey && selKeyObj ? selKey[1] : 0);
	function onHandleDown(/** @type {number} */ idx, /** @type {PointerEvent} */ e) {
		if (!target || !selTrack) return;
		dragIdx = idx;
		e.preventDefault();
		beginAnimGesture(target.uuid, 'Easing');
		window.addEventListener('pointermove', onMove);
		window.addEventListener('pointerup', onUp);
	}
	function onMove(/** @type {PointerEvent} */ e) {
		if (dragIdx < 0 || !svgEl || !selTrack || !target) return;
		const r = svgEl.getBoundingClientRect();
		let x = (e.clientX - r.left - PAD) / INNER;
		let y = 1 - (e.clientY - r.top - PAD) / INNER;
		x = Math.min(1, Math.max(0, x));
		y = Math.min(1, Math.max(0, y));
		const b = [...segEase];
		if (dragIdx === 0) { b[0] = x; b[1] = y; } else { b[2] = x; b[3] = y; }
		updateKey(target.uuid, selTrack.id, easeIndex, { ease: b });
	}
	function onUp() {
		dragIdx = -1;
		endAnimGesture();
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
	}
	function applyEasing(/** @type {string} */ name) {
		if (!selTrack || !target) return;
		updateKey(target.uuid, selTrack.id, easeIndex, { ease: [...EASINGS[name]] });
	}

	// resize: docked = shared top-edge dock height; floating = corner grip
	const clampH = (/** @type {number} */ h) => Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(/** @type {any} */ e) { resizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); }
	function doResize(/** @type {any} */ e) { if (resizing) dockHeight.update((h) => clampH(h - e.movementY)); }
	function endResize(/** @type {any} */ e) { if (resizing) { resizing = false; e.currentTarget.releasePointerCapture?.(e.pointerId); } }
	function startWinResize(/** @type {any} */ e) { winResizing = true; e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault(); e.stopPropagation(); }
	function doWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		winW = Math.min(Math.max(360, baseW + e.movementX), window.innerWidth - 8);
		winH = Math.min(Math.max(260, baseH + e.movementY), window.innerHeight);
		resizeGroup('animation', winW, winH); // if grouped, resize the whole group
	}
	function endWinResize(/** @type {any} */ e) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		localStorage.setItem('animationWinW', String(winW));
		localStorage.setItem('animationWinH', String(winH));
	}
</script>

{#snippet body()}
	{#if !target}
		<div class="flex flex-1 items-center justify-center p-6 text-center text-sm text-gray-400">
			Select an object in the viewport to see and edit its animation.
		</div>
	{:else}
		<!-- TRANSPORT. Grouped like a player: the deck (rewind / play / stop) sits in
		     one segmented control, the playhead owns the whole middle with a monospaced
		     readout beside it, and the clip settings are a second group on the right so
		     "how long is this clip" never reads as part of "where am I in it". -->
		<div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-gray-700/60 px-2 py-1.5">
			<div class="flex items-center overflow-hidden rounded-md border border-gray-600/80 bg-gray-900/60 text-gray-300 [&>button]:px-1.5 [&>button]:py-1 [&>button:hover]:bg-gray-700/70">
				<button
					id="animation-rewind"
					title="Go to the start of the clip"
					aria-label="Go to start"
					onclick={() => target && scrub(target.uuid, rangeIn)}><SkipBack size={14} /></button
				>
				<button
					id="animation-prev-key"
					title="Previous key"
					aria-label="Previous key"
					onclick={() => stepKey(-1)}><StepBack size={14} /></button
				>
				<button
					id="animation-play-back"
					class="border-l border-gray-600/80 {isPlaying && pb?.reverse ? 'bg-primary-600/30 text-primary-200' : 'text-primary-300'}"
					title="Play backwards from here"
					aria-label="Play backwards"
					aria-pressed={!!(isPlaying && pb?.reverse)}
					onclick={playBack}><Rewind size={14} /></button
				>
				<button
					id="animation-play"
					class="border-x border-gray-600/80 {isPlaying && !pb?.reverse
						? 'bg-primary-600/30 text-primary-200'
						: 'text-primary-300'}"
					title={isPlaying ? 'Pause' : 'Play from here'}
					aria-label={isPlaying ? 'Pause' : 'Play'}
					aria-pressed={isPlaying}
					onclick={togglePlay}
				>
					{#if isPlaying}<Pause size={14} />{:else}<Play size={14} />{/if}
				</button>
				<button
					id="animation-stop"
					title="Stop and go back to the frame this run started from"
					aria-label="Stop"
					onclick={() => target && stop(target.uuid)}><Square size={13} /></button
				>
				<button
					id="animation-next-key"
					class="border-l border-gray-600/80"
					title="Next key"
					aria-label="Next key"
					onclick={() => stepKey(1)}><StepForward size={14} /></button
				>
				<button
					id="animation-end"
					title="Go to the end of the clip"
					aria-label="Go to end"
					onclick={() => target && scrub(target.uuid, rangeOut)}><SkipForward size={14} /></button
				>
			</div>

			<div class="flex min-w-40 flex-1 items-center gap-2">
				<input
					type="range" min="0" max={duration} step="0.01"
					class="min-w-0 flex-1 accent-primary-500"
					aria-label="Playhead"
					value={curTime} oninput={(e) => target && scrub(target.uuid, parseFloat(e.currentTarget.value))}
				/>
				<span class="shrink-0 font-mono text-[11px] tabular-nums text-gray-300">
					{curTime.toFixed(2)}<span class="text-gray-500">/{duration.toFixed(2)}s</span>
				</span>
			</div>

			<div class="flex items-center gap-1.5">
				<label class="flex items-center gap-1 text-[11px] text-gray-400" title="Clip length. Keys keep their times — use ＋ ▸ Retime to stretch the movement itself.">
					<span>length</span>
					<input
						type="number" min="0.1" step="0.1"
						class="w-14 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-right text-xs tabular-nums"
						value={duration}
						oninput={(e) => target && updateAnim(target.uuid, { duration: Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1) })}
					/>
				</label>
				<label class="flex items-center gap-1 text-[11px] text-gray-400" title="Playback rate — how fast it runs, without changing any keys">
					<span>speed</span>
					<input
						id="animation-speed"
						type="number" min="0.1" max="8" step="0.1"
						class="w-14 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-right text-xs tabular-nums"
						value={speed}
						oninput={(e) => target && setSpeed(target.uuid, parseFloat(e.currentTarget.value) || 1)}
					/>
				</label>
				<select
					class="rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-xs"
					aria-label="Loop mode"
					value={anim?.loop ?? 'loop'}
					onchange={(e) => target && updateAnim(target.uuid, { loop: /** @type {any} */ (e.currentTarget.value) })}
				>
					<option value="loop">Loop</option>
					<option value="once">Once</option>
					<option value="pingpong">Ping-pong</option>
				</select>
			</div>

			<div class="flex items-center gap-1.5">
				<button
					id="animation-autokey"
					class="flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium {recording
						? 'border-red-500 bg-red-500/20 text-red-300'
						: 'border-gray-600 text-gray-400 hover:bg-gray-700/70'}"
					title={recording
						? 'Recording: posing this object writes keys at the playhead'
						: 'Auto-key: pose the object and keys are written at the playhead'}
					aria-label="Auto-key"
					aria-pressed={recording}
					onclick={() => target && setAutoKey(recording ? null : target.uuid)}
				>
					<span class={recording ? 'animate-pulse' : ''}>●</span> REC
				</button>
				<button
					id="animation-add"
					class="shrink-0 rounded-md border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:bg-gray-700/70"
					title="Add movements, keys, presets and clips"
					aria-label="Add"
					onclick={openAddMenu}>＋</button
				>
			</div>
		</div>

		<div class="flex min-h-0 flex-1">
			<!-- LEFT: the object's OWN clips, then authored clips + movement tracks -->
			<div class="flex w-56 shrink-0 flex-col border-r border-gray-700/60">
				{#if clips.length}
					<div id="animation-clips" class="border-b border-gray-700/60">
						<div class="flex items-center justify-between px-2 pt-1.5">
							<span class="text-[10px] uppercase tracking-wider text-gray-500">Imported clips</span>
							<span class="text-[10px] text-gray-500">{clips.length}</span>
						</div>
						<div class="max-h-24 overflow-y-auto p-1">
							{#each clips as clip (clip.name)}
								<button
									class="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-gray-700/60 {clipState?.clip === clip.name ? 'bg-primary-900/40 text-primary-200' : 'text-gray-300'}"
									title="Play this clip — on every peer"
									onclick={() => target && setAnimationState(target.uuid, { clip: clip.name, playing: true })}
								>
									<span class="min-w-0 truncate">{clip.name}</span>
									<span class="shrink-0 text-[10px] tabular-nums text-gray-500">{clip.duration.toFixed(2)}s</span>
								</button>
							{/each}
						</div>
						<div class="flex items-center gap-2 px-2 pb-1">
							<button
								id="clip-play"
								class="ui-button-quiet text-primary-400"
								title={clipState?.playing ? 'Pause the clip' : 'Play the clip'}
								onclick={() => target && setAnimationState(target.uuid, { playing: !clipState?.playing })}
							>
								{clipState?.playing ? '⏸' : '▶'}
							</button>
							<input
								type="range" min="0.1" max="3" step="0.1"
								class="min-w-0 flex-1 accent-primary-600"
								aria-label="Clip speed"
								value={clipState?.speed ?? 1}
								oninput={(e) => target && setAnimationState(target.uuid, { speed: parseFloat(e.currentTarget.value) })}
							/>
							<span class="shrink-0 text-[10px] tabular-nums text-gray-400">{(clipState?.speed ?? 1).toFixed(1)}×</span>
						</div>
					</div>
				{/if}

				<!-- authored clips -->
				{#if authoredClips.length}
					<div id="authored-clips" class="border-b border-gray-700/60">
						<div class="flex items-center justify-between px-2 pt-1.5">
							<span class="text-[10px] uppercase tracking-wider text-gray-500">Clips</span>
							<span class="text-[10px] text-gray-500">{authoredClips.length}</span>
						</div>
						<div class="overflow-y-auto p-1" style="max-height: {clipsH}px">
							{#each authoredClips as clip (clip.id)}
								{#if renaming === clip.id}
									<!-- svelte-ignore a11y_autofocus -->
									<input
										class="w-full rounded-sm border border-primary-500 bg-gray-900 px-1 py-0.5 text-xs text-gray-100"
										autofocus
										value={clip.name}
										aria-label="Clip name"
										onblur={(e) => { if (target) renameClip(target.uuid, clip.id, e.currentTarget.value); renaming = null; }}
										onkeydown={(e) => {
											if (e.key === 'Enter') e.currentTarget.blur();
											else if (e.key === 'Escape') renaming = null;
										}}
									/>
								{:else}
									<button
										class="flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-gray-700/60 {clip.active ? 'bg-primary-900/40 text-primary-200' : 'text-gray-300'}"
										title="Edit this clip (and make it the object's default)"
										onclick={() => { if (target) { setActiveClip(target.uuid, clip.id); selId = null; selKeys = []; } }}
										ondblclick={() => (renaming = clip.id)}
									>
										<span class="min-w-0 truncate">{clip.name}</span>
										<span class="shrink-0 text-[10px] tabular-nums text-gray-500">{clip.tracks}▪{clip.duration.toFixed(1)}s</span>
									</button>
								{/if}
							{/each}
						</div>
						<!-- drag to give the clip list more (or less) room -->
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							id="animation-clips-resize"
							class="group h-1.5 cursor-ns-resize border-t border-gray-700/60 bg-gray-800/40 hover:bg-primary-700/40"
							style="touch-action: none"
							title="Drag to resize the clip list"
							onpointerdown={startClipsResize}
							onpointermove={doClipsResize}
							onpointerup={endClipsResize}
						></div>
					</div>
				{/if}

				<div class="flex items-center justify-between px-2 pt-1.5">
					<span class="text-[10px] uppercase tracking-wider text-gray-500">Channels</span>
					<span class="text-[10px] text-gray-500">{tracks.length}</span>
				</div>
				<div class="flex items-center gap-1 border-b border-gray-700/60 p-1.5">
					<select class="min-w-0 flex-1 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-xs" aria-label="Channel to animate" value={newChannel} onchange={(e) => (newChannel = e.currentTarget.value)}>
						{#each addableChannels as c}<option value={c}>{channelLabel(c)}</option>{/each}
					</select>
					<button class="ui-button-quiet shrink-0" title="Animate this channel" aria-label="Add channel" onclick={add}>＋</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto">
					{#if !tracks.length}
						<div class="p-3 text-center text-[11px] text-gray-500">
							{clips.length
								? 'This clip is empty. The model’s own clips are listed above.'
								: 'Nothing animated yet. Pick a channel and add it, or use ＋ ▸ Presets.'}
						</div>
					{/if}
					{#each tracks as t (t.id)}
						<div class="flex items-center gap-1 {selTrack?.id === t.id ? 'bg-primary-900/40' : ''}">
							<button
								class="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs hover:bg-gray-700/60 {selTrack?.id === t.id ? 'text-primary-200' : 'text-gray-300'}"
								title={isMaterialChannel(t.channel) ? channelLabel(t.channel) + ' — a look channel: it drives the material, so a GLTF export cannot carry it' : channelLabel(t.channel)}
								onclick={() => { selId = t.id; selKeys = []; }}>{channelLabel(t.channel)}</button
							>
							<span class="shrink-0 text-[10px] tabular-nums text-gray-500">{t.keys.length}</span>
							<button class="ui-button-quiet shrink-0 text-red-400" title="Remove" aria-label="Remove channel" onclick={() => { if (target) removeTrack(target.uuid, t.id); }}>✕</button>
						</div>
					{/each}
				</div>
			</div>

			<!-- CENTRE: the timeline (dope sheet / value graph) -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="flex min-w-0 flex-1 flex-col" tabindex="-1" bind:this={plotHost} use:keyNav>
				<div class="flex shrink-0 items-center gap-2 border-b border-gray-700/60 px-2 py-1 text-[11px] text-gray-400">
					<button
						class="rounded-sm border px-1.5 py-0.5 {view === 'sheet' ? 'border-primary-500 text-primary-300' : 'border-gray-600'}"
						onclick={() => (view = 'sheet')}>Sheet</button
					>
					<button
						class="rounded-sm border px-1.5 py-0.5 {view === 'graph' ? 'border-primary-500 text-primary-300' : 'border-gray-600'}"
						onclick={() => (view = 'graph')}>Graph</button
					>
				<!-- 1 / 2 arm the transform, the way the digits pick a tool in the mesh
					     editor; they drive both the drag and Shift+arrows -->
					<div class="flex items-center overflow-hidden rounded-sm border border-gray-600">
						<button
							id="animation-mode-move"
							class="px-1.5 py-0.5 {xform === 'move' ? 'bg-primary-600/30 text-primary-200' : 'hover:bg-gray-700/70'}"
							title="Move keys (1)"
							aria-pressed={xform === 'move'}
							onclick={() => (xform = 'move')}>Move</button
						>
						<button
							id="animation-mode-scale"
							class="border-l border-gray-600 px-1.5 py-0.5 {xform === 'scale' ? 'bg-primary-600/30 text-primary-200' : 'hover:bg-gray-700/70'}"
							title="Scale keys about the playhead (2)"
							aria-pressed={xform === 'scale'}
							onclick={() => (xform = 'scale')}>Scale</button
						>
					</div>
					<label class="flex items-center gap-1" title="What key times snap to while you drag">
						snap
						<select
							id="animation-snap"
							class="rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-[11px]"
							value={snapMode}
							onchange={(e) => {
								snapMode = e.currentTarget.value;
								localStorage.setItem('animationSnap', snapMode);
							}}
						>
							<option value="off">off</option>
							<option value="frame">frame ({FPS}fps)</option>
							<option value="0.1">0.1s</option>
							<option value="0.5">0.5s</option>
						</select>
					</label>

					<!-- A/B: loop the seconds you are tuning. It rides the transport, so a
					     peer watching sees the same window. -->
					<div class="flex items-center gap-1">
						<button
							id="animation-mark-in"
							class="rounded-sm border border-gray-600 px-1.5 py-0.5 hover:bg-gray-700/70"
							title="Set the loop START here (A)"
							onclick={() => target && setRange(target.uuid, curTime, rangeOut > curTime ? rangeOut : null)}
							>A</button
						>
						<button
							id="animation-mark-out"
							class="rounded-sm border border-gray-600 px-1.5 py-0.5 hover:bg-gray-700/70"
							title="Set the loop END here (B)"
							onclick={() => target && setRange(target.uuid, rangeIn < curTime ? rangeIn : null, curTime)}
							>B</button
						>
						{#if ranged}
							<button
								id="animation-clear-range"
								class="rounded-sm border border-primary-600 px-1.5 py-0.5 text-primary-300 hover:bg-gray-700/70"
								title="Play the whole clip again ({rangeIn.toFixed(2)}–{rangeOut.toFixed(2)}s now)"
								onclick={() => target && setRange(target.uuid, null, null)}
								>A/B ✕</button
							>
						{/if}
					</div>

					<span
						class="cursor-help text-gray-500"
						title="Double-click empty space adds a key · drag moves it · shift-click builds a selection · RIGHT-CLICK locks the selection to the pointer (click to place, Esc to cancel) · Del removes · ctrl+wheel zooms, wheel pans"
						>?</span
					>
					<div class="flex items-center gap-0.5">
						<button class="rounded-sm border border-gray-600 p-0.5 hover:bg-gray-700/70" title="Zoom out" aria-label="Zoom out" onclick={() => zoomView(1.4)}><ZoomOut size={12} /></button>
						<button class="rounded-sm border border-gray-600 p-0.5 hover:bg-gray-700/70" title="Zoom in" aria-label="Zoom in" onclick={() => zoomView(1 / 1.4)}><ZoomIn size={12} /></button>
						<button id="animation-fit" class="rounded-sm border border-gray-600 p-0.5 hover:bg-gray-700/70" title="Fit the whole clip" aria-label="Fit" onclick={fitView}><Maximize2 size={12} /></button>
					</div>
					<span class="flex-1"></span>
					{#if grabbing}
						<span class="shrink-0 rounded-sm bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
							moving {selKeys.length > 1 ? selKeys.length + ' keys' : 'key'} — click to place, Esc to cancel
						</span>
					{:else if selKeys.length > 1}
						<span class="shrink-0 text-[10px] text-primary-300">{selKeys.length} keys selected</span>
					{/if}
					<span class="truncate font-mono text-[10px] text-gray-500">
						{viewStart.toFixed(2)}–{viewEnd.toFixed(2)}s
					</span>
				</div>
				<!-- NAVIGATOR: the whole clip at a glance with the visible window as a
				     thumb, so a zoomed-in view still shows where it sits and can be
				     dragged along. A native scrollbar cannot do this job — the plot is
				     one screen wide by construction, the zoom is a view WINDOW rather
				     than a wider canvas. -->
				{#if tracks.length}
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						id="animation-navigator"
						class="relative mx-2 mt-1.5 mb-1 h-3 shrink-0 cursor-pointer rounded-full bg-gray-900/70"
						style="touch-action: none"
						title="The whole clip — drag the bar to move the visible window"
						onpointerdown={navDown}
					>
					<!-- keyed by INDEX, never by time: two keys legitimately share a time
						     while a multi-selection is dragged through one another, and a
						     duplicate each-key is a THROW in svelte, which took the whole
						     window down — the pane stopped opening at all -->
						{#each tracks as track (track.id)}
							{#each track.keys as key, ki (ki)}
								<span
									class="pointer-events-none absolute top-1/2 h-1 w-px -translate-y-1/2 bg-gray-500/70"
									style="left: {(key.t / Math.max(duration, 0.001)) * 100}%"
								></span>
							{/each}
						{/each}
						<span
							class="pointer-events-none absolute inset-y-0 rounded-full border border-primary-500/70 bg-primary-500/25"
							style="left: {(viewStart / Math.max(duration, 0.001)) * 100}%; width: {Math.max(
								2,
								(viewSpan / Math.max(duration, 0.001)) * 100
							)}%"
						></span>
						<span
							class="pointer-events-none absolute inset-y-0 w-px bg-amber-400"
							style="left: {(Math.min(curTime, duration) / Math.max(duration, 0.001)) * 100}%"
						></span>
					</div>
				{/if}
				<div
					class="min-h-0 flex-1 overflow-x-hidden {view === 'graph' ? 'overflow-y-hidden' : 'overflow-y-auto'} p-2"
					bind:clientWidth={plotW}
					bind:clientHeight={plotVH}
				>
					{#if !tracks.length}
						<div class="flex h-full items-center justify-center text-center text-sm text-gray-500">
							Add a movement to build a timeline.
						</div>
					{:else}
						<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
						<svg
							bind:this={plotEl}
							id="animation-timeline"
							width={plotAvail}
							height={plotH}
							class="touch-none select-none rounded-sm bg-gray-900/60"
							role="application"
							aria-label="Timeline"
							ondblclick={plotDblClick}
							onpointerdown={plotDown}
							onwheel={onPlotWheel}
							oncontextmenu={(e) => e.preventDefault()}
						>
							<!-- ruler: drag anywhere along it to sweep the playhead -->
							<rect
								x="0" y="0" width={plotAvail} height={RULER_H}
								fill="rgb(31 41 55 / 0.8)" class="cursor-ew-resize"
							/>
							{#each ticks as t (t)}
								<line x1={tx(t)} y1={0} x2={tx(t)} y2={plotH} stroke="rgb(75 85 99 / 0.35)" pointer-events="none" />
								<text x={tx(t) + 2} y={11} font-size="9" fill="rgb(107 114 128)" pointer-events="none">{t}s</text>
							{/each}

							<!-- everything outside the A/B window is dimmed, the way a video
							     editor shades the part it will not play -->
							{#if ranged}
								{#if rangeIn > viewStart}
									<rect x={tx(viewStart)} y={RULER_H} width={Math.max(0, tx(Math.min(rangeIn, viewEnd)) - tx(viewStart))} height={plotH - RULER_H} fill="rgb(17 24 39 / 0.55)" pointer-events="none" />
								{/if}
								{#if rangeOut < viewEnd}
									<rect x={tx(Math.max(rangeOut, viewStart))} y={RULER_H} width={Math.max(0, tx(viewEnd) - tx(Math.max(rangeOut, viewStart)))} height={plotH - RULER_H} fill="rgb(17 24 39 / 0.55)" pointer-events="none" />
								{/if}
								<line x1={tx(rangeIn)} y1={0} x2={tx(rangeIn)} y2={plotH} stroke="rgb(34 197 94 / 0.9)" stroke-width="1.5" pointer-events="none" />
								<line x1={tx(rangeOut)} y1={0} x2={tx(rangeOut)} y2={plotH} stroke="rgb(239 68 68 / 0.9)" stroke-width="1.5" pointer-events="none" />
								<text x={tx(rangeIn) + 2} y={RULER_H + 9} font-size="8" fill="rgb(34 197 94)" pointer-events="none">A</text>
								<text x={tx(rangeOut) - 8} y={RULER_H + 9} font-size="8" fill="rgb(239 68 68)" pointer-events="none">B</text>
							{/if}

							{#if view === 'sheet'}
								{#each tracks as track, row (track.id)}
									<line
										x1={tx(viewStart)} y1={rowY(row)} x2={tx(viewEnd)} y2={rowY(row)}
										stroke={selTrack?.id === track.id ? 'rgb(129 140 248 / 0.5)' : 'rgb(75 85 99 / 0.5)'}
									/>
									{#each track.keys as key, index (index)}
										<rect
											x={tx(key.t) - 4} y={rowY(row) - 4} width="8" height="8"
											transform="rotate(45 {tx(key.t)} {rowY(row)})"
											class="cursor-ew-resize"
											fill={isKeySelected(track.id, index) ? 'rgb(250 204 21)' : 'rgb(99 102 241)'}
											stroke="rgb(17 24 39)"
											onpointerdown={(e) => keyDown(e, track.id, index)}
											oncontextmenu={(e) => keyContext(e, track.id, index)}
										/>
									{/each}
								{/each}
							{:else if selTrack}
								<path d={curve} fill="none" stroke="rgb(129 140 248)" stroke-width="2" />
								{#each selTrack.keys as key, index (index)}
									<circle
										cx={tx(key.t)} cy={vy(key.v)} r="5"
										class="cursor-move"
										fill={isKeySelected(selTrack.id, index) ? 'rgb(250 204 21)' : 'rgb(99 102 241)'}
										stroke="rgb(17 24 39)"
										onpointerdown={(e) => keyDown(e, selTrack.id, index)}
										oncontextmenu={(e) => keyContext(e, selTrack.id, index)}
									/>
								{/each}
								<text x={PAD_X} y={RULER_H + 10} font-size="9" fill="rgb(107 114 128)">
									{dispVal(range.hi, selTrack.channel)}
								</text>
								<text x={PAD_X} y={RULER_H + GRAPH_H - 2} font-size="9" fill="rgb(107 114 128)">
									{dispVal(range.lo, selTrack.channel)}
								</text>
							{/if}

							<!-- playhead -->
							<line
								x1={tx(Math.min(curTime, duration))} y1={0}
								x2={tx(Math.min(curTime, duration))} y2={plotH}
							stroke="rgb(250 204 21 / 0.9)" stroke-width="1.5"
							/>
						</svg>
					{/if}
				</div>

			</div>

			<!-- RIGHT: selected key + the easing that leaves it -->
			<div class="w-52 shrink-0 overflow-y-auto border-l border-gray-700/60 p-2">
				{#if selTrack}
					<div class="ui-section-label">Movement</div>
					<label class="mb-2 block text-[11px] text-gray-400">
						Channel
						<select
							class="mt-0.5 w-full rounded-sm border border-gray-600 bg-gray-900 px-1 py-1 text-xs text-gray-200"
							value={selTrack.channel}
							onchange={(e) => target && updateTrack(target.uuid, selTrack.id, { channel: e.currentTarget.value })}
						>
							{#each CHANNELS as c}<option value={c}>{channelLabel(c)}</option>{/each}
						</select>
					</label>

					{#if selKeyObj && selKey}
						<div class="ui-section-label">Key {selKey[1] + 1} / {selTrack.keys.length}</div>
						<div class="mb-2 grid grid-cols-2 gap-2">
							<label class="text-[11px] text-gray-400">
								Time (s)
								<input
									type="number" step="0.05" min="0"
									class="mt-0.5 w-full rounded-sm border border-gray-600 bg-gray-900 px-1 py-1 text-xs"
									value={Math.round(selKeyObj.t * 1000) / 1000}
									oninput={(e) => selKey && setKeyTime(selKey[1], e.currentTarget.value)}
								/>
							</label>
							<label class="text-[11px] text-gray-400">
								Value{isRot(selTrack.channel) ? ' (deg)' : ''}
								<input
									type="number" step="0.1"
									class="mt-0.5 w-full rounded-sm border border-gray-600 bg-gray-900 px-1 py-1 text-xs"
									value={dispVal(selKeyObj.v, selTrack.channel)}
									oninput={(e) => selKey && setKeyVal(selKey[1], e.currentTarget.value)}
								/>
							</label>
						</div>
						<button
							class="mb-2 w-full rounded-sm border border-gray-600 px-1.5 py-0.5 text-[11px] text-gray-300 hover:bg-gray-700"
							onclick={() => { if (target && selKey) { removeKey(target.uuid, selKey[0], selKey[1]); selKeys = []; } }}
						>Remove key</button>
					{:else}
						<div class="mb-2 text-[11px] text-gray-500">
							{selTrack.keys.length} keys — click one to edit its time and value.
						</div>
					{/if}

					{#if !STEPPED.has(selTrack.channel)}
						<div class="ui-section-label">
							Easing out of key {selKey ? selKey[1] + 1 : 1}
						</div>
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<svg bind:this={svgEl} width={SIZE} height={SIZE} viewBox="0 0 {SIZE} {SIZE}" class="touch-none rounded-sm bg-gray-900/60">
							<rect x={PAD} y={PAD} width={INNER} height={INNER} fill="none" stroke="rgb(75 85 99 / 0.6)" />
							<line x1={sx(0)} y1={sy(0)} x2={sx(1)} y2={sy(1)} stroke="rgb(75 85 99 / 0.35)" stroke-dasharray="3 3" />
							<line x1={sx(0)} y1={sy(0)} x2={sx(segEase[0])} y2={sy(segEase[1])} stroke="rgb(129 140 248 / 0.5)" />
							<line x1={sx(1)} y1={sy(1)} x2={sx(segEase[2])} y2={sy(segEase[3])} stroke="rgb(129 140 248 / 0.5)" />
							<path
								d="M {sx(0)} {sy(0)} C {sx(segEase[0])} {sy(segEase[1])} {sx(segEase[2])} {sy(segEase[3])} {sx(1)} {sy(1)}"
								fill="none" stroke="rgb(129 140 248)" stroke-width="2"
							/>
							<circle cx={sx(0)} cy={sy(0)} r="3" fill="rgb(148 163 184)" />
							<circle cx={sx(1)} cy={sy(1)} r="3" fill="rgb(148 163 184)" />
							<circle class="cursor-grab" cx={sx(segEase[0])} cy={sy(segEase[1])} r="6" fill="rgb(99 102 241)" onpointerdown={(e) => onHandleDown(0, e)} />
							<circle class="cursor-grab" cx={sx(segEase[2])} cy={sy(segEase[3])} r="6" fill="rgb(99 102 241)" onpointerdown={(e) => onHandleDown(1, e)} />
						</svg>
						<div class="mt-1 flex flex-wrap gap-1">
							{#each Object.keys(EASINGS) as name}
								<button class="rounded-sm border border-gray-600 px-1.5 py-0.5 text-[10px] text-gray-300 hover:bg-gray-700" onclick={() => applyEasing(name)}>{name}</button>
							{/each}
						</div>
					{:else}
						<div class="text-[11px] text-gray-500">
							{channelLabel(selTrack.channel)} is stepped: it holds each key's value until the next
							one, so there is no curve to shape.
						</div>
					{/if}
				{:else}
					<div class="text-[11px] text-gray-500">Select a movement on the left.</div>
				{/if}
			</div>
		</div>
	{/if}
{/snippet}

{#if !$animationClose}
	{#if docked}
		<div
			id="animation-dock"
			class="fixed inset-x-0 bottom-0 flex flex-col bg-white p-2 text-gray-800 dark:bg-gray-800 dark:text-gray-200 {dockVisible ? '' : 'hidden'}"
			style="z-index: var(--z-bottom); height: {$dockHeight}px; border-top: 1px solid rgb(55 65 81 / 0.6)"
		>
			<div
				class="resize-cue absolute -top-1 left-0 right-0 z-10 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<div class="flex shrink-0 items-center gap-2 pb-1">
				<span class="text-xs font-semibold text-gray-200">Animation</span>
				<span class="text-[11px] text-gray-400">{target ? target.name || 'object' : 'no selection'}</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Undock into a floating window" aria-label="Undock" onclick={() => setDocked(false)}>⧉</button>
				<button class="ui-button-quiet" title="Close" aria-label="Close" onclick={() => animationClose.set(true)}>✕</button>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<div
			id="animation-window"
			class="ui-panel fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: 'animation', defaultRect: { left: 200, top: 120 } }}
			use:focusStack
			use:tabbable={{ key: 'animation', title: 'Animation', openStore: animationClose, isOpen: (v) => !v, close: () => animationClose.set(true) }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<div class="ui-panel-header move-handle shrink-0 cursor-move select-none py-1.5">
				<span>Animation</span>
				<span class="text-[11px] font-normal text-gray-400">{target ? target.name || 'object' : 'no selection'}</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Dock to the bottom" onclick={() => setDocked(true)}>⇩ Dock</button>
				<button class="ui-button-quiet" title="Close" aria-label="Close" onclick={() => animationClose.set(true)}>✕</button>
			</div>
			{@render body()}
			<div
				class="resize-cue absolute bottom-0 right-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl bg-gray-500/40"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
			></div>
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="animation" on:close={() => (menu = null)} />
{/if}
