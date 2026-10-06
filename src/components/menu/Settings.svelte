<script lang="ts">
	import { Modal } from 'flowbite-svelte';
	// 36 B14: the sections REGISTER into the sidebar (settingsNav); the two components keep
	// flowbite's names, so every `<AccordionItem>` block below is untouched and a section another
	// lane adds appears in the sidebar with no second edit.
	// 37-settings (R21): the window is the redesign's — the kit's modal header with the search in it,
	// a GROUPED sidebar (General / Workspace / Devices & services, About pinned), one content column
	// (~660 px) with the app's minimal scrollbar, sub-pages with a breadcrumb, and a quiet footer
	// ("Reset <Category> to defaults" · "Changes save automatically" · Done). Under 640 px: the
	// category LIST first, then a pushed page with "‹ Settings" (and "‹ <Category>" on a sub-page).
	import Accordion from './settings/SettingsSections.svelte';
	import AccordionItem from './settings/SettingsSection.svelte';
	import SettingsNav from './settings/SettingsNav.svelte';
	import WindowChrome from '../ui/WindowChrome.svelte';
	import SearchField from '../ui/SearchField.svelte';
	import KitButton from '../ui/Button.svelte';
	import NavRow from '../ui/NavRow.svelte';
	import KitRow from '../ui/SettingRow.svelte';
	import ChangelogBody from './settings/ChangelogBody.svelte';
	import { showConfirm } from '$lib/confirmDialog';
	import Section from '../ui/Section.svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import '$lib/uiDensity'; // NOTES-38 #19: applies the stored density at boot
	import { setContext, tick } from 'svelte';
	import { get } from 'svelte/store';
	import { createSettingsNav, NAV_CONTEXT, sectionKeyOf } from '$lib/settingsNav';
	import { canResetCategory, askResetCategory, askResetAllSettings } from '$lib/settings/resetCategory.js';
	import { whatsNewUnseen } from '$lib/whatsNew';
	const settingsNav = createSettingsNav();
	setContext(NAV_CONTEXT, settingsNav);
	const { active: navActive, sub: navSub, home: navHome } = settingsNav;
	// a phone (< 640 px) gets the category list + pushed pages instead of a sidebar
	const narrowQuery = typeof window === 'undefined' ? null : window.matchMedia?.('(max-width: 639.98px)');
	let narrowSettings = !!narrowQuery?.matches;
	narrowQuery?.addEventListener?.('change', (e) => (narrowSettings = e.matches));
	// 36 I4: what a row is known by (its text, group, section, keywords) + the highlight spans
	import { rowMatches, matchSpans } from '$lib/settingsSearch';
	// 37-settings: one file per category page (the redesign kit); the sections another lane adds
	// still drop in here with one import + one line (a legacy `<SettingRow>` draws the new row too)
	import InterfaceSettings from './settings/InterfaceSettings.svelte'; // absorbs text selection, avatars, tours
	import ControlsSettings from './settings/ControlsSettings.svelte';
	import InputSettings from './settings/InputSettings.svelte'; // absorbs NodeEditorViewSettings
	import TouchControlsSettings from './TouchControlsSettings.svelte'; // 36 U8 (its own section)
	import ShortcutsSettings from './settings/ShortcutsSettings.svelte';
	import SceneSettings from './settings/SceneSettings.svelte'; // checkpoints, loading, water render inside
	import ExplorerSettings from './settings/ExplorerSettings.svelte';
	import NodeTypesSection from './NodeTypesSection.svelte'; // 36 B7
	// 36-export: the export defaults (its own file; also the Publish / Export modal's Settings tab)
	import ExportSettingsSection from './ExportSettingsSection.svelte';
	import VRSettingsSection from './VRSettingsSection.svelte'; // the whole VR page
	import AiSettings from './settings/AiSettings.svelte';
	import ConnectionSettings from './settings/ConnectionSettings.svelte';
	import { settingsOpen, settingsSection, hidePanels, restorePanels, showToast } from '../../stores/appStore.js';
	import { cloudPluginInfo } from '$lib/cloudHooks';
	import { versionString } from '$lib/version.js';
	// 27-B: the diagnostics bundle — clipboard only, nothing leaves the browser
	import { copyDiagnostics } from '$lib/diagnostics';
	import { clearSavedSession } from '$lib/autosave';
	import { autofocusOk, typeToFocus } from '$lib/inputDevice';
	const appVersionString = versionString();

	let shortcutsExpanded = false;
	let aiExpanded = false;
	// 36-export: Settings ▸ Export — opened by a search (the filter needs mounted rows) or a deep link
	let exportExpanded = false;
	// 36 B7: Settings ▸ Node types (the node manager) — opened by a search or a deep link
	let nodeTypesExpanded = false;
	$: if ((settingsQuery || '').trim() || ($settingsOpen && $settingsSection === 'nodetypes')) nodeTypesExpanded = true;
	$: if ((settingsQuery || '').trim() || ($settingsOpen && $settingsSection === 'export')) exportExpanded = true;
	let sceneExpanded = false;
	let explorerExpanded = false;
	let connectionExpanded = false;
	let aboutExpanded = false;
	let vrExpanded = false; // D7: edit-cap toasts deep-link here ('vr')
	let interfaceExpanded = false;
	let controlsExpanded = false;
	let inputExpanded = false; // 21-E5: gamepad (the shortcuts-registry precedent: LOCAL prefs)


	// Hide open panels while settings is shown, restore them after (initial value is null,
	// so nothing happens until the modal is opened the first time)
	$: if ($settingsOpen) {
		hidePanels();
		shortcutsExpanded = $settingsSection === 'shortcuts';
		aiExpanded = $settingsSection === 'ai';
		sceneExpanded = $settingsSection === 'scene';
		connectionExpanded = $settingsSection === 'connection';
		vrExpanded = $settingsSection === 'vr';
		interfaceExpanded = $settingsSection === 'interface';
		controlsExpanded = $settingsSection === 'controls';
		inputExpanded = $settingsSection === 'input';
		// R22 round 12: the file settings were reachable by deep link in every sense EXCEPT
		// this line — the section existed, the store existed, and nothing mapped one onto
		// the other. The delete strip's "File settings" button is the first caller.
		explorerExpanded = $settingsSection === 'explorer';
		// 37-settings: a phone opens on the category LIST unless a deep link names a page
		if (narrowSettings && !$settingsSection) settingsNav.showHome();
	} else if ($settingsOpen === false) {
		restorePanels();
		$settingsSection = null;
	}

	// U-3: filter the (numerous) settings rows by a search query. A `use:` action
	// keeps it legacy-mode safe — it toggles each row's display without touching
	// the heterogeneous markup. Rows carry the `.setting-row` class; inner controls
	// live in <p>, so hiding a row never hides a control inside a shown row.
	let settingsQuery = '';
	let searchInput: any = null; // the search box (bound to SearchField.inputEl — never undefined: props_invalid_value)
	/**
	 * Searching must EXPAND every section first. flowbite-svelte 1.x renders an
	 * AccordionItem's body only while it is open, so with the sections collapsed
	 * there were literally zero `.setting-row` elements in the DOM and the filter had
	 * nothing to match — that is why search stopped working after the flowbite
	 * migration (the old Accordion kept its content mounted and merely hidden).
	 * The previous expansion is restored when the query clears.
	 */
	/** @type {any} */
	let savedExpansion: any = null;
	$: syncSearchExpansion(settingsQuery);
	$: settingsNav.setSearching(!!(settingsQuery || '').trim()); // 36 B14

	/** @param {string} query */
	function syncSearchExpansion(query: string) {
		const searching = !!(query || '').trim();
		if (searching && !savedExpansion) {
			savedExpansion = {
				shortcutsExpanded,
				aiExpanded,
				sceneExpanded,
				explorerExpanded,
				interfaceExpanded,
				controlsExpanded,
				inputExpanded,
				connectionExpanded,
				vrExpanded,
				aboutExpanded
			};
			shortcutsExpanded = true;
			aiExpanded = true;
			sceneExpanded = true;
			explorerExpanded = true;
			interfaceExpanded = true;
			controlsExpanded = true;
			inputExpanded = true;
			connectionExpanded = true;
			vrExpanded = true;
			aboutExpanded = true;
		} else if (!searching && savedExpansion) {
			({
				shortcutsExpanded,
				aiExpanded,
				sceneExpanded,
				explorerExpanded,
				interfaceExpanded,
				controlsExpanded,
				inputExpanded,
				connectionExpanded,
				vrExpanded,
				aboutExpanded
			} = savedExpansion);
			savedExpansion = null;
		}
	}
	/**
	 * Walk the PAGES, not the rows: a section's body is mounted only while it is open, so a
	 * row-first pass sees a partial DOM — and a page hidden on that partial view could never be
	 * shown again (no rows left to walk back from). A MutationObserver re-applies as the bodies
	 * arrive, which beats guessing frames.
	 * 37-settings: a page is `.ss-page` (SettingsSection); its groups are the kit's card labels
	 * (`[data-section-label]`) or a legacy `.ui-section-label`; a row is a `.setting-row` or a kit
	 * NavRow (a submenu is found by its name too); a card left with no row is hidden.
	 * @param {HTMLElement} node @param {string} query
	 */
	function filterSettings(node: HTMLElement, query: string) {
		let needle = (query || '').trim().toLowerCase();
		/** 36 I4: the words an ancestor section declares (`data-keywords` on its root) */
		const ancestorKeywords = (el: Element) => {
			const out: string[] = [];
			for (let e: Element | null = el; e && e !== node; e = e.parentElement) {
				const k = e.getAttribute('data-keywords');
				if (k) out.push(k);
			}
			return out;
		};
		const apply = () => {
			/** @type {Element[]} what the highlight walks: visible rows, group labels, headers */
			const shown: Element[] = [];
			type RowInfo = { el: HTMLElement; info: { text: string; name: string; group: string; section: string; extra: string[] } };
			const pages: { page: HTMLElement; rows: RowInfo[] }[] = [];
			node.querySelectorAll<HTMLElement>('.ss-page').forEach((page) => {
				const section = (page.querySelector('.ss-title')?.textContent || '').replace(/›\s*$/, '').trim();
				const rows: RowInfo[] = [];
				let group = ''; // nearest card / group label above the row ("Sound", "Grid"…)
				page.querySelectorAll('[data-section-label], .ui-section-label, .setting-row, .tp-ui.nr').forEach((el) => {
					if (!el.classList.contains('setting-row') && !el.classList.contains('nr')) {
						group = el.textContent || '';
						return;
					}
					// a NavRow inside a row (an AI provider list) belongs to that row
					if (el.classList.contains('nr') && el.parentElement?.closest('.setting-row')) return;
					rows.push({
						el: el as HTMLElement,
						info: {
							text: el.textContent || '',
							name: (el.querySelector('.sr-name, .nr-label')?.textContent || '').trim(),
							group,
							section,
							extra: ancestorKeywords(el)
						}
					});
				});
				pages.push({ page, rows });
			});
			// searching "grid" finds the whole Grid group and "vr" the VR section; 36 I4: "dark" finds
			// the Theme row (its keywords), and a SECTION's own words count only when no row
			// matched directly — a section-wide word would otherwise list the whole section
			const direct = (r: RowInfo) => rowMatches(needle, r.info);
			const anyDirect = !!needle && pages.some((pg) => pg.rows.some(direct));
			const match = (r: RowInfo) => !needle || (anyDirect ? direct(r) : rowMatches(needle, r.info, { fallback: true }));
			for (const { page, rows } of pages) {
				let visible = 0;
				for (const r of rows) {
					const show = match(r);
					r.el.style.display = show ? '' : 'none';
					if (show) {
						visible++;
						if (needle) shown.push(r.el);
					}
				}
				// a card whose rows all went: hide the card too (its label would stand alone)
				page.querySelectorAll<HTMLElement>('.sec-card-wrap').forEach((card) => {
					const any = [...card.querySelectorAll<HTMLElement>('.setting-row, .tp-ui.nr')].some((r) => r.style.display !== 'none');
					card.style.display = needle && !any ? 'none' : '';
				});
				// hide a page only when we KNOW it has rows and none of them matched;
				// an unmounted body (0 rows) is unknown, and the observer will revisit it
				const hide = !!needle && rows.length > 0 && visible === 0;
				page.style.display = hide ? 'none' : '';
				if (needle && !hide) page.querySelectorAll('[data-section-label], .ui-section-label').forEach((l) => shown.push(l));
			}
			highlight(shown);
		};
		/**
		 * 36 I4: mark every occurrence of the query in what is shown — through the CSS Custom
		 * Highlight API, so no text node svelte owns is ever split or wrapped (a <mark> injected
		 * into a label would be wiped, or worse, kept, on svelte's next update).
		 * @param {Element[]} els
		 */
		const highlight = (els: Element[]) => {
			const H = (globalThis as any).Highlight;
			const reg = (globalThis as any).CSS?.highlights;
			if (!H || !reg) return;
			if (!needle) {
				reg.delete('settings-match');
				return;
			}
			const ranges: Range[] = [];
			for (const el of els) {
				const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
				for (let t = walker.nextNode() as Text | null; t; t = walker.nextNode() as Text | null) {
					const parent = t.parentElement;
					if (!parent || parent.closest('input, textarea, select, option, button[role="switch"]')) continue;
					for (const [a, b] of matchSpans(t.data, needle)) {
						const r = document.createRange();
						r.setStart(t, a);
						r.setEnd(t, b);
						ranges.push(r);
					}
				}
			}
			reg.set('settings-match', new H(...ranges));
		};
		const observer = new MutationObserver(() => apply());
		// childList only: our own style writes are attribute changes, so re-entry
		// cannot loop
		observer.observe(node, { childList: true, subtree: true });
		apply();
		return {
			update(next: string) {
				needle = (next || '').trim().toLowerCase();
				apply();
			},
			destroy: () => {
				observer.disconnect();
				(globalThis as any).CSS?.highlights?.delete('settings-match');
			}
		};
	}

	/**
	 * flowbite's Modal focuses the first focusable child when it opens — on a phone that slides
	 * the on-screen keyboard over the settings the user just opened. Keep the autofocus on pointer
	 * devices (it is genuinely nice there), undo it on touch, and let a real keyboard opt in by
	 * typing (see inputDevice.typeToFocus). The kit's SearchField owns its <input>, so this runs on
	 * the bound element instead of as a `use:` action.
	 * @param {HTMLInputElement} node
	 */
	function searchFocus(node: HTMLInputElement) {
		if (autofocusOk()) return () => {};
		const stop = typeToFocus(() => node);
		// two frames is after the modal's own focus call and long before any tap
		const a = requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (document.activeElement === node) node.blur();
			})
		);
		return () => {
			cancelAnimationFrame(a);
			stop();
		};
	}
	let focusedInput: HTMLInputElement | null = null;
	let stopSearchFocus: () => void = () => {};
	$: if (searchInput !== focusedInput) {
		stopSearchFocus();
		focusedInput = searchInput;
		stopSearchFocus = searchInput ? searchFocus(searchInput) : () => {};
	}

	// 37-settings: the active section's key + title (the footer's reset, the phone's nav bar)
	$: activeKey = sectionKeyOf($navActive?.label ?? '');
	$: activeLabel = $navActive?.label ?? '';
	$: searching = !!(settingsQuery || '').trim();

	/**
	 * Jump from a search result to where it lives: end the search, show its page (and sub-page),
	 * bring the row into view and flash it. The spec: "search results show the matching row with
	 * its path and jump to it".
	 * @param {string} key the page @param {string | null} [rowLabel] @param {{id: string, label: string} | null} [sub]
	 */
	async function jumpTo(key: string, rowLabel: string | null = null, sub: { id: string; label: string } | null = null) {
		settingsQuery = '';
		await tick();
		await new Promise((r) => setTimeout(r, 0)); // after the search's own restore (a microtask)
		settingsNav.activateKey(key);
		if (sub) baseOpenSub(sub.id, sub.label);
		await tick();
		await tick();
		if (!rowLabel) return;
		const page = document.querySelector(`#settings-sections .ss-page[data-section="${key}"]`);
		const row = [...(page?.querySelectorAll<HTMLElement>('.setting-row, .tp-ui.nr') ?? [])].find(
			(r) => (r.querySelector('.sr-name, .nr-label')?.textContent || '').trim() === rowLabel
		);
		if (!row) return;
		row.scrollIntoView({ block: 'center' });
		row.classList.add('sr-flash');
		setTimeout(() => row.classList.remove('sr-flash'), 1600);
		const control = row.matches('button') ? row : row.querySelector<HTMLElement>('.sr-control button, .sr-control input, .sr-control select, .sr-control [tabindex="0"]');
		control?.focus({ preventScroll: true });
	}
	(settingsNav as any).jumpTo = jumpTo;
	// a page opens its sub-pages through the nav; while searching that is a jump first
	const baseOpenSub = settingsNav.openSub;
	settingsNav.openSub = (id: string, label: string, key?: string) => {
		if (get(settingsNav.searching) && key) void jumpTo(key, null, { id, label });
		else baseOpenSub(id, label);
	};

	/** searching: a click on a row's NAME jumps to it (the controls keep working in place) */
	function onMainClick(e: MouseEvent) {
		if (!searching) return;
		const name = (e.target as HTMLElement)?.closest?.('.sr-name');
		const page = name?.closest<HTMLElement>('.ss-page');
		if (!name || !page) return;
		void jumpTo(page.dataset.section || '', (name.textContent || '').trim());
	}

	/** About › Danger zone: 1.25.0's footer button, now behind a confirmation */
	async function askClearSavedSession() {
		const ok = await showConfirm({
			title: 'Clear the saved session?',
			message: 'The autosaved copy of your work on this device is deleted and no restore is offered next time. Your library, saved sessions and the scene on screen stay.',
			confirmLabel: 'Clear',
			cancelLabel: 'Cancel'
		});
		if (ok) await clearSavedSession();
	}

	function closeSettings() {
		settingsOpen.set(false);
	}

	/** Esc: a sub-page first, then the search (36 I4: it keeps you where you are), then the window */
	function onDialogKey(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (get(navSub)) {
			e.stopPropagation();
			settingsNav.closeSub();
			return;
		}
		if ((settingsQuery || '').trim()) {
			e.stopPropagation();
			settingsQuery = '';
			searchInput?.focus();
			return;
		}
		settingsOpen.set(false);
	}

	/** the phone's nav bar: "‹ Settings" on a page, "‹ <Category>" on a sub-page */
	$: mobileBack = narrowSettings && !searching ? ($navSub ? () => settingsNav.closeSub() : !$navHome ? () => settingsNav.showHome() : null) : null;
	$: mobileTitle = !narrowSettings || searching || $navHome ? 'Settings' : $navSub ? $navSub.label : activeLabel;
	$: mobileBackLabel = $navSub ? activeLabel : 'Settings';
</script>

<Modal
	bind:open={$settingsOpen}
	modal={false}
	dismissable={false}
	onkeydown={onDialogKey}
	outsideclose
	size="none"
	class="tp-modal-frame tp-ui settings-dialog"
	classes={{ body: 'tp-modal-body settings-dialog-body' }}
	aria-label="Settings"
>
	<div class="settings-shell" class:settings-narrow={narrowSettings} class:settings-searching={searching}>
		<WindowChrome
			size="modal"
			body={false}
			title={mobileTitle}
			titleId="settings-title"
			closeLabel="Close"
			onclose={closeSettings}
			onback={mobileBack}
			backLabel={mobileBackLabel}
		>
			{#snippet actions()}
				{#if !narrowSettings}
					<div class="settings-search-head">
						<SearchField
							id="settings-search"
							clearId="settings-search-clear"
							size="sm"
							placeholder="Search settings"
							label="Search settings"
							bind:value={settingsQuery}
							bind:inputEl={searchInput}
						/>
					</div>
				{/if}
			{/snippet}
		</WindowChrome>
		{#if narrowSettings && ($navHome || searching)}
			<div class="settings-msearch">
				<SearchField
					id="settings-search"
					clearId="settings-search-clear"
					placeholder="Search settings"
					label="Search settings"
					bind:value={settingsQuery}
					bind:inputEl={searchInput}
				/>
			</div>
		{/if}
		<div class="settings-split">
			{#if !narrowSettings}
				<aside class="settings-side" use:minimalScroll>
					<SettingsNav nav={settingsNav} />
				</aside>
			{/if}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
			<div id="settings-main" class="settings-main" use:filterSettings={settingsQuery} use:minimalScroll on:click={onMainClick}>
			<!-- ONE nav per layout (each row renders its section's header snippet, ids and tour anchors
			     included): the phone's list stays mounted while a page is shown, so labels resolve -->
			{#if narrowSettings}
				<div class="settings-home" class:settings-pages-hidden={!$navHome || searching}>
					<SettingsNav nav={settingsNav} layout="home" />
				</div>
			{/if}
			<div class="settings-pages" class:settings-pages-hidden={narrowSettings && $navHome && !searching}>
			<!-- 36 B14: a section's open flag is still its MOUNT switch (the filter can only see
			     mounted rows, so a search opens them all). Outside a search the sidebar keeps
			     exactly one open — the one on screen (settingsNav). -->
			<Accordion multiple>
				<AccordionItem bind:open={interfaceExpanded}>
					{#snippet header()}Interface{/snippet}
					<InterfaceSettings />
				</AccordionItem>
				<AccordionItem bind:open={controlsExpanded}>
					{#snippet header()}Controls{/snippet}
					<ControlsSettings />
				</AccordionItem>
				<AccordionItem bind:open={inputExpanded}>
					{#snippet header()}Input{/snippet}
					<InputSettings />
				</AccordionItem>
				<TouchControlsSettings searching={!!settingsQuery.trim()} />
				<AccordionItem bind:open={sceneExpanded}>
					{#snippet header()}Scene{/snippet}
					<SceneSettings />
				</AccordionItem>
				<AccordionItem bind:open={explorerExpanded}>
					{#snippet header()}Explorer{/snippet}
					<ExplorerSettings />
				</AccordionItem>
				<AccordionItem bind:open={vrExpanded}>
					{#snippet header()}VR{/snippet}
					<VRSettingsSection />
				</AccordionItem>
				<AccordionItem bind:open={aiExpanded}>
					{#snippet header()}AI{/snippet}
					<AiSettings />
				</AccordionItem>
				<AccordionItem bind:open={exportExpanded}>
					{#snippet header()}Export{/snippet}
					<Section variant="card" label="Defaults for the next export" badge="This device"><ExportSettingsSection /></Section>
				</AccordionItem>
				<AccordionItem bind:open={nodeTypesExpanded}>
					{#snippet header()}Node types{/snippet}
					<NodeTypesSection />
				</AccordionItem>
				<AccordionItem bind:open={connectionExpanded}>
					{#snippet header()}Connection{/snippet}
					<ConnectionSettings />
				</AccordionItem>
				<AccordionItem bind:open={shortcutsExpanded}>
					{#snippet header()}Shortcuts{/snippet}
					<ShortcutsSettings />
				</AccordionItem>
				<AccordionItem bind:open={aboutExpanded}>
					{#snippet header()}About & what’s new{/snippet}
					{#if $navSub?.id === 'whatsnew'}
						<ChangelogBody />
					{:else}
						<Section variant="card" label="About">
							<KitRow id="about-version" label="Version"><span class="settings-mono">{appVersionString}</span></KitRow>
							{#if $cloudPluginInfo}
								<KitRow id="about-cloud-plugin" label="Cloud plugin"><span class="settings-mono">{$cloudPluginInfo.name} {$cloudPluginInfo.version}</span></KitRow>
							{/if}
							<KitRow label="Diagnostics" description="Copies the version, this session’s peer and scene counts and the last 300 log lines to your clipboard — for a bug report.">
								<KitButton
									id="about-copy-diagnostics"
									size="sm"
									onclick={async () => {
										const ok = await copyDiagnostics();
										showToast(ok ? 'Diagnostics copied to the clipboard' : 'Could not copy the diagnostics');
									}}>Copy</KitButton
								>
							</KitRow>
						</Section>
						<Section variant="card" label="What’s new">
							<NavRow
								id="about-whats-new"
								label="What’s new"
								description="What changed in each release."
								dot={$whatsNewUnseen}
								onclick={() => settingsNav.openSub('whatsnew', 'What’s new', 'aboutwhatsnew')}
							/>
						</Section>
						<Section variant="card" label="Links">
							<NavRow id="about-link-dev" label="Dev builds" href="https://alexz005.github.io/theprototype" external />
							<NavRow id="about-link-source" label="Source code" href="https://github.com/theprototype-app/core" external />
							<NavRow id="about-link-modules" label="Modules" href="https://github.com/theprototype-app/modules" external />
							<NavRow id="about-link-docs" label="Docs" href="https://github.com/theprototype-app/docs" external />
						</Section>
						<Section variant="card" label="Danger zone">
							<KitRow label="Clear saved session" description="Deletes the autosaved copy of your work on this device, so no restore is offered next time.">
								<KitButton id="settings-clear-session" variant="warn-text" size="sm" onclick={askClearSavedSession}>Clear</KitButton>
							</KitRow>
							<KitRow label="Reset all settings" description="Every setting on this device goes back to its default, in every category at once.">
								<KitButton id="settings-reset-all" variant="warn-text" size="sm" onclick={() => askResetAllSettings()}>Reset all</KitButton>
							</KitRow>
						</Section>
					{/if}
				</AccordionItem>
			</Accordion>
			</div>
			</div>
		</div>
		{#if !narrowSettings}
			<footer class="settings-foot">
				{#if !searching && canResetCategory(activeKey) && !$navSub}
					<KitButton variant="warn-text" size="sm" id="settings-reset-category" onclick={() => askResetCategory(activeKey, activeLabel)}>Reset {activeLabel} to defaults</KitButton>
				{/if}
				<span class="settings-foot-note">Changes save automatically</span>
				<KitButton variant="primary" size="sm" id="settings-done" onclick={closeSettings}>Done</KitButton>
			</footer>
		{/if}
	</div>
</Modal>

<style>
	/* a muted note under a card ("Storage" in AI, "Per-game controls" in Input) */
	.settings-main :global(.settings-footnote) {
		margin: -12px 2px 0;
		font-size: var(--fs-desc);
		line-height: 1.45;
		color: var(--text-faint);
	}
	/* the small form controls the redesigned pages share (a number with its unit, a colour swatch,
	   an inline text link) — tokens only, so a custom .theme.json restyles them */
	.settings-main :global(.settings-num) {
		box-sizing: border-box;
		width: 84px;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: var(--surface-inset);
		color: var(--text);
		font-family: var(--font-ui-mono);
		font-size: var(--fs-input);
	}
	.settings-main :global(.settings-text) {
		box-sizing: border-box;
		width: 220px;
		max-width: 100%;
		height: var(--control-h-sm);
		padding: 0 10px;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.settings-main :global(.settings-num:disabled),
	.settings-main :global(.settings-color:disabled) {
		opacity: 0.45;
	}
	.settings-main :global(.settings-unit) {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.settings-main :global(.settings-color) {
		width: 40px;
		height: 28px;
		padding: 2px;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: var(--surface-inset);
		cursor: pointer;
	}
	.settings-main :global(.settings-link) {
		padding: 0;
		border: 0;
		background: transparent;
		font: inherit;
		color: var(--accent-text);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	@media (max-width: 639.98px) {
		.settings-main :global(.settings-num),
		.settings-main :global(.settings-text) {
			height: 44px;
			font-size: 16px;
		}
	}
	.settings-mono {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-desc);
		color: var(--text-2);
	}
	/* 37-settings: the window. Its own width (the content column is ~660 px beside a 220 px menu),
	   one definite height so the menu stays while the content column scrolls. */
	:global(dialog.settings-dialog) {
		width: min(960px, 94vw) !important;
		max-width: min(960px, 94vw) !important;
		padding: 0 !important;
		background: var(--surface-1) !important;
		border: 1px solid var(--border) !important;
		border-radius: var(--radius-modal) !important;
		box-shadow: var(--shadow-window);
		color: var(--text);
		font-family: var(--font-ui);
		overflow: hidden;
	}
	:global(.settings-dialog-body) {
		padding: 0 !important;
		overflow: hidden !important;
	}
	.settings-shell {
		display: flex;
		flex-direction: column;
		height: min(80vh, 760px);
		min-height: 0;
	}
	/* the header is the dialog's own: no second frame around it */
	.settings-shell > :global(.wc) {
		flex-shrink: 0;
		background: transparent;
		border: 0;
		border-radius: 0;
	}
	.settings-search-head {
		width: 260px;
		margin-right: 4px;
	}
	.settings-split {
		display: flex;
		flex: 1 1 auto;
		min-height: 0;
	}
	.settings-side {
		flex: 0 0 220px;
		min-height: 0;
		overflow-y: auto;
		border-right: 1px solid var(--border);
		background: color-mix(in srgb, var(--surface-1) 70%, var(--bg-app));
	}
	.settings-main {
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: 24px 28px 28px;
	}
	.settings-pages-hidden {
		display: none;
	}
	/* searching: every matching page, one after the other */
	.settings-searching :global(.ss-page + .ss-page) {
		margin-top: 28px;
	}
	/* searching: the card labels carry their page ("INTERFACE › SOUND") */
	.settings-searching :global(.ss-page [data-section-label]::before) {
		content: var(--ss-path);
	}
	/* searching: a row's name is the way to its place */
	.settings-searching :global(.setting-row .sr-name) {
		cursor: pointer;
	}
	.settings-searching :global(.setting-row .sr-name:hover) {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	/* a search result we jumped to */
	:global(.setting-row.sr-flash),
	:global(.tp-ui.nr.sr-flash) {
		animation: settings-flash 1.6s ease-out;
	}
	@keyframes -global-settings-flash {
		0%,
		35% {
			background: var(--accent-soft);
		}
		100% {
			background: transparent;
		}
	}
	/* dividers between rows at ANY depth inside a card (legacy sections wrap their rows in a
	   `display: contents` div, which the card's own child rule cannot see) */
	.settings-main :global(.sec-card .setting-row + .setting-row),
	.settings-main :global(.sec-card .contents + .setting-row),
	.settings-main :global(.sec-card .setting-row + .contents > .setting-row:first-child),
	.settings-main :global(.sec-card .tp-ui.nr + .setting-row),
	.settings-main :global(.sec-card .setting-row + .tp-ui.nr) {
		border-top: 1px solid var(--border);
	}
	.settings-foot {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-shrink: 0;
		padding: 10px 16px 10px 20px;
		border-top: 1px solid var(--border);
	}
	.settings-foot-note {
		margin-left: auto;
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.settings-msearch {
		flex-shrink: 0;
		padding: 10px 16px 6px;
	}
	@media (max-width: 639.98px) {
		.settings-shell {
			height: calc(100dvh - var(--connect-bottom, 0px));
		}
		:global(dialog.settings-dialog) {
			width: 100vw !important;
			max-width: 100vw !important;
			border-radius: 0 !important;
			border-left: 0 !important;
			border-right: 0 !important;
		}
		.settings-main {
			padding: 12px 16px 24px;
		}
		/* the title clears the logo button top-left on the list screen */
		.settings-shell > :global(.wc .wc-head:not(.wc-nav)) {
			padding-left: 62px;
		}
	}
</style>
