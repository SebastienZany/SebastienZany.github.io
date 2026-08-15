export function createSimulationBindings(device, layouts, resources) {
  const bind = (label, layoutName, entries) => device.createBindGroup({
    label,
    layout: layouts[layoutName].bindGroupLayout,
    entries: entries.map((resource, binding) => ({ binding, resource })),
  });
  const buffer = (value) => ({ buffer: value });
  const texture = (view) => view;

  const oat = bind('sim-oat-bind-group', 'oat', [
    buffer(resources.parameters), buffer(resources.oats), texture(resources.oatFieldView),
  ]);
  const crowdScatter = resources.agentBuffers.map((agents, parity) => bind(
    `sim-crowd-scatter-bind-${parity}`,
    'scatter',
    [buffer(resources.parameters), buffer(agents), buffer(resources.countBuffers[parity]), buffer(resources.crowdAtomic)],
  ));
  const crowdResolve = bind('sim-crowd-resolve-bind', 'crowdResolve', [
    buffer(resources.parameters), buffer(resources.crowdAtomic), texture(resources.crowdFieldViews[0]),
  ]);
  const crowdFilter = [0, 1].map((source) => bind(`sim-crowd-filter-bind-${source}`, 'textureFilter', [
    buffer(resources.parameters), texture(resources.crowdFieldViews[source]), texture(resources.crowdFieldViews[source ^ 1]),
  ]));

  const advance = resources.agentBuffers.map((agentsIn, parity) => [0, 1].map((densityIndex) => bind(
    `sim-advance-bind-${parity}-density-${densityIndex}`,
    'advance',
    [
      buffer(resources.parameters), buffer(agentsIn), buffer(resources.agentBuffers[parity ^ 1]),
      buffer(resources.countBuffers[parity]), buffer(resources.countBuffers[parity ^ 1]),
      texture(resources.dynamicFieldViews[0]), texture(resources.oatFieldView),
      texture(resources.crowdFieldViews[densityIndex]),
    ],
  )));
  const birth = resources.agentBuffers.map((agents, parity) => bind(`sim-birth-bind-${parity}`, 'birth', [
    buffer(resources.parameters), buffer(agents), buffer(resources.countBuffers[parity]),
    buffer(resources.survivorCount), buffer(resources.allocatorDebug), buffer(resources.childOwnership),
  ]));
  const indirect = resources.countBuffers.map((count, parity) => bind(`sim-indirect-bind-${parity}`, 'indirect', [
    buffer(resources.parameters), buffer(count), buffer(resources.survivorCount),
    buffer(resources.dispatchArgs), buffer(resources.renderArgs),
  ]));
  const exposure = resources.agentBuffers.map((agents, parity) => bind(`sim-exposure-bind-${parity}`, 'scatter', [
    buffer(resources.parameters), buffer(agents), buffer(resources.countBuffers[parity]), buffer(resources.exposureAtomic),
  ]));
  const diffuse = bind('sim-diffuse-bind', 'field', [
    buffer(resources.parameters), texture(resources.dynamicFieldViews[0]),
    buffer(resources.exposureAtomic), texture(resources.dynamicFieldViews[1]),
  ]);
  const delta = bind('sim-delta-bind', 'field', [
    buffer(resources.parameters), texture(resources.dynamicFieldViews[1]),
    buffer(resources.exposureAtomic), texture(resources.dynamicFieldViews[0]),
  ]);
  const hash = resources.agentBuffers.map((agents, parity) => bind(`sim-hash-bind-${parity}`, 'hash', [
    buffer(resources.parameters), buffer(agents), buffer(resources.countBuffers[parity]),
    texture(resources.dynamicFieldViews[0]), buffer(resources.stateHash),
  ]));
  return { oat, crowdScatter, crowdResolve, crowdFilter, advance, birth, indirect, exposure, diffuse, delta, hash };
}
