# M0 capability probe results

## Harness notes

- Automated browser: system Chrome channel, starting headless with no added launch flags.
- Every browser test asserts `adapter.info.isFallbackAdapter === false` before exercising a page;
  vendor and description strings are retained only as secondary diagnostics.
- The automated rehearsal runs for five seconds with a 180-second explicit test timeout. It
  includes the maximum legal crowd radius × eight simulation steps plus maximum display
  smoothing on the device's actual fill path.
- The manual device protocol is 60 seconds. Use 1536 on desktop and 1024 on phones, then copy the
  page JSON into the matching section below.
- Managed-session launch attempt (2026-08-15): headless system Chrome 151 aborted with `SIGABRT`
  before page creation. The headed fallback also aborted because Crashpad could not read its
  application-support directory under the filesystem sandbox. A third headless attempt with
  `--disable-crashpad --disable-crash-reporter --crash-dumps-dir=/private/tmp/v2-chrome-crashes`
  behaved identically, so those ineffective flags are not part of the committed config. There is
  no working browser configuration to record from this restricted session; see `../BLOCKERS.md`.

<!-- mac-chrome:start -->
## Mac Chrome 151.0.7922.138

- Recorded: 2026-08-15T02:53:37.788Z
- Harness: Playwright system Chrome channel, headless=true, no extra launch flags.
- GPU gate: `adapter.info.isFallbackAdapter === false`.
- Adapter identity: `{"vendor":"apple","architecture":"metal-3","device":"","description":"","isFallbackAdapter":false}`

```json
{
  "schema": "v2-capability-probe@1",
  "generatedAt": "2026-08-15T02:53:32.045Z",
  "environment": {
    "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/151.0.0.0 Safari/537.36",
    "devicePixelRatio": 1,
    "screen": {
      "width": 1280,
      "height": 720,
      "availWidth": 1280,
      "availHeight": 720
    },
    "deviceMemoryGiB": 32,
    "hardwareConcurrency": 10,
    "preferredCanvasFormat": "bgra8unorm",
    "phoneDefault": false
  },
  "adapter": {
    "vendor": "apple",
    "architecture": "metal-3",
    "device": "",
    "description": "",
    "isFallbackAdapter": false,
    "subgroupMinSize": 32,
    "subgroupMaxSize": 32
  },
  "limits": {
    "maxBindGroups": 4,
    "maxBindGroupsPlusVertexBuffers": 24,
    "maxBindingsPerBindGroup": 1000,
    "maxBufferSize": 4294967292,
    "maxColorAttachmentBytesPerSample": 128,
    "maxColorAttachments": 8,
    "maxComputeInvocationsPerWorkgroup": 1024,
    "maxComputeWorkgroupSizeX": 1024,
    "maxComputeWorkgroupSizeY": 1024,
    "maxComputeWorkgroupSizeZ": 64,
    "maxComputeWorkgroupStorageSize": 32768,
    "maxComputeWorkgroupsPerDimension": 65535,
    "maxDynamicStorageBuffersPerPipelineLayout": 8,
    "maxDynamicUniformBuffersPerPipelineLayout": 10,
    "maxImmediateSize": 64,
    "maxInterStageShaderVariables": 28,
    "maxSampledTexturesPerShaderStage": 48,
    "maxSamplersPerShaderStage": 16,
    "maxStorageBufferBindingSize": 4294967292,
    "maxStorageBuffersInFragmentStage": 10,
    "maxStorageBuffersInVertexStage": 10,
    "maxStorageBuffersPerShaderStage": 10,
    "maxStorageTexturesInFragmentStage": 8,
    "maxStorageTexturesInVertexStage": 8,
    "maxStorageTexturesPerShaderStage": 8,
    "maxTextureArrayLayers": 2048,
    "maxTextureDimension1D": 16384,
    "maxTextureDimension2D": 16384,
    "maxTextureDimension3D": 2048,
    "maxUniformBufferBindingSize": 65536,
    "maxUniformBuffersPerShaderStage": 12,
    "maxVertexAttributes": 30,
    "maxVertexBufferArrayStride": 2048,
    "maxVertexBuffers": 8,
    "minStorageBufferOffsetAlignment": 256,
    "minUniformBufferOffsetAlignment": 256
  },
  "features": [
    "bgra8unorm-storage",
    "clip-distances",
    "core-features-and-limits",
    "depth-clip-control",
    "depth32float-stencil8",
    "dual-source-blending",
    "float32-blendable",
    "float32-filterable",
    "indirect-first-instance",
    "primitive-index",
    "rg11b10ufloat-renderable",
    "shader-f16",
    "subgroups",
    "texture-component-swizzle",
    "texture-compression-astc",
    "texture-compression-astc-sliced-3d",
    "texture-compression-bc",
    "texture-compression-bc-sliced-3d",
    "texture-compression-etc2",
    "texture-formats-tier1",
    "texture-formats-tier2",
    "timestamp-query"
  ],
  "wgslLanguageFeatures": [
    "immediate_address_space",
    "linear_indexing",
    "packed_4x8_integer_dot_product",
    "pointer_composite_access",
    "readonly_and_readwrite_storage_textures",
    "subgroup_id",
    "subgroup_uniformity",
    "texture_and_sampler_let",
    "uniform_buffer_standard_layout",
    "unrestricted_pointer_parameters"
  ],
  "checks": {
    "device-acquisition": {
      "status": "PASS",
      "detail": "WebGPU device acquired."
    },
    "shader-f16": {
      "status": "PASS",
      "detail": "shader-f16 is advertised and enabled."
    },
    "float32-filterable": {
      "status": "PASS",
      "detail": "float32-filterable is advertised and enabled."
    },
    "texture-formats-tier1": {
      "status": "PASS",
      "detail": "texture-formats-tier1 is advertised and enabled."
    },
    "read-write-storage-textures": {
      "status": "PASS",
      "detail": {
        "languageAdvertised": true,
        "compiledAndDispatched": true
      }
    },
    "uncaptured-gpu-errors": {
      "status": "FAIL",
      "detail": "Error while parsing WGSL: :4:27 error: 'target' is a reserved keyword\n@group(0) @binding(0) var target: texture_storage_2d<rgba16float, write>;\n                          ^^^^^^\n\n\n - While calling [Device].CreateShaderModule([ShaderModuleDescriptor \"\"rgba16float-storage-probe\"\"]).\n"
    },
    "r32float-storage": {
      "status": "FAIL",
      "detail": "r32float-storage-probe:4: 'target' is a reserved keyword"
    },
    "r16float-render-filter": {
      "status": "PASS",
      "detail": {
        "format": "r16float",
        "renderAttachment": true,
        "filterableSample": true
      }
    },
    "rgba16float-storage": {
      "status": "FAIL",
      "detail": "rgba16float-storage-probe:4: 'target' is a reserved keyword"
    },
    "compute-sum": {
      "status": "PASS",
      "detail": {
        "elementCount": 65536,
        "expected": 2147516416,
        "actual": 2147516416
      }
    },
    "render-smoke": {
      "status": "PASS",
      "detail": {
        "pixel": [
          51,
          102,
          153,
          255
        ],
        "expected": [
          51,
          102,
          153,
          255
        ]
      }
    },
    "workload-rehearsal": {
      "status": "PASS",
      "detail": "1536 complete; peak 270.9 MiB; actual fill read_write."
    }
  },
  "workloadRehearsals": [
    {
      "status": "PASS",
      "targetSize": 1536,
      "requestedDurationMs": 5000,
      "actualFillPath": "read_write",
      "gutterFraction": 0.3,
      "gutterRecordCount": 707788,
      "authoritativeTexelCount": 1651508,
      "donorStructure": "all four donor indices are inside the designated authoritative prefix",
      "displayFormat": "r16float",
      "peakAllocation": {
        "status": "PASS",
        "bytes": 284080656,
        "formatted": "270.9 MiB"
      },
      "rows": [
        {
          "label": "default",
          "fillPath": "read_write",
          "simulationSteps": 1,
          "crowdBlurPasses": 5,
          "displayBlurPasses": 1,
          "blurFillPairsPerFrame": 6,
          "maximumLegalSettings": false,
          "frames": 66,
          "measuredDurationMs": 1686.300000011921,
          "startMsPerFrame": 28.640000000596046,
          "endMsPerFrame": 24.809999999403953,
          "sustainedMsPerFrame": 25.546969696879387,
          "thermalRatio": 0.8662709496818302,
          "dispatchesPerFrame": 14
        },
        {
          "label": "worst-case-legal",
          "fillPath": "read_write",
          "simulationSteps": 8,
          "crowdBlurPasses": 20,
          "displayBlurPasses": 10,
          "blurFillPairsPerFrame": 170,
          "maximumLegalSettings": true,
          "frames": 4,
          "measuredDurationMs": 2193.2999999970198,
          "startMsPerFrame": 558.8499999940395,
          "endMsPerFrame": 537.8000000044703,
          "sustainedMsPerFrame": 548.3249999992549,
          "thermalRatio": 0.9623333631747452,
          "dispatchesPerFrame": 349
        },
        {
          "label": "fallback-cost-comparison",
          "fillPath": "staging-copy",
          "simulationSteps": 1,
          "crowdBlurPasses": 5,
          "displayBlurPasses": 1,
          "blurFillPairsPerFrame": 6,
          "maximumLegalSettings": false,
          "frames": 73,
          "measuredDurationMs": 1672.2999999970198,
          "startMsPerFrame": 18.829999999701975,
          "endMsPerFrame": 22.95,
          "sustainedMsPerFrame": 22.904109589041095,
          "thermalRatio": 1.2187997875923118,
          "dispatchesPerFrame": 14
        }
      ]
    }
  ],
  "pageFailures": [],
  "enabledDeviceFeatures": [
    "shader-f16",
    "float32-filterable",
    "texture-formats-tier1"
  ]
}
```
<!-- mac-chrome:end -->

## Mac Safari — pending user run

Open local `/v2/probe.html`, run the 60-second rehearsal at 1536, and copy the JSON here.

## iPhone Safari — pending deployment and user run

Open `https://bestiaryofvanishings.com/v2/probe.html`, run the 60-second rehearsal at 1024, and
copy the JSON here. Record the phone model, iOS version, battery/charging state, and whether the
tab was backgrounded.
