<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// the old Settings ▸ AI words still find the rows that moved here
	registerSettingsKeywords('chat providers', [
		'ai',
		'llm',
		'claude',
		'openai',
		'grok',
		'gemini',
		'assistant',
		'provider',
		'api key',
		'model'
	]);
	registerSettingsKeywords('mesh providers', [
		'meshy',
		'comfyui',
		'trellis',
		'text to 3d',
		'generate',
		'mesh generation'
	]);
	registerSettingsKeywords('desktop tools', [
		'blender',
		'maya',
		'3ds max',
		'cascadeur',
		'gltf',
		'glb',
		'dcc'
	]);
	registerSettingsKeywords('voice typing', ['stt', 'whisper', 'speech', 'mic', 'dictation']);
</script>

<script>
	// 59 T4 — Settings ▸ Tools & connections: ONE page for everything outside the app. It renders the
	// registry (`$lib/tools/toolStatus.js`) — every section that has rows, in page order — and knows
	// nothing about any provider: a row brings its own status, Test, Enable / Disable and the
	// features it turns on. A row's form is either its own `configure()` (a later roadmap's section)
	// or a built-in form the AI page owns (`onform(kind, ref)` — the provider forms that moved here
	// with their stores and keys unchanged).
	import { tick } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import NavRow from '../../ui/NavRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Button from '../../ui/Button.svelte';
	import Badge from '../../ui/Badge.svelte';
	import {
		toolSections,
		toolTests,
		runToolTest,
		rowState,
		toolsFocus
	} from '$lib/tools/toolStatus.js';
	import '$lib/tools/builtinTools.js';

	/** @type {{onform?: (kind: string, ref?: any) => void}} */
	let { onform = () => {} } = $props();

	/** @type {Record<string, boolean>} */
	let testing = $state({});

	const TONE = /** @type {const} */ ({
		ready: 'ok',
		off: 'off',
		setup: 'warn',
		error: 'bad',
		unknown: 'neutral'
	});
	/** @param {string} id a row id → a DOM-safe suffix */
	const domId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, '-');

	/** @param {import('$lib/tools/toolStatus.js').ToolRow} row */
	async function test(row) {
		testing = { ...testing, [row.id]: true };
		await runToolTest(row);
		testing = { ...testing, [row.id]: false };
	}
	/** @param {import('$lib/tools/toolStatus.js').ToolRow} row */
	function configure(row) {
		if (row.configure) row.configure();
		else if (row.form) onform(row.form.kind, row.form.ref);
	}
	/** @param {{onclick?: () => void, form?: string}} add */
	function runAdd(add) {
		if (add.onclick) add.onclick();
		else if (add.form) onform(add.form + ':new');
	}

	// T5: a button whose tool is missing opens this page AT its row — scroll there and flash it
	$effect(() => {
		const focus = $toolsFocus;
		if (!focus) return;
		void tick().then(() =>
			requestAnimationFrame(() => {
				const el =
					(focus.row &&
						document.querySelector(`#settings-main [data-tool-row="${CSS.escape(focus.row)}"]`)) ||
					document.querySelector(
						`#settings-main [data-tool-section="${CSS.escape(focus.section)}"]`
					);
				if (!(el instanceof HTMLElement)) return;
				el.scrollIntoView({ block: 'center' });
				const flash = el.matches('.setting-row') ? el : el.querySelector('.setting-row');
				flash?.classList.add('sr-flash');
				setTimeout(() => flash?.classList.remove('sr-flash'), 1600);
				toolsFocus.set(null);
			})
		);
	});
</script>

{#each $toolSections as group (group.section.id)}
	<div
		class="tools-section"
		data-tool-section={group.section.id}
		id={'tools-section-' + group.section.id}
	>
		<Section variant="card" label={group.section.label} badge="This device">
			{#if group.section.description}
				<p class="tools-desc">{group.section.description}</p>
			{/if}
			{#each group.rows as row (row.id)}
				{@const state = rowState(row, $toolTests)}
				{@const result = $toolTests[row.id]}
				{@const rid = 'tool-' + domId(row.id)}
				<SettingRow id={rid} label={row.label} data-tool-row={row.id} data-tool-state={state}>
					{#snippet desc()}
						<span class="tools-status" data-tool-status={state}
							><Badge tone={TONE[state] ?? 'neutral'} text={row.stateText || state} /></span
						>
						{#if row.detail}<span class="tools-detail">{row.detail}</span>{/if}
						{#if row.features?.length}
							<span class="tools-features"
								><span class="tools-features-label">Turns on:</span>
								{row.features.join(' · ')}</span
							>
						{/if}
					{/snippet}
					{#if row.test}
						<Button
							id={rid + '-test'}
							size="sm"
							variant="outline"
							disabled={!!testing[row.id]}
							onclick={() => test(row)}
							title={'Test ' + row.label}>{testing[row.id] ? 'Testing…' : 'Test'}</Button
						>
					{/if}
					{#if typeof row.enabled === 'boolean' && row.setEnabled}
						<Toggle
							id={rid + '-enable'}
							label={'Enable ' + row.label}
							title={row.enabled ? 'Disable' : 'Enable'}
							checked={row.enabled}
							onchange={(on) => row.setEnabled?.(on)}
						/>
					{/if}
					{#if row.configure || (row.form && row.form.kind !== 'desktop')}
						<Button
							id={rid + '-configure'}
							size="sm"
							variant="ghost"
							iconRight="chevron-right"
							onclick={() => configure(row)}
							title={'Set up ' + row.label}>Set up<span class="sr-only"> {row.label}</span></Button
						>
					{/if}
					{#snippet extra()}
						{#if result}
							<p
								id={rid + '-result'}
								class="tools-result"
								class:tools-ok={result.ok}
								class:tools-bad={!result.ok}
								role="status"
							>
								{result.ok ? '✓' : '✗'}
								{result.detail}
							</p>
						{/if}
					{/snippet}
				</SettingRow>
			{/each}
			{#each group.adds as add (add.label)}
				<NavRow
					id={'tools-add-' + group.section.id}
					label={add.label}
					description={group.rows.length ? '' : 'Nothing set up yet.'}
					onclick={() => runAdd(add)}
				/>
			{/each}
		</Section>
	</div>
{/each}
<p class="settings-footnote">
	API keys are stored unencrypted in this browser and only ever sent to the provider you set up.
</p>

<style>
	.tools-desc {
		margin: 0;
		font-size: var(--fs-desc);
		line-height: 1.45;
		color: var(--text-muted);
	}
	.tools-desc {
		padding: var(--space-3) 18px 0;
	}
	.tools-status {
		margin-right: var(--space-2);
	}
	.tools-detail {
		overflow-wrap: anywhere;
	}
	.tools-features {
		display: block;
		margin-top: 2px;
	}
	.tools-features-label {
		color: var(--text-faint);
	}
	.tools-result {
		margin: 0;
		font-size: var(--fs-desc);
	}
	.tools-ok {
		color: var(--ink-good);
	}
	.tools-bad {
		color: var(--ink-bad);
	}
	.sr-only {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
	@media (max-width: 639.98px) {
		.tools-desc {
			padding: var(--space-3) var(--space-4) 0;
		}
	}
</style>
