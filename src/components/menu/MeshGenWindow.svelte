<script lang="ts">
	// THE GENERATE WINDOW (uir-timeline, owner 2026-11-09 "a dockable Generate window with prompt history and
	// jobs"). It replaces the Generate 3D model modal (roadmap #11 G6, 73 AI1-AI8): the same form — provider,
	// a picture (a photo, an Explorer image, the viewport), the prompt and a name, the credits line — in a
	// window that STAYS: it floats, docks as a bottom-dock tab or a sidebar tab ($lib/dockHost 'meshGen'),
	// and on a phone it is a bottom sheet. Under the form, two tabs:
	//   Jobs     every generation, running / done / failed / cancelled, saved on this device ($lib/ai/meshJobs).
	//            Running: progress + Cancel. Done: Reopen (selects it, or places the cached file again). Failed
	//            or cancelled: Retry (a text job; it is a new generation and uses credits again) and ✕.
	//   History  the prompts this device asked for, newest first: a tap puts one back in the form.
	// The store keeps its name `meshGenModalOpen` (null = closed, {position?, imageItemId?} = open, seeded): the
	// Add menu's point, the Explorer's "Make a 3D model…" picture and every suite open it that way. It is not a
	// modal any more, so it left `anyModalOpen` (the viewport keeps its keys while it is open).
	import { backClose } from '$lib/backStack.js'; // phone-polish: Android Back closes it
	import { meshGenModalOpen, showToast } from '../../stores/appStore';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { dragWindow } from '$lib/dragWindow';
	import { focusStack } from '$lib/windowFocus';
	import { bottomDockable } from '$lib/bottomDockDrop';
	import { safeStorage } from '$lib/safeStorage';
	import Icon from '../ui/Icon.svelte';
	import Button from '../ui/Button.svelte';
	import Tabs from '../ui/Tabs.svelte';
	import { meshProviders, meshActiveProvider, setMeshActiveProvider, meshTakesImage } from '$lib/ai/meshProviders';
	import {
		generateMesh,
		meshJobs,
		cancelMeshJob,
		dismissMeshJob,
		clearFinishedMeshJobs,
		reopenMeshJob,
		meshPromptHistory,
		forgetMeshPrompt,
		clearMeshPromptHistory
	} from '$lib/ai/meshJobs';
	import { agoText } from '$lib/peerFacts.js';
	import { explorerItems } from '$lib/explorer';
	import { prepareImage, viewportPicture, explorerPicture } from '$lib/chat/attachments.js';
	import { MESH_IMAGE } from '$lib/chat/attachCore.js';
	import { rolesInfo } from '$lib/cloudHooks';
	import { openToolRow } from '$lib/tools/toolLinks.js';
	import { tipShown, dismissTip, TIP_MESH_PICTURE } from '$lib/tips.js';
	import { pictureConsentFor } from '$lib/ai/meshConsent.js';

	const KEY = 'meshGen';
	/** 73 AI6: the first-use hint, until a picture is picked */
	const pictureTip = tipShown(TIP_MESH_PICTURE);
	/** 73 AI8: the picture limits, said before a pick (attachCore.MESH_IMAGE) */
	const pictureLimits = `JPEG, PNG, WebP or HEIC · sent at up to ${MESH_IMAGE.maxEdge} px and ${Math.round(MESH_IMAGE.maxBytes / (1024 * 1024))} MB · location data removed first`;

	let prompt = $state('');
	let name = $state('');
	/** the prepared picture, or null: text-to-3D as before */
	let image: any = $state(null);
	let busy = $state(false);
	let fileInput: HTMLInputElement | null = $state(null);
	let cameraInput: HTMLInputElement | null = $state(null);
	let promptEl: HTMLTextAreaElement | null = $state(null);
	/** a closed or re-picked window ignores a prepare still running */
	let pickToken = 0;
	/** Jobs | History, remembered on this device */
	let tab = $state((typeof localStorage !== 'undefined' && safeStorage.getItem('meshGen:tab')) === 'history' ? 'history' : 'jobs');
	function setTab(v: string) {
		tab = v;
		safeStorage.setItem('meshGen:tab', v);
	}
	/** a clock for "2 min ago" while the window is open */
	let now = $state(Date.now());
	$effect(() => {
		if (!$meshGenModalOpen) return;
		const t = setInterval(() => (now = Date.now()), 15000);
		return () => clearInterval(t);
	});

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
	// 73 AI4: a provider that cannot start from a picture says so (and what would)
	const noPicture = $derived(!!active && !meshTakesImage(active) && ($rolesInfo as any)?.myRole !== 'viewer');
	const consent = $derived(active && image && takesImage ? pictureConsentFor(active) : null);
	/** where the next model lands: the Add menu's picked point, until it is used or cleared */
	const position = $derived(($meshGenModalOpen as any)?.position ?? null);

	const RUNNING = new Set(['submitting', 'running', 'importing']);
	/** newest first */
	const jobs = $derived([...($meshJobs as any[])].reverse());
	const runningCount = $derived(jobs.filter((j) => RUNNING.has(j.status)).length);
	const finishedCount = $derived(jobs.length - runningCount);

	// the Explorer menu's "Make a 3D model…" opens with the picture already chosen
	let seededFrom: string | null = null;
	$effect(() => {
		const itemId = ($meshGenModalOpen as any)?.imageItemId ?? null;
		if (itemId && itemId !== seededFrom) void pick(() => explorerPicture(itemId, MESH_IMAGE));
		seededFrom = itemId;
	});

	// opening the window puts the caret in the prompt (not on a phone: the keyboard would cover the sheet)
	let wasOpen = false;
	$effect(() => {
		const open = !!$meshGenModalOpen;
		if (open && !wasOpen && !phone) queueMicrotask(() => promptEl?.focus({ preventScroll: true }));
		wasOpen = open;
	});

	function close() {
		meshGenModalOpen.set(null);
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
		else {
			image = r;
			dismissTip(TIP_MESH_PICTURE);
		}
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
		e.stopPropagation(); // the viewport under the window must not place the file too
		if (takesImage) void pick(() => prepareImage(file, file.name, MESH_IMAGE));
	}

	function submit() {
		const text = prompt.trim();
		const picture = takesImage ? image : null;
		if (!text && !picture) return;
		generateMesh({ prompt: text, name: name.trim() || undefined, position: position ?? undefined, ...(picture ? { image: picture } : {}) }).catch(() => {});
		// the window stays: the job shows under the form, the form is ready for the next one
		prompt = '';
		name = '';
		image = null;
		meshGenModalOpen.set({});
		setTab('jobs');
	}

	function onProvider(e: Event) {
		setMeshActiveProvider((e.currentTarget as HTMLSelectElement).value || null);
	}

	function usePrompt(entry: { prompt: string; name?: string }) {
		prompt = entry.prompt;
		name = entry.name ?? '';
		promptEl?.focus({ preventScroll: true });
	}

	/** a text job runs again as a new job (a new generation: it uses credits again); a picture job asks for the picture */
	function retry(job: any) {
		if (job.image) {
			usePrompt({ prompt: job.prompt === 'From a picture' ? '' : job.prompt, name: job.name });
			showToast('Pick the picture again, then Generate');
			return;
		}
		generateMesh({ prompt: job.prompt, name: job.name, position: job.position, providerId: $meshProviders.some((p) => p.id === job.providerId) ? job.providerId : undefined }).catch(() => {});
	}

	function statusText(job: any) {
		if (job.status === 'submitting') return 'Sending…';
		if (job.status === 'running') return job.progress != null ? `Generating · ${Math.round(job.progress * 100)}%` : 'Generating…';
		if (job.status === 'importing') return 'Placing…';
		if (job.status === 'done') return 'Done';
		if (job.status === 'error') return 'Failed';
		if (job.status === 'cancelled') return 'Cancelled';
		return job.status;
	}
	function statusIcon(status: string) {
		if (RUNNING.has(status)) return 'loader-circle';
		if (status === 'done') return 'circle-check';
		if (status === 'error') return 'circle-x';
		return 'circle-dashed';
	}
</script>

{#if $meshGenModalOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		id="mesh-gen-window"
		class="ui-panel tp-ui tp-window tp-themed mesh-gen-window fixed flex flex-col overflow-hidden outline-hidden"
		tabindex="-1"
		role="dialog"
		aria-label="Generate 3D model"
		use:backClose={close}
		use:dragWindow={{ key: 'meshGenWindow', defaultRect: { left: 200, top: 90 }, resizable: true, minW: 300, minH: 280 }}
		use:bottomDockable={{ key: KEY }}
		use:focusStack={KEY}
		style="z-index: var(--z-window); width: min(420px, calc(100vw - 16px)); height: min(620px, calc(100dvh - 110px))"
		data-keywords="generate 3d model mesh ai meshy comfyui prompt picture image to 3d jobs history"
		onpaste={onPaste}
		ondrop={onDrop}
		ondragover={(e) => e.preventDefault()}
	>
		<div data-sb-headless class="ui-panel-header move-handle flex shrink-0 cursor-move items-center gap-2 py-1.5 select-none">
			<Icon name="wand-sparkles" size={16} aria-hidden="true" />
			<span class="flex-1 truncate text-sm font-semibold">Generate 3D model</span>
			{#if runningCount}<span class="mg-badge" id="mesh-gen-running" title="Running jobs">{runningCount} running</span>{/if}
			<button id="mesh-gen-close" class="rounded-sm p-1 hover:brightness-150" title="Close (jobs keep running)" aria-label="Close the Generate window" onclick={close}
				><Icon name="x" size={16} aria-hidden="true" /></button
			>
		</div>

		<div class="mg-body min-h-0 flex-1 overflow-y-auto" use:minimalScroll>
			<div class="mg-form">
				{#if $meshProviders.length}
					<label class="mg-label">
						Provider
						<select class="ui-input" id="mesh-gen-provider" value={$meshActiveProvider ?? ''} onchange={onProvider}>
							{#each $meshProviders as p (p.id)}
								<option value={p.id}>{p.label}</option>
							{/each}
						</select>
					</label>
				{:else}
					<!-- 73 AI4: says what is missing and goes there -->
					<p id="mesh-gen-no-provider" class="text-xs text-ink-warn">
						No mesh provider set up yet.
						<button
							id="mesh-gen-setup"
							type="button"
							class="underline"
							onclick={() => {
								close();
								openToolRow('mesh');
							}}>Set one up in Tools &amp; connections</button
						>
					</p>
				{/if}
				{#if noPicture}
					<p id="mesh-gen-no-picture" class="mg-small text-text-muted">
						{active?.label} can’t start from a picture. Use Meshy, or a ComfyUI workflow with <code>{'{{IMAGE}}'}</code> in a LoadImage node.
					</p>
				{/if}

				{#if takesImage}
					<div class="mg-label" id="mesh-gen-picture">
						Picture (optional)
						{#if $pictureTip && !image}
							<span id="mesh-gen-tip" class="mg-small text-accent-text" role="note">New: start from a photo, an Explorer picture or the viewport — the model is made from it.</span>
						{/if}
						{#if image}
							<div class="flex items-center gap-2">
								<img id="mesh-gen-image" class="mesh-gen-thumb" src={'data:' + image.mimeType + ';base64,' + image.data} alt={image.name} />
								<span class="min-w-0 flex-1 truncate">{image.name} · {image.w}×{image.h}</span>
								<button id="mesh-gen-image-clear" class="ui-button-quiet" title="Remove the picture" aria-label="Remove the picture" onclick={() => (image = null)}
									><Icon name="x" size={16} aria-hidden="true" /></button
								>
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
						<span id="mesh-gen-limits" class="mg-small text-text-muted">{pictureLimits}</span>
						{#if busy}
							<span id="mesh-gen-preparing" class="mg-small text-text-muted" role="status">Preparing the picture…</span>
						{/if}
						<input bind:this={fileInput} id="mesh-gen-file-input" type="file" accept="image/*" hidden onchange={onFile} />
						<input bind:this={cameraInput} type="file" accept="image/*" capture="environment" hidden onchange={onFile} />
					</div>
				{/if}

				<label class="mg-label">
					{image && takesImage ? 'Prompt (optional)' : 'Prompt'}
					<textarea
						id="mesh-gen-prompt"
						bind:this={promptEl}
						class="ui-input min-h-[64px] resize-y"
						placeholder="a weathered wooden treasure chest with iron bands"
						bind:value={prompt}
						onkeydown={(e) => {
							if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
						}}
					></textarea>
				</label>

				<label class="mg-label">
					Name (optional)
					<input class="ui-input" id="mesh-gen-name" placeholder="Treasure chest" bind:value={name} />
				</label>

				{#if position}
					<div class="mg-small flex items-center gap-1 text-text-muted" id="mesh-gen-at">
						<Icon name="map-pin" size={16} aria-hidden="true" />
						<span class="flex-1">Placed where you picked in the scene</span>
						<button class="ui-button-quiet" title="Place it at the default spot instead" aria-label="Forget the picked point" onclick={() => meshGenModalOpen.set({})}
							><Icon name="x" size={16} aria-hidden="true" /></button
						>
					</div>
				{/if}

				{#if isHosted}
					<p class="mg-small text-ink-warn" id="mesh-gen-credits">
						Uses your {active?.label} account credits.{consent ? (active?.kind === 'meshy' ? ' Before anything is sent you confirm the cost and that the picture goes to Meshy.' : ' Before anything is sent you confirm that the picture leaves this device.') : ''}
					</p>
				{/if}

				<div class="flex items-center gap-2">
					<Button variant="primary" size="sm" icon="wand-sparkles" text="Generate" id="mesh-gen-submit" disabled={!ready || busy || !$meshProviders.length} onclick={submit} />
					<span class="mg-small text-text-muted">Takes ~1–3 min; it appears in the scene when ready.</span>
				</div>
			</div>

			<div class="mg-lists">
				<Tabs
					idPrefix="mesh-gen"
					label="Jobs and history"
					tabs={[
						{ id: 'jobs', label: jobs.length ? `Jobs (${jobs.length})` : 'Jobs' },
						{ id: 'history', label: 'History' }
					]}
					value={tab}
					onchange={setTab}
				/>
				{#if tab === 'jobs'}
					<div id="mesh-gen-jobs" class="mg-list" role="list" aria-label="Jobs">
						{#if !jobs.length}
							<p class="mg-empty">No jobs yet. What you generate shows here: running, done or failed.</p>
						{/if}
						{#each jobs as job (job.id)}
							<div class="mg-job" role="listitem" data-job-id={job.id} data-job-status={job.status}>
								<span class="mg-job-icon" class:mg-spin={RUNNING.has(job.status)} data-tone={job.status}
									><Icon name={statusIcon(job.status)} size={16} aria-hidden="true" /></span
								>
								<div class="min-w-0 flex-1">
									<div class="mg-job-prompt" title={job.prompt}>{job.prompt}</div>
									<div class="mg-small text-text-muted">
										<span class="mg-job-status" data-tone={job.status}>{statusText(job)}</span>
										· {job.provider}{job.at ? ' · ' + agoText(job.at, now) : ''}{job.image ? ' · from a picture' : ''}
									</div>
									{#if job.status === 'error' && job.error}
										<div class="mg-small mg-job-error" title={job.error}>{job.error}</div>
									{/if}
									{#if RUNNING.has(job.status)}
										<div class="mg-bar">
											{#if job.progress != null}
												<div class="mg-bar-fill" style={`width:${Math.round(job.progress * 100)}%`}></div>
											{:else}
												<div class="mg-bar-fill mg-indeterminate"></div>
											{/if}
										</div>
									{/if}
								</div>
								<div class="mg-job-actions">
									{#if RUNNING.has(job.status)}
										<Button size="sm" variant="ghost" text="Cancel" data-job-cancel={job.id} onclick={() => cancelMeshJob(job.id)} />
									{:else}
										{#if job.status === 'done'}
											<Button size="sm" variant="secondary" icon="focus" text="Reopen" title="Select it in the scene, or place it again from Explorer ▸ Generated" data-job-reopen={job.id} onclick={() => reopenMeshJob(job.id)} />
										{:else}
											<Button size="sm" variant="secondary" icon="refresh-cw" text="Retry" title={job.image ? 'Put the prompt back; pick the picture again' : 'Generate it again (a new job: uses credits again)'} data-job-retry={job.id} onclick={() => retry(job)} />
										{/if}
										<Button size="sm" variant="ghost" icon="x" title="Remove from the list" aria-label="Remove this job from the list" data-job-dismiss={job.id} onclick={() => dismissMeshJob(job.id)} />
									{/if}
								</div>
							</div>
						{/each}
						{#if finishedCount > 1}
							<div class="mg-list-foot"><Button size="sm" variant="ghost" icon="trash-2" text="Clear finished" id="mesh-gen-clear-jobs" onclick={clearFinishedMeshJobs} /></div>
						{/if}
					</div>
				{:else}
					<div id="mesh-gen-history" class="mg-list" role="list" aria-label="Prompt history">
						{#if !$meshPromptHistory.length}
							<p class="mg-empty">No prompts yet. Each one you generate is kept here on this device.</p>
						{/if}
						{#each $meshPromptHistory as entry (entry.prompt)}
							<div class="mg-hist" role="listitem">
								<button class="mg-hist-use" title="Put this prompt in the form" data-history-use={entry.prompt} onclick={() => usePrompt(entry)}>
									<Icon name="history" size={16} aria-hidden="true" />
									<span class="min-w-0 flex-1">
										<span class="mg-job-prompt">{entry.prompt}</span>
										<span class="mg-small text-text-muted">{entry.name ? entry.name + ' · ' : ''}{agoText(entry.at, now)}</span>
									</span>
								</button>
								<Button size="sm" variant="ghost" icon="x" title="Forget this prompt" aria-label="Forget this prompt" onclick={() => forgetMeshPrompt(entry.prompt)} />
							</div>
						{/each}
						{#if $meshPromptHistory.length > 1}
							<div class="mg-list-foot"><Button size="sm" variant="ghost" icon="trash-2" text="Clear history" id="mesh-gen-clear-history" onclick={clearMeshPromptHistory} /></div>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.mg-body {
		container-type: inline-size;
	}
	.mg-form {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 10px 12px;
	}
	.mg-lists {
		display: flex;
		min-width: 0;
		flex-direction: column;
		padding: 0 12px 12px;
	}
	/* docked in a wide, short dock: the form on the left, the lists beside it */
	@container (min-width: 720px) {
		.mg-body {
			display: grid;
			grid-template-columns: minmax(300px, 420px) minmax(0, 1fr);
			align-items: start;
		}
		.mg-lists {
			padding: 10px 12px 12px 0;
		}
	}
	.mg-label {
		display: flex;
		flex-direction: column;
		gap: 4px;
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	.mg-small {
		font-size: var(--fs-badge);
	}
	.mg-badge {
		padding: 1px 6px;
		border-radius: 999px;
		background: var(--accent-fill);
		color: var(--on-accent);
		font-size: var(--fs-badge);
	}
	.mesh-gen-thumb {
		width: 48px;
		height: 48px;
		flex: none;
		object-fit: cover;
		border-radius: var(--radius-input);
	}
	.mg-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding-top: 6px;
	}
	.mg-empty {
		padding: 10px 4px;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.mg-job,
	.mg-hist {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 6px 4px;
		border-bottom: 1px solid var(--border);
	}
	.mg-job-icon {
		display: inline-flex;
		padding-top: 2px;
		color: var(--text-muted);
	}
	.mg-job-icon[data-tone='done'],
	.mg-job-status[data-tone='done'] {
		color: var(--ink-good);
	}
	.mg-job-icon[data-tone='error'],
	.mg-job-status[data-tone='error'],
	.mg-job-error {
		color: var(--ink-bad);
	}
	.mg-spin :global(svg) {
		animation: mg-spin 1s linear infinite;
	}
	@keyframes mg-spin {
		to {
			transform: rotate(360deg);
		}
	}
	.mg-job-prompt {
		display: block;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.mg-job-error {
		display: -webkit-box;
		overflow: hidden;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
	}
	.mg-job-actions {
		display: flex;
		flex: none;
		align-items: center;
		gap: 2px;
	}
	.mg-bar {
		height: 4px;
		margin-top: 4px;
		overflow: hidden;
		border-radius: 2px;
		background: var(--surface-inset);
	}
	.mg-bar-fill {
		height: 100%;
		background: var(--accent);
	}
	.mg-indeterminate {
		width: 35%;
		animation: mg-slide 1.2s ease-in-out infinite;
	}
	@keyframes mg-slide {
		0% {
			margin-left: 0;
		}
		50% {
			margin-left: 65%;
		}
		100% {
			margin-left: 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.mg-spin :global(svg),
		.mg-indeterminate {
			animation: none;
		}
	}
	.mg-hist-use {
		display: flex;
		min-width: 0;
		flex: 1 1 auto;
		align-items: flex-start;
		gap: 8px;
		border: 0;
		background: transparent;
		color: var(--text-2);
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	.mg-hist-use > span {
		display: flex;
		flex-direction: column;
	}
	.mg-hist-use:hover .mg-job-prompt {
		text-decoration: underline;
	}
	.mg-hist-use:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
	.mg-list-foot {
		display: flex;
		justify-content: flex-end;
		padding-top: 4px;
	}
	/* a phone: a bottom sheet over the bar (the asset browser's rule) */
	:global(:root.phone-shell) #mesh-gen-window {
		position: fixed !important;
		top: auto !important;
		left: 0 !important;
		right: 0 !important;
		bottom: var(--ps-bar-h, 0px) !important;
		width: auto !important;
		height: var(--ps-sheet-max, 78vh) !important;
		max-height: var(--ps-sheet-max, 92vh) !important;
		border-radius: 18px 18px 0 0 !important;
	}
</style>
