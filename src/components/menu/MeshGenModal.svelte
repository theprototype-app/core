<script lang="ts">
	// Generate 3D model modal (roadmap #11, G6): a direct (no-LLM) entry point to
	// mesh generation. Opened from the Add menu; kicks a meshJobs job (progress shows
	// in the MeshJobsCard). Rendered at the component root (not inside a filtered
	// ancestor) so its fixed positioning is correct.
	import { meshGenModalOpen } from '../../stores/appStore';
	// Roadmap 73 AI1: or from a picture (a photo, an Explorer image, the viewport) — prepared like a chat
	// picture (downscaled, metadata stripped on this device), then the same job and the same import.
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { showToast } from '../../stores/appStore';
	import { meshProviders, meshActiveProvider, setMeshActiveProvider, meshTakesImage } from '$lib/ai/meshProviders';
	import { generateMesh } from '$lib/ai/meshJobs';
	import { explorerItems } from '$lib/explorer';
	import { prepareImage, viewportPicture, explorerPicture } from '$lib/chat/attachments.js';
	import { MESH_IMAGE } from '$lib/chat/attachCore.js';
	import { rolesInfo } from '$lib/cloudHooks';

	let prompt = $state('');
	let name = $state('');
	/** the prepared picture, or null: text-to-3D as before */
	let image: any = $state(null);
	let busy = $state(false);
	let fileInput: HTMLInputElement | null = $state(null);
	let cameraInput: HTMLInputElement | null = $state(null);
	/** a closed or re-picked dialog ignores a prepare still running */
	let pickToken = 0;

	const phone = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
	const explorerImages = $derived(
		($explorerItems as any[])
			.filter((i) => i.kind === 'image')
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.slice(0, 24)
	);

	const active = $derived($meshProviders.find((p) => p.id === $meshActiveProvider) ?? null);
	const isHosted = $derived(active?.kind === 'meshy');
	// C5's rule: viewers attach nothing
	const takesImage = $derived(meshTakesImage(active) && ($rolesInfo as any)?.myRole !== 'viewer');
	const ready = $derived(!!(prompt.trim() || (image && takesImage)));

	// the Explorer menu's "Make a 3D model…" opens with the picture already chosen
	let seededFrom: string | null = null;
	$effect(() => {
		const itemId = ($meshGenModalOpen as any)?.imageItemId ?? null;
		if (itemId && itemId !== seededFrom) void pick(() => explorerPicture(itemId, MESH_IMAGE));
		seededFrom = itemId;
	});

	function close() {
		meshGenModalOpen.set(null);
		prompt = '';
		name = '';
		image = null;
		busy = false;
		pickToken++;
	}

	async function pick(make: () => Promise<any>) {
		const token = ++pickToken;
		busy = true;
		const r = await make();
		if (token !== pickToken) return;
		busy = false;
		if (r?.error) showToast(r.error);
		else image = r;
	}

	function onFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = ''; // the same file can be picked again
		if (file) void pick(() => prepareImage(file, file.name, MESH_IMAGE));
	}

	function onExplorerPick(e: Event) {
		const select = e.currentTarget as HTMLSelectElement;
		const id = select.value;
		select.value = '';
		if (id) void pick(() => explorerPicture(id, MESH_IMAGE));
	}

	function onPaste(e: ClipboardEvent) {
		if (!takesImage) return;
		const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'));
		if (!file) return;
		e.preventDefault();
		void pick(() => prepareImage(file, file.name, MESH_IMAGE));
	}

	function onDrop(e: DragEvent) {
		const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.type.startsWith('image/'));
		if (!file) return;
		e.preventDefault();
		e.stopPropagation(); // the viewport under the dialog must not place the file too
		if (takesImage) void pick(() => prepareImage(file, file.name, MESH_IMAGE));
	}

	function onBackdrop(e: MouseEvent) {
		if (e.target === e.currentTarget) close();
	}

	function submit() {
		const text = prompt.trim();
		const picture = takesImage ? image : null;
		if (!text && !picture) return;
		const position = $meshGenModalOpen?.position ?? undefined;
		generateMesh({ prompt: text, name: name.trim() || undefined, position, ...(picture ? { image: picture } : {}) }).catch(() => {});
		close();
	}

	function onProvider(e: Event) {
		setMeshActiveProvider((e.currentTarget as HTMLSelectElement).value || null);
	}
</script>

{#if $meshGenModalOpen}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions a11y_no_noninteractive_element_interactions -->
	<div class="mesh-gen-backdrop" role="presentation" onclick={onBackdrop} onpaste={onPaste} ondrop={onDrop} ondragover={(e) => e.preventDefault()}>
		<div
			class="ui-panel mesh-gen-modal flex max-h-[92dvh] w-[min(460px,92vw)] flex-col gap-3 overflow-y-auto bg-surface-1/95 p-4 backdrop-blur-sm"
			use:minimalScroll
			role="dialog"
			aria-modal="true"
			aria-label="Generate 3D model"
		>
			<div class="flex items-center">
				<span class="text-sm font-semibold">✨ Generate 3D model</span>
				<span class="flex-1"></span>
				<button class="ui-button-quiet" title="Close" aria-label="Close" onclick={close}>✕</button>
			</div>

			{#if $meshProviders.length}
				<label class="flex flex-col gap-1 text-xs text-text-2">
					Provider
					<select class="ui-input" value={$meshActiveProvider ?? ''} onchange={onProvider}>
						{#each $meshProviders as p (p.id)}
							<option value={p.id}>{p.label}</option>
						{/each}
					</select>
				</label>
			{:else}
				<p class="text-xs text-ink-warn">No mesh provider configured — add one in Settings → AI → Mesh generation.</p>
			{/if}

			{#if takesImage}
				<div class="flex flex-col gap-1 text-xs text-text-2" id="mesh-gen-picture">
					Picture (optional)
					{#if image}
						<div class="flex items-center gap-2">
							<img id="mesh-gen-image" class="mesh-gen-thumb" src={'data:' + image.mimeType + ';base64,' + image.data} alt={image.name} />
							<span class="min-w-0 flex-1 truncate">{image.name} · {image.w}×{image.h}</span>
							<button id="mesh-gen-image-clear" class="ui-button-quiet" title="Remove the picture" aria-label="Remove the picture" onclick={() => (image = null)}>✕</button>
						</div>
					{:else}
						<div class="flex flex-wrap items-center gap-1.5">
							<button id="mesh-gen-file" class="ui-button-quiet" disabled={busy} onclick={() => fileInput?.click()}>From device…</button>
							{#if phone}
								<button id="mesh-gen-camera" class="ui-button-quiet" disabled={busy} onclick={() => cameraInput?.click()}>Camera</button>
							{/if}
							<button id="mesh-gen-viewport" class="ui-button-quiet" disabled={busy} onclick={() => pick(() => viewportPicture(MESH_IMAGE))}>Viewport</button>
							{#if explorerImages.length}
								<select id="mesh-gen-explorer" class="ui-input min-w-0 flex-1" aria-label="From Explorer" disabled={busy} onchange={onExplorerPick}>
									<option value="">From Explorer…</option>
									{#each explorerImages as it (it.id)}
										<option value={it.id}>{it.name}</option>
									{/each}
								</select>
							{/if}
						</div>
					{/if}
					{#if busy}
						<span id="mesh-gen-preparing" class="text-[11px] text-text-muted" role="status">Preparing the picture…</span>
					{/if}
					<input bind:this={fileInput} id="mesh-gen-file-input" type="file" accept="image/*" hidden onchange={onFile} />
					<input bind:this={cameraInput} type="file" accept="image/*" capture="environment" hidden onchange={onFile} />
				</div>
			{/if}

			<label class="flex flex-col gap-1 text-xs text-text-2">
				{image && takesImage ? 'Prompt (optional)' : 'Prompt'}
				<textarea
					class="ui-input min-h-[64px] resize-y"
					placeholder="a weathered wooden treasure chest with iron bands"
					bind:value={prompt}
					onkeydown={(e) => {
						if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
					}}
				></textarea>
			</label>

			<label class="flex flex-col gap-1 text-xs text-text-2">
				Name (optional)
				<input class="ui-input" placeholder="Treasure chest" bind:value={name} />
			</label>

			{#if isHosted}
				<p class="text-[11px] text-ink-warn">Uses your {active?.label} account credits.{image && takesImage ? ' The picture is sent to them.' : ''}</p>
			{/if}

			<div class="flex items-center gap-2">
				<button
					class="rounded-lg bg-accent-fill px-3 py-1.5 text-sm font-medium text-on-accent hover:brightness-110 disabled:opacity-50"
					disabled={!ready || busy || !$meshProviders.length}
					onclick={submit}
				>
					Generate
				</button>
				<span class="text-[11px] text-text-muted">Takes ~1–3 min; it appears in the scene when ready.</span>
			</div>
		</div>
	</div>
{/if}

<style>
	.mesh-gen-backdrop {
		position: fixed;
		inset: 0;
		background: var(--scrim);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: var(--z-modal);
	}
	.mesh-gen-thumb {
		width: 48px;
		height: 48px;
		flex: none;
		object-fit: cover;
		border-radius: var(--radius-input);
	}
</style>
