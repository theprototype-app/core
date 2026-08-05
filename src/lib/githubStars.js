import { writable } from 'svelte/store';

// 15-M: the repo's GitHub star count, for the Welcome overlay's GitHub link.
// Deliberately tiny and FAIL-QUIET: unauthenticated api.github.com allows 60
// requests/hour/IP, and a self-hosted instance may have no internet at all, so
// the count is cached and simply hidden when unavailable — never a 0, never an
// error row. (The cloud plugin carries its own copy of this ~15-line logic: it
// is a separate build and cannot import core modules.)

const REPO = 'theprototype-app/core';
const CACHE_KEY = 'gh:stars:core';
const TTL = 12 * 60 * 60 * 1000; // 12h — stars move slowly; one fetch per session

/** @type {import('svelte/store').Writable<number|null>} null = unknown, hide it */
export const githubStars = writable(null);

let started = false;

/** Read the cached count (fresh or stale) @returns {{n: number, ts: number}|null} */
function cached() {
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const entry = JSON.parse(raw);
		return typeof entry?.n === 'number' ? entry : null;
	} catch {
		return null;
	}
}

/**
 * Publish the star count: the cached value immediately (even when stale, so the
 * UI never flickers), then a background refresh once the TTL has passed.
 */
export function loadGithubStars() {
	if (started || typeof window === 'undefined') return;
	started = true;
	const entry = cached();
	if (entry) githubStars.set(entry.n);
	if (entry && Date.now() - entry.ts < TTL) return; // still fresh
	fetch('https://api.github.com/repos/' + REPO, { headers: { Accept: 'application/vnd.github+json' } })
		.then((res) => (res.ok ? res.json() : null))
		.then((data) => {
			const n = data?.stargazers_count;
			if (typeof n !== 'number') return; // rate limited / offline — keep the cache
			githubStars.set(n);
			try {
				localStorage.setItem(CACHE_KEY, JSON.stringify({ n, ts: Date.now() }));
			} catch {}
		})
		.catch(() => {}); // offline / blocked: the link renders without a count
}
