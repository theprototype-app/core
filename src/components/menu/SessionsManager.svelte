<script>
	// Sessions manager (phase 50): thumbnail grid of saved sessions with
	// load (proposal when peers are connected), selective object import,
	// rename, export/import and delete.
	import { Modal, Button } from 'flowbite-svelte';
	import { sessionsOpen, hidePanels, restorePanels, showToast } from '../../stores/appStore.js';
	import {
		sessions,
		loadSessions,
		saveSession,
		getSession,
		deleteSession,
		renameSession,
		exportSession,
		importSession,
		exportSessionZip,
		importSessionZip,
		requestLoadSession,
		sessionObjectList,
		importObjects
	} from '$lib/sessions';

	// like Settings: side panels hide while the manager is open, restore after
	$: if ($sessionsOpen) {
		hidePanels();
		loadSessions();
		picker = null;
	} else if ($sessionsOpen === false) {
		restorePanels();
	}

	/** selective-import checklist: { id, name, entries, checked: Set } | null */
	/** @type {any} */
	let picker = null;

	/** @param {any} meta */
	async function openPicker(meta) {
		const payload = await getSession(meta.id);
		if (!payload) return;
		picker = {
			id: meta.id,
			name: meta.name,
			payload,
			entries: sessionObjectList(payload),
			checked: new Set()
		};
	}

	/** @param {number} index */
	function togglePick(index) {
		if (picker.checked.has(index)) picker.checked.delete(index);
		else picker.checked.add(index);
		picker = picker; // refresh
	}

	function runImport() {
		if (!picker || picker.checked.size === 0) return;
		importObjects(picker.payload, [...picker.checked]);
		picker = null;
		sessionsOpen.set(false);
	}

	/** @param {any} meta @param {boolean=} asZip */
	async function downloadSession(meta, asZip = false) {
		const payload = await getSession(meta.id);
		if (!payload) return;
		const safe = String(meta.name).replace(/[^\w-]+/g, '_');
		if (asZip) {
			// 127: session.json + the scene's binary assets, portable
			const bytes = await exportSessionZip(payload);
			const blob = new Blob([bytes], { type: 'application/zip' });
			const link = document.createElement('a');
			link.href = URL.createObjectURL(blob);
			link.download = safe + '.session.zip';
			link.click();
			URL.revokeObjectURL(link.href);
			return;
		}
		const blob = new Blob([exportSession(payload)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = safe + '.session.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}

	/** @param {any} event */
	async function importSessionFile(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		try {
			// 127: a .zip restores its bundled assets into the Explorer first
			if (file.name.toLowerCase().endsWith('.zip')) await importSessionZip(await file.arrayBuffer());
			else await importSession(await file.text());
		} catch {
			showToast('Not a valid session file');
		}
		event.target.value = '';
	}

	/** @param {number} ts */
	function stamp(ts) {
		return new Date(ts).toLocaleString([], {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		});
	}
</script>

<Modal
	title="Sessions"
	bind:open={$sessionsOpen}
	outsideclose
	size="lg"
	class="tp-modal-frame"
	dialogClass="tp-modal-dialog fixed top-0 start-0 end-0 h-modal md:inset-0 md:h-full z-50 w-full p-4 flex"
	bodyClass="tp-modal-body flex-1 overflow-y-auto overscroll-contain"
	backdropClass="tp-modal-backdrop fixed inset-0 z-40 bg-gray-900 bg-opacity-50 dark:bg-opacity-80"
	headerClass="tp-modal-header flex justify-between items-center p-4 md:p-5 rounded-t-lg"
>
	<div class="modal-content p-1">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			<Button
				id="session-save"
				size="xs"
				onclick={() => {
					const name = prompt('Session name', 'Session ' + new Date().toLocaleDateString());
					if (name) saveSession(name);
				}}><i class="fa-solid fa-floppy-disk mr-1"></i>Save current scene</Button
			>
			<Button size="xs" color="alternative" onclick={() => document.getElementById('session-import-file')?.click()}>
				<i class="fa-solid fa-upload mr-1"></i>Import session file
			</Button>
			<input type="file" id="session-import-file" style="display: none" accept=".json,.zip" onchange={importSessionFile} />
			<span class="text-xs text-gray-400">
				Loading with peers connected asks everyone first; a backup session is stashed before any replace.
			</span>
		</div>

		{#if picker}
			<div class="mb-3 rounded-lg border border-gray-600 p-2">
				<p class="mb-1 text-sm font-semibold text-gray-100">
					Import objects from “{picker.name}”
				</p>
				<div class="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
					{#each picker.entries as entry (entry.index)}
						<label class="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm text-gray-200 hover:bg-gray-700">
							<input
								type="checkbox"
								checked={picker.checked.has(entry.index)}
								onchange={() => togglePick(entry.index)}
							/>
							<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
							<span class="text-[10px] uppercase text-gray-400">{entry.type}</span>
						</label>
					{/each}
					{#if !picker.entries.length}
						<p class="p-1 text-xs italic text-gray-400">This session has no objects.</p>
					{/if}
				</div>
				<div class="mt-2 flex gap-2">
					<Button id="session-import-selected" size="xs" disabled={picker.checked.size === 0} onclick={runImport}>
						Import {picker.checked.size} into the scene
					</Button>
					<Button size="xs" color="alternative" onclick={() => (picker = null)}>Cancel</Button>
				</div>
			</div>
		{/if}

		{#if !$sessions.length}
			<p class="rounded-lg border border-dashed border-gray-600 p-4 text-center text-sm italic text-gray-400">
				No saved sessions yet — Save current scene keeps a named snapshot you can reload,
				share as a file or pick objects from later.
			</p>
		{:else}
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				{#each $sessions as meta (meta.id)}
					<div class="session-card flex flex-col overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/70">
						{#if meta.thumbnail}
							<img src={meta.thumbnail} alt={meta.name} class="h-24 w-full object-cover" />
						{:else}
							<div class="flex h-24 w-full items-center justify-center bg-gray-700 text-2xl text-gray-400"><i class="fa-solid fa-box-archive"></i></div>
						{/if}
						<div class="flex flex-col gap-1 p-2">
							<p
								class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-gray-100"
								title="Double-click to rename"
								ondblclick={() => {
									const name = prompt('Session name', meta.name);
									if (name) renameSession(meta.id, name);
								}}
							>
								{meta.name}
							</p>
							<p class="text-[10px] text-gray-400">
								{meta.count} object{meta.count === 1 ? '' : 's'} · {stamp(meta.createdAt)}
							</p>
							<div class="flex flex-wrap gap-1">
								<button class="ui-button-quiet session-load" title="Replace the scene with this session (peers must accept)"
									onclick={() => { requestLoadSession(meta.id); sessionsOpen.set(false); }}>▶ Load</button>
								<button class="ui-button-quiet" title="Pick objects to add to the current scene"
									onclick={() => openPicker(meta)}>⤵ Import objects…</button>
								<button class="ui-button-quiet session-download-json" title="Download as JSON" onclick={() => downloadSession(meta)}><i class="fa-solid fa-download mr-1"></i>.json</button>
								<button class="ui-button-quiet session-download-zip" title="Download as a .zip with the scene's assets" onclick={() => downloadSession(meta, true)}><i class="fa-solid fa-download mr-1"></i>.zip</button>
								<button class="ui-button-quiet hover:bg-red-700" title="Delete"
									onclick={() => deleteSession(meta.id)}>✕</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</Modal>
