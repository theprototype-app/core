<script>
	// 59 T2 — the short card "Edit in Blender…" opens beside the download: how to take the model
	// into Blender (or any glTF tool) and back. Non-modal like every panel-shaped dialog: the scene
	// stays usable while it is up. The export settings are the module's list, so the card and the
	// docs cannot drift. On Chromium desktop it also offers to WATCH the saved file (T7a).
	import ModalDialog from '../ui/ModalDialog.svelte';
	import UiButton from '../ui/Button.svelte';
	import { editInBlenderCard, BLENDER_EXPORT_SETTINGS, EDIT_IN_BLENDER_DOCS } from '$lib/editInBlenderState';
	import { canWatchFiles, watchModelFile } from '$lib/modelWatch';

	let open = $state(false);
	$effect(() => {
		open = !!$editInBlenderCard;
	});
	const card = $derived($editInBlenderCard);
	const watchable = $derived(!!card && canWatchFiles() && card.format !== 'fbx');

	function close() {
		editInBlenderCard.set(null);
	}
</script>

<ModalDialog
	title={'Edit "' + (card?.name ?? '') + '" in Blender'}
	bind:open
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') close();
	}}
	oncancel={close}
	outsideclose
	width="sm"
	desktopWidth="560px"
>
	{#if card}
		<div id="edit-in-blender" class="flex flex-col gap-2 text-sm" data-file={card.fileName}>
			<p class="text-xs text-text-muted">
				<b>{card.fileName}</b> is in your downloads. Any tool that reads and writes glTF works the same way (Maya, 3ds Max, Cascadeur …).
			</p>
			<ol class="ml-4 flex list-decimal flex-col gap-1 text-xs">
				<li>In Blender: <b>File ▸ Import ▸ glTF 2.0</b>, pick {card.fileName}.</li>
				<li>Edit it. For a model without a rig, <b>Object ▸ Apply ▸ All Transforms</b> (Ctrl+A) before exporting.</li>
				<li>
					<b>File ▸ Export ▸ glTF 2.0</b> with:
					<ul id="edit-in-blender-settings" class="ml-3 mt-0.5 list-disc">
						{#each BLENDER_EXPORT_SETTINGS as row (row.where)}
							<li><span class="text-text-muted">{row.where}:</span> {row.what}</li>
						{/each}
					</ul>
				</li>
				<li>
					{#if card.stamped}
						Drop the exported file anywhere here — it asks <b>Update "{card.name}"?</b> The object keeps its place, links and flows.
					{:else}
						Drop the exported file onto "{card.name}" (select it first) and choose <b>Replace</b>.
					{/if}
				</li>
			</ol>
			{#if card.format === 'fbx'}
				<p class="text-xs text-text-muted">This model came in as FBX, so it goes out as FBX; export it back as glTF.</p>
			{/if}
			<div class="flex flex-wrap gap-1 pt-1">
				{#if watchable}
					<UiButton
						id="edit-in-blender-watch"
						size="sm"
						variant="primary"
						icon="eye"
						title="Pick the file you export from Blender: each time it is saved again, this model offers to reload"
						onclick={() => {
							const uuid = card.uuid;
							void watchModelFile(uuid).then((ok) => ok && close());
						}}>Watch the exported file…</UiButton
					>
				{/if}
				<UiButton id="edit-in-blender-again" size="sm" variant="outline" icon="arrow-down-to-line" onclick={() => import('$lib/editInBlender').then((m) => m.downloadAgain(card.uuid))}
					>Download again</UiButton
				>
				<UiButton id="edit-in-blender-docs" size="sm" variant="ghost" icon="book-open" href={EDIT_IN_BLENDER_DOCS} target="_blank" rel="noopener"
					>Guide</UiButton
				>
				<UiButton id="edit-in-blender-close" size="sm" variant="ghost" onclick={close}>Close</UiButton>
			</div>
		</div>
	{/if}
</ModalDialog>
