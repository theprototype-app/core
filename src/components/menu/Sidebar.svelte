<script lang="ts">
	import { backClose } from '$lib/backStack.js'; // phone-polish: Android Back closes it
	import { edgeFade } from '$lib/ui/edgeFade.js'; // 98-int UI-6: the edge with more rows fades (the scroll cue)
	import Icon from '../ui/Icon.svelte';
	import SheetGrip from '../ui/SheetGrip.svelte';
	import { readSheetH, saveSheetH } from '$lib/ui/sheetDrag.js';
	import { phoneShellActive, phoneSheetMaxH } from '$lib/ui/phoneShell.js';
	import { openPublishExport } from '$lib/export/exportStores.js';
	import { openMomentReport } from '$lib/perf/moment';
	import { openProblemReport } from '$lib/problemReport';
	import '../../app.css';
	import { moduleToolboxes, openToolboxes, buildToolboxItems } from '$lib/moduleToolboxes';
	import { simpleUntilPlay } from '$lib/onboarding/onboardState.js'; // 76 FW1
	/** 76 FW1: the "More" row was pressed this time the menu is open */
	let sceneMore = $state(false);
	import '../../styles/menu.css';
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { motionMs } from '$lib/motion'; // 53 A5: instant under reduced motion
	import { save, load, importModelFiles } from '$lib/fileHandler.svelte';
	import {
		settingsOpen,
		inspectorClose,
		inspectorKind,
		showSidebar,
		closeMenu,
		modulesOpen,
		sessionsOpen,
		templatesModalOpen,
		characterModalOpen,
		profileSettingsOpen,
		connectDocked,
		connectBarHeight
	} from '../../stores/appStore.js';
	import { confirmClearScene } from '$lib/sceneTemplates';
	// 28-A5: the cloud plugin's row under Save (null without a plugin = no row at all)
	import { sidebarSlot } from '$lib/cloudHooks';
	import CloudSlot from '../CloudSlot.svelte';
	import { whatsNewUnseen, openWhatsNew } from '$lib/whatsNew';
	// 36 I5: own lines (not the shared icon list) so a merge with the menu's other lanes stays a union
	import { checkpointsOpen, checkpointSaveOpen, explorerClose, armExplorerSceneSave, showToast } from '../../stores/appStore.js'; // 36 B14; showhide-v8 §6 Save as copy
	import { commandPaletteOpen } from '../../stores/appStore'; // phone-polish item 5: the palette's touch entry
	import { startEditorTour } from '$lib/tours/builtin.js';
	import { statsOpen } from '$lib/sceneBudget';
	import { layoutsMenuOpen } from '$lib/uiLayouts'; // 37 R14
	import { globalRenderer } from '../../stores/sceneStore'; // 41 G3a
	import { saveOptions, saveOptionsOpen, setSaveOptions, SAVE_FORMATS } from '$lib/saveOptions'; // 41b H14
	import { projectActionsLayout } from '$lib/projectActions'; // 41b H14
	import SaveOptionsModal from './SaveOptionsModal.svelte'; // 41b H14
	import { saveManyDialog } from '$lib/saveManyState'; // 56 C13
	import { openAssetBrowser } from '$lib/cc0/assetBrowserState.js'; // 47-cc0
	import { openWindowHere, burgerWindowItems, closeAllFloating } from '$lib/dockMenu'; // dock-fixes D: opens where you work; showhide-v8 §6 Windows ▸
	import { snapToEdges, layoutLocked, layoutPerScene } from '$lib/windowPrefs.js';
	import { bindingOf, cheatSheetOpen } from '$lib/shortcuts';
	import { APP_VERSION } from '$lib/version.js'; // showhide-v8 §6: the footer's version
	import { toggleViewportFocus } from '$lib/focusMode';
	import { resetWindowLayout } from '$lib/dragWindow';
	import { editedSinceSave, noteFileSaved } from '$lib/saveState.js'; // showhide-v8 §6
	import ContextMenu from '../ContextMenu.svelte';

	// 203: redesigned as a compact floating panel — flat list (order preserved,
	// no boxed group / section headers / vertical bar), a fast fade-in (was a
	// slide from the left), narrower than the Properties sidebar so it needs no
	// scrollbar, and floated ABOVE the bottom dock (z-hud) instead of covered.
	// The Files format picker became a segmented control (the old dropdown was
	// fiddly). Themed for light + dark.

	// B3: Scene (.tpscene) is the primary SCENE format; JSON is demoted behind the
	// export-settings cog since it's rarely used. 21-G8 (fork 11): TP — the whole PROJECT as
	// one .tp — is the default for anyone without a stored preference. 21-H1: the primary row
	// is `Project | Scene`; GLTF and JSON are optional and render on a SECOND ROW when enabled.
	// 41b H14: the options live in `$lib/saveOptions` (same keys) so the burger's two layouts and
	// the "Save options" modal (Compact's Save ▾, List's ⚙ — it replaced the cog's popup) share them.
	function pickFormat(f: string) {
		setSaveOptions({ format: f });
	}
	const saveFormat = $derived($saveOptions.format);
	const formatInfo = $derived(SAVE_FORMATS.find((f) => f.value === saveFormat) ?? SAVE_FORMATS[0]);
	function openSaveOptions() {
		saveOptionsOpen.set(true);
	}
	// showhide-v8 §6: the Save as… menu (the owner's order)
	let saveAsMenu = $state<{ x: number; y: number } | null>(null);
	function openSaveAs(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		saveAsMenu = { x: r.left, y: r.bottom + 4 };
	}
	// showhide-v8 §6: Windows ▸ — every window with its shortcut and an open mark (a click reveals, never closes),
	// then the window-wide commands. Layouts ▸ stays its own row.
	const SHORTCUT_IDS: Record<string, string> = { objects: 'panels.object-list', flow: 'panels.node-editor', explorer: 'panels.explorer', animation: 'panels.animation', uv: 'panels.uv-editor', shader: 'panels.shader-editor', hud: 'panels.hud-editor', timeline: 'panels.timeline', chat: 'panels.chat', code: 'panels.flow-code' };
	let windowsMenu = $state<{ x: number; y: number } | null>(null);
	function openWindowsMenu(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		windowsMenu = $phoneShellActive ? { x: r.left + 12, y: r.bottom } : { x: r.right + 4, y: r.top };
	}
	function toggleFullScreen() {
		if (typeof document === 'undefined') return;
		if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => {});
		else void document.documentElement.requestFullscreen?.().catch(() => showToast('Full screen is not available here'));
	}
	function windowsItems() {
		return [
			...burgerWindowItems((key) => (SHORTCUT_IDS[key] && key !== 'code' ? bindingOf(SHORTCUT_IDS[key]) : null)),
			{ separator: true },
			{ label: 'Focus mode', icon: 'focus', hint: bindingOf('view.focus') ?? 'Ctrl+Space', tooltip: 'The viewport alone, nothing over it; again to restore', action: () => { closeMenu.set(true); toggleViewportFocus(); } },
			{ label: 'Full screen', icon: 'fullscreen', tooltip: 'The app fills the screen (Esc leaves)', action: () => toggleFullScreen() },
			{ separator: true },
			{ label: 'Reset positions and sizes', icon: 'rotate-ccw', tooltip: 'Every floating window back to where and how big it started', action: () => { resetWindowLayout(); showToast('Window positions and sizes reset'); } },
			{ label: 'Close all floating windows', icon: 'x', tooltip: 'Docked, sidebar and pop-out windows stay', action: () => { const n = closeAllFloating(); showToast(n ? `Closed ${n} floating window${n === 1 ? '' : 's'}` : 'No floating windows were open'); } },
			{ separator: true },
			{ label: 'Snap to edges', checked: $snapToEdges, tooltip: 'A dragged window lands flush on a screen edge it comes close to', action: () => snapToEdges.set(!$snapToEdges) },
			{ label: 'Lock layout', checked: $layoutLocked, tooltip: 'No window moves, resizes, undocks or tears off by a drag; opening, closing and the menus still work', action: () => layoutLocked.set(!$layoutLocked) },
			{ label: 'Remember layout per scene', checked: $layoutPerScene, tooltip: 'Each saved scene keeps the window layout you left it with, and gets it back when it opens', action: () => layoutPerScene.set(!$layoutPerScene) }
		];
	}
	const saveAsItems = [
		{ label: 'Save scene as file…', icon: 'download', tooltip: 'Download the open scene as a .tpscene', action: () => { saveFromMenu('tpscene'); closeMenu.set(true); } },
		{ label: 'Save project as file…', icon: 'package', tooltip: 'Download the whole project as a .tp: the scene, its library files and history', action: () => { saveFromMenu('tp'); closeMenu.set(true); } },
		{ label: 'Save as copy…', icon: 'copy', tooltip: 'Save this scene under a new name in the Explorer (your library)', action: () => { explorerClose.set(false); armExplorerSceneSave(null); closeMenu.set(true); } },
		{ separator: true },
		{ label: 'Save options…', icon: 'settings', tooltip: 'Format and everything else a Save uses', action: () => openSaveOptions() }
	];
	/**
	 * 56 C13 (addendum 2026-10-28f): Save PROJECT with several libraries open (my Library, a session I
	 * joined, a mounted project with changes) goes through Settings ▸ Save options ▸ "When several
	 * libraries are open"; with one library it is the same `save` as ever. Other formats save the scene.
	 * @param {string} format
	 */
	function saveFromMenu(format: string) {
		noteFileSaved();
		if (format !== 'tp') return save(format);
		void import('$lib/saveProject').then((m) => m.saveProjectPressed('burger', () => save(format)));
	}
	// Clearing value (instead of the old {#key} recreate) lets the same file be
	// re-picked without detaching the input mid-dialog — a detached input's event
	// never reaches Svelte 5's delegated oninput, so the pick was silently dropped.
	function pickFile(id: string) {
		const input = document.getElementById(id) as HTMLInputElement | null;
		if (!input) return;
		input.value = '';
		input.click();
	}

	// A6: clicking the logo while ANY modal is open closes every modal and OPENS the
	// menu in ONE step. (Previously it toggled the menu regardless of state, so a modal
	// opened from the avatar — where the menu was already "open" — flipped the menu shut
	// and only the modal's own outside-click closed it, causing a flicker.)
	async function toggleMenu() {
		if ($settingsOpen || $modulesOpen || $sessionsOpen || $templatesModalOpen || $characterModalOpen || $profileSettingsOpen) {
			settingsOpen.set(false);
			modulesOpen.set(false);
			sessionsOpen.set(false);
			templatesModalOpen.set(false);
			characterModalOpen.set(false);
			profileSettingsOpen.set(false);
			// closing a modal fires its restorePanels(), which resets closeMenu to the
			// pre-modal value — open the menu AFTER that flush so it wins (previously the
			// menu flickered open then shut).
			await tick();
			closeMenu.set(false);
			return;
		}
		closeMenu.update((value) => !value);
	}

	// 40 F1: on the phone the main menu is a resizable sheet above the bottom bar — its height is
	// remembered (`mainMenuSheetH`), swipe down to the end closes it, like every other sheet
	let menuH = $state(readSheetH('mainMenuSheetH', 0));
	const menuShown = $derived(Math.min(menuH || $phoneSheetMaxH, $phoneSheetMaxH || 9999));
	function menuResize(h: number, done: boolean) {
		menuH = Math.round(h);
		if (done) saveSheetH('mainMenuSheetH', menuH);
	}

	// 41 G3a — LIGHT DISMISS: a press anywhere outside the open menu closes it, on the desktop
	// popover and the phone sheet alike — what every platform menu does (and the user's report:
	// "when burger menu pressed pressing outside it should close menu"). Outside = not the menu,
	// not the logo (it toggles by itself), not the tour card that may be pointing at the menu,
	// and nothing while the export-settings popup is up (its own backdrop answers that press).
	// A press on another control still WORKS (a bottom-bar tab, the bell, Play) — one press,
	// not two; a press on the 3D VIEW only dismisses: it must not also select, deselect or orbit
	// the camera, which is what a stray tap to close a menu would otherwise do. A CAPTURE
	// listener on window: panel chrome stops pointerdown on its way up.
	$effect(() => {
		if ($closeMenu) return;
		const outside = (e: PointerEvent) => {
			if ($saveOptionsOpen) return;
			// showhide-v8 §6: the burger's own submenus (Save as… ▾, Windows ▸) are portaled out of #sidebar70; a press
			// in one is still inside the menu, and a press outside both closes the submenu first (its own dismiss)
			if (saveAsMenu || windowsMenu) return;
			const t = e.target as Element | null;
			if (!t || !t.isConnected || t.closest('#sidebar70, #logo-menu, #tour-card, #save-options-modal')) return;
			closeMenu.set(true);
			const view = ($globalRenderer as any)?.domElement;
			if (view && t === view) {
				e.stopPropagation();
				e.preventDefault();
			}
		};
		window.addEventListener('pointerdown', outside, true);
		return () => window.removeEventListener('pointerdown', outside, true);
	});

	// 15-J viewer gate + 33 (L3) the Clear scene modal live in $lib/sceneTemplates.confirmClearScene
	// now — shared with the Templates modal's "Blank scene" card.

	/**
	 * dock-fixes E (owner 2026-11-08, shot 5): the open menu ends ABOVE the bottom toolbar instead of cutting it —
	 * it scrolls instead (it already does on a short screen). Only when the toolbar is under the menu's column; the
	 * toolbar itself never moves for the menu (the menu overlays, it relayouts nothing).
	 */
	function clearToolbar(node: HTMLElement, on: boolean) {
		let enabled = on;
		const fit = () => {
			node.style.maxHeight = '';
			if (!enabled) return;
			const pill = document.getElementById('controls-pill');
			const p = pill?.getBoundingClientRect();
			const m = node.getBoundingClientRect();
			// UI-6 (HONOR 718x587): it scrolled, but ran to the very bottom edge — it now ends 8 px inside the viewport
			let bottom = window.innerHeight - 8;
			if (p && p.width && p.left < m.right && p.right > m.left && p.top < m.bottom) bottom = Math.min(bottom, p.top - 8);
			// 78 PL7 (UI-6, HONOR 718x587): and above the bottom-left corner stack (+, AI) it shares the left edge with —
			// the menu's last rows ran under the + button, which is drawn on its own tier over the menu's corner
			for (const el of document.querySelectorAll('#hud-stack-left > *')) {
				const r = el.getBoundingClientRect();
				if (r.width && r.height && r.left < m.right && r.right > m.left && r.top > m.top + 160 && r.top < m.bottom) bottom = Math.min(bottom, r.top - 8);
			}
			if (m.bottom > bottom) node.style.maxHeight = Math.max(160, Math.floor(bottom - m.top)) + 'px';
		};
		const raf = requestAnimationFrame(fit);
		window.addEventListener('resize', fit);
		return {
			update(v: boolean) {
				enabled = v;
				fit();
			},
			destroy() {
				cancelAnimationFrame(raf);
				window.removeEventListener('resize', fit);
			}
		};
	}
</script>

<!-- 94: the logo IS the menu button. Open state = accent ring. -->
<button
	id="logo-menu"
	class="burger tp-ui hud-glass flex items-center justify-center rounded-xl transition-transform hover:scale-105 {$closeMenu
		? ''
		: 'logo-open'}"
	style="height: var(--hud-fab); width: var(--hud-fab); {$connectDocked ? `top: ${$connectBarHeight + 8}px` : ''}"
	title={$closeMenu ? 'Open menu' : 'Close menu'}
	onclick={toggleMenu}
>
	<!-- 38 R8 (design page): the logo sits on the HUD glass, a 44 px tile like the corner buttons -->
	<img src="logo.svg" alt="menu" class="h-7 w-7" />
	<!-- RW/B4: unseen-update cue. A dot, never a boot dialog — the menu's "What's new"
	     row (and the one update toast) lead to the changelog. Class toggle, not an
	     {#if}, so nothing is destroyed mid-flush when the cue clears (see the row). -->
	<span class="update-dot" class:update-dot-on={$whatsNewUnseen} title="Updated — see what's new"></span>
</button>

{#if !$closeMenu}
	<nav
		id="sidebar70"
		use:backClose={() => closeMenu.set(true)}
		use:clearToolbar={!$phoneShellActive}
		use:edgeFade={$phoneShellActive ? 'off' : 'y'}
		transition:fade={{ duration: motionMs(130) }}
		class="app-sidebar tp-ui tp-menu tp-noscrollbar fixed"
		style="--side-top: {$connectDocked ? $connectBarHeight + 64 : 64}px; {$phoneShellActive ? `--menu-sheet-h: ${menuShown}px` : ''}"
	>
		{#if $phoneShellActive}
			<SheetGrip class="side-grip" label="main menu" height={menuShown} onresize={menuResize} onclose={() => closeMenu.set(true)} />
		{/if}
		<!-- multiple + the companion types so an .obj can be picked TOGETHER with its
		     .mtl and textures (17-D2); a lone model file behaves exactly as before -->
		<input type="file" id="import-file" multiple style="display: none" oninput={(e: any) => importModelFiles(e.target.files)} accept=".gltf, .glb, .obj, .stl, .fbx, .vrm, .mtl, .png, .jpg, .jpeg, .webp" />
		<input type="file" id="load-file" style="display: none" oninput={(e: any) => load(e.target.files[0])} accept=".json, .tpscene, .tp" />

		<!-- 38 NOTES-38 #24 (design page): the main menu is one of the app's menus — the menu
		     surface, 32px rows, faint section labels (Project · Scene · Collaborate · App) and a
		     Segmented save format. Every row, id and handler is unchanged; Modules stays under
		     Scene (phase 126's order, sidebar-reorg) and Settings stays in App. -->
		<!-- showhide-v8 §6 (burger direction A, owner 2026-11-09): File · Scene · Versions · Window · Help, the command
		     search on top and Settings + the version as a footer. Every id and handler is unchanged; only the order and a few
		     words move ("Load" -> "Open…", "Clear scene…" last in Scene behind a divider). No Undo / Redo row (owner). -->
		<button id="open-command-palette" class="side-row side-search" onclick={() => { closeMenu.set(true); commandPaletteOpen.set(true); }}>
			<span class="side-ico"><Icon name="search" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Search commands…</span>
			<span class="side-hint">Ctrl+K</span>
		</button>
		<div class="side-label">File</div>
		{#if $projectActionsLayout === 'compact'}
			<!-- 41b H14 — COMPACT (the desktop / unfolded default): a strict two-column grid at list-row
			     height, DCC order create -> open / save -> interchange. Save saves with the last-used
			     options; ▾ opens "Save options" (format + everything that sat behind the old cog). The
			     ids the list rows carry (#open-templates, #open-publish-export) move with their action. -->
			<div id="project-actions" class="pa-grid" data-layout="compact">
				<button id="open-templates" class="side-row pa-btn pa-wide" title="Start a new scene from a template" onclick={() => { templatesModalOpen.set(true); closeMenu.set(true); }}>
					<span class="side-ico"><Icon name="layout-template" size={16} aria-hidden="true" /></span><span class="pa-label">New from template…</span>
				</button>
				<button id="project-load" class="side-row pa-btn" title="Open a .tp project, .tpscene scene or .json file" onclick={() => pickFile('load-file')}>
					<span class="side-ico"><Icon name="folder-open" size={16} aria-hidden="true" /></span><span class="pa-label">Open…</span>
				</button>
				<!-- showhide-v8 §6 (burger direction A): [Save] — greyed until something changed since the last save — and
				     [Save as… ▾], a menu: Save scene as file… · Save project as file… · Save as copy… · Save options… -->
				<div class="pa-split">
					<button id="project-save" class="side-row pa-btn pa-split-main" disabled={!$editedSinceSave} title={$editedSinceSave ? 'Save as ' + formatInfo.label + ' (' + formatInfo.ext + ') with your last-used options' : 'Nothing changed since the last save'} onclick={() => saveFromMenu(saveFormat)}>
						<span class="side-ico"><Icon name="save" size={16} aria-hidden="true" /></span><span class="pa-label">Save</span>
					</button>
					<button id="project-save-as" class="side-row pa-btn pa-split-more pa-save-as" title="Save as a file, as a copy, or change the save options" aria-haspopup="menu" aria-expanded={!!saveAsMenu} onclick={openSaveAs}>
						<span class="pa-label">Save as…</span><Icon name="chevron-down" size={16} aria-hidden="true" />
					</button>
				</div>
				<button id="project-import" class="side-row pa-btn" title="Bring models, images or sounds into the scene" onclick={() => pickFile('import-file')}>
					<span class="side-ico"><Icon name="file-input" size={16} aria-hidden="true" /></span><span class="pa-label">Import</span>
				</button>
				<button id="open-publish-export" class="side-row pa-btn" data-tour="publish-export" title="Publish or export the scene" onclick={() => { openPublishExport(); closeMenu.set(true); }}>
					<span class="side-ico"><Icon name="upload" size={16} aria-hidden="true" /></span><span class="pa-label">Export…</span>
				</button>
			</div>
			{#if $sidebarSlot}
				<div id="sidebar-cloud-slot" class="side-cloud">
					<CloudSlot mount={$sidebarSlot} />
				</div>
			{/if}
		{:else}
		<!-- New scene from a starting point (General / Examples / Community tabs) -->
		<button id="open-templates" class="side-row" onclick={() => { templatesModalOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="layout-template" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Templates</span>
		</button>

		<!-- Files -->
		<button class="side-row" onclick={() => pickFile('import-file')}>
			<span class="side-ico"><Icon name="file-input" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Import</span>
		</button>
		<button class="side-row" onclick={() => pickFile('load-file')}>
			<span class="side-ico"><Icon name="folder-open" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Open…</span>
		</button>
		<button class="side-row" onclick={() => saveFromMenu(saveFormat)}>
			<span class="side-ico"><Icon name="save" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Save</span>
		</button>
		<!-- 21-H1: [ Project | Scene | cog ]. The KEY stays 'tp' and the id stays
		     #format-tp — the id addresses the format, not the word — but the label reads
		     "Project", because that is what the file is. 41b H14: the cog opens "Save options". -->
		<div id="format-row" class="side-segs mb-0.5 mt-0.5 flex pl-9 pr-2">
			<button id="format-tp" class="side-seg {saveFormat === 'tp' ? 'on' : ''}" title="Saves the whole project as .tp — the Explorer library, scene history and manifest" onclick={() => pickFormat('tp')}>Project</button>
			<button id="format-tpscene" class="side-seg {saveFormat === 'tpscene' ? 'on' : ''}" title="Saves the open scene as .tpscene" onclick={() => pickFormat('tpscene')}>Scene</button>
			<button id="export-settings-cog" class="side-seg" title="Save options…" aria-label="Save options" aria-haspopup="dialog" onclick={openSaveOptions}><Icon name="settings" size={16} aria-hidden="true" /></button>
		</div>
		<!-- the SECOND row: whichever optional formats Save options has enabled. Absent
		     entirely when neither is, so nothing here costs a pixel by default. -->
		{#if $saveOptions.showGltf || $saveOptions.showJson}
			<div id="format-row-optional" class="side-segs mb-0.5 flex pl-9 pr-2">
				{#if $saveOptions.showGltf}
					<button id="format-gltf" class="side-seg {saveFormat === 'gltf' ? 'on' : ''}" title="Exports the selected objects as glTF (nothing selected: offers the whole scene) — for other tools, not for keeping your work" onclick={() => pickFormat('gltf')}>GLTF</button>
				{/if}
				{#if $saveOptions.showJson}
					<button id="format-json" class="side-seg {saveFormat === 'json' ? 'on' : ''}" title="Saves the scene as raw JSON" onclick={() => pickFormat('json')}>JSON</button>
				{/if}
			</div>
		{/if}
		<!-- 28-A5 (roadmap #28): THE SAVE ROW'S NEIGHBOUR. A cloud plugin's own row (Publish)
		     mounts here, directly under the format segment, because a publish row anywhere
		     else is one nobody finds. The plugin renders a plain `.side-row` button and the
		     row look reaches it (see the style block). Absent ENTIRELY without a plugin — the
		     slot store is null — so the OSS menu is byte-identical. -->
		{#if $sidebarSlot}
			<div id="sidebar-cloud-slot" class="side-cloud">
				<CloudSlot mount={$sidebarSlot} />
			</div>
		{/if}
		<!-- 36-export (U4): ONE burger item for getting a scene out — the modal's Publish tab (a cloud
		     plugin's), Export tab (core's: itch.io / static host / embed) and Settings tab -->
		<button id="open-publish-export" class="side-row" data-tour="publish-export" onclick={() => { openPublishExport(); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="upload" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Publish / Export</span>
		</button>
		{/if}

		<div class="side-div"></div>
		<div class="side-label">Scene</div>
		<!-- Scene -->
		<!-- 15-O: the "●" text prefix is gone — it shifted the label as it appeared
		     (read as a glitch) and duplicated what the open panel already shows.
		     The row itself carries an `active` highlight instead, like any nav item. -->
		<!-- 41b H2: on a phone the menu closes as Configure Scene opens (it is a dock tab there, under
		     the menu sheet); on a wider screen the menu stays open beside the drawer, as before -->
		<button class="side-row" class:active={!$inspectorClose && $inspectorKind === 'scene'} onclick={() => { showSidebar('scene'); if ($phoneShellActive) closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="sliders-horizontal" size={16} aria-hidden="true" /></span>
			<span class="flex-1 whitespace-nowrap">Configure Scene</span>
		</button>
		<!-- 47-cc0: free CC0 models, skies and materials (Poly Haven + ambientCG) -->
		<button id="open-asset-browser" class="side-row" onclick={() => { openWindowHere('assets', openAssetBrowser); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="package-open" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Free assets (CC0)</span>
		</button>
		<!-- 76 FW1: until a new user's first Play, Modules and Layouts wait under "More" -->
		{#if !$simpleUntilPlay || sceneMore}
			<button id="open-modules-manager" class="side-row" onclick={() => { modulesOpen.set(true); closeMenu.set(true); }}>
				<span class="side-ico"><Icon name="puzzle" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Modules</span>
			</button>
			<!-- A5: a module's own toolbox, one row each, indented under Modules. This is
			     what makes moduleSDK's JSDoc true — it already CLAIMED a sidebar Modules
			     section that did not exist. Deliberately not a Controls HUD button: the
			     corner HUD already reflows four buttons at <=600px and does not scale to N
			     modules. The rows come from the SAME builder the viewport menu uses, which is
			     asked as the 'sidebar' surface: a toolbox may opt OUT of this permanent row
			     (`sidebar: false`) and keep its viewport-menu one. -->
			{#each buildToolboxItems($moduleToolboxes, $openToolboxes, 'sidebar') as box (box.id)}
				<button
					id="open-toolbox-{box.id}"
					class="side-row side-sub"
					class:active={box.checked}
					onclick={() => { box.action(); closeMenu.set(true); }}
				>
					<span class="side-ico"><Icon name="wrench" size={16} aria-hidden="true" /></span>
					<span class="flex-1 whitespace-nowrap">{box.label}</span>
					{#if box.shortcut}<span class="side-hint">{box.shortcut}</span>{/if}
				</button>
			{/each}
			<!-- 37 R14: named workspace layouts (windows, docks, sizes) -->
			<button id="open-layouts" class="side-row" onclick={() => { layoutsMenuOpen.set(true); closeMenu.set(true); }}>
				<span class="side-ico"><Icon name="panels-top-left" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Layouts</span>
			</button>
		{:else}
			<button id="sidebar-more" class="side-row" aria-expanded="false" onclick={() => (sceneMore = true)}>
				<span class="side-ico"><Icon name="ellipsis" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">More</span>
			</button>
		{/if}
		<div class="side-div"></div>
		<button id="clear-scene" class="side-row" onclick={() => { closeMenu.set(true); void confirmClearScene(); }}>
			<span class="side-ico"><Icon name="trash-2" size={16} class="ico-danger" aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Clear scene…</span>
		</button>

		<div class="side-div"></div>
		<div class="side-label">Versions</div>
		<!-- 36 B14: named checkpoints + the timeline they live in -->
		<button id="save-checkpoint" class="side-row" onclick={() => { checkpointSaveOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="bookmark" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Save checkpoint…</span>
			<span class="side-hint">Ctrl+Shift+S</span>
		</button>
		<button id="open-checkpoints" class="side-row" onclick={() => { checkpointsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="history" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Checkpoints</span>
		</button>
		<button id="open-sessions-manager" class="side-row" onclick={() => { sessionsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="archive" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Sessions</span>
		</button>

		<div class="side-div"></div>
		<div class="side-label">Window</div>
		<!-- showhide-v8 §6: Windows ▸ (every window, its shortcut, open mark; focus / full screen / reset / close floating) -->
		<button id="open-windows-menu" class="side-row" aria-haspopup="menu" aria-expanded={!!windowsMenu} onclick={openWindowsMenu}>
			<span class="side-ico"><Icon name="app-window" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Windows</span>
			<Icon name="chevron-right" size={16} aria-hidden="true" />
		</button>
		<!-- 26-A: what the scene costs. It sits beside Settings rather than under it
		     because it is something you WATCH while working, not something you set. -->
		<button id="open-stats" class="side-row" onclick={() => { statsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="gauge" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Statistics</span>
		</button>

		<div class="side-div"></div>
		<div class="side-label">Help</div>
		<button class="side-row" onclick={() => window.open('https://docs.theprototype.app', '_blank')}>
			<span class="side-ico"><Icon name="book-open" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Docs</span>
		</button>
		<!-- showhide-v8 §6: the "?" cheat sheet had no menu row -->
		<button id="open-shortcuts" class="side-row" onclick={() => { closeMenu.set(true); cheatSheetOpen.set(true); }}>
			<span class="side-ico"><Icon name="keyboard" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Keyboard shortcuts</span>
			<span class="side-hint">{bindingOf('help.cheatsheet') ?? '?'}</span>
		</button>
		<!-- 36 I5: the editor tour (Settings ▸ Tours has the VR welcome + reset). 76 FW1: it no longer starts by
		     itself after the Welcome — the first-win quest does — so this row is where it lives -->
		<button id="open-tour" class="side-row" onclick={() => { closeMenu.set(true); startEditorTour(); }}>
			<span class="side-ico"><Icon name="compass" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Tour the interface</span>
		</button>
		<!-- the unseen cue is a CLASS toggle, not an {#if}: clicking this row closes the
		     menu, and destroying a nested branch inside the subtree being destroyed in
		     the same flush crashes Svelte's sibling walk (destroy_effect). -->
		<button id="open-whats-new" class="side-row" onclick={() => { openWhatsNew(); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="sparkles" size={16} aria-hidden="true" /></span>
			<span class="flex-1 whitespace-nowrap">What's new</span>
			<span class="row-dot" class:row-dot-on={$whatsNewUnseen}></span>
		</button>
		<!-- 37 R20: a picture + boxes round what is wrong + a note, sent to the team with consent -->
		<button id="report-problem" class="side-row" onclick={() => { closeMenu.set(true); void openProblemReport(); }}>
			<span class="side-ico"><Icon name="message-square-warning" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Report a problem…</span>
		</button>
		<!-- 34 R1: the last 30 s of frame data + what the viewport shows + a note, kept as a
			recording (and sent when performance reports are on) -->
		<button id="report-moment" class="side-row" onclick={() => { closeMenu.set(true); void openMomentReport(); }}>
			<span class="side-ico"><Icon name="flag" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Report this moment</span>
		</button>
		<!-- showhide-v8 §6: Settings + the version, a footer that stays in view while the rows scroll; the version opens What's new -->
		<div class="side-foot">
			<button id="open-settings" class="side-row" onclick={() => { settingsOpen.set(!$settingsOpen); closeMenu.set(true); }}>
				<span class="side-ico"><Icon name="settings" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Settings</span>
			</button>
			<button id="open-version" class="side-version" title="What's new in this version" onclick={() => { openWhatsNew(); closeMenu.set(true); }}>{APP_VERSION}</button>
		</div>
	</nav>
{/if}

<!-- 41b H14: "Save options" (Compact's Save ▾, List's ⚙) — rendered at the component ROOT, never
     inside the blurred .app-sidebar (a backdrop-filter ancestor captures position:fixed) -->
<SaveOptionsModal />
<!-- 56 C13: the "Save which libraries?" dialog, mounted only while it is open (lazy chunk) -->
{#if $saveManyDialog}
	{#await import('./SaveManyDialog.svelte') then m}<m.default />{/await}
{/if}
<!-- showhide-v8 §6: the burger's Windows ▸ and Save as… menus, at the root for the same backdrop-filter reason -->
{#if windowsMenu}<ContextMenu x={windowsMenu.x} y={windowsMenu.y} items={windowsItems()} sizeKey="burger-windows" onclose={() => (windowsMenu = null)} />{/if}
{#if saveAsMenu}<ContextMenu x={saveAsMenu.x} y={saveAsMenu.y} items={saveAsItems} sizeKey="burger-save-as" onclose={() => (saveAsMenu = null)} />{/if}

<style>
	/* (no background here: an undefined --color-form blanked the utility's surface fill — a
	   scoped rule beats every utility — which theme.css's !important remap used to hide) */
	.burger {
		top: 8px;
		/* 42 I2: a FULL-HEIGHT left sidebar takes the corner — the logo slides inward by its width */
		left: calc(8px + var(--sb-dock-left, 0px));
		/* 45 N3: the hover scale only — the logo JUMPS beside a pinned / closed sidebar in one frame (the user:
		   "remove animations when hide/show sidebars on top clusters and burger menu and profile buttons") */
		transition: transform 150ms;
		/* .burger is position:absolute in menu.css — that already anchors .update-dot */
	}
	/* unseen-update cue: a small accent dot on the logo corner + on the menu row */
	.update-dot {
		position: absolute;
		top: 5px;
		right: 5px;
		width: 9px;
		height: 9px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--surface-1);
		visibility: hidden;
	}
	.update-dot-on {
		visibility: visible;
	}
	.row-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		flex: 0 0 auto;
		visibility: hidden;
	}
	.row-dot-on {
		visibility: visible;
	}
	/* the logo menu opens above everything (Connect, toasts) */
	.app-sidebar {
		/* 36 U5: the menu's top is a variable (it drops below a docked Connect bar), so the
		   height it may take can subtract it — the old cap subtracted a fixed 72px from the
		   LARGE viewport (100vh), and a docked bar or a phone's URL bar left the last rows
		   below the screen where no swipe could bring them back */
		top: var(--side-top, 64px);
		/* 42 I2: opens from the logo — beside a full-height left sidebar, and on --z-popover, above
		   every sidebar either way */
		left: calc(8px + var(--sb-dock-left, 0px));
		z-index: var(--z-popover);
		/* size to the widest row so wider-font themes (e.g. 8-bit) never overflow
		   the panel and overlap the scene; clamped so it stays compact */
		width: max-content;
		min-width: 12.5rem;
		max-width: 17rem;
		/* short viewports: touch-scroll the menu, but with no visible scrollbar. 100dvh = the
		   viewport you can SEE (URL bar and fold posture included); 100vh is the fallback */
		max-height: calc(100vh - var(--side-top, 64px) - 8px);
		max-height: calc(100dvh - var(--side-top, 64px) - 8px);
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none; /* Firefox */
		-webkit-overflow-scrolling: touch;
		/* a swipe that reaches the end stops here instead of dragging the page/canvas */
		overscroll-behavior: contain;
		touch-action: pan-y;
	}
	.app-sidebar::-webkit-scrollbar {
		display: none; /* Chrome/Safari — scroll, no bar */
	}
	/* 28-A5: the `.side-cloud :global(...)` halves republish the row look for the cloud
	   slot's FOREIGN DOM. svelte scopes these rules to elements in this template, and a
	   plugin's button carries no scope class, so without them a Publish row rendered
	   under Save would sit unstyled beside every native row. Scoped under the slot only,
	   never as a bare global — the sidebar's look must not leak into the page. */
	/* 38 NOTES-38 #24: the rows in the menu tokens (.tp-menu surface, ContextMenu row metrics) */
	.side-row,
	.side-cloud :global(.side-row) {
		display: flex;
		width: 100%;
		min-height: 32px;
		align-items: center;
		gap: 10px;
		border-radius: var(--radius-input);
		padding: 0 10px;
		text-align: left;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.side-row:hover,
	.side-cloud :global(.side-row:hover) {
		background-color: var(--surface-hover);
	}
	/* 15-O / 16-P6: the active nav row (Configure Scene while its panel is open) */
	.side-row.active {
		background-color: var(--accent-soft);
		color: var(--text);
	}
	.side-row.active .side-ico {
		color: var(--accent-text);
	}
	.side-ico,
	.side-cloud :global(.side-ico) {
		display: inline-flex;
		justify-content: center;
		width: 1.25rem;
		flex-shrink: 0;
		text-align: center;
		color: var(--text-muted);
	}
	/* Clear scene reads as a warning row (the design's warn-text), the bin icon with it */
	#clear-scene {
		color: var(--warn-text);
	}
	#clear-scene .side-ico {
		color: var(--warn-text);
	}
	/* A5: a module toolbox row sits under the Modules row it belongs to */
	.side-sub {
		padding-left: 1.5rem;
		font-size: var(--fs-desc);
	}
	.side-hint {
		margin-left: auto;
		padding-left: 12px;
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	.side-label {
		padding: 8px 10px 4px;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	/* showhide-v8 §6: the footer (Settings + version) stays at the bottom of the scrolling menu */
	.side-foot {
		position: sticky;
		bottom: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		margin-top: 5px;
		padding-top: 4px;
		border-top: 1px solid var(--border);
		background: var(--surface-1);
	}
	.side-foot .side-row {
		flex: 1 1 auto;
	}
	.side-version {
		flex: 0 0 auto;
		padding: 0 8px;
		min-height: 32px;
		border-radius: var(--radius-input);
		color: var(--text-faint);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
	}
	.side-version:hover {
		background-color: var(--surface-hover);
		color: var(--text);
	}
	.side-div {
		height: 1px;
		margin: 5px 4px;
		background: var(--border);
	}
	/* the save format: the kit's Segmented (an inset well, the chosen one raised) */
	.side-segs {
		gap: 2px;
	}
	.side-segs > .side-seg:first-child {
		margin-left: 0;
	}
	.side-seg {
		flex: 1;
		height: 26px;
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		padding: 0 8px;
		font-size: var(--fs-badge);
		font-weight: 500;
		background-color: var(--surface-inset);
		color: var(--text-muted);
	}
	.side-seg:hover {
		color: var(--text);
	}
	.side-seg.on {
		background-color: var(--segment-on);
		border-color: var(--border-strong);
		color: var(--text);
		box-shadow: var(--shadow-knob);
	}
	#export-settings-cog {
		flex: 0 0 auto;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 30px;
		padding: 0;
	}
	/* 41b H14 — the COMPACT project actions: a strict two-column grid, icon beside label, each cell
	   the list row's own metrics (.side-row), Save split into the action and its ▾ options */
	.pa-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
		gap: 2px 4px;
		margin-bottom: 2px;
	}
	.pa-wide {
		grid-column: 1 / -1;
	}
	.pa-btn {
		min-width: 0;
	}
	.pa-label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pa-split {
		display: flex;
		min-width: 0;
	}
	.pa-split > .pa-split-main {
		flex: 1 1 auto;
		border-top-right-radius: 0;
		border-bottom-right-radius: 0;
	}
	/* showhide-v8 §6: Save as… carries its words, so it is as wide as they are; Save greys until an edit */
	.pa-split > .pa-split-more.pa-save-as {
		flex: 0 0 auto;
		width: auto;
		gap: 2px;
		padding: 0 6px 0 8px;
	}
	.pa-split > .pa-split-main:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.pa-split > .pa-split-more {
		flex: 0 0 28px;
		width: 28px;
		justify-content: center;
		padding: 0;
		border-top-left-radius: 0;
		border-bottom-left-radius: 0;
		color: var(--text-muted);
		box-shadow: inset 1px 0 0 var(--border);
	}
	.pa-split > .pa-split-more:hover {
		color: var(--text);
	}
	/* the id: a click leaves the logo FOCUSED, and the forms plugin's :focus rule (box-shadow
	   from empty ring vars, a black border) ties a plain class and wins on order */
	#logo-menu.logo-open {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 35%, transparent);
	}
	/* When the Connect bar docks to a full-width top strip, the logo + its menu drop
	   below it — driven dynamically by connectDocked/connectBarHeight (inline `top`),
	   which adapts to the bar's height (incl. its pinned tab strip) at any width. */
</style>
