// 102-splats: what each splat object is doing on THIS device (a leaf store; the Inspector reads it,
// splatRuntime writes it): uuid -> {state: 'loading'|'waiting'|'ready'|'error', error?, shown}.
import { writable } from 'svelte/store';

/** @type {import('svelte/store').Writable<Record<string, {state: string, error?: string, shown: boolean}>>} */
export const splatStatus = writable({});
