// Population-count conversion and admission-finalize kernels.
// Inputs: atomic live count. Outputs: indirect compute args and render draw args;
// prepare also freezes survivorCount before births mutate the live count.
// Invariants: finalize is the only observation point after transient overshoot.
// Anchors: M3 fixes 2 and 3b.

//#include "common.wgsl"

struct DispatchArgs { x: u32, y: u32, z: u32 }
struct RenderArgs { vertexCount: u32, instanceCount: u32, firstVertex: u32, firstInstance: u32 }

@group(0) @binding(1) var<storage, read_write> liveCount: AtomicCount;
@group(0) @binding(2) var<storage, read_write> survivors: PlainCount;
@group(0) @binding(3) var<storage, read_write> dispatchArgs: DispatchArgs;
@group(0) @binding(4) var<storage, read_write> renderArgs: RenderArgs;

fn writeArgs(count: u32) {
  dispatchArgs = DispatchArgs((count + ${AGENT_WORKGROUP_SIZE}u - 1u) / ${AGENT_WORKGROUP_SIZE}u, 1u, 1u);
}

@compute @workgroup_size(1)
fn prepareSurvivors() {
  let count = atomicLoad(&liveCount.value);
  survivors.value = count;
  writeArgs(count);
}

@compute @workgroup_size(1)
fn finalizeAdmission() {
  let finalized = min(atomicLoad(&liveCount.value), capacity());
  atomicStore(&liveCount.value, finalized);
  writeArgs(finalized);
  renderArgs = RenderArgs(finalized, 1u, 0u, 0u);
}
