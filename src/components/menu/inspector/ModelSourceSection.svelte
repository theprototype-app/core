<script>
	// 59 T1/T2/T7a — Inspector ▸ Model: replace this object's model from a file, take it to Blender
	// (or any glTF tool) and back, and — while a saved file is watched — say so with its toggle.
	// The rows only START things: the replace / export / watch live in their modules, reached by a
	// dynamic import so none of it is in the boot graph.
	import Section from '../../ui/Section.svelte';
	import UiButton from '../../ui/Button.svelte';
	import { watchedModels } from '$lib/modelWatch';

	/** @type {{ object: any, locked?: boolean }} */
	let { object, locked = false } = $props();

	const watch = $derived(object ? $watchedModels[object.uuid] : null);
</script>

<Section variant="panel" label="Model" aliases={['Replace model', 'Edit in Blender', 'Reimport', 'Reload']}>
	<div id="model-source-section" class="flex flex-wrap gap-1">
		<UiButton
			id="model-source-replace"
			size="sm"
			variant="outline"
			icon="folder-input"
			disabled={locked}
			title="Pick a model file — this object keeps its place, name, links, flows, physics and behaviours (one undo)"
			onclick={() => import('$lib/modelReplace').then((m) => m.pickReplacementFile(object.uuid))}>Replace model…</UiButton
		>
		<UiButton
			id="model-source-blender"
			size="sm"
			variant="outline"
			icon="external-link"
			title="Download it as a .glb to edit in Blender (or any glTF tool), then drop the exported file back"
			onclick={() => import('$lib/editInBlender').then((m) => m.editInBlender(object.uuid))}>Edit in Blender…</UiButton
		>
	</div>
	{#if watch}
		<div id="model-source-watch" class="mt-1 flex flex-wrap items-center gap-2 text-xs">
			<span class="min-w-0 truncate text-text-muted" title={watch.fileName}>Watching <b>{watch.fileName}</b></span>
			<label class="flex items-center gap-1">
				<input
					id="model-source-auto"
					type="checkbox"
					class="tp-check"
					checked={watch.auto}
					onchange={(e) => {
						const on = e.currentTarget.checked;
						import('$lib/modelWatch').then((m) => m.setAutoReload(object.uuid, on));
					}}
				/>
				Reload automatically
			</label>
			<UiButton
				id="model-source-unwatch"
				size="sm"
				variant="ghost"
				onclick={() => import('$lib/modelWatch').then((m) => m.stopWatching(object.uuid))}>Stop</UiButton
			>
		</div>
	{/if}
</Section>
