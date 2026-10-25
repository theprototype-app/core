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
		TRACK_KINDS,
		TRACK_LABELS,
		formatTime,
		rulerTicks,
		snapTime,
		snapTargets,
		contentEnd,
		MIN_ITEM,
		clamp
	} from '$lib/sequenceCore';
	import { listCameraObjects } from '$lib/cameraObjects';
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
		caption: 'captions'
	};
	const KIND_COLOR: Record<string, string> = {
		camera: 'var(--icon-object)',
		anim: 'var(--accent)',
		audio: 'var(--icon-audio)',
		event: 'var(--ink-warn)',
		caption: 'var(--icon-doc)'
	};

	// ---- shell: docked vs floating (HudEditor's verbatim) ------------------------------
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
	$effect(() =>
		onLayoutRestore(() => {
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
		if (kind === 'caption')
			return (item.speaker ? item.speaker + ': ' : '') + (String(item.text ?? '').replace(/\n/g, ' / ') || 'type a caption');
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
		} else if (track.kind === 'caption') {
			item.text = 'New caption';
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
	let renaming = $state(false);
	let renameText = $state('');
	let renamingTrack = $state<string | null>(null);
	function seqMenu(e: MouseEvent) {
		if (!seqId || !seq) return;
		const id = seqId;
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
				{
					label: 'Rename…',
					action: () => {
						renameText = seq.name;
						renaming = true;
					}
				},
				{ label: 'Duplicate', action: () => duplicateSequence(id) },
				{ label: 'Fit view', action: fitView },
				// 77 C1: subtitles in and out, and captions made from the clips' speech
				{ label: 'Captions', icon: 'captions', children: captionMenuItems(id, null) },
				{
					label: 'Grow to fit items',
					disabled: contentEnd(seq) <= seq.duration,
					action: () =>
						updateSequence(id, { duration: Math.ceil(contentEnd(seq) * seq.fps) / seq.fps })
				},
				{ section: ' ' },
				{ label: 'Delete sequence', danger: true, action: () => deleteSequence(id) }
			]
		};
	}
	function addTrackMenu(e: MouseEvent) {
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: TRACK_KINDS.map((kind) => ({
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
				...(track.kind === 'caption' ? [{ label: 'Captions', icon: 'captions', children: captionMenuItems(id, track.id) }] : []),
				{ section: ' ' },
				{ label: 'Delete track', danger: true, action: () => removeTrack(id, track.id) }
			]
		};
	}
	// 77 C1: the caption actions (captionJobs.js is LAZY — loaded on the first press)
	const captionJobs = () => import('$lib/captionJobs');
	function captionMenuItems(id: string, trackId: string | null) {
		return [
			{
				label: trackId ? 'Import .srt / .vtt into this track…' : 'Import .srt / .vtt…',
				// the file input is made synchronously, inside the press: a picker opened after the
				// lazy import resolves can land outside the click's user activation (no dialog at all)
				action: () => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = '.srt,.vtt,text/vtt,application/x-subrip';
					input.onchange = () => {
						const file = input.files?.[0];
						if (file) void captionJobs().then((m) => m.importSubtitleFile(id, trackId, file));
					};
					input.click();
				}
			},
			{ label: 'Export .vtt', action: () => captionJobs().then((m) => m.exportSubtitles(id, 'vtt')) },
			{ label: 'Export .srt', action: () => captionJobs().then((m) => m.exportSubtitles(id, 'srt')) },
			{ section: ' ' },
			{
				label: 'Caption the speech in audio clips',
				tooltip: 'Transcribes the selected audio clips (or all of them) onto a new caption track — on this device with the Captions module, else your speech-to-text server (Settings ▸ AI)',
				action: () => captionJobs().then((m) => m.autoCaption(id))
			}
		];
	}
	function commitRename() {
		if (seqId && renameText.trim()) renameSequence(seqId, renameText);
		renaming = false;
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
		data-keywords="timeline cutscene sequence camera shot animation audio event"
		onpointerdown={focusRoot}
		onpointerenter={() => listTick++}
	>
		{#if !seq}
			<EmptyState
				icon="video"
				title="No sequences yet"
				description="A sequence is a cutscene: camera shots, animation clips, audio and events on a timeline. Play it with the Play Sequence node, or let it autoplay when the game starts."
				actionLabel="New sequence"
				onaction={newSequence}
			/>
		{:else}
			<div class="tl-bar">
				{#if renaming}
					<input
						class="tl-rename"
						id="timeline-rename"
						bind:value={renameText}
						onkeydown={(e) => {
							if (e.key === 'Enter') commitRename();
							if (e.key === 'Escape') renaming = false;
							e.stopPropagation();
						}}
						onblur={commitRename}
					/>
				{:else}
					<div class="tl-seq-pick" title="Sequence">
						<ThemedSelect
							id="timeline-seq-select"
							clip={false}
							items={list.map((s: any) => ({ value: s.id, name: s.name }))}
							value={seqId}
							onchange={(v: any) => {
								activeSequence.set(v);
								sequenceSelection.set([]);
							}}
						/>
					</div>
				{/if}
				<Button
					size="sm"
					variant="ghost"
					icon="plus"
					title="New sequence"
					id="timeline-new"
					onclick={newSequence}
				/>
				<Button
					size="sm"
					variant="ghost"
					icon="ellipsis"
					title="Sequence menu"
					id="timeline-seq-menu"
					onclick={seqMenu}
				/>
				<span class="tl-sep"></span>
				<Button
					size="sm"
					variant="ghost"
					icon="skip-back"
					title="Back to the start (Home)"
					id="timeline-home"
					onclick={() => scrubTo(0, true)}
				/>
				<Button
					size="sm"
					variant={playing ? 'primary' : 'secondary'}
					icon={playing ? 'pause' : 'play'}
					title={playing
						? 'Pause (Space)'
						: 'Preview (Space) — local to you; graph events fire only in Play'}
					id="timeline-play"
					onclick={togglePlay}
				/>
				<Button
					size="sm"
					variant="ghost"
					icon="square"
					title="Stop and rewind"
					id="timeline-stop"
					onclick={stopAll}
				/>
				<span class="tl-time" id="timeline-time"
					>{formatTime(playhead, seq.fps)} / {formatTime(seq.duration, seq.fps)}</span
				>
				{#if runningGame}<span
						class="tl-live"
						title="Running in the game (Play Sequence / autoplay)">● live</span
					>{/if}
				<span class="tl-sep"></span>
				<div class="tl-dur" title="Length (seconds)">
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
				<label
					class="tl-flag"
					title="Start this sequence when a player enters Play (and in exported games)"
				>
					<Toggle
						id="timeline-autoplay"
						checked={seq.autoplay}
						onchange={(v: boolean) => seqId && updateSequence(seqId, { autoplay: v })}
					/>
					<span>Autoplay</span>
				</label>
				<label class="tl-flag" title="Loop">
					<Toggle
						id="timeline-loop"
						checked={seq.loop}
						onchange={(v: boolean) => seqId && updateSequence(seqId, { loop: v })}
					/>
					<span>Loop</span>
				</label>
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
					title={$previewShots
						? 'Previews look through the camera shots'
						: 'Previews keep your view'}
					id="timeline-shots"
					onclick={() => previewShots.set(!$previewShots)}
				/>
				<Button
					size="sm"
					variant="ghost"
					icon="maximize-2"
					title="Fit the whole sequence"
					id="timeline-fit"
					onclick={fitView}
				/>
				<Button
					size="sm"
					variant="secondary"
					icon="plus"
					text="Track"
					id="timeline-add-track"
					onclick={addTrackMenu}
				/>
			</div>

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
						{#each TRACK_KINDS as kind (kind)}
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
						<span class="tl-kind" style="color: {KIND_COLOR[track.kind]}"
							><Icon name={KIND_ICON[track.kind]} size={16} /></span
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
								title="{track.name} — double-click to rename"
								ondblclick={() => (renamingTrack = track.id)}>{track.name}</span
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
						title="Double-click to add {track.kind === 'event'
							? 'an event'
							: 'a ' + TRACK_LABELS[track.kind].toLowerCase() + ' item'}"
						ondblclick={(e) => laneDblClick(e, track)}
						onpointerdown={laneDown}
					>
						{#each track.items as item (item.id)}
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

			{#if oneSel}
				{@const kind = oneSel.track.kind}
				{@const it = oneSel.item}
				<div class="tl-inspector" id="timeline-inspector" data-kind={kind}>
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
					{:else if kind === 'caption'}
						<!-- 77 C1: a subtitle cue — Enter commits, Shift+Enter breaks the line -->
						<textarea
							class="tl-event-name tl-cue-text"
							id="timeline-item-cue"
							rows="1"
							value={it.text ?? ''}
							maxlength="300"
							placeholder="Caption text"
							aria-label="Caption text"
							title="The subtitle shown while the playhead is inside this cue (Shift+Enter for a second line)"
							onkeydown={(e) => {
								if (e.key === 'Enter' && !e.shiftKey) {
									e.preventDefault();
									e.currentTarget.blur();
								}
								e.stopPropagation();
							}}
							onchange={(e) => patchItem({ text: e.currentTarget.value })}
						></textarea>
						<input
							class="tl-event-name tl-cue-speaker"
							id="timeline-item-speaker"
							value={it.speaker ?? ''}
							maxlength="60"
							placeholder="Speaker"
							aria-label="Speaker"
							title="Who says it (optional) — shown before the line and written as a voice in .vtt"
							onkeydown={(e) => {
								if (e.key === 'Enter') e.currentTarget.blur();
								e.stopPropagation();
							}}
							onchange={(e) => patchItem({ speaker: e.currentTarget.value.trim() })}
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
					<span class="flex-1"></span>
					<Button
						size="sm"
						variant="ghost"
						icon="trash-2"
						title="Delete (Del)"
						id="timeline-item-delete"
						onclick={deleteSelection}
					/>
				</div>
			{:else if selection.length > 1}
				<div class="tl-inspector">
					<span class="tl-hint"
						>{selection.length} items — drag to move together, ←/→ to nudge, Del to delete</span
					>
				</div>
			{/if}
		{/if}
	</div>
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
		gap: 6px;
		outline: none;
		font-size: var(--fs-body);
		color: var(--text);
	}
	.tl-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 4px;
	}
	.tl-seq-pick {
		width: 170px;
	}
	.tl-sep {
		width: 1px;
		height: 18px;
		margin: 0 2px;
		background: var(--border);
	}
	.tl-time {
		min-width: 9.5em;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text-2);
		font-variant-numeric: tabular-nums;
	}
	.tl-live {
		font-size: var(--fs-desc);
		color: var(--ink-good);
	}
	.tl-dur {
		width: 130px;
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
	/* 77 C1: a cue's text grows with a second line; the speaker field is short */
	.tl-cue-text {
		width: 260px;
		min-height: var(--control-h-sm);
		height: auto;
		padding: 3px 6px;
		resize: vertical;
		field-sizing: content;
		max-height: 72px;
	}
	.tl-cue-speaker {
		width: 110px;
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
	.tl-inspector {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 4px 6px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card, 8px);
		background: var(--surface-1);
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
	:global(:root.phone-shell) .tl-dur,
	:global(:root.phone-shell) .tl-seq-pick {
		width: 128px;
	}
	:global(:root.phone-shell) .tl-pick,
	:global(:root.phone-shell) .tl-field {
		width: calc(50% - 20px);
	}
	/* the name needs the room: Mute lives in the track menu there */
	:global(:root.phone-shell) .tl-mute {
		display: none;
	}
	:global(:root.phone-shell) .tl-grip {
		width: 14px;
	}
</style>
