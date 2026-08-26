<script>
	import { Archive, Download, LayoutGrid, List, Save, Upload } from '@lucide/svelte';
	import Icon from '../ui/Icon.svelte';
	// Sessions manager (phase 50): thumbnail grid of saved sessions with
	// load (proposal when peers are connected), selective object import,
	// rename, export/import and delete.
	import { Modal, Button } from 'flowbite-svelte';
	import { sessionsOpen, hidePanels, restorePanels, showToast } from '../../stores/appStore.js';
	import {
		sessions,
		loadSessions,
		saveSession,
		saveSessionWithLibrary,
		getSession,
		deleteSession,
		renameSession,
		exportSession,
		importSession,
		exportSessionZip,
		importSessionZip,
		requestLoadSession,
		sessionObjectList,
		sessionFileList,
		sessionFilePayload,
		importObjects
	} from '$lib/sessions';
	// R22 round 11: a file's icon. The Explorer keeps its own map inside the component, so
	// this is the small subset a saved entry can hold rather than an import of it — three
	// rows, and no reason to export a table from a 5,000-line component to share them.
	/** @type {Record<string, string>} */
	const FILE_ICONS = {
		scene: 'map',
		object: 'box',
		image: 'image',
		texture: 'image',
		audio: 'music',
		text: 'file-text'
	};

	// like Settings: side panels hide while the manager is open, restore after
	$: if ($sessionsOpen) {
		hidePanels();
		loadSessions();
		picker = null;
	} else if ($sessionsOpen === false) {
		restorePanels();
	}

	/**
	 * R22 round 11 (user): "for sessions instead of 'import objects' should be 'import
	 * files' and within files which are scenes I should be able to import objects from
	 * there". So the picker has TWO levels now — the FILES in an entry, and the OBJECTS
	 * inside whichever of them is a scene. `file` is null while the file list is showing.
	 * { id, name, payload, files, file, entries, checked: Set } | null
	 */
	/** @type {any} */
	let picker = null;
	/**
	 * R22 round 11 (user): "organize items better in grid view there and allow list view as
	 * well (details with buttons for each row)". GRID or LIST, remembered locally — the
	 * Explorer's own split, and for the same reason: a wall of thumbnails is how you
	 * recognise a scene and a row of facts is how you compare twenty of them.
	 */
	let sessionView = typeof localStorage !== 'undefined' && localStorage.getItem('sessions:view') === 'list' ? 'list' : 'grid';
	$: if (typeof localStorage !== 'undefined') localStorage.setItem('sessions:view', sessionView);

	// 15-B5: naming a session used a browser prompt() — now an inline textbox in
	// the toolbar (and inline rename on a card), matching the Explorer's
	// no-prompt rename. Legacy-mode file: plain lets, never $state.
	let saving = false;
	let saveName = '';
	// R22 round 9: LEGACY MODE, so `$:` and plain lets — introducing one `$state` here
	// would flip the whole file to runes and break its `$:` block (the documented rule).
	/** which button opened the name field — 'scene' or 'project' */
	let saveKind = 'scene';
	/**
	 * ONE LIST WITH A BADGE (the locked answer), so this narrows rather than splitting —
	 * the templates filter's shape. 'all' | 'scene' | 'project'.
	 */
	let kindFilter = 'all';
	/** @type {any[]} */
	let shownSessions = [];
	/** the total across what is SHOWN, so the number answers the list you are looking at */
	let shownBytes = 0;
	$: shownSessions = $sessions.filter((/** @type {any} */ m) =>
		kindFilter === 'all' ? true : kindFilter === 'project' ? m.hasLibrary : !m.hasLibrary
	);
	$: shownBytes = shownSessions.reduce(
		(/** @type {number} */ sum, /** @type {any} */ m) => sum + (Number(m.bytes) || 0),
		0
	);
	/** @param {number} bytes */
	function fmtBytes(bytes) {
		if (!bytes || isNaN(bytes)) return '—';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
		return (bytes / 1024 / 1024 / 1024).toFixed(1) + ' GB';
	}
	/** @type {string|null} */
	let renamingId = null;
	let renameValue = '';

	/** focus + select a freshly revealed input (autofocus would trip a11y) */
	/** @param {HTMLInputElement} node */
	function focusInput(node) {
		node.focus();
		node.select();
	}

	/**
	 * R22 round 9 — TWO BUTTONS, AND NOTHING INFERRED. `saveSessionWithLibrary` has existed
	 * since R8 and had no caller: the difference between a scene snapshot and a project
	 * save is whether the Explorer's files come with it, and that is a decision only the
	 * person pressing the button can make. Guessing it from "does the library have files"
	 * would make one press mean two different things on two different days.
	 *
	 * `withLibrary` rides on the same inline name field rather than a second one — the name
	 * is the same question either way.
	 * @param {boolean} withLibrary
	 */
	function beginSave(withLibrary = false) {
		saveKind = withLibrary ? 'project' : 'scene';
		saveName = (withLibrary ? 'Project ' : 'Session ') + new Date().toLocaleDateString();
		saving = true;
	}
	function confirmSave() {
		const name = saveName.trim();
		if (!name) return;
		if (saveKind === 'project') void saveSessionWithLibrary(name);
		else saveSession(name);
		saving = false;
	}
	/** @param {any} meta */
	function beginRename(meta) {
		renamingId = meta.id;
		renameValue = meta.name;
	}
	function confirmRename() {
		const name = renameValue.trim();
		if (renamingId && name) renameSession(renamingId, name);
		renamingId = null;
	}

	/** @param {any} meta */
	async function openPicker(meta) {
		const payload = await getSession(meta.id);
		if (!payload) return;
		picker = {
			id: meta.id,
			name: meta.name,
			payload,
			files: sessionFileList(payload),
			file: null,
			entries: [],
			checked: new Set()
		};
	}

	/**
	 * Drill into one FILE. A scene opens its object list; anything else says why it has
	 * none rather than showing an empty checklist that reads as broken.
	 * @param {any} file
	 */
	async function openFile(file) {
		if (!picker) return;
		if (file.kind !== 'scene')
			return showToast('"' + file.name + '" is ' + file.kind + ' — objects come from scene files');
		const inner = await sessionFilePayload(picker.payload, file);
		if (!inner) return showToast('"' + file.name + '" could not be read');
		picker = { ...picker, file, entries: inner.entries, innerPayload: inner.payload, checked: new Set() };
	}
	/** back to the file list */
	function closeFile() {
		if (picker) picker = { ...picker, file: null, entries: [], checked: new Set() };
	}
	/** what a file row reads on its right — objects for a scene, a size for anything else.
	 * @param {any} file @returns {string} */
	function fileNote(file) {
		if (file.own) return file.objects + ' object' + (file.objects === 1 ? '' : 's');
		return file.kind === 'scene' ? 'scene file' : fmtBytes(file.bytes);
	}

	/** @param {number} index */
	function togglePick(index) {
		if (picker.checked.has(index)) picker.checked.delete(index);
		else picker.checked.add(index);
		picker = picker; // refresh
	}

	function runImport() {
		if (!picker || picker.checked.size === 0) return;
		// the payload of the FILE that is open, which for the entry's own scene is the
		// entry's payload and for a library .tpscene is the one read out of its bytes
		importObjects(picker.innerPayload ?? picker.payload, [...picker.checked]);
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
	modal={false} onkeydown={(e) => { if (e.key === 'Escape') sessionsOpen.set(false); }}
	outsideclose
	size="lg"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div class="modal-content p-1">
		<div class="mb-3 flex flex-wrap items-center gap-2">
			{#if saving}
				<!-- B5: inline name entry — Enter saves, Esc cancels -->
				<input
					id="session-save-name"
					class="ui-input w-52 text-sm"
					type="text"
					aria-label="Session name"
					placeholder="Session name"
					bind:value={saveName}
					use:focusInput
					onkeydown={(/** @type {KeyboardEvent} */ e) => {
						if (e.key === 'Enter') confirmSave();
						else if (e.key === 'Escape') saving = false;
					}}
				/>
				<!-- say WHICH of the two saves this name is for: one field serves both buttons -->
				<span id="session-save-kind" class="text-[10px] uppercase tracking-wide text-gray-400"
					>{saveKind === 'project' ? 'project + library' : 'scene only'}</span
				>
				<Button id="session-save-confirm" size="xs" disabled={!saveName.trim()} onclick={confirmSave}>
					<Save size={16} class="mr-1" aria-hidden="true" />Save
				</Button>
				<Button size="xs" color="alternative" onclick={() => (saving = false)}>Cancel</Button>
			{:else}
				<Button id="session-save" size="xs" onclick={() => beginSave(false)}
					><Save size={16} class="mr-1" aria-hidden="true" />Save current scene</Button
				>
				<!-- R22 round 9: the project save. Beside the scene one and never inferred from it. -->
				<Button
					id="session-save-project"
					size="xs"
					color="alternative"
					title="The scene AND every file in the Explorer — folders, records and their bytes"
					onclick={() => beginSave(true)}
					><Save size={16} class="mr-1" aria-hidden="true" />Save current project</Button
				>
			{/if}
			<Button size="xs" color="alternative" onclick={() => document.getElementById('session-import-file')?.click()}>
				<Upload size={16} class="mr-1" aria-hidden="true" />Import session file
			</Button>
			<input type="file" id="session-import-file" style="display: none" accept=".json,.zip" onchange={importSessionFile} />
			<span class="text-xs text-gray-400">
				Loading with peers connected asks everyone first; a backup session is stashed before any replace.
			</span>
		</div>

		{#if $sessions.length}
			<!--
				R22 round 9: the filter and the total, on one line above the grid. The total is of
				WHAT IS SHOWN rather than of everything stored, so filtering to Projects answers
				"how much are my projects costing me" instead of repeating a number that does not
				match the cards underneath it.
			-->
			<div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-gray-400">
				<div class="tp-seg" role="group" aria-label="Filter sessions">
					{#each [{ v: 'all', l: 'All' }, { v: 'scene', l: 'Scenes' }, { v: 'project', l: 'Projects' }] as opt (opt.v)}
						<button
							id={'session-filter-' + opt.v}
							class="tp-seg-btn"
							aria-pressed={kindFilter === opt.v}
							onclick={() => (kindFilter = opt.v)}>{opt.l}</button
						>
					{/each}
				</div>
				<span id="session-total"
					>{shownSessions.length} of {$sessions.length} · about {fmtBytes(shownBytes)}</span
				>
				<span class="flex-1"></span>
				<!-- R22 round 11: thumbnails or a list, the Explorer's own split. Local. -->
				<div class="tp-seg" role="group" aria-label="View">
					<button
						id="session-view-grid"
						class="tp-seg-btn"
						aria-pressed={sessionView === 'grid'}
						title="Thumbnails"
						onclick={() => (sessionView = 'grid')}><LayoutGrid size={14} aria-hidden="true" /></button
					>
					<button
						id="session-view-list"
						class="tp-seg-btn"
						aria-pressed={sessionView === 'list'}
						title="Details, with a button per row"
						onclick={() => (sessionView = 'list')}><List size={14} aria-hidden="true" /></button
					>
				</div>
			</div>
		{/if}

		{#if picker}
			<!--
				R22 round 11 — TWO LEVELS. "instead of 'import objects' should be 'import files'
				and within files which are scenes I should be able to import objects from there".
				The FILE list is the first level; a scene row drills into the object checklist
				that was the whole picker before. A scene-only entry still has a file list — the
				one file it IS — so both kinds answer the same question.
			-->
			<div id="session-picker" class="mb-3 rounded-lg border border-gray-600 p-2">
				{#if !picker.file}
					<p class="mb-1 text-sm font-semibold text-gray-100">Files in “{picker.name}”</p>
					<div id="session-file-list" class="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
						{#each picker.files as file (file.own ? 'own' : 'f' + file.index)}
							<button
								class="session-file flex items-center gap-2 rounded-sm px-1 py-1 text-left text-sm text-gray-200 hover:bg-gray-700 disabled:opacity-50"
								data-kind={file.kind}
								disabled={file.kind !== 'scene'}
								title={file.kind === 'scene'
									? 'Open this scene and pick objects from it'
									: 'Only scene files hold objects to import'}
								onclick={() => void openFile(file)}
							>
								{#if file.thumbnail}
									<img src={file.thumbnail} alt="" class="h-7 w-10 shrink-0 rounded-sm object-cover" />
								{:else}
									<span class="flex h-7 w-10 shrink-0 items-center justify-center rounded-sm bg-gray-700 text-gray-400"
										><Icon name={FILE_ICONS[file.kind] ?? 'package'} size={14} /></span
									>
								{/if}
								<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{file.name}</span>
								{#if file.own}
									<span class="session-badge rounded-sm bg-gray-600/40 px-1 py-px text-[10px] font-semibold text-gray-300"
										>this entry</span
									>
								{/if}
								<span class="text-[10px] uppercase text-gray-400">{fileNote(file)}</span>
							</button>
						{/each}
					</div>
					<div class="mt-2 flex gap-2">
						<Button size="xs" color="alternative" onclick={() => (picker = null)}>Close</Button>
					</div>
				{:else}
					<p class="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-100">
						<button id="session-file-back" class="ui-button-quiet" title="Back to the files" onclick={closeFile}
							>‹ Files</button
						>
						Objects in “{picker.file.name}”
					</p>
					<div class="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
						{#each picker.entries as entry (entry.index)}
							<label class="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-gray-200 hover:bg-gray-700">
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
							<p class="p-1 text-xs italic text-gray-400">This scene has no objects.</p>
						{/if}
					</div>
					<div class="mt-2 flex gap-2">
						<Button id="session-import-selected" size="xs" disabled={picker.checked.size === 0} onclick={runImport}>
							Import {picker.checked.size} into the scene
						</Button>
						<Button size="xs" color="alternative" onclick={() => (picker = null)}>Cancel</Button>
					</div>
				{/if}
			</div>
		{/if}

		{#if !$sessions.length}
			<p class="rounded-lg border border-dashed border-gray-600 p-4 text-center text-sm italic text-gray-400">
				No saved sessions yet — Save current scene keeps a named snapshot you can reload,
				share as a file or pick objects from later.
			</p>
		{:else if sessionView === 'list'}
			<!--
				R22 round 11: "allow list view as well (details with buttons for each row)". The
				facts a card spreads over four lines, on one — and the SAME actions, because a
				view is a layout and not a different set of things you can do. The per-kind
				difference is stated in one place (`Import files…` is offered for every entry;
				`Restore library` only exists for one that HAS a library) so the two views
				cannot disagree about it.
			-->
			<div id="session-list" class="flex flex-col gap-0.5">
				{#each shownSessions as meta (meta.id)}
					<div class="session-card session-row flex items-center gap-2 rounded-sm border border-gray-700/60 bg-gray-800/70 px-2 py-1">
						{#if meta.thumbnail}
							<img src={meta.thumbnail} alt="" class="h-8 w-12 shrink-0 rounded-sm object-cover" />
						{:else}
							<span class="flex h-8 w-12 shrink-0 items-center justify-center rounded-sm bg-gray-700 text-gray-400"
								><Archive size={14} aria-hidden="true" /></span
							>
						{/if}
						{#if renamingId === meta.id}
							<input
								class="ui-input w-40 text-sm"
								type="text"
								aria-label="Session name"
								bind:value={renameValue}
								use:focusInput
								onblur={confirmRename}
								onkeydown={(/** @type {KeyboardEvent} */ e) => {
									if (e.key === 'Enter') confirmRename();
									else if (e.key === 'Escape') renamingId = null;
								}}
							/>
						{:else}
							<button
								class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left text-sm font-semibold text-gray-100"
								title="Click to rename"
								onclick={() => beginRename(meta)}>{meta.name}</button
							>
						{/if}
						<span class="session-meta flex shrink-0 items-center gap-1.5 text-[10px]">
							{#if meta.hasLibrary}
								<span class="session-badge rounded-sm bg-teal-500/20 px-1 py-px font-semibold text-teal-300">Project</span>
								<span class="text-gray-500">{meta.libraryCount} file{meta.libraryCount === 1 ? '' : 's'}</span>
							{:else}
								<span class="session-badge rounded-sm bg-gray-600/40 px-1 py-px font-semibold text-gray-300">Scene</span>
							{/if}
						</span>
						<span class="shrink-0 text-[10px] text-gray-500">{meta.count} obj</span>
						<span class="session-size shrink-0 text-[10px] text-gray-500">{fmtBytes(meta.bytes)}</span>
						<span class="shrink-0 text-[10px] text-gray-500">{stamp(meta.createdAt)}</span>
						<div class="flex shrink-0 gap-1">
							<button
								class="ui-button-quiet session-load"
								title="Replace the scene with this entry (peers must accept)"
								onclick={() => {
									requestLoadSession(meta.id);
									sessionsOpen.set(false);
								}}>▶ Load</button
							>
							<button class="ui-button-quiet session-import" title="Browse this entry's files" onclick={() => openPicker(meta)}
								>⤵ Import files…</button
							>
							<button class="ui-button-quiet session-download-json" title="Download as JSON" onclick={() => downloadSession(meta)}
								>.json</button
							>
							<button
								class="ui-button-quiet session-download-zip"
								title="Download as a .zip with the scene's assets"
								onclick={() => downloadSession(meta, true)}>.zip</button
							>
							<button class="ui-button-quiet hover:bg-red-700" title="Delete" onclick={() => deleteSession(meta.id)}>✕</button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				{#each shownSessions as meta (meta.id)}
					<div class="session-card flex flex-col overflow-hidden rounded-lg border border-gray-700/60 bg-gray-800/70">
						{#if meta.thumbnail}
							<img src={meta.thumbnail} alt={meta.name} class="h-24 w-full object-cover" />
						{:else}
							<div class="flex h-24 w-full items-center justify-center bg-gray-700 text-2xl text-gray-400"><Archive size={16} aria-hidden="true" /></div>
						{/if}
						<div class="flex flex-col gap-1 p-2">
							{#if renamingId === meta.id}
								<!-- B5: inline rename (was a prompt) -->
								<input
									class="ui-input w-full text-sm"
									type="text"
									aria-label="Session name"
									bind:value={renameValue}
									use:focusInput
									onblur={confirmRename}
									onkeydown={(/** @type {KeyboardEvent} */ e) => {
										if (e.key === 'Enter') confirmRename();
										else if (e.key === 'Escape') renamingId = null;
									}}
								/>
							{:else}
								<p
									class="overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-gray-100"
									title="Double-click to rename"
									ondblclick={() => beginRename(meta)}
								>
									{meta.name}
								</p>
							{/if}
							<p class="text-[10px] text-gray-400">
								{meta.count} object{meta.count === 1 ? '' : 's'} · {stamp(meta.createdAt)}
							</p>
							<!--
								R22 round 9: WHAT KIND OF ENTRY IS THIS, and what does it cost. A project
								badge is derived from the payload carrying a library — nothing new is stored,
								so every session saved before this release is labelled correctly too.
							-->
							<p class="session-meta flex items-center gap-1.5 text-[10px]">
								{#if meta.hasLibrary}
									<span
										class="session-badge rounded-sm bg-teal-500/20 px-1 py-px font-semibold text-teal-300"
										title={'The scene AND ' + meta.libraryCount + ' library file' + (meta.libraryCount === 1 ? '' : 's')}
										>Project</span
									>
									<span class="text-gray-500">{meta.libraryCount} file{meta.libraryCount === 1 ? '' : 's'}</span>
								{:else}
									<span
										class="session-badge rounded-sm bg-gray-600/40 px-1 py-px font-semibold text-gray-300"
										title="The scene only — the Explorer's files are not in this entry"
										>Scene</span
									>
								{/if}
								<span class="session-size text-gray-500" title="Approximate — idb's own overhead is not measurable from here"
									>{fmtBytes(meta.bytes)}</span
								>
							</p>
							<div class="flex flex-wrap gap-1">
								<button class="ui-button-quiet session-load" title="Replace the scene with this entry (peers must accept)"
									onclick={() => { requestLoadSession(meta.id); sessionsOpen.set(false); }}>▶ Load</button>
								<button class="ui-button-quiet session-import" title="Browse this entry's files"
									onclick={() => openPicker(meta)}>⤵ Import files…</button>
								<button class="ui-button-quiet session-download-json" title="Download as JSON" onclick={() => downloadSession(meta)}><Download size={16} class="mr-1" aria-hidden="true" />.json</button>
								<button class="ui-button-quiet session-download-zip" title="Download as a .zip with the scene's assets" onclick={() => downloadSession(meta, true)}><Download size={16} class="mr-1" aria-hidden="true" />.zip</button>
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
