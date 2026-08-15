// Contract (M0 compute smoke): atomically sum indices 1..65536 into one u32.
// Input: invocation index. Output: one storage-buffer atomic. Units: integer count.
// Invariant: exactly ELEMENT_COUNT invocations contribute once; analytic sum fits u32.
const ELEMENT_COUNT: u32 = ${ELEMENT_COUNT}u;

@group(0) @binding(0) var<storage, read_write> sum: atomic<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3u) {
  if (invocation.x < ELEMENT_COUNT) {
    atomicAdd(&sum, invocation.x + 1u);
  }
}

