import { DENSITY_MASS, MAX_DENSITY_RESERVE_MASS } from './constants.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** Plain-JS oracle for main.js:3706–3713 (legacy deltaFragment). */
export function resolveFoodDelta({
  food,
  density,
  uptakeRate,
  depositRate,
  deltaScale,
  dt,
  foodClamp,
  densityMass = DENSITY_MASS,
  exposureCap = MAX_DENSITY_RESERVE_MASS,
}) {
  const nonnegativeFood = Math.max(food, 0);
  const nonnegativeDensity = Math.max(density, 0);
  const agentLoad = Math.min(nonnegativeDensity / densityMass, exposureCap);
  const exposure = agentLoad * deltaScale * dt;
  const deposited = depositRate * exposure;
  const uptake = nonnegativeFood * (1 - Math.exp(-uptakeRate * exposure));
  return clamp(nonnegativeFood + deposited - uptake, 0, foodClamp);
}

/** Plain-JS oracle for main.js:3076–3082 (forced oat rationing). */
export function rationedOatFood({
  oatFood,
  localDensity,
  uptakeRate,
  oatSupplyRate,
  densityMass = DENSITY_MASS,
  enabled = true,
}) {
  if (!enabled || oatFood <= 0) return oatFood;
  const localReserveLoad = Math.max(localDensity / Math.max(densityMass, 0.00001), 1);
  const requestedUptake = localReserveLoad * uptakeRate * oatFood;
  const supply = Math.max(oatSupplyRate, 0.00001);
  const ration = clamp(supply / Math.max(requestedUptake, supply), 0, 1);
  return oatFood * ration;
}
