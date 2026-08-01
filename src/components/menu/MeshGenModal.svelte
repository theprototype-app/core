<script lang="ts">
	// Generate 3D model modal (roadmap #11, G6): a direct (no-LLM) entry point to
	// mesh generation. Opened from the Add menu; kicks a meshJobs job (progress shows
	// in the MeshJobsCard). Rendered at the component root (not inside a filtered
	// ancestor) so its fixed positioning is correct.
	import { meshGenModalOpen } from '../../stores/appStore';
	import { meshProviders, meshActiveProvider, setMeshActiveProvider, activeMeshConfig } from '$lib/ai/meshProviders';
	import { generateMesh } from '$lib/ai/meshJobs';

	let prompt = $state('');
	let name = $state('');

	const active = $derived($meshProviders.find((p) => p.id === $meshActiveProvider) ?? null);
	const isHosted = $derived(active?.kind === 'meshy');

	function close() {
		meshGenModalOpen.set(null);
		prompt = '';
		name = '';
	}

	function onBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}

	function submit() {
		const text = prompt.trim();
		if (!text) return;
		const position = $meshGenModalOpen?.position ?? undefined;
		generateMesh({ prompt: text, name: name.trim() || undefined, position }).catch(() => {});
		close();
	}

	function onProvider(e: Event) {
		setMeshActiveProvider((e.currentTarget as HTMLSelectElement).value || null);
	}
</script>

{#if $meshGenModalOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
	<div class="mesh-gen-backdrop" role="presentation" onclick={onBackdrop}>
		<div
			class="ui-panel mesh-gen-modal flex w-[min(460px,92vw)] flex-col gap-3 bg-gray-900/95 p-4 backdrop-blur-sm"
			role="dialog"
			aria-modal="true"
			aria-label="Generate 3D model"
		>
			<div class="flex items-center">
				<span class="text-sm font-semibold">✨ Generate 3D model</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Close" onclick={close}>✕</button>
			</div>

			{#if $meshProviders.length}
				<label class="flex flex-col gap-1 text-xs text-gray-300">
					Provider
					<select class="ui-input" value={$meshActiveProvider ?? ''} onchange={onProvider}>
						{#each $meshProviders as p (p.id)}
							<option value={p.id}>{p.label}</option>
						{/each}
					</select>
				</label>
			{:else}
				<p class="text-xs text-amber-300">No mesh provider configured — add one in Settings → AI → Mesh generation.</p>
			{/if}

			<label class="flex flex-col gap-1 text-xs text-gray-300">
				Prompt
				<textarea
					class="ui-input min-h-[64px] resize-y"
					placeholder="a weathered wooden treasure chest with iron bands"
					bind:value={prompt}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
					}}
				></textarea>
			</label>

			<label class="flex flex-col gap-1 text-xs text-gray-300">
				Name (optional)
				<input class="ui-input" placeholder="Treasure chest" bind:value={name} />
			</label>

			{#if isHosted}
				<p class="text-[11px] text-amber-300/90">Uses your {active?.label} account credits.</p>
			{/if}

			<div class="flex items-center gap-2">
				<button
					class="rounded-lg bg-primary-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
					disabled={!prompt.trim() || !$meshProviders.length}
					onclick={submit}
				>
					Generate
				</button>
				<span class="text-[11px] text-gray-400">Takes ~1–3 min; it appears in the scene when ready.</span>
			</div>
		</div>
	</div>
{/if}

<style>
	.mesh-gen-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal);
	}
</style>
