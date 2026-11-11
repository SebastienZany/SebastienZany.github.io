// The SlimeModel interface, and the list of behavioural models that implement it.
//
// A slime model is the organism: how it moves, feeds, spreads and dies on the
// body. The game mechanics (oats, stories, the intro and ending) and the
// renderer know nothing about how a model works inside. They only:
//
//   - tell it where food is and where the player's pointer disturbs it,
//   - ask it to grow a colony somewhere,
//   - step it once per frame,
//   - read `thickness`, a texture in the body's atlas saying how much slime is
//     on each texel, and ask how much slime is near a few points.
//
// To try a different behavioural model, add a folder next to `physarum/` whose
// index.js exports a factory with the shape below, list it in SLIME_MODELS,
// and load the page with ?slime=<id>. Nothing else in the game changes.
// `mould/` is a complete model in one short file; start from a copy of it.
// `shared/` has the two pieces most models want: the oats painted into the
// atlas as a food texture, and the coverage query.
//
// A model works in the atlas, so it should include SURFACE_GLSL
// (src/surface/surface-glsl.js) in its shaders: that gives it the body's
// metric (so speeds and sizes can be in world units, independent of how the
// mesh was unwrapped) and carries points across the atlas's cuts.

import { createPhysarum } from './physarum/index.js';
import { createMould } from './mould/index.js';

/**
 * @typedef {object} FoodSource      An oat, as the organism sees it.
 * @property {{x:number,y:number}} uv   where it is in the atlas
 * @property {number} radiusWorld       how far its food reaches, in world units
 * @property {number} power             how much food it offers at its centre
 *
 * @typedef {object} Disturbance     The player's pointer on the body.
 * @property {{x:number,y:number}} uv
 * @property {number} radiusWorld
 * @property {number} strength
 *
 * @typedef {object} SlimeModel
 * @property {string} id
 * @property {Array} paramSchema         tunable settings (see docs/CONTRACTS.md)
 * @property {object} params             live values of those settings
 * @property {import('three').Texture} thickness
 *   Red channel = amount of slime, 0..thicknessMax, on every texel of the body.
 *   Texels just off the body must hold the values from across the nearest cut:
 *   finish each step with surface.pad(), as physarum does.
 * @property {number} thicknessMax
 * @property {boolean} isSeeding         true while a colony is still being released
 * @property {() => void} reset          remove all slime
 * @property {(now:number, colony:{uv:{x:number,y:number}, durationMs:number}) => void} seed
 *   Grow a new colony around `uv`, released gradually over `durationMs`.
 * @property {(sources:FoodSource[]) => void} setFood
 * @property {(disturbance:Disturbance|null) => void} setDisturbance
 * @property {(now:number, dt:number) => void} step
 *   Advance one frame. dt is in sixtieths of a second (1 = a frame at 60 Hz).
 * @property {(uvs:Array<{x:number,y:number}>) => Promise<number[]>} coverageNear
 *   Peak slime thickness close to each point; the game compares it with a threshold.
 * @property {() => number} countAgents  dev statistic; may be slow (0 if the model has no agents)
 * @property {() => Float32Array} readThickness  dev statistic: `thickness` read back as RGBA floats
 * @property {() => void} dispose
 */

/**
 * id -> factory(ctx) => SlimeModel, where ctx = { gpu, surface, diag, sizeScale }.
 * sizeScale is the game's slime size (see SLIME_SIZE in src/config.js): multiply
 * every world distance of the organism by it.
 */
export const SLIME_MODELS = {
  physarum: createPhysarum,
  mould: createMould,
};

export const DEFAULT_SLIME_MODEL = 'physarum';

export function createSlimeModel(id, ctx) {
  const factory = SLIME_MODELS[id];
  if (!factory) {
    ctx.diag.log('slime', `unknown model "${id}", using ${DEFAULT_SLIME_MODEL}`);
    return SLIME_MODELS[DEFAULT_SLIME_MODEL](ctx);
  }
  return factory(ctx);
}
