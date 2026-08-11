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
		activeClip, clipList, addTrack, removeTrack, updateTrack, updateAnim,
		addKey, updateKey, removeKey, sampleTrack, evaluateClip, channelValue,
		createClip, renameClip, duplicateClip, deleteClip, setActiveClip,
		beginAnimGesture, endAnimGesture, play, pause, stop, scrub
	} from '$lib/animationPreview';
	// the clips a model was IMPORTED with are a different system (replicated,
	// posed from the synced clock) — the window used to ignore them entirely, so
	// a rigged model showed "no movements yet" and its own animations were
	// reachable only from the Inspector.
	import { animatedObjects, setAnimationState, clipInfo } from '$lib/animatedImports';
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
	/** which key is selected: [trackId, index] */
	let selKey = $state(/** @type {[string, number]|null} */ (null));
	const selKeyObj = $derived.by(() => {
		const sel = selKey;
		if (!sel) return null;
		const track = tracks.find((t) => t.id === sel[0]);
		return track?.keys[sel[1]] ?? null;
	});
	/** the easing being edited: the selected key's, else the first key's */
	const easeKey = $derived(selKeyObj ?? selTrack?.keys?.[0] ?? null);
	const segEase = $derived(easeKey?.ease ?? EASINGS.linear);
	let view = $state(/** @type {'sheet'|'graph'} */ ('sheet'));
	let snap = $state(true);
	let renaming = $state(/** @type {string|null} */ (null));

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

	// Selecting a different object releases a SCRUB left on the previous one (it
	// holds a base pose that must be restored). Something actually PLAYING keeps
	// playing — playback is shared with peers, not a property of the selection.
	let prevUuid = /** @type {string|null} */ (null);
	$effect(() => {
		const t = target?.uuid ?? null;
		untrack(() => {
			if (t === prevUuid) return;
			const prev = prevUuid;
			prevUuid = t;
			selKey = null;
			if (prev && prev !== t && !get(playback)[prev]?.playing) stop(prev);
		});
	});

	function add() {
		if (!target) return;
		selId = addTrack(target.uuid, newChannel, target);
		selKey = null;
	}
	function togglePlay() {
		if (!target) return;
		if (isPlaying) pause(target.uuid);
		else play(target.uuid);
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
	const PAD_X = 10;
	const RULER_H = 16;
	const ROW_H = 22;
	const GRAPH_H = 150;
	const innerW = $derived(Math.max(60, plotW - PAD_X * 2));
	const sheetH = $derived(RULER_H + Math.max(1, tracks.length) * ROW_H + 6);
	const plotH = $derived(view === 'graph' ? RULER_H + GRAPH_H + 6 : sheetH);
	const tx = (/** @type {number} */ t) => PAD_X + (t / Math.max(duration, 0.001)) * innerW;
	const xt = (/** @type {number} */ x) => ((x - PAD_X) / innerW) * Math.max(duration, 0.001);
	const rowY = (/** @type {number} */ i) => RULER_H + i * ROW_H + ROW_H / 2;

	// value range of the selected track, for the graph's y axis
	const range = $derived.by(() => {
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
		const steps = 64;
		let d = '';
		for (let i = 0; i <= steps; i++) {
			const t = (i / steps) * duration;
			const v = sampleTrack(selTrack, t);
			if (v === null) continue;
			d += (d ? ' L ' : 'M ') + tx(t).toFixed(2) + ' ' + vy(v).toFixed(2);
		}
		return d;
	});

	const snapT = (/** @type {number} */ t) => (snap ? Math.round(t * 10) / 10 : Math.round(t * 1000) / 1000);

	// --- key dragging ------------------------------------------------------------
	let plotEl = $state(/** @type {any} */ (null));
	/** @type {{trackId: string, index: number, axis: 'time'|'both'}|null} */
	let drag = null;
	function keyDown(/** @type {PointerEvent} */ e, /** @type {string} */ trackId, /** @type {number} */ index) {
		if (!target) return;
		e.preventDefault();
		e.stopPropagation();
		selId = trackId;
		selKey = [trackId, index];
		drag = { trackId, index, axis: view === 'graph' ? 'both' : 'time' };
		beginAnimGesture(target.uuid, 'Move key');
		window.addEventListener('pointermove', keyMove);
		window.addEventListener('pointerup', keyUp);
	}
	function keyMove(/** @type {PointerEvent} */ e) {
		if (!drag || !plotEl || !target) return;
		const r = plotEl.getBoundingClientRect();
		const t = snapT(Math.max(0, Math.min(duration, xt(e.clientX - r.left))));
		/** @type {any} */
		const patch = { t };
		if (drag.axis === 'both') {
			const track = tracks.find((tr) => tr.id === drag?.trackId);
			if (track && !STEPPED.has(track.channel)) patch.v = yv(e.clientY - r.top);
		}
		updateKey(target.uuid, drag.trackId, drag.index, patch);
		// keys re-sort while dragging, so follow this key by its new position
		const track = get(animations)[target.uuid]?.clips?.[
			get(animations)[target.uuid].active
		]?.tracks?.find((/** @type {any} */ tr) => tr.id === drag?.trackId);
		if (track) {
			const at = track.keys.findIndex((/** @type {any} */ k) => Math.abs(k.t - t) < 1e-6);
			if (at >= 0 && drag) {
				drag.index = at;
				selKey = [drag.trackId, at];
			}
		}
	}
	function keyUp() {
		drag = null;
		endAnimGesture();
		window.removeEventListener('pointermove', keyMove);
		window.removeEventListener('pointerup', keyUp);
	}

	/** double-click on a row (or the graph) inserts a key at that time */
	function plotDblClick(/** @type {MouseEvent} */ e) {
		if (!target || !plotEl) return;
		const r = plotEl.getBoundingClientRect();
		const x = e.clientX - r.left;
		const y = e.clientY - r.top;
		const t = snapT(Math.max(0, Math.min(duration, xt(x))));
		if (view === 'graph') {
			if (!selTrack) return;
			const v = STEPPED.has(selTrack.channel) ? (sampleTrack(selTrack, t) ?? 0) : yv(y);
			addKey(target.uuid, selTrack.id, t, v);
			return;
		}
		const row = Math.floor((y - RULER_H) / ROW_H);
		const track = tracks[row];
		if (!track) return;
		selId = track.id;
		addKey(target.uuid, track.id, t, sampleTrack(track, t) ?? 0);
	}

	/** clicking the ruler scrubs */
	function rulerDown(/** @type {PointerEvent} */ e) {
		if (!target || !plotEl) return;
		const r = plotEl.getBoundingClientRect();
		scrub(target.uuid, Math.max(0, Math.min(duration, xt(e.clientX - r.left))));
	}

	/** Del removes the selected key. Panels swallow DELEGATED handlers, so this is a
	 *  direct listener (the DragRow lesson, 16-Q3). @param {HTMLElement} node */
	function keyNav(node) {
		const onKey = (/** @type {KeyboardEvent} */ e) => {
			if (!target || !selKey) return;
			if (e.key !== 'Delete' && e.key !== 'Backspace') return;
			const tag = /** @type {any} */ (e.target)?.tagName;
			if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
			e.preventDefault();
			removeKey(target.uuid, selKey[0], selKey[1]);
			selKey = null;
		};
		node.addEventListener('keydown', onKey);
		return { destroy: () => node.removeEventListener('keydown', onKey) };
	}

	// --- the "+" menu ------------------------------------------------------------
	let menu = $state(/** @type {any} */ (null));
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
					label: 'Movement',
					children: CHANNELS.map((c) => ({
						label: channelLabel(c),
						action: () => {
							selId = addTrack(uuid, c, target);
							selKey = null;
						}
					}))
				},
				{
					label: 'Key at playhead',
					disabled: !selTrack,
					tooltip: 'Insert a key on the selected movement at ' + t.toFixed(2) + 's',
					action: () => {
						if (!selTrack) return;
						addKey(uuid, selTrack.id, snapT(t), sampleTrack(selTrack, t) ?? 0);
					}
				},
				{
					label: 'Keys on every movement',
					disabled: !tracks.length,
					tooltip: 'Pose the object, then drop a key on every track at once',
					action: () => {
						beginAnimGesture(uuid, 'Add keys');
						for (const track of tracks) {
							addKey(uuid, track.id, snapT(t), sampleTrack(track, t) ?? 0);
						}
						endAnimGesture();
					}
				},
				{
					label: 'Key from the current pose',
					disabled: !tracks.length,
					tooltip: 'Read the object where it stands now and key every channel',
					action: () => {
						beginAnimGesture(uuid, 'Key pose');
						for (const track of tracks) {
							addKey(uuid, track.id, snapT(t), channelValue(target, track.channel));
						}
						endAnimGesture();
					}
				},
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
			Select an object in the viewport to animate it, or to pick from the clips it was imported
			with.
		</div>
	{:else}
		<!-- transport -->
		<div class="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-700/60 px-2 py-1.5">
			<button class="ui-button-quiet text-primary-400" title={isPlaying ? 'Pause' : 'Play'} onclick={togglePlay}>
				{isPlaying ? '⏸' : '▶'}
			</button>
			<button class="ui-button-quiet" title="Stop and reset" onclick={() => target && stop(target.uuid)}>⏹</button>
			<input
				type="range" min="0" max={duration} step="0.01" class="min-w-24 flex-1 accent-primary-500"
				aria-label="Playhead"
				value={curTime} oninput={(e) => target && scrub(target.uuid, parseFloat(e.currentTarget.value))}
			/>
			<span class="w-24 text-right text-[11px] tabular-nums text-gray-400">
				{curTime.toFixed(2)} / {duration.toFixed(2)}s
			</span>
			<label class="flex items-center gap-1 text-[11px] text-gray-400">
				dur
				<input
					type="number" min="0.1" step="0.1" class="w-14 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-right text-xs"
					value={duration}
					oninput={(e) => target && updateAnim(target.uuid, { duration: Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1) })}
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
			<button
				id="animation-add"
				class="ui-button-quiet shrink-0"
				title="Add movements, keys and clips"
				aria-label="Add"
				onclick={openAddMenu}>＋</button
			>
		</div>

		<div class="flex min-h-0 flex-1">
			<!-- LEFT: the object's OWN clips, then authored clips + movement tracks -->
			<div class="flex w-56 shrink-0 flex-col border-r border-gray-700/60">
				{#if clips.length}
					<div id="animation-clips" class="border-b border-gray-700/60">
						<div class="flex items-center justify-between px-2 pt-1.5">
							<span class="text-[10px] uppercase tracking-wider text-gray-500">Clips in this model</span>
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
							<span class="text-[10px] uppercase tracking-wider text-gray-500">Clips you authored</span>
							<span class="text-[10px] text-gray-500">{authoredClips.length}</span>
						</div>
						<div class="max-h-24 overflow-y-auto p-1">
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
										onclick={() => { if (target) { setActiveClip(target.uuid, clip.id); selId = null; selKey = null; } }}
										ondblclick={() => (renaming = clip.id)}
									>
										<span class="min-w-0 truncate">{clip.name}</span>
										<span class="shrink-0 text-[10px] tabular-nums text-gray-500">{clip.tracks}▪{clip.duration.toFixed(1)}s</span>
									</button>
								{/if}
							{/each}
						</div>
					</div>
				{/if}

				<div class="flex items-center gap-1 border-b border-gray-700/60 p-1.5">
					<select class="min-w-0 flex-1 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-xs" aria-label="Channel to animate" value={newChannel} onchange={(e) => (newChannel = e.currentTarget.value)}>
						{#each CHANNELS as c}<option value={c}>{channelLabel(c)}</option>{/each}
					</select>
					<button class="ui-button-quiet shrink-0" title="Add movement" aria-label="Add movement" onclick={add}>＋</button>
				</div>
				<div class="min-h-0 flex-1 overflow-y-auto">
					{#if !tracks.length}
						<div class="p-3 text-center text-[11px] text-gray-500">
							{clips.length
								? 'No authored movements. The model’s own clips are listed above.'
								: 'No movements yet. Pick a channel and add one.'}
						</div>
					{/if}
					{#each tracks as t (t.id)}
						<div class="flex items-center gap-1 {selTrack?.id === t.id ? 'bg-primary-900/40' : ''}">
							<button
								class="min-w-0 flex-1 truncate px-2 py-1 text-left text-xs hover:bg-gray-700/60 {selTrack?.id === t.id ? 'text-primary-200' : 'text-gray-300'}"
								onclick={() => { selId = t.id; selKey = null; }}>{channelLabel(t.channel)}</button
							>
							<span class="shrink-0 text-[10px] tabular-nums text-gray-500">{t.keys.length}</span>
							<button class="ui-button-quiet shrink-0 text-red-400" title="Remove" aria-label="Remove movement" onclick={() => { if (target) removeTrack(target.uuid, t.id); }}>✕</button>
						</div>
					{/each}
				</div>
			</div>

			<!-- CENTRE: the timeline (dope sheet / value graph) -->
			<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
			<div class="flex min-w-0 flex-1 flex-col" tabindex="-1" use:keyNav>
				<div class="flex shrink-0 items-center gap-2 border-b border-gray-700/60 px-2 py-1 text-[11px] text-gray-400">
					<button
						class="rounded-sm border px-1.5 py-0.5 {view === 'sheet' ? 'border-primary-500 text-primary-300' : 'border-gray-600'}"
						onclick={() => (view = 'sheet')}>Sheet</button
					>
					<button
						class="rounded-sm border px-1.5 py-0.5 {view === 'graph' ? 'border-primary-500 text-primary-300' : 'border-gray-600'}"
						onclick={() => (view = 'graph')}>Graph</button
					>
					<label class="flex items-center gap-1">
						<input type="checkbox" class="accent-primary-500" checked={snap} onchange={(e) => (snap = e.currentTarget.checked)} />
						snap 0.1s
					</label>
					<span class="flex-1"></span>
					<span class="truncate">
						{tracks.length ? 'Double-click to add a key · drag to move · Del removes' : ''}
					</span>
				</div>
				<div class="min-h-0 flex-1 overflow-auto p-2" bind:clientWidth={plotW}>
					{#if !tracks.length}
						<div class="flex h-full items-center justify-center text-center text-sm text-gray-500">
							Add a movement to build a timeline.
						</div>
					{:else}
						<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
						<svg
							bind:this={plotEl}
							id="animation-timeline"
							width={plotW - 4}
							height={plotH}
							class="touch-none select-none rounded-sm bg-gray-900/60"
							ondblclick={plotDblClick}
						>
							<!-- ruler -->
							<!-- svelte-ignore a11y_no_static_element_interactions -->
							<rect
								x="0" y="0" width={plotW - 4} height={RULER_H}
								fill="rgb(31 41 55 / 0.8)" class="cursor-ew-resize"
								onpointerdown={rulerDown}
							/>
							{#each Array(Math.min(21, Math.max(2, Math.round(duration / (duration > 4 ? 1 : 0.5)) + 1))) as _, i}
								{@const t = i * (duration > 4 ? 1 : 0.5)}
								{#if t <= duration}
									<line x1={tx(t)} y1={0} x2={tx(t)} y2={plotH} stroke="rgb(75 85 99 / 0.35)" />
									<text x={tx(t) + 2} y={11} font-size="9" fill="rgb(107 114 128)">{t}s</text>
								{/if}
							{/each}

							{#if view === 'sheet'}
								{#each tracks as track, row (track.id)}
									<line
										x1={PAD_X} y1={rowY(row)} x2={tx(duration)} y2={rowY(row)}
										stroke={selTrack?.id === track.id ? 'rgb(129 140 248 / 0.5)' : 'rgb(75 85 99 / 0.5)'}
									/>
									{#each track.keys as key, index (index)}
										<rect
											x={tx(key.t) - 4} y={rowY(row) - 4} width="8" height="8"
											transform="rotate(45 {tx(key.t)} {rowY(row)})"
											class="cursor-ew-resize"
											fill={selKey && selKey[0] === track.id && selKey[1] === index ? 'rgb(250 204 21)' : 'rgb(99 102 241)'}
											stroke="rgb(17 24 39)"
											onpointerdown={(e) => keyDown(e, track.id, index)}
										/>
									{/each}
								{/each}
							{:else if selTrack}
								<path d={curve} fill="none" stroke="rgb(129 140 248)" stroke-width="2" />
								{#each selTrack.keys as key, index (index)}
									<circle
										cx={tx(key.t)} cy={vy(key.v)} r="5"
										class="cursor-move"
										fill={selKey && selKey[0] === selTrack.id && selKey[1] === index ? 'rgb(250 204 21)' : 'rgb(99 102 241)'}
										stroke="rgb(17 24 39)"
										onpointerdown={(e) => keyDown(e, selTrack.id, index)}
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
							onclick={() => { if (target && selKey) { removeKey(target.uuid, selKey[0], selKey[1]); selKey = null; } }}
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
