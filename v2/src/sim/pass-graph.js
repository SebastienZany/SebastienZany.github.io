import { AGENT_WORKGROUP_SIZE, FIELD_WORKGROUP_SIZE } from './constants.js';

export function encodeSimulationStep(encoder, pipelines, bindings, resources, {
  agentParity,
  blurIterations,
  oatDirty,
  capacityDispatch = false,
}) {
  const nextParity = agentParity ^ 1;
  const fieldGroups = Math.ceil(resources.fieldSize / FIELD_WORKGROUP_SIZE);
  const capacityGroups = Math.ceil(resources.capacity / AGENT_WORKGROUP_SIZE);
  encoder.pushDebugGroup('flat-torus simulation step');
  encoder.clearBuffer(resources.crowdAtomic);
  encoder.clearBuffer(resources.exposureAtomic);
  encoder.clearBuffer(resources.countBuffers[nextParity]);
  encoder.clearBuffer(resources.allocatorDebug);
  encoder.clearBuffer(resources.childOwnership);

  if (oatDirty) encodeFieldPass(encoder, 'oat-field refresh', pipelines.oat, bindings.oat, fieldGroups);

  encodeAgentPass(encoder, 'crowd scatter', pipelines.crowdScatter, bindings.crowdScatter[agentParity], {
    indirect: resources.dispatchArgs,
  });
  encodeFieldPass(encoder, 'crowd fixed-point resolve', pipelines.crowdResolve, bindings.crowdResolve, fieldGroups);
  var densityIndex = 0;
  for (let iteration = 0; iteration < blurIterations; iteration += 1) {
    encodeFieldPass(encoder, `crowd blur ${iteration + 1}/${blurIterations}`,
      pipelines.crowdBlur, bindings.crowdFilter[densityIndex], fieldGroups);
    densityIndex ^= 1;
  }
  encodeFieldPass(encoder, 'crowd clamp and quantize',
    pipelines.crowdQuantize, bindings.crowdFilter[densityIndex], fieldGroups);
  densityIndex ^= 1;

  encodeAgentPass(encoder, 'advance surviving parents', pipelines.advance,
    bindings.advance[agentParity][densityIndex], capacityDispatch
      ? { direct: capacityGroups }
      : { indirect: resources.dispatchArgs });
  encodeSinglePass(encoder, 'freeze survivor count', pipelines.prepare, bindings.indirect[nextParity]);
  encodeAgentPass(encoder, 'admit children', pipelines.birth, bindings.birth[nextParity], capacityDispatch
    ? { direct: capacityGroups }
    : { indirect: resources.dispatchArgs });
  encodeSinglePass(encoder, 'finalize population', pipelines.finalize, bindings.indirect[nextParity]);

  // Legacy order is agents -> diffuse -> exposure -> delta. New deposits therefore
  // remain sharp until the following step.
  encodeFieldPass(encoder, 'dynamic field diffuse and decay', pipelines.diffuse, bindings.diffuse, fieldGroups);
  encodeAgentPass(encoder, 'food exposure scatter', pipelines.exposure, bindings.exposure[nextParity], {
    indirect: resources.dispatchArgs,
  });
  encodeFieldPass(encoder, 'apply food exposure delta', pipelines.delta, bindings.delta, fieldGroups);
  encoder.popDebugGroup();
  return { nextParity, densityIndex };
}

export function encodeStateHash(encoder, pipelines, bindings, resources, agentParity) {
  const fieldGroups = Math.ceil(resources.fieldSize / FIELD_WORKGROUP_SIZE);
  encoder.clearBuffer(resources.stateHash);
  encodeAgentPass(encoder, 'hash agent state set', pipelines.hashAgents, bindings.hash[agentParity], {
    indirect: resources.dispatchArgs,
  });
  encodeFieldPass(encoder, 'hash dynamic field', pipelines.hashField, bindings.hash[agentParity], fieldGroups);
}

function encodeAgentPass(encoder, label, pipeline, bindGroup, dispatch) {
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  if (dispatch.indirect) pass.dispatchWorkgroupsIndirect(dispatch.indirect, 0);
  else pass.dispatchWorkgroups(dispatch.direct);
  pass.end();
}

function encodeFieldPass(encoder, label, pipeline, bindGroup, groups) {
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(groups, groups);
  pass.end();
}

function encodeSinglePass(encoder, label, pipeline, bindGroup) {
  const pass = encoder.beginComputePass({ label });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(1);
  pass.end();
}
