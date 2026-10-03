// 34 R2 (kit-entities) — kit.mover's kit row (steering for kit entities; core: kit/moverCore.js).
import spec from './mover.spec.js';
import { entityPiece } from './entityHub.js';

export const moverPiece = entityPiece(
	spec,
	['seek', 'arrive', 'patrol', 'stop', 'knock', 'setSpeed', 'chase', 'halt'],
	false
);
