<script>
	// 36-fb-code (F6): the code workspace's LEFT sidebar. Top: OPEN EDITORS — the open tabs in
	// the tab strip's own order (drag to reorder: one order, both places). A draggable separator.
	// Below: PROJECT — every source the scene has (codeProject.js builds the tree), searchable,
	// read-only module sources with "Make editable copy". Chrome only; the verbs are the
	// workspace's (openCode, moveCodeTab, the forks).
	// 70 W1: the Files group is the Explorer's own folders and text files, and here they are made,
	// renamed, moved and deleted — header buttons, a context menu (right-click, Shift+F10), keys
	// (F2, Delete, Ctrl+X / Ctrl+V to move, Ctrl+Z) and drag. The verbs are codeFiles.js.
	import Icon from '../ui/Icon.svelte';
	import { codeTabs, activeCodeTab, openCode, moveCodeTab, forkCodeTab, forkNodeTab, tabById } from '$lib/codeWorkspace';
	import { isDirty } from '$lib/codeTabs';
	import { codeLeftSplit } from '$lib/codeSidebars';
	import { projectTree, filterTree, keyOfTab, moduleLeaf } from '$lib/codeProject';
	import { dragReorder } from '$lib/dragReorder';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { arrowNav } from '$lib/arrowNav';
	import { flowGraphs } from '../../stores/flowStore';
	import { objectsGroup } from '../../stores/sceneStore';
	import { explorerItems, explorerFolders, folderPath, revealItem, activeFolder } from '$lib/explorer';
	import ContextMenu from '../ContextMenu.svelte';
	import { rolesInfo } from '$lib/cloudHooks';
	import { explorerClose } from '../../stores/appStore.js';
	import { deleteWithoutConfirm, recycleBinEnabled } from '$lib/sharedLibrary';
	import { FILE_TEMPLATES, templateOf, fileNameFor, renamedFileName, stemOf, moveProblem, subtreeOf } from '$lib/codeFilesCore.js';
	import {
		createCodeFile,
		createCodeFolder,
		renameCodeEntry,
		moveCodeEntry,
		deleteCodeEntry,
		deleteCounts,
		undoLastFileOp,
		lastFileOp,
		VIEWER_REASON
	} from '$lib/codeFiles';
	import { nodesBoundTo } from '$lib/scriptAssets';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { moduleSourceFiles } from '$lib/codeOpen';

	/** `badOf(tab)` = does the tab have problems (the strip's red mark); `onClose(id)` = the
	 * workspace's close-with-confirm
	 * @type {{ badOf: (tab: any) => boolean, onClose: (id: string) => void }} */
	let { badOf, onClose } = $props();

	const active = $derived($codeTabs.find((t) => t.id === $activeCodeTab) ?? null);
	const activeKey = $derived(keyOfTab(active));

	// ---------------------------------------------------------------- the separator
	let host = /** @type {HTMLElement | null} */ (null);
	let splitting = false;
	/** @param {PointerEvent} e */
	function startSplit(e) {
		splitting = true;
		/** @type {HTMLElement} */ (e.currentTarget).setPointerCapture(e.pointerId);
		e.preventDefault();
	}
	/** @param {PointerEvent} e */
	function moveSplit(e) {
		if (!splitting || !host) return;
		const r = host.getBoundingClientRect();
		codeLeftSplit.set(Math.min(0.9, Math.max(0.1, (e.clientY - r.top) / Math.max(1, r.height))));
	}
	/** @param {PointerEvent} e */
	function endSplit(e) {
		if (!splitting) return;
		splitting = false;
		/** @type {HTMLElement} */ (e.currentTarget).releasePointerCapture?.(e.pointerId);
	}

	// ---------------------------------------------------------------- the project tree
	let query = $state('');
	/** groups the user opened or closed (absent = its default) @type {Record<string, boolean>} */
	let opened = $state({});
	/** a module's whole file list, once expanded @type {Record<string, string[]>} */
	let moduleFiles = $state({});
	const DEFAULT_OPEN = new Set(['grp:graphs', 'grp:scene', 'grp:files', 'grp:modules']);

	/** @param {string} id */
	function graphTitle(id) {
		if (id === 'scene') return 'Main graph';
		void $objectsGroup;
		/** @type {any} */
		const g = $objectsGroup;
		const o = g?.getObjectByProperty?.('uuid', id);
		return o?.name || 'Object ' + id.slice(0, 6);
	}

	const tree = $derived.by(() => {
		const built = projectTree({
			graphs: $flowGraphs,
			graphTitle,
			// 70 W1: every folder and text file (filesTree keeps the text ones)
			scripts: $explorerItems,
			folders: $explorerFolders,
			boundCount: (hash) => nodesBoundTo(hash).length,
			specOf: (type) => findNodeSpec(type)
		});
		// a module the user expanded lists every file it has, not only the ones the graphs name
		/** @param {any[]} list @returns {any[]} */
		const withFiles = (list) =>
			list.map((/** @type {any} */ n) => {
				if (n.lazy && moduleFiles[n.lazy]) {
					const have = new Set(n.children.map((/** @type {any} */ c) => c.label));
					const extra = moduleFiles[n.lazy].filter((f) => !have.has(f)).map((f) => moduleLeaf(n.lazy, f));
					return { ...n, children: [...n.children, ...extra] };
				}
				return n.children ? { ...n, children: withFiles(n.children) } : n;
			});
		return withFiles(built);
	});
	const shown = $derived(filterTree(tree, query));
	const filtering = $derived(query.trim().length > 0);

	/** @param {any} node */
	function isOpen(node) {
		if (filtering) return true;
		return opened[node.key] ?? DEFAULT_OPEN.has(node.key);
	}
	/** open a group (and every folder above it) @param {string} key */
	function reveal(key) {
		/** @type {Record<string, boolean>} */
		const next = { ...opened, 'grp:files': true, [key]: true };
		let at = key.startsWith('dir:') ? key.slice(4) : null;
		for (let i = 0; at && i < 64; i++) {
			next['dir:' + at] = true;
			at = $explorerFolders.find((f) => f.id === at)?.parentId ?? null;
		}
		opened = next;
	}
	/** @param {any} node */
	async function toggle(node) {
		const next = !isOpen(node);
		opened = { ...opened, [node.key]: next };
		if (next && node.lazy && !moduleFiles[node.lazy]) {
			const files = await moduleSourceFiles(node.lazy).catch(() => []);
			moduleFiles = { ...moduleFiles, [node.lazy]: files.map((f) => f.file).filter((f) => /\.m?js$/.test(f)) };
		}
	}

	/** @param {any} leaf */
	function openLeaf(leaf) {
		if (leaf.request) void openCode(leaf.request);
	}
	/** "Make editable copy" straight from the tree: open the source, then fork its tab @param {any} leaf */
	async function forkLeaf(leaf) {
		const id = await openCode(leaf.request);
		if (!id) return;
		const tab = tabById(id);
		if (leaf.fork === 'node' && tab?.readOnly) await forkNodeTab(id);
		else if (tab?.kind === 'module') await forkCodeTab(id);
	}

	// ---------------------------------------------------------------- 70 W1: files and folders
	const viewer = $derived(/** @type {any} */ ($rolesInfo)?.myRole === 'viewer');
	/** every node of the Files group by key (the unfiltered tree: a menu may act on a hidden row) */
	const fileNodes = $derived.by(() => {
		/** @type {Map<string, any>} */
		const out = new Map();
		/** @param {any[]} list */
		const walk = (list) => {
			for (const n of list) {
				out.set(n.key, n);
				if (n.children) walk(n.children);
			}
		};
		const group = tree.find((g) => g.key === 'grp:files');
		if (group) {
			out.set(group.key, group);
			walk(group.children ?? []);
		}
		return out;
	});
	/** what a tree key names in the Files group, or null @param {string} key
	 * @returns {{kind: 'file' | 'folder' | 'root', id: string, name: string, parentId: string | null} | null} */
	function entryOf(key) {
		if (key === 'grp:files') return { kind: 'root', id: '', name: 'Files', parentId: null };
		const n = fileNodes.get(key);
		if (!n) return null;
		if (key.startsWith('dir:')) return { kind: 'folder', id: n.folderId, name: n.label, parentId: n.parentId ?? null };
		if (n.itemId) return { kind: 'file', id: n.itemId, name: n.label, parentId: n.parentId ?? null };
		return null;
	}
	/** the folder a new file lands in from this row: the folder itself, a file's folder, else the root
	 * @param {string} key */
	function folderAt(key) {
		const e = entryOf(key);
		if (!e) return null;
		return e.kind === 'folder' ? e.id : e.parentId;
	}

	/** the inline name field: a new file / folder, or a rename
	 * @type {{mode: 'new-file' | 'new-folder' | 'rename', template?: string, parentId?: string | null, kind?: 'file' | 'folder', id?: string, key?: string, value: string} | null} */
	let editing = $state(null);
	let editError = $state('');
	/** @param {'new-file' | 'new-folder'} mode @param {string | null} parentId @param {string} [template] */
	function startNew(mode, parentId, template = 'script') {
		if (viewer) return;
		reveal(parentId ? 'dir:' + parentId : 'grp:files');
		editError = '';
		editing = mode === 'new-file' ? { mode, template, parentId, value: stemOf(templateOf(template).defaultName) } : { mode, parentId, value: 'New folder' };
	}
	/** @param {string} key */
	function startRename(key) {
		const e = entryOf(key);
		if (viewer || !e || e.kind === 'root') return;
		editError = '';
		editing = { mode: 'rename', kind: e.kind, id: e.id, key, value: e.name };
	}
	async function commitEdit() {
		const ed = editing;
		if (!ed) return;
		if (ed.mode === 'new-file') {
			const r = await createCodeFile({ template: ed.template, name: ed.value, folderId: ed.parentId ?? null, quiet: true });
			if (!r.ok) return void (editError = r.reason ?? '');
			editing = null;
			treeFocus = 'f:' + r.item.id;
		} else if (ed.mode === 'new-folder') {
			const r = createCodeFolder({ name: ed.value, parentId: ed.parentId ?? null, quiet: true });
			if (!r.ok) return void (editError = r.reason ?? '');
			editing = null;
			treeFocus = 'dir:' + r.folder.id;
			focusKey(treeFocus);
		} else if (ed.kind && ed.id) {
			const r = renameCodeEntry({ kind: ed.kind, id: ed.id, name: ed.value }, { quiet: true });
			if (!r.ok) return void (editError = r.reason ?? '');
			editing = null;
			focusKey(ed.key ?? '');
		}
	}
	function cancelEdit() {
		const key = editing?.key;
		editing = null;
		editError = '';
		if (key) focusKey(key);
	}
	/** @param {KeyboardEvent} e */
	function editKeys(e) {
		e.stopPropagation();
		if (e.key === 'Enter') {
			e.preventDefault();
			void commitEdit();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			cancelEdit();
		}
	}
	/** leaving the field keeps a good name and drops a bad one (nothing is left half-typed) */
	async function editBlur() {
		const ed = editing;
		if (!ed) return;
		await commitEdit();
		if (editing === ed) cancelEdit();
	}
	/** the field opens with the NAME selected, not the extension @param {HTMLInputElement} node */
	function focusName(node) {
		queueMicrotask(() => {
			node.focus();
			const dot = node.value.lastIndexOf('.');
			node.setSelectionRange(0, dot > 0 ? dot : node.value.length);
		});
	}
	/** what the field will make, for its label @param {any} ed */
	const editLabel = (ed) =>
		ed.mode === 'new-file' ? 'Name of the new ' + templateOf(ed.template).label + ' file' : ed.mode === 'new-folder' ? 'Name of the new folder' : 'New name for ' + ed.value;
	const editPreview = $derived.by(() => {
		const ed = /** @type {any} */ (editing);
		if (ed?.mode === 'new-file') return fileNameFor(ed.value, ed.template ?? 'script');
		const old = ed?.mode === 'rename' && ed.kind === 'file' ? entryOf(ed.key)?.name : '';
		return old ? renamedFileName(ed.value, old) : '';
	});

	/** @param {string} key */
	function focusKey(key) {
		if (!key) return;
		treeFocus = key;
		queueMicrotask(() => /** @type {HTMLElement | null | undefined} */ (host?.querySelector(`#code-ws-project [data-tree-key="${CSS.escape(key)}"]`))?.focus?.());
	}

	// delete, with the Explorer's confirm (skipped by its "Delete without asking" setting)
	/** @type {{kind: 'file' | 'folder', id: string, name: string, key: string, text: string} | null} */
	let confirmDel = $state(null);
	/** @param {string} key */
	function askDelete(key) {
		const e = entryOf(key);
		if (viewer || !e || e.kind === 'root') return;
		if ($deleteWithoutConfirm) return void deleteCodeEntry({ kind: e.kind, id: e.id });
		const c = deleteCounts({ kind: e.kind, id: e.id });
		const inside =
			e.kind === 'folder' && (c.files || c.folders > 1)
				? ' and everything in it (' + [c.folders > 1 ? c.folders - 1 + (c.folders === 2 ? ' folder' : ' folders') : '', c.files ? c.files + (c.files === 1 ? ' file' : ' files') : ''].filter(Boolean).join(', ') + (c.hidden ? ', ' + c.hidden + ' not listed here' : '') + ')'
				: '';
		const after = $recycleBinEnabled ? ' It goes to Deleted in the Explorer — Undo or Restore brings it back.' : ' The recycle bin is off: this cannot be undone.';
		confirmDel = { kind: e.kind, id: e.id, name: e.name, key, text: 'Delete "' + e.name + '"' + inside + '?' + after };
	}
	function confirmDelete() {
		const c = confirmDel;
		confirmDel = null;
		if (c) deleteCodeEntry({ kind: c.kind, id: c.id });
		focusKey('grp:files');
	}
	function cancelDelete() {
		const key = confirmDel?.key ?? '';
		confirmDel = null;
		focusKey(key);
	}

	// move: drag, "Move to", or Ctrl+X then Ctrl+V on the destination
	/** @type {{kind: 'file' | 'folder', id: string, name: string, parentId: string | null} | null} */
	let cut = $state(null);
	/** @param {{kind: 'file' | 'folder', id: string}} what @param {string | null} to */
	function moveTo(what, to) {
		const r = moveCodeEntry({ kind: what.kind, id: what.id, to });
		if (r.ok && to) reveal('dir:' + to);
		return r.ok;
	}
	/** @param {string} key */
	function cutAt(key) {
		const e = entryOf(key);
		if (viewer || !e || e.kind === 'root') return;
		cut = { kind: e.kind, id: e.id, name: e.name, parentId: e.parentId };
	}
	/** @param {string} key */
	function pasteAt(key) {
		if (!cut) return;
		const to = folderAt(key);
		if (moveTo(cut, to)) cut = null;
	}
	/** @type {{kind: 'file' | 'folder', id: string, parentId: string | null} | null} */
	let dragging = null;
	let dropKey = $state('');
	/** @param {DragEvent} e @param {string} key */
	function dragStart(e, key) {
		const en = entryOf(key);
		if (viewer || !en || en.kind === 'root' || !e.dataTransfer) return e.preventDefault();
		dragging = { kind: en.kind, id: en.id, parentId: en.parentId };
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/plain', en.name);
	}
	/** the folder a drop on this row means: a folder row, the Files group (the root) @param {string} key */
	const dropFolder = (key) => (key === 'grp:files' ? null : key.startsWith('dir:') ? key.slice(4) : undefined);
	/** @param {DragEvent} e @param {string} key */
	function dragOver(e, key) {
		const to = dropFolder(key);
		if (!dragging || to === undefined || moveProblem(dragging, to, $explorerFolders)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropKey = key;
	}
	/** @param {DragEvent} e @param {string} key */
	function dropOn(e, key) {
		const to = dropFolder(key);
		const what = dragging;
		dragging = null;
		dropKey = '';
		if (!what || to === undefined) return;
		e.preventDefault();
		moveTo(what, to);
	}
	function dragEnd() {
		dragging = null;
		dropKey = '';
	}

	// the context menu (right-click on a row, Shift+F10 / the Menu key)
	/** @type {{x: number, y: number, items: any[]} | null} */
	let menu = $state(null);
	/** @param {any} item */
	const gated = (item) => (viewer ? { ...item, disabled: true, tooltip: VIEWER_REASON, children: undefined } : item);
	/** @param {string | null} parentId */
	function newItems(parentId) {
		return [
			gated({
				label: 'New file',
				icon: 'file-plus',
				children: FILE_TEMPLATES.map((t) => ({ label: t.label, icon: t.icon, tooltip: t.tooltip, action: () => startNew('new-file', parentId, t.key) }))
			}),
			gated({ label: 'New folder', icon: 'folder-plus', action: () => startNew('new-folder', parentId) })
		];
	}
	/** "Move to ▸": every folder it can go to, by path, and the Library root
	 * @param {{kind: 'file' | 'folder', id: string, parentId: string | null}} e */
	function moveItems(e) {
		const folders = $explorerFolders;
		const below = e.kind === 'folder' ? new Set(subtreeOf(e.id, folders)) : new Set();
		const rows = folders
			.filter((f) => !below.has(f.id))
			.map((f) => ({ id: f.id, path: folderPath(f.id).join(' › ') }))
			.sort((a, b) => a.path.localeCompare(b.path));
		return [
			{ label: 'Library root', icon: 'folder-open', disabled: e.parentId === null, action: () => moveTo(e, null) },
			...rows.map((r) => ({ label: r.path, icon: 'folder', disabled: e.parentId === r.id, action: () => moveTo(e, r.id) }))
		];
	}
	/** @param {string} key @param {number} x @param {number} y */
	function openMenu(key, x, y) {
		const e = entryOf(key);
		if (!e) return false;
		/** @type {any[]} */
		const items = [];
		const paste = cut ? [gated({ label: 'Move "' + cut.name + '" here', icon: 'clipboard-paste', hint: 'Ctrl+V', action: () => pasteAt(key) })] : [];
		if (e.kind === 'root') {
			items.push(...newItems(null), ...paste);
			if ($lastFileOp) items.push({ section: '' }, gated({ label: 'Undo: ' + $lastFileOp, icon: 'undo-2', hint: 'Ctrl+Z', action: () => undoLastFileOp() }));
		} else {
			if (e.kind === 'file') {
				const n = fileNodes.get(key);
				items.push({ label: 'Open', icon: 'file-code', action: () => openLeaf(n) });
			}
			items.push(
				gated({ label: 'Rename', icon: 'pencil', hint: 'F2', action: () => startRename(key) }),
				gated({ label: 'Move to', icon: 'folder-input', children: moveItems(/** @type {any} */ (e)) }),
				gated({ label: 'Cut', icon: 'scissors', hint: 'Ctrl+X', tooltip: 'Then Ctrl+V (or "Move here") on the folder it should go to', action: () => cutAt(key) }),
				...(e.kind === 'folder' ? paste : []),
				gated({ label: 'Delete', icon: 'trash-2', hint: 'Del', danger: true, action: () => askDelete(key) }),
				{ section: '' },
				...newItems(e.kind === 'folder' ? e.id : e.parentId),
				{ section: '' },
				{ label: 'Show in Explorer', icon: 'folder-open', action: () => showInExplorer(e) }
			);
		}
		menu = { x, y, items };
		return true;
	}
	/** @param {{kind: string, id: string, parentId: string | null}} e */
	function showInExplorer(e) {
		explorerClose.set(false);
		if (e.kind === 'file') revealItem(e.id);
		else activeFolder.set(e.kind === 'folder' ? e.id : null);
	}
	/** @param {MouseEvent} ev */
	function treeMenu(ev) {
		const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (ev.target).closest('[data-tree-key]'));
		const key = row?.dataset.treeKey ?? '';
		if (!entryOf(key)) return;
		ev.preventDefault();
		ev.stopPropagation();
		openMenu(key, ev.clientX, ev.clientY);
	}
	/** @param {MouseEvent} ev */
	function headerNewFile(ev) {
		const r = /** @type {HTMLElement} */ (ev.currentTarget).getBoundingClientRect();
		const parentId = folderAt(treeFocus);
		menu = { x: r.left, y: r.bottom + 4, items: FILE_TEMPLATES.map((t) => ({ label: t.label, icon: t.icon, tooltip: t.tooltip, action: () => startNew('new-file', parentId, t.key) })) };
	}

	/** the Files keys, on the tree's direct listener (before arrowNav) @param {KeyboardEvent} e
	 * @returns {boolean} taken */
	function fileKeys(e) {
		if (/** @type {HTMLElement} */ (e.target).closest('input')) return false;
		const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-tree-key]'));
		const key = btn?.dataset.treeKey ?? '';
		const ctrl = e.ctrlKey || e.metaKey;
		const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
		/** @type {(() => void) | null} */
		let run = null;
		if (ctrl && k === 'z' && !e.shiftKey) run = () => void undoLastFileOp();
		else if (!entryOf(key)) return false;
		else if (e.key === 'F2') run = () => startRename(key);
		else if (e.key === 'Delete') run = () => askDelete(key);
		else if (ctrl && k === 'x') run = () => cutAt(key);
		else if (ctrl && k === 'v') run = () => pasteAt(key);
		else if (e.key === 'Escape' && cut) run = () => (cut = null);
		else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
			const r = /** @type {HTMLElement} */ (btn).getBoundingClientRect();
			run = () => void openMenu(key, r.left + 24, r.bottom);
		}
		if (!run) return false;
		e.preventDefault();
		e.stopPropagation();
		run();
		return true;
	}

	// ---------------------------------------------------------------- the keyboard (S12)
	// ONE tab stop per list (roving tabindex): the row last moved to, else the active source
	let treeFocus = $state('');
	const treeStop = $derived(treeFocus || activeKey);
	/** ←/→ in the tree: open/close a folder, or step to its parent @param {KeyboardEvent} e */
	function treeKeys(e) {
		if (fileKeys(e)) return;
		if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
		const btn = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('button[data-tree-key]'));
		if (!btn) return;
		const key = btn.dataset.treeKey ?? '';
		const depth = Number(btn.dataset.depth ?? 0);
		const isGroup = btn.classList.contains('cs-group');
		const expanded = btn.getAttribute('aria-expanded') === 'true';
		e.preventDefault();
		e.stopPropagation();
		const all = /** @type {HTMLElement[]} */ ([...(btn.closest('[role="tree"]')?.querySelectorAll('button[data-tree-key]') ?? [])]);
		const at = all.indexOf(btn);
		const node = { key, lazy: key.startsWith('mod:') ? key.slice(4) : undefined };
		if (e.key === 'ArrowRight') {
			if (isGroup && !expanded) void toggle(node);
			else if (isGroup && all[at + 1]) all[at + 1].focus();
			return;
		}
		if (isGroup && expanded) return void toggle(node);
		for (let i = at - 1; i >= 0; i--)
			if (all[i].classList.contains('cs-group') && Number(all[i].dataset.depth) < depth) {
				all[i].focus();
				treeFocus = all[i].dataset.treeKey ?? '';
				return;
			}
	}
	/** Delete on an Open editors row closes it @param {KeyboardEvent} e */
	function openRowKeys(e) {
		const id = /** @type {HTMLElement} */ (e.target).closest('[data-open-tab]')?.getAttribute('data-open-tab');
		if (e.key === 'Delete' && id) {
			e.preventDefault();
			e.stopPropagation();
			onClose(id);
		}
	}

	/** @param {string} icon */
	const iconOf = (icon) => ({ script: 'file-code', behaviour: 'sparkles', builtin: 'user-round', graph: 'braces', file: 'file-code', module: 'package' })[icon] ?? 'file-code';
</script>

{#snippet nameField(/** @type {number} */ depth, /** @type {string} */ icon)}
	{#if editing}
		<div class="cs-edit" style:padding-left="{4 + depth * 12}px">
			<Icon name={icon} size={16} aria-hidden="true" />
			<input
				id="code-ws-name-input"
				class="cs-input"
				type="text"
				spellcheck="false"
				autocomplete="off"
				bind:value={editing.value}
				aria-label={editLabel(editing)}
				aria-invalid={editError ? 'true' : undefined}
				aria-describedby={editError ? 'code-ws-name-error' : undefined}
				use:focusName
				onkeydown={editKeys}
				onblur={editBlur}
			/>
			{#if editPreview && editPreview !== editing.value.trim()}<span class="cs-detail" aria-hidden="true">{editPreview}</span>{/if}
		</div>
		{#if editError}<p id="code-ws-name-error" class="cs-edit-error" role="alert" style:padding-left="{22 + depth * 12}px">{editError}</p>{/if}
	{/if}
{/snippet}

{#snippet branch(/** @type {any[]} */ nodes, /** @type {number} */ depth)}
	{#each nodes as node (node.key)}
		{#if node.children}
			{@const fileGroup = node.key === 'grp:files' || node.key.startsWith('dir:')}
			{#if editing?.mode === 'rename' && editing.key === node.key}
				{@render nameField(depth, 'folder')}
			{:else}
				<button
					class="cs-row cs-group"
					class:cs-drop={dropKey === node.key}
					class:cs-cut={cut?.kind === 'folder' && 'dir:' + cut.id === node.key}
					style:padding-left="{4 + depth * 12}px"
					data-tree-key={node.key}
					data-depth={depth}
					role="treeitem"
					aria-level={depth + 1}
					aria-selected="false"
					tabindex={node.key === treeStop ? 0 : -1}
					aria-expanded={isOpen(node)}
					title={node.detail ?? node.label}
					draggable={node.key.startsWith('dir:') && !viewer ? 'true' : undefined}
					ondragstart={node.key.startsWith('dir:') ? (/** @type {DragEvent} */ e) => dragStart(e, node.key) : undefined}
					ondragover={fileGroup ? (/** @type {DragEvent} */ e) => dragOver(e, node.key) : undefined}
					ondragleave={fileGroup ? () => dropKey === node.key && (dropKey = '') : undefined}
					ondrop={fileGroup ? (/** @type {DragEvent} */ e) => dropOn(e, node.key) : undefined}
					ondragend={dragEnd}
					onclick={() => toggle(node)}
				>
					{#if isOpen(node)}<Icon name="chevron-down" size={16} aria-hidden="true" />{:else}<Icon name="chevron-right" size={16} aria-hidden="true" />{/if}
					<Icon name="folder" size={16} aria-hidden="true" />
					<span class="cs-name">{node.label}</span>
					{#if node.readOnly}<Icon name="lock" size={16} aria-hidden="true" />{/if}
					<span class="cs-count">{node.children.length}</span>
				</button>
			{/if}
			{#if isOpen(node)}
				{#if editing && editing.mode !== 'rename' && (editing.parentId ? 'dir:' + editing.parentId : 'grp:files') === node.key}
					{@render nameField(depth + 1, editing.mode === 'new-folder' ? 'folder' : templateOf(editing.template ?? 'script').icon)}
				{/if}
				{@render branch(node.children, depth + 1)}
			{/if}
		{:else if editing?.mode === 'rename' && editing.key === node.key}
			{@render nameField(depth, 'file-code')}
		{:else}
			{@const leafIcon = iconOf(node.icon)}
			<div class="cs-leaf-wrap" class:cs-on={node.key === activeKey} class:cs-cut={cut?.kind === 'file' && 'f:' + cut.id === node.key}>
				<button
					class="cs-row cs-leaf"
					style:padding-left="{18 + depth * 12}px"
					data-tree-key={node.key}
					data-depth={depth}
					role="treeitem"
					aria-level={depth + 1}
					aria-selected={node.key === activeKey}
					tabindex={node.key === treeStop ? 0 : -1}
					title={(node.detail ? node.label + ' — ' + node.detail : node.label) + (node.readOnly ? ' (read-only)' : '')}
					draggable={node.itemId && !viewer ? 'true' : undefined}
					ondragstart={node.itemId ? (/** @type {DragEvent} */ e) => dragStart(e, node.key) : undefined}
					ondragend={dragEnd}
					onclick={() => openLeaf(node)}
				>
					<Icon name={leafIcon} size={16} aria-hidden="true" />
					<span class="cs-name">{node.label}</span>
					{#if node.detail}<span class="cs-detail">{node.detail}</span>{/if}
					{#if node.readOnly}<Icon name="lock" size={16} aria-hidden="true" />{/if}
				</button>
				{#if node.fork}
					<button class="cs-act" tabindex="-1" data-fork-key={node.key} title="Make editable copy — copy this code into a script you own" aria-label="Make editable copy of {node.label}" onclick={() => forkLeaf(node)}><Icon name="copy" size={16} aria-hidden="true" /></button>
				{/if}
			</div>
		{/if}
	{/each}
{/snippet}

<div id="code-ws-left" class="cs-root" bind:this={host} data-tour="code-left">
	<section class="cs-section" style:height="{$codeLeftSplit * 100}%">
		<header class="cs-head">Open editors <span class="cs-count">{$codeTabs.length}</span></header>
		<div
			id="code-ws-open-editors"
			class="cs-scroll"
			use:minimalScroll
			role="group"
			aria-label="Open editors"
			use:dragReorder={{ axis: 'y', item: '[data-open-tab]', idAttr: 'data-open-tab', onMove: moveCodeTab, handleIgnore: '.cs-act' }}
			use:arrowNav={{ item: '.cs-open > .cs-leaf', onKey: openRowKeys }}
		>
			{#each $codeTabs as tab (tab.id)}
				<div class="cs-leaf-wrap cs-open" class:cs-on={tab.id === $activeCodeTab} data-open-tab={tab.id} aria-current={tab.id === $activeCodeTab ? 'true' : undefined}>
					<button
						class="cs-row cs-leaf"
						title={tab.title + ' — drag to reorder, Delete closes'}
						tabindex={tab.id === ($activeCodeTab ?? $codeTabs[0]?.id) ? 0 : -1}
						onclick={() => activeCodeTab.set(tab.id)}
					>
						{#if tab.readOnly}<Icon name="lock" size={16} aria-hidden="true" />{:else}<Icon name="file-code" size={16} aria-hidden="true" />{/if}
						<span class="cs-name">{tab.title}</span>
						{#if badOf(tab)}<span class="cs-bad" aria-label="has problems">!</span>{/if}
						{#if isDirty(tab)}<span class="cs-dirty" aria-label="unsaved">●</span>{/if}
					</button>
					<button class="cs-act" tabindex="-1" aria-label="Close {tab.title}" title="Close" onclick={() => onClose(tab.id)}><Icon name="x" size={16} aria-hidden="true" /></button>
				</div>
			{/each}
			{#if !$codeTabs.length}<p class="cs-empty">Nothing open.</p>{/if}
		</div>
	</section>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		id="code-ws-left-split"
		class="cs-split"
		role="separator"
		aria-orientation="horizontal"
		title="Drag to share the height between Open editors and Project"
		onpointerdown={startSplit}
		onpointermove={moveSplit}
		onpointerup={endSplit}
		ondblclick={() => codeLeftSplit.set(0.34)}
	></div>
	<section class="cs-section cs-grow">
		<header class="cs-head">
			Project
			<span class="cs-head-acts">
				<button
					id="code-ws-new-file"
					class="cs-head-btn"
					aria-label="New file"
					aria-haspopup="menu"
					aria-disabled={viewer ? 'true' : undefined}
					title={viewer ? VIEWER_REASON : 'New file — a script, a note or JSON, in the folder you are on'}
					onclick={(e) => !viewer && headerNewFile(e)}><Icon name="file-plus" size={16} aria-hidden="true" /></button
				>
				<button
					id="code-ws-new-folder"
					class="cs-head-btn"
					aria-label="New folder"
					aria-disabled={viewer ? 'true' : undefined}
					title={viewer ? VIEWER_REASON : 'New folder — in the folder you are on'}
					onclick={() => !viewer && startNew('new-folder', folderAt(treeFocus))}><Icon name="folder-plus" size={16} aria-hidden="true" /></button
				>
			</span>
		</header>
		<label class="cs-search">
			<Icon name="search" size={16} aria-hidden="true" />
			<input id="code-ws-project-search" type="search" placeholder="Search scripts…" bind:value={query} aria-label="Search the project's scripts" />
		</label>
		<div
			id="code-ws-project"
			class="cs-scroll"
			use:minimalScroll
			role="tree"
			tabindex="-1"
			aria-label="Project scripts"
			use:arrowNav={{ item: 'button[data-tree-key]', onMove: (el) => (treeFocus = el.dataset.treeKey ?? ''), onKey: treeKeys }}
			oncontextmenu={treeMenu}
			onfocusin={(/** @type {FocusEvent} */ e) => {
				const k = /** @type {HTMLElement} */ (e.target).closest?.('[data-tree-key]')?.getAttribute('data-tree-key');
				if (k) treeFocus = k;
			}}
		>
			{@render branch(shown, 0)}
			{#if filtering && !shown.length}<p class="cs-empty">No script matches "{query}".</p>{/if}
		</div>
		{#if cut}
			<p id="code-ws-cut" class="cs-note" role="status">Moving "{cut.name}" — Ctrl+V on a folder (or Files) puts it there, Esc cancels.</p>
		{/if}
		{#if confirmDel}
			<div id="code-ws-delete-confirm" class="cs-confirm" role="alertdialog" aria-labelledby="code-ws-delete-text" tabindex="-1" onkeydown={(e) => e.key === 'Escape' && (e.stopPropagation(), cancelDelete())}>
				<p id="code-ws-delete-text">{confirmDel.text}</p>
				<div class="cs-confirm-row">
					<button id="code-ws-delete-cancel" class="ui-button-quiet" onclick={cancelDelete}>Cancel</button>
					<!-- svelte-ignore a11y_autofocus -->
					<button id="code-ws-delete-ok" class="ui-button-quiet cs-danger" autofocus onclick={confirmDelete}>Delete</button>
				</div>
			</div>
		{/if}
	</section>
</div>
{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="code-files" onclose={() => (menu = null)} />
{/if}

<style>
	.cs-root {
		display: flex;
		flex-direction: column;
		min-height: 0;
		height: 100%;
		font-size: 11px;
		color: var(--text);
		background: var(--bg-app);
		border-right: 1px solid var(--border);
		user-select: none;
	}
	.cs-section {
		display: flex;
		flex-direction: column;
		min-height: 48px;
		overflow: hidden;
	}
	.cs-grow {
		flex: 1;
	}
	.cs-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-shrink: 0;
		padding: 4px 8px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.cs-scroll {
		flex: 1;
		min-height: 0;
		overflow: auto;
	}
	.cs-split {
		flex-shrink: 0;
		height: 5px;
		cursor: ns-resize;
		touch-action: none;
		border-top: 1px solid var(--border);
	}
	.cs-split:hover {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.cs-search {
		display: flex;
		align-items: center;
		gap: 4px;
		margin: 0 6px 4px;
		padding: 0 6px;
		border-radius: 4px;
		color: var(--text-muted);
		background: var(--surface-inset);
		border: 1px solid var(--border);
	}
	.cs-search input {
		flex: 1;
		min-width: 0;
		padding: 2px 0;
		font-size: 11px;
		color: var(--text);
		background: transparent;
		border: none;
		outline: none;
		box-shadow: none;
	}
	.cs-row {
		display: flex;
		align-items: center;
		gap: 4px;
		width: 100%;
		min-width: 0;
		height: 22px;
		padding-right: 6px;
		text-align: left;
		color: inherit;
	}
	.cs-group {
		color: var(--text-2);
		font-weight: 600;
	}
	.cs-row:hover,
	.cs-leaf-wrap:hover {
		background: var(--surface-hover);
	}
	.cs-leaf-wrap {
		display: flex;
		align-items: center;
		position: relative;
	}
	.cs-leaf-wrap .cs-leaf {
		flex: 1;
	}
	.cs-open .cs-leaf {
		padding-left: 8px;
	}
	.cs-on {
		color: var(--accent-soft-text);
		background: var(--accent-soft);
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.cs-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.cs-detail {
		margin-left: auto;
		padding-left: 6px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--text-muted);
		font-size: 10px;
	}
	.cs-count {
		margin-left: auto;
		color: var(--text-muted);
		font-weight: 400;
	}
	.cs-act {
		display: none;
		flex-shrink: 0;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		margin-right: 3px;
		border-radius: 3px;
		color: var(--text-muted);
	}
	.cs-leaf-wrap:hover .cs-act,
	.cs-on .cs-act,
	.cs-act:focus-visible {
		display: inline-flex;
	}
	.cs-act:hover {
		color: var(--text);
		background: var(--surface-active);
	}
	.cs-dirty {
		color: var(--ink-warn);
	}
	.cs-bad {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		height: 12px;
		border-radius: 9999px;
		font-size: 9px;
		font-weight: 700;
		color: var(--on-danger);
		background: var(--danger);
	}
	.cs-empty {
		padding: 6px 10px;
		color: var(--text-muted);
	}
	/* 70 W1: files and folders */
	.cs-head-acts {
		display: inline-flex;
		gap: 2px;
		margin-left: auto;
	}
	.cs-head-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 20px;
		height: 20px;
		border-radius: 3px;
		color: var(--text-muted);
	}
	.cs-head-btn:hover:not([aria-disabled='true']) {
		color: var(--text);
		background: var(--surface-active);
	}
	.cs-head-btn[aria-disabled='true'] {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.cs-edit {
		display: flex;
		align-items: center;
		gap: 4px;
		height: 22px;
		padding-right: 6px;
	}
	.cs-input {
		flex: 1;
		min-width: 0;
		height: 18px;
		padding: 0 4px;
		font-size: 11px;
		color: var(--text);
		background: var(--surface-inset);
		border: 1px solid var(--accent);
		border-radius: 3px;
	}
	.cs-input[aria-invalid='true'] {
		border-color: var(--danger);
	}
	.cs-edit-error {
		padding: 2px 6px 4px;
		color: var(--danger);
		font-size: 10px;
	}
	.cs-drop {
		background: color-mix(in srgb, var(--accent) 25%, transparent);
		box-shadow: inset 0 0 0 1px var(--accent);
	}
	.cs-cut {
		opacity: 0.55;
	}
	.cs-note {
		flex-shrink: 0;
		padding: 4px 8px;
		color: var(--text-muted);
		border-top: 1px solid var(--border);
	}
	.cs-confirm {
		flex-shrink: 0;
		padding: 6px 8px;
		border-top: 1px solid var(--border);
		background: var(--surface-inset);
	}
	.cs-confirm-row {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 4px;
	}
	.cs-danger {
		color: var(--danger);
	}
	/* drag to reorder (dragReorder.js): the dragged row fades, the gap shows as a line */
	.cs-open:global([data-dragging]) {
		opacity: 0.45;
	}
	.cs-open:global([data-drop='before']) {
		box-shadow: inset 0 2px 0 var(--accent);
	}
	.cs-open:global([data-drop='after']) {
		box-shadow: inset 0 -2px 0 var(--accent);
	}
</style>
