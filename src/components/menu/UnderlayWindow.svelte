<script>
	// 60 Q5: Tools ▸ Reference images… — the one place a reference image is changed (the planes
	// themselves cannot be clicked: they are locked and unpickable). On the shared ToolboxWindow
	// shell: a floating palette on desktop, a bottom sheet on a phone. Also hosts the image-DROP
	// menu ("Use as reference"), which App's drop handler opens through `underlayDropMenu`.
	import Icon from '../ui/Icon.svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import Slider from '../ui/Slider.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import {
		underlays,
		underlayWindowOpen,
		underlayDropMenu,
		addUnderlay,
		updateUnderlay,
		removeUnderlay,
		setUnderlayShared,
		isMine
	} from '$lib/underlays';
	import { underlayPoseFromView, GROUND_LIFT } from '$lib/underlayPose';
	import { nameOf } from '$lib/lockControl';
	import { isLocked, isVRMode } from '../../stores/sceneStore';
	import { peers } from '../../stores/appStore';

	const open = $derived($underlayWindowOpen && $isLocked !== true && !$isVRMode);
	/** @type {any} */
	const peerConn = $derived($peers);
	const connected = $derived((peerConn?.openedPeers?.size ?? 0) > 0);
	/** the placement a new image takes ("Add image…" in this window) */
	let addMode = $state(/** @type {'ground' | 'view'} */ ('ground'));
	/** @type {HTMLInputElement | null} */
	let picker = $state(null);

	/** @param {File[]} files @param {'ground' | 'view'} mode */
	async function useAsReference(files, mode) {
		for (const file of files) {
			const pose = underlayPoseFromView(mode);
			if (!pose) return;
			await addUnderlay(file, pose);
		}
		underlayWindowOpen.set(true);
	}

	const dropItems = $derived(
		$underlayDropMenu
			? [
					{ section: $underlayDropMenu.files.length > 1 ? `${$underlayDropMenu.files.length} images` : $underlayDropMenu.files[0]?.name ?? 'Image' },
					{
						label: 'Use as reference — on the ground',
						icon: 'image-up',
						tooltip: 'A see-through, unclickable image lying on the ground to build over (hidden in Play, never exported)',
						action: () => useAsReference($underlayDropMenu?.files ?? [], 'ground')
					},
					{
						label: 'Use as reference — facing the view',
						tooltip: 'A see-through, unclickable image standing in front of you, square to this view',
						action: () => useAsReference($underlayDropMenu?.files ?? [], 'view')
					},
					{
						label: 'Add to the Explorer',
						icon: 'folder-open',
						tooltip: 'Keep the image in your library (drag it onto an object to texture it)',
						action: () => {
							const files = $underlayDropMenu?.files ?? [];
							void import('$lib/explorer').then((m) => m.importFiles(files));
						}
					}
				]
			: []
	);

	/** @param {any} u @param {'ground' | 'view'} mode */
	function setMode(u, mode) {
		if (u.mode === mode) return;
		const pose = underlayPoseFromView(mode);
		if (pose) updateUnderlay(u.id, pose);
	}
	/** @param {any} u */
	function faceView(u) {
		const pose = underlayPoseFromView(u.mode);
		if (pose) updateUnderlay(u.id, { position: pose.position, quaternion: pose.quaternion });
	}
	/** a ground image's height over the ground plane (cm precision is plenty) @param {any} u */
	const lift = (u) => Math.round((u.position[1] - GROUND_LIFT) * 100) / 100;
</script>

{#if $underlayDropMenu}
	<ContextMenu x={$underlayDropMenu.x} y={$underlayDropMenu.y} items={dropItems} sizeKey="underlayDrop" on:close={() => underlayDropMenu.set(null)} />
{/if}

{#if open}
	<ToolboxWindow id="underlay-window" key="underlayWindow" title="Reference images" width={264} onclose={() => underlayWindowOpen.set(false)}>
		{#snippet actions()}
			<button id="underlay-close" class="tbx-hbtn" aria-label="Close" title="Close" onclick={() => underlayWindowOpen.set(false)}
				><Icon name="x" size={16} aria-hidden="true" /></button
			>
		{/snippet}

		<div class="tbx-row text-xs">
			<button id="underlay-add" class="tbx-cmd" title="Pick an image to lay in the scene as a reference" onclick={() => picker?.click()}>Add image…</button>
			<select id="underlay-add-mode" class="tbx-cmd" aria-label="Where a new image goes" bind:value={addMode}>
				<option value="ground">On the ground</option>
				<option value="view">Facing the view</option>
			</select>
			<input
				bind:this={picker}
				type="file"
				accept="image/*"
				multiple
				hidden
				onchange={(e) => {
					const files = [...(e.currentTarget.files ?? [])];
					e.currentTarget.value = '';
					if (files.length) void useAsReference(files, addMode);
				}}
			/>
		</div>

		{#if !$underlays.length}
			<div class="tbx-row text-xs text-text-muted" id="underlay-empty">Drop an image on the viewport, or Add image…, to trace over a plan, a sketch or a photo.</div>
		{/if}

		{#each $underlays as u (u.id)}
			{@const mine = isMine(u.id)}
			<div class="ul-item" data-underlay={u.id}>
				<div class="tbx-row text-xs ul-head">
					<img class="ul-thumb" src={u.src} alt="" />
					<span class="ul-name" title={u.name}>{u.name}</span>
					{#if mine}
						<button class="tbx-hbtn" data-ul="visible" aria-pressed={u.visible} title={u.visible ? 'Hide' : 'Show'} aria-label={u.visible ? 'Hide' : 'Show'} onclick={() => updateUnderlay(u.id, { visible: !u.visible })}
							><Icon name={u.visible ? 'eye' : 'eye-off'} size={16} aria-hidden="true" /></button
						>
						<button class="tbx-hbtn" data-ul="remove" title="Remove this reference image" aria-label="Remove" onclick={() => removeUnderlay(u.id)}
							><Icon name="trash-2" size={16} aria-hidden="true" /></button
						>
					{/if}
				</div>
				{#if mine}
					<div class="tbx-row text-xs">
						<span class="text-text-muted">Opacity</span>
						<Slider value={u.opacity} min={0.05} max={1} step={0.05} label="Opacity" width="120px" format={(v) => Math.round(v * 100) + '%'} data-ul="opacity" onchange={(v) => updateUnderlay(u.id, { opacity: v })} />
					</div>
					<div class="tbx-row text-xs">
						<span class="text-text-muted">Size</span>
						<Slider value={u.width} min={0.5} max={Math.max(200, u.width)} step={0.5} label="Width in metres" width="120px" format={(v) => v.toFixed(1) + ' m'} data-ul="width" onchange={(v) => updateUnderlay(u.id, { width: v })} />
					</div>
					{#if u.mode === 'ground'}
						<div class="tbx-row text-xs">
							<span class="text-text-muted">Height</span>
							<Slider
								value={lift(u)}
								min={-5}
								max={20}
								step={0.05}
								label="Height over the ground"
								width="120px"
								format={(v) => v.toFixed(2) + ' m'}
								data-ul="lift"
								onchange={(v) => updateUnderlay(u.id, { position: [u.position[0], v + GROUND_LIFT, u.position[2]] })}
							/>
						</div>
					{/if}
					<div class="tbx-row text-xs">
						<select class="tbx-cmd" data-ul="mode" aria-label="Placement" value={u.mode} onchange={(e) => setMode(u, /** @type {any} */ (e.currentTarget.value))}>
							<option value="ground">On the ground</option>
							<option value="view">Facing the view</option>
						</select>
						<button class="tbx-cmd" data-ul="here" title={u.mode === 'view' ? 'Stand it in front of the current view again' : 'Move it under the point you are looking at, turned to this view'} onclick={() => faceView(u)}
							>{u.mode === 'view' ? 'Face the view' : 'Move here'}</button
						>
					</div>
					<div class="tbx-row text-xs">
						<label class="flex items-center gap-1" title={connected ? 'Everyone in your room sees it (read-only); off takes it back' : 'Shared with whoever is in your room once you connect'}>
							<input class="tbx-check" type="checkbox" data-ul="share" checked={u.shared} onchange={(e) => setUnderlayShared(u.id, e.currentTarget.checked)} />
							Share with session
						</label>
					</div>
				{:else}
					<div class="tbx-row text-xs text-text-muted" data-ul="from">Shared by {nameOf(u.owner ?? '') || 'a peer'} · read-only</div>
				{/if}
			</div>
		{/each}

		{#snippet status()}
			<span id="underlay-status">Locked · hidden in Play · never exported{connected ? '' : ' · on this device'}</span>
		{/snippet}
	</ToolboxWindow>
{/if}

<style>
	/* one image's block: a full-width cell of the toolbox body's button grid (the .tbx-row rule) —
	   without it the block took one 36px cell and every slider in it measured 0px */
	.ul-item {
		grid-column: 1 / -1;
		min-width: 0;
		border-top: 1px solid var(--border);
		padding-top: 4px;
	}
	.ul-head {
		gap: 6px;
		align-items: center;
	}
	.ul-thumb {
		width: 28px;
		height: 28px;
		object-fit: cover;
		border-radius: 3px;
		flex: none;
	}
	.ul-name {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
