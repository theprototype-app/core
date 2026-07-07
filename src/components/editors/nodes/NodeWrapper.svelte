<script lang="ts">
	export let type: string;
	export let label: string = '';
</script>

<div
	class="flex h-full flex-col rounded-2xl border border-solid border-gray-200 bg-white/70 shadow-[0_7px_9px_0_rgba(0,0,0,0.02)]"
>
	<div
		class="family-mono rounded-t-2xl border-b border-solid border-gray-200 px-3 py-2 font-mono text-xs font-semibold text-[#0F172A]"
	>
		{label ? label : type}
	</div>
	<div
		class="family-sans relative flex rounded-b-2xl bg-white p-3 text-xs font-light text-[#757575]"
	>
		<slot />
	</div>
</div>
