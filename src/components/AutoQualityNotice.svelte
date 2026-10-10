<script>
	// 40 F12 — THE AUTO-QUALITY NOTICE. When this device lowers a quality toggle ON ITS OWN, the
	// person is told once: "Lowered water quality to keep it smooth · Keep full quality". The rule
	// (which toggles, the wording, once per toggle per session) is the pure `qualityNoticeCore`;
	// this file only watches the stores and rides the ordinary toast pipeline (kit card, the
	// notification history). It replaces two older notices: the first-step quality toast that
	// lived in the object list (gone whenever that window was closed) and SimplifiedWaterNotice.
	//
	// Only AUTOMATIC drops count (the governor's frames / long tasks, the phone's lighter start):
	// a game's own Quality preset, the headset's entry floor and the person's own picks are not
	// news. Never shown in Play or in a headset — a drop there waits until you are back.
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { qualityOverrides, qualityState, keepFullQuality } from '$lib/qualityGovernor';
	import { simplifiedWater } from '$lib/water/simplifiedNotice.js';
	import { newlyLowered, toAnnounce, noticeText, KEEP_FULL_LABEL } from '$lib/qualityNoticeCore.js';
	import { FULL_QUALITY } from '$lib/qualityGovernorCore';
	import { isLocked, globalRenderer } from '../stores/sceneStore';
	import { showToast } from '../stores/appStore';

	const KEY = 'quality:announced';
	/** the reasons a level moves by itself (qualityGovernor publish reasons) */
	const AUTOMATIC = new Set(['frames', 'long tasks', 'phone: a lighter start']);
	/** a drop's store writes land over a frame or two (the water tier follows on its next tick) */
	const BATCH_MS = 400;

	function announced() {
		try {
			return JSON.parse(sessionStorage.getItem(KEY) || '[]');
		} catch {
			return [];
		}
	}
	/** @param {string[]} keys */
	function remember(keys) {
		try {
			sessionStorage.setItem(KEY, JSON.stringify([...new Set([...announced(), ...keys])]));
		} catch {}
	}

	onMount(() => {
		/** @type {import('$lib/qualityNoticeCore.js').QualitySnapshot} */
		let prev = { ...FULL_QUALITY, water: false, fluid: false };
		/** @type {Set<string>} */
		const pending = new Set();
		/** @type {any} */ let timer = null;

		const snapshot = () => ({ ...get(qualityOverrides), ...get(simplifiedWater) });
		const away = () => get(isLocked) === true || !!(/** @type {any} */ (get(globalRenderer))?.xr?.isPresenting);

		function flush() {
			timer = null;
			if (!pending.size || away()) return; // kept until leaving Play / the headset
			const keys = toAnnounce([...pending], announced());
			pending.clear();
			if (!keys.length) return;
			remember(keys);
			showToast(noticeText(keys), [{ label: KEEP_FULL_LABEL, action: () => keepFullQuality() }]);
		}
		function schedule() {
			if (!timer) timer = setTimeout(flush, BATCH_MS);
		}
		function check() {
			const next = snapshot();
			const keys = newlyLowered(prev, next);
			prev = next;
			if (!keys.length || !AUTOMATIC.has(get(qualityState).reason)) return;
			for (const k of keys) pending.add(k);
			schedule();
		}

		// a level change writes qualityOverrides BEFORE qualityState (publish), so the reason
		// that caused it is only readable once the write is finished: judge in a microtask
		let queued = false;
		function soon() {
			if (queued) return;
			queued = true;
			queueMicrotask(() => {
				queued = false;
				check();
			});
		}
		const offs = [
			qualityOverrides.subscribe(soon),
			simplifiedWater.subscribe(soon),
			isLocked.subscribe(() => pending.size && schedule())
		];
		return () => {
			offs.forEach((off) => off());
			clearTimeout(timer);
		};
	});
</script>
