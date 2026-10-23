<script>
	// 57 M6 (+ M2's map editor) — THE SKELETON VIEW for one rigged model, three tabs:
	//   Humanoid map  every VRM 1.0 humanoid bone and the rig bone it is mapped to (detected, or your
	//                 fix — a replicated config, the model's bytes never change)
	//   Bones         the bone tree: rename, move in the rest pose, add a child, delete, mirror L <-> R
	//   Weights       automatic weights (heat diffusion in a worker), smooth, normalize, a weight
	//                 brush for one bad area with a live test pose
	// Bones and Weights edit the FILE: each operation (a brush stroke is one) rewrites the GLB and
	// sends it once, undoable. Opened from Inspector ▸ Character ▸ Skeleton… (lazy, CharacterDialogs).
	import { onMount, onDestroy } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { skeletonTarget } from '$lib/characterUi.js';
	import {
		sceneRevision,
		globalCamera,
		globalRenderer,
		objectsGroup
	} from '../../stores/sceneStore';
	import { VRM_BONES, REQUIRED_BONES, boneLabel, rigLabel } from '$lib/humanoid/humanoidMap.js';
	import {
		humanoidOf,
		setMapBone,
		applyHumanoidConfig,
		configOf
	} from '$lib/humanoid/humanoidRig.js';
	import * as rig from '$lib/rig/rigFixes.js';
	import * as THREE from 'three';

	const pickedBone = rig.pickedBone;
	const rigBusy = rig.rigBusy;

	let open = $state(true);
	let tab = $state('map');
	let showFingers = $state(false);
	let renameTo = $state('');
	let newChild = $state('');
	/** @type {number[]} */
	let restT = $state([0, 0, 0]);
	let brushOn = $state(false);
	let radius = $state(0.08);
	let strength = $state(0.5);
	let erase = $state(false);
	let bend = $state(0);

	const uuid = $derived($skeletonTarget ?? '');
	const info = $derived.by(() => {
		void $sceneRevision;
		return uuid ? rig.rigInfo(uuid) : null;
	});
	const human = $derived.by(() => {
		void $sceneRevision;
		void info;
		return uuid ? humanoidOf(uuid) : null;
	});
	const boneNames = $derived(info ? info.bones.filter((b) => b.bone).map((b) => b.name) : []);
	const rows = $derived(
		VRM_BONES.filter((b) => showFingers || !/(Thumb|Index|Middle|Ring|Little)/.test(b.name))
	);
	/** VRM bone each rig bone maps to */
	const mappedAs = $derived(
		human ? Object.fromEntries(Object.entries(human.map).map(([k, v]) => [v, k])) : {}
	);

	$effect(() => {
		const b = info?.bones.find((x) => x.name === $pickedBone);
		renameTo = $pickedBone;
		if (b) restT = b.t.map((/** @type {number} */ v) => +v.toFixed(4));
	});
	$effect(() => {
		void $pickedBone;
		void info;
		if (uuid) rig.refreshHelpers(uuid);
	});
	$effect(() => {
		if (uuid && $pickedBone) rig.testPose(uuid, $pickedBone, bend);
	});

	onMount(() => {
		if (uuid) rig.refreshHelpers(uuid);
	});
	onDestroy(() => {
		rig.closeSession(uuid);
		detachBrush();
	});

	function close() {
		skeletonTarget.set(null);
	}

	/** @param {string} bone @param {string} value */
	function pickMap(bone, value) {
		setMapBone(uuid, bone, value === '__detected' ? null : value === '__none' ? '' : value);
	}

	// ---- the brush: pointer on the canvas paints the picked bone's weight -------------------
	/** @type {HTMLCanvasElement | null} */
	let canvas = null;
	let painting = false;
	const ray = new THREE.Raycaster();
	/** @param {PointerEvent} e */
	function hit(e) {
		const cam = /** @type {any} */ ($globalCamera);
		const root = /** @type {any} */ ($objectsGroup)?.getObjectByProperty('uuid', uuid);
		if (!cam || !root || !canvas) return null;
		const r = canvas.getBoundingClientRect();
		ray.setFromCamera(
			new THREE.Vector2(
				((e.clientX - r.left) / r.width) * 2 - 1,
				-((e.clientY - r.top) / r.height) * 2 + 1
			),
			cam
		);
		const h = ray
			.intersectObject(root, true)
			.find((x) => /** @type {any} */ (x.object).isSkinnedMesh);
		return h ? h.point.toArray() : null;
	}
	/** @param {PointerEvent} e */
	function down(e) {
		if (!brushOn || !$pickedBone || e.button !== 0 || e.target !== canvas) return;
		const p = hit(e);
		if (!p) return;
		e.stopPropagation();
		e.stopImmediatePropagation();
		e.preventDefault();
		painting = true;
		rig.beginStroke(uuid, $pickedBone);
		rig.strokeAt(p, radius, erase ? -strength : strength);
	}
	/** @param {PointerEvent} e */
	function move(e) {
		if (!painting) return;
		e.stopPropagation();
		const p = hit(e);
		if (p) rig.strokeAt(p, radius, (erase ? -strength : strength) * 0.25);
	}
	/** @param {PointerEvent} e */
	function up(e) {
		if (!painting) return;
		e.stopPropagation();
		painting = false;
		void rig.endStroke();
	}
	function attachBrush() {
		canvas = /** @type {any} */ ($globalRenderer)?.domElement ?? null;
		// window CAPTURE, so the stroke is claimed before the viewport's own handlers (select, orbit)
		window.addEventListener('pointerdown', down, true);
		window.addEventListener('pointermove', move, true);
		window.addEventListener('pointerup', up, true);
	}
	function detachBrush() {
		window.removeEventListener('pointerdown', down, true);
		window.removeEventListener('pointermove', move, true);
		window.removeEventListener('pointerup', up, true);
		canvas = null;
	}
	$effect(() => {
		if (brushOn) attachBrush();
		else detachBrush();
		return detachBrush;
	});
</script>

<ModalDialog
	title={'Skeleton' + (human ? ' · ' + rigLabel(human.rig) : '')}
	bind:open
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	oncancel={close}
	outsideclose={false}
	width="sm"
	frame={false}
	class="sk-floating"
	id="skeleton-window"
>
	{#snippet bar()}
		<Tabs
			tabs={[
				{ id: 'map', label: 'Humanoid map' },
				{ id: 'bones', label: 'Bones' },
				{ id: 'weights', label: 'Weights' }
			]}
			idPrefix="skeleton"
			label="Skeleton tools"
			value={tab}
			onchange={(/** @type {string} */ id) => (tab = id)}
		/>
	{/snippet}
	{#if info}
		<div class="flex flex-col gap-2 text-xs" data-busy={$rigBusy ? '1' : '0'}>
			{#if tab === 'map'}
				<p class="text-text-muted">
					{human?.ok
						? 'A full humanoid'
						: 'Missing: ' + (human?.missing ?? REQUIRED_BONES).map(boneLabel).join(', ')} — {Object.keys(
						human?.map ?? {}
					).length} of 55 bones mapped ({human?.via === 'file'
						? 'from the file'
						: human?.via === 'structure'
							? 'from its shape — check it'
							: 'from bone names'}). A fix here changes no file.
				</p>
				<div id="skeleton-map" class="sk-list" use:minimalScroll>
					{#each rows as b (b.name)}
						{@const cur = human?.map[b.name] ?? ''}
						{@const fixed = human ? b.name in human.overrides : false}
						<label class="sk-row" data-vrm-bone={b.name} class:sk-req={b.required && !cur}>
							<span class="sk-label">{boneLabel(b.name)}{b.required ? ' *' : ''}</span>
							<select
								class="ui-input sk-select"
								value={fixed ? cur || '__none' : '__detected'}
								onchange={(e) => pickMap(b.name, e.currentTarget.value)}
								aria-label={'Rig bone for ' + boneLabel(b.name)}
							>
								<option value="__detected"
									>{human?.detected[b.name]
										? 'detected: ' + human.detected[b.name]
										: 'detected: —'}</option
								>
								<option value="__none">— not mapped —</option>
								{#each boneNames as n (n)}<option value={n}>{n}</option>{/each}
							</select>
						</label>
					{/each}
				</div>
				<div class="flex flex-wrap gap-1">
					<Button size="sm" variant="ghost" onclick={() => (showFingers = !showFingers)}
						>{showFingers ? 'Hide fingers' : 'Show fingers'}</Button
					>
					<Button
						id="skeleton-map-reset"
						size="sm"
						variant="warn-text"
						disabled={!human || !Object.keys(human.overrides).length}
						onclick={() => applyHumanoidConfig(uuid, { ...configOf(uuid), map: undefined })}
						>Reset fixes</Button
					>
				</div>
			{:else}
				<div id="skeleton-bones" class="sk-list sk-tree" use:minimalScroll>
					{#each info.bones as b (b.name)}
						<button
							type="button"
							class="sk-bone"
							class:sk-picked={$pickedBone === b.name}
							class:sk-node={!b.bone}
							style="padding-left: {4 + b.depth * 10}px"
							data-bone={b.name}
							onclick={() => pickedBone.set(b.name)}
						>
							<span class="min-w-0 truncate">{b.name}</span>
							{#if mappedAs[b.name]}<span class="sk-chip">{boneLabel(mappedAs[b.name])}</span>{/if}
						</button>
					{/each}
				</div>
				{#if !info.editable}
					<p class="text-ink-warn">
						This model is a {info.kind.toUpperCase()} file: rig fix-ups edit GLB / VRM files. Download
						it as GLB and import that.
					</p>
				{:else if tab === 'bones'}
					{#if $pickedBone}
						<div class="flex items-center gap-1">
							<input
								id="skeleton-rename"
								class="ui-input min-w-0 flex-1"
								bind:value={renameTo}
								aria-label="Bone name"
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={$rigBusy || !renameTo.trim() || renameTo === $pickedBone}
								onclick={() => rig.renameBone(uuid, $pickedBone, renameTo.trim())}>Rename</Button
							>
						</div>
						<div class="flex items-center gap-1" id="skeleton-rest">
							<span class="text-text-muted">Rest</span>
							{#each [0, 1, 2] as k (k)}
								<input
									class="ui-input sk-num"
									type="number"
									step="0.01"
									aria-label={'Rest ' + 'xyz'[k]}
									value={restT[k]}
									oninput={(e) =>
										(restT = restT.map((v, i) => (i === k ? +e.currentTarget.value : v)))}
								/>
							{/each}
							<Button
								size="sm"
								variant="outline"
								disabled={$rigBusy}
								onclick={() => rig.moveBone(uuid, $pickedBone, restT)}>Move</Button
							>
						</div>
						<div class="flex items-center gap-1">
							<input
								id="skeleton-child"
								class="ui-input min-w-0 flex-1"
								placeholder="new bone name"
								bind:value={newChild}
								aria-label="New bone name"
							/>
							<Button
								size="sm"
								variant="outline"
								disabled={$rigBusy || !newChild.trim()}
								onclick={() => rig.addBone(uuid, $pickedBone, newChild.trim())}>Add child</Button
							>
							<Button
								size="sm"
								variant="warn-text"
								disabled={$rigBusy}
								onclick={() => rig.deleteBone(uuid, $pickedBone)}>Delete</Button
							>
						</div>
					{:else}
						<p class="text-text-muted">Pick a bone in the list.</p>
					{/if}
					<div class="flex flex-wrap gap-1">
						<Button
							id="skeleton-mirror-lr"
							size="sm"
							variant="outline"
							disabled={$rigBusy}
							onclick={() => rig.mirrorBones(uuid, 'left')}>Mirror left → right</Button
						>
						<Button
							id="skeleton-mirror-rl"
							size="sm"
							variant="outline"
							disabled={$rigBusy}
							onclick={() => rig.mirrorBones(uuid, 'right')}>Mirror right → left</Button
						>
					</div>
				{:else}
					<div class="flex flex-wrap gap-1">
						<Button
							id="skeleton-auto-weights"
							size="sm"
							variant="outline"
							disabled={$rigBusy}
							onclick={() => rig.autoWeights(uuid)}>Automatic weights</Button
						>
						<Button
							size="sm"
							variant="outline"
							disabled={$rigBusy}
							onclick={() => rig.smoothAll(uuid)}>Smooth</Button
						>
						<Button
							size="sm"
							variant="outline"
							disabled={$rigBusy}
							onclick={() => rig.normalizeAll(uuid)}>Normalize</Button
						>
					</div>
					<label class="flex items-center gap-2">
						<input
							id="skeleton-brush"
							type="checkbox"
							class="tp-check"
							bind:checked={brushOn}
							disabled={!$pickedBone}
						/>
						<span>Weight brush for {$pickedBone || '(pick a bone)'} — paint on the model</span>
					</label>
					{#if brushOn}
						<div class="flex items-center gap-2">
							<span class="text-text-muted w-16">Radius</span><input
								type="range"
								min="0.01"
								max="0.5"
								step="0.01"
								bind:value={radius}
								aria-label="Brush radius"
								class="accent-accent flex-1"
							/>
						</div>
						<div class="flex items-center gap-2">
							<span class="text-text-muted w-16">Strength</span><input
								type="range"
								min="0.05"
								max="1"
								step="0.05"
								bind:value={strength}
								aria-label="Brush strength"
								class="accent-accent flex-1"
							/>
							<label class="flex items-center gap-1"
								><input type="checkbox" class="tp-check" bind:checked={erase} /> erase</label
							>
						</div>
					{/if}
					<div class="flex items-center gap-2">
						<span class="text-text-muted w-16">Test pose</span>
						<input
							type="range"
							min="-90"
							max="90"
							step="1"
							bind:value={bend}
							disabled={!$pickedBone}
							aria-label="Bend the picked bone"
							class="accent-accent flex-1"
						/>
						<span class="w-10 tabular-nums">{bend}°</span>
					</div>
					<p class="text-text-faint">
						Bends the picked bone here only, to see the weights work. Each stroke is saved and sent
						when you lift.
					</p>
				{/if}
			{/if}
		</div>
	{/if}
</ModalDialog>

<style>
	/* a FLOATING panel at the right, not the dimmed modal tier: the viewport stays live under it
	   (the brush paints on it, the test pose is watched there) */
	:global(dialog.sk-floating) {
		position: fixed;
		inset: 72px 16px auto auto;
		margin: 0;
		z-index: var(--z-modal);
		width: 420px;
		max-width: calc(100vw - 32px);
		max-height: 78vh;
		display: flex;
		flex-direction: column;
	}
	@media (max-width: 640px) {
		:global(dialog.sk-floating) {
			inset: auto 8px 8px 8px;
			width: auto;
			max-height: 60vh;
		}
	}
	.sk-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
		max-height: 44vh;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 4px;
	}
	.sk-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.sk-label {
		width: 9rem;
		flex-shrink: 0;
		color: var(--text-muted);
	}
	.sk-req .sk-label {
		color: var(--ink-warn);
	}
	.sk-select {
		min-width: 0;
		flex: 1;
	}
	.sk-bone {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		text-align: left;
		border-radius: 4px;
		padding-top: 1px;
		padding-bottom: 1px;
	}
	.sk-bone:hover {
		background: var(--surface-hover);
	}
	.sk-picked {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.sk-node {
		color: var(--text-faint);
	}
	.sk-chip {
		font-size: var(--fs-badge);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.sk-num {
		width: 4.5rem;
	}
</style>
