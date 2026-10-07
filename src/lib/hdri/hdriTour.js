// 37-hdri — the "Sky image" tour (T1): two steps the first time the HDRI cards are shown
// (Configure Scene ▸ Environment). Registered with the built-in tours, so Settings ▸ Tours can
// replay it; HdriSection auto-starts it through the engine's own gate (never twice, never over
// another tour, never under test unless the suite opts in).

export const HDRI_TOUR = 'env-hdri';

/** @type {import('../tours/engine.js').TourStep[]} */
export const HDRI_STEPS = [
	{
		id: 'cards',
		title: 'Light the scene with a real sky',
		body: 'Pick a sky image: it becomes the background AND lights every object — reflections included, water too. Everyone in the session sees it.',
		target: 'env-hdri'
	},
	{
		id: 'knobs',
		title: 'Make it yours',
		body: 'Upload your own .hdr or .exr, turn the sky with Rotation (the sun and its shadows turn with it), set how strong its light is, or keep only the light with "Show as sky" off. Exposure above brightens or darkens the whole picture.',
		target: 'env-hdri',
		placement: 'left'
	}
];
