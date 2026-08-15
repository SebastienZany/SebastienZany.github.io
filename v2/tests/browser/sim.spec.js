import { appendFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  crowdProfileResidual,
  crowdProfileResidualSvg,
  legacyCrowdProfile,
  realizedCrowdProfile,
} from '../../src/sim/crowd-profile.js';
import { resolveFoodDelta } from '../../src/sim/delta-oracle.js';
import { test, expect } from './gpu-fixture.js';

test.describe.configure({ timeout: 180_000 });

const smallQuery = 'field=64&cap=512&seed=96&rng=73&paused=1';

test('state-set determinism and complete snapshot continuation pass twice', async ({ page }) => {
  for (let run = 0; run < 2; run += 1) {
    const first = await deterministicRun(page, smallQuery, 500);
    const second = await deterministicRun(page, smallQuery, 500);
    expect(second).toBe(first);
  }

  await openSim(page, smallQuery);
  await noBirthParams(page);
  await stepMany(page, 250);
  const snapshot = await portableSnapshot(page);
  expect(snapshot.header).toEqual({
    schemaVersion: 1,
    manifestRootHash: 'flat-torus-v1',
    fieldSize: 64,
    capacity: 512,
  });
  expect(snapshot.metadata).toEqual(expect.objectContaining({
    stepIndex: 250,
    controllerState: expect.any(Object),
    params: expect.any(Object),
    oats: expect.any(Array),
    handOutCursor: 0,
    timebase: expect.any(Object),
  }));
  await stepMany(page, 250);
  const continued = await page.evaluate(() => window.__v2.sim.hashState());

  await openSim(page, smallQuery);
  await page.evaluate((saved) => window.__v2.sim.restore(saved), snapshot);
  await stepMany(page, 250);
  expect(await page.evaluate(() => window.__v2.sim.hashState())).toBe(continued);

  await expect(page.evaluate((saved) => {
    saved.header.manifestRootHash = 'rebaked-atlas-with-different-uvs';
    return window.__v2.sim.restore(saved);
  }, structuredClone(snapshot))).rejects.toThrow(/manifest root hash/);
});

test('indirect and capacity dispatch have the same below-capacity state set', async ({ page }) => {
  await openSim(page, 'field=64&cap=1024&seed=80&rng=91&paused=1');
  await noBirthParams(page);
  const initial = await portableSnapshot(page);
  await stepMany(page, 200);
  const indirect = await page.evaluate(() => window.__v2.sim.hashState());
  await page.evaluate((saved) => window.__v2.sim.restore(saved), initial);
  await page.evaluate(() => {
    for (let index = 0; index < 200; index += 1) window.__v2.sim.step(1, { capacityDispatch: true });
  });
  const capacity = await page.evaluate(() => window.__v2.sim.hashState());
  expect(capacity).toBe(indirect);
});

test('legacy wall-clock and fixed-tick variants are deterministic when elapsed time is pinned', async ({ page }) => {
  const elapsed = [8.3, 8.4, 16.6667, 25, 4.2, 29.1];
  for (const fixedTick of [false, true]) {
    const query = `field=64&cap=512&seed=64&rng=19&paused=1${fixedTick ? '&fixedtick=1' : ''}`;
    const hashes = [];
    for (let run = 0; run < 2; run += 1) {
      await openSim(page, query);
      await noBirthParams(page);
      hashes.push(await page.evaluate(async (durations) => {
        for (let frame = 0; frame < 240; frame += 1) {
          window.__v2.sim.advance(durations[frame % durations.length]);
        }
        return window.__v2.sim.hashState();
      }, elapsed));
    }
    expect(hashes[1]).toBe(hashes[0]);
  }
});

test('two-phase saturation preserves every parent and finalizes an exact count', async ({ page }) => {
  await openSim(page, 'field=64&cap=64&seed=64&rng=12&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    const before = await sim.readAgents();
    const field = new Float32Array(sim.fieldSize * sim.fieldSize);
    await sim.debugReplaceState({
      agents: before.map((agent) => ({ ...agent, reserve: 4 })),
      field,
    });
    const survivorIds = new Set(before.map(({ idHi, idLo }) => `${idHi}:${idLo}`));
    sim.step(0);
    const after = await sim.readAgents();
    return {
      allSurvive: after.every(({ idHi, idLo }) => survivorIds.has(`${idHi}:${idLo}`)),
      count: await sim.count(),
      diagnostics: await sim.allocatorDiagnostics(),
    };
  });
  expect(result.allSurvive).toBe(true);
  expect(result.count).toBe(64);
  expect(result.diagnostics.ownershipViolations).toBe(0);
  expect(result.diagnostics.rejectedChildren).toBeGreaterThan(0);
});

test('movement and diffusion are translationally identical across torus boundaries', async ({ page }) => {
  await openSim(page, 'field=64&cap=8&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      stepSize: 0.003,
      minMoveScale: 0.6,
      wander: 0,
      sensorDistance: 0,
      fieldDecay: 1,
      reproThreshold: 4.5,
      maxReserve: 4.2,
    });
    const uniform = new Float32Array(64 * 64).fill(0.3);
    await sim.debugReplaceState({
      agents: [{ uvPos: [0.9995, 0.5], heading: 0, reserve: 2, idLo: 1, idHi: 2, flags: 0 }],
      field: uniform,
    });
    sim.step(1);
    const wrappedAgent = (await sim.readAgents())[0];

    const evolveBlob = async (x, y) => {
      const field = new Float32Array(64 * 64);
      field[y * 64 + x] = 0.5;
      await sim.debugReplaceState({ field });
      sim.step(0);
      return [...await sim.readField()];
    };
    const border = await evolveBlob(0, 7);
    const interior = await evolveBlob(32, 7);
    let maxTranslatedDifference = 0;
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 64; x += 1) {
        const shiftedX = (x + 32) % 64;
        maxTranslatedDifference = Math.max(maxTranslatedDifference,
          Math.abs(border[y * 64 + x] - interior[y * 64 + shiftedX]));
      }
    }
    return { wrappedAgent, maxTranslatedDifference };
  });
  expect(result.wrappedAgent.uvPos[0]).toBeLessThan(0.01);
  expect(result.wrappedAgent.heading).toBeCloseTo(0, 5);
  expect(result.maxTranslatedDifference).toBeLessThan(1e-7);
});

test('border translation accumulates no growth bias over 1000 steps', async ({ page }) => {
  await openSim(page, 'field=64&cap=16&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      stepSize: 0,
      wander: 0,
      sensorDistance: 0,
      fieldDecay: 1,
      reproThreshold: 4.5,
      maxReserve: 4.2,
    });
    const agents = [];
    for (let index = 0; index < 4; index += 1) {
      agents.push({ uvPos: [(index + 0.5) / 64, 0.2], heading: 0, reserve: 2, idLo: index + 1, idHi: 1, flags: 0 });
      agents.push({ uvPos: [0.5 + (index + 0.5) / 64, 0.7], heading: 0, reserve: 2, idLo: index + 1, idHi: 2, flags: 0 });
    }
    await sim.debugReplaceState({ agents, field: new Float32Array(64 * 64).fill(0.4) });
    for (let step = 0; step < 1000; step += 1) sim.step(1);
    const final = await sim.readAgents();
    const first = final.filter(({ idHi }) => idHi === 1).reduce((sum, agent) => sum + agent.reserve, 0);
    const second = final.filter(({ idHi }) => idHi === 2).reduce((sum, agent) => sum + agent.reserve, 0);
    return { first, second, count: final.length, nonFinite: await sim.scanFinite() };
  });
  expect(result.count).toBe(8);
  expect(Math.abs(result.first - result.second)).toBeLessThan(1e-5);
  expect(result.nonFinite).toBe(0);
});

test('field decay is analytic and final-agent exposure measurably depletes food', async ({ page }) => {
  await openSim(page, 'field=64&cap=64&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, { fieldDiffusion: 0, fieldDecay: 0.99 });
    await sim.debugReplaceState({ field: new Float32Array(64 * 64).fill(0.4) });
    for (let index = 0; index < 10; index += 1) sim.step(1);
    const decayed = (await sim.readField())[0];

    const patch = new Float32Array(64 * 64);
    patch.fill(0.05);
    for (let y = 28; y < 36; y += 1) for (let x = 28; x < 36; x += 1) patch[y * 64 + x] = 0.5;
    await sim.debugReplaceState({ field: patch });
    for (let index = 0; index < 8; index += 1) sim.step(1);
    const control = (await sim.readField())[32 * 64 + 32];
    const agents = Array.from({ length: 32 }, (_, index) => ({
      uvPos: [32.5 / 64, 32.5 / 64], heading: 0, reserve: 2,
      idLo: index + 1, idHi: 9, flags: 0,
    }));
    Object.assign(sim.params, { stepSize: 0, wander: 0, sensorDistance: 0, reproThreshold: 4.5, maxReserve: 4.2 });
    await sim.debugReplaceState({ agents, field: patch });
    for (let index = 0; index < 8; index += 1) sim.step(1);
    const depleted = (await sim.readField())[32 * 64 + 32];
    return { decayed, control, depleted };
  });
  expect(result.decayed).toBeCloseTo(0.4 * (0.99 ** 10), 5);
  expect(result.depleted).toBeLessThan(result.control - 0.01);
});

test('GPU delta pass agrees numerically with the anchored plain-JS oracle', async ({ page }) => {
  await openSim(page, 'field=64&cap=32&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      fieldDiffusion: 0,
      fieldDecay: 1,
      uptakeRate: 0.035,
      depositRate: 0.005,
      burnRate: 0.005,
      deltaScale: 1.35,
      foodClamp: 0.5,
      stepSize: 0,
      wander: 0,
      sensorDistance: 0,
      reproThreshold: 4.5,
      maxReserve: 4.2,
    });
    sim.clearOats();
    const samples = [
      { x: 7, y: 9, food: 0.12, reserve: 1.25 },
      { x: 19, y: 33, food: 0.38, reserve: 3.5 },
      { x: 48, y: 51, food: 0.49, reserve: 4.1 },
    ];
    const field = new Float32Array(64 * 64);
    const agents = samples.map((sample, index) => {
      field[sample.y * 64 + sample.x] = sample.food;
      return {
        uvPos: [(sample.x + 0.5) / 64, (sample.y + 0.5) / 64],
        heading: 0,
        reserve: sample.reserve,
        idLo: index + 1,
        idHi: 5,
        flags: 0,
      };
    });
    await sim.debugReplaceState({ agents, field });
    sim.step(0.75);
    const gpuField = await sim.readField();
    return {
      params: { ...sim.params },
      samples: samples.map((sample) => ({ ...sample, gpu: gpuField[sample.y * 64 + sample.x] })),
    };
  });
  for (const sample of result.samples) {
    const finalReserve = Math.min(result.params.maxReserve,
      sample.reserve + (result.params.uptakeRate * sample.food
        - result.params.depositRate - result.params.burnRate) * 0.75);
    const fixedDensity = Math.round(finalReserve * 0.032 * 256) / 256;
    const expected = resolveFoodDelta({
      food: Math.fround(sample.food),
      density: fixedDensity,
      uptakeRate: result.params.uptakeRate,
      depositRate: result.params.depositRate,
      deltaScale: result.params.deltaScale,
      dt: 0.75,
      foodClamp: result.params.foodClamp,
    });
    expect(sample.gpu).toBeCloseTo(expected, 5);
  }
});

test('oats max-compose, clear immediately, ration, and honor all 64 records', async ({ page }) => {
  await openSim(page, 'field=64&cap=8&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    sim.setOats([
      { uvPos: [32.5 / 64, 32.5 / 64], radiusUv: 0.01, peakFood: 0.3 },
      { uvPos: [32.5 / 64, 32.5 / 64], radiusUv: 0.01, peakFood: 0.6 },
    ]);
    sim.step(0);
    const overlap = (await sim.readOatField())[32 * 64 + 32];
    sim.clearOats();
    sim.step(0);
    const clearedMax = Math.max(...await sim.readOatField());
    const oats = Array.from({ length: 64 }, (_, index) => ({
      uvPos: [((index % 8) * 8 + 0.5) / 64, (Math.floor(index / 8) * 8 + 0.5) / 64],
      radiusUv: 0.001,
      peakFood: 0.1 + index * 0.005,
    }));
    sim.setOats(oats);
    sim.step(0);
    const honored = sim.oats().length;
    const oatField = await sim.readOatField();
    const lastOat = oatField[56 * 64 + 56];

    const reserveAfter = async (rationing) => {
      sim.setOats([{ uvPos: [0.5, 0.5], radiusUv: 0.02, peakFood: 0.8 }]);
      Object.assign(sim.params, {
        useOatRationing: rationing,
        oatSupplyRate: 0.001,
        uptakeRate: 0.09,
        depositRate: 0,
        burnRate: 0,
        stepSize: 0,
        wander: 0,
        sensorDistance: 0,
        reproThreshold: 4.5,
      });
      await sim.debugReplaceState({
        agents: [{ uvPos: [0.5, 0.5], heading: 0, reserve: 2, idLo: 1, idHi: 1, flags: 0 }],
      });
      sim.step(1);
      return (await sim.readAgents())[0].reserve;
    };
    return { overlap, clearedMax, honored, lastOat, rationed: await reserveAfter(true), full: await reserveAfter(false) };
  });
  expect(result.overlap).toBeCloseTo(0.6, 4);
  expect(result.clearedMax).toBe(0);
  expect(result.honored).toBe(64);
  expect(result.lastOat).toBeCloseTo(0.415, 4);
  expect(result.full).toBeGreaterThan(result.rationed);
});

test('half-texel crowd probe follows nearest density sensing, not bilinear interpolation', async ({ page }) => {
  await openSim(page, 'field=64&cap=8&seed=0&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      densityBlur: 1,
      densityTarget: 0.1,
      crowdWeight: 0.1,
      crowdExponent: 1,
      foodWeight: 0,
      sensorAngle: Math.PI / 2,
      sensorDistance: 0.5 / 64,
      turnAngle: 0.34,
      wander: 0,
      stepSize: 0.003,
      minMoveScale: 0,
      reproThreshold: 4.5,
      maxReserve: 4.2,
      fieldDecay: 1,
    });
    sim.clearOats();
    const probe = { uvPos: [32.5 / 64, 32.5 / 64], heading: 0, reserve: 0.1, idLo: 1, idHi: 1, flags: 0 };
    const crowdSource = { uvPos: [32.5 / 64, 33.5 / 64], heading: 0, reserve: 2, idLo: 2, idHi: 1, flags: 0 };
    await sim.debugReplaceState({ agents: [probe, crowdSource] });
    sim.step(1);
    const agents = await sim.readAgents();
    return agents.find(({ idLo }) => idLo === 1);
  });
  const density = Math.round((2 * 0.032) * 255) / 255;
  const stayDensity = Math.round((0.1 * 0.032) * 255) / 255;
  const preference = crowdPreference(density, 0.1) * 0.1 - crowdPreference(stayDensity, 0.1) * 0.1;
  const moveScale = smoothstep(0, 0.08, preference);
  const expectedY = 32.5 / 64 + Math.sin(0.34) * 0.003 * moveScale;
  expect(result.heading).toBeCloseTo(0.34, 5);
  expect(result.uvPos[1]).toBeCloseTo(expectedY, 5);
});

test('population target step follows the ported timing, EMA, log-supply, and secondary law', async ({ page }) => {
  await openSim(page, 'field=64&cap=2000&seed=0&paused=1');
  const primary = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      usePopulationControl: true,
      populationTarget: 1000,
      populationControlPeriodMs: 1200,
      oatSupplyRate: 0.14,
    });
    const setCount = (count) => sim.debugReplaceState({
      agents: Array.from({ length: count }, (_, index) => ({
        uvPos: [0.5, 0.5], heading: 0, reserve: 2,
        idLo: index + 1, idHi: 4, flags: 0,
      })),
    });
    await setCount(1000);
    await sim.samplePopulation(0);
    sim.params.populationTarget = 800;
    await sim.samplePopulation(600);
    const skipped = sim.controllerState();
    const first = await sim.samplePopulation(1200);
    await setCount(1100);
    const second = await sim.samplePopulation(2400);
    const third = await sim.samplePopulation(3600);
    await setCount(808);
    const insideTolerance = await sim.samplePopulation(4800);
    return { skipped, first, second, third, insideTolerance, supplyBeforeTolerance: third.lastOatSupplyRate };
  });
  expect(primary.skipped.lastSampleTime).toBe(0);
  expect(primary.first.commandedGrowthRate).toBeCloseTo(-0.006694306539426292, 10);
  expect(primary.first.lastOatSupplyRate).toBeCloseTo(0.1395788932853929, 10);
  expect(primary.second.growthRate).toBeCloseTo(0.019856287459234328, 10);
  expect(primary.third.growthRate).toBeCloseTo(0.014892215594425745, 10);
  expect(primary.supplyBeforeTolerance).toBeCloseTo(0.13623684896842575, 10);
  expect(Math.abs(primary.insideTolerance.commandedGrowthRate)).toBe(0);
  expect(primary.insideTolerance.target).toBe(800);

  await openSim(page, 'field=64&cap=2000&seed=0&paused=1');
  const secondary = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    Object.assign(sim.params, {
      usePopulationControl: true,
      populationTarget: 1000,
      oatSupplyRate: 0.001,
      populationUseSecondaryActuator: true,
    });
    const setCount = (count) => sim.debugReplaceState({
      agents: Array.from({ length: count }, (_, index) => ({
        uvPos: [0.5, 0.5], heading: 0, reserve: 2,
        idLo: index + 1, idHi: 6, flags: 0,
      })),
    });
    await setCount(1500);
    await sim.samplePopulation(0);
    await setCount(1700);
    const state = await sim.samplePopulation(1200);
    return { state, burnRate: sim.params.burnRate, reproThreshold: sim.params.reproThreshold };
  });
  expect(secondary.state.saturatedLow).toBe(true);
  expect(secondary.state.secondarySeverity).toBeCloseTo(0.16, 10);
  expect(secondary.burnRate).toBeCloseTo(0.0082, 10);
  expect(secondary.reproThreshold).toBeCloseTo(3.16, 10);
});

test('GPU crowd profile matches the strengthened CPU oracle across phases and superposition', async ({ page }, testInfo) => {
  const size = 512;
  await openSim(page, `field=${size}&cap=16&seed=0&paused=1`);
  for (const densityBlur of [1, 30, 64]) {
    const scenarios = [0.17, 0.5, 0.83].map((phase) => ([{
      texelX: 256 + phase, texelY: 256.37, reserve: 4.2,
    }])).concat([[
      { texelX: 255.13, texelY: 254.38, reserve: 2.5 },
      { texelX: 257.27, texelY: 256.44, reserve: 4.1 },
      { texelX: 256.61, texelY: 258.28, reserve: 3.8 },
    ]]);
    for (const [scenarioIndex, agents] of scenarios.entries()) {
      const gpu = await page.evaluate(async ({ agents, densityBlur, size }) => {
        const sim = window.__v2.sim;
        sim.params.densityBlur = densityBlur;
        await sim.debugReplaceState({
          agents: agents.map((agent, index) => ({
            uvPos: [agent.texelX / size, agent.texelY / size],
            heading: 0,
            reserve: agent.reserve,
            idLo: index + 1,
            idHi: 8,
            flags: 0,
          })),
        });
        sim.step(0);
        return [...await sim.readDensityField()];
      }, { agents, densityBlur, size });
      const realized = realizedCrowdProfile({ size, agents, densityBlur, fieldSize: size });
      const legacy = legacyCrowdProfile({ size, agents, densityBlur, fieldSize: size });
      expect(maxDifference(gpu, realized)).toBeLessThanOrEqual(1 / 255 + 1e-6);
      const residual = crowdProfileResidual(legacy, gpu);
      expect(residual.normalizedRmse).toBeLessThanOrEqual(0.045);
      expect(residual.normalizedMax).toBeLessThanOrEqual(0.75);
      if (scenarioIndex === scenarios.length - 1) {
        await testInfo.attach(`crowd-profile-${densityBlur}.svg`, {
          body: Buffer.from(crowdProfileResidualSvg(legacy, gpu, size, {
            title: `densityBlur=${densityBlur}, reserve-weighted superposition`,
          })),
          contentType: 'image/svg+xml',
        });
      }
    }
  }
});

test('NaN scan stays zero and the population can grow then saturate safely', async ({ page }) => {
  await openSim(page, 'field=64&cap=65000&seed=60000&rng=7&paused=1');
  const result = await page.evaluate(async () => {
    const sim = window.__v2.sim;
    const snapshot = await sim.snapshot();
    snapshot.field.fill(0.5);
    await sim.restore(snapshot);
    Object.assign(sim.params, { reproThreshold: 2, fieldDecay: 1 });
    let minimum = 60000;
    for (let index = 0; index < 100; index += 1) {
      sim.step(1);
      if (index % 10 === 9) minimum = Math.min(minimum, await sim.count());
    }
    return { count: await sim.count(), minimum, nonFinite: await sim.scanFinite() };
  });
  expect(result.count).toBeGreaterThan(60000);
  expect(result.count).toBeLessThanOrEqual(65000);
  expect(result.minimum).toBeGreaterThan(0);
  expect(result.nonFinite).toBe(0);
});

test('performance sample is recorded without becoming a gate', async ({ page }, testInfo) => {
  await openSim(page, 'field=256&cap=100000&seed=4000&rng=1&paused=1');
  const started = performance.now();
  await page.evaluate(async () => {
    for (let index = 0; index < 100; index += 1) window.__v2.sim.step(1);
    await window.__v2.sim.hashState();
  });
  const msPerStep = (performance.now() - started) / 100;
  const record = {
    recordedAt: new Date().toISOString(),
    milestone: 'M3',
    fieldSize: 256,
    capacity: 100000,
    seedCount: 4000,
    msPerStep,
    adapter: testInfo.annotations.find(({ type }) => type === 'adapter')?.description ?? 'unknown',
    informational: true,
  };
  await appendFile(new URL('../../perf-log.ndjson', import.meta.url), `${JSON.stringify(record)}\n`);
  await testInfo.attach('m3-perf.json', { body: Buffer.from(JSON.stringify(record, null, 2)), contentType: 'application/json' });
});

async function deterministicRun(page, query, steps) {
  await openSim(page, query);
  await noBirthParams(page);
  await stepMany(page, steps);
  return page.evaluate(() => window.__v2.sim.hashState());
}

async function openSim(page, query) {
  await page.goto(`/v2/dev.html?${query}`);
  await page.evaluate(() => window.__v2.ready);
  expect(await page.evaluate(() => window.__v2.uncapturedErrors)).toEqual([]);
}

async function noBirthParams(page) {
  await page.evaluate(() => Object.assign(window.__v2.sim.params, {
    reproThreshold: 4.5,
    maxReserve: 4.2,
    burnRate: 0.001,
    depositRate: 0.001,
  }));
}

async function stepMany(page, count) {
  await page.evaluate((steps) => {
    for (let index = 0; index < steps; index += 1) window.__v2.sim.step(1);
  }, count);
}

async function portableSnapshot(page) {
  return page.evaluate(async () => {
    const snapshot = await window.__v2.sim.snapshot();
    return { ...snapshot, agents: [...snapshot.agents], field: [...snapshot.field] };
  });
}

function maxDifference(left, right) {
  let maximum = 0;
  for (let index = 0; index < left.length; index += 1) maximum = Math.max(maximum, Math.abs(left[index] - right[index]));
  return maximum;
}

function crowdPreference(density, target) {
  const ratio = Math.max(density / target, 0);
  const occupied = smoothstep(0, 1, ratio);
  const rangeMaximum = Math.max(1.0001, Math.min(3, 1 / target));
  const tooCrowded = smoothstep(1, rangeMaximum, ratio);
  return occupied - tooCrowded * 2;
}

function smoothstep(low, high, value) {
  const amount = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return amount * amount * (3 - 2 * amount);
}
