<script lang="ts">
	// 48 S1 — THE TIMELINE: a cutscene sequencer, the 7th FLOW_FAMILY dock tab.
	//
	// A sequence is SCENE DATA (sequences.js: saved, replicated, undoable); this editor is
	// its view. Tracks run left to right: CAMERA shots (look through a camera object, or
	// glide between two), ANIMATION clips on objects, AUDIO from the Explorer, and EVENTS
	// that pulse the graph's On Sequence Event nodes. The scene plays one with the Play
	// Sequence node or the sequence's own "Autoplay" (starts as each player enters Play).
	//
	// The shell (dock / floating window / phone sheet, resize, layouts) is HudEditor's
	// verbatim; on a phone the dock is the bottom sheet, so no phone branch lives here —
	// only CSS for the narrower header column and bigger rows.
	//
	// Editing: click selects (Shift adds), drag moves (snapping to item edges, the
	// playhead and the frame grid; Alt frees it), the right edge resizes, double-click an
	// empty lane adds an item there. One undo step per drag (beginSequenceGesture).
	// Keys (on the editor): Space play/pause, ←/→ nudge the selection a frame (Shift ×10)
	// or step the playhead, Home/End, K adds on the selected track at the playhead,
	// Delete removes, Esc cancels a drag or clears the selection, Ctrl+A selects all.
	// Wheel zooms, Shift+wheel pans. The ruler scrubs.
	//
	// uir-timeline — THREE PANES on WindowShell: the SEQUENCES list on the left (pick, new, rename,
	// duplicate, delete), the tracks in the middle, PROPERTIES on the right with two tabs: Sequence
	// (name, length, frame rate, autoplay, loop) and Item (the selected item's fields, the old bottom
	// inspector). Picking one item opens the Item tab for a moment (WindowShell's showSecondary); a
	// tab the user pressed stays. The ids the suites and docs know (#timeline-inspector,
	// #timeline-duration, #timeline-autoplay, #timeline-item-*) moved with their fields.
	import { untrack } from 'svelte';
	import { get } from 'svelte/store';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import EmptyState from '../ui/EmptyState.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import DockTabs from '../DockTabs.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	// uir-timeline (owner 2026-11-09): Sequences on the left, Properties (Sequence | Item) on the right — the
	// shared side-pane chrome every tabbed window uses (showhide-v8 turns its edges into the one arrow pattern)
	import WindowShell from '../shared/WindowShell.svelte';
	import { phoneShell } from '$lib/ui/phoneShell.js';
	import { timelineClose, showToast } from '../../stores/appStore.js';
	import { objectsGroup, selectedObjects } from '../../stores/sceneStore';
	import { onLayoutRestore, storedPanelLayout } from '$lib/uiLayoutsCore';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable, resizeGroup, tabGroups } from '$lib/windowTabs';
	import { clampWinSize, clampResize, anchorOf } from '$lib/windowSize';
	import {
		setDockOccupant,
		dockHeight,
		dockShownKeys,
		dockPaneOf,
		activateDock,
		dockModeArm,
		forgetDockTab
	} from '$lib/bottomDock';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { safeStorage } from '$lib/safeStorage';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import {
		sequences,
		activeSequence,
		sequenceSelection,
		createSequence,
		renameSequence,
		deleteSequence,
		duplicateSequence,
		updateSequence,
		addTrack,
		updateTrack,
		removeTrack,
		moveTrack,
		addItem,
		updateItem,
		placeItems,
		removeItems,
		findItem
	} from '$lib/sequences';
	import {
		beginSequenceGesture,
		endSequenceGesture,
		cancelSequenceGesture
	} from '$lib/sequenceSync';
	import {
		seqTransport,
		seqFlash,
		previewShots,
		playSequence,
		stopSequence,
		stopAllSequences,
		scrubSequence,
		releaseScrub
	} from '$lib/sequencePlayer';
	import {
		ADDABLE_KINDS,
		TRACK_LABELS,
		isTrackKind,
		formatTime,
		rulerTicks,
		snapTime,
		snapTargets,
		contentEnd,
		MIN_ITEM,
		clamp
	} from '$lib/sequenceCore';
	import { listCameraObjects } from '$lib/cameraObjects';
	import { timelineFocus } from '$lib/timelineOpen';
	import { propDef } from '$lib/propTracks';
	import { smoothKeys } from '$lib/curveCore';
	import { animations, clipList } from '$lib/animationPreview';
	import { animatedObjects, clipInfo } from '$lib/animatedImports';
	import { explorerItems } from '$lib/explorer';
	import { sendAsset } from '$lib/assetShare';

	const KEY = 'timeline';
	const KIND_ICON: Record<string, string> = {
		camera: 'camera',
		anim: 'clapperboard',
		audio: 'volume-2',
		event: 'zap',
		prop: 'sliders-horizontal' // 68: a property track (keys of one value: a recorded take, FOV, focus…)
	};
	const KIND_COLOR: Record<string, string> = {
		camera: 'var(--icon-object)',
		anim: 'var(--accent)',
		audio: 'var(--icon-audio)',
		event: 'var(--ink-warn)',
		prop: 'var(--accent)'
	};
	/** 68-int: what a track head and lane say about a track kind this version does not know (a newer one) */
	const NEWER_NOTE = 'Made with a newer version of the app: kept and shared, but this version cannot play or edit it';
	/** 68-int: a property track's name for people — its target's name + the property */
	function propTrackLabel(track: any) {
		const what = propDef(track.path)?.label ?? track.path;
		return track.name && track.name !== TRACK_LABELS.prop ? track.name : what;
	}
	/** 68-int (V6): smooth a property track's keys (handheld shake out, key times kept): one undo step */
	function smoothTrack(track: any) {
		if (!seqId || track.kind !== 'prop' || !Array.isArray(track.keys) || track.keys.length < 3) return;
		updateTrack(seqId, track.id, { keys: smoothKeys(track.type, track.keys, 0.4) });
		showToast('Smoothed ' + propTrackLabel(track) + ' (' + track.keys.length + ' keys, times kept)');
	}

	// ---- shell: docked vs floating (HudEditor's verbatim) ------------------------------
	// 70 W2: `popped` = this instance lives in a pop-out window ($lib/windows/panelHost mounts it there)
	let { popped = false } = $props();
	let docked = $state(true);
	const WIN_MIN = { minW: 420, minH: 260 };
	const WIN_DEFAULT = { w: 760, h: 380 };
	let winW = $state(760);
	let winH = $state(380);
	if (typeof localStorage !== 'undefined') {
		docked = safeStorage.getItem('timelineDocked') !== 'false';
		const saved = clampWinSize(
			parseInt(safeStorage.getItem('timelineWinW') ?? '760') || 760,
			parseInt(safeStorage.getItem('timelineWinH') ?? '380') || 380,
			WIN_MIN
		);
		winW = saved.w;
		winH = saved.h;
	}
	// 70 W2: a popped-out instance renders its floating layout inside its window, never docked
	// svelte-ignore state_referenced_locally
	if (popped) docked = false;
	$effect(() =>
		popped ? undefined : onLayoutRestore(() => {
			const stored = storedPanelLayout(safeStorage.getItem, KEY, 760, 380);
			docked = !!stored.docked;
			const fit = clampWinSize(stored.w, stored.h, WIN_MIN);
			winW = fit.w;
			winH = fit.h;
		})
	);
	function setDocked(v: boolean) {
		docked = v;
		safeStorage.setItem('timelineDocked', String(v));
		if (v) activateDock(KEY);
		else forgetDockTab(KEY);
	}
	$effect(() => {
		if (popped) return; // 70 W2: the main window's instance answers the arm
		const arm = $dockModeArm as any;
		if (!arm || arm.key !== KEY) return;
		dockModeArm.set(null);
		untrack(() => {
			if (arm.docked !== docked) setDocked(arm.docked);
			timelineClose.set(false);
		});
	});
	const myGroup = $derived(($tabGroups as any[]).find((g) => g.members.includes(KEY)) ?? null);
	const effW = $derived(myGroup ? myGroup.rect.width : winW);
	const effH = $derived(myGroup ? myGroup.rect.height : winH);
	$effect(() => {
		if (popped) return; // 70 W2: a popped panel is no dock tab
		setDockOccupant(KEY, !$timelineClose && docked, $dockHeight);
		return () => setDockOccupant(KEY, false);
	});
	const dockVisible = $derived(($dockShownKeys as string[]).includes(KEY));

	const clampDockH = (h: number) =>
		Math.min(Math.max(h || 320, 200), Math.round(window.innerHeight * 0.8));
	let resizing = $state(false);
	let winResizing = $state(false);
	function startResize(e: any) {
		resizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	function doResize(e: any) {
		if (resizing) dockHeight.update((h: number) => clampDockH(h - e.movementY));
	}
	function endResize(e: any) {
		if (resizing) {
			resizing = false;
			e.currentTarget.releasePointerCapture?.(e.pointerId);
		}
	}
	function startWinResize(e: any) {
		winResizing = true;
		e.currentTarget.setPointerCapture(e.pointerId);
		e.preventDefault();
		e.stopPropagation();
	}
	function doWinResize(e: any) {
		if (!winResizing) return;
		const baseW = myGroup ? myGroup.rect.width : winW;
		const baseH = myGroup ? myGroup.rect.height : winH;
		const at = anchorOf(e.currentTarget.parentElement);
		const fit = clampResize(baseW + e.movementX, baseH + e.movementY, at.left, at.top, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup(KEY, winW, winH);
	}
	function endWinResize(e: any) {
		if (!winResizing) return;
		winResizing = false;
		e.currentTarget.releasePointerCapture?.(e.pointerId);
		saveWinSize();
	}
	function saveWinSize() {
		safeStorage.setItem('timelineWinW', String(winW));
		safeStorage.setItem('timelineWinH', String(winH));
	}
	function resetWinSize() {
		const fit = clampWinSize(WIN_DEFAULT.w, WIN_DEFAULT.h, WIN_MIN);
		winW = fit.w;
		winH = fit.h;
		resizeGroup(KEY, winW, winH);
		saveWinSize();
	}

	// ---- data -------------------------------------------------------------------------
	const list = $derived(
		Object.values($sequences as Record<string, any>).sort(
			(a: any, b: any) =>
				String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
		)
	);
	const seqId = $derived(
		$activeSequence && ($sequences as any)[$activeSequence as string]
			? ($activeSequence as string)
			: (list[0]?.id ?? null)
	);
	const seq: any = $derived(seqId ? ($sequences as any)[seqId] : null);
	const transport: any = $derived(seqId ? ($seqTransport as any)[seqId] : null);
	const playhead = $derived(clamp(transport?.t ?? 0, 0, seq?.duration ?? 0));
	const playing = $derived(!!transport?.playing && transport?.mode === 'preview');
	const runningGame = $derived(!!transport?.playing && transport?.mode === 'game');
	const selection = $derived($sequenceSelection as string[]);
	const oneSel: any = $derived(seq && selection.length === 1 ? findItem(seq, selection[0]) : null);

	// keep the store pointing at a real sequence (a peer deleted ours, a load replaced them)
	$effect(() => {
		const want = seqId;
		untrack(() => {
			if ((get(activeSequence) ?? null) !== want) activeSequence.set(want);
		});
	});

	// closing the editor gives the view back (a scrub looks through shots + poses clips)
	$effect(() => {
		if (!$timelineClose) return;
		untrack(() => {
			stopAllSequences((run: any) => run.mode === 'preview');
			releaseScrub();
		});
	});

	// ---- view window (zoom / pan) -------------------------------------------------------
	let viewStart = $state(0);
	let viewEnd = $state(10);
	let lanesW = $state(600);
	const span = $derived(Math.max(0.05, viewEnd - viewStart));
	const pps = $derived(Math.max(1e-3, lanesW / span));
	const xOf = (t: number) => (t - viewStart) * pps;
	const tOf = (x: number) => viewStart + x / pps;
	const ticks = $derived(rulerTicks(viewStart, viewEnd, lanesW, 64));
	// seconds on the ruler ("0.5s", "12s", "1:30"); the readout keeps m:ss.ff for frames
	const tickLabel = (t: number) =>
		t >= 60
			? `${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, '0')}`
			: `${Math.round(t * 100) / 100}s`;
	function fitView() {
		if (!seq) return;
		viewStart = 0;
		viewEnd = Math.max(seq.duration, contentEnd(seq), 0.5) * 1.02;
	}
	let fittedFor = '';
	$effect(() => {
		const id = seqId;
		if (id && id !== fittedFor) {
			fittedFor = id;
			untrack(fitView);
		}
	});
	// fix-film: Film's "Edit in timeline" on one shot — show that range, playhead at its start
	$effect(() => {
		const f = $timelineFocus;
		if (!f || !seq || f.seq !== seqId) return;
		untrack(() => {
			fittedFor = f.seq;
			const pad = Math.max(0.2, (f.t1 - f.t0) * 0.08);
			viewStart = Math.max(-pad, f.t0 - pad);
			viewEnd = f.t1 + pad;
			if (f.item) sequenceSelection.set([f.item]);
			scrubTo(f.t0, true);
			timelineFocus.set(null);
		});
	});
	function wheel(node: HTMLElement) {
		const onWheel = (e: WheelEvent) => {
			if (!seq) return;
			e.preventDefault();
			const rect = node.getBoundingClientRect();
			if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
				const d = ((e.shiftKey ? e.deltaY : e.deltaX) / pps) * 0.5;
				const s = Math.max(-span * 0.1, viewStart + d);
				viewEnd = s + span;
				viewStart = s;
				return;
			}
			const at = tOf(e.clientX - rect.left);
			const factor = e.deltaY < 0 ? 1 / 1.15 : 1.15;
			const next = clamp(span * factor, 0.2, Math.max(seq.duration * 4, 10));
			const ratio = (at - viewStart) / span;
			viewStart = at - ratio * next;
			viewEnd = viewStart + next;
		};
		node.addEventListener('wheel', onWheel, { passive: false });
		return { destroy: () => node.removeEventListener('wheel', onWheel) };
	}

	// ---- snapping -----------------------------------------------------------------------
	let snapOn = $state(
		typeof localStorage === 'undefined' ? true : safeStorage.getItem('timelineSnap') !== 'false'
	);
	function setSnap(v: boolean) {
		snapOn = v;
		safeStorage.setItem('timelineSnap', String(v));
	}
	let guide = $state<number | null>(null);

	// ---- names + pickers ----------------------------------------------------------------
	let listTick = $state(0); // bumped when a picker may be stale (objects come and go)
	function objectName(uuid: string) {
		void listTick;
		if (!uuid) return '';
		const obj = ($objectsGroup as any)?.getObjectByProperty?.('uuid', uuid);
		return obj ? obj.name || obj.type || 'object' : 'missing';
	}
	const cameraItems = $derived.by(() => {
		void listTick;
		void $objectsGroup;
		return listCameraObjects().map((o: any) => ({ value: o.uuid, name: o.name || 'Camera' }));
	});
	const animTargets = $derived.by(() => {
		void listTick;
		const ids = new Set([
			...Object.keys($animations as any),
			...Object.keys($animatedObjects as any)
		]);
		return [...ids]
			.map((uuid) => ({ value: uuid, name: objectName(uuid) }))
			.filter((x) => x.name !== 'missing');
	});
	function clipItems(uuid: string) {
		void $animations;
		const names = new Set<string>();
		if (uuid) {
			try {
				for (const c of clipList(uuid) as any[]) names.add(c.name);
			} catch {
				/* no authored set */
			}
			for (const c of clipInfo(uuid)) names.add(c.name);
		}
		return [{ value: '', name: 'default clip' }, ...[...names].map((n) => ({ value: n, name: n }))];
	}
	const audioItems = $derived(($explorerItems as any[]).filter((i) => i.kind === 'audio'));

	function itemLabel(kind: string, item: any) {
		if (kind === 'camera') {
			const a = item.camera ? objectName(item.camera) : 'choose a camera';
			return item.to ? `${a} → ${objectName(item.to)}` : a;
		}
		if (kind === 'anim')
			return item.target
				? `${objectName(item.target)} · ${item.clip || 'default'}`
				: 'choose an object';
		if (kind === 'audio') return item.name || (item.sound ? 'sound' : 'choose a sound');
		return item.name;
	}

	// ---- authoring ----------------------------------------------------------------------
	function newSequence() {
		const id = createSequence();
		sequenceSelection.set([]);
		return id;
	}
	function addTrackOf(kind: string) {
		if (!seqId) return;
		addTrack(seqId, kind);
	}
	function pickedObject() {
		const sel = get(selectedObjects) as any[];
		return sel?.[0]?.uuid ?? null;
	}
	function addItemAt(track: any, t: number) {
		if (!seqId) return null;
		listTick++;
		const at = Math.max(0, t);
		/** @type {any} */
		let item: any = { t: at };
		if (track.kind === 'camera') {
			const cams = listCameraObjects();
			const picked = pickedObject();
			const cam = cams.find((c: any) => c.uuid === picked) ?? cams[0];
			item.camera = cam?.uuid ?? '';
			if (!cam) showToast('Add a camera object (Add ▸ Camera), then pick it for this shot');
		} else if (track.kind === 'anim') {
			const picked = pickedObject();
			const target = animTargets.find((x) => x.value === picked) ?? animTargets[0];
			item.target = target?.value ?? '';
			if (!target) showToast('Animate an object first (Animation editor), then pick it here');
		} else if (track.kind === 'audio') {
			const sound = audioItems[0];
			if (sound) {
				item.sound = sound.hash;
				item.name = sound.name;
				sendAsset(sound.hash);
			} else showToast('Import an audio file into the Explorer, then pick it here');
		} else {
			const n = track.items.length + 1;
			item.name = `event ${n}`;
		}
		const id = addItem(seqId, track.id, item);
		if (id) sequenceSelection.set([id]);
		return id;
	}
	function deleteSelection() {
		if (!seqId || !selection.length) return;
		removeItems(seqId, selection);
	}

	// ---- transport ----------------------------------------------------------------------
	function togglePlay() {
		if (!seqId || !seq) return;
		if (playing) {
			stopSequence(seqId, { restore: false }); // pause: the playhead parks where it is
			return;
		}
		const from = playhead >= seq.duration - 1e-3 ? 0 : playhead;
		playSequence(seqId, { mode: 'preview', from });
	}
	function stopAll() {
		if (!seqId) return;
		stopSequence(seqId, { restore: true });
		scrubSequence(seqId, 0);
		releaseScrub();
	}
	function scrubTo(t: number, free = false) {
		if (!seqId || !seq) return;
		let at = clamp(t, 0, seq.duration);
		if (snapOn && !free) at = Math.round(at * seq.fps) / seq.fps;
		scrubSequence(seqId, at);
	}

	// ---- pointer gestures ---------------------------------------------------------------
	let drag: any = null;
	let root: HTMLElement | null = $state(null);
	function focusRoot(e?: any) {
		const tag = e?.target?.tagName;
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
		root?.focus({ preventScroll: true });
	}
	function rulerDown(e: PointerEvent) {
		if (e.button !== 0 || !seq) return;
		focusRoot();
		drag = { kind: 'scrub' };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		scrubTo(tOf(e.clientX - rect.left), e.altKey);
	}
	function rulerMove(e: PointerEvent) {
		if (drag?.kind !== 'scrub') return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		scrubTo(tOf(e.clientX - rect.left), e.altKey);
	}
	function itemDown(e: PointerEvent, item: any, resize = false) {
		if (e.button !== 0 || !seqId || !seq) return;
		e.stopPropagation();
		focusRoot();
		let sel = get(sequenceSelection) as string[];
		if (e.shiftKey || e.ctrlKey || e.metaKey) {
			sel = sel.includes(item.id) ? sel.filter((x) => x !== item.id) : [...sel, item.id];
			sequenceSelection.set(sel);
			if (!sel.includes(item.id)) return;
		} else if (!sel.includes(item.id) || resize) {
			sel = [item.id];
			sequenceSelection.set(sel);
		}
		/** @type {Record<string, {t: number, dur: number}>} */
		const orig: Record<string, { t: number; dur: number }> = {};
		for (const id of resize ? [item.id] : sel) {
			const hit = findItem(seq, id);
			if (hit) orig[id] = { t: hit.item.t, dur: hit.item.dur };
		}
		drag = {
			kind: resize ? 'resize' : 'move',
			x0: e.clientX,
			primary: item.id,
			orig,
			moved: false,
			pointerId: e.pointerId
		};
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
	}
	function itemMove(e: PointerEvent) {
		if (!drag || drag.kind === 'scrub' || !seqId || !seq) return;
		const dx = e.clientX - drag.x0;
		if (!drag.moved) {
			if (Math.abs(dx) < 3) return;
			drag.moved = true;
			beginSequenceGesture(seqId);
		}
		const tol = 8 / pps;
		const exclude = new Set(Object.keys(drag.orig));
		const targets = snapTargets(seq, exclude, playhead);
		const o = drag.orig[drag.primary];
		const free = !snapOn || e.altKey;
		if (drag.kind === 'move') {
			let t = Math.max(0, o.t + dx / pps);
			guide = null;
			if (!free) {
				const head = snapTime(t, targets, tol, seq.fps);
				const tail = o.dur > 0 ? snapTime(t + o.dur, targets, tol, seq.fps) : null;
				if (
					tail &&
					tail.to !== null &&
					(head.to === null || Math.abs(tail.t - (t + o.dur)) < Math.abs(head.t - t))
				) {
					t = tail.t - o.dur;
					guide = tail.to;
				} else {
					t = head.t;
					guide = head.to;
				}
			}
			const minT = Math.min(...Object.values(drag.orig).map((v: any) => v.t));
			const delta = Math.max(t - o.t, -minT);
			const moves: Record<string, { t: number }> = {};
			for (const [id, v] of Object.entries(drag.orig) as [string, any][])
				moves[id] = { t: v.t + delta };
			placeItems(seqId, moves);
		} else {
			let end = Math.max(o.t + MIN_ITEM, o.t + o.dur + dx / pps);
			guide = null;
			if (!free) {
				const s = snapTime(end, targets, tol, seq.fps);
				end = Math.max(o.t + MIN_ITEM, s.t);
				guide = s.to;
			}
			placeItems(seqId, { [drag.primary]: { dur: end - o.t } });
		}
	}
	function itemUp() {
		if (!drag) return;
		if (drag.moved && seqId) endSequenceGesture(seqId);
		drag = null;
		guide = null;
	}
	function cancelDrag() {
		if (drag?.moved && seqId) cancelSequenceGesture(seqId);
		drag = null;
		guide = null;
	}
	function laneDblClick(e: MouseEvent, track: any) {
		if (!seq) return;
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		let t = tOf(e.clientX - rect.left);
		if (snapOn && !e.altKey)
			t = snapTime(t, snapTargets(seq, undefined, playhead), 8 / pps, seq.fps).t;
		addItemAt(track, t);
	}
	function laneDown(e: PointerEvent) {
		if (e.button !== 0) return;
		focusRoot(e);
		if (!e.shiftKey) sequenceSelection.set([]);
	}

	// ---- keys (claimed on the editor, CAPTURE phase: Delete would delete the selected
	// OBJECT and Space / arrows drive the viewport otherwise — the UvEditor rule) ----------
	function keys(node: HTMLElement) {
		const onKey = (e: KeyboardEvent) => {
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
			if (!seq || !seqId) return;
			let used = true;
			const frame = 1 / seq.fps;
			if (e.key === ' ') togglePlay();
			else if (e.key === 'Escape') {
				if (drag) cancelDrag();
				else sequenceSelection.set([]);
			} else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
			else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey))
				sequenceSelection.set(seq.tracks.flatMap((tr: any) => tr.items.map((it: any) => it.id)));
			else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
				const step = (e.key === 'ArrowLeft' ? -1 : 1) * frame * (e.shiftKey ? 10 : 1);
				if (selection.length) {
					beginSequenceGesture(seqId);
					const moves: Record<string, { t: number }> = {};
					const items = selection.map((id) => findItem(seq, id)?.item).filter(Boolean);
					const minT = Math.min(...items.map((it: any) => it.t));
					const d = Math.max(step, -minT);
					for (const it of items as any[]) moves[it.id] = { t: it.t + d };
					placeItems(seqId, moves);
					endSequenceGesture(seqId);
				} else scrubTo(playhead + step, true);
			} else if (e.key === 'Home') scrubTo(0, true);
			else if (e.key === 'End') scrubTo(seq.duration, true);
			else if ((e.key === 'k' || e.key === 'K') && !e.ctrlKey && !e.metaKey) {
				const hit = selection.length ? findItem(seq, selection[0]) : null;
				const track = hit?.track ?? seq.tracks[0];
				if (track) addItemAt(track, playhead);
			} else used = false;
			if (used) {
				e.preventDefault();
				e.stopPropagation();
			}
		};
		node.addEventListener('keydown', onKey, true);
		return { destroy: () => node.removeEventListener('keydown', onKey, true) };
	}

	// ---- menus + renames ----------------------------------------------------------------
	let menu: { x: number; y: number; items: any[] } | null = $state(null);
	/** the sequence whose name is being typed (the list row, or the phone bar's picker) */
	let renamingSeq = $state<string | null>(null);
	let renameText = $state('');
	let renamingTrack = $state<string | null>(null);
	function pickSequence(id: string) {
		if (id === seqId) return;
		activeSequence.set(id);
		sequenceSelection.set([]);
	}
	function startRename(id: string) {
		const s = ($sequences as any)[id];
		if (!s) return;
		renameText = s.name;
		renamingSeq = id;
	}
	function seqMenu(e: MouseEvent, id: string | null = seqId) {
		e.preventDefault();
		const s = id ? ($sequences as any)[id] : null;
		if (!id || !s) return;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: 'Rename…', icon: 'pencil', action: () => startRename(id) },
				{ label: 'Duplicate', icon: 'copy', action: () => duplicateSequence(id) },
				...(id === seqId ? [{ label: 'Fit view', icon: 'maximize-2', action: fitView }] : []),
				{
					label: 'Grow to fit items',
					disabled: contentEnd(s) <= s.duration,
					action: () => updateSequence(id, { duration: Math.ceil(contentEnd(s) * s.fps) / s.fps })
				},
				{ section: ' ' },
				{ label: 'Delete sequence', icon: 'trash-2', danger: true, action: () => deleteSequence(id) }
			]
		};
	}
	function addTrackMenu(e: MouseEvent) {
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: ADDABLE_KINDS.map((kind) => ({
				label: TRACK_LABELS[kind] + ' track',
				icon: KIND_ICON[kind],
				action: () => addTrackOf(kind)
			}))
		};
	}
	function trackMenu(e: MouseEvent, track: any, index: number) {
		if (!seqId) return;
		const id = seqId;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{ label: 'Rename…', action: () => (renamingTrack = track.id) },
				...(track.kind === 'prop'
					? [{ label: 'Smooth keys', disabled: !(track.keys?.length >= 3), action: () => smoothTrack(track) }]
					: []),
				{
					label: track.muted ? 'Unmute' : 'Mute',
					action: () => updateTrack(id, track.id, { muted: !track.muted })
				},
				{ label: 'Move up', disabled: index === 0, action: () => moveTrack(id, track.id, -1) },
				{
					label: 'Move down',
					disabled: index === seq.tracks.length - 1,
					action: () => moveTrack(id, track.id, 1)
				},
				{ section: ' ' },
				{ label: 'Delete track', danger: true, action: () => removeTrack(id, track.id) }
			]
		};
	}
	function commitRename() {
		if (renamingSeq && renameText.trim()) renameSequence(renamingSeq, renameText);
		renamingSeq = null;
	}

	// ---- the panes (uir-timeline) ----------------------------------------------------------
	/** the Properties tabs; the glyphs are the ones showhide-v8's WindowShell maps onto Lucide icons */
	const PANE_MODES = [
		{ key: 'sequence', icon: '⚙', label: 'Sequence' },
		{ key: 'item', icon: 'ⓘ', label: 'Item' }
	];
	let shell: any = $state(null);
	// picking ONE item brings its tab forward (transient unless the user pressed the tab); clearing the
	// pick puts a transient pane away again — the UvEditor rule
	let shownFor = '';
	$effect(() => {
		const id = oneSel?.item?.id ?? '';
		untrack(() => {
			if (id && id !== shownFor) shell?.showSecondary('item');
			else if (!id && shownFor) {
				const st = shell?.secondaryStatus?.();
				if (st?.open && st.mode === 'item' && !st.pinned) shell?.hideSecondary();
			}
			shownFor = id;
		});
	});
	const itemCount = $derived(seq ? seq.tracks.reduce((n: number, tr: any) => n + (tr.items?.length ?? 0), 0) : 0);
	/** frame rates people pick; anything 1-120 types in the field */
	const FPS_PRESETS = [24, 25, 30, 60];
	function setFps(v: number) {
		if (!seqId) return;
		const fps = Math.min(120, Math.max(1, Math.round(Number(v) || 0)));
		if (fps !== seq?.fps) updateSequence(seqId, { fps });
	}

	// a gesture for DragRow scrubs in the inspector (one undo step per scrub)
	const scrubStart = () => seqId && beginSequenceGesture(seqId);
	const scrubEnd = () => seqId && endSequenceGesture(seqId);
	function patchItem(patch: any) {
		if (seqId && oneSel) updateItem(seqId, oneSel.item.id, patch);
	}
	const flashNow = $derived($seqFlash as Record<string, number>);
</script>

{#snippet body()}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="tl-root"
		bind:this={root}
		use:keys
		tabindex="-1"
		role="application"
		aria-label="Timeline"
		data-keywords="timeline cutscene sequence sequences fps frame rate camera shot animation audio event properties"
		onpointerdown={focusRoot}
		onpointerenter={() => listTick++}
	>
		<WindowShell
			bind:this={shell}
			key="timeline"
			primaryLabel="sequences"
			primaryDefaultWidth={176}
			secondaryModes={PANE_MODES}
			secondaryDefaultOpen={!$phoneShell}
			secondaryDefaultWidth={236}
			topbar={seq ? tlBar : undefined}
			primary={tlSequences}
			main={tlMain}
			secondary={tlProps}
		/>
	</div>
{/snippet}

<!-- LEFT: the sequences of this scene -->
{#snippet tlSequences()}
	<div class="tl-seqs" id="timeline-sequences">
		<div class="tl-pane-head">
			<span class="tl-pane-title">Sequences</span>
			<Button size="sm" variant="ghost" icon="plus" title="New sequence" id="timeline-new" onclick={newSequence} />
		</div>
		{#if !list.length}
			<p class="tl-hint tl-pad">None yet. A sequence is one cutscene.</p>
		{/if}
		<div class="tl-seq-list" role="listbox" aria-label="Sequences">
			{#each list as s (s.id)}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="tl-seq-row" class:tl-seq-active={s.id === seqId} data-seq-row={s.id} oncontextmenu={(e) => seqMenu(e, s.id)}>
					{#if renamingSeq === s.id}
						<!-- svelte-ignore a11y_autofocus -->
						<input
							class="tl-rename"
							id="timeline-rename"
							aria-label="Sequence name"
							autofocus
							bind:value={renameText}
							onkeydown={(e) => {
								if (e.key === 'Enter') commitRename();
								if (e.key === 'Escape') renamingSeq = null;
								e.stopPropagation();
							}}
							onblur={commitRename}
						/>
					{:else}
						<button
							class="tl-seq-pick-btn"
							role="option"
							aria-selected={s.id === seqId}
							data-seq-id={s.id}
							title="{s.name} — double-click to rename"
							onclick={() => pickSequence(s.id)}
							ondblclick={() => startRename(s.id)}
						>
							<Icon name="video" size={16} aria-hidden="true" />
							<span class="tl-seq-name">{s.name}</span>
							{#if s.autoplay}<span class="tl-seq-flag" title="Autoplay"><Icon name="play" size={16} aria-hidden="true" /></span>{/if}
							{#if s.loop}<span class="tl-seq-flag" title="Loop"><Icon name="repeat" size={16} aria-hidden="true" /></span>{/if}
							<span class="tl-seq-len">{formatTime(s.duration, s.fps)}</span>
						</button>
					{/if}
					<button class="tl-icon-btn" title="Sequence menu" aria-label="Sequence menu for {s.name}" data-seq-menu={s.id} onclick={(e) => seqMenu(e, s.id)}
						><Icon name="ellipsis" size={16} /></button
					>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<!-- TOP of the middle pane: the transport and the view tools -->
{#snippet tlBar()}
	<div class="tl-bar">
		<!-- a phone opens with the side panes put away: the picker keeps switching one tap away -->
		<div class="tl-seq-pick tl-phone-only" title="Sequence">
			<ThemedSelect
				id="timeline-seq-select"
				clip={false}
				items={list.map((s: any) => ({ value: s.id, name: s.name }))}
				value={seqId}
				onchange={(v: any) => pickSequence(v)}
			/>
		</div>
		<Button size="sm" variant="ghost" icon="skip-back" title="Back to the start (Home)" id="timeline-home" onclick={() => scrubTo(0, true)} />
		<Button
			size="sm"
			variant={playing ? 'primary' : 'secondary'}
			icon={playing ? 'pause' : 'play'}
			title={playing ? 'Pause (Space)' : 'Preview (Space) — local to you; graph events fire only in Play'}
			id="timeline-play"
			onclick={togglePlay}
		/>
		<Button size="sm" variant="ghost" icon="square" title="Stop and rewind" id="timeline-stop" onclick={stopAll} />
		<span class="tl-time" id="timeline-time">{formatTime(playhead, seq.fps)} / {formatTime(seq.duration, seq.fps)}</span>
		{#if runningGame}<span class="tl-live" title="Running in the game (Play Sequence / autoplay)"
				><Icon name="circle" size={16} aria-hidden="true" /> live</span
			>{/if}
		<span class="flex-1"></span>
		<Button
			size="sm"
			variant="ghost"
			icon="magnet"
			pressed={snapOn}
			title={snapOn ? 'Snapping on (Alt drags freely)' : 'Snapping off'}
			id="timeline-snap"
			onclick={() => setSnap(!snapOn)}
		/>
		<Button
			size="sm"
			variant="ghost"
			icon={$previewShots ? 'eye' : 'eye-off'}
			pressed={$previewShots}
			title={$previewShots ? 'Previews look through the camera shots' : 'Previews keep your view'}
			id="timeline-shots"
			onclick={() => previewShots.set(!$previewShots)}
		/>
		<Button size="sm" variant="ghost" icon="maximize-2" title="Fit the whole sequence" id="timeline-fit" onclick={fitView} />
		<Button size="sm" variant="secondary" icon="plus" text="Track" id="timeline-add-track" onclick={addTrackMenu} />
	</div>
{/snippet}

<!-- MIDDLE: the tracks -->
{#snippet tlMain()}
	<div class="tl-main">
		{#if !seq}
			<EmptyState
				icon="video"
				title="No sequences yet"
				description="A sequence is a cutscene: camera shots, animation clips, audio and events on a timeline. Play it with the Play Sequence node, or let it autoplay when the game starts."
				actionLabel="New sequence"
				onaction={newSequence}
			/>
		{:else}
			<div class="tl-grid" use:wheel use:minimalScroll>
				<div class="tl-corner"></div>
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="tl-ruler"
					id="timeline-ruler"
					data-view="{viewStart},{viewEnd}"
					bind:clientWidth={lanesW}
					onpointerdown={rulerDown}
					onpointermove={rulerMove}
					onpointerup={() => (drag = null)}
				>
					{#each ticks.ticks as t (t)}
						<span class="tl-tick" style="left: {xOf(t)}px">{tickLabel(t)}</span>
					{/each}
					<span class="tl-end" style="left: {xOf(seq.duration)}px" title="End"></span>
					<span class="tl-head-mark" style="left: {xOf(playhead)}px"></span>
				</div>
				{#if !seq.tracks.length}
					<div class="tl-empty-tracks">
						<span>Add a track:</span>
						{#each ADDABLE_KINDS as kind (kind)}
							<Button
								size="sm"
								variant="secondary"
								icon={KIND_ICON[kind]}
								text={TRACK_LABELS[kind]}
								id="timeline-add-{kind}"
								onclick={() => addTrackOf(kind)}
							/>
						{/each}
					</div>
				{/if}
				{#each seq.tracks as track, index (track.id)}
					<div class="tl-track-head" data-track-head={track.id} class:tl-muted={track.muted}>
						<span class="tl-kind" style="color: {KIND_COLOR[track.kind] ?? 'var(--ink-warn)'}" title={isTrackKind(track.kind) ? TRACK_LABELS[track.kind] : NEWER_NOTE}
							><Icon name={KIND_ICON[track.kind] ?? 'triangle-alert'} size={16} /></span
						>
						{#if renamingTrack === track.id}
							<!-- svelte-ignore a11y_autofocus -->
							<input
								class="tl-rename"
								value={track.name}
								autofocus
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										updateTrack(seqId!, track.id, {
											name: e.currentTarget.value.trim() || track.name
										});
										renamingTrack = null;
									}
									if (e.key === 'Escape') renamingTrack = null;
									e.stopPropagation();
								}}
								onblur={(e) => {
									updateTrack(seqId!, track.id, {
										name: e.currentTarget.value.trim() || track.name
									});
									renamingTrack = null;
								}}
							/>
						{:else}
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<span
								class="tl-track-name"
								title="{track.kind === 'prop' ? propTrackLabel(track) : track.name} — double-click to rename"
								ondblclick={() => (renamingTrack = track.id)}>{track.kind === 'prop' ? propTrackLabel(track) : track.name}</span
							>
						{/if}
						<button
							class="tl-icon-btn tl-mute"
							title={track.muted ? 'Unmute track' : 'Mute track'}
							aria-pressed={track.muted}
							data-track-mute={track.id}
							onclick={() => updateTrack(seqId!, track.id, { muted: !track.muted })}
							><Icon name={track.muted ? 'volume-x' : 'volume-2'} size={16} /></button
						>
						<button
							class="tl-icon-btn"
							title="Track menu"
							data-track-menu={track.id}
							onclick={(e) => trackMenu(e, track, index)}><Icon name="ellipsis" size={16} /></button
						>
					</div>
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="tl-lane"
						class:tl-muted={track.muted}
						data-track-id={track.id}
						data-track-kind={track.kind}
						data-track-newer={isTrackKind(track.kind) ? undefined : ''}
						title={!isTrackKind(track.kind)
							? NEWER_NOTE
							: track.kind === 'prop'
								? propTrackLabel(track) + ' · ' + (track.keys?.length ?? 0) + ' keys — the track menu ⋯ smooths them'
								: 'Double-click to add ' + (track.kind === 'event' ? 'an event' : 'a ' + TRACK_LABELS[track.kind].toLowerCase() + ' item')}
						ondblclick={(e) => {
							if (isTrackKind(track.kind) && track.kind !== 'prop') laneDblClick(e, track);
						}}
						onpointerdown={laneDown}
					>
						{#if !isTrackKind(track.kind)}
							<span class="tl-newer" role="note">{NEWER_NOTE}</span>
						{:else if track.kind === 'prop'}
							{#each track.keys ?? [] as key (key.id)}
								<span class="tl-key" class:tl-key-user={key.src === 'user'} style="left: {xOf(key.t)}px" data-key-id={key.id}></span>
							{/each}
						{/if}
						{#each isTrackKind(track.kind) ? track.items : [] as item (item.id)}
							{@const sel = selection.includes(item.id)}
							{#if track.kind === 'event'}
								<div
									class="tl-item tl-event"
									class:tl-sel={sel}
									class:tl-flash={flashNow[item.id] !== undefined &&
										transport?.playing &&
										Math.abs(playhead - item.t) < 0.25}
									style="left: {xOf(item.t)}px; --tl-kind: {KIND_COLOR.event}"
									data-item-id={item.id}
									title="{item.name} @ {formatTime(item.t, seq.fps)}"
									onpointerdown={(e) => itemDown(e, item)}
									onpointermove={itemMove}
									onpointerup={itemUp}
									onpointercancel={cancelDrag}
								>
									<span class="tl-diamond"></span><span class="tl-label">{item.name}</span>
								</div>
							{:else}
								<div
									class="tl-item"
									class:tl-sel={sel}
									style="left: {xOf(item.t)}px; width: {Math.max(
										8,
										item.dur * pps
									)}px; --tl-kind: {KIND_COLOR[track.kind]}"
									data-item-id={item.id}
									title="{itemLabel(track.kind, item)} · {formatTime(
										item.t,
										seq.fps
									)} – {formatTime(item.t + item.dur, seq.fps)}"
									onpointerdown={(e) => itemDown(e, item)}
									onpointermove={itemMove}
									onpointerup={itemUp}
									onpointercancel={cancelDrag}
								>
									<span class="tl-label">{itemLabel(track.kind, item)}</span>
									<!-- svelte-ignore a11y_no_static_element_interactions -->
									<span
										class="tl-grip"
										title="Drag to change the length"
										data-item-grip={item.id}
										onpointerdown={(e) => itemDown(e, item, true)}
										onpointermove={itemMove}
										onpointerup={itemUp}
										onpointercancel={cancelDrag}
									></span>
								</div>
							{/if}
						{/each}
						<span class="tl-head-mark" style="left: {xOf(playhead)}px"></span>
						{#if guide !== null}<span class="tl-guide" style="left: {xOf(guide)}px"></span>{/if}
					</div>
				{/each}
			</div>

		{/if}
	</div>
{/snippet}

<!-- RIGHT: Properties — the sequence, or the picked item -->
{#snippet tlProps(mode: string)}
	{#if mode === 'item'}
		{#if oneSel}
			{@const kind = oneSel.track.kind}
			{@const it = oneSel.item}
			<div class="tl-pane tl-inspector" id="timeline-inspector" data-kind={kind}>
				<div class="tl-pane-head">
					<span class="tl-kind" style="color: {KIND_COLOR[kind]}"><Icon name={KIND_ICON[kind]} size={16} /></span>
					<span class="tl-pane-title">{isTrackKind(kind) ? TRACK_LABELS[kind] : 'Item'}</span>
					<span class="flex-1"></span>
					<Button size="sm" variant="ghost" icon="trash-2" title="Delete (Del)" id="timeline-item-delete" onclick={deleteSelection} />
				</div>
					<span class="tl-kind" style="color: {KIND_COLOR[kind]}"
						><Icon name={KIND_ICON[kind]} size={16} /></span
					>
					<div class="tl-field">
						<DragRow
							label="At"
							value={it.t}
							step={0.02}
							decimals={2}
							min={0}
							onscrubstart={scrubStart}
							onscrubend={scrubEnd}
							onchange={(v: number) => patchItem({ t: v })}
						/>
					</div>
					{#if kind !== 'event'}
						<div class="tl-field">
							<DragRow
								label="Length"
								value={it.dur}
								step={0.02}
								decimals={2}
								min={MIN_ITEM}
								onscrubstart={scrubStart}
								onscrubend={scrubEnd}
								onchange={(v: number) => patchItem({ dur: v })}
							/>
						</div>
					{/if}
					{#if kind === 'camera'}
						<div class="tl-pick" title="Shot camera">
							<ThemedSelect
								id="timeline-item-camera"
								clip={false}
								placeholder="Camera"
								items={cameraItems}
								value={it.camera || undefined}
								onchange={(v: any) => patchItem({ camera: v })}
							/>
						</div>
						<div
							class="tl-pick"
							title="Glide to this camera over the shot (a dolly / pan between two marks)"
						>
							<ThemedSelect
								id="timeline-item-to"
								clip={false}
								items={[
									{ value: '', name: 'hold (no move)' },
									...cameraItems
										.filter((c: any) => c.value !== it.camera)
										.map((c: any) => ({ ...c, name: '→ ' + c.name }))
								]}
								value={it.to}
								onchange={(v: any) => patchItem({ to: v })}
							/>
						</div>
						{#if it.to}
							<div class="tl-pick tl-narrow">
								<ThemedSelect
									clip={false}
									items={[
										{ value: 'smooth', name: 'smooth' },
										{ value: 'linear', name: 'linear' }
									]}
									value={it.ease}
									onchange={(v: any) => patchItem({ ease: v })}
								/>
							</div>
						{/if}
					{:else if kind === 'anim'}
						<div class="tl-pick" title="Object">
							<ThemedSelect
								id="timeline-item-target"
								clip={false}
								placeholder="Object"
								items={animTargets}
								value={it.target || undefined}
								onchange={(v: any) => patchItem({ target: v, clip: '' })}
							/>
						</div>
						<div class="tl-pick" title="Clip">
							<ThemedSelect
								id="timeline-item-clip"
								clip={false}
								items={clipItems(it.target)}
								value={it.clip}
								onchange={(v: any) => patchItem({ clip: v })}
							/>
						</div>
						<div class="tl-field">
							<DragRow
								label="Speed"
								value={it.speed}
								step={0.01}
								decimals={2}
								min={0.1}
								max={4}
								onscrubstart={scrubStart}
								onscrubend={scrubEnd}
								onchange={(v: number) => patchItem({ speed: v })}
							/>
						</div>
					{:else if kind === 'audio'}
						<div class="tl-pick" title="Sound (Explorer audio)">
							<ThemedSelect
								id="timeline-item-sound"
								clip={false}
								placeholder="Sound"
								items={audioItems.map((a: any) => ({ value: a.hash, name: a.name }))}
								value={it.sound || undefined}
								onchange={(v: any) => {
									const a = audioItems.find((x: any) => x.hash === v);
									patchItem({ sound: v, name: a?.name ?? '' });
									if (v) sendAsset(v);
								}}
							/>
						</div>
						<div class="tl-field">
							<DragRow
								label="Gain"
								value={it.gain}
								step={0.01}
								decimals={2}
								min={0}
								max={2}
								onscrubstart={scrubStart}
								onscrubend={scrubEnd}
								onchange={(v: number) => patchItem({ gain: v })}
							/>
						</div>
						<!-- 53 (A6/A5): the clip's caption — shown to players with Captions on while it plays -->
						<input
							class="tl-event-name"
							id="timeline-item-caption"
							value={it.caption ?? ''}
							maxlength="200"
							placeholder="Caption"
							aria-label="Caption"
							title="A caption shown while this clip plays, to players who switched Captions on"
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
								e.stopPropagation();
							}}
							onchange={(e) => patchItem({ caption: e.currentTarget.value.trim() })}
						/>
					{:else}
						<input
							class="tl-event-name"
							id="timeline-item-event"
							value={it.name}
							title="The event name an On Sequence Event node listens for"
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
								e.stopPropagation();
							}}
							onchange={(e) => patchItem({ name: e.currentTarget.value.trim() || it.name })}
						/>
					{/if}
			</div>
		{:else if selection.length > 1}
			<div class="tl-pane" id="timeline-inspector-many">
				<span class="tl-hint">{selection.length} items — drag to move together, ←/→ to nudge, Del to delete</span>
			</div>
		{:else}
			<div class="tl-pane" id="timeline-inspector-none">
				<span class="tl-hint">Pick an item on a track to edit it here. Double-click an empty lane to add one.</span>
			</div>
		{/if}
	{:else if seq}
		<div class="tl-pane" id="timeline-seq-props">
			<label class="tl-row-label" for="timeline-seq-name">Name</label>
			<input
				class="tl-event-name"
				id="timeline-seq-name"
				value={seq.name}
				maxlength="80"
				onkeydown={(e) => {
					if (e.key === 'Enter') e.currentTarget.blur();
					if (e.key === 'Escape') {
						e.currentTarget.value = seq.name;
						e.currentTarget.blur();
					}
					e.stopPropagation();
				}}
				onchange={(e) => seqId && renameSequence(seqId, e.currentTarget.value)}
			/>
			<div class="tl-field" title="Length (seconds)">
				<DragRow
					id="timeline-duration"
					label="Length"
					value={seq.duration}
					step={0.05}
					decimals={2}
					min={0.1}
					max={3600}
					onscrubstart={scrubStart}
					onscrubend={scrubEnd}
					onchange={(v: number) => seqId && updateSequence(seqId, { duration: v })}
				/>
			</div>
			<div class="tl-field" title="Frames per second: the grid items snap to and the readout counts in">
				<DragRow
					id="timeline-fps"
					label="Frame rate"
					value={seq.fps}
					step={1}
					decimals={0}
					min={1}
					max={120}
					onscrubstart={scrubStart}
					onscrubend={scrubEnd}
					onchange={setFps}
				/>
			</div>
			<div class="tl-chips" role="group" aria-label="Common frame rates">
				{#each FPS_PRESETS as f (f)}
					<button class="tl-chip" aria-pressed={seq.fps === f} data-fps={f} onclick={() => setFps(f)}>{f}</button>
				{/each}
			</div>
			<label class="tl-flag" title="Start this sequence when a player enters Play (and in exported games)">
				<Toggle id="timeline-autoplay" checked={seq.autoplay} onchange={(v: boolean) => seqId && updateSequence(seqId, { autoplay: v })} />
				<span>Autoplay</span>
			</label>
			<label class="tl-flag" title="Loop">
				<Toggle id="timeline-loop" checked={seq.loop} onchange={(v: boolean) => seqId && updateSequence(seqId, { loop: v })} />
				<span>Loop</span>
			</label>
			<span class="tl-hint" id="timeline-seq-count">{seq.tracks.length} {seq.tracks.length === 1 ? 'track' : 'tracks'} · {itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
			{#if contentEnd(seq) > seq.duration}
				<Button
					size="sm"
					variant="secondary"
					icon="chevrons-left-right"
					text="Grow to fit items"
					id="timeline-grow"
					onclick={() => seqId && updateSequence(seqId, { duration: Math.ceil(contentEnd(seq) * seq.fps) / seq.fps })}
				/>
			{/if}
		</div>
	{:else}
		<div class="tl-pane"><span class="tl-hint">No sequence yet.</span></div>
	{/if}
{/snippet}

{#if !$timelineClose}
	{#if docked}
		<div
			id="timeline-dock"
			class="tp-ui tp-dock-panel fixed inset-x-0 bottom-0 flex flex-col p-2 {dockVisible
				? ''
				: 'hidden'}"
			data-dock-pane={($dockPaneOf as any)[KEY]}
			style="z-index: var(--z-dock); height: {$dockHeight}px"
			data-key-scope="panel"
			role="region"
			aria-label="Timeline (docked)"
		>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue hover:bg-accent/30 absolute -top-1 right-0 left-0 z-28 h-2 cursor-ns-resize"
				style="touch-action: none"
				title="Drag to resize"
				onpointerdown={startResize}
				onpointermove={doResize}
				onpointerup={endResize}
			></div>
			<DockTabs />
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
		</div>
	{:else}
		<div
			id="timeline-window"
			class="ui-panel tp-ui tp-window fixed flex flex-col overflow-hidden"
			use:dragWindow={{ key: KEY, defaultRect: { left: 220, top: 170 } }}
			use:focusStack={KEY}
			use:tabbable={{
				key: KEY,
				title: 'Timeline',
				openStore: timelineClose,
				isOpen: (v: any) => !v,
				close: () => timelineClose.set(true)
			}}
			use:bottomDockable={{ key: KEY }}
			style="z-index: var(--z-window); max-width: 96vw; max-height: 88vh"
			style:width="{effW}px"
			style:height="{effH}px"
		>
			<WindowChrome
				size="tool"
				bare
				body={false}
				title="Timeline"
				headerClass="ui-panel-header move-handle cursor-move select-none"
				onclose={() => timelineClose.set(true)}
				closeAttrs={{ title: 'Close' }}
			>
				{#snippet heading()}
					<span class="wc-label">Timeline</span>
					<span class="wc-sub">{seq ? seq.name : 'no sequence'}</span>
					<span class="flex-1"></span>
				{/snippet}
				{#snippet actions()}
					<button
						data-wc-chrome
						class="wc-act-text"
						title="Dock to the bottom"
						onclick={() => setDocked(true)}><Icon name="panel-bottom" size={16} />Dock</button
					>
				{/snippet}
			</WindowChrome>
			<div class="flex min-h-0 flex-1 flex-col">
				{@render body()}
			</div>
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="resize-cue bg-border-strong/40 absolute right-0 bottom-0 z-10 h-3.5 w-3.5 cursor-se-resize rounded-tl"
				style="touch-action: none"
				title="Drag to resize · double-click to reset size"
				onpointerdown={startWinResize}
				onpointermove={doWinResize}
				onpointerup={endWinResize}
				ondblclick={resetWinSize}
			></div>
		</div>
	{/if}
{/if}

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		items={menu.items}
		sizeKey="timeline"
		onclose={() => (menu = null)}
	/>
{/if}

<style>
	.tl-root {
		--tl-head: 168px;
		--tl-row: 34px;
		display: flex;
		min-height: 0;
		flex: 1 1 auto;
		flex-direction: column;
		outline: none;
		font-size: var(--fs-body);
		color: var(--text);
	}
	.tl-root > :global(.ws-root) {
		flex: 1 1 auto;
		min-height: 0;
	}
	.tl-main {
		display: flex;
		height: 100%;
		min-height: 0;
		flex-direction: column;
		padding: 0 6px 4px;
	}
	.tl-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
		padding: 0 6px 6px;
	}
	/* uir-timeline: the side panes */
	.tl-seqs {
		display: flex;
		min-height: 0;
		flex-direction: column;
	}
	.tl-pane-head {
		display: flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		padding: 2px 4px 2px 8px;
	}
	.tl-pane-title {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-desc);
		font-weight: 600;
		color: var(--text-2);
	}
	.tl-seq-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		padding: 0 4px 6px;
	}
	.tl-seq-row {
		display: flex;
		align-items: center;
		gap: 2px;
		border-radius: var(--radius-button, 6px);
	}
	.tl-seq-row:hover {
		background: var(--surface-hover);
	}
	.tl-seq-row.tl-seq-active {
		background: var(--surface-active);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.tl-seq-pick-btn {
		display: flex;
		min-width: 0;
		min-height: 30px;
		flex: 1 1 auto;
		align-items: center;
		gap: 6px;
		padding: 0 4px 0 8px;
		border: 0;
		background: transparent;
		color: var(--text);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.tl-seq-name {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tl-seq-flag {
		display: inline-flex;
		color: var(--text-muted);
	}
	.tl-seq-len {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-muted);
		font-variant-numeric: tabular-nums;
	}
	.tl-seq-row .tl-rename {
		flex: 1 1 auto;
		width: auto;
		margin: 2px 0 2px 4px;
	}
	.tl-pad {
		padding: 0 8px;
	}
	.tl-pane {
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 4px 8px 10px;
	}
	.tl-pane .tl-pane-head {
		padding: 0;
	}
	.tl-pane .tl-field,
	.tl-pane .tl-pick,
	.tl-pane .tl-pick.tl-narrow,
	.tl-pane .tl-event-name {
		width: 100%;
	}
	.tl-row-label {
		margin-bottom: -4px;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.tl-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
	}
	.tl-chip {
		min-width: 36px;
		min-height: 24px;
		padding: 0 8px;
		border: 1px solid var(--border);
		border-radius: var(--radius-button, 6px);
		background: var(--surface-1);
		color: var(--text-2);
		font-size: var(--fs-desc);
		font-variant-numeric: tabular-nums;
		cursor: pointer;
	}
	.tl-chip:hover {
		background: var(--surface-hover);
	}
	.tl-chip[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--accent-fill);
		color: var(--on-accent);
	}
	.tl-chip:focus-visible,
	.tl-seq-pick-btn:focus-visible {
		outline: 2px solid var(--focus-ring, var(--accent));
		outline-offset: -2px;
	}
	.tl-phone-only {
		display: none;
	}
	:global(:root.phone-shell) .tl-phone-only {
		display: block;
	}
	.tl-seq-pick {
		width: 170px;
	}
	.tl-time {
		min-width: 9.5em;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.tl-live {
		display: inline-flex;
		align-items: center;
		gap: 3px;
		font-size: var(--fs-desc);
		color: var(--ink-good);
	}
	.tl-flag {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 0 4px;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.tl-rename,
	.tl-event-name {
		min-width: 0;
		height: var(--control-h-sm);
		padding: 0 6px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-input, 6px);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
	}
	.tl-rename {
		width: 160px;
	}
	.tl-event-name {
		width: 180px;
	}
	.tl-grid {
		position: relative;
		display: grid;
		min-height: 0;
		flex: 1 1 auto;
		grid-template-columns: var(--tl-head) minmax(0, 1fr);
		grid-template-rows: 24px;
		grid-auto-rows: var(--tl-row);
		align-content: start;
		overflow-x: hidden;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-card, 8px);
		background: var(--surface-inset);
		user-select: none;
	}
	.tl-corner {
		position: sticky;
		top: 0;
		z-index: 3;
		height: 24px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-2);
	}
	.tl-ruler {
		position: sticky;
		top: 0;
		z-index: 3;
		height: 24px;
		overflow: hidden;
		border-bottom: 1px solid var(--border);
		background: var(--surface-2);
		cursor: col-resize;
		touch-action: none;
	}
	.tl-tick {
		position: absolute;
		top: 0;
		bottom: 0;
		padding: 4px 0 0 3px;
		border-left: 1px solid var(--border-strong);
		color: var(--text-muted);
		font-size: var(--fs-badge);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		pointer-events: none;
	}
	.tl-end {
		position: absolute;
		top: 0;
		bottom: 0;
		width: 2px;
		background: var(--text-faint);
		pointer-events: none;
	}
	.tl-head-mark {
		position: absolute;
		top: 0;
		bottom: 0;
		z-index: 2;
		width: 2px;
		margin-left: -1px;
		background: var(--danger);
		pointer-events: none;
	}
	.tl-guide {
		position: absolute;
		top: 0;
		bottom: 0;
		z-index: 2;
		width: 1px;
		background: var(--accent);
		pointer-events: none;
	}
	.tl-empty-tracks {
		grid-column: 1 / -1;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 8px;
		color: var(--text-muted);
	}
	.tl-track-head {
		display: flex;
		min-width: 0;
		align-items: center;
		gap: 4px;
		padding: 0 4px 0 8px;
		border-bottom: 1px solid var(--border);
		background: var(--surface-1);
	}
	.tl-kind {
		display: inline-flex;
		flex: 0 0 auto;
	}
	.tl-track-name {
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.tl-icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 24px;
		height: 24px;
		flex: 0 0 auto;
		border: 0;
		border-radius: var(--radius-button, 6px);
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}
	.tl-icon-btn:hover {
		background: var(--surface-hover);
		color: var(--text);
	}
	.tl-muted {
		opacity: 0.5;
	}
	.tl-lane {
		position: relative;
		overflow: hidden;
		border-bottom: 1px solid var(--border);
		touch-action: pan-y;
	}
	.tl-item {
		position: absolute;
		top: 4px;
		bottom: 4px;
		display: flex;
		align-items: center;
		overflow: hidden;
		padding: 0 10px 0 6px;
		border: 1px solid color-mix(in srgb, var(--tl-kind) 70%, transparent);
		border-radius: 5px;
		background: color-mix(in srgb, var(--tl-kind) 28%, var(--surface-1));
		color: var(--text);
		font-size: var(--fs-desc);
		cursor: grab;
		touch-action: none;
	}
	.tl-item.tl-sel {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		z-index: 1;
	}
	.tl-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		pointer-events: none;
	}
	.tl-grip {
		position: absolute;
		top: 0;
		right: 0;
		bottom: 0;
		width: 8px;
		cursor: ew-resize;
		background: color-mix(in srgb, var(--tl-kind) 45%, transparent);
	}
	.tl-event {
		padding: 0 4px 0 0;
		margin-left: -7px;
		border-color: transparent;
		background: transparent;
		overflow: visible;
	}
	.tl-event.tl-sel {
		box-shadow: none;
	}
	/* 68-int: a property track's keys (a dope row) and a newer version's track */
	.tl-key {
		position: absolute;
		top: 50%;
		width: 7px;
		height: 7px;
		margin: -4px 0 0 -4px;
		border: 1px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 45%, var(--surface-1));
		transform: rotate(45deg);
		pointer-events: none;
	}
	.tl-key.tl-key-user {
		background: var(--accent);
	}
	.tl-newer {
		position: absolute;
		left: 8px;
		top: 50%;
		transform: translateY(-50%);
		font-size: var(--fs-desc);
		color: var(--ink-warn);
		white-space: nowrap;
		pointer-events: none;
	}
	.tl-diamond {
		width: 12px;
		height: 12px;
		flex: 0 0 auto;
		margin: 0 4px 0 1px;
		border: 1px solid var(--tl-kind);
		background: color-mix(in srgb, var(--tl-kind) 55%, var(--surface-1));
		transform: rotate(45deg);
	}
	.tl-event.tl-sel .tl-diamond {
		border-color: var(--accent);
		outline: 2px solid var(--accent);
	}
	.tl-flash .tl-diamond {
		background: var(--tl-kind);
		transform: rotate(45deg) scale(1.35);
	}
	.tl-field {
		width: 120px;
	}
	.tl-pick {
		width: 170px;
	}
	.tl-pick.tl-narrow {
		width: 100px;
	}
	.tl-hint {
		color: var(--text-muted);
		font-size: var(--fs-desc);
	}
	/* the phone sheet: a narrow header column and finger-sized rows */
	:global(:root.phone-shell) .tl-root {
		--tl-head: 104px;
		--tl-row: 42px;
	}
	:global(:root.phone-shell) .tl-seq-pick {
		width: 128px;
	}
	:global(:root.phone-shell) .tl-seq-pick-btn {
		min-height: 40px;
	}
	/* the name needs the room: Mute lives in the track menu there */
	:global(:root.phone-shell) .tl-mute {
		display: none;
	}
	:global(:root.phone-shell) .tl-grip {
		width: 14px;
	}
</style>
