<script>
	// 73 AI3 — the shader editor's </> view. THREE tabs: GLSL (what the graph compiles to,
	// read-only + Copy, because GLSL cannot be parsed back into nodes) · Graph JSON (editable,
	// Apply/Reload, FlowCode's contract) · Your GLSL (a vertex + fragment pair that replaces the
	// graph while it is on). A post document gets the first two: your own GLSL is surface only.
	import CodeEditor from './CodeEditor.svelte';
	import ShaderVectorInput from './nodes/ShaderVectorInput.svelte';
	import { showToast } from '../../stores/appStore.js';
	import { objectsGroup } from '../../stores/sceneStore.js';
	import { setShaderGraphFor, shaderGraphOf, shaderCodeRunState, retryShaderCodeFor } from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';
	import { compileShaderGraphToIR, compilePostGraphToIR } from '$lib/shaderCompile';
	import { shaderCodeBlocked, shaderCodeSuspended, codeUniformValue } from '$lib/shaderCodeGuard';
	import {
		STARTER_VERTEX,
		STARTER_FRAGMENT,
		formatGeneratedGlsl,
		parseGraphJson,
		scanShaderUniforms,
		shaderCodeHash,
		normalizeShaderCode
	} from '$lib/shaderCode';
	import { safeStorage } from '$lib/safeStorage';

	/** @type {{scope: string, doc: any, isPost: boolean, ensureDoc: () => void}} */
	let { scope, doc, isPost, ensureDoc } = $props();

	let tab = $state(safeStorage.getItem('shaderCodeTab') || 'glsl');
	const shownTab = $derived(isPost && tab === 'own' ? 'glsl' : tab);
	/** @param {string} next */
	function setTab(next) {
		tab = next;
		safeStorage.setItem('shaderCodeTab', next);
	}

	// ---- GLSL: derived, so it can never disagree with the graph ----------------
	const generated = $derived.by(() => {
		if (!doc) return '';
		const result = isPost ? compilePostGraphToIR(doc) : compileShaderGraphToIR(doc);
		return result.ok ? formatGeneratedGlsl(result.ir) : '// The graph does not compile yet:\n' + (result.errors ?? []).map((/** @type {string} */ e) => '// ' + e).join('\n') + '\n';
	});
	async function copyGenerated() {
		try {
			await navigator.clipboard.writeText(generated);
			showToast('GLSL copied');
		} catch {
			showToast('The browser refused the clipboard.');
		}
	}

	// ---- Graph JSON: text you edit, kept until you Apply or Reload --------------
	let jsonText = $state('');
	let jsonDirty = $state(false);
	let jsonError = $state('');
	const liveJson = $derived(doc ? JSON.stringify({ nodes: doc.nodes, edges: doc.edges }, null, 2) : '');
	$effect(() => {
		if (!jsonDirty) jsonText = liveJson;
	});
	function applyJson() {
		const parsed = parseGraphJson(jsonText);
		if ('error' in parsed) {
			jsonError = parsed.error;
			return;
		}
		jsonError = '';
		jsonDirty = false;
		setShaderGraphFor(scope, { nodes: parsed.nodes, edges: parsed.edges });
	}
	function reloadJson() {
		jsonDirty = false;
		jsonError = '';
		jsonText = liveJson;
	}

	// ---- Your GLSL --------------------------------------------------------------
	const code = $derived(normalizeShaderCode(doc?.code));
	let stage = $state('fragment');
	let vertexText = $state('');
	let fragmentText = $state('');
	let codeDirty = $state(false);
	let lastScope = '';
	$effect(() => {
		// another object is another document: unapplied text does not follow you there
		const moved = lastScope !== scope;
		lastScope = scope;
		if (moved) codeDirty = false;
		if (!codeDirty) {
			vertexText = code.vertex || STARTER_VERTEX;
			fragmentText = code.fragment || STARTER_FRAGMENT;
		}
	});
	const fields = $derived(scanShaderUniforms(code.vertex, code.fragment).uniforms);
	const hash = $derived(shaderCodeHash(code));
	const refusal = $derived($shaderCodeBlocked[hash] || $shaderCodeSuspended || '');
	const runState = $derived.by(() => {
		void $objectsGroup; // a THREE tree is not reactive; the install pokes this
		return doc ? shaderCodeRunState(scope) : 'off';
	});

	/** Apply the text and turn it on: a pair you pressed Apply on is a pair you want to see. */
	function applyCode() {
		if (!shaderGraphOf(scope)) ensureDoc();
		const current = shaderGraphOf(scope);
		if (!current) return; // refused, and the editor said why
		codeDirty = false;
		setShaderGraphFor(scope, { code: { ...normalizeShaderCode(current.code), use: true, vertex: vertexText, fragment: fragmentText } });
	}
	function turnOff() {
		setShaderGraphFor(scope, { code: { ...code, use: false } });
	}
	/** @param {{name: string, type: string}} field @returns {number[]} */
	function vectorOf(field) {
		const value = codeUniformValue(code.uniforms[field.name], field.type);
		return Array.isArray(value) ? value : [value];
	}
	/** @param {string} name @param {any} value */
	function writeField(name, value) {
		setShaderGraphFor(scope, { code: { ...code, uniforms: { ...code.uniforms, [name]: value } } });
	}
</script>

<div class="scp" id="shader-code-pane">
	<div class="scp-bar">
		<div class="tp-seg" role="group" aria-label="Code view">
			<button class="tp-seg-btn" id="shader-code-tab-glsl" aria-pressed={shownTab === 'glsl'} onclick={() => setTab('glsl')}>GLSL</button>
			<button class="tp-seg-btn" id="shader-code-tab-json" aria-pressed={shownTab === 'json'} onclick={() => setTab('json')}>Graph JSON</button>
			{#if !isPost}
				<button class="tp-seg-btn" id="shader-code-tab-own" aria-pressed={shownTab === 'own'} onclick={() => setTab('own')}>Your GLSL</button>
			{/if}
		</div>
		<span class="flex-1"></span>
		{#if shownTab === 'glsl'}
			<button class="ui-button-quiet scp-act" id="shader-code-copy" disabled={!generated} onclick={copyGenerated}>Copy</button>
		{:else if shownTab === 'json'}
			<button class="ui-button-quiet scp-act" id="shader-json-reload" title="Throw away your edits and read the graph again" disabled={!doc} onclick={reloadJson}>Reload</button>
			<button class="ui-button-quiet scp-act" id="shader-json-apply" disabled={!doc || !jsonDirty} onclick={applyJson}>Apply</button>
		{:else}
			{#if code.use}
				<button class="ui-button-quiet scp-act" id="shader-own-off" title="Go back to the graph. Your text stays here." onclick={turnOff}>Use the graph</button>
			{/if}
			<button class="ui-button-quiet scp-act" id="shader-own-apply" onclick={applyCode}>Apply</button>
		{/if}
	</div>

	{#if shownTab === 'glsl'}
		<div class="scp-editor" id="shader-code-glsl">
			{#if doc}
				<CodeEditor value={generated} readOnly />
			{:else}
				<p class="scp-note">No shader here yet. Create a graph, or write Your GLSL.</p>
			{/if}
		</div>
	{:else if shownTab === 'json'}
		{#if jsonError}<div class="scp-error" id="shader-json-error">{jsonError}</div>{/if}
		<div class="scp-editor" id="shader-code-json">
			{#if doc}
				<CodeEditor value={jsonText} onChange={(v) => { jsonText = v; jsonDirty = v !== liveJson; }} />
			{:else}
				<p class="scp-note">No shader here yet.</p>
			{/if}
		</div>
	{:else}
		<div class="scp-status" id="shader-own-status" data-state={refusal ? 'refused' : runState}>
			{#if refusal}
				<span>{refusal}</span>
				<button class="ui-button-quiet scp-act" id="shader-own-retry" onclick={() => retryShaderCodeFor(scope)}>Try again</button>
			{:else if runState === 'running'}
				Running on this device.
			{:else if runState === 'waiting'}
				Testing before it runs…
			{:else}
				Off. Apply runs this pair instead of the graph, for everyone in the session.
			{/if}
		</div>
		{#if fields.length}
			<div class="scp-fields" id="shader-own-fields">
				{#each fields as field (field.name)}
					<div class="scp-field" data-uniform={field.name}>
						<span class="scp-field-name">{field.name}</span>
						{#if field.type === 'float'}
							<input
								type="number"
								step="0.01"
								aria-label={field.name}
								value={codeUniformValue(code.uniforms[field.name], 'float')}
								onchange={(e) => writeField(field.name, Number(e.currentTarget.value))}
							/>
						{:else}
							<ShaderVectorInput
								value={vectorOf(field)}
								size={field.type === 'vec2' ? 2 : field.type === 'vec4' ? 4 : 3}
								onchange={(/** @type {number[]} */ next) => writeField(field.name, next)}
								onstart={() => beginShaderGesture(scope)}
								onend={() => endShaderGesture(scope)}
							/>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
		<div class="scp-stage">
			<div class="tp-seg" role="group" aria-label="Shader stage">
				<button class="tp-seg-btn" id="shader-own-vertex" aria-pressed={stage === 'vertex'} onclick={() => (stage = 'vertex')}>Vertex</button>
				<button class="tp-seg-btn" id="shader-own-fragment" aria-pressed={stage === 'fragment'} onclick={() => (stage = 'fragment')}>Fragment</button>
			</div>
			<span class="scp-hint">Loops must count to a constant. Up to 64 KB per stage.</span>
		</div>
		<div class="scp-editor" id="shader-own-editor" data-stage={stage}>
			{#key stage}
				<CodeEditor
					value={stage === 'vertex' ? vertexText : fragmentText}
					onChange={(v) => {
						if (stage === 'vertex') vertexText = v;
						else fragmentText = v;
						codeDirty = true;
					}}
				/>
			{/key}
		</div>
	{/if}
</div>

<style>
	.scp {
		flex: 1;
		min-height: 0;
		display: flex;
		flex-direction: column;
		font-size: 11px;
	}
	.scp-bar,
	.scp-stage {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-1);
		padding: var(--space-1) var(--space-2);
	}
	.scp-act {
		font-size: 11px;
		padding: 2px 6px;
	}
	.scp-editor {
		flex: 1;
		min-height: 0;
		overflow: hidden;
		display: flex;
		flex-direction: column;
	}
	.scp-note,
	.scp-hint {
		color: var(--text-faint);
		padding: var(--space-1) var(--space-2);
	}
	.scp-error {
		flex: 0 0 auto;
		color: var(--ink-bad);
		padding: var(--space-1) var(--space-2);
	}
	.scp-status {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		color: var(--text-2);
		padding: var(--space-1) var(--space-2);
	}
	.scp-status[data-state='refused'] {
		color: var(--ink-bad);
	}
	.scp-fields {
		flex: 0 0 auto;
		max-height: 96px;
		overflow-y: auto;
		padding: 0 var(--space-2);
	}
	.scp-field {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: 1px 0;
	}
	.scp-field-name {
		flex: 0 0 72px;
		overflow: hidden;
		text-overflow: ellipsis;
		font-family: var(--font-mono, monospace);
	}
	.scp-field input {
		width: 72px;
		font-size: 11px;
	}
</style>
