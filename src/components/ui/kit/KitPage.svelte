<script>
	// 38 R3 — the UI KIT page behind /kit (public since NOTES-38 #17: the module-author reference; see routes/kit).
	// Every redesign primitive in every state, under Dark, Light, a CUSTOM theme written with
	// legacy keys only (kitData.js — it proves the token derivation), and the exotic built-ins.
	// `?theme=light` (dark | light | custom | green | bit8 | contrast) deep-links a theme for
	// screenshots. Theme switching here is LOCAL to the kit: it never writes the app's saved
	// theme. Forced hover / focus states ride `data-kit-state`, which the primitives style
	// exactly like the real pseudo-class.
	import { onMount, tick } from 'svelte';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { THEME_TOKENS } from '$lib/themes.js';
	import { DENSITIES, DEFAULT_DENSITY, applyDensity } from '$lib/ui/density.js';
	import { SAMPLE_CUSTOM_THEME, SKY_GROUND } from './kitData.js';
	import WindowChrome from '../WindowChrome.svelte';
	import Tabs from '../Tabs.svelte';
	import Segmented from '../Segmented.svelte';
	import Chips from '../Chips.svelte';
	import Toggle from '../Toggle.svelte';
	import Checkbox from '../Checkbox.svelte';
	import Button from '../Button.svelte';
	import Badge from '../Badge.svelte';
	import SettingRow from '../SettingRow.svelte';
	import Slider from '../Slider.svelte';
	import PropRow from '../PropRow.svelte';
	import DragRow from '../DragRow.svelte';
	import NavRow from '../NavRow.svelte';
	import Section from '../Section.svelte';
	import EmptyState from '../EmptyState.svelte';
	import Sheet from '../Sheet.svelte';
	import Menu from '../Menu.svelte';
	import Toast from '../Toast.svelte';
	import SearchField from '../SearchField.svelte';

	const THEME_CHOICES = [
		{ value: 'dark', label: 'Dark' },
		{ value: 'light', label: 'Light' },
		{ value: 'custom', label: 'Custom .theme.json' },
		{ value: 'green', label: 'Green console' },
		{ value: 'bit8', label: '8-bit' },
		{ value: 'contrast', label: 'High contrast' }
	];
	let kitTheme = $state('dark');
	// NOTES-38 #19: `?density=compact` previews the Compact switch (local to the kit, like the theme)
	let kitDensity = $state(DEFAULT_DENSITY);

	/** @param {string} d */
	function applyKitDensity(d) {
		applyDensity(d);
		const url = new URL(location.href);
		if (d === DEFAULT_DENSITY) url.searchParams.delete('density');
		else url.searchParams.set('density', d);
		history.replaceState(history.state, '', url);
	}

	/** @param {string} id */
	function applyKitTheme(id) {
		const root = document.documentElement;
		THEME_TOKENS.forEach((t) => root.style.removeProperty(t));
		if (id === 'custom') {
			root.dataset.theme = 'custom-kit';
			root.classList.add('dark');
			for (const [k, v] of Object.entries(SAMPLE_CUSTOM_THEME.tokens)) root.style.setProperty(k, v);
		} else {
			root.dataset.theme = id;
			root.classList.toggle('dark', id !== 'light');
		}
		const url = new URL(location.href);
		url.searchParams.set('theme', id);
		history.replaceState(history.state, '', url);
		measure();
	}

	// ---- live token readout + contrast (SPEC §8: text >= 4.5:1 in every theme) ----
	const SWATCHES = [
		'--bg-app',
		'--surface-1',
		'--surface-2',
		'--surface-inset',
		'--border',
		'--border-strong',
		'--text',
		'--text-2',
		'--text-muted',
		'--text-faint',
		'--accent',
		'--accent-fill',
		'--accent-soft',
		'--accent-muted',
		'--segment-on',
		'--accent-text',
		'--live',
		'--speaking',
		'--warn-text',
		'--danger',
		'--badge-bg',
		'--badge-text',
		'--control-off'
	];
	/** [foreground, background, what it is] */
	const PAIRS = [
		['--text', '--surface-2', 'Label on a card'],
		['--text-2', '--surface-2', 'Property label'],
		['--text-muted', '--surface-2', 'Description'],
		['--text-muted', '--surface-1', 'Description on a window'],
		['--text-faint', '--surface-1', 'Section header'],
		['--text-faint', '--surface-2', 'Count / hint on a card'],
		['--accent-text', '--surface-1', 'Link / ghost button'],
		['--warn-text', '--surface-1', 'Reset…'],
		['--on-accent', '--accent-fill', 'Primary button'],
		['--on-danger', '--danger', 'Danger button'],
		['--badge-text', '--badge-bg', 'Scope badge'],
		['--accent-soft-text', '--accent-soft', 'Selected chip / nav'],
		['--text', '--segment-on', 'Selected segment']
	];
	/** @type {Record<string, string>} */
	let values = $state({});
	/** @type {{fg: string, bg: string, what: string, ratio: number}[]} */
	let contrast = $state([]);
	/** @type {HTMLElement | null} */
	let probeHost = $state(null);

	/** "rgb(1, 2, 3)" / "rgba(…)" / "color(srgb 0.1 0.2 0.3)" → [r,g,b] 0-255 @param {string} c */
	function parseColor(c) {
		let m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(c);
		if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
		m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(c);
		if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
		return null;
	}
	/** @param {number[]} rgb */
	function luminance(rgb) {
		const f = (/** @type {number} */ v) => {
			const c = v / 255;
			return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
		};
		return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
	}

	async function measure() {
		await tick();
		requestAnimationFrame(() => {
			if (!probeHost) return;
			const cs = getComputedStyle(probeHost);
			/** @type {Record<string, string>} */
			const v = {};
			for (const t of SWATCHES) v[t] = cs.getPropertyValue(t).trim();
			values = v;
			const probe = document.createElement('span');
			probeHost.appendChild(probe);
			contrast = PAIRS.map(([fg, bg, what]) => {
				probe.style.color = `var(${fg})`;
				probe.style.backgroundColor = `var(${bg})`;
				const pcs = getComputedStyle(probe);
				const a = parseColor(pcs.color);
				const b = parseColor(pcs.backgroundColor);
				const ratio = a && b ? (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05) : 0;
				return { fg, bg, what, ratio: Math.round(ratio * 100) / 100 };
			});
			probe.remove();
		});
	}

	onMount(() => {
		const wanted = new URL(location.href).searchParams.get('theme') ?? 'dark';
		kitTheme = THEME_CHOICES.some((t) => t.value === wanted) ? wanted : 'dark';
		applyKitTheme(kitTheme);
		kitDensity = new URL(location.href).searchParams.get('density') === 'compact' ? 'compact' : DEFAULT_DENSITY;
		applyKitDensity(kitDensity);
	});

	// ---- interactive demo state ----
	let tab = $state('core');
	let tabFilter = $state('');
	let touchMode = $state('auto');
	let view = $state('grid');
	let themeSeg = $state('dark');
	let envPreset = $state(/** @type {string|null} */ ('studio'));
	let filters = $state(['meshes', 'lights']);
	let tOff = $state(false);
	let tOn = $state(true);
	let tTouch = $state(true);
	let picked = $state(true);
	let picked2 = $state(false);
	let announce = $state(true);
	let sfx = $state(80);
	let exposure = $state(1);
	let softness = $state(0.35);
	let pos = $state({ x: 0, y: 0.5, z: 0 });
	let scrubs = $state({ start: 0, end: 0 });
	let lastMenu = $state('');
	let search = $state('');
	let sheetOpen = $state(false);
	let sheetDetent = $state('half');
	let sheetModal = $state(false);
	let lastAction = $state('');

	/** @param {string} d @param {boolean} [modal] */
	function openSheet(d, modal = false) {
		sheetDetent = d;
		sheetModal = modal;
		sheetOpen = true;
	}
	/** @param {string} what */
	const did = (what) => () => (lastAction = what);
</script>

{#snippet st(/** @type {string} */ label, /** @type {import('svelte').Snippet} */ body)}
	<div class="kit-st">
		{@render body()}
		<small>{label}</small>
	</div>
{/snippet}

<div class="tp-ui kit" bind:this={probeHost} use:minimalScroll>
	<header class="kit-top">
		<div class="kit-brand">
			<h1>UI kit</h1>
			<span>roadmap 38 · SPEC §2 primitives · <code>src/components/ui</code></span>
		</div>
		<Chips
			label="Theme"
			size="sm"
			options={THEME_CHOICES}
			bind:value={kitTheme}
			onchange={(v) => applyKitTheme(/** @type {string} */ (v))}
			data-testid="kit-theme"
		/>
		<Segmented
			label="Density"
			options={DENSITIES}
			bind:value={kitDensity}
			onchange={(v) => applyKitDensity(/** @type {string} */ (v))}
			data-testid="kit-density"
		/>
	</header>

	<main class="kit-main">
		<!-- ================= module authors (NOTES-38 #17) ================= -->
		<section class="kit-card kit-wide" id="kit-authors">
			<header><b>Building a module UI?</b><span>use these parts, not your own</span></header>
			<div class="kit-authors">
				<p>
					<b>Core modules</b> import the primitives directly:
					<code>import Toggle from '../../components/ui/Toggle.svelte'</code> from <code>src/modules/&lt;name&gt;/</code> (WindowChrome, Tabs, Segmented, Chips, Toggle,
					Button, Badge, SettingRow, PropRow, NavRow, Section, EmptyState, Sheet, Menu, Toast, SearchField). Icons go
					through <code>ui/Icon.svelte</code>.
				</p>
				<p>
					<b>User modules</b> are self-contained: put <code>class="tp-ui"</code> on your panel's root and paint only with
					the tokens in the table below (<code>var(--surface-2)</code>, <code>var(--text-muted)</code>,
					<code>var(--accent)</code> …). Every theme, including a user's custom <code>.theme.json</code>, then restyles
					your UI with the app, and the Compact density applies to it too.
				</p>
				<p>
					Rules: one primary button per view; <code>--live</code> only for Play, record and streaming; toggles for on/off,
					checkboxes only to pick items in a list. Full guide:
					<a href="https://docs.theprototype.app/ui-kit/" target="_blank" rel="noopener">UI kit for module authors</a>.
				</p>
			</div>
		</section>

		<!-- ================= tokens ================= -->
		<section class="kit-card kit-wide" id="kit-tokens">
			<header><b>Tokens</b><span>SPEC §1 · resolved in this theme</span></header>
			<div class="kit-swatches">
				{#each SWATCHES as t (t)}
					<div class="kit-sw">
						<i style="background: var({t})"></i>
						<span><b>{t}</b><em>{values[t] ?? ''}</em></span>
					</div>
				{/each}
			</div>
			<table class="kit-contrast" id="kit-contrast">
				<thead><tr><th>Text</th><th>On</th><th>Used for</th><th>Ratio</th></tr></thead>
				<tbody>
					{#each contrast as c (c.fg + c.bg)}
						<tr data-ratio={c.ratio}>
							<td><code>{c.fg}</code></td>
							<td><code>{c.bg}</code></td>
							<td><span class="kit-sample" style="color: var({c.fg}); background: var({c.bg})">{c.what}</span></td>
							<td><Badge tone={c.ratio >= 4.5 ? 'ok' : 'bad'} text={c.ratio.toFixed(2) + ':1'} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<!-- ================= WindowChrome ================= -->
		<section class="kit-card kit-wide" id="kit-windowchrome">
			<header><b>WindowChrome</b><span>size = modal · panel · tool · mobile nav bar</span></header>
			<div class="kit-cols3">
				<WindowChrome size="modal" title="Modules" onclose={did('close modules')}>
					{#snippet actions()}<Button variant="outline" size="sm">Install from file…</Button>{/snippet}
					<p class="kit-note">Modal · 56px · 18px title · one action + close</p>
				</WindowChrome>
				<WindowChrome size="panel" title="Scene" icon="sun" onpin={did('pin')} onclose={did('close scene')}>
					<p class="kit-note">Panel · 48px · icon, title, pin, close</p>
				</WindowChrome>
				<WindowChrome size="tool" title="Objects" count={12} onclose={did('close objects')}>
					<p class="kit-note">Tool · 40px · count</p>
				</WindowChrome>
				<WindowChrome size="panel" title="Inspector" icon="sliders-horizontal" pinned onpin={did('unpin')} onpopout={did('pop out')} onclose={did('close')}>
					<p class="kit-note">Panel, pinned, with pop-out</p>
				</WindowChrome>
				<WindowChrome size="modal" title="Interface" onback={did('back')} backLabel="Settings" onclose={did('close')}>
					<p class="kit-note">Mobile nav bar: ‹ Back · Title · Close</p>
				</WindowChrome>
				<div class="kit-span2">
					<WindowChrome size="modal" title="Settings" onclose={did('close')}>
						<p class="kit-note">With the Settings footer</p>
						{#snippet footer()}
							<Button variant="warn-text" size="sm">Reset Interface to defaults</Button>
							<span class="kit-foot-note">Changes save automatically</span>
							<Button variant="primary">Done</Button>
						{/snippet}
					</WindowChrome>
				</div>
			</div>
		</section>

		<!-- ================= Tabs ================= -->
		<section class="kit-card kit-wide" id="kit-tabs">
			<header><b>Tabs</b><span>underline · optional count · arrows move + select</span></header>
			<Tabs
				label="Modules"
				idPrefix="kit-mod"
				bind:value={tab}
				tabs={[
					{ id: 'core', label: 'Core', count: 8 },
					{ id: 'user', label: 'User', count: 0 },
					{ id: 'browse', label: 'Browse' },
					{ id: 'later', label: 'Disabled', disabled: true }
				]}
			>
				{#snippet actions()}<SearchField size="sm" placeholder="Filter modules" bind:value={tabFilter} />{/snippet}
				{#snippet panel(active)}<p class="kit-note" data-testid="kit-tab-panel">Showing <b>{active}</b></p>{/snippet}
			</Tabs>
			<div class="kit-row">
				{#snippet hoverTabs()}
					<Tabs idPrefix="kit-tabs-h" value="a" tabs={[{ id: 'a', label: 'Info' }, { id: 'b', label: 'Toasts', count: 3, kitState: 'hover' }]} />
				{/snippet}
				{#snippet focusTabs()}
					<Tabs idPrefix="kit-tabs-f" value="a" tabs={[{ id: 'a', label: 'Grid', kitState: 'focus' }, { id: 'b', label: 'List' }]} />
				{/snippet}
				{@render st('Hover (Toasts)', hoverTabs)}
				{@render st('Focus (Grid)', focusTabs)}
			</div>
		</section>

		<!-- ================= Segmented ================= -->
		<section class="kit-card" id="kit-segmented">
			<header><b>Segmented</b><span>2 to 4 exclusive options</span></header>
			<div class="kit-row">
				{#snippet segText()}
					<Segmented label="Show touch controls" bind:value={touchMode} options={[{ value: 'auto', label: 'Auto' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' }]} data-testid="kit-seg-text" />
				{/snippet}
				{#snippet segIcons()}
					<Segmented label="View" bind:value={view} options={[{ value: 'grid', label: 'Grid', icon: 'layout-grid' }, { value: 'list', label: 'List', icon: 'list' }]} />
				{/snippet}
				{@render st('Text', segText)}
				{@render st('Icons', segIcons)}
			</div>
			{#snippet segFull()}
				<Segmented full label="Theme" bind:value={themeSeg} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'custom', label: 'Custom' }]} />
			{/snippet}
			{@render st('Full width (mobile / wide row)', segFull)}
			<div class="kit-row">
				{#snippet segStates()}
					<Segmented label="States" value="a" options={[{ value: 'a', label: 'On' }, { value: 'b', label: 'Hover', kitState: 'hover' }, { value: 'c', label: 'Off' }, { value: 'd', label: 'Disabled', disabled: true }]} />
				{/snippet}
				{#snippet segDisabled()}
					<Segmented label="Disabled group" disabled value="a" options={[{ value: 'a', label: 'Auto' }, { value: 'b', label: 'Never' }]} />
				{/snippet}
				{@render st('Selected · hover · disabled option', segStates)}
				{@render st('Disabled group', segDisabled)}
			</div>
		</section>

		<!-- ================= Chips ================= -->
		<section class="kit-card" id="kit-chips">
			<header><b>Chips</b><span>5+ options, presets, filters</span></header>
			{#snippet chipSingle()}
				<Chips
					label="Environment preset"
					bind:value={envPreset}
					options={[
						{ value: 'studio', label: 'Studio' },
						{ value: 'daylight', label: 'Daylight' },
						{ value: 'sunset', label: 'Sunset' },
						{ value: 'night', label: 'Night' },
						{ value: 'classic', label: 'Classic' }
					]}
					data-testid="kit-chips-single"
				/>
			{/snippet}
			{#snippet chipMulti()}
				<Chips
					multiple
					label="Object filters"
					bind:values={filters}
					options={[
						{ value: 'meshes', label: 'Meshes', count: 9 },
						{ value: 'lights', label: 'Lights', count: 3 },
						{ value: 'groups', label: 'Groups', count: 2 },
						{ value: 'strokes', label: 'Strokes', count: 0 }
					]}
				/>
			{/snippet}
			{#snippet chipStates()}
				<Chips
					label="Chip states"
					value="a"
					options={[
						{ value: 'a', label: 'Selected' },
						{ value: 'b', label: 'Hover', kitState: 'hover' },
						{ value: 'c', label: 'Focus', kitState: 'focus' },
						{ value: 'd', label: 'Disabled', disabled: true }
					]}
				/>
			{/snippet}
			{#snippet chipSmall()}
				<Chips size="sm" label="Small" value="x" options={[{ value: 'x', label: 'Hat' }, { value: 'y', label: 'Cap' }, { value: 'z', label: 'None' }]} />
			{/snippet}
			{@render st('Single choice', chipSingle)}
			{@render st('Filter, multi-select, counts', chipMulti)}
			{@render st('Selected · hover · focus · disabled', chipStates)}
			{@render st('Small', chipSmall)}
		</section>

		<!-- ================= Toggle ================= -->
		<section class="kit-card" id="kit-toggle">
			<header><b>Toggle</b><span>40 × 24 desktop · 51 × 31 touch</span></header>
			<div class="kit-row">
				{#snippet t1()}<Toggle label="Example off" bind:checked={tOff} data-testid="kit-toggle-off" />{/snippet}
				{#snippet t2()}<Toggle label="Example on" bind:checked={tOn} />{/snippet}
				{#snippet t3()}<Toggle label="Hover" checked data-kit-state="hover" />{/snippet}
				{#snippet t4()}<Toggle label="Focus" data-kit-state="focus" />{/snippet}
				{#snippet t5()}<Toggle label="Disabled off" disabled />{/snippet}
				{#snippet t6()}<Toggle label="Disabled on" disabled checked />{/snippet}
				{#snippet t7()}<span class="kit-touch"><Toggle label="Touch example" bind:checked={tTouch} /></span>{/snippet}
				{@render st('Off', t1)}
				{@render st('On', t2)}
				{@render st('Hover', t3)}
				{@render st('Focus', t4)}
				{@render st('Disabled', t5)}
				{@render st('Disabled on', t6)}
				{@render st('Touch 51×31', t7)}
			</div>
			<div class="kit-row">
				{#snippet c1()}<Checkbox label="Picked" bind:checked={picked} />{/snippet}
				{#snippet c2()}<Checkbox label="Not picked" bind:checked={picked2} />{/snippet}
				{#snippet c3()}<Checkbox label="Some picked" indeterminate />{/snippet}
				{#snippet c4()}<Checkbox label="Disabled" disabled />{/snippet}
				{@render st('Checkbox: list pick only', c1)}
				{@render st('Unpicked', c2)}
				{@render st('Some', c3)}
				{@render st('Disabled', c4)}
			</div>
		</section>

		<!-- ================= Button ================= -->
		<section class="kit-card kit-wide" id="kit-button">
			<header><b>Button</b><span>one primary per view · live only for Play</span></header>
			<div class="kit-row">
				{#snippet b1()}<Button variant="primary" onclick={did('primary')}>Done</Button>{/snippet}
				{#snippet b2()}<Button variant="primary" data-kit-state="hover">Done</Button>{/snippet}
				{#snippet b3()}<Button variant="primary" data-kit-state="focus">Done</Button>{/snippet}
				{#snippet b4()}<Button variant="primary" disabled>Done</Button>{/snippet}
				{#snippet b5()}<Button variant="primary" size="sm" icon="save">Save checkpoint…</Button>{/snippet}
				{@render st('Primary', b1)}
				{@render st('Hover', b2)}
				{@render st('Focus', b3)}
				{@render st('Disabled', b4)}
				{@render st('Small + icon', b5)}
			</div>
			<div class="kit-row">
				{#snippet b6()}<Button variant="secondary">Add to scene</Button>{/snippet}
				{#snippet b7()}<Button variant="outline">Load file…</Button>{/snippet}
				{#snippet b8()}<Button variant="outline" data-kit-state="hover">Load file…</Button>{/snippet}
				{#snippet b9()}<Button variant="ghost">Open it now</Button>{/snippet}
				{#snippet b10()}<Button variant="warn-text">Reset…</Button>{/snippet}
				{#snippet b11()}<Button variant="danger">Clear</Button>{/snippet}
				{#snippet b12()}<Button variant="outline" iconRight="chevron-down">+ Light</Button>{/snippet}
				{@render st('Secondary', b6)}
				{@render st('Outline', b7)}
				{@render st('Outline hover', b8)}
				{@render st('Ghost', b9)}
				{@render st('Warn text', b10)}
				{@render st('Danger', b11)}
				{@render st('Menu trigger', b12)}
			</div>
			<div class="kit-row">
				{#snippet i1()}<Button variant="icon" icon="pin" label="Pin" />{/snippet}
				{#snippet i2()}<Button variant="icon" icon="pin" label="Pin" data-kit-state="hover" />{/snippet}
				{#snippet i3()}<Button variant="icon" icon="magnet" label="Snapping" pressed />{/snippet}
				{#snippet i4()}<Button variant="icon" icon="bell" label="Notifications, 6 new" count={6} />{/snippet}
				{#snippet i5()}<Button variant="icon" icon="bell" label="Notifications, new" dot />{/snippet}
				{#snippet i6()}<Button variant="icon" icon="trash-2" label="Delete" disabled />{/snippet}
				{#snippet i7()}<Button variant="live" icon="play" label="Play" onclick={did('play')} />{/snippet}
				{@render st('Icon', i1)}
				{@render st('Icon hover', i2)}
				{@render st('Icon on', i3)}
				{@render st('Count', i4)}
				{@render st('Dot', i5)}
				{@render st('Disabled', i6)}
				{@render st('Live (Play only)', i7)}
			</div>
		</section>

		<!-- ================= Badge ================= -->
		<section class="kit-card" id="kit-badge">
			<header><b>Badge</b><span>scope, status, count</span></header>
			<div class="kit-row">
				<Badge text="This device" />
				<Badge text="Shared" />
				<Badge tone="warn" text="Reconnecting" />
				<Badge tone="ok" text="Connected" />
				<Badge tone="off" text="Offline" />
				<Badge tone="bad" text="Unreachable" />
				<Badge tone="live" text="Recording" />
				<Badge tone="count" text="12" />
				<Badge tone="neutral" text="Beta" />
				<Badge dot text="New" />
			</div>
		</section>

		<!-- ================= SearchField ================= -->
		<section class="kit-card" id="kit-search">
			<header><b>SearchField</b><span>one search / filter field everywhere</span></header>
			{#snippet s1()}<SearchField placeholder="Search all settings" hint="/" bind:value={search} />{/snippet}
			{#snippet s2()}<SearchField placeholder="Filter properties" value="grid" />{/snippet}
			{#snippet s3()}<SearchField size="sm" placeholder="Filter modules" />{/snippet}
			{@render st('Empty, with key hint', s1)}
			{@render st('With text (clear)', s2)}
			{@render st('Small', s3)}
		</section>

		<!-- ================= SettingRow ================= -->
		<section class="kit-card kit-wide" id="kit-settingrow">
			<header><b>SettingRow</b><span>label + one sentence left, control right</span></header>
			<Section variant="card" label="Interface">
				<SettingRow id="kit-sr-announce" label="Announce new versions" description="After an update, show one toast and a dot on the logo menu.">
					<Toggle label="Announce new versions" describedby="kit-sr-announce-desc" bind:checked={announce} />
				</SettingRow>
				<SettingRow label="Theme" badge="This device" description="The 3D viewport follows the scene environment, not the theme." wide>
					<Segmented label="Theme" bind:value={themeSeg} options={[{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }, { value: 'custom', label: 'Custom' }]} />
				</SettingRow>
				<SettingRow label="Game sounds" labelFor="kit-sfx" description="Coins, goals, hits and clicks." wide>
					<Slider id="kit-sfx" label="Game sounds" min={0} max={100} step={1} value={sfx} format={(v) => v + '%'} onchange={(v) => (sfx = v)} />
				</SettingRow>
				<SettingRow label="Custom theme" wide>
					{#snippet desc()}Export the current theme as <code>.theme.json</code>, edit the colours, then load it back.{/snippet}
					<Button variant="outline" size="sm">Export</Button>
					<Button variant="outline" size="sm">Load file…</Button>
				</SettingRow>
				<SettingRow label="Welcome card on start">
					{#snippet desc()}Normally shown only on your first visit. <a href="#kit-settingrow">Open it now</a>{/snippet}
					<Toggle label="Welcome card on start" />
				</SettingRow>
				<SettingRow label="Mirror turn" description="Unavailable while colocated." disabled>
					<Toggle label="Mirror turn" disabled />
				</SettingRow>
				<SettingRow label="Signaling server" description="Where peers find each other. Stack: a field wider than 260px always drops under the label." stack>
					<input class="kit-text" type="text" value="peerjs.theprototype.app" aria-label="Signaling server host" />
				</SettingRow>
				<SettingRow label="AI providers" description="No control: the content is the list below.">
					{#snippet extra()}
						<div class="kit-inset-list">
							<NavRow label="Anthropic" value="Default" />
							<NavRow label="Add provider" icon="plus" />
						</div>
					{/snippet}
				</SettingRow>
			</Section>
		</section>

		<!-- ================= PropRow ================= -->
		<section class="kit-card" id="kit-proprow">
			<header><b>PropRow</b><span>wraps DragRow; same props and events</span></header>
			<div class="kit-props">
				<PropRow
					id="kit-exposure"
					label="Exposure"
					slider
					min={0}
					max={3}
					step={0.01}
					value={exposure}
					onchange={(v) => (exposure = v)}
					onscrubstart={() => scrubs.start++}
					onscrubend={() => scrubs.end++}
				/>
				<PropRow label="Position" valueBox={false}>
					{#snippet control()}
						<div class="kit-xyz">
							<DragRow label="X" accent="kit-ax-x" unit="length" value={pos.x} ariaLabel="Position X" onchange={(v) => (pos.x = v)} />
							<DragRow label="Y" accent="kit-ax-y" unit="length" value={pos.y} ariaLabel="Position Y" onchange={(v) => (pos.y = v)} />
							<DragRow label="Z" accent="kit-ax-z" unit="length" value={pos.z} ariaLabel="Position Z" onchange={(v) => (pos.z = v)} />
						</div>
					{/snippet}
				</PropRow>
				<PropRow label="Sky / ground" valueBox={false}>
					{#snippet control()}
						{#each SKY_GROUND as c, i (i)}
							<button type="button" class="kit-swatch" style:background={c} aria-label={i ? 'Ground colour' : 'Sky colour'}></button>
						{/each}
					{/snippet}
				</PropRow>
				<PropRow label="Shadow softness at a distance" value={softness} min={0} max={1} slider onchange={(v) => (softness = v)} />
				<PropRow label="Roughness" value={0.5} mixed slider min={0} max={1} />
				<PropRow label="Loop-cut position" value={0.5} disabled title="Applies to one cut only" />
			</div>
			<p class="kit-note" data-testid="kit-prop-readout">
				Exposure <b>{exposure.toFixed(2)}</b> · scrubs started {scrubs.start}, ended {scrubs.end} · position {pos.x.toFixed(2)},
				{pos.y.toFixed(2)}, {pos.z.toFixed(2)}
			</p>
			<p class="kit-note">Drag a value sideways (Shift = fine, Ctrl = snap), click to type, ↑↓ step, Esc restores. Long labels wrap; mixed shows a dash; disabled cannot scrub.</p>
		</section>

		<!-- ================= NavRow ================= -->
		<section class="kit-card" id="kit-navrow">
			<header><b>NavRow</b><span>label, value, chevron</span></header>
			<Section variant="card" label="Rows">
				<NavRow label="Signaling server" value="Public PeerJS cloud" onclick={did('nav')} />
				<NavRow label="Your character" description="Head, hat, outfit and ping" icon="users" />
				<NavRow label="About & what's new" dot />
				<NavRow label="Jump" value="Default" data-kit-state="hover" />
				<NavRow label="Interface" current />
				<NavRow label="Documentation" href="https://docs.theprototype.app" external />
				<NavRow label="Unavailable" value="Off" disabled />
			</Section>
		</section>

		<!-- ================= Section ================= -->
		<section class="kit-card" id="kit-section">
			<header><b>Section</b><span>settings card · collapsible panel</span></header>
			<Section variant="card" label="Sound" badge="This device">
				<SettingRow label="Music" wide>
					<Slider label="Music" min={0} max={100} step={1} value={60} format={(v) => v + '%'} />
				</SettingRow>
			</Section>
			<div class="kit-panel-demo">
				<Section variant="panel" label="Kit environment" badge="Shared">
					<PropRow label="Sun" value={1.8} min={0} max={4} slider />
					<p class="kit-note">Collapsible header for the Inspector and panels (state persists per label).</p>
				</Section>
				<Section variant="panel" label="Kit fog" open={false}>
					<p class="kit-note">Closed by default.</p>
				</Section>
			</div>
		</section>

		<!-- ================= EmptyState ================= -->
		<section class="kit-card" id="kit-empty">
			<header><b>EmptyState</b><span>what goes here + one action</span></header>
			<div class="kit-boxed">
				<EmptyState icon="history" title="No checkpoints yet" description="Save one now or let autosave add one every few minutes." actionLabel="Save checkpoint…" onaction={did('save')} />
			</div>
			<div class="kit-boxed">
				<EmptyState compact title="No objects match “lamp”" />
			</div>
		</section>

		<!-- ================= Sheet ================= -->
		<section class="kit-card" id="kit-sheet">
			<header><b>Sheet</b><span>mobile · peek / half / full · drag to dismiss</span></header>
			<div class="kit-row">
				<Button variant="secondary" onclick={() => openSheet('peek')} data-testid="kit-sheet-peek">Open at peek</Button>
				<Button variant="secondary" onclick={() => openSheet('half')} data-testid="kit-sheet-half">Open at half</Button>
				<Button variant="secondary" onclick={() => openSheet('full')}>Open at full</Button>
				<Button variant="outline" onclick={() => openSheet('half', true)}>Modal (scrim)</Button>
			</div>
			<p class="kit-note" data-testid="kit-sheet-state">Sheet: {sheetOpen ? 'open at ' + sheetDetent : 'closed'}</p>
			<p class="kit-note">Drag the handle; a flick moves one detent; below peek it closes. Handle: ↑↓ step, Enter cycles; Esc closes.</p>
		</section>

		<!-- ================= Menu ================= -->
		<section class="kit-card" id="kit-menu">
			<header><b>Menu</b><span>context, Add and viewport menus share it</span></header>
			<Menu
				label="Kit menu"
				highlight={1}
				onselect={(it) => (lastMenu = it.label ?? '')}
				items={[
					{ label: 'Add', icon: 'plus', submenu: true },
					{ label: 'Undo', icon: 'undo-2', shortcut: 'Ctrl+Z' },
					{ label: 'Redo', icon: 'redo-2', shortcut: 'Ctrl+Y', disabled: true },
					{ separator: true },
					{ section: 'Tools & view' },
					{ label: 'Snapping', icon: 'magnet', value: 'Off', submenu: true },
					{ label: "What's new", icon: 'sparkles', dot: true },
					{ separator: true },
					{ label: 'Clear scene…', icon: 'trash-2', warn: true }
				]}
			/>
			<p class="kit-note">Chosen: {lastMenu || '—'}</p>
		</section>

		<!-- ================= Toast ================= -->
		<section class="kit-card" id="kit-toast">
			<header><b>Toast</b><span>max 3, then "+N more"</span></header>
			<div class="kit-stack">
				<Toast message="Cannot reach the peer server. Retrying…" tone="warn" repeat={11} ondismiss={did('dismiss')} />
				<Toast message="Checkpoint saved" tone="ok" icon="check" actionLabel="Undo" onaction={did('undo')} ondismiss={did('dismiss')} />
				<Toast message="Alex joined" icon="users" />
				<Toast more={2} onmore={did('more')} />
			</div>
		</section>
	</main>
	<p class="kit-foot">Last action: {lastAction || '—'}</p>
</div>

<Sheet bind:open={sheetOpen} bind:detent={sheetDetent} modal={sheetModal} title="Objects" data-testid="kit-sheet-el">
	<div class="kit-sheet-body">
		<SearchField placeholder="Filter objects" />
		<Section variant="card" label="Scene">
			<NavRow label="Cube" value="Mesh" />
			<NavRow label="Sun" value="Light" />
			<NavRow label="Player" value="Group" />
		</Section>
	</div>
</Sheet>

<style>
	.kit {
		position: fixed;
		inset: 0;
		overflow: auto;
		background: var(--bg-app);
		color: var(--text);
		font-size: var(--fs-body);
		line-height: 1.4;
	}
	.kit-top {
		position: sticky;
		top: 0;
		z-index: 5;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3) var(--space-6);
		padding: var(--space-3) var(--space-6);
		background: color-mix(in srgb, var(--bg-app) 90%, transparent);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid var(--border);
	}
	.kit-brand {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--space-3);
	}
	.kit-brand h1 {
		margin: 0;
		font-size: var(--fs-modal-title);
		font-weight: 600;
	}
	.kit-brand span {
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.kit-main {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 400px), 1fr));
		gap: 18px;
		padding: var(--space-6);
		max-width: 1400px;
		margin: 0 auto;
	}
	.kit-card {
		display: grid;
		align-content: start;
		gap: 14px;
		min-width: 0;
		padding: 18px;
		background: var(--surface-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-window);
	}
	.kit-wide {
		grid-column: 1 / -1;
	}
	.kit-card > header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-3);
	}
	.kit-card > header b {
		font-size: var(--fs-body);
		font-weight: 600;
	}
	.kit-card > header span {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-section);
		color: var(--text-faint);
		text-align: right;
	}
	.kit-authors {
		display: grid;
		gap: var(--space-2);
		max-width: 90ch;
		color: var(--text-2);
		font-size: var(--fs-desc);
		line-height: 1.5;
	}
	.kit-authors p {
		margin: 0;
	}
	.kit-authors b {
		color: var(--text);
	}
	.kit-authors code {
		font-family: var(--font-ui-mono);
		font-size: 0.95em;
		color: var(--text);
	}
	.kit-authors a {
		color: var(--accent-text);
	}
	.kit-row {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-start;
		gap: 14px 18px;
	}
	.kit-st {
		display: grid;
		gap: 6px;
		justify-items: start;
		min-width: 0;
	}
	.kit-st > small {
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.kit-cols3 {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr));
		gap: var(--space-3);
	}
	.kit-note {
		margin: 0;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.kit-span2 {
		grid-column: span 2;
		display: grid;
	}
	@media (max-width: 760px) {
		.kit-span2 {
			grid-column: auto;
		}
	}
	.kit-foot-note {
		margin-left: auto;
		white-space: nowrap;
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.kit-touch {
		--toggle-w: 51px;
		--toggle-h: 31px;
	}
	.kit-swatches {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
		gap: var(--space-2);
	}
	.kit-sw {
		display: grid;
		grid-template-columns: 30px minmax(0, 1fr);
		align-items: center;
		gap: var(--space-2);
		padding: 6px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
	}
	.kit-sw i {
		width: 30px;
		height: 30px;
		border-radius: var(--radius-input);
		border: 1px solid var(--border-strong);
	}
	.kit-sw b {
		display: block;
		font: 500 var(--fs-badge) var(--font-ui-mono);
	}
	.kit-sw em {
		display: block;
		font-style: normal;
		font-size: var(--fs-badge);
		color: var(--text-faint);
		overflow-wrap: anywhere;
	}
	.kit-contrast {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--fs-desc);
	}
	.kit-contrast th {
		text-align: left;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
	}
	.kit-contrast td {
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		color: var(--text-2);
	}
	.kit-contrast code,
	.kit-card code {
		font-family: var(--font-ui-mono);
		font-size: var(--fs-section);
	}
	.kit-sample {
		display: inline-block;
		padding: 3px 8px;
		border-radius: var(--radius-input);
	}
	.kit-text {
		box-sizing: border-box;
		width: 100%;
		height: var(--control-h-sm);
		padding: 0 10px;
		background: var(--surface-inset);
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-input);
	}
	.kit-inset-list {
		border: 1px solid var(--border);
		border-radius: var(--radius-button);
		overflow: hidden;
	}
	.kit-props {
		display: grid;
		gap: 4px;
	}
	.kit-xyz {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 6px;
		width: 100%;
		font-family: var(--font-ui-mono);
		--field: var(--surface-inset);
		--border: var(--border-input);
		--color-primary-400: var(--accent);
		--color-primary-500: var(--accent);
	}
	:global(.kit-ax-x) {
		color: var(--axis-x);
	}
	:global(.kit-ax-y) {
		color: var(--axis-y);
	}
	:global(.kit-ax-z) {
		color: var(--axis-z);
	}
	.kit-swatch {
		width: 28px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-input);
		cursor: pointer;
	}
	.kit-panel-demo {
		padding: 0 var(--space-3);
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
	}
	.kit-boxed {
		background: var(--surface-2);
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
	}
	.kit-stack {
		display: grid;
		gap: 6px;
	}
	.kit-sheet-body {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4) var(--space-6);
	}
	.kit-foot {
		margin: 0;
		padding: 0 var(--space-6) var(--space-8);
		font-size: var(--fs-desc);
		color: var(--text-faint);
		text-align: center;
	}
	@media (max-width: 639.98px) {
		.kit-top,
		.kit-main {
			padding-left: var(--space-4);
			padding-right: var(--space-4);
		}
		.kit-card {
			padding: 14px;
		}
	}
</style>
