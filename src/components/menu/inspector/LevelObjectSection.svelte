<script>
	// 93 LP1 / LP3: Inspector ▸ Portal / Checkpoint — the record on a selected Portal or Checkpoint object.
	// Writes go through setLevelObjectRecord: replicated, one undo entry each (the FlowPathSection shape).
	import Section from '../../ui/Section.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import InsToggle from './InsToggle.svelte';
	import { scenePhysicsState_ } from '$lib/scenePhysics';
	import { projectManifest, manifestSceneNames } from '$lib/projectManifest';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { isViewer } from '$lib/objectPermissions';
	import { normalizePortal, normalizeCheckpoint, BACK_TARGET } from '$lib/gameLevels/objects.js';

	/** @type {{object: any}} */
	let { object } = $props();
	const isPortal = $derived(!!object?.userData?.portal);
	const p = $derived(normalizePortal(object?.userData?.portal));
	const c = $derived(normalizeCheckpoint(object?.userData?.checkpoint));
	const viewer = $derived(isViewer());
	const rows = $derived(/** @type {any} */ ($scenePhysicsState_)?.levels?.list ?? []);
	const sceneNames = $derived($projectManifest ? manifestSceneNames() : []);
	/** the objects a portal can land on (Checkpoints and Portals first) */
	const spawnNames = $derived.by(() => {
		/** @type {string[]} */
		const out = [];
		$objectsGroup?.traverse?.((/** @type {any} */ o) => {
			if (o !== object && o.name && (o.userData?.checkpoint || o.userData?.portal)) out.push(o.name);
		});
		return [...new Set(out)].sort().slice(0, 80);
	});

	/** @param {any} patch */
	async function set(patch) {
		const m = await import('$lib/gameLevels/objectEdit.js');
		m.setLevelObjectRecord(object.uuid, isPortal ? 'portal' : 'checkpoint', patch);
	}
	const TRANSITIONS = [
		{ value: 'fade', label: 'Fade', title: 'Fade to black and back' },
		{ value: 'iris', label: 'Iris', title: 'A closing circle (a fade with reduced motion)' },
		{ value: 'card', label: 'Card', title: 'The level name and its goal' },
		{ value: 'none', label: 'Cut', title: 'No transition' }
	];
	const target = $derived(p.level ?? '');
</script>

{#if isPortal}
	<Section variant="panel" label="Portal" badge="Shared" aliases={['Door', 'Teleport', 'Level exit']}>
		<div id="portal-section" class="flex flex-col gap-2" data-keywords="portal door teleport level exit travel">
			<label class="flex items-center gap-2 text-xs text-text-muted">
				<span class="w-20 shrink-0">Goes to</span>
				<select
					id="portal-target"
					class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
					value={target}
					disabled={viewer}
					onchange={(e) => set({ level: e.currentTarget.value || null })}
				>
					<option value="">A scene or a spot</option>
					{#each rows as row (row.id)}<option value={row.id}>Level: {row.name}</option>{/each}
					<option value={BACK_TARGET}>Back where the player came from</option>
				</select>
			</label>
			{#if !target}
				<label class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Scene</span>
					<input
						id="portal-scene"
						class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
						list="portal-scene-names"
						placeholder="This scene"
						value={p.scene ?? ''}
						disabled={viewer}
						onchange={(e) => set({ scene: e.currentTarget.value.trim() || null })}
					/>
				</label>
			{/if}
			{#if target !== BACK_TARGET}
				<label class="flex items-center gap-2 text-xs text-text-muted">
					<span class="w-20 shrink-0">Arrive at</span>
					<input
						id="portal-spawn"
						class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
						list="portal-spawn-names"
						placeholder={target ? 'The level start' : 'The scene spawn'}
						value={p.spawn ?? ''}
						disabled={viewer}
						onchange={(e) => set({ spawn: e.currentTarget.value.trim() || null })}
					/>
				</label>
			{/if}
			<datalist id="portal-scene-names">
				{#each sceneNames as name (name)}<option value={name}></option>{/each}
			</datalist>
			<datalist id="portal-spawn-names">
				{#each spawnNames as name (name)}<option value={name}></option>{/each}
			</datalist>
			<div class="flex flex-col gap-1">
				<span class="text-xs text-text-muted" id="portal-transition-label">Transition</span>
				<Segmented id="portal-transition" labelledby="portal-transition-label" full options={TRANSITIONS} value={p.transition} disabled={viewer} onchange={(v) => set({ transition: v })} />
			</div>
			<InsToggle id="portal-show" checked={p.show} disabled={viewer} onchange={(e) => set({ show: e.currentTarget.checked })}>Show the doorway in Play</InsToggle>
			<p class="text-[length:var(--fs-desc)] text-text-muted">
				Walking in takes only that player through. The target scene starts loading while the player is near.
			</p>
		</div>
	</Section>
{:else}
	<Section variant="panel" label="Checkpoint" badge="Shared" aliases={['Respawn point', 'Save point']}>
		<div id="checkpoint-section" class="flex flex-col gap-2" data-keywords="checkpoint respawn save point progress">
			<label class="flex items-center gap-2 text-xs text-text-muted">
				<span class="w-20 shrink-0">Message</span>
				<input
					id="checkpoint-label"
					class="ui-input min-w-0 flex-1 px-1 py-0.5 text-xs"
					placeholder="Checkpoint"
					value={c.label ?? ''}
					disabled={viewer}
					onchange={(e) => set({ label: e.currentTarget.value.trim() || null })}
				/>
			</label>
			<InsToggle id="checkpoint-show" checked={c.show} disabled={viewer} onchange={(e) => set({ show: e.currentTarget.checked })}>Show the message when reached</InsToggle>
			<p class="text-[length:var(--fs-desc)] text-text-muted">
				Each player respawns at the last checkpoint they stepped on. An exported game saves it on the player's device.
			</p>
		</div>
	</Section>
{/if}
