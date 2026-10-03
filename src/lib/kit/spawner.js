// 34 R2 (kit-entities) — kit.spawner v2's kit row (the runtime is kit/entities.js, shared with
// kit.health and kit.mover through kit/entityHub.js). The spawner is the PRIMARY entity piece:
// it ticks the shared runtime, receives the `kitentity` wire and answers the handshake.
import spec from './spawner.spec.js';
import { entityPiece } from './entityHub.js';

export const spawnerPiece = entityPiece(
	spec,
	['spawn', 'despawn', 'clear', 'clearOwned', 'setTags', 'setData'],
	true
);
