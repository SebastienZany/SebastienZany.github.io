// Child admission kernel (allocator phase B).
// Inputs: phase-A survivor array and its exact count.
// Output: children only at slots >=survivorCount; each invocation may rewrite only
// its own parent slot for accepted-child debits.
// Invariants: overshoot is compensated before finalize; child state/id are pure
// functions of parent state, step, and side. Saturated admission is best-effort.
// Anchors: main.js:3225–3246/3355–3378 and M3 allocator fix 3b.

//#include "common.wgsl"

struct AllocatorDebug {
  ownershipViolations: atomic<u32>,
  admittedChildren: atomic<u32>,
  rejectedChildren: atomic<u32>,
  padding: atomic<u32>,
}

@group(0) @binding(1) var<storage, read_write> agents: array<Agent>;
@group(0) @binding(2) var<storage, read_write> liveCount: AtomicCount;
@group(0) @binding(3) var<storage, read> survivors: PlainCount;
@group(0) @binding(4) var<storage, read_write> allocatorDebug: AllocatorDebug;
@group(0) @binding(5) var<storage, read_write> childOwnership: array<atomic<u32>>;

@compute @workgroup_size(${AGENT_WORKGROUP_SIZE})
fn admitChildren(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let parentSlot = invocation.x;
  if (parentSlot >= survivors.value) { return; }
  var parent = agents[parentSlot];
  if (parent.reserve <= parameterFloat(${PARAM_SLOT_MOVEMENT}u, 3u)) { return; }

  let childReserve = parent.reserve * 0.25;
  var acceptedDebit = 0.0;
  for (var childIndex = 0u; childIndex < 2u; childIndex += 1u) {
    let sideSign = select(-1.0, 1.0, childIndex == 0u);
    let jitter = (counterRandom(parent.idLo, parent.idHi, 37u + childIndex) - 0.5)
      * parameterFloat(${PARAM_SLOT_REPRODUCTION}u, 3u);
    let childHeading = parent.heading
      + sideSign * parameterFloat(${PARAM_SLOT_REPRODUCTION}u, 0u) + jitter;
    let childDirection = vec2<f32>(cos(childHeading), sin(childHeading));
    let childUvPos = wrapUv(parent.uvPos
      + childDirection * parameterFloat(${PARAM_SLOT_REPRODUCTION}u, 1u));
    let identity = childIdentity(parent, childIndex);

    let childSlot = atomicAdd(&liveCount.value, 1u);
    if (childSlot >= capacity()) {
      atomicSub(&liveCount.value, 1u);
      atomicAdd(&allocatorDebug.rejectedChildren, 1u);
      continue;
    }
    if (childSlot < survivors.value) {
      atomicAdd(&allocatorDebug.ownershipViolations, 1u);
    }
    let previousOwner = atomicExchange(&childOwnership[childSlot], parentSlot + 1u);
    if (previousOwner != 0u) {
      atomicAdd(&allocatorDebug.ownershipViolations, 1u);
    }
    agents[childSlot] = Agent(childUvPos, childHeading, childReserve,
      identity.x, identity.y, 1u, 0u);
    acceptedDebit += childReserve;
    atomicAdd(&allocatorDebug.admittedChildren, 1u);
  }
  parent.reserve = max(parent.reserve - acceptedDebit, 0.0);
  agents[parentSlot] = parent;
}
