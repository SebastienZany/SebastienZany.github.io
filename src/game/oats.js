// Oats: the food the player drops on the body.
//
// This file owns the list of oats and the rules about them: where one may be
// placed, how many there can be, and how an oat's food fades with time. It
// does not draw anything and does not know how the slime uses the food.

// Distances are at slime size 1; createOats scales them by the game's slime size.
export const OATS = Object.freeze({
  radiusWorld: 0.3897,          // reach of an oat's food
  power: 1.55,                  // food at its centre when fresh
  maxCount: 64,
  // A new oat is refused within this distance of another, measured along the
  // skin, or within the shorter straight-line distance through the body.
  minSkinDistanceWorld: 0.974,
  minStraightDistanceWorld: 0.48,
  // An oat's food eases down to this fraction of its power over this long.
  decayTo: 1 / 3,
  decayDurationMs: 90000,
  decayTickMs: 250,
});

const smooth = (t) => t * t * (3 - 2 * t);

export function createOats({ surface, sizeScale = 1 }) {
  const radiusWorld = OATS.radiusWorld * sizeScale;
  const minSkinDistanceWorld = OATS.minSkinDistanceWorld * sizeScale;
  const minStraightDistanceWorld = OATS.minStraightDistanceWorld * sizeScale;
  const oats = [];
  let nextId = 1;
  let nextDecayAtMs = Infinity;
  let changed = true;

  function tooClose(hit) {
    return oats.some((oat) =>
      hit.point.distanceTo(oat.point) < minStraightDistanceWorld
      || surface.worldDistance(hit.uv, oat.uv) < minSkinDistanceWorld);
  }

  return {
    /** The live list. Treat it as read-only. */
    list: oats,
    get initial() { return oats.find((oat) => oat.initial) ?? null; },

    /**
     * Try to place an oat where the player pointed.
     * @param hit a surface.raycast() result
     * @returns {{ oat, evicted } | { rejected: 'off-body' | 'too-close' }}
     */
    place(hit, now, { initial = false } = {}) {
      if (!surface.isOnBody(hit.uv)) return { rejected: 'off-body' };
      if (!initial && tooClose(hit)) return { rejected: 'too-close' };
      // At the limit, the oldest oat the player placed makes room. The first oat stays.
      let evicted = null;
      if (oats.length >= OATS.maxCount) {
        const index = oats.findIndex((oat) => !oat.initial);
        if (index >= 0) [evicted] = oats.splice(index, 1);
      }
      const oat = {
        id: nextId++,
        uv: { x: hit.uv.x, y: hit.uv.y },
        point: hit.point.clone(),
        normal: hit.normal.clone(),
        initial,
        createdAtMs: now,
        power: OATS.power,
        decayStartedAtMs: null,
        decay: 1,
      };
      oats.push(oat);
      changed = true;
      return { oat, evicted };
    },

    /** Start an oat's food fading (the first oat: at once; the others: when their story starts). */
    startDecay(oat, now) {
      if (oat.decayStartedAtMs !== null) return;
      oat.decayStartedAtMs = now;
      nextDecayAtMs = 0;
    },

    clear() {
      oats.length = 0;
      nextDecayAtMs = Infinity;
      changed = true;
    },

    /** Advance the fading. Returns true when the food the organism sees has changed since the last call. */
    update(now) {
      if (now >= nextDecayAtMs) {
        let stillFading = false;
        for (const oat of oats) {
          if (oat.decayStartedAtMs === null) continue;
          const progress = Math.min(1, Math.max(0, (now - oat.decayStartedAtMs) / OATS.decayDurationMs));
          const decay = 1 + (OATS.decayTo - 1) * smooth(progress);
          if (Math.abs(decay - oat.decay) >= 0.0005) {
            oat.decay = decay;
            changed = true;
          }
          if (progress < 1) stillFading = true;
        }
        nextDecayAtMs = stillFading ? now + OATS.decayTickMs : Infinity;
      }
      const result = changed;
      changed = false;
      return result;
    },

    /** The oats as the slime model wants them. */
    asFood() {
      return oats.map((oat) => ({ uv: oat.uv, radiusWorld, power: oat.power * oat.decay }));
    },
  };
}
