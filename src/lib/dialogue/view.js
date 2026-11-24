// 92-dialogue (GC6): the ONE boot-side piece of a dialogue — what this device shows right now.
// LOCAL per peer by design (each player reads their own talk); never sent, saved or undone.
// The runtime (dialogue/runtime.js) is the single writer; the HUD box and the VR panel read it.
import { writable } from 'svelte/store';

/** @typedef {{ key: string, talk: string, nodeId: string, speaker: string, portrait: string, text: string, choices: string[], last: boolean, anchor: number[] | null }} DialogueView */

/** @type {import('svelte/store').Writable<DialogueView | null>} */
export const dialogueView = writable(null);
