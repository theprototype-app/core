<script module>
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	const ROW_WORDS = {
		'enable assistant': ['ai', 'llm', 'claude', 'openai', 'assistant', 'prompt'],
		'add provider': ['provider', 'api key', 'model', 'ai', 'llm'],
		'mesh generation': ['meshy', 'ai', 'text to 3d', 'trellis', 'comfyui'],
		'add mesh provider': ['meshy', 'comfyui', 'provider', 'mesh']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ AI on the redesign kit (docs/settings-inventory.md §3.11): the
	// providers are a list of NavRows (+ Add provider) opening a provider SUB-PAGE with the form, the
	// same for mesh providers and the voice-typing server; the storage note is a muted footnote. The
	// form logic moved here from Settings.svelte unchanged (roadmap #10 / #11): per-preset key memory,
	// the silent /models refresh with its sequence guard, Test connection. Same stores, same keys.
	import { getContext } from 'svelte';
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import NavRow from '../../ui/NavRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import AiSttSettings from '../AiSttSettings.svelte';
	import { NAV_CONTEXT } from '$lib/settingsNav';
	import { showToast } from '../../../stores/appStore.js';
	import {
		aiEnabled,
		setAiEnabled,
		aiProviders,
		aiActiveProvider,
		setAiActiveProvider,
		addAiProvider,
		updateAiProvider,
		removeAiProvider,
		PROVIDER_PRESETS,
		presetFor,
		normalizeBaseUrl
	} from '$lib/ai/providers';
	import { testConnection, listModels } from '$lib/ai/client';
	import {
		meshGenEnabled,
		setMeshGenEnabled,
		meshProviders,
		meshActiveProvider,
		setMeshActiveProvider,
		addMeshProvider,
		updateMeshProvider,
		removeMeshProvider,
		MESH_PRESETS,
		meshPresetFor
	} from '$lib/ai/meshProviders';

	const nav = /** @type {any} */ (getContext(NAV_CONTEXT));
	const sub = nav?.sub;
	const view = $derived(
		$sub?.id === 'ai:stt' ? 'stt' : $sub?.id?.startsWith('ai:provider') ? 'provider' : $sub?.id?.startsWith('ai:mesh') ? 'mesh' : 'main'
	);

	// ---- the AI provider add / edit form (roadmap #10) ----
	/** @type {string | null} */
	let aiEditId = $state(null);
	let aiFormPreset = $state('grok');
	let aiFormLabel = $state('');
	let aiFormBaseUrl = $state('');
	let aiFormKey = $state('');
	let aiFormModel = $state('');
	let aiFormStream = $state(true);
	let aiFormPhysics = $state(false);
	let aiFormTemp = $state('');
	let aiTesting = $state(false);
	/** @type {{ ok: boolean, detail: string, modelOk?: boolean | null, model?: string } | null} */
	let aiTestResult = $state(null);
	// model picker: suggestions from the endpoint's GET /models (persisted on the provider so Edit
	// works after a reload); free text stays allowed — aliases and custom ids are legitimate
	/** @type {string[]} */
	let aiFormModels = $state([]);
	let aiModelListOpen = $state(false);
	let aiModelsFetching = $state(false);
	// per-preset API-key entries while the form is OPEN (switching Grok→Gemini must not carry the
	// Grok key into the Gemini box); only Save persists a key
	/** @type {Record<string, string>} */
	let aiFormKeys = {};
	let aiFormPresetPrev = 'grok';
	const aiModelFiltered = $derived.by(() => {
		const q = (aiFormModel || '').trim().toLowerCase();
		return q ? aiFormModels.filter((m) => m.toLowerCase().includes(q)) : aiFormModels;
	});

	/** silent best-effort refresh of the model suggestions; the sequence guard keeps a slow answer
	 * for a PREVIOUS endpoint from filling the current one */
	let aiFetchSeq = 0;
	async function aiRefreshModels() {
		const baseUrl = normalizeBaseUrl(aiFormBaseUrl);
		if (!baseUrl) return;
		const seq = ++aiFetchSeq;
		aiModelsFetching = true;
		const list = await listModels({ id: 'probe', preset: aiFormPreset, label: '', baseUrl, apiKey: aiFormKey.trim(), model: '' });
		if (seq !== aiFetchSeq) return;
		aiModelsFetching = false;
		if (list && list.length) aiFormModels = list;
	}
	function aiApplyPreset() {
		const preset = presetFor(aiFormPreset);
		aiFormLabel = preset.label;
		aiFormBaseUrl = preset.baseUrl;
		aiFormModel = preset.defaultModel;
	}
	/** preset switch: stash the old preset's key, restore the new one's, refetch if a key is there */
	function aiPresetChanged() {
		aiFormKeys[aiFormPresetPrev] = aiFormKey;
		aiApplyPreset();
		aiFormKey = aiFormKeys[aiFormPreset] ?? '';
		aiFormModels = [];
		aiModelListOpen = false;
		aiTestResult = null;
		aiFormPresetPrev = aiFormPreset;
		if (aiFormKey.trim() || aiFormPreset === 'custom') aiRefreshModels();
	}
	function aiStartAdd() {
		aiEditId = null;
		aiFormPreset = 'grok';
		aiApplyPreset();
		aiFormKey = '';
		aiFormStream = true;
		aiFormPhysics = false;
		aiFormTemp = '';
		aiTestResult = null;
		aiFormModels = [];
		aiModelListOpen = false;
		aiFormKeys = {};
		aiFormPresetPrev = aiFormPreset;
		nav.openSub('ai:provider:new', 'Add provider', 'ai');
	}
	/** @param {any} p */
	function aiStartEdit(p) {
		aiEditId = p.id;
		aiFormPreset = p.preset;
		aiFormLabel = p.label;
		aiFormBaseUrl = p.baseUrl;
		aiFormKey = p.apiKey;
		aiFormModel = p.model;
		aiFormStream = p.stream !== false;
		aiFormPhysics = p.physicsTools === true;
		aiFormTemp = typeof p.temperature === 'number' ? String(p.temperature) : '';
		aiTestResult = null;
		aiFormModels = Array.isArray(p.models) ? p.models : [];
		aiModelListOpen = false;
		aiFormKeys = { [p.preset]: p.apiKey };
		aiFormPresetPrev = p.preset;
		nav.openSub('ai:provider:' + p.id, p.label, 'ai');
		aiRefreshModels(); // silent; keeps the picker current without a Test click
	}
	function aiSaveProvider() {
		if (!aiFormBaseUrl.trim() || !aiFormModel.trim()) {
			showToast('Base URL and model are required');
			return;
		}
		const temp = parseFloat(aiFormTemp);
		const config = {
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: aiFormBaseUrl,
			apiKey: aiFormKey,
			model: aiFormModel,
			stream: aiFormStream,
			physicsTools: aiFormPhysics,
			temperature: Number.isFinite(temp) ? temp : undefined,
			models: aiFormModels
		};
		if (aiEditId) updateAiProvider(aiEditId, config);
		else addAiProvider(config);
		aiEditId = null;
		nav.closeSub();
	}
	async function aiTest() {
		if (!aiFormBaseUrl.trim()) {
			aiTestResult = { ok: false, detail: 'Enter a base URL first' };
			return;
		}
		aiTesting = true;
		aiTestResult = null;
		const result = await testConnection({
			id: 'test',
			preset: aiFormPreset,
			label: aiFormLabel,
			baseUrl: normalizeBaseUrl(aiFormBaseUrl),
			apiKey: aiFormKey.trim(),
			model: aiFormModel.trim()
		});
		if (result.models && result.models.length) aiFormModels = result.models;
		// pin the tested model into the result so later typing can't mislabel it
		aiTestResult = { ok: result.ok, detail: result.detail, modelOk: result.modelOk, model: aiFormModel.trim() };
		aiTesting = false;
	}

	// ---- the mesh-generation provider form (roadmap #11) ----
	/** @type {string | null} */
	let meshEditId = $state(null);
	let meshFormKind = $state('comfyui');
	let meshFormLabel = $state('');
	let meshFormBaseUrl = $state('');
	let meshFormKey = $state('');
	let meshFormWorkflow = $state('');
	let meshFormOutputNode = $state('');
	let meshFormMode = $state('preview');
	let meshFormAssetProxy = $state('');

	function meshApplyPreset() {
		const preset = meshPresetFor(meshFormKind);
		meshFormLabel = preset.label;
		meshFormBaseUrl = preset.baseUrl;
	}
	function meshStartAdd() {
		meshEditId = null;
		meshFormKind = 'comfyui';
		meshApplyPreset();
		meshFormKey = '';
		meshFormWorkflow = '';
		meshFormOutputNode = '';
		meshFormMode = 'preview';
		meshFormAssetProxy = '';
		nav.openSub('ai:mesh:new', 'Add mesh provider', 'ai');
	}
	/** @param {any} p */
	function meshStartEdit(p) {
		meshEditId = p.id;
		meshFormKind = p.kind;
		meshFormLabel = p.label;
		meshFormBaseUrl = p.baseUrl;
		meshFormKey = p.apiKey ?? '';
		meshFormWorkflow = p.workflowJson ?? '';
		meshFormOutputNode = p.outputNodeId ?? '';
		meshFormMode = p.mode ?? 'preview';
		meshFormAssetProxy = p.assetProxy ?? '';
		nav.openSub('ai:mesh:' + p.id, p.label, 'ai');
	}
	function meshSaveProvider() {
		if (!meshFormBaseUrl.trim()) {
			showToast('A base URL is required');
			return;
		}
		if (meshFormKind === 'comfyui' && meshFormWorkflow.trim()) {
			try {
				JSON.parse(meshFormWorkflow);
			} catch {
				showToast('The ComfyUI workflow is not valid JSON — re-export it in API format');
				return;
			}
		}
		/** @type {any} */
		const config = { kind: meshFormKind, label: meshFormLabel, baseUrl: meshFormBaseUrl, apiKey: meshFormKey };
		if (meshFormKind === 'comfyui') {
			config.workflowJson = meshFormWorkflow;
			config.outputNodeId = meshFormOutputNode;
		} else {
			config.mode = meshFormMode;
			config.assetProxy = meshFormAssetProxy;
		}
		if (meshEditId) updateMeshProvider(meshEditId, config);
		else addMeshProvider(config);
		meshEditId = null;
		nav.closeSub();
	}

	const MESH_MODES = [
		{ value: 'preview', label: 'Preview', title: 'Geometry only — faster, cheaper' },
		{ value: 'refine', label: 'Refine', title: 'Adds textures — more credits' }
	];
	/** @param {string} id */
	function removeAi(id) {
		removeAiProvider(id);
		nav.closeSub();
	}
	/** @param {string} id */
	function removeMesh(id) {
		removeMeshProvider(id);
		nav.closeSub();
	}
</script>

<div class="settings-page-body" data-keywords="assistant llm model">
	{#if view === 'stt'}
		<AiSttSettings subpage={true} />
	{:else if view === 'provider'}
		<Section variant="card" label={aiEditId ? 'Provider' : 'New provider'} badge="This device">
			<SettingRow id="row-ai-preset" label="Preset" wide>
				<select id="ai-form-preset" class="settings-text" bind:value={aiFormPreset} onchange={aiPresetChanged}>
					{#each PROVIDER_PRESETS as preset (preset.preset)}
						<option value={preset.preset}>{preset.label}</option>
					{/each}
				</select>
			</SettingRow>
			<SettingRow id="row-ai-label" label="Label" wide>
				<input id="ai-form-label" class="settings-text" placeholder="Label" autocomplete="off" bind:value={aiFormLabel} />
			</SettingRow>
			<SettingRow id="row-ai-base" label="Base URL" description="Ends in /v1. Leaving the field fetches the model list." wide>
				<input id="ai-form-base" class="settings-text" placeholder="Base URL (…/v1)" autocomplete="off" bind:value={aiFormBaseUrl} onchange={aiRefreshModels} />
			</SettingRow>
			<SettingRow id="row-ai-key" label="API key" wide>
				<!-- new-password: keeps Chrome's password manager from saving base-url + key as a login pair -->
				<input id="ai-form-key" class="settings-text" type="password" placeholder="API key / bearer token" autocomplete="new-password" bind:value={aiFormKey} onchange={aiRefreshModels} />
			</SettingRow>
			<SettingRow id="row-ai-model" label="Model" description="Pick from the list or type any id (aliases work)." wide>
				<input
					id="ai-model-input"
					class="settings-text"
					placeholder={aiModelsFetching ? 'Model id — fetching list…' : aiFormModels.length ? 'Model id — ' + aiFormModels.length + ' available' : 'Model id'}
					autocomplete="off"
					bind:value={aiFormModel}
					onfocus={() => (aiModelListOpen = true)}
					oninput={() => (aiModelListOpen = true)}
					onkeydown={(e) => {
						if (e.key === 'Escape' || e.key === 'Enter') aiModelListOpen = false;
					}}
					onblur={() => setTimeout(() => (aiModelListOpen = false), 150)}
				/>
				{#snippet extra()}
					{#if aiModelListOpen && aiFormModels.length}
						<div id="ai-model-list" class="ai-models">
							{#each aiModelFiltered as m (m)}
								<button
									type="button"
									class="ai-model"
									class:ai-model-on={m === aiFormModel.trim()}
									onmousedown={(e) => {
										e.preventDefault();
										aiFormModel = m;
										aiModelListOpen = false;
									}}>{m}</button
								>
							{/each}
							{#if !aiModelFiltered.length}
								<div class="ai-model-none">No match — free text works too.</div>
							{/if}
						</div>
					{/if}
				{/snippet}
			</SettingRow>
			<SettingRow id="row-ai-stream" label="Stream responses" description="Turn off for a self-hosted server whose tool calls only work unstreamed. The assistant also falls back by itself.">
				<Toggle id="ai-form-stream" label="Stream responses" bind:checked={aiFormStream} />
			</SettingRow>
			<SettingRow id="row-ai-physics" label="Physics tools" badge="Advanced">
				{#snippet desc()}Lets the assistant set physics bodies, joints and the simulation — best with 14B+ or hosted models. <a href="https://docs.theprototype.app/ai/local-models/" target="_blank" rel="noopener">Local &amp; small models guide</a>{/snippet}
				<Toggle id="ai-physics-tools" label="Physics tools" bind:checked={aiFormPhysics} />
			</SettingRow>
			<SettingRow id="row-ai-temp" label="Temperature" description="Blank uses the server’s default.">
				<input id="ai-form-temp" class="settings-num" placeholder="—" bind:value={aiFormTemp} />
			</SettingRow>
		</Section>
		<div class="ai-actions">
			<Button id="ai-form-save" variant="primary" size="sm" onclick={aiSaveProvider}>Save</Button>
			<Button id="ai-form-test" variant="outline" size="sm" disabled={aiTesting} onclick={aiTest}>{aiTesting ? 'Testing…' : 'Test connection'}</Button>
			{#if aiEditId && $aiActiveProvider !== aiEditId}
				<Button id="ai-form-use" variant="outline" size="sm" onclick={() => aiEditId && setAiActiveProvider(aiEditId)}>Use this provider</Button>
			{/if}
			<Button id="ai-form-cancel" variant="ghost" size="sm" onclick={() => nav.closeSub()}>Cancel</Button>
			{#if aiEditId}
				<span class="ai-spacer"></span>
				<Button id="ai-form-remove" variant="warn-text" size="sm" onclick={() => aiEditId && removeAi(aiEditId)}>Remove</Button>
			{/if}
		</div>
		{#if aiTestResult}
			<p id="ai-test-result" class="ai-result">
				{#if aiTestResult.ok}
					<span class="ai-ok">✓ {aiTestResult.detail}</span>
					{#if !aiTestResult.model}
						<span class="ai-bad"> · no model selected</span>
					{:else if aiTestResult.modelOk}
						<span class="ai-ok"> · model <code>{aiTestResult.model}</code> — Configuration OK</span>
					{:else if aiTestResult.modelOk === false}
						<span class="ai-bad"> · model “{aiTestResult.model}” did not respond — pick one from the list</span>
					{/if}
				{:else}
					<span class="ai-bad">✗ {aiTestResult.detail}</span>
				{/if}
			</p>
		{/if}
	{:else if view === 'mesh'}
		<Section variant="card" label={meshEditId ? 'Mesh provider' : 'New mesh provider'} badge="This device">
			<SettingRow id="row-mesh-kind" label="Kind" wide>
				<select id="mesh-form-kind" class="settings-text" bind:value={meshFormKind} onchange={meshApplyPreset}>
					{#each MESH_PRESETS as preset (preset.kind)}
						<option value={preset.kind}>{preset.label}</option>
					{/each}
				</select>
			</SettingRow>
			<SettingRow id="row-mesh-label" label="Label" wide>
				<input class="settings-text" placeholder="Label" autocomplete="off" bind:value={meshFormLabel} />
			</SettingRow>
			<SettingRow id="row-mesh-url" label="URL" wide>
				<input class="settings-text" placeholder={meshFormKind === 'comfyui' ? 'http://host:8188' : 'https://api.meshy.ai'} autocomplete="off" bind:value={meshFormBaseUrl} />
			</SettingRow>
			<SettingRow id="row-mesh-key" label={meshFormKind === 'comfyui' ? 'Bearer token' : 'API key'} description={meshFormKind === 'comfyui' ? 'Only if proxied; blank on a LAN.' : ''} wide>
				<input class="settings-text" type="password" autocomplete="new-password" bind:value={meshFormKey} />
			</SettingRow>
			{#if meshFormKind === 'comfyui'}
				<SettingRow id="row-mesh-workflow" label="Workflow JSON" wide>
					{#snippet desc()}API format. Put <code>{'{{PROMPT}}'}</code> in the text node and <code>{'{{SEED}}'}</code> in the sampler seed.{/snippet}
					{#snippet extra()}
						<textarea class="settings-text ai-workflow" bind:value={meshFormWorkflow}></textarea>
					{/snippet}
				</SettingRow>
				<SettingRow id="row-mesh-output" label="Output node" description="Optional — the SaveGLB node is found by itself." wide>
					<input class="settings-text" placeholder="node id" bind:value={meshFormOutputNode} />
				</SettingRow>
			{:else}
				<SettingRow id="row-mesh-mode" label="Mode">
					<Segmented id="mesh-form-mode" label="Mode" options={MESH_MODES} value={meshFormMode} onchange={(v) => (meshFormMode = v)} />
				</SettingRow>
				<SettingRow id="row-mesh-proxy" label="Asset proxy" description="The assets CDN sends no CORS headers, so downloads go through a proxy. Blank uses the built-in defaults." wide>
					<input class="settings-text" placeholder="https://proxy.theprototype.app" bind:value={meshFormAssetProxy} />
				</SettingRow>
			{/if}
		</Section>
		<div class="ai-actions">
			<Button id="mesh-form-save" variant="primary" size="sm" onclick={meshSaveProvider}>Save</Button>
			{#if meshEditId && $meshActiveProvider !== meshEditId}
				<Button variant="outline" size="sm" onclick={() => meshEditId && setMeshActiveProvider(meshEditId)}>Use this provider</Button>
			{/if}
			<Button variant="ghost" size="sm" onclick={() => nav.closeSub()}>Cancel</Button>
			{#if meshEditId}
				<span class="ai-spacer"></span>
				<Button variant="warn-text" size="sm" onclick={() => meshEditId && removeMesh(meshEditId)}>Remove</Button>
			{/if}
		</div>
	{:else}
		<Section variant="card" label="Assistant" badge="This device">
			<SettingRow id="row-ai-enable" label="Enable assistant" description="Build and edit the scene with prompts. Press ` for the quick prompt bar. Edits replicate and undo as one step.">
				<Toggle id="ai-enabled" label="Enable assistant" checked={$aiEnabled} onchange={(on) => setAiEnabled(on)} />
			</SettingRow>
			{#each $aiProviders as p (p.id)}
				<NavRow label={p.label} description={p.model} badge={$aiActiveProvider === p.id ? 'Active' : ''} data-provider={p.id} onclick={() => aiStartEdit(p)} />
			{/each}
			<NavRow id="ai-add-provider" label="Add provider" description={$aiProviders.length ? '' : 'No providers yet.'} onclick={aiStartAdd} />
		</Section>
		<Section variant="card" label="Voice typing" badge="This device">
			<AiSttSettings />
		</Section>
		<Section variant="card" label="Mesh generation" badge="This device">
			<SettingRow id="row-mesh-enable" label="Mesh generation" description="Text → 3D models from the Add menu or the assistant — a self-hosted ComfyUI with TRELLIS, or Meshy.">
				<Toggle id="mesh-gen-enabled" label="Mesh generation" checked={$meshGenEnabled} onchange={(on) => setMeshGenEnabled(on)} />
			</SettingRow>
			{#each $meshProviders as p (p.id)}
				<NavRow label={p.label} description={p.kind} badge={$meshActiveProvider === p.id ? 'Active' : ''} data-mesh-provider={p.id} onclick={() => meshStartEdit(p)} />
			{/each}
			<NavRow id="ai-add-mesh-provider" label="Add mesh provider" description={$meshProviders.length ? '' : 'No mesh providers yet.'} onclick={meshStartAdd} />
		</Section>
		<p class="settings-footnote">API keys are stored unencrypted in this browser and only ever sent to the provider you set up.</p>
	{/if}
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.ai-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		margin-top: -8px;
	}
	.ai-spacer {
		flex: 1;
	}
	.ai-result {
		margin: -8px 0 0;
		font-size: var(--fs-desc);
	}
	.ai-ok {
		color: var(--ink-good, #4ade80);
	}
	.ai-bad {
		color: var(--ink-bad, #f87171);
	}
	.ai-models {
		max-height: 10rem;
		overflow-y: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--surface-inset);
	}
	.ai-model {
		display: block;
		width: 100%;
		padding: 4px 10px;
		border: 0;
		background: transparent;
		font-family: var(--font-ui-mono);
		font-size: 12px;
		text-align: left;
		color: var(--text-2);
		cursor: pointer;
	}
	.ai-model:hover {
		background: var(--surface-hover);
	}
	.ai-model-on {
		background: var(--accent-soft);
		color: var(--accent-soft-text);
	}
	.ai-model-none {
		padding: 4px 10px;
		font-size: 12px;
		color: var(--text-faint);
	}
	.ai-workflow {
		width: 100%;
		height: auto;
		min-height: 90px;
		padding: 8px 10px;
		resize: vertical;
		font-family: var(--font-ui-mono);
		font-size: 11px;
	}
</style>
