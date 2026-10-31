<script>
	// 71 TR1 — THE PERMISSIONS SHEET: what one peer may do in this room. Core renders; the plugin decides
	// (`rolesInfo.capCatalog()` is the list of switches and presets, `setCaps` is the only write, and every
	// peer's capability gate is what holds). Opened from the peer menu and from the plugin's cards through
	// the `permissionsFor` store. Choosing a preset fills the switches; any switch can then be changed, and
	// nothing applies until Apply.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { rolesInfo, permissionsFor } from '$lib/cloudHooks';
	import { userdata, showToast } from '../../stores/appStore';

	const ri = $derived(/** @type {any} */ ($rolesInfo));
	const peerId = $derived($permissionsFor);
	const catalog = $derived(ri?.capCatalog?.() ?? { caps: [], presets: [], agentDefault: '' });
	const row = $derived(/** @type {any[]} */ ($userdata).find((u) => u[0] === peerId));
	const who = $derived(String(row?.[1] || String(peerId).slice(0, 6).toUpperCase()));
	const isAgent = $derived(row?.[6]?.kind === 'agent');

	const AREAS = [
		{ id: 'objects', label: 'Objects and scene' },
		{ id: 'nodes', label: 'Nodes and code' },
		{ id: 'voice', label: 'Voice' },
		{ id: 'room', label: 'Room' }
	];
	const TRI = [
		{ value: 'off', label: 'Off' },
		{ value: 'ask', label: 'Ask first' },
		{ value: 'on', label: 'On' }
	];

	/** @type {Record<string, any>} */
	let draft = $state({});
	let open = $state(true);
	let saveName = $state('');
	let loadedFor = '';
	$effect(() => {
		if (!peerId || loadedFor === peerId) return;
		loadedFor = peerId;
		const current = ri?.capsOf?.(peerId);
		const fallback = catalog.presets.find((/** @type {any} */ p) => p.id === (isAgent ? catalog.agentDefault : 'editor'));
		draft = { ...(current ?? fallback?.caps ?? {}) };
	});
	$effect(() => {
		if (!open) permissionsFor.set('');
	});

	const matching = $derived(
		catalog.presets.find((/** @type {any} */ p) => catalog.caps.every((/** @type {any} */ c) => p.caps[c.key] === draft[c.key]))?.id ?? ''
	);
	const presetOptions = $derived([
		...catalog.presets.map((/** @type {any} */ p) => ({ value: p.id, name: p.label })),
		...(matching ? [] : [{ value: '', name: 'Custom' }])
	]);
	const hint = $derived(catalog.presets.find((/** @type {any} */ p) => p.id === matching)?.hint ?? '');
	const custom = $derived(catalog.presets.find((/** @type {any} */ p) => p.id === matching)?.custom === true);

	/** @param {string} id */
	function pick(id) {
		const preset = catalog.presets.find((/** @type {any} */ p) => p.id === id);
		if (preset) draft = { ...preset.caps };
	}
	function apply() {
		ri?.setCaps?.(peerId, { ...draft });
		showToast(who + "'s permissions were updated.");
		open = false;
	}
	function saveAsPreset() {
		const id = ri?.savePreset?.(saveName, { ...draft });
		if (id) {
			saveName = '';
			showToast('Preset saved on this device.');
		}
	}
</script>

{#if peerId && ri?.capCatalog}
	<ModalDialog bind:open title={'Permissions for ' + who} width="sm" class="peer-permissions">
		<div class="pp" data-peer={peerId}>
			<label class="pp-preset">
				<span class="pp-label">Preset</span>
				<ThemedSelect id="pp-preset" items={presetOptions} value={matching} onchange={(/** @type {string} */ v) => pick(v)} />
			</label>
			{#if hint}<p class="pp-hint">{hint}</p>{/if}

			{#each AREAS as area (area.id)}
				<section class="pp-area" data-area={area.id}>
					<h3 class="pp-area-title">{area.label}</h3>
					{#each catalog.caps.filter((/** @type {any} */ c) => c.area === area.id) as cap (cap.key)}
						<div class="pp-row" data-cap={cap.key}>
							<span class="pp-row-label" id={'pp-l-' + cap.key}>{cap.label}</span>
							{#if cap.kind === 'tri'}
								<Segmented options={TRI} value={draft[cap.key]} labelledby={'pp-l-' + cap.key} id={'pp-' + cap.key} onchange={(/** @type {string} */ v) => (draft[cap.key] = v)} />
							{:else}
								<Toggle checked={draft[cap.key] === true} labelledby={'pp-l-' + cap.key} id={'pp-' + cap.key} onchange={(/** @type {boolean} */ v) => (draft[cap.key] = v)} />
							{/if}
						</div>
					{/each}
				</section>
			{/each}

			<section class="pp-area">
				<h3 class="pp-area-title">Presets on this device</h3>
				<div class="pp-save">
					<input id="pp-save-name" class="pp-input" type="text" maxlength="40" placeholder="Name this set of switches" aria-label="Preset name" bind:value={saveName} />
					<Button id="pp-save" disabled={!saveName.trim()} onclick={saveAsPreset}>Save</Button>
				</div>
				{#if isAgent && matching}
					<Button id="pp-agent-default" disabled={catalog.agentDefault === matching} onclick={() => ri?.setAgentDefault?.(matching)}>
						{catalog.agentDefault === matching ? 'New agents start on this preset' : 'Start new agents on this preset'}
					</Button>
				{/if}
				{#if custom}
					<Button id="pp-delete-preset" onclick={() => ri?.deletePreset?.(matching)}>Delete this preset</Button>
				{/if}
			</section>
		</div>
		{#snippet footer()}
			<Button id="pp-apply" variant="primary" onclick={apply}>Apply</Button>
		{/snippet}
	</ModalDialog>
{/if}

<style>
	.pp {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}
	.pp-preset {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.pp-label,
	.pp-area-title {
		font-size: var(--fs-label);
		font-weight: 600;
		color: var(--text-dim);
		margin: 0;
	}
	.pp-hint {
		margin: 0;
		color: var(--text-dim);
		font-size: var(--fs-label);
	}
	.pp-area {
		display: flex;
		flex-direction: column;
		gap: 6px;
		border-top: 1px solid var(--border);
		padding-top: 10px;
	}
	.pp-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 6px 12px;
		min-height: 32px;
	}
	.pp-row-label {
		flex: 1 1 140px;
		min-width: 0;
	}
	.pp-save {
		display: flex;
		gap: 8px;
	}
	.pp-input {
		flex: 1 1 auto;
		min-width: 0;
		background: var(--surface-2);
		color: var(--text);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 4px 8px;
	}
</style>
