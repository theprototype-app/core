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
		sessionLibraryTree,
		importSessionFiles,
		importObjects
	} from '$lib/sessions';
	import { showConfirm } from '$lib/confirmDialog';
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
	/** the picker's own view, remembered separately — it lists FILES, not entries */
	let pickerView = typeof localStorage !== 'undefined' && localStorage.getItem('sessions:pickerView') === 'grid' ? 'grid' : 'list';
	$: if (typeof localStorage !== 'undefined') localStorage.setItem('sessions:pickerView', pickerView);
	/**
	 * R22 round 12 (user): "allow multiselect in sessions so I can delete multiple files".
	 * A Set of entry ids. Kept as a plain `let` reassigned wholesale — this file is LEGACY
	 * MODE, so a Set mutated in place would not re-render.
	 */
	let picked = new Set();
	/**
	 * @param {string} id @param {MouseEvent} e
	 *
	 * A CLICK ON A BUTTON IS NOT A CLICK ON THE ROW. Without this guard every action in the
	 * row also changed the selection on its way past — and pressing Load, which replaces the
	 * scene and closes this dialog, selected the entry on the way out. The Explorer's card
	 * handlers keep the same rule with `closest('button, input')`.
	 */
	function pickEntry(id, e) {
		if (/** @type {HTMLElement} */ (e.target)?.closest?.('button, input, a, label')) return;
		const next = new Set(picked);
		if (e.ctrlKey || e.metaKey || e.shiftKey) {
			if (next.has(id)) next.delete(id);
			else next.add(id);
		} else if (next.has(id) && next.size === 1) next.clear();
		else {
			next.clear();
			next.add(id);
		}
		picked = next;
	}
	$: if (!$sessionsOpen) picked = new Set();

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
	/**
	 * R22 round 12 (user): "allow multiselect in sessions so I can delete multiple files,
	 * also add confirmation dialog when deleting items".
	 *
	 * `deleteSession` had NO confirmation at all, not even for one entry — a saved scene was
	 * one stray click from gone. It asks now, and it asks through the app's own
	 * `ConfirmModal`, which is the RIGHT shape here and not in the Explorer: round 11 put
	 * the Explorer's question in an inline strip because the files are in the Explorer,
	 * whereas this manager is already a dialog and a second dialog over it is the ordinary
	 * pattern. (ConfirmModal is the one truly-modal dialog in the app, so it renders above
	 * this non-modal one.)
	 * @param {any[]} metas
	 */
	async function confirmDelete(metas) {
		const list = metas.filter(Boolean);
		if (!list.length) return;
		const names = list.length === 1 ? '"' + list[0].name + '"' : list.length + ' saved entries';
		const bytes = list.reduce((/** @type {number} */ sum, /** @type {any} */ m) => sum + (Number(m.bytes) || 0), 0);
		const ok = await showConfirm({
			title: 'Delete ' + names + '?',
			message:
				'This frees about ' +
				fmtBytes(bytes) +
				'. Saved entries live on this machine only, so nobody else is affected — and there is no bin for them.',
			confirmLabel: list.length === 1 ? 'Delete' : 'Delete ' + list.length
		});
		if (!ok) return;
		for (const meta of list) await deleteSession(meta.id);
		picked = new Set();
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

	/**
	 * R22 round 12 (user): "for saved scene in session modal it should write 'import
	 * objects' ... I should open scene automatically and allow to select objects to import
	 * as it was before".
	 *
	 * Round 11 gave EVERY entry a file level. For a scene-only entry that level holds
	 * exactly one row, which is a click that answers nothing — so a scene entry goes
	 * straight to its objects and a project entry starts on its files. Same two levels,
	 * one of them skipped when it has nothing to say.
	 * @param {any} meta
	 */
	async function openPicker(meta) {
		const payload = await getSession(meta.id);
		if (!payload) return;
		const files = sessionFileList(payload);
		picker = {
			id: meta.id,
			name: meta.name,
			payload,
			files,
			tree: sessionLibraryTree(payload),
			file: null,
			entries: [],
			innerPayload: null,
			checked: new Set(),
			pickedFiles: new Set(),
			pickedFolders: new Set()
		};
		// a SCENE entry is its own single file: open it and show the objects
		if (!meta.hasLibrary) await openFile(files[0]);
	}

	/** ticking a file row in the project picker */
	/** @param {any} row */
	function toggleFile(row) {
		if (!picker) return;
		const files = new Set(picker.pickedFiles);
		const folders = new Set(picker.pickedFolders);
		if (row.kind === 'folder') {
			if (folders.has(row.id)) folders.delete(row.id);
			else folders.add(row.id);
		} else if (files.has(row.index)) files.delete(row.index);
		else files.add(row.index);
		picker = { ...picker, pickedFiles: files, pickedFolders: folders };
	}
	/**
	 * Anything inside a ticked FOLDER reads as picked, so the checkboxes agree with the act.
	 *
	 * "Anything" includes a nested FOLDER, not only files — measured: ticking Textures left
	 * its child Bricks unticked while both of Bricks' files showed as picked, which reads as
	 * a box that disagrees with the rows under it. The containment test is on the PATH,
	 * which is the one thing every row carries and which cannot go stale.
	 * @param {any} row @returns {boolean}
	 */
	function rowPicked(row) {
		if (!picker) return false;
		if (row.kind === 'folder' && picker.pickedFolders.has(row.id)) return true;
		if (row.kind === 'file' && picker.pickedFiles.has(row.index)) return true;
		return picker.tree.some(
			(/** @type {any} */ f) =>
				f.kind === 'folder' &&
				f.id !== row.id &&
				picker.pickedFolders.has(f.id) &&
				row.path.startsWith(f.path + '/')
		);
	}
	$: pickedFileCount = picker
		? picker.tree.filter((/** @type {any} */ r) => r.kind === 'file' && rowPicked(r)).length
		: 0;

	/** bring the ticked files into the CURRENT Explorer library */
	async function runFileImport() {
		if (!picker) return;
		const n = await importSessionFiles(picker.payload, {
			items: [...picker.pickedFiles],
			folders: [...picker.pickedFolders]
		});
		showToast(n ? 'Imported ' + n + ' file' + (n === 1 ? '' : 's') + ' into your Library' : 'Nothing was imported');
		picker = null;
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

	/** the anchor + object URL ritual, the one way a page can start a download
	 * @param {Blob} blob @param {string} filename */
	function saveBlob(blob, filename) {
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = filename;
		link.click();
		URL.revokeObjectURL(link.href);
	}

	/**
	 * R22 round 12 (user): "instead of .json download allow to download session as .tpscene
	 * or .tp would make more sense (or if .json is useful, keep it also)".
	 *
	 * A SCENE entry IS a .tpscene by construction — `exportSessionZip` produces exactly that
	 * format, and the old `.session.zip` was the same bytes under a name nothing else in the
	 * app recognises.
	 *
	 * WHY THERE IS NO .tp: that is projectFile's format, written by `exportProject` FROM THE
	 * LIVE STORES (the manifest, the Explorer, the version history). Writing one from a
	 * SAVED payload would be a second writer of one format, which that file's own comments
	 * warn against — and the reason it was wanted, "a file carrying the whole project", is
	 * now true of the bundle: round 12 made the library travel as real files inside it. It
	 * used to stringify a Blob to `{}` and lose every one, silently.
	 *
	 * `.json` is KEPT, as the user allowed: it is the only human-readable form, it is what a
	 * bug report can carry, and dropping it would take something away to add something.
	 * @param {any} meta @param {'scene'|'json'} [format]
	 */
	async function downloadSession(meta, format = 'scene') {
		const payload = await getSession(meta.id);
		if (!payload) return;
		const safe = String(meta.name).replace(/[^\w-]+/g, '_');
		if (format === 'json') {
			saveBlob(new Blob([exportSession(payload)], { type: 'application/json' }), safe + '.session.json');
			return;
		}
		const bytes = await exportSessionZip(payload);
		saveBlob(
			new Blob([/** @type {BlobPart} */ (bytes)], { type: 'application/zip' }),
			safe + '.tpscene'
		);
	}

	/** @param {any} event */
	/**
	 * R22 round 12 (user): "also allow to import session file as .tpscene and .tp formats
	 * (name can be taken from filename, maybe or project name inside imported project, pick
	 * best option here, maybe combination)".
	 *
	 * THE NAME RULE IS PER FORMAT, and each already had a reason:
	 *   · a .tpscene keeps the name INSIDE it, with the filename as the fallback — that is
	 *     what its author called the scene, and it is the order travelToLevel already uses;
	 *   · a .tp keeps the FILENAME, and that is 21-I's explicit ruling, not an oversight:
	 *     you picked "Dungeon v3.tp" off a disk, so "Dungeon v3" is what you will look for,
	 *     and two exports of one project would otherwise both land under one name.
	 * So this passes each importer the thing it asks for and does not impose one rule on a
	 * format that already decided.
	 *
	 * .tpscene IS a session zip — same bytes, same reader, and after round 12 it carries a
	 * project's library files too. .tp is projectFile's own format with a different shape
	 * inside, so it goes to ITS importer, which keeps the V4 format dialog: an import is
	 * one person at a file dialog, which is exactly where a question can be answered.
	 * @param {any} event
	 */
	async function importSessionFile(event) {
		const file = event.target.files?.[0];
		if (!file) return;
		const name = file.name.toLowerCase();
		const stem = file.name.replace(/\.[^.]+$/, '');
		try {
			if (name.endsWith('.tp')) {
				const { importProjectAsFolder } = await import('$lib/projectFile');
				await importProjectAsFolder(await file.arrayBuffer(), { fileName: file.name });
			} else if (name.endsWith('.zip') || name.endsWith('.tpscene')) {
				// 127: a .zip restores its bundled assets into the Explorer first
				const payload = await importSessionZip(await file.arrayBuffer());
				// the name INSIDE wins; the filename is the fallback (see above)
				if (payload && !payload.name) await renameSession(payload.id, stem);
			} else await importSession(await file.text());
		} catch {
			showToast('Not a valid session or project file');
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
			<input
				type="file"
				id="session-import-file"
				style="display: none"
				accept=".json,.zip,.tpscene,.tp"
				onchange={importSessionFile}
			/>
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
				{#if picked.size}
					<span id="session-picked" class="text-gray-300">{picked.size} selected</span>
					<button
						id="session-delete-picked"
						class="ui-button-quiet hover:bg-red-700"
						title="Delete every selected entry"
						onclick={() => confirmDelete(shownSessions.filter((/** @type {any} */ m) => picked.has(m.id)))}
						>Delete {picked.size}</button
					>
					<button class="ui-button-quiet" title="Clear the selection" onclick={() => (picked = new Set())}
						>Clear</button
					>
				{/if}
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
					<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
					<div
						class="session-card session-row flex items-center gap-2 rounded-sm border px-2 py-1 {picked.has(meta.id)
							? 'session-picked border-primary-500 bg-primary-600/20'
							: 'border-gray-700/60 bg-gray-800/70'}"
						onclick={(e) => pickEntry(meta.id, e)}
					>
						{#if meta.thumbnail}
							<img src={meta.thumbnail} alt="" class="h-8 w-12 shrink-0 rounded-sm object-cover" />
						{:else}
							<span class="flex h-8 w-12 shrink-0 items-center justify-center rounded-sm bg-gray-700 text-gray-400"
								><Archive size={14} aria-hidden="true" /></span
							>
						{/if}
						{#if renamingId === meta.id}
							<!-- the same flex slot the name occupies, so committing does not shift the row -->
							<input
								class="ui-input min-w-0 flex-1 text-sm"
								type="text"
								aria-label="Session name"
								bind:value={renameValue}
								use:focusInput
								onclick={(/** @type {MouseEvent} */ e) => e.stopPropagation()}
								onblur={confirmRename}
								onkeydown={(/** @type {KeyboardEvent} */ e) => {
									if (e.key === 'Enter') confirmRename();
									else if (e.key === 'Escape') renamingId = null;
								}}
							/>
						{:else}
							<!--
								R22 round 12 (user): "when clicking on name buttons from right move, it
								should not be like that, and add double click to rename, as its confusing
								when I just click I want it to highlight and do nothing".
								Round 11 made this a button that renamed on a SINGLE click, which is not
								what a name is for: a click SELECTS (and highlights), a double click
								renames. That is the Explorer's own convention, the grid view's existing
								one and every file manager's — and it is why the two agree now.
							-->
							<span
								class="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-semibold text-gray-100"
								title="Double-click to rename"
								ondblclick={(e) => {
									e.stopPropagation();
									beginRename(meta);
								}}>{meta.name}</span
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
							<button
								class="ui-button-quiet session-import"
								title={meta.hasLibrary
									? "Browse this entry's files, and pick objects out of any scene in it"
									: 'Pick objects from this scene to add to the one on screen'}
								onclick={() => openPicker(meta)}
								>⤵ {meta.hasLibrary ? 'Import files…' : 'Import objects…'}</button
							>
							<button
								class="ui-button-quiet session-download-scene"
								title="Download as .tpscene — the bundle this app can open again, with its assets and (for a project) its library files"
								onclick={() => downloadSession(meta)}>.tpscene</button
							>
							<button
								class="ui-button-quiet session-download-json"
								title="Download as JSON — readable, and what a bug report can carry"
								onclick={() => downloadSession(meta, 'json')}>.json</button
							>
							<button class="ui-button-quiet hover:bg-red-700" title="Delete" onclick={() => confirmDelete([meta])}>✕</button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3">
				{#each shownSessions as meta (meta.id)}
					<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
					<div
						class="session-card flex flex-col overflow-hidden rounded-lg border {picked.has(meta.id)
							? 'session-picked border-primary-500 bg-primary-600/20'
							: 'border-gray-700/60 bg-gray-800/70'}"
						onclick={(e) => pickEntry(meta.id, e)}
					>
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
								<button class="ui-button-quiet session-import" title={meta.hasLibrary ? "Browse this entry's files, and pick objects out of any scene in it" : 'Pick objects from this scene to add to the one on screen'}
									onclick={() => openPicker(meta)}>⤵ {meta.hasLibrary ? 'Import files…' : 'Import objects…'}</button>
								<button class="ui-button-quiet session-download-scene" title="Download as .tpscene — the bundle this app can open again, with its assets and (for a project) its library files" onclick={() => downloadSession(meta)}><Download size={16} class="mr-1" aria-hidden="true" />.tpscene</button>
								<button class="ui-button-quiet session-download-json" title="Download as JSON — readable, and what a bug report can carry" onclick={() => downloadSession(meta, 'json')}><Download size={16} class="mr-1" aria-hidden="true" />.json</button>
								<button class="ui-button-quiet hover:bg-red-700" title="Delete"
									onclick={() => confirmDelete([meta])}>✕</button>
							</div>
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</Modal>

<!--
	R22 round 12 (user): "rework on this 'import files'/'import object' dialog, it feels
	strange when it appears from top, maybe its better to open it as another modal, make it
	proper per UI/UX standards, also allow to view as list and as thumbnails (thumbnails
	should also allow to multiselect)".

	It was a block that grew out of the top of the Sessions body and pushed the entries
	down — which is why it "feels strange": nothing else in the app answers a question by
	shoving the thing you asked about off the screen. It is its own dialog now, over the
	one that opened it.

	NON-MODAL, like every other dialog in this app (dialog.show(), never showModal): the
	top layer makes everything else INERT, which kills body-portalled menus, the approval
	toasts and the chrome above --z-modal. That is a documented rule, and it is also why
	this needs its own Escape handler — a non-modal dialog fires no cancel event.
-->
{#if picker}
	<Modal
		title={picker.file ? 'Import objects' : 'Import files'}
		open={true}
		modal={false}
		onkeydown={(e) => {
			if (e.key === 'Escape') picker = null;
		}}
		outsideclose
		size="lg"
		class="tp-modal-frame"
		classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
	>
		<div id="session-picker" class="flex h-full min-h-0 flex-col gap-2 p-1">
			<div class="flex flex-wrap items-center gap-2 text-xs text-gray-400">
				{#if picker.file}
					<button id="session-file-back" class="ui-button-quiet" title="Back to the files" onclick={closeFile}
						>‹ Files</button
					>
					<span class="text-gray-200">{picker.file.name}</span>
				{:else}
					<span class="text-gray-200">{picker.name}</span>
				{/if}
				<span class="flex-1"></span>
				<!-- the same Grid/List pair the entries above use, so one control means one thing -->
				<div class="tp-seg" role="group" aria-label="View">
					<button
						id="picker-view-list"
						class="tp-seg-btn"
						aria-pressed={pickerView === 'list'}
						title="Details"
						onclick={() => (pickerView = 'list')}><List size={14} aria-hidden="true" /></button
					>
					<button
						id="picker-view-grid"
						class="tp-seg-btn"
						aria-pressed={pickerView === 'grid'}
						title="Thumbnails"
						onclick={() => (pickerView = 'grid')}><LayoutGrid size={14} aria-hidden="true" /></button
					>
				</div>
			</div>

			{#if picker.file}
				<!-- LEVEL TWO: the objects inside one scene file -->
				<div id="session-object-list" class="min-h-0 flex-1 overflow-y-auto">
					{#if pickerView === 'grid'}
						<div class="grid grid-cols-[repeat(auto-fill,120px)] justify-start gap-2">
							{#each picker.entries as entry (entry.index)}
								<button
									class="picker-card flex flex-col items-center gap-1 rounded border p-2 text-center {picker.checked.has(
										entry.index
									)
										? 'border-primary-500 bg-primary-600/20'
										: 'border-gray-700/60 hover:border-gray-500'}"
									onclick={() => togglePick(entry.index)}
								>
									<span class="text-gray-400"><Icon name={FILE_ICONS.object} size={22} /></span>
									<span class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-200"
										>{entry.name}</span
									>
									<span class="text-[10px] uppercase text-gray-500">{entry.type}</span>
								</button>
							{/each}
						</div>
					{:else}
						<div class="flex flex-col gap-0.5">
							{#each picker.entries as entry (entry.index)}
								<label
									class="picker-row flex cursor-pointer items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-gray-200 hover:bg-gray-700"
								>
									<input
										type="checkbox"
										checked={picker.checked.has(entry.index)}
										onchange={() => togglePick(entry.index)}
									/>
									<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{entry.name}</span>
									<span class="text-[10px] uppercase text-gray-400">{entry.type}</span>
								</label>
							{/each}
						</div>
					{/if}
					{#if !picker.entries.length}
						<p class="p-1 text-xs italic text-gray-400">This scene has no objects.</p>
					{/if}
				</div>
				<div class="flex shrink-0 gap-2">
					<Button id="session-import-selected" size="xs" disabled={picker.checked.size === 0} onclick={runImport}>
						Import {picker.checked.size} into the scene
					</Button>
					<Button size="xs" color="alternative" onclick={() => (picker = null)}>Cancel</Button>
				</div>
			{:else}
				<!--
					LEVEL ONE: the FILES, with the folder structure the payload always carried and
					nothing ever drew. Ticking a folder takes everything under it.
				-->
				<div id="session-file-list" class="min-h-0 flex-1 overflow-y-auto">
					{#if pickerView === 'grid'}
						<div class="grid grid-cols-[repeat(auto-fill,120px)] justify-start gap-2">
							{#each picker.tree as row (row.key)}
								<button
									class="picker-card session-file flex flex-col items-center gap-1 rounded border p-2 text-center {rowPicked(
										row
									)
										? 'border-primary-500 bg-primary-600/20'
										: 'border-gray-700/60 hover:border-gray-500'}"
									data-kind={row.kind === 'folder' ? 'folder' : row.kindOf}
									title={row.path}
									onclick={() => toggleFile(row)}
								>
									{#if row.thumbnail}
										<img src={row.thumbnail} alt="" class="h-12 w-full rounded-sm object-cover" />
									{:else}
										<span class="flex h-12 items-center text-gray-400"
											><Icon
												name={row.kind === 'folder' ? 'folder' : (FILE_ICONS[row.kindOf] ?? 'package')}
												size={22}
											/></span
										>
									{/if}
									<span class="w-full overflow-hidden text-ellipsis whitespace-nowrap text-xs text-gray-200"
										>{row.name}</span
									>
								</button>
							{/each}
						</div>
					{:else}
						<div class="flex flex-col gap-0.5">
							{#each picker.tree as row (row.key)}
								<label
									class="picker-row session-file flex cursor-pointer items-center gap-2 rounded-sm px-1 py-1 text-sm text-gray-200 hover:bg-gray-700"
									data-kind={row.kind === 'folder' ? 'folder' : row.kindOf}
									title={row.path}
									style="padding-left: {4 + row.depth * 16}px"
								>
									<input type="checkbox" checked={rowPicked(row)} onchange={() => toggleFile(row)} />
									{#if row.thumbnail}
										<img src={row.thumbnail} alt="" class="h-6 w-8 shrink-0 rounded-sm object-cover" />
									{:else}
										<span class="shrink-0 text-gray-400"
											><Icon
												name={row.kind === 'folder' ? 'folder' : (FILE_ICONS[row.kindOf] ?? 'package')}
												size={14}
											/></span
										>
									{/if}
									<span class="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{row.name}</span>
									<!--
										R22 round 12: a scene FILE keeps round 11's drill-in. The checkbox and
										this button are the dialog's TWO ACTS on one row, and they are genuinely
										different: ticking brings the FILE into the Library, opening picks
										OBJECTS out of it and into the scene. A row that offered only the first
										would have taken the second away, which round 11 added on purpose.
									-->
									{#if row.kindOf === 'scene'}
										<button
											class="session-file-open ui-button-quiet"
											title="Open this scene and pick objects out of it"
											onclick={(e) => {
												e.preventDefault();
												e.stopPropagation();
												void openFile({ index: row.index, kind: 'scene', name: row.name });
											}}>Open…</button
										>
									{/if}
									<span class="text-[10px] uppercase text-gray-400"
										>{row.kind === 'folder' ? 'folder' : row.kindOf}</span
									>
								</label>
							{/each}
						</div>
					{/if}
					{#if !picker.tree.length}
						<p class="p-1 text-xs italic text-gray-400">
							This entry has no library files — it is a scene on its own.
						</p>
					{/if}
				</div>
				<div class="flex shrink-0 flex-wrap items-center gap-2">
					<Button id="session-import-files" size="xs" disabled={pickedFileCount === 0} onclick={runFileImport}>
						Import {pickedFileCount} file{pickedFileCount === 1 ? '' : 's'} into the Library
					</Button>
					<!-- the OTHER act this dialog offers, and they are different: files go to the
					     Explorer, objects go into the world -->
					<!--
						THE ENTRY'S OWN SCENE is not a library file, so it is not a row in the tree —
						it is the scene the entry IS. Its own button, beside the file import, because
						the two are different acts on different things.
					-->
					<Button
						id="session-open-scene"
						size="xs"
						color="alternative"
						title="Open this entry's own scene and pick objects out of it"
						onclick={() => void openFile(picker.files[0])}>Objects from its scene…</Button
					>
					<span class="flex-1"></span>
					<Button size="xs" color="alternative" onclick={() => (picker = null)}>Close</Button>
				</div>
			{/if}
		</div>
	</Modal>
{/if}
