import { withGpuErrorScope } from '../device.js';
import { fetchWgsl } from '../wgsl.js';
import { createWorkloadResources, destroyWorkloadResources } from './workload-resources.js';

const shaderUrl = (name) => new URL(`../shaders/${name}`, import.meta.url);

export async function runWorkloadRehearsal(device, registry, {
  size,
  durationMs = 60_000,
  supportsReadWriteStorage,
  formatCapabilities,
  onProgress = () => {},
} = {}) {
  const baselineBytes = registry.totalBytes();
  let resources;
  try {
    onProgress({ phase: 'allocation', message: `Allocating the full ${size} resource set…` });
    resources = createWorkloadResources(device, registry, size, formatCapabilities);
    const peakAllocatedBytes = registry.totalBytes() - baselineBytes;
    onProgress({ phase: 'compile', message: `Allocated ${formatBytes(peakAllocatedBytes)}; compiling workload kernels…` });
    const pipelines = await scopedPipelines(device, resources, supportsReadWriteStorage);
    await initializeNoiseFields(device, resources, pipelines);

    const actualFillPath = supportsReadWriteStorage ? 'read_write' : 'staging-copy';
    const rows = [
      workloadRow('default', actualFillPath, 1, 5, 1),
      workloadRow('worst-case-legal', actualFillPath, 8, 20, 10),
    ];
    if (supportsReadWriteStorage) rows.push(workloadRow('fallback-cost-comparison', 'staging-copy', 1, 5, 1));

    const durationPerRowMs = durationMs / rows.length;
    const results = [];
    let fieldParity = 0;
    for (const [index, row] of rows.entries()) {
      onProgress({
        phase: 'run',
        row: row.label,
        message: `${row.label}: ${row.fillPath}, ${row.blurFillPairsPerFrame} blur/fill pairs per frame…`,
        fraction: index / rows.length,
      });
      const result = await measureRow(device, resources, pipelines, row, durationPerRowMs, fieldParity);
      fieldParity = result.finalFieldParity;
      results.push(result);
    }

    return {
      status: 'PASS',
      targetSize: size,
      requestedDurationMs: durationMs,
      actualFillPath,
      gutterFraction: resources.gutterFraction,
      gutterRecordCount: resources.gutterRecordCount,
      authoritativeTexelCount: resources.authoritativeTexelCount,
      donorStructure: 'all four donor indices are inside the designated authoritative prefix',
      displayFormat: resources.displayFormat,
      peakAllocation: { status: 'PASS', bytes: peakAllocatedBytes, formatted: formatBytes(peakAllocatedBytes) },
      rows: results.map(({ finalFieldParity, ...result }) => result),
    };
  } catch (error) {
    return {
      status: 'FAIL',
      targetSize: size,
      requestedDurationMs: durationMs,
      peakAllocation: {
        status: resources ? 'PASS' : 'FAIL',
        bytes: registry.totalBytes() - baselineBytes,
        formatted: formatBytes(registry.totalBytes() - baselineBytes),
      },
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    destroyWorkloadResources(registry, resources);
  }
}

function workloadRow(label, fillPath, simulationSteps, crowdBlurPasses, displayBlurPasses) {
  return Object.freeze({
    label,
    fillPath,
    simulationSteps,
    crowdBlurPasses,
    displayBlurPasses,
    blurFillPairsPerFrame: simulationSteps * crowdBlurPasses + displayBlurPasses,
    maximumLegalSettings: label === 'worst-case-legal',
  });
}

async function measureRow(device, resources, pipelines, row, durationMs, initialFieldParity) {
  const samples = [];
  let fieldParity = initialFieldParity;
  const rowStartedAt = performance.now();
  const deadline = rowStartedAt + durationMs;
  do {
    const frameStartedAt = performance.now();
    const encoder = device.createCommandEncoder({ label: `workload-${row.label}-encoder` });
    encoder.pushDebugGroup(`workload ${row.label}`);
    fieldParity = encodeRehearsalFrame(encoder, resources, pipelines, row, fieldParity);
    encoder.popDebugGroup();
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    samples.push(performance.now() - frameStartedAt);
  } while (performance.now() < deadline || samples.length === 0);

  const bandSize = Math.max(1, Math.min(10, Math.ceil(samples.length / 3)));
  return {
    ...row,
    frames: samples.length,
    measuredDurationMs: performance.now() - rowStartedAt,
    startMsPerFrame: mean(samples.slice(0, bandSize)),
    endMsPerFrame: mean(samples.slice(-bandSize)),
    sustainedMsPerFrame: mean(samples),
    thermalRatio: mean(samples.slice(-bandSize)) / mean(samples.slice(0, bandSize)),
    dispatchesPerFrame: row.blurFillPairsPerFrame * 2 + row.simulationSteps + 1,
    finalFieldParity: fieldParity,
  };
}

function encodeRehearsalFrame(encoder, resources, pipelines, row, initialFieldParity) {
  let fieldParity = initialFieldParity;
  const fill = () => encodeFill(encoder, resources, pipelines, row.fillPath, fieldParity);
  const blurThenFill = () => {
    dispatch(encoder, 'workload blur', pipelines.blur, pipelines.blurBindGroups[fieldParity], [
      Math.ceil(resources.size / 8), Math.ceil(resources.size / 8),
    ]);
    fieldParity = 1 - fieldParity;
    fill();
  };

  encoder.clearBuffer(resources.scatterBuffers[0]);
  fill();
  for (let step = 0; step < row.simulationSteps; step += 1) {
    dispatch(encoder, 'workload scatter', pipelines.scatter, pipelines.scatterBindGroup, [
      Math.ceil(resources.agentCount / 64),
    ]);
    for (let pass = 0; pass < row.crowdBlurPasses; pass += 1) blurThenFill();
  }
  for (let pass = 0; pass < row.displayBlurPasses; pass += 1) blurThenFill();
  return fieldParity;
}

function encodeFill(encoder, resources, pipelines, fillPath, fieldParity) {
  if (fillPath === 'staging-copy') {
    encoder.copyTextureToTexture(
      { texture: resources.fields.food[fieldParity] },
      { texture: resources.fallbackStaging },
      [resources.size, resources.size],
    );
    dispatch(encoder, 'workload staging-copy gutter fill', pipelines.fallbackFill,
      pipelines.fallbackFillBindGroups[fieldParity], [Math.ceil(resources.gutterRecordCount / 64)]);
    return;
  }
  if (!pipelines.fastFill) throw new Error('The read_write fill path was selected without a valid pipeline');
  dispatch(encoder, 'workload read_write gutter fill', pipelines.fastFill,
    pipelines.fastFillBindGroups[fieldParity], [Math.ceil(resources.gutterRecordCount / 64)]);
}

function dispatch(encoder, label, pipeline, bindGroup, workgroups) {
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(...workgroups);
  pass.end();
}

async function scopedPipelines(device, resources, supportsReadWriteStorage) {
  const { value, error } = await withGpuErrorScope(device, 'workload pipeline creation', () => (
    createPipelines(device, resources, supportsReadWriteStorage)
  ));
  if (error) throw new Error(`Workload pipeline validation failed: ${error.message}`);
  return value;
}

async function createPipelines(device, resources, supportsReadWriteStorage) {
  const constants = { RECORD_COUNT: resources.gutterRecordCount };
  const [initModule, blurModule, scatterModule, fallbackModule, fastModule] = await Promise.all([
    loadModule(device, 'workload-init', 'workload-init.wgsl'),
    loadModule(device, 'workload-blur', 'workload-blur.wgsl'),
    loadModule(device, 'workload-scatter', 'workload-scatter.wgsl', {
      AGENT_COUNT: resources.agentCount,
      FIELD_TEXEL_COUNT: resources.textureCount,
    }),
    loadModule(device, 'workload-fill-fallback', 'workload-fill-fallback.wgsl', constants),
    supportsReadWriteStorage ? loadModule(device, 'workload-fill-fast', 'workload-fill-fast.wgsl', constants) : null,
  ]);
  const initLayout = storageTextureLayout(device, 'workload-init-layout', 'write-only');
  const blurLayout = device.createBindGroupLayout({
    label: 'workload-blur-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
    ],
  });
  const scatterLayout = device.createBindGroupLayout({
    label: 'workload-scatter-layout',
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }],
  });
  const fallbackLayout = device.createBindGroupLayout({
    label: 'workload-fill-fallback-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'unfilterable-float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'r32float' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  });
  const fastLayout = supportsReadWriteStorage ? device.createBindGroupLayout({
    label: 'workload-fill-fast-layout',
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'read-write', format: 'r32float' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
    ],
  }) : null;
  const pipeline = (label, module, layout) => module && device.createComputePipeline({
    label,
    layout: device.createPipelineLayout({ label: `${label}-pipeline-layout`, bindGroupLayouts: [layout] }),
    compute: { module, entryPoint: 'main' },
  });
  const init = pipeline('workload-init-pipeline', initModule, initLayout);
  const blur = pipeline('workload-blur-pipeline', blurModule, blurLayout);
  const scatter = pipeline('workload-scatter-pipeline', scatterModule, scatterLayout);
  const fallbackFill = pipeline('workload-fill-fallback-pipeline', fallbackModule, fallbackLayout);
  const fastFill = pipeline('workload-fill-fast-pipeline', fastModule, fastLayout);

  return {
    init,
    initBindGroups: Object.values(resources.fields).flat().map((texture, index) => bindGroup(device, `workload-init-${index}`, initLayout, [
      { binding: 0, resource: texture.createView() },
    ])),
    blur,
    blurBindGroups: [0, 1].map((source) => bindGroup(device, `workload-blur-${source}`, blurLayout, [
      { binding: 0, resource: resources.fields.food[source].createView() },
      { binding: 1, resource: resources.fields.food[1 - source].createView() },
    ])),
    scatter,
    scatterBindGroup: bindGroup(device, 'workload-scatter', scatterLayout, [
      { binding: 0, resource: { buffer: resources.scatterBuffers[0] } },
    ]),
    fallbackFill,
    fallbackFillBindGroups: [0, 1].map((parity) => bindGroup(device, `workload-fill-fallback-${parity}`, fallbackLayout, [
      { binding: 0, resource: resources.fallbackStaging.createView() },
      { binding: 1, resource: resources.fields.food[parity].createView() },
      { binding: 2, resource: { buffer: resources.donorRecords } },
    ])),
    fastFill,
    fastFillBindGroups: fastLayout ? [0, 1].map((parity) => bindGroup(device, `workload-fill-fast-${parity}`, fastLayout, [
      { binding: 0, resource: resources.fields.food[parity].createView() },
      { binding: 1, resource: { buffer: resources.donorRecords } },
    ])) : [],
  };
}

async function initializeNoiseFields(device, resources, pipelines) {
  const encoder = device.createCommandEncoder({ label: 'workload-initialize-noise-encoder' });
  for (const bindGroup of pipelines.initBindGroups) {
    dispatch(encoder, 'workload initialize noise', pipelines.init, bindGroup, [
      Math.ceil(resources.size / 8), Math.ceil(resources.size / 8),
    ]);
  }
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

async function loadModule(device, label, fileName, constants = {}) {
  const code = await fetchWgsl(shaderUrl(fileName), { constants });
  const module = device.createShaderModule({ label, code });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter(({ type }) => type === 'error');
  if (errors.length) throw new Error(errors.map(({ message, lineNum }) => `${label}:${lineNum}: ${message}`).join('\n'));
  return module;
}

function storageTextureLayout(device, label, access) {
  return device.createBindGroupLayout({
    label,
    entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access, format: 'r32float' } }],
  });
}

function bindGroup(device, label, layout, entries) {
  return device.createBindGroup({ label, layout, entries });
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatBytes(bytes) {
  return `${(bytes / 2 ** 20).toFixed(1)} MiB`;
}
