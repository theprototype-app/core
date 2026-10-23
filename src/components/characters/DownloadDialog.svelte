<script>
	// 57 M9 — Object ▸ Download…: a character with the clips you tick, as (a) one GLB with them
	// embedded (default, fork F4), (b) the model + one .tpanim per clip in a zip, or (c) the model
	// only; or ONE clip as .tpanim / .glb / .vrma / .bvh. FBX / USD are listed but off, with the
	// reason (they need an AI box with the `convert` capability, roadmap 58). Several objects download
	// as one zip. The licence warnings sit on top (M7: warn, never block). Lazy (CharacterDialogs).
	import { onMount } from 'svelte';
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import LicenceWarnings from '../menu/LicenceWarnings.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { downloadRequest } from '$lib/characterUi.js';
	import { showToast } from '../../stores/appStore';
	import {
		downloadPlan,
		buildDownload,
		clipFile,
		saveFile,
		CLIP_FORMATS,
		CONVERT_FORMATS
	} from '$lib/download/characterDownload.js';

	let open = $state(true);
	/** @type {any[]} */
	let plans = $state.raw([]);
	/** @type {Record<string, boolean>} uuid|clip -> ticked */
	let ticked = $state({});
	let layout = $state('a');
	let mode = $state('model');
	let clipPick = $state('');
	let format = $state('tpanim');
	let busy = $state(false);

	const uuids = $derived($downloadRequest?.uuids ?? []);
	const single = $derived(plans.length === 1 ? plans[0] : null);
	const key = (/** @type {string} */ u, /** @type {string} */ c) => u + '|' + c;

	onMount(async () => {
		plans = (await Promise.all(uuids.map((u) => downloadPlan(u).catch(() => null)))).filter(
			Boolean
		);
		/** @type {Record<string, boolean>} */
		const t = {};
		for (const p of plans) for (const c of p.clips) t[key(p.uuid, c.name)] = true;
		ticked = t;
		clipPick = plans[0]?.clips[0]?.name ?? '';
	});

	const picks = $derived(
		plans.map((p) => ({
			uuid: p.uuid,
			clips: p.clips
				.filter((/** @type {any} */ c) => ticked[key(p.uuid, c.name)])
				.map((/** @type {any} */ c) => c.name)
		}))
	);
	const clipCount = $derived(picks.reduce((n, p) => n + p.clips.length, 0));

	function close() {
		downloadRequest.set(null);
	}

	async function go() {
		if (busy || !plans.length) return;
		busy = true;
		try {
			if (single && mode === 'clip') {
				const f = await clipFile(single.uuid, clipPick, /** @type {any} */ (format));
				await saveFile(f);
				showToast('Downloaded ' + f.name);
			} else {
				const f = await buildDownload(picks, /** @type {any} */ (layout));
				await saveFile(f);
				showToast(
					'Downloaded ' +
						f.name +
						(clipCount && layout !== 'c'
							? ' (' + clipCount + (clipCount === 1 ? ' clip)' : ' clips)')
							: '')
				);
				for (const n of f.notes) showToast(n);
			}
			close();
		} catch (error) {
			showToast('Download failed: ' + String(/** @type {any} */ (error)?.message ?? error));
		} finally {
			busy = false;
		}
	}
</script>

<ModalDialog
	title="Download"
	bind:open
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	oncancel={close}
	outsideclose
	width="sm"
	id="download-dialog"
>
	<div class="flex flex-col gap-2 text-sm">
		<LicenceWarnings where="download" {uuids} id="licence-warnings-download" />
		{#if single}
			<Segmented
				id="download-mode"
				label="What to download"
				options={[
					{ value: 'model', label: 'Character' },
					{ value: 'clip', label: 'One clip', disabled: !single.clips.length }
				]}
				bind:value={mode}
			/>
		{/if}
		{#if !single || mode === 'model'}
			<span class="text-text-muted text-xs">Layout</span>
			<Segmented
				id="download-layout"
				label="Layout"
				options={[
					{
						value: 'a',
						label: 'One GLB',
						title:
							'The model with the ticked clips embedded — what Blender, Unity, Unreal and Godot expect'
					},
					{
						value: 'b',
						label: 'Model + clips',
						title: 'A zip: the model and one .tpanim per clip'
					},
					{ value: 'c', label: 'Model only', title: 'The model without its clips' }
				]}
				bind:value={layout}
			/>
			{#if layout !== 'c'}
				<span class="text-text-muted text-xs">Clips</span>
				<div id="download-clips" class="dl-list" use:minimalScroll>
					{#each plans as p (p.uuid)}
						{#if plans.length > 1}<span class="dl-obj">{p.name}</span>{/if}
						{#if !p.clips.length}<span class="dl-none"
								>No clips — apply some with Character ▸ Apply clip…</span
							>{/if}
						{#each p.clips as c (c.name)}
							<label class="dl-row" data-clip={c.name}>
								<Checkbox
									checked={!!ticked[key(p.uuid, c.name)]}
									label={c.name}
									onchange={(/** @type {boolean} */ v) =>
										(ticked = { ...ticked, [key(p.uuid, c.name)]: v })}
								/>
								<span class="min-w-0 flex-1 truncate">{c.name}</span>
								<span class="dl-meta"
									>{c.applied ? 'applied · baked onto this skeleton' : 'its own'} · {c.duration.toFixed(
										2
									)}s</span
								>
							</label>
						{/each}
					{/each}
				</div>
			{/if}
		{:else}
			<span class="text-text-muted text-xs">Clip</span>
			<select id="download-clip" class="ui-input" bind:value={clipPick} aria-label="Clip">
				{#each single.clips as c (c.name)}<option value={c.name}>{c.name}</option>{/each}
			</select>
			<span class="text-text-muted text-xs">Format</span>
			<div id="download-formats" class="flex flex-col gap-1">
				{#each CLIP_FORMATS as f (f.id)}
					{@const off = f.needs === 'humanoid' && !single.humanoid}
					<label
						class="dl-row"
						class:dl-off={off}
						title={off ? 'Needs a humanoid character (map its bones in Skeleton…)' : ''}
					>
						<input type="radio" name="dl-format" value={f.id} bind:group={format} disabled={off} />
						<span>{f.label}</span>
					</label>
				{/each}
				{#each CONVERT_FORMATS as f (f.id)}
					<label
						class="dl-row dl-off"
						data-format={f.id}
						title="Needs an AI box with the convert capability (roadmap 58)"
					>
						<input type="radio" name="dl-format" disabled />
						<span
							>{f.label} — needs an AI box with the <i>convert</i> capability; use .glb or .bvh meanwhile</span
						>
					</label>
				{/each}
			</div>
		{/if}
		{#if single && mode === 'model' && !single.glb}
			<p class="text-text-muted text-xs">
				This model was a {single.kind.toUpperCase()} file — it downloads as glTF (materials may look simpler).
			</p>
		{/if}
	</div>
	{#snippet footer()}
		<div class="flex justify-end gap-2">
			<Button variant="ghost" onclick={close}>Cancel</Button>
			<Button
				id="download-go"
				variant="primary"
				disabled={busy || !plans.length || (mode === 'clip' && !clipPick)}
				onclick={go}>Download</Button
			>
		</div>
	{/snippet}
</ModalDialog>

<style>
	.dl-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 36vh;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 4px;
	}
	.dl-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 2px 4px;
		cursor: pointer;
	}
	.dl-off {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.dl-obj {
		font-weight: 600;
		padding: 4px 4px 0;
	}
	.dl-none,
	.dl-meta {
		font-size: var(--fs-badge);
		color: var(--text-faint);
		white-space: nowrap;
	}
	.dl-none {
		padding: 2px 4px;
	}
</style>
