<script lang="ts">
	import { Archive, BookOpen, FileInput, FolderOpen, LayoutTemplate, Puzzle, Save, Settings, SlidersHorizontal, Trash2, Wrench } from '@lucide/svelte';
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
	import { whatsNewUnseen, openWhatsNew } from '$lib/whatsNew';

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
	const initShowJson = typeof localStorage !== 'undefined' && localStorage.getItem('showJsonFormat') === 'true';
	const initShowGltf = typeof localStorage !== 'undefined' && localStorage.getItem('showGltfFormat') === 'true';
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
	const initFormat = typeof localStorage !== 'undefined' ? localStorage.getItem('saveFormat') || 'tp' : 'tp';
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
		const h = 276; // 21-H1: one more row (Show GLTF) — the clamp has to know about it
		let left = r.left; // top-left of the popup aligns under the cog, extending right
		let top = r.bottom + 6;
		left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
		top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
		exportPos = { top, left };
		exportSettingsOpen = true;
	}
	let tpAssets = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpsceneAssets') !== 'false');
	let tpPacks = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpscenePacks') === 'true');
	let tpFlow = $state(typeof localStorage !== 'undefined' && localStorage.getItem('tpsceneFlow') !== 'false');
	function pickFormat(f: string) {
		saveFormat = f;
		localStorage.setItem('saveFormat', f);
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

	// 15-J viewer gate + confirm toast live in $lib/sceneTemplates.confirmClearScene
	// now — shared with the Templates modal's "Blank scene" card.
</script>

<!-- 94: the logo IS the menu button. Open state = accent ring. -->
<button
	id="logo-menu"
	class="burger flex items-center justify-center rounded-lg border bg-gray-800/90 shadow-lg backdrop-blur-sm transition-transform hover:scale-105 {$closeMenu
		? 'border-gray-700/60'
		: 'border-primary-500 ring-2 ring-primary-500/50'}"
	style="height: 48px; width: 48px; {$connectDocked ? `top: ${$connectBarHeight + 8}px` : ''}"
	title={$closeMenu ? 'Open menu' : 'Close menu'}
	onclick={toggleMenu}
>
	<img src="logo.svg" alt="menu" class="h-9 w-9" />
	<!-- RW/B4: unseen-update cue. A dot, never a boot dialog — the menu's "What's new"
	     row (and the one update toast) lead to the changelog. Class toggle, not an
	     {#if}, so nothing is destroyed mid-flush when the cue clears (see the row). -->
	<span class="update-dot" class:update-dot-on={$whatsNewUnseen} title="Updated — see what's new"></span>
</button>

{#if !$closeMenu}
	<nav
		id="sidebar70"
		transition:fade={{ duration: 130 }}
		class="app-sidebar fixed rounded-xl border border-gray-200 bg-white/95 p-1.5 text-gray-900 shadow-xl backdrop-blur-sm dark:border-gray-700 dark:bg-gray-800/95 dark:text-gray-100"
		style={$connectDocked ? `top: ${$connectBarHeight + 64}px` : ''}
	>
		<!-- multiple + the companion types so an .obj can be picked TOGETHER with its
		     .mtl and textures (17-D2); a lone model file behaves exactly as before -->
		<input type="file" id="import-file" multiple style="display: none" oninput={(e: any) => importModelFiles(e.target.files)} accept=".gltf, .glb, .obj, .stl, .fbx, .mtl, .png, .jpg, .jpeg, .webp" />
		<input type="file" id="load-file" style="display: none" oninput={(e: any) => load(e.target.files[0])} accept=".json, .tpscene, .tp" />

		<!-- New scene from a starting point (General / Examples / Community tabs) -->
		<button id="open-templates" class="side-row" onclick={() => { templatesModalOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><LayoutTemplate size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Templates</span>
		</button>

		<div class="side-div"></div>

		<!-- Files -->
		<button class="side-row" onclick={() => pickFile('import-file')}>
			<span class="side-ico"><FileInput size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Import</span>
		</button>
		<button class="side-row" onclick={() => pickFile('load-file')}>
			<span class="side-ico"><FolderOpen size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Load</span>
		</button>
		<button class="side-row" onclick={() => save(saveFormat)}>
			<span class="side-ico"><Save size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Save</span>
		</button>
		<!-- 21-H1: [ Project | Scene | cog ]. The KEY stays 'tp' and the id stays
		     #format-tp — the id addresses the format, not the word — but the label reads
		     "Project", because that is what the file is. -->
		<div id="format-row" class="mb-0.5 mt-0.5 flex gap-1 pl-9 pr-2">
			<button id="format-tp" class="side-seg {saveFormat === 'tp' ? 'on' : ''}" title="Saves the whole project as .tp — the Explorer library, scene history and manifest" onclick={() => pickFormat('tp')}>Project</button>
			<button id="format-tpscene" class="side-seg {saveFormat === 'tpscene' ? 'on' : ''}" title="Saves the open scene as .tpscene" onclick={() => pickFormat('tpscene')}>Scene</button>
			<button id="export-settings-cog" class="side-seg" title="Export settings" onclick={openExportSettings}><Settings size={16} aria-hidden="true" /></button>
		</div>
		<!-- the SECOND row: whichever optional formats the cog has enabled. Absent
		     entirely when neither is, so nothing here costs a pixel by default. -->
		{#if showGltf || showJson}
			<div id="format-row-optional" class="mb-0.5 flex gap-1 pl-9 pr-2">
				{#if showGltf}
					<button id="format-gltf" class="side-seg {saveFormat === 'gltf' ? 'on' : ''}" title="Exports the scene as glTF — for other tools, not for keeping your work" onclick={() => pickFormat('gltf')}>GLTF</button>
				{/if}
				{#if showJson}
					<button id="format-json" class="side-seg {saveFormat === 'json' ? 'on' : ''}" title="Saves the scene as raw JSON" onclick={() => pickFormat('json')}>JSON</button>
				{/if}
			</div>
		{/if}

		<div class="side-div"></div>

		<!-- Scene -->
		<!-- 15-O: the "●" text prefix is gone — it shifted the label as it appeared
		     (read as a glitch) and duplicated what the open panel already shows.
		     The row itself carries an `active` highlight instead, like any nav item. -->
		<button class="side-row" class:active={!$inspectorClose && $inspectorKind === 'scene'} onclick={() => showSidebar('scene')}>
			<span class="side-ico"><SlidersHorizontal size={16} aria-hidden="true" /></span>
			<span class="flex-1 whitespace-nowrap">Configure Scene</span>
		</button>
		<button class="side-row" onclick={() => void confirmClearScene()}>
			<span class="side-ico"><Trash2 size={16} class="ico-danger" aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Clear Scene</span>
		</button>
		<button id="open-modules-manager" class="side-row" onclick={() => { modulesOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Puzzle size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Modules</span>
		</button>
		<!-- A5: a module's own toolbox, one row each, indented under Modules. This is
		     what makes moduleSDK's JSDoc true — it already CLAIMED a sidebar Modules
		     section that did not exist. Deliberately not a Controls HUD button: the
		     corner HUD already reflows four buttons at <=600px and does not scale to N
		     modules. The rows come from the SAME builder the viewport menu uses. -->
		{#each buildToolboxItems($moduleToolboxes, $openToolboxes) as box (box.id)}
			<button
				id="open-toolbox-{box.id}"
				class="side-row side-sub"
				class:active={box.checked}
				onclick={() => { box.action(); closeMenu.set(true); }}
			>
				<span class="side-ico"><Wrench size={14} aria-hidden="true" /></span>
				<span class="flex-1 whitespace-nowrap">{box.label}</span>
				{#if box.shortcut}<span class="side-hint">{box.shortcut}</span>{/if}
			</button>
		{/each}
		<button id="open-sessions-manager" class="side-row" onclick={() => { sessionsOpen.set(true); closeMenu.set(true); }}>
			<span class="side-ico"><Archive size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Sessions</span>
		</button>

		<div class="side-div"></div>

		<!-- App -->
		<button class="side-row" onclick={() => { settingsOpen.set(!$settingsOpen); closeMenu.set(true); }}>
			<span class="side-ico"><Settings size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Settings</span>
		</button>
		<button class="side-row" onclick={() => window.open('https://docs.theprototype.app', '_blank')}>
			<span class="side-ico"><BookOpen size={16} aria-hidden="true" /></span><span class="flex-1 whitespace-nowrap">Docs</span>
		</button>
		<!-- the unseen cue is a CLASS toggle, not an {#if}: clicking this row closes the
		     menu, and destroying a nested branch inside the subtree being destroyed in
		     the same flush crashes Svelte's sibling walk (destroy_effect). -->
		<button id="open-whats-new" class="side-row" onclick={() => { openWhatsNew(); closeMenu.set(true); }}>
			<span class="side-ico">✨</span>
			<span class="flex-1 whitespace-nowrap">What's new</span>
			<span class="row-dot" class:row-dot-on={$whatsNewUnseen}></span>
		</button>
	</nav>
{/if}

{#if exportSettingsOpen}
	<!-- B3 export settings. Rendered at the component ROOT (not inside .app-sidebar,
	     whose backdrop-blur-sm would make this fixed panel center on the sidebar and
	     spill off the left edge). Modal tier so it clears the avatar/Connect chrome. -->
	<button
		class="fixed inset-0 cursor-default bg-black/40"
		style="z-index: calc(var(--z-menu) + 1)"
		aria-label="Close export settings"
		onclick={() => (exportSettingsOpen = false)}
	></button>
	<div
		id="export-settings-modal"
		class="fixed w-64 max-w-[92vw] rounded-lg border border-gray-700 bg-gray-800 p-4 text-sm text-gray-100 shadow-2xl"
		style="z-index: calc(var(--z-menu) + 2); top: {exportPos.top}px; left: {exportPos.left}px;"
	>
		<p class="mb-2 font-semibold">Export settings</p>
		<p class="mb-1 text-[11px] text-gray-400">Scene (.tpscene) includes:</p>
		<label class="flex items-center gap-2 py-0.5">
			<input class="tp-check" type="checkbox" checked={tpAssets} onchange={(e: any) => { tpAssets = e.target.checked; localStorage.setItem('tpsceneAssets', String(tpAssets)); }} />
			Assets (audio, textures, configs)
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-packs" class="tp-check" type="checkbox" checked={tpPacks} onchange={(e: any) => { tpPacks = e.target.checked; localStorage.setItem('tpscenePacks', String(tpPacks)); }} />
			Imported packs
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="tpscene-flow" class="tp-check" type="checkbox" checked={tpFlow} onchange={(e: any) => { tpFlow = e.target.checked; localStorage.setItem('tpsceneFlow', String(tpFlow)); }} />
			Flow graph (nodes + edges)
		</label>
		<div class="my-2 border-t border-gray-700"></div>
		<!-- 21-H1: both optional formats, same shape, both OFF by default -->
		<label class="flex items-center gap-2 py-0.5">
			<input id="show-gltf-format" class="tp-check" type="checkbox" checked={showGltf} onchange={(e: any) => { showGltf = e.target.checked; localStorage.setItem('showGltfFormat', String(showGltf)); syncFormatVisibility(); }} />
			Show GLTF format
		</label>
		<label class="flex items-center gap-2 py-0.5">
			<input id="show-json-format" class="tp-check" type="checkbox" checked={showJson} onchange={(e: any) => { showJson = e.target.checked; localStorage.setItem('showJsonFormat', String(showJson)); syncFormatVisibility(); }} />
			Show JSON format
		</label>
		<div class="mt-3 flex justify-end">
			<button class="rounded-sm bg-gray-600 px-2 py-1 text-xs hover:bg-gray-500" onclick={() => (exportSettingsOpen = false)}>Close</button>
		</div>
	</div>
{/if}

<style>
	.burger {
		background-color: var(--color-form);
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
		background: #60a5fa;
		box-shadow: 0 0 0 2px var(--color-form, #1f2937);
		visibility: hidden;
	}
	.update-dot-on {
		visibility: visible;
	}
	.row-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #60a5fa;
		flex: 0 0 auto;
		visibility: hidden;
	}
	.row-dot-on {
		visibility: visible;
	}
	/* the logo menu opens above everything (Connect, toasts) */
	.app-sidebar {
		top: 64px;
		left: 8px;
		z-index: var(--z-menu);
		/* size to the widest row so wider-font themes (e.g. 8-bit) never overflow
		   the panel and overlap the scene; clamped so it stays compact */
		width: max-content;
		min-width: 12.5rem;
		max-width: 17rem;
		/* short viewports: touch-scroll the menu, but with no visible scrollbar */
		max-height: calc(100vh - 72px);
		overflow-y: auto;
		overflow-x: hidden;
		scrollbar-width: none; /* Firefox */
		-webkit-overflow-scrolling: touch;
	}
	.app-sidebar::-webkit-scrollbar {
		display: none; /* Chrome/Safari — scroll, no bar */
	}
	.side-row {
		display: flex;
		width: 100%;
		align-items: center;
		gap: 0.5rem;
		border-radius: 0.375rem;
		padding: 0.4rem 0.5rem;
		text-align: left;
		font-size: 0.875rem;
	}
	.side-row:hover {
		background-color: rgb(0 0 0 / 0.06);
	}
	:global(.dark) .side-row:hover {
		background-color: rgb(255 255 255 / 0.08);
	}
	/* 15-O: active nav row (Configure Scene while its panel is open) — a tinted
	   row + accent rule, replacing the "●" that used to shift the label */
	/* 16-P6: tint + accent text only — the inset accent bar read as a stray border */
	.side-row.active {
		background-color: rgb(59 130 246 / 0.12);
		color: var(--color-primary-400, #60a5fa);
	}
	.side-ico {
		width: 1.25rem;
		flex-shrink: 0;
		text-align: center;
	}
	/* A5: a module toolbox row sits under the Modules row it belongs to */
	.side-sub {
		padding-left: 1.25rem;
		font-size: 0.8125rem;
	}
	.side-hint {
		margin-left: auto;
		opacity: 0.55;
		font-family: ui-monospace, monospace;
		font-size: 0.6875rem;
	}
	.side-div {
		margin: 0.35rem 0.25rem;
		border-top: 1px solid rgb(0 0 0 / 0.1);
	}
	:global(.dark) .side-div {
		border-top-color: rgb(255 255 255 / 0.1);
	}
	.side-seg {
		flex: 1;
		border-radius: 0.25rem;
		padding: 0.1rem 0.4rem;
		font-size: 0.625rem;
		font-weight: 600;
		background-color: rgb(0 0 0 / 0.06);
		color: rgb(75 85 99);
	}
	:global(.dark) .side-seg {
		background-color: rgb(255 255 255 / 0.08);
		color: rgb(209 213 219);
	}
	.side-seg.on {
		background-color: var(--color-primary-600, #2563eb);
		color: #fff;
	}
	/* When the Connect bar docks to a full-width top strip, the logo + its menu drop
	   below it — driven dynamically by connectDocked/connectBarHeight (inline `top`),
	   which adapts to the bar's height (incl. its pinned tab strip) at any width. */
</style>
