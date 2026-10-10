<script lang="ts">
	import Icon from '../ui/Icon.svelte';
	import SheetGrip from '../ui/SheetGrip.svelte';
	import { readSheetH, saveSheetH } from '$lib/ui/sheetDrag.js';
	import { phoneShellActive, phoneSheetMaxH } from '$lib/ui/phoneShell.js';
	import { openPublishExport } from '$lib/export/exportStores.js';
	import { openMomentReport } from '$lib/perf/moment';
	import { openProblemReport } from '$lib/problemReport';
	import '../../app.css';
	import { moduleToolboxes, openToolboxes, buildToolboxItems } from '$lib/moduleToolboxes';
	import '../../styles/menu.css';
	import { tick } from 'svelte';
	import { fade } from 'svelte/transition';
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
	import { checkpointsOpen, checkpointSaveOpen } from '../../stores/appStore.js'; // 36 B14
	import { startEditorTour } from '$lib/tours/builtin.js';
	import { safeStorage } from '$lib/safeStorage';
	import { statsOpen } from '$lib/sceneBudget';
	import { layoutsMenuOpen } from '$lib/uiLayouts'; // 37 R14

	// 203: redesigned as a compact floating panel — flat list (order preserved,
	// no boxed group / section headers / vertical bar), a fast fade-in (was a
	// slide from the left), narrower than the Properties sidebar so it needs no
	// scrollbar, and floated ABOVE the bottom dock (z-hud) instead of covered.
	// The Files format picker became a segmented control (the old dropdown was
	// fiddly). Themed for light + dark.

	// B3: Scene (.tpscene) is the primary SCENE format; JSON is demoted behind the
	// export-settings cog ("Show JSON") since it's rarely used. 21-G8 (fork 11): TP —
	// the whole PROJECT as one .tp — is the new default for anyone without a stored
	// preference; a user who picked a format keeps it.
	//
	// 21-H1 (locked answer 1): the primary row is `Project | Scene` — the two formats
	// this app is actually about — and BOTH of the others are optional now. GLTF joined
	// JSON behind the cog (default OFF): it is an interchange format, not a way to keep
	// your work, and it was taking a permanent third of a row from the two that are.
	// An enabled optional format renders on a SECOND ROW rather than widening the first,
	// so the primary pair never moves as the cog is toggled.
	const initShowJson = typeof localStorage !== 'undefined' && safeStorage.getItem('showJsonFormat') === 'true';
	const initShowGltf = typeof localStorage !== 'undefined' && safeStorage.getItem('showGltfFormat') === 'true';
	/**
	 * A STORED format can name one that is no longer on screen — a Save button pointing
	 * at a control the user cannot see, which is the bug the JSON rule already existed
	 * to avoid. Generalized here because `gltf` acquired the same property the moment it
	 * became optional: one function, consulted at boot AND every time a checkbox moves.
	 */
	function visibleFormat(f: string, json: boolean, gltf: boolean) {
		if (f === 'json' && !json) return 'tp';
		if (f === 'gltf' && !gltf) return 'tp';
		return f;
	}
	const initFormat = typeof localStorage !== 'undefined' ? safeStorage.getItem('saveFormat') || 'tp' : 'tp';
	let saveFormat = $state(visibleFormat(initFormat, initShowJson, initShowGltf));
	let showJson = $state(initShowJson);
	let showGltf = $state(initShowGltf);
	let exportSettingsOpen = $state(false);
	// export-settings popup is anchored BELOW-RIGHT of the cog (so its relation is
	// clear), clamped to the viewport when there isn't room
	let exportPos = $state({ top: 0, left: 0 });
	function openExportSettings(e: MouseEvent) {
		const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const w = 256;
		// 21-H1: one more row (Show GLTF) — the clamp has to know about it.
		// 21-I5: +1 row, +1 group heading, +1 divider (the .tp version-history checkbox)
		const h = 360;
		let left = r.left; // top-left of the popup aligns under the cog, extending right
		let top = r.bottom + 6;
		left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
		top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
		exportPos = { top, left };
		exportSettingsOpen = true;
	}
	let tpAssets = $state(typeof localStorage !== 'undefined' && safeStorage.getItem('tpsceneAssets') !== 'false');
	let tpPacks = $state(typeof localStorage !== 'undefined' && safeStorage.getItem('tpscenePacks') === 'true');
	let tpFlow = $state(typeof localStorage !== 'undefined' && safeStorage.getItem('tpsceneFlow') !== 'false');
	// 21-I5 (locked answer 2): the PROJECT box is ON by default, because a .tp has carried
	// its scene history since 21-G3 and flipping that off silently would make an existing
	// behaviour vanish — and it gates machinery with its own proper import.
	//
	// There is no SCENE counterpart, and the absence is deliberate. The Save button
	// exports whatever is in the viewport, which cannot always answer "and its history":
	// an unnamed or never-travelled scene has no manifest entry, so the box that used to
	// sit here silently bundled nothing. The Explorer's scene card knows the name and the
	// history unambiguously, so downloading versions lives on ITS menu instead.
	let tpProjectVersions = $state(typeof localStorage === 'undefined' || safeStorage.getItem('tpProjectVersions') !== 'false');
	function pickFormat(f: string) {
		saveFormat = f;
		safeStorage.setItem('saveFormat', f);
	}
	/** Called after either cog checkbox moves: if what is selected just went off screen,
	 * fall back (and PERSIST the fallback — the stored value is what the next boot reads). */
	function syncFormatVisibility() {
		const next = visibleFormat(saveFormat, showJson, showGltf);
		if (next !== saveFormat) pickFormat(next);
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

	// 15-J viewer gate + 33 (L3) the Clear scene modal live in $lib/sceneTemplates.confirmClearScene
	// now — shared with the Templates modal's "Blank scene" card.
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
		transition:fade={{ duration: 130 }}
		class="app-sidebar tp-ui tp-menu tp-noscrollbar fixed"
		style="--side-top: {$connectDocked ? $connectBarHeight + 64 : 64}px; {$phoneShellActive ? `--menu-sheet-h: ${menuShown}px` : ''}"
	>
		{#if $phoneShellActive}
			<SheetGrip class="side-grip" label="main menu" height={menuShown} onresize={menuResize} onclose={() => closeMenu.set(true)} />
		{/if}
		<!-- multiple + the companion types so an .obj can be picked TOGETHER with its
		     .mtl and textures (17-D2); a lone model file behaves exactly as before -->
		<input type="file" id="import-file" multiple style="display: none" oninput={(e: any) => importModelFiles(e.target.files)} accept=".gltf, .glb, .obj, .stl, .fbx, .mtl, .png, .jpg, .jpeg, .webp" />
		<input type="file" id="load-file" style="display: none" oninput={(e: any) => load(e.target.files[0])} accept=".json, .tpscene, .tp" />

		<!-- 38 NOTES-38 #24 (design page): the main menu is one of the app's menus — the menu
		     surface, 32px rows, faint section labels (Project · Scene · Collaborate · App) and a
		     Segmented save format. Every row, id and handler is unchanged; Modules stays under
		     Scene (phase 126's order, sidebar-reorg) and Settings stays in App. -->
		<div class="side-label">Project</div>
		<!-- New scene from a starting point (General / Examples / Community tabs) -->
		<button id="open-templates" class="side-row" onclick={() => { templatesModalOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="layout-template" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Templates</span>
		</button>

		<!-- Files -->
		<button class="side-row" onclick={() => pickFile('import-file')}>
			<span class="side-ico"><Icon name="file-input" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Import</span>
		</button>
		<button class="side-row" onclick={() => pickFile('load-file')}>
			<span class="side-ico"><Icon name="folder-open" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Load</span>
		</button>
		<button class="side-row" onclick={() => save(saveFormat)}>
			<span class="side-ico"><Icon name="save" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Save</span>
		</button>
		<!-- 21-H1: [ Project | Scene | cog ]. The KEY stays 'tp' and the id stays
		     #format-tp — the id addresses the format, not the word — but the label reads
		     "Project", because that is what the file is. -->
		<div id="format-row" class="side-segs mb-0.5 mt-0.5 flex pl-9 pr-2">
			<button id="format-tp" class="side-seg {saveFormat === 'tp' ? 'on' : ''}" title="Saves the whole project as .tp — the Explorer library, scene history and manifest" onclick={() => pickFormat('tp')}>Project</button>
			<button id="format-tpscene" class="side-seg {saveFormat === 'tpscene' ? 'on' : ''}" title="Saves the open scene as .tpscene" onclick={() => pickFormat('tpscene')}>Scene</button>
			<button id="export-settings-cog" class="side-seg" title="Export settings" onclick={openExportSettings}><Icon name="settings" size={16} aria-hidden="true" /></button>
		</div>
		<!-- the SECOND row: whichever optional formats the cog has enabled. Absent
		     entirely when neither is, so nothing here costs a pixel by default. -->
		{#if showGltf || showJson}
			<div id="format-row-optional" class="side-segs mb-0.5 flex pl-9 pr-2">
				{#if showGltf}
					<button id="format-gltf" class="side-seg {saveFormat === 'gltf' ? 'on' : ''}" title="Exports the scene as glTF — for other tools, not for keeping your work" onclick={() => pickFormat('gltf')}>GLTF</button>
				{/if}
				{#if showJson}
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

		<div class="side-div"></div>
		<div class="side-label">Scene</div>

		<!-- Scene -->
		<!-- 15-O: the "●" text prefix is gone — it shifted the label as it appeared
		     (read as a glitch) and duplicated what the open panel already shows.
		     The row itself carries an `active` highlight instead, like any nav item. -->
		<button class="side-row" class:active={!$inspectorClose && $inspectorKind === 'scene'} onclick={() => showSidebar('scene')}>
			<span class="side-ico"><Icon name="sliders-horizontal" size={16} aria-hidden="true" /></span>
			<span class="flex-1 whitespace-nowrap">Configure Scene</span>
		</button>
		<button id="clear-scene" class="side-row" onclick={() => { closeMenu.set(true); void confirmClearScene(); }}>
			<span class="side-ico"><Icon name="trash-2" size={16} class="ico-danger" aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Clear Scene</span>
		</button>
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
		<div class="side-div"></div>
		<div class="side-label">Collaborate</div>
		<button id="open-sessions-manager" class="side-row" onclick={() => { sessionsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="archive" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Sessions</span>
		</button>
		<!-- 36 B14: named checkpoints + the timeline they live in -->
		<button id="save-checkpoint" class="side-row" onclick={() => { checkpointSaveOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="bookmark" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Save checkpoint…</span>
			<span class="side-hint">Ctrl+Shift+S</span>
		</button>
		<button id="open-checkpoints" class="side-row" onclick={() => { checkpointsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="history" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Checkpoints</span>
		</button>

		<div class="side-div"></div>
		<div class="side-label">App</div>

		<!-- App -->
		<!-- 26-A: what the scene costs. It sits beside Settings rather than under it
		     because it is something you WATCH while working, not something you set. -->
		<button id="open-stats" class="side-row" onclick={() => { statsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="gauge" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Statistics</span>
		</button>
		<!-- 34 R1: the last 30 s of frame data + what the viewport shows + a note, kept as a
			recording (and sent when performance reports are on) -->
		<button id="report-moment" class="side-row" onclick={() => { closeMenu.set(true); void openMomentReport(); }}>
			<span class="side-ico"><Icon name="flag" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Report this moment</span>
		</button>
		<!-- 37 R20: a picture + boxes round what is wrong + a note, sent to the team with consent -->
		<button id="report-problem" class="side-row" onclick={() => { closeMenu.set(true); void openProblemReport(); }}>
			<span class="side-ico"><Icon name="message-square-warning" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Report a problem</span>
		</button>
		<!-- 36 U5: "Live profiler" left the menu — it is a Profiler tool, opened from the
		     Profiler tab's own header (#profiler-open-live) beside Record and Import -->
		<button class="side-row" onclick={() => { settingsOpen.set(!$settingsOpen); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="settings" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Settings</span>
		</button>
		<button class="side-row" onclick={() => window.open('https://docs.theprototype.app', '_blank')}>
			<span class="side-ico"><Icon name="book-open" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Docs</span>
		</button>
		<!-- the unseen cue is a CLASS toggle, not an {#if}: clicking this row closes the
		     menu, and destroying a nested branch inside the subtree being destroyed in
		     the same flush crashes Svelte's sibling walk (destroy_effect). -->
		<button id="open-whats-new" class="side-row" onclick={() => { openWhatsNew(); closeMenu.set(true); }}>
			<span class="side-ico"><Icon name="sparkles" size={16} aria-hidden="true" /></span>
			<span class="flex-1 whitespace-nowrap">What's new</span>
			<span class="row-dot" class:row-dot-on={$whatsNewUnseen}></span>
		</button>
		<!-- 36 I5: the first-run editor tour, again (Settings ▸ Tours has the VR welcome + reset) -->
		<button id="open-tour" class="side-row" onclick={() => { closeMenu.set(true); startEditorTour(); }}>
			<span class="side-ico"><Icon name="compass" size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Tours</span>
		</button>
	</nav>
{/if}

{#if exportSettingsOpen}
	<!-- B3 export settings. Rendered at the component ROOT (not inside .app-sidebar,
	     whose backdrop-blur-sm would make this fixed panel center on the sidebar and
	     spill off the left edge). Modal tier so it clears the avatar/Connect chrome. -->
	<button
		class="fixed inset-0 cursor-default bg-scrim"
		style="z-index: calc(var(--z-menu) + 1)"
		aria-label="Close export settings"
		onclick={() => (exportSettingsOpen = false)}
	></button>
	<div
		id="export-settings-modal"
		class="fixed w-64 max-w-[92vw] rounded-lg border border-border bg-surface-1 p-4 text-sm text-text shadow-2xl"
		style="z-index: calc(var(--z-menu) + 2); top: {exportPos.top}px; left: {exportPos.left}px;"
	>
		<p class="mb-2 font-semibold">Export settings</p>
		<p class="mb-1 text-[11px] text-text-muted">Scene (.tpscene) includes:</p>
		<label class="flex items-center gap-2 py-0.5">
			<input class="tp-check" type="checkbox" checked={tpAssets} onchange={(e: any) => { tpAssets = e.target.checked; safeStorage.setItem('tpsceneAssets', String(tpAssets)); }} />
			Assets (audio, textures, configs)
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-packs" class="tp-check" type="checkbox" checked={tpPacks} onchange={(e: any) => { tpPacks = e.target.checked; safeStorage.setItem('tpscenePacks', String(tpPacks)); }} />
			Imported packs
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-flow" class="tp-check" type="checkbox" checked={tpFlow} onchange={(e: any) => { tpFlow = e.target.checked; safeStorage.setItem('tpsceneFlow', String(tpFlow)); }} />
			Flow graph (nodes + edges)
		</label>
		<div class="my-2 border-t border-border"></div>
		<p class="mb-1 text-[11px] text-text-muted">Project (.tp) includes:</p>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tp-project-versions" class="tp-check" type="checkbox" checked={tpProjectVersions} onchange={(e: any) => { tpProjectVersions = e.target.checked; safeStorage.setItem('tpProjectVersions', String(tpProjectVersions)); }} />
			<span title="Every kept version of every scene. Off exports each scene's current version only.">Scene version history</span>
		</label>
		<div class="my-2 border-t border-border"></div>
		<!-- 21-H1: both optional formats, same shape, both OFF by default -->
		<label class="flex items-center gap-2 py-0.5">
			<input id="show-gltf-format" class="tp-check" type="checkbox" checked={showGltf} onchange={(e: any) => { showGltf = e.target.checked; safeStorage.setItem('showGltfFormat', String(showGltf)); syncFormatVisibility(); }} />
			Show GLTF format
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="show-json-format" class="tp-check" type="checkbox" checked={showJson} onchange={(e: any) => { showJson = e.target.checked; safeStorage.setItem('showJsonFormat', String(showJson)); syncFormatVisibility(); }} />
			Show JSON format
		</label>
		<div class="mt-3 flex justify-end">
			<button class="rounded-sm bg-surface-active px-2 py-1 text-xs text-text hover:bg-border-strong" onclick={() => (exportSettingsOpen = false)}>Close</button>
		</div>
	</div>
{/if}

<style>
	/* (no background here: an undefined --color-form blanked the utility's surface fill — a
	   scoped rule beats every utility — which theme.css's !important remap used to hide) */
	.burger {
		top: 8px;
		left: 8px;
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
		left: 8px;
		z-index: var(--z-menu);
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
