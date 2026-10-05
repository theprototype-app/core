<script lang="ts">
	// 36 B14 — "Save checkpoint…": a name and an optional note, nothing else. Opened by the burger
	// menu, Ctrl+Shift+S and the timeline's own button. Enter saves from the name field; the note
	// is a textarea, so Enter there is a newline and Ctrl+Enter saves.
	import { Modal, Button } from 'flowbite-svelte';
	import { checkpointSaveOpen } from '../../../stores/appStore.js';
	import { saveCheckpoint, checkpointBusy } from '$lib/checkpoints';
	import { currentLevel } from '$lib/levels';

	let name = $state('');
	let note = $state('');
	let nameInput: HTMLInputElement | null = $state(null);

	// a fresh suggestion every time the dialog opens: the scene's name and the time
	$effect(() => {
		if (!$checkpointSaveOpen) return;
		const scene = $currentLevel?.name;
		const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
		name = (scene ? scene + ' · ' : '') + time;
		note = '';
		requestAnimationFrame(() => nameInput?.select());
	});

	async function save() {
		if ($checkpointBusy) return;
		const row = await saveCheckpoint({ name, note });
		if (row) checkpointSaveOpen.set(false);
	}
</script>

<Modal
	title="Save checkpoint"
	bind:open={$checkpointSaveOpen}
	modal={false}
	onkeydown={(e) => {
		if (e.key === 'Escape') checkpointSaveOpen.set(false);
	}}
	outsideclose
	size="sm"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body' }}
>
	<div id="checkpoint-save" class="flex flex-col gap-3 p-1">
		<label class="flex flex-col gap-1 text-sm">
			<span class="cp-label">Name</span>
			<input
				id="checkpoint-save-name"
				class="ui-input w-full"
				type="text"
				maxlength="80"
				bind:value={name}
				bind:this={nameInput}
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						void save();
					}
				}}
			/>
		</label>
		<label class="flex flex-col gap-1 text-sm">
			<span class="cp-label">Note <span class="cp-hint">(optional)</span></span>
			<textarea
				id="checkpoint-save-note"
				class="ui-input w-full"
				rows="3"
				maxlength="500"
				placeholder="What changed, what to try next…"
				bind:value={note}
				onkeydown={(e) => {
					if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
						e.preventDefault();
						void save();
					}
				}}
			></textarea>
		</label>
		<p class="cp-hint">
			Kept on this device only, in the checkpoint timeline (burger menu ▸ Checkpoints). Restoring
			one replaces the scene; with people connected they are asked first.
		</p>
	</div>
	{#snippet footer()}
		<Button id="checkpoint-save-confirm" onclick={() => void save()}>Save checkpoint</Button>
		<Button color="alternative" onclick={() => checkpointSaveOpen.set(false)}>Cancel</Button>
	{/snippet}
</Modal>

<style>
	.cp-label {
		color: var(--text, rgb(229 231 235));
		font-weight: 600;
	}
	.cp-hint {
		color: var(--muted, rgb(156 163 175));
		font-size: 0.75rem;
		font-weight: 400;
	}
</style>
