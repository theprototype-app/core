<script>
	// Animation window v1: a LOCAL-ONLY transform animator for the selected object.
	// DOCKED mode is a Flow-family tab in the bottom dock; UNDOCKED mode is a floating,
	// resizable window. Left = movement tracks (layers), centre = a cubic-bezier easing
	// curve editor (draggable dots = the speed graph), right = the selected track's
	// properties. Transport previews it by driving the object per frame (animationPreview).
	import { get } from 'svelte/store';
	import { untrack } from 'svelte';
	import { selectedObject } from '../../stores/sceneStore';
	import { animationClose } from '../../stores/appStore.js';
	import {
		animations, playback, playheads, CHANNELS, EASINGS, channelLabel, isRotChannel,
		activeClip, addTrack, removeTrack, updateTrack, updateKey, updateAnim,
		play, pause, stop, scrub
	} from '$lib/animationPreview';
	// the clips a model was IMPORTED with are a different system (replicated,
	// posed from the synced clock) — the window used to ignore them entirely, so
	// a rigged model showed "no movements yet" and its own animations were
	// reachable only from the Inspector.
	import { animatedObjects, setAnimationState, clipInfo } from '$lib/animatedImports';
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

	let selId = $state(/** @type {string|null} */ (null));
	const selTrack = $derived(tracks.find((t) => t.id === selId) ?? tracks[0] ?? null);
	let newChannel = $state('pos.y');

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
			if (prev && prev !== t && !get(playback)[prev]?.playing) stop(prev);
		});
	});

	function add() {
		if (!target) return;
		selId = addTrack(target.uuid, newChannel, target);
	}
	function togglePlay() {
		if (!target) return;
		if (isPlaying) pause(target.uuid);
		else play(target.uuid);
	}

	// a track's endpoints are its first and last KEY now; the number fields edit
	// those, and the curve below shapes the segment that follows the first key.
	const firstKey = $derived(selTrack?.keys?.[0] ?? null);
	const lastKey = $derived(selTrack?.keys?.length ? selTrack.keys[selTrack.keys.length - 1] : null);
	const segEase = $derived(firstKey?.ease ?? EASINGS.linear);
	const isRot = (/** @type {string} */ ch) => isRotChannel(ch);
	function dispVal(/** @type {number|undefined} */ v, /** @type {string} */ channel) {
		const n = v ?? 0;
		return isRot(channel) ? Math.round((n * 180) / Math.PI * 100) / 100 : Math.round(n * 1000) / 1000;
	}
	function setKeyVal(/** @type {number} */ index, /** @type {string} */ raw) {
		const n = parseFloat(raw);
		if (Number.isNaN(n) || !target || !selTrack) return;
		updateKey(target.uuid, selTrack.id, index, {
			v: isRot(selTrack.channel) ? (n * Math.PI) / 180 : n
		});
	}

	// --- curve editor geometry (unit square, y up) ---
	const SIZE = 200;
	const PAD = 14;
	const INNER = SIZE - 2 * PAD;
	const sx = (/** @type {number} */ x) => PAD + x * INNER;
	const sy = (/** @type {number} */ y) => PAD + (1 - y) * INNER;

	let svgEl = $state(/** @type {any} */ (null));
	let dragIdx = $state(-1); // 0 = P1, 1 = P2
	function onHandleDown(/** @type {number} */ idx, /** @type {PointerEvent} */ e) {
		dragIdx = idx;
		e.preventDefault();
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
		updateKey(target.uuid, selTrack.id, 0, { ease: b });
	}
	function onUp() {
		dragIdx = -1;
		window.removeEventListener('pointermove', onMove);
		window.removeEventListener('pointerup', onUp);
	}
	function applyEasing(/** @type {string} */ name) {
		if (!selTrack || !target) return;
		updateKey(target.uuid, selTrack.id, 0, { ease: [...EASINGS[name]] });
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
		<div class="flex shrink-0 items-center gap-2 border-b border-gray-700/60 px-2 py-1.5">
			<button class="ui-button-quiet text-primary-400" title={isPlaying ? 'Pause' : 'Play'} onclick={togglePlay}>
				{isPlaying ? '⏸' : '▶'}
			</button>
			<button class="ui-button-quiet" title="Stop and reset" onclick={() => target && stop(target.uuid)}>⏹</button>
			<input
				type="range" min="0" max={anim?.duration ?? 2} step="0.01" class="flex-1 accent-primary-500"
				value={curTime} oninput={(e) => target && scrub(target.uuid, parseFloat(e.currentTarget.value))}
			/>
			<span class="w-24 text-right text-[11px] tabular-nums text-gray-400">
				{curTime.toFixed(2)} / {(anim?.duration ?? 2).toFixed(2)}s
			</span>
			<label class="flex items-center gap-1 text-[11px] text-gray-400">
				dur
				<input
					type="number" min="0.1" step="0.1" class="w-14 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-right text-xs"
					value={anim?.duration ?? 2}
					oninput={(e) => target && updateAnim(target.uuid, { duration: Math.max(0.1, parseFloat(e.currentTarget.value) || 0.1) })}
				/>
			</label>
			<select
				class="rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-xs"
				value={anim?.loop ?? 'loop'}
				onchange={(e) => target && updateAnim(target.uuid, { loop: /** @type {any} */ (e.currentTarget.value) })}
			>
				<option value="loop">Loop</option>
				<option value="once">Once</option>
				<option value="pingpong">Ping-pong</option>
			</select>
		</div>

		<div class="flex min-h-0 flex-1">
			<!-- LEFT: the object's OWN clips, then authored movement tracks -->
			<div class="flex w-56 shrink-0 flex-col border-r border-gray-700/60">
				{#if clips.length}
					<div id="animation-clips" class="border-b border-gray-700/60">
						<div class="flex items-center justify-between px-2 pt-1.5">
							<span class="text-[10px] uppercase tracking-wider text-gray-500">Clips in this model</span>
							<span class="text-[10px] text-gray-500">{clips.length}</span>
						</div>
						<div class="max-h-32 overflow-y-auto p-1">
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
						<p class="px-2 pb-1.5 text-[10px] text-gray-500">
							Clips ride the synced clock, so every peer sees the same pose.
						</p>
					</div>
				{/if}
				<div class="flex items-center gap-1 border-b border-gray-700/60 p-1.5">
					<select class="min-w-0 flex-1 rounded-sm border border-gray-600 bg-gray-900 px-1 py-0.5 text-xs" value={newChannel} onchange={(e) => (newChannel = e.currentTarget.value)}>
						{#each CHANNELS as c}<option value={c}>{channelLabel(c)}</option>{/each}
					</select>
					<button class="ui-button-quiet shrink-0" title="Add movement" onclick={add}>＋</button>
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
								onclick={() => (selId = t.id)}>{channelLabel(t.channel)}</button
							>
							<button class="ui-button-quiet shrink-0 text-red-400" title="Remove" onclick={() => { if (target) removeTrack(target.uuid, t.id); }}>✕</button>
						</div>
					{/each}
				</div>
			</div>

			<!-- CENTRE: easing curve editor -->
			<div class="flex min-w-0 flex-1 flex-col items-center justify-center gap-2 p-2">
				{#if selTrack}
					<div class="text-[11px] text-gray-400">Speed curve for <span class="text-gray-200">{channelLabel(selTrack.channel)}</span></div>
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
					<div class="flex flex-wrap justify-center gap-1">
						{#each Object.keys(EASINGS) as name}
							<button class="rounded-sm border border-gray-600 px-1.5 py-0.5 text-[10px] text-gray-300 hover:bg-gray-700" onclick={() => applyEasing(name)}>{name}</button>
						{/each}
					</div>
				{:else}
					<div class="text-sm text-gray-500">Add a movement to edit its speed curve.</div>
				{/if}
			</div>

			<!-- RIGHT: selected-track properties -->
			<div class="w-48 shrink-0 overflow-y-auto border-l border-gray-700/60 p-2">
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
					<div class="mb-2 grid grid-cols-2 gap-2">
						<label class="text-[11px] text-gray-400">
							From{isRot(selTrack.channel) ? ' (deg)' : ''}
							<input type="number" step="0.1" class="mt-0.5 w-full rounded-sm border border-gray-600 bg-gray-900 px-1 py-1 text-xs" value={dispVal(firstKey?.v, selTrack.channel)} oninput={(e) => setKeyVal(0, e.currentTarget.value)} />
						</label>
						<label class="text-[11px] text-gray-400">
							To{isRot(selTrack.channel) ? ' (deg)' : ''}
							<input type="number" step="0.1" class="mt-0.5 w-full rounded-sm border border-gray-600 bg-gray-900 px-1 py-1 text-xs" value={dispVal(lastKey?.v, selTrack.channel)} oninput={(e) => setKeyVal(selTrack.keys.length - 1, e.currentTarget.value)} />
						</label>
					</div>
					<div class="text-[10px] leading-relaxed text-gray-500">
						{selTrack.keys.length} keys — saved with the scene.
					</div>
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
				<button class="ui-button-quiet" title="Undock into a floating window" onclick={() => setDocked(false)}>⧉</button>
				<button class="ui-button-quiet" title="Close" onclick={() => animationClose.set(true)}>✕</button>
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
				<button class="ui-button-quiet" title="Close" onclick={() => animationClose.set(true)}>✕</button>
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
