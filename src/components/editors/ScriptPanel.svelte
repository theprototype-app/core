<script>
	import { flowNodes, scriptEditorOpen, scriptErrors } from '../../stores/flowStore';
	import { setNodeData } from '$lib/nodesHandler';
	import { focusStack } from '$lib/windowFocus';
	import { tabbable } from '$lib/windowTabs';
	import { scriptInputs, scriptOutputs, SCRIPT_INPUT_TYPES, SCRIPT_OUTPUT_TYPES } from '$lib/scriptIO';
	import { setScriptSockets, upgradeScriptToV2 } from '$lib/scriptSockets';
	import { lintScript } from '$lib/scriptLint';
	import CodeEditor from './CodeEditor.svelte';

	// Side panel editing a Script node's code (live, replicated via nodedata).
	// Edits are debounced so peers aren't flooded per keystroke.
	// 34 D3: and its DECLARED sockets — typed inputs read as `inputs.<name>`, outputs filled
	// by `return {…}`. Declaring any socket makes the node v2 (linted); none = v1, unchanged.

	$: node = $flowNodes.find((n) => n.id === $scriptEditorOpen) ?? null;
	$: error = node ? $scriptErrors[node.id] : null;
	$: inputs = node ? scriptInputs(node.data) : null;
	$: outputs = node ? scriptOutputs(node.data) : [];
	$: v2 = !!inputs || outputs.length > 0;
	/** @type {{ kind: 'inputs' | 'outputs', list: import('$lib/scriptIO').ScriptSocket[], types: string[] }[]} */
	$: sections = [
		{ kind: 'inputs', list: inputs ?? [], types: SCRIPT_INPUT_TYPES },
		{ kind: 'outputs', list: outputs, types: SCRIPT_OUTPUT_TYPES }
	];
	// a v1 node is not held to the lint (it ran yesterday), but it is told — the same
	// findings, as advice rather than a refusal
	$: advice = node && !v2 ? lintScript(node.data.code ?? '') : [];

	let timer;
	function onChange(code) {
		clearTimeout(timer);
		const id = node?.id;
		if (!id) return;
		timer = setTimeout(() => setNodeData(id, { code: code }), 400);
	}

	/** @param {'inputs' | 'outputs'} kind @param {any[]} list */
	function writeSockets(kind, list) {
		if (!node) return;
		setScriptSockets(node.id, { [kind]: list });
	}
	/** @param {'inputs' | 'outputs'} kind */
	function addSocket(kind) {
		const list = (kind === 'inputs' ? inputs : outputs) ?? [];
		let n = list.length + 1;
		const base = kind === 'inputs' ? 'in' : 'out';
		while (list.some((s) => s.name === base + n)) n++;
		writeSockets(kind, [...list, { name: base + n, type: 'number' }]);
	}
	/** @param {'inputs' | 'outputs'} kind @param {number} i @param {any} patch @param {any} [field] */
	function editSocket(kind, i, patch, field) {
		const list = [...((kind === 'inputs' ? inputs : outputs) ?? [])];
		list[i] = { ...list[i], ...patch };
		// normalizing DROPS an invalid or duplicate name, which would delete the socket the
		// user was only renaming — refuse the edit and put the field back instead
		const kept = kind === 'inputs' ? scriptInputs({ inputs: list }) : scriptOutputs({ outputs: list });
		if ((kept?.length ?? 0) !== list.length) {
			if (field) field.value = (kind === 'inputs' ? inputs : outputs)?.[i]?.name ?? '';
			return;
		}
		writeSockets(kind, list);
	}
	/** @param {'inputs' | 'outputs'} kind @param {number} i */
	function removeSocket(kind, i) {
		const list = [...((kind === 'inputs' ? inputs : outputs) ?? [])];
		list.splice(i, 1);
		writeSockets(kind, list);
	}
	function backToV1() {
		if (node) setScriptSockets(node.id, { inputs: null, outputs: null });
	}
</script>

{#if node}
	<div
		use:focusStack
		use:tabbable={{ key: 'script', title: 'Script', openStore: scriptEditorOpen, isOpen: (v) => !!v, close: () => scriptEditorOpen.set(null) }}
		class="fixed right-0 top-16 z-40 flex h-[70%] w-[420px] max-w-[90vw] flex-col gap-2 rounded-bl-lg bg-gray-800 p-3 text-white shadow-xl"
	>
		<div class="move-handle flex items-center justify-between">
			<span class="font-semibold">Script — runs on every peer</span>
			<button id="script-panel-close" class="rounded-sm bg-gray-600 px-2" on:click={() => scriptEditorOpen.set(null)}>✕</button>
		</div>
		<div id="script-sockets" class="flex max-h-[40%] shrink-0 flex-col gap-1 overflow-auto text-xs">
			{#if !v2}
				<div class="flex items-center gap-2">
					<span class="flex-1 text-gray-400">Inputs a, b, c (numbers) — no outputs.</span>
					<button id="script-upgrade-v2" class="rounded-sm bg-gray-600 px-2 py-0.5" title="Declare typed inputs and outputs (the code returns its outputs)" on:click={() => upgradeScriptToV2(node.id)}>
						Typed sockets…
					</button>
				</div>
			{:else}
				{#each sections as { kind, list, types } (kind)}
					<div class="flex items-center gap-2">
						<span class="font-semibold text-gray-300">{kind === 'inputs' ? 'Inputs' : 'Outputs'}</span>
						<span class="flex-1"></span>
						<button class="script-add-socket rounded-sm bg-gray-600 px-2" data-kind={kind} on:click={() => addSocket(kind)}>+ {kind === 'inputs' ? 'input' : 'output'}</button>
					</div>
					{#each list as socket, i (socket.name)}
						<div class="script-socket-row flex items-center gap-1" data-kind={kind} data-socket={socket.name}>
							<input
								class="w-28 rounded-sm bg-gray-900 px-1"
								aria-label="{kind} name"
								value={socket.name}
								on:change={(e) => editSocket(kind, i, { name: e.currentTarget.value.trim() }, e.currentTarget)}
							/>
							<select class="rounded-sm bg-gray-900 px-1" aria-label="{kind} type" value={socket.type} on:change={(e) => editSocket(kind, i, { type: e.currentTarget.value })}>
								{#each types as t (t)}<option value={t}>{t}</option>{/each}
							</select>
							<button class="ml-auto rounded-sm px-1 text-gray-400 hover:text-red-400" aria-label="Remove {socket.name}" on:click={() => removeSocket(kind, i)}>✕</button>
						</div>
					{/each}
				{/each}
				<button id="script-back-v1" class="self-start text-[11px] text-gray-400 underline" on:click={backToV1}>Back to a, b, c</button>
			{/if}
		</div>
		<div class="min-h-0 flex-1">
			<CodeEditor value={node.data.code ?? ''} {onChange} />
		</div>
		{#if error}
			<p class="text-xs text-red-400">⚠ {error}</p>
		{:else if v2}
			<p class="text-xs text-gray-400">
				inputs.&lt;name&gt;, time, dist/lerp/clamp — {outputs.length ? 'return { ' + outputs.map((o) => o.name).join(', ') + ' }' : 'drives its object (object, base, data)'}.
				No DOM, Math.random, Date.now or storage: peers must agree.
			</p>
		{:else}
			<p class="text-xs text-gray-400">
				object, base ({'{'}pos, rot, scale, visible{'}'}), data, time — keep it a pure function
				of these so peers stay in sync.
			</p>
			{#if advice.length}
				<p id="script-lint-advice" class="text-xs text-amber-400">line {advice[0].line}: {advice[0].message}{advice.length > 1 ? ' (+' + (advice.length - 1) + ' more)' : ''}</p>
			{/if}
		{/if}
	</div>
{/if}
