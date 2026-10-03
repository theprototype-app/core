// 34 R2 (kit-entities) — kit.health's kit row (hit points on kit entities; runtime: kit/entities.js).
import spec from './health.spec.js';
import { entityPiece } from './entityHub.js';

export const healthPiece = entityPiece(spec, ['damage', 'damageArea', 'heal', 'revive'], false);
