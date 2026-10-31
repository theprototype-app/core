<script>
	// 57 M2 — APPLY CLIP…: play a clip on any mapped humanoid. Pick the clip (a model in the scene
	// that plays it, or the built-in avatar motions; 57 M1's .tpanim assets join the list when that
	// lands), tick the characters, Apply. Each target RETARGETS it for itself on every peer (the
	// config replicates, the result never travels), so the models' bytes never change.
	// Non-modal like every app dialog; mounted lazily by CharacterDialogs.
	import { onMount } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { applyClipRequest } from '$lib/characterUi.js';
	import { showToast } from '../../stores/appStore';
	import { humanoidsInScene, clipSourcesInScene, applyClipTo } from '$lib/humanoid/humanoidRig.js';
	import { rigLabel, boneLabel } from '$lib/humanoid/humanoidMap.js';

	let open = $state(true);
	/** @type {{label: string, src: any, group: string}[]} */
	let sources = $state.raw([]);
	let sourceKey = $state('');
	/** @type {{uuid: string, name: string, rig: string, ok: boolean, missing: string[]}[]} */
	let targets = $state.raw([]);
	/** @type {Record<string, boolean>} */
	let picked = $state({});
	let busy = $state(false);

	const keyOf = (/** @type {any} */ src) => JSON.stringify(src);

	onMount(async () => {
		const req = $applyClipRequest ?? {};
		targets = humanoidsInScene();
		/** @type {Record<string, boolean>} */
		const p = {};
		const pre = new Set(req.targets ?? []);
		for (const t of targets) p[t.uuid] = t.ok && (pre.size ? pre.has(t.uuid) : false);
		picked = p;
		sources = await clipSourcesInScene();
		const want = req.src ? keyOf(req.src) : '';
		sourceKey = sources.some((s) => keyOf(s.src) === want)
			? want
			: sources[0]
				? keyOf(sources[0].src)
				: '';
	});

	const items = $derived(
		sources.map((s) => ({ value: keyOf(s.src), name: s.group + ' ▸ ' + s.label }))
	);
	const chosen = $derived(sources.find((s) => keyOf(s.src) === sourceKey) ?? null);
	const count = $derived(Object.values(picked).filter(Boolean).length);

	function close() {
		applyClipRequest.set(null);
	}

	async function apply() {
		if (!chosen || !count || busy) return;
		busy = true;
		try {
			const uuids = targets.filter((t) => picked[t.uuid]).map((t) => t.uuid);
			const { applied, refused } = await applyClipTo(uuids, chosen.src);
			if (applied.length)
				showToast(
					'"' +
						chosen.label +
						'" applied to ' +
						applied.length +
						(applied.length === 1 ? ' character' : ' characters')
				);
			for (const r of refused)
				showToast(
					(targets.find((t) => t.uuid === r.uuid)?.name ?? 'A character') +
						': not applied — ' +
						r.why
				);
			if (applied.length) close();
		} finally {
			busy = false;
		}
	}
</script>

<ModalDialog
	title="Apply clip"
	bind:open
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	oncancel={close}
	outsideclose
	width="sm"
	id="apply-clip-dialog"
>
	<div class="flex flex-col gap-2 text-sm">
		<p class="text-text-muted text-xs">
			Plays the clip on each character you tick: it is fitted to that character's own skeleton on
			every peer. The models themselves never change.
		</p>
		<label class="text-text-muted text-xs" for="apply-clip-source">Clip</label>
		{#if items.length}
			<ThemedSelect id="apply-clip-source" {items} bind:value={sourceKey} />
		{:else}
			<p id="apply-clip-nosource" class="text-text-muted text-xs">
				No clips yet — import an animated model or a clip file.
			</p>
		{/if}
		<span class="text-text-muted text-xs">Characters</span>
		<div id="apply-clip-targets" class="ac-list" use:minimalScroll>
			{#if !targets.length}
				<p class="text-text-muted p-2 text-xs">
					No rigged characters in the scene. Import a .vrm, .glb or .fbx with a skeleton.
				</p>
			{/if}
			{#each targets as t (t.uuid)}
				<div class="ac-row" data-uuid={t.uuid}>
					<label class="ac-pick">
						<Checkbox
							checked={!!picked[t.uuid]}
							disabled={!t.ok || ('uuid' in (chosen?.src ?? {}) && chosen?.src.uuid === t.uuid)}
							label={t.name}
							onchange={(/** @type {boolean} */ v) => (picked = { ...picked, [t.uuid]: v })}
						/>
						<span>{t.name}</span>
					</label>
					<span
						class="ac-rig"
						title={t.ok
							? 'Humanoid map detected'
							: 'Missing: ' + t.missing.map(boneLabel).join(', ')}
					>
						{rigLabel(t.rig)}{t.ok ? '' : ' · not mapped'}
					</span>
				</div>
			{/each}
		</div>
	</div>
	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button
				id="apply-clip-go"
				variant="primary"
				disabled={!chosen || !count || busy}
				onclick={apply}
			>
				{count > 1 ? 'Apply to ' + count : 'Apply'}
			</Button>
		</div>
	{/snippet}
</ModalDialog>

<style>
	.ac-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 40vh;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 4px;
	}
	.ac-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 2px 4px;
	}
	.ac-pick {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
		cursor: pointer;
	}
	.ac-rig {
		font-size: var(--fs-badge);
		color: var(--text-faint);
		white-space: nowrap;
	}
</style>
