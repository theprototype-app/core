<script>
	import { nodeDesignerOpen } from '../../stores/flowStore';
	import { saveNodeDef, deleteNodeDef } from '$lib/customNodes';
	import CodeEditor from './CodeEditor.svelte';

	// Modal for creating/editing a custom node definition. Saving replicates
	// the def to every peer; existing instances re-render and re-run live.

	let name = '';
	let params = [];
	let code = '';
	let editingId = null;

	// (re)seed the form whenever the modal opens with a different def
	let seededFor = null;
	$: if ($nodeDesignerOpen && $nodeDesignerOpen !== seededFor) {
		seededFor = $nodeDesignerOpen;
		const def = $nodeDesignerOpen;
		if (def === 'new') {
			editingId = null;
			name = 'My node';
			params = [{ key: 'speed', kind: 'range', min: 0, max: 10, step: 0.1 }];
			code =
				'// object, base ({pos, rot, scale, visible}), data, time\n' +
				'// node controls arrive in data (data.speed here)\n' +
				'object.rotation.y = base.rot[1] + time * (data.speed ?? 1);\n';
		} else {
			editingId = def.id;
			name = def.name;
			params = (def.params ?? []).map((p) => ({ ...p, options: p.options ? [...p.options] : undefined }));
			code = def.code ?? '';
		}
	}
	$: if (!$nodeDesignerOpen) seededFor = null;

	function addParam() {
		params = [...params, { key: 'param' + (params.length + 1), kind: 'range', min: 0, max: 10, step: 0.1 }];
	}

	function removeParam(index) {
		params = params.filter((_, i) => i !== index);
	}

	function save() {
		if (!name.trim()) return;
		saveNodeDef({
			id: editingId ?? crypto.randomUUID(),
			name: name.trim(),
			params: params
				.filter((p) => p.key.trim())
				.map((p) =>
					p.kind === 'select'
						? { key: p.key.trim(), kind: 'select', options: (p.optionsText ?? (p.options ?? []).join(',')).split(',').map((s) => s.trim()).filter(Boolean) }
						: { key: p.key.trim(), kind: 'range', min: +p.min || 0, max: +p.max || 10, step: +p.step || 0.1 }
				),
			code: code
		});
		nodeDesignerOpen.set(null);
	}

	function remove() {
		if (editingId) deleteNodeDef(editingId);
		nodeDesignerOpen.set(null);
	}
</script>

{#if $nodeDesignerOpen}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
		<div class="flex h-[80vh] w-[640px] max-w-[95vw] flex-col gap-2 rounded-lg bg-gray-800 p-4 text-white shadow-xl">
			<div class="flex items-center justify-between">
				<span class="text-lg font-semibold">{editingId ? 'Edit node definition' : 'New custom node'}</span>
				<button class="rounded bg-gray-600 px-2" on:click={() => nodeDesignerOpen.set(null)}>✕</button>
			</div>

			<label class="flex items-center gap-2 text-sm">
				Name
				<input class="flex-1 rounded bg-gray-700 px-2 py-1" bind:value={name} placeholder="Wobble" />
			</label>

			<div class="text-sm">
				<div class="mb-1 flex items-center justify-between">
					<span>Controls</span>
					<button class="rounded bg-gray-600 px-2 text-xs" on:click={addParam}>+ add</button>
				</div>
				<div class="flex max-h-40 flex-col gap-1 overflow-y-auto">
					{#each params as param, index}
						<div class="flex items-center gap-1 text-xs">
							<input class="w-24 rounded bg-gray-700 px-1 py-0.5" bind:value={param.key} placeholder="key" />
							<select class="rounded bg-gray-700 px-1 py-0.5" bind:value={param.kind}>
								<option value="range">range</option>
								<option value="select">select</option>
							</select>
							{#if param.kind === 'range'}
								<input class="w-14 rounded bg-gray-700 px-1 py-0.5" type="number" bind:value={param.min} placeholder="min" />
								<input class="w-14 rounded bg-gray-700 px-1 py-0.5" type="number" bind:value={param.max} placeholder="max" />
								<input class="w-14 rounded bg-gray-700 px-1 py-0.5" type="number" bind:value={param.step} placeholder="step" />
							{:else}
								<input
									class="flex-1 rounded bg-gray-700 px-1 py-0.5"
									value={param.optionsText ?? (param.options ?? []).join(',')}
									on:input={(e) => (param.optionsText = e.currentTarget.value)}
									placeholder="red,green,blue"
								/>
							{/if}
							<button class="rounded bg-gray-600 px-1" on:click={() => removeParam(index)}>✕</button>
						</div>
					{/each}
				</div>
			</div>

			<span class="text-sm">Code (object, base, data, time — controls arrive in data)</span>
			<div class="min-h-0 flex-1">
				<CodeEditor value={code} onChange={(c) => (code = c)} />
			</div>

			<div class="flex justify-between">
				{#if editingId}
					<button class="rounded bg-red-700 px-3 py-1" on:click={remove}>Delete definition</button>
				{:else}
					<span></span>
				{/if}
				<button class="rounded bg-[#ff4000] px-3 py-1" on:click={save}>Save for everyone</button>
			</div>
		</div>
	</div>
{/if}
