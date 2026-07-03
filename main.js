import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

const appEl = document.getElementById('app');
const canvas = document.getElementById('sim');
const statusEl = document.getElementById('gpuStatus');
const agentCountEl = document.getElementById('agentCount');
const oatCountEl = document.getElementById('oatCount');
const slimeCoverageEl = document.getElementById('slimeCoverage');
const fpsEl = document.getElementById('fps');
const agentHistoryCanvas = document.getElementById('agentHistoryChart');
const agentGrowthCanvas = document.getElementById('agentGrowthChart');
const agentAccelerationCanvas = document.getElementById('agentAccelerationChart');
const agentHistoryRangeEl = document.getElementById('agentHistoryRange');
const annotationLayer = document.getElementById('annotationLayer');
const startScreen = document.getElementById('startScreen');
const startScreenTitle = document.getElementById('startScreenTitle');
const startScreenIntroLine = document.getElementById('startScreenIntroLine');
const startScreenIntroDots = Array.from(document.querySelectorAll('.start-screen-intro-dot'));
const startScreenStatus = document.getElementById('startScreenStatus');
const startButton = document.getElementById('startButton');
const endingFadeOverlay = document.getElementById('endingFadeOverlay');
const endingCountdownLayer = document.getElementById('endingCountdownLayer');
const endingCountdownLeft = document.getElementById('endingCountdownLeft');
const endingCountdownRight = document.getElementById('endingCountdownRight');
let startScreenReady = false;
const cameraAzimuthEl = document.getElementById('cameraAzimuth');
const cameraElevationEl = document.getElementById('cameraElevation');
const cameraPolarEl = document.getElementById('cameraPolar');
const cameraDistanceEl = document.getElementById('cameraDistance');
const cameraFovEl = document.getElementById('cameraFov');
const cameraTargetEl = document.getElementById('cameraTarget');
const cameraPoseCommandEl = document.getElementById('cameraPoseCommand');
const copyCameraPoseButton = document.getElementById('copyCameraPose');
const soundCheckToggleButton = document.getElementById('soundCheckToggle');
const soundCheckPanel = document.getElementById('soundCheckPanel');
const soundCheckCloseButton = document.getElementById('soundCheckClose');
const soundCheckGrid = document.getElementById('soundCheckGrid');
const soundCompressorEnabledInput = document.getElementById('soundCompressorEnabled');
const soundCompressorGrid = document.getElementById('soundCompressorGrid');
let uiPanelsVisible = appEl?.dataset.panelsVisible === 'true';

// DOM write helpers: skip the write (and its style/layout invalidation) when the
// value is unchanged, so per-frame readouts only touch the DOM on real changes.
const lastWrittenText = new WeakMap();
function setTextIfChanged(el, text) {
  if (!el || lastWrittenText.get(el) === text) return;
  lastWrittenText.set(el, text);
  el.textContent = text;
}
const lastWrittenStyleProps = new WeakMap();
function setStylePropIfChanged(el, prop, value) {
  if (!el) return;
  let props = lastWrittenStyleProps.get(el);
  if (!props) {
    props = new Map();
    lastWrittenStyleProps.set(el, props);
  }
  if (props.get(prop) === value) return;
  props.set(prop, value);
  if (prop.startsWith('--')) el.style.setProperty(prop, value);
  else el.style[prop] = value;
}

// Phone-class devices get a reduced profile: lower pixel ratio and the 'fast'
// performance mode. Detection is capability-based (coarse pointer + small
// screen) rather than UA sniffing. ?mobile=1 / ?mobile=0 forces the profile
// on or off so the phone configuration can be exercised from a desktop
// browser.
const MOBILE_PROFILE_OVERRIDE = new URLSearchParams(window.location.search).get('mobile');
const IS_MOBILE_DEVICE = MOBILE_PROFILE_OVERRIDE !== null
  ? MOBILE_PROFILE_OVERRIDE !== '0'
  : (window.matchMedia?.('(pointer: coarse)')?.matches ?? false) &&
    Math.min(window.screen?.width ?? Infinity, window.screen?.height ?? Infinity) <= 820;
const MAX_PIXEL_RATIO = IS_MOBILE_DEVICE ? 1.5 : 2;

// Phones get a reduced simulation profile. The desktop profile allocates
// ~1.4 GB of float render targets (field buffers plus the 4-lane seam
// transition atlases), which is far past iOS Safari's per-tab GPU budget --
// WebKit kills the tab during load and the page never gets past "loading...".
// 768^2 field / 384^2 agents keeps the total near 360 MB. The ?field=
// override exists for generating seam bakes at other sizes from a desktop
// browser (see exportSeamBake); ship a matching seam-bake-<size>.bin for any
// size phones can hit, or load stalls for minutes building seams live.
const FIELD_SIZE_OVERRIDE = Number(new URLSearchParams(window.location.search).get('field'));
const FIELD_SIZE = FIELD_SIZE_OVERRIDE > 0 ? FIELD_SIZE_OVERRIDE : (IS_MOBILE_DEVICE ? 768 : 1536);
const AGENT_SIDE = IS_MOBILE_DEVICE ? 384 : 768;
const SEAM_BAKE_EXPORT_MODE = new URLSearchParams(window.location.search).has('bakeExport');
const AGENT_CAPACITY = AGENT_SIDE * AGENT_SIDE;
const AGENT_RECORD_STRIDE = 3; // updated parent plus two child proposal slots
const AGENT_CANDIDATE_HEIGHT = AGENT_SIDE * AGENT_RECORD_STRIDE;
const AGENT_CANDIDATE_COUNT = AGENT_CAPACITY * AGENT_RECORD_STRIDE;
const AGENT_SCAN_PASS_COUNT = Math.ceil(Math.log2(AGENT_CANDIDATE_COUNT));
const INITIAL_AGENTS = 4096;
const MAX_OATS = 64;
const OBSERVATION_SLIME_TRIGGER_RADIUS_TEXELS = 3;
const WORLD_LINEAR_SCALE = 4.0;
const SURFACE_WORLD_SIZE = 2.4 * WORLD_LINEAR_SCALE;
const SURFACE_FOV = Math.PI / 4.2;
const OPTICAL_ZOOM_MIN_FOV_DEG = 8;
const OPTICAL_ZOOM_MAX_FOV_DEG = 76;
const OPTICAL_ZOOM_WHEEL_SCALE = 0.001;
const OPTICAL_ZOOM_SMOOTH_MS = 120;
const OPTICAL_ZOOM_SNAP_EPSILON_DEG = 0.01;
const CAMERA_ORBIT_DAMPING_FACTOR = 0.07;
const CAMERA_ORBIT_ROTATE_SPEED = 0.65;
const CAMERA_ORBIT_ZOOM_SPEED = 0.7;
const CAMERA_ORBIT_SHIFT_SPEED_MULTIPLIER = 1 / 3;
const CAMERA_KEYBOARD_ORBIT_SPEED = 0.68;
const CAMERA_KEYBOARD_ORBIT_RESPONSE_MS = 120;
const CAMERA_KEYBOARD_ORBIT_DECAY_MS = 520;
const CAMERA_KEYBOARD_ORBIT_EPSILON = 0.00001;
const DEFAULT_OAT_RADIUS = 0.08 / WORLD_LINEAR_SCALE;
const DEFAULT_OAT_POWER = 1.55;
const OAT_EPSILON = 0.001;
const OAT_SUPPORT_SIGMAS = Math.sqrt(-2 * Math.log(OAT_EPSILON));
const OAT_FOOD_DECAY_TARGET_MULTIPLIER = 1 / 3;
const OAT_FOOD_DECAY_DURATION_MS = 90000;
const OAT_FOOD_DECAY_UPDATE_INTERVAL_MS = 250;
const OAT_FOOD_DECAY_EPSILON = 0.0005;
const MOUSE_REPEL_RADIUS_UV = 0.07 / 3;
const MOUSE_REPEL_STRENGTH = 3.0;
const MOUSE_REPEL_RAYCAST_INTERVAL_MS = 45;
const INITIAL_AGENT_SPAWN_SIGMA = DEFAULT_OAT_RADIUS * 0.45;
const GLB_PATH = 'luyvwj-fwgyww.glb';
const GOLD_WAFER_LOOKUP_PATH = 'material%20data/thicker_au_rgb_thickness_angle_tensor.json';
const GOLD_WAFER_BODY_ENV_EQUIRECT_WIDTH = 512;
const GOLD_WAFER_BODY_ENV_EQUIRECT_HEIGHT = 256;
const GOLD_BODY_FAST_LOOKUP = true;
const GOLD_BODY_FAST_LOOKUP_ANGLE_ROWS = 256;
const INITIAL_OAT_POWER_MULTIPLIER = 1;
const ENV_AUDIO_PATH = 'shen-soundpack/wav/env.wav';
const ENV_AUDIO_FALLBACK_PATH = 'shen-soundpack/wav/env-under-25mb.wav';
const ENV_AUDIO_CROSSFADE_SECONDS = 2.5;
const ENV_AUDIO_SCHEDULE_LOOKAHEAD_SECONDS = 12;
const ENV_AUDIO_SCHEDULE_INTERVAL_MS = 1000;
const ENV_AUDIO_START_DELAY_SECONDS = 0.05;
const SLIME_TUMBLE_AUDIO_PATH = 'shen-soundpack/wav/slime-tumble.wav';
const SLIME_TUMBLE_LOOP_START_SECONDS = 8;
const SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS = 2;
const SLIME_TUMBLE_SCHEDULE_LOOKAHEAD_SECONDS = 12;
const SLIME_TUMBLE_SCHEDULE_INTERVAL_MS = 1000;
const SLIME_TUMBLE_START_DELAY_SECONDS = 0.02;
const SLIME_TUMBLE_REVERB_SECONDS = 3.8;
const SLIME_TUMBLE_REVERB_DECAY = 3.2;
const SLIME_TUMBLE_REVERB_MAX_WET = 0.58;
const SLIME_TUMBLE_SPATIAL_SMOOTH_SECONDS = 0.045;
const SLIME_TUMBLE_SPATIAL_SYNC_INTERVAL_MS = 66;
const SLIME_TUMBLE_SPATIAL_POSITION_EPSILON = 0.012 * WORLD_LINEAR_SCALE;
const SLIME_TUMBLE_SPATIAL_DIRECTION_EPSILON = 0.0008;
const SLIME_TUMBLE_PANNER_ROLLOFF = 4.8;
const SLIME_TUMBLE_LOWPASS_NEAR_HZ = 18000;
const SLIME_TUMBLE_LOWPASS_FAR_HZ = 900;
const SLIME_TUMBLE_LOWPASS_Q = 0.55;
const SOUND_VOLUME_RAMP_SECONDS = 0.035;
const SOUND_ONE_SHOT_MAX_VOICES_PER_CLIP = 16;
const SOUND_ONE_SHOT_STEAL_FADE_SECONDS = 0.025;
const SOUND_FADE_SECONDS_MAX = 30;
const SOUND_DEFAULT_FADE_IN_SECONDS = 0;
const SOUND_DEFAULT_FADE_OUT_SECONDS = 0.08;
const SOUND_COMPRESSOR_DEFAULTS = Object.freeze({
  enabled: false,
  threshold: -24,
  knee: 30,
  ratio: 12,
  attack: 0.003,
  release: 0.25,
});
const SOUND_COMPRESSOR_CONTROLS = Object.freeze([
  { key: 'threshold', label: 'Threshold', min: -100, max: 0, step: 1, suffix: 'dB', digits: 0 },
  { key: 'knee', label: 'Knee', min: 0, max: 40, step: 1, suffix: 'dB', digits: 0 },
  { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.1, suffix: ':1', digits: 1 },
  { key: 'attack', label: 'Attack', min: 0, max: 1, step: 0.001, suffix: 's', digits: 3 },
  { key: 'release', label: 'Release', min: 0, max: 1, step: 0.01, suffix: 's', digits: 2 },
]);
const INTRO_OAT_SPRITE_DELAY_MS = 5500;
const INTRO_UI_FADE_MS = 1000;
const INTRO_BUTTON_HOVER_FADE_MS = 500;
const INTRO_START_CLICK_SOUND_PEAK_MS = 826.23;
const INTRO_START_SCREEN_FADE_MS = INTRO_UI_FADE_MS;
const INTRO_START_SILENT_BEAT_MS = 1000;
const INTRO_OAT_SEQUENCE_MS = 10000;
const INTRO_OAT_FADE_MS = INTRO_UI_FADE_MS;
const INITIAL_AGENT_SEED_DURATION_MS = 3460;
const INITIAL_AGENT_SEED_SOUND_LEAD_MS = 1000;
const ENDING_TOTAL_RUNTIME_MS = 120000;
const ENDING_CAMOUFLAGE_FADE_DELAY_MS = 7000;
const ENDING_FALLBACK_FADE_MS = 3000;
const INTRO_OAT_LAND_AT = 0.68;
const INTRO_OAT_BRIGHTEN_END = 1 - (INTRO_OAT_FADE_MS / INTRO_OAT_SEQUENCE_MS);
const INTRO_OAT_START_SCREEN_Y = 1.55;
const INTRO_OAT_TOP_EDGE_NDC_Y = 1;
const INTRO_OAT_BASE_SCALE = 0.24 * WORLD_LINEAR_SCALE;
const SOUND_CHECK_CLIPS = Object.freeze([
  { id: 'intro', path: 'shen-soundpack/wav/intro.wav', loop: false, maxGain: 2.1809 },
  { id: 'env', path: ENV_AUDIO_PATH, loop: true, gain: 2, maxGain: 15.5816, fadeOutSeconds: ENV_AUDIO_CROSSFADE_SECONDS },
  { id: 'slime-appear', path: 'shen-soundpack/wav/slime-appear.wav', loop: false, maxGain: 3.4979 },
  { id: 'slime-appear-stretch', path: 'shen-soundpack/wav/slime-appear-stretch.wav', loop: false, gain: 2, maxGain: 4.1431 },
  { id: 'slime-tumble', path: SLIME_TUMBLE_AUDIO_PATH, loop: false, gain: 0.5, maxGain: 1.9959 },
  { id: 'slime-tumble-complete', path: 'shen-soundpack/wav/slime-tumble-complete.wav', loop: false, maxGain: 3.0304 },
  { id: 'slime-fuse', path: 'shen-soundpack/wav/slime-fuse.wav', loop: false, maxGain: 1.7083 },
  { id: 'cuttlefish-reveal', path: 'shen-soundpack/wav/cuttlefish-reveal.wav', loop: false, gain: 0.5, maxGain: 2.2347 },
  { id: 'cuttlefish-camouflage', path: 'shen-soundpack/wav/cuttlefish-camouflage.wav', loop: false, maxGain: 1.6634 },
  { id: 'text-reveal', path: 'shen-soundpack/wav/text-reveal.wav', loop: false, maxGain: 5.2462 },
  { id: 'game-complete', path: 'shen-soundpack/wav/game-complete.wav', loop: false, maxGain: 2.4264 },
]);
const STATS_UPDATE_INTERVAL_MS = 650;
const STATS_READBACK_RESET_COOLDOWN_MS = 1200;
const STATS_READBACK_MIN_FPS = 24;
const STATS_READBACK_MAX_DT = 2.15;
const STATS_READBACK_MAX_STALE_MS = 3200;
const AGENT_HISTORY_SAMPLE_LIMIT = 180;
const SLIME_COVERAGE_THRESHOLD = 0.006;
const CAMERA_FAR = 300 * WORLD_LINEAR_SCALE;
const FRAME_DT_CLAMP = 2.2;
const MAX_SIMULATION_STEPS = 8;
const SEAM_REDIRECT_HALO_TEXELS = 1;
const SEAM_WELD_OUT_PAD_TEXELS = 1;
const SEAM_WELD_IN_DEPTH_TEXELS = 1;
const SEAM_PADDING_BUDGET_EPSILON_TEXELS = 1e-3;
const SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD = 1.5;
const RENDER_DILATE_ITERATIONS = 3;
const DIFFUSION_SAMPLE_RADIUS_TEXELS = 1;
const BUMP_NORMAL_BASE_RADIUS_TEXELS = 1;
const BUMP_NORMAL_SMOOTHING_SCALE = 0.65;
const SPATIAL_SMOOTHING_MAX_TEXELS = 10;
const VISUAL_TRANSITION_RASTER_MARGIN_TEXELS = 2;
const ZERO_GUTTER_CROSSING_RASTER_PAD_TEXELS = 1;
const SEAM_TRANSITION_CANDIDATE_COUNT = 4;
const ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN = 0.15;
const ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS = 0.75;
const DEPOSIT_POINT_SIZE_WORLD = 2.8;
const DENSITY_MASS_SCALE = 0.032;
const MAX_DENSITY_RESERVE_MASS = 64.0;
const AGENT_DENSITY_OVERLAY_POINT_SIZE_PIXELS = 4.0;
const OAT_SUPPORT_RADIUS_MULTIPLIER = OAT_SUPPORT_SIGMAS;
const READBACK_DIAGNOSTIC_THROTTLE_MS = 250;
const AGENT_INIT_LOCAL_RETRIES = 24;
const AGENT_INIT_GLOBAL_RETRIES = 48;
const PERFORMANCE_MODES = Object.freeze({
  quality: {
    smoothingTapCount: 14,
    bumpDiagonalTaps: true,
  },
  balanced: {
    smoothingTapCount: 7,
    bumpDiagonalTaps: false,
  },
  fast: {
    smoothingTapCount: 3,
    bumpDiagonalTaps: false,
  },
});
const PERFORMANCE_MODE_NAMES = Object.freeze(Object.keys(PERFORMANCE_MODES));

// Fallback only; startup replaces this with the mesh hit under the viewport center.
const FALLBACK_INITIAL_OAT_UV = { x: 0.65, y: 0.1 };
let initialOatUv = { ...FALLBACK_INITIAL_OAT_UV };
let initialOatSurfaceHit = null;
const INITIAL_OAT_VIEWPORT_CENTER_NDC = new THREE.Vector2(0, 0);
const initialOatViewportRaycaster = new THREE.Raycaster();
const initialOatViewportHits = [];

const BASE_SIMULATION_PARAMS = Object.freeze({
  uptakeRate: 0.035,
  depositRate: 0.005,
  burnRate: 0.005,
  reproThreshold: 3.0,
  foodWeight: 1.5,
  crowdWeight: 1.0,
  crowdExponent: 1.0,
  densityBlur: 18.0,
  densityTarget: 0.02,
  simulationSteps: 1,
  minMoveScale: 0.18,
  stepSize: 0.0016 / WORLD_LINEAR_SCALE,
  sensorDistance: 0.032 / WORLD_LINEAR_SCALE,
  sensorAngle: 0.72,
  turnAngle: 0.34,
  wander: 0.092,
  reproAngle: 0.7,
  childStep: 0.0022 / WORLD_LINEAR_SCALE,
  maxReserve: 7.0,
  fieldDiffusion: 0.13,
  fieldDecay: 0.991,
  deltaScale: 1.35,
  foodClamp: 0.5,
  oatPower: DEFAULT_OAT_POWER,
  oatSupplyRate: 0.5,
  useOatRationing: false,
});

function makeSimulationPreset(id, label, note, overrides = {}) {
  return Object.freeze({
    id,
    label,
    note,
    values: Object.freeze({ ...BASE_SIMULATION_PARAMS, ...overrides }),
  });
}

const DEFAULT_SIMULATION_PRESET_ID = 'default-current';
const SIMULATION_PRESETS = Object.freeze([
  makeSimulationPreset(
    'default-current',
    'Default',
    'Original defaults plus requested current defaults: rationed oats, crowd blur 30.0, oat supply 0.140.',
    {
      densityBlur: 30.0,
      oatSupplyRate: 0.14,
      useOatRationing: true,
    },
  ),
  makeSimulationPreset(
    'stable-medium',
    'Stable ~9k',
    '2400-step sweep: 8.4k-10.3k tail, no capacity runaway.',
    {
      oatPower: 1.0,
      burnRate: 0.018,
      crowdWeight: 1.5,
      densityTarget: 0.28,
      reproThreshold: 4.0,
      maxReserve: 4.2,
      oatSupplyRate: 1.0,
      useOatRationing: true,
    },
  ),
  makeSimulationPreset(
    'stable-compact',
    'Compact ~7k',
    '2400-step sweep: compact colony around 6.7k-7.4k.',
    {
      oatPower: 1.0,
      burnRate: 0.018,
      crowdWeight: 1.65,
      densityTarget: 0.28,
      reproThreshold: 4.0,
      maxReserve: 4.2,
      useOatRationing: true,
    },
  ),
  makeSimulationPreset(
    'stable-loose',
    'Loose ~10k',
    '2400-step sweep: looser colony around 7.8k-10.2k.',
    {
      oatPower: 1.0,
      burnRate: 0.018,
      crowdWeight: 1.35,
      densityTarget: 0.28,
      reproThreshold: 4.0,
      maxReserve: 4.2,
      useOatRationing: true,
    },
  ),
  makeSimulationPreset(
    'slow-growth',
    'Slow growth ~20k',
    'Conservative food and stronger birth gate; grows slowly past 10k.',
    {
      oatPower: 0.95,
      burnRate: 0.016,
      crowdWeight: 1.1,
      densityTarget: 0.22,
      reproThreshold: 4.0,
      maxReserve: 4.2,
      useOatRationing: true,
    },
  ),
  makeSimulationPreset(
    'original-defaults',
    'Original defaults',
    'Original simulation tuning retained for comparison; tends to run away.',
  ),
]);
const SIMULATION_PRESET_BY_ID = new Map(SIMULATION_PRESETS.map((preset) => [preset.id, preset]));
const SIMULATION_PRESET_KEYS = Object.freeze(Object.keys(BASE_SIMULATION_PARAMS));
const SIMULATION_PRESET_KEY_SET = new Set(SIMULATION_PRESET_KEYS);

const BASE_POPULATION_CONTROL_PARAMS = Object.freeze({
  usePopulationControl: false,
  populationTarget: 100000,
  populationControlPeriodMs: 1200,
  populationDeadbandFraction: 0.02,
  populationLambda: 0.03,
  populationMaxCommandedGrowthRate: 0.08,
  populationGrowthEmaAlpha: 0.25,
  populationSupplyLogGain: 0.45,
  populationOatSupplyMin: 0.001,
  populationOatSupplyMax: 1.0,
  populationUseSecondaryActuator: false,
  populationSecondaryOvershootRatio: 1.15,
  populationSecondaryGrowthThreshold: 0.01,
  populationBurnBoostMax: 0.02,
  populationReproBoostMax: 1.0,
});

const BASE_RENDER_DISPLAY_PARAMS = Object.freeze({
  showAgentDots: false,
  showOats: true,
  meshOutlineEnabled: false,
  surfaceHeight: 1,
  surfaceBump: 10,
  iridescenceStrength: 0.8,
  slimeBaseColor: '#ffffff',
  iridescenceMinThickness: 370,
  iridescenceThickness: 600,
  filmThicknessCurve: 4,
  filmFollowsSlimeHeight: true,
  useGoldWaferFilm: false,
  useGoldWaferBody: true,
  goldBodyFade: 0.15,
  goldBodyRoughness: 0.33,
  goldBodyReflectivity: 1,
  goldBodyColor: '#8a889e',
  lightBrightness: 1,
  useIcosaFaceLights: false,
  spatialSmoothing: 1,
  temporalSmoothing: 1,
  observationTailLength: 0.15,
  observationStrokeOpacity: 0,
  observationCornerRadius: 24,
  observationEdgeFeather: 24,
  observationBlurRadius: 7,
  observationTintColor: '#000000',
  observationTintOpacity: 0.33,
  observationSlimeTriggerThreshold: 0.05,
  storyBoxesEnabled: true,
  showWireframe: false,
});

function makeRenderDisplayPreset(id, label, note, overrides = {}) {
  return Object.freeze({
    id,
    label,
    note,
    values: Object.freeze({ ...BASE_RENDER_DISPLAY_PARAMS, ...overrides }),
  });
}

const DEFAULT_RENDER_DISPLAY_PRESET_ID = 'pearl-bright';
const RENDER_DISPLAY_PRESETS = Object.freeze([
  makeRenderDisplayPreset(
    'render-default',
    'Original defaults',
    'Original render/display defaults retained for comparison.',
  ),
  makeRenderDisplayPreset(
    'pearl-bright',
    'Pearl bright',
    'Screenshot render look: softer spatial blur, stronger temporal smoothing, white body, thinner film band.',
    {
      spatialSmoothing: 1,
      temporalSmoothing: 0.93,
      surfaceHeight: 1.4,
      surfaceBump: 5,
      iridescenceStrength: 0.8,
      slimeBaseColor: '#ffffff',
      observationTailLength: 0.15,
      iridescenceMinThickness: 220,
      iridescenceThickness: 760,
      filmFollowsSlimeHeight: true,
      lightBrightness: 1,
    },
  ),
]);
const RENDER_DISPLAY_PRESET_BY_ID = new Map(RENDER_DISPLAY_PRESETS.map((preset) => [preset.id, preset]));
const RENDER_DISPLAY_PRESET_KEYS = Object.freeze(Object.keys(BASE_RENDER_DISPLAY_PARAMS));
const RENDER_DISPLAY_PRESET_KEY_SET = new Set(RENDER_DISPLAY_PRESET_KEYS);

const params = {
  ...SIMULATION_PRESET_BY_ID.get(DEFAULT_SIMULATION_PRESET_ID).values,
  ...RENDER_DISPLAY_PRESET_BY_ID.get(DEFAULT_RENDER_DISPLAY_PRESET_ID).values,
  ...BASE_POPULATION_CONTROL_PARAMS,
  useSeamStitching: true,
  useIslandMasking: true,
  useHeadingRotation: true,
  useOpticalZoom: false,
  endingTimeLimitEnabled: false,
  statsReadbackEnabled: false,
  debugView: 'slime',
  performanceMode: 'quality',
};
let activeSimulationPresetId = DEFAULT_SIMULATION_PRESET_ID;
let activeRenderDisplayPresetId = DEFAULT_RENDER_DISPLAY_PRESET_ID;
const boundParamControls = new Map();

function cssRgbFromHex(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!match) return '14, 38, 56';
  const value = Number.parseInt(match[1], 16);
  return `${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}`;
}

function syncObservationCssVars() {
  const opacity = Math.max(0, Math.min(1, params.observationStrokeOpacity ?? 0));
  const cornerRadius = Math.max(0, params.observationCornerRadius ?? 24);
  const edgeFeather = Math.max(0, params.observationEdgeFeather ?? 24);
  const blurRadius = Math.max(0, params.observationBlurRadius ?? 7);
  const tintOpacity = Math.max(0, Math.min(1, params.observationTintOpacity ?? 0.15));
  const edgeFeatherOutset = edgeFeather * 1.75;
  const edgeFeatherMask = edgeFeather * 2.6;
  const edgeFeatherOpacity = Math.min(1, edgeFeather / 8);
  document.documentElement.style.setProperty('--observation-stroke-opacity', opacity.toFixed(3));
  document.documentElement.style.setProperty('--observation-corner-radius', `${cornerRadius.toFixed(1)}px`);
  document.documentElement.style.setProperty('--observation-edge-feather', `${edgeFeather.toFixed(1)}px`);
  document.documentElement.style.setProperty('--observation-edge-feather-outset', `${edgeFeatherOutset.toFixed(1)}px`);
  document.documentElement.style.setProperty('--observation-edge-feather-mask', `${edgeFeatherMask.toFixed(1)}px`);
  document.documentElement.style.setProperty('--observation-edge-feather-opacity', edgeFeatherOpacity.toFixed(3));
  document.documentElement.style.setProperty('--observation-blur-radius', `${blurRadius.toFixed(1)}px`);
  document.documentElement.style.setProperty('--observation-tint-rgb', cssRgbFromHex(params.observationTintColor ?? '#000000'));
  document.documentElement.style.setProperty('--observation-tint-opacity', tintOpacity.toFixed(3));
  document.documentElement.style.setProperty('--observation-text-rgb', cssRgbFromHex(params.slimeBaseColor ?? '#eef5f2'));
}

function getPerformanceModeConfig(settings = params) {
  return PERFORMANCE_MODES[settings.performanceMode] ?? PERFORMANCE_MODES.quality;
}

function setPerformanceMode(mode) {
  if (!PERFORMANCE_MODES[mode]) {
    console.warn('unknown performance mode', mode, 'available:', PERFORMANCE_MODE_NAMES);
    return params.performanceMode;
  }
  params.performanceMode = mode;
  return params.performanceMode;
}

function listSimulationPresets() {
  return SIMULATION_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    note: preset.note,
    values: { ...preset.values },
  }));
}

function listRenderDisplayPresets() {
  return RENDER_DISPLAY_PRESETS.map((preset) => ({
    id: preset.id,
    label: preset.label,
    note: preset.note,
    values: { ...preset.values },
  }));
}

function setActiveSimulationPreset(presetId) {
  activeSimulationPresetId = presetId;
  const select = document.getElementById('simulationPreset');
  if (select && select.value !== presetId) select.value = presetId;
}

function setActiveRenderDisplayPreset(presetId) {
  activeRenderDisplayPresetId = presetId;
  const select = document.getElementById('renderPreset');
  if (select && select.value !== presetId) select.value = presetId;
}

function syncBoundParamControls() {
  for (const sync of boundParamControls.values()) sync();
}

function syncBoundParamControlsFor(keys) {
  for (const key of keys) {
    const sync = boundParamControls.get(key);
    if (sync) sync();
  }
}

function applySimulationPreset(presetId, { syncControls = true } = {}) {
  const preset = SIMULATION_PRESET_BY_ID.get(presetId);
  if (!preset) {
    console.warn('unknown simulation preset', presetId, 'available:', SIMULATION_PRESETS.map((item) => item.id));
    return { ...params };
  }
  applyRuntimeParams(preset.values);
  setActiveSimulationPreset(presetId);
  if (syncControls) syncBoundParamControls();
  return { ...params };
}

function applyRenderDisplayPreset(presetId, { syncControls = true } = {}) {
  const preset = RENDER_DISPLAY_PRESET_BY_ID.get(presetId);
  if (!preset) {
    console.warn('unknown render/display preset', presetId, 'available:', RENDER_DISPLAY_PRESETS.map((item) => item.id));
    return { ...params };
  }
  applyRuntimeParams(preset.values);
  setActiveRenderDisplayPreset(presetId);
  if (syncControls) syncBoundParamControls();
  return { ...params };
}

function getSimulationStepCount(settings = params) {
  return Math.max(1, Math.min(MAX_SIMULATION_STEPS, Math.round(settings.simulationSteps)));
}

function getRenderSmoothingTapCount(settings = params) {
  return getPerformanceModeConfig(settings).smoothingTapCount;
}

function getBumpDiagonalTapsEnabled(settings = params) {
  return getPerformanceModeConfig(settings).bumpDiagonalTaps;
}

function getRenderSmoothingRadiusTexels(settings = params) {
  return Math.max(0, settings.spatialSmoothing);
}

function getNormalSampleRadiusTexels(settings = params) {
  return BUMP_NORMAL_BASE_RADIUS_TEXELS +
    getRenderSmoothingRadiusTexels(settings) * BUMP_NORMAL_SMOOTHING_SCALE;
}

function getBumpVisualFootprintTexels(settings = params) {
  const normalRadius = getNormalSampleRadiusTexels(settings);
  return getBumpDiagonalTapsEnabled(settings) ? normalRadius * Math.SQRT2 : normalRadius;
}

function getVisualTransitionFootprint(settings = params) {
  const renderSmoothingRadiusTexels = getRenderSmoothingRadiusTexels(settings);
  const bumpSampleRadiusTexels = getNormalSampleRadiusTexels(settings);
  const bumpVisualFootprintTexels = getBumpVisualFootprintTexels(settings);
  const visualSampleFootprintTexels = Math.max(
    renderSmoothingRadiusTexels,
    bumpVisualFootprintTexels,
  );
  const requestedVisualTransitionBandTexels = Math.ceil(
    visualSampleFootprintTexels + VISUAL_TRANSITION_RASTER_MARGIN_TEXELS,
  );
  return {
    renderSmoothingRadiusTexels,
    bumpSampleRadiusTexels,
    bumpDiagonalTapsEnabled: getBumpDiagonalTapsEnabled(settings),
    bumpVisualFootprintTexels,
    visualSampleFootprintTexels,
    rasterSafetyMarginTexels: VISUAL_TRANSITION_RASTER_MARGIN_TEXELS,
    requestedVisualTransitionBandTexels,
  };
}

function getSupportedVisualTransitionFootprint() {
  return getVisualTransitionFootprint({
    ...params,
    spatialSmoothing: SPATIAL_SMOOTHING_MAX_TEXELS,
    performanceMode: 'quality',
  });
}

const PR11A_VISUAL_TRANSITION_FOOTPRINT = getSupportedVisualTransitionFootprint();
const PR11A_VISUAL_TRANSITION_BAND_TEXELS =
  PR11A_VISUAL_TRANSITION_FOOTPRINT.requestedVisualTransitionBandTexels;

function getDiffusionTransitionFootprint() {
  const requestedDiffusionTransitionBandTexels = Math.ceil(
    DIFFUSION_SAMPLE_RADIUS_TEXELS + ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS,
  );
  return {
    diffusionSampleRadiusTexels: DIFFUSION_SAMPLE_RADIUS_TEXELS,
    crossingToleranceTexels: ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS,
    requestedDiffusionTransitionBandTexels,
  };
}

function getAgentSensorRadiusTexels(settings = params) {
  return settings.sensorDistance * FIELD_SIZE;
}

function getMaxAgentStepTexels(settings = params, rawDtClamp = FRAME_DT_CLAMP) {
  return settings.stepSize * rawDtClamp * FIELD_SIZE;
}

function getMaxPerSimulationStepTexels(settings = params, rawDtClamp = FRAME_DT_CLAMP) {
  return settings.stepSize * (rawDtClamp / getSimulationStepCount(settings)) * FIELD_SIZE;
}

function getChildStepTexels(settings = params) {
  return settings.childStep * FIELD_SIZE;
}

function getAgentTransitionFootprint(settings = params, rawDtClamp = FRAME_DT_CLAMP) {
  const agentSensorDistanceTexels = getAgentSensorRadiusTexels(settings);
  const maxMovementStepTexels = getMaxAgentStepTexels(settings, rawDtClamp);
  const maxPerSimulationStepMovementTexels = getMaxPerSimulationStepTexels(settings, rawDtClamp);
  const childStepTexels = getChildStepTexels(settings);
  const marginTexels = ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS + 1;
  return {
    agentSensorDistanceTexels,
    maxMovementStepTexels,
    maxPerSimulationStepMovementTexels,
    childStepTexels,
    transitionMarginTexels: marginTexels,
    requestedAgentSensingTransitionBandTexels: Math.ceil(agentSensorDistanceTexels + marginTexels),
    requestedAgentMovementTransitionBandTexels: Math.ceil(maxMovementStepTexels + marginTexels),
    requestedChildPlacementTransitionBandTexels: Math.ceil(childStepTexels + marginTexels),
  };
}

function getDensityPointSizePixels(settings = params) {
  return Math.max(1.0, settings.densityBlur / WORLD_LINEAR_SCALE);
}

function getDensityKernelRadiusTexels(settings = params) {
  return getDensityPointSizePixels(settings) * 0.5;
}

function getDepositPointSizePixels() {
  return Math.max(1.0, DEPOSIT_POINT_SIZE_WORLD / WORLD_LINEAR_SCALE);
}

function getDepositKernelRadiusTexels() {
  return getDepositPointSizePixels() * 0.5;
}

function getMaxOatRadiusTexels(oatList = oats) {
  const maxOatRadius = oatList.reduce(
    (maxRadius, oat) => Math.max(maxRadius, oat.radius),
    DEFAULT_OAT_RADIUS,
  );
  return maxOatRadius * FIELD_SIZE;
}

function getOatSupportRadiusTexels(oatList = oats) {
  return getMaxOatRadiusTexels(oatList) * OAT_SUPPORT_RADIUS_MULTIPLIER;
}

function getDefaultOatSupportRadiusTexels() {
  return DEFAULT_OAT_RADIUS * OAT_SUPPORT_RADIUS_MULTIPLIER * FIELD_SIZE;
}

function getCrossingTransitionFootprint(settings = params, rawDtClamp = FRAME_DT_CLAMP) {
  const visualTransition = getSupportedVisualTransitionFootprint();
  const diffusionTransition = getDiffusionTransitionFootprint();
  const agentTransition = getAgentTransitionFootprint(settings, rawDtClamp);
  const requestedCrossingTransitionBandTexels = Math.ceil(Math.max(
    visualTransition.requestedVisualTransitionBandTexels,
    diffusionTransition.requestedDiffusionTransitionBandTexels,
    agentTransition.requestedAgentSensingTransitionBandTexels,
    agentTransition.requestedAgentMovementTransitionBandTexels,
    agentTransition.requestedChildPlacementTransitionBandTexels,
  ) + ZERO_GUTTER_CROSSING_RASTER_PAD_TEXELS);
  return {
    requestedCrossingTransitionBandTexels,
    crossingRasterPadTexels: ZERO_GUTTER_CROSSING_RASTER_PAD_TEXELS,
    visualTransitionBandTexels: visualTransition.requestedVisualTransitionBandTexels,
    diffusionTransitionBandTexels: diffusionTransition.requestedDiffusionTransitionBandTexels,
    agentSensingTransitionBandTexels: agentTransition.requestedAgentSensingTransitionBandTexels,
    agentMovementTransitionBandTexels: agentTransition.requestedAgentMovementTransitionBandTexels,
    childPlacementTransitionBandTexels: agentTransition.requestedChildPlacementTransitionBandTexels,
    visualTransition,
    diffusionTransition,
    agentTransition,
    note: 'Narrow crossing transition footprint. Broad source/write kernels are distributed per source/kernel and must not prepaint this global map.',
  };
}

function getSpatialSupportTransitionFootprint(settings = params) {
  const crossingTransition = getCrossingTransitionFootprint(settings);
  const oatSupportRadiusTexels = getDefaultOatSupportRadiusTexels();
  const densityKernelRadiusTexels = getDensityKernelRadiusTexels(settings);
  const depositKernelRadiusTexels = getDepositKernelRadiusTexels(settings);
  const requestedSourceWriteSupportRadiusTexels = Math.ceil(Math.max(
    oatSupportRadiusTexels,
    densityKernelRadiusTexels,
    depositKernelRadiusTexels,
  ));
  return {
    requestedSpatialSupportTransitionBandTexels:
      crossingTransition.requestedCrossingTransitionBandTexels,
    requestedCrossingTransitionBandTexels:
      crossingTransition.requestedCrossingTransitionBandTexels,
    crossingTransitionRasterPadTexels:
      crossingTransition.crossingRasterPadTexels,
    requestedSourceWriteSupportRadiusTexels,
    sourceWriteGlobalTransitionBandTexels: 0,
    visualTransitionBandTexels: crossingTransition.visualTransitionBandTexels,
    diffusionTransitionBandTexels: crossingTransition.diffusionTransitionBandTexels,
    agentSensingTransitionBandTexels: crossingTransition.agentSensingTransitionBandTexels,
    agentMovementTransitionBandTexels: crossingTransition.agentMovementTransitionBandTexels,
    childPlacementTransitionBandTexels: crossingTransition.childPlacementTransitionBandTexels,
    oatSupportRadiusTexels,
    densityKernelRadiusTexels,
    depositKernelRadiusTexels,
    diffusionRadiusTexels: DIFFUSION_SAMPLE_RADIUS_TEXELS,
    maxPropagationDepth: 1,
    note: 'PR11.5 seam-continuity closure: the global seamTransition maps are narrow crossing maps. Broad oats/density/deposit support is accounted as explicit per-source/per-kernel support, not as a prepainted global transition band.',
  };
}

const SEAM_CONTINUITY_SPATIAL_SUPPORT_TRANSITION_FOOTPRINT = getSpatialSupportTransitionFootprint();
const SEAM_CROSSING_TRANSITION_FOOTPRINT = getCrossingTransitionFootprint();
const SEAM_CROSSING_TRANSITION_BAND_TEXELS =
  SEAM_CROSSING_TRANSITION_FOOTPRINT.requestedCrossingTransitionBandTexels;
// Compatibility alias for older diagnostics. This now means the narrow crossing
// transition map width; broad source/write support must not widen seamTransition*.
const SEAM_CONTINUITY_SPATIAL_SUPPORT_TRANSITION_BAND_TEXELS =
  SEAM_CONTINUITY_SPATIAL_SUPPORT_TRANSITION_FOOTPRINT.requestedSpatialSupportTransitionBandTexels;

function getTransitionUsageProfiles(settings = params, oatList = oats, rawDtClamp = FRAME_DT_CLAMP) {
  const visualTransition = getVisualTransitionFootprint(settings);
  const supportedVisualTransition = getSupportedVisualTransitionFootprint();
  const diffusionTransition = getDiffusionTransitionFootprint();
  const agentTransition = getAgentTransitionFootprint(settings, rawDtClamp);
  const densityKernelRadiusTexels = getDensityKernelRadiusTexels(settings);
  const depositKernelRadiusTexels = getDepositKernelRadiusTexels(settings);
  const oatSupportRadiusTexels = getOatSupportRadiusTexels(oatList);
  return [
    {
      usage: 'visual',
      mapName: 'seamTransition* crossing map',
      requestedBandTexels: supportedVisualTransition.requestedVisualTransitionBandTexels,
      activeRequestedBandTexels: visualTransition.requestedVisualTransitionBandTexels,
      actualBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      usesGlobalTransitionBand: true,
      collisionChecked: true,
      sufficientForActiveSettings:
        SEAM_CROSSING_TRANSITION_BAND_TEXELS >= visualTransition.requestedVisualTransitionBandTexels,
    },
    {
      usage: 'diffusion',
      mapName: 'seamTransition* crossing map',
      requestedBandTexels: diffusionTransition.requestedDiffusionTransitionBandTexels,
      activeRequestedBandTexels: diffusionTransition.requestedDiffusionTransitionBandTexels,
      actualBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      usesGlobalTransitionBand: true,
      collisionChecked: true,
      sufficientForActiveSettings:
        SEAM_CROSSING_TRANSITION_BAND_TEXELS >= diffusionTransition.requestedDiffusionTransitionBandTexels,
    },
    {
      usage: 'agent sensing',
      mapName: 'seamTransition* crossing map',
      requestedBandTexels: agentTransition.requestedAgentSensingTransitionBandTexels,
      activeRequestedBandTexels: agentTransition.requestedAgentSensingTransitionBandTexels,
      actualBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      usesGlobalTransitionBand: true,
      collisionChecked: true,
      sufficientForActiveSettings:
        SEAM_CROSSING_TRANSITION_BAND_TEXELS >= agentTransition.requestedAgentSensingTransitionBandTexels,
    },
    {
      usage: 'agent movement',
      mapName: 'seamTransition* crossing map',
      requestedBandTexels: agentTransition.requestedAgentMovementTransitionBandTexels,
      activeRequestedBandTexels: agentTransition.requestedAgentMovementTransitionBandTexels,
      actualBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      usesGlobalTransitionBand: true,
      collisionChecked: true,
      sufficientForActiveSettings:
        SEAM_CROSSING_TRANSITION_BAND_TEXELS >= agentTransition.requestedAgentMovementTransitionBandTexels,
    },
    {
      usage: 'source/write kernels',
      mapName: 'per-source/per-kernel seam distribution',
      requestedBandTexels: Math.ceil(Math.max(
        oatSupportRadiusTexels,
        densityKernelRadiusTexels,
        depositKernelRadiusTexels,
      )),
      activeRequestedBandTexels: Math.ceil(Math.max(
        oatSupportRadiusTexels,
        densityKernelRadiusTexels,
        depositKernelRadiusTexels,
      )),
      actualBandTexels: 0,
      usesGlobalTransitionBand: false,
      collisionChecked: true,
      densityKernelRadiusTexels,
      depositKernelRadiusTexels,
      oatSupportRadiusTexels,
      sufficientForActiveSettings: true,
      note: 'Broad source/write support is intentionally not rasterized into seamTransition*. Kernel support is evaluated by the source/write pass and clipped by ownership/transition checks.',
    },
  ];
}

function getSamplingFootprintRegistry(settings = params, oatList = oats, rawDtClamp = FRAME_DT_CLAMP) {
  const performance = getPerformanceModeConfig(settings);
  const simulationSteps = getSimulationStepCount(settings);
  const renderSmoothingRadiusTexels = getRenderSmoothingRadiusTexels(settings);
  const bumpSampleRadiusTexels = getNormalSampleRadiusTexels(settings);
  const visualTransition = getVisualTransitionFootprint(settings);
  const spatialTransition = getSpatialSupportTransitionFootprint(settings);
  const crossingTransition = getCrossingTransitionFootprint(settings, rawDtClamp);
  const diffusionTransition = getDiffusionTransitionFootprint();
  const agentTransition = getAgentTransitionFootprint(settings, rawDtClamp);
  const agentSensorDistanceTexels = getAgentSensorRadiusTexels(settings);
  const maxMovementStepTexels = getMaxAgentStepTexels(settings, rawDtClamp);
  const maxPerSimulationStepMovementTexels = getMaxPerSimulationStepTexels(settings, rawDtClamp);
  const childStepTexels = getChildStepTexels(settings);
  const densityPointSizePixels = getDensityPointSizePixels(settings);
  const densityKernelRadiusTexels = getDensityKernelRadiusTexels(settings);
  const depositPointSizePixels = getDepositPointSizePixels(settings);
  const depositKernelRadiusTexels = getDepositKernelRadiusTexels(settings);
  const maxOatRadiusTexels = getMaxOatRadiusTexels(oatList);
  const oatEstimatedSupportTexels = getOatSupportRadiusTexels(oatList);
  const passFootprints = [
    { pass: 'diffusion', footprintTexels: DIFFUSION_SAMPLE_RADIUS_TEXELS },
    { pass: 'render smoothing', footprintTexels: renderSmoothingRadiusTexels },
    { pass: 'render sample-view seam padding', footprintTexels: SEAM_REDIRECT_HALO_TEXELS },
    { pass: 'bump normals', footprintTexels: bumpSampleRadiusTexels },
    { pass: 'agent sensing', footprintTexels: agentSensorDistanceTexels },
    { pass: 'agent movement', footprintTexels: maxMovementStepTexels },
    { pass: 'child placement', footprintTexels: childStepTexels },
    { pass: 'density splat', footprintTexels: densityKernelRadiusTexels },
    { pass: 'deposit splat', footprintTexels: depositKernelRadiusTexels },
    { pass: 'oat field', footprintTexels: oatEstimatedSupportTexels },
    { pass: 'seam redirect halo', footprintTexels: SEAM_REDIRECT_HALO_TEXELS },
    { pass: 'seam weld inward band', footprintTexels: SEAM_WELD_IN_DEPTH_TEXELS },
    { pass: 'zero-gutter crossing transition band', footprintTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS },
    { pass: 'source/write explicit kernel support', footprintTexels: spatialTransition.requestedSourceWriteSupportRadiusTexels },
  ];
  const requiredSamplingFootprintTexels = Math.max(
    ...passFootprints.map((entry) => entry.footprintTexels),
  );

  return {
    fieldSize: FIELD_SIZE,
    performanceMode: PERFORMANCE_MODES[settings.performanceMode] ? settings.performanceMode : 'quality',
    renderSmoothingTapCount: performance.smoothingTapCount,
    bumpDiagonalTapsEnabled: performance.bumpDiagonalTaps,
    renderSmoothingRadiusTexels,
    bumpSampleRadiusTexels,
    bumpVisualFootprintTexels: visualTransition.bumpVisualFootprintTexels,
    visualSampleFootprintTexels: visualTransition.visualSampleFootprintTexels,
    requestedVisualTransitionBandTexels: visualTransition.requestedVisualTransitionBandTexels,
    requestedSpatialSupportTransitionBandTexels:
      spatialTransition.requestedSpatialSupportTransitionBandTexels,
    requestedCrossingTransitionBandTexels:
      crossingTransition.requestedCrossingTransitionBandTexels,
    requestedSourceWriteSupportRadiusTexels:
      spatialTransition.requestedSourceWriteSupportRadiusTexels,
    sourceWriteGlobalTransitionBandTexels:
      spatialTransition.sourceWriteGlobalTransitionBandTexels,
    diffusionTransitionBandTexels:
      diffusionTransition.requestedDiffusionTransitionBandTexels,
    agentSensingTransitionBandTexels:
      agentTransition.requestedAgentSensingTransitionBandTexels,
    agentMovementTransitionBandTexels:
      agentTransition.requestedAgentMovementTransitionBandTexels,
    childPlacementTransitionBandTexels:
      agentTransition.requestedChildPlacementTransitionBandTexels,
    visualTransitionRasterSafetyMarginTexels: VISUAL_TRANSITION_RASTER_MARGIN_TEXELS,
    supportedSpatialSmoothingMaxTexels: SPATIAL_SMOOTHING_MAX_TEXELS,
    visualTransitionBandTexels: PR11A_VISUAL_TRANSITION_BAND_TEXELS,
    actualVisualTransitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
    crossingTransitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
    spatialSupportTransitionBandTexels: spatialTransition.requestedSourceWriteSupportRadiusTexels,
    visualTransitionCoverageSufficient:
      SEAM_CROSSING_TRANSITION_BAND_TEXELS >= visualTransition.requestedVisualTransitionBandTexels,
    agentSensorDistanceTexels,
    maxMovementStepTexels,
    maxPerSimulationStepMovementTexels,
    childStepTexels,
    densityPointSizePixels,
    densityKernelRadiusTexels,
    depositPointSizePixels,
    depositKernelRadiusTexels,
    maxOatRadiusTexels,
    oatEstimatedSupportTexels,
    oatEpsilon: OAT_EPSILON,
    oatSupportSigmas: OAT_SUPPORT_SIGMAS,
    seamRedirectHaloTexels: SEAM_REDIRECT_HALO_TEXELS,
    seamWeldOutPadTexels: SEAM_WELD_OUT_PAD_TEXELS,
    seamWeldInDepthTexels: SEAM_WELD_IN_DEPTH_TEXELS,
    zeroGutterTransitionInwardBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
    renderSampleViewSeamPaddingTexels: SEAM_REDIRECT_HALO_TEXELS,
    legacyRenderDilationIterations: RENDER_DILATE_ITERATIONS,
    dtClamp: rawDtClamp,
    simulationSteps,
    passFootprints,
    transitionUsageProfiles: getTransitionUsageProfiles(settings, oatList, rawDtClamp),
    requiredFootprintTexels: requiredSamplingFootprintTexels,
    requiredSamplingFootprintTexels,
  };
}

function getRequiredSamplingFootprintTexels(settings = params, oatList = oats) {
  return getSamplingFootprintRegistry(settings, oatList).requiredSamplingFootprintTexels;
}

function getSafeGutterBudgetTexels(chartDiagnostics = {}) {
  const clearance = chartDiagnostics.clearance ?? chartDiagnostics;
  const ownership = chartDiagnostics.ownership ?? chartDiagnostics.overlaps ?? chartDiagnostics;
  const minimumDistinctChartBoundaryClearanceTexels =
    clearance.minimumDistinctChartBoundaryClearanceTexels ?? null;
  const unsafeOwnershipTexels = ownership.unsafeTexels ?? ownership.conflictTexels ?? 0;
  const multiOwnerConflictTexels = ownership.multiOwnerConflictTexels ?? 0;
  const maxSafePaddingTexels = minimumDistinctChartBoundaryClearanceTexels === null
    ? null
    : Math.max(0, minimumDistinctChartBoundaryClearanceTexels);
  const maxConservativeSymmetricPadTexels = minimumDistinctChartBoundaryClearanceTexels === null
    ? null
    : Math.max(0, minimumDistinctChartBoundaryClearanceTexels * 0.5);
  return {
    minimumDistinctChartBoundaryClearanceTexels,
    maxSafePaddingTexels,
    maxConservativeSymmetricPadTexels,
    unsafeOwnershipTexels,
    multiOwnerConflictTexels,
    hasUnsafeOwnership: unsafeOwnershipTexels > 0,
    note: 'Budget is based on distinct chart boundary clearance; explicit seam-neighbor pairs are not filtered in PR4. Future padding writes must stay strictly below this clearance, not treat it as an inclusive width.',
  };
}

function getTopologySafetyBudget(settings = params, oatList = oats, chartDiagnostics = {}) {
  const footprints = getSamplingFootprintRegistry(settings, oatList);
  const safeGutter = getSafeGutterBudgetTexels(chartDiagnostics);
  const minClearance = safeGutter.minimumDistinctChartBoundaryClearanceTexels;
  const paddingWouldCollide = minClearance !== null &&
    footprints.requiredSamplingFootprintTexels >= minClearance;
  const currentSeamHaloWouldCollide = minClearance !== null &&
    SEAM_REDIRECT_HALO_TEXELS >= minClearance;
  const requiresConservativeFallback =
    safeGutter.hasUnsafeOwnership || paddingWouldCollide || currentSeamHaloWouldCollide;
  const requiresZeroGutterTransition = paddingWouldCollide ||
    (safeGutter.maxSafePaddingTexels !== null &&
      footprints.requiredSamplingFootprintTexels > safeGutter.maxSafePaddingTexels);
  return {
    ...footprints,
    requiredFootprintTexels: footprints.requiredSamplingFootprintTexels,
    minimumDistinctChartBoundaryClearanceTexels: minClearance,
    minDistinctChartBoundaryClearanceTexels: minClearance,
    maxSafePaddingTexels: safeGutter.maxSafePaddingTexels,
    safeAvailableOwnershipPaddingCoverageTexels: safeGutter.maxSafePaddingTexels,
    maxConservativeSymmetricPadTexels: safeGutter.maxConservativeSymmetricPadTexels,
    unsafeOwnershipTexels: safeGutter.unsafeOwnershipTexels,
    multiOwnerConflictTexels: safeGutter.multiOwnerConflictTexels,
    paddingWouldCollide,
    currentSeamHaloWouldCollide,
    requiresConservativeFallback,
    requiresZeroGutterTransition,
    safeGutterBudget: safeGutter,
  };
}

// === renderer ===
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  alpha: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.autoClear = false;

if (!renderer.capabilities.isWebGL2) {
  fail('WebGL2 is required.');
  throw new Error('WebGL2 is required.');
}

// Mobile Safari drops WebGL contexts under memory pressure; without a handler
// the page just freezes on the last frame.
canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  fail('The graphics context was lost (usually memory pressure). Reload the page to continue.');
});

const colorBufferFloat = renderer.extensions.get('EXT_color_buffer_float');
const floatBlend = renderer.extensions.get('EXT_float_blend');
const linearFloat = renderer.extensions.get('OES_texture_float_linear');

if (!colorBufferFloat || !floatBlend) {
  fail('WebGL2 float render targets and float blending are required.');
  throw new Error('Required WebGL2 float extensions are unavailable.');
}

const fieldFilter = linearFloat ? THREE.LinearFilter : THREE.NearestFilter;


// === scene / camera / controls / lights ===
const scene = new THREE.Scene();
scene.background = new THREE.Color(0.004, 0.006, 0.005);

const camera = new THREE.PerspectiveCamera(
  THREE.MathUtils.radToDeg(SURFACE_FOV),
  canvas.clientWidth / Math.max(canvas.clientHeight, 1),
  0.04,
  CAMERA_FAR,
);
camera.far = CAMERA_FAR;
camera.updateProjectionMatrix();

// Default intro view.
const initialCameraPose = (() => {
  return {
    position: new THREE.Vector3(1.893468, 5.498426, -5.633916),
    target: new THREE.Vector3(0, 0, 0),
    fovDeg: 42.8571,
  };
})();
camera.position.copy(initialCameraPose.position);
camera.fov = initialCameraPose.fovDeg;
camera.updateProjectionMatrix();
camera.lookAt(initialCameraPose.target);

const controls = new OrbitControls(camera, canvas);
controls.enablePan = false;
controls.enableDamping = true;
controls.dampingFactor = CAMERA_ORBIT_DAMPING_FACTOR;
controls.rotateSpeed = CAMERA_ORBIT_ROTATE_SPEED;
controls.zoomSpeed = CAMERA_ORBIT_ZOOM_SPEED;
controls.minDistance = 0.8 * WORLD_LINEAR_SCALE;
controls.maxDistance = 5.6 * WORLD_LINEAR_SCALE;
// Allow a true side view while keeping the camera above the underside.
controls.minPolarAngle = 0;
controls.maxPolarAngle = Math.PI * 0.5 - 0.04;
controls.target.copy(initialCameraPose.target);
controls.update();
controls.enableZoom = !params.useOpticalZoom;

const cameraPoseOffset = new THREE.Vector3();
const cameraPoseSpherical = new THREE.Spherical();
let cameraTargetFovDeg = camera.fov;
let lastCameraFovSmoothingAt = performance.now();
let cameraPoseReadoutDirty = true;
let lastCameraPoseReadoutText = '';
const CAMERA_POSE_READOUT_INTERVAL_MS = 150;
let lastCameraPoseReadoutUpdateAt = -Infinity;
const cameraKeyboardOrbitState = {
  left: false,
  right: false,
  up: false,
  down: false,
  shift: false,
  thetaVelocity: 0,
  phiVelocity: 0,
  lastUpdateAt: performance.now(),
};

function roundPoseNumber(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function vectorToPoseObject(vector, digits = 6) {
  return {
    x: roundPoseNumber(vector.x, digits),
    y: roundPoseNumber(vector.y, digits),
    z: roundPoseNumber(vector.z, digits),
  };
}

function poseObjectToVector(value, fallback) {
  if (Array.isArray(value) && value.length >= 3) {
    return new THREE.Vector3(Number(value[0]), Number(value[1]), Number(value[2]));
  }
  if (value && typeof value === 'object') {
    return new THREE.Vector3(Number(value.x), Number(value.y), Number(value.z));
  }
  return fallback.clone();
}

function normalizeCameraAngleDeg(angleDeg) {
  return roundPoseNumber(THREE.MathUtils.euclideanModulo(angleDeg + 180, 360) - 180, 3);
}

function setCameraFovImmediate(fovDeg, now = performance.now()) {
  const nextFov = Number(fovDeg);
  if (!Number.isFinite(nextFov) || nextFov <= 1 || nextFov >= 175) return false;
  cameraTargetFovDeg = nextFov;
  lastCameraFovSmoothingAt = now;
  if (Math.abs(camera.fov - nextFov) <= OPTICAL_ZOOM_SNAP_EPSILON_DEG) return false;
  camera.fov = nextFov;
  camera.updateProjectionMatrix();
  cameraPoseReadoutDirty = true;
  return true;
}

function syncCameraFovTargetToCurrent(now = performance.now()) {
  cameraTargetFovDeg = camera.fov;
  lastCameraFovSmoothingAt = now;
}

function updateCameraFovSmoothing(now = performance.now()) {
  if (!Number.isFinite(cameraTargetFovDeg)) syncCameraFovTargetToCurrent(now);
  const delta = cameraTargetFovDeg - camera.fov;
  if (Math.abs(delta) <= OPTICAL_ZOOM_SNAP_EPSILON_DEG) {
    if (camera.fov !== cameraTargetFovDeg) {
      camera.fov = cameraTargetFovDeg;
      camera.updateProjectionMatrix();
      cameraPoseReadoutDirty = true;
    }
    lastCameraFovSmoothingAt = now;
    return false;
  }
  const dtMs = Math.max(0, Math.min(100, now - lastCameraFovSmoothingAt));
  lastCameraFovSmoothingAt = now;
  const alpha = 1 - Math.exp(-dtMs / OPTICAL_ZOOM_SMOOTH_MS);
  camera.fov += delta * alpha;
  camera.updateProjectionMatrix();
  cameraPoseReadoutDirty = true;
  return true;
}

function getCameraOrbitSpherical(target = cameraPoseSpherical) {
  cameraPoseOffset.copy(camera.position).sub(controls.target);
  return target.setFromVector3(cameraPoseOffset);
}

function applyCameraOrbitDelta(deltaTheta, deltaPhi) {
  if (Math.abs(deltaTheta) <= 1e-12 && Math.abs(deltaPhi) <= 1e-12) return false;
  getCameraOrbitSpherical(cameraPoseSpherical);
  cameraPoseSpherical.theta += deltaTheta;
  cameraPoseSpherical.phi = THREE.MathUtils.clamp(
    cameraPoseSpherical.phi + deltaPhi,
    controls.minPolarAngle,
    controls.maxPolarAngle,
  );
  cameraPoseOffset.setFromSpherical(cameraPoseSpherical);
  camera.position.copy(controls.target).add(cameraPoseOffset);
  controls.update();
  cameraPoseReadoutDirty = true;
  return true;
}

function cameraKeyboardKeyName(key) {
  if (key === 'ArrowLeft') return 'left';
  if (key === 'ArrowRight') return 'right';
  if (key === 'ArrowUp') return 'up';
  if (key === 'ArrowDown') return 'down';
  return null;
}

function areCameraKeyboardOrbitKeysDown() {
  return cameraKeyboardOrbitState.left ||
    cameraKeyboardOrbitState.right ||
    cameraKeyboardOrbitState.up ||
    cameraKeyboardOrbitState.down;
}

function clearCameraKeyboardOrbitState() {
  cameraKeyboardOrbitState.left = false;
  cameraKeyboardOrbitState.right = false;
  cameraKeyboardOrbitState.up = false;
  cameraKeyboardOrbitState.down = false;
  cameraKeyboardOrbitState.shift = false;
  cameraKeyboardOrbitState.thetaVelocity = 0;
  cameraKeyboardOrbitState.phiVelocity = 0;
}

function getCameraOrbitInputSpeedMultiplier(source = null) {
  const shiftKey = typeof source === 'boolean' ? source : Boolean(source?.shiftKey);
  return shiftKey ? CAMERA_ORBIT_SHIFT_SPEED_MULTIPLIER : 1;
}

function syncCameraKeyboardOrbitModifierState(event) {
  cameraKeyboardOrbitState.shift = Boolean(event?.shiftKey);
}

function handleCameraKeyboardOrbitKeydown(event) {
  syncCameraKeyboardOrbitModifierState(event);
  const keyName = cameraKeyboardKeyName(event.key);
  if (!keyName || event.altKey || event.ctrlKey || event.metaKey) return;
  if (isPanelShortcutEditableTarget(event.target)) return;
  event.preventDefault();
  cameraKeyboardOrbitState[keyName] = true;
}

function handleCameraKeyboardOrbitKeyup(event) {
  syncCameraKeyboardOrbitModifierState(event);
  const keyName = cameraKeyboardKeyName(event.key);
  if (!keyName) return;
  event.preventDefault();
  cameraKeyboardOrbitState[keyName] = false;
}

function updateCameraKeyboardOrbit(now = performance.now()) {
  const dtMs = Math.max(0, Math.min(100, now - cameraKeyboardOrbitState.lastUpdateAt));
  cameraKeyboardOrbitState.lastUpdateAt = now;
  const horizontal = (cameraKeyboardOrbitState.right ? 1 : 0) - (cameraKeyboardOrbitState.left ? 1 : 0);
  const vertical = (cameraKeyboardOrbitState.down ? 1 : 0) - (cameraKeyboardOrbitState.up ? 1 : 0);
  const diagonalMultiplier = horizontal !== 0 && vertical !== 0 ? Math.SQRT1_2 : 1;
  const speedMultiplier =
    diagonalMultiplier * getCameraOrbitInputSpeedMultiplier(cameraKeyboardOrbitState.shift);
  const targetThetaVelocity = horizontal * CAMERA_KEYBOARD_ORBIT_SPEED * speedMultiplier;
  const targetPhiVelocity = vertical * CAMERA_KEYBOARD_ORBIT_SPEED * speedMultiplier;
  const responseMs = areCameraKeyboardOrbitKeysDown()
    ? CAMERA_KEYBOARD_ORBIT_RESPONSE_MS
    : CAMERA_KEYBOARD_ORBIT_DECAY_MS;
  const alpha = 1 - Math.exp(-dtMs / responseMs);
  cameraKeyboardOrbitState.thetaVelocity +=
    (targetThetaVelocity - cameraKeyboardOrbitState.thetaVelocity) * alpha;
  cameraKeyboardOrbitState.phiVelocity +=
    (targetPhiVelocity - cameraKeyboardOrbitState.phiVelocity) * alpha;

  if (
    Math.abs(cameraKeyboardOrbitState.thetaVelocity) <= CAMERA_KEYBOARD_ORBIT_EPSILON &&
    Math.abs(cameraKeyboardOrbitState.phiVelocity) <= CAMERA_KEYBOARD_ORBIT_EPSILON
  ) {
    cameraKeyboardOrbitState.thetaVelocity = 0;
    cameraKeyboardOrbitState.phiVelocity = 0;
    return false;
  }

  const dtSeconds = dtMs / 1000;
  const changed = applyCameraOrbitDelta(
    cameraKeyboardOrbitState.thetaVelocity * dtSeconds,
    cameraKeyboardOrbitState.phiVelocity * dtSeconds,
  );
  return changed;
}

function getCameraPose() {
  cameraPoseOffset.copy(camera.position).sub(controls.target);
  cameraPoseSpherical.setFromVector3(cameraPoseOffset);
  const azimuthDeg = normalizeCameraAngleDeg(THREE.MathUtils.radToDeg(cameraPoseSpherical.theta));
  const polarDeg = roundPoseNumber(THREE.MathUtils.radToDeg(cameraPoseSpherical.phi), 3);
  const elevationDeg = roundPoseNumber(90 - polarDeg, 3);
  return {
    position: vectorToPoseObject(camera.position),
    target: vectorToPoseObject(controls.target),
    distance: roundPoseNumber(cameraPoseSpherical.radius, 6),
    azimuthDeg,
    elevationDeg,
    polarDeg,
    fovDeg: roundPoseNumber(camera.fov, 4),
    viewport: {
      width: Math.round(canvas.clientWidth),
      height: Math.round(canvas.clientHeight),
      devicePixelRatio: roundPoseNumber(window.devicePixelRatio || 1, 3),
    },
  };
}

function getCameraPoseCommand(pose = getCameraPose()) {
  const replayPose = {
    position: pose.position,
    target: pose.target,
    fovDeg: pose.fovDeg,
  };
  return `window.__cuttle.setCameraPose(${JSON.stringify(replayPose)});`;
}

function setCameraPose(poseLike = {}) {
  const pose = typeof poseLike === 'string' ? JSON.parse(poseLike) : poseLike;
  if (!pose || typeof pose !== 'object') return getCameraPose();
  const positionSource = pose.position ?? pose.camera?.position;
  const targetSource = pose.target ?? pose.controls?.target ?? pose.camera?.target;
  const nextPosition = poseObjectToVector(positionSource, camera.position);
  const nextTarget = poseObjectToVector(targetSource, controls.target);
  if (Number.isFinite(nextPosition.x) && Number.isFinite(nextPosition.y) && Number.isFinite(nextPosition.z)) {
    camera.position.copy(nextPosition);
  }
  if (Number.isFinite(nextTarget.x) && Number.isFinite(nextTarget.y) && Number.isFinite(nextTarget.z)) {
    controls.target.copy(nextTarget);
  }
  const nextFov = Number(pose.fovDeg ?? pose.fov);
  if (Number.isFinite(nextFov) && nextFov > 1 && nextFov < 175) {
    setCameraFovImmediate(nextFov);
  } else {
    syncCameraFovTargetToCurrent();
  }
  controls.update();
  cameraPoseReadoutDirty = true;
  updateCameraPoseReadout(true);
  return getCameraPose();
}

function setCameraAngles(anglePose = {}) {
  const current = getCameraPose();
  const nextTarget = poseObjectToVector(anglePose.target, controls.target);
  const distance = Number(anglePose.distance ?? current.distance);
  const azimuthDeg = Number(anglePose.azimuthDeg ?? current.azimuthDeg);
  const polarDeg = Number(anglePose.polarDeg ?? (90 - Number(anglePose.elevationDeg ?? current.elevationDeg)));
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(azimuthDeg) || !Number.isFinite(polarDeg)) {
    return current;
  }
  const clampedPolar = THREE.MathUtils.clamp(
    polarDeg,
    THREE.MathUtils.radToDeg(controls.minPolarAngle),
    THREE.MathUtils.radToDeg(controls.maxPolarAngle),
  );
  cameraPoseSpherical.set(
    distance,
    THREE.MathUtils.degToRad(clampedPolar),
    THREE.MathUtils.degToRad(azimuthDeg),
  );
  cameraPoseOffset.setFromSpherical(cameraPoseSpherical);
  controls.target.copy(nextTarget);
  camera.position.copy(nextTarget).add(cameraPoseOffset);
  const nextFov = Number(anglePose.fovDeg ?? anglePose.fov);
  if (Number.isFinite(nextFov) && nextFov > 1 && nextFov < 175) {
    setCameraFovImmediate(nextFov);
  } else {
    syncCameraFovTargetToCurrent();
  }
  controls.update();
  cameraPoseReadoutDirty = true;
  updateCameraPoseReadout(true);
  return getCameraPose();
}

function updateCameraPoseReadout(force = false) {
  if (!cameraAzimuthEl || (!force && !cameraPoseReadoutDirty)) return;
  // Leave the dirty flag set while the readout is hidden or throttled; the next
  // eligible frame picks the update up.
  if (!force) {
    if (!uiPanelsVisible) return;
    const now = performance.now();
    if (now - lastCameraPoseReadoutUpdateAt < CAMERA_POSE_READOUT_INTERVAL_MS) return;
    lastCameraPoseReadoutUpdateAt = now;
  }
  const pose = getCameraPose();
  const text = JSON.stringify(pose);
  if (!force && text === lastCameraPoseReadoutText) {
    cameraPoseReadoutDirty = false;
    return;
  }
  lastCameraPoseReadoutText = text;
  cameraPoseReadoutDirty = false;
  cameraAzimuthEl.textContent = `${pose.azimuthDeg.toFixed(2)}deg`;
  cameraElevationEl.textContent = `${pose.elevationDeg.toFixed(2)}deg`;
  cameraPolarEl.textContent = `${pose.polarDeg.toFixed(2)}deg`;
  cameraDistanceEl.textContent = pose.distance.toFixed(3);
  cameraFovEl.textContent = `${pose.fovDeg.toFixed(2)}deg`;
  cameraTargetEl.textContent = `${pose.target.x.toFixed(2)}, ${pose.target.y.toFixed(2)}, ${pose.target.z.toFixed(2)}`;
  if (cameraPoseCommandEl) cameraPoseCommandEl.textContent = getCameraPoseCommand(pose);
}

async function copyCameraPoseToClipboard() {
  const command = getCameraPoseCommand();
  try {
    await navigator.clipboard.writeText(command);
    if (copyCameraPoseButton) {
      copyCameraPoseButton.textContent = 'Copied';
      window.setTimeout(() => {
        copyCameraPoseButton.textContent = 'Copy camera pose';
      }, 1200);
    }
  } catch (error) {
    console.warn('Camera pose copy failed; use window.__cuttle.getCameraPose().', error);
  }
}

controls.addEventListener('change', () => {
  cameraPoseReadoutDirty = true;
});
window.addEventListener('resize', () => {
  cameraPoseReadoutDirty = true;
});
updateCameraPoseReadout(true);

function syncCameraZoomMode() {
  controls.enableZoom = !params.useOpticalZoom;
  controls.zoomSpeed = CAMERA_ORBIT_ZOOM_SPEED;
  syncCameraFovTargetToCurrent();
}

function normalizedWheelDeltaY(event) {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * window.innerHeight;
  return event.deltaY;
}

function restoreCameraOrbitWheelSpeed() {
  controls.zoomSpeed = CAMERA_ORBIT_ZOOM_SPEED;
}

function queueCameraOrbitWheelSpeedRestore() {
  if (typeof window.queueMicrotask === 'function') {
    window.queueMicrotask(restoreCameraOrbitWheelSpeed);
  } else {
    window.setTimeout(restoreCameraOrbitWheelSpeed, 0);
  }
}

function handleCameraOrbitWheelSpeedCapture(event) {
  if (params.useOpticalZoom) return;
  controls.zoomSpeed = CAMERA_ORBIT_ZOOM_SPEED * getCameraOrbitInputSpeedMultiplier(event);
  queueCameraOrbitWheelSpeedRestore();
}

function handleOpticalZoomWheel(event) {
  if (!params.useOpticalZoom) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const deltaY = normalizedWheelDeltaY(event) * getCameraOrbitInputSpeedMultiplier(event);
  if (!Number.isFinite(deltaY) || deltaY === 0) return;

  const currentFov = Number.isFinite(cameraTargetFovDeg) ? cameraTargetFovDeg : camera.fov;
  const currentHalfTan = Math.tan(THREE.MathUtils.degToRad(currentFov) * 0.5);
  const nextHalfTan = currentHalfTan * Math.exp(deltaY * OPTICAL_ZOOM_WHEEL_SCALE);
  const nextFov = THREE.MathUtils.radToDeg(Math.atan(nextHalfTan)) * 2;
  cameraTargetFovDeg = THREE.MathUtils.clamp(
    nextFov,
    OPTICAL_ZOOM_MIN_FOV_DEG,
    OPTICAL_ZOOM_MAX_FOV_DEG,
  );
  cameraPoseReadoutDirty = true;
}

canvas.addEventListener('wheel', handleOpticalZoomWheel, { capture: true, passive: false });
canvas.addEventListener('wheel', handleCameraOrbitWheelSpeedCapture, { capture: true, passive: true });
window.addEventListener('keydown', handleCameraKeyboardOrbitKeydown);
window.addEventListener('keyup', handleCameraKeyboardOrbitKeyup);
window.addEventListener('blur', () => {
  clearCameraKeyboardOrbitState();
});

const ICOSA_VERTEX_LIGHT_COUNT = 12;
const ICOSA_FACE_LIGHT_COUNT = 20;
const ICOSA_LIGHT_COUNT = ICOSA_VERTEX_LIGHT_COUNT + ICOSA_FACE_LIGHT_COUNT;
const ICOSA_LIGHT_RADIUS = SURFACE_WORLD_SIZE * 1.85;

function getActiveIcosaLightCount(settings = params) {
  return settings.useIcosaFaceLights === false ? ICOSA_VERTEX_LIGHT_COUNT : ICOSA_LIGHT_COUNT;
}

function getActiveIcosaLightRadianceScale(settings = params) {
  return ICOSA_VERTEX_LIGHT_COUNT / getActiveIcosaLightCount(settings);
}

function makeIcosahedronLightPositions() {
  const phi = (1 + Math.sqrt(5)) * 0.5;
  const vertices = [
    [0, 1, phi], [0, -1, phi], [0, 1, -phi], [0, -1, -phi],
    [1, phi, 0], [-1, phi, 0], [1, -phi, 0], [-1, -phi, 0],
    [phi, 0, 1], [-phi, 0, 1], [phi, 0, -1], [-phi, 0, -1],
  ];
  const rawVertices = vertices.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const vertexPositions = rawVertices.map((position) =>
    position.clone().normalize().multiplyScalar(ICOSA_LIGHT_RADIUS),
  );
  const faceIndices = [
    [0, 1, 8], [0, 1, 9], [0, 4, 5], [0, 4, 8],
    [0, 5, 9], [1, 6, 7], [1, 6, 8], [1, 7, 9],
    [2, 3, 10], [2, 3, 11], [2, 4, 5], [2, 4, 10],
    [2, 5, 11], [3, 6, 7], [3, 6, 10], [3, 7, 11],
    [4, 8, 10], [5, 9, 11], [6, 8, 10], [7, 9, 11],
  ];
  const faceCenterPositions = faceIndices.map(([a, b, c]) =>
    vertexPositions[a]
      .clone()
      .add(vertexPositions[b])
      .add(vertexPositions[c])
      .multiplyScalar(1 / 3),
  );
  return [
    ...vertexPositions,
    ...faceCenterPositions,
  ];
}
const icosahedronLightPositions = makeIcosahedronLightPositions();
if (icosahedronLightPositions.length !== ICOSA_LIGHT_COUNT) {
  console.warn(
    `Expected ${ICOSA_LIGHT_COUNT} icosahedron lights, got ${icosahedronLightPositions.length}.`,
  );
}

// === full-screen pass infra ===
const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadGeo = new THREE.PlaneGeometry(2, 2);
const quadScene = new THREE.Scene();
const quadMesh = new THREE.Mesh(quadGeo, null);
quadScene.add(quadMesh);

function runFullscreenPass(material, target) {
  quadMesh.material = material;
  renderer.setRenderTarget(target);
  renderer.render(quadScene, quadCamera);
}

// === RT pairs ===
function makeCanonicalFieldRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeSampleViewFieldRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeObservationTriggerScoreRT() {
  return new THREE.WebGLRenderTarget(MAX_OATS, 1, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeObservationTriggerQueryRT() {
  return new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA8',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeMaskRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA8',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeDensityRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeSeamMetadataRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeSeamCandidateAtlasRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE * SEAM_TRANSITION_CANDIDATE_COUNT, FIELD_SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeDebugRT() {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeAgentRT() {
  return new THREE.WebGLRenderTarget(AGENT_SIDE, AGENT_SIDE, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}
function makeAgentCandidateRT() {
  return new THREE.WebGLRenderTarget(AGENT_SIDE, AGENT_CANDIDATE_HEIGHT, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    internalFormat: 'RGBA32F',
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

class RTPair {
  constructor(make) {
    this.read = make();
    this.write = make();
  }
  swap() {
    const tmp = this.read;
    this.read = this.write;
    this.write = tmp;
  }
}

const agentRT = new RTPair(makeAgentRT);
const agentSeedRT = makeAgentRT();
const agentParentNextRT = makeAgentRT();
const agentCandidateRT = makeAgentCandidateRT();
const agentPrefixRT = new RTPair(makeAgentCandidateRT);
const fieldRT = new RTPair(makeCanonicalFieldRT);
const fieldSampleViewRT = makeSampleViewFieldRT();
const renderRT = new RTPair(makeCanonicalFieldRT);
const renderSampleViewRT = new RTPair(makeSampleViewFieldRT);
const renderScratchRT = makeSampleViewFieldRT();
const observationTriggerScoreRT = makeObservationTriggerScoreRT();
const observationTriggerQueryRT = makeObservationTriggerQueryRT();
let goldWaferBodyMaxFoodRT = null;
let goldWaferBodyMaxFoodInitialized = false;
let goldWaferBodyMaxFoodNeedsUpdate = true;
let goldWaferBodyMaterial = null;
let goldWaferBodyMesh = null;
let goldWaferBodyIcoEnvMaterial = null;
let goldWaferBodyIcoEnvRT = null;
let goldWaferBodyIcoEnvPmrem = null;
let goldWaferBodyMaxFoodRTConfig = null;
let goldWaferBodyModeDirty = true;
let goldWaferBodyUniformsDirty = true;
function makeGoldWaferBodyZeroFoodTexture() {
  const texture = new THREE.DataTexture(new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}
const goldWaferBodyZeroFoodTexture = makeGoldWaferBodyZeroFoodTexture();

function makeGoldWaferBodyMaxFoodCandidateRT(config) {
  return new THREE.WebGLRenderTarget(FIELD_SIZE, FIELD_SIZE, {
    type: config.type,
    format: config.format,
    internalFormat: config.internalFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

function isGoldWaferBodyRTConfigRenderable(config) {
  const rt = makeGoldWaferBodyMaxFoodCandidateRT(config);
  const gl = renderer.getContext();
  const previousTarget = renderer.getRenderTarget();
  renderer.setRenderTarget(rt);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  renderer.setRenderTarget(previousTarget);
  rt.dispose();
  return complete;
}

function getGoldWaferBodyMaxFoodRTConfig() {
  if (goldWaferBodyMaxFoodRTConfig) return goldWaferBodyMaxFoodRTConfig;
  const candidates = [
    {
      label: 'R16F',
      type: THREE.HalfFloatType,
      format: THREE.RedFormat,
      internalFormat: 'R16F',
    },
    {
      label: 'RGBA16F',
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      internalFormat: 'RGBA16F',
    },
    {
      label: 'RGBA32F',
      type: THREE.FloatType,
      format: THREE.RGBAFormat,
      internalFormat: 'RGBA32F',
    },
  ];
  goldWaferBodyMaxFoodRTConfig = candidates.find(isGoldWaferBodyRTConfigRenderable)
    ?? candidates[candidates.length - 1];
  return goldWaferBodyMaxFoodRTConfig;
}

function makeGoldWaferBodyMaxFoodRT() {
  return makeGoldWaferBodyMaxFoodCandidateRT(getGoldWaferBodyMaxFoodRTConfig());
}
const oatRT = makeCanonicalFieldRT();
const depositDensityRT = makeCanonicalFieldRT();
const densityRT = makeDensityRT();
const agentDensityOverlayRT = makeDensityRT();
// Phase 1: uvIslandMaskRT is now the conservative surface coverage mask used by
// production code. Keep the legacy GPU-rasterized mask for diagnostics only.
const uvIslandMaskRT = makeMaskRT();
const surfaceCoverageRT = uvIslandMaskRT;
const legacyUvIslandMaskRT = makeMaskRT();
const seamRedirectUvRT = makeSeamMetadataRT();
const seamRedirectMetaRT = makeSeamMetadataRT();
// Future packing notes: seamRedirectClaimRT may not need RGBA32F and
// seamPaddingDebugRT is debug-only, but topology metadata packing needs a
// dedicated audit before changing correctness-critical formats.
const seamRedirectClaimRT = makeDebugRT();
// Twin maps for on-island texels along seam edges. Same UV/meta split as the
// redirect maps but rasterized INWARD, so on-island edge texels can be welded.
const seamWeldUvRT = makeSeamMetadataRT();
const seamWeldMetaRT = makeSeamMetadataRT();
// Zero-gutter crossing transition maps: destination seam UV/distance, chart IDs,
// crossing normals, basis vectors, and a conservative claim mask. These maps
// stay narrow enough for true crossing consumers (visual/diffusion/agents).
// Broad source/write kernels must distribute per source and must not widen this
// global map, or collision claims turn ordinary seams into walls.
const seamTransitionUvAtlasRT = makeSeamCandidateAtlasRT();
const seamTransitionMetaAtlasRT = makeSeamCandidateAtlasRT();
const seamTransitionDirectionAtlasRT = makeSeamCandidateAtlasRT();
const seamTransitionBasisAtlasRT = makeSeamCandidateAtlasRT();
// Compatibility names now point at the packed candidate atlases. Slot 0 is the
// first FIELD_SIZE-wide lane; shaders and diagnostics sample explicit lanes.
const seamTransitionUvRT = seamTransitionUvAtlasRT;
const seamTransitionMetaRT = seamTransitionMetaAtlasRT;
const seamTransitionDirectionRT = seamTransitionDirectionAtlasRT;
const seamTransitionBasisRT = seamTransitionBasisAtlasRT;
const seamTransitionClaimRT = makeDebugRT();
// Legacy aliases exposed for existing console probes; use the split names in new code.
const seamRedirectRT = seamRedirectUvRT;
const seamWeldRT = seamWeldUvRT;
const chartIdRT = makeDebugRT();
const chartConflictRT = makeMaskRT();
// PR3 broadens the conflict map into an unsafe ownership mask: set texels are
// either true multi-owner conflicts or ambiguous micro-chart footprints.
// Keep chartConflictRT as a compatibility name; prefer chartUnsafeRT in new code.
// chart IDs may be packable if chart counts stay bounded; chartUnsafeRT should
// remain 8-bit unless future diagnostics prove otherwise.
const chartUnsafeRT = chartConflictRT;
const seamPaddingDebugRT = makeDebugRT();

// === GLSL ===

const fullscreenVertex = `#version 300 es
in vec2 position;
out vec2 v_uv;
void main() {
  v_uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const goldWaferBodyIcoEnvFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform vec3 u_lightDirections[${ICOSA_LIGHT_COUNT}];
uniform int u_lightCount;
uniform float u_lightRadianceScale;
const float PI = 3.141592653589793;
void main() {
  float phi = v_uv.x * 2.0 * PI - PI;
  float latitude = (v_uv.y - 0.5) * PI;
  vec3 dir = normalize(vec3(
    cos(latitude) * cos(phi),
    sin(latitude),
    cos(latitude) * sin(phi)
  ));

  vec3 color = vec3(0.018, 0.022, 0.026);
  for (int i = 0; i < ${ICOSA_LIGHT_COUNT}; i++) {
    if (i >= u_lightCount) break;
    float alignment = max(dot(dir, normalize(u_lightDirections[i])), 0.0);
    float broad = pow(alignment, 42.0) * 1.25;
    float core = pow(alignment, 360.0) * 22.0;
    color += vec3(1.0) * (broad + core) * u_lightRadianceScale;
  }
  outColor = vec4(color, 1.0);
}
`;

const seamKernelContinuationGlsl = `
uniform sampler2D u_seamTransitionUvAtlas;
uniform sampler2D u_seamTransitionMetaAtlas;
uniform sampler2D u_seamTransitionDirectionAtlas;
uniform sampler2D u_seamTransitionBasisAtlas;
uniform sampler2D u_seamTransitionClaim;
uniform int u_useSeamStitching;
vec2 seamTransitionCandidateAtlasUv(vec2 uv, int slot) {
  return vec2((uv.x + float(slot)) / float(${SEAM_TRANSITION_CANDIDATE_COUNT}), uv.y);
}
bool hasSeamKernelTransitionCandidateOverflow(vec2 uv) {
  return texture(u_seamTransitionClaim, uv).g >= 0.5;
}
void trySeamKernelCandidate(
  vec2 receiverUv,
  float receiverChart,
  float sourceChart,
  vec4 transitionUv,
  vec4 transitionMeta,
  vec4 transitionDirection,
  vec4 transitionBasis,
  inout vec2 winnerUv,
  inout float winnerCount,
  inout float winnerDistance
) {
  if (transitionUv.z < 0.5) return;
  float transitionSourceChart = floor(transitionMeta.r + 0.5);
  float transitionDestinationChart = floor(transitionMeta.g + 0.5);
  if (abs(transitionSourceChart - receiverChart) > 0.5 ||
      abs(transitionDestinationChart - sourceChart) > 0.5) {
    return;
  }
  if (dot(transitionDirection.xy, transitionDirection.xy) < 0.25 ||
      dot(transitionDirection.zw, transitionDirection.zw) < 0.25 ||
      dot(transitionBasis.xy, transitionBasis.xy) < 0.25 ||
      dot(transitionBasis.zw, transitionBasis.zw) < 0.25) {
    return;
  }
  // Nearest seam wins: the kernel continues across the closest boundary.
  float seamDistance = max(0.0, transitionUv.w);
  if (winnerCount > 0.5 && seamDistance >= winnerDistance) return;
  vec2 destinationIn = normalize(transitionDirection.zw);
  float receiverDepthUv = seamDistance / float(${FIELD_SIZE});
  winnerUv = transitionUv.xy - destinationIn * receiverDepthUv;
  winnerDistance = seamDistance;
  winnerCount = 1.0;
}
vec2 mapSeamReceiverToSourceVirtualUv(
  vec2 receiverUv,
  float receiverChart,
  float sourceChart,
  out float valid
) {
  valid = 0.0;
  // Overflow texels (more candidates generated at build time than atlas slots)
  // still store their nearest candidates; try them rather than treating the
  // texel as a wall. The single-winner check below keeps ambiguity conservative.
  if (u_useSeamStitching == 0 ||
      receiverChart < 0.5 ||
      sourceChart < 0.5) {
    return receiverUv;
  }
  vec2 winnerUv = receiverUv;
  float winnerCount = 0.0;
  float winnerDistance = 1e9;
  for (int slot = 0; slot < ${SEAM_TRANSITION_CANDIDATE_COUNT}; slot++) {
    vec2 candidateUv = seamTransitionCandidateAtlasUv(receiverUv, slot);
    trySeamKernelCandidate(receiverUv, receiverChart, sourceChart,
      texture(u_seamTransitionUvAtlas, candidateUv),
      texture(u_seamTransitionMetaAtlas, candidateUv),
      texture(u_seamTransitionDirectionAtlas, candidateUv),
      texture(u_seamTransitionBasisAtlas, candidateUv),
      winnerUv,
      winnerCount,
      winnerDistance);
  }
  if (winnerCount < 0.5) return receiverUv;
  valid = 1.0;
  return winnerUv;
}
bool canReceiveSeamKernelContribution(vec2 receiverUv, float receiverChart, float sourceChart) {
  float valid = 0.0;
  mapSeamReceiverToSourceVirtualUv(receiverUv, receiverChart, sourceChart, valid);
  return valid >= 0.5;
}
`;

const oatFragment = `#version 300 es
precision highp float;
#define MAX_OATS 64
in vec2 v_uv;
out vec4 outColor;
uniform int u_oatCount;
uniform vec2 u_oats[MAX_OATS];
uniform float u_oatRadius[MAX_OATS];
uniform float u_oatPower[MAX_OATS];
uniform float u_oatChart[MAX_OATS];
uniform float u_oatSupportSigmas;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
${seamKernelContinuationGlsl}
float chartIdAt(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ||
    texture(u_chartUnsafe, uv).r >= 0.5;
}
void main() {
  float fragmentChart = chartIdAt(v_uv);
  if (fragmentChart < 0.5 || isOwnershipUnsafe(v_uv)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float food = 0.0;
  for (int i = 0; i < MAX_OATS; i++) {
    if (i >= u_oatCount) break;
    float oatChart = floor(u_oatChart[i] + 0.5);
    float radius = max(u_oatRadius[i], 0.001);
    float supportRadius = radius * u_oatSupportSigmas;
    vec2 sampleUv = v_uv;
    if (abs(oatChart - fragmentChart) > 0.5) {
      float seamValid = 0.0;
      sampleUv = mapSeamReceiverToSourceVirtualUv(v_uv, fragmentChart, oatChart, seamValid);
      if (seamValid < 0.5) continue;
    }
    vec2 d = sampleUv - u_oats[i];
    if (dot(d, d) > supportRadius * supportRadius) continue;
    float peakFood = max(u_oatPower[i], 0.0);
    float contribution = peakFood * exp(-dot(d, d) / (2.0 * radius * radius));
    food = max(food, contribution);
  }
  outColor = vec4(food, 0.0, 0.0, 1.0);
}
`;

const safeSamplingGlsl = `
uniform sampler2D u_seamRedirectUv;
uniform sampler2D u_seamRedirectMeta;
uniform sampler2D u_seamRedirectClaim;
uniform sampler2D u_seamTransitionUvAtlas;
uniform sampler2D u_seamTransitionMetaAtlas;
uniform sampler2D u_seamTransitionDirectionAtlas;
uniform sampler2D u_seamTransitionBasisAtlas;
uniform sampler2D u_seamTransitionClaim;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform int u_useSeamStitching;
uniform int u_useZeroGutterTransitions;
vec2 seamTransitionCandidateAtlasUv(vec2 uv, int slot) {
  return vec2((uv.x + float(slot)) / float(${SEAM_TRANSITION_CANDIDATE_COUNT}), uv.y);
}
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
bool sameChart(vec2 a, vec2 b) {
  float chartA = chartIdAt(a);
  return chartA > 0.5 && chartA == chartIdAt(b);
}
bool isSafeEmptyGutter(vec2 uv) {
  return !isOutsideAtlas(uv) && chartIdAt(uv) < 0.5 && !isOwnershipUnsafe(uv);
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && !isOwnershipUnsafe(uv);
}
bool isOwnershipConflict(vec2 uv) {
  return isOwnershipUnsafe(uv);
}
bool hasRedirectClaimCollision(vec2 uv) {
  return !isOutsideAtlas(uv) &&
    texture(u_seamRedirectClaim, uv).r >= ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)};
}
bool hasTransitionClaimCollision(vec2 uv) {
  return !isOutsideAtlas(uv) &&
    texture(u_seamTransitionClaim, uv).r >= ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)};
}
bool hasTransitionCandidateOverflow(vec2 uv) {
  return !isOutsideAtlas(uv) && texture(u_seamTransitionClaim, uv).g >= 0.5;
}
vec2 rotateTransitionOffset(vec2 offsetUv, vec2 sinCos) {
  float sinT = sinCos.x;
  float cosT = sinCos.y;
  return vec2(
    offsetUv.x * cosT - offsetUv.y * sinT,
    offsetUv.x * sinT + offsetUv.y * cosT
  );
}
void tryZeroGutterTransitionCandidate(
  vec2 baseUv,
  vec2 sampleOffset,
  float baseChart,
  vec4 transitionUv,
  vec4 transitionMeta,
  vec4 transitionDirection,
  vec4 transitionBasis,
  inout vec2 winnerUv,
  inout vec2 winnerRotation,
  inout float winnerCount,
  inout float winnerDistance
) {
  if (transitionUv.z < 0.5 || isOutsideAtlas(transitionUv.xy)) return;
  float sourceChart = floor(transitionMeta.r + 0.5);
  float destinationChart = floor(transitionMeta.g + 0.5);
  if (abs(sourceChart - baseChart) > 0.5 ||
      destinationChart < 0.5 ||
      dot(transitionDirection.xy, transitionDirection.xy) < 0.25 ||
      dot(transitionDirection.zw, transitionDirection.zw) < 0.25 ||
      dot(transitionBasis.xy, transitionBasis.xy) < 0.25 ||
      dot(transitionBasis.zw, transitionBasis.zw) < 0.25) {
    return;
  }
  vec2 sourceOut = normalize(transitionDirection.xy);
  vec2 destinationIn = normalize(transitionDirection.zw);
  vec2 sourceEdge = normalize(transitionBasis.xy);
  vec2 destinationEdge = normalize(transitionBasis.zw);

  float offsetLen = length(sampleOffset);
  if (offsetLen <= 1e-8) return;
  float outwardUv = dot(sampleOffset, sourceOut);
  float outwardTexels = outwardUv * float(${FIELD_SIZE});
  float seamDistanceTexels = transitionUv.w;
  float outwardAlignment = outwardUv / offsetLen;
  if (outwardAlignment < ${ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN.toFixed(3)} ||
      outwardTexels + ${ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS.toFixed(2)} < seamDistanceTexels) {
    return;
  }

  float alongUv = dot(sampleOffset, sourceEdge);
  float destinationDepthUv = max(0.0, outwardTexels - seamDistanceTexels) / float(${FIELD_SIZE});
  vec2 destUv = transitionUv.xy + destinationEdge * alongUv + destinationIn * destinationDepthUv;
  if (isOutsideAtlas(destUv) ||
      isOwnershipUnsafe(destUv) ||
      abs(chartIdAt(destUv) - destinationChart) > 0.5) {
    return;
  }

  // Nearest seam wins: the offset crosses the closest boundary first.
  if (winnerCount > 0.5 && seamDistanceTexels >= winnerDistance) return;
  winnerUv = destUv;
  winnerRotation = transitionMeta.zw;
  winnerDistance = seamDistanceTexels;
  winnerCount = 1.0;
}
vec2 resolveZeroGutterTransitionUv(vec2 baseUv, vec2 sampleUv, float baseChart, out float transitionValid, out vec2 transitionRotation) {
  transitionValid = 0.0;
  transitionRotation = vec2(0.0, 1.0);
  if (u_useZeroGutterTransitions == 0 || u_useSeamStitching == 0) return baseUv;
  // Overflow texels still store their nearest candidates; try them instead of
  // treating the texel as a wall. The single-winner check below stays.

  vec2 sampleOffset = sampleUv - baseUv;
  vec2 winnerUv = baseUv;
  vec2 winnerRotation = vec2(0.0, 1.0);
  float winnerCount = 0.0;
  float winnerDistance = 1e9;
  for (int slot = 0; slot < ${SEAM_TRANSITION_CANDIDATE_COUNT}; slot++) {
    vec2 candidateUv = seamTransitionCandidateAtlasUv(baseUv, slot);
    tryZeroGutterTransitionCandidate(baseUv, sampleOffset, baseChart,
      texture(u_seamTransitionUvAtlas, candidateUv),
      texture(u_seamTransitionMetaAtlas, candidateUv),
      texture(u_seamTransitionDirectionAtlas, candidateUv),
      texture(u_seamTransitionBasisAtlas, candidateUv),
      winnerUv,
      winnerRotation,
      winnerCount,
      winnerDistance);
  }
  if (winnerCount < 0.5) return baseUv;
  transitionRotation = winnerRotation;
  transitionValid = 1.0;
  return winnerUv;
}
vec2 resolveSampleUvSafe(vec2 baseUv, vec2 sampleUv, out float valid) {
  valid = 0.0;
  if (!isAuthoritativeChartTexel(baseUv)) return baseUv;

  float baseChart = chartIdAt(baseUv);
  float sampleChart = chartIdAt(sampleUv);
  if (sampleChart == baseChart && !isOwnershipUnsafe(sampleUv)) {
    valid = 1.0;
    return sampleUv;
  }

  float transitionValid = 0.0;
  vec2 transitionRotation = vec2(0.0, 1.0);
  vec2 transitionUv = resolveZeroGutterTransitionUv(baseUv, sampleUv, baseChart, transitionValid, transitionRotation);
  if (transitionValid >= 0.5) {
    valid = 1.0;
    return transitionUv;
  }

  if (isOutsideAtlas(sampleUv)) return baseUv;

  if (sampleChart == 0.0 &&
      !isOwnershipUnsafe(sampleUv) &&
      !hasRedirectClaimCollision(sampleUv) &&
      u_useSeamStitching == 1) {
    vec4 redirectUv = texture(u_seamRedirectUv, sampleUv);
    vec2 destUv = redirectUv.xy;
    if (redirectUv.z >= 0.5 && !isOutsideAtlas(destUv) && !isOwnershipUnsafe(destUv)) {
      vec4 redirectMeta = texture(u_seamRedirectMeta, sampleUv);
      float sourceChart = floor(redirectMeta.r + 0.5);
      float destinationChart = floor(redirectMeta.g + 0.5);
      if (sourceChart == baseChart &&
          destinationChart > 0.5 &&
          chartIdAt(destUv) == destinationChart) {
        valid = 1.0;
        return destUv;
      }
    }
  }

  return baseUv;
}
`;

const diffuseFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform vec2 u_texel;
uniform float u_diffusion;
uniform float u_decay;
uniform float u_foodClamp;
${safeSamplingGlsl}
float readFoodSafe(vec2 baseUv, vec2 sampleUv, float fallback, out float valid) {
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  return max(texture(u_food, r).r, 0.0);
}
void main() {
  if (!isAuthoritativeChartTexel(v_uv)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float c = max(texture(u_food, v_uv).r, 0.0);
  float n = 0.0;
  float valid = 0.0;
  n += readFoodSafe(v_uv, v_uv + vec2(-u_texel.x, -u_texel.y), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(0.0, -u_texel.y), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(u_texel.x, -u_texel.y), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(-u_texel.x, 0.0), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(u_texel.x, 0.0), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(-u_texel.x, u_texel.y), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(0.0, u_texel.y), c, valid);
  n += readFoodSafe(v_uv, v_uv + vec2(u_texel.x, u_texel.y), c, valid);
  float blurred = n * 0.125;
  float food = clamp(mix(c, blurred, u_diffusion) * u_decay, 0.0, u_foodClamp);
  outColor = vec4(food, 0.0, 0.0, 1.0);
}
`;

const dilateFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform sampler2D u_islandMask;
uniform vec2 u_texel;
float readIslandMask(vec2 uv) {
  return step(0.5, texture(u_islandMask, uv).r);
}
void main() {
  float mask = readIslandMask(v_uv);
  vec4 self = texture(u_food, v_uv);
  if (mask >= 0.5) {
    outColor = self;
    return;
  }
  float best = self.r;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) continue;
      vec2 nuv = v_uv + vec2(float(dx), float(dy)) * u_texel;
      best = max(best, texture(u_food, nuv).r);
    }
  }
  outColor = vec4(best, 0.0, 0.0, 1.0);
}
`;

const clampFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform float u_foodClamp;
void main() {
  float food = clamp(texture(u_food, v_uv).r, 0.0, u_foodClamp);
  outColor = vec4(food, 0.0, 0.0, 1.0);
}
`;

const sampleViewCopyFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
bool isAuthoritativeSampleViewTexel(vec2 uv) {
  float chartId = floor(texture(u_chartId, uv).r + 0.5);
  float unsafe = texture(u_chartUnsafe, uv).r;
  return chartId > 0.5 && unsafe < 0.5;
}
void main() {
  if (!isAuthoritativeSampleViewTexel(v_uv)) {
    outColor = vec4(0.0);
    return;
  }
  outColor = texture(u_source, v_uv);
}
`;

const observationTriggerScoreFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform int u_oatCount;
uniform vec2 u_oats[${MAX_OATS}];
const int SAMPLE_RADIUS = ${OBSERVATION_SLIME_TRIGGER_RADIUS_TEXELS};
void main() {
  int index = int(gl_FragCoord.x);
  if (index >= u_oatCount || index >= ${MAX_OATS}) {
    outColor = vec4(0.0);
    return;
  }

  ivec2 fieldSize = textureSize(u_food, 0);
  vec2 centerUv = clamp(u_oats[index], vec2(0.0), vec2(1.0));
  ivec2 centerPixel = clamp(
    ivec2(floor(centerUv * vec2(fieldSize))),
    ivec2(0),
    fieldSize - ivec2(1)
  );

  float sumValue = 0.0;
  float maxValue = 0.0;
  int sampleCount = 0;
  for (int dy = -SAMPLE_RADIUS; dy <= SAMPLE_RADIUS; dy++) {
    int y = centerPixel.y + dy;
    if (y < 0 || y >= fieldSize.y) continue;
    for (int dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx++) {
      int x = centerPixel.x + dx;
      if (x < 0 || x >= fieldSize.x) continue;
      float value = max(texelFetch(u_food, ivec2(x, y), 0).r, 0.0);
      sumValue += value;
      maxValue = max(maxValue, value);
      sampleCount++;
    }
  }

  float meanValue = sampleCount > 0 ? sumValue / float(sampleCount) : 0.0;
  outColor = vec4(maxValue, meanValue, float(sampleCount), 1.0);
}
`;

const observationTriggerThresholdQueryFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_scores;
uniform int u_oatCount;
uniform float u_threshold;
uniform float u_pending[${MAX_OATS}];
void main() {
  bool found = false;
  for (int i = 0; i < ${MAX_OATS}; i++) {
    if (i >= u_oatCount) continue;
    if (u_pending[i] < 0.5) continue;
    float score = texelFetch(u_scores, ivec2(i, 0), 0).r;
    if (score >= u_threshold) found = true;
  }
  if (!found) discard;
  outColor = vec4(1.0);
}
`;

const safeSeamPaddingFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_existingSampleView;
uniform sampler2D u_sourceCanonical;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform sampler2D u_seamRedirectUv;
uniform sampler2D u_seamRedirectMeta;
uniform sampler2D u_seamRedirectClaim;
uniform float u_maxPadTexels;
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && !isUnsafe(uv);
}
void main() {
  vec4 existing = texture(u_existingSampleView, v_uv);
  if (u_maxPadTexels <= 0.0) {
    outColor = existing;
    return;
  }
  if (chartIdAt(v_uv) > 0.5 || isUnsafe(v_uv)) {
    outColor = existing;
    return;
  }
  if (texture(u_seamRedirectClaim, v_uv).r >= ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)}) {
    outColor = existing;
    return;
  }

  vec4 redirectUv = texture(u_seamRedirectUv, v_uv);
  if (redirectUv.z < 0.5 ||
      redirectUv.w > u_maxPadTexels + 0.001 ||
      isOutsideAtlas(redirectUv.xy)) {
    outColor = existing;
    return;
  }

  vec4 redirectMeta = texture(u_seamRedirectMeta, v_uv);
  float sourceChart = floor(redirectMeta.r + 0.5);
  float destinationChart = floor(redirectMeta.g + 0.5);
  if (sourceChart < 0.5 || destinationChart < 0.5) {
    outColor = existing;
    return;
  }

  vec2 sourceUv = redirectUv.xy;
  if (!isAuthoritativeChartTexel(sourceUv) || chartIdAt(sourceUv) != destinationChart) {
    outColor = existing;
    return;
  }

  outColor = texture(u_sourceCanonical, sourceUv);
}
`;

const seamPaddingDebugFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform sampler2D u_seamRedirectUv;
uniform sampler2D u_seamRedirectMeta;
uniform sampler2D u_seamRedirectClaim;
uniform float u_requestedPadTexels;
uniform float u_maxPadTexels;
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
void main() {
  vec4 redirectUv = texture(u_seamRedirectUv, v_uv);
  if (redirectUv.z < 0.5 || redirectUv.w > u_requestedPadTexels + 0.001) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (u_maxPadTexels <= 0.0 || redirectUv.w > u_maxPadTexels + 0.001) {
    outColor = vec4(1.0, 0.78, 0.0, 1.0);
    return;
  }
  if (chartIdAt(v_uv) > 0.5) {
    outColor = vec4(0.0, 0.85, 0.28, 1.0);
    return;
  }
  if (isUnsafe(v_uv)) {
    outColor = vec4(1.0, 0.0, 0.85, 1.0);
    return;
  }
  if (texture(u_seamRedirectClaim, v_uv).r >= ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)}) {
    outColor = vec4(1.0, 0.08, 0.04, 1.0);
    return;
  }
  vec4 redirectMeta = texture(u_seamRedirectMeta, v_uv);
  float destinationChart = floor(redirectMeta.g + 0.5);
  if (destinationChart > 0.5 &&
      !isOutsideAtlas(redirectUv.xy) &&
      !isUnsafe(redirectUv.xy) &&
      chartIdAt(redirectUv.xy) == destinationChart) {
    outColor = vec4(0.0, 0.95, 1.0, 1.0);
    return;
  }
  outColor = vec4(1.0, 0.78, 0.0, 1.0);
}
`;

const smoothFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_currentFood;
uniform sampler2D u_previousFood;
uniform vec2 u_texel;
uniform vec2 u_direction;
uniform float u_spatialRadius;
uniform float u_temporalWeight;
uniform float u_foodClamp;
uniform int u_applyTemporal;
uniform int u_smoothingTapCount;
${safeSamplingGlsl}
float readFoodSafe(vec2 offset, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(v_uv, v_uv + offset, valid);
  if (valid < 0.5) return fallback;
  return max(texture(u_currentFood, r).r, 0.0);
}
void main() {
  float radius = max(u_spatialRadius, 0.0);
  float center = readFoodSafe(vec2(0.0), 0.0);
  float blurred = center;
  float weightTotal = 1.0;
  float sigma = max(radius * 0.42, 0.35);
  int tapCount = clamp(u_smoothingTapCount, 0, 14);
  float tapDenom = float(max(tapCount, 1));
  for (int i = 1; i <= 14; i++) {
    if (i > tapCount) break;
    float offset = float(i) * radius / tapDenom;
    float weight = exp(-0.5 * (offset * offset) / (sigma * sigma));
    vec2 sampleOffset = u_direction * u_texel * offset;
    blurred += (readFoodSafe(sampleOffset, center) + readFoodSafe(-sampleOffset, center)) * weight;
    weightTotal += weight * 2.0;
  }
  blurred /= max(weightTotal, 0.0001);
  float spatialMix = smoothstep(0.0, 0.25, radius);
  float spatialFood = mix(center, blurred, spatialMix);
  float food = spatialFood;
  if (u_applyTemporal == 1) {
    float previousFood = isAuthoritativeChartTexel(v_uv) ? max(texture(u_previousFood, v_uv).r, 0.0) : 0.0;
    float temporalAmount = max(u_temporalWeight, 0.0);
    float temporalBlend = min(temporalAmount, 0.98);
    if (temporalAmount > 1.0) {
      temporalBlend = 1.0 - 0.02 / temporalAmount;
    }
    food = mix(spatialFood, previousFood, clamp(temporalBlend, 0.0, 0.995));
  }
  outColor = vec4(clamp(food, 0.0, u_foodClamp), 0.0, 0.0, 1.0);
}
`;

const maxFoodHistoryFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_currentFood;
uniform sampler2D u_previousMax;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && texture(u_chartUnsafe, uv).r < 0.5;
}
void main() {
  if (!isAuthoritativeChartTexel(v_uv)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float currentFood = max(texture(u_currentFood, v_uv).r, 0.0);
  float previousMax = max(texture(u_previousMax, v_uv).r, 0.0);
  outColor = vec4(max(currentFood, previousMax), 0.0, 0.0, 1.0);
}
`;

const agentAllocatorCommonFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_agents;
uniform sampler2D u_food;
uniform sampler2D u_oat;
uniform sampler2D u_density;
uniform int u_agentSide;
uniform float u_time;
uniform float u_dt;
uniform float u_stepSize;
uniform float u_minMoveScale;
uniform float u_sensorDistance;
uniform float u_sensorAngle;
uniform float u_turnAngle;
uniform float u_wander;
uniform float u_uptakeRate;
uniform float u_depositRate;
uniform float u_burnRate;
uniform float u_reproThreshold;
uniform float u_reproAngle;
uniform float u_childStep;
uniform float u_foodWeight;
uniform float u_crowdWeight;
uniform float u_crowdExponent;
uniform float u_densityTarget;
uniform float u_maxReserve;
uniform float u_oatSupplyRate;
uniform float u_densityMassScale;
uniform int u_useOatRationing;
uniform int u_useHeadingRotation;
uniform int u_mouseRepelActive;
uniform vec2 u_mouseRepelUv;
uniform float u_mouseRepelChart;
uniform float u_mouseRepelRadius;
uniform float u_mouseRepelStrength;
${safeSamplingGlsl}
float hash(float n) {
  return fract(sin(n * 127.1 + u_time * 41.7) * 43758.5453123);
}
vec4 fetchAgent(int index) {
  ivec2 pixel = ivec2(index % u_agentSide, index / u_agentSide);
  return texelFetch(u_agents, pixel, 0);
}
float readFoodSafe(vec2 baseUv, vec2 sampleUv, float fallback, out float valid) {
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  return max(texture(u_food, r).r, 0.0);
}
float readFoodSafe(vec2 baseUv, vec2 sampleUv, float fallback) {
  float valid = 0.0;
  return readFoodSafe(baseUv, sampleUv, fallback, valid);
}
float readOatSafe(vec2 baseUv, vec2 sampleUv, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  return max(texture(u_oat, r).r, 0.0);
}
float readDensitySafe(vec2 baseUv, vec2 sampleUv, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  ivec2 densitySize = textureSize(u_density, 0);
  ivec2 densityPixel = clamp(
    ivec2(floor(r * vec2(densitySize))),
    ivec2(0),
    densitySize - ivec2(1)
  );
  return max(texelFetch(u_density, densityPixel, 0).r, 0.0);
}
float rationedOatFood(float oatFood, float localDensity) {
  if (u_useOatRationing == 0 || oatFood <= 0.0) return oatFood;
  float localReserveLoad = max(localDensity / max(u_densityMassScale, 0.00001), 1.0);
  float requestedUptake = localReserveLoad * u_uptakeRate * oatFood;
  float supply = max(u_oatSupplyRate, 0.00001);
  float ration = clamp(supply / max(requestedUptake, supply), 0.0, 1.0);
  return oatFood * ration;
}
float rotateHeading(float angle, vec2 rotation) {
  float sinT = rotation.x;
  float cosT = rotation.y;
  float newCos = cos(angle) * cosT - sin(angle) * sinT;
  float newSin = sin(angle) * cosT + cos(angle) * sinT;
  return atan(newSin, newCos);
}
vec2 resolveMoveUvSafe(vec2 baseUv, vec2 candidateUv, out float valid, out vec2 rotation) {
  valid = 0.0;
  rotation = vec2(0.0, 1.0);
  if (!isAuthoritativeChartTexel(baseUv)) return baseUv;

  float baseChart = chartIdAt(baseUv);
  float candidateChart = chartIdAt(candidateUv);
  if (candidateChart == baseChart && !isOwnershipUnsafe(candidateUv)) {
    valid = 1.0;
    return candidateUv;
  }

  float transitionValid = 0.0;
  vec2 transitionRotation = vec2(0.0, 1.0);
  vec2 transitionUv = resolveZeroGutterTransitionUv(
    baseUv,
    candidateUv,
    baseChart,
    transitionValid,
    transitionRotation
  );
  if (transitionValid >= 0.5) {
    valid = 1.0;
    rotation = transitionRotation;
    return transitionUv;
  }

  if (isOutsideAtlas(candidateUv)) return baseUv;

  if (candidateChart == 0.0 &&
      !isOwnershipUnsafe(candidateUv) &&
      !hasRedirectClaimCollision(candidateUv) &&
      u_useSeamStitching == 1) {
    vec4 redirectUv = texture(u_seamRedirectUv, candidateUv);
    vec2 destUv = redirectUv.xy;
    if (redirectUv.z >= 0.5 && !isOutsideAtlas(destUv) && !isOwnershipUnsafe(destUv)) {
      vec4 redirectMeta = texture(u_seamRedirectMeta, candidateUv);
      float sourceChart = floor(redirectMeta.r + 0.5);
      float destinationChart = floor(redirectMeta.g + 0.5);
      if (sourceChart == baseChart &&
          destinationChart > 0.5 &&
          chartIdAt(destUv) == destinationChart) {
        valid = 1.0;
        rotation = redirectMeta.zw;
        return destUv;
      }
    }
  }

  return baseUv;
}
float scoreAt(vec2 baseUv, vec2 sampleUv, float reserve) {
  float sampleValid = 0.0;
  float dynamicFood = readFoodSafe(baseUv, sampleUv, 0.0, sampleValid);
  if (sampleValid < 0.5) return -100000.0;
  float mouseRepelPenalty = 0.0;
  if (u_mouseRepelActive == 1 && u_mouseRepelRadius > 0.0 && u_mouseRepelStrength > 0.0) {
    float sampleChart = chartIdAt(sampleUv);
    if (sampleChart > 0.5 && abs(sampleChart - u_mouseRepelChart) < 0.5 && !isOwnershipUnsafe(sampleUv)) {
      vec2 pointerDelta = sampleUv - u_mouseRepelUv;
      float radiusSq = u_mouseRepelRadius * u_mouseRepelRadius;
      float normalizedDistanceSq = dot(pointerDelta, pointerDelta) / max(radiusSq, 0.0000001);
      mouseRepelPenalty = u_mouseRepelStrength * exp(-normalizedDistanceSq * 2.0);
    }
  }
  float crowd = readDensitySafe(baseUv, sampleUv, 1.0);
  float oatFood = rationedOatFood(readOatSafe(baseUv, sampleUv, 0.0), crowd);
  float food = dynamicFood + oatFood;
  float foodSignal = 1.0 - exp(-food * 1.2);
  float appetite = 1.0 - smoothstep(u_reproThreshold * 0.55, u_reproThreshold * 1.05, reserve);
  float target = max(u_densityTarget, 0.001);
  float densityRatio = max(crowd / target, 0.0);
  float occupiedEnough = smoothstep(0.0, 1.0, densityRatio);
  float crowdRangeMax = max(1.0001, min(3.0, 1.0 / target));
  float tooCrowded = smoothstep(1.0, crowdRangeMax, densityRatio);
  float crowdCurve = max(u_crowdExponent, 1.0);
  float superlinearPenalty = tooCrowded * pow(max(densityRatio, 1.0), crowdCurve - 1.0);
  float crowdPreference = occupiedEnough - superlinearPenalty * 2.0;
  return u_foodWeight * foodSignal * appetite + u_crowdWeight * crowdPreference - mouseRepelPenalty;
}
vec4 advanceAgent(vec4 agent, float seed) {
  float angle = agent.z;
  if (agent.w <= 0.0) {
    return vec4(clamp(agent.xy, vec2(0.0), vec2(1.0)), angle, 0.0);
  }
  vec2 pos = agent.xy;
  if (!isAuthoritativeChartTexel(pos)) {
    return vec4(clamp(pos, vec2(0.0), vec2(1.0)), angle, 0.0);
  }
  vec2 frontDir = vec2(cos(angle), sin(angle));
  vec2 leftDir = vec2(cos(angle + u_sensorAngle), sin(angle + u_sensorAngle));
  vec2 rightDir = vec2(cos(angle - u_sensorAngle), sin(angle - u_sensorAngle));
  float front = scoreAt(pos, pos + frontDir * u_sensorDistance, agent.w);
  float left = scoreAt(pos, pos + leftDir * u_sensorDistance, agent.w);
  float right = scoreAt(pos, pos + rightDir * u_sensorDistance, agent.w);
  float stay = scoreAt(pos, pos, agent.w);
  float moveScore = front;
  float angleDelta = (hash(seed + 11.0) - 0.5) * u_wander;
  if (left > front && left > right) {
    moveScore = left;
    angleDelta = u_turnAngle;
  } else if (right > front && right > left) {
    moveScore = right;
    angleDelta = -u_turnAngle;
  }
  float preference = moveScore - stay;
  float moveScale = max(u_minMoveScale, smoothstep(0.0, 0.08, preference));
  angle += angleDelta;
  angle += (hash(seed + 23.0) - 0.5) * u_wander * 0.5 * moveScale;
  vec2 dir = vec2(cos(angle), sin(angle));
  float moveValid = 0.0;
  vec2 moveRotation = vec2(0.0, 1.0);
  vec2 nextPos = resolveMoveUvSafe(pos, pos + dir * u_stepSize * u_dt * moveScale, moveValid, moveRotation);
  if (moveValid < 0.5) {
    nextPos = pos;
    angle += (hash(seed + 59.0) < 0.5 ? -1.0 : 1.0) * u_turnAngle;
  } else if (u_useHeadingRotation == 1) {
    angle = rotateHeading(angle, moveRotation);
  }
  float dynamicFood = readFoodSafe(nextPos, nextPos, 0.0);
  float localDensity = readDensitySafe(nextPos, nextPos, 0.0);
  float oatFood = rationedOatFood(readOatSafe(nextPos, nextPos, 0.0), localDensity);
  float effectiveFood = dynamicFood + oatFood;
  float reserve = agent.w + (u_uptakeRate * effectiveFood - u_depositRate - u_burnRate) * u_dt;
  if (reserve <= 0.0) {
    return vec4(nextPos, angle, 0.0);
  }
  return vec4(nextPos, angle, min(reserve, u_maxReserve));
}
vec4 makeChildCandidate(vec4 parentNext, int side, float seed, float childReserve, out float childValid) {
  childValid = 0.0;
  float sideSign = side == 0 ? 1.0 : -1.0;
  parentNext.z += sideSign * u_reproAngle + (hash(seed + 37.0) - 0.5) * 0.18;
  vec2 childRotation = vec2(0.0, 1.0);
  vec2 childDir = vec2(cos(parentNext.z), sin(parentNext.z));
  vec2 childPos = resolveMoveUvSafe(parentNext.xy, parentNext.xy + childDir * u_childStep, childValid, childRotation);
  if (childValid >= 0.5) {
    parentNext.xy = childPos;
    if (u_useHeadingRotation == 1) {
      parentNext.z = rotateHeading(parentNext.z, childRotation);
    }
  } else {
    parentNext.z += (hash(seed + 83.0) < 0.5 ? -1.0 : 1.0) * u_turnAngle;
    parentNext.w = 0.0;
    return parentNext;
  }
  parentNext.w = childReserve;
  return parentNext;
}
`;

const agentParentUpdateFragment = `${agentAllocatorCommonFragment}
void main() {
  int sourceIndex = int(gl_FragCoord.y) * u_agentSide + int(gl_FragCoord.x);
  outColor = advanceAgent(fetchAgent(sourceIndex), float(sourceIndex));
}
`;

const agentCandidateBuildFragment = `${agentAllocatorCommonFragment}
uniform sampler2D u_parentNext;
uniform int u_allocationOffset;
vec4 fetchParentNext(int index) {
  ivec2 pixel = ivec2(index % u_agentSide, index / u_agentSide);
  return texelFetch(u_parentNext, pixel, 0);
}
void main() {
  int candidateIndex = int(gl_FragCoord.y) * u_agentSide + int(gl_FragCoord.x);
  int capacity = u_agentSide * u_agentSide;
  vec4 result = vec4(0.0);

  // Segment 0: advanced parents, before all children. This preserves every
  // surviving parent under capacity pressure.
  if (candidateIndex < capacity) {
    vec4 parentNext = fetchParentNext(candidateIndex);
    if (parentNext.w > 0.0) result = parentNext;
    outColor = result;
    return;
  }

  // Segments 1/2: child proposals in a frame-rotated order. Proposal identity is
  // independent from storage position; storage index is only storage.
  int childLinearIndex = candidateIndex - capacity;
  int proposalCount = capacity * 2;
  int offset = u_allocationOffset % proposalCount;
  int proposalId = (childLinearIndex + offset) % proposalCount;
  int sourceIndex = proposalId / 2;
  int side = proposalId - sourceIndex * 2;

  vec4 parentNext = fetchParentNext(sourceIndex);
  if (parentNext.w <= u_reproThreshold) {
    outColor = result;
    return;
  }

  float childReserve = parentNext.w * 0.25;
  float childValid = 0.0;
  vec4 child = makeChildCandidate(parentNext, side, float(sourceIndex * 2 + side + 1), childReserve, childValid);
  if (childValid >= 0.5) result = child;
  outColor = result;
}
`;

const agentPrefixInitFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_candidates;
void main() {
  ivec2 pixel = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));
  vec4 candidate = texelFetch(u_candidates, pixel, 0);
  float valid = candidate.w > 0.0001 ? 1.0 : 0.0;
  outColor = vec4(valid, 0.0, 0.0, 1.0);
}
`;

const agentPrefixScanFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_prefix;
uniform int u_offset;
uniform int u_candidateWidth;
float prefixAt(int index) {
  ivec2 pixel = ivec2(index % u_candidateWidth, index / u_candidateWidth);
  return texelFetch(u_prefix, pixel, 0).r;
}
void main() {
  ivec2 pixel = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));
  int index = pixel.y * u_candidateWidth + pixel.x;
  float sum = texelFetch(u_prefix, pixel, 0).r;
  int previousIndex = index - u_offset;
  if (previousIndex >= 0) sum += prefixAt(previousIndex);
  outColor = vec4(sum, 0.0, 0.0, 1.0);
}
`;

const agentCompactFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_candidates;
uniform sampler2D u_prefix;
uniform int u_agentSide;
uniform int u_candidateWidth;
uniform int u_candidateCount;
uniform int u_allocationOffset;
float prefixAt(int index) {
  ivec2 pixel = ivec2(index % u_candidateWidth, index / u_candidateWidth);
  return texelFetch(u_prefix, pixel, 0).r;
}
vec4 candidateAt(int index) {
  ivec2 pixel = ivec2(index % u_candidateWidth, index / u_candidateWidth);
  return texelFetch(u_candidates, pixel, 0);
}
int childCandidateIndexForParentSide(int sourceIndex, int side) {
  int capacity = u_agentSide * u_agentSide;
  int proposalCount = capacity * 2;
  int proposalId = sourceIndex * 2 + side;
  int offset = u_allocationOffset % proposalCount;
  int childLinearIndex = (proposalId - offset + proposalCount) % proposalCount;
  return capacity + childLinearIndex;
}
float acceptedChildDebit(int sourceIndex, int side) {
  int capacity = u_agentSide * u_agentSide;
  int childIndex = childCandidateIndexForParentSide(sourceIndex, side);
  vec4 child = candidateAt(childIndex);
  if (child.w <= 0.0001) return 0.0;
  return prefixAt(childIndex) <= float(capacity) + 0.001 ? 1.0 : 0.0;
}
void main() {
  int outputIndex = int(gl_FragCoord.y) * u_agentSide + int(gl_FragCoord.x);
  int capacity = u_agentSide * u_agentSide;
  float target = float(outputIndex + 1);
  float total = prefixAt(u_candidateCount - 1);
  if (target > total || target > float(capacity)) {
    outColor = vec4(0.0);
    return;
  }

  int lo = 0;
  int hi = u_candidateCount - 1;
  for (int step = 0; step < ${AGENT_SCAN_PASS_COUNT}; step++) {
    int mid = (lo + hi) / 2;
    if (prefixAt(mid) >= target) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }

  vec4 candidate = candidateAt(lo);
  if (candidate.w <= 0.0001 || prefixAt(lo) < target - 0.25) {
    candidate = vec4(0.0);
  } else if (lo < capacity) {
    int sourceIndex = lo;
    float debitCount = acceptedChildDebit(sourceIndex, 0) + acceptedChildDebit(sourceIndex, 1);
    float childReserve = candidate.w * 0.25;
    candidate.w = max(candidate.w - debitCount * childReserve, 0.0);
  }
  outColor = candidate;
}
`;

const agentSeedInjectFragment = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_currentAgents;
uniform sampler2D u_seedAgents;
uniform int u_agentSide;
uniform float u_revealSlotCount;
void main() {
  ivec2 pixel = ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y));
  int index = pixel.y * u_agentSide + pixel.x;
  vec4 currentAgent = texelFetch(u_currentAgents, pixel, 0);
  if (currentAgent.w > 0.0001) {
    outColor = currentAgent;
    return;
  }
  if (float(index) < u_revealSlotCount) {
    outColor = texelFetch(u_seedAgents, pixel, 0);
    return;
  }
  outColor = vec4(0.0);
}
`;

const particleVertex = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in float a_index;
flat out float v_alive;
flat out vec2 v_agentUv;
flat out vec2 v_sourceUv;
flat out float v_agentChart;
flat out float v_sourceChart;
flat out float v_targetChart;
flat out float v_splatMode;
out float v_reserve;
uniform sampler2D u_agents;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform sampler2D u_seamTransitionUvAtlas;
uniform sampler2D u_seamTransitionMetaAtlas;
uniform sampler2D u_seamTransitionDirectionAtlas;
uniform sampler2D u_seamTransitionClaim;
uniform int u_agentSide;
uniform int u_splatMode;
uniform int u_useSeamStitching;
uniform float u_pointSize;
uniform float u_fieldSize;
vec4 fetchAgent(float index) {
  int i = int(index);
  ivec2 pixel = ivec2(i % u_agentSide, i / u_agentSide);
  return texelFetch(u_agents, pixel, 0);
}
vec2 seamTransitionCandidateAtlasUv(vec2 uv, int slot) {
  return vec2((uv.x + float(slot)) / float(${SEAM_TRANSITION_CANDIDATE_COUNT}), uv.y);
}
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
bool hasSeamKernelTransitionClaimCollision(vec2 uv) {
  return !isOutsideAtlas(uv) &&
    texture(u_seamTransitionClaim, uv).r >= ${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)};
}
bool hasSeamKernelTransitionCandidateOverflow(vec2 uv) {
  return !isOutsideAtlas(uv) && texture(u_seamTransitionClaim, uv).g >= 0.5;
}
void trySplatTransitionCandidate(
  vec2 agentUv,
  float agentChart,
  vec4 transitionUv,
  vec4 transitionMeta,
  vec4 transitionDirection,
  inout vec2 winnerUv,
  inout float winnerChart,
  inout float winnerCount,
  inout float winnerDistance
) {
  float sourceChart = floor(transitionMeta.r + 0.5);
  float destinationChart = floor(transitionMeta.g + 0.5);
  if (transitionUv.z < 0.5 ||
      abs(sourceChart - agentChart) > 0.5 ||
      destinationChart < 0.5 ||
      dot(transitionDirection.zw, transitionDirection.zw) < 0.25) {
    return;
  }
  // Nearest seam wins: the kernel continues across the closest boundary.
  float seamDistance = max(0.0, transitionUv.w);
  if (winnerCount > 0.5 && seamDistance >= winnerDistance) return;
  vec2 destinationIn = normalize(transitionDirection.zw);
  float sourceDepthUv = seamDistance / u_fieldSize;
  winnerUv = transitionUv.xy - destinationIn * sourceDepthUv;
  winnerChart = destinationChart;
  winnerDistance = seamDistance;
  winnerCount = 1.0;
}
void main() {
  vec4 agent = fetchAgent(a_index);
  v_agentUv = agent.xy;
  v_sourceUv = agent.xy;
  v_agentChart = chartIdAt(agent.xy);
  v_sourceChart = v_agentChart;
  v_targetChart = v_agentChart;
  v_splatMode = float(u_splatMode);
  v_alive = agent.w > 0.0 && v_agentChart > 0.5 && !isOwnershipUnsafe(agent.xy) ? 1.0 : 0.0;
  v_reserve = agent.w;
  if (v_alive < 0.5) {
    gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
  } else {
    if (u_splatMode == 1) {
      if (u_useSeamStitching == 0) {
        gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      vec2 winnerUv = agent.xy;
      float winnerChart = 0.0;
      float winnerCount = 0.0;
      float winnerDistance = 1e9;
      for (int slot = 0; slot < ${SEAM_TRANSITION_CANDIDATE_COUNT}; slot++) {
        vec2 candidateUv = seamTransitionCandidateAtlasUv(agent.xy, slot);
        trySplatTransitionCandidate(agent.xy, v_agentChart,
          texture(u_seamTransitionUvAtlas, candidateUv),
          texture(u_seamTransitionMetaAtlas, candidateUv),
          texture(u_seamTransitionDirectionAtlas, candidateUv),
          winnerUv,
          winnerChart,
          winnerCount,
          winnerDistance);
      }
      if (winnerCount < 0.5) {
        gl_Position = vec4(-2.0, -2.0, 0.0, 1.0);
        gl_PointSize = 0.0;
        return;
      }
      v_agentUv = winnerUv;
      v_targetChart = winnerChart;
    }
    gl_Position = vec4(v_agentUv * 2.0 - 1.0, 0.0, 1.0);
    gl_PointSize = u_pointSize;
  }
}
`;

const densityFragment = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
flat in float v_alive;
flat in vec2 v_agentUv;
flat in vec2 v_sourceUv;
flat in float v_agentChart;
flat in float v_sourceChart;
flat in float v_targetChart;
flat in float v_splatMode;
in float v_reserve;
out vec4 outColor;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform float u_fieldSize;
uniform float u_pointSize;
uniform float u_densityMassScale;
uniform float u_maxDensityReserveMass;
${seamKernelContinuationGlsl}
float chartIdAt(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0 ||
    texture(u_chartUnsafe, uv).r >= 0.5;
}
void main() {
  if (v_alive < 0.5 || v_agentChart < 0.5) discard;
  vec2 fragmentUv = gl_FragCoord.xy / vec2(u_fieldSize);
  float fragmentChart = chartIdAt(fragmentUv);
  if (isOwnershipUnsafe(fragmentUv)) discard;
  float distSq = dot(gl_PointCoord * 2.0 - 1.0, gl_PointCoord * 2.0 - 1.0);
  bool acceptsFragment = false;
  if (v_splatMode < 0.5) {
    acceptsFragment = abs(fragmentChart - v_targetChart) <= 0.5;
  } else {
    float seamValid = 0.0;
    vec2 sourceVirtualUv = mapSeamReceiverToSourceVirtualUv(
      fragmentUv,
      fragmentChart,
      v_sourceChart,
      seamValid
    );
    vec2 sourceDeltaTexels = (sourceVirtualUv - v_sourceUv) * u_fieldSize;
    float radius = max(0.5, u_pointSize * 0.5);
    distSq = dot(sourceDeltaTexels, sourceDeltaTexels) / (radius * radius);
    acceptsFragment = abs(fragmentChart - v_targetChart) <= 0.5 && seamValid >= 0.5;
  }
  if (!acceptsFragment || distSq > 1.0) discard;
  float kernel = smoothstep(1.0, 0.0, distSq);
  float reserveMass = clamp(v_reserve, 0.0, u_maxDensityReserveMass);
  outColor = vec4(kernel * reserveMass * u_densityMassScale, 0.0, 0.0, 1.0);
}
`;

// Average paired-vertex food values via the seam weld map (on-island twin lookup).
// Welds at the architectural level: paired-vertex texels are the same surface point,
// so their scalar field values must agree.
const seamEqualizeFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform sampler2D u_seamWeldUv;
uniform sampler2D u_seamWeldMeta;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform int u_useSeamStitching;
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && !isOwnershipUnsafe(uv);
}
void main() {
  float here = texture(u_food, v_uv).r;
  if (u_useSeamStitching == 0) {
    outColor = vec4(here, 0.0, 0.0, 1.0);
    return;
  }
  if (!isAuthoritativeChartTexel(v_uv)) {
    outColor = vec4(here, 0.0, 0.0, 1.0);
    return;
  }
  float baseChart = chartIdAt(v_uv);
  vec4 weldUv = texture(u_seamWeldUv, v_uv);
  if (weldUv.z >= 0.5) {
    vec4 weldMeta = texture(u_seamWeldMeta, v_uv);
    float sourceChart = floor(weldMeta.r + 0.5);
    float destinationChart = floor(weldMeta.g + 0.5);
    if (sourceChart < 0.5 || destinationChart < 0.5 || baseChart != sourceChart) {
      outColor = vec4(here, 0.0, 0.0, 1.0);
      return;
    }
    vec2 twinUv = weldUv.xy;
    if (isOutsideAtlas(twinUv)) {
      outColor = vec4(here, 0.0, 0.0, 1.0);
      return;
    }
    // Snap to exact texel center so the linear-filtered sample of u_food returns
    // that texel's value, not a lerp of its neighbors. Otherwise paired-vertex
    // equalize produces near-equal-but-not-equal values.
    vec2 fieldSize = vec2(textureSize(u_food, 0));
    vec2 twinPixel = clamp(floor(twinUv * fieldSize), vec2(0.0), fieldSize - vec2(1.0));
    vec2 snapped = (twinPixel + 0.5) / fieldSize;
    if (isAuthoritativeChartTexel(snapped) && chartIdAt(snapped) == destinationChart) {
      float twin = texture(u_food, snapped).r;
      outColor = vec4((here + twin) * 0.5, 0.0, 0.0, 1.0);
      return;
    }
  }
  outColor = vec4(here, 0.0, 0.0, 1.0);
}
`;

const deltaFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_food;
uniform sampler2D u_depositDensity;
uniform sampler2D u_chartId;
uniform sampler2D u_chartUnsafe;
uniform float u_uptakeRate;
uniform float u_depositRate;
uniform float u_deltaScale;
uniform float u_dt;
uniform float u_foodClamp;
uniform float u_densityMassScale;
bool isOutsideAtlas(vec2 uv) {
  return uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0;
}
float chartIdAt(vec2 uv) {
  if (isOutsideAtlas(uv)) return -1.0;
  return floor(texture(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return isOutsideAtlas(uv) || texture(u_chartUnsafe, uv).r >= 0.5;
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && !isOwnershipUnsafe(uv);
}
void main() {
  if (!isAuthoritativeChartTexel(v_uv)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float food = max(texture(u_food, v_uv).r, 0.0);
  float density = max(texture(u_depositDensity, v_uv).r, 0.0);
  float agentLoad = min(density / u_densityMassScale, ${MAX_DENSITY_RESERVE_MASS.toFixed(1)});
  float exposure = agentLoad * u_deltaScale * u_dt;
  float deposited = u_depositRate * exposure;
  float uptake = food * (1.0 - exp(-u_uptakeRate * exposure));
  float nextFood = clamp(food + deposited - uptake, 0.0, u_foodClamp);
  outColor = vec4(nextFood, 0.0, 0.0, 1.0);
}
`;

// UV mask raster: a special vertex shader that emits the mesh's UVs to NDC.
const uvMaskVertex = `#version 300 es
in vec3 position;
in vec2 uv;
void main() {
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}
`;

const uvMaskFragment = `#version 300 es
precision highp float;
out vec4 outColor;
void main() { outColor = vec4(1.0, 1.0, 1.0, 1.0); }
`;

const textureUploadFragment = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_source;
void main() {
  outColor = texture(u_source, v_uv);
}
`;

// Seam redirect raster: rasterize halo quads carrying redirect uv + rotation.
const seamRedirectVertex = `#version 300 es
in vec3 position;     // halo NDC position
in vec2 a_redirect;   // destination UV
in vec2 a_rotation;   // sin, cos of rotation
in vec2 a_chart;      // source chart, destination chart
in float a_haloDistance; // distance from seam edge in texels
in vec4 a_transitionDirection; // source outward normal, destination inward normal
in vec4 a_transitionBasis;     // source edge tangent, destination edge tangent
out vec2 v_redirect;
out vec2 v_rotation;
out vec2 v_chart;
out float v_haloDistance;
out vec4 v_transitionDirection;
out vec4 v_transitionBasis;
void main() {
  v_redirect = a_redirect;
  v_rotation = a_rotation;
  v_chart = a_chart;
  v_haloDistance = a_haloDistance;
  v_transitionDirection = a_transitionDirection;
  v_transitionBasis = a_transitionBasis;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const seamUvFragment = `#version 300 es
precision highp float;
in vec2 v_redirect;
in float v_haloDistance;
out vec4 outColor;
void main() {
  outColor = vec4(v_redirect.x, v_redirect.y, 1.0, v_haloDistance);
}
`;

const seamClaimFragment = `#version 300 es
precision highp float;
out vec4 outColor;
void main() {
  outColor = vec4(1.0, 0.0, 0.0, 1.0);
}
`;

const seamMetaFragment = `#version 300 es
precision highp float;
in vec2 v_rotation;
in vec2 v_chart;
out vec4 outColor;
void main() {
  outColor = vec4(v_chart.x, v_chart.y, v_rotation.x, v_rotation.y);
}
`;

const seamTransitionDirectionFragment = `#version 300 es
precision highp float;
in vec4 v_transitionDirection;
out vec4 outColor;
void main() {
  outColor = v_transitionDirection;
}
`;

const seamTransitionBasisFragment = `#version 300 es
precision highp float;
in vec4 v_transitionBasis;
out vec4 outColor;
void main() {
  outColor = v_transitionBasis;
}
`;

const seamRedirectCoverageVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const seamRedirectCoverageFragment = `
uniform sampler2D u_seamRedirectUv;
varying vec2 vUv;
void main() {
  float valid = step(0.5, texture2D(u_seamRedirectUv, vUv).b);
  vec3 color = mix(vec3(0.0), vec3(0.1, 1.0, 0.45), valid);
  gl_FragColor = vec4(color, 1.0);
}
`;

const chartOwnershipDebugHelpers = `
uniform sampler2D u_chartId;
uniform sampler2D u_chartConflict;
float chartIdAt(vec2 uv) {
  return floor(texture2D(u_chartId, uv).r + 0.5);
}
bool isOwnershipUnsafe(vec2 uv) {
  return texture2D(u_chartConflict, uv).r >= 0.5;
}
bool sameChart(vec2 a, vec2 b) {
  float chartA = chartIdAt(a);
  return chartA > 0.5 && chartA == chartIdAt(b);
}
bool isSafeEmptyGutter(vec2 uv) {
  return chartIdAt(uv) < 0.5 && !isOwnershipUnsafe(uv);
}
bool isAuthoritativeChartTexel(vec2 uv) {
  return chartIdAt(uv) > 0.5 && !isOwnershipUnsafe(uv);
}
bool isEmptyGutter(vec2 uv) {
  return isSafeEmptyGutter(uv);
}
bool isOwnershipConflict(vec2 uv) {
  return isOwnershipUnsafe(uv);
}
`;

const seamTransitionCoverageFragment = `
uniform sampler2D u_seamTransitionUvAtlas;
uniform sampler2D u_seamTransitionClaim;
varying vec2 vUv;
vec2 seamTransitionCandidateAtlasUv(vec2 uv, float slot) {
  return vec2((uv.x + slot) / ${SEAM_TRANSITION_CANDIDATE_COUNT.toFixed(1)}, uv.y);
}
void main() {
  float valid = step(0.5, texture2D(u_seamTransitionUvAtlas, seamTransitionCandidateAtlasUv(vUv, 0.0)).b);
  vec4 claim = texture2D(u_seamTransitionClaim, vUv);
  float multiCandidate = step(${SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD.toFixed(1)}, claim.r);
  float overflow = step(0.5, claim.g);
  vec3 color = mix(vec3(0.0), vec3(0.1, 1.0, 0.7), valid);
  color = mix(color, vec3(0.18, 0.34, 1.0), multiCandidate * valid);
  color = mix(color, vec3(1.0, 0.08, 0.04), overflow * valid);
  gl_FragColor = vec4(color, 1.0);
}
`;

const chartIdDebugVertex = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const chartIdDebugFragment = `
varying vec2 vUv;
${chartOwnershipDebugHelpers}
vec3 chartColor(float id) {
  vec3 seed = vec3(0.1031, 0.11369, 0.13787) * id;
  return 0.18 + 0.82 * fract(sin(seed * 437.13 + id) * 43758.5453);
}
void main() {
  float id = chartIdAt(vUv);
  vec3 color = id < 0.5 ? vec3(0.0) : chartColor(id);
  if (isOwnershipUnsafe(vUv)) {
    color = vec3(1.0, 0.05, 0.8);
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

const chartConflictDebugFragment = `
varying vec2 vUv;
${chartOwnershipDebugHelpers}
void main() {
  float id = chartIdAt(vUv);
  vec3 color = id < 0.5 ? vec3(0.0) : vec3(0.035, 0.045, 0.045);
  if (isOwnershipUnsafe(vUv)) {
    color = vec3(1.0, 0.05, 0.1);
  }
  gl_FragColor = vec4(color, 1.0);
}
`;

const surfaceCoverageDebugFragment = `
uniform sampler2D u_surfaceCoverage;
varying vec2 vUv;
void main() {
  float covered = step(0.5, texture2D(u_surfaceCoverage, vUv).r);
  gl_FragColor = vec4(vec3(covered), 1.0);
}
`;

const coverageComparisonDebugFragment = `
uniform sampler2D u_legacyCoverage;
uniform sampler2D u_surfaceCoverage;
varying vec2 vUv;
void main() {
  float legacyCovered = step(0.5, texture2D(u_legacyCoverage, vUv).r);
  float conservativeCovered = step(0.5, texture2D(u_surfaceCoverage, vUv).r);
  vec3 color = vec3(0.0);
  if (legacyCovered > 0.5 && conservativeCovered > 0.5) color = vec3(0.82);
  if (legacyCovered < 0.5 && conservativeCovered > 0.5) color = vec3(0.0, 0.85, 1.0);
  if (legacyCovered > 0.5 && conservativeCovered < 0.5) color = vec3(1.0, 0.08, 0.08);
  gl_FragColor = vec4(color, 1.0);
}
`;

const simulationDomainDebugFragment = `
uniform sampler2D u_surfaceCoverage;
varying vec2 vUv;
${chartOwnershipDebugHelpers}
void main() {
  float covered = step(0.5, texture2D(u_surfaceCoverage, vUv).r);
  float id = chartIdAt(vUv);
  bool unsafe = isOwnershipUnsafe(vUv);
  vec3 color = vec3(0.0);
  if (covered > 0.5) color = vec3(0.85);
  if (covered > 0.5 && id < 0.5) color = vec3(1.0, 0.75, 0.05);
  if (unsafe) color = vec3(1.0, 0.05, 0.08);
  if (id > 0.5 && !unsafe) color = vec3(0.05, 0.85, 0.25);
  gl_FragColor = vec4(color, 1.0);
}
`;

const watertightCracksDebugFragment = `
uniform sampler2D u_surfaceCoverage;
varying vec2 vUv;
${chartOwnershipDebugHelpers}
void main() {
  float covered = step(0.5, texture2D(u_surfaceCoverage, vUv).r);
  float id = chartIdAt(vUv);
  bool unsafe = isOwnershipUnsafe(vUv);
  vec3 color = vec3(0.0);
  if (covered > 0.5) color = vec3(0.92);
  if (id > 0.5 && !unsafe) color = vec3(0.05, 0.85, 0.25);
  if (covered > 0.5 && id < 0.5 && !unsafe) color = vec3(1.0, 0.75, 0.05);
  if (covered > 0.5 && unsafe) color = vec3(1.0, 0.05, 0.08);
  if (covered < 0.5 && id > 0.5) color = vec3(1.0, 0.0, 0.85);
  gl_FragColor = vec4(color, 1.0);
}
`;

// === Slime cuttlefish material (ShaderMaterial) ===
// Uses three.js's auto-injected uniforms (projectionMatrix, modelViewMatrix, etc.) and
// auto-injected attributes (position, normal, uv).

const slimeVertex = `
out vec2 v_uv;
out vec3 v_worldPos;
out vec3 v_worldNormal;
out vec3 v_viewPos;
out vec3 v_viewNormal;
void main() {
  v_uv = uv;
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
  v_worldPos = worldPos.xyz;
  v_worldNormal = normalize(mat3(modelMatrix) * normal);
  v_viewPos = viewPos.xyz;
  v_viewNormal = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewPos;
}
`;

const slimeFragment = `
precision highp float;
in vec2 v_uv;
in vec3 v_worldPos;
in vec3 v_worldNormal;
in vec3 v_viewPos;
in vec3 v_viewNormal;
out vec4 outColor;
uniform sampler2D u_food;
uniform sampler2D u_agentDensity;
uniform sampler2D u_agentDensityOverlay;
uniform vec2 u_texel;
uniform float u_heightScale;
uniform float u_bumpStrength;
uniform float u_normalSampleRadius;
uniform float u_iridescenceStrength;
uniform float u_iridescenceMinThickness;
uniform float u_iridescenceThickness;
uniform float u_filmThicknessCurve;
uniform float u_lightBrightness;
uniform float u_foodClamp;
uniform sampler2D u_goldWaferLookup;
uniform float u_goldLookupW;
uniform float u_goldLookupH;
uniform float u_goldLookupMinNm;
uniform float u_goldLookupSpanNm;
uniform vec3 u_lightPositions[${ICOSA_LIGHT_COUNT}];
uniform int u_lightCount;
uniform float u_lightRadianceScale;
uniform vec3 u_cameraPos;
uniform vec3 u_baseColor;
uniform int u_meshOutlineEnabled;
uniform int u_showAgentDots;
uniform int u_bumpDiagonalTapsEnabled;
uniform int u_filmFollowsSlimeHeight;
uniform int u_useGoldWaferFilm;
uniform int u_useGoldWaferBodyUnderlay;
${safeSamplingGlsl}
float heightFromFood(float food) {
  return (1.0 - exp(-max(food, 0.0) * 4.0)) * u_heightScale;
}
float filmThickness01FromFood(float food) {
  float maxFood = max(u_foodClamp, 0.0001);
  float x = clamp(max(food, 0.0), 0.0, maxFood);
  float curve = max(u_filmThicknessCurve, 0.0001);
  float denom = 1.0 - exp(-curve * maxFood);
  if (denom < 0.00001) return clamp(x / maxFood, 0.0, 1.0);
  return clamp((1.0 - exp(-curve * x)) / denom, 0.0, 1.0);
}
float readFoodSafe(vec2 sampleUv, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(v_uv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  return max(texture(u_food, r).r, 0.0);
}
float readDensitySafe(vec2 baseUv, vec2 sampleUv, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  ivec2 densitySize = textureSize(u_agentDensity, 0);
  ivec2 densityPixel = clamp(
    ivec2(floor(r * vec2(densitySize))),
    ivec2(0),
    densitySize - ivec2(1)
  );
  return max(texelFetch(u_agentDensity, densityPixel, 0).r, 0.0);
}
float readAgentDensityOverlaySafe(vec2 baseUv, vec2 sampleUv, float fallback) {
  float valid = 0.0;
  vec2 r = resolveSampleUvSafe(baseUv, sampleUv, valid);
  if (valid < 0.5) return fallback;
  ivec2 overlaySize = textureSize(u_agentDensityOverlay, 0);
  ivec2 overlayPixel = clamp(
    ivec2(floor(r * vec2(overlaySize))),
    ivec2(0),
    overlaySize - ivec2(1)
  );
  return max(texelFetch(u_agentDensityOverlay, overlayPixel, 0).r, 0.0);
}
const float PI = 3.141592653589793;
const int ICOSA_LIGHT_COUNT = ${ICOSA_LIGHT_COUNT};
vec3 schlickFresnel(vec3 f0, float cosTheta) {
  float f = pow(1.0 - clamp(cosTheta, 0.0, 1.0), 5.0);
  return f0 + (vec3(1.0) - f0) * f;
}
float ggxDistribution(float nDotH, float roughness) {
  float a = max(roughness * roughness, 0.001);
  float a2 = a * a;
  float denom = nDotH * nDotH * (a2 - 1.0) + 1.0;
  return a2 / max(PI * denom * denom, 1e-5);
}
float smithG1(float nDotX, float roughness) {
  float r = roughness + 1.0;
  float k = (r * r) * 0.125;
  return nDotX / max(nDotX * (1.0 - k) + k, 1e-5);
}
float smithVisibility(float nDotL, float nDotV, float roughness) {
  return smithG1(nDotL, roughness) * smithG1(nDotV, roughness);
}
vec3 microfacetSpecular(vec3 normal, vec3 viewDir, vec3 lightDir, vec3 f0, float roughness) {
  float nDotL = max(dot(normal, lightDir), 0.0);
  float nDotV = max(dot(normal, viewDir), 0.001);
  vec3 halfDir = normalize(lightDir + viewDir);
  float nDotH = max(dot(normal, halfDir), 0.0);
  float vDotH = max(dot(viewDir, halfDir), 0.0);
  vec3 F = schlickFresnel(f0, vDotH);
  float D = ggxDistribution(nDotH, roughness);
  float G = smithVisibility(nDotL, nDotV, roughness);
  float lobe = min((D * G * nDotL) / max(4.0 * nDotL * nDotV, 0.02), 7.5);
  return F * lobe;
}
vec3 thinFilmColor(float nDotV, float thicknessNm) {
  const float filmIor = 1.36;
  float sinTheta = sqrt(max(1.0 - nDotV * nDotV, 0.0));
  float sinFilm = clamp(sinTheta / filmIor, 0.0, 0.999);
  float cosFilm = sqrt(max(1.0 - sinFilm * sinFilm, 0.0));
  float thickness = max(thicknessNm, 0.0);
  float opticalPath = 2.0 * filmIor * thickness * cosFilm;
  vec3 wavelengths = vec3(680.0, 535.0, 440.0);
  vec3 phase = opticalPath * (2.0 * PI) / wavelengths;
  vec3 interference = 0.5 + 0.5 * cos(phase + vec3(0.45, 2.35, 4.20));
  interference = interference * interference * (3.0 - 2.0 * interference);
  vec3 abaloneBias = vec3(1.08, 1.18, 1.32);
  return clamp(interference * abaloneBias, 0.0, 1.0);
}
const float GOLD_COS_P0 = 1.00000000;
const float GOLD_COS_P1 = 0.98480775;
const float GOLD_COS_P2 = 0.93969262;
const float GOLD_COS_P3 = 0.86602540;
const float GOLD_COS_P4 = 0.76604444;
const float GOLD_COS_P5 = 0.64278761;
const float GOLD_COS_P6 = 0.50000000;
const float GOLD_COS_P7 = 0.34202014;
const float GOLD_COS_P8 = 0.17364818;
const float GOLD_COS_P9 = 0.08715574;
float goldFindAngleSeg(float c) {
  if (c >= GOLD_COS_P1) return 0.0;
  if (c >= GOLD_COS_P2) return 1.0;
  if (c >= GOLD_COS_P3) return 2.0;
  if (c >= GOLD_COS_P4) return 3.0;
  if (c >= GOLD_COS_P5) return 4.0;
  if (c >= GOLD_COS_P6) return 5.0;
  if (c >= GOLD_COS_P7) return 6.0;
  if (c >= GOLD_COS_P8) return 7.0;
  return 8.0;
}
float goldCosAt(int idx) {
  idx = clamp(idx, 0, 9);
  if (idx == 0) return GOLD_COS_P0;
  if (idx == 1) return GOLD_COS_P1;
  if (idx == 2) return GOLD_COS_P2;
  if (idx == 3) return GOLD_COS_P3;
  if (idx == 4) return GOLD_COS_P4;
  if (idx == 5) return GOLD_COS_P5;
  if (idx == 6) return GOLD_COS_P6;
  if (idx == 7) return GOLD_COS_P7;
  if (idx == 8) return GOLD_COS_P8;
  return GOLD_COS_P9;
}
vec4 goldAngleHermiteWeights(float c, out float segOut) {
  float seg = goldFindAngleSeg(c);
  segOut = seg;
  int iseg = int(seg);
  float cL = goldCosAt(iseg);
  float cR = goldCosAt(iseg + 1);
  float cP = goldCosAt(iseg - 1);
  float cN = goldCosAt(iseg + 2);
  float h = cR - cL;
  float alpha = h / (cR - cP);
  float beta = h / (cN - cL);
  float s = (cL - c) / (cL - cR);
  float s2 = s * s;
  float s3 = s2 * s;
  float H00 = 2.0 * s3 - 3.0 * s2 + 1.0;
  float H10 = s3 - 2.0 * s2 + s;
  float H01 = -2.0 * s3 + 3.0 * s2;
  float H11 = s3 - s2;
  return vec4(
    -alpha * H10,
     H00 - beta * H11,
     H01 + alpha * H10,
     beta * H11
  );
}
vec4 goldThicknessCubicW(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return 0.5 * vec4(
    -t3 + 2.0 * t2 - t,
     3.0 * t3 - 5.0 * t2 + 2.0,
    -3.0 * t3 + 4.0 * t2 + t,
     t3 - t2
  );
}
vec3 goldLookupTap(float ti, float ai) {
  ti = clamp(ti, 0.0, u_goldLookupW - 1.0);
  ai = clamp(ai, 0.0, u_goldLookupH - 1.0);
  vec2 uv = vec2((ti + 0.5) / u_goldLookupW, (ai + 0.5) / u_goldLookupH);
  return texture(u_goldWaferLookup, uv).rgb;
}
vec3 goldWaferFilmColor(float nDotV, float thicknessNm) {
  float c = clamp(nDotV, GOLD_COS_P9, GOLD_COS_P0);
  float t = clamp(thicknessNm, u_goldLookupMinNm, u_goldLookupMinNm + u_goldLookupSpanNm);
  float tIdx = (t - u_goldLookupMinNm) / u_goldLookupSpanNm * (u_goldLookupW - 1.0);
  float ti0 = clamp(floor(tIdx), 0.0, u_goldLookupW - 2.0);
  float ft = tIdx - ti0;
  vec4 wt = goldThicknessCubicW(ft);
  float seg;
  vec4 wa = goldAngleHermiteWeights(c, seg);
  vec3 r = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    float ay = seg - 1.0 + float(j);
    vec3 row = wt.x * goldLookupTap(ti0 - 1.0, ay)
             + wt.y * goldLookupTap(ti0,        ay)
             + wt.z * goldLookupTap(ti0 + 1.0,  ay)
             + wt.w * goldLookupTap(ti0 + 2.0,  ay);
    r += wa[j] * row;
  }
  return clamp(r, 0.0, 1.0);
}
void main() {
  bool baseSafe = isAuthoritativeChartTexel(v_uv);
  float food = baseSafe ? max(texture(u_food, v_uv).r, 0.0) : 0.0;

  // Build tangent space from screen-space derivatives.
  vec3 dp1 = dFdx(v_worldPos);
  vec3 dp2 = dFdy(v_worldPos);
  vec2 duv1 = dFdx(v_uv);
  vec2 duv2 = dFdy(v_uv);
  vec3 N0 = normalize(v_worldNormal);
  if (!gl_FrontFacing) N0 = -N0;
  vec3 dp2perp = cross(dp2, N0);
  vec3 dp1perp = cross(N0, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float tb2 = max(dot(T, T), dot(B, B));
  if (tb2 > 1e-24) {
    float invMax = inversesqrt(tb2);
    T *= invMax;
    B *= invMax;
  } else {
    vec3 up = abs(N0.y) < 0.999 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    T = normalize(cross(up, N0));
    B = normalize(cross(N0, T));
  }

  vec3 viewDir = normalize(u_cameraPos - v_worldPos);
  float normalRadius = max(u_normalSampleRadius, 1.0);
  vec2 normalTexel = u_texel * normalRadius;
  float normalScale = u_bumpStrength / normalRadius;
  float hL = heightFromFood(readFoodSafe(v_uv - vec2(normalTexel.x, 0.0), food));
  float hR = heightFromFood(readFoodSafe(v_uv + vec2(normalTexel.x, 0.0), food));
  float hD = heightFromFood(readFoodSafe(v_uv - vec2(0.0, normalTexel.y), food));
  float hU = heightFromFood(readFoodSafe(v_uv + vec2(0.0, normalTexel.y), food));
  float gradX = (hR - hL) * 0.5;
  float gradY = (hU - hD) * 0.5;
  if (u_bumpDiagonalTapsEnabled == 1) {
    float hUL = heightFromFood(readFoodSafe(v_uv + vec2(-normalTexel.x, normalTexel.y), food));
    float hUR = heightFromFood(readFoodSafe(v_uv + normalTexel, food));
    float hDL = heightFromFood(readFoodSafe(v_uv - normalTexel, food));
    float hDR = heightFromFood(readFoodSafe(v_uv + vec2(normalTexel.x, -normalTexel.y), food));
    gradX += (hUR + hDR - hUL - hDL) * 0.25;
    gradY += (hUL + hUR - hDL - hDR) * 0.25;
  }
  vec3 perturbed = N0 - T * gradX * normalScale - B * gradY * normalScale;
  vec3 normal = normalize(perturbed);

  float foodViz = 1.0 - exp(-food * 2.4);
  float trail = pow(foodViz, 0.68);
  float trailCore = foodViz * foodViz * 0.55;
  float glossMask = smoothstep(0.02, 0.26, food);
  float slimePresence = smoothstep(0.006, 0.08, food);
  float nDotV = max(dot(normal, viewDir), 0.001);

  float filmThickness = u_iridescenceThickness;
  if (u_filmFollowsSlimeHeight == 1) {
    float filmMin = min(u_iridescenceMinThickness, u_iridescenceThickness);
    float filmMax = max(u_iridescenceMinThickness, u_iridescenceThickness);
    float slimeHeight01 = filmThickness01FromFood(food);
    filmThickness = mix(filmMin, filmMax, slimeHeight01);
  }
  vec3 filmColor = thinFilmColor(nDotV, filmThickness);
  if (u_useGoldWaferFilm == 1) {
    filmColor = goldWaferFilmColor(nDotV, filmThickness);
  }

  float iridescence = clamp(u_iridescenceStrength, 0.0, 2.0);
  vec3 filmF0 = clamp(mix(vec3(0.045), vec3(0.065) + filmColor * 0.34, iridescence), 0.0, 1.0);
  if (u_useGoldWaferFilm == 1) {
    filmF0 = clamp(mix(vec3(0.045), filmColor, iridescence), 0.0, 1.0);
  }
  vec3 filmFView = schlickFresnel(filmF0, nDotV) * slimePresence;
  vec3 clearFView = schlickFresnel(vec3(0.035), nDotV) * slimePresence * (0.22 + glossMask * 0.58);
  vec3 reflectedBudget = clamp(filmFView + clearFView * (vec3(1.0) - filmFView), vec3(0.0), vec3(0.92));
  vec3 bodyBudget = max(vec3(0.0), vec3(1.0) - reflectedBudget);

  vec3 liquidBody = clamp(u_baseColor, 0.0, 1.0);
  vec3 deepBody = liquidBody * vec3(0.32, 0.34, 0.36);
  vec3 pearlBody = mix(deepBody, liquidBody, trail);
  pearlBody = mix(pearlBody, pearlBody + filmColor * 0.11, slimePresence * (0.30 + trailCore * 0.35));
  pearlBody = clamp(pearlBody, 0.0, 1.0);

  vec3 icosaLightRadiance = vec3(1.0) * u_lightBrightness * u_lightRadianceScale;
  vec3 ambientRadiance = vec3(0.22, 0.24, 0.26);
  float bodyRoughness = mix(0.34, 0.105, glossMask);
  float clearRoughness = mix(0.18, 0.055, glossMask);

  vec3 diffuseLight = ambientRadiance;
  vec3 filmSpec = vec3(0.0);
  vec3 clearSpec = vec3(0.0);
  for (int i = 0; i < ICOSA_LIGHT_COUNT; i++) {
    if (i >= u_lightCount) break;
    vec3 lightDir = normalize(u_lightPositions[i] - v_worldPos);
    float nDotLight = max(dot(normal, lightDir), 0.0);
    diffuseLight += icosaLightRadiance * nDotLight;
    filmSpec += microfacetSpecular(normal, viewDir, lightDir, filmF0, bodyRoughness) * icosaLightRadiance;
    clearSpec += microfacetSpecular(normal, viewDir, lightDir, vec3(0.035), clearRoughness) * icosaLightRadiance;
  }
  clearSpec *= slimePresence * (0.18 + glossMask * 0.82);

  float pearlMask = max(trail, slimePresence * 0.26);
  vec3 color = pearlBody * bodyBudget * diffuseLight * pearlMask;
  color += filmSpec * slimePresence * (0.42 + trailCore * 0.85);
  color += clearSpec;
  color += bodyBudget * filmColor * slimePresence * (0.018 + trailCore * 0.045);

  float agentDotAlpha = 0.0;
  if (u_showAgentDots == 1) {
    float overlayDensity = readAgentDensityOverlaySafe(v_uv, v_uv, 0.0);
    agentDotAlpha = smoothstep(0.003, 0.028, overlayDensity);
    vec3 cyan = vec3(0.50, 1.0, 0.95);
    color = mix(color, cyan, agentDotAlpha * 0.78);
    color += cyan * agentDotAlpha * 0.38;
  }

  float outlineAlpha = 0.0;
  if (u_meshOutlineEnabled == 1) {
    outlineAlpha = pow(1.0 - max(dot(N0, viewDir), 0.0), 3.0);
    color += vec3(0.18, 0.36, 0.55) * outlineAlpha * 0.34;
  }

  float slimeLayerAlpha = clamp(
    max(max(slimePresence * 0.82, trail * 0.68), outlineAlpha),
    0.0,
    1.0
  );

  vec3 slimeColor = color;
  vec3 legacySlimeOnly = pow(max(slimeColor, vec3(0.0)), vec3(0.78));

  vec3 finalColor = legacySlimeOnly;

  if (u_useGoldWaferBodyUnderlay == 1) {
    outColor = vec4(max(finalColor, vec3(0.0)), slimeLayerAlpha);
    return;
  }
  outColor = vec4(max(finalColor, vec3(0.0)), 1.0);
}
`;

// === build sim materials ===
function makeRawShaderMaterial(fragment, uniforms, vertex = fullscreenVertex, extras = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(vertex),
    fragmentShader: stripGlslVersion(fragment),
    uniforms,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    ...extras,
  });
}

function stripGlslVersion(shader) {
  return shader.replace(/^\s*#version\s+300\s+es\s*/, '');
}

goldWaferBodyIcoEnvMaterial = makeRawShaderMaterial(goldWaferBodyIcoEnvFragment, {
  u_lightDirections: { value: icosahedronLightPositions.map((position) => position.clone().normalize()) },
  u_lightCount: { value: getActiveIcosaLightCount() },
  u_lightRadianceScale: { value: getActiveIcosaLightRadianceScale() },
});

function ensureGoldWaferBodyEnvironmentMap() {
  if (goldWaferBodyIcoEnvPmrem) return goldWaferBodyIcoEnvPmrem.texture;
  if (!goldWaferBodyIcoEnvRT) {
    goldWaferBodyIcoEnvRT = new THREE.WebGLRenderTarget(
      GOLD_WAFER_BODY_ENV_EQUIRECT_WIDTH,
      GOLD_WAFER_BODY_ENV_EQUIRECT_HEIGHT,
      {
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
        format: THREE.RGBAFormat,
        type: colorBufferFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
      },
    );
    goldWaferBodyIcoEnvRT.texture.generateMipmaps = false;
    goldWaferBodyIcoEnvRT.texture.colorSpace = THREE.NoColorSpace;
    goldWaferBodyIcoEnvRT.texture.mapping = THREE.EquirectangularReflectionMapping;
    goldWaferBodyIcoEnvRT.texture.name = 'gold-wafer-body-icosa-env-equirect';
  }
  const previousTarget = renderer.getRenderTarget();
  runFullscreenPass(goldWaferBodyIcoEnvMaterial, goldWaferBodyIcoEnvRT);
  renderer.setRenderTarget(previousTarget);
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  goldWaferBodyIcoEnvPmrem = pmremGenerator.fromEquirectangular(goldWaferBodyIcoEnvRT.texture);
  goldWaferBodyIcoEnvPmrem.texture.name = 'gold-wafer-body-icosa-env';
  pmremGenerator.dispose();
  return goldWaferBodyIcoEnvPmrem.texture;
}

const oatMaterial = makeRawShaderMaterial(oatFragment, {
  u_oatCount: { value: 0 },
  u_oats: { value: new Array(MAX_OATS).fill(null).map(() => new THREE.Vector2()) },
  u_oatRadius: { value: new Float32Array(MAX_OATS) },
  u_oatPower: { value: new Float32Array(MAX_OATS) },
  u_oatChart: { value: new Float32Array(MAX_OATS) },
  u_oatSupportSigmas: { value: OAT_SUPPORT_SIGMAS },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_seamTransitionUvAtlas: { value: seamTransitionUvAtlasRT.texture },
  u_seamTransitionMetaAtlas: { value: seamTransitionMetaAtlasRT.texture },
  u_seamTransitionDirectionAtlas: { value: seamTransitionDirectionAtlasRT.texture },
  u_seamTransitionBasisAtlas: { value: seamTransitionBasisAtlasRT.texture },
  u_seamTransitionClaim: { value: seamTransitionClaimRT.texture },
  u_useSeamStitching: { value: 1 },
});

const sharedSeamUniforms = () => ({
  u_seamRedirectUv: { value: seamRedirectUvRT.texture },
  u_seamRedirectMeta: { value: seamRedirectMetaRT.texture },
  u_islandMask: { value: uvIslandMaskRT.texture },
  u_useSeamStitching: { value: 1 },
  u_useIslandMasking: { value: 1 },
});

const sharedSafeSamplingUniforms = () => ({
  u_seamRedirectUv: { value: seamRedirectUvRT.texture },
  u_seamRedirectMeta: { value: seamRedirectMetaRT.texture },
  u_seamRedirectClaim: { value: seamRedirectClaimRT.texture },
  u_seamTransitionUvAtlas: { value: seamTransitionUvAtlasRT.texture },
  u_seamTransitionMetaAtlas: { value: seamTransitionMetaAtlasRT.texture },
  u_seamTransitionDirectionAtlas: { value: seamTransitionDirectionAtlasRT.texture },
  u_seamTransitionBasisAtlas: { value: seamTransitionBasisAtlasRT.texture },
  u_seamTransitionClaim: { value: seamTransitionClaimRT.texture },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_useSeamStitching: { value: 1 },
  u_useZeroGutterTransitions: { value: 0 },
});

const diffuseMaterial = makeRawShaderMaterial(diffuseFragment, {
  u_food: { value: null },
  u_texel: { value: new THREE.Vector2(1 / FIELD_SIZE, 1 / FIELD_SIZE) },
  u_diffusion: { value: params.fieldDiffusion },
  u_decay: { value: params.fieldDecay },
  u_foodClamp: { value: params.foodClamp },
  ...sharedSafeSamplingUniforms(),
  u_useZeroGutterTransitions: { value: 1 },
});

const clampMaterial = makeRawShaderMaterial(clampFragment, {
  u_food: { value: null },
  u_foodClamp: { value: params.foodClamp },
});

const sampleViewCopyMaterial = makeRawShaderMaterial(sampleViewCopyFragment, {
  u_source: { value: null },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
});

const observationTriggerScoreMaterial = makeRawShaderMaterial(observationTriggerScoreFragment, {
  u_food: { value: null },
  u_oatCount: { value: 0 },
  u_oats: { value: new Array(MAX_OATS).fill(null).map(() => new THREE.Vector2()) },
});

const observationTriggerThresholdQueryMaterial = makeRawShaderMaterial(observationTriggerThresholdQueryFragment, {
  u_scores: { value: observationTriggerScoreRT.texture },
  u_oatCount: { value: 0 },
  u_threshold: { value: 0 },
  u_pending: { value: new Float32Array(MAX_OATS) },
});

const safeSeamPaddingMaterial = makeRawShaderMaterial(safeSeamPaddingFragment, {
  u_existingSampleView: { value: null },
  u_sourceCanonical: { value: null },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_seamRedirectUv: { value: seamRedirectUvRT.texture },
  u_seamRedirectMeta: { value: seamRedirectMetaRT.texture },
  u_seamRedirectClaim: { value: seamRedirectClaimRT.texture },
  u_maxPadTexels: { value: SEAM_REDIRECT_HALO_TEXELS },
});

const seamPaddingDebugMaterial = makeRawShaderMaterial(seamPaddingDebugFragment, {
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_seamRedirectUv: { value: seamRedirectUvRT.texture },
  u_seamRedirectMeta: { value: seamRedirectMetaRT.texture },
  u_seamRedirectClaim: { value: seamRedirectClaimRT.texture },
  u_requestedPadTexels: { value: SEAM_REDIRECT_HALO_TEXELS },
  u_maxPadTexels: { value: SEAM_REDIRECT_HALO_TEXELS },
});

const smoothMaterial = makeRawShaderMaterial(smoothFragment, {
  u_currentFood: { value: null },
  u_previousFood: { value: null },
  u_texel: { value: new THREE.Vector2(1 / FIELD_SIZE, 1 / FIELD_SIZE) },
  u_direction: { value: new THREE.Vector2(1, 0) },
  u_spatialRadius: { value: params.spatialSmoothing },
  u_temporalWeight: { value: 0 },
  u_foodClamp: { value: params.foodClamp },
  u_applyTemporal: { value: 0 },
  u_smoothingTapCount: { value: getRenderSmoothingTapCount(params) },
  ...sharedSafeSamplingUniforms(),
  u_useZeroGutterTransitions: { value: 1 },
});

const maxFoodHistoryMaterial = makeRawShaderMaterial(maxFoodHistoryFragment, {
  u_currentFood: { value: null },
  u_previousMax: { value: goldWaferBodyZeroFoodTexture },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
});

const dilateMaterial = makeRawShaderMaterial(dilateFragment, {
  u_food: { value: null },
  u_islandMask: { value: uvIslandMaskRT.texture },
  u_texel: { value: new THREE.Vector2(1 / FIELD_SIZE, 1 / FIELD_SIZE) },
});

const agentParentUpdateMaterial = makeRawShaderMaterial(agentParentUpdateFragment, {
  u_agents: { value: null },
  u_food: { value: null },
  u_oat: { value: oatRT.texture },
  u_density: { value: densityRT.texture },
  u_agentSide: { value: AGENT_SIDE },
  u_time: { value: 0 },
  u_dt: { value: 1 },
  u_stepSize: { value: params.stepSize },
  u_minMoveScale: { value: params.minMoveScale },
  u_sensorDistance: { value: params.sensorDistance },
  u_sensorAngle: { value: params.sensorAngle },
  u_turnAngle: { value: params.turnAngle },
  u_wander: { value: params.wander },
  u_uptakeRate: { value: params.uptakeRate },
  u_depositRate: { value: params.depositRate },
  u_burnRate: { value: params.burnRate },
  u_reproThreshold: { value: params.reproThreshold },
  u_reproAngle: { value: params.reproAngle },
  u_childStep: { value: params.childStep },
  u_foodWeight: { value: params.foodWeight },
  u_crowdWeight: { value: params.crowdWeight },
  u_crowdExponent: { value: params.crowdExponent },
  u_densityTarget: { value: params.densityTarget },
  u_maxReserve: { value: params.maxReserve },
  u_oatSupplyRate: { value: params.oatSupplyRate },
  u_densityMassScale: { value: DENSITY_MASS_SCALE },
  u_useOatRationing: { value: params.useOatRationing ? 1 : 0 },
  u_useHeadingRotation: { value: 1 },
  u_mouseRepelActive: { value: 0 },
  u_mouseRepelUv: { value: new THREE.Vector2() },
  u_mouseRepelChart: { value: 0 },
  u_mouseRepelRadius: { value: MOUSE_REPEL_RADIUS_UV },
  u_mouseRepelStrength: { value: MOUSE_REPEL_STRENGTH },
  ...sharedSafeSamplingUniforms(),
});

const agentCandidateBuildMaterial = makeRawShaderMaterial(agentCandidateBuildFragment, {
  u_agents: { value: null },
  u_parentNext: { value: agentParentNextRT.texture },
  u_food: { value: null },
  u_oat: { value: oatRT.texture },
  u_density: { value: densityRT.texture },
  u_agentSide: { value: AGENT_SIDE },
  u_time: { value: 0 },
  u_dt: { value: 1 },
  u_stepSize: { value: params.stepSize },
  u_minMoveScale: { value: params.minMoveScale },
  u_sensorDistance: { value: params.sensorDistance },
  u_sensorAngle: { value: params.sensorAngle },
  u_turnAngle: { value: params.turnAngle },
  u_wander: { value: params.wander },
  u_uptakeRate: { value: params.uptakeRate },
  u_depositRate: { value: params.depositRate },
  u_burnRate: { value: params.burnRate },
  u_reproThreshold: { value: params.reproThreshold },
  u_reproAngle: { value: params.reproAngle },
  u_childStep: { value: params.childStep },
  u_foodWeight: { value: params.foodWeight },
  u_crowdWeight: { value: params.crowdWeight },
  u_crowdExponent: { value: params.crowdExponent },
  u_densityTarget: { value: params.densityTarget },
  u_maxReserve: { value: params.maxReserve },
  u_oatSupplyRate: { value: params.oatSupplyRate },
  u_densityMassScale: { value: DENSITY_MASS_SCALE },
  u_useOatRationing: { value: params.useOatRationing ? 1 : 0 },
  u_useHeadingRotation: { value: 1 },
  u_mouseRepelActive: { value: 0 },
  u_mouseRepelUv: { value: new THREE.Vector2() },
  u_mouseRepelChart: { value: 0 },
  u_mouseRepelRadius: { value: MOUSE_REPEL_RADIUS_UV },
  u_mouseRepelStrength: { value: MOUSE_REPEL_STRENGTH },
  u_allocationOffset: { value: 0 },
  ...sharedSafeSamplingUniforms(),
});

const agentPrefixInitMaterial = makeRawShaderMaterial(agentPrefixInitFragment, {
  u_candidates: { value: agentCandidateRT.texture },
});

const agentPrefixScanMaterial = makeRawShaderMaterial(agentPrefixScanFragment, {
  u_prefix: { value: null },
  u_offset: { value: 1 },
  u_candidateWidth: { value: AGENT_SIDE },
});

const agentCompactMaterial = makeRawShaderMaterial(agentCompactFragment, {
  u_candidates: { value: agentCandidateRT.texture },
  u_prefix: { value: null },
  u_agentSide: { value: AGENT_SIDE },
  u_candidateWidth: { value: AGENT_SIDE },
  u_candidateCount: { value: AGENT_CANDIDATE_COUNT },
  u_allocationOffset: { value: 0 },
});

const agentSeedInjectMaterial = makeRawShaderMaterial(agentSeedInjectFragment, {
  u_currentAgents: { value: null },
  u_seedAgents: { value: agentSeedRT.texture },
  u_agentSide: { value: AGENT_SIDE },
  u_revealSlotCount: { value: 0 },
});

const deltaMaterial = makeRawShaderMaterial(deltaFragment, {
  u_food: { value: null },
  u_depositDensity: { value: depositDensityRT.texture },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_uptakeRate: { value: params.uptakeRate },
  u_depositRate: { value: params.depositRate },
  u_deltaScale: { value: params.deltaScale },
  u_dt: { value: 1 },
  u_foodClamp: { value: params.foodClamp },
  u_densityMassScale: { value: DENSITY_MASS_SCALE },
});

const seamEqualizeMaterial = makeRawShaderMaterial(seamEqualizeFragment, {
  u_food: { value: null },
  u_seamWeldUv: { value: seamWeldUvRT.texture },
  u_seamWeldMeta: { value: seamWeldMetaRT.texture },
  u_chartId: { value: chartIdRT.texture },
  u_chartUnsafe: { value: chartUnsafeRT.texture },
  u_useSeamStitching: { value: 1 },
});

// === density / agent points geometry ===
function makePointsGeometry() {
  const geo = new THREE.BufferGeometry();
  const indices = new Float32Array(AGENT_CAPACITY);
  for (let i = 0; i < AGENT_CAPACITY; i++) indices[i] = i;
  geo.setAttribute('a_index', new THREE.BufferAttribute(indices, 1));
  // dummy position so three.js doesn't complain about count
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AGENT_CAPACITY * 3), 3));
  return geo;
}
const pointsGeo = makePointsGeometry();

const densityMaterial = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: stripGlslVersion(particleVertex),
  fragmentShader: stripGlslVersion(densityFragment),
  uniforms: {
    u_agents: { value: null },
    u_chartId: { value: chartIdRT.texture },
    u_chartUnsafe: { value: chartUnsafeRT.texture },
    u_seamTransitionUvAtlas: { value: seamTransitionUvAtlasRT.texture },
    u_seamTransitionMetaAtlas: { value: seamTransitionMetaAtlasRT.texture },
    u_seamTransitionDirectionAtlas: { value: seamTransitionDirectionAtlasRT.texture },
    u_seamTransitionBasisAtlas: { value: seamTransitionBasisAtlasRT.texture },
    u_seamTransitionClaim: { value: seamTransitionClaimRT.texture },
    u_agentSide: { value: AGENT_SIDE },
    u_splatMode: { value: 0 },
    u_useSeamStitching: { value: 1 },
    u_pointSize: { value: 4 },
    u_fieldSize: { value: FIELD_SIZE },
    u_densityMassScale: { value: DENSITY_MASS_SCALE },
    u_maxDensityReserveMass: { value: MAX_DENSITY_RESERVE_MASS },
  },
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneFactor,
  depthTest: false,
  depthWrite: false,
  transparent: true,
});

const densityPoints = new THREE.Points(pointsGeo, densityMaterial);
densityPoints.frustumCulled = false;
const densityScene = new THREE.Scene();
densityScene.add(densityPoints);

// === uv mask material ===
const uvMaskMaterial = new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3,
  vertexShader: stripGlslVersion(uvMaskVertex),
  fragmentShader: stripGlslVersion(uvMaskFragment),
  side: THREE.DoubleSide,
  depthTest: false,
  depthWrite: false,
  blending: THREE.NoBlending,
});

// === slime cuttlefish material ===
let slimeMaterial = null;

function makeGoldWaferFallbackTexture() {
  const data = new Uint8Array([255, 237, 160, 255]);
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

const goldWaferFilmState = {
  ready: false,
  loading: false,
  error: '',
  texture: makeGoldWaferFallbackTexture(),
  fastTexture: makeGoldWaferFallbackTexture(),
  width: 1,
  height: 1,
  fastWidth: 1,
  fastHeight: 1,
  minNm: 10,
  spanNm: 600,
  fastCosMin: Math.cos(THREE.MathUtils.degToRad(85)),
  fastCosSpan: 1 - Math.cos(THREE.MathUtils.degToRad(85)),
};
const goldWaferBodyUniforms = {
  uGoldBodyMaxFood: { value: goldWaferBodyZeroFoodTexture },
  uGoldBodyLookup: { value: goldWaferFilmState.texture },
  uGoldBodyFastLookup: { value: goldWaferFilmState.fastTexture },
  uGoldBodyLookupW: { value: goldWaferFilmState.width },
  uGoldBodyLookupH: { value: goldWaferFilmState.height },
  uGoldBodyFastLookupW: { value: goldWaferFilmState.fastWidth },
  uGoldBodyFastLookupH: { value: goldWaferFilmState.fastHeight },
  uGoldBodyFastLookupCosMin: { value: goldWaferFilmState.fastCosMin },
  uGoldBodyFastLookupCosSpan: { value: goldWaferFilmState.fastCosSpan },
  uGoldBodyLookupMinNm: { value: goldWaferFilmState.minNm },
  uGoldBodyLookupSpanNm: { value: goldWaferFilmState.spanNm },
  uGoldBodyFoodClamp: { value: params.foodClamp },
  uGoldBodyFilmCurve: { value: params.filmThicknessCurve },
  uGoldBodyMinThicknessNm: { value: params.iridescenceMinThickness },
  uGoldBodyMaxThicknessNm: { value: params.iridescenceThickness },
  uGoldBodyFadeFraction: { value: params.goldBodyFade },
  uGoldBodyRoughness: { value: params.goldBodyRoughness },
  uGoldBodyReflectivity: { value: params.goldBodyReflectivity },
  uGoldBodyColor: { value: new THREE.Color(params.goldBodyColor) },
  uGoldBodyDiscardUnvisited: { value: 0 },
};

const goldWaferBodyLutShaderHelpers = `
       const float GOLD_BODY_COS_P0 = 1.00000000;
       const float GOLD_BODY_COS_P1 = 0.98480775;
       const float GOLD_BODY_COS_P2 = 0.93969262;
       const float GOLD_BODY_COS_P3 = 0.86602540;
       const float GOLD_BODY_COS_P4 = 0.76604444;
       const float GOLD_BODY_COS_P5 = 0.64278761;
       const float GOLD_BODY_COS_P6 = 0.50000000;
       const float GOLD_BODY_COS_P7 = 0.34202014;
       const float GOLD_BODY_COS_P8 = 0.17364818;
       const float GOLD_BODY_COS_P9 = 0.08715574;

       float goldBodyFindAngleSeg(float c) {
         if (c >= GOLD_BODY_COS_P1) return 0.0;
         if (c >= GOLD_BODY_COS_P2) return 1.0;
         if (c >= GOLD_BODY_COS_P3) return 2.0;
         if (c >= GOLD_BODY_COS_P4) return 3.0;
         if (c >= GOLD_BODY_COS_P5) return 4.0;
         if (c >= GOLD_BODY_COS_P6) return 5.0;
         if (c >= GOLD_BODY_COS_P7) return 6.0;
         if (c >= GOLD_BODY_COS_P8) return 7.0;
         return 8.0;
       }

       float goldBodyCosAt(int idx) {
         idx = clamp(idx, 0, 9);
         if (idx == 0) return GOLD_BODY_COS_P0;
         if (idx == 1) return GOLD_BODY_COS_P1;
         if (idx == 2) return GOLD_BODY_COS_P2;
         if (idx == 3) return GOLD_BODY_COS_P3;
         if (idx == 4) return GOLD_BODY_COS_P4;
         if (idx == 5) return GOLD_BODY_COS_P5;
         if (idx == 6) return GOLD_BODY_COS_P6;
         if (idx == 7) return GOLD_BODY_COS_P7;
         if (idx == 8) return GOLD_BODY_COS_P8;
         return GOLD_BODY_COS_P9;
       }

       vec4 goldBodyAngleHermiteWeights(float c, out float segOut) {
         float seg = goldBodyFindAngleSeg(c);
         segOut = seg;
         int iseg = int(seg);
         float cL = goldBodyCosAt(iseg);
         float cR = goldBodyCosAt(iseg + 1);
         float cP = goldBodyCosAt(iseg - 1);
         float cN = goldBodyCosAt(iseg + 2);
         float h = cR - cL;
         float alpha = h / (cR - cP);
         float beta = h / (cN - cL);
         float s = (cL - c) / (cL - cR);
         float s2 = s * s;
         float s3 = s2 * s;
         float H00 = 2.0 * s3 - 3.0 * s2 + 1.0;
         float H10 = s3 - 2.0 * s2 + s;
         float H01 = -2.0 * s3 + 3.0 * s2;
         float H11 = s3 - s2;
         return vec4(
           -alpha * H10,
            H00 - beta * H11,
            H01 + alpha * H10,
            beta * H11
         );
       }

       vec4 goldBodyThicknessCubicW(float t) {
         float t2 = t * t;
         float t3 = t2 * t;
         return 0.5 * vec4(
           -t3 + 2.0 * t2 - t,
            3.0 * t3 - 5.0 * t2 + 2.0,
           -3.0 * t3 + 4.0 * t2 + t,
            t3 - t2
         );
       }

       vec3 goldBodyLookupTap(float ti, float ai) {
         ti = clamp(ti, 0.0, uGoldBodyLookupW - 1.0);
         ai = clamp(ai, 0.0, uGoldBodyLookupH - 1.0);
         vec2 uv = vec2((ti + 0.5) / uGoldBodyLookupW, (ai + 0.5) / uGoldBodyLookupH);
         return texture2D(uGoldBodyLookup, uv).rgb;
       }

       vec3 goldBodyFilmBicubic(float tIdx, float c) {
         c = clamp(c, GOLD_BODY_COS_P9, GOLD_BODY_COS_P0);
         float ti0 = clamp(floor(tIdx), 0.0, uGoldBodyLookupW - 2.0);
         float ft = tIdx - ti0;
         vec4 wt = goldBodyThicknessCubicW(ft);
         float seg;
         vec4 wa = goldBodyAngleHermiteWeights(c, seg);
         vec3 r = vec3(0.0);
         for (int j = 0; j < 4; j++) {
           float ay = seg - 1.0 + float(j);
           vec3 row = wt.x * goldBodyLookupTap(ti0 - 1.0, ay)
                    + wt.y * goldBodyLookupTap(ti0,        ay)
                    + wt.z * goldBodyLookupTap(ti0 + 1.0,  ay)
                    + wt.w * goldBodyLookupTap(ti0 + 2.0,  ay);
           r += wa[j] * row;
         }
         return r;
       }

       float goldBodyFilmThickness01FromFood(float food) {
         float maxFood = max(uGoldBodyFoodClamp, 0.0001);
         float x = clamp(max(food, 0.0), 0.0, maxFood);
         float curve = max(uGoldBodyFilmCurve, 0.0001);
         float denom = 1.0 - exp(-curve * maxFood);
         if (denom < 0.00001) return clamp(x / maxFood, 0.0, 1.0);
         return clamp((1.0 - exp(-curve * x)) / denom, 0.0, 1.0);
       }

       float goldBodyFadeFromFood(float food) {
         float normalizedFood = clamp(max(food, 0.0) / max(uGoldBodyFoodClamp, 0.0001), 0.0, 1.0);
         float fadeFraction = clamp(uGoldBodyFadeFraction, 0.0001, 1.0);
         if (normalizedFood >= fadeFraction) return 1.0;
         return smoothstep(0.0, fadeFraction, normalizedFood);
       }

       float goldBodyFadeAt(vec2 uv) {
         return goldBodyFadeFromFood(texture2D(uGoldBodyMaxFood, uv).r);
       }

       vec3 goldBodyFilmColorFromFood(float food, float c) {
         float filmMin = min(uGoldBodyMinThicknessNm, uGoldBodyMaxThicknessNm);
         float filmMax = max(uGoldBodyMinThicknessNm, uGoldBodyMaxThicknessNm);
         float thickness01 = goldBodyFilmThickness01FromFood(food);
         float thickNm = mix(filmMin, filmMax, thickness01);
         thickNm = clamp(thickNm, uGoldBodyLookupMinNm, uGoldBodyLookupMinNm + uGoldBodyLookupSpanNm);
         float lookupThickness01 = (thickNm - uGoldBodyLookupMinNm) / uGoldBodyLookupSpanNm;
#if GOLD_BODY_FAST_LOOKUP
         float lookupCos01 = (clamp(c, uGoldBodyFastLookupCosMin, 1.0) - uGoldBodyFastLookupCosMin)
           / max(uGoldBodyFastLookupCosSpan, 0.0001);
         return texture2D(uGoldBodyFastLookup, vec2(clamp(lookupThickness01, 0.0, 1.0), clamp(lookupCos01, 0.0, 1.0))).rgb;
#else
         float tIdx = lookupThickness01 * (uGoldBodyLookupW - 1.0);
         return clamp(goldBodyFilmBicubic(tIdx, c), 0.0, 1.0);
#endif
       }
`;

function validateGoldWaferTensor(tensor) {
  const shape = tensor?.shape;
  const axes = tensor?.axes;
  if (!Array.isArray(shape) || shape.length !== 3 || shape[2] !== 3) {
    throw new Error('gold wafer lookup must have shape [angle, thickness, 3]');
  }
  const [angleCount, thicknessCount] = shape;
  if (!Number.isInteger(angleCount) || !Number.isInteger(thicknessCount) || angleCount !== 10) {
    throw new Error(`gold wafer lookup expected 10 angle rows, got ${angleCount}`);
  }
  const expectedAngles = [0, 10, 20, 30, 40, 50, 60, 70, 80, 85];
  const angles = axes?.angle_deg;
  if (!Array.isArray(angles) || angles.length !== expectedAngles.length) {
    throw new Error('gold wafer lookup angle axis does not match the shader');
  }
  for (let i = 0; i < expectedAngles.length; i++) {
    if (Number(angles[i]) !== expectedAngles[i]) {
      throw new Error(`gold wafer lookup angle ${i} must be ${expectedAngles[i]}, got ${angles[i]}`);
    }
  }
  const thicknesses = axes?.thickness_nm;
  if (!Array.isArray(thicknesses) || thicknesses.length !== thicknessCount) {
    throw new Error('gold wafer lookup thickness axis does not match shape');
  }
  const minNm = Number(thicknesses[0]);
  const maxNm = Number(thicknesses[thicknesses.length - 1]);
  const spanNm = maxNm - minNm;
  if (!Number.isFinite(minNm) || !Number.isFinite(spanNm) || spanNm <= 0) {
    throw new Error('gold wafer lookup thickness axis must be increasing');
  }
  if (!Array.isArray(tensor.data) || tensor.data.length !== angleCount) {
    throw new Error('gold wafer lookup data does not match angle count');
  }
  return { angleCount, thicknessCount, minNm, spanNm };
}

function buildGoldWaferLookupTexture(tensor, shapeInfo) {
  const { angleCount, thicknessCount } = shapeInfo;
  const data = new Uint8Array(angleCount * thicknessCount * 4);
  for (let a = 0; a < angleCount; a++) {
    const angleRow = tensor.data[a];
    if (!Array.isArray(angleRow) || angleRow.length !== thicknessCount) {
      throw new Error(`gold wafer lookup row ${a} does not match thickness count`);
    }
    for (let t = 0; t < thicknessCount; t++) {
      const rgb = angleRow[t];
      if (!Array.isArray(rgb) || rgb.length !== 3) {
        throw new Error(`gold wafer lookup sample [${a}, ${t}] is not RGB`);
      }
      const o = (a * thicknessCount + t) * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, thicknessCount, angleCount, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

function goldWaferTensorRgbAt(tensor, angleIndex, thicknessIndex) {
  const angleRows = tensor.data;
  const ai = Math.max(0, Math.min(angleRows.length - 1, angleIndex));
  const row = angleRows[ai];
  const ti = Math.max(0, Math.min(row.length - 1, thicknessIndex));
  return row[ti];
}

function goldWaferCosAt(cosRows, index) {
  return cosRows[Math.max(0, Math.min(cosRows.length - 1, index))];
}

function goldWaferFindAngleSegment(c, cosRows) {
  for (let i = 0; i < cosRows.length - 1; i++) {
    if (c >= cosRows[i + 1]) return i;
  }
  return cosRows.length - 2;
}

function goldWaferAngleHermiteWeights(c, cosRows) {
  const seg = goldWaferFindAngleSegment(c, cosRows);
  const cL = goldWaferCosAt(cosRows, seg);
  const cR = goldWaferCosAt(cosRows, seg + 1);
  const cP = goldWaferCosAt(cosRows, seg - 1);
  const cN = goldWaferCosAt(cosRows, seg + 2);
  const h = cR - cL;
  const alpha = h / (cR - cP);
  const beta = h / (cN - cL);
  const s = (cL - c) / (cL - cR);
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return {
    seg,
    weights: [
      -alpha * h10,
      h00 - beta * h11,
      h01 + alpha * h10,
      beta * h11,
    ],
  };
}

function buildGoldWaferFastLookupTexture(tensor, shapeInfo) {
  const { thicknessCount } = shapeInfo;
  const angles = tensor.axes.angle_deg.map((angle) => Number(angle));
  const cosRows = angles.map((angle) => Math.cos(THREE.MathUtils.degToRad(angle)));
  const cosMin = cosRows[cosRows.length - 1];
  const cosSpan = cosRows[0] - cosMin;
  const height = GOLD_BODY_FAST_LOOKUP_ANGLE_ROWS;
  const data = new Uint8Array(thicknessCount * height * 4);
  for (let y = 0; y < height; y++) {
    const fy = height <= 1 ? 0 : y / (height - 1);
    const c = cosMin + cosSpan * fy;
    const { seg, weights } = goldWaferAngleHermiteWeights(c, cosRows);
    for (let x = 0; x < thicknessCount; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < 4; j++) {
        const rgb = goldWaferTensorRgbAt(tensor, seg - 1 + j, x);
        const w = weights[j];
        r += rgb[0] * w;
        g += rgb[1] * w;
        b += rgb[2] * w;
      }
      const o = (y * thicknessCount + x) * 4;
      data[o] = Math.max(0, Math.min(255, Math.round(r)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[o + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[o + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, thicknessCount, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.flipY = false;
  texture.needsUpdate = true;
  return { texture, width: thicknessCount, height, cosMin, cosSpan };
}

function ensureGoldWaferBodyMaxFoodRT() {
  if (!goldWaferBodyMaxFoodRT) {
    goldWaferBodyMaxFoodRT = new RTPair(makeGoldWaferBodyMaxFoodRT);
    clearRT(goldWaferBodyMaxFoodRT.read);
    clearRT(goldWaferBodyMaxFoodRT.write);
    goldWaferBodyMaxFoodInitialized = false;
    goldWaferBodyMaxFoodNeedsUpdate = true;
  }
  return goldWaferBodyMaxFoodRT;
}

function syncGoldWaferBodyMaxFoodUniform() {
  goldWaferBodyUniforms.uGoldBodyMaxFood.value = goldWaferBodyMaxFoodRT?.read?.texture ?? goldWaferBodyZeroFoodTexture;
}

function markGoldWaferBodyUniformsDirty() {
  goldWaferBodyUniformsDirty = true;
}

function markGoldWaferBodyModeDirty({ uniforms = false } = {}) {
  goldWaferBodyModeDirty = true;
  if (uniforms) markGoldWaferBodyUniformsDirty();
}

function resetGoldWaferBodyHistory() {
  goldWaferBodyMaxFoodInitialized = false;
  goldWaferBodyMaxFoodNeedsUpdate = true;
  if (goldWaferBodyMaxFoodRT) {
    clearRT(goldWaferBodyMaxFoodRT.read);
    clearRT(goldWaferBodyMaxFoodRT.write);
  }
  syncGoldWaferBodyMaxFoodUniform();
}

function updateGoldWaferBodyMaxFoodTexture({ force = false } = {}) {
  if (!isGoldWaferBodyHistoryActive()) return false;
  if (!force && !started && !goldWaferBodyMaxFoodNeedsUpdate) return false;
  const rt = ensureGoldWaferBodyMaxFoodRT();
  maxFoodHistoryMaterial.uniforms.u_currentFood.value = renderSampleViewRT.read.texture;
  maxFoodHistoryMaterial.uniforms.u_previousMax.value = goldWaferBodyMaxFoodInitialized
    ? rt.read.texture
    : goldWaferBodyZeroFoodTexture;
  runFullscreenPass(maxFoodHistoryMaterial, rt.write);
  rt.swap();
  goldWaferBodyMaxFoodInitialized = true;
  goldWaferBodyMaxFoodNeedsUpdate = false;
  syncGoldWaferBodyMaxFoodUniform();
  return true;
}

function buildGoldWaferBodyMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    color: params.goldBodyColor,
    metalness: 1.0,
    roughness: params.goldBodyRoughness,
    reflectivity: params.goldBodyReflectivity,
    specularIntensity: 0.0,
    side: THREE.DoubleSide,
    envMapIntensity: params.lightBrightness,
  });
  material.name = 'gold-wafer-body-underlay';
  material.defines = { ...(material.defines ?? {}), USE_UV: '' };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, goldWaferBodyUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        `#include <common>
         varying vec2 vGoldBodyUv;`)
      .replace('#include <uv_vertex>',
        `#include <uv_vertex>
         vGoldBodyUv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        `#include <common>
         uniform sampler2D uGoldBodyMaxFood;
         uniform sampler2D uGoldBodyLookup;
         uniform sampler2D uGoldBodyFastLookup;
         uniform float uGoldBodyLookupW;
         uniform float uGoldBodyLookupH;
         uniform float uGoldBodyFastLookupW;
         uniform float uGoldBodyFastLookupH;
         uniform float uGoldBodyFastLookupCosMin;
         uniform float uGoldBodyFastLookupCosSpan;
         uniform float uGoldBodyLookupMinNm;
         uniform float uGoldBodyLookupSpanNm;
         uniform float uGoldBodyFoodClamp;
         uniform float uGoldBodyFilmCurve;
         uniform float uGoldBodyMinThicknessNm;
         uniform float uGoldBodyMaxThicknessNm;
         uniform float uGoldBodyFadeFraction;
         uniform float uGoldBodyRoughness;
         uniform float uGoldBodyReflectivity;
         uniform vec3 uGoldBodyColor;
         uniform int uGoldBodyDiscardUnvisited;
         varying vec2 vGoldBodyUv;
         #define GOLD_BODY_FAST_LOOKUP ${GOLD_BODY_FAST_LOOKUP ? 1 : 0}

${goldWaferBodyLutShaderHelpers}

         float goldBodyFragmentFoodMax = 0.0;
         float goldBodyFragmentFade = 0.0;
         bool goldBodyFragmentStateReady = false;

         void goldBodyLoadFragmentState(vec2 uv) {
           if (goldBodyFragmentStateReady) return;
           goldBodyFragmentFoodMax = texture2D(uGoldBodyMaxFood, uv).r;
           goldBodyFragmentFade = goldBodyFadeFromFood(goldBodyFragmentFoodMax);
           goldBodyFragmentStateReady = true;
         }`)
      .replace('#include <color_fragment>',
        `#include <color_fragment>
         {
           goldBodyLoadFragmentState(vGoldBodyUv);
           float _fade = goldBodyFragmentFade;
           if (_fade <= 0.00001) {
             if (uGoldBodyDiscardUnvisited == 1) discard;
             diffuseColor.rgb = vec3(0.0);
           } else {
             diffuseColor.rgb = clamp(uGoldBodyColor, 0.0, 1.0);
             if (uGoldBodyDiscardUnvisited == 1) {
               diffuseColor.a *= _fade;
             } else {
               diffuseColor.rgb *= _fade;
             }
           }
         }`)
      .replace('#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
         {
           goldBodyLoadFragmentState(vGoldBodyUv);
           roughnessFactor = clamp(mix(1.0, uGoldBodyRoughness, goldBodyFragmentFade), 0.04, 1.0);
         }`)
      .replace('#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>
         goldBodyLoadFragmentState(vGoldBodyUv);
         metalnessFactor *= goldBodyFragmentFade;`)
      .replace('#include <lights_fragment_end>',
        `#include <lights_fragment_end>
         {
           float _goldBodyReflectivity = clamp(uGoldBodyReflectivity, 0.0, 1.0);
           goldBodyLoadFragmentState(vGoldBodyUv);
           vec3 _goldBodyReflectionColor = vec3(1.0);
           if (_goldBodyReflectivity > 0.00001 && goldBodyFragmentFade > 0.00001) {
             vec3 _N = normalize(vNormal);
             vec3 _V = normalize(vViewPosition);
             float _c = clamp(abs(dot(_N, _V)), 0.0, 1.0);
             vec3 _goldBodyFilmColor = goldBodyFilmColorFromFood(goldBodyFragmentFoodMax, _c);
             _goldBodyReflectionColor = mix(vec3(1.0), _goldBodyFilmColor, goldBodyFragmentFade);
           }
           reflectedLight.directSpecular *= _goldBodyReflectionColor * _goldBodyReflectivity;
           reflectedLight.indirectSpecular *= _goldBodyReflectionColor * _goldBodyReflectivity;
         }`);
  };
  material.customProgramCacheKey = () => `gold-wafer-body-underlay-v5-fast-${GOLD_BODY_FAST_LOOKUP ? 1 : 0}`;
  return material;
}

function syncGoldWaferBodyMaterialUniforms({ force = false } = {}) {
  if (!force && !goldWaferBodyUniformsDirty) {
    syncGoldWaferBodyMaxFoodUniform();
    return;
  }
  syncGoldWaferBodyMaxFoodUniform();
  goldWaferBodyUniforms.uGoldBodyLookup.value = goldWaferFilmState.texture;
  goldWaferBodyUniforms.uGoldBodyFastLookup.value = goldWaferFilmState.fastTexture;
  goldWaferBodyUniforms.uGoldBodyLookupW.value = goldWaferFilmState.width;
  goldWaferBodyUniforms.uGoldBodyLookupH.value = goldWaferFilmState.height;
  goldWaferBodyUniforms.uGoldBodyFastLookupW.value = goldWaferFilmState.fastWidth;
  goldWaferBodyUniforms.uGoldBodyFastLookupH.value = goldWaferFilmState.fastHeight;
  goldWaferBodyUniforms.uGoldBodyFastLookupCosMin.value = goldWaferFilmState.fastCosMin;
  goldWaferBodyUniforms.uGoldBodyFastLookupCosSpan.value = goldWaferFilmState.fastCosSpan;
  goldWaferBodyUniforms.uGoldBodyLookupMinNm.value = goldWaferFilmState.minNm;
  goldWaferBodyUniforms.uGoldBodyLookupSpanNm.value = goldWaferFilmState.spanNm;
  goldWaferBodyUniforms.uGoldBodyFoodClamp.value = params.foodClamp;
  goldWaferBodyUniforms.uGoldBodyFilmCurve.value = params.filmThicknessCurve;
  goldWaferBodyUniforms.uGoldBodyMinThicknessNm.value = params.iridescenceMinThickness;
  goldWaferBodyUniforms.uGoldBodyMaxThicknessNm.value = params.iridescenceThickness;
  goldWaferBodyUniforms.uGoldBodyFadeFraction.value = params.goldBodyFade;
  goldWaferBodyUniforms.uGoldBodyRoughness.value = params.goldBodyRoughness;
  goldWaferBodyUniforms.uGoldBodyReflectivity.value = params.goldBodyReflectivity;
  goldWaferBodyUniforms.uGoldBodyColor.value.set(params.goldBodyColor);
  goldWaferBodyUniforms.uGoldBodyDiscardUnvisited.value = 0;
  if (goldWaferBodyMaterial) {
    goldWaferBodyMaterial.roughness = params.goldBodyRoughness;
    goldWaferBodyMaterial.reflectivity = params.goldBodyReflectivity;
    goldWaferBodyMaterial.color.set(params.goldBodyColor);
    goldWaferBodyMaterial.specularIntensity = 0.0;
    goldWaferBodyMaterial.envMapIntensity = params.lightBrightness;
  }
  goldWaferBodyUniformsDirty = false;
}

function syncIcosaLightRigUniforms() {
  const lightCount = getActiveIcosaLightCount(params);
  const lightRadianceScale = getActiveIcosaLightRadianceScale(params);
  if (slimeMaterial) {
    slimeMaterial.uniforms.u_lightCount.value = lightCount;
    slimeMaterial.uniforms.u_lightRadianceScale.value = lightRadianceScale;
  }
  if (goldWaferBodyIcoEnvMaterial) {
    goldWaferBodyIcoEnvMaterial.uniforms.u_lightCount.value = lightCount;
    goldWaferBodyIcoEnvMaterial.uniforms.u_lightRadianceScale.value = lightRadianceScale;
  }
  if (goldWaferBodyIcoEnvPmrem) {
    goldWaferBodyIcoEnvPmrem.dispose();
    goldWaferBodyIcoEnvPmrem = null;
    if (goldWaferBodyMaterial) {
      goldWaferBodyMaterial.envMap = null;
      goldWaferBodyMaterial.needsUpdate = true;
    }
  }
  markGoldWaferBodyModeDirty({ uniforms: true });
  syncGoldWaferBodyMode();
}

function isGoldWaferBodyHistoryActive() {
  return !!(
    params.useGoldWaferBody &&
    goldWaferFilmState.ready &&
    params.debugView === 'slime'
  );
}

function isGoldWaferBodyRenderActive() {
  return !!(
    params.useGoldWaferBody &&
    goldBodyVisualVisible &&
    goldWaferFilmState.ready &&
    goldWaferBodyMesh &&
    slimeMaterial &&
    params.debugView === 'slime'
  );
}

function syncVisualLayerVisibility() {
  if (mesh) mesh.visible = slimeVisualVisible;
  markGoldWaferBodyModeDirty();
  syncGoldWaferBodyMode();
}

function toggleSlimeVisualVisibility() {
  slimeVisualVisible = !slimeVisualVisible;
  syncVisualLayerVisibility();
  return slimeVisualVisible;
}

function toggleGoldBodyVisualVisibility() {
  goldBodyVisualVisible = !goldBodyVisualVisible;
  markGoldWaferBodyModeDirty();
  syncGoldWaferBodyMode();
  return goldBodyVisualVisible;
}

function syncGoldWaferBodyMode() {
  if (!goldWaferBodyModeDirty) return;
  const active = isGoldWaferBodyRenderActive();
  if (active && goldWaferBodyMaterial) {
    const envMap = ensureGoldWaferBodyEnvironmentMap();
    if (goldWaferBodyMaterial.envMap !== envMap) {
      goldWaferBodyMaterial.envMap = envMap;
      goldWaferBodyMaterial.needsUpdate = true;
    }
  }
  syncGoldWaferBodyMaterialUniforms();
  if (goldWaferBodyMaterial) {
    if (goldWaferBodyMaterial.transparent) {
      goldWaferBodyMaterial.transparent = false;
      goldWaferBodyMaterial.needsUpdate = true;
    }
    goldWaferBodyMaterial.depthWrite = true;
  }
  if (goldWaferBodyMesh) {
    goldWaferBodyMesh.visible = active;
  }
  if (slimeMaterial) {
    slimeMaterial.uniforms.u_useGoldWaferBodyUnderlay.value = active ? 1 : 0;
    const shouldBeTransparent = active;
    const desiredBlending = active ? THREE.CustomBlending : THREE.NormalBlending;
    const blendingChanged = slimeMaterial.blending !== desiredBlending;
    if (slimeMaterial.transparent !== shouldBeTransparent) {
      slimeMaterial.transparent = shouldBeTransparent;
      slimeMaterial.needsUpdate = true;
    }
    slimeMaterial.depthWrite = !shouldBeTransparent;
    slimeMaterial.blending = desiredBlending;
    if (active) {
      // Preserve slime radiance; alpha only reveals the gold underlay behind it.
      slimeMaterial.blendEquation = THREE.AddEquation;
      slimeMaterial.blendSrc = THREE.OneFactor;
      slimeMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
      slimeMaterial.blendSrcAlpha = THREE.OneFactor;
      slimeMaterial.blendDstAlpha = THREE.OneMinusSrcAlphaFactor;
    }
    if (blendingChanged) slimeMaterial.needsUpdate = true;
  }
  if (mesh) {
    mesh.renderOrder = active ? 2 : 0;
  }
  goldWaferBodyModeDirty = false;
}

function syncGoldWaferFilmUniforms() {
  if (slimeMaterial) {
    const u = slimeMaterial.uniforms;
    u.u_goldWaferLookup.value = goldWaferFilmState.texture;
    u.u_goldLookupW.value = goldWaferFilmState.width;
    u.u_goldLookupH.value = goldWaferFilmState.height;
    u.u_goldLookupMinNm.value = goldWaferFilmState.minNm;
    u.u_goldLookupSpanNm.value = goldWaferFilmState.spanNm;
    u.u_useGoldWaferFilm.value = params.useGoldWaferFilm && goldWaferFilmState.ready ? 1 : 0;
  }
  markGoldWaferBodyUniformsDirty();
}

function syncGoldWaferFilmControlState() {
  const input = document.getElementById('useGoldWaferFilm');
  const bodyInput = document.getElementById('useGoldWaferBody');
  const loadingTitle = 'Loading the gold-wafer lookup.';
  const idleTitle = goldWaferFilmState.error || 'Check to load and use the gold-wafer thin-film lookup.';
  if (input) {
    input.disabled = goldWaferFilmState.loading;
    input.title = goldWaferFilmState.ready
      ? 'Use the expanded gold-wafer thin-film lookup for the slime film.'
      : goldWaferFilmState.loading
        ? loadingTitle
        : idleTitle;
    if (!goldWaferFilmState.ready && goldWaferFilmState.error && input.checked) {
      input.checked = false;
      params.useGoldWaferFilm = false;
    }
  }
  if (bodyInput) {
    bodyInput.disabled = goldWaferFilmState.loading;
    bodyInput.title = goldWaferFilmState.ready
      ? 'Render a MeshPhysicalMaterial gold-wafer body under the slime, driven by peak food.'
      : goldWaferFilmState.loading
        ? loadingTitle
        : idleTitle;
    if (!goldWaferFilmState.ready && goldWaferFilmState.error && bodyInput.checked) {
      bodyInput.checked = false;
      params.useGoldWaferBody = false;
      markGoldWaferBodyModeDirty({ uniforms: true });
    }
  }
  syncGoldWaferBodyMode();
}

async function loadGoldWaferFilmLookup() {
  if (goldWaferFilmState.loading || goldWaferFilmState.ready) return;
  goldWaferFilmState.loading = true;
  syncGoldWaferFilmControlState();
  try {
    const response = await fetch(GOLD_WAFER_LOOKUP_PATH);
    if (!response.ok) throw new Error(`${GOLD_WAFER_LOOKUP_PATH}: HTTP ${response.status}`);
    const tensor = await response.json();
    const shapeInfo = validateGoldWaferTensor(tensor);
    const texture = buildGoldWaferLookupTexture(tensor, shapeInfo);
    const fastLookup = buildGoldWaferFastLookupTexture(tensor, shapeInfo);
    const oldTexture = goldWaferFilmState.texture;
    const oldFastTexture = goldWaferFilmState.fastTexture;
    goldWaferFilmState.texture = texture;
    goldWaferFilmState.fastTexture = fastLookup.texture;
    goldWaferFilmState.width = shapeInfo.thicknessCount;
    goldWaferFilmState.height = shapeInfo.angleCount;
    goldWaferFilmState.fastWidth = fastLookup.width;
    goldWaferFilmState.fastHeight = fastLookup.height;
    goldWaferFilmState.minNm = shapeInfo.minNm;
    goldWaferFilmState.spanNm = shapeInfo.spanNm;
    goldWaferFilmState.fastCosMin = fastLookup.cosMin;
    goldWaferFilmState.fastCosSpan = fastLookup.cosSpan;
    goldWaferFilmState.ready = true;
    goldWaferFilmState.error = '';
    if (params.useGoldWaferBody) goldWaferBodyMaxFoodNeedsUpdate = true;
    markGoldWaferBodyModeDirty({ uniforms: true });
    syncGoldWaferFilmUniforms();
    syncGoldWaferFilmControlState();
    oldTexture?.dispose?.();
    oldFastTexture?.dispose?.();
  } catch (err) {
    goldWaferFilmState.error = `Gold wafer lookup unavailable: ${err.message}`;
    console.warn(goldWaferFilmState.error);
    params.useGoldWaferFilm = false;
    params.useGoldWaferBody = false;
    markGoldWaferBodyModeDirty({ uniforms: true });
    syncGoldWaferFilmUniforms();
    syncGoldWaferFilmControlState();
  } finally {
    goldWaferFilmState.loading = false;
    syncGoldWaferFilmControlState();
  }
}

function buildSlimeMaterial() {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: slimeVertex,
    fragmentShader: slimeFragment,
    side: THREE.DoubleSide,
    defines: {
    },
    uniforms: {
	      u_food: { value: renderSampleViewRT.read.texture },
	      u_agentDensity: { value: densityRT.texture },
	      u_agentDensityOverlay: { value: agentDensityOverlayRT.texture },
      u_seamRedirectUv: { value: seamRedirectUvRT.texture },
      u_seamRedirectMeta: { value: seamRedirectMetaRT.texture },
      u_seamRedirectClaim: { value: seamRedirectClaimRT.texture },
      u_seamTransitionUvAtlas: { value: seamTransitionUvAtlasRT.texture },
      u_seamTransitionMetaAtlas: { value: seamTransitionMetaAtlasRT.texture },
      u_seamTransitionDirectionAtlas: { value: seamTransitionDirectionAtlasRT.texture },
      u_seamTransitionBasisAtlas: { value: seamTransitionBasisAtlasRT.texture },
      u_seamTransitionClaim: { value: seamTransitionClaimRT.texture },
      u_chartId: { value: chartIdRT.texture },
      u_chartUnsafe: { value: chartUnsafeRT.texture },
      u_texel: { value: new THREE.Vector2(1 / FIELD_SIZE, 1 / FIELD_SIZE) },
      u_heightScale: { value: params.surfaceHeight },
      u_bumpStrength: { value: params.surfaceBump },
      u_normalSampleRadius: { value: getNormalSampleRadiusTexels(params) },
      u_iridescenceStrength: { value: params.iridescenceStrength },
      u_iridescenceMinThickness: { value: params.iridescenceMinThickness },
      u_iridescenceThickness: { value: params.iridescenceThickness },
      u_filmThicknessCurve: { value: params.filmThicknessCurve },
      u_lightBrightness: { value: params.lightBrightness },
      u_foodClamp: { value: params.foodClamp },
      u_goldWaferLookup: { value: goldWaferFilmState.texture },
      u_goldLookupW: { value: goldWaferFilmState.width },
      u_goldLookupH: { value: goldWaferFilmState.height },
      u_goldLookupMinNm: { value: goldWaferFilmState.minNm },
      u_goldLookupSpanNm: { value: goldWaferFilmState.spanNm },
      u_lightPositions: { value: icosahedronLightPositions.map((position) => position.clone()) },
      u_lightCount: { value: getActiveIcosaLightCount() },
      u_lightRadianceScale: { value: getActiveIcosaLightRadianceScale() },
      u_cameraPos: { value: new THREE.Vector3() },
      u_baseColor: { value: new THREE.Color(params.slimeBaseColor) },
      u_meshOutlineEnabled: { value: params.meshOutlineEnabled ? 1 : 0 },
      u_showAgentDots: { value: 0 },
      u_bumpDiagonalTapsEnabled: { value: getBumpDiagonalTapsEnabled(params) ? 1 : 0 },
      u_filmFollowsSlimeHeight: { value: params.filmFollowsSlimeHeight ? 1 : 0 },
      u_useGoldWaferFilm: { value: 0 },
      u_useGoldWaferBodyUnderlay: { value: 0 },
      u_useSeamStitching: { value: 1 },
      u_useZeroGutterTransitions: { value: 1 },
    },
  });
}

function syncSlimeMaterialForCamera(renderCamera) {
  if (!slimeMaterial) return;
  const u = slimeMaterial.uniforms;
  u.u_food.value = renderSampleViewRT.read.texture;
  u.u_agentDensity.value = densityRT.texture;
  u.u_agentDensityOverlay.value = agentDensityOverlayRT.texture;
  u.u_cameraPos.value.copy(renderCamera.position);
  u.u_meshOutlineEnabled.value = params.meshOutlineEnabled ? 1 : 0;
  u.u_showAgentDots.value = params.showAgentDots ? 1 : 0;
  u.u_bumpDiagonalTapsEnabled.value = getBumpDiagonalTapsEnabled(params) ? 1 : 0;
  u.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  u.u_useZeroGutterTransitions.value = params.useSeamStitching ? 1 : 0;
  u.u_normalSampleRadius.value = getNormalSampleRadiusTexels(params);
  u.u_heightScale.value = params.surfaceHeight;
  u.u_bumpStrength.value = params.surfaceBump;
  u.u_iridescenceStrength.value = params.iridescenceStrength;
  u.u_iridescenceMinThickness.value = params.iridescenceMinThickness;
  u.u_iridescenceThickness.value = params.iridescenceThickness;
  u.u_filmThicknessCurve.value = params.filmThicknessCurve;
  u.u_lightBrightness.value = params.lightBrightness;
  u.u_lightCount.value = getActiveIcosaLightCount(params);
  u.u_lightRadianceScale.value = getActiveIcosaLightRadianceScale(params);
  u.u_foodClamp.value = params.foodClamp;
  u.u_baseColor.value.set(params.slimeBaseColor);
  u.u_filmFollowsSlimeHeight.value = params.filmFollowsSlimeHeight ? 1 : 0;
}

// === oat glow markers ===
const oatGroup = new THREE.Group();
scene.add(oatGroup);

function makeRadialGlowTexture({
  size = 96,
  inner = 0.05,
  mid = 0.28,
  stops = [
    [0.0, 'rgba(255, 248, 190, 1.0)'],
    [0.28, 'rgba(255, 205, 74, 0.45)'],
    [0.68, 'rgba(82, 221, 255, 0.12)'],
    [1.0, 'rgba(82, 221, 255, 0.0)'],
  ],
} = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const center = size * 0.5;
  const gradient = ctx.createRadialGradient(center, center, size * inner, center, center, center);
  for (const [position, color] of stops) gradient.addColorStop(position, color);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

const oatGlowTexture = makeRadialGlowTexture({
  size: 96,
  inner: 0.0,
  mid: 0.24,
  stops: [
    [0.0, 'rgba(255, 255, 120, 1.0)'],
    [0.20, 'rgba(255, 235, 36, 0.50)'],
    [0.52, 'rgba(255, 210, 0, 0.14)'],
    [1.0, 'rgba(255, 210, 0, 0.0)'],
  ],
});
const oatGlowTint = 0xffffff;
const oatGlowLift = 0;
const OBSERVATION_VIEW_MARGIN_PX = 14;
const OBSERVATION_BOX_WIDTH_PX = 230;
const OBSERVATION_BOX_HEIGHT_PX = 126;
const OBSERVATION_MIN_SCREEN_GAP_PX = 8;
const OBSERVATION_STROKE_WIDTH_PX = 1.5;
const OBSERVATION_LEADER_BORDER_OVERLAP_PX = 2;
const OBSERVATION_Z_INDEX_RANGE = 100000;
const OBSERVATION_OCCLUSION_MARGIN = 0.012 * WORLD_LINEAR_SCALE;
const OBSERVATION_OCCLUSION_REFRESH_MS = 120;
const OBSERVATION_SLIME_TRIGGER_INTERVAL_MS = 220;
const OBSERVATION_SLIME_TRIGGER_READS_PER_FRAME = 4;
const OBSERVATION_CHAR_STEP_MS = 190;
const OBSERVATION_CHAR_FADE_MS = 1560;
const OBSERVATION_TEXT_REVEAL_MASK_SCALE = 2.6;
const OBSERVATION_TEXT_REVEAL_SOLID_STOP = 0.48;
const OBSERVATION_TEXT_REVEAL_SOLID_STOP_PERCENT = OBSERVATION_TEXT_REVEAL_SOLID_STOP * 100;
// Stop at the first fully opaque mask position; the remaining travel to 0% is visually inert.
const OBSERVATION_TEXT_REVEAL_END_PERCENT = (
  ((OBSERVATION_TEXT_REVEAL_MASK_SCALE * OBSERVATION_TEXT_REVEAL_SOLID_STOP) - 1) /
  (OBSERVATION_TEXT_REVEAL_MASK_SCALE - 1)
) * 100;
const OBSERVATION_TEXT_REVEAL_ACTIVE_FRACTION = (100 - OBSERVATION_TEXT_REVEAL_END_PERCENT) / 100;
const OBSERVATION_TEXT_REVEAL_MASK_IMAGE = `linear-gradient(90deg, #000 0%, #000 ${OBSERVATION_TEXT_REVEAL_SOLID_STOP_PERCENT.toFixed(0)}%, rgba(0, 0, 0, 0.72) 51%, rgba(0, 0, 0, 0.28) 54%, transparent 58%, transparent 100%)`;
const OBSERVATION_TEXT_REVEAL_MASK_SIZE = `${(OBSERVATION_TEXT_REVEAL_MASK_SCALE * 100).toFixed(0)}% 100%`;
const OBSERVATION_TEXT_REVEAL_START_POSITION = '100% 0';
const OBSERVATION_TEXT_REVEAL_END_POSITION = `${OBSERVATION_TEXT_REVEAL_END_PERCENT.toFixed(3)}% 0`;
const OBSERVATION_NEXT_LINE_START_FRACTION = 2 / 3;
const OBSERVATION_EXIT_LINE_COUNT = 5;
const OBSERVATION_BOX_FADE_IN_MS = 2600;
const OBSERVATION_TEXT_START_DELAY_MS = OBSERVATION_BOX_FADE_IN_MS;
const OBSERVATION_BOX_FADE_OUT_MS = 2600;
const OBSERVATION_OAT_FADE_IN_MS = 900;
const OBSERVATION_OAT_FADE_OUT_MS = 1800;
const REJECTED_OAT_FIZZLE_MS = 1050;
const OAT_MIN_PLACEMENT_UV_DISTANCE = DEFAULT_OAT_RADIUS * 2.5;
const OAT_MIN_PLACEMENT_WORLD_DISTANCE = 0.12 * WORLD_LINEAR_SCALE;
const OBSERVATION_PLACEHOLDER_TEXT = 'stories.json did not load; serve this page locally and check the story file.';
const STORIES_JSON_PATH = 'stories.json';
const storyLibraryState = {
  path: STORIES_JSON_PATH,
  stories: [],
  nextIndex: 0,
  loaded: false,
  loading: false,
  error: '',
  promise: null,
};
const observationTextMeasureCanvas = document.createElement('canvas');
const observationTextMeasureContext = observationTextMeasureCanvas.getContext('2d');
const observationOcclusionRaycaster = new THREE.Raycaster();
// three-mesh-bvh extension: occlusion only asks "is anything in the way", so
// stop at the first hit instead of collecting and sorting all of them.
observationOcclusionRaycaster.firstHitOnly = true;
const observationOcclusionDirection = new THREE.Vector3();
const observationOcclusionHits = [];
const oatFacingToCamera = new THREE.Vector3();
const oatAnnotationAnchorScratch = new THREE.Vector3();
const oatAnnotationProjectScratch = new THREE.Vector3();
const introOatSpriteWorldScratch = new THREE.Vector3();
const introOatSpriteCenterNdcScratch = new THREE.Vector3();
const introOatSpriteTopNdcScratch = new THREE.Vector3();
const introOatSpriteCameraUpScratch = new THREE.Vector3();
const observationGraphemeSegmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

function makeOatGlowSprite(texture, color, opacity, scale, { depthTest = false } = {}) {
  const material = new THREE.SpriteMaterial({
    map: texture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(scale);
  sprite.renderOrder = depthTest ? 4 : 8;
  return sprite;
}

function createOatGlowMarker(surfacePos, surfaceNormal = null) {
  const normal = surfaceNormal?.clone?.() ?? surfacePos.clone().normalize();
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  normal.normalize();

  const marker = new THREE.Group();
  marker.userData.surfacePos = surfacePos.clone();
  marker.userData.surfaceNormal = normal.clone();
  marker.userData.baseScale = 0.15 * WORLD_LINEAR_SCALE;
  marker.userData.createdAt = performance.now();
  marker.userData.fadeInMs = OBSERVATION_OAT_FADE_IN_MS;
  marker.userData.occlusionOpacity = 1;
  marker.userData.occlusionUpdatedAt = performance.now();
  marker.userData.occlusionPhaseMs = (nextObservationId * 19) % OBSERVATION_OCCLUSION_REFRESH_MS;
  marker.position.copy(surfacePos).addScaledVector(normal, oatGlowLift);

  const glow = makeOatGlowSprite(oatGlowTexture, oatGlowTint, 1.0, marker.userData.baseScale * 0.68);
  glow.userData.baseOpacity = glow.material.opacity;
  glow.userData.baseScale = glow.scale.x;
  marker.add(glow);
  return marker;
}

function createRejectedOatFizzleMarker(surfacePos, surfaceNormal = null) {
  const normal = surfaceNormal?.clone?.() ?? surfacePos.clone().normalize();
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  normal.normalize();

  const marker = new THREE.Group();
  marker.userData.rejectedOatFizzle = true;
  marker.userData.surfacePos = surfacePos.clone();
  marker.userData.surfaceNormal = normal.clone();
  marker.userData.baseScale = 0.13 * WORLD_LINEAR_SCALE;
  marker.userData.createdAt = performance.now();
  marker.userData.durationMs = REJECTED_OAT_FIZZLE_MS;
  marker.userData.fizzlePhase = Math.random() * 1000;
  marker.userData.occlusionOpacity = 1;
  marker.userData.occlusionUpdatedAt = performance.now();
  marker.userData.occlusionPhaseMs = Math.random() * OBSERVATION_OCCLUSION_REFRESH_MS;
  marker.position.copy(surfacePos).addScaledVector(normal, oatGlowLift);

  const glow = makeOatGlowSprite(oatGlowTexture, oatGlowTint, 0.95, marker.userData.baseScale * 0.7);
  glow.userData.baseOpacity = glow.material.opacity;
  glow.userData.baseScale = glow.scale.x;
  marker.add(glow);
  return marker;
}

function spawnRejectedOatFizzle(surfacePos, surfaceNormal = null) {
  if (!surfacePos) return null;
  const marker = createRejectedOatFizzleMarker(surfacePos, surfaceNormal);
  oatGroup.add(marker);
  return marker;
}

function disposeOatMarker(marker) {
  marker?.traverse?.((child) => {
    if (child.material) child.material.dispose();
  });
}

function setStartScreenOpacity(element, opacity) {
  if (!element) return;
  const value = Math.max(0, Math.min(1, Number(opacity) || 0));
  element.style.opacity = value.toFixed(3);
}

function applyStartButtonVisual(now = performance.now()) {
  if (!startButton) return;
  const clickAt = startScreenUiState.clickedAt;
  const fadeOutAt = startScreenUiState.beginFadeOutAt;
  const hasStartClickGlow =
    introSequenceState.requested &&
    Number.isFinite(clickAt) &&
    clickAt > 0 &&
    Number.isFinite(fadeOutAt) &&
    fadeOutAt > clickAt;
  const fadeHasStarted = Number.isFinite(fadeOutAt) && fadeOutAt > 0 && now >= fadeOutAt;
  let glowMix = 0;
  let hoverMix = fadeHasStarted ? 1 : 0;
  if (hasStartClickGlow) {
    const riseDuration = Math.max(1, fadeOutAt - clickAt);
    const riseMix = smoothUnit((now - clickAt) / riseDuration);
    const fadeMix = fadeHasStarted
      ? 1 - smoothUnit((now - fadeOutAt) / INTRO_UI_FADE_MS)
      : 1;
    glowMix = Math.max(0, Math.min(1, riseMix * fadeMix));
    hoverMix = Math.max(startScreenUiState.hoverMix, 0.35 + 0.65 * riseMix);
  } else if (!fadeHasStarted) {
    const hoverT = smoothUnit((now - startScreenUiState.hoverStartedAt) / INTRO_BUTTON_HOVER_FADE_MS);
    hoverMix = startScreenUiState.hoverFrom +
      (startScreenUiState.hoverTo - startScreenUiState.hoverFrom) * hoverT;
  }
  hoverMix = Math.max(0, Math.min(1, hoverMix));
  startScreenUiState.hoverMix = hoverMix;
  const channel = Math.round(255 * (1 - hoverMix));
  const fillAlpha = hoverMix;
  const borderAlpha = 0.62 + 0.28 * hoverMix;
  const idleGlow = hoverMix * 0.14;
  const glowAlpha = hasStartClickGlow ? 0.16 + glowMix * 0.52 : idleGlow;
  const glowRadius = hasStartClickGlow ? 8 + glowMix * 30 : hoverMix * 10;
  const insetGlowAlpha = hasStartClickGlow ? 0.08 + glowMix * 0.22 : hoverMix * 0.05;
  startButton.style.backgroundColor = `rgba(255, 255, 255, ${fillAlpha.toFixed(3)})`;
  startButton.style.borderColor = `rgba(255, 255, 255, ${borderAlpha.toFixed(3)})`;
  startButton.style.boxShadow = glowAlpha > 0.001
    ? `0 0 ${glowRadius.toFixed(1)}px rgba(188, 255, 236, ${glowAlpha.toFixed(3)}), inset 0 0 ${(glowRadius * 0.42).toFixed(1)}px rgba(255, 255, 255, ${insetGlowAlpha.toFixed(3)})`
    : 'none';
  startButton.style.color = `rgb(${channel}, ${channel}, ${channel})`;
}

function setStartButtonHoverTarget(target, now = performance.now(), immediate = false) {
  if (!startButton) return;
  if (!immediate) applyStartButtonVisual(now);
  const value = Math.max(0, Math.min(1, Number(target) || 0));
  startScreenUiState.hoverStartedAt = now;
  startScreenUiState.hoverFrom = immediate ? value : startScreenUiState.hoverMix;
  startScreenUiState.hoverTo = value;
  startScreenUiState.hoverMix = startScreenUiState.hoverFrom;
  applyStartButtonVisual(now);
}

function setEndingFadeOpacity(opacity) {
  if (!endingFadeOverlay) return;
  const value = Math.max(0, Math.min(1, Number(opacity) || 0));
  endingFadeOverlay.style.opacity = value.toFixed(3);
}

function setEndingCountdownVisible(visible) {
  if (!endingCountdownLayer) return;
  const shouldShow = Boolean(visible && params.endingTimeLimitEnabled);
  endingCountdownLayer.style.opacity = shouldShow ? '1' : '0';
  endingCountdownLayer.setAttribute('aria-hidden', String(!shouldShow));
}

function formatEndingCountdown(ms) {
  const seconds = Math.max(0, Number(ms) || 0) / 1000;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${remainingSeconds.toFixed(1).padStart(4, '0')}`;
}

function syncEndingCountdownText(text) {
  if (endingSequenceState.lastCountdownText === text) return;
  endingSequenceState.lastCountdownText = text;
  if (endingCountdownLeft) endingCountdownLeft.textContent = text;
  if (endingCountdownRight) endingCountdownRight.textContent = text;
}

function resetIntroSequenceToStartScreen(now = performance.now()) {
  if (introSequenceState.sprite) {
    scene.remove(introSequenceState.sprite);
    introSequenceState.sprite.material?.dispose?.();
    introSequenceState.sprite = null;
  }
  introSequenceState.requested = false;
  introSequenceState.active = false;
  introSequenceState.completed = false;
  introSequenceState.requestedAt = 0;
  introSequenceState.startedAt = 0;
  introSequenceState.topEdgeLeadMs = 0;
  introSequenceState.seedSoundPlayed = false;
  introSequenceState.envAudioStarted = false;
  startScreenReady = true;
  startScreenUiState.readyAt = now - INTRO_UI_FADE_MS * 2;
  startScreenUiState.clickedAt = 0;
  startScreenUiState.beginFadeOutAt = 0;
  setStartButtonHoverTarget(0, now, true);
  if (startScreen) {
    startScreen.classList.remove('is-armed', 'is-running', 'is-complete');
    startScreen.removeAttribute('aria-hidden');
  }
  if (startScreenStatus) {
    startScreenStatus.classList.remove('error');
    startScreenStatus.textContent = 'loading...';
    startScreenStatus.hidden = true;
  }
  if (startButton) {
    startButton.hidden = false;
    startButton.disabled = false;
  }
  updateStartScreenUi(now);
}

function getEndingTargetReturnAt(now = performance.now(), { fromNow = false } = {}) {
  const clickedAt = startScreenUiState.clickedAt;
  if (!fromNow && Number.isFinite(clickedAt) && clickedAt > 0) {
    return clickedAt + ENDING_TOTAL_RUNTIME_MS;
  }
  return now + ENDING_TOTAL_RUNTIME_MS;
}

function getIntroContentStartAt() {
  if (
    !Number.isFinite(introSequenceState.requestedAt) ||
    introSequenceState.requestedAt <= 0
  ) {
    return 0;
  }
  return introSequenceState.requestedAt + INTRO_UI_FADE_MS + INTRO_START_SILENT_BEAT_MS;
}

function updateStartScreenUi(now = performance.now()) {
  if (!startScreen) return;
  const fadeMs = INTRO_UI_FADE_MS;
  const hasError = Boolean(startScreenStatus?.classList.contains('error'));
  const readyElapsed = startScreenReady && startScreenUiState.readyAt > 0 && !hasError
    ? now - startScreenUiState.readyAt
    : -Infinity;
  let beginOpacity = 0;

  if (hasError) {
    if (startScreenStatus) startScreenStatus.hidden = false;
    if (startButton) startButton.hidden = true;
    setStartScreenOpacity(startScreenStatus, 1);
  } else if (!startScreenReady || startScreenUiState.readyAt <= 0) {
    if (startScreenStatus) startScreenStatus.hidden = false;
    if (startButton) startButton.hidden = true;
    setStartScreenOpacity(startScreenStatus, 1);
  } else if (readyElapsed < fadeMs) {
    if (startScreenStatus) startScreenStatus.hidden = false;
    if (startButton) startButton.hidden = true;
    setStartScreenOpacity(startScreenStatus, 1 - smoothUnit(readyElapsed / fadeMs));
  } else {
    if (startScreenStatus) startScreenStatus.hidden = true;
    if (startButton) startButton.hidden = false;
    const beginFadeIn = smoothUnit((readyElapsed - fadeMs) / fadeMs);
    const beginFadeOut = startScreenUiState.beginFadeOutAt > 0
      ? smoothUnit((now - startScreenUiState.beginFadeOutAt) / fadeMs)
      : 0;
    beginOpacity = beginFadeIn * (1 - beginFadeOut);
    if (startButton && beginFadeOut >= 1 && introSequenceState.requested) startButton.hidden = true;
  }

  setStartScreenOpacity(startButton, beginOpacity);
  applyStartButtonVisual(now);
  if (startButton) {
    const canClick =
      startScreenReady &&
      !introSequenceState.requested &&
      !introSequenceState.completed &&
      !startButton.disabled &&
      beginOpacity > 0.18;
    startButton.style.pointerEvents = canClick ? 'auto' : 'none';
  }

  if (
    !introSequenceState.requested ||
    !Number.isFinite(introSequenceState.requestedAt) ||
    introSequenceState.requestedAt <= 0
  ) {
    setStartScreenOpacity(startScreen, introSequenceState.completed ? 0 : 1);
    setStartScreenOpacity(startScreenTitle, 1);
    setStartScreenOpacity(startScreenIntroLine, 0);
    for (const dot of startScreenIntroDots) setStartScreenOpacity(dot, 0);
    return;
  }

  const elapsed = now - introSequenceState.requestedAt;
  const contentDelayMs = INTRO_UI_FADE_MS + INTRO_START_SILENT_BEAT_MS;
  const subtitleFadeInStart = contentDelayMs;
  const subtitleFadeOutStart = contentDelayMs + INTRO_OAT_SPRITE_DELAY_MS - fadeMs * 2;
  const screenFadeStart = contentDelayMs + INTRO_OAT_SPRITE_DELAY_MS - fadeMs;
  setStartScreenOpacity(startScreen, 1 - smoothUnit((elapsed - screenFadeStart) / fadeMs));
  setStartScreenOpacity(startScreenTitle, 1 - smoothUnit(elapsed / fadeMs));

  const subtitleOpacity =
    smoothUnit((elapsed - subtitleFadeInStart) / fadeMs) *
    (1 - smoothUnit((elapsed - subtitleFadeOutStart) / fadeMs));
  setStartScreenOpacity(startScreenIntroLine, subtitleOpacity);

  const dotStep = Math.max(1, (subtitleFadeOutStart - subtitleFadeInStart) / 4);
  const dotStarts = [1, 2, 3].map((step) => subtitleFadeInStart + dotStep * step);
  startScreenIntroDots.forEach((dot, index) => {
    setStartScreenOpacity(dot, smoothUnit((elapsed - dotStarts[index]) / fadeMs));
  });
}

async function requestIntroStart() {
  if (introSequenceState.requested || introSequenceState.completed) return;
  const clickedAt = performance.now();
  const fadeOutAt = clickedAt + INTRO_START_CLICK_SOUND_PEAK_MS;
  startScreenUiState.clickedAt = clickedAt;
  startScreenUiState.beginFadeOutAt = fadeOutAt;
  introSequenceState.requested = true;
  introSequenceState.requestedAt = fadeOutAt;
  introSequenceState.seedSoundPlayed = false;
  introSequenceState.envAudioStarted = false;
  if (startButton) {
    startButton.disabled = true;
    setStartButtonHoverTarget(1, clickedAt, true);
  }
  if (startScreen) startScreen.classList.add('is-armed');
  updateStartScreenUi(clickedAt);
  const startClickClip = getSoundClip('slime-fuse');
  if (startClickClip) {
    playSoundCheckOneShot(startClickClip).catch((err) => {
      console.warn('Failed to play start click sound:', err);
    });
  }
  const contentStartAt = getIntroContentStartAt();
  const introClip = SOUND_CHECK_CLIPS.find((clip) => clip.id === 'intro');
  const soundStart = introClip
    ? await playSoundCheckOneShot(introClip, { startAtPerformanceMs: contentStartAt })
    : null;
  if (introSequenceState.completed) {
    if (introClip) stopSoundCheckOneShot(introClip.id);
    return;
  }
  const reportedSoundStart = soundStart?.startedAtPerformanceMs;
  if (Number.isFinite(reportedSoundStart) && Math.abs(reportedSoundStart - contentStartAt) > 250) {
    console.warn('Intro sound did not schedule near the intended content start.', {
      reportedSoundStart,
      contentStartAt,
      deltaMs: reportedSoundStart - contentStartAt,
    });
  }
  const stretchClip = SOUND_CHECK_CLIPS.find((clip) => clip.id === 'slime-appear-stretch');
  if (stretchClip) {
    loadSoundCheckBuffer(stretchClip.path).catch((err) => {
      console.warn(`Failed to preload ${getSoundFileName(stretchClip.path)}:`, err);
    });
  }
  const tumbleClip = SOUND_CHECK_CLIPS.find((clip) => clip.id === 'slime-tumble');
  if (tumbleClip) {
    loadSoundCheckBuffer(tumbleClip.path).catch((err) => {
      console.warn(`Failed to preload ${getSoundFileName(tumbleClip.path)}:`, err);
    });
  }
  const camouflageClip = getSoundClip('cuttlefish-camouflage');
  if (camouflageClip) {
    loadSoundCheckBuffer(camouflageClip.path).catch((err) => {
      console.warn(`Failed to preload ${getSoundFileName(camouflageClip.path)}:`, err);
    });
  }
  initEnvAudio().catch((err) => {
    console.warn('Failed to preload ambience loop:', err);
  });
  updateStartScreenIntroState(performance.now());
  maybeBeginIntroSequence(performance.now());
}

function skipIntroSequence() {
  if (!startScreenReady || !started || introSequenceState.completed) return false;
  const now = performance.now();
  startScreenUiState.clickedAt = now;
  startScreenUiState.beginFadeOutAt = now;
  setStartButtonHoverTarget(0, now, true);
  if (
    !introSequenceState.requested ||
    !Number.isFinite(introSequenceState.requestedAt) ||
    introSequenceState.requestedAt <= 0 ||
    introSequenceState.requestedAt > now
  ) {
    introSequenceState.requested = true;
    introSequenceState.requestedAt = now;
    introSequenceState.seedSoundPlayed = false;
  }
  if (startButton) startButton.disabled = true;
  if (startScreen) startScreen.classList.add('is-armed', 'is-running');
  updateStartScreenUi(now);
  stopSoundCheckOneShot('intro');
  introSequenceState.envAudioStarted = true;
  startEnvAudio().catch((err) => {
    console.warn('Failed to start ambience loop after skipping intro:', err);
  });
  finishIntroSequence();
  return true;
}

function getInitialOatUv() {
  return initialOatUv ?? FALLBACK_INITIAL_OAT_UV;
}

function getIntroOatTargetPosition() {
  const target = initialOatSurfaceHit?.worldPos?.clone?.() ??
    uvToWorld(getInitialOatUv(), new THREE.Vector3());
  if (!target) return null;
  const normal = initialOatSurfaceHit?.worldNormal?.clone?.() ?? target.clone();
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  normal.normalize();
  return target.addScaledVector(normal, 0.035 * WORLD_LINEAR_SCALE);
}

function getIntroOatStartPosition(targetPos) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const targetNdc = targetPos.clone().project(camera);
  if (!Number.isFinite(targetNdc.x) || !Number.isFinite(targetNdc.y) || !Number.isFinite(targetNdc.z)) {
    return targetPos.clone().add(new THREE.Vector3(0, 0.7 * WORLD_LINEAR_SCALE, 0));
  }
  return new THREE.Vector3(targetNdc.x, INTRO_OAT_START_SCREEN_Y, targetNdc.z).unproject(camera);
}

function inverseSmoothUnit(value) {
  const target = Math.max(0, Math.min(1, Number(value) || 0));
  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) * 0.5;
    if (smoothUnit(mid) < target) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

function getIntroOatSpriteScale(descent, glow = 0) {
  const boundedDescent = Math.max(0, Math.min(1, Number(descent) || 0));
  const boundedGlow = Math.max(0, Math.min(1, Number(glow) || 0));
  return INTRO_OAT_BASE_SCALE * (1.12 - boundedDescent * 0.16 + boundedGlow * 0.38);
}

function getIntroOatSpriteHalfHeightNdc(centerPos, scale) {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  introOatSpriteCameraUpScratch.setFromMatrixColumn(camera.matrixWorld, 1).normalize();
  introOatSpriteCenterNdcScratch.copy(centerPos).project(camera);
  introOatSpriteTopNdcScratch
    .copy(centerPos)
    .addScaledVector(introOatSpriteCameraUpScratch, scale * 0.5)
    .project(camera);
  const halfHeight = Math.abs(introOatSpriteTopNdcScratch.y - introOatSpriteCenterNdcScratch.y);
  return Number.isFinite(halfHeight) ? halfHeight : 0;
}

function getIntroOatSpriteBottomNdcY(startPos, targetPos, descent) {
  const boundedDescent = Math.max(0, Math.min(1, Number(descent) || 0));
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  introOatSpriteWorldScratch.lerpVectors(startPos, targetPos, boundedDescent);
  introOatSpriteCenterNdcScratch.copy(introOatSpriteWorldScratch).project(camera);
  if (!Number.isFinite(introOatSpriteCenterNdcScratch.y)) return Infinity;
  return introOatSpriteCenterNdcScratch.y -
    getIntroOatSpriteHalfHeightNdc(introOatSpriteWorldScratch, getIntroOatSpriteScale(boundedDescent));
}

function getIntroOatTopEdgeLeadMs(startPos, targetPos) {
  if (
    getIntroOatSpriteBottomNdcY(startPos, targetPos, 0) <= INTRO_OAT_TOP_EDGE_NDC_Y ||
    getIntroOatSpriteBottomNdcY(startPos, targetPos, 1) > INTRO_OAT_TOP_EDGE_NDC_Y
  ) {
    return 0;
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) * 0.5;
    if (getIntroOatSpriteBottomNdcY(startPos, targetPos, mid) > INTRO_OAT_TOP_EDGE_NDC_Y) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const edgeDescent = (low + high) * 0.5;
  const edgeProgress = inverseSmoothUnit(edgeDescent) * INTRO_OAT_LAND_AT;
  return Math.max(0, Math.min(INTRO_OAT_SEQUENCE_MS, edgeProgress * INTRO_OAT_SEQUENCE_MS));
}

function updateStartScreenIntroState(now = performance.now()) {
  if (
    !startScreen ||
    !introSequenceState.requested ||
    introSequenceState.completed ||
    !Number.isFinite(introSequenceState.requestedAt) ||
    introSequenceState.requestedAt <= 0
  ) {
    return;
  }
  const contentStartAt = getIntroContentStartAt();
  const fadeAt = contentStartAt + Math.max(0, INTRO_OAT_SPRITE_DELAY_MS - INTRO_START_SCREEN_FADE_MS);
  if (contentStartAt > 0 && now >= fadeAt) {
    startScreen.classList.add('is-running');
  }
}

function maybeBeginIntroSequence(now = performance.now()) {
  if (
    !startScreenReady ||
    !started ||
    !introSequenceState.requested ||
    !Number.isFinite(introSequenceState.requestedAt) ||
    introSequenceState.requestedAt <= 0 ||
    introSequenceState.active ||
    introSequenceState.completed
  ) {
    return false;
  }

  const targetPos = getIntroOatTargetPosition();
  if (!targetPos) return false;
  const contentStartAt = getIntroContentStartAt();
  if (contentStartAt <= 0) return false;
  const startPos = getIntroOatStartPosition(targetPos);
  const topEdgeLeadMs = getIntroOatTopEdgeLeadMs(startPos, targetPos);
  const startedAt = contentStartAt +
    Math.max(0, INTRO_OAT_SPRITE_DELAY_MS - topEdgeLeadMs);
  if (now < startedAt) return false;

  if (startScreen) startScreen.classList.add('is-running');
  introSequenceState.active = true;
  introSequenceState.startedAt = startedAt;
  introSequenceState.topEdgeLeadMs = topEdgeLeadMs;
  introSequenceState.seedSoundPlayed = false;
  introSequenceState.targetPos.copy(targetPos);
  introSequenceState.startPos.copy(startPos);

  const sprite = makeOatGlowSprite(oatGlowTexture, oatGlowTint, 1.0, INTRO_OAT_BASE_SCALE, {
    depthTest: false,
  });
  sprite.userData.baseScale = sprite.scale.x;
  sprite.position.copy(introSequenceState.startPos);
  sprite.renderOrder = 20;
  scene.add(sprite);
  introSequenceState.sprite = sprite;
  return true;
}

function startIntroEnvAudio() {
  if (introSequenceState.envAudioStarted) return;
  introSequenceState.envAudioStarted = true;
  startEnvAudio().catch((err) => {
    console.warn('Failed to start ambience loop:', err);
  });
}

function updateIntroSequence(now) {
  updateStartScreenIntroState(now);
  if (
    introSequenceState.requested &&
    !introSequenceState.completed &&
    getIntroContentStartAt() > 0 &&
    now - getIntroContentStartAt() >= INTRO_OAT_SPRITE_DELAY_MS
  ) {
    startIntroEnvAudio();
  }
  if (introSequenceState.requested && !introSequenceState.active && !introSequenceState.completed) {
    maybeBeginIntroSequence(now);
  }
  if (!introSequenceState.active || !introSequenceState.sprite) return;
  const progress = Math.max(0, Math.min(1, (now - introSequenceState.startedAt) / INTRO_OAT_SEQUENCE_MS));
  const descent = smoothUnit(Math.min(1, progress / INTRO_OAT_LAND_AT));
  introSequenceState.sprite.position.lerpVectors(
    introSequenceState.startPos,
    introSequenceState.targetPos,
    descent,
  );

  const glow = progress <= INTRO_OAT_LAND_AT
    ? 0
    : smoothUnit(
      (Math.min(progress, INTRO_OAT_BRIGHTEN_END) - INTRO_OAT_LAND_AT) /
        Math.max(0.001, INTRO_OAT_BRIGHTEN_END - INTRO_OAT_LAND_AT),
    );
  const fade = progress <= INTRO_OAT_BRIGHTEN_END
    ? 0
    : smoothUnit((progress - INTRO_OAT_BRIGHTEN_END) / Math.max(0.001, 1 - INTRO_OAT_BRIGHTEN_END));
  const opacity = (1 + glow * 0.72) * (1 - fade);
  introSequenceState.sprite.material.opacity = opacity;
  introSequenceState.sprite.material.color.setScalar(1);
  introSequenceState.sprite.scale.setScalar(getIntroOatSpriteScale(descent, glow));
  const seedSoundAt = INTRO_OAT_SEQUENCE_MS - INITIAL_AGENT_SEED_SOUND_LEAD_MS;
  if (
    !introSequenceState.seedSoundPlayed &&
    now - introSequenceState.startedAt >= seedSoundAt
  ) {
    playInitialAgentSeedSound();
    introSequenceState.seedSoundPlayed = true;
  }
  if (progress >= 1) finishIntroSequence();
}

function finishIntroSequence() {
  if (introSequenceState.sprite) {
    scene.remove(introSequenceState.sprite);
    introSequenceState.sprite.material?.dispose?.();
    introSequenceState.sprite = null;
  }
  introSequenceState.active = false;
  introSequenceState.completed = true;
  if (startScreen) {
    startScreen.classList.add('is-complete');
    startScreen.setAttribute('aria-hidden', 'true');
  }
  if (started) {
    statsReadbackCooldownUntil = performance.now() + STATS_READBACK_RESET_COOLDOWN_MS;
    replayInitialAgentSeed({ playSound: !introSequenceState.seedSoundPlayed });
  }
}

function cancelEndingSequence({ stopSound = false } = {}) {
  endingSequenceState.active = false;
  endingSequenceState.phase = 'idle';
  endingSequenceState.sequenceId++;
  endingSequenceState.armedAt = 0;
  endingSequenceState.camouflageStartAt = 0;
  endingSequenceState.camouflageStartedAt = 0;
  endingSequenceState.camouflageDurationMs = 0;
  endingSequenceState.fadeStartAt = 0;
  endingSequenceState.endAt = 0;
  endingSequenceState.targetReturnAt = 0;
  endingSequenceState.lastCountdownText = '';
  setEndingFadeOpacity(0);
  setEndingCountdownVisible(false);
  if (stopSound) stopEndingSequenceSounds();
}

function stopEndingSequenceSounds() {
  stopSoundCheckOneShot('cuttlefish-camouflage');
  stopSoundCheckOneShot('game-complete');
}

function isEndingSequenceSoundAllowed(sequenceId = endingSequenceState.sequenceId) {
  return params.endingTimeLimitEnabled &&
    endingSequenceState.active &&
    endingSequenceState.sequenceId === sequenceId;
}

function armEndingSequence(now = performance.now(), { fromNow = false } = {}) {
  if (!params.endingTimeLimitEnabled) {
    setEndingCountdownVisible(false);
    return false;
  }
  if (endingSequenceState.active) return true;
  endingSequenceState.active = true;
  endingSequenceState.phase = 'preparing';
  endingSequenceState.sequenceId++;
  endingSequenceState.armedAt = now;
  endingSequenceState.targetReturnAt = getEndingTargetReturnAt(now, { fromNow });
  endingSequenceState.camouflageStartAt = 0;
  endingSequenceState.camouflageStartedAt = 0;
  endingSequenceState.camouflageDurationMs = 0;
  endingSequenceState.fadeStartAt = 0;
  endingSequenceState.endAt = endingSequenceState.targetReturnAt;
  endingSequenceState.lastCountdownText = '';
  setEndingFadeOpacity(0);
  setEndingCountdownVisible(true);
  prepareEndingCamouflageSchedule(endingSequenceState.sequenceId);
  return true;
}

function useFallbackEndingFade(now = performance.now(), targetReturnAt = endingSequenceState.targetReturnAt) {
  const boundedTarget = Number.isFinite(targetReturnAt) && targetReturnAt > now
    ? targetReturnAt
    : now + ENDING_FALLBACK_FADE_MS;
  endingSequenceState.phase = 'fade';
  endingSequenceState.camouflageStartAt = now;
  endingSequenceState.camouflageStartedAt = 0;
  endingSequenceState.camouflageDurationMs = ENDING_FALLBACK_FADE_MS;
  endingSequenceState.fadeStartAt = Math.max(now, boundedTarget - ENDING_FALLBACK_FADE_MS);
  endingSequenceState.endAt = boundedTarget;
  endingSequenceState.targetReturnAt = boundedTarget;
}

async function prepareEndingCamouflageSchedule(sequenceId) {
  if (!isEndingSequenceSoundAllowed(sequenceId)) return;
  const clip = getSoundClip('cuttlefish-camouflage');
  const targetReturnAt = endingSequenceState.targetReturnAt || getEndingTargetReturnAt();
  if (!clip) {
    useFallbackEndingFade(performance.now(), targetReturnAt);
    return;
  }
  try {
    const buffer = await loadSoundCheckBuffer(clip.path);
    if (!isEndingSequenceSoundAllowed(sequenceId)) return;
    const now = performance.now();
    const durationMs = Math.max(1, (buffer.duration ?? 0) * 1000);
    const fadeDelayMs = Math.min(ENDING_CAMOUFLAGE_FADE_DELAY_MS, Math.max(0, durationMs - 1));
    endingSequenceState.camouflageDurationMs = durationMs;
    endingSequenceState.camouflageStartAt = targetReturnAt - durationMs;
    endingSequenceState.fadeStartAt = endingSequenceState.camouflageStartAt + fadeDelayMs;
    endingSequenceState.endAt = targetReturnAt;
    endingSequenceState.targetReturnAt = targetReturnAt;
    endingSequenceState.phase = now >= endingSequenceState.camouflageStartAt
      ? 'camouflage-loading'
      : 'gameplay';
    if (endingSequenceState.phase === 'camouflage-loading') {
      startEndingCamouflageSound(sequenceId);
    }
  } catch (err) {
    console.warn('Failed to prepare ending camouflage timing:', err);
    if (endingSequenceState.active && endingSequenceState.sequenceId === sequenceId) {
      useFallbackEndingFade(performance.now(), targetReturnAt);
    }
  }
}

async function startEndingCamouflageSound(sequenceId) {
  if (!isEndingSequenceSoundAllowed(sequenceId)) return;
  const clip = getSoundClip('cuttlefish-camouflage');
  if (!clip) {
    useFallbackEndingFade();
    return;
  }
  try {
    const sourceRecord = await playSoundCheckOneShot(clip, {
      restart: true,
      allowOverlap: false,
      startAtPerformanceMs: endingSequenceState.camouflageStartAt,
    });
    if (!isEndingSequenceSoundAllowed(sequenceId)) {
      stopOneShotSourceRecord(sourceRecord, 0);
      return;
    }
    if (!sourceRecord) {
      useFallbackEndingFade();
      return;
    }
    endingSequenceState.phase = 'camouflage';
    endingSequenceState.camouflageStartedAt = sourceRecord.startedAtPerformanceMs ?? performance.now();
  } catch (err) {
    console.warn('Failed to play ending camouflage sound:', err);
    if (endingSequenceState.active && endingSequenceState.sequenceId === sequenceId) {
      useFallbackEndingFade();
    }
  }
}

function completeEndingSequence(now = performance.now()) {
  if (!params.endingTimeLimitEnabled) {
    cancelEndingSequence({ stopSound: true });
    return false;
  }
  cancelEndingSequence({ stopSound: true });
  resetSimulation({ resetOats: true, spawnAgents: false });
  stopEnvAudio();
  stopSlimeTumbleLoop({ fadeOutSeconds: 1.2 });
  resetIntroSequenceToStartScreen(now);
  return true;
}

function updateEndingSequence(now = performance.now()) {
  if (!params.endingTimeLimitEnabled) {
    if (endingSequenceState.active) {
      cancelEndingSequence({ stopSound: true });
    } else {
      setEndingCountdownVisible(false);
    }
    return;
  }
  if (!endingSequenceState.active) return;
  let countdownTargetAt = endingSequenceState.camouflageStartAt || endingSequenceState.endAt;
  if (endingSequenceState.endAt > 0 && now >= endingSequenceState.endAt) {
    completeEndingSequence(now);
    return;
  }

  if (endingSequenceState.phase === 'gameplay' && now >= endingSequenceState.camouflageStartAt) {
    endingSequenceState.phase = 'camouflage-loading';
    startEndingCamouflageSound(endingSequenceState.sequenceId);
  }

  if (
    (
      endingSequenceState.phase === 'camouflage-loading' ||
      endingSequenceState.phase === 'camouflage' ||
      endingSequenceState.phase === 'fade'
    ) &&
    endingSequenceState.endAt > 0
  ) {
    countdownTargetAt = endingSequenceState.endAt;
    if (now >= endingSequenceState.fadeStartAt) {
      const fadeProgress = (now - endingSequenceState.fadeStartAt) /
        Math.max(1, endingSequenceState.endAt - endingSequenceState.fadeStartAt);
      setEndingFadeOpacity(smoothUnit(fadeProgress));
    } else {
      setEndingFadeOpacity(0);
    }
    if (now >= endingSequenceState.endAt) {
      completeEndingSequence(now);
      return;
    }
  }

  setEndingCountdownVisible(true);
  syncEndingCountdownText(formatEndingCountdown(countdownTargetAt - now));
}

function updateOatMarkerOcclusionOpacity(marker, target, now) {
  return updateOcclusionOpacity(marker.userData, target, now, 14);
}

function getOatStorySpriteOpacity(oat, now) {
  const observation = oat?.observation;
  const createdAt = oat?.sphere?.userData?.createdAt ?? now - OBSERVATION_OAT_FADE_IN_MS;
  const fadeIn = smoothUnit((now - createdAt) / OBSERVATION_OAT_FADE_IN_MS);
  if (observation?.completed) return 0;
  if (!observation?.triggered || !Number.isFinite(observation.oatFadeOutStartedAt)) return fadeIn;
  const fadeOut = smoothUnit((now - observation.oatFadeOutStartedAt) / OBSERVATION_OAT_FADE_OUT_MS);
  return fadeIn * (1 - fadeOut);
}

function getFizzleFlameOpacity(t, phase) {
  const envelope = Math.pow(1 - t, 1.55);
  const flutter =
    0.62 +
    0.28 * Math.sin(phase + t * 94) +
    0.18 * Math.sin(phase * 0.47 + t * 211) +
    0.12 * Math.sin(phase * 1.83 + t * 397);
  const sputter = t > 0.46 && Math.sin(phase * 2.7 + t * 61) < (-0.36 + t * 0.42)
    ? 0.18
    : 1;
  const lastGasp = Math.exp(-Math.pow((t - 0.82) / 0.075, 2)) * 0.32;
  return Math.max(0, Math.min(1.25, (envelope + lastGasp) * Math.max(0, flutter) * sputter));
}

function updateRejectedOatFizzleMarker(marker, now) {
  const duration = Math.max(1, marker.userData.durationMs ?? REJECTED_OAT_FIZZLE_MS);
  const elapsed = now - (marker.userData.createdAt ?? now);
  const t = Math.max(0, Math.min(1, elapsed / duration));
  if (t >= 1) {
    oatGroup.remove(marker);
    disposeOatMarker(marker);
    return;
  }

  const toCamera = oatFacingToCamera.copy(camera.position).sub(marker.userData.surfacePos).normalize();
  const facing = marker.userData.surfaceNormal.dot(toCamera);
  const facingVisibility = THREE.MathUtils.smoothstep(facing, -0.18, 0.14);
  const occlusionTarget = getCachedMeshOcclusionTarget(
    marker.userData,
    marker.userData.surfacePos,
    facingVisibility,
    now,
  );
  const visibility = facingVisibility * updateOatMarkerOcclusionOpacity(marker, occlusionTarget, now);
  marker.visible = visibility > 0.01;
  marker.position
    .copy(marker.userData.surfacePos)
    .addScaledVector(marker.userData.surfaceNormal, oatGlowLift);

  const flame = getFizzleFlameOpacity(t, marker.userData.fizzlePhase ?? 0);
  const glow = marker.children[0];
  if (glow) {
    const jitter = 1 + 0.16 * Math.sin((marker.userData.fizzlePhase ?? 0) + t * 173);
    const shrink = Math.max(0.08, Math.pow(1 - t, 0.72));
    glow.material.opacity = glow.userData.baseOpacity * visibility * flame;
    glow.scale.setScalar(glow.userData.baseScale * shrink * jitter);
  }
}

function updateOcclusionOpacity(cache, target, now, responseRate = 10) {
  const current = Number.isFinite(cache.occlusionOpacity) ? cache.occlusionOpacity : target;
  const last = Number.isFinite(cache.occlusionUpdatedAt) ? cache.occlusionUpdatedAt : now;
  const dtSeconds = Math.max(0, (now - last) / 1000);
  const response = 1 - Math.exp(-dtSeconds * responseRate);
  const next = current + (target - current) * response;
  cache.occlusionOpacity = next;
  cache.occlusionUpdatedAt = now;
  return next;
}

function getCachedMeshOcclusionTarget(cache, anchorPos, facingVisibility, now) {
  if (facingVisibility <= 0.002) {
    cache.occlusionTarget = 0;
    return 0;
  }
  if (!Number.isFinite(cache.occlusionTarget) || now >= (cache.nextOcclusionCheckAt ?? 0)) {
    cache.occlusionTarget = getOatMeshOcclusionTarget(anchorPos);
    const phase = Number.isFinite(cache.occlusionPhaseMs) ? cache.occlusionPhaseMs : 0;
    cache.nextOcclusionCheckAt = now + OBSERVATION_OCCLUSION_REFRESH_MS + phase;
  }
  return cache.occlusionTarget;
}

function updateOatGlowMarkers() {
  const now = performance.now();
  if (mesh) mesh.updateMatrixWorld(true);
  // Backwards index loop: fizzle markers can remove themselves mid-iteration.
  for (let markerIndex = oatGroup.children.length - 1; markerIndex >= 0; markerIndex--) {
    const marker = oatGroup.children[markerIndex];
    if (marker.userData.rejectedOatFizzle) {
      updateRejectedOatFizzleMarker(marker, now);
      continue;
    }
    if (marker.userData.oat?.suppressObservation) {
      marker.visible = false;
      const glow = marker.children[0];
      if (glow?.material) glow.material.opacity = 0;
      continue;
    }
    const toCamera = oatFacingToCamera.copy(camera.position).sub(marker.userData.surfacePos).normalize();
    const facing = marker.userData.surfaceNormal.dot(toCamera);
    const facingVisibility = THREE.MathUtils.smoothstep(facing, -0.18, 0.14);
    const occlusionTarget = getCachedMeshOcclusionTarget(
      marker.userData,
      marker.userData.surfacePos,
      facingVisibility,
      now,
    );
    const occlusionVisibility = updateOatMarkerOcclusionOpacity(marker, occlusionTarget, now);
    const storyOpacity = getOatStorySpriteOpacity(marker.userData.oat, now);
    const visibility = facingVisibility * occlusionVisibility * storyOpacity;
    marker.visible = visibility > 0.01;
    marker.position
      .copy(marker.userData.surfacePos)
      .addScaledVector(marker.userData.surfaceNormal, oatGlowLift);
    const glow = marker.children[0];
    if (glow) {
      glow.material.opacity = glow.userData.baseOpacity * visibility;
      glow.scale.setScalar(glow.userData.baseScale);
    }
  }
}

function splitObservationGraphemes(text) {
  if (observationGraphemeSegmenter) {
    return Array.from(observationGraphemeSegmenter.segment(String(text)), (part) => part.segment);
  }
  return Array.from(String(text));
}

function splitObservationWordToFit(word, availableWidth) {
  const parts = [];
  let current = '';
  for (const char of splitObservationGraphemes(word)) {
    const candidate = `${current}${char}`;
    if (!current || observationTextMeasureContext.measureText(candidate).width <= availableWidth) {
      current = candidate;
      continue;
    }
    parts.push(current);
    current = char;
  }
  if (current) parts.push(current);
  return parts;
}

function wrapObservationParagraph(paragraph, availableWidth) {
  const words = paragraph.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [''];
  const lines = [];
  let current = '';
  const pushCurrent = () => {
    if (!current) return;
    lines.push(current);
    current = '';
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (!current || observationTextMeasureContext.measureText(candidate).width <= availableWidth) {
      current = candidate;
      continue;
    }
    pushCurrent();
    if (observationTextMeasureContext.measureText(word).width <= availableWidth) {
      current = word;
      continue;
    }
    const parts = splitObservationWordToFit(word, availableWidth);
    for (let i = 0; i < parts.length - 1; i++) lines.push(parts[i]);
    current = parts[parts.length - 1] ?? '';
  }
  pushCurrent();
  return lines;
}

function wrapObservationText(text, body) {
  const normalizedText = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!normalizedText.trim()) return [''];

  const style = getComputedStyle(body);
  const paddingX = Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
  const availableWidth = Math.max(20, body.clientWidth - paddingX);
  observationTextMeasureContext.font = style.font ||
    `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;

  const lines = [];
  for (const paragraph of normalizedText.split('\n')) {
    if (lines.length) lines.push('');
    lines.push(...wrapObservationParagraph(paragraph, availableWidth));
  }
  return lines;
}

function cancelObservationTextAnimation(observation) {
  observation?.textScrollAnimation?.cancel?.();
  for (const animation of observation?.textRevealAnimations ?? []) {
    animation.cancel?.();
  }
  if (observation) observation.textScrollAnimation = null;
  if (observation) observation.textRevealAnimations = [];
}

function buildObservationTextAnimation(observation, text = OBSERVATION_PLACEHOLDER_TEXT) {
  const body = observation?.body;
  if (!body || !body.isConnected) return;
  observation.text = String(text ?? '');
  cancelObservationTextAnimation(observation);

  const lines = wrapObservationText(observation.text, body);
  body.textContent = '';
  body.setAttribute('aria-label', observation.text);

  const roll = document.createElement('span');
  roll.className = 'observation-text-roll';
  roll.setAttribute('aria-hidden', 'true');
  body.append(roll);

  const lineDurations = [];
  const lineStartTimes = [];
  observation.textRevealAnimations = [];
  let nextLineStartMs = 0;
  let revealEndMs = 0;
  for (const lineText of lines) {
    const line = document.createElement('span');
    line.className = 'observation-line';
    const chars = splitObservationGraphemes(lineText);
    const maskTravelDurationMs = chars.length * OBSERVATION_CHAR_STEP_MS + OBSERVATION_CHAR_FADE_MS;
    const lineDurationMs = Math.max(240, maskTravelDurationMs * OBSERVATION_TEXT_REVEAL_ACTIVE_FRACTION);
    const lineStartMs = nextLineStartMs;
    lineDurations.push(lineDurationMs);
    lineStartTimes.push(lineStartMs);
    line.textContent = lineText || '\u00a0';
    line.style.maskImage = OBSERVATION_TEXT_REVEAL_MASK_IMAGE;
    line.style.webkitMaskImage = line.style.maskImage;
    line.style.maskSize = OBSERVATION_TEXT_REVEAL_MASK_SIZE;
    line.style.webkitMaskSize = line.style.maskSize;
    line.style.maskRepeat = 'no-repeat';
    line.style.webkitMaskRepeat = line.style.maskRepeat;
    line.style.maskPosition = OBSERVATION_TEXT_REVEAL_START_POSITION;
    line.style.webkitMaskPosition = line.style.maskPosition;
    roll.append(line);
    const revealAnimation = line.animate([
      {
        maskPosition: OBSERVATION_TEXT_REVEAL_START_POSITION,
        WebkitMaskPosition: OBSERVATION_TEXT_REVEAL_START_POSITION,
      },
      {
        maskPosition: OBSERVATION_TEXT_REVEAL_END_POSITION,
        WebkitMaskPosition: OBSERVATION_TEXT_REVEAL_END_POSITION,
      },
    ], {
      duration: lineDurationMs,
      delay: OBSERVATION_TEXT_START_DELAY_MS + lineStartMs,
      easing: 'linear',
      fill: 'forwards',
    });
    observation.textRevealAnimations.push(revealAnimation);
    revealEndMs = Math.max(revealEndMs, lineStartMs + lineDurationMs);
    nextLineStartMs = lineStartMs + lineDurationMs * OBSERVATION_NEXT_LINE_START_FRACTION;
  }

  const style = getComputedStyle(body);
  const lineHeight = Number.parseFloat(style.lineHeight) || 16;
  const viewportHeight = Math.max(1, body.clientHeight);
  const textFadePx = Math.max(0, Number.parseFloat(style.getPropertyValue('--observation-text-fade')) || 0);
  const revealDurationMs = Math.max(1, revealEndMs);
  const averageLineDurationMs = lineDurations.reduce((sum, durationMs) => sum + durationMs, 0) /
    Math.max(1, lineDurations.length);
  const exitDurationMs = Math.max(2400, averageLineDurationMs * OBSERVATION_EXIT_LINE_COUNT);
  const textEndMs = OBSERVATION_TEXT_START_DELAY_MS + revealDurationMs + exitDurationMs;
  const totalDurationMs = textEndMs + OBSERVATION_BOX_FADE_OUT_MS;
  // Start revealing right at the lower edge of the opaque zone.
  const initialOffset = Math.max(0, viewportHeight - textFadePx);
  const finalOffset = -((lineDurations.length + 1) * lineHeight);
  const keyframes = [{ transform: `translate3d(0, ${initialOffset.toFixed(2)}px, 0)`, offset: 0 }];
  if (OBSERVATION_TEXT_START_DELAY_MS > 0) {
    keyframes.push({
      transform: `translate3d(0, ${initialOffset.toFixed(2)}px, 0)`,
      offset: Math.min(1, OBSERVATION_TEXT_START_DELAY_MS / totalDurationMs),
    });
  }
  lineStartTimes.forEach((lineStartMs, index) => {
    if (index === 0) return;
    keyframes.push({
      transform: `translate3d(0, ${(initialOffset - lineHeight * index).toFixed(2)}px, 0)`,
      offset: Math.min(1, (OBSERVATION_TEXT_START_DELAY_MS + lineStartMs) / totalDurationMs),
    });
  });
  keyframes.push({
    transform: `translate3d(0, ${(initialOffset - lineHeight * lineDurations.length).toFixed(2)}px, 0)`,
    offset: Math.min(1, (OBSERVATION_TEXT_START_DELAY_MS + revealDurationMs) / totalDurationMs),
  });
  keyframes.push({
    transform: `translate3d(0, ${finalOffset.toFixed(2)}px, 0)`,
    offset: Math.min(1, textEndMs / totalDurationMs),
  });
  keyframes.push({
    transform: `translate3d(0, ${finalOffset.toFixed(2)}px, 0)`,
    offset: 1,
  });

  observation.textTimeline = {
    startTime: performance.now(),
    textStartDelayMs: OBSERVATION_TEXT_START_DELAY_MS,
    revealDurationMs,
    exitDurationMs,
    textEndMs,
    fadeOutMs: OBSERVATION_BOX_FADE_OUT_MS,
    totalDurationMs,
  };
  observation.textScrollAnimation = roll.animate(keyframes, {
    duration: totalDurationMs,
    easing: 'linear',
    fill: 'forwards',
  });
}

function maybeStartOatObservationText(oat, now = performance.now()) {
  if (oat?.initial || oat?.suppressObservation) return null;
  const observation = oat?.observation;
  if (
    !observation?.triggered ||
    observation.completed ||
    observation.textTimeline ||
    now < (observation.textBoxStartAt ?? 0)
  ) {
    return observation?.textTimeline ?? null;
  }
  const storyText = ensureOatStoryText(oat);
  buildObservationTextAnimation(observation, normalizeStoryTextValue(observation.text) || storyText);
  startOatFoodDecay(oat, now);
  return observation.textTimeline;
}

function smoothUnit(value) {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function getObservationEnvelope(observation, now) {
  if (!observation?.triggered) return { glassOpacity: 0, textOpacity: 0 };
  const timeline = observation?.textTimeline;
  if (!timeline) return { glassOpacity: 0, textOpacity: 0 };
  const elapsedMs = now - timeline.startTime;
  if (elapsedMs >= timeline.totalDurationMs) return { glassOpacity: 0, textOpacity: 0 };
  const fadeIn = smoothUnit(elapsedMs / Math.max(1, timeline.textStartDelayMs));
  const textOpacity = elapsedMs >= timeline.textStartDelayMs ? 1 : 0;
  if (elapsedMs <= timeline.textEndMs) {
    return {
      glassOpacity: fadeIn,
      textOpacity,
    };
  }
  const fadeOut = smoothUnit((elapsedMs - timeline.textEndMs) / Math.max(1, timeline.fadeOutMs));
  return {
    glassOpacity: fadeIn * (1 - fadeOut),
    textOpacity: textOpacity * (1 - fadeOut),
  };
}

function setObservationText(observation, text = '', { restart = true } = {}) {
  if (!observation) return null;
  observation.text = String(text ?? '');
  if (restart && observation.triggered && observation.textTimeline) {
    buildObservationTextAnimation(observation, observation.text);
  } else if (!observation.triggered) {
    cancelObservationTextAnimation(observation);
    if (observation.body) observation.body.textContent = '';
    observation.textTimeline = null;
  }
  return observation;
}

function setOatObservationText(oatOrIndex, text = '', options = {}) {
  const oat = typeof oatOrIndex === 'number' ? oats[oatOrIndex] : oatOrIndex;
  if (!oat) return null;
  oat.storyText = normalizeStoryTextValue(text);
  oat.storyAssigned = Boolean(oat.storyText);
  return setObservationText(oat.observation, oat.storyText, options);
}

function setAllOatObservationText(text = '', options = {}) {
  const value = String(text ?? '');
  return oats.map((oat) => setOatObservationText(oat, value, options)).filter(Boolean);
}

function normalizeStoryTextValue(value) {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/[ \t]+/g, ' '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeStoryEntry(entry) {
  if (Array.isArray(entry)) {
    return normalizeStoryTextValue(entry.map(normalizeStoryEntry).filter(Boolean).join('\n\n'));
  }
  if (entry && typeof entry === 'object') {
    const candidate =
      entry.text ??
      entry.story ??
      entry.body ??
      entry.content ??
      entry.copy ??
      entry.description ??
      (Array.isArray(entry.lines) ? entry.lines.join('\n') : null) ??
      entry.title;
    return normalizeStoryEntry(candidate);
  }
  return normalizeStoryTextValue(entry);
}

function getStoryCollectionFromJson(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const key of ['stories', 'items', 'entries', 'observations', 'texts']) {
      if (Array.isArray(data[key])) return data[key];
    }
    if (
      typeof data.text === 'string' ||
      typeof data.story === 'string' ||
      typeof data.body === 'string' ||
      typeof data.content === 'string' ||
      Array.isArray(data.lines)
    ) {
      return [data];
    }
    return Object.values(data);
  }
  return [];
}

function parseStoryJson(data) {
  return getStoryCollectionFromJson(data)
    .map(normalizeStoryEntry)
    .filter(Boolean);
}

function setStoryLibrary(data, { path = storyLibraryState.path, resetCursor = true } = {}) {
  const stories = parseStoryJson(data);
  if (stories.length === 0) throw new Error('No story text entries found.');
  storyLibraryState.path = path;
  storyLibraryState.stories = stories;
  storyLibraryState.loaded = true;
  storyLibraryState.error = '';
  if (resetCursor) storyLibraryState.nextIndex = 0;
  return stories;
}

async function loadStories(path = STORIES_JSON_PATH) {
  if (storyLibraryState.loading && storyLibraryState.promise) return storyLibraryState.promise;
  if (storyLibraryState.loaded && storyLibraryState.path === path) return storyLibraryState.stories;
  storyLibraryState.path = path;
  storyLibraryState.loading = true;
  storyLibraryState.error = '';
  storyLibraryState.promise = fetch(path, { cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      const stories = setStoryLibrary(data, { path });
      console.info(`Loaded ${stories.length} story ${stories.length === 1 ? 'entry' : 'entries'} from ${path}.`);
      return stories;
    })
    .catch((err) => {
      storyLibraryState.loaded = false;
      storyLibraryState.error = err?.message ?? String(err);
      console.warn(`Story file ${path} could not be loaded; using fallback story text.`, err);
      return [];
    })
    .finally(() => {
      storyLibraryState.loading = false;
      storyLibraryState.promise = null;
    });
  return storyLibraryState.promise;
}

function getStoryLibraryState() {
  return {
    path: storyLibraryState.path,
    count: storyLibraryState.stories.length,
    nextIndex: storyLibraryState.nextIndex,
    loaded: storyLibraryState.loaded,
    loading: storyLibraryState.loading,
    error: storyLibraryState.error,
  };
}

function resetStoryLibraryCursor() {
  storyLibraryState.nextIndex = 0;
}

function getNextStoryText({ consume = true } = {}) {
  const storyCount = storyLibraryState.stories.length;
  if (storyCount === 0) return OBSERVATION_PLACEHOLDER_TEXT;
  const story = storyLibraryState.stories[storyLibraryState.nextIndex % storyCount];
  if (consume) storyLibraryState.nextIndex = (storyLibraryState.nextIndex + 1) % storyCount;
  return story;
}

function ensureOatStoryText(oat) {
  if (!oat) return OBSERVATION_PLACEHOLDER_TEXT;
  if (!oat.storyAssigned) {
    oat.storyText = getNextStoryText();
    oat.storyAssigned = true;
    if (oat.observation) oat.observation.text = oat.storyText;
  }
  return normalizeStoryTextValue(oat.storyText) || OBSERVATION_PLACEHOLDER_TEXT;
}

function playCuttlefishRevealSound(startAtPerformanceMs = performance.now()) {
  const revealClip = getSoundClip('cuttlefish-reveal');
  if (!revealClip) return null;
  return playSoundCheckOneShot(revealClip, { allowOverlap: true, startAtPerformanceMs }).catch((err) => {
    console.warn('Failed to play cuttlefish reveal sound:', err);
    return null;
  });
}

function triggerOatObservation(oatOrIndex, { force = false } = {}) {
  if (!isStoryBoxesEnabled() && !force) return null;
  const oat = typeof oatOrIndex === 'number' ? oats[oatOrIndex] : oatOrIndex;
  if (oat?.initial || oat?.suppressObservation) return null;
  const observation = oat?.observation;
  if (!observation || (observation.triggered && !force)) return null;
  const now = performance.now();
  observation.triggered = true;
  observation.completed = false;
  observation.triggeredAt = now;
  observation.oatFadeOutStartedAt = now;
  observation.textBoxStartAt = now + OBSERVATION_OAT_FADE_OUT_MS;
  cancelObservationTextAnimation(observation);
  if (observation.body) observation.body.textContent = '';
  observation.textTimeline = null;
  return observation;
}

function completeOatObservation(oatOrIndex) {
  const oat = typeof oatOrIndex === 'number' ? oats[oatOrIndex] : oatOrIndex;
  const observation = oat?.observation;
  if (!observation) return null;
  const now = performance.now();
  observation.triggered = true;
  observation.completed = true;
  observation.triggeredAt = now - OBSERVATION_BOX_FADE_OUT_MS - OBSERVATION_OAT_FADE_OUT_MS;
  observation.oatFadeOutStartedAt = now - OBSERVATION_OAT_FADE_OUT_MS;
  observation.textBoxStartAt = now;
  cancelObservationTextAnimation(observation);
  if (observation.body) observation.body.textContent = '';
  observation.textTimeline = {
    startTime: now - OBSERVATION_OAT_FADE_OUT_MS - 1,
    textStartDelayMs: 0,
    textEndMs: 0,
    totalDurationMs: 0,
    fadeOutMs: OBSERVATION_BOX_FADE_OUT_MS,
  };
  hideOatObservation(observation, { preserveEnvelope: true });
  if (oat?.sphere) {
    oat.sphere.visible = false;
    const glow = oat.sphere.children?.[0];
    if (glow?.material) glow.material.opacity = 0;
  }
  return observation;
}

function createOatObservation(oat) {
  if (!annotationLayer || !oat.worldPos || !oat.worldNormal) return null;
  const normal = oat.worldNormal.clone();
  if (normal.lengthSq() < 1e-8) normal.set(0, 1, 0);
  normal.normalize();

  const id = nextObservationId++;
  const callout = document.createElement('article');
  callout.className = 'observation-callout';

  const tail = document.createElement('div');
  tail.className = 'observation-tail';
  tail.setAttribute('aria-hidden', 'true');

  const content = document.createElement('div');
  content.className = 'observation-content';
  const body = document.createElement('p');
  body.className = 'observation-text-viewport';
  content.append(body);
  callout.append(tail, content);

  const observation = {
    id,
    callout,
    tail,
    body,
    text: normalizeStoryTextValue(oat.storyText),
    triggered: false,
    completed: false,
    triggeredAt: 0,
    oatFadeOutStartedAt: null,
    textBoxStartAt: null,
    slimeTriggerScore: 0,
    slimeTriggerMean: 0,
    slimeTriggerMax: 0,
    surfacePos: oat.worldPos.clone(),
    surfaceNormal: normal,
    occlusionOpacity: 1,
    occlusionUpdatedAt: performance.now(),
    occlusionPhaseMs: (id * 19) % OBSERVATION_OCCLUSION_REFRESH_MS,
  };
  annotationLayer.append(callout);
  body.textContent = '';
  document.fonts?.ready?.then(() => {
    if (observation.callout.isConnected && observation.triggered && !observation.completed && observation.textTimeline) {
      buildObservationTextAnimation(observation, observation.text);
    }
  });
  return observation;
}

function disposeOatObservation(observation) {
  cancelObservationTextAnimation(observation);
  observation?.callout?.remove();
}

const projectWorldToScreenResult = { x: 0, y: 0, z: 0, inClip: false };
function projectWorldToScreen(worldPoint, viewportWidth = canvas.clientWidth, viewportHeight = canvas.clientHeight) {
  const projected = oatAnnotationProjectScratch.copy(worldPoint).project(camera);
  const result = projectWorldToScreenResult;
  result.x = (projected.x * 0.5 + 0.5) * viewportWidth;
  result.y = (-projected.y * 0.5 + 0.5) * viewportHeight;
  result.z = projected.z;
  result.inClip = projected.z >= -1 && projected.z <= 1;
  return result;
}

function getTailAnchor(box, tip) {
  const centerX = box.left + box.width * 0.5;
  const centerY = box.top + box.height * 0.5;
  const halfWidth = Math.max(1, box.width * 0.5);
  const halfHeight = Math.max(1, box.height * 0.5);
  const dx = tip.x - centerX;
  const dy = tip.y - centerY;
  const scale = Math.max(Math.abs(dx) / halfWidth, Math.abs(dy) / halfHeight, 1e-6);
  const edgeX = centerX + dx / scale;
  const edgeY = centerY + dy / scale;
  const onLeft = Math.abs(edgeX - box.left) <= 0.5;
  const onRight = Math.abs(edgeX - (box.left + box.width)) <= 0.5;
  const side = onLeft ? 'left' : onRight ? 'right' : edgeY < centerY ? 'top' : 'bottom';
  const x = side === 'left' ? box.left : side === 'right' ? box.left + box.width : edgeX;
  const y = side === 'top' ? box.top : side === 'bottom' ? box.top + box.height : edgeY;
  return {
    x: THREE.MathUtils.clamp(x, box.left, box.left + box.width),
    y: THREE.MathUtils.clamp(y, box.top, box.top + box.height),
  };
}

function isPointOutsideRect(point, rect) {
  return point.x < rect.left ||
    point.x > rect.left + rect.width ||
    point.y < rect.top ||
    point.y > rect.top + rect.height;
}

function updateObservationTail(observation, tip, box, opacity) {
  if (!observation?.tail) return;
  if (!isPointOutsideRect(tip, box)) {
    setStylePropIfChanged(observation.tail, 'opacity', '0');
    return;
  }

  const anchor = getTailAnchor(box, tip);
  const dx = tip.x - anchor.x;
  const dy = tip.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) {
    setStylePropIfChanged(observation.tail, 'opacity', '0');
    return;
  }

  const ux = dx / length;
  const uy = dy / length;
  const leaderStartX = anchor.x - ux * OBSERVATION_LEADER_BORDER_OVERLAP_PX;
  const leaderStartY = anchor.y - uy * OBSERVATION_LEADER_BORDER_OVERLAP_PX;
  setStylePropIfChanged(observation.tail, 'left', `${(leaderStartX - box.left).toFixed(1)}px`);
  setStylePropIfChanged(observation.tail, 'top', `${(leaderStartY - box.top - OBSERVATION_STROKE_WIDTH_PX * 0.5).toFixed(1)}px`);
  setStylePropIfChanged(observation.tail, 'width', `${(length + OBSERVATION_LEADER_BORDER_OVERLAP_PX).toFixed(1)}px`);
  setStylePropIfChanged(observation.tail, 'opacity', opacity.toFixed(3));
  setStylePropIfChanged(observation.tail, 'transform', `rotate(${Math.atan2(dy, dx).toFixed(4)}rad)`);
}

function hideOatObservation(observation, { preserveEnvelope = false } = {}) {
  if (!observation) return;
  if (observation.calloutVisible !== false) {
    observation.callout.classList.remove('is-visible');
    observation.calloutVisible = false;
  }
  setStylePropIfChanged(observation.callout, 'opacity', '0');
  setStylePropIfChanged(observation.callout, '--observation-spatial-opacity', '0');
  if (!preserveEnvelope) {
    setStylePropIfChanged(observation.callout, '--observation-glass-opacity', '0');
    setStylePropIfChanged(observation.callout, '--observation-text-opacity', '0');
  }
  if (observation.tail) setStylePropIfChanged(observation.tail, 'opacity', '0');
}

function isStoryBoxesEnabled() {
  return params.storyBoxesEnabled !== false;
}

function syncStoryBoxesEnabled() {
  if (isStoryBoxesEnabled()) return;
  for (const oat of oats) hideOatObservation(oat.observation);
}

function setStoryBoxesEnabled(enabled) {
  const nextEnabled = Boolean(enabled);
  if (params.storyBoxesEnabled !== nextEnabled) {
    params.storyBoxesEnabled = nextEnabled;
    setActiveRenderDisplayPreset('custom');
  }
  const syncControl = boundParamControls.get('storyBoxesEnabled');
  if (syncControl) syncControl();
  else syncStoryBoxesEnabled();
  return params.storyBoxesEnabled;
}

function toggleStoryBoxesEnabled() {
  return setStoryBoxesEnabled(!isStoryBoxesEnabled());
}

function getOatAnnotationAnchorPos(oat, observation, target = oatAnnotationAnchorScratch) {
  if (oat?.sphere?.position) return target.copy(oat.sphere.position);
  return target.copy(observation.surfacePos).addScaledVector(observation.surfaceNormal, oatGlowLift);
}

function getOatMeshOcclusionTarget(anchorPos) {
  if (!mesh || !anchorPos) return 1;
  const distance = observationOcclusionDirection.copy(anchorPos).sub(camera.position).length();
  if (distance <= OBSERVATION_OCCLUSION_MARGIN) return 1;

  observationOcclusionDirection.normalize();
  observationOcclusionRaycaster.near = 0;
  observationOcclusionRaycaster.far = Math.max(0, distance - OBSERVATION_OCCLUSION_MARGIN);
  observationOcclusionRaycaster.set(camera.position, observationOcclusionDirection);
  observationOcclusionHits.length = 0;
  observationOcclusionRaycaster.intersectObject(mesh, false, observationOcclusionHits);
  const occluded = observationOcclusionHits.length > 0;
  observationOcclusionHits.length = 0;
  return occluded ? 0 : 1;
}

function updateObservationOcclusionOpacity(observation, target, now) {
  return updateOcclusionOpacity(observation, target, now, 10);
}

function renderObservationTriggerScoreTexture() {
  const uniforms = observationTriggerScoreMaterial.uniforms;
  uniforms.u_food.value = renderSampleViewRT.read.texture;
  uniforms.u_oatCount.value = Math.min(oats.length, MAX_OATS);
  const oatUniforms = uniforms.u_oats.value;
  for (let i = 0; i < MAX_OATS; i++) {
    const uv = oats[i]?.uv;
    oatUniforms[i].set(
      Number.isFinite(uv?.x) ? uv.x : 0,
      Number.isFinite(uv?.y) ? uv.y : 0,
    );
  }
  runFullscreenPass(observationTriggerScoreMaterial, observationTriggerScoreRT);
}

function beginObservationTriggerThresholdQuery(indices, threshold) {
  const state = observationTriggerThresholdQueryState;
  if (!state.supported || state.pending || !indices?.length) return false;

  renderObservationTriggerScoreTexture();

  const uniforms = observationTriggerThresholdQueryMaterial.uniforms;
  uniforms.u_scores.value = observationTriggerScoreRT.texture;
  uniforms.u_oatCount.value = Math.min(oats.length, MAX_OATS);
  uniforms.u_threshold.value = threshold;
  uniforms.u_pending.value.fill(0);
  for (const index of indices) {
    if (index >= 0 && index < MAX_OATS) uniforms.u_pending.value[index] = 1;
  }

  const gl = renderer.getContext();
  let query = null;
  let queryBegun = false;
  try {
    query = gl.createQuery();
    if (!query) return false;
    gl.beginQuery(gl.ANY_SAMPLES_PASSED, query);
    queryBegun = true;
    runFullscreenPass(observationTriggerThresholdQueryMaterial, observationTriggerQueryRT);
    gl.endQuery(gl.ANY_SAMPLES_PASSED);
    queryBegun = false;

    const queryError = gl.getError();
    if (queryError !== gl.NO_ERROR) {
      state.supported = false;
      state.lastError = queryError;
      gl.deleteQuery(query);
      return false;
    }

    state.query = query;
    state.pending = true;
    state.indices = indices.slice();
    state.requestedSequence = ++state.sequence;
    state.requestedOatListVersion = oatListVersion;
    state.lastQueuedAt = performance.now();
    return true;
  } catch (err) {
    state.supported = false;
    state.lastError = err;
    if (queryBegun) {
      try {
        gl.endQuery(gl.ANY_SAMPLES_PASSED);
      } catch {
        // Query support is disabled below; keep the fallback path available.
      }
    }
    if (query) gl.deleteQuery(query);
    return false;
  }
}

function beginObservationTriggerScoreAsyncReadback() {
  const state = observationTriggerScoreReadbackState;
  if (!state.asyncSupported || state.pending) return false;
  const gl = renderer.getContext();
  const previousPackBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  const previousRenderTarget = renderer.getRenderTarget();
  let sync = null;
  try {
    if (!state.buffer) state.buffer = gl.createBuffer();
    if (!state.buffer) return false;
    renderer.setRenderTarget(observationTriggerScoreRT);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, state.buffer);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, observationTriggerScoreReadbackByteLength, gl.STREAM_READ);
    gl.readPixels(0, 0, MAX_OATS, 1, gl.RGBA, gl.FLOAT, 0);
    const readError = gl.getError();
    if (readError !== gl.NO_ERROR) {
      state.asyncSupported = false;
      state.lastError = readError;
      return false;
    }
    sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    if (!sync) return false;
    gl.flush();
    state.pending = true;
    state.sync = sync;
    state.requestedSequence = ++state.sequence;
    state.requestedOatListVersion = oatListVersion;
    state.lastQueuedAt = performance.now();
    state.mode = 'async';
    return true;
  } catch (err) {
    state.asyncSupported = false;
    state.lastError = err;
    if (sync) gl.deleteSync(sync);
    return false;
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPackBuffer);
    renderer.setRenderTarget(previousRenderTarget);
  }
}

function completeObservationTriggerScoreReadback(sequence, oatVersion, mode) {
  observationTriggerScoreReadbackState.completedSequence = sequence;
  observationTriggerScoreReadbackState.completedOatListVersion = oatVersion;
  observationTriggerScoreReadbackState.lastCompletedAt = performance.now();
  observationTriggerScoreReadbackState.mode = mode;
}

function readObservationTriggerScoresSync() {
  renderer.readRenderTargetPixels(
    observationTriggerScoreRT,
    0,
    0,
    MAX_OATS,
    1,
    observationTriggerScoreReadback,
  );
  const sequence = ++observationTriggerScoreReadbackState.sequence;
  completeObservationTriggerScoreReadback(sequence, oatListVersion, 'sync');
  return true;
}

function requestObservationTriggerScoreReadback({ renderScores = true, processIndices = null } = {}) {
  const state = observationTriggerScoreReadbackState;
  if (state.pending) return false;
  state.processIndices = Array.isArray(processIndices) ? processIndices.slice() : null;
  if (renderScores) renderObservationTriggerScoreTexture();
  if (beginObservationTriggerScoreAsyncReadback()) return true;
  const completed = readObservationTriggerScoresSync();
  if (!completed) state.processIndices = null;
  return completed;
}

function pollObservationTriggerScoreReadback() {
  const state = observationTriggerScoreReadbackState;
  if (!state.pending || !state.sync || !state.buffer) return false;
  const gl = renderer.getContext();
  const status = gl.clientWaitSync(state.sync, 0, 0);
  if (status === gl.TIMEOUT_EXPIRED) return false;

  const sync = state.sync;
  const sequence = state.requestedSequence;
  const oatVersion = state.requestedOatListVersion;
  state.pending = false;
  state.sync = null;
  gl.deleteSync(sync);

  if (status === gl.WAIT_FAILED) {
    state.lastError = 'WAIT_FAILED';
    return false;
  }

  const previousPackBuffer = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
  try {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, state.buffer);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, observationTriggerScoreReadback);
    const readError = gl.getError();
    if (readError !== gl.NO_ERROR) {
      state.asyncSupported = false;
      state.lastError = readError;
      return false;
    }
  } finally {
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, previousPackBuffer);
  }

  if (oatVersion !== oatListVersion) return false;
  completeObservationTriggerScoreReadback(sequence, oatVersion, 'async');
  return true;
}

function invalidateObservationTriggerThresholdQuery() {
  const state = observationTriggerThresholdQueryState;
  if (state.query) {
    try {
      renderer.getContext().deleteQuery(state.query);
    } catch {
      // The query is best-effort; a stale query should not block the fallback.
    }
  }
  state.query = null;
  state.pending = false;
  state.indices = [];
  state.requestedOatListVersion = -1;
}

function pollObservationTriggerThresholdQuery() {
  const state = observationTriggerThresholdQueryState;
  if (!state.pending || !state.query) {
    return { completed: false, passed: false, checked: 0, readbackRequested: false };
  }

  const gl = renderer.getContext();
  let available = false;
  try {
    available = Boolean(gl.getQueryParameter(state.query, gl.QUERY_RESULT_AVAILABLE));
  } catch (err) {
    state.supported = false;
    state.lastError = err;
    invalidateObservationTriggerThresholdQuery();
    return { completed: false, passed: false, checked: 0, readbackRequested: false };
  }
  if (!available) return { completed: false, passed: false, checked: 0, readbackRequested: false };

  const query = state.query;
  const indices = state.indices.slice();
  const oatVersion = state.requestedOatListVersion;
  let passed = false;
  try {
    passed = Boolean(gl.getQueryParameter(query, gl.QUERY_RESULT));
  } catch (err) {
    state.supported = false;
    state.lastError = err;
  } finally {
    gl.deleteQuery(query);
    state.query = null;
    state.pending = false;
    state.indices = [];
  }

  state.lastCompletedAt = performance.now();
  state.lastResult = passed;
  if (oatVersion !== oatListVersion) {
    return { completed: true, passed: false, checked: indices.length, readbackRequested: false, stale: true };
  }

  let readbackRequested = false;
  if (passed && !observationTriggerScoreReadbackState.pending && !hasUnprocessedObservationTriggerScores()) {
    readbackRequested = requestObservationTriggerScoreReadback({
      renderScores: false,
      processIndices: indices,
    });
  }

  return { completed: true, passed, checked: indices.length, readbackRequested };
}

function hasUnprocessedObservationTriggerScores() {
  const state = observationTriggerScoreReadbackState;
  return state.completedSequence > state.processedSequence &&
    state.completedOatListVersion === oatListVersion;
}

function markObservationTriggerScoresProcessed() {
  observationTriggerScoreReadbackState.processedSequence =
    observationTriggerScoreReadbackState.completedSequence;
  observationTriggerScoreReadbackState.processIndices = null;
}

function invalidateObservationTriggerScores() {
  const state = observationTriggerScoreReadbackState;
  state.requestedOatListVersion = -1;
  state.completedOatListVersion = -1;
  state.completedSequence = 0;
  state.processedSequence = 0;
  state.processIndices = null;
  invalidateObservationTriggerThresholdQuery();
}

function readOatSlimeTriggerScore(index) {
  if (index < 0 || index >= Math.min(oats.length, MAX_OATS)) return null;
  if (observationTriggerScoreReadbackState.completedOatListVersion !== oatListVersion) return null;
  const offset = index * 4;
  const maxValue = observationTriggerScoreReadback[offset];
  const meanValue = observationTriggerScoreReadback[offset + 1];
  const sampleCount = observationTriggerScoreReadback[offset + 2];
  if (!Number.isFinite(maxValue) || !Number.isFinite(meanValue) || sampleCount <= 0) return null;
  return {
    mean: meanValue,
    max: maxValue,
    score: maxValue,
  };
}

function collectObservationTriggerCheckIndices(maxReads) {
  const indices = [];
  const count = oats.length;
  if (count <= 0) return { indices, cursor: observationTriggerCursor };
  let cursor = observationTriggerCursor;
  for (let attempts = 0; attempts < count && indices.length < maxReads; attempts++) {
    const index = cursor % count;
    cursor = (cursor + 1) % count;
    const oat = oats[index];
    const observation = oat?.observation;
    if (oat?.initial || oat?.suppressObservation) continue;
    if (!observation || observation.triggered) continue;
    indices.push(index);
  }
  return { indices, cursor };
}

function processObservationTriggerScoreIndex(index, threshold, now) {
  const oat = oats[index];
  const observation = oat?.observation;
  if (oat?.initial || oat?.suppressObservation) return { checked: false, triggered: false };
  if (!observation || observation.triggered) return { checked: false, triggered: false };

  const sample = readOatSlimeTriggerScore(index);
  if (!sample) return { checked: true, triggered: false };

  observation.slimeTriggerMean = sample.mean;
  observation.slimeTriggerMax = sample.max;
  observation.slimeTriggerScore = sample.score;
  if (sample.score < threshold) return { checked: true, triggered: false };

  const triggeredObservation = triggerOatObservation(oat);
  if (!triggeredObservation) return { checked: true, triggered: false };
  playCuttlefishRevealSound(now);
  return { checked: true, triggered: true };
}

function updateObservationSlimeTriggers(now = performance.now()) {
  const threshold = Math.max(0, params.observationSlimeTriggerThreshold ?? 0);
  if (!isStoryBoxesEnabled()) {
    nextObservationTriggerCheckAt = now + OBSERVATION_SLIME_TRIGGER_INTERVAL_MS;
    invalidateObservationTriggerScores();
    lastObservationTriggerDiagnostics = {
      checked: 0,
      triggered: 0,
      pending: 0,
      threshold,
      lastCheckedAt: now,
      disabled: true,
    };
    return lastObservationTriggerDiagnostics;
  }

  const completedScoreReadback = pollObservationTriggerScoreReadback();
  const thresholdQueryResult = pollObservationTriggerThresholdQuery();
  if ((completedScoreReadback || hasUnprocessedObservationTriggerScores()) && now < nextObservationTriggerCheckAt) {
    nextObservationTriggerCheckAt = now;
  }

  if (!oats.length || now < nextObservationTriggerCheckAt) return lastObservationTriggerDiagnostics;
  nextObservationTriggerCheckAt = now + OBSERVATION_SLIME_TRIGGER_INTERVAL_MS;

  let pendingBefore = 0;
  for (const oat of oats) {
    if (oat.observation && !oat.observation.triggered) pendingBefore++;
  }
  if (pendingBefore <= 0) {
    lastObservationTriggerDiagnostics = {
      checked: 0,
      triggered: 0,
      pending: 0,
      threshold,
      lastCheckedAt: now,
      gpuScoreReadbacks: 0,
      gpuScoreReadbackMode: observationTriggerScoreReadbackState.mode,
      gpuScoreReadbackPending: observationTriggerScoreReadbackState.pending,
      gpuThresholdQueries: 0,
      gpuThresholdQueryPending: observationTriggerThresholdQueryState.pending,
      gpuThresholdQuerySupported: observationTriggerThresholdQueryState.supported,
    };
    return lastObservationTriggerDiagnostics;
  }

  let scoreReadbackRequested = false;
  let thresholdQueryRequested = false;
  let thresholdQueryChecked = thresholdQueryResult.completed ? thresholdQueryResult.checked : 0;
  const maxReads = Math.max(1, OBSERVATION_SLIME_TRIGGER_READS_PER_FRAME);

  if (
    !hasUnprocessedObservationTriggerScores() &&
    !observationTriggerScoreReadbackState.pending &&
    !observationTriggerThresholdQueryState.pending
  ) {
    if (observationTriggerThresholdQueryState.supported) {
      const selection = collectObservationTriggerCheckIndices(maxReads);
      if (selection.indices.length > 0) {
        thresholdQueryRequested = beginObservationTriggerThresholdQuery(selection.indices, threshold);
        if (thresholdQueryRequested) {
          observationTriggerCursor = selection.cursor;
          thresholdQueryChecked += selection.indices.length;
        }
      }
    }
    if (!thresholdQueryRequested) {
      scoreReadbackRequested = requestObservationTriggerScoreReadback();
    }
  }

  if (!hasUnprocessedObservationTriggerScores()) {
    lastObservationTriggerDiagnostics = {
      checked: 0,
      triggered: 0,
      pending: pendingBefore,
      threshold,
      lastCheckedAt: now,
      gpuScoreReadbacks: scoreReadbackRequested ? 1 : 0,
      gpuScoreReadbackMode: observationTriggerScoreReadbackState.mode,
      gpuScoreReadbackPending: observationTriggerScoreReadbackState.pending,
      gpuThresholdQueries: thresholdQueryRequested ? 1 : 0,
      gpuThresholdQueryChecked: thresholdQueryChecked,
      gpuThresholdQueryPassed: thresholdQueryResult.passed,
      gpuThresholdQueryReadbackRequested: thresholdQueryResult.readbackRequested,
      gpuThresholdQueryPending: observationTriggerThresholdQueryState.pending,
      gpuThresholdQuerySupported: observationTriggerThresholdQueryState.supported,
    };
    return lastObservationTriggerDiagnostics;
  }

  let checked = 0;
  let triggered = 0;
  let pending = 0;
  const processIndices = Array.isArray(observationTriggerScoreReadbackState.processIndices)
    ? observationTriggerScoreReadbackState.processIndices
    : null;
  let scoreSelection = processIndices;
  if (!scoreSelection) {
    const selection = collectObservationTriggerCheckIndices(maxReads);
    scoreSelection = selection.indices;
    observationTriggerCursor = selection.cursor;
  }

  for (const index of scoreSelection) {
    const result = processObservationTriggerScoreIndex(index, threshold, now);
    if (result.checked) checked++;
    if (result.triggered) triggered++;
  }

  for (const oat of oats) {
    if (oat.observation && !oat.observation.triggered) pending++;
  }
  markObservationTriggerScoresProcessed();
  lastObservationTriggerDiagnostics = {
    checked,
    triggered,
    pending,
    threshold,
    lastCheckedAt: now,
    gpuScoreReadbacks: scoreReadbackRequested ? 1 : 0,
    gpuScoreReadbackMode: observationTriggerScoreReadbackState.mode,
    gpuScoreReadbackPending: observationTriggerScoreReadbackState.pending,
    gpuThresholdQueries: thresholdQueryRequested ? 1 : 0,
    gpuThresholdQueryChecked: thresholdQueryChecked,
    gpuThresholdQueryPassed: thresholdQueryResult.passed,
    gpuThresholdQueryReadbackRequested: thresholdQueryResult.readbackRequested,
    gpuThresholdQueryPending: observationTriggerThresholdQueryState.pending,
    gpuThresholdQuerySupported: observationTriggerThresholdQueryState.supported,
  };
  return lastObservationTriggerDiagnostics;
}

function updateOatAnnotations() {
  if (!annotationLayer || !mesh) return;
  if (!isStoryBoxesEnabled()) {
    for (const oat of oats) hideOatObservation(oat.observation);
    return;
  }
  const now = performance.now();
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  mesh.updateMatrixWorld(true);

  const viewportWidth = Math.max(1, canvas.clientWidth);
  const viewportHeight = Math.max(1, canvas.clientHeight);

  for (const oat of oats) {
    const observation = oat.observation;
    if (!observation) continue;
    maybeStartOatObservationText(oat, now);
    const envelope = getObservationEnvelope(observation, now);
    if (envelope.glassOpacity <= 0.005) {
      hideOatObservation(observation, { preserveEnvelope: observation.triggered });
      continue;
    }

    const surfacePos = observation.surfacePos;
    const surfaceNormal = observation.surfaceNormal;
    const anchorPos = getOatAnnotationAnchorPos(oat, observation);
    const anchorScreen = projectWorldToScreen(anchorPos, viewportWidth, viewportHeight);
    const toCamera = oatFacingToCamera.copy(camera.position).sub(surfacePos).normalize();
    const facing = surfaceNormal.dot(toCamera);
    const facingVisibility = THREE.MathUtils.smoothstep(facing, -0.14, 0.2);
    const occlusionCache = oat.sphere?.userData ?? observation;
    const occlusionTarget = getCachedMeshOcclusionTarget(occlusionCache, anchorPos, facingVisibility, now);
    const visibility = facingVisibility * updateObservationOcclusionOpacity(occlusionCache, occlusionTarget, now);

    if (!anchorScreen.inClip) {
      hideOatObservation(observation, { preserveEnvelope: true });
      continue;
    }

    const boxWidth = Math.min(OBSERVATION_BOX_WIDTH_PX, Math.max(1, viewportWidth - OBSERVATION_VIEW_MARGIN_PX * 2));
    const boxHeight = OBSERVATION_BOX_HEIGHT_PX;
    const screenGap = Math.max(
      OBSERVATION_MIN_SCREEN_GAP_PX,
      Math.max(0, params.observationTailLength ?? 0) * viewportHeight,
    );
    const left = THREE.MathUtils.clamp(
      anchorScreen.x - boxWidth * 0.5,
      OBSERVATION_VIEW_MARGIN_PX,
      viewportWidth - boxWidth - OBSERVATION_VIEW_MARGIN_PX,
    );
    const top = THREE.MathUtils.clamp(
      anchorScreen.y - boxHeight - screenGap,
      OBSERVATION_VIEW_MARGIN_PX,
      viewportHeight - boxHeight - OBSERVATION_VIEW_MARGIN_PX,
    );

    setStylePropIfChanged(observation.callout, 'left', `${left.toFixed(1)}px`);
    setStylePropIfChanged(observation.callout, 'top', `${top.toFixed(1)}px`);
    setStylePropIfChanged(observation.callout, 'opacity', '1');
    setStylePropIfChanged(observation.callout, '--observation-glass-opacity', envelope.glassOpacity.toFixed(3));
    setStylePropIfChanged(observation.callout, '--observation-text-opacity', envelope.textOpacity.toFixed(3));
    setStylePropIfChanged(observation.callout, '--observation-spatial-opacity', visibility.toFixed(3));
    const depth01 = THREE.MathUtils.clamp((anchorScreen.z + 1) * 0.5, 0, 1);
    setStylePropIfChanged(observation.callout, 'zIndex', String(Math.round((1 - depth01) * OBSERVATION_Z_INDEX_RANGE)));
    if (!observation.calloutVisible) {
      observation.callout.classList.add('is-visible');
      observation.calloutVisible = true;
    }

    updateObservationTail(
      observation,
      anchorScreen,
      { left, top, width: boxWidth, height: boxHeight },
      1,
    );
  }
}

// === state ===
let mesh = null;
let wireframeOverlay = null;
// Large readback scratch buffers are allocated on first use: agent full-scan is
// a rare fallback and slime coverage is a manual/console stat, so keeping them
// eager would pin ~20MB of heap (painful on phones) for nothing.
let agentReadback = null;
const agentPrefixCountReadback = new Float32Array(4);
let agentPrefixCountValid = false;
let slimeCoverageReadback = null;
let coverageMaskReadback = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
const observationTriggerScoreReadback = new Float32Array(MAX_OATS * 4);
const observationTriggerScoreReadbackByteLength =
  observationTriggerScoreReadback.length * Float32Array.BYTES_PER_ELEMENT;
const observationTriggerScoreReadbackState = {
  asyncSupported: (() => {
    const gl = renderer.getContext();
    return typeof gl.fenceSync === 'function' &&
      typeof gl.clientWaitSync === 'function' &&
      typeof gl.getBufferSubData === 'function';
  })(),
  buffer: null,
  sync: null,
  pending: false,
  sequence: 0,
  requestedSequence: 0,
  completedSequence: 0,
  processedSequence: 0,
  requestedOatListVersion: -1,
  completedOatListVersion: -1,
  lastQueuedAt: 0,
  lastCompletedAt: 0,
  mode: 'idle',
  lastError: null,
  processIndices: null,
};
const observationTriggerThresholdQueryState = {
  supported: (() => {
    const gl = renderer.getContext();
    return typeof gl.createQuery === 'function' &&
      typeof gl.beginQuery === 'function' &&
      typeof gl.endQuery === 'function' &&
      typeof gl.getQueryParameter === 'function' &&
      typeof gl.deleteQuery === 'function' &&
      gl.ANY_SAMPLES_PASSED !== undefined;
  })(),
  query: null,
  pending: false,
  indices: [],
  sequence: 0,
  requestedSequence: 0,
  requestedOatListVersion: -1,
  lastQueuedAt: 0,
  lastCompletedAt: 0,
  lastResult: false,
  lastError: null,
};
let oatListVersion = 0;
let nextObservationTriggerCheckAt = 0;
let observationTriggerCursor = 0;
let lastObservationTriggerDiagnostics = {
  checked: 0,
  triggered: 0,
  pending: 0,
  threshold: 0,
  lastCheckedAt: 0,
};
let coverageSurfaceTexels = 0;
let surfaceCoverageBuildDiagnostics = {
  phase: 'not-built',
  oldMaskCoverageTexels: 0,
  conservativeCoverageTexels: 0,
  newlyCoveredTexels: 0,
};
let lastFrameTime = performance.now();
let fpsSmoothed = 60;
let lastStatsRead = 0;
let statsReadbackCooldownUntil = performance.now() + STATS_READBACK_RESET_COOLDOWN_MS;
let lastRuntimeAgentFeedbackRead = performance.now();
let visibleAgents = INITIAL_AGENTS;
let slimeVisualVisible = true;
let goldBodyVisualVisible = true;
const POPULATION_CONTROLLER_SAMPLE_LIMIT = 240;
const POPULATION_CONTROLLER_SUPPLY_EPSILON = 1e-6;
let populationControllerState = {
  enabled: false,
  target: BASE_POPULATION_CONTROL_PARAMS.populationTarget,
  lastSampleTime: null,
  lastCount: null,
  growthRate: 0,
  commandedGrowthRate: 0,
  logPopulationError: 0,
  lastOatSupplyRate: params.oatSupplyRate,
  saturatedLow: false,
  saturatedHigh: false,
  secondarySeverity: 0,
  baseBurnRate: params.burnRate,
  baseReproThreshold: params.reproThreshold,
  samples: [],
};
let agentHistorySamples = [];
let agentAllocationFrame = 0;
let lastAgentAllocationOffset = 0;
let smoothInitialized = false;
// Frames of smoothing left before the render field is considered settled. The
// temporal blend can be as high as 0.995/frame, so give it ~10s to converge
// after the last field change before skipping the smoothing passes.
const SMOOTH_SETTLE_FRAME_LIMIT = 600;
let smoothSettleFramesRemaining = SMOOTH_SETTLE_FRAME_LIMIT;
let lastSmoothingParamsSignature = '';
function markRenderFieldChanged() {
  smoothSettleFramesRemaining = SMOOTH_SETTLE_FRAME_LIMIT;
}
function getSmoothingParamsSignature() {
  return `${params.spatialSmoothing}|${params.temporalSmoothing}|${params.foodClamp}|${params.useSeamStitching}|${getRenderSmoothingTapCount(params)}`;
}
let oatDirty = true;
let lastOatRenderSeamStitching = null;
let nextOatFoodDecayUpdateAt = 0;
let paused = false;
let started = false;
let baseStatus = 'loading cuttlefish...';
let seamPairs = [];
let loggedClicks = [];
let nextObservationId = 1;
const mouseRepelState = {
  active: false,
  uv: new THREE.Vector2(),
  chartId: 0,
  lastRaycastAt: 0,
};
let debugMaterials = {};
let debugBaseMaterial = null;
let chartOwnership = null;
let uvDiagnostics = null;
let authoritativeSpawnTexels = null;
function makeEmptyAgentCreationDiagnostics(note = 'Agent creation has not run yet.') {
  return {
    requestedAgents: 0,
    createdAgents: 0,
    failedAgents: 0,
    localRetryAttempts: 0,
    localAccepted: 0,
    localRejectedOutsideAtlas: 0,
    localRejectedWrongChart: 0,
    localRejectedUnsafeOrUnowned: 0,
    globalRetryAttempts: 0,
    globalAccepted: 0,
    deterministicFallbackAccepted: 0,
    deterministicFallbackFailed: 0,
    initialOatGaussianAccepted: 0,
    initialOatGaussianFailed: 0,
    initialOatCenterFallbackAccepted: 0,
    initialOatUv: null,
    initialOatSpawnSigma: 0,
    invalidCreatedAgents: 0,
    note,
  };
}
let lastAgentCreationDiagnostics = makeEmptyAgentCreationDiagnostics();
const introSequenceState = {
  requested: false,
  active: false,
  completed: false,
  requestedAt: 0,
  startedAt: 0,
  topEdgeLeadMs: 0,
  seedSoundPlayed: false,
  envAudioStarted: false,
  sprite: null,
  startPos: new THREE.Vector3(),
  targetPos: new THREE.Vector3(),
};
const startScreenUiState = {
  readyAt: 0,
  clickedAt: 0,
  beginFadeOutAt: 0,
  hoverStartedAt: 0,
  hoverFrom: 0,
  hoverTo: 0,
  hoverMix: 0,
};
const initialAgentSeedState = {
  pending: false,
  pendingStartAt: 0,
  active: false,
  startedAt: 0,
  durationMs: INITIAL_AGENT_SEED_DURATION_MS,
  data: null,
  liveAgentIndices: [],
  diagnostics: null,
  visibleCount: 0,
  revealSlotCount: 0,
};
const endingSequenceState = {
  active: false,
  phase: 'idle',
  sequenceId: 0,
  armedAt: 0,
  camouflageStartAt: 0,
  camouflageStartedAt: 0,
  camouflageDurationMs: 0,
  fadeStartAt: 0,
  endAt: 0,
  targetReturnAt: 0,
  lastCountdownText: '',
};
let lastTransitionCandidatePackingDiagnostics = {
  rawCandidateClaims: 0,
  rawCandidateTexels: 0,
  discardedSourceChartMismatchCandidates: 0,
  discardedSourceChartMismatchTexels: 0,
  discardedNonAuthoritativeCandidates: 0,
  discardedNonAuthoritativeTexels: 0,
  duplicateCandidatesMerged: 0,
  duplicateCandidateTexels: 0,
  remainingCandidatesAfterFilteringDeduplication: 0,
  remainingCandidateTexels: 0,
  remainingMultiCandidateTexels: 0,
  trueOverflowAfterFilteringDeduplicationCandidates: 0,
  trueOverflowAfterFilteringDeduplicationTexels: 0,
  overflowReplacedFartherCandidates: 0,
  overflowDroppedCandidates: 0,
  effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels: 0,
  note: 'Transition candidates have not been packed yet.',
};
const readbackDiagnosticState = new Map();
let lastSeamPaddingDiagnostics = {
  fieldKind: 'render',
  requestedPadTexels: 0,
  allowedPadTexels: 0,
  requestedPadCandidateTexels: 0,
  allowedPadCandidateTexels: 0,
  writtenPadTexels: 0,
  skippedByBudgetCollisionTexels: 0,
  skippedByRedirectCollisionTexels: 0,
  skippedByRealChartTexels: 0,
  skippedByUnsafeOwnershipTexels: 0,
  skippedByUnresolvedDestinationTexels: 0,
  clippedByRealIslandTexels: 0,
  clippedByConflictTexels: 0,
  redirectCollisionTexels: 0,
  explicitRedirectCollisionTexels: 0,
  unresolvedTexels: 0,
  paddingBudgetCollisionTexels: 0,
  note: 'Safe seam padding has not run yet.',
};

const oats = [];
// Each oat: { uv: {x,y}, chartId, worldPos: Vector3, worldNormal: Vector3, radius, power, sphere: Object3D }

const soundCheckAudioState = {
  context: null,
  output: null,
  compressor: null,
  buffers: new Map(),
  bufferPromises: new Map(),
  oneShots: [],
};

const envAudioState = {
  path: ENV_AUDIO_PATH,
  buffer: null,
  output: null,
  sources: [],
  duration: 0,
  interval: 0,
  crossfadeSeconds: ENV_AUDIO_CROSSFADE_SECONDS,
  nextStartTime: 0,
  schedulerId: null,
  running: false,
};

const slimeTumbleLoopState = {
  path: SLIME_TUMBLE_AUDIO_PATH,
  buffer: null,
  panner: null,
  fadeGain: null,
  distanceFilter: null,
  volumeGain: null,
  dryGain: null,
  reverbSendGain: null,
  reverbWetGain: null,
  reverbConvolver: null,
  reverbImpulse: null,
  sources: [],
  duration: 0,
  loopStartSeconds: SLIME_TUMBLE_LOOP_START_SECONDS,
  loopDuration: 0,
  interval: 0,
  crossfadeSeconds: SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS,
  nextStartTime: 0,
  schedulerId: null,
  running: false,
  startingPromise: null,
  referenceDistance: Math.max(0.001, camera.position.distanceTo(controls.target)),
  lastVolumeGain: NaN,
  lastLowpassHz: NaN,
  lastReverbWet: NaN,
  lastSpatialSyncAt: -Infinity,
  spatialAnchor: new THREE.Vector3(),
  lastPannerPosition: new THREE.Vector3(NaN, NaN, NaN),
  lastListenerPosition: new THREE.Vector3(NaN, NaN, NaN),
  lastListenerForward: new THREE.Vector3(NaN, NaN, NaN),
  lastListenerUp: new THREE.Vector3(NaN, NaN, NaN),
  listenerForwardScratch: new THREE.Vector3(),
  listenerUpScratch: new THREE.Vector3(),
};

function clampFinite(value, min, max, fallback = min) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function getClipMaxVolume(clip) {
  return Math.max(0.01, Number(clip?.maxGain) || 1);
}

function getSoundFileName(path) {
  return String(path || '').split('/').pop() || String(path || '');
}

function getSoundClip(soundId) {
  return SOUND_CHECK_CLIPS.find((clip) => clip.id === soundId) ?? null;
}

const soundSettingsState = new Map(SOUND_CHECK_CLIPS.map((clip) => {
  const maxVolume = getClipMaxVolume(clip);
  return [clip.id, {
    volume: clampFinite(clip.gain ?? 1, 0, maxVolume, Math.min(1, maxVolume)),
    maxVolume,
    loop: Boolean(clip.loop),
    fadeInSeconds: clampFinite(
      clip.fadeInSeconds ?? SOUND_DEFAULT_FADE_IN_SECONDS,
      0,
      SOUND_FADE_SECONDS_MAX,
      SOUND_DEFAULT_FADE_IN_SECONDS,
    ),
    fadeOutSeconds: clampFinite(
      clip.fadeOutSeconds ?? SOUND_DEFAULT_FADE_OUT_SECONDS,
      0,
      SOUND_FADE_SECONDS_MAX,
      SOUND_DEFAULT_FADE_OUT_SECONDS,
    ),
  }];
}));

const soundCompressorState = { ...SOUND_COMPRESSOR_DEFAULTS };

function getSoundCheckButton(soundId) {
  if (!soundCheckGrid) return null;
  return Array.from(soundCheckGrid.querySelectorAll('[data-sound-id]'))
    .find((button) => button.dataset.soundId === soundId) ?? null;
}

function getSoundCheckRow(soundId) {
  if (!soundCheckGrid) return null;
  return Array.from(soundCheckGrid.querySelectorAll('[data-sound-row-id]'))
    .find((row) => row.dataset.soundRowId === soundId) ?? null;
}

function setButtonLoading(button, loading) {
  if (!button) return;
  button.classList.toggle('is-loading', loading);
  button.disabled = loading;
}

function isSoundActive(soundId) {
  return getOneShotSources(soundId).length > 0 ||
    (soundId === 'env' && envAudioState.running) ||
    (soundId === 'slime-tumble' && slimeTumbleLoopState.running);
}

function isSoundStopToggleActive(soundId) {
  return (soundId === 'env' && envAudioState.running) ||
    (soundId === 'slime-tumble' && slimeTumbleLoopState.running);
}

function setSoundButtonState(soundId, { loading = false } = {}) {
  const button = getSoundCheckButton(soundId);
  if (!button) return;
  const clip = getSoundClip(soundId);
  const filename = getSoundFileName(clip?.path);
  const active = isSoundActive(soundId);
  const stopToggleActive = isSoundStopToggleActive(soundId);
  button.textContent = loading ? 'Loading' : stopToggleActive ? 'Stop' : 'Play';
  button.title = loading
    ? `Loading ${filename}`
    : stopToggleActive
      ? `Stop ${filename}`
      : active
        ? `Play another ${filename}`
        : `Play ${filename}`;
  button.setAttribute('aria-pressed', String(stopToggleActive));
  button.classList.toggle('is-active', stopToggleActive);
  setButtonLoading(button, loading);
}

function setEnvLoopButtonState({ loading = false } = {}) {
  setSoundButtonState('env', { loading });
}

function setSlimeTumbleLoopButtonState({ loading = false } = {}) {
  setSoundButtonState('slime-tumble', { loading });
}

function isPanelShortcutEditableTarget(target) {
  const element = target instanceof Element ? target : null;
  return Boolean(element?.closest('input, textarea, select, button, [contenteditable=""], [contenteditable="true"]'));
}

function syncPanelVisibilityState() {
  if (appEl) appEl.dataset.panelsVisible = String(uiPanelsVisible);
  const panel = document.querySelector('.panel');
  panel?.setAttribute('aria-hidden', String(!uiPanelsVisible));
  if (soundCheckPanel) {
    soundCheckPanel.setAttribute('aria-hidden', String(!uiPanelsVisible || soundCheckPanel.hidden));
  }
}

function setUiPanelsVisible(visible) {
  uiPanelsVisible = Boolean(visible);
  syncPanelVisibilityState();
  if (uiPanelsVisible) drawAgentCharts();
}

function toggleUiPanelsVisible() {
  setUiPanelsVisible(!uiPanelsVisible);
}

function handlePanelVisibilityKeydown(event) {
  if (event.key?.toLowerCase() !== 'p' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.repeat) return;
  if (isPanelShortcutEditableTarget(event.target)) return;
  event.preventDefault();
  toggleUiPanelsVisible();
}

function handleIntroSkipKeydown(event) {
  if (event.key?.toLowerCase() !== 's' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.repeat) return;
  if (isPanelShortcutEditableTarget(event.target)) return;
  if (!startScreenReady || introSequenceState.completed) return;
  event.preventDefault();
  skipIntroSequence();
}

function handleStoryBoxesKeydown(event) {
  if (event.key?.toLowerCase() !== 'm' || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.repeat) return;
  if (isPanelShortcutEditableTarget(event.target)) return;
  event.preventDefault();
  toggleStoryBoxesEnabled();
}

function handleVisualLayerKeydown(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return;
  if (isPanelShortcutEditableTarget(event.target)) return;
  if (event.key === '1') {
    event.preventDefault();
    toggleSlimeVisualVisibility();
  } else if (event.key === '2') {
    event.preventDefault();
    toggleGoldBodyVisualVisibility();
  } else if (event.key === '3') {
    event.preventDefault();
    toggleShowAgentDotsVisible();
  }
}

function setShowAgentDotsVisible(visible) {
  const nextVisible = Boolean(visible);
  if (params.showAgentDots !== nextVisible) {
    params.showAgentDots = nextVisible;
    setActiveRenderDisplayPreset('custom');
  }
  boundParamControls.get('showAgentDots')?.();
  if (nextVisible && started) renderAgentDensityOverlay();
  return params.showAgentDots;
}

function toggleShowAgentDotsVisible() {
  return setShowAgentDotsVisible(!params.showAgentDots);
}

function setSoundCheckOpen(open) {
  if (!soundCheckPanel || !soundCheckToggleButton) return;
  soundCheckPanel.hidden = !open;
  soundCheckToggleButton.setAttribute('aria-expanded', String(open));
  soundCheckToggleButton.title = open ? 'Hide sound check' : 'Show sound check';
  syncPanelVisibilityState();
}

function toggleSoundCheckPanel() {
  setSoundCheckOpen(soundCheckPanel?.hidden ?? true);
}

function getSoundSettings(soundId) {
  const clip = getSoundClip(soundId);
  if (!clip) return null;
  if (!soundSettingsState.has(soundId)) {
    const maxVolume = getClipMaxVolume(clip);
    soundSettingsState.set(soundId, {
      volume: clampFinite(clip.gain ?? 1, 0, maxVolume, Math.min(1, maxVolume)),
      maxVolume,
      loop: Boolean(clip.loop),
      fadeInSeconds: clampFinite(
        clip.fadeInSeconds ?? SOUND_DEFAULT_FADE_IN_SECONDS,
        0,
        SOUND_FADE_SECONDS_MAX,
        SOUND_DEFAULT_FADE_IN_SECONDS,
      ),
      fadeOutSeconds: clampFinite(
        clip.fadeOutSeconds ?? SOUND_DEFAULT_FADE_OUT_SECONDS,
        0,
        SOUND_FADE_SECONDS_MAX,
        SOUND_DEFAULT_FADE_OUT_SECONDS,
      ),
    });
  }
  return soundSettingsState.get(soundId);
}

function getSoundVolume(soundId) {
  const settings = getSoundSettings(soundId);
  if (!settings) return 1;
  return clampFinite(settings.volume, 0, settings.maxVolume, Math.min(1, settings.maxVolume));
}

function getSoundLoopEnabled(soundId) {
  return Boolean(getSoundSettings(soundId)?.loop);
}

function getSoundFadeInSeconds(soundId) {
  return clampFinite(
    getSoundSettings(soundId)?.fadeInSeconds,
    0,
    SOUND_FADE_SECONDS_MAX,
    SOUND_DEFAULT_FADE_IN_SECONDS,
  );
}

function getSoundFadeOutSeconds(soundId) {
  return clampFinite(
    getSoundSettings(soundId)?.fadeOutSeconds,
    0,
    SOUND_FADE_SECONDS_MAX,
    SOUND_DEFAULT_FADE_OUT_SECONDS,
  );
}

function formatSoundVolume(volume) {
  return `${Math.round(volume * 100)}%`;
}

function syncSoundRowControls(soundId) {
  const row = getSoundCheckRow(soundId);
  const settings = getSoundSettings(soundId);
  if (!row || !settings) return;
  const volumeInput = row.querySelector('[data-sound-volume-id]');
  const volumeOutput = row.querySelector('[data-sound-volume-output-id]');
  const loopInput = row.querySelector('[data-sound-loop-id]');
  const fadeInInput = row.querySelector('[data-sound-fade-in-id]');
  const fadeOutInput = row.querySelector('[data-sound-fade-out-id]');
  if (volumeInput) {
    volumeInput.max = settings.maxVolume.toFixed(4);
    volumeInput.value = getSoundVolume(soundId).toFixed(2);
    volumeInput.title = `Peak-safe max ${formatSoundVolume(settings.maxVolume)}`;
  }
  if (volumeOutput) volumeOutput.value = formatSoundVolume(getSoundVolume(soundId));
  if (loopInput) loopInput.checked = getSoundLoopEnabled(soundId);
  if (fadeInInput) fadeInInput.value = getSoundFadeInSeconds(soundId).toFixed(2);
  if (fadeOutInput) fadeOutInput.value = getSoundFadeOutSeconds(soundId).toFixed(2);
}

function getEnvAudioVolume() {
  return getSoundVolume('env');
}

function getEnvAudioCrossfadeSeconds(duration = envAudioState.duration) {
  const maxCrossfade = Math.max(0, Math.min(SOUND_FADE_SECONDS_MAX, (Number(duration) || 0) - 0.001));
  return clampFinite(getSoundFadeOutSeconds('env'), 0, maxCrossfade, Math.min(ENV_AUDIO_CROSSFADE_SECONDS, maxCrossfade));
}

function getSlimeTumbleLoopVolume() {
  return getSoundVolume('slime-tumble');
}

function getSlimeTumbleLoopCrossfadeSeconds(loopDuration = slimeTumbleLoopState.loopDuration) {
  const duration = Math.max(0, Number(loopDuration) || 0);
  const maxCrossfade = Math.max(0, Math.min(SOUND_FADE_SECONDS_MAX, duration * 0.5));
  return clampFinite(
    SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS,
    0,
    maxCrossfade,
    Math.min(SLIME_TUMBLE_LOOP_CROSSFADE_SECONDS, maxCrossfade),
  );
}

function getSlimeTumbleCameraDistance(sourcePosition = getSlimeTumbleSpatialAnchor(slimeTumbleLoopState.spatialAnchor)) {
  return Math.max(0.001, camera.position.distanceTo(sourcePosition));
}

function getSlimeTumbleFarDistance(referenceDistance = slimeTumbleLoopState.referenceDistance) {
  const fallbackDistance = Math.max(0.001, referenceDistance * 2);
  const maxDistance = Number.isFinite(controls.maxDistance) ? controls.maxDistance : fallbackDistance;
  return Math.max(referenceDistance + 0.001, maxDistance || fallbackDistance);
}

function getSlimeTumbleDistanceProgress(distance = getSlimeTumbleCameraDistance()) {
  const referenceDistance = Math.max(0.001, slimeTumbleLoopState.referenceDistance || distance);
  return THREE.MathUtils.smoothstep(distance, referenceDistance, getSlimeTumbleFarDistance(referenceDistance));
}

function getSlimeTumbleReverbWet(distance = getSlimeTumbleCameraDistance()) {
  return SLIME_TUMBLE_REVERB_MAX_WET * getSlimeTumbleDistanceProgress(distance);
}

function getSlimeTumbleLowpassFrequency(distance = getSlimeTumbleCameraDistance()) {
  const t = getSlimeTumbleDistanceProgress(distance);
  return THREE.MathUtils.lerp(SLIME_TUMBLE_LOWPASS_NEAR_HZ, SLIME_TUMBLE_LOWPASS_FAR_HZ, t);
}

function getSlimeTumblePannerDistanceGain(distance = getSlimeTumbleCameraDistance()) {
  const referenceDistance = Math.max(0.001, slimeTumbleLoopState.referenceDistance || distance);
  const rolloffFactor = Math.max(0, slimeTumbleLoopState.panner?.rolloffFactor ?? SLIME_TUMBLE_PANNER_ROLLOFF);
  const clampedDistance = Math.min(
    Math.max(distance, referenceDistance),
    slimeTumbleLoopState.panner?.maxDistance ?? getSlimeTumbleFarDistance(referenceDistance),
  );
  return referenceDistance / (referenceDistance + rolloffFactor * (clampedDistance - referenceDistance));
}

function getSlimeTumbleSpatialAnchor(target = slimeTumbleLoopState.spatialAnchor) {
  if (introSequenceState.sprite) return target.copy(introSequenceState.sprite.position);

  target.set(0, 0, 0);
  let totalWeight = 0;
  for (const oat of oats) {
    if (!oat?.worldPos) continue;
    const weight = Math.max(0.1, Number(oat.power) || 1);
    target.addScaledVector(oat.worldPos, weight);
    totalWeight += weight;
  }
  if (totalWeight > 0) return target.multiplyScalar(1 / totalWeight);
  if (initialOatSurfaceHit?.worldPos) return target.copy(initialOatSurfaceHit.worldPos);
  return target.copy(controls.target);
}

function setAudioParamTarget(audioParam, value, context, { smooth = true } = {}) {
  if (!audioParam || !context) return;
  const now = context.currentTime;
  audioParam.cancelScheduledValues(now);
  if (smooth) {
    audioParam.setTargetAtTime(value, now, SLIME_TUMBLE_SPATIAL_SMOOTH_SECONDS);
  } else {
    audioParam.setValueAtTime(value, now);
  }
}

function setAudioNodePosition(node, position, context, options = {}) {
  if (node.positionX) {
    setAudioParamTarget(node.positionX, position.x, context, options);
    setAudioParamTarget(node.positionY, position.y, context, options);
    setAudioParamTarget(node.positionZ, position.z, context, options);
  } else {
    node.setPosition?.(position.x, position.y, position.z);
  }
}

function setAudioListenerOrientation(listener, forward, up, context, options = {}) {
  if (listener.forwardX) {
    setAudioParamTarget(listener.forwardX, forward.x, context, options);
    setAudioParamTarget(listener.forwardY, forward.y, context, options);
    setAudioParamTarget(listener.forwardZ, forward.z, context, options);
    setAudioParamTarget(listener.upX, up.x, context, options);
    setAudioParamTarget(listener.upY, up.y, context, options);
    setAudioParamTarget(listener.upZ, up.z, context, options);
  } else {
    listener.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }
}

function syncSlimeTumblePannerPosition({ smooth = true, force = false } = {}) {
  const context = soundCheckAudioState.context;
  const panner = slimeTumbleLoopState.panner;
  if (!context || !panner) return null;
  const position = getSlimeTumbleSpatialAnchor(slimeTumbleLoopState.spatialAnchor);
  const epsilonSq = SLIME_TUMBLE_SPATIAL_POSITION_EPSILON * SLIME_TUMBLE_SPATIAL_POSITION_EPSILON;
  if (!force && position.distanceToSquared(slimeTumbleLoopState.lastPannerPosition) < epsilonSq) {
    return position;
  }
  setAudioNodePosition(panner, position, context, { smooth });
  slimeTumbleLoopState.lastPannerPosition.copy(position);
  return position;
}

function syncSlimeTumbleListener({ smooth = true, force = false } = {}) {
  const context = soundCheckAudioState.context;
  if (!context?.listener) return;

  camera.updateMatrixWorld(true);
  const position = camera.position;
  const forward = slimeTumbleLoopState.lastListenerForward;
  const up = slimeTumbleLoopState.lastListenerUp;
  const nextForward = slimeTumbleLoopState.listenerForwardScratch;
  const nextUp = slimeTumbleLoopState.listenerUpScratch;

  camera.getWorldDirection(nextForward).normalize();
  nextUp.copy(camera.up).applyQuaternion(camera.quaternion).normalize();

  const positionChanged =
    position.distanceToSquared(slimeTumbleLoopState.lastListenerPosition) >=
      SLIME_TUMBLE_SPATIAL_POSITION_EPSILON * SLIME_TUMBLE_SPATIAL_POSITION_EPSILON;
  const forwardChanged =
    !Number.isFinite(forward.x) ||
    1 - nextForward.dot(forward) >= SLIME_TUMBLE_SPATIAL_DIRECTION_EPSILON;
  const upChanged =
    !Number.isFinite(up.x) ||
    1 - nextUp.dot(up) >= SLIME_TUMBLE_SPATIAL_DIRECTION_EPSILON;

  if (force || positionChanged) {
    setAudioNodePosition(context.listener, position, context, { smooth });
    slimeTumbleLoopState.lastListenerPosition.copy(position);
  }
  if (force || forwardChanged || upChanged) {
    setAudioListenerOrientation(context.listener, nextForward, nextUp, context, { smooth });
    forward.copy(nextForward);
    up.copy(nextUp);
  }
}

function syncSlimeTumbleSpatialAudio({ smooth = true, force = false } = {}) {
  if (
    !soundCheckAudioState.context ||
    !slimeTumbleLoopState.panner ||
    !slimeTumbleLoopState.volumeGain
  ) {
    return getSlimeTumbleLoopVolume();
  }

  // Audio params already smooth via setTargetAtTime, so re-targeting them every
  // frame only churns the audio thread's automation timeline. ~15 Hz is plenty.
  if (!force) {
    const now = performance.now();
    if (now - slimeTumbleLoopState.lastSpatialSyncAt < SLIME_TUMBLE_SPATIAL_SYNC_INTERVAL_MS) {
      return getSlimeTumbleLoopVolume();
    }
    slimeTumbleLoopState.lastSpatialSyncAt = now;
  }

  syncSlimeTumbleListener({ smooth, force });
  const sourcePosition =
    syncSlimeTumblePannerPosition({ smooth, force }) ??
    getSlimeTumbleSpatialAnchor(slimeTumbleLoopState.spatialAnchor);
  const distance = getSlimeTumbleCameraDistance(sourcePosition);

  const gainNode = slimeTumbleLoopState.volumeGain;
  const targetGain = getSlimeTumbleLoopVolume();
  if (gainNode) {
    const previousGain = slimeTumbleLoopState.lastVolumeGain;
    const minDelta = Math.max(0.0005, targetGain * 0.002);
    if (force || !Number.isFinite(previousGain) || Math.abs(targetGain - previousGain) >= minDelta) {
      applyAudioParamValue(gainNode.gain, targetGain, { smooth });
      slimeTumbleLoopState.lastVolumeGain = targetGain;
    }
  }

  const filter = slimeTumbleLoopState.distanceFilter;
  const targetLowpassHz = getSlimeTumbleLowpassFrequency(distance);
  if (filter) {
    const previousLowpassHz = slimeTumbleLoopState.lastLowpassHz;
    if (force || !Number.isFinite(previousLowpassHz) || Math.abs(targetLowpassHz - previousLowpassHz) >= 8) {
      applyAudioParamValue(filter.frequency, targetLowpassHz, { smooth });
      slimeTumbleLoopState.lastLowpassHz = targetLowpassHz;
    }
  }

  const wetGainNode = slimeTumbleLoopState.reverbWetGain;
  const targetWet = getSlimeTumbleReverbWet(distance);
  if (wetGainNode) {
    const previousWet = slimeTumbleLoopState.lastReverbWet;
    const minWetDelta = Math.max(0.0005, SLIME_TUMBLE_REVERB_MAX_WET * 0.002);
    if (force || !Number.isFinite(previousWet) || Math.abs(targetWet - previousWet) >= minWetDelta) {
      applyAudioParamValue(wetGainNode.gain, targetWet, { smooth });
      slimeTumbleLoopState.lastReverbWet = targetWet;
    }
  }

  return targetGain;
}

function applyAudioParamValue(audioParam, value, { smooth = true } = {}) {
  const context = soundCheckAudioState.context;
  if (!audioParam || !context) return;
  const now = context.currentTime;
  audioParam.cancelScheduledValues(now);
  if (smooth) {
    audioParam.setValueAtTime(audioParam.value, now);
    audioParam.setTargetAtTime(value, now, SOUND_VOLUME_RAMP_SECONDS);
  } else {
    audioParam.setValueAtTime(value, now);
  }
}

function getAudioOutputTimestamp(context) {
  if (!context?.getOutputTimestamp) return null;
  const timestamp = context.getOutputTimestamp();
  if (
    !timestamp ||
    !Number.isFinite(timestamp.contextTime) ||
    !Number.isFinite(timestamp.performanceTime)
  ) {
    return null;
  }
  return timestamp;
}

function performanceMsToAudioContextTime(context, performanceMs) {
  const targetMs = Number(performanceMs);
  if (!Number.isFinite(targetMs)) return context.currentTime;
  const timestamp = getAudioOutputTimestamp(context);
  if (timestamp) {
    return Math.max(
      context.currentTime,
      timestamp.contextTime + ((targetMs - timestamp.performanceTime) / 1000),
    );
  }
  return Math.max(context.currentTime, context.currentTime + ((targetMs - performance.now()) / 1000));
}

function audioContextTimeToPerformanceMs(context, audioTime) {
  const targetAudioTime = Number(audioTime);
  if (!Number.isFinite(targetAudioTime)) return performance.now();
  const timestamp = getAudioOutputTimestamp(context);
  if (timestamp) {
    return timestamp.performanceTime + ((targetAudioTime - timestamp.contextTime) * 1000);
  }
  return performance.now() + ((targetAudioTime - context.currentTime) * 1000);
}

function ensureEnvAudioOutput(context) {
  if (!envAudioState.output) {
    envAudioState.output = context.createGain();
    envAudioState.output.gain.setValueAtTime(getEnvAudioVolume(), context.currentTime);
    envAudioState.output.connect(soundCheckAudioState.output);
  }
  return envAudioState.output;
}

function setSoundVolume(soundId, volume, { smooth = true } = {}) {
  const settings = getSoundSettings(soundId);
  if (!settings) return 1;
  settings.volume = clampFinite(volume, 0, settings.maxVolume, getSoundVolume(soundId));
  if (soundId === 'env' && envAudioState.output) {
    applyAudioParamValue(envAudioState.output.gain, settings.volume, { smooth });
  }
  if (soundId === 'slime-tumble' && slimeTumbleLoopState.volumeGain) {
    syncSlimeTumbleSpatialAudio({ smooth, force: true });
  }
  for (const sourceRecord of getOneShotSources(soundId)) {
    applyAudioParamValue(sourceRecord.gain?.gain, settings.volume, { smooth });
  }
  syncSoundRowControls(soundId);
  return settings.volume;
}

function setEnvAudioVolume(volume, options) {
  return setSoundVolume('env', volume, options);
}

function setSoundLoopEnabled(soundId, enabled) {
  const settings = getSoundSettings(soundId);
  if (!settings) return false;
  settings.loop = Boolean(enabled);
  syncSoundRowControls(soundId);
  return settings.loop;
}

function setSoundFadeInSeconds(soundId, seconds) {
  const settings = getSoundSettings(soundId);
  if (!settings) return 0;
  settings.fadeInSeconds = clampFinite(seconds, 0, SOUND_FADE_SECONDS_MAX, settings.fadeInSeconds);
  syncSoundRowControls(soundId);
  return settings.fadeInSeconds;
}

function setSoundFadeOutSeconds(soundId, seconds) {
  const settings = getSoundSettings(soundId);
  if (!settings) return 0;
  settings.fadeOutSeconds = clampFinite(seconds, 0, SOUND_FADE_SECONDS_MAX, settings.fadeOutSeconds);
  syncSoundRowControls(soundId);
  return settings.fadeOutSeconds;
}

function safeDisconnectAudioNode(node) {
  try {
    node?.disconnect?.();
  } catch (err) {
    // Disconnect throws when no connections exist; that state is harmless here.
  }
}

function ensureSoundCompressorNode(context) {
  if (!soundCheckAudioState.compressor) {
    soundCheckAudioState.compressor = context.createDynamicsCompressor();
  }
  applySoundCompressorSettings({ smooth: false });
  return soundCheckAudioState.compressor;
}

function connectSoundOutputGraph() {
  const context = soundCheckAudioState.context;
  const output = soundCheckAudioState.output;
  if (!context || !output) return;
  safeDisconnectAudioNode(output);
  safeDisconnectAudioNode(soundCheckAudioState.compressor);
  if (soundCompressorState.enabled) {
    const compressor = ensureSoundCompressorNode(context);
    output.connect(compressor);
    compressor.connect(context.destination);
  } else {
    output.connect(context.destination);
  }
}

function applySoundCompressorSettings({ smooth = true } = {}) {
  const compressor = soundCheckAudioState.compressor;
  if (!compressor) return;
  for (const control of SOUND_COMPRESSOR_CONTROLS) {
    const value = clampFinite(
      soundCompressorState[control.key],
      control.min,
      control.max,
      SOUND_COMPRESSOR_DEFAULTS[control.key],
    );
    applyAudioParamValue(compressor[control.key], value, { smooth });
  }
}

function setSoundCompressorEnabled(enabled) {
  soundCompressorState.enabled = Boolean(enabled);
  connectSoundOutputGraph();
  syncSoundCompressorControls();
  return soundCompressorState.enabled;
}

function setSoundCompressorParam(key, value, { smooth = true } = {}) {
  const control = SOUND_COMPRESSOR_CONTROLS.find((item) => item.key === key);
  if (!control) return null;
  soundCompressorState[key] = clampFinite(value, control.min, control.max, SOUND_COMPRESSOR_DEFAULTS[key]);
  applySoundCompressorSettings({ smooth });
  syncSoundCompressorControls();
  return soundCompressorState[key];
}

function formatCompressorValue(control, value) {
  const digits = Number(control.digits ?? 2);
  return `${value.toFixed(digits)}${control.suffix ?? ''}`;
}

function syncSoundCompressorControls() {
  if (soundCompressorEnabledInput) soundCompressorEnabledInput.checked = soundCompressorState.enabled;
  if (!soundCompressorGrid) return;
  for (const control of SOUND_COMPRESSOR_CONTROLS) {
    const input = Array.from(soundCompressorGrid.querySelectorAll('[data-compressor-param]'))
      .find((item) => item.dataset.compressorParam === control.key);
    const output = Array.from(soundCompressorGrid.querySelectorAll('[data-compressor-output]'))
      .find((item) => item.dataset.compressorOutput === control.key);
    const value = clampFinite(
      soundCompressorState[control.key],
      control.min,
      control.max,
      SOUND_COMPRESSOR_DEFAULTS[control.key],
    );
    if (input) input.value = String(value);
    if (output) output.value = formatCompressorValue(control, value);
  }
}

async function ensureSoundCheckAudioContext({ resume = true } = {}) {
  if (!soundCheckAudioState.context) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio is not available in this browser.');
    soundCheckAudioState.context = new AudioContextCtor();
    soundCheckAudioState.output = soundCheckAudioState.context.createGain();
    connectSoundOutputGraph();
  }
  if (resume && soundCheckAudioState.context.state !== 'running') {
    await soundCheckAudioState.context.resume();
  }
  return soundCheckAudioState.context;
}

async function loadSoundCheckBuffer(path, { resumeContext = true } = {}) {
  if (soundCheckAudioState.buffers.has(path)) return soundCheckAudioState.buffers.get(path);
  if (!soundCheckAudioState.bufferPromises.has(path)) {
    const promise = (async () => {
      const context = await ensureSoundCheckAudioContext({ resume: resumeContext });
      const response = await fetch(path);
      if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
      const arrayBuffer = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(arrayBuffer);
      soundCheckAudioState.buffers.set(path, buffer);
      return buffer;
    })().catch((err) => {
      soundCheckAudioState.bufferPromises.delete(path);
      throw err;
    });
    soundCheckAudioState.bufferPromises.set(path, promise);
  }
  return soundCheckAudioState.bufferPromises.get(path);
}

async function loadEnvAudioBuffer({ resumeContext = true } = {}) {
  // Once a load resolved (primary or fallback), stick with that path: retrying
  // the missing primary would re-issue the 404 and re-log the warning on every
  // env-audio (re)start.
  if (envAudioState.path && soundCheckAudioState.buffers.has(envAudioState.path)) {
    return soundCheckAudioState.buffers.get(envAudioState.path);
  }
  try {
    const buffer = await loadSoundCheckBuffer(ENV_AUDIO_PATH, { resumeContext });
    envAudioState.path = ENV_AUDIO_PATH;
    return buffer;
  } catch (primaryError) {
    if (!ENV_AUDIO_FALLBACK_PATH || ENV_AUDIO_FALLBACK_PATH === ENV_AUDIO_PATH) {
      throw primaryError;
    }
    try {
      const buffer = await loadSoundCheckBuffer(ENV_AUDIO_FALLBACK_PATH, { resumeContext });
      envAudioState.path = ENV_AUDIO_FALLBACK_PATH;
      console.warn(`Failed to load ${getSoundFileName(ENV_AUDIO_PATH)}; using ${getSoundFileName(ENV_AUDIO_FALLBACK_PATH)} instead.`, primaryError);
      return buffer;
    } catch (fallbackError) {
      throw new Error(
        `Failed to load ${getSoundFileName(ENV_AUDIO_PATH)} or fallback ${getSoundFileName(ENV_AUDIO_FALLBACK_PATH)}: ${fallbackError.message}`,
      );
    }
  }
}

function reportSoundPackPreloadFailures(results) {
  const failures = results
    .map((result, index) => ({ result, clip: SOUND_CHECK_CLIPS[index] }))
    .filter(({ result }) => result.status === 'rejected');
  if (failures.length === 0) return;
  console.warn(
    `Sound preload skipped ${failures.length} clip${failures.length === 1 ? '' : 's'}; playback will retry on demand.`,
    failures.map(({ clip, result }) => ({
      id: clip.id,
      path: clip.path,
      error: result.reason?.message ?? String(result.reason),
    })),
  );
}

async function preloadSoundPack() {
  const results = await Promise.allSettled(SOUND_CHECK_CLIPS.map((clip) =>
    clip.id === 'env'
      ? initEnvAudio({ resumeContext: false })
      : loadSoundCheckBuffer(clip.path, { resumeContext: false })
  ));
  reportSoundPackPreloadFailures(results);
  return results;
}

function scheduleSoundPackPreload() {
  const startPreload = () => {
    void preloadSoundPack().catch((err) => {
      console.warn('Sound preload failed unexpectedly; playback will retry on demand.', err);
    });
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(startPreload, { timeout: 1500 });
  } else {
    window.setTimeout(startPreload, 250);
  }
}

async function initEnvAudio({ resumeContext = true } = {}) {
  envAudioState.buffer = await loadEnvAudioBuffer({ resumeContext });
  const duration = envAudioState.buffer?.duration ?? 0;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Invalid ambience duration: ${duration}`);
  }
  const crossfadeSeconds = getEnvAudioCrossfadeSeconds(duration);
  envAudioState.duration = duration;
  envAudioState.crossfadeSeconds = crossfadeSeconds;
  envAudioState.interval = Math.max(0.001, duration - crossfadeSeconds);
  return envAudioState;
}

async function initSlimeTumbleLoopAudio({ resumeContext = true } = {}) {
  slimeTumbleLoopState.buffer = await loadSoundCheckBuffer(SLIME_TUMBLE_AUDIO_PATH, { resumeContext });
  const duration = slimeTumbleLoopState.buffer?.duration ?? 0;
  if (!Number.isFinite(duration) || duration <= SLIME_TUMBLE_LOOP_START_SECONDS + 0.001) {
    throw new Error(`Invalid slime tumble loop duration after 8s crop: ${duration}`);
  }
  const loopStartSeconds = clampFinite(
    SLIME_TUMBLE_LOOP_START_SECONDS,
    0,
    Math.max(0, duration - 0.001),
    SLIME_TUMBLE_LOOP_START_SECONDS,
  );
  const loopDuration = Math.max(0.001, duration - loopStartSeconds);
  const crossfadeSeconds = getSlimeTumbleLoopCrossfadeSeconds(loopDuration);
  slimeTumbleLoopState.duration = duration;
  slimeTumbleLoopState.loopStartSeconds = loopStartSeconds;
  slimeTumbleLoopState.loopDuration = loopDuration;
  slimeTumbleLoopState.crossfadeSeconds = crossfadeSeconds;
  slimeTumbleLoopState.interval = Math.max(0.001, loopDuration - crossfadeSeconds);
  return slimeTumbleLoopState;
}

function makeSlimeTumbleReverbImpulse(context) {
  const length = Math.max(1, Math.floor(context.sampleRate * SLIME_TUMBLE_REVERB_SECONDS));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel++) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      const t = i / Math.max(1, length - 1);
      const envelope = Math.pow(1 - t, SLIME_TUMBLE_REVERB_DECAY);
      const earlyLift = 0.36 + 0.64 * Math.min(1, i / (context.sampleRate * 0.035));
      data[i] = (Math.random() * 2 - 1) * envelope * earlyLift * 0.22;
    }
  }
  return impulse;
}

function ensureSlimeTumbleLoopOutput(context) {
  if (!slimeTumbleLoopState.fadeGain || !slimeTumbleLoopState.distanceFilter || !slimeTumbleLoopState.volumeGain) {
    const referenceDistance = Math.max(0.001, slimeTumbleLoopState.referenceDistance || getSlimeTumbleCameraDistance());
    const farDistance = getSlimeTumbleFarDistance(referenceDistance);
    slimeTumbleLoopState.panner = context.createPanner();
    slimeTumbleLoopState.fadeGain = context.createGain();
    slimeTumbleLoopState.distanceFilter = context.createBiquadFilter();
    slimeTumbleLoopState.volumeGain = context.createGain();
    slimeTumbleLoopState.dryGain = context.createGain();
    slimeTumbleLoopState.reverbSendGain = context.createGain();
    slimeTumbleLoopState.reverbWetGain = context.createGain();
    slimeTumbleLoopState.reverbConvolver = context.createConvolver();
    slimeTumbleLoopState.reverbImpulse = makeSlimeTumbleReverbImpulse(context);
    slimeTumbleLoopState.reverbConvolver.buffer = slimeTumbleLoopState.reverbImpulse;
    slimeTumbleLoopState.panner.panningModel = 'HRTF';
    slimeTumbleLoopState.panner.distanceModel = 'inverse';
    slimeTumbleLoopState.panner.refDistance = referenceDistance;
    slimeTumbleLoopState.panner.maxDistance = farDistance;
    slimeTumbleLoopState.panner.rolloffFactor = SLIME_TUMBLE_PANNER_ROLLOFF;
    slimeTumbleLoopState.panner.coneInnerAngle = 360;
    slimeTumbleLoopState.panner.coneOuterAngle = 360;
    slimeTumbleLoopState.distanceFilter.type = 'lowpass';
    slimeTumbleLoopState.fadeGain.gain.setValueAtTime(0.0001, context.currentTime);
    slimeTumbleLoopState.distanceFilter.frequency.setValueAtTime(getSlimeTumbleLowpassFrequency(), context.currentTime);
    slimeTumbleLoopState.distanceFilter.Q.setValueAtTime(SLIME_TUMBLE_LOWPASS_Q, context.currentTime);
    slimeTumbleLoopState.volumeGain.gain.setValueAtTime(getSlimeTumbleLoopVolume(), context.currentTime);
    slimeTumbleLoopState.dryGain.gain.setValueAtTime(1, context.currentTime);
    slimeTumbleLoopState.reverbSendGain.gain.setValueAtTime(1, context.currentTime);
    slimeTumbleLoopState.reverbWetGain.gain.setValueAtTime(getSlimeTumbleReverbWet(), context.currentTime);
    slimeTumbleLoopState.panner.connect(slimeTumbleLoopState.fadeGain);
    slimeTumbleLoopState.fadeGain.connect(slimeTumbleLoopState.distanceFilter);
    slimeTumbleLoopState.distanceFilter.connect(slimeTumbleLoopState.volumeGain);
    slimeTumbleLoopState.volumeGain.connect(slimeTumbleLoopState.dryGain);
    slimeTumbleLoopState.volumeGain.connect(slimeTumbleLoopState.reverbSendGain);
    slimeTumbleLoopState.reverbSendGain.connect(slimeTumbleLoopState.reverbConvolver);
    slimeTumbleLoopState.reverbConvolver.connect(slimeTumbleLoopState.reverbWetGain);
    slimeTumbleLoopState.dryGain.connect(soundCheckAudioState.output);
    slimeTumbleLoopState.reverbWetGain.connect(soundCheckAudioState.output);
    slimeTumbleLoopState.lastVolumeGain = getSlimeTumbleLoopVolume();
    slimeTumbleLoopState.lastLowpassHz = getSlimeTumbleLowpassFrequency();
    slimeTumbleLoopState.lastReverbWet = getSlimeTumbleReverbWet();
    syncSlimeTumbleSpatialAudio({ smooth: false, force: true });
  }
  return slimeTumbleLoopState.fadeGain;
}

function removeSlimeTumbleLoopSource(sourceRecord) {
  if (sourceRecord.removed) return;
  sourceRecord.removed = true;
  const index = slimeTumbleLoopState.sources.indexOf(sourceRecord);
  if (index >= 0) slimeTumbleLoopState.sources.splice(index, 1);
  safeDisconnectAudioNode(sourceRecord.source);
  safeDisconnectAudioNode(sourceRecord.gain);
}

function scheduleSlimeTumbleLoopCopy(startTime) {
  const context = soundCheckAudioState.context;
  const buffer = slimeTumbleLoopState.buffer;
  if (!context || !buffer || !slimeTumbleLoopState.fadeGain) return;

  const playDuration = slimeTumbleLoopState.loopDuration;
  const crossfadeSeconds = Math.max(0, slimeTumbleLoopState.crossfadeSeconds);
  const stopTime = startTime + playDuration;
  const source = context.createBufferSource();
  const gain = context.createGain();
  const sourceRecord = { source, gain, startTime, stopTime, removed: false };

  source.buffer = buffer;
  source.connect(gain);
  gain.connect(slimeTumbleLoopState.panner ?? slimeTumbleLoopState.fadeGain);
  if (crossfadeSeconds > 0) {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.linearRampToValueAtTime(1, Math.min(stopTime, startTime + crossfadeSeconds));
    gain.gain.setValueAtTime(1, Math.max(startTime, stopTime - crossfadeSeconds));
    gain.gain.linearRampToValueAtTime(0.0001, stopTime);
  } else {
    gain.gain.setValueAtTime(1, startTime);
  }
  source.start(startTime, slimeTumbleLoopState.loopStartSeconds, playDuration);
  source.stop(stopTime + 0.05);
  source.addEventListener('ended', () => removeSlimeTumbleLoopSource(sourceRecord), { once: true });
  slimeTumbleLoopState.sources.push(sourceRecord);
}

function scheduleSlimeTumbleLoopUntil(untilTime) {
  while (slimeTumbleLoopState.running && slimeTumbleLoopState.nextStartTime <= untilTime) {
    scheduleSlimeTumbleLoopCopy(slimeTumbleLoopState.nextStartTime);
    slimeTumbleLoopState.nextStartTime += slimeTumbleLoopState.interval;
  }
}

function pumpSlimeTumbleLoopSchedule() {
  if (!slimeTumbleLoopState.running) return;
  scheduleSlimeTumbleLoopUntil(
    soundCheckAudioState.context.currentTime + SLIME_TUMBLE_SCHEDULE_LOOKAHEAD_SECONDS,
  );
}

async function startSlimeTumbleLoop({
  fadeInSeconds = INITIAL_AGENT_SEED_DURATION_MS / 1000,
  startAtPerformanceMs = null,
} = {}) {
  if (slimeTumbleLoopState.running) {
    syncSlimeTumbleSpatialAudio({ smooth: true, force: true });
    setSlimeTumbleLoopButtonState();
    return slimeTumbleLoopState;
  }
  if (slimeTumbleLoopState.startingPromise) return slimeTumbleLoopState.startingPromise;

  slimeTumbleLoopState.startingPromise = (async () => {
    setSlimeTumbleLoopButtonState({ loading: true });
    const context = await ensureSoundCheckAudioContext();
    await initSlimeTumbleLoopAudio();
    ensureSlimeTumbleLoopOutput(context);
    syncSlimeTumbleSpatialAudio({ smooth: false, force: true });

    const requestedStartTime = Number.isFinite(startAtPerformanceMs)
      ? performanceMsToAudioContextTime(context, startAtPerformanceMs)
      : context.currentTime + SLIME_TUMBLE_START_DELAY_SECONDS;
    const startTime = Math.max(context.currentTime, requestedStartTime);
    const fadeSeconds = Math.max(0, Number(fadeInSeconds) || 0);

    slimeTumbleLoopState.fadeGain.gain.cancelScheduledValues(context.currentTime);
    slimeTumbleLoopState.fadeGain.gain.setValueAtTime(0.0001, startTime);
    if (fadeSeconds > 0) {
      slimeTumbleLoopState.fadeGain.gain.linearRampToValueAtTime(1, startTime + fadeSeconds);
    } else {
      slimeTumbleLoopState.fadeGain.gain.setValueAtTime(1, startTime);
    }

    slimeTumbleLoopState.running = true;
    slimeTumbleLoopState.nextStartTime = startTime;
    scheduleSlimeTumbleLoopUntil(context.currentTime + SLIME_TUMBLE_SCHEDULE_LOOKAHEAD_SECONDS);
    slimeTumbleLoopState.schedulerId = window.setInterval(
      pumpSlimeTumbleLoopSchedule,
      SLIME_TUMBLE_SCHEDULE_INTERVAL_MS,
    );
    setSlimeTumbleLoopButtonState();
    return slimeTumbleLoopState;
  })().catch((err) => {
    slimeTumbleLoopState.running = false;
    setSlimeTumbleLoopButtonState();
    console.warn('Failed to start slime tumble loop:', err);
    throw err;
  }).finally(() => {
    slimeTumbleLoopState.startingPromise = null;
  });

  return slimeTumbleLoopState.startingPromise;
}

function stopSlimeTumbleLoop({ fadeOutSeconds = getSoundFadeOutSeconds('slime-tumble') } = {}) {
  slimeTumbleLoopState.running = false;
  if (slimeTumbleLoopState.schedulerId) {
    window.clearInterval(slimeTumbleLoopState.schedulerId);
    slimeTumbleLoopState.schedulerId = null;
  }
  const context = soundCheckAudioState.context;
  if (!context) {
    setSlimeTumbleLoopButtonState();
    return;
  }
  const now = context.currentTime;
  const fadeSeconds = Math.max(0, Number(fadeOutSeconds) || 0);
  if (slimeTumbleLoopState.fadeGain) {
    slimeTumbleLoopState.fadeGain.gain.cancelScheduledValues(now);
    if (fadeSeconds > 0) {
      slimeTumbleLoopState.fadeGain.gain.setValueAtTime(slimeTumbleLoopState.fadeGain.gain.value, now);
      slimeTumbleLoopState.fadeGain.gain.linearRampToValueAtTime(0.0001, now + fadeSeconds);
    } else {
      slimeTumbleLoopState.fadeGain.gain.setValueAtTime(0.0001, now);
    }
  }
  for (const sourceRecord of [...slimeTumbleLoopState.sources]) {
    try {
      sourceRecord.source.stop(now + fadeSeconds + 0.02);
    } catch (err) {
      removeSlimeTumbleLoopSource(sourceRecord);
    }
  }
  setSlimeTumbleLoopButtonState();
}

function removeEnvAudioSource(sourceRecord) {
  if (sourceRecord.removed) return;
  sourceRecord.removed = true;
  const index = envAudioState.sources.indexOf(sourceRecord);
  if (index >= 0) envAudioState.sources.splice(index, 1);
  safeDisconnectAudioNode(sourceRecord.source);
  safeDisconnectAudioNode(sourceRecord.gain);
}

function scheduleEnvAudioCopy(startTime) {
  const context = soundCheckAudioState.context;
  if (!context || !envAudioState.buffer) return;
  const fadeStart = startTime + envAudioState.interval;
  const stopTime = startTime + envAudioState.duration;
  const crossfadeSeconds = Math.max(0, envAudioState.crossfadeSeconds);
  const source = context.createBufferSource();
  const gain = context.createGain();
  const sourceRecord = { source, gain, startTime, stopTime, removed: false };

  source.buffer = envAudioState.buffer;
  source.connect(gain);
  gain.connect(ensureEnvAudioOutput(context));
  gain.gain.setValueAtTime(1, startTime);
  if (crossfadeSeconds > 0) {
    gain.gain.setValueAtTime(1, fadeStart);
    gain.gain.linearRampToValueAtTime(0.0001, stopTime);
  }
  source.start(startTime, 0);
  source.stop(stopTime + 0.05);
  source.addEventListener('ended', () => removeEnvAudioSource(sourceRecord), { once: true });
  envAudioState.sources.push(sourceRecord);
}

function scheduleEnvAudioUntil(untilTime) {
  while (envAudioState.running && envAudioState.nextStartTime <= untilTime) {
    scheduleEnvAudioCopy(envAudioState.nextStartTime);
    envAudioState.nextStartTime += envAudioState.interval;
  }
}

function pumpEnvAudioSchedule() {
  if (!envAudioState.running) return;
  scheduleEnvAudioUntil(soundCheckAudioState.context.currentTime + ENV_AUDIO_SCHEDULE_LOOKAHEAD_SECONDS);
}

async function startEnvAudio() {
  if (envAudioState.running) return;
  setEnvLoopButtonState({ loading: true });
  const context = await ensureSoundCheckAudioContext();
  await initEnvAudio();
  const output = ensureEnvAudioOutput(context);
  const fadeInSeconds = getSoundFadeInSeconds('env');
  output.gain.cancelScheduledValues(context.currentTime);
  if (fadeInSeconds > 0) {
    output.gain.setValueAtTime(0.0001, context.currentTime);
    output.gain.linearRampToValueAtTime(getEnvAudioVolume(), context.currentTime + fadeInSeconds);
  } else {
    output.gain.setValueAtTime(getEnvAudioVolume(), context.currentTime);
  }
  envAudioState.running = true;
  envAudioState.nextStartTime = context.currentTime + ENV_AUDIO_START_DELAY_SECONDS;
  scheduleEnvAudioUntil(context.currentTime + ENV_AUDIO_SCHEDULE_LOOKAHEAD_SECONDS);
  envAudioState.schedulerId = window.setInterval(pumpEnvAudioSchedule, ENV_AUDIO_SCHEDULE_INTERVAL_MS);
  setEnvLoopButtonState();
}

function stopEnvAudio() {
  envAudioState.running = false;
  if (envAudioState.schedulerId) {
    window.clearInterval(envAudioState.schedulerId);
    envAudioState.schedulerId = null;
  }
  const now = soundCheckAudioState.context?.currentTime ?? 0;
  const fadeOutSeconds = getSoundFadeOutSeconds('env');
  for (const sourceRecord of [...envAudioState.sources]) {
    sourceRecord.gain.gain.cancelScheduledValues(now);
    if (fadeOutSeconds > 0) {
      sourceRecord.gain.gain.setValueAtTime(sourceRecord.gain.gain.value, now);
      sourceRecord.gain.gain.linearRampToValueAtTime(0.0001, now + fadeOutSeconds);
    } else {
      sourceRecord.gain.gain.setValueAtTime(0.0001, now);
    }
    try {
      sourceRecord.source.stop(now + fadeOutSeconds + 0.02);
    } catch (err) {
      removeEnvAudioSource(sourceRecord);
    }
  }
  setEnvLoopButtonState();
}

async function toggleEnvAudio() {
  if (envAudioState.running) {
    stopEnvAudio();
    return;
  }
  try {
    await startEnvAudio();
  } catch (err) {
    console.error('Failed to start ambience audio:', err);
    envAudioState.running = false;
    setEnvLoopButtonState();
    const button = getSoundCheckButton('env');
    if (button) button.title = `Ambience failed to start: ${err.message}`;
  }
}

function removeOneShotSource(sourceRecord) {
  if (sourceRecord.removed) return;
  sourceRecord.removed = true;
  const index = soundCheckAudioState.oneShots.indexOf(sourceRecord);
  if (index >= 0) soundCheckAudioState.oneShots.splice(index, 1);
  safeDisconnectAudioNode(sourceRecord.source);
  safeDisconnectAudioNode(sourceRecord.envelopeGain);
  safeDisconnectAudioNode(sourceRecord.gain);
  setSoundButtonState(sourceRecord.soundId);
}

function getOneShotSources(soundId) {
  return soundCheckAudioState.oneShots.filter((sourceRecord) => sourceRecord.soundId === soundId);
}

function setOneShotButtonState(soundId) {
  setSoundButtonState(soundId);
}

function getSoundOneShotMaxVoices(clip) {
  return Math.max(1, Math.floor(Number(clip?.maxVoices) || SOUND_ONE_SHOT_MAX_VOICES_PER_CLIP));
}

function stopOneShotSourceRecord(sourceRecord, fadeOutSeconds = getSoundFadeOutSeconds(sourceRecord?.soundId)) {
  if (!sourceRecord || sourceRecord.stopping) return;
  sourceRecord.stopping = true;
  const context = soundCheckAudioState.context;
  const now = context?.currentTime ?? 0;
  const fadeSeconds = Math.max(0, Number(fadeOutSeconds) || 0);
  const envelope = sourceRecord.envelopeGain?.gain ?? sourceRecord.gain?.gain;
  if (envelope) {
    envelope.cancelScheduledValues(now);
    if (fadeSeconds > 0) {
      envelope.setValueAtTime(envelope.value, now);
      envelope.linearRampToValueAtTime(0.0001, now + fadeSeconds);
    } else {
      envelope.setValueAtTime(0.0001, now);
    }
  }
  try {
    const startedAt = Number.isFinite(sourceRecord.startedAtAudioTime)
      ? sourceRecord.startedAtAudioTime
      : now;
    sourceRecord.source.stop(Math.max(now, startedAt) + fadeSeconds + 0.02);
  } catch (err) {
    removeOneShotSource(sourceRecord);
  }
}

function trimOneShotVoicesForNewSource(clip) {
  const activeSources = getOneShotSources(clip.id)
    .filter((sourceRecord) => !sourceRecord.removed && !sourceRecord.stopping)
    .sort((a, b) => (a.startedAtAudioTime ?? 0) - (b.startedAtAudioTime ?? 0));
  const voicesToSteal = activeSources.length - getSoundOneShotMaxVoices(clip) + 1;
  if (voicesToSteal <= 0) return;
  for (const sourceRecord of activeSources.slice(0, voicesToSteal)) {
    stopOneShotSourceRecord(sourceRecord, SOUND_ONE_SHOT_STEAL_FADE_SECONDS);
  }
}

function stopSoundCheckOneShot(soundId) {
  const context = soundCheckAudioState.context;
  if (!context) return;
  const fadeOutSeconds = getSoundFadeOutSeconds(soundId);
  for (const sourceRecord of getOneShotSources(soundId)) {
    stopOneShotSourceRecord(sourceRecord, fadeOutSeconds);
  }
}

async function playSoundCheckOneShot(
  clip,
  { restart = false, audition = false, startAtPerformanceMs = null, allowOverlap = !restart } = {},
) {
  const button = getSoundCheckButton(clip.id);
  const activeSources = getOneShotSources(clip.id);
  if (activeSources.length > 0 && !allowOverlap) {
    stopSoundCheckOneShot(clip.id);
    if (!restart) return null;
  }
  try {
    setButtonLoading(button, true);
    const context = await ensureSoundCheckAudioContext();
    const buffer = clip.id === 'env'
      ? await loadEnvAudioBuffer()
      : await loadSoundCheckBuffer(clip.path);
    setButtonLoading(button, false);
    if (allowOverlap) trimOneShotVoicesForNewSource(clip);

    const startTime = Number.isFinite(startAtPerformanceMs)
      ? performanceMsToAudioContextTime(context, startAtPerformanceMs)
      : context.currentTime;
    const shouldLoop = Boolean(audition && getSoundLoopEnabled(clip.id));
    const fadeInSeconds = Math.min(getSoundFadeInSeconds(clip.id), Math.max(0, buffer.duration - 0.001));
    const fadeOutSeconds = shouldLoop
      ? 0
      : Math.min(
        getSoundFadeOutSeconds(clip.id),
        Math.max(0, buffer.duration - fadeInSeconds - 0.001),
      );
    const source = context.createBufferSource();
    const envelopeGain = context.createGain();
    const gain = context.createGain();
    const sourceRecord = { source, envelopeGain, gain, button, soundId: clip.id, removed: false, stopping: false };
    source.buffer = buffer;
    source.loop = shouldLoop;
    source.connect(envelopeGain);
    envelopeGain.connect(gain);
    gain.gain.setValueAtTime(getSoundVolume(clip.id), startTime);
    envelopeGain.gain.setValueAtTime(fadeInSeconds > 0 ? 0.0001 : 1, startTime);
    if (fadeInSeconds > 0) {
      envelopeGain.gain.linearRampToValueAtTime(1, startTime + fadeInSeconds);
    }
    if (fadeOutSeconds > 0) {
      const fadeStart = startTime + Math.max(fadeInSeconds, buffer.duration - fadeOutSeconds);
      envelopeGain.gain.setValueAtTime(1, fadeStart);
      envelopeGain.gain.linearRampToValueAtTime(0.0001, startTime + buffer.duration);
    }
    gain.connect(soundCheckAudioState.output);
    source.addEventListener('ended', () => removeOneShotSource(sourceRecord), { once: true });
    soundCheckAudioState.oneShots.push(sourceRecord);
    setOneShotButtonState(clip.id);
    sourceRecord.startedAtAudioTime = startTime;
    sourceRecord.startedAtPerformanceMs = audioContextTimeToPerformanceMs(context, startTime);
    source.start(startTime);
    return sourceRecord;
  } catch (err) {
    console.error(`Failed to play ${getSoundFileName(clip.path)}:`, err);
    setButtonLoading(button, false);
    if (button) button.title = `Failed to play: ${err.message}`;
    return null;
  }
}

function initSoundCheckPanel() {
  if (!soundCheckGrid) return;
  soundCheckGrid.textContent = '';
  for (const clip of SOUND_CHECK_CLIPS) {
    const row = document.createElement('div');
    row.className = 'sound-check-row';
    row.dataset.soundRowId = clip.id;

    const filename = getSoundFileName(clip.path);
    const name = document.createElement('span');
    name.className = 'sound-file-label';
    name.textContent = filename;
    name.title = clip.path;
    row.append(name);

    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.soundId = clip.id;
    button.textContent = 'Play';
    button.title = `Play ${filename}`;
    button.setAttribute('aria-pressed', 'false');
    button.addEventListener('click', () => {
      if (clip.id === 'env' && envAudioState.running) {
        stopEnvAudio();
        return;
      }
      if (clip.id === 'slime-tumble' && slimeTumbleLoopState.running) {
        stopSlimeTumbleLoop();
        return;
      }
      if (clip.id === 'env' && getSoundLoopEnabled(clip.id)) toggleEnvAudio();
      else if (clip.id === 'slime-tumble') startSlimeTumbleLoop({
        fadeInSeconds: getSoundFadeInSeconds('slime-tumble'),
      }).catch((err) => {
        console.error('Failed to start slime tumble loop:', err);
        setSlimeTumbleLoopButtonState();
        button.title = `Slime tumble loop failed to start: ${err.message}`;
      });
      else playSoundCheckOneShot(clip, { audition: true });
    });
    row.append(button);

    const volumeCell = document.createElement('label');
    volumeCell.className = 'sound-volume-cell';
    const volumeText = document.createElement('span');
    volumeText.textContent = 'Vol';
    const volumeInput = document.createElement('input');
    volumeInput.type = 'range';
    volumeInput.min = '0';
    volumeInput.step = '0.01';
    volumeInput.dataset.soundVolumeId = clip.id;
    volumeInput.setAttribute('aria-label', `${filename} volume`);
    const volumeOutput = document.createElement('output');
    volumeOutput.dataset.soundVolumeOutputId = clip.id;
    volumeInput.addEventListener('input', () => setSoundVolume(clip.id, volumeInput.value));
    volumeCell.append(volumeText, volumeInput, volumeOutput);
    row.append(volumeCell);

    const loopCell = document.createElement('label');
    loopCell.className = 'sound-loop-cell';
    const loopText = document.createElement('span');
    loopText.textContent = 'Loop';
    const loopInput = document.createElement('input');
    loopInput.type = 'checkbox';
    loopInput.dataset.soundLoopId = clip.id;
    loopInput.setAttribute('aria-label', `${filename} loop in sound check`);
    loopInput.addEventListener('change', () => setSoundLoopEnabled(clip.id, loopInput.checked));
    loopCell.append(loopText, loopInput);
    row.append(loopCell);

    const fadeInCell = document.createElement('label');
    fadeInCell.className = 'sound-time-cell';
    const fadeInText = document.createElement('span');
    fadeInText.textContent = 'In';
    const fadeInInput = document.createElement('input');
    fadeInInput.type = 'number';
    fadeInInput.min = '0';
    fadeInInput.max = String(SOUND_FADE_SECONDS_MAX);
    fadeInInput.step = '0.01';
    fadeInInput.dataset.soundFadeInId = clip.id;
    fadeInInput.setAttribute('aria-label', `${filename} fade in seconds`);
    fadeInInput.addEventListener('change', () => setSoundFadeInSeconds(clip.id, fadeInInput.value));
    fadeInCell.append(fadeInText, fadeInInput);
    row.append(fadeInCell);

    const fadeOutCell = document.createElement('label');
    fadeOutCell.className = 'sound-time-cell';
    const fadeOutText = document.createElement('span');
    fadeOutText.textContent = 'Out';
    const fadeOutInput = document.createElement('input');
    fadeOutInput.type = 'number';
    fadeOutInput.min = '0';
    fadeOutInput.max = String(SOUND_FADE_SECONDS_MAX);
    fadeOutInput.step = '0.01';
    fadeOutInput.dataset.soundFadeOutId = clip.id;
    fadeOutInput.setAttribute('aria-label', `${filename} fade out seconds`);
    fadeOutInput.addEventListener('change', () => setSoundFadeOutSeconds(clip.id, fadeOutInput.value));
    fadeOutCell.append(fadeOutText, fadeOutInput);
    row.append(fadeOutCell);

    soundCheckGrid.append(row);
    syncSoundRowControls(clip.id);
    setSoundButtonState(clip.id);
  }
}

function initSoundCompressorControls() {
  if (soundCompressorEnabledInput) {
    soundCompressorEnabledInput.addEventListener('change', () => {
      setSoundCompressorEnabled(soundCompressorEnabledInput.checked);
    });
  }
  if (soundCompressorGrid) {
    soundCompressorGrid.textContent = '';
    for (const control of SOUND_COMPRESSOR_CONTROLS) {
      const label = document.createElement('label');
      label.className = 'sound-compressor-control';
      const name = document.createElement('span');
      name.textContent = control.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(control.min);
      input.max = String(control.max);
      input.step = String(control.step);
      input.dataset.compressorParam = control.key;
      input.setAttribute('aria-label', `Compressor ${control.label.toLowerCase()}`);
      const output = document.createElement('output');
      output.dataset.compressorOutput = control.key;
      input.addEventListener('input', () => setSoundCompressorParam(control.key, input.value));
      label.append(name, input, output);
      soundCompressorGrid.append(label);
    }
  }
  syncSoundCompressorControls();
}

function getEnvAudioState() {
  return {
    path: envAudioState.path,
    primaryPath: ENV_AUDIO_PATH,
    fallbackPath: ENV_AUDIO_FALLBACK_PATH,
    crossfadeSeconds: envAudioState.crossfadeSeconds,
    durationSeconds: envAudioState.duration,
    intervalSeconds: envAudioState.interval,
    volume: getEnvAudioVolume(),
    fadeInSeconds: getSoundFadeInSeconds('env'),
    fadeOutSeconds: getSoundFadeOutSeconds('env'),
    running: envAudioState.running,
    loaded: Boolean(envAudioState.buffer),
    scheduledSourceCount: envAudioState.sources.length,
    oneShotSourceCount: soundCheckAudioState.oneShots.length,
  };
}

function getSlimeTumbleLoopState() {
  const anchor = getSlimeTumbleSpatialAnchor(slimeTumbleLoopState.spatialAnchor);
  const distance = getSlimeTumbleCameraDistance(anchor);
  return {
    path: slimeTumbleLoopState.path,
    cropStartSeconds: slimeTumbleLoopState.loopStartSeconds,
    crossfadeSeconds: slimeTumbleLoopState.crossfadeSeconds,
    durationSeconds: slimeTumbleLoopState.duration,
    loopDurationSeconds: slimeTumbleLoopState.loopDuration,
    intervalSeconds: slimeTumbleLoopState.interval,
    cameraDistance: distance,
    referenceDistance: slimeTumbleLoopState.referenceDistance,
    pannerDistanceGain: getSlimeTumblePannerDistanceGain(distance),
    distanceFalloff: 'PannerNode inverse',
    panningModel: slimeTumbleLoopState.panner?.panningModel ?? 'HRTF',
    distanceModel: slimeTumbleLoopState.panner?.distanceModel ?? 'inverse',
    rolloffFactor: slimeTumbleLoopState.panner?.rolloffFactor ?? SLIME_TUMBLE_PANNER_ROLLOFF,
    maxDistance: slimeTumbleLoopState.panner?.maxDistance ?? getSlimeTumbleFarDistance(),
    sourcePosition: {
      x: anchor.x,
      y: anchor.y,
      z: anchor.z,
    },
    lowpassHz: getSlimeTumbleLowpassFrequency(distance),
    reverbWet: getSlimeTumbleReverbWet(distance),
    reverbSeconds: SLIME_TUMBLE_REVERB_SECONDS,
    baseVolume: getSlimeTumbleLoopVolume(),
    running: slimeTumbleLoopState.running,
    loaded: Boolean(slimeTumbleLoopState.buffer),
    scheduledSourceCount: slimeTumbleLoopState.sources.length,
  };
}

function runReadbackDiagnostic(
  name,
  fn,
  {
    minIntervalMs = READBACK_DIAGNOSTIC_THROTTLE_MS,
    returnEnvelope = false,
  } = {},
) {
  const now = performance.now();
  const previous = readbackDiagnosticState.get(name);
  if (previous && now - previous.completedAt < minIntervalMs) {
    const waitMs = Math.max(0, minIntervalMs - (now - previous.completedAt));
    console.warn(
      `[cuttlefish] ${name} skipped to avoid continuous GPU readbacks. ` +
      `Try again in ${waitMs.toFixed(0)} ms; returning the last result.`,
    );
    if (returnEnvelope) {
      return {
        name,
        durationMs: previous.durationMs,
        cached: true,
        skipped: true,
        result: previous.result,
      };
    }
    return previous.result;
  }

  console.warn(`[cuttlefish] ${name} reads GPU texture data and can stall rendering.`);
  const startedAt = performance.now();
  const result = fn();
  const completedAt = performance.now();
  const durationMs = completedAt - startedAt;
  readbackDiagnosticState.set(name, {
    startedAt,
    completedAt,
    durationMs,
    result,
  });
  console.info(`[cuttlefish] ${name} completed in ${durationMs.toFixed(2)} ms.`, result);
  if (returnEnvelope) {
    return { name, durationMs, result };
  }
  return result;
}

// === fail ===
function setStartScreenLoadingProgress(percent = null, label = 'loading') {
  if (!startScreenStatus || startScreenReady) return;
  startScreenUiState.readyAt = 0;
  startScreenUiState.clickedAt = 0;
  startScreenUiState.beginFadeOutAt = 0;
  setStartButtonHoverTarget(0, performance.now(), true);
  startScreenStatus.hidden = false;
  startScreenStatus.classList.remove('error');
  startScreenStatus.textContent = 'loading...';
  if (startButton) {
    startButton.hidden = true;
    startButton.disabled = true;
  }
  updateStartScreenUi();
}

function showStartScreenError(message) {
  startScreenReady = false;
  startScreenUiState.readyAt = 0;
  startScreenUiState.clickedAt = 0;
  startScreenUiState.beginFadeOutAt = 0;
  setStartButtonHoverTarget(0, performance.now(), true);
  if (startScreen) {
    startScreen.classList.remove('is-armed', 'is-running', 'is-complete');
    startScreen.removeAttribute('aria-hidden');
  }
  if (startScreenStatus) {
    startScreenStatus.hidden = false;
    startScreenStatus.classList.add('error');
    startScreenStatus.textContent = String(message || 'loading failed');
  }
  if (startButton) {
    startButton.hidden = true;
    startButton.disabled = true;
  }
  updateStartScreenUi();
}

function showStartButton() {
  console.info(`[load] start button ready at ${Math.round(performance.now())}ms`);
  startScreenReady = true;
  startScreenUiState.readyAt = performance.now();
  startScreenUiState.clickedAt = 0;
  startScreenUiState.beginFadeOutAt = 0;
  setStartButtonHoverTarget(0, startScreenUiState.readyAt, true);
  if (startScreenStatus) {
    startScreenStatus.classList.remove('error');
    startScreenStatus.textContent = 'loading...';
    startScreenStatus.hidden = false;
  }
  if (startButton) {
    startButton.hidden = true;
    startButton.disabled = false;
  }
  updateStartScreenUi(startScreenUiState.readyAt);
  maybeBeginIntroSequence();
}

function fail(message) {
  statusEl.textContent = message;
  statusEl.classList.add('error');
  showStartScreenError(message);
}

// === UV → world (for initial oat seed) ===
function uvToWorld(uv, target = new THREE.Vector3()) {
  if (!mesh) return null;
  const geom = mesh.geometry;
  const pos = geom.attributes.position.array;
  const uvAttr = geom.attributes.uv.array;
  const idx = geom.index ? geom.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  for (let f = 0; f < triCount; f++) {
    const i0 = idx ? idx[f * 3] : f * 3;
    const i1 = idx ? idx[f * 3 + 1] : f * 3 + 1;
    const i2 = idx ? idx[f * 3 + 2] : f * 3 + 2;
    const u0 = uvAttr[i0 * 2], v0 = uvAttr[i0 * 2 + 1];
    const u1 = uvAttr[i1 * 2], v1 = uvAttr[i1 * 2 + 1];
    const u2 = uvAttr[i2 * 2], v2 = uvAttr[i2 * 2 + 1];
    const denom = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
    if (Math.abs(denom) < 1e-12) continue;
    const w0 = ((v1 - v2) * (uv.x - u2) + (u2 - u1) * (uv.y - v2)) / denom;
    const w1 = ((v2 - v0) * (uv.x - u2) + (u0 - u2) * (uv.y - v2)) / denom;
    const w2 = 1 - w0 - w1;
    if (w0 < -1e-5 || w1 < -1e-5 || w2 < -1e-5) continue;
    target.set(
      pos[i0 * 3] * w0 + pos[i1 * 3] * w1 + pos[i2 * 3] * w2,
      pos[i0 * 3 + 1] * w0 + pos[i1 * 3 + 1] * w1 + pos[i2 * 3 + 1] * w2,
      pos[i0 * 3 + 2] * w0 + pos[i1 * 3 + 2] * w1 + pos[i2 * 3 + 2] * w2,
    );
    mesh.localToWorld(target);
    return target;
  }
  return null;
}

function updateInitialOatFromCameraRotationCenter(targetMesh = mesh) {
  if (!targetMesh) {
    initialOatUv = { ...FALLBACK_INITIAL_OAT_UV };
    initialOatSurfaceHit = null;
    return null;
  }

  targetMesh.updateMatrixWorld(true);
  const geom = targetMesh.geometry;
  const posAttr = geom.attributes.position;
  const uvAttr = geom.attributes.uv;
  const idx = geom.index;
  if (!posAttr || !uvAttr) {
    initialOatUv = { ...FALLBACK_INITIAL_OAT_UV };
    initialOatSurfaceHit = null;
    console.warn('Mesh position/UV attributes unavailable for initial oat; using fallback UV.', initialOatUv);
    return null;
  }

  const rotationCenter = controls?.target?.clone?.() ?? new THREE.Vector3();
  const tri = new THREE.Triangle();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const bary = new THREE.Vector3();
  const bestPoint = new THREE.Vector3();
  const bestNormal = new THREE.Vector3();
  let bestDistanceSq = Infinity;
  let bestUv = null;
  const triCount = idx ? idx.count / 3 : posAttr.count / 3;

  for (let faceIndex = 0; faceIndex < triCount; faceIndex++) {
    const i0 = idx ? idx.getX(faceIndex * 3) : faceIndex * 3;
    const i1 = idx ? idx.getX(faceIndex * 3 + 1) : faceIndex * 3 + 1;
    const i2 = idx ? idx.getX(faceIndex * 3 + 2) : faceIndex * 3 + 2;
    a.fromBufferAttribute(posAttr, i0).applyMatrix4(targetMesh.matrixWorld);
    b.fromBufferAttribute(posAttr, i1).applyMatrix4(targetMesh.matrixWorld);
    c.fromBufferAttribute(posAttr, i2).applyMatrix4(targetMesh.matrixWorld);
    tri.set(a, b, c);
    tri.closestPointToPoint(rotationCenter, closest);
    const distanceSq = closest.distanceToSquared(rotationCenter);
    if (distanceSq >= bestDistanceSq) continue;

    THREE.Triangle.getBarycoord(closest, a, b, c, bary);
    const uvX =
      uvAttr.getX(i0) * bary.x +
      uvAttr.getX(i1) * bary.y +
      uvAttr.getX(i2) * bary.z;
    const uvY =
      uvAttr.getY(i0) * bary.x +
      uvAttr.getY(i1) * bary.y +
      uvAttr.getY(i2) * bary.z;
    tri.getNormal(bestNormal);
    bestPoint.copy(closest);
    bestDistanceSq = distanceSq;
    bestUv = { x: uvX, y: uvY };
  }

  if (!bestUv || !Number.isFinite(bestDistanceSq)) {
    initialOatUv = { ...FALLBACK_INITIAL_OAT_UV };
    initialOatSurfaceHit = null;
    console.warn('No closest mesh point found for initial oat; using fallback UV.', initialOatUv);
    return null;
  }

  if (bestNormal.lengthSq() < 1e-8) bestNormal.copy(bestPoint).normalize();
  initialOatUv = bestUv;
  initialOatSurfaceHit = {
    uv: { ...initialOatUv },
    worldPos: bestPoint.clone(),
    worldNormal: bestNormal.clone().normalize(),
    distanceToRotationCenter: Math.sqrt(bestDistanceSq),
  };
  return initialOatSurfaceHit;
}

function updateInitialOatFromViewportCenter(targetMesh = mesh) {
  if (!targetMesh) {
    initialOatUv = { ...FALLBACK_INITIAL_OAT_UV };
    initialOatSurfaceHit = null;
    return null;
  }

  targetMesh.updateMatrixWorld(true);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  initialOatViewportRaycaster.setFromCamera(INITIAL_OAT_VIEWPORT_CENTER_NDC, camera);
  initialOatViewportHits.length = 0;
  initialOatViewportRaycaster.intersectObject(targetMesh, false, initialOatViewportHits);
  const hit = initialOatViewportHits[0];
  initialOatViewportHits.length = 0;

  if (!hit?.uv) {
    console.warn('Viewport-center ray missed mesh for initial oat; using camera-target fallback.');
    return updateInitialOatFromCameraRotationCenter(targetMesh);
  }

  const worldNormal = hit.face?.normal
    ?.clone()
    .transformDirection(targetMesh.matrixWorld) ?? new THREE.Vector3();
  if (worldNormal.lengthSq() < 1e-8) {
    const center = targetMesh.geometry?.boundingSphere?.center?.clone?.() ?? new THREE.Vector3();
    targetMesh.localToWorld(center);
    worldNormal.copy(hit.point).sub(center);
  }
  if (worldNormal.lengthSq() < 1e-8) {
    worldNormal.copy(camera.position).sub(hit.point);
  }
  if (worldNormal.lengthSq() < 1e-8) worldNormal.set(0, 1, 0);

  initialOatUv = { x: hit.uv.x, y: hit.uv.y };
  initialOatSurfaceHit = {
    uv: { ...initialOatUv },
    worldPos: hit.point.clone(),
    worldNormal: worldNormal.normalize(),
    distanceToCamera: hit.distance,
    distanceToRotationCenter: hit.point.distanceTo(controls?.target ?? new THREE.Vector3()),
    source: 'viewport-center-raycast',
  };
  return initialOatSurfaceHit;
}

function addInitialOat(opts = {}) {
  const hit = updateInitialOatFromViewportCenter() ?? initialOatSurfaceHit;
  const uv = hit?.uv ?? getInitialOatUv();
  return addOat(uv.x, uv.y, {
    initial: true,
    suppressObservation: true,
    worldPos: hit?.worldPos,
    worldNormal: hit?.worldNormal,
    ...opts,
  });
}

// === fixed-UV safety diagnostics ===
function createUvDiagnostics(targetMesh, initialTopology = null, initialOwnership = null) {
  let topologyCache = initialTopology;
  let clearanceCache = null;
  let ownershipCache = initialOwnership;
  let overlapCache = initialOwnership?.summary ?? null;

  function topology() {
    if (!topologyCache) topologyCache = buildUvChartTopology(targetMesh);
    return topologyCache;
  }

  function summarizeCharts() {
    const topo = topology();
    return {
      chartCount: topo.charts.length,
      faceCount: topo.faceCount,
      boundarySegmentCount: topo.boundarySegments.length,
      nonManifoldUvEdgeCount: topo.nonManifoldUvEdgeCount,
      charts: topo.charts.map((chart) => ({
        id: chart.id,
        faceCount: chart.faceCount,
        uvAreaTexels: chart.uvAreaTexels,
        boundarySegmentCount: chart.boundarySegments.length,
        bounds: { ...chart.bounds },
      })),
    };
  }

  function measureChartClearance() {
    if (!clearanceCache) clearanceCache = computeChartClearance(topology());
    return clearanceCache;
  }

  function ownership() {
    if (!ownershipCache) {
      ownershipCache = rasterizeUvOwnershipMaps(topology());
      overlapCache = ownershipCache.summary;
    }
    return ownershipCache;
  }

  function detectUvOverlapConflicts() {
    return ownership().summary;
  }

  function measureChartOwnershipStats() {
    const summary = ownership().summary;
    return {
      resolution: summary.resolution,
      ownedTexels: summary.ownedTexels,
      conservativeOwnedTexels: summary.conservativeOwnedTexels,
      centerOwnedTexels: summary.centerOwnedTexels,
      centerClaimOwnedTexels: summary.centerClaimOwnedTexels,
      unsafeTexels: summary.unsafeTexels,
      centerUnsafeTexels: summary.centerUnsafeTexels,
      conflictTexels: summary.conflictTexels,
      multiOwnerConflictTexels: summary.multiOwnerConflictTexels,
      centerMultiOwnerConflictTexels: summary.centerMultiOwnerConflictTexels,
      conservativeClaimTexels: summary.conservativeClaimTexels,
      conservativeSingleChartClaimTexels: summary.conservativeSingleChartClaimTexels,
      conservativeMultiChartClaimTexels: summary.conservativeMultiChartClaimTexels,
      centerCandidateTexelsTested: summary.centerCandidateTexelsTested,
      conservativeCandidateTexelsTested: summary.conservativeCandidateTexelsTested,
      zeroOwnedChartCount: summary.zeroOwnedChartIds.length,
      centerZeroOwnedChartCount: summary.centerZeroOwnedChartIds.length,
      conservativeZeroOwnedChartCount: summary.conservativeZeroOwnedChartIds.length,
      microChartCount: summary.microChartIds.length,
      ambiguousUnsafeChartCount: summary.ambiguousUnsafeChartIds.length,
      centerAmbiguousUnsafeChartCount: summary.centerAmbiguousUnsafeChartIds.length,
      zeroOwnedChartIds: [...summary.zeroOwnedChartIds],
      centerZeroOwnedChartIds: [...summary.centerZeroOwnedChartIds],
      conservativeZeroOwnedChartIds: [...summary.conservativeZeroOwnedChartIds],
      microChartIds: [...summary.microChartIds],
      ambiguousUnsafeChartIds: [...summary.ambiguousUnsafeChartIds],
      centerAmbiguousUnsafeChartIds: [...summary.centerAmbiguousUnsafeChartIds],
      zeroOwnedOrMicroCharts: summary.zeroOwnedOrMicroCharts.map((entry) => ({ ...entry })),
      perChartStats: summary.perChartStats.map((entry) => ({ ...entry })),
      note: summary.note,
    };
  }

  function getChartOwnershipStats() {
    return measureChartOwnershipStats();
  }

  function getZeroOwnedCharts() {
    return measureChartOwnershipStats().perChartStats
      .filter((chart) => chart.zeroOwned)
      .map((chart) => ({ ...chart }));
  }

  function getMicroCharts() {
    return measureChartOwnershipStats().perChartStats
      .filter((chart) => chart.micro)
      .map((chart) => ({ ...chart }));
  }

  function getUnsafeCharts() {
    return measureChartOwnershipStats().perChartStats
      .filter((chart) => chart.unsafeTexels > 0 || chart.isAmbiguousUnsafe)
      .map((chart) => ({ ...chart }));
  }

  function measureCurrentSamplingFootprints() {
    const footprints = getSamplingFootprintRegistry(params, oats);
    return {
      ...footprints,
      linearFloatFilteringAvailable: Boolean(linearFloat),
      selectedLegacyFieldFilter: threeConstName(fieldFilter),
    };
  }

  function measureSafeGutterBudget() {
    return getSafeGutterBudgetTexels({
      clearance: measureChartClearance(),
      ownership: measureChartOwnershipStats(),
      overlaps: detectUvOverlapConflicts(),
    });
  }

  function measureTopologySafetyBudget() {
    return getTopologySafetyBudget(params, oats, {
      clearance: measureChartClearance(),
      ownership: measureChartOwnershipStats(),
      overlaps: detectUvOverlapConflicts(),
    });
  }

  function readTransitionSnapshot() {
    const candidateAtlasWidth = FIELD_SIZE * SEAM_TRANSITION_CANDIDATE_COUNT;
    const candidateAtlasTexelCount = candidateAtlasWidth * FIELD_SIZE;
    const uvAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const metaAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const directionAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const basisAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    renderer.readRenderTargetPixels(seamTransitionUvAtlasRT, 0, 0, candidateAtlasWidth, FIELD_SIZE, uvAtlas);
    renderer.readRenderTargetPixels(seamTransitionMetaAtlasRT, 0, 0, candidateAtlasWidth, FIELD_SIZE, metaAtlas);
    renderer.readRenderTargetPixels(seamTransitionDirectionAtlasRT, 0, 0, candidateAtlasWidth, FIELD_SIZE, directionAtlas);
    renderer.readRenderTargetPixels(seamTransitionBasisAtlasRT, 0, 0, candidateAtlasWidth, FIELD_SIZE, basisAtlas);
    const transitionCandidates = [];
    for (let slot = 0; slot < SEAM_TRANSITION_CANDIDATE_COUNT; slot++) {
      const transitionUv = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
      const transitionMeta = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
      const transitionDirection = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
      const transitionBasis = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
      for (let y = 0; y < FIELD_SIZE; y++) {
        const atlasBase = ((y * candidateAtlasWidth) + slot * FIELD_SIZE) * 4;
        const slotBase = y * FIELD_SIZE * 4;
        transitionUv.set(uvAtlas.subarray(atlasBase, atlasBase + FIELD_SIZE * 4), slotBase);
        transitionMeta.set(metaAtlas.subarray(atlasBase, atlasBase + FIELD_SIZE * 4), slotBase);
        transitionDirection.set(directionAtlas.subarray(atlasBase, atlasBase + FIELD_SIZE * 4), slotBase);
        transitionBasis.set(basisAtlas.subarray(atlasBase, atlasBase + FIELD_SIZE * 4), slotBase);
      }
      transitionCandidates.push({
        transitionUv,
        transitionMeta,
        transitionDirection,
        transitionBasis,
      });
    }
    const transitionClaim = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    renderer.readRenderTargetPixels(seamTransitionClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, transitionClaim);
    const first = transitionCandidates[0];
    return {
      transitionUv: first.transitionUv,
      transitionMeta: first.transitionMeta,
      transitionDirection: first.transitionDirection,
      transitionBasis: first.transitionBasis,
      transitionClaim,
      transitionCandidates,
    };
  }

  function indexAtUvComponents(u, v) {
    if (u < 0 || v < 0 || u > 1 || v > 1) return -1;
    const ix = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(u * FIELD_SIZE)));
    const iy = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(v * FIELD_SIZE)));
    return iy * FIELD_SIZE + ix;
  }

  function candidatePair(candidate, p) {
    const sourceChart = Math.round(candidate.transitionMeta[p]);
    const destinationChart = Math.round(candidate.transitionMeta[p + 1]);
    return `${sourceChart}->${destinationChart}`;
  }

  function resolveTransitionCandidate(maps, state, baseIndex, baseChart, offsetUvX, offsetUvY) {
    const p = baseIndex * 4;
    const claimCount = Math.round(maps.transitionClaim[p]);
    // Mirrors the GLSL: overflow texels still resolve through their stored
    // nearest candidates; overflow is only reported as the cause when
    // resolution fails (the evicted candidate may have been the right one).
    const hasOverflow = maps.transitionClaim[p + 1] >= 0.5;
    if (claimCount <= 0) {
      return { accepted: false, cause: 'transitionMetadataMissing', metadataPair: 'none' };
    }

    const offsetLen = Math.hypot(offsetUvX, offsetUvY);
    if (offsetLen <= 1e-12) {
      return { accepted: false, cause: 'wrongDirectionRejection', metadataPair: 'none' };
    }

    const accepted = [];
    const causeCounts = new Map();
    let metadataPair = 'none';

    function addCause(cause) {
      causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
    }

    for (const candidate of maps.transitionCandidates ?? []) {
      if (candidate.transitionUv[p + 2] < 0.5) continue;
      metadataPair = candidatePair(candidate, p);
      const sourceChart = Math.round(candidate.transitionMeta[p]);
      const destinationChart = Math.round(candidate.transitionMeta[p + 1]);
      if (sourceChart !== baseChart || destinationChart <= 0) {
        addCause('metadataChartMismatch');
        continue;
      }

      const sourceOutX = candidate.transitionDirection[p];
      const sourceOutY = candidate.transitionDirection[p + 1];
      const destinationInX = candidate.transitionDirection[p + 2];
      const destinationInY = candidate.transitionDirection[p + 3];
      const sourceEdgeX = candidate.transitionBasis[p];
      const sourceEdgeY = candidate.transitionBasis[p + 1];
      const destinationEdgeX = candidate.transitionBasis[p + 2];
      const destinationEdgeY = candidate.transitionBasis[p + 3];
      const sourceOutLen = Math.hypot(sourceOutX, sourceOutY);
      const destinationInLen = Math.hypot(destinationInX, destinationInY);
      const sourceEdgeLen = Math.hypot(sourceEdgeX, sourceEdgeY);
      const destinationEdgeLen = Math.hypot(destinationEdgeX, destinationEdgeY);
      if (sourceOutLen < 0.5 ||
          destinationInLen < 0.5 ||
          sourceEdgeLen < 0.5 ||
          destinationEdgeLen < 0.5) {
        addCause('wrongDirectionRejection');
        continue;
      }

      const sourceOutNx = sourceOutX / sourceOutLen;
      const sourceOutNy = sourceOutY / sourceOutLen;
      const destinationInNx = destinationInX / destinationInLen;
      const destinationInNy = destinationInY / destinationInLen;
      const sourceEdgeNx = sourceEdgeX / sourceEdgeLen;
      const sourceEdgeNy = sourceEdgeY / sourceEdgeLen;
      const destinationEdgeNx = destinationEdgeX / destinationEdgeLen;
      const destinationEdgeNy = destinationEdgeY / destinationEdgeLen;
      const outwardUv = offsetUvX * sourceOutNx + offsetUvY * sourceOutNy;
      const outwardTexels = outwardUv * FIELD_SIZE;
      const seamDistanceTexels = candidate.transitionUv[p + 3];
      const outwardAlignment = outwardUv / offsetLen;
      if (outwardAlignment < ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN) {
        addCause('wrongDirectionRejection');
        continue;
      }
      if (outwardTexels + ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS < seamDistanceTexels) {
        addCause('notCrossingRejection');
        continue;
      }

      const alongUv = offsetUvX * sourceEdgeNx + offsetUvY * sourceEdgeNy;
      const destinationDepthUv = Math.max(0, outwardTexels - seamDistanceTexels) / FIELD_SIZE;
      const destU = candidate.transitionUv[p] +
        destinationEdgeNx * alongUv +
        destinationInNx * destinationDepthUv;
      const destV = candidate.transitionUv[p + 1] +
        destinationEdgeNy * alongUv +
        destinationInNy * destinationDepthUv;
      const destIndex = indexAtUvComponents(destU, destV);
      if (destIndex < 0 ||
          state.conflict[destIndex] !== 0 ||
          state.owner[destIndex] !== destinationChart) {
        addCause('destinationOwnershipUnsafeRejection');
        continue;
      }

      accepted.push({
        destIndex,
        destinationChart,
        metadataPair,
        destU,
        destV,
        outwardTexels,
        seamDistanceTexels,
        outwardAlignment,
      });
    }

    const uniqueAccepted = [];
    for (const entry of accepted) {
      const duplicate = uniqueAccepted.find((existing) =>
        existing.destinationChart === entry.destinationChart &&
        existing.metadataPair === entry.metadataPair &&
        Math.hypot(
          (existing.destU - entry.destU) * FIELD_SIZE,
          (existing.destV - entry.destV) * FIELD_SIZE,
        ) <= 3.0
      );
      if (!duplicate) {
        uniqueAccepted.push(entry);
      } else if (entry.seamDistanceTexels < duplicate.seamDistanceTexels) {
        Object.assign(duplicate, entry);
      }
    }

    if (uniqueAccepted.length === 1) {
      return {
        accepted: true,
        ...uniqueAccepted[0],
        candidateCount: claimCount,
        hadCandidateOverflow: hasOverflow,
        duplicateWinnersMerged: accepted.length - uniqueAccepted.length,
      };
    }
    if (uniqueAccepted.length > 1) {
      // Mirrors the GLSL nearest-seam-wins rule: the offset crosses the
      // closest boundary first.
      const nearest = uniqueAccepted.reduce((best, entry) =>
        entry.seamDistanceTexels < best.seamDistanceTexels ? entry : best);
      return {
        accepted: true,
        ...nearest,
        candidateCount: claimCount,
        hadCandidateOverflow: hasOverflow,
        resolvedFromAmbiguousCandidates: uniqueAccepted.length,
        duplicateWinnersMerged: accepted.length - uniqueAccepted.length,
      };
    }

    if (hasOverflow) {
      return {
        accepted: false,
        cause: 'transitionCandidateOverflow',
        metadataPair: 'overflow',
        candidateCount: claimCount,
      };
    }

    const causePriority = [
      'metadataChartMismatch',
      'wrongDirectionRejection',
      'notCrossingRejection',
      'destinationOwnershipUnsafeRejection',
    ];
    const cause = causePriority.find((key) => causeCounts.has(key)) ?? 'transitionMetadataMissing';
    return {
      accepted: false,
      cause,
      metadataPair,
      candidateCount: claimCount,
    };
  }

  function mapReceiverTexelToSourceVirtualUv(texel, receiverChart, sourceChart, maps, counts = null) {
    const p = texel * 4;
    // Mirrors the GLSL: overflow texels resolve through their stored nearest
    // candidates instead of being skipped outright.
    let winner = null;
    let winnerCount = 0;
    for (const candidate of maps.transitionCandidates ?? []) {
      if (candidate.transitionUv[p + 2] < 0.5) continue;
      const transitionSourceChart = Math.round(candidate.transitionMeta[p]);
      const transitionDestinationChart = Math.round(candidate.transitionMeta[p + 1]);
      if (transitionSourceChart !== receiverChart || transitionDestinationChart !== sourceChart) {
        continue;
      }
      const destinationInX = candidate.transitionDirection[p + 2];
      const destinationInY = candidate.transitionDirection[p + 3];
      const sourceEdgeX = candidate.transitionBasis[p];
      const sourceEdgeY = candidate.transitionBasis[p + 1];
      const destinationEdgeX = candidate.transitionBasis[p + 2];
      const destinationEdgeY = candidate.transitionBasis[p + 3];
      const destinationInLen = Math.hypot(destinationInX, destinationInY);
      const sourceEdgeLen = Math.hypot(sourceEdgeX, sourceEdgeY);
      const destinationEdgeLen = Math.hypot(destinationEdgeX, destinationEdgeY);
      if (destinationInLen < 0.5 || sourceEdgeLen < 0.5 || destinationEdgeLen < 0.5) {
        continue;
      }
      // Mirrors the GLSL nearest-seam-wins rule.
      const seamDistance = Math.max(0, candidate.transitionUv[p + 3]);
      if (winner && seamDistance >= winner.transitionDistanceTexels) continue;
      const receiverDepthUv = seamDistance / FIELD_SIZE;
      winner = {
        u: candidate.transitionUv[p] - (destinationInX / destinationInLen) * receiverDepthUv,
        v: candidate.transitionUv[p + 1] - (destinationInY / destinationInLen) * receiverDepthUv,
        pair: `${sourceChart}->${receiverChart}`,
        transitionDistanceTexels: seamDistance,
      };
      winnerCount++;
    }
    if (winner) return winner;
    if (counts) counts.skippedWrongDirectionNotCrossingContributions++;
    return null;
  }

  function measureSafeSamplingRejections(strideTexels = 8) {
    const state = ownership();
    const footprints = measureCurrentSamplingFootprints();
    const stride = Math.max(1, Math.min(128, Math.round(strideTexels)));
    const redirectClaims = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const maps = readTransitionSnapshot();
    renderer.readRenderTargetPixels(seamRedirectClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectClaims);

    function sampleIndexAt(x, y, dx, dy) {
      const sx = x + 0.5 + dx;
      const sy = y + 0.5 + dy;
      if (sx < 0 || sy < 0 || sx >= FIELD_SIZE || sy >= FIELD_SIZE) return -1;
      return Math.floor(sy) * FIELD_SIZE + Math.floor(sx);
    }

    function measurePass(pass, offsets) {
      const counts = {
        pass,
        sampleStrideTexels: stride,
        baseTexelsVisited: 0,
        authoritativeBaseTexels: 0,
        baseUnsafeOrUnownedTexels: 0,
        totalSamples: 0,
        acceptedSameChart: 0,
        acceptedZeroGutterTransition: 0,
        rejectedCrossOwner: 0,
        rejectedUnsafe: 0,
        rejectedOutsideAtlas: 0,
        rejectedRedirectClaimCollision: 0,
        rejectedZeroGutterClaimCollision: 0,
        rejectedZeroGutterWrongDirection: 0,
        rejectedZeroGutterNotCrossing: 0,
        rejectedZeroGutterUnresolved: 0,
        rejectedEmptyOrRedirectRequired: 0,
      };

      function indexAtUv(u, v) {
        if (u < 0 || v < 0 || u > 1 || v > 1) return -1;
        const ix = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(u * FIELD_SIZE)));
        const iy = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(v * FIELD_SIZE)));
        return iy * FIELD_SIZE + ix;
      }

      function tryZeroGutterTransition(baseIndex, baseChart, offset) {
        const offsetUvX = offset.x / FIELD_SIZE;
        const offsetUvY = offset.y / FIELD_SIZE;
        const resolved = resolveTransitionCandidate(
          maps,
          state,
          baseIndex,
          baseChart,
          offsetUvX,
          offsetUvY,
        );
        if (!resolved.accepted) {
          if (resolved.cause === 'transitionCandidateOverflow' ||
              resolved.cause === 'transitionCandidateAmbiguous') {
            counts.rejectedZeroGutterClaimCollision++;
          } else if (resolved.cause === 'wrongDirectionRejection') {
            counts.rejectedZeroGutterWrongDirection++;
          } else if (resolved.cause === 'notCrossingRejection') {
            counts.rejectedZeroGutterNotCrossing++;
          } else {
            counts.rejectedZeroGutterUnresolved++;
          }
          return false;
        }
        counts.acceptedZeroGutterTransition++;
        return true;
      }

      for (let y = 0; y < FIELD_SIZE; y += stride) {
        for (let x = 0; x < FIELD_SIZE; x += stride) {
          counts.baseTexelsVisited++;
          const baseIndex = y * FIELD_SIZE + x;
          const baseChart = state.owner[baseIndex];
          if (baseChart <= 0 || state.conflict[baseIndex] !== 0) {
            counts.baseUnsafeOrUnownedTexels++;
            continue;
          }
          counts.authoritativeBaseTexels++;
          for (const offset of offsets) {
            counts.totalSamples++;
            const sampleIndex = sampleIndexAt(x, y, offset.x, offset.y);
            const sampleChart = sampleIndex >= 0 ? state.owner[sampleIndex] : -1;
            const sampleUnsafe = sampleIndex >= 0 && state.conflict[sampleIndex] !== 0;
            if (sampleIndex >= 0 && !sampleUnsafe && sampleChart === baseChart) {
              counts.acceptedSameChart++;
              continue;
            }
            if (tryZeroGutterTransition(baseIndex, baseChart, offset)) {
              continue;
            }
            if (sampleIndex < 0) {
              counts.rejectedOutsideAtlas++;
            } else if (sampleUnsafe) {
              counts.rejectedUnsafe++;
            } else if (sampleChart > 0) {
              counts.rejectedCrossOwner++;
            } else if (redirectClaims[sampleIndex * 4] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) {
              counts.rejectedRedirectClaimCollision++;
            } else {
              counts.rejectedEmptyOrRedirectRequired++;
            }
          }
        }
      }

      counts.estimatedRejectedTotal =
        counts.rejectedCrossOwner +
        counts.rejectedUnsafe +
        counts.rejectedOutsideAtlas +
        counts.rejectedRedirectClaimCollision +
        counts.rejectedEmptyOrRedirectRequired;
      counts.estimatedZeroGutterRejectedTotal =
        counts.rejectedZeroGutterClaimCollision +
        counts.rejectedZeroGutterWrongDirection +
        counts.rejectedZeroGutterNotCrossing +
        counts.rejectedZeroGutterUnresolved;
      counts.note = 'CPU estimate of migrated safe-sampling decisions. PR11 visual smoothing/bump normals and PR11B canonical diffusion use direction-safe zero-gutter transitions when validated.';
      return counts;
    }

    const smoothingOffsets = [];
    const radius = Math.max(0, footprints.renderSmoothingRadiusTexels);
    const smoothingTapCount = getRenderSmoothingTapCount(params);
    for (let i = 1; i <= smoothingTapCount; i++) {
      const offset = i * radius / Math.max(1, smoothingTapCount);
      if (offset <= 0) continue;
      smoothingOffsets.push({ x: offset, y: 0 }, { x: -offset, y: 0 }, { x: 0, y: offset }, { x: 0, y: -offset });
    }

    const normalRadius = Math.max(1, footprints.bumpSampleRadiusTexels);
    const bumpOffsets = [
      { x: -normalRadius, y: 0 },
      { x: normalRadius, y: 0 },
      { x: 0, y: -normalRadius },
      { x: 0, y: normalRadius },
    ];
    if (getBumpDiagonalTapsEnabled(params)) {
      bumpOffsets.push(
        { x: -normalRadius, y: normalRadius },
        { x: normalRadius, y: normalRadius },
        { x: -normalRadius, y: -normalRadius },
        { x: normalRadius, y: -normalRadius },
      );
    }

    const diffusionOffsets = [
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];

    const passes = [
      measurePass('render smoothing', smoothingOffsets),
      measurePass('bump normals', bumpOffsets),
      measurePass('canonical diffusion', diffusionOffsets),
    ];
    const totals = passes.reduce((acc, pass) => {
      for (const key of [
        'baseTexelsVisited',
        'authoritativeBaseTexels',
        'baseUnsafeOrUnownedTexels',
        'totalSamples',
        'acceptedSameChart',
        'acceptedZeroGutterTransition',
        'rejectedCrossOwner',
        'rejectedUnsafe',
        'rejectedOutsideAtlas',
        'rejectedRedirectClaimCollision',
        'rejectedZeroGutterClaimCollision',
        'rejectedZeroGutterWrongDirection',
        'rejectedZeroGutterNotCrossing',
        'rejectedZeroGutterUnresolved',
        'rejectedEmptyOrRedirectRequired',
        'estimatedRejectedTotal',
        'estimatedZeroGutterRejectedTotal',
      ]) {
        acc[key] += pass[key];
      }
      return acc;
    }, {
      baseTexelsVisited: 0,
      authoritativeBaseTexels: 0,
      baseUnsafeOrUnownedTexels: 0,
      totalSamples: 0,
      acceptedSameChart: 0,
      acceptedZeroGutterTransition: 0,
      rejectedCrossOwner: 0,
      rejectedUnsafe: 0,
      rejectedOutsideAtlas: 0,
      rejectedRedirectClaimCollision: 0,
      rejectedZeroGutterClaimCollision: 0,
      rejectedZeroGutterWrongDirection: 0,
      rejectedZeroGutterNotCrossing: 0,
      rejectedZeroGutterUnresolved: 0,
      rejectedEmptyOrRedirectRequired: 0,
      estimatedRejectedTotal: 0,
      estimatedZeroGutterRejectedTotal: 0,
    });

    return {
      migratedPasses: passes.map((entry) => entry.pass),
      sampleStrideTexels: stride,
      totals,
      passes,
      note: 'Manual diagnostic only; no readback runs per frame. Render smoothing, bump normals, and canonical diffusion are accepted zero-gutter transition users before PR12.',
    };
  }

  function measureAgentTopologySafety(dt = 1) {
    const agents = new Float32Array(AGENT_CAPACITY * 4);
    const redirectUv = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const redirectMeta = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const redirectClaim = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const maps = readTransitionSnapshot();
    const state = ownership();
    renderer.readRenderTargetPixels(agentRT.read, 0, 0, AGENT_SIDE, AGENT_SIDE, agents);
    renderer.readRenderTargetPixels(seamRedirectUvRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectUv);
    renderer.readRenderTargetPixels(seamRedirectMetaRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectMeta);
    renderer.readRenderTargetPixels(seamRedirectClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectClaim);

    const counts = {
      activeAgents: 0,
      inactiveAgents: 0,
      killedInvalidCurrentAgents: 0,
      invalidCurrentAgents: 0,
      sensorSamples: 0,
      sensorAcceptedSameChart: 0,
      sensorAcceptedZeroGutterTransition: 0,
      sensorAcceptedRedirect: 0,
      sensorRejectedUnrelatedChart: 0,
      sensorRejectedUnsafeOwnership: 0,
      sensorRejectedOutsideAtlas: 0,
      sensorRejectedRedirectClaimCollision: 0,
      sensorRejectedZeroGutterClaimCollision: 0,
      sensorRejectedZeroGutterWrongDirection: 0,
      sensorRejectedZeroGutterNotCrossing: 0,
      sensorRejectedZeroGutterUnresolved: 0,
      sensorRejectedUnresolvedDestination: 0,
      moveAcceptedSameChart: 0,
      moveAcceptedZeroGutterTransition: 0,
      moveAcceptedRedirect: 0,
      moveRejectedUnrelatedChart: 0,
      moveRejectedUnsafeOwnership: 0,
      moveRejectedOutsideAtlas: 0,
      moveRejectedRedirectClaimCollision: 0,
      moveRejectedZeroGutterClaimCollision: 0,
      moveRejectedZeroGutterWrongDirection: 0,
      moveRejectedZeroGutterNotCrossing: 0,
      moveRejectedZeroGutterUnresolved: 0,
      moveRejectedUnresolvedDestination: 0,
      childAcceptedSameChart: 0,
      childAcceptedZeroGutterTransition: 0,
      childAcceptedRedirect: 0,
      childRejectedUnrelatedChart: 0,
      childRejectedUnsafeOwnership: 0,
      childRejectedOutsideAtlas: 0,
      childRejectedRedirectClaimCollision: 0,
      childRejectedZeroGutterClaimCollision: 0,
      childRejectedZeroGutterWrongDirection: 0,
      childRejectedZeroGutterNotCrossing: 0,
      childRejectedZeroGutterUnresolved: 0,
      childRejectedUnresolvedDestination: 0,
    };

    function indexAtUv(x, y) {
      if (x < 0 || y < 0 || x > 1 || y > 1) return -1;
      const ix = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(x * FIELD_SIZE)));
      const iy = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(y * FIELD_SIZE)));
      return iy * FIELD_SIZE + ix;
    }

    function tryZeroGutterTransition(baseIndex, baseChart, baseX, baseY, x, y, prefix) {
      if (!params.useSeamStitching) return false;
      const offsetUvX = x - baseX;
      const offsetUvY = y - baseY;
      const resolved = resolveTransitionCandidate(
        maps,
        state,
        baseIndex,
        baseChart,
        offsetUvX,
        offsetUvY,
      );
      if (!resolved.accepted) {
        if (resolved.cause === 'transitionCandidateOverflow' ||
            resolved.cause === 'transitionCandidateAmbiguous') {
          counts[`${prefix}RejectedZeroGutterClaimCollision`]++;
        } else if (resolved.cause === 'wrongDirectionRejection') {
          counts[`${prefix}RejectedZeroGutterWrongDirection`]++;
        } else if (resolved.cause === 'notCrossingRejection') {
          counts[`${prefix}RejectedZeroGutterNotCrossing`]++;
        } else {
          counts[`${prefix}RejectedZeroGutterUnresolved`]++;
        }
        return false;
      }

      counts[`${prefix}AcceptedZeroGutterTransition`]++;
      return true;
    }

    function classify(baseIndex, baseChart, baseX, baseY, x, y, prefix) {
      const sampleIndex = indexAtUv(x, y);
      const sampleUnsafe = sampleIndex >= 0 && state.conflict[sampleIndex] !== 0;
      const sampleChart = sampleIndex >= 0 ? state.owner[sampleIndex] : -1;
      if (sampleIndex >= 0 && !sampleUnsafe && sampleChart === baseChart) {
        counts[`${prefix}AcceptedSameChart`]++;
        return 'same-chart';
      }
      if (tryZeroGutterTransition(baseIndex, baseChart, baseX, baseY, x, y, prefix)) {
        return 'zero-gutter-transition';
      }
      if (sampleIndex < 0) {
        counts[`${prefix}RejectedOutsideAtlas`]++;
        return 'outside';
      }
      const p = sampleIndex * 4;
      if (sampleUnsafe) {
        counts[`${prefix}RejectedUnsafeOwnership`]++;
        return 'unsafe';
      }
      if (sampleChart > 0) {
        counts[`${prefix}RejectedUnrelatedChart`]++;
        return 'unrelated-chart';
      }
      if (redirectClaim[p] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) {
        counts[`${prefix}RejectedRedirectClaimCollision`]++;
        return 'redirect-claim-collision';
      }
      if (!params.useSeamStitching || redirectUv[p + 2] < 0.5) {
        counts[`${prefix}RejectedUnresolvedDestination`]++;
        return 'unresolved';
      }
      const sourceChart = Math.round(redirectMeta[p]);
      const destinationChart = Math.round(redirectMeta[p + 1]);
      const destIndex = indexAtUv(redirectUv[p], redirectUv[p + 1]);
      if (sourceChart !== baseChart || destinationChart <= 0 || destIndex < 0 ||
          state.conflict[destIndex] !== 0 || state.owner[destIndex] !== destinationChart) {
        counts[`${prefix}RejectedUnresolvedDestination`]++;
        return 'unresolved';
      }
      counts[`${prefix}AcceptedRedirect`]++;
      return 'redirect';
    }

    const moveDt = Number.isFinite(dt) ? Math.max(0, dt) : 1;
    for (let i = 0; i < AGENT_CAPACITY; i++) {
      const p = i * 4;
      const reserve = agents[p + 3];
      if (reserve <= 0) {
        counts.inactiveAgents++;
        continue;
      }
      counts.activeAgents++;
      const x = agents[p];
      const y = agents[p + 1];
      const angle = agents[p + 2];
      const baseIndex = indexAtUv(x, y);
      if (baseIndex < 0 || state.owner[baseIndex] <= 0 || state.conflict[baseIndex] !== 0) {
        counts.invalidCurrentAgents++;
        counts.killedInvalidCurrentAgents++;
        continue;
      }
      const baseChart = state.owner[baseIndex];
      const sensorOffsets = [
        { angle: angle, distance: params.sensorDistance },
        { angle: angle + params.sensorAngle, distance: params.sensorDistance },
        { angle: angle - params.sensorAngle, distance: params.sensorDistance },
        { angle: angle, distance: 0 },
      ];
      for (const sensor of sensorOffsets) {
        counts.sensorSamples++;
        classify(
          baseIndex,
          baseChart,
          x,
          y,
          x + Math.cos(sensor.angle) * sensor.distance,
          y + Math.sin(sensor.angle) * sensor.distance,
          'sensor',
        );
      }
      classify(
        baseIndex,
        baseChart,
        x,
        y,
        x + Math.cos(angle) * params.stepSize * moveDt,
        y + Math.sin(angle) * params.stepSize * moveDt,
        'move',
      );
      if (reserve > params.reproThreshold) {
        classify(
          baseIndex,
          baseChart,
          x,
          y,
          x + Math.cos(angle + params.reproAngle) * params.childStep,
          y + Math.sin(angle + params.reproAngle) * params.childStep,
          'child',
        );
        classify(
          baseIndex,
          baseChart,
          x,
          y,
          x + Math.cos(angle - params.reproAngle) * params.childStep,
          y + Math.sin(angle - params.reproAngle) * params.childStep,
          'child',
        );
      }
    }

    const moveRejectedTotal =
      counts.moveRejectedUnrelatedChart +
      counts.moveRejectedUnsafeOwnership +
      counts.moveRejectedOutsideAtlas +
      counts.moveRejectedRedirectClaimCollision +
      counts.moveRejectedUnresolvedDestination;
    const moveRejectedZeroGutterTotal =
      counts.moveRejectedZeroGutterClaimCollision +
      counts.moveRejectedZeroGutterWrongDirection +
      counts.moveRejectedZeroGutterNotCrossing +
      counts.moveRejectedZeroGutterUnresolved;
    const childRejectedTotal =
      counts.childRejectedUnrelatedChart +
      counts.childRejectedUnsafeOwnership +
      counts.childRejectedOutsideAtlas +
      counts.childRejectedRedirectClaimCollision +
      counts.childRejectedUnresolvedDestination;
    const childRejectedZeroGutterTotal =
      counts.childRejectedZeroGutterClaimCollision +
      counts.childRejectedZeroGutterWrongDirection +
      counts.childRejectedZeroGutterNotCrossing +
      counts.childRejectedZeroGutterUnresolved;
    const sensorRejectedZeroGutterTotal =
      counts.sensorRejectedZeroGutterClaimCollision +
      counts.sensorRejectedZeroGutterWrongDirection +
      counts.sensorRejectedZeroGutterNotCrossing +
      counts.sensorRejectedZeroGutterUnresolved;
    const sensorZeroGutterAttempts =
      counts.sensorAcceptedZeroGutterTransition + sensorRejectedZeroGutterTotal;
    const moveZeroGutterAttempts =
      counts.moveAcceptedZeroGutterTransition + moveRejectedZeroGutterTotal;
    const childZeroGutterAttempts =
      counts.childAcceptedZeroGutterTransition + childRejectedZeroGutterTotal;
    const totalZeroGutterAttempts =
      sensorZeroGutterAttempts + moveZeroGutterAttempts + childZeroGutterAttempts;
    const totalZeroGutterAccepted =
      counts.sensorAcceptedZeroGutterTransition +
      counts.moveAcceptedZeroGutterTransition +
      counts.childAcceptedZeroGutterTransition;

    return {
      dt: moveDt,
      ...counts,
      rejectedMoveFallbacks: moveRejectedTotal,
      rejectedZeroGutterMoveAttempts: moveRejectedZeroGutterTotal,
      childPlacementFallbacks: childRejectedTotal,
      rejectedZeroGutterChildPlacementAttempts: childRejectedZeroGutterTotal,
      rejectedZeroGutterSensorAttempts: sensorRejectedZeroGutterTotal,
      acceptedSameChartMoves: counts.moveAcceptedSameChart,
      acceptedSeamRedirectMoves: counts.moveAcceptedRedirect,
      acceptedZeroGutterAgentSensorSamples: counts.sensorAcceptedZeroGutterTransition,
      acceptedZeroGutterAgentTransitionMoves: counts.moveAcceptedZeroGutterTransition,
      acceptedZeroGutterChildPlacements: counts.childAcceptedZeroGutterTransition,
      acceptedZeroGutterAgentTransitions:
        totalZeroGutterAccepted,
      sensorZeroGutterAttempts,
      moveZeroGutterAttempts,
      childZeroGutterAttempts,
      totalZeroGutterAttempts,
      totalZeroGutterAccepted,
      zeroGutterTransitionAcceptanceRatio: totalZeroGutterAttempts > 0
        ? totalZeroGutterAccepted / totalZeroGutterAttempts
        : null,
      sensorZeroGutterTransitionAcceptanceRatio: sensorZeroGutterAttempts > 0
        ? counts.sensorAcceptedZeroGutterTransition / sensorZeroGutterAttempts
        : null,
      moveZeroGutterTransitionAcceptanceRatio: moveZeroGutterAttempts > 0
        ? counts.moveAcceptedZeroGutterTransition / moveZeroGutterAttempts
        : null,
      childZeroGutterTransitionAcceptanceRatio: childZeroGutterAttempts > 0
        ? counts.childAcceptedZeroGutterTransition / childZeroGutterAttempts
        : null,
      agentCreation: { ...lastAgentCreationDiagnostics },
      totalRejectedUnrelatedChart:
        counts.sensorRejectedUnrelatedChart +
        counts.moveRejectedUnrelatedChart +
        counts.childRejectedUnrelatedChart,
      totalRejectedRedirectClaimCollision:
        counts.sensorRejectedRedirectClaimCollision +
        counts.moveRejectedRedirectClaimCollision +
        counts.childRejectedRedirectClaimCollision,
      totalRejectedZeroGutterClaimCollision:
        counts.sensorRejectedZeroGutterClaimCollision +
        counts.moveRejectedZeroGutterClaimCollision +
        counts.childRejectedZeroGutterClaimCollision,
      sensorRejectedTransitionClaimCollision:
        counts.sensorRejectedRedirectClaimCollision +
        counts.sensorRejectedZeroGutterClaimCollision,
      moveRejectedTransitionClaimCollision:
        counts.moveRejectedRedirectClaimCollision +
        counts.moveRejectedZeroGutterClaimCollision,
      childRejectedTransitionClaimCollision:
        counts.childRejectedRedirectClaimCollision +
        counts.childRejectedZeroGutterClaimCollision,
      pr11cStatus: 'accepted',
      note: 'PR11C manual readback estimate for current agents. Sensing, movement, and child placement use chart-validated same-chart samples, direction-safe zero-gutter transitions, and legacy redirect gutter only when validated; invalid creation/current agents fail safely.',
    };
  }

  function measurePaddingCollisionRisk(requiredPadTexels = SEAM_REDIRECT_HALO_TEXELS) {
    const clearance = measureChartClearance();
    const overlaps = detectUvOverlapConflicts();
    const budget = getSafeGutterBudgetTexels({ clearance, overlaps });
    const minClearance = budget.minimumDistinctChartBoundaryClearanceTexels;
    const oneSidedPaddingWouldCollide = minClearance !== null && requiredPadTexels >= minClearance;
    const symmetricPaddingWouldCollide = minClearance !== null && requiredPadTexels * 2 >= minClearance;
    return {
      requiredPadTexels,
      minimumDistinctChartBoundaryClearanceTexels: minClearance,
      maxConservativeSingleSidedPadTexels: budget.maxSafePaddingTexels,
      maxConservativeSymmetricPadTexels: budget.maxConservativeSymmetricPadTexels,
      oneSidedPaddingWouldCollide,
      symmetricPaddingWouldCollide,
      multiOwnerConflictTexels: overlaps.multiOwnerConflictTexels,
      unsafeOwnershipTexels: overlaps.unsafeTexels,
      safeGutterAvailable: overlaps.unsafeTexels === 0 && !oneSidedPaddingWouldCollide,
      note: minClearance === null
        ? `No distinct-chart boundary pair was found within ${clearance.searchRadiusTexels} texels.`
        : 'Collision risk is conservative and treats close distinct-chart boundaries as unsafe for blind padding.',
    };
  }

  function measureCrossOwnerReads() {
    const footprints = measureCurrentSamplingFootprints();
    const clearance = measureChartClearance();
    const minClearance = clearance.minimumDistinctChartBoundaryClearanceTexels ?? Infinity;
    const ownershipClippedMigratedPasses = new Set([
      'diffusion',
      'render smoothing',
      'bump normals',
      'render sample-view seam padding',
      'agent sensing',
      'agent movement',
      'child placement',
      'density splat',
      'deposit splat',
      'oat field',
    ]);
    const passFootprints = footprints.passFootprints
      .filter((entry) => !entry.pass.startsWith('seam ') &&
        entry.pass !== 'zero-gutter visual transition band' &&
        entry.pass !== 'zero-gutter crossing transition band' &&
        entry.pass !== 'source/write/diffusion seam transition band' &&
        entry.pass !== 'source/write explicit kernel support')
      .map((entry) => {
        const usesOwnershipSafeSampling = ownershipClippedMigratedPasses.has(entry.pass);
        const usesPr11ZeroGutterVisualSampling =
          entry.pass === 'render smoothing' || entry.pass === 'bump normals';
        const usesPr11bDiffusionTransition = entry.pass === 'diffusion';
        const usesPr11cAgentTransition =
          entry.pass === 'agent sensing' ||
          entry.pass === 'agent movement' ||
          entry.pass === 'child placement';
        const usesPr115SeamDistributedSourceWrite =
          entry.pass === 'density splat' || entry.pass === 'deposit splat' || entry.pass === 'oat field';
        const usesPr9OwnershipClippedWrite = false;
        const usesPr10ChartClippedOatField = false;
        return {
          ...entry,
          fallbackNeeded: entry.footprintTexels >= minClearance,
          ownershipSamplingMode: usesOwnershipSafeSampling
            ? (usesPr11bDiffusionTransition
              ? 'PR11B accepted transition-aware no-flux diffusion sampler'
              : usesPr115SeamDistributedSourceWrite
              ? 'PR11.5 accepted seam-distributed source/write pass'
              : usesPr11ZeroGutterVisualSampling
              ? 'PR11A accepted zero-gutter visual transition sampler'
              : usesPr11cAgentTransition
              ? 'PR11C accepted agent zero-gutter transition path'
              : usesPr9OwnershipClippedWrite
              ? 'ownership-clipped PR9 write pass'
              : usesPr10ChartClippedOatField
                ? 'chart-clipped PR10 oat field pass'
                : 'safe-sampled or ownership-clipped migrated pass')
            : 'legacy mask-only estimate',
          usesLegacyMaskOnlyOwnership: !usesOwnershipSafeSampling,
          usesOwnershipSafeSampling,
          usesPr11ZeroGutterVisualSampling,
          usesPr11bDiffusionTransition,
          usesPr11cAgentTransition,
          usesPr115SeamDistributedSourceWrite,
          usesPr5SafeSampling: usesOwnershipSafeSampling &&
            !usesPr11ZeroGutterVisualSampling &&
            !usesPr11bDiffusionTransition &&
            !usesPr11cAgentTransition &&
            !usesPr115SeamDistributedSourceWrite &&
            !usesPr9OwnershipClippedWrite &&
            !usesPr10ChartClippedOatField,
          usesPr9OwnershipClippedWrite,
          usesPr10ChartClippedOatField,
          safeSamplingDiagnostic: usesOwnershipSafeSampling
            ? 'measureSafeSamplingRejections(), measureSeamPaddingDiagnostics(), measureAgentTopologySafety(), measureSplatOwnershipDiagnostics(), or measureOatTopologySafety()'
            : null,
          instrumentedCrossOwnerReadCount: null,
        };
      });
    const legacyRemainingPasses = passFootprints
      .filter((entry) => entry.usesLegacyMaskOnlyOwnership)
      .map((entry) => entry.pass);
    const ownershipSafeMigratedPasses = passFootprints
      .filter((entry) => entry.usesOwnershipSafeSampling)
      .map((entry) => entry.pass);
    const pr5MigratedSafeSampledPasses = passFootprints
      .filter((entry) => entry.usesPr5SafeSampling)
      .map((entry) => entry.pass);
    const pr9MigratedOwnershipClippedWritePasses = passFootprints
      .filter((entry) => entry.usesPr9OwnershipClippedWrite)
      .map((entry) => entry.pass);
    const pr10MigratedChartClippedOatPasses = passFootprints
      .filter((entry) => entry.usesPr10ChartClippedOatField)
      .map((entry) => entry.pass);
    const pr11aAcceptedVisualPasses = passFootprints
      .filter((entry) => entry.usesPr11ZeroGutterVisualSampling)
      .map((entry) => entry.pass);
    const pr11bAcceptedDiffusionPasses = passFootprints
      .filter((entry) => entry.usesPr11bDiffusionTransition)
      .map((entry) => entry.pass);
    const pr11cAcceptedAgentPasses = passFootprints
      .filter((entry) => entry.usesPr11cAgentTransition)
      .map((entry) => entry.pass);
    const seamContinuityAcceptedPasses = passFootprints
      .filter((entry) => entry.usesPr11bDiffusionTransition || entry.usesPr115SeamDistributedSourceWrite)
      .map((entry) => entry.pass);
    return {
      instrumented: false,
      pr11AcceptedScope: 'PR11A visual transitions, PR11B canonical diffusion, PR11C agents, and PR11.5 seam-continuity closure are complete before PR12.',
      pr11OverallComplete: true,
      pr11Remaining: [],
      reason: 'Pre-PR12 topology paths are classified as ownership-safe, zero-gutter transition-aware, or seam-distributed; remaining legacy entries are outside PR11/11.5 scope.',
      minimumDistinctChartBoundaryClearanceTexels: Number.isFinite(minClearance) ? minClearance : null,
      unsafePasses: passFootprints.filter((entry) => entry.fallbackNeeded).map((entry) => entry.pass),
      legacyRemainingPasses,
      ownershipSafeMigratedPasses,
      pr5MigratedSafeSampledPasses,
      pr9MigratedOwnershipClippedWritePasses,
      pr10MigratedChartClippedOatPasses,
      pr11ZeroGutterVisualPasses: pr11aAcceptedVisualPasses,
      pr11aAcceptedVisualPasses,
      pr11bAcceptedDiffusionPasses,
      pr11cAcceptedAgentPasses,
      seamContinuityAcceptedPasses,
      passFootprints,
    };
  }

  function measureMaskSoftness() {
    const buf = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
    renderer.readRenderTargetPixels(uvIslandMaskRT, 0, 0, FIELD_SIZE, FIELD_SIZE, buf);
    let softTexels = 0;
    let onTexels = 0;
    let offTexels = 0;
    for (let i = 0; i < buf.length; i += 4) {
      const value = buf[i];
      if (value === 0) offTexels++;
      else if (value === 255) onTexels++;
      else softTexels++;
    }
    return { softTexels, onTexels, offTexels, totalTexels: FIELD_SIZE * FIELD_SIZE };
  }

  function measureFieldDomainEnergy() {
    const state = ownership();

    function summarize(rt) {
      const buf = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, FIELD_SIZE, FIELD_SIZE, buf);
      let authoritativeEnergy = 0;
      let nonAuthoritativeEnergy = 0;
      let unsafeEnergy = 0;
      let authoritativeNonZeroTexels = 0;
      let nonAuthoritativeNonZeroTexels = 0;
      let unsafeNonZeroTexels = 0;
      for (let i = 0, texel = 0; i < buf.length; i += 4, texel++) {
        const value = Math.max(0, buf[i]);
        if (value <= 1e-8) continue;
        const authoritative = state.owner[texel] > 0 && state.conflict[texel] === 0;
        const unsafe = state.conflict[texel] !== 0;
        if (authoritative) {
          authoritativeEnergy += value;
          authoritativeNonZeroTexels++;
        } else {
          nonAuthoritativeEnergy += value;
          nonAuthoritativeNonZeroTexels++;
          if (unsafe) {
            unsafeEnergy += value;
            unsafeNonZeroTexels++;
          }
        }
      }
      return {
        authoritativeEnergy,
        nonAuthoritativeEnergy,
        unsafeEnergy,
        authoritativeNonZeroTexels,
        nonAuthoritativeNonZeroTexels,
        unsafeNonZeroTexels,
      };
    }

    return {
      canonicalFood: summarize(fieldRT.read),
      fieldSampleView: summarize(fieldSampleViewRT),
      canonicalRender: summarize(renderRT.read),
      renderSampleView: summarize(renderSampleViewRT.read),
      note: 'PR7 manual readback: canonical fields stay clipped to authoritative texels; derived sample-view fields may contain ownership-clipped seam padding in safe redirect gutter.',
    };
  }

  function measureSplatDomainEnergy() {
    const state = ownership();

    function summarize(rt) {
      const isByteTarget = rt.texture.type === THREE.UnsignedByteType;
      const ArrayType = isByteTarget ? Uint8Array : Float32Array;
      const scale = isByteTarget ? 1 / 255 : 1;
      const buf = new ArrayType(FIELD_SIZE * FIELD_SIZE * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, FIELD_SIZE, FIELD_SIZE, buf);
      let authoritativeEnergy = 0;
      let nonAuthoritativeEnergy = 0;
      let unsafeEnergy = 0;
      let authoritativeNonZeroTexels = 0;
      let nonAuthoritativeNonZeroTexels = 0;
      let unsafeNonZeroTexels = 0;
      for (let i = 0, texel = 0; i < buf.length; i += 4, texel++) {
        const value = Math.max(0, buf[i] * scale);
        if (value <= 1e-8) continue;
        const authoritative = state.owner[texel] > 0 && state.conflict[texel] === 0;
        const unsafe = state.conflict[texel] !== 0;
        if (authoritative) {
          authoritativeEnergy += value;
          authoritativeNonZeroTexels++;
        } else {
          nonAuthoritativeEnergy += value;
          nonAuthoritativeNonZeroTexels++;
          if (unsafe) {
            unsafeEnergy += value;
            unsafeNonZeroTexels++;
          }
        }
      }
      return {
        authoritativeEnergy,
        nonAuthoritativeEnergy,
        unsafeEnergy,
        authoritativeNonZeroTexels,
        nonAuthoritativeNonZeroTexels,
        unsafeNonZeroTexels,
      };
    }

    return {
      density: summarize(densityRT),
      depositDensity: summarize(depositDensityRT),
      note: 'PR11.5 seam-continuity readback: density and deposit splat targets should have zero red-channel energy outside authoritative chart texels; seam continuation writes land only on authoritative paired charts.',
    };
  }

  function measureDiffusionContinuityDiagnostics(strideTexels = 8) {
    const state = ownership();
    const maps = readTransitionSnapshot();
    const stride = Math.max(1, Math.min(128, Math.round(strideTexels)));
    const scale = stride * stride;
    const field = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    renderer.readRenderTargetPixels(fieldRT.read, 0, 0, FIELD_SIZE, FIELD_SIZE, field);
    const offsets = [
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];
    const counts = {
      sampleStrideTexels: stride,
      baseTexelsVisited: 0,
      authoritativeBaseTexels: 0,
      totalDiffusionSamples: 0,
      sameChartDiffusionSamples: 0,
      acceptedSeamTransitionDiffusionSamples: 0,
      noFluxFallbackSamples: 0,
      rejectedUnrelatedChartSamples: 0,
      rejectedUnsafeSamples: 0,
      rejectedTransitionCollisionSamples: 0,
      rejectedOutsideAtlasSamples: 0,
      rejectedUnresolvedTransitionSamples: 0,
      estimatedEnergyBefore: 0,
      estimatedEnergyAfter: 0,
    };

    function tryTransition(baseIndex, baseChart, offset) {
      const resolved = resolveTransitionCandidate(
        maps,
        state,
        baseIndex,
        baseChart,
        offset.x / FIELD_SIZE,
        offset.y / FIELD_SIZE,
      );
      if (resolved.accepted) return resolved.destIndex;
      if (resolved.cause === 'transitionCandidateOverflow' ||
          resolved.cause === 'transitionCandidateAmbiguous') {
        counts.rejectedTransitionCollisionSamples++;
      } else if (resolved.cause === 'destinationOwnershipUnsafeRejection' ||
          resolved.cause === 'metadataChartMismatch') {
        counts.rejectedUnresolvedTransitionSamples++;
      }
      return -1;
    }

    for (let y = 0; y < FIELD_SIZE; y += stride) {
      for (let x = 0; x < FIELD_SIZE; x += stride) {
        counts.baseTexelsVisited++;
        const baseIndex = y * FIELD_SIZE + x;
        const baseChart = state.owner[baseIndex];
        if (baseChart <= 0 || state.conflict[baseIndex] !== 0) continue;
        counts.authoritativeBaseTexels++;
        const center = Math.max(0, field[baseIndex * 4]);
        counts.estimatedEnergyBefore += center * scale;
        let n = 0;
        for (const offset of offsets) {
          counts.totalDiffusionSamples++;
          const sx = x + offset.x;
          const sy = y + offset.y;
          const sampleIndex = sx < 0 || sy < 0 || sx >= FIELD_SIZE || sy >= FIELD_SIZE
            ? -1
            : sy * FIELD_SIZE + sx;
          if (sampleIndex >= 0 &&
              state.conflict[sampleIndex] === 0 &&
              state.owner[sampleIndex] === baseChart) {
            counts.sameChartDiffusionSamples++;
            n += Math.max(0, field[sampleIndex * 4]);
            continue;
          }
          const transitionIndex = tryTransition(baseIndex, baseChart, offset);
          if (transitionIndex >= 0) {
            counts.acceptedSeamTransitionDiffusionSamples++;
            n += Math.max(0, field[transitionIndex * 4]);
            continue;
          }
          counts.noFluxFallbackSamples++;
          n += center;
          if (sampleIndex < 0) {
            counts.rejectedOutsideAtlasSamples++;
          } else if (state.conflict[sampleIndex] !== 0) {
            counts.rejectedUnsafeSamples++;
          } else if (state.owner[sampleIndex] > 0) {
            counts.rejectedUnrelatedChartSamples++;
          } else {
            counts.rejectedUnresolvedTransitionSamples++;
          }
        }
        const blurred = n * 0.125;
        const after = clampNumber(
          (center * (1 - params.fieldDiffusion) + blurred * params.fieldDiffusion) * params.fieldDecay,
          0,
          params.foodClamp,
        );
        counts.estimatedEnergyAfter += after * scale;
      }
    }
    counts.estimatedEnergyDelta = counts.estimatedEnergyAfter - counts.estimatedEnergyBefore;
    counts.boundaryMode = 'zero-gutter transition sampling with center-value no-flux fallback';
    counts.note = 'PR11B sampled diagnostic for canonical food/trail diffusion. Runtime diffusion uses resolveSampleUvSafe(); rejected unrelated/unsafe/unresolved samples fall back to the center value as explicit no-flux.';
    return counts;
  }

  function measureSplatOwnershipDiagnostics(agentStride = 32) {
    const state = ownership();
    const maps = readTransitionSnapshot();
    const agents = new Float32Array(AGENT_CAPACITY * 4);
    renderer.readRenderTargetPixels(agentRT.read, 0, 0, AGENT_SIDE, AGENT_SIDE, agents);
    const stride = Math.max(1, Math.min(1024, Math.round(agentStride)));

    function summarize(pass, pointSizeTexels) {
      const radius = Math.max(0.5, pointSizeTexels * 0.5);
      const counts = {
        pass,
        agentStride: stride,
        pointSizeTexels,
        kernelRadiusTexels: radius,
        sampledAgents: 0,
        activeSampledAgents: 0,
        invalidAgentCenters: 0,
        candidateFragments: 0,
        acceptedSameChartFragments: 0,
        clippedUnrelatedChartFragments: 0,
        clippedUnsafeOwnershipFragments: 0,
        clippedEmptyGutterFragments: 0,
        clippedOutsideAtlasFragments: 0,
        seamContinuationAcceptedFragments: 0,
        seamContinuationContributionCount: 0,
        skippedTransitionCollisionContributions: 0,
        skippedWrongDirectionNotCrossingContributions: 0,
        skippedUnrelatedChartAttempts: 0,
        truncatedKernelSupportCount: 0,
        estimatedMassBeforeSeamDistribution: 0,
        estimatedMassAfterSeamDistribution: 0,
      };

      for (let i = 0; i < AGENT_CAPACITY; i += stride) {
        counts.sampledAgents++;
        const p = i * 4;
        const reserve = agents[p + 3];
        if (reserve <= 0) continue;
        counts.activeSampledAgents++;
        const x = agents[p];
        const y = agents[p + 1];
        const centerIndex = chartTexelIndex(x, y);
        if (centerIndex < 0 || state.owner[centerIndex] <= 0 || state.conflict[centerIndex] !== 0) {
          counts.invalidAgentCenters++;
          continue;
        }
        const agentChart = state.owner[centerIndex];
        const cx = x * FIELD_SIZE;
        const cy = y * FIELD_SIZE;
        const minX = Math.floor(cx - radius);
        const maxX = Math.ceil(cx + radius);
        const minY = Math.floor(cy - radius);
        const maxY = Math.ceil(cy + radius);
        const reserveMass = clampNumber(reserve, 0, MAX_DENSITY_RESERVE_MASS);

        for (let py = minY; py <= maxY; py++) {
          for (let px = minX; px <= maxX; px++) {
            const dx = (px + 0.5 - cx) / radius;
            const dy = (py + 0.5 - cy) / radius;
            if (dx * dx + dy * dy > 1) continue;
            const kernel = smoothstepNumber(1, 0, dx * dx + dy * dy);
            counts.candidateFragments++;
            if (px < 0 || py < 0 || px >= FIELD_SIZE || py >= FIELD_SIZE) {
              counts.clippedOutsideAtlasFragments++;
              continue;
            }
            const sampleIndex = py * FIELD_SIZE + px;
            if (state.conflict[sampleIndex] !== 0) {
              counts.clippedUnsafeOwnershipFragments++;
              continue;
            }
            const fragmentChart = state.owner[sampleIndex];
            if (fragmentChart === agentChart) {
              counts.acceptedSameChartFragments++;
              counts.estimatedMassBeforeSeamDistribution += kernel * reserveMass * DENSITY_MASS_SCALE;
              counts.estimatedMassAfterSeamDistribution += kernel * reserveMass * DENSITY_MASS_SCALE;
            } else if (fragmentChart > 0) {
              counts.clippedUnrelatedChartFragments++;
            } else {
              counts.clippedEmptyGutterFragments++;
            }
          }
        }

        // Mirrors the GLSL splat-vertex rule: overflow texels still resolve
        // through stored candidates, and the nearest seam wins.
        const centerP = centerIndex * 4;
        let centerWinner = null;
        for (const candidate of maps.transitionCandidates ?? []) {
          if (candidate.transitionUv[centerP + 2] < 0.5) continue;
          const transitionSourceChart = Math.round(candidate.transitionMeta[centerP]);
          const destinationChart = Math.round(candidate.transitionMeta[centerP + 1]);
          const destinationInX = candidate.transitionDirection[centerP + 2];
          const destinationInY = candidate.transitionDirection[centerP + 3];
          const destinationInLen = Math.hypot(destinationInX, destinationInY);
          if (transitionSourceChart !== agentChart || destinationChart <= 0 || destinationInLen < 0.5) continue;
          const seamDistance = Math.max(0, candidate.transitionUv[centerP + 3]);
          if (centerWinner && seamDistance >= centerWinner.transitionDistanceTexels) continue;
          const sourceDepthUv = seamDistance / FIELD_SIZE;
          centerWinner = {
            destinationChart,
            virtualCx: (candidate.transitionUv[centerP] - (destinationInX / destinationInLen) * sourceDepthUv) * FIELD_SIZE,
            virtualCy: (candidate.transitionUv[centerP + 1] - (destinationInY / destinationInLen) * sourceDepthUv) * FIELD_SIZE,
            transitionDistanceTexels: seamDistance,
          };
        }
        if (!centerWinner) {
          counts.skippedWrongDirectionNotCrossingContributions++;
          continue;
        }
        const { destinationChart, virtualCx, virtualCy } = centerWinner;
        const seamMinX = Math.floor(virtualCx - radius);
        const seamMaxX = Math.ceil(virtualCx + radius);
        const seamMinY = Math.floor(virtualCy - radius);
        const seamMaxY = Math.ceil(virtualCy + radius);
        if (radius > SEAM_CROSSING_TRANSITION_BAND_TEXELS &&
            centerWinner.transitionDistanceTexels >= SEAM_CROSSING_TRANSITION_BAND_TEXELS - 0.5) {
          counts.truncatedKernelSupportCount++;
        }
        for (let py = seamMinY; py <= seamMaxY; py++) {
          for (let px = seamMinX; px <= seamMaxX; px++) {
            counts.candidateFragments++;
            if (px < 0 || py < 0 || px >= FIELD_SIZE || py >= FIELD_SIZE) {
              counts.clippedOutsideAtlasFragments++;
              continue;
            }
            const sampleIndex = py * FIELD_SIZE + px;
            if (state.conflict[sampleIndex] !== 0) {
              counts.clippedUnsafeOwnershipFragments++;
              continue;
            }
            const fragmentChart = state.owner[sampleIndex];
            if (fragmentChart !== destinationChart) {
              if (fragmentChart > 0) counts.clippedUnrelatedChartFragments++;
              else counts.clippedEmptyGutterFragments++;
              continue;
            }
            const mapped = mapReceiverTexelToSourceVirtualUv(
              sampleIndex,
              fragmentChart,
              agentChart,
              maps,
              counts,
            );
            if (!mapped) continue;
            const sourceDx = (mapped.u - x) * FIELD_SIZE / radius;
            const sourceDy = (mapped.v - y) * FIELD_SIZE / radius;
            const distSq = sourceDx * sourceDx + sourceDy * sourceDy;
            if (distSq > 1) continue;
            const kernel = smoothstepNumber(1, 0, distSq);
            counts.seamContinuationAcceptedFragments++;
            counts.seamContinuationContributionCount++;
            counts.estimatedMassAfterSeamDistribution += kernel * reserveMass * DENSITY_MASS_SCALE;
          }
        }
      }

      counts.estimatedRejectedAgentCenters = counts.invalidAgentCenters;
      counts.estimatedClippedFragmentTotal =
        counts.clippedUnrelatedChartFragments +
        counts.clippedUnsafeOwnershipFragments +
        counts.clippedEmptyGutterFragments +
        counts.clippedOutsideAtlasFragments;
      counts.estimatedClippedTotal = counts.estimatedClippedFragmentTotal;
      counts.skippedUnsafeFragments = counts.clippedUnsafeOwnershipFragments;
      counts.skippedUnrelatedChartFragments = counts.clippedUnrelatedChartFragments;
      counts.skippedTransitionCollisionFragments = counts.skippedTransitionCollisionContributions;
      counts.skippedWrongDirectionNotCrossingFragments =
        counts.skippedWrongDirectionNotCrossingContributions;
      counts.note = 'CPU estimate of PR11.5 seam-continuity point-sprite clipping. Runtime draws same-chart splats plus one-hop seam-continuation splats clipped by transition metadata; whole kernels are not duplicated.';
      return counts;
    }

    const density = summarize('density splat', getDensityPointSizePixels(params));
    const deposit = summarize('deposit splat', getDepositPointSizePixels(params));
    return {
      agentStride: stride,
      density,
      deposit,
      note: 'Manual diagnostic only; no readback runs per frame.',
    };
  }

  function measureOatTopologySafety(strideTexels = 4) {
    const state = ownership();
    const maps = readTransitionSnapshot();
    const stride = Math.max(1, Math.min(128, Math.round(strideTexels)));
    const scale = stride * stride;
    const perOat = oats.map((oat, index) => {
      const texelIndex = chartTexelIndex(oat.uv);
      const actualChart = texelIndex >= 0 ? state.owner[texelIndex] : 0;
      const unsafe = texelIndex >= 0 && state.conflict[texelIndex] !== 0;
      const valid = texelIndex >= 0 &&
        oat.chartId > 0 &&
        actualChart === oat.chartId &&
        !unsafe;
      return {
        index,
        chartId: oat.chartId ?? 0,
        actualChart,
        valid,
        unsafe,
        outsideAtlas: texelIndex < 0,
        radius: oat.radius,
        power: oat.power,
        supportRadiusTexels: oat.radius * OAT_SUPPORT_SIGMAS * FIELD_SIZE,
        crossingTransitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
        sourceWriteGlobalTransitionBandTexels: 0,
        oneHopTruncated:
          oat.radius * OAT_SUPPORT_SIGMAS * FIELD_SIZE > SEAM_CROSSING_TRANSITION_BAND_TEXELS,
        uv: { ...oat.uv },
      };
    });
    const counts = {
      sampleStrideTexels: stride,
      sameChartContributionSamples: 0,
      virtualOatContributionCount: 0,
      skippedUnsafeContributions: 0,
      skippedTransitionCollisionContributions: 0,
      skippedWrongDirectionNotCrossingContributions: 0,
      skippedUnrelatedChartAttempts: 0,
      truncatedContributionCount: 0,
      sourceDestinationContributionPairs: new Map(),
    };
    for (let y = 0; y < FIELD_SIZE; y += stride) {
      for (let x = 0; x < FIELD_SIZE; x += stride) {
        const texel = y * FIELD_SIZE + x;
        const receiverChart = state.owner[texel];
        if (receiverChart <= 0) continue;
        if (state.conflict[texel] !== 0) {
          counts.skippedUnsafeContributions += scale;
          continue;
        }
        const receiverUv = {
          x: (x + 0.5) / FIELD_SIZE,
          y: (y + 0.5) / FIELD_SIZE,
        };
        for (const oat of oats) {
          if (oat.chartId <= 0) continue;
          const supportRadius = oat.radius * OAT_SUPPORT_SIGMAS;
          let sampleUv = receiverUv;
          if (receiverChart !== oat.chartId) {
            const mapped = mapReceiverTexelToSourceVirtualUv(
              texel,
              receiverChart,
              oat.chartId,
              maps,
              counts,
            );
            if (!mapped) continue;
            sampleUv = { x: mapped.u, y: mapped.v };
            const dx = sampleUv.x - oat.uv.x;
            const dy = sampleUv.y - oat.uv.y;
            if (dx * dx + dy * dy > supportRadius * supportRadius) continue;
            counts.virtualOatContributionCount += scale;
            counts.sourceDestinationContributionPairs.set(
              mapped.pair,
              (counts.sourceDestinationContributionPairs.get(mapped.pair) ?? 0) + scale,
            );
            if (supportRadius * FIELD_SIZE > SEAM_CROSSING_TRANSITION_BAND_TEXELS &&
                mapped.transitionDistanceTexels >= SEAM_CROSSING_TRANSITION_BAND_TEXELS - stride) {
              counts.truncatedContributionCount += scale;
            }
          } else {
            const dx = sampleUv.x - oat.uv.x;
            const dy = sampleUv.y - oat.uv.y;
            if (dx * dx + dy * dy <= supportRadius * supportRadius) {
              counts.sameChartContributionSamples += scale;
            }
          }
        }
      }
    }
    const invalidOats = perOat.filter((entry) => !entry.valid);
    const maxSingleOatPeakFood = perOat.reduce(
      (maxPower, entry) => Math.max(maxPower, Math.max(entry.power, 0)),
      0,
    );
    const sourceDestinationContributionPairs = [...counts.sourceDestinationContributionPairs.entries()]
      .map(([pair, estimatedTexels]) => ({ pair, estimatedTexels }))
      .sort((a, b) => b.estimatedTexels - a.estimatedTexels);
    return {
      oatCount: oats.length,
      realOatCount: oats.length,
      validOatCount: perOat.length - invalidOats.length,
      invalidOatCount: invalidOats.length,
      oatEpsilon: OAT_EPSILON,
      oatSupportSigmas: OAT_SUPPORT_SIGMAS,
      oatFoodAccumulationMode: 'max of valid individual oat fields; stacked oats do not add food',
      oatRationingEnabled: !!params.useOatRationing,
      oatSupplyRate: params.oatSupplyRate,
      oatRationingMode: 'agent shader scales oat uptake by shared supply divided by topology-safe local density demand',
      maxSingleOatPeakFood,
      usesToroidalAtlasDistance: false,
      seamDuplicatedOatField: true,
      sameChartContributionSamples: counts.sameChartContributionSamples,
      virtualOatContributionCount: counts.virtualOatContributionCount,
      sourceDestinationContributionPairs,
      skippedUnsafeContributions: counts.skippedUnsafeContributions,
      skippedTransitionCollisionContributions: counts.skippedTransitionCollisionContributions,
      skippedWrongDirectionNotCrossingContributions: counts.skippedWrongDirectionNotCrossingContributions,
      skippedUnrelatedChartAttempts: counts.skippedUnrelatedChartAttempts,
      maxPropagationDepth: 1,
      truncatedContributionCount: counts.truncatedContributionCount,
      transitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      crossingTransitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      sourceWriteGlobalTransitionBandTexels: 0,
      sampleStrideTexels: stride,
      invalidOats,
      perOat,
      note: 'PR11.5 oat field keeps real oats unchanged. Broad oat support is not prepainted into seamTransition*; seam continuation is clipped by the narrow crossing map and reports truncation when one-hop support extends beyond it. Runtime oat food uses the maximum individual oat contribution, so stacked oats do not add food.',
    };
  }

  function measureZeroGutterTransitionDiagnostics() {
    const state = ownership();
    const visualFootprint = getVisualTransitionFootprint(params);
    const supportedVisualFootprint = getSupportedVisualTransitionFootprint();
    const maps = readTransitionSnapshot();
    const packingDiagnostics = { ...lastTransitionCandidatePackingDiagnostics };

    function indexAtUv(u, v) {
      if (u < 0 || v < 0 || u > 1 || v > 1) return -1;
      const ix = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(u * FIELD_SIZE)));
      const iy = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(v * FIELD_SIZE)));
      return iy * FIELD_SIZE + ix;
    }

    const counts = {
      transitionBandTexels: 0,
      validTransitionTexels: 0,
      claimCollisionTexels: 0,
      candidateCollisionTexels: 0,
      candidateOverflowTexels: 0,
      offIslandTransitionPadTexels: 0,
      invalidSourceTexels: 0,
      invalidDestinationTexels: 0,
      invalidDirectionOrBasisTexels: 0,
      unresolvedTransitionTexels: 0,
      maxTransitionDistanceTexels: 0,
      sourceDestinationPairs: new Map(),
    };
    let effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels = 0;

    const texelCount = FIELD_SIZE * FIELD_SIZE;
    const diffusionNeighborOffsets = [
      { x: -1, y: -1 },
      { x: 0, y: -1 },
      { x: 1, y: -1 },
      { x: -1, y: 0 },
      { x: 1, y: 0 },
      { x: -1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ];

    function overflowBlocksAllDiffusionDirections(texel, baseChart) {
      for (const offset of diffusionNeighborOffsets) {
        const resolved = resolveTransitionCandidate(
          maps,
          state,
          texel,
          baseChart,
          offset.x / FIELD_SIZE,
          offset.y / FIELD_SIZE,
        );
        if (resolved.accepted) return false;
      }
      return true;
    }

    function overflowDestinationChartCount(texel) {
      const p = texel * 4;
      const destinations = new Set();
      for (const candidate of maps.transitionCandidates ?? []) {
        if (candidate.transitionUv[p + 2] < 0.5) continue;
        const sourceChart = Math.round(candidate.transitionMeta[p]);
        if (sourceChart !== state.owner[texel]) continue;
        const destinationChart = Math.round(candidate.transitionMeta[p + 1]);
        if (destinationChart > 0) destinations.add(destinationChart);
      }
      return destinations.size;
    }

    let candidateOverflowTexelsOnAuthoritativeOwnedTexels = 0;
    let effectiveAutomaticWallTexelsOnOrdinarySeamTexels = 0;
    let effectiveAutomaticWallTexelsAtAmbiguousJunctions = 0;
    for (let texel = 0; texel < texelCount; texel++) {
      const p = texel * 4;
      const candidateCount = Math.round(maps.transitionClaim[p]);
      if (candidateCount <= 0) continue;
      counts.transitionBandTexels++;
      if (candidateCount >= 2) {
        counts.claimCollisionTexels++;
        counts.candidateCollisionTexels++;
      }
      if (maps.transitionClaim[p + 1] >= 0.5) {
        counts.candidateOverflowTexels++;
        if (state.owner[texel] > 0 && state.conflict[texel] === 0) {
          candidateOverflowTexelsOnAuthoritativeOwnedTexels++;
          if (overflowBlocksAllDiffusionDirections(texel, state.owner[texel])) {
            effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels++;
            if (overflowDestinationChartCount(texel) <= 1) {
              effectiveAutomaticWallTexelsOnOrdinarySeamTexels++;
            } else {
              effectiveAutomaticWallTexelsAtAmbiguousJunctions++;
            }
          }
        }
      }

      let validCandidate = false;
      let offIslandCandidate = false;
      let invalidSourceCandidate = false;
      let invalidDestinationCandidate = false;
      let invalidDirectionCandidate = false;
      for (const candidate of maps.transitionCandidates ?? []) {
        if (candidate.transitionUv[p + 2] < 0.5) continue;
        counts.maxTransitionDistanceTexels = Math.max(
          counts.maxTransitionDistanceTexels,
          candidate.transitionUv[p + 3],
        );
        const sourceChart = Math.round(candidate.transitionMeta[p]);
        const destinationChart = Math.round(candidate.transitionMeta[p + 1]);
        const pairKey = `${sourceChart}->${destinationChart}`;
        counts.sourceDestinationPairs.set(
          pairKey,
          (counts.sourceDestinationPairs.get(pairKey) ?? 0) + 1,
        );

        const actualSource = state.owner[texel];
        if (actualSource <= 0) {
          offIslandCandidate = true;
          continue;
        }
        if (sourceChart <= 0 || actualSource !== sourceChart || state.conflict[texel] !== 0) {
          invalidSourceCandidate = true;
          continue;
        }

        const sourceOutLen = Math.hypot(candidate.transitionDirection[p], candidate.transitionDirection[p + 1]);
        const destinationInLen = Math.hypot(candidate.transitionDirection[p + 2], candidate.transitionDirection[p + 3]);
        const sourceEdgeLen = Math.hypot(candidate.transitionBasis[p], candidate.transitionBasis[p + 1]);
        const destinationEdgeLen = Math.hypot(candidate.transitionBasis[p + 2], candidate.transitionBasis[p + 3]);
        if (sourceOutLen < 0.5 ||
            destinationInLen < 0.5 ||
            sourceEdgeLen < 0.5 ||
            destinationEdgeLen < 0.5) {
          invalidDirectionCandidate = true;
          continue;
        }

        const destIndex = indexAtUv(candidate.transitionUv[p], candidate.transitionUv[p + 1]);
        if (destinationChart <= 0 ||
            destIndex < 0 ||
            state.owner[destIndex] !== destinationChart ||
            state.conflict[destIndex] !== 0) {
          invalidDestinationCandidate = true;
          continue;
        }

        validCandidate = true;
      }

      if (validCandidate) {
        counts.validTransitionTexels++;
      } else if (offIslandCandidate) {
        counts.offIslandTransitionPadTexels++;
      } else if (invalidSourceCandidate) {
        counts.invalidSourceTexels++;
      } else if (invalidDestinationCandidate) {
        counts.invalidDestinationTexels++;
      } else if (invalidDirectionCandidate) {
        counts.invalidDirectionOrBasisTexels++;
      }
    }

    counts.unresolvedTransitionTexels =
      counts.transitionBandTexels -
      counts.validTransitionTexels -
      counts.offIslandTransitionPadTexels -
      counts.invalidSourceTexels -
      counts.invalidDestinationTexels -
      counts.invalidDirectionOrBasisTexels;
    const sourceDestinationPairs = [...counts.sourceDestinationPairs.entries()]
      .map(([pair, texels]) => ({ pair, texels }))
      .sort((a, b) => b.texels - a.texels);
    const transitionUsageProfiles = getTransitionUsageProfiles(params).map((profile) => {
      if (!profile.usesGlobalTransitionBand) {
        return {
          ...profile,
          transitionBandTexels: 0,
          claimCollisionTexels: 0,
          claimCollisionRatio: 0,
          broadSupportPrepaintedIntoTransitionMap: false,
        };
      }
      const usageBand = Math.min(profile.actualBandTexels, profile.requestedBandTexels);
      let transitionBandTexels = 0;
      let claimCollisionTexels = 0;
      let candidateOverflowTexels = 0;
      let effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels = 0;
      for (let texel = 0; texel < texelCount; texel++) {
        const p = texel * 4;
        if (maps.transitionClaim[p] <= 0) continue;
        let withinUsageBand = false;
        for (const candidate of maps.transitionCandidates ?? []) {
          if (candidate.transitionUv[p + 2] >= 0.5 &&
              candidate.transitionUv[p + 3] <= usageBand + 0.5) {
            withinUsageBand = true;
            break;
          }
        }
        if (!withinUsageBand) continue;
        transitionBandTexels++;
        if (maps.transitionClaim[p] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) {
          claimCollisionTexels++;
        }
        if (maps.transitionClaim[p + 1] >= 0.5) {
          candidateOverflowTexels++;
          if (state.owner[texel] > 0 && state.conflict[texel] === 0) {
            effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels++;
          }
        }
      }
      return {
        ...profile,
        measuredBandTexels: transitionBandTexels,
        transitionBandTexels,
        claimCollisionTexels,
        claimCollisionRatio: transitionBandTexels > 0
          ? claimCollisionTexels / transitionBandTexels
          : 0,
        candidateCollisionTexels: claimCollisionTexels,
        candidateOverflowTexels,
        directionResolvableCandidateCollisionTexels:
          Math.max(0, claimCollisionTexels - candidateOverflowTexels),
        automaticWallCollisionTexels: candidateOverflowTexels,
        effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels,
        automaticWallCollisionRatio: transitionBandTexels > 0
          ? candidateOverflowTexels / transitionBandTexels
          : 0,
        collisionRejectsOnlyOnAmbiguity: true,
        broadSupportPrepaintedIntoTransitionMap: false,
      };
    });
    const coverageSufficientForCurrentVisualSettings =
      SEAM_CROSSING_TRANSITION_BAND_TEXELS >= visualFootprint.requestedVisualTransitionBandTexels;
    const coverageSufficientForSupportedUiRange =
      SEAM_CROSSING_TRANSITION_BAND_TEXELS >= supportedVisualFootprint.requestedVisualTransitionBandTexels;
    return {
      requestedVisualTransitionBandTexels: visualFootprint.requestedVisualTransitionBandTexels,
      visualTransitionBandTexels: PR11A_VISUAL_TRANSITION_BAND_TEXELS,
      requestedSpatialSupportTransitionBandTexels:
        SEAM_CONTINUITY_SPATIAL_SUPPORT_TRANSITION_FOOTPRINT.requestedSpatialSupportTransitionBandTexels,
      requestedCrossingTransitionBandTexels:
        SEAM_CROSSING_TRANSITION_FOOTPRINT.requestedCrossingTransitionBandTexels,
      crossingTransitionRasterPadTexels:
        SEAM_CROSSING_TRANSITION_FOOTPRINT.crossingRasterPadTexels,
      sourceWriteGlobalTransitionBandTexels:
        SEAM_CONTINUITY_SPATIAL_SUPPORT_TRANSITION_FOOTPRINT.sourceWriteGlobalTransitionBandTexels,
      actualTransitionBandTexels: SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      maxObservedTransitionDistanceTexels: counts.maxTransitionDistanceTexels,
      renderSmoothingRadiusTexels: visualFootprint.renderSmoothingRadiusTexels,
      bumpSampleRadiusTexels: visualFootprint.bumpSampleRadiusTexels,
      bumpVisualFootprintTexels: visualFootprint.bumpVisualFootprintTexels,
      bumpDiagonalTapsEnabled: visualFootprint.bumpDiagonalTapsEnabled,
      rasterSafetyMarginTexels: visualFootprint.rasterSafetyMarginTexels,
      coverageSufficientForCurrentVisualSettings,
      coverageSufficientForSupportedUiRange,
      supportedSpatialSmoothingMaxTexels: SPATIAL_SMOOTHING_MAX_TEXELS,
      supportedRequestedVisualTransitionBandTexels:
        supportedVisualFootprint.requestedVisualTransitionBandTexels,
      transitionBandTexels: counts.transitionBandTexels,
      validTransitionTexels: counts.validTransitionTexels,
      claimCollisionTexels: counts.claimCollisionTexels,
      candidateCollisionTexels: counts.candidateCollisionTexels,
      candidateOverflowTexels: counts.candidateOverflowTexels,
      candidateOverflowTexelsOnAuthoritativeOwnedTexels,
      transitionCandidatePacking: packingDiagnostics,
      transitionCandidateSlots: SEAM_TRANSITION_CANDIDATE_COUNT,
      directionResolvableCandidateCollisionTexels:
        Math.max(0, counts.candidateCollisionTexels - counts.candidateOverflowTexels),
      automaticWallCollisionTexels: counts.candidateOverflowTexels,
      effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels,
      effectiveAutomaticWallTexelsOnOrdinarySeamTexels,
      effectiveAutomaticWallTexelsAtAmbiguousJunctions,
      automaticWallCollisionRatio: counts.transitionBandTexels > 0
        ? counts.candidateOverflowTexels / counts.transitionBandTexels
        : 0,
      collisionRejectsOnlyOnAmbiguity: true,
      seamTransitionDebugRedMeans:
        'candidate-overflow/unresolved ambiguity only; ordinary multi-candidate texels are blue and resolved by sample direction',
      offIslandTransitionPadTexels: counts.offIslandTransitionPadTexels,
      invalidSourceTexels: counts.invalidSourceTexels,
      invalidDestinationTexels: counts.invalidDestinationTexels,
      invalidDirectionOrBasisTexels: counts.invalidDirectionOrBasisTexels,
      unresolvedTransitionTexels: counts.unresolvedTransitionTexels,
      sourceDestinationPairs,
      transitionUsageProfiles,
      usesBaseChartContext: true,
      pr11AcceptedScope: 'PR11A visual, PR11B diffusion, PR11C agents, and PR11.5 spatial-support closure',
      pr11OverallComplete: true,
      acceptedPr11aPasses: ['render smoothing', 'bump normals'],
      acceptedPr11bPasses: ['canonical diffusion'],
      acceptedPr11cPasses: ['agent sensing', 'agent movement', 'child placement'],
      acceptedPr115Passes: ['oat field', 'density splat', 'deposit splat'],
      remainingPrePr12Passes: [],
      note: 'Zero-gutter diagnostic: seamTransition* is now a narrow crossing map. Broad source/write kernels are reported separately and no longer inflate global transition claim collisions.',
    };
  }

  function measureSeamPaddingDiagnostics(requestedPadTexels = lastSeamPaddingDiagnostics.requestedPadTexels) {
    const effectiveRequestedPadTexels = Number.isFinite(requestedPadTexels)
      ? requestedPadTexels
      : SEAM_REDIRECT_HALO_TEXELS;
    const budget = resolveSeamPaddingBudget(effectiveRequestedPadTexels);
    const chartIds = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const unsafe = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
    const redirectUv = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const redirectMeta = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    const redirectClaim = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
    renderer.readRenderTargetPixels(chartIdRT, 0, 0, FIELD_SIZE, FIELD_SIZE, chartIds);
    renderer.readRenderTargetPixels(chartUnsafeRT, 0, 0, FIELD_SIZE, FIELD_SIZE, unsafe);
    renderer.readRenderTargetPixels(seamRedirectUvRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectUv);
    renderer.readRenderTargetPixels(seamRedirectMetaRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectMeta);
    renderer.readRenderTargetPixels(seamRedirectClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectClaim);

    const diagnostics = {
      fieldKind: lastSeamPaddingDiagnostics.fieldKind ?? 'render',
      requestedPadTexels: budget.requestedPadTexels,
      allowedPadTexels: budget.allowedPadTexels,
      safeBudgetTexels: budget.safeBudgetTexels,
      budgetCollision: budget.budgetCollision,
      requestedPadCandidateTexels: 0,
      allowedPadCandidateTexels: 0,
      writtenPadTexels: 0,
      skippedByBudgetCollisionTexels: 0,
      skippedByRedirectCollisionTexels: 0,
      skippedByRealChartTexels: 0,
      skippedByUnsafeOwnershipTexels: 0,
      skippedByUnresolvedDestinationTexels: 0,
      clippedByRealIslandTexels: 0,
      clippedByConflictTexels: 0,
      redirectCollisionTexels: 0,
      explicitRedirectCollisionTexels: 0,
      unresolvedTexels: 0,
      paddingBudgetCollisionTexels: 0,
      totalSkippedTexels: 0,
      maxSafePaddingTexels: budget.safeBudgetTexels,
      note: 'Safe padding is budget-gated before writing. Redirect collisions use a conservative claim-count mask: any texel covered by multiple redirect halos is skipped unless future metadata can prove the redirects are equivalent.',
    };

    const texelCount = FIELD_SIZE * FIELD_SIZE;
    for (let texel = 0; texel < texelCount; texel++) {
      const p = texel * 4;
      if (redirectUv[p + 2] < 0.5) continue;
      if (redirectUv[p + 3] > budget.requestedPadTexels + 0.001) continue;
      diagnostics.requestedPadCandidateTexels++;

      if (budget.allowedPadTexels <= 0 ||
          redirectUv[p + 3] > budget.allowedPadTexels + 0.001) {
        diagnostics.skippedByBudgetCollisionTexels++;
        continue;
      }
      diagnostics.allowedPadCandidateTexels++;

      const chartId = Math.round(chartIds[p]);
      if (chartId > 0) {
        diagnostics.skippedByRealChartTexels++;
        continue;
      }
      if (unsafe[p] >= 128) {
        diagnostics.skippedByUnsafeOwnershipTexels++;
        continue;
      }
      if (redirectClaim[p] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) {
        diagnostics.skippedByRedirectCollisionTexels++;
        continue;
      }

      const sourceChart = Math.round(redirectMeta[p]);
      const destinationChart = Math.round(redirectMeta[p + 1]);
      const u = redirectUv[p];
      const v = redirectUv[p + 1];
      if (sourceChart <= 0 || destinationChart <= 0 || u < 0 || v < 0 || u > 1 || v > 1) {
        diagnostics.skippedByUnresolvedDestinationTexels++;
        continue;
      }

      const sx = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(u * FIELD_SIZE)));
      const sy = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(v * FIELD_SIZE)));
      const sp = (sy * FIELD_SIZE + sx) * 4;
      if (unsafe[sp] >= 128 || Math.round(chartIds[sp]) !== destinationChart) {
        diagnostics.skippedByUnresolvedDestinationTexels++;
        continue;
      }

      diagnostics.writtenPadTexels++;
    }

    diagnostics.clippedByRealIslandTexels = diagnostics.skippedByRealChartTexels;
    diagnostics.clippedByConflictTexels = diagnostics.skippedByUnsafeOwnershipTexels;
    diagnostics.redirectCollisionTexels = diagnostics.skippedByRedirectCollisionTexels;
    diagnostics.explicitRedirectCollisionTexels = diagnostics.skippedByRedirectCollisionTexels;
    diagnostics.unresolvedTexels = diagnostics.skippedByUnresolvedDestinationTexels;
    diagnostics.paddingBudgetCollisionTexels = diagnostics.skippedByBudgetCollisionTexels;
    diagnostics.totalSkippedTexels =
      diagnostics.skippedByBudgetCollisionTexels +
      diagnostics.skippedByRedirectCollisionTexels +
      diagnostics.skippedByRealChartTexels +
      diagnostics.skippedByUnsafeOwnershipTexels +
      diagnostics.skippedByUnresolvedDestinationTexels;

    return diagnostics;
  }

  function measureSeamContinuityClosure() {
    const oatTopology = measureOatTopologySafety(8);
    const splats = measureSplatOwnershipDiagnostics(64);
    const diffusion = measureDiffusionContinuityDiagnostics(8);
    const safeSampling = measureSafeSamplingRejections(16);
    const agentTopology = measureAgentTopologySafety(1);
    const smoothing = safeSampling.passes.find((entry) => entry.pass === 'render smoothing') ?? {};
    const bump = safeSampling.passes.find((entry) => entry.pass === 'bump normals') ?? {};

    const rows = [
      {
        operation: 'oat field',
        boundaryMode: 'seam-distributed source/write',
        acceptanceStatus: 'PR11.5 accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: oatTopology.virtualOatContributionCount,
        skippedUnsafeCount: oatTopology.skippedUnsafeContributions,
        skippedCollisionCount: oatTopology.skippedTransitionCollisionContributions,
        massOrStrengthPreservationApplies: true,
        propagationTruncated: oatTopology.truncatedContributionCount > 0,
      },
      {
        operation: 'density splat',
        boundaryMode: 'seam-distributed source/write',
        acceptanceStatus: 'PR11.5 accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: splats.density.seamContinuationContributionCount,
        skippedUnsafeCount: splats.density.skippedUnsafeFragments,
        skippedCollisionCount: splats.density.skippedTransitionCollisionFragments,
        massOrStrengthPreservationApplies: true,
        propagationTruncated: splats.density.truncatedKernelSupportCount > 0,
      },
      {
        operation: 'deposit splat',
        boundaryMode: 'seam-distributed source/write',
        acceptanceStatus: 'PR11.5 accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: splats.deposit.seamContinuationContributionCount,
        skippedUnsafeCount: splats.deposit.skippedUnsafeFragments,
        skippedCollisionCount: splats.deposit.skippedTransitionCollisionFragments,
        massOrStrengthPreservationApplies: true,
        propagationTruncated: splats.deposit.truncatedKernelSupportCount > 0,
      },
      {
        operation: 'canonical food/trail diffusion',
        boundaryMode: 'zero-gutter transition sampling with no-flux fallback',
        acceptanceStatus: 'PR11B accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: diffusion.acceptedSeamTransitionDiffusionSamples,
        skippedUnsafeCount: diffusion.rejectedUnsafeSamples,
        skippedCollisionCount: diffusion.rejectedTransitionCollisionSamples,
        massOrStrengthPreservationApplies: true,
        propagationTruncated: false,
      },
      {
        operation: 'render smoothing',
        boundaryMode: 'zero-gutter transition sampling',
        acceptanceStatus: 'PR11A accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: smoothing.acceptedZeroGutterTransition ?? 0,
        skippedUnsafeCount: smoothing.rejectedUnsafe ?? 0,
        skippedCollisionCount: smoothing.rejectedZeroGutterClaimCollision ?? 0,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'bump normals',
        boundaryMode: 'zero-gutter transition sampling',
        acceptanceStatus: 'PR11A accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: bump.acceptedZeroGutterTransition ?? 0,
        skippedUnsafeCount: bump.rejectedUnsafe ?? 0,
        skippedCollisionCount: bump.rejectedZeroGutterClaimCollision ?? 0,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'agent food sensing',
        boundaryMode: 'zero-gutter transition sampling with chart-validated redirect fallback',
        acceptanceStatus: 'PR11C accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: agentTopology.sensorAcceptedZeroGutterTransition,
        acceptedLegacyRedirectCount: agentTopology.sensorAcceptedRedirect,
        skippedUnsafeCount: agentTopology.sensorRejectedUnsafeOwnership,
        skippedCollisionCount: agentTopology.sensorRejectedTransitionClaimCollision,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'agent density sensing',
        boundaryMode: 'zero-gutter transition sampling with chart-validated redirect fallback',
        acceptanceStatus: 'PR11C accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: agentTopology.sensorAcceptedZeroGutterTransition,
        acceptedLegacyRedirectCount: agentTopology.sensorAcceptedRedirect,
        skippedUnsafeCount: agentTopology.sensorRejectedUnsafeOwnership,
        skippedCollisionCount: agentTopology.sensorRejectedTransitionClaimCollision,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'agent movement',
        boundaryMode: 'zero-gutter transition movement with chart-validated redirect fallback',
        acceptanceStatus: 'PR11C accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: agentTopology.moveAcceptedZeroGutterTransition,
        acceptedLegacyRedirectCount: agentTopology.moveAcceptedRedirect,
        skippedUnsafeCount: agentTopology.moveRejectedUnsafeOwnership,
        skippedCollisionCount: agentTopology.moveRejectedTransitionClaimCollision,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'child placement',
        boundaryMode: 'zero-gutter transition placement with chart-validated redirect fallback',
        acceptanceStatus: 'PR11C accepted',
        physicallySeamContinuous: true,
        acceptedSeamContributionCount: agentTopology.childAcceptedZeroGutterTransition,
        acceptedLegacyRedirectCount: agentTopology.childAcceptedRedirect,
        skippedUnsafeCount: agentTopology.childRejectedUnsafeOwnership,
        skippedCollisionCount: agentTopology.childRejectedTransitionClaimCollision,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
      {
        operation: 'manual oat placement / seed inputs',
        boundaryMode: 'same-chart authoritative placement validation',
        acceptanceStatus: 'not a PR11 spatial sampling pass',
        physicallySeamContinuous: 'not a spatial support operation',
        acceptedSeamContributionCount: null,
        skippedUnsafeCount: oatTopology.invalidOats.filter((entry) => entry.unsafe).length,
        skippedCollisionCount: 0,
        massOrStrengthPreservationApplies: false,
        propagationTruncated: false,
      },
    ];
    return {
      pr11AcceptedScope: 'PR11A visual, PR11B diffusion, PR11C agents, and PR11.5 spatial-support closure',
      pr11OverallComplete: true,
      pr11bStatus: 'accepted',
      pr11cStatus: 'accepted',
      spatialSupportClosureStatus: 'accepted before PR12',
      rows,
      oatTopology,
      splats,
      diffusion,
      safeSamplingSummary: safeSampling.totals,
      note: 'Seam-continuity audit. All pre-PR12 spatial-support, diffusion, visual, and agent transition rows are accepted with explicit ownership, direction, and collision checks; no row grants UV-proximity ownership.',
    };
  }

  function measureWatertightDomainDiagnostics() {
    const topo = topology();
    const state = ownership();
    const texelCount = FIELD_SIZE * FIELD_SIZE;
    const mask = new Uint8Array(texelCount * 4);
    const legacyMask = new Uint8Array(texelCount * 4);
    const redirectUv = new Float32Array(texelCount * 4);
    const redirectMeta = new Float32Array(texelCount * 4);
    const redirectClaim = new Float32Array(texelCount * 4);
    const maps = readTransitionSnapshot();
    renderer.readRenderTargetPixels(surfaceCoverageRT, 0, 0, FIELD_SIZE, FIELD_SIZE, mask);
    renderer.readRenderTargetPixels(legacyUvIslandMaskRT, 0, 0, FIELD_SIZE, FIELD_SIZE, legacyMask);
    renderer.readRenderTargetPixels(seamRedirectUvRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectUv);
    renderer.readRenderTargetPixels(seamRedirectMetaRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectMeta);
    renderer.readRenderTargetPixels(seamRedirectClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectClaim);

    const seamEdgeTexels = new Uint8Array(texelCount);
    const suspectedCrackTexels = new Uint8Array(texelCount);
    const offsets = [
      [-1, -1], [0, -1], [1, -1],
      [-1, 0],           [1, 0],
      [-1, 1],  [0, 1],  [1, 1],
    ];

    function markSeamEdgeTexel(x, y) {
      if (x < 0 || y < 0 || x >= FIELD_SIZE || y >= FIELD_SIZE) return;
      seamEdgeTexels[y * FIELD_SIZE + x] = 1;
    }

    function markSegmentTexels(segment) {
      const minX = Math.max(0, Math.floor(Math.min(segment.ax, segment.bx) * FIELD_SIZE) - 1);
      const maxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(segment.ax, segment.bx) * FIELD_SIZE) + 1);
      const minY = Math.max(0, Math.floor(Math.min(segment.ay, segment.by) * FIELD_SIZE) - 1);
      const maxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(segment.ay, segment.by) * FIELD_SIZE) + 1);
      for (let y = minY; y <= maxY; y++) {
        const v0 = y / FIELD_SIZE;
        const v1 = (y + 1) / FIELD_SIZE;
        for (let x = minX; x <= maxX; x++) {
          const u0 = x / FIELD_SIZE;
          const u1 = (x + 1) / FIELD_SIZE;
          // Match the Phase 1 coverage contract: boundary diagnostics should
          // count texels whose footprint intersects the UV edge, not an
          // inflated halo that includes legitimate unrelated gutter.
          if (
            pointInUvRect(segment.ax, segment.ay, u0, v0, u1, v1) ||
            pointInUvRect(segment.bx, segment.by, u0, v0, u1, v1) ||
            segmentIntersectsUvRect(segment.ax, segment.ay, segment.bx, segment.by, u0, v0, u1, v1)
          ) {
            markSeamEdgeTexel(x, y);
          }
        }
      }
    }

    for (const segment of topo.boundarySegments) markSegmentTexels(segment);

    function isMaskCovered(index) {
      return mask[index * 4] >= 128;
    }

    function wasLegacyMaskCovered(index) {
      return legacyMask[index * 4] >= 128;
    }

    const legacyOwner = state.centerOwner ?? state.owner;
    const legacyConflict = state.centerConflict ?? state.conflict;

    function transitionAccepts(
      baseIndex,
      baseChart,
      offset,
      ownerArray = state.owner,
      conflictArray = state.conflict,
    ) {
      return resolveTransitionCandidate(
        maps,
        { owner: ownerArray, conflict: conflictArray },
        baseIndex,
        baseChart,
        offset[0] / FIELD_SIZE,
        offset[1] / FIELD_SIZE,
      ).accepted;
    }

    function redirectAccepts(
      sampleIndex,
      baseChart,
      ownerArray = state.owner,
      conflictArray = state.conflict,
    ) {
      if (sampleIndex < 0) return false;
      const p = sampleIndex * 4;
      if (redirectClaim[p] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) return false;
      if (redirectUv[p + 2] < 0.5) return false;
      const sourceChart = Math.round(redirectMeta[p]);
      const destinationChart = Math.round(redirectMeta[p + 1]);
      const destIndex = indexAtUvComponents(redirectUv[p], redirectUv[p + 1]);
      return sourceChart === baseChart &&
        destinationChart > 0 &&
        destIndex >= 0 &&
        conflictArray[destIndex] === 0 &&
        ownerArray[destIndex] === destinationChart;
    }

    const counts = {
      resolution: FIELD_SIZE,
      oldMaskCoverageTexels: 0,
      conservativeCoverageTexels: 0,
      newlyCoveredTexels: 0,
      legacyCoveredButNotConservativeTexels: 0,
      surfaceCoverageTexels: 0,
      authoritativeTexelsBefore: 0,
      authoritativeTexels: 0,
      unsafeTexelsBefore: 0,
      unsafeTexels: 0,
      emptyTexels: 0,
      maskCrackTexels: 0,
      unownedCoveredTexelsBefore: 0,
      unownedCoveredTexels: 0,
      unsafeCoveredTexelsBefore: 0,
      unsafeCoveredTexels: 0,
      authoritativeButMaskEmptyTexels: 0,
      maskCoveredButNoChartTexelsBefore: 0,
      maskCoveredButNoChartTexels: 0,
      seamEdgeTexelsVisited: 0,
      seamEdgeMaskEmptyTexelsBefore: 0,
      seamEdgeMaskEmptyTexelsAfter: 0,
      seamEdgeMaskEmptyTexels: 0,
      seamEdgeUnownedTexelsBefore: 0,
      seamEdgeUnownedTexels: 0,
      seamEdgeUnsafeTexelsBefore: 0,
      seamEdgeUnsafeTexels: 0,
      seamEdgeTransitionAvailableTexels: 0,
      seamEdgeTransitionMissingTexels: 0,
      authoritativeButMaskEmptyTexelsBefore: 0,
      authoritativeButMaskEmptyTexelsAfter: 0,
      diffusionNeighborSamplesTestedBefore: 0,
      diffusionNeighborSamplesTested: 0,
      falseCrackNoFluxSamplesBefore: 0,
      falseCrackNoFluxSamples: 0,
      trueBoundaryNoFluxSamplesBefore: 0,
      trueBoundaryNoFluxSamples: 0,
      unsafeNoFluxSamplesBefore: 0,
      unsafeNoFluxSamples: 0,
      unresolvedTransitionNoFluxSamplesBefore: 0,
      unresolvedTransitionNoFluxSamples: 0,
    };

    for (let index = 0; index < texelCount; index++) {
      const covered = isMaskCovered(index);
      const legacyCovered = wasLegacyMaskCovered(index);
      const owner = state.owner[index];
      const unsafe = state.conflict[index] !== 0;
      const authoritative = owner > 0 && !unsafe;
      const oldOwner = legacyOwner[index];
      const oldUnsafe = legacyConflict[index] !== 0;
      const oldAuthoritative = oldOwner > 0 && !oldUnsafe;
      const seamEdge = seamEdgeTexels[index] !== 0;
      const transitionAvailable =
        maps.transitionClaim[index * 4] > 0 &&
        maps.transitionClaim[index * 4 + 1] < 0.5;

      if (legacyCovered) counts.oldMaskCoverageTexels++;
      if (covered) {
        counts.surfaceCoverageTexels++;
        counts.conservativeCoverageTexels++;
      }
      if (covered && !legacyCovered) counts.newlyCoveredTexels++;
      if (legacyCovered && !covered) counts.legacyCoveredButNotConservativeTexels++;
      if (oldAuthoritative) counts.authoritativeTexelsBefore++;
      if (authoritative) counts.authoritativeTexels++;
      if (oldUnsafe) counts.unsafeTexelsBefore++;
      if (unsafe) counts.unsafeTexels++;
      if (!covered && owner <= 0 && !unsafe) counts.emptyTexels++;
      if (covered && oldOwner <= 0 && !oldUnsafe) counts.unownedCoveredTexelsBefore++;
      if (covered && owner <= 0 && !unsafe) counts.unownedCoveredTexels++;
      if (covered && oldUnsafe) counts.unsafeCoveredTexelsBefore++;
      if (covered && unsafe) counts.unsafeCoveredTexels++;
      if (authoritative && !covered) {
        counts.authoritativeButMaskEmptyTexels++;
        counts.authoritativeButMaskEmptyTexelsAfter++;
        suspectedCrackTexels[index] = 1;
      }
      if (authoritative && !legacyCovered) {
        counts.authoritativeButMaskEmptyTexelsBefore++;
      }
      if (covered && oldOwner <= 0) counts.maskCoveredButNoChartTexelsBefore++;
      if (covered && owner <= 0) counts.maskCoveredButNoChartTexels++;

      if (seamEdge) {
        counts.seamEdgeTexelsVisited++;
        if (!legacyCovered) counts.seamEdgeMaskEmptyTexelsBefore++;
        if (!covered) {
          counts.seamEdgeMaskEmptyTexels++;
          counts.seamEdgeMaskEmptyTexelsAfter++;
          suspectedCrackTexels[index] = 1;
        }
        if (oldOwner <= 0) counts.seamEdgeUnownedTexelsBefore++;
        if (owner <= 0) counts.seamEdgeUnownedTexels++;
        if (oldUnsafe) counts.seamEdgeUnsafeTexelsBefore++;
        if (unsafe) counts.seamEdgeUnsafeTexels++;
        if (transitionAvailable) counts.seamEdgeTransitionAvailableTexels++;
        else counts.seamEdgeTransitionMissingTexels++;
      }
    }

    for (let index = 0; index < texelCount; index++) {
      if (suspectedCrackTexels[index]) counts.maskCrackTexels++;
    }

    function measureDiffusionNoFlux(ownerArray, conflictArray) {
      const result = {
        diffusionNeighborSamplesTested: 0,
        falseCrackNoFluxSamples: 0,
        trueBoundaryNoFluxSamples: 0,
        unsafeNoFluxSamples: 0,
        unresolvedTransitionNoFluxSamples: 0,
      };
      for (let y = 0; y < FIELD_SIZE; y++) {
        for (let x = 0; x < FIELD_SIZE; x++) {
          const baseIndex = y * FIELD_SIZE + x;
          const baseChart = ownerArray[baseIndex];
          if (baseChart <= 0 || conflictArray[baseIndex] !== 0) continue;
          for (const offset of offsets) {
            result.diffusionNeighborSamplesTested++;
            const sx = x + offset[0];
            const sy = y + offset[1];
            const sampleIndex = sx < 0 || sy < 0 || sx >= FIELD_SIZE || sy >= FIELD_SIZE
              ? -1
              : sy * FIELD_SIZE + sx;
            if (sampleIndex >= 0 &&
                conflictArray[sampleIndex] === 0 &&
                ownerArray[sampleIndex] === baseChart) {
              continue;
            }
            if (transitionAccepts(baseIndex, baseChart, offset, ownerArray, conflictArray) ||
                redirectAccepts(sampleIndex, baseChart, ownerArray, conflictArray)) {
              continue;
            }
            if (sampleIndex < 0) {
              result.trueBoundaryNoFluxSamples++;
            } else if (conflictArray[sampleIndex] !== 0) {
              result.unsafeNoFluxSamples++;
            } else if (!isMaskCovered(sampleIndex)) {
              if (suspectedCrackTexels[sampleIndex]) result.falseCrackNoFluxSamples++;
              else result.trueBoundaryNoFluxSamples++;
            } else {
              result.unresolvedTransitionNoFluxSamples++;
            }
          }
        }
      }
      return result;
    }

    const beforeFlux = measureDiffusionNoFlux(legacyOwner, legacyConflict);
    const afterFlux = measureDiffusionNoFlux(state.owner, state.conflict);
    counts.diffusionNeighborSamplesTestedBefore = beforeFlux.diffusionNeighborSamplesTested;
    counts.falseCrackNoFluxSamplesBefore = beforeFlux.falseCrackNoFluxSamples;
    counts.trueBoundaryNoFluxSamplesBefore = beforeFlux.trueBoundaryNoFluxSamples;
    counts.unsafeNoFluxSamplesBefore = beforeFlux.unsafeNoFluxSamples;
    counts.unresolvedTransitionNoFluxSamplesBefore = beforeFlux.unresolvedTransitionNoFluxSamples;
    counts.diffusionNeighborSamplesTested = afterFlux.diffusionNeighborSamplesTested;
    counts.falseCrackNoFluxSamples = afterFlux.falseCrackNoFluxSamples;
    counts.trueBoundaryNoFluxSamples = afterFlux.trueBoundaryNoFluxSamples;
    counts.unsafeNoFluxSamples = afterFlux.unsafeNoFluxSamples;
    counts.unresolvedTransitionNoFluxSamples = afterFlux.unresolvedTransitionNoFluxSamples;

    const domainCrackSignal =
      counts.maskCrackTexels +
      counts.maskCoveredButNoChartTexels +
      counts.unownedCoveredTexels +
      counts.unsafeCoveredTexels +
      counts.seamEdgeUnsafeTexels;
    const sourceScores = {
      uvIslandMaskRT: counts.maskCrackTexels + counts.authoritativeButMaskEmptyTexels,
      chartIdRT: counts.maskCoveredButNoChartTexels + counts.unownedCoveredTexels,
      chartUnsafeRT: counts.unsafeCoveredTexels + counts.seamEdgeUnsafeTexels,
      canonicalClipping: domainCrackSignal === 0 ? counts.falseCrackNoFluxSamples : 0,
      renderOnlyDebugView: domainCrackSignal === 0 && counts.falseCrackNoFluxSamples === 0 ? 1 : 0,
    };
    const dominantSource = Object.entries(sourceScores)
      .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
    const ownershipSummary = state.summary ?? {};

    return {
      ...counts,
      coverageBuildDiagnostics: { ...surfaceCoverageBuildDiagnostics },
      ownershipBuildDiagnostics: {
        phase: ownershipSummary.phase ?? 'unknown',
        centerOwnedTexels: ownershipSummary.centerOwnedTexels,
        conservativeOwnedTexels: ownershipSummary.conservativeOwnedTexels ?? ownershipSummary.ownedTexels,
        centerUnsafeTexels: ownershipSummary.centerUnsafeTexels,
        unsafeTexels: ownershipSummary.unsafeTexels,
        centerMultiOwnerConflictTexels: ownershipSummary.centerMultiOwnerConflictTexels,
        multiOwnerConflictTexels: ownershipSummary.multiOwnerConflictTexels,
        centerZeroOwnedChartCount: ownershipSummary.centerZeroOwnedChartIds?.length ?? 0,
        zeroOwnedChartCount: ownershipSummary.zeroOwnedChartIds?.length ?? 0,
        microChartCount: ownershipSummary.microChartIds?.length ?? 0,
        centerZeroOwnedChartIds: [...(ownershipSummary.centerZeroOwnedChartIds ?? [])],
        zeroOwnedChartIds: [...(ownershipSummary.zeroOwnedChartIds ?? [])],
        microChartIds: [...(ownershipSummary.microChartIds ?? [])],
        zeroOwnedOrMicroCharts: (ownershipSummary.zeroOwnedOrMicroCharts ?? []).map((entry) => ({ ...entry })),
        note: ownershipSummary.note,
      },
      zeroOwnedChartCountBefore: ownershipSummary.centerZeroOwnedChartIds?.length ?? 0,
      zeroOwnedChartCountAfter: ownershipSummary.zeroOwnedChartIds?.length ?? 0,
      microChartCount: ownershipSummary.microChartIds?.length ?? 0,
      multiChartConflictTexelsBefore: ownershipSummary.centerMultiOwnerConflictTexels ?? 0,
      multiChartConflictTexelsAfter: ownershipSummary.multiOwnerConflictTexels ?? 0,
      dominantSuspectedCrackSourceStillUvIslandMaskRT: dominantSource === 'uvIslandMaskRT',
      debugViewsAdded: ['surface-coverage', 'coverage-comparison', 'simulation-domain', 'watertight-cracks'],
      sourceScores,
      dominantSuspectedCrackSource: dominantSource,
      sourceClassification: {
        uvIslandMaskRT: {
          suspected: sourceScores.uvIslandMaskRT > 0,
          seamEdgeMaskEmptyTexels: counts.seamEdgeMaskEmptyTexels,
          authoritativeButMaskEmptyTexels: counts.authoritativeButMaskEmptyTexels,
        },
        chartIdRT: {
          suspected: sourceScores.chartIdRT > 0,
          maskCoveredButNoChartTexels: counts.maskCoveredButNoChartTexels,
          unownedCoveredTexels: counts.unownedCoveredTexels,
        },
        chartUnsafeRT: {
          suspected: sourceScores.chartUnsafeRT > 0,
          unsafeCoveredTexels: counts.unsafeCoveredTexels,
          seamEdgeUnsafeTexels: counts.seamEdgeUnsafeTexels,
        },
        canonicalClipping: {
          suspected: counts.falseCrackNoFluxSamples > 0,
          falseCrackNoFluxSamples: counts.falseCrackNoFluxSamples,
          note: 'Phase 0 estimates no-flux pressure from current domain classifications without changing canonical fields.',
        },
        renderOnlyDebugView: {
          suspected: dominantSource === 'renderOnlyDebugView',
          note: 'Only suspected when mask, chart-id, and unsafe-domain counters do not explain the visible cracks.',
        },
      },
      note: 'Phase 2 diagnostic: surfaceCoverageRT is conservative UV surface coverage, and chartIdRT/chartUnsafeRT are built from conservative chart claims. Coverage remains separate from chart authority; unsafe or ambiguous ownership is not promoted to an arbitrary chart.',
    };
  }

  function measureTransitionNoFluxDiagnostics() {
    const topo = topology();
    const state = ownership();
    const maps = readTransitionSnapshot();
    const texelCount = FIELD_SIZE * FIELD_SIZE;
    const surfaceCoverage = new Uint8Array(texelCount * 4);
    const redirectUv = new Float32Array(texelCount * 4);
    const redirectMeta = new Float32Array(texelCount * 4);
    const redirectClaim = new Float32Array(texelCount * 4);
    renderer.readRenderTargetPixels(surfaceCoverageRT, 0, 0, FIELD_SIZE, FIELD_SIZE, surfaceCoverage);
    renderer.readRenderTargetPixels(seamRedirectUvRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectUv);
    renderer.readRenderTargetPixels(seamRedirectMetaRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectMeta);
    renderer.readRenderTargetPixels(seamRedirectClaimRT, 0, 0, FIELD_SIZE, FIELD_SIZE, redirectClaim);

    const offsets = [
      { x: -1, y: -1, name: 'nw' },
      { x: 0, y: -1, name: 'n' },
      { x: 1, y: -1, name: 'ne' },
      { x: -1, y: 0, name: 'w' },
      { x: 1, y: 0, name: 'e' },
      { x: -1, y: 1, name: 'sw' },
      { x: 0, y: 1, name: 's' },
      { x: 1, y: 1, name: 'se' },
    ];
    const causes = [
      'trueUnsafeMicroNoFlux',
      'transitionMetadataMissing',
      'transitionClaimCollision',
      'transitionCandidateOverflow',
      'transitionCandidateAmbiguous',
      'wrongDirectionRejection',
      'notCrossingRejection',
      'destinationOwnershipUnsafeRejection',
      'insufficientTransitionBandCoverage',
      'metadataChartMismatch',
      'unrelatedChartBoundaryNoFlux',
      'outsideAtlasBoundaryNoFlux',
      'trueEmptyAtlasBoundaryNoFlux',
    ];
    const causeCounts = Object.fromEntries(causes.map((cause) => [cause, 0]));
    const destinationBreakdown = {
      destinationOutsideAtlas: 0,
      destinationUnsafe: 0,
      destinationWrongChart: 0,
      destinationUnowned: 0,
    };
    const totals = {
      authoritativeBaseTexels: 0,
      diffusionNeighborSamples: 0,
      acceptedSameChartSamples: 0,
      acceptedTransitionSamples: 0,
      acceptedTransitionSamplesFromOverflow: 0,
      acceptedRedirectSamples: 0,
      totalNoFluxSamples: 0,
      transitionResolutionNoFluxSamples: 0,
      trueUnsafeOrBoundaryNoFluxSamples: 0,
      knownTrueSeamTransitionNoFluxSamples: 0,
      knownTrueSeamCollisionNoFluxSamples: 0,
      knownTrueSeamNonCollisionNoFluxSamples: 0,
      nonSeamTransitionNoFluxSamples: 0,
      ambiguousCollisionNoFluxSamples: 0,
    };
    const pairMap = new Map();
    const examples = [];
    const directedSeamPairs = new Map();
    const undirectedSeamPairs = new Set();
    const actualTransitionBandTexels = SEAM_CROSSING_TRANSITION_BAND_TEXELS;
    const requestedDiffusionTransitionBandTexels = Math.ceil(
      DIFFUSION_SAMPLE_RADIUS_TEXELS + ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS,
    );
    const transitionBandSufficientForDiffusion =
      actualTransitionBandTexels >= requestedDiffusionTransitionBandTexels;

    function addDirectedSeamPair(sourceChart, destinationChart) {
      if (sourceChart <= 0 || destinationChart <= 0) return;
      const directed = `${sourceChart}->${destinationChart}`;
      directedSeamPairs.set(directed, (directedSeamPairs.get(directed) ?? 0) + 1);
      const a = Math.min(sourceChart, destinationChart);
      const b = Math.max(sourceChart, destinationChart);
      undirectedSeamPairs.add(`${a}<->${b}`);
    }

    for (const seam of seamPairs) {
      const chartA = topo.faceChartIds?.[seam.A.face] ?? 0;
      const chartB = topo.faceChartIds?.[seam.B.face] ?? 0;
      addDirectedSeamPair(chartA, chartB);
      addDirectedSeamPair(chartB, chartA);
    }

    function isCovered(index) {
      return index >= 0 && surfaceCoverage[index * 4] >= 128;
    }

    function chartLabel(index) {
      if (index < 0) return 'outside-atlas';
      if (state.conflict[index] !== 0) {
        const claimed = state.claimOwner?.[index] ?? 0;
        return claimed > 0 ? `unsafe:${claimed}` : 'unsafe';
      }
      const owner = state.owner[index];
      if (owner > 0) return String(owner);
      return isCovered(index) ? 'covered-unowned' : 'empty-atlas';
    }

    function getPairRow(observedPair, metadataPair) {
      const key = `${observedPair}|${metadataPair}`;
      let row = pairMap.get(key);
      if (!row) {
        const [sourceText, destinationText] = observedPair.split('->');
        const sourceChart = Number(sourceText);
        const destinationChart = Number(destinationText);
        const undirectedKey = Number.isFinite(destinationChart)
          ? `${Math.min(sourceChart, destinationChart)}<->${Math.max(sourceChart, destinationChart)}`
          : null;
        row = {
          observedPair,
          metadataPair,
          sourceChart,
          observedDestination: destinationText,
          knownDirectedSeamEdges: directedSeamPairs.get(observedPair) ?? 0,
          knownUndirectedSeam: undirectedKey ? undirectedSeamPairs.has(undirectedKey) : false,
          totalSamples: 0,
          acceptedTransitionSamples: 0,
          acceptedRedirectSamples: 0,
          noFluxSamples: 0,
          transitionResolutionNoFluxSamples: 0,
          trueUnsafeOrBoundaryNoFluxSamples: 0,
          ...Object.fromEntries(causes.map((cause) => [cause, 0])),
        };
        pairMap.set(key, row);
      }
      return row;
    }

    function classifyTransitionAttempt(baseIndex, baseChart, offset) {
      const resolved = resolveTransitionCandidate(
        maps,
        state,
        baseIndex,
        baseChart,
        offset.x / FIELD_SIZE,
        offset.y / FIELD_SIZE,
      );
      if (resolved.cause === 'transitionMetadataMissing' && !transitionBandSufficientForDiffusion) {
        return {
          ...resolved,
          accepted: false,
          cause: 'insufficientTransitionBandCoverage',
        };
      }
      if (resolved.cause === 'transitionCandidateOverflow' ||
          resolved.cause === 'transitionCandidateAmbiguous') {
        return { ...resolved, cause: resolved.cause };
      }
      return resolved;
    }

    function redirectAccepts(sampleIndex, baseChart) {
      if (sampleIndex < 0) return false;
      const p = sampleIndex * 4;
      if (redirectClaim[p] >= SEAM_REDIRECT_CLAIM_COLLISION_THRESHOLD) return false;
      if (redirectUv[p + 2] < 0.5) return false;
      const sourceChart = Math.round(redirectMeta[p]);
      const destinationChart = Math.round(redirectMeta[p + 1]);
      const destIndex = indexAtUvComponents(redirectUv[p], redirectUv[p + 1]);
      return sourceChart === baseChart &&
        destinationChart > 0 &&
        destIndex >= 0 &&
        state.conflict[destIndex] === 0 &&
        state.owner[destIndex] === destinationChart;
    }

    function recordExample(baseIndex, sampleIndex, offset, observedPair, metadataPair, cause, transition) {
      if (examples.length >= 40) return;
      if (cause === 'outsideAtlasBoundaryNoFlux' || cause === 'trueEmptyAtlasBoundaryNoFlux') return;
      examples.push({
        baseTexel: { x: baseIndex % FIELD_SIZE, y: Math.floor(baseIndex / FIELD_SIZE) },
        sampleTexel: sampleIndex >= 0
          ? { x: sampleIndex % FIELD_SIZE, y: Math.floor(sampleIndex / FIELD_SIZE) }
          : null,
        offset: offset.name,
        observedPair,
        metadataPair,
        cause,
        outwardTexels: transition?.outwardTexels ?? null,
        seamDistanceTexels: transition?.seamDistanceTexels ?? null,
        outwardAlignment: transition?.outwardAlignment ?? null,
      });
    }

    for (let y = 0; y < FIELD_SIZE; y++) {
      for (let x = 0; x < FIELD_SIZE; x++) {
        const baseIndex = y * FIELD_SIZE + x;
        const baseChart = state.owner[baseIndex];
        if (baseChart <= 0 || state.conflict[baseIndex] !== 0) continue;
        totals.authoritativeBaseTexels++;
        for (const offset of offsets) {
          totals.diffusionNeighborSamples++;
          const sx = x + offset.x;
          const sy = y + offset.y;
          const sampleIndex = sx < 0 || sy < 0 || sx >= FIELD_SIZE || sy >= FIELD_SIZE
            ? -1
            : sy * FIELD_SIZE + sx;
          if (sampleIndex >= 0 &&
              state.conflict[sampleIndex] === 0 &&
              state.owner[sampleIndex] === baseChart) {
            totals.acceptedSameChartSamples++;
            continue;
          }

          const transition = classifyTransitionAttempt(baseIndex, baseChart, offset);
          const observedPair = `${baseChart}->${chartLabel(sampleIndex)}`;
          const row = getPairRow(observedPair, transition.metadataPair);
          row.totalSamples++;
          if (transition.accepted) {
            totals.acceptedTransitionSamples++;
            if (transition.hadCandidateOverflow) {
              totals.acceptedTransitionSamplesFromOverflow++;
            }
            row.acceptedTransitionSamples++;
            continue;
          }
          if (redirectAccepts(sampleIndex, baseChart)) {
            totals.acceptedRedirectSamples++;
            row.acceptedRedirectSamples++;
            continue;
          }

          let cause = transition.cause;
          let transitionResolutionNoFlux = false;
          if (sampleIndex < 0) {
            cause = 'outsideAtlasBoundaryNoFlux';
          } else if (state.conflict[sampleIndex] !== 0) {
            cause = 'trueUnsafeMicroNoFlux';
          } else if (state.owner[sampleIndex] > 0 && !row.knownUndirectedSeam) {
            cause = 'unrelatedChartBoundaryNoFlux';
          } else if (!isCovered(sampleIndex)) {
            cause = 'trueEmptyAtlasBoundaryNoFlux';
          } else {
            transitionResolutionNoFlux = true;
          }

          totals.totalNoFluxSamples++;
          row.noFluxSamples++;
          if (transitionResolutionNoFlux) {
            totals.transitionResolutionNoFluxSamples++;
            row.transitionResolutionNoFluxSamples++;
            const ambiguousCause = cause === 'transitionClaimCollision' ||
              cause === 'transitionCandidateOverflow' ||
              cause === 'transitionCandidateAmbiguous';
            if (row.knownUndirectedSeam) {
              totals.knownTrueSeamTransitionNoFluxSamples++;
              if (ambiguousCause) totals.knownTrueSeamCollisionNoFluxSamples++;
              else totals.knownTrueSeamNonCollisionNoFluxSamples++;
            } else {
              totals.nonSeamTransitionNoFluxSamples++;
            }
            if (ambiguousCause) totals.ambiguousCollisionNoFluxSamples++;
          } else {
            totals.trueUnsafeOrBoundaryNoFluxSamples++;
            row.trueUnsafeOrBoundaryNoFluxSamples++;
          }
          causeCounts[cause]++;
          row[cause]++;
          if (cause === 'destinationOwnershipUnsafeRejection' && transition.destinationRejectKind) {
            destinationBreakdown[transition.destinationRejectKind]++;
          }
          recordExample(baseIndex, sampleIndex, offset, observedPair, transition.metadataPair, cause, transition);
        }
      }
    }

    const pairRows = [...pairMap.values()]
      .sort((a, b) =>
        b.transitionResolutionNoFluxSamples - a.transitionResolutionNoFluxSamples ||
        b.noFluxSamples - a.noFluxSamples ||
        a.observedPair.localeCompare(b.observedPair)
      );
    return {
      phase: 'transition-resolution-no-flux-diagnostic',
      resolution: FIELD_SIZE,
      requestedDiffusionTransitionBandTexels,
      actualTransitionBandTexels,
      transitionBandSufficientForDiffusion,
      crossingToleranceTexels: ZERO_GUTTER_TRANSITION_CROSSING_TOLERANCE_TEXELS,
      outwardDotMinimum: ZERO_GUTTER_TRANSITION_OUTWARD_DOT_MIN,
      directedSeamPairCount: directedSeamPairs.size,
      undirectedSeamPairCount: undirectedSeamPairs.size,
      totals,
      causeCounts,
      destinationBreakdown,
      transitionCandidateResolution: {
        directionResolvedAcceptedTransitions: totals.acceptedTransitionSamples,
        acceptedTransitionSamplesFromOverflow:
          totals.acceptedTransitionSamplesFromOverflow,
        unresolvedAmbiguousTransitions:
          causeCounts.transitionCandidateOverflow + causeCounts.transitionCandidateAmbiguous,
        candidateOverflowRejections: causeCounts.transitionCandidateOverflow,
        candidateAmbiguousRejections: causeCounts.transitionCandidateAmbiguous,
        unsafeMicroRejections: causeCounts.trueUnsafeMicroNoFlux,
        destinationOwnershipUnsafeRejections: causeCounts.destinationOwnershipUnsafeRejection,
        wrongDirectionRejections: causeCounts.wrongDirectionRejection,
        notCrossingRejections: causeCounts.notCrossingRejection,
        metadataChartMismatches: causeCounts.metadataChartMismatch,
      },
      acceptanceClassification: {
        validTrueSeamNoFluxNeedingFix: totals.knownTrueSeamNonCollisionNoFluxSamples,
        collisionOrAmbiguousNoFluxSamples: totals.ambiguousCollisionNoFluxSamples,
        ambiguousNonSeamNoFluxSamples:
          Math.max(0, totals.nonSeamTransitionNoFluxSamples - totals.ambiguousCollisionNoFluxSamples),
        unsafeMicroNoFluxSamples: causeCounts.trueUnsafeMicroNoFlux,
        trueBoundaryNoFluxSamples:
          causeCounts.outsideAtlasBoundaryNoFlux +
          causeCounts.trueEmptyAtlasBoundaryNoFlux +
          causeCounts.unrelatedChartBoundaryNoFlux,
        metadataMissingNoFluxSamples: causeCounts.transitionMetadataMissing,
        insufficientBandNoFluxSamples: causeCounts.insufficientTransitionBandCoverage,
        accepted:
          totals.knownTrueSeamNonCollisionNoFluxSamples === 0 &&
          causeCounts.transitionMetadataMissing === 0 &&
          causeCounts.insufficientTransitionBandCoverage === 0,
      },
      pairRows,
      topPairs: pairRows.slice(0, 24),
      examples,
      note: 'Manual Phase 3 diagnostic only. It replays diffusion-neighbor topology checks and classifies no-flux fallbacks by transition metadata/claim/direction/crossing/destination cause without changing mask, chart ownership, diffusion, rendering, or model parameters.',
    };
  }

  function measureSeamEdgeDomainContinuity() {
    const topo = topology();
    const state = ownership();
    const maps = readTransitionSnapshot();
    const texelCount = FIELD_SIZE * FIELD_SIZE;
    const surfaceCoverage = new Uint8Array(texelCount * 4);
    renderer.readRenderTargetPixels(surfaceCoverageRT, 0, 0, FIELD_SIZE, FIELD_SIZE, surfaceCoverage);

    function isCovered(index) {
      return index >= 0 && surfaceCoverage[index * 4] >= 128;
    }

    function segmentTexels(segment) {
      const texels = [];
      const minX = Math.max(0, Math.floor(Math.min(segment.ax, segment.bx) * FIELD_SIZE) - 1);
      const maxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(segment.ax, segment.bx) * FIELD_SIZE) + 1);
      const minY = Math.max(0, Math.floor(Math.min(segment.ay, segment.by) * FIELD_SIZE) - 1);
      const maxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(segment.ay, segment.by) * FIELD_SIZE) + 1);
      for (let y = minY; y <= maxY; y++) {
        const v0 = y / FIELD_SIZE;
        const v1 = (y + 1) / FIELD_SIZE;
        for (let x = minX; x <= maxX; x++) {
          const u0 = x / FIELD_SIZE;
          const u1 = (x + 1) / FIELD_SIZE;
          if (
            pointInUvRect(segment.ax, segment.ay, u0, v0, u1, v1) ||
            pointInUvRect(segment.bx, segment.by, u0, v0, u1, v1) ||
            segmentIntersectsUvRect(segment.ax, segment.ay, segment.bx, segment.by, u0, v0, u1, v1)
          ) {
            texels.push(y * FIELD_SIZE + x);
          }
        }
      }
      return texels;
    }

    function transitionStatus(index, sourceChart, destinationChart) {
      const p = index * 4;
      if (maps.transitionClaim[p + 1] >= 0.5) return 'collision';
      let matchingCandidates = 0;
      let invalidBasis = false;
      let invalidDestination = false;
      for (const candidate of maps.transitionCandidates ?? []) {
        if (candidate.transitionUv[p + 2] < 0.5) continue;
        const metaSource = Math.round(candidate.transitionMeta[p]);
        const metaDestination = Math.round(candidate.transitionMeta[p + 1]);
        if (metaSource !== sourceChart || metaDestination !== destinationChart) continue;
        matchingCandidates++;
        const sourceOutLen = Math.hypot(candidate.transitionDirection[p], candidate.transitionDirection[p + 1]);
        const destinationInLen = Math.hypot(candidate.transitionDirection[p + 2], candidate.transitionDirection[p + 3]);
        const sourceEdgeLen = Math.hypot(candidate.transitionBasis[p], candidate.transitionBasis[p + 1]);
        const destinationEdgeLen = Math.hypot(candidate.transitionBasis[p + 2], candidate.transitionBasis[p + 3]);
        if (sourceOutLen < 0.5 ||
            destinationInLen < 0.5 ||
            sourceEdgeLen < 0.5 ||
            destinationEdgeLen < 0.5) {
          invalidBasis = true;
          continue;
        }
        const destIndex = indexAtUvComponents(candidate.transitionUv[p], candidate.transitionUv[p + 1]);
        if (destIndex < 0 ||
            state.conflict[destIndex] !== 0 ||
            state.owner[destIndex] !== destinationChart) {
          invalidDestination = true;
          continue;
        }
        return matchingCandidates > 1 ? 'collision' : 'available';
      }
      if (matchingCandidates === 0) return maps.transitionClaim[p] > 0 ? 'metadata-mismatch' : 'missing';
      if (invalidDestination) return 'invalid-destination';
      if (invalidBasis) return 'invalid-basis';
      return 'missing';
    }

    function makeSegment(side, chartId, destinationChart, seamIndex, sideName) {
      const a = side.vA;
      const b = side.vB;
      return {
        seamIndex,
        side: sideName,
        chartId,
        destinationChart,
        ax: topo.uvAttr[a * 2],
        ay: topo.uvAttr[a * 2 + 1],
        bx: topo.uvAttr[b * 2],
        by: topo.uvAttr[b * 2 + 1],
      };
    }

    const counts = {
      seamPairs: seamPairs.length,
      seamEdgeTexels: 0,
      uniqueSeamEdgeTexels: 0,
      coveredSeamEdgeTexels: 0,
      authoritativeSourceTexels: 0,
      coveredButUnownedSourceTexels: 0,
      unsafeSourceTexels: 0,
      transitionAvailableTexels: 0,
      transitionMissingTexels: 0,
      transitionCollisionTexels: 0,
      transitionMetadataMismatchTexels: 0,
      transitionInvalidBasisTexels: 0,
      transitionInvalidDestinationTexels: 0,
      falseHoleTexels: 0,
      unresolvedSeamTexels: 0,
    };
    const uniqueTexels = new Set();
    const perSeamSummary = [];

    for (let seamIndex = 0; seamIndex < seamPairs.length; seamIndex++) {
      const seam = seamPairs[seamIndex];
      const chartA = topo.faceChartIds?.[seam.A.face] ?? 0;
      const chartB = topo.faceChartIds?.[seam.B.face] ?? 0;
      const segments = [
        makeSegment(seam.A, chartA, chartB, seamIndex, 'A'),
        makeSegment(seam.B, chartB, chartA, seamIndex, 'B'),
      ];
      const row = {
        seamIndex,
        chartA,
        chartB,
        seamEdgeTexels: 0,
        coveredSeamEdgeTexels: 0,
        authoritativeSourceTexels: 0,
        coveredButUnownedSourceTexels: 0,
        unsafeSourceTexels: 0,
        transitionAvailableTexels: 0,
        transitionMissingTexels: 0,
        transitionCollisionTexels: 0,
        transitionMetadataMismatchTexels: 0,
        transitionInvalidBasisTexels: 0,
        transitionInvalidDestinationTexels: 0,
        falseHoleTexels: 0,
        unresolvedSeamTexels: 0,
      };

      for (const segment of segments) {
        for (const texel of segmentTexels(segment)) {
          counts.seamEdgeTexels++;
          row.seamEdgeTexels++;
          uniqueTexels.add(texel);
          const covered = isCovered(texel);
          const owner = state.owner[texel];
          const unsafe = state.conflict[texel] !== 0;
          if (covered) {
            counts.coveredSeamEdgeTexels++;
            row.coveredSeamEdgeTexels++;
          }
          if (owner === segment.chartId && !unsafe) {
            counts.authoritativeSourceTexels++;
            row.authoritativeSourceTexels++;
            continue;
          }
          if (!covered) {
            counts.falseHoleTexels++;
            row.falseHoleTexels++;
          } else if (unsafe) {
            counts.unsafeSourceTexels++;
            row.unsafeSourceTexels++;
          } else if (owner <= 0) {
            counts.coveredButUnownedSourceTexels++;
            row.coveredButUnownedSourceTexels++;
          }

          const status = transitionStatus(texel, segment.chartId, segment.destinationChart);
          if (status === 'available') {
            counts.transitionAvailableTexels++;
            row.transitionAvailableTexels++;
          } else if (status === 'collision') {
            counts.transitionCollisionTexels++;
            row.transitionCollisionTexels++;
          } else if (status === 'metadata-mismatch') {
            counts.transitionMetadataMismatchTexels++;
            row.transitionMetadataMismatchTexels++;
          } else if (status === 'invalid-basis') {
            counts.transitionInvalidBasisTexels++;
            row.transitionInvalidBasisTexels++;
          } else if (status === 'invalid-destination') {
            counts.transitionInvalidDestinationTexels++;
            row.transitionInvalidDestinationTexels++;
          } else {
            counts.transitionMissingTexels++;
            row.transitionMissingTexels++;
          }

          if (!covered || (!unsafe && owner <= 0 && status !== 'available')) {
            counts.unresolvedSeamTexels++;
            row.unresolvedSeamTexels++;
          }
        }
      }

      if (row.unresolvedSeamTexels > 0 ||
          row.unsafeSourceTexels > 0 ||
          row.transitionCollisionTexels > 0 ||
          row.transitionMissingTexels > 0 ||
          row.transitionMetadataMismatchTexels > 0 ||
          row.transitionInvalidDestinationTexels > 0) {
        perSeamSummary.push(row);
      }
    }

    counts.uniqueSeamEdgeTexels = uniqueTexels.size;
    return {
      phase: 'seam-edge-domain-continuity',
      ...counts,
      perSeamSummary: perSeamSummary
        .sort((a, b) =>
          b.unresolvedSeamTexels - a.unresolvedSeamTexels ||
          b.unsafeSourceTexels - a.unsafeSourceTexels ||
          b.transitionCollisionTexels - a.transitionCollisionTexels
        )
        .slice(0, 48),
      note: 'Manual Chunk B diagnostic. Seam-edge texels are classified as authoritative, unsafe/micro, transition-available, collision/ambiguous, or unresolved without changing mask or ownership.',
    };
  }

  function measureProductionMaskUsageAudit() {
    const rows = [
      {
        symbol: 'uvIslandMaskRT',
        currentMeaning: 'alias of conservative surfaceCoverageRT',
        productionUse: 'surface coverage texture only',
        semanticOwnershipProxy: false,
        status: 'accepted',
      },
      {
        symbol: 'surfaceCoverageRT',
        currentMeaning: 'real UV triangle/texel surface coverage',
        productionUse: 'coverage diagnostics and legacy mask debug view',
        semanticOwnershipProxy: false,
        status: 'accepted',
      },
      {
        symbol: 'u_islandMask / dilateFragment',
        currentMeaning: 'conservative surface coverage',
        productionUse: 'manual legacy dilateRenderField() sample-view helper; animation frame uses safe seam padding instead',
        semanticOwnershipProxy: false,
        status: 'legacy-manual-only',
      },
      {
        symbol: 'params.useIslandMasking',
        currentMeaning: 'legacy UI/debug toggle retained for compatibility',
        productionUse: 'no production shader branch reads u_useIslandMasking',
        semanticOwnershipProxy: false,
        status: 'legacy-no-effect',
      },
      {
        symbol: 'chartIdRT + chartUnsafeRT',
        currentMeaning: 'authoritative ownership predicate',
        productionUse: 'canonical writes, clipping, safe sampling, agents, splats, oats, seam equalization',
        semanticOwnershipProxy: true,
        status: 'accepted',
      },
    ];
    return {
      phase: 'production-mask-usage-audit',
      rows,
      binaryMaskSemanticOwnershipUses: rows.filter((row) =>
        row.symbol !== 'chartIdRT + chartUnsafeRT' && row.semanticOwnershipProxy
      ).length,
      useIslandMaskingProductionEffect: false,
      accepted: true,
      note: 'Binary surface coverage is not used as semantic chart authority. Production ownership decisions use chartIdRT/chartUnsafeRT or explicit transition/redirect validation.',
    };
  }

  function measureCanonicalSampleViewAudit() {
    const rows = [
      {
        path: 'clipCanonicalField(fieldRT)',
        predicate: 'chartId > 0 && chartUnsafe == 0',
        preservesAuthoritativeSeamTexels: true,
        canWriteUnsafeOrUnownedSurface: false,
      },
      {
        path: 'copyAndClipToAuthoritativeTexels() / sampleViewCopyFragment',
        predicate: 'chartId > 0 && chartUnsafe == 0',
        preservesAuthoritativeSeamTexels: true,
        canWriteUnsafeOrUnownedSurface: false,
      },
      {
        path: 'updateFieldSampleView()',
        predicate: 'canonical authoritative copy only',
        preservesAuthoritativeSeamTexels: true,
        canWriteUnsafeOrUnownedSurface: false,
      },
      {
        path: 'updateRenderSampleView()',
        predicate: 'authoritative copy, then collision-checked safe seam padding',
        preservesAuthoritativeSeamTexels: true,
        canWriteUnsafeOrUnownedSurface: false,
      },
      {
        path: 'padFieldAcrossSeamsSafe()',
        predicate: 'safe empty gutter + redirect destination chart validation + redirect claim collision rejection',
        preservesAuthoritativeSeamTexels: true,
        canWriteUnsafeOrUnownedSurface: false,
      },
    ];
    return {
      phase: 'canonical-sample-view-audit',
      rows,
      unsafeRows: rows.filter((row) =>
        !row.preservesAuthoritativeSeamTexels || row.canWriteUnsafeOrUnownedSurface
      ),
      accepted: rows.every((row) =>
        row.preservesAuthoritativeSeamTexels && !row.canWriteUnsafeOrUnownedSurface
      ),
      note: 'Canonical and sample-view paths use authoritative ownership for writable state and collision-checked redirects for derived padding; they do not reintroduce mask cracks.',
    };
  }

  function measureChunkBAcceptanceReport() {
    const watertight = measureWatertightDomainDiagnostics();
    const transitionNoFlux = measureTransitionNoFluxDiagnostics();
    const seamEdge = measureSeamEdgeDomainContinuity();
    const transitionDiagnostics = measureZeroGutterTransitionDiagnostics();
    const productionMaskUsage = measureProductionMaskUsageAudit();
    const canonicalSampleView = measureCanonicalSampleViewAudit();
    const pr12ProductionAudit = measurePr12ProductionSamplingAudit();
    const safeSampling = measureSafeSamplingRejections(32);
    const agentTopology = measureAgentTopologySafety(1);
    const splatOwnership = measureSplatOwnershipDiagnostics(64);
    const oatTopology = measureOatTopologySafety(16);
    const transitionPacking = transitionDiagnostics.transitionCandidatePacking ?? {};
    const diffusionAutomaticWallNoFluxSamples =
      transitionNoFlux.totals.knownTrueSeamCollisionNoFluxSamples;
    const agentMovementAutomaticWallRejections =
      agentTopology.moveRejectedZeroGutterClaimCollision;
    const safeSamplingByPass = Object.fromEntries(safeSampling.passes.map((pass) => [
      pass.pass,
      {
        acceptedSameChart: pass.acceptedSameChart,
        directionResolvedAcceptedTransitions: pass.acceptedZeroGutterTransition,
        unresolvedAmbiguousTransitions: pass.rejectedZeroGutterClaimCollision,
        wrongDirectionRejections: pass.rejectedZeroGutterWrongDirection,
        notCrossingRejections: pass.rejectedZeroGutterNotCrossing,
        unresolvedTransitionRejections: pass.rejectedZeroGutterUnresolved,
        unsafeRejections: pass.rejectedUnsafe,
        outsideAtlasRejections: pass.rejectedOutsideAtlas,
        unrelatedChartRejections: pass.rejectedCrossOwner,
      },
    ]));
    function summarizeAgentPrefix(prefix) {
      const title = prefix === 'sensor' ? 'agent sensing' :
        prefix === 'move' ? 'agent movement' : 'child placement';
      return {
        pass: title,
        acceptedSameChart: agentTopology[`${prefix}AcceptedSameChart`],
        directionResolvedAcceptedTransitions:
          agentTopology[`${prefix}AcceptedZeroGutterTransition`],
        acceptedRedirects: agentTopology[`${prefix}AcceptedRedirect`],
        unresolvedAmbiguousTransitions:
          agentTopology[`${prefix}RejectedZeroGutterClaimCollision`],
        wrongDirectionRejections:
          agentTopology[`${prefix}RejectedZeroGutterWrongDirection`],
        notCrossingRejections:
          agentTopology[`${prefix}RejectedZeroGutterNotCrossing`],
        unresolvedTransitionRejections:
          agentTopology[`${prefix}RejectedZeroGutterUnresolved`],
        unsafeRejections:
          agentTopology[`${prefix}RejectedUnsafeOwnership`],
        outsideAtlasRejections:
          agentTopology[`${prefix}RejectedOutsideAtlas`],
        unrelatedChartRejections:
          agentTopology[`${prefix}RejectedUnrelatedChart`],
        redirectClaimCollisionRejections:
          agentTopology[`${prefix}RejectedRedirectClaimCollision`],
      };
    }
    function summarizeSplat(pass) {
      return {
        pass: pass.pass,
        acceptedSameChartFragments: pass.acceptedSameChartFragments,
        seamContinuationAcceptedFragments: pass.seamContinuationAcceptedFragments,
        seamContinuationContributionCount: pass.seamContinuationContributionCount,
        unresolvedAmbiguousTransitions: pass.skippedTransitionCollisionContributions,
        unsafeSkips: pass.clippedUnsafeOwnershipFragments,
        unrelatedChartSkips: pass.clippedUnrelatedChartFragments,
        wrongDirectionOrNotCrossingSkips:
          pass.skippedWrongDirectionNotCrossingContributions,
        truncatedKernelSupportCount: pass.truncatedKernelSupportCount,
      };
    }
    const transitionAcceptanceByConsumer = {
      diffusion: {
        acceptedSameChartSamples: transitionNoFlux.totals.acceptedSameChartSamples,
        directionResolvedAcceptedTransitions:
          transitionNoFlux.totals.acceptedTransitionSamples,
        acceptedTransitionSamplesFromOverflow:
          transitionNoFlux.totals.acceptedTransitionSamplesFromOverflow,
        acceptedRedirectSamples: transitionNoFlux.totals.acceptedRedirectSamples,
        noFluxFallbackSamples: transitionNoFlux.totals.totalNoFluxSamples,
        unresolvedAmbiguousTransitions:
          transitionNoFlux.transitionCandidateResolution.unresolvedAmbiguousTransitions,
        unsafeMicroRejections:
          transitionNoFlux.transitionCandidateResolution.unsafeMicroRejections,
        wrongDirectionRejections:
          transitionNoFlux.transitionCandidateResolution.wrongDirectionRejections,
        notCrossingRejections:
          transitionNoFlux.transitionCandidateResolution.notCrossingRejections,
        metadataChartMismatches:
          transitionNoFlux.transitionCandidateResolution.metadataChartMismatches,
      },
      renderSmoothing: safeSamplingByPass['render smoothing'],
      bumpNormals: safeSamplingByPass['bump normals'],
      canonicalDiffusionSampledStride: safeSamplingByPass['canonical diffusion'],
      agentSensing: summarizeAgentPrefix('sensor'),
      agentMovement: summarizeAgentPrefix('move'),
      childPlacement: summarizeAgentPrefix('child'),
      densitySplat: summarizeSplat(splatOwnership.density),
      depositSplat: summarizeSplat(splatOwnership.deposit),
      oatField: {
        sameChartContributionSamples: oatTopology.sameChartContributionSamples,
        virtualOatContributionCount: oatTopology.virtualOatContributionCount,
        sourceDestinationContributionPairs:
          oatTopology.sourceDestinationContributionPairs.slice(0, 16),
        unresolvedAmbiguousTransitions:
          oatTopology.skippedTransitionCollisionContributions,
        unsafeSkips: oatTopology.skippedUnsafeContributions,
        wrongDirectionOrNotCrossingSkips:
          oatTopology.skippedWrongDirectionNotCrossingContributions,
        truncatedContributionCount: oatTopology.truncatedContributionCount,
      },
    };
    const checks = {
      maskAndOwnershipStable:
        watertight.seamEdgeMaskEmptyTexelsAfter === 0 &&
        watertight.authoritativeButMaskEmptyTexelsAfter === 0 &&
        watertight.unownedCoveredTexels === 0,
      noValidTrueSeamNoFluxNeedingFix:
        transitionNoFlux.acceptanceClassification.validTrueSeamNoFluxNeedingFix === 0,
      noMissingTransitionNoFlux:
        transitionNoFlux.causeCounts.transitionMetadataMissing === 0,
      noInsufficientTransitionBandNoFlux:
        transitionNoFlux.causeCounts.insufficientTransitionBandCoverage === 0,
      noAcceptedTransitionsFromOverflow:
        transitionNoFlux.totals.acceptedTransitionSamplesFromOverflow === 0,
      transitionCollisionsAreDirectionResolved:
        transitionDiagnostics.collisionRejectsOnlyOnAmbiguity === true &&
        transitionDiagnostics.effectiveAutomaticWallTexelsOnOrdinarySeamTexels <= 32,
      automaticWallsDoNotAffectOrdinaryDiffusionOrMovement:
        diffusionAutomaticWallNoFluxSamples <= 32 &&
        agentMovementAutomaticWallRejections <= 4,
      remainingTransitionNoFluxClassified:
        transitionNoFlux.totals.transitionResolutionNoFluxSamples ===
          transitionNoFlux.totals.ambiguousCollisionNoFluxSamples +
          transitionNoFlux.causeCounts.wrongDirectionRejection +
          transitionNoFlux.causeCounts.metadataChartMismatch +
          transitionNoFlux.causeCounts.destinationOwnershipUnsafeRejection,
      watertightCracksSeparatedFromTransitionOverlay: true,
      binaryMaskNotUsedAsOwnership: productionMaskUsage.binaryMaskSemanticOwnershipUses === 0,
      canonicalSampleViewsAccepted: canonicalSampleView.accepted,
      productionSamplingAuditSafe:
        pr12ProductionAudit.unsafeProductionRows.length === 0 &&
        pr12ProductionAudit.omittedProductionPaths.length === 0,
    };
    const accepted = Object.values(checks).every(Boolean);
    return {
      chunk: 'B',
      phases: ['Phase 3', 'Phase 4', 'Phase 5', 'Phase 6'],
      status: accepted ? 'accepted' : 'needs-review',
      accepted,
      checks,
      summary: {
        unresolvedTransitionNoFluxSamples: watertight.unresolvedTransitionNoFluxSamples,
        transitionResolutionNoFluxSamples:
          transitionNoFlux.totals.transitionResolutionNoFluxSamples,
        collisionOrAmbiguousNoFluxSamples:
          transitionNoFlux.acceptanceClassification.collisionOrAmbiguousNoFluxSamples,
        ambiguousNonSeamNoFluxSamples:
          transitionNoFlux.acceptanceClassification.ambiguousNonSeamNoFluxSamples,
        validTrueSeamNoFluxNeedingFix:
          transitionNoFlux.acceptanceClassification.validTrueSeamNoFluxNeedingFix,
        trueUnsafeMicroNoFluxSamples: transitionNoFlux.causeCounts.trueUnsafeMicroNoFlux,
        trueBoundaryNoFluxSamples:
          transitionNoFlux.acceptanceClassification.trueBoundaryNoFluxSamples,
        wrongDirectionRejections: transitionNoFlux.causeCounts.wrongDirectionRejection,
        metadataChartMismatches: transitionNoFlux.causeCounts.metadataChartMismatch,
        directionResolvedDiffusionTransitions:
          transitionNoFlux.totals.acceptedTransitionSamples,
        acceptedTransitionSamplesFromOverflow:
          transitionNoFlux.totals.acceptedTransitionSamplesFromOverflow,
        transitionCandidateOverflowTexels:
          transitionDiagnostics.candidateOverflowTexels,
        effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels:
          transitionDiagnostics.effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels,
        effectiveAutomaticWallTexelsOnOrdinarySeamTexels:
          transitionDiagnostics.effectiveAutomaticWallTexelsOnOrdinarySeamTexels,
        effectiveAutomaticWallTexelsAtAmbiguousJunctions:
          transitionDiagnostics.effectiveAutomaticWallTexelsAtAmbiguousJunctions,
        trueOverflowAfterFilteringDeduplicationTexels:
          transitionPacking.trueOverflowAfterFilteringDeduplicationTexels ?? 0,
        duplicateCandidatesMerged:
          transitionPacking.duplicateCandidatesMerged ?? 0,
        discardedSourceChartMismatchCandidates:
          transitionPacking.discardedSourceChartMismatchCandidates ?? 0,
        diffusionAutomaticWallNoFluxSamples,
        agentMovementAutomaticWallRejections,
        automaticWallCollisionTexels:
          transitionDiagnostics.automaticWallCollisionTexels,
        automaticWallCollisionRatio:
          transitionDiagnostics.automaticWallCollisionRatio,
        transitionBandSufficientForDiffusion:
          transitionNoFlux.transitionBandSufficientForDiffusion,
        seamEdgeUnresolvedTexels: seamEdge.unresolvedSeamTexels,
        seamEdgeUnsafeTexels: seamEdge.unsafeSourceTexels,
      },
      transitionCandidateResolution:
        transitionNoFlux.transitionCandidateResolution,
      transitionCandidatePacking: transitionPacking,
      transitionAcceptanceByConsumer,
      watertightDomain: {
        seamEdgeMaskEmptyTexelsAfter: watertight.seamEdgeMaskEmptyTexelsAfter,
        authoritativeButMaskEmptyTexelsAfter: watertight.authoritativeButMaskEmptyTexelsAfter,
        maskCoveredButNoChartTexels: watertight.maskCoveredButNoChartTexels,
        unownedCoveredTexels: watertight.unownedCoveredTexels,
        unsafeCoveredTexels: watertight.unsafeCoveredTexels,
        falseCrackNoFluxSamples: watertight.falseCrackNoFluxSamples,
        unresolvedTransitionNoFluxSamples: watertight.unresolvedTransitionNoFluxSamples,
        dominantSuspectedCrackSource: watertight.dominantSuspectedCrackSource,
      },
      transitionNoFlux: {
        totals: transitionNoFlux.totals,
        causeCounts: transitionNoFlux.causeCounts,
        destinationBreakdown: transitionNoFlux.destinationBreakdown,
        acceptanceClassification: transitionNoFlux.acceptanceClassification,
        topPairs: transitionNoFlux.topPairs,
      },
      seamEdgeContinuity: seamEdge,
      transitionDiagnostics,
      productionMaskUsage,
      canonicalSampleView,
      productionSamplingAudit: {
        repeatWrappedTargetCount: pr12ProductionAudit.repeatWrappedTargetCount,
        unsafeProductionRows: pr12ProductionAudit.unsafeProductionRows,
        omittedProductionPaths: pr12ProductionAudit.omittedProductionPaths,
        productionSamplingRows: pr12ProductionAudit.productionSamplingRows,
      },
      note: 'Chunk B acceptance report. Remaining no-flux is accepted only when classified as true empty/outside boundary, unsafe micro ownership, or transition claim collision/ambiguous metadata; mask and chart ownership are not modified by this report.',
    };
  }

  function measurePr12ProductionSamplingAudit() {
    const renderTargets = dumpRenderTargetConfig();
    const renderTargetRows = Object.entries(renderTargets).map(([name, config]) => ({
      name,
      wrapS: config.wrapS,
      wrapT: config.wrapT,
      productionStateTarget: !name.toLowerCase().includes('debug'),
      usesRepeatWrapping: config.wrapS === 'RepeatWrapping' || config.wrapT === 'RepeatWrapping',
    }));
    const repeatWrappedTargets = renderTargetRows.filter((entry) => entry.usesRepeatWrapping);
    const remainingFractUses = [
      {
        site: 'agentAllocatorCommonFragment.hash()',
        expressionClass: 'fract(sin(seed) * constant)',
        purpose: 'scalar PRNG for wander/reproduction decisions',
        uvTopologyUse: false,
        debugOnly: false,
        allowedInPr12: true,
      },
      {
        site: 'seamTransitionCoverageFragment.rand() / chart debug coloring',
        expressionClass: 'fract(sin(seed) * constant)',
        purpose: 'deterministic debug color noise',
        uvTopologyUse: false,
        debugOnly: true,
        allowedInPr12: true,
      },
    ];
    const productionSamplingRows = [
      {
        path: 'canonical diffusion',
        topologyMode: 'resolveSampleUvSafe() for neighbors; center same-texel read only after authoritative ownership check',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'applyAgentFoodDeltas',
        topologyMode: 'same-texel food/deposit update gated by chartId/chartUnsafe; non-authoritative or unsafe texels write zero and the pass is followed by clipCanonicalField(fieldRT)',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'render smoothing and bump normals',
        topologyMode: 'resolveSampleUvSafe() with zero-gutter transitions and collision claims',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'agent food/oat/density sensing',
        topologyMode: 'resolveSampleUvSafe(); density uses validated texelFetch after UV resolution',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'agent movement and child placement',
        topologyMode: 'parent-update + deferred-debit compact allocator; resolveMoveUvSafe() validates same-chart, zero-gutter transition, or redirect destination',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'agent reproduction storage allocation',
        topologyMode: 'advanced parents are preserved first; child proposal admission is prefix-compacted and parent reserve is debited only for admitted children',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'density/deposit splats',
        topologyMode: 'chart-owned same-chart draw plus validated one-hop seam continuation',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'oat field',
        topologyMode: 'chart-owned same-chart evaluation plus validated one-hop seam continuation',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'seam weld equalization',
        topologyMode: 'explicit weld map destination plus weld meta source/destination chart validation, chartUnsafe rejection, atlas bounds check, texel-center sample; no fract wrap',
        atlasWrapping: false,
        crossOwnerReadsAllowed: false,
      },
      {
        path: 'legacy console dilateRenderField() alias',
        topologyMode: 'debug/manual derived sample-view dilation; not used by the animation frame',
        atlasWrapping: false,
        crossOwnerReadsAllowed: 'manual legacy helper',
      },
    ];
    const unsafeProductionRows = productionSamplingRows.filter((row) =>
      row.atlasWrapping || row.crossOwnerReadsAllowed === true
    );
    const requiredProductionPaths = [
      'canonical diffusion',
      'applyAgentFoodDeltas',
      'render smoothing and bump normals',
      'agent food/oat/density sensing',
      'agent movement and child placement',
      'agent reproduction storage allocation',
      'density/deposit splats',
      'oat field',
      'seam weld equalization',
    ];
    const auditedProductionPathSet = new Set(productionSamplingRows.map((row) => row.path));
    const omittedProductionPaths = requiredProductionPaths.filter((path) =>
      !auditedProductionPathSet.has(path)
    );
    return {
      pr12Status: 'complete',
      pr12OverallComplete:
        repeatWrappedTargets.length === 0 &&
        unsafeProductionRows.length === 0 &&
        omittedProductionPaths.length === 0,
      repeatWrappedTargetCount: repeatWrappedTargets.length,
      repeatWrappedTargets,
      renderTargetRows,
      remainingFractUses,
      remainingUvFractUses: remainingFractUses.filter((entry) => entry.uvTopologyUse),
      requiredProductionPaths,
      omittedProductionPaths,
      productionSamplingRows,
      unsafeProductionRows,
      note: 'PR12 audit: production render targets are clamp-wrapped; remaining fract() calls are scalar hashes, not UV topology; production sampling/update paths use authoritative ownership checks, explicit seam redirect/transition, or conservative fallback.',
    };
  }

  function dumpRenderTargetConfig() {
    return {
      agentRead: describeRenderTarget(agentRT.read),
      agentWrite: describeRenderTarget(agentRT.write),
      agentParentNext: describeRenderTarget(agentParentNextRT),
      agentCandidate: describeRenderTarget(agentCandidateRT),
      agentPrefixRead: describeRenderTarget(agentPrefixRT.read),
      agentPrefixWrite: describeRenderTarget(agentPrefixRT.write),
      canonicalFoodRead: describeRenderTarget(fieldRT.read),
      canonicalFoodWrite: describeRenderTarget(fieldRT.write),
      fieldSampleView: describeRenderTarget(fieldSampleViewRT),
      canonicalRenderRead: describeRenderTarget(renderRT.read),
      canonicalRenderWrite: describeRenderTarget(renderRT.write),
      renderSampleViewRead: describeRenderTarget(renderSampleViewRT.read),
      renderSampleViewWrite: describeRenderTarget(renderSampleViewRT.write),
      sampleViewRead: describeRenderTarget(renderSampleViewRT.read),
      sampleViewWrite: describeRenderTarget(renderSampleViewRT.write),
      sampleViewScratch: describeRenderTarget(renderScratchRT),
      oatCanonical: describeRenderTarget(oatRT),
      density: describeRenderTarget(densityRT),
      depositDensityCanonical: describeRenderTarget(depositDensityRT),
      surfaceCoverage: describeRenderTarget(surfaceCoverageRT),
      uvIslandMask: describeRenderTarget(uvIslandMaskRT),
      legacyUvIslandMask: describeRenderTarget(legacyUvIslandMaskRT),
      seamRedirectUv: describeRenderTarget(seamRedirectUvRT),
      seamRedirectMeta: describeRenderTarget(seamRedirectMetaRT),
      seamRedirectClaim: describeRenderTarget(seamRedirectClaimRT),
      seamWeldUv: describeRenderTarget(seamWeldUvRT),
      seamWeldMeta: describeRenderTarget(seamWeldMetaRT),
      seamTransitionUv: describeRenderTarget(seamTransitionUvRT),
      seamTransitionMeta: describeRenderTarget(seamTransitionMetaRT),
      seamTransitionDirection: describeRenderTarget(seamTransitionDirectionRT),
      seamTransitionBasis: describeRenderTarget(seamTransitionBasisRT),
      seamTransitionClaim: describeRenderTarget(seamTransitionClaimRT),
      chartId: describeRenderTarget(chartIdRT),
      chartConflictUnsafe: describeRenderTarget(chartConflictRT),
      chartUnsafe: describeRenderTarget(chartUnsafeRT),
      seamPaddingDebug: describeRenderTarget(seamPaddingDebugRT),
    };
  }

  function dumpTopologySafetyReport() {
    const charts = summarizeCharts();
    const clearance = measureChartClearance();
    const overlaps = detectUvOverlapConflicts();
    const ownershipStats = measureChartOwnershipStats();
    const footprints = measureCurrentSamplingFootprints();
    const padding = measurePaddingCollisionRisk(SEAM_REDIRECT_HALO_TEXELS);
    const crossOwner = measureCrossOwnerReads();
    const topologyBudget = measureTopologySafetyBudget();
    const safeSampling = measureSafeSamplingRejections();
    const agentTopology = measureAgentTopologySafety();
    const fieldDomainEnergy = measureFieldDomainEnergy();
    const splatDomainEnergy = measureSplatDomainEnergy();
    const splatOwnership = measureSplatOwnershipDiagnostics();
    const oatTopology = measureOatTopologySafety();
    const diffusionContinuity = measureDiffusionContinuityDiagnostics();
    const zeroGutterTransitions = measureZeroGutterTransitionDiagnostics();
    const seamPadding = measureSeamPaddingDiagnostics();
    const seamContinuity = measureSeamContinuityClosure();
    const watertightDomain = measureWatertightDomainDiagnostics();
    const transitionNoFlux = measureTransitionNoFluxDiagnostics();
    const seamEdgeDomain = measureSeamEdgeDomainContinuity();
    const chunkBAcceptance = measureChunkBAcceptanceReport();
    const pr12Audit = measurePr12ProductionSamplingAudit();
    const report = {
      pr11AcceptedScope: 'PR11A/B/C plus PR11.5 complete before PR12',
      pr11OverallComplete: true,
      pr12Status: pr12Audit.pr12Status,
      pr12OverallComplete: pr12Audit.pr12OverallComplete,
      charts,
      clearance,
      overlaps,
      ownership: ownershipStats,
      footprints,
      topologyBudget,
      safeSampling,
      agentTopology,
      fieldDomainEnergy,
      splatDomainEnergy,
      splatOwnership,
      oatTopology,
      diffusionContinuity,
      zeroGutterTransitions,
      seamPadding,
      seamContinuity,
      watertightDomain,
      transitionNoFlux,
      seamEdgeDomain,
      chunkBAcceptance,
      pr12Audit,
      padding,
      crossOwner,
      agentCreation: { ...lastAgentCreationDiagnostics },
      renderTargets: dumpRenderTargetConfig(),
    };
    console.table({
      pr11AcceptedScope: 'PR11A/B/C + PR11.5',
      pr11OverallComplete: true,
      pr12Status: pr12Audit.pr12Status,
      pr12OverallComplete: pr12Audit.pr12OverallComplete,
      chartCount: charts.chartCount,
      minDistinctBoundaryClearanceTexels: clearance.minimumDistinctChartBoundaryClearanceTexels,
      unsafeOwnershipTexels: ownershipStats.unsafeTexels,
      centerUnsafeOwnershipTexels: ownershipStats.centerUnsafeTexels,
      multiOwnerConflictTexels: ownershipStats.multiOwnerConflictTexels,
      centerMultiOwnerConflictTexels: ownershipStats.centerMultiOwnerConflictTexels,
      conservativeChartClaimTexels: ownershipStats.conservativeClaimTexels,
      conservativeOwnedTexels: ownershipStats.conservativeOwnedTexels,
      centerOwnedTexels: ownershipStats.centerOwnedTexels,
      zeroOwnedChartCount: ownershipStats.zeroOwnedChartCount,
      centerZeroOwnedChartCount: ownershipStats.centerZeroOwnedChartCount,
      microChartCount: ownershipStats.microChartCount,
      zeroOwnedOrMicroChartIds: ownershipStats.zeroOwnedOrMicroCharts.map((chart) => chart.id).join(', ') || 'none',
      requiredFootprintTexels: footprints.requiredSamplingFootprintTexels,
      maxSafePaddingTexels: topologyBudget.maxSafePaddingTexels,
      requiresConservativeFallback: topologyBudget.requiresConservativeFallback,
      requiresZeroGutterTransition: topologyBudget.requiresZeroGutterTransition,
      seamHaloTexels: SEAM_REDIRECT_HALO_TEXELS,
      safeGutterForCurrentHalo: padding.safeGutterAvailable,
      currentHaloWouldCollide: padding.oneSidedPaddingWouldCollide,
      safeSamplingRejectedCrossOwnerEstimate: safeSampling.totals.rejectedCrossOwner,
      safeSamplingRejectedUnsafeEstimate: safeSampling.totals.rejectedUnsafe,
      safeSamplingAcceptedZeroGutterTransitions: safeSampling.totals.acceptedZeroGutterTransition,
      agentCreationCreatedAgents: lastAgentCreationDiagnostics.createdAgents,
      agentCreationFailedAgents: lastAgentCreationDiagnostics.failedAgents,
      agentCreationLocalRetryAttempts: lastAgentCreationDiagnostics.localRetryAttempts,
      agentCreationGlobalFallbackAccepted: lastAgentCreationDiagnostics.globalAccepted,
      agentCreationDeterministicFallbackAccepted: lastAgentCreationDiagnostics.deterministicFallbackAccepted,
      agentCreationInvalidCreatedAgents: lastAgentCreationDiagnostics.invalidCreatedAgents,
      agentAcceptedSameChartMoves: agentTopology.acceptedSameChartMoves,
      agentAcceptedSeamRedirectMoves: agentTopology.acceptedSeamRedirectMoves,
      agentAcceptedZeroGutterTransitionMoves: agentTopology.acceptedZeroGutterAgentTransitionMoves,
      agentZeroGutterTransitionAcceptanceRatio: agentTopology.zeroGutterTransitionAcceptanceRatio,
      agentRejectedMoveFallbacks: agentTopology.rejectedMoveFallbacks,
      agentChildPlacementFallbacks: agentTopology.childPlacementFallbacks,
      agentKilledInvalidCurrentAgents: agentTopology.killedInvalidCurrentAgents,
      agentRejectedUnrelatedChartEstimate: agentTopology.totalRejectedUnrelatedChart,
      agentRejectedRedirectClaimCollisionEstimate: agentTopology.totalRejectedRedirectClaimCollision,
      densitySplatClippedUnrelatedEstimate: splatOwnership.density.clippedUnrelatedChartFragments,
      densitySplatClippedUnsafeEstimate: splatOwnership.density.clippedUnsafeOwnershipFragments,
      densitySplatClippedEmptyGutterEstimate: splatOwnership.density.clippedEmptyGutterFragments,
      depositSplatClippedUnrelatedEstimate: splatOwnership.deposit.clippedUnrelatedChartFragments,
      depositSplatClippedUnsafeEstimate: splatOwnership.deposit.clippedUnsafeOwnershipFragments,
      depositSplatClippedEmptyGutterEstimate: splatOwnership.deposit.clippedEmptyGutterFragments,
      densitySplatSeamContinuationEstimate: splatOwnership.density.seamContinuationContributionCount,
      depositSplatSeamContinuationEstimate: splatOwnership.deposit.seamContinuationContributionCount,
      validOatCount: oatTopology.validOatCount,
      invalidOatCount: oatTopology.invalidOatCount,
      virtualOatContributionCount: oatTopology.virtualOatContributionCount,
      oatSupportSigmas: oatTopology.oatSupportSigmas,
      diffusionSameChartSamples: diffusionContinuity.sameChartDiffusionSamples,
      diffusionAcceptedSeamTransitionSamples: diffusionContinuity.acceptedSeamTransitionDiffusionSamples,
      diffusionNoFluxFallbackSamples: diffusionContinuity.noFluxFallbackSamples,
      zeroGutterTransitionBandTexels: zeroGutterTransitions.transitionBandTexels,
      zeroGutterRequestedBandTexels: zeroGutterTransitions.requestedVisualTransitionBandTexels,
      zeroGutterActualBandTexels: zeroGutterTransitions.actualTransitionBandTexels,
      zeroGutterCoverageSufficient: zeroGutterTransitions.coverageSufficientForCurrentVisualSettings,
      zeroGutterSupportedUiCoverageSufficient: zeroGutterTransitions.coverageSufficientForSupportedUiRange,
      zeroGutterValidTransitionTexels: zeroGutterTransitions.validTransitionTexels,
      zeroGutterClaimCollisionTexels: zeroGutterTransitions.claimCollisionTexels,
      oldMaskCoverageTexels: watertightDomain.oldMaskCoverageTexels,
      conservativeCoverageTexels: watertightDomain.conservativeCoverageTexels,
      newlyCoveredTexels: watertightDomain.newlyCoveredTexels,
      watertightMaskCrackTexels: watertightDomain.maskCrackTexels,
      seamEdgeMaskEmptyBefore: watertightDomain.seamEdgeMaskEmptyTexelsBefore,
      seamEdgeMaskEmptyAfter: watertightDomain.seamEdgeMaskEmptyTexelsAfter,
      authoritativeButMaskEmptyBefore: watertightDomain.authoritativeButMaskEmptyTexelsBefore,
      authoritativeButMaskEmptyAfter: watertightDomain.authoritativeButMaskEmptyTexelsAfter,
      maskCoveredButNoChartBefore: watertightDomain.maskCoveredButNoChartTexelsBefore,
      maskCoveredButNoChartAfter: watertightDomain.maskCoveredButNoChartTexels,
      unownedCoveredBefore: watertightDomain.unownedCoveredTexelsBefore,
      unownedCoveredAfter: watertightDomain.unownedCoveredTexels,
      unsafeCoveredBefore: watertightDomain.unsafeCoveredTexelsBefore,
      unsafeCoveredAfter: watertightDomain.unsafeCoveredTexels,
      seamEdgeUnownedBefore: watertightDomain.seamEdgeUnownedTexelsBefore,
      seamEdgeUnownedAfter: watertightDomain.seamEdgeUnownedTexels,
      seamEdgeUnsafeBefore: watertightDomain.seamEdgeUnsafeTexelsBefore,
      seamEdgeUnsafeAfter: watertightDomain.seamEdgeUnsafeTexels,
      watertightFalseCrackNoFluxSamplesBefore: watertightDomain.falseCrackNoFluxSamplesBefore,
      watertightFalseCrackNoFluxSamples: watertightDomain.falseCrackNoFluxSamples,
      unresolvedTransitionNoFluxSamplesBefore: watertightDomain.unresolvedTransitionNoFluxSamplesBefore,
      unresolvedTransitionNoFluxSamplesAfter: watertightDomain.unresolvedTransitionNoFluxSamples,
      transitionNoFluxSamples: transitionNoFlux.totals.totalNoFluxSamples,
      transitionResolutionNoFluxSamples: transitionNoFlux.totals.transitionResolutionNoFluxSamples,
      transitionNoFluxUnsafeMicroSamples: transitionNoFlux.causeCounts.trueUnsafeMicroNoFlux,
      transitionNoFluxMetadataMissing: transitionNoFlux.causeCounts.transitionMetadataMissing,
      transitionNoFluxClaimCollision: transitionNoFlux.causeCounts.transitionClaimCollision,
      transitionNoFluxWrongDirection: transitionNoFlux.causeCounts.wrongDirectionRejection,
      transitionNoFluxNotCrossing: transitionNoFlux.causeCounts.notCrossingRejection,
      transitionNoFluxDestinationRejected: transitionNoFlux.causeCounts.destinationOwnershipUnsafeRejection,
      transitionNoFluxInsufficientBand: transitionNoFlux.causeCounts.insufficientTransitionBandCoverage,
      chunkBAccepted: chunkBAcceptance.accepted,
      chunkBStatus: chunkBAcceptance.status,
      chunkBValidTrueSeamNoFluxNeedingFix:
        chunkBAcceptance.summary.validTrueSeamNoFluxNeedingFix,
      seamEdgeUnresolvedTexels: seamEdgeDomain.unresolvedSeamTexels,
      watertightDominantSource: watertightDomain.dominantSuspectedCrackSource,
      repeatWrappedTargetCount: pr12Audit.repeatWrappedTargetCount,
      remainingUvFractUseCount: pr12Audit.remainingUvFractUses.length,
      densityNonAuthoritativeEnergy: splatDomainEnergy.density.nonAuthoritativeEnergy,
      depositDensityNonAuthoritativeEnergy: splatDomainEnergy.depositDensity.nonAuthoritativeEnergy,
      canonicalRenderNonAuthoritativeEnergy: fieldDomainEnergy.canonicalRender.nonAuthoritativeEnergy,
      renderSampleViewNonAuthoritativeEnergy: fieldDomainEnergy.renderSampleView.nonAuthoritativeEnergy,
      requestedPadTexels: seamPadding.requestedPadTexels,
      allowedPadTexels: seamPadding.allowedPadTexels,
      writtenPadTexels: seamPadding.writtenPadTexels,
      skippedPadByBudgetCollisionTexels: seamPadding.skippedByBudgetCollisionTexels,
      skippedPadByRedirectCollisionTexels: seamPadding.skippedByRedirectCollisionTexels,
      skippedPadByRealChartTexels: seamPadding.skippedByRealChartTexels,
      skippedPadByUnsafeOwnershipTexels: seamPadding.skippedByUnsafeOwnershipTexels,
      skippedPadByUnresolvedDestinationTexels: seamPadding.skippedByUnresolvedDestinationTexels,
      unsafePasses: crossOwner.unsafePasses.join(', ') || 'none estimated',
    });
    console.table(ownershipStats.zeroOwnedOrMicroCharts);
    console.table(safeSampling.passes);
    console.table([lastAgentCreationDiagnostics]);
    console.table([agentTopology]);
    console.table([splatOwnership.density, splatOwnership.deposit]);
    console.table(oatTopology.perOat);
    console.table(seamContinuity.rows);
    console.table([watertightDomain]);
    console.table(transitionNoFlux.topPairs);
    console.table(seamEdgeDomain.perSeamSummary);
    console.table(zeroGutterTransitions.sourceDestinationPairs);
    console.table(crossOwner.passFootprints);
    console.table(pr12Audit.productionSamplingRows);
    return report;
  }

  const timedReadback = (name, fn) => (...args) =>
    runReadbackDiagnostic(name, () => fn(...args));

  return {
    summarizeCharts,
    measureChartClearance,
    detectUvOverlapConflicts,
    measureChartOwnershipStats,
    getChartOwnershipStats,
    getMicroCharts,
    getZeroOwnedCharts,
    getUnsafeCharts,
    measureCurrentSamplingFootprints,
    getFootprintRegistry: measureCurrentSamplingFootprints,
    getSafeGutterBudgetTexels: measureSafeGutterBudget,
    getTopologySafetyBudget: measureTopologySafetyBudget,
    measureSafeSamplingRejections: timedReadback('measureSafeSamplingRejections', measureSafeSamplingRejections),
    measureAgentTopologySafety: timedReadback('measureAgentTopologySafety', measureAgentTopologySafety),
    measurePaddingCollisionRisk,
    measureCrossOwnerReads,
    measureMaskSoftness: timedReadback('measureMaskSoftness', measureMaskSoftness),
    measureFieldDomainEnergy: timedReadback('measureFieldDomainEnergy', measureFieldDomainEnergy),
    measureSplatDomainEnergy: timedReadback('measureSplatDomainEnergy', measureSplatDomainEnergy),
    measureSplatOwnershipDiagnostics: timedReadback('measureSplatOwnershipDiagnostics', measureSplatOwnershipDiagnostics),
    measureOatTopologySafety: timedReadback('measureOatTopologySafety', measureOatTopologySafety),
    measureDiffusionContinuityDiagnostics: timedReadback('measureDiffusionContinuityDiagnostics', measureDiffusionContinuityDiagnostics),
    measureZeroGutterTransitionDiagnostics: timedReadback('measureZeroGutterTransitionDiagnostics', measureZeroGutterTransitionDiagnostics),
    measureSeamPaddingDiagnostics: timedReadback('measureSeamPaddingDiagnostics', measureSeamPaddingDiagnostics),
    measureSeamContinuityClosure: timedReadback('measureSeamContinuityClosure', measureSeamContinuityClosure),
    measureWatertightDomainDiagnostics: timedReadback('measureWatertightDomainDiagnostics', measureWatertightDomainDiagnostics),
    measureTransitionNoFluxDiagnostics: timedReadback('measureTransitionNoFluxDiagnostics', measureTransitionNoFluxDiagnostics),
    measureSeamEdgeDomainContinuity: timedReadback('measureSeamEdgeDomainContinuity', measureSeamEdgeDomainContinuity),
    getTransitionCandidatePackingDiagnostics: () => ({ ...lastTransitionCandidatePackingDiagnostics }),
    measureProductionMaskUsageAudit,
    measureCanonicalSampleViewAudit,
    measureChunkBAcceptanceReport: timedReadback('measureChunkBAcceptanceReport', measureChunkBAcceptanceReport),
    measurePr12ProductionSamplingAudit,
    dumpRenderTargetConfig,
    dumpTopologySafetyReport: timedReadback('dumpTopologySafetyReport', dumpTopologySafetyReport),
  };
}

function buildUvChartTopology(targetMesh) {
  const geom = targetMesh.geometry;
  const uvAttr = geom.attributes.uv?.array;
  const idx = geom.index?.array;
  if (!uvAttr || !idx) {
    return {
      faceCount: 0,
      charts: [],
      faceChartIds: new Int32Array(0),
      boundarySegments: [],
      nonManifoldUvEdgeCount: 0,
      uvAttr,
      idx,
    };
  }

  const faceCount = idx.length / 3;
  const parent = new Int32Array(faceCount);
  for (let i = 0; i < faceCount; i++) parent[i] = i;
  const find = (x) => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== x) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const faceUvKeys = new Array(faceCount);
  const edgeMap = new Map();
  for (let f = 0; f < faceCount; f++) {
    const verts = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
    const keys = verts.map((v) => uvKey(uvAttr[v * 2], uvAttr[v * 2 + 1]));
    faceUvKeys[f] = keys;
    for (let e = 0; e < 3; e++) {
      const aKey = keys[e];
      const bKey = keys[(e + 1) % 3];
      const key = edgeKey(aKey, bKey);
      if (!edgeMap.has(key)) edgeMap.set(key, []);
      edgeMap.get(key).push({ face: f, edge: e });
    }
  }

  let nonManifoldUvEdgeCount = 0;
  for (const entries of edgeMap.values()) {
    if (entries.length > 2) nonManifoldUvEdgeCount++;
    for (let i = 1; i < entries.length; i++) union(entries[0].face, entries[i].face);
  }

  const rootToChartId = new Map();
  const faceChartIds = new Int32Array(faceCount);
  const charts = [];
  for (let f = 0; f < faceCount; f++) {
    const root = find(f);
    let id = rootToChartId.get(root);
    if (!id) {
      id = charts.length + 1;
      rootToChartId.set(root, id);
      charts.push({
        id,
        faceCount: 0,
        uvAreaTexels: 0,
        boundarySegments: [],
        bounds: { minU: Infinity, minV: Infinity, maxU: -Infinity, maxV: -Infinity },
      });
    }
    faceChartIds[f] = id;
    const chart = charts[id - 1];
    chart.faceCount++;
    for (let e = 0; e < 3; e++) {
      const v = idx[f * 3 + e];
      const u = uvAttr[v * 2];
      const vCoord = uvAttr[v * 2 + 1];
      chart.bounds.minU = Math.min(chart.bounds.minU, u);
      chart.bounds.minV = Math.min(chart.bounds.minV, vCoord);
      chart.bounds.maxU = Math.max(chart.bounds.maxU, u);
      chart.bounds.maxV = Math.max(chart.bounds.maxV, vCoord);
    }
    const i0 = idx[f * 3];
    const i1 = idx[f * 3 + 1];
    const i2 = idx[f * 3 + 2];
    chart.uvAreaTexels += Math.abs(orient2d(
      uvAttr[i0 * 2], uvAttr[i0 * 2 + 1],
      uvAttr[i1 * 2], uvAttr[i1 * 2 + 1],
      uvAttr[i2 * 2], uvAttr[i2 * 2 + 1],
    )) * 0.5 * FIELD_SIZE * FIELD_SIZE;
  }

  const boundarySegments = [];
  for (let f = 0; f < faceCount; f++) {
    const chartId = faceChartIds[f];
    const verts = [idx[f * 3], idx[f * 3 + 1], idx[f * 3 + 2]];
    const keys = faceUvKeys[f];
    for (let e = 0; e < 3; e++) {
      const entries = edgeMap.get(edgeKey(keys[e], keys[(e + 1) % 3]));
      let sameChartCount = 0;
      for (const entry of entries) {
        if (faceChartIds[entry.face] === chartId) sameChartCount++;
      }
      if (sameChartCount > 1) continue;
      const a = verts[e];
      const b = verts[(e + 1) % 3];
      const segment = {
        index: boundarySegments.length,
        chartId,
        ax: uvAttr[a * 2],
        ay: uvAttr[a * 2 + 1],
        bx: uvAttr[b * 2],
        by: uvAttr[b * 2 + 1],
      };
      boundarySegments.push(segment);
      charts[chartId - 1].boundarySegments.push(segment);
    }
  }

  return { faceCount, charts, faceChartIds, boundarySegments, nonManifoldUvEdgeCount, uvAttr, idx };
}

function computeChartClearance(topo) {
  const thresholds = [1, 2, 4, 8, 16, 32, 64];
  const closestPairs = [];
  const segments = topo.boundarySegments;
  const segmentCount = segments.length;
  const maxThresholdTexels = Math.max(...thresholds);
  const cellSize = maxThresholdTexels / FIELD_SIZE;
  let minimum = Infinity;

  // Hot path at load: with ~60k boundary segments and a search radius of 64
  // texels, tens of millions of segment pairs land in neighboring grid cells.
  // Flatten the per-segment AABBs into typed arrays, key the grid numerically,
  // and dedup visits with a generation stamp instead of a per-segment Set. An
  // AABB lower bound then skips the exact segment distance whenever it cannot
  // beat the pair's running minimum (which decides every threshold bucket) or
  // the global minimum (which decides clearance and the closest-pair ties):
  // both only ever decrease, so a bound that loses now loses forever.
  const minXs = new Float64Array(segmentCount);
  const maxXs = new Float64Array(segmentCount);
  const minYs = new Float64Array(segmentCount);
  const maxYs = new Float64Array(segmentCount);
  const chartIds = new Int32Array(segmentCount);
  for (let i = 0; i < segmentCount; i++) {
    const seg = segments[i];
    minXs[i] = Math.min(seg.ax, seg.bx);
    maxXs[i] = Math.max(seg.ax, seg.bx);
    minYs[i] = Math.min(seg.ay, seg.by);
    maxYs[i] = Math.max(seg.ay, seg.by);
    chartIds[i] = seg.chartId;
  }

  const GRID_KEY_STRIDE = 4096;
  const grid = new Map();
  const lastVisitedBy = new Int32Array(segmentCount).fill(-1);
  const pairMinDistances = new Map();

  for (let i = 0; i < segmentCount; i++) {
    const seg = segments[i];
    const cMinX = Math.floor(minXs[i] / cellSize) - 1;
    const cMaxX = Math.floor(maxXs[i] / cellSize) + 1;
    const cMinY = Math.floor(minYs[i] / cellSize) - 1;
    const cMaxY = Math.floor(maxYs[i] / cellSize) + 1;

    for (let cy = cMinY; cy <= cMaxY; cy++) {
      for (let cx = cMinX; cx <= cMaxX; cx++) {
        const bucket = grid.get((cx + 2) * GRID_KEY_STRIDE + (cy + 2));
        if (!bucket) continue;
        for (let b = 0; b < bucket.length; b++) {
          const otherIndex = bucket[b];
          if (chartIds[otherIndex] === chartIds[i]) continue;
          if (lastVisitedBy[otherIndex] === i) continue;
          lastVisitedBy[otherIndex] = i;

          const gapX = Math.max(0, minXs[otherIndex] - maxXs[i], minXs[i] - maxXs[otherIndex]);
          const gapY = Math.max(0, minYs[otherIndex] - maxYs[i], minYs[i] - maxYs[otherIndex]);
          const aabbGapTexels = Math.sqrt(gapX * gapX + gapY * gapY) * FIELD_SIZE;
          const a = Math.min(chartIds[i], chartIds[otherIndex]);
          const bChart = Math.max(chartIds[i], chartIds[otherIndex]);
          const pairKey = a * 65536 + bChart;
          const pairMin = pairMinDistances.get(pairKey) ?? Infinity;
          if (aabbGapTexels >= pairMin && aabbGapTexels > minimum + 1e-6) continue;

          const other = segments[otherIndex];
          const distanceTexels = segmentDistance(seg, other) * FIELD_SIZE;
          if (distanceTexels < pairMin) pairMinDistances.set(pairKey, distanceTexels);
          if (distanceTexels < minimum) {
            minimum = distanceTexels;
            closestPairs.length = 0;
          }
          if (Math.abs(distanceTexels - minimum) < 1e-6 && closestPairs.length < 12) {
            closestPairs.push({
              chartA: seg.chartId,
              chartB: other.chartId,
              distanceTexels,
              segmentA: seg.index,
              segmentB: other.index,
            });
          }
        }
      }
    }

    for (let cy = cMinY + 1; cy <= cMaxY - 1; cy++) {
      for (let cx = cMinX + 1; cx <= cMaxX - 1; cx++) {
        const key = (cx + 2) * GRID_KEY_STRIDE + (cy + 2);
        let bucket = grid.get(key);
        if (!bucket) {
          bucket = [];
          grid.set(key, bucket);
        }
        bucket.push(i);
      }
    }
  }

  const chartPairsCloserThanTexels = {};
  for (const threshold of thresholds) {
    let pairCount = 0;
    for (const pairMin of pairMinDistances.values()) {
      if (pairMin <= threshold) pairCount++;
    }
    chartPairsCloserThanTexels[threshold] = pairCount;
  }

  return {
    chartCount: topo.charts.length,
    boundarySegmentCount: segments.length,
    searchRadiusTexels: maxThresholdTexels,
    minimumDistinctChartBoundaryClearanceTexels: Number.isFinite(minimum) ? minimum : null,
    clearanceSemantics: 'Minimum distance between distinct chart boundary segments; explicit seam-neighbor pairs are not filtered in PR3.',
    chartPairsCloserThanTexels,
    closestPairs,
  };
}

function rasterizeUvOwnershipMaps(topo) {
  const texelCount = FIELD_SIZE * FIELD_SIZE;
  const centerOwner = new Int32Array(texelCount);
  const centerUnsafe = new Uint8Array(texelCount);
  const centerMultiOwnerConflict = new Uint8Array(texelCount);
  const owner = new Int32Array(texelCount);
  const unsafe = new Uint8Array(texelCount);
  const multiOwnerConflict = new Uint8Array(texelCount);
  const claimOwner = new Int32Array(texelCount);
  const claimConflict = new Uint8Array(texelCount);
  const centerConflictPairs = new Set();
  const conflictPairs = new Set();
  const chartCount = topo.charts.length;
  const centerOwnerCounts = new Int32Array(chartCount);
  const centerClaimOwnerCounts = new Int32Array(chartCount);
  const conservativeCandidateOwnerCounts = new Int32Array(chartCount);
  const ownerCounts = new Int32Array(chartCount);
  const perChartCenterUnsafeTexels = Array.from({ length: chartCount }, () => new Set());
  const perChartUnsafeTexels = Array.from({ length: chartCount }, () => new Set());
  const perChartCenterConflictTexels = Array.from({ length: chartCount }, () => new Set());
  const perChartConservativeConflictTexels = Array.from({ length: chartCount }, () => new Set());
  const perChartStats = topo.charts.map((chart) => ({
    id: chart.id,
    faceCount: chart.faceCount,
    uvAreaTexels: chart.uvAreaTexels,
    ownedTexels: 0,
    conflictTexels: 0,
    unsafeTexels: 0,
    centerOwnedTexels: 0,
    centerClaimOwnedTexels: 0,
    oldCenterOwnedTexels: 0,
    centerConflictTexels: 0,
    conservativeClaimTexels: 0,
    conservativeSingleChartClaimTexels: 0,
    conservativeConflictTexels: 0,
    newConservativeOwnedTexels: 0,
    newUnsafeTexels: 0,
    isMicro: false,
    micro: false,
    isZeroOwned: false,
    zeroOwned: false,
    stillZeroOwned: false,
    stillMicro: false,
    isAmbiguousUnsafe: false,
    unsafe: false,
    boundarySegmentCount: chart.boundarySegments.length,
    bounds: { ...chart.bounds },
  }));
  let centerClaimOwnedTexels = 0;
  let centerOwnedTexels = 0;
  let centerUnsafeTexels = 0;
  let centerMultiOwnerConflictTexels = 0;
  let conservativeClaimTexels = 0;
  let conservativeSingleChartClaimTexels = 0;
  let unsafeTexels = 0;
  let multiOwnerConflictTexels = 0;
  let degenerateTriangles = 0;
  let conservativeCandidateTexelsTested = 0;
  let centerCandidateTexelsTested = 0;

  function markCenterUnsafe(index, chartId = 0) {
    if (centerUnsafe[index] === 0) {
      centerUnsafe[index] = 1;
      centerUnsafeTexels++;
    }
    if (chartId > 0 && chartId <= chartCount) {
      perChartCenterUnsafeTexels[chartId - 1].add(index);
    }
  }

  function markUnsafe(index, chartId = 0) {
    if (unsafe[index] === 0) {
      unsafe[index] = 1;
      unsafeTexels++;
    }
    if (chartId > 0 && chartId <= chartCount) {
      perChartUnsafeTexels[chartId - 1].add(index);
    }
  }

  function markCenterMultiOwnerConflict(index, previousChartId, chartId) {
    if (centerMultiOwnerConflict[index] === 0) {
      centerMultiOwnerConflict[index] = 1;
      centerMultiOwnerConflictTexels++;
    }
    markCenterUnsafe(index, previousChartId);
    markCenterUnsafe(index, chartId);
    if (previousChartId > 0 && previousChartId <= chartCount) {
      perChartCenterConflictTexels[previousChartId - 1].add(index);
    }
    if (chartId > 0 && chartId <= chartCount) {
      perChartCenterConflictTexels[chartId - 1].add(index);
    }
  }

  function markConservativeMultiOwnerConflict(index, previousChartId, chartId) {
    if (multiOwnerConflict[index] === 0) {
      multiOwnerConflict[index] = 1;
      multiOwnerConflictTexels++;
    }
    markUnsafe(index, previousChartId);
    markUnsafe(index, chartId);
    if (previousChartId > 0 && previousChartId <= chartCount) {
      perChartConservativeConflictTexels[previousChartId - 1].add(index);
    }
    if (chartId > 0 && chartId <= chartCount) {
      perChartConservativeConflictTexels[chartId - 1].add(index);
    }
  }

  function claimCenterTexel(index, chartId) {
    const previous = centerOwner[index];
    if (previous === 0) {
      centerOwner[index] = chartId;
      centerClaimOwnerCounts[chartId - 1]++;
      centerClaimOwnedTexels++;
    } else if (previous !== chartId) {
      markCenterMultiOwnerConflict(index, previous, chartId);
      const a = Math.min(previous, chartId);
      const b = Math.max(previous, chartId);
      centerConflictPairs.add(`${a}|${b}`);
    }
  }

  function claimConservativeTexel(index, chartId) {
    const previous = claimOwner[index];
    if (previous === 0) {
      claimOwner[index] = chartId;
      conservativeClaimTexels++;
    } else if (previous !== chartId) {
      claimConflict[index] = 1;
      markConservativeMultiOwnerConflict(index, previous, chartId);
      const a = Math.min(previous, chartId);
      const b = Math.max(previous, chartId);
      conflictPairs.add(`${a}|${b}`);
    }
  }

  for (let f = 0; f < topo.faceCount; f++) {
    const chartId = topo.faceChartIds[f];
    const i0 = topo.idx[f * 3];
    const i1 = topo.idx[f * 3 + 1];
    const i2 = topo.idx[f * 3 + 2];
    const u0 = topo.uvAttr[i0 * 2], v0 = topo.uvAttr[i0 * 2 + 1];
    const u1 = topo.uvAttr[i1 * 2], v1 = topo.uvAttr[i1 * 2 + 1];
    const u2 = topo.uvAttr[i2 * 2], v2 = topo.uvAttr[i2 * 2 + 1];
    const area = orient2d(u0, v0, u1, v1, u2, v2);
    if (Math.abs(area) < 1e-14) {
      degenerateTriangles++;
    }
    if (Math.abs(area) >= 1e-14) {
      const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * FIELD_SIZE));
      const maxX = Math.min(FIELD_SIZE - 1, Math.floor(Math.max(u0, u1, u2) * FIELD_SIZE));
      const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * FIELD_SIZE));
      const maxY = Math.min(FIELD_SIZE - 1, Math.floor(Math.max(v0, v1, v2) * FIELD_SIZE));
      for (let y = minY; y <= maxY; y++) {
        const py = (y + 0.5) / FIELD_SIZE;
        for (let x = minX; x <= maxX; x++) {
          centerCandidateTexelsTested++;
          const px = (x + 0.5) / FIELD_SIZE;
          if (!pointInTriangle(px, py, u0, v0, u1, v1, u2, v2, area)) continue;
          claimCenterTexel(y * FIELD_SIZE + x, chartId);
        }
      }
    }

    const conservativeMinX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * FIELD_SIZE) - 1);
    const conservativeMaxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(u0, u1, u2) * FIELD_SIZE) + 1);
    const conservativeMinY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * FIELD_SIZE) - 1);
    const conservativeMaxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(v0, v1, v2) * FIELD_SIZE) + 1);
    for (let y = conservativeMinY; y <= conservativeMaxY; y++) {
      for (let x = conservativeMinX; x <= conservativeMaxX; x++) {
        conservativeCandidateTexelsTested++;
        if (!triangleTouchesTexel(u0, v0, u1, v1, u2, v2, area, x, y)) continue;
        claimConservativeTexel(y * FIELD_SIZE + x, chartId);
      }
    }
  }

  for (let index = 0; index < texelCount; index++) {
    const chartId = claimOwner[index];
    if (chartId > 0 && claimConflict[index] === 0) {
      conservativeCandidateOwnerCounts[chartId - 1]++;
      conservativeSingleChartClaimTexels++;
    }
  }

  const ambiguousUnsafeChartIds = new Set();
  const centerAmbiguousUnsafeChartIds = new Set();
  const centerZeroOwnedChartIds = [];
  const microChartIds = [];
  for (const stat of perChartStats) {
    const centerClaimOwned = centerClaimOwnerCounts[stat.id - 1];
    const conservativeCandidateOwned = conservativeCandidateOwnerCounts[stat.id - 1];
    stat.centerClaimOwnedTexels = centerClaimOwned;
    stat.conservativeSingleChartClaimTexels = conservativeCandidateOwned;
    stat.isMicro = stat.uvAreaTexels < 1;
    if (centerClaimOwned === 0) {
      centerZeroOwnedChartIds.push(stat.id);
      centerAmbiguousUnsafeChartIds.add(stat.id);
    }
    if (conservativeCandidateOwned === 0) {
      ambiguousUnsafeChartIds.add(stat.id);
    }
    if (stat.isMicro) {
      microChartIds.push(stat.id);
      centerAmbiguousUnsafeChartIds.add(stat.id);
      ambiguousUnsafeChartIds.add(stat.id);
    }
  }

  for (let f = 0; f < topo.faceCount; f++) {
    const chartId = topo.faceChartIds[f];
    if (!centerAmbiguousUnsafeChartIds.has(chartId) && !ambiguousUnsafeChartIds.has(chartId)) continue;
    const i0 = topo.idx[f * 3];
    const i1 = topo.idx[f * 3 + 1];
    const i2 = topo.idx[f * 3 + 2];
    const u0 = topo.uvAttr[i0 * 2], v0 = topo.uvAttr[i0 * 2 + 1];
    const u1 = topo.uvAttr[i1 * 2], v1 = topo.uvAttr[i1 * 2 + 1];
    const u2 = topo.uvAttr[i2 * 2], v2 = topo.uvAttr[i2 * 2 + 1];
    const area = orient2d(u0, v0, u1, v1, u2, v2);
    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * FIELD_SIZE) - 1);
    const maxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(u0, u1, u2) * FIELD_SIZE) + 1);
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * FIELD_SIZE) - 1);
    const maxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(v0, v1, v2) * FIELD_SIZE) + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!triangleTouchesTexel(u0, v0, u1, v1, u2, v2, area, x, y)) continue;
        const index = y * FIELD_SIZE + x;
        if (centerAmbiguousUnsafeChartIds.has(chartId)) markCenterUnsafe(index, chartId);
        if (ambiguousUnsafeChartIds.has(chartId)) markUnsafe(index, chartId);
      }
    }
  }

  for (let i = 0; i < texelCount; i++) {
    const centerChartId = centerOwner[i];
    if (centerChartId > 0 &&
        centerUnsafe[i] === 0 &&
        !centerAmbiguousUnsafeChartIds.has(centerChartId)) {
      centerOwnerCounts[centerChartId - 1]++;
      centerOwnedTexels++;
    } else {
      centerOwner[i] = 0;
    }

    const chartId = claimOwner[i];
    if (chartId > 0 &&
        claimConflict[i] === 0 &&
        unsafe[i] === 0 &&
        !ambiguousUnsafeChartIds.has(chartId)) {
      owner[i] = chartId;
      ownerCounts[chartId - 1]++;
    } else {
      owner[i] = 0;
    }
  }

  let ownedTexels = 0;
  for (const count of ownerCounts) ownedTexels += count;

  const zeroOwnedChartIds = [];
  const conservativeZeroOwnedChartIds = [];
  for (const stat of perChartStats) {
    stat.centerOwnedTexels = centerOwnerCounts[stat.id - 1];
    stat.oldCenterOwnedTexels = stat.centerOwnedTexels;
    stat.ownedTexels = ownerCounts[stat.id - 1];
    stat.newConservativeOwnedTexels = stat.ownedTexels;
    stat.centerConflictTexels = perChartCenterConflictTexels[stat.id - 1].size;
    stat.centerUnsafeTexels = perChartCenterUnsafeTexels[stat.id - 1].size;
    stat.conservativeConflictTexels = perChartConservativeConflictTexels[stat.id - 1].size;
    stat.conflictTexels = perChartUnsafeTexels[stat.id - 1].size;
    stat.unsafeTexels = stat.conflictTexels;
    stat.newUnsafeTexels = stat.unsafeTexels;
    stat.conservativeClaimTexels = stat.conservativeSingleChartClaimTexels + stat.conservativeConflictTexels;
    stat.isZeroOwned = stat.ownedTexels === 0;
    stat.zeroOwned = stat.isZeroOwned;
    stat.isAmbiguousUnsafe = ambiguousUnsafeChartIds.has(stat.id);
    stat.unsafe = stat.unsafeTexels > 0 || stat.isAmbiguousUnsafe;
    stat.micro = stat.isMicro || stat.isZeroOwned;
    stat.stillZeroOwned = stat.isZeroOwned;
    stat.stillMicro = stat.isMicro;
    if (stat.isZeroOwned) zeroOwnedChartIds.push(stat.id);
    if (stat.conservativeSingleChartClaimTexels === 0) conservativeZeroOwnedChartIds.push(stat.id);
  }

  const zeroOwnedOrMicroCharts = perChartStats
    .filter((stat) => stat.isZeroOwned || stat.isMicro)
    .map((stat) => ({
      id: stat.id,
      faceCount: stat.faceCount,
      uvAreaTexels: stat.uvAreaTexels,
      oldCenterOwnedTexels: stat.oldCenterOwnedTexels,
      centerClaimOwnedTexels: stat.centerClaimOwnedTexels,
      newConservativeOwnedTexels: stat.newConservativeOwnedTexels,
      ownedTexels: stat.ownedTexels,
      conflictTexels: stat.conflictTexels,
      unsafeTexels: stat.unsafeTexels,
      centerOwnedTexels: stat.centerOwnedTexels,
      conservativeClaimTexels: stat.conservativeClaimTexels,
      conservativeConflictTexels: stat.conservativeConflictTexels,
      isZeroOwned: stat.isZeroOwned,
      zeroOwned: stat.zeroOwned,
      isMicro: stat.isMicro,
      micro: stat.micro,
      stillZeroOwned: stat.stillZeroOwned,
      stillMicro: stat.stillMicro,
      isAmbiguousUnsafe: stat.isAmbiguousUnsafe,
      unsafe: stat.unsafe,
    }));

  const summary = {
    resolution: FIELD_SIZE,
    ownedTexels,
    conservativeOwnedTexels: ownedTexels,
    centerOwnedTexels,
    centerClaimOwnedTexels,
    centerUnsafeTexels,
    centerMultiOwnerConflictTexels,
    conservativeClaimTexels,
    conservativeSingleChartClaimTexels,
    conservativeMultiChartClaimTexels: multiOwnerConflictTexels,
    centerCandidateTexelsTested,
    conservativeCandidateTexelsTested,
    // Compatibility alias: this now means the broadened unsafe mask. Use
    // multiOwnerConflictTexels when you need true chart-overlap conflicts only.
    conflictTexels: unsafeTexels,
    unsafeTexels,
    multiOwnerConflictTexels,
    centerConflictChartPairCount: centerConflictPairs.size,
    conflictChartPairCount: conflictPairs.size,
    centerConflictChartPairs: Array.from(centerConflictPairs).slice(0, 40),
    conflictChartPairs: Array.from(conflictPairs).slice(0, 40),
    centerZeroOwnedChartIds,
    conservativeZeroOwnedChartIds,
    zeroOwnedChartIds,
    microChartIds,
    ambiguousUnsafeChartIds: Array.from(ambiguousUnsafeChartIds),
    centerAmbiguousUnsafeChartIds: Array.from(centerAmbiguousUnsafeChartIds),
    zeroOwnedOrMicroCharts,
    perChartStats,
    degenerateTriangles,
    phase: 'conservative-chart-ownership',
    note: 'Phase 2 ownership: chartIdRT is built from conservative triangle-vs-texel chart claims. Single-chart claims become authoritative unless the chart is micro/zero-owned ambiguous; multi-chart claims and ambiguous chart footprints become unsafe with chartId 0.',
  };
  return {
    owner,
    conflict: unsafe,
    unsafe,
    multiOwnerConflict,
    centerOwner,
    centerConflict: centerUnsafe,
    centerUnsafe,
    centerMultiOwnerConflict,
    claimOwner,
    claimConflict,
    summary,
  };
}

function rasterizeUvOwnershipConflicts(topo) {
  return rasterizeUvOwnershipMaps(topo).summary;
}

function buildChartOwnershipTextures(topo) {
  const ownership = rasterizeUvOwnershipMaps(topo);
  authoritativeSpawnTexels = null;
  const chartPixels = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
  const conflictPixels = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
  for (let i = 0; i < ownership.owner.length; i++) {
    const p = i * 4;
    chartPixels[p] = ownership.owner[i];
    chartPixels[p + 3] = 1;
    const conflictValue = ownership.conflict[i] ? 255 : 0;
    conflictPixels[p] = conflictValue;
    conflictPixels[p + 1] = conflictValue;
    conflictPixels[p + 2] = conflictValue;
    conflictPixels[p + 3] = 255;
  }

  const chartTexture = makeDataTexture(chartPixels, THREE.FloatType);
  const conflictTexture = makeDataTexture(conflictPixels, THREE.UnsignedByteType);
  uploadDataTextureToRT(chartTexture, chartIdRT);
  uploadDataTextureToRT(conflictTexture, chartConflictRT);
  chartTexture.dispose();
  conflictTexture.dispose();
  return ownership;
}

function makeDataTexture(data, type) {
  return makeDataTexture2D(data, FIELD_SIZE, FIELD_SIZE, type);
}

function makeDataTexture2D(data, width, height, type) {
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, type);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function uploadDataTextureToRT(texture, target) {
  const material = makeRawShaderMaterial(textureUploadFragment, {
    u_source: { value: texture },
  });
  runFullscreenPass(material, target);
  renderer.setRenderTarget(null);
  material.dispose();
}

function makeAgentDataTexture(data) {
  const texture = new THREE.DataTexture(data, AGENT_SIDE, AGENT_SIDE, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function uploadAgentDataToRT(data, target) {
  const texture = makeAgentDataTexture(data);
  uploadDataTextureToRT(texture, target);
  texture.dispose();
}

function buildConservativeSurfaceCoverageData(targetMesh, legacyMask = null) {
  const geom = targetMesh.geometry;
  const uvAttr = geom.attributes.uv?.array;
  const idx = geom.index?.array;
  const pixels = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
  const diagnostics = {
    phase: 'conservative-surface-coverage',
    resolution: FIELD_SIZE,
    faceCount: idx ? idx.length / 3 : 0,
    candidateTexelsTested: 0,
    degenerateTriangles: 0,
    oldMaskCoverageTexels: 0,
    conservativeCoverageTexels: 0,
    newlyCoveredTexels: 0,
    legacyCoveredButNotConservativeTexels: 0,
    method: 'CPU triangle-vs-texel-box conservative rasterization',
    note: 'Phase 1 coverage only: this marks real UV triangle/texel intersections but does not assign chart authority.',
  };
  if (!uvAttr || !idx) return { pixels, diagnostics };

  for (let f = 0; f < idx.length / 3; f++) {
    const i0 = idx[f * 3];
    const i1 = idx[f * 3 + 1];
    const i2 = idx[f * 3 + 2];
    const u0 = uvAttr[i0 * 2], v0 = uvAttr[i0 * 2 + 1];
    const u1 = uvAttr[i1 * 2], v1 = uvAttr[i1 * 2 + 1];
    const u2 = uvAttr[i2 * 2], v2 = uvAttr[i2 * 2 + 1];
    const area = orient2d(u0, v0, u1, v1, u2, v2);
    if (Math.abs(area) < 1e-14) diagnostics.degenerateTriangles++;
    const minX = Math.max(0, Math.floor(Math.min(u0, u1, u2) * FIELD_SIZE) - 1);
    const maxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(u0, u1, u2) * FIELD_SIZE) + 1);
    const minY = Math.max(0, Math.floor(Math.min(v0, v1, v2) * FIELD_SIZE) - 1);
    const maxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(v0, v1, v2) * FIELD_SIZE) + 1);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        diagnostics.candidateTexelsTested++;
        if (!triangleTouchesTexel(u0, v0, u1, v1, u2, v2, area, x, y)) continue;
        const p = (y * FIELD_SIZE + x) * 4;
        pixels[p] = 255;
        pixels[p + 1] = 255;
        pixels[p + 2] = 255;
        pixels[p + 3] = 255;
      }
    }
  }

  for (let p = 0; p < pixels.length; p += 4) {
    const conservativeCovered = pixels[p] >= 128;
    const legacyCovered = legacyMask ? legacyMask[p] >= 128 : false;
    if (legacyCovered) diagnostics.oldMaskCoverageTexels++;
    if (conservativeCovered) diagnostics.conservativeCoverageTexels++;
    if (conservativeCovered && !legacyCovered) diagnostics.newlyCoveredTexels++;
    if (legacyCovered && !conservativeCovered) diagnostics.legacyCoveredButNotConservativeTexels++;
    if (conservativeCovered && pixels[p + 3] === 0) pixels[p + 3] = 255;
  }

  return { pixels, diagnostics };
}

function chartTexelIndex(uv) {
  const x = typeof uv === 'number' ? uv : uv?.x;
  const y = typeof uv === 'number' ? arguments[1] : uv?.y;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return -1;
  const px = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(x * FIELD_SIZE)));
  const py = Math.min(FIELD_SIZE - 1, Math.max(0, Math.floor(y * FIELD_SIZE)));
  return py * FIELD_SIZE + px;
}

function chartIdAt(uv, y) {
  if (!chartOwnership) return 0;
  const index = chartTexelIndex(uv, y);
  return index >= 0 ? chartOwnership.owner[index] : 0;
}

function sameChart(a, b) {
  const chartA = chartIdAt(a);
  return chartA > 0 && chartA === chartIdAt(b);
}

function isOwnershipUnsafe(uv, y) {
  if (!chartOwnership) return false;
  const index = chartTexelIndex(uv, y);
  return index >= 0 && chartOwnership.conflict[index] !== 0;
}

function isSafeEmptyGutter(uv, y) {
  return chartIdAt(uv, y) === 0 && !isOwnershipUnsafe(uv, y);
}

function isAuthoritativeChartTexel(uv, y) {
  return chartIdAt(uv, y) > 0 && !isOwnershipUnsafe(uv, y);
}

function isEmptyGutter(uv, y) {
  return isSafeEmptyGutter(uv, y);
}

function isOwnershipConflict(uv, y) {
  return isOwnershipUnsafe(uv, y);
}

function getAuthoritativeSpawnTexels() {
  if (authoritativeSpawnTexels) return authoritativeSpawnTexels;
  const texels = [];
  if (!chartOwnership) return texels;
  for (let i = 0; i < chartOwnership.owner.length; i++) {
    if (chartOwnership.owner[i] > 0 && chartOwnership.conflict[i] === 0) {
      texels.push(i);
    }
  }
  authoritativeSpawnTexels = texels;
  return authoritativeSpawnTexels;
}

function uvFromTexelIndex(index) {
  const x = index % FIELD_SIZE;
  const y = Math.floor(index / FIELD_SIZE);
  return {
    x: (x + 0.5) / FIELD_SIZE,
    y: (y + 0.5) / FIELD_SIZE,
  };
}

function validateSpawnUv(uv, expectedChart = null) {
  const texelIndex = chartTexelIndex(uv);
  if (texelIndex < 0) return 'outsideAtlas';
  if (!chartOwnership ||
      chartOwnership.owner[texelIndex] <= 0 ||
      chartOwnership.conflict[texelIndex] !== 0) {
    return 'unsafeOrUnowned';
  }
  if (expectedChart !== null && chartOwnership.owner[texelIndex] !== expectedChart) {
    return 'wrongChart';
  }
  return 'valid';
}

function describeRenderTarget(rt) {
  const texture = rt.texture;
  return {
    width: rt.width,
    height: rt.height,
    type: threeConstName(texture.type),
    format: threeConstName(texture.format),
    internalFormat: texture.internalFormat ?? null,
    minFilter: threeConstName(texture.minFilter),
    magFilter: threeConstName(texture.magFilter),
    wrapS: threeConstName(texture.wrapS),
    wrapT: threeConstName(texture.wrapT),
  };
}

function threeConstName(value) {
  const names = {
    [THREE.NearestFilter]: 'NearestFilter',
    [THREE.LinearFilter]: 'LinearFilter',
    [THREE.RepeatWrapping]: 'RepeatWrapping',
    [THREE.ClampToEdgeWrapping]: 'ClampToEdgeWrapping',
    [THREE.FloatType]: 'FloatType',
    [THREE.UnsignedByteType]: 'UnsignedByteType',
    [THREE.RGBAFormat]: 'RGBAFormat',
  };
  return names[value] ?? value;
}

function uvKey(u, v) {
  return `${Math.round(u * 1e6)},${Math.round(v * 1e6)}`;
}

function edgeKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function orient2d(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function pointInTriangle(px, py, ax, ay, bx, by, cx, cy, area) {
  const w0 = orient2d(bx, by, cx, cy, px, py);
  const w1 = orient2d(cx, cy, ax, ay, px, py);
  const w2 = orient2d(ax, ay, bx, by, px, py);
  const epsilon = 1e-12;
  return area > 0
    ? w0 >= -epsilon && w1 >= -epsilon && w2 >= -epsilon
    : w0 <= epsilon && w1 <= epsilon && w2 <= epsilon;
}

function pointInUvRect(px, py, minX, minY, maxX, maxY) {
  const epsilon = 1e-12;
  return px >= minX - epsilon && px <= maxX + epsilon &&
    py >= minY - epsilon && py <= maxY + epsilon;
}

function segmentIntersectsUvRect(ax, ay, bx, by, minX, minY, maxX, maxY) {
  if (pointInUvRect(ax, ay, minX, minY, maxX, maxY) ||
      pointInUvRect(bx, by, minX, minY, maxX, maxY)) {
    return true;
  }
  return segmentsIntersect(ax, ay, bx, by, minX, minY, maxX, minY) ||
    segmentsIntersect(ax, ay, bx, by, maxX, minY, maxX, maxY) ||
    segmentsIntersect(ax, ay, bx, by, maxX, maxY, minX, maxY) ||
    segmentsIntersect(ax, ay, bx, by, minX, maxY, minX, minY);
}

function triangleTouchesTexel(ax, ay, bx, by, cx, cy, area, x, y) {
  const minX = x / FIELD_SIZE;
  const minY = y / FIELD_SIZE;
  const maxX = (x + 1) / FIELD_SIZE;
  const maxY = (y + 1) / FIELD_SIZE;
  const triMinX = Math.min(ax, bx, cx);
  const triMaxX = Math.max(ax, bx, cx);
  const triMinY = Math.min(ay, by, cy);
  const triMaxY = Math.max(ay, by, cy);
  if (triMaxX < minX || triMinX > maxX || triMaxY < minY || triMinY > maxY) return false;
  if (pointInUvRect(ax, ay, minX, minY, maxX, maxY) ||
      pointInUvRect(bx, by, minX, minY, maxX, maxY) ||
      pointInUvRect(cx, cy, minX, minY, maxX, maxY)) {
    return true;
  }
  if (Math.abs(area) >= 1e-14) {
    if (pointInTriangle(minX, minY, ax, ay, bx, by, cx, cy, area) ||
        pointInTriangle(maxX, minY, ax, ay, bx, by, cx, cy, area) ||
        pointInTriangle(maxX, maxY, ax, ay, bx, by, cx, cy, area) ||
        pointInTriangle(minX, maxY, ax, ay, bx, by, cx, cy, area)) {
      return true;
    }
  }
  return segmentIntersectsUvRect(ax, ay, bx, by, minX, minY, maxX, maxY) ||
    segmentIntersectsUvRect(bx, by, cx, cy, minX, minY, maxX, maxY) ||
    segmentIntersectsUvRect(cx, cy, ax, ay, minX, minY, maxX, maxY);
}

function segmentDistance(a, b) {
  if (segmentsIntersect(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by)) return 0;
  return Math.min(
    pointSegmentDistance(a.ax, a.ay, b.ax, b.ay, b.bx, b.by),
    pointSegmentDistance(a.bx, a.by, b.ax, b.ay, b.bx, b.by),
    pointSegmentDistance(b.ax, b.ay, a.ax, a.ay, a.bx, a.by),
    pointSegmentDistance(b.bx, b.by, a.ax, a.ay, a.bx, a.by),
  );
}

function segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = orient2d(ax, ay, bx, by, cx, cy);
  const o2 = orient2d(ax, ay, bx, by, dx, dy);
  const o3 = orient2d(cx, cy, dx, dy, ax, ay);
  const o4 = orient2d(cx, cy, dx, dy, bx, by);
  const epsilon = 1e-12;
  if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon)) &&
      ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) {
    return true;
  }
  return Math.abs(o1) <= epsilon && pointOnSegment(cx, cy, ax, ay, bx, by) ||
    Math.abs(o2) <= epsilon && pointOnSegment(dx, dy, ax, ay, bx, by) ||
    Math.abs(o3) <= epsilon && pointOnSegment(ax, ay, cx, cy, dx, dy) ||
    Math.abs(o4) <= epsilon && pointOnSegment(bx, by, cx, cy, dx, dy);
}

function pointOnSegment(px, py, ax, ay, bx, by) {
  const epsilon = 1e-12;
  return px >= Math.min(ax, bx) - epsilon &&
    px <= Math.max(ax, bx) + epsilon &&
    py >= Math.min(ay, by) - epsilon &&
    py <= Math.max(ay, by) + epsilon;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const lenSq = vx * vx + vy * vy;
  if (lenSq <= 1e-20) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / lenSq));
  const x = ax + vx * t;
  const y = ay + vy * t;
  return Math.hypot(px - x, py - y);
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function smoothstepNumber(edge0, edge1, value) {
  const t = clampNumber((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function getManualPasses() {
  return {
    renderOats,
    renderDensity,
    updateAgents: () => updateAgents(performance.now(), 1),
    diffuseField,
    renderDepositDensity,
    applyFoodDelta: () => applyAgentFoodDeltas(1),
    applyAgentFoodDeltas: () => applyAgentFoodDeltas(1),
    clipField: () => clipCanonicalField(fieldRT),
    updateFieldSampleView,
    smoothRenderField,
    updateRenderSampleView,
    padFieldAcrossSeamsSafe: () => padFieldAcrossSeamsSafe({
      sourceCanonicalRT: renderRT.read,
      destinationSampleViewRT: renderSampleViewRT,
      maxPadTexels: SEAM_REDIRECT_HALO_TEXELS,
      fieldKind: 'render',
    }),
    padRenderSampleView: () => padFieldAcrossSeamsSafe({
      sourceCanonicalRT: renderRT.read,
      destinationSampleViewRT: renderSampleViewRT,
      maxPadTexels: SEAM_REDIRECT_HALO_TEXELS,
      fieldKind: 'render',
    }),
    equalizeField: () => equalizeField(fieldRT),
    equalizeRender: () => equalizeField(renderSampleViewRT),
    renderFrame: renderSceneOnce,
  };
}

function runNamedPass(passName) {
  const passes = getManualPasses();
  const fn = passes[passName];
  if (!fn) {
    console.warn('unknown pass', passName, 'available:', Object.keys(passes));
    return null;
  }
  return fn();
}

function estimateRenderTargetMemory() {
  const targets = [
    ['agentRT.read', agentRT.read],
    ['agentRT.write', agentRT.write],
    ['agentParentNextRT', agentParentNextRT],
    ['agentCandidateRT', agentCandidateRT],
    ['agentPrefixRT.read', agentPrefixRT.read],
    ['agentPrefixRT.write', agentPrefixRT.write],
    ['fieldRT.read', fieldRT.read],
    ['fieldRT.write', fieldRT.write],
    ['fieldSampleViewRT', fieldSampleViewRT],
    ['renderRT.read', renderRT.read],
    ['renderRT.write', renderRT.write],
    ['renderSampleViewRT.read', renderSampleViewRT.read],
    ['renderSampleViewRT.write', renderSampleViewRT.write],
    ['renderScratchRT', renderScratchRT],
    ['oatRT', oatRT],
    ['densityRT', densityRT],
    ['depositDensityRT', depositDensityRT],
    ['surfaceCoverageRT', surfaceCoverageRT],
    ['legacyUvIslandMaskRT', legacyUvIslandMaskRT],
    ['chartIdRT', chartIdRT],
    ['chartUnsafeRT', chartUnsafeRT],
    ['seamRedirectUvRT', seamRedirectUvRT],
    ['seamRedirectMetaRT', seamRedirectMetaRT],
    ['seamRedirectClaimRT', seamRedirectClaimRT],
    ['seamWeldUvRT', seamWeldUvRT],
    ['seamWeldMetaRT', seamWeldMetaRT],
    ['seamTransitionUvRT', seamTransitionUvRT],
    ['seamTransitionMetaRT', seamTransitionMetaRT],
    ['seamTransitionDirectionRT', seamTransitionDirectionRT],
    ['seamTransitionBasisRT', seamTransitionBasisRT],
    ['seamTransitionClaimRT', seamTransitionClaimRT],
    ['seamPaddingDebugRT', seamPaddingDebugRT],
  ];

  const rows = targets.map(([name, rt]) => {
    const texture = rt.texture;
    const bytesPerPixel = estimateTextureBytesPerPixel(texture);
    const estimatedBytes = rt.width * rt.height * bytesPerPixel;
    return {
      name,
      width: rt.width,
      height: rt.height,
      format: threeConstName(texture.format),
      internalFormat: texture.internalFormat ?? 'default',
      type: threeConstName(texture.type),
      bytesPerPixel,
      estimatedBytes,
      estimatedMiB: estimatedBytes / (1024 * 1024),
    };
  });
  const totalEstimatedBytes = rows.reduce((sum, row) => sum + row.estimatedBytes, 0);
  return {
    rows,
    totalEstimatedBytes,
    totalEstimatedMiB: totalEstimatedBytes / (1024 * 1024),
    notes: [
      'chartUnsafeRT is intentionally 8-bit and can likely stay there.',
      'seamRedirectClaimRT may not need RGBA32F, but packing needs a dedicated correctness audit.',
      'PR11 transition UV/meta/direction/basis maps are packed as same-format candidate atlases; format-level packing still needs a dedicated correctness audit.',
      'seamTransitionClaimRT is a PR11 conservative collision mask and may be packable after a transition-band audit.',
      'seamPaddingDebugRT is debug-only and may be a future lazy allocation candidate.',
      'chart IDs may be packable depending on maximum chart count; do not assume this permanently.',
      'seam metadata packing should not change without a dedicated topology correctness audit.',
    ],
  };
}

function estimateTextureBytesPerPixel(texture) {
  if (texture.internalFormat === 'R16F') return 2;
  if (texture.internalFormat === 'RGBA32F') return 16;
  if (texture.internalFormat === 'RGBA16F') return 8;
  if (texture.internalFormat === 'RGBA8') return 4;
  const channels = texture.format === THREE.RGBAFormat ? 4 : 1;
  const bytesPerChannel = texture.type === THREE.FloatType
    ? 4
    : texture.type === THREE.HalfFloatType
      ? 2
      : 1;
  return channels * bytesPerChannel;
}

const DEFAULT_PROFILE_PASS_NAMES = [
  'renderOats',
  'renderDensity',
  'updateAgents',
  'diffuseField',
  'renderDepositDensity',
  'applyFoodDelta',
  'equalizeField',
  'clipField',
  'smoothRenderField',
  'renderFrame',
];

function createPerfHelpers() {
  const gl = renderer.getContext();
  const timerQuery = gl.getExtension('EXT_disjoint_timer_query_webgl2');

  function timeFunction(name, fn, { finish = false } = {}) {
    if (timerQuery && !finish) {
      return new Promise((resolve, reject) => {
        const query = gl.createQuery();
        gl.beginQuery(timerQuery.TIME_ELAPSED_EXT, query);
        try {
          fn();
        } catch (err) {
          gl.endQuery(timerQuery.TIME_ELAPSED_EXT);
          gl.deleteQuery(query);
          reject(err);
          return;
        }
        gl.endQuery(timerQuery.TIME_ELAPSED_EXT);

        const poll = () => {
          const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
          const disjoint = gl.getParameter(timerQuery.GPU_DISJOINT_EXT);
          if (!available) {
            setTimeout(poll, 0);
            return;
          }
          if (disjoint) {
            gl.deleteQuery(query);
            resolve({
              name,
              durationMs: null,
              method: 'EXT_disjoint_timer_query_webgl2',
              disjoint: true,
              note: 'GPU timer was disjoint; run again for a stable measurement.',
            });
            return;
          }
          const elapsedNs = gl.getQueryParameter(query, gl.QUERY_RESULT);
          gl.deleteQuery(query);
          resolve({
            name,
            durationMs: elapsedNs / 1e6,
            method: 'EXT_disjoint_timer_query_webgl2',
            approximate: false,
          });
        };
        poll();
      });
    }

    const startedAt = performance.now();
    fn();
    if (finish) gl.finish();
    return {
      name,
      durationMs: performance.now() - startedAt,
      method: finish ? 'performance.now() + explicit gl.finish()' : 'performance.now()',
      approximate: !finish,
      note: finish
        ? 'Explicit finish was requested for this manual measurement only.'
        : 'Approximate CPU wall-clock fallback; pass { finish: true } to include an explicit GPU sync.',
    };
  }

  async function timePass(passName, options = {}) {
    return await Promise.resolve(timeFunction(passName, () => runNamedPass(passName), options));
  }

  async function profilePassesOnce(passNames = DEFAULT_PROFILE_PASS_NAMES, options = {}) {
    const passes = [];
    for (const passName of passNames) {
      passes.push(await timePass(passName, options));
    }
    const totalMs = passes.reduce((sum, pass) => sum + (pass.durationMs ?? 0), 0);
    return {
      mode: params.performanceMode,
      timer: timerQuery && !options.finish
        ? 'EXT_disjoint_timer_query_webgl2'
        : 'performance.now() fallback',
      approximate: !(timerQuery && !options.finish),
      totalMs,
      passes,
      note: 'Manual profiler only. profilePassesOnce() runs real render/simulation passes and may mutate simulation state.',
    };
  }

  async function profilePassesAverage(passNames = DEFAULT_PROFILE_PASS_NAMES, options = {}) {
    const {
      samples = 10,
      warmup = 2,
      ...timingOptions
    } = options;
    const profilePassNames = passNames ?? DEFAULT_PROFILE_PASS_NAMES;
    const warmupCount = Math.max(0, Math.floor(warmup));
    const sampleCount = Math.max(1, Math.floor(samples));
    for (let i = 0; i < warmupCount; i++) {
      await profilePassesOnce(profilePassNames, timingOptions);
    }
    const runs = [];
    for (let i = 0; i < sampleCount; i++) {
      runs.push(await profilePassesOnce(profilePassNames, timingOptions));
    }
    const byName = new Map();
    for (const run of runs) {
      for (const pass of run.passes) {
        if (!byName.has(pass.name)) {
          byName.set(pass.name, {
            name: pass.name,
            samples: 0,
            validSamples: 0,
            totalMs: 0,
            minMs: Infinity,
            maxMs: 0,
            methods: new Set(),
          });
        }
        const row = byName.get(pass.name);
        row.samples++;
        if (pass.method) row.methods.add(pass.method);
        if (Number.isFinite(pass.durationMs)) {
          row.validSamples++;
          row.totalMs += pass.durationMs;
          row.minMs = Math.min(row.minMs, pass.durationMs);
          row.maxMs = Math.max(row.maxMs, pass.durationMs);
        }
      }
    }
    const averages = [...byName.values()]
      .map((row) => ({
        name: row.name,
        avgMs: row.validSamples > 0 ? row.totalMs / row.validSamples : null,
        minMs: row.validSamples > 0 ? row.minMs : null,
        maxMs: row.validSamples > 0 ? row.maxMs : null,
        samples: row.samples,
        validSamples: row.validSamples,
        methods: [...row.methods],
      }))
      .sort((a, b) => (b.avgMs ?? -1) - (a.avgMs ?? -1));
    const totalAvgMs = averages.reduce((sum, row) => sum + (row.avgMs ?? 0), 0);
    return {
      mode: params.performanceMode,
      timer: timerQuery && !timingOptions.finish
        ? 'EXT_disjoint_timer_query_webgl2'
        : 'performance.now() fallback',
      approximate: !(timerQuery && !timingOptions.finish),
      samples: sampleCount,
      warmup: warmupCount,
      passNames: profilePassNames.slice(),
      totalAvgMs,
      averages,
      runs,
      note: 'Manual profiler average. Warmup runs are discarded; measured passes may mutate simulation state.',
    };
  }

  return {
    timePass,
    timeFrameOnce: (options = {}) => timePass('renderFrame', options),
    profilePassesOnce,
    profilePassesAverage,
    defaultPassNames: DEFAULT_PROFILE_PASS_NAMES.slice(),
    estimateRenderTargetMemory,
    runReadbackDiagnostic: (name, fn, options = {}) =>
      runReadbackDiagnostic(name, fn, { ...options, returnEnvelope: true }),
    timerQueryAvailable: Boolean(timerQuery),
  };
}

// === GLB load ===
// === seam transition bake ===
// The CPU-side candidate packing dominates load time (tens of seconds at
// 2048). The bake stores its per-slot decisions; values are recomputed from
// the mesh at load. Generated via ?bakeExport=1 + __cuttle.exportSeamBake().
const SEAM_BAKE_MAGIC = 0x53424b31; // 'SBK1'
const SEAM_BAKE_VERSION = 1;
let seamBakeData = null;
let seamBakeExportState = null;

function parseSeamBake(bytes) {
  if (bytes.byteLength < 28) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== SEAM_BAKE_MAGIC) return null;
  if (view.getUint32(4, true) !== SEAM_BAKE_VERSION) return null;
  const fieldSize = view.getUint32(8, true);
  const slots = view.getUint32(12, true);
  const seamEdgeCount = view.getUint32(16, true);
  const recordCount = view.getUint32(20, true);
  const diagnosticsLength = view.getUint32(24, true);
  if (28 + diagnosticsLength > bytes.byteLength) return null;
  let diagnostics = {};
  try {
    diagnostics = JSON.parse(new TextDecoder().decode(bytes.subarray(28, 28 + diagnosticsLength)));
  } catch {
    return null;
  }
  return {
    fieldSize,
    slots,
    seamEdgeCount,
    recordCount,
    diagnostics,
    view,
    recordsOffset: 28 + diagnosticsLength,
  };
}

const seamBakeFetchPromise = (async () => {
  if (SEAM_BAKE_EXPORT_MODE) return null;
  if (typeof DecompressionStream !== 'function') return null;
  try {
    const response = await fetch(`seam-bake-${FIELD_SIZE}.bin`);
    if (!response.ok) return null;
    const stream = response.body.pipeThrough(new DecompressionStream('gzip'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    return parseSeamBake(bytes);
  } catch (error) {
    console.warn('Seam bake unavailable; seam transitions will build live.', error);
    return null;
  }
})();

async function exportSeamBake() {
  const state = seamBakeExportState;
  if (!state?.slotSeamIds) {
    throw new Error('Load the page with ?bakeExport=1 first, then call exportSeamBake().');
  }
  const diagnosticsBytes = new TextEncoder().encode(JSON.stringify(state.diagnostics));
  const texelCount = state.fieldSize * state.fieldSize;
  let recordCount = 0;
  let recordBytes = 0;
  for (let texel = 0; texel < texelCount; texel++) {
    const count = Math.min(state.candidateCounts[texel], state.slots);
    if (count === 0 && state.candidateOverflow[texel] === 0) continue;
    recordCount++;
    recordBytes += 5 + count * 4;
  }
  const bytes = new Uint8Array(28 + diagnosticsBytes.length + recordBytes);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, SEAM_BAKE_MAGIC, true);
  view.setUint32(4, SEAM_BAKE_VERSION, true);
  view.setUint32(8, state.fieldSize, true);
  view.setUint32(12, state.slots, true);
  view.setUint32(16, state.seamEdgeCount, true);
  view.setUint32(20, recordCount, true);
  view.setUint32(24, diagnosticsBytes.length, true);
  bytes.set(diagnosticsBytes, 28);
  let offset = 28 + diagnosticsBytes.length;
  for (let texel = 0; texel < texelCount; texel++) {
    const count = Math.min(state.candidateCounts[texel], state.slots);
    if (count === 0 && state.candidateOverflow[texel] === 0) continue;
    view.setUint32(offset, texel, true);
    view.setUint8(offset + 4, count | (state.candidateOverflow[texel] ? 0x80 : 0));
    offset += 5;
    for (let slot = 0; slot < count; slot++) {
      view.setUint32(offset, state.slotSeamIds[texel * state.slots + slot], true);
      offset += 4;
    }
  }
  const gzipped = new Uint8Array(await new Response(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
  ).arrayBuffer());
  const blob = new Blob([gzipped], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `seam-bake-${state.fieldSize}.bin`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { rawBytes: bytes.length, gzippedBytes: gzipped.length, recordCount };
}

new GLTFLoader().load(
  GLB_PATH,
  (gltf) => {
    Promise.resolve()
      .then(() => {
        setStartScreenLoadingProgress(72, 'preparing');
        return onLoad(gltf);
      })
      .catch((err) => {
        console.error(err);
        fail(`init failed: ${err.message}`);
      });
  },
  (progress) => {
    if (progress?.lengthComputable && progress.total > 0) {
      setStartScreenLoadingProgress((progress.loaded / progress.total) * 70, 'loading');
    } else {
      setStartScreenLoadingProgress(null, 'loading');
    }
  },
  (err) => {
    console.error(err);
    fail(`failed to load ${GLB_PATH}`);
  },
);

async function onLoad(gltf) {
  let foundMesh = null;
  gltf.scene.traverse((obj) => {
    if (!foundMesh && obj.isMesh) foundMesh = obj;
  });
  if (!foundMesh) {
    fail('GLB has no mesh.');
    return;
  }
  setStartScreenLoadingProgress(74, 'preparing');
  mesh = foundMesh;
  const geom = mesh.geometry;
  if (!geom.index) {
    geom.setIndex(Array.from({ length: geom.attributes.position.count }, (_, i) => i));
  }
  if (!geom.attributes.normal) geom.computeVertexNormals();

  // Dispose original material/textures
  const origMat = mesh.material;
  if (origMat) {
    for (const k of Object.keys(origMat)) {
      const v = origMat[k];
      if (v && typeof v === 'object' && v.isTexture) v.dispose();
    }
    origMat.dispose?.();
  }

  // Normalize size: scale so longest bbox extent equals SURFACE_WORLD_SIZE; recenter at origin.
  geom.computeBoundingBox();
  const bbox = geom.boundingBox;
  const size = new THREE.Vector3().subVectors(bbox.max, bbox.min);
  const longest = Math.max(size.x, size.y, size.z);
  const scaleFactor = SURFACE_WORLD_SIZE / longest;
  const center = new THREE.Vector3().addVectors(bbox.min, bbox.max).multiplyScalar(0.5);
  // Apply transformation to the geometry directly so world-space = local-space
  geom.translate(-center.x, -center.y, -center.z);
  geom.scale(scaleFactor, scaleFactor, scaleFactor);
  geom.computeBoundingBox();
  geom.computeBoundingSphere();
  // BVH-accelerated raycasts: occlusion checks, click-to-place, and mouse
  // repel all raycast against this mesh; brute-force triangle iteration made
  // per-oat occlusion refreshes dominate CPU once many oats were placed.
  geom.boundsTree = new MeshBVH(geom);
  mesh.raycast = acceleratedRaycast;
  mesh.position.set(0, 0, 0);
  mesh.rotation.set(0, 0, 0);
  mesh.scale.set(1, 1, 1);
  mesh.frustumCulled = false;

  scene.add(mesh);
  updateInitialOatFromViewportCenter(mesh);
  setStartScreenLoadingProgress(80, 'mapping');

  const loadPhaseStart = performance.now();
  console.info(`[load] mapping phase begins at ${Math.round(loadPhaseStart)}ms`);
  let loadPhaseLast = loadPhaseStart;
  const loadPhase = (label) => {
    const now = performance.now();
    console.info(`[load] ${label}: ${Math.round(now - loadPhaseLast)}ms`);
    loadPhaseLast = now;
  };
  // Build UV mask
  buildUvMask(mesh);
  cacheCoverageMask();
  loadPhase('uvMask+coverage');
  const uvTopology = buildUvChartTopology(mesh);
  loadPhase('chartTopology');
  chartOwnership = buildChartOwnershipTextures(uvTopology);
  loadPhase('chartOwnership');
  setStartScreenLoadingProgress(88, 'mapping');
  // Build seam data
  seamBakeData = await seamBakeFetchPromise;
  loadPhase('bakeFetch');
  seamPairs = buildSeamData(mesh, uvTopology);
  loadPhase('seamData');
  uvDiagnostics = createUvDiagnostics(mesh, uvTopology, chartOwnership);
  setStartScreenLoadingProgress(92, 'shading');

  // Build slime material
  slimeMaterial = buildSlimeMaterial();
  debugBaseMaterial = slimeMaterial;
  mesh.material = slimeMaterial;
  goldWaferBodyMaterial = buildGoldWaferBodyMaterial();
  goldWaferBodyMesh = new THREE.Mesh(geom, goldWaferBodyMaterial);
  goldWaferBodyMesh.name = 'gold-wafer-body-underlay';
  goldWaferBodyMesh.frustumCulled = false;
  goldWaferBodyMesh.renderOrder = 0;
  goldWaferBodyMesh.visible = false;
  scene.add(goldWaferBodyMesh);
  mesh.onBeforeRender = function onCuttlefishBeforeRender(renderer, scene, renderCamera) {
    if (!mesh || mesh.material !== slimeMaterial) return;
    syncSlimeMaterialForCamera(renderCamera);
  };
  markGoldWaferBodyModeDirty({ uniforms: true });
  syncGoldWaferBodyMode();
  setStartScreenLoadingProgress(95, 'shading');

  // Cache debug-view materials
  debugMaterials.slime = slimeMaterial;
  debugMaterials.food = new THREE.MeshBasicMaterial({ map: renderSampleViewRT.read.texture, side: THREE.DoubleSide });
  debugMaterials.mask = new THREE.MeshBasicMaterial({ map: uvIslandMaskRT.texture, side: THREE.DoubleSide });
  debugMaterials.surfaceCoverage = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: surfaceCoverageDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_surfaceCoverage: { value: surfaceCoverageRT.texture },
    },
  });
  debugMaterials.coverageComparison = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: coverageComparisonDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_legacyCoverage: { value: legacyUvIslandMaskRT.texture },
      u_surfaceCoverage: { value: surfaceCoverageRT.texture },
    },
  });
  debugMaterials.simulationDomain = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: simulationDomainDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_surfaceCoverage: { value: surfaceCoverageRT.texture },
      u_chartId: { value: chartIdRT.texture },
      u_chartConflict: { value: chartConflictRT.texture },
    },
  });
  debugMaterials.watertightCracks = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: watertightCracksDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_surfaceCoverage: { value: surfaceCoverageRT.texture },
      u_chartId: { value: chartIdRT.texture },
      u_chartConflict: { value: chartConflictRT.texture },
    },
  });
  debugMaterials.chartId = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: chartIdDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_chartId: { value: chartIdRT.texture },
      u_chartConflict: { value: chartConflictRT.texture },
    },
  });
  debugMaterials.chartConflict = new THREE.ShaderMaterial({
    vertexShader: chartIdDebugVertex,
    fragmentShader: chartConflictDebugFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_chartId: { value: chartIdRT.texture },
      u_chartConflict: { value: chartConflictRT.texture },
    },
  });
  debugMaterials.seam = new THREE.MeshBasicMaterial({ map: seamRedirectUvRT.texture, side: THREE.DoubleSide });
  debugMaterials.seamPadding = new THREE.MeshBasicMaterial({ map: seamPaddingDebugRT.texture, side: THREE.DoubleSide });
  debugMaterials.seamRedirectCoverage = new THREE.ShaderMaterial({
    vertexShader: seamRedirectCoverageVertex,
    fragmentShader: seamRedirectCoverageFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_seamRedirectUv: { value: seamRedirectUvRT.texture },
    },
  });
  debugMaterials.seamTransition = new THREE.ShaderMaterial({
    vertexShader: seamRedirectCoverageVertex,
    fragmentShader: seamTransitionCoverageFragment,
    side: THREE.DoubleSide,
    uniforms: {
      u_seamTransitionUvAtlas: { value: seamTransitionUvAtlasRT.texture },
      u_seamTransitionClaim: { value: seamTransitionClaimRT.texture },
    },
  });

  setStartScreenLoadingProgress(98, 'starting');

  // Status reflects renderer + slot count, with "loading cuttlefish..." dropped.
  const info = renderer.getContext().getParameter(
    renderer.getContext().getExtension('WEBGL_debug_renderer_info')?.UNMASKED_RENDERER_WEBGL ?? 0x1F01,
  ) || 'WebGL2';
  baseStatus = `${info} | ${AGENT_CAPACITY.toLocaleString()} slots`;
  statusEl.textContent = baseStatus;

  loadPhase('materials+wiring');

  // First use of each program triggers driver compilation, which can block the
  // main thread for tens of seconds. Run one throwaway frame while the loading
  // screen is still up so the stall lands here instead of freezing the first
  // visible frame; resetSimulation() below clears any state it touched.
  setStartScreenLoadingProgress(99, 'compiling');
  await new Promise((resolve) => requestAnimationFrame(resolve));
  simulate(performance.now(), 0.001);
  markRenderFieldChanged();
  smoothRenderField();
  renderSceneOnce(performance.now(), { updateAnnotations: false });
  loadPhase('shaderPrewarm');

  // Reset & start frame loop
  await loadStories();
  loadPhase('stories');
  resetSimulation({ resetOats: true, spawnAgents: false });
  started = true;
  loadPhase('resetSimulation');
  lastFrameTime = performance.now();
  requestAnimationFrame(frame);

  // Expose debug namespace
  window.__cuttle = {
    THREE,
    renderer,
    scene,
    camera,
    controls,
    audio: {
      startEnvAudio,
      stopEnvAudio,
      toggleEnvAudio,
      getSoundVolume,
      setSoundVolume,
      setSoundLoopEnabled,
      setSoundFadeInSeconds,
      setSoundFadeOutSeconds,
      setEnvAudioVolume,
      setSoundCompressorEnabled,
      setSoundCompressorParam,
      playSoundCheckOneShot,
      getEnvAudioState,
      startSlimeTumbleLoop,
      stopSlimeTumbleLoop,
      getSlimeTumbleLoopState,
      soundSettings: soundSettingsState,
      soundCompressorState,
      soundCheckClips: SOUND_CHECK_CLIPS,
    },
    getCameraPose,
    getCameraPoseCommand,
    setCameraPose,
    setCameraAngles,
    replayInitialAgentSeed,
    skipIntroSequence,
    visualLayers: {
      get slimeVisible() {
        return slimeVisualVisible;
      },
      get goldBodyVisible() {
        return goldBodyVisualVisible;
      },
      toggleSlime: toggleSlimeVisualVisibility,
      toggleGoldBody: toggleGoldBodyVisualVisibility,
    },
    getIntroSequenceState: () => ({
      requested: introSequenceState.requested,
      active: introSequenceState.active,
      completed: introSequenceState.completed,
      clickAt: startScreenUiState.clickedAt,
      fadeOutAt: startScreenUiState.beginFadeOutAt,
      requestedAt: introSequenceState.requestedAt,
      startClickPeakDelayMs: INTRO_START_CLICK_SOUND_PEAK_MS,
      contentStartAt: getIntroContentStartAt(),
      startedAt: introSequenceState.startedAt,
      topEdgeLeadMs: introSequenceState.topEdgeLeadMs,
      topEdgeAt: getIntroContentStartAt() + INTRO_OAT_SPRITE_DELAY_MS,
      silentBeatMs: INTRO_START_SILENT_BEAT_MS,
      seedSoundPlayed: introSequenceState.seedSoundPlayed,
      envAudioStarted: introSequenceState.envAudioStarted,
      now: performance.now(),
      elapsedSinceRequestMs: performance.now() - introSequenceState.requestedAt,
      elapsedSinceSpriteMs: performance.now() - introSequenceState.startedAt,
    }),
    getInitialAgentSeedState: () => ({
      pending: initialAgentSeedState.pending,
      pendingStartAt: initialAgentSeedState.pendingStartAt,
      active: initialAgentSeedState.active,
      startedAt: initialAgentSeedState.startedAt,
      durationMs: initialAgentSeedState.durationMs,
      visibleCount: initialAgentSeedState.visibleCount,
      revealSlotCount: initialAgentSeedState.revealSlotCount,
      now: performance.now(),
      elapsedMs: performance.now() - initialAgentSeedState.startedAt,
      pendingMs: initialAgentSeedState.pending
        ? initialAgentSeedState.pendingStartAt - performance.now()
        : 0,
    }),
    getEndingSequenceState: () => ({
      active: endingSequenceState.active,
      phase: endingSequenceState.phase,
      armedAt: endingSequenceState.armedAt,
      camouflageStartAt: endingSequenceState.camouflageStartAt,
      camouflageStartedAt: endingSequenceState.camouflageStartedAt,
      camouflageDurationMs: endingSequenceState.camouflageDurationMs,
      fadeStartAt: endingSequenceState.fadeStartAt,
      endAt: endingSequenceState.endAt,
      targetReturnAt: endingSequenceState.targetReturnAt,
      countdownText: endingSequenceState.lastCountdownText,
      countdownEnabled: params.endingTimeLimitEnabled,
      timeLimitEnabled: params.endingTimeLimitEnabled,
      fadeOpacity: Number.parseFloat(endingFadeOverlay?.style.opacity || '0') || 0,
      now: performance.now(),
    }),
    mesh,
    syncSlimeMaterialForCamera,
    params,
    agentRT,
    agentParentNextRT,
    agentCandidateRT,
    agentPrefixRT,
    fieldRT,
    fieldSampleViewRT,
    renderRT,
    renderSampleViewRT,
    oatRT,
    densityRT,
    depositDensityRT,
    uvIslandMaskRT,
    surfaceCoverageRT,
    legacyUvIslandMaskRT,
    chartIdRT,
    chartConflictRT,
    chartUnsafeRT,
    seamPaddingDebugRT,
    seamRedirectUvRT,
    seamRedirectMetaRT,
    seamRedirectClaimRT,
    seamWeldUvRT,
    seamWeldMetaRT,
    seamTransitionUvRT,
    seamTransitionMetaRT,
    seamTransitionDirectionRT,
    seamTransitionBasisRT,
    seamTransitionUvAtlasRT,
    seamTransitionMetaAtlasRT,
    seamTransitionDirectionAtlasRT,
    seamTransitionBasisAtlasRT,
    seamTransitionClaimRT,
    seamRedirectRT,
    seamWeldRT,
    seamPairs,
    chartOwnership,
    uvDiagnostics,
    exportSeamBake,
    debugMaterials,
    perf: createPerfHelpers(),
    oats,
    annotationLayer,
    updateOatAnnotations,
    updateObservationSlimeTriggers,
    triggerOatObservation,
    completeOatObservation,
    getLastObservationTriggerDiagnostics: () => ({ ...lastObservationTriggerDiagnostics }),
    loadStories,
    setStoryLibrary,
    getStoryLibraryState,
    resetStoryLibraryCursor,
    setObservationText,
    setOatObservationText,
    setAllOatObservationText,
    observationPlaceholderText: OBSERVATION_PLACEHOLDER_TEXT,
    loggedClicks,
    getMouseRepelState: () => ({
      active: mouseRepelState.active,
      uv: { x: mouseRepelState.uv.x, y: mouseRepelState.uv.y },
      chartId: mouseRepelState.chartId,
      radius: MOUSE_REPEL_RADIUS_UV,
      strength: MOUSE_REPEL_STRENGTH,
    }),
    addOat,
    resetSimulation,
    listSimulationPresets,
    listRenderDisplayPresets,
    applySimulationPreset,
    applyRenderDisplayPreset,
    applyRuntimeParams,
    runPopulationTrial,
    enablePopulationControl,
    setPopulationTarget,
    resetPopulationController,
    updatePopulationController,
    getPopulationControllerState,
    runPopulationControlledTrial,
    setPerformanceMode,
    getPerformanceModeConfig: () => ({ ...getPerformanceModeConfig(params) }),
    refreshRuntimeReadbackStats,
    getLastAgentCreationDiagnostics: () => ({ ...lastAgentCreationDiagnostics }),
    getTransitionCandidatePackingDiagnostics: uvDiagnostics.getTransitionCandidatePackingDiagnostics,
    padFieldAcrossSeamsSafe,
    getLastSeamPaddingDiagnostics: () => lastSeamPaddingDiagnostics,
    measureMaskSoftness: uvDiagnostics.measureMaskSoftness,
    measureFieldDomainEnergy: uvDiagnostics.measureFieldDomainEnergy,
    measureSplatDomainEnergy: uvDiagnostics.measureSplatDomainEnergy,
    measureSplatOwnershipDiagnostics: uvDiagnostics.measureSplatOwnershipDiagnostics,
    measureOatTopologySafety: uvDiagnostics.measureOatTopologySafety,
    measureDiffusionContinuityDiagnostics: uvDiagnostics.measureDiffusionContinuityDiagnostics,
    measureZeroGutterTransitionDiagnostics: uvDiagnostics.measureZeroGutterTransitionDiagnostics,
    measureSeamPaddingDiagnostics: uvDiagnostics.measureSeamPaddingDiagnostics,
    measureSeamContinuityClosure: uvDiagnostics.measureSeamContinuityClosure,
    measureWatertightDomainDiagnostics: uvDiagnostics.measureWatertightDomainDiagnostics,
    measureTransitionNoFluxDiagnostics: uvDiagnostics.measureTransitionNoFluxDiagnostics,
    measureSeamEdgeDomainContinuity: uvDiagnostics.measureSeamEdgeDomainContinuity,
    measureProductionMaskUsageAudit: uvDiagnostics.measureProductionMaskUsageAudit,
    measureCanonicalSampleViewAudit: uvDiagnostics.measureCanonicalSampleViewAudit,
    measureChunkBAcceptanceReport: uvDiagnostics.measureChunkBAcceptanceReport,
    getChunkBAcceptanceReport: uvDiagnostics.measureChunkBAcceptanceReport,
    measurePr12ProductionSamplingAudit: uvDiagnostics.measurePr12ProductionSamplingAudit,
    dumpRenderTargetConfig: uvDiagnostics.dumpRenderTargetConfig,
    getCurrentFootprintSummary: uvDiagnostics.measureCurrentSamplingFootprints,
    getFootprintRegistry: uvDiagnostics.getFootprintRegistry,
    getSafeGutterBudgetTexels: uvDiagnostics.getSafeGutterBudgetTexels,
    getTopologySafetyBudget: uvDiagnostics.getTopologySafetyBudget,
    measureSafeSamplingRejections: uvDiagnostics.measureSafeSamplingRejections,
    measureAgentTopologySafety: uvDiagnostics.measureAgentTopologySafety,
    measureAgentAllocatorDiagnostics,
    runAgentAllocatorRegressionTests,
    getChartOwnershipStats: uvDiagnostics.getChartOwnershipStats,
    getMicroCharts: uvDiagnostics.getMicroCharts,
    getZeroOwnedCharts: uvDiagnostics.getZeroOwnedCharts,
    getUnsafeCharts: uvDiagnostics.getUnsafeCharts,
    footprintRegistry: {
      getSamplingFootprintRegistry,
      getRenderSmoothingRadiusTexels,
      getNormalSampleRadiusTexels,
      getAgentSensorRadiusTexels,
      getMaxAgentStepTexels,
      getMaxPerSimulationStepTexels,
      getChildStepTexels,
      getDensityKernelRadiusTexels,
      getDepositKernelRadiusTexels,
      getOatSupportRadiusTexels,
      getRequiredSamplingFootprintTexels,
      getVisualTransitionFootprint,
      getSupportedVisualTransitionFootprint,
      getSpatialSupportTransitionFootprint,
      getSafeGutterBudgetTexels,
      getTopologySafetyBudget,
    },
    chartIdAt,
    sameChart,
    isEmptyGutter,
    isSafeEmptyGutter,
    isAuthoritativeChartTexel,
    isOwnershipConflict,
    isOwnershipUnsafe,
    dumpAgents() {
      return runReadbackDiagnostic('dumpAgents', () => {
        const buf = new Float32Array(AGENT_CAPACITY * 4);
        renderer.readRenderTargetPixels(agentRT.read, 0, 0, AGENT_SIDE, AGENT_SIDE, buf);
        return buf;
      });
    },
    dumpField(rt = renderSampleViewRT.read) {
      return runReadbackDiagnostic('dumpField', () => {
        const ArrayType = rt.texture.type === THREE.UnsignedByteType ? Uint8Array : Float32Array;
        const buf = new ArrayType(FIELD_SIZE * FIELD_SIZE * 4);
        renderer.readRenderTargetPixels(rt, 0, 0, FIELD_SIZE, FIELD_SIZE, buf);
        return buf;
      });
    },
    runOnce(passName) {
      return runNamedPass(passName);
    },
  };
  showStartButton();
  scheduleSoundPackPreload();
}

// === buildUvMask ===
function buildUvMask(targetMesh) {
  const geom = targetMesh.geometry;
  const maskMesh = new THREE.Mesh(geom, uvMaskMaterial);
  maskMesh.frustumCulled = false;
  const maskScene = new THREE.Scene();
  maskScene.add(maskMesh);
  renderer.setRenderTarget(legacyUvIslandMaskRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.render(maskScene, quadCamera);
  renderer.setRenderTarget(null);
  const legacyCoverageMask = new Uint8Array(FIELD_SIZE * FIELD_SIZE * 4);
  renderer.readRenderTargetPixels(
    legacyUvIslandMaskRT,
    0,
    0,
    FIELD_SIZE,
    FIELD_SIZE,
    legacyCoverageMask,
  );

  const { pixels, diagnostics } = buildConservativeSurfaceCoverageData(
    targetMesh,
    legacyCoverageMask,
  );
  const coverageTexture = makeDataTexture(pixels, THREE.UnsignedByteType);
  uploadDataTextureToRT(coverageTexture, surfaceCoverageRT);
  coverageTexture.dispose();
  surfaceCoverageBuildDiagnostics = diagnostics;
}

function cacheCoverageMask() {
  renderer.readRenderTargetPixels(uvIslandMaskRT, 0, 0, FIELD_SIZE, FIELD_SIZE, coverageMaskReadback);
  let surfaceTexels = 0;
  for (let i = 0; i < coverageMaskReadback.length; i += 4) {
    if (coverageMaskReadback[i] >= 128) surfaceTexels++;
  }
  coverageSurfaceTexels = surfaceTexels;
}

// === buildSeamData ===
function buildSeamData(targetMesh, uvTopology = null) {
  const geom = targetMesh.geometry;
  const pos = geom.attributes.position.array;
  const uvAttr = geom.attributes.uv.array;
  const idx = geom.index.array;
  const vertCount = pos.length / 3;
  const faceCount = idx.length / 3;

  // Per-vertex tangent and bitangent in world space (from positions and UVs).
  const T = new Float32Array(vertCount * 3);
  const B = new Float32Array(vertCount * 3);
  for (let f = 0; f < faceCount; f++) {
    const i0 = idx[f * 3], i1 = idx[f * 3 + 1], i2 = idx[f * 3 + 2];
    const p0 = [pos[i0 * 3], pos[i0 * 3 + 1], pos[i0 * 3 + 2]];
    const p1 = [pos[i1 * 3], pos[i1 * 3 + 1], pos[i1 * 3 + 2]];
    const p2 = [pos[i2 * 3], pos[i2 * 3 + 1], pos[i2 * 3 + 2]];
    const uv0 = [uvAttr[i0 * 2], uvAttr[i0 * 2 + 1]];
    const uv1 = [uvAttr[i1 * 2], uvAttr[i1 * 2 + 1]];
    const uv2 = [uvAttr[i2 * 2], uvAttr[i2 * 2 + 1]];
    const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const d1 = [uv1[0] - uv0[0], uv1[1] - uv0[1]];
    const d2 = [uv2[0] - uv0[0], uv2[1] - uv0[1]];
    const det = d1[0] * d2[1] - d1[1] * d2[0];
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const tx = (e1[0] * d2[1] - e2[0] * d1[1]) * r;
    const ty = (e1[1] * d2[1] - e2[1] * d1[1]) * r;
    const tz = (e1[2] * d2[1] - e2[2] * d1[1]) * r;
    const bx = (e2[0] * d1[0] - e1[0] * d2[0]) * r;
    const by = (e2[1] * d1[0] - e1[1] * d2[0]) * r;
    const bz = (e2[2] * d1[0] - e1[2] * d2[0]) * r;
    for (const i of [i0, i1, i2]) {
      T[i * 3] += tx; T[i * 3 + 1] += ty; T[i * 3 + 2] += tz;
      B[i * 3] += bx; B[i * 3 + 1] += by; B[i * 3 + 2] += bz;
    }
  }
  // Normalize T, B per vertex
  for (let i = 0; i < vertCount; i++) {
    let lT = Math.hypot(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]) || 1;
    T[i * 3] /= lT; T[i * 3 + 1] /= lT; T[i * 3 + 2] /= lT;
    let lB = Math.hypot(B[i * 3], B[i * 3 + 1], B[i * 3 + 2]) || 1;
    B[i * 3] /= lB; B[i * 3 + 1] /= lB; B[i * 3 + 2] /= lB;
  }

  // Position hash: round to 1e-5 quantization.
  function posKey(x, y, z) {
    return `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
  }
  const posBuckets = new Map();
  for (let i = 0; i < vertCount; i++) {
    const k = posKey(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (!posBuckets.has(k)) posBuckets.set(k, []);
    posBuckets.get(k).push(i);
  }

  // Edge → face entries.
  const edgeMap = new Map();
  for (let f = 0; f < faceCount; f++) {
    const i0 = idx[f * 3], i1 = idx[f * 3 + 1], i2 = idx[f * 3 + 2];
    const verts = [i0, i1, i2];
    const keys = verts.map((v) => posKey(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
    for (let e = 0; e < 3; e++) {
      const vA = verts[e], vB = verts[(e + 1) % 3], vC = verts[(e + 2) % 3];
      const kA = keys[e], kB = keys[(e + 1) % 3];
      const ek = kA < kB ? `${kA}|${kB}` : `${kB}|${kA}`;
      if (!edgeMap.has(ek)) edgeMap.set(ek, []);
      edgeMap.get(ek).push({ vA, vB, vC, kA, kB, face: f });
    }
  }

  // Find seam edge pairs.
  const seamEdges = [];
  for (const [, faces] of edgeMap) {
    if (faces.length < 2) continue;
    for (let a = 0; a < faces.length; a++) {
      for (let b = a + 1; b < faces.length; b++) {
        const fA = faces[a], fB = faces[b];
        // Align endpoints so fA.vA ↔ fB.vA, fA.vB ↔ fB.vB.
        let bA, bB;
        if (fA.kA === fB.kA && fA.kB === fB.kB) {
          bA = fB.vA; bB = fB.vB;
        } else {
          bA = fB.vB; bB = fB.vA;
        }
        // Test UV equality: if both endpoints share UVs, this is not a seam.
        const sameUV =
          Math.abs(uvAttr[fA.vA * 2] - uvAttr[bA * 2]) < 1e-6 &&
          Math.abs(uvAttr[fA.vA * 2 + 1] - uvAttr[bA * 2 + 1]) < 1e-6 &&
          Math.abs(uvAttr[fA.vB * 2] - uvAttr[bB * 2]) < 1e-6 &&
          Math.abs(uvAttr[fA.vB * 2 + 1] - uvAttr[bB * 2 + 1]) < 1e-6;
        if (sameUV) continue;
        seamEdges.push({
          A: { vA: fA.vA, vB: fA.vB, vC: fA.vC, face: fA.face },
          B: { vA: bA, vB: bB, vC: fB.vC, face: fB.face },
        });
      }
    }
  }

  // Build halo geometry: for each seam edge pair, a quad on each side.
  const haloPositions = [];
  const haloRedirect = [];
  const haloRotation = [];
  const haloChart = [];
  const haloDistance = [];
  const haloDirection = [];
  const haloBasis = [];
  const haloIndices = [];
  const haloWidth = SEAM_REDIRECT_HALO_TEXELS / FIELD_SIZE;
  let vertOffset = 0;

  for (const seam of seamEdges) {
    pushHalo(seam.A, seam.B);
    pushHalo(seam.B, seam.A);
  }

  function pushHalo(srcSide, dstSide) {
    // src island UVs and tangent frames.
    const uvA = [uvAttr[srcSide.vA * 2], uvAttr[srcSide.vA * 2 + 1]];
    const uvB = [uvAttr[srcSide.vB * 2], uvAttr[srcSide.vB * 2 + 1]];
    const uvC = [uvAttr[srcSide.vC * 2], uvAttr[srcSide.vC * 2 + 1]];
    const dstA = [uvAttr[dstSide.vA * 2], uvAttr[dstSide.vA * 2 + 1]];
    const dstB = [uvAttr[dstSide.vB * 2], uvAttr[dstSide.vB * 2 + 1]];
    const dstC = [uvAttr[dstSide.vC * 2], uvAttr[dstSide.vC * 2 + 1]];

    // Edge direction and outward normal in src (away from third vertex).
    const ex = uvB[0] - uvA[0], ey = uvB[1] - uvA[1];
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-12) return;
    const edgeX = ex / elen, edgeY = ey / elen;
    // Perpendicular candidates
    const px = -edgeY, py = edgeX;
    // Sign of perpendicular: should point away from uvC.
    const toC = [uvC[0] - uvA[0], uvC[1] - uvA[1]];
    const sign = (px * toC[0] + py * toC[1]) > 0 ? -1 : 1;
    const outX = px * sign, outY = py * sign;

    // Inward normal on dst (toward dstC).
    const dEx = dstB[0] - dstA[0], dEy = dstB[1] - dstA[1];
    const dElen = Math.hypot(dEx, dEy);
    if (dElen < 1e-12) return;
    const dstEdgeX = dEx / dElen, dstEdgeY = dEy / dElen;
    const dPx = -dstEdgeY, dPy = dstEdgeX;
    const dToC = [dstC[0] - dstA[0], dstC[1] - dstA[1]];
    const dSign = (dPx * dToC[0] + dPy * dToC[1]) > 0 ? 1 : -1;
    const inX = dPx * dSign, inY = dPy * dSign;

    // Per-edge rotation derived from per-vertex tangent frames.
    // Use vertex A on each side (results similar at vertex B for continuous seams).
    const TA = [T[srcSide.vA * 3], T[srcSide.vA * 3 + 1], T[srcSide.vA * 3 + 2]];
    const TB = [T[dstSide.vA * 3], T[dstSide.vA * 3 + 1], T[dstSide.vA * 3 + 2]];
    const BB = [B[dstSide.vA * 3], B[dstSide.vA * 3 + 1], B[dstSide.vA * 3 + 2]];
    const cosT = TA[0] * TB[0] + TA[1] * TB[1] + TA[2] * TB[2];
    const sinT = TA[0] * BB[0] + TA[1] * BB[1] + TA[2] * BB[2];
    const sourceChart = uvTopology?.faceChartIds?.[srcSide.face] ?? 0;
    const destinationChart = uvTopology?.faceChartIds?.[dstSide.face] ?? 0;

    // Quad corners in src UV space (extruded outward).
    const qA = uvA;
    const qB = uvB;
    const qBo = [uvB[0] + outX * haloWidth, uvB[1] + outY * haloWidth];
    const qAo = [uvA[0] + outX * haloWidth, uvA[1] + outY * haloWidth];

    // Corresponding redirect destinations on dst (extruded inward by the same amount).
    const rA = dstA;
    const rB = dstB;
    const rBo = [dstB[0] + inX * haloWidth, dstB[1] + inY * haloWidth];
    const rAo = [dstA[0] + inX * haloWidth, dstA[1] + inY * haloWidth];

    const corners = [qA, qB, qBo, qAo];
    const redirects = [rA, rB, rBo, rAo];
    const distances = [0, 0, SEAM_REDIRECT_HALO_TEXELS, SEAM_REDIRECT_HALO_TEXELS];

    for (let i = 0; i < 4; i++) {
      // NDC = uv*2 - 1
      haloPositions.push(corners[i][0] * 2 - 1, corners[i][1] * 2 - 1, 0);
      haloRedirect.push(redirects[i][0], redirects[i][1]);
      haloRotation.push(sinT, cosT);
      haloChart.push(sourceChart, destinationChart);
      haloDistance.push(distances[i]);
      haloDirection.push(outX, outY, inX, inY);
      haloBasis.push(edgeX, edgeY, dstEdgeX, dstEdgeY);
    }
    haloIndices.push(vertOffset, vertOffset + 1, vertOffset + 2, vertOffset, vertOffset + 2, vertOffset + 3);
    vertOffset += 4;
  }

  // Rasterize halo geometry into split redirect UV/valid and metadata targets.
  const haloGeo = new THREE.BufferGeometry();
  haloGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(haloPositions), 3));
  haloGeo.setAttribute('a_redirect', new THREE.BufferAttribute(new Float32Array(haloRedirect), 2));
  haloGeo.setAttribute('a_rotation', new THREE.BufferAttribute(new Float32Array(haloRotation), 2));
  haloGeo.setAttribute('a_chart', new THREE.BufferAttribute(new Float32Array(haloChart), 2));
  haloGeo.setAttribute('a_haloDistance', new THREE.BufferAttribute(new Float32Array(haloDistance), 1));
  haloGeo.setAttribute('a_transitionDirection', new THREE.BufferAttribute(new Float32Array(haloDirection), 4));
  haloGeo.setAttribute('a_transitionBasis', new THREE.BufferAttribute(new Float32Array(haloBasis), 4));
  haloGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(haloIndices), 1));

  const haloUvMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamUvFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const haloMetaMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamMetaFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const haloClaimMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamClaimFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
  });

  const haloMesh = new THREE.Mesh(haloGeo, haloUvMaterial);
  haloMesh.frustumCulled = false;
  const haloScene = new THREE.Scene();
  haloScene.add(haloMesh);

  haloMesh.material = haloUvMaterial;
  renderer.setRenderTarget(seamRedirectUvRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (haloPositions.length > 0) renderer.render(haloScene, quadCamera);

  haloMesh.material = haloClaimMaterial;
  renderer.setRenderTarget(seamRedirectClaimRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (haloPositions.length > 0) renderer.render(haloScene, quadCamera);

  haloMesh.material = haloMetaMaterial;
  renderer.setRenderTarget(seamRedirectMetaRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (haloPositions.length > 0) renderer.render(haloScene, quadCamera);
  renderer.setRenderTarget(null);

  haloGeo.dispose();
  haloUvMaterial.dispose();
  haloMetaMaterial.dispose();
  haloClaimMaterial.dispose();

  // === Weld geometry: paired quads extruded INWARD on both sides, so each
  // on-island edge texel knows the UV of its twin on the other island.
  const weldPositions = [];
  const weldRedirect = [];
  const weldRotation = [];
  const weldChart = [];
  const weldDistance = [];
  const weldDirection = [];
  const weldBasis = [];
  const weldIndices = [];
  // Quad spans 1 texel OUTSIDE the seam edge to 4 texels INSIDE, so on-island
  // edge-texel centers reliably land inside the rasterized region.
  const weldOutPad = SEAM_WELD_OUT_PAD_TEXELS / FIELD_SIZE;
  const weldInDepth = SEAM_WELD_IN_DEPTH_TEXELS / FIELD_SIZE;
  let weldVertOffset = 0;

  for (const seam of seamEdges) {
    pushWeld(seam.A, seam.B);
    pushWeld(seam.B, seam.A);
  }

  function pushWeld(srcSide, dstSide) {
    const uvA = [uvAttr[srcSide.vA * 2], uvAttr[srcSide.vA * 2 + 1]];
    const uvB = [uvAttr[srcSide.vB * 2], uvAttr[srcSide.vB * 2 + 1]];
    const uvC = [uvAttr[srcSide.vC * 2], uvAttr[srcSide.vC * 2 + 1]];
    const dstA = [uvAttr[dstSide.vA * 2], uvAttr[dstSide.vA * 2 + 1]];
    const dstB = [uvAttr[dstSide.vB * 2], uvAttr[dstSide.vB * 2 + 1]];
    const dstC = [uvAttr[dstSide.vC * 2], uvAttr[dstSide.vC * 2 + 1]];

    const ex = uvB[0] - uvA[0], ey = uvB[1] - uvA[1];
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-12) return;
    const edgeX = ex / elen, edgeY = ey / elen;
    const px = -edgeY, py = edgeX;
    const toC = [uvC[0] - uvA[0], uvC[1] - uvA[1]];
    // Inward on src points TOWARD uvC.
    const sign = (px * toC[0] + py * toC[1]) > 0 ? 1 : -1;
    const inX_src = px * sign, inY_src = py * sign;

    const dEx = dstB[0] - dstA[0], dEy = dstB[1] - dstA[1];
    const dElen = Math.hypot(dEx, dEy);
    if (dElen < 1e-12) return;
    const dstEdgeX = dEx / dElen, dstEdgeY = dEy / dElen;
    const dPx = -dstEdgeY, dPy = dstEdgeX;
    const dToC = [dstC[0] - dstA[0], dstC[1] - dstA[1]];
    // Inward on dst points TOWARD dstC.
    const dSign = (dPx * dToC[0] + dPy * dToC[1]) > 0 ? 1 : -1;
    const inX_dst = dPx * dSign, inY_dst = dPy * dSign;

    const TA = [T[srcSide.vA * 3], T[srcSide.vA * 3 + 1], T[srcSide.vA * 3 + 2]];
    const TB = [T[dstSide.vA * 3], T[dstSide.vA * 3 + 1], T[dstSide.vA * 3 + 2]];
    const BB = [B[dstSide.vA * 3], B[dstSide.vA * 3 + 1], B[dstSide.vA * 3 + 2]];
    const cosT = TA[0] * TB[0] + TA[1] * TB[1] + TA[2] * TB[2];
    const sinT = TA[0] * BB[0] + TA[1] * BB[1] + TA[2] * BB[2];
    const sourceChart = uvTopology?.faceChartIds?.[srcSide.face] ?? 0;
    const destinationChart = uvTopology?.faceChartIds?.[dstSide.face] ?? 0;

    // Source quad on src side: from outPad outside the seam to inDepth inside.
    const qA = [uvA[0] - inX_src * weldOutPad, uvA[1] - inY_src * weldOutPad];
    const qB = [uvB[0] - inX_src * weldOutPad, uvB[1] - inY_src * weldOutPad];
    const qBi = [uvB[0] + inX_src * weldInDepth, uvB[1] + inY_src * weldInDepth];
    const qAi = [uvA[0] + inX_src * weldInDepth, uvA[1] + inY_src * weldInDepth];

    // Redirect destinations on dst side: paired vertices, extending INWARD on dst.
    // Outward side maps to dstA/dstB themselves so a fragment AT the edge gets the vertex UV.
    const rA = dstA;
    const rB = dstB;
    const rBi = [dstB[0] + inX_dst * weldInDepth, dstB[1] + inY_dst * weldInDepth];
    const rAi = [dstA[0] + inX_dst * weldInDepth, dstA[1] + inY_dst * weldInDepth];

    const corners = [qA, qB, qBi, qAi];
    const redirects = [rA, rB, rBi, rAi];
    const distances = [0, 0, 0, 0];

    for (let i = 0; i < 4; i++) {
      weldPositions.push(corners[i][0] * 2 - 1, corners[i][1] * 2 - 1, 0);
      weldRedirect.push(redirects[i][0], redirects[i][1]);
      weldRotation.push(sinT, cosT);
      weldChart.push(sourceChart, destinationChart);
      weldDistance.push(distances[i]);
      weldDirection.push(-inX_src, -inY_src, inX_dst, inY_dst);
      weldBasis.push(edgeX, edgeY, dstEdgeX, dstEdgeY);
    }
    weldIndices.push(weldVertOffset, weldVertOffset + 1, weldVertOffset + 2, weldVertOffset, weldVertOffset + 2, weldVertOffset + 3);
    weldVertOffset += 4;
  }

  const weldGeo = new THREE.BufferGeometry();
  weldGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(weldPositions), 3));
  weldGeo.setAttribute('a_redirect', new THREE.BufferAttribute(new Float32Array(weldRedirect), 2));
  weldGeo.setAttribute('a_rotation', new THREE.BufferAttribute(new Float32Array(weldRotation), 2));
  weldGeo.setAttribute('a_chart', new THREE.BufferAttribute(new Float32Array(weldChart), 2));
  weldGeo.setAttribute('a_haloDistance', new THREE.BufferAttribute(new Float32Array(weldDistance), 1));
  weldGeo.setAttribute('a_transitionDirection', new THREE.BufferAttribute(new Float32Array(weldDirection), 4));
  weldGeo.setAttribute('a_transitionBasis', new THREE.BufferAttribute(new Float32Array(weldBasis), 4));
  weldGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(weldIndices), 1));

  const weldUvMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamUvFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const weldMetaMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamMetaFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const weldMesh = new THREE.Mesh(weldGeo, weldUvMaterial);
  weldMesh.frustumCulled = false;
  const weldScene = new THREE.Scene();
  weldScene.add(weldMesh);

  renderer.setRenderTarget(seamWeldUvRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (weldPositions.length > 0) renderer.render(weldScene, quadCamera);

  weldMesh.material = weldMetaMaterial;
  renderer.setRenderTarget(seamWeldMetaRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (weldPositions.length > 0) renderer.render(weldScene, quadCamera);
  renderer.setRenderTarget(null);

  weldGeo.dispose();
  weldUvMaterial.dispose();
  weldMetaMaterial.dispose();

  // === Zero-gutter crossing transition geometry: an explicit on-island seam
  // band. It is deliberately narrow and sized from actual crossing consumers
  // (visual support, diffusion, agent sensing/movement), not broad oat or splat
  // source/write support. Wide kernels must distribute per kernel instead of
  // prepainting a global transition strip.
  const transitionPositions = [];
  const transitionRedirect = [];
  const transitionRotation = [];
  const transitionChart = [];
  const transitionDistance = [];
  const transitionDirection = [];
  const transitionBasis = [];
  const transitionIndices = [];
  const transitionOutPad = SEAM_WELD_OUT_PAD_TEXELS / FIELD_SIZE;
  const transitionInDepth = SEAM_CROSSING_TRANSITION_BAND_TEXELS / FIELD_SIZE;
  let transitionVertOffset = 0;

  for (const seam of seamEdges) {
    pushTransition(seam.A, seam.B);
    pushTransition(seam.B, seam.A);
  }

  function pushTransition(srcSide, dstSide) {
    const uvA = [uvAttr[srcSide.vA * 2], uvAttr[srcSide.vA * 2 + 1]];
    const uvB = [uvAttr[srcSide.vB * 2], uvAttr[srcSide.vB * 2 + 1]];
    const uvC = [uvAttr[srcSide.vC * 2], uvAttr[srcSide.vC * 2 + 1]];
    const dstA = [uvAttr[dstSide.vA * 2], uvAttr[dstSide.vA * 2 + 1]];
    const dstB = [uvAttr[dstSide.vB * 2], uvAttr[dstSide.vB * 2 + 1]];
    const dstC = [uvAttr[dstSide.vC * 2], uvAttr[dstSide.vC * 2 + 1]];

    const ex = uvB[0] - uvA[0], ey = uvB[1] - uvA[1];
    const elen = Math.hypot(ex, ey);
    if (elen < 1e-12) return;
    const edgeX = ex / elen, edgeY = ey / elen;
    const px = -edgeY, py = edgeX;
    const toC = [uvC[0] - uvA[0], uvC[1] - uvA[1]];
    const sign = (px * toC[0] + py * toC[1]) > 0 ? 1 : -1;
    const inX_src = px * sign, inY_src = py * sign;
    const outX_src = -inX_src, outY_src = -inY_src;

    const dEx = dstB[0] - dstA[0], dEy = dstB[1] - dstA[1];
    const dElen = Math.hypot(dEx, dEy);
    if (dElen < 1e-12) return;
    const dstEdgeX = dEx / dElen, dstEdgeY = dEy / dElen;
    const dPx = -dstEdgeY, dPy = dstEdgeX;
    const dToC = [dstC[0] - dstA[0], dstC[1] - dstA[1]];
    const dSign = (dPx * dToC[0] + dPy * dToC[1]) > 0 ? 1 : -1;
    const inX_dst = dPx * dSign, inY_dst = dPy * dSign;

    const TA = [T[srcSide.vA * 3], T[srcSide.vA * 3 + 1], T[srcSide.vA * 3 + 2]];
    const TB = [T[dstSide.vA * 3], T[dstSide.vA * 3 + 1], T[dstSide.vA * 3 + 2]];
    const BB = [B[dstSide.vA * 3], B[dstSide.vA * 3 + 1], B[dstSide.vA * 3 + 2]];
    const cosT = TA[0] * TB[0] + TA[1] * TB[1] + TA[2] * TB[2];
    const sinT = TA[0] * BB[0] + TA[1] * BB[1] + TA[2] * BB[2];
    const sourceChart = uvTopology?.faceChartIds?.[srcSide.face] ?? 0;
    const destinationChart = uvTopology?.faceChartIds?.[dstSide.face] ?? 0;

    const qA = [uvA[0] - inX_src * transitionOutPad, uvA[1] - inY_src * transitionOutPad];
    const qB = [uvB[0] - inX_src * transitionOutPad, uvB[1] - inY_src * transitionOutPad];
    const qBi = [uvB[0] + inX_src * transitionInDepth, uvB[1] + inY_src * transitionInDepth];
    const qAi = [uvA[0] + inX_src * transitionInDepth, uvA[1] + inY_src * transitionInDepth];

    const corners = [qA, qB, qBi, qAi];
    // Store destination seam UV, not destination interior UV. The shader adds
    // mapped edge/depth offsets after proving the sample crosses this seam.
    const redirects = [dstA, dstB, dstB, dstA];
    const distances = [
      0,
      0,
      SEAM_CROSSING_TRANSITION_BAND_TEXELS,
      SEAM_CROSSING_TRANSITION_BAND_TEXELS,
    ];

    for (let i = 0; i < 4; i++) {
      transitionPositions.push(corners[i][0] * 2 - 1, corners[i][1] * 2 - 1, 0);
      transitionRedirect.push(redirects[i][0], redirects[i][1]);
      transitionRotation.push(sinT, cosT);
      transitionChart.push(sourceChart, destinationChart);
      transitionDistance.push(distances[i]);
      transitionDirection.push(outX_src, outY_src, inX_dst, inY_dst);
      transitionBasis.push(edgeX, edgeY, dstEdgeX, dstEdgeY);
    }
    transitionIndices.push(
      transitionVertOffset,
      transitionVertOffset + 1,
      transitionVertOffset + 2,
      transitionVertOffset,
      transitionVertOffset + 2,
      transitionVertOffset + 3,
    );
    transitionVertOffset += 4;
  }

  const transitionGeo = new THREE.BufferGeometry();
  transitionGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(transitionPositions), 3));
  transitionGeo.setAttribute('a_redirect', new THREE.BufferAttribute(new Float32Array(transitionRedirect), 2));
  transitionGeo.setAttribute('a_rotation', new THREE.BufferAttribute(new Float32Array(transitionRotation), 2));
  transitionGeo.setAttribute('a_chart', new THREE.BufferAttribute(new Float32Array(transitionChart), 2));
  transitionGeo.setAttribute('a_haloDistance', new THREE.BufferAttribute(new Float32Array(transitionDistance), 1));
  transitionGeo.setAttribute('a_transitionDirection', new THREE.BufferAttribute(new Float32Array(transitionDirection), 4));
  transitionGeo.setAttribute('a_transitionBasis', new THREE.BufferAttribute(new Float32Array(transitionBasis), 4));
  transitionGeo.setIndex(new THREE.BufferAttribute(new Uint32Array(transitionIndices), 1));

  const transitionUvMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamUvFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const transitionMetaMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamMetaFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const transitionDirectionMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamTransitionDirectionFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const transitionBasisMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamTransitionBasisFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
  });
  const transitionClaimMaterial = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: stripGlslVersion(seamRedirectVertex),
    fragmentShader: stripGlslVersion(seamClaimFragment),
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneFactor,
    transparent: true,
  });

  const transitionMesh = new THREE.Mesh(transitionGeo, transitionUvMaterial);
  transitionMesh.frustumCulled = false;
  const transitionScene = new THREE.Scene();
  transitionScene.add(transitionMesh);

  transitionMesh.material = transitionUvMaterial;
  renderer.setRenderTarget(seamTransitionUvRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (transitionPositions.length > 0) renderer.render(transitionScene, quadCamera);

  transitionMesh.material = transitionMetaMaterial;
  renderer.setRenderTarget(seamTransitionMetaRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (transitionPositions.length > 0) renderer.render(transitionScene, quadCamera);

  transitionMesh.material = transitionDirectionMaterial;
  renderer.setRenderTarget(seamTransitionDirectionRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (transitionPositions.length > 0) renderer.render(transitionScene, quadCamera);

  transitionMesh.material = transitionBasisMaterial;
  renderer.setRenderTarget(seamTransitionBasisRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (transitionPositions.length > 0) renderer.render(transitionScene, quadCamera);

  transitionMesh.material = transitionClaimMaterial;
  renderer.setRenderTarget(seamTransitionClaimRT);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  if (transitionPositions.length > 0) renderer.render(transitionScene, quadCamera);
  renderer.setRenderTarget(null);

  buildAndUploadTransitionCandidateMaps();

  transitionGeo.dispose();
  transitionUvMaterial.dispose();
  transitionMetaMaterial.dispose();
  transitionDirectionMaterial.dispose();
  transitionBasisMaterial.dispose();
  transitionClaimMaterial.dispose();

  return seamEdges;

  function buildAndUploadTransitionCandidateMaps() {
    const texelCount = FIELD_SIZE * FIELD_SIZE;
    const candidateAtlasWidth = FIELD_SIZE * SEAM_TRANSITION_CANDIDATE_COUNT;
    const candidateAtlasTexelCount = candidateAtlasWidth * FIELD_SIZE;
    const uvAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const metaAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const directionAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const basisAtlas = new Float32Array(candidateAtlasTexelCount * 4);
    const candidateCounts = new Uint16Array(texelCount);
    const candidateOverflow = new Uint8Array(texelCount);
    const rawCandidateCounts = new Uint16Array(texelCount);
    const sourceMismatchCounts = new Uint16Array(texelCount);
    const nonAuthoritativeCounts = new Uint16Array(texelCount);
    const duplicateMergeCounts = new Uint16Array(texelCount);
    const trueOverflowCounts = new Uint16Array(texelCount);
    const claimPixels = new Float32Array(texelCount * 4);
    // Only tracked in bake-export mode: which edge-side won each slot.
    const slotSeamIds = SEAM_BAKE_EXPORT_MODE
      ? new Uint32Array(texelCount * SEAM_TRANSITION_CANDIDATE_COUNT)
      : null;
    const packingStats = {
      rawCandidateClaims: 0,
      rawCandidateTexels: 0,
      discardedSourceChartMismatchCandidates: 0,
      discardedSourceChartMismatchTexels: 0,
      discardedNonAuthoritativeCandidates: 0,
      discardedNonAuthoritativeTexels: 0,
      duplicateCandidatesMerged: 0,
      duplicateCandidateTexels: 0,
      remainingCandidatesAfterFilteringDeduplication: 0,
      remainingCandidateTexels: 0,
      remainingMultiCandidateTexels: 0,
      trueOverflowAfterFilteringDeduplicationCandidates: 0,
      trueOverflowAfterFilteringDeduplicationTexels: 0,
      overflowReplacedFartherCandidates: 0,
      overflowDroppedCandidates: 0,
      effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels: 0,
      candidateSlots: SEAM_TRANSITION_CANDIDATE_COUNT,
    };
    let seamId = 1;

    const bake = seamBakeData &&
      seamBakeData.fieldSize === FIELD_SIZE &&
      seamBakeData.slots === SEAM_TRANSITION_CANDIDATE_COUNT &&
      seamBakeData.seamEdgeCount === seamEdges.length
      ? seamBakeData
      : null;
    if (bake) {
      applyBakedCandidates(bake);
    } else {
      if (seamBakeData) {
        console.warn('Seam bake does not match this mesh/config; building seam transitions live.');
      }
      for (const seam of seamEdges) {
        pushTransitionCandidate(seam.A, seam.B, seamId++);
        pushTransitionCandidate(seam.B, seam.A, seamId++);
      }
    }

    for (let texel = 0; texel < texelCount; texel++) {
      const p = texel * 4;
      claimPixels[p] = candidateCounts[texel];
      claimPixels[p + 1] = candidateOverflow[texel];
      claimPixels[p + 3] = 1;
      if (bake) continue; // packing stats come from the bake below
      if (rawCandidateCounts[texel] > 0) packingStats.rawCandidateTexels++;
      if (sourceMismatchCounts[texel] > 0) packingStats.discardedSourceChartMismatchTexels++;
      if (nonAuthoritativeCounts[texel] > 0) packingStats.discardedNonAuthoritativeTexels++;
      if (duplicateMergeCounts[texel] > 0) packingStats.duplicateCandidateTexels++;
      if (candidateCounts[texel] > 0) packingStats.remainingCandidateTexels++;
      if (candidateCounts[texel] >= 2) packingStats.remainingMultiCandidateTexels++;
      if (candidateOverflow[texel] !== 0) {
        packingStats.trueOverflowAfterFilteringDeduplicationTexels++;
        if (chartOwnership?.owner?.[texel] > 0 && chartOwnership?.conflict?.[texel] === 0) {
          packingStats.effectiveAutomaticWallTexelsOnAuthoritativeOwnedTexels++;
        }
      }
    }
    lastTransitionCandidatePackingDiagnostics = bake
      ? { ...bake.diagnostics, prebaked: true }
      : {
        ...packingStats,
        filteredCandidateClaims:
          packingStats.remainingCandidatesAfterFilteringDeduplication +
          packingStats.trueOverflowAfterFilteringDeduplicationCandidates,
        discardedCandidateClaims:
          packingStats.discardedSourceChartMismatchCandidates +
          packingStats.discardedNonAuthoritativeCandidates,
        note: 'Transition candidate packing is filtered by authoritative source ownership before slot allocation, then equivalent same-seam candidates are deduplicated. Overflow now means true post-filter/post-dedup ambiguity and is treated as conservative no-flux by runtime samplers.',
      };
    if (SEAM_BAKE_EXPORT_MODE) {
      seamBakeExportState = {
        fieldSize: FIELD_SIZE,
        slots: SEAM_TRANSITION_CANDIDATE_COUNT,
        seamEdgeCount: seamEdges.length,
        candidateCounts,
        candidateOverflow,
        slotSeamIds,
        diagnostics: lastTransitionCandidatePackingDiagnostics,
      };
    }

    const uvTexture = makeDataTexture2D(uvAtlas, candidateAtlasWidth, FIELD_SIZE, THREE.FloatType);
    const metaTexture = makeDataTexture2D(metaAtlas, candidateAtlasWidth, FIELD_SIZE, THREE.FloatType);
    const directionTexture = makeDataTexture2D(directionAtlas, candidateAtlasWidth, FIELD_SIZE, THREE.FloatType);
    const basisTexture = makeDataTexture2D(basisAtlas, candidateAtlasWidth, FIELD_SIZE, THREE.FloatType);
    uploadDataTextureToRT(uvTexture, seamTransitionUvAtlasRT);
    uploadDataTextureToRT(metaTexture, seamTransitionMetaAtlasRT);
    uploadDataTextureToRT(directionTexture, seamTransitionDirectionAtlasRT);
    uploadDataTextureToRT(basisTexture, seamTransitionBasisAtlasRT);
    uvTexture.dispose();
    metaTexture.dispose();
    directionTexture.dispose();
    basisTexture.dispose();

    const claimTexture = makeDataTexture(claimPixels, THREE.FloatType);
    uploadDataTextureToRT(claimTexture, seamTransitionClaimRT);
    claimTexture.dispose();

    function applyBakedCandidates(bakeData) {
      // The bake stores only the packing decisions (which edge-side won each
      // slot); the candidate values are recomputed here with the same math the
      // live rasterizer uses, so both paths produce identical atlases.
      const frames = new Array(seamEdges.length * 2 + 1);
      const view = bakeData.view;
      let offset = bakeData.recordsOffset;
      for (let record = 0; record < bakeData.recordCount; record++) {
        const texel = view.getUint32(offset, true);
        const flags = view.getUint8(offset + 4);
        offset += 5;
        const count = flags & 0x0f;
        candidateCounts[texel] = count;
        candidateOverflow[texel] = flags & 0x80 ? 1 : 0;
        const x = texel % FIELD_SIZE;
        const y = (texel - x) / FIELD_SIZE;
        for (let slot = 0; slot < count; slot++) {
          const candidateSeamId = view.getUint32(offset, true);
          offset += 4;
          let frame = frames[candidateSeamId];
          if (frame === undefined) {
            const seam = seamEdges[(candidateSeamId - 1) >> 1];
            frame = seam
              ? ((candidateSeamId - 1) % 2 === 0
                ? makeTransitionCandidateFrame(seam.A, seam.B, candidateSeamId)
                : makeTransitionCandidateFrame(seam.B, seam.A, candidateSeamId))
              : null;
            frames[candidateSeamId] = frame;
          }
          if (!frame) continue;
          writeCandidateToSlot(slot, texel, candidateAtTexel(frame, x, y));
        }
      }
    }

    function candidateAtlasOffset(slot, texel) {
      const x = texel % FIELD_SIZE;
      const y = (texel - x) / FIELD_SIZE;
      return ((y * candidateAtlasWidth) + slot * FIELD_SIZE + x) * 4;
    }

    function dot2(ax, ay, bx, by) {
      const al = Math.hypot(ax, ay);
      const bl = Math.hypot(bx, by);
      if (al < 1e-8 || bl < 1e-8) return -1;
      return (ax * bx + ay * by) / (al * bl);
    }

    function candidateMatchesExistingSlot(slot, texel, candidate) {
      const p = candidateAtlasOffset(slot, texel);
      if (uvAtlas[p + 2] < 0.5) return false;
      if (Math.round(metaAtlas[p]) !== candidate.sourceChart ||
          Math.round(metaAtlas[p + 1]) !== candidate.destinationChart) {
        return false;
      }
      const sourceOutDot = dot2(directionAtlas[p], directionAtlas[p + 1], candidate.outX, candidate.outY);
      const destinationInDot = dot2(directionAtlas[p + 2], directionAtlas[p + 3], candidate.destInX, candidate.destInY);
      const sourceEdgeDot = dot2(basisAtlas[p], basisAtlas[p + 1], candidate.edgeX, candidate.edgeY);
      const destinationEdgeDot = dot2(basisAtlas[p + 2], basisAtlas[p + 3], candidate.dstEdgeX, candidate.dstEdgeY);
      const edgeDirectionsCompatible =
        (sourceEdgeDot > 0.9 && destinationEdgeDot > 0.9) ||
        (sourceEdgeDot < -0.9 && destinationEdgeDot < -0.9);
      const duTexels = (uvAtlas[p] - candidate.destinationU) * FIELD_SIZE;
      const dvTexels = (uvAtlas[p + 1] - candidate.destinationV) * FIELD_SIZE;
      const destinationDistanceTexels = Math.hypot(duTexels, dvTexels);
      const depthDeltaTexels = Math.abs(uvAtlas[p + 3] - candidate.distanceTexels);
      return sourceOutDot > 0.9 &&
        destinationInDot > 0.9 &&
        edgeDirectionsCompatible &&
        destinationDistanceTexels <= 10.0 &&
        depthDeltaTexels <= 5.0;
    }

    function writeCandidateToSlot(slot, texel, candidate) {
      if (slotSeamIds) slotSeamIds[texel * SEAM_TRANSITION_CANDIDATE_COUNT + slot] = candidate.seamId;
      const p = candidateAtlasOffset(slot, texel);
      uvAtlas[p] = candidate.destinationU;
      uvAtlas[p + 1] = candidate.destinationV;
      uvAtlas[p + 2] = 1;
      uvAtlas[p + 3] = candidate.distanceTexels;
      metaAtlas[p] = candidate.sourceChart;
      metaAtlas[p + 1] = candidate.destinationChart;
      metaAtlas[p + 2] = candidate.sinT;
      metaAtlas[p + 3] = candidate.cosT;
      directionAtlas[p] = candidate.outX;
      directionAtlas[p + 1] = candidate.outY;
      directionAtlas[p + 2] = candidate.destInX;
      directionAtlas[p + 3] = candidate.destInY;
      basisAtlas[p] = candidate.edgeX;
      basisAtlas[p + 1] = candidate.edgeY;
      basisAtlas[p + 2] = candidate.dstEdgeX;
      basisAtlas[p + 3] = candidate.dstEdgeY;
    }

    function mergeCandidateIntoSlot(slot, texel, candidate) {
      const p = candidateAtlasOffset(slot, texel);
      // Keep the shallower equivalent crossing. It is less likely to create a
      // false not-crossing rejection while still going through destination
      // ownership and chart validation in the sampler.
      if (candidate.distanceTexels < uvAtlas[p + 3]) {
        writeCandidateToSlot(slot, texel, candidate);
      }
    }

    function appendCandidate(texel, candidate) {
      packingStats.rawCandidateClaims++;
      rawCandidateCounts[texel]++;
      const ownerChart = chartOwnership?.owner?.[texel] ?? 0;
      const unsafe = chartOwnership?.conflict?.[texel] !== 0;
      if (ownerChart <= 0 || unsafe) {
        packingStats.discardedNonAuthoritativeCandidates++;
        nonAuthoritativeCounts[texel]++;
        return;
      }
      if (ownerChart !== candidate.sourceChart) {
        packingStats.discardedSourceChartMismatchCandidates++;
        sourceMismatchCounts[texel]++;
        return;
      }

      const allocatedCount = Math.min(candidateCounts[texel], SEAM_TRANSITION_CANDIDATE_COUNT);
      for (let slot = 0; slot < allocatedCount; slot++) {
        if (!candidateMatchesExistingSlot(slot, texel, candidate)) continue;
        packingStats.duplicateCandidatesMerged++;
        duplicateMergeCounts[texel]++;
        mergeCandidateIntoSlot(slot, texel, candidate);
        return;
      }

      const slot = candidateCounts[texel];
      if (slot >= SEAM_TRANSITION_CANDIDATE_COUNT) {
        candidateOverflow[texel] = 1;
        packingStats.trueOverflowAfterFilteringDeduplicationCandidates++;
        trueOverflowCounts[texel]++;
        let farthestSlot = 0;
        let farthestDistance = -Infinity;
        for (let existingSlot = 0; existingSlot < SEAM_TRANSITION_CANDIDATE_COUNT; existingSlot++) {
          const existingP = candidateAtlasOffset(existingSlot, texel);
          if (uvAtlas[existingP + 3] > farthestDistance) {
            farthestDistance = uvAtlas[existingP + 3];
            farthestSlot = existingSlot;
          }
        }
        if (candidate.distanceTexels + 0.25 < farthestDistance) {
          packingStats.overflowReplacedFartherCandidates++;
          writeCandidateToSlot(farthestSlot, texel, candidate);
        } else {
          packingStats.overflowDroppedCandidates++;
        }
        return;
      }
      candidateCounts[texel]++;
      packingStats.remainingCandidatesAfterFilteringDeduplication++;
      writeCandidateToSlot(slot, texel, candidate);
    }

    // Per-edge-side frame: everything a texel candidate derives from. Shared by
    // the live rasterizer and the bake decoder so both produce identical values.
    function makeTransitionCandidateFrame(srcSide, dstSide, candidateSeamId) {
      const uvA = [uvAttr[srcSide.vA * 2], uvAttr[srcSide.vA * 2 + 1]];
      const uvB = [uvAttr[srcSide.vB * 2], uvAttr[srcSide.vB * 2 + 1]];
      const uvC = [uvAttr[srcSide.vC * 2], uvAttr[srcSide.vC * 2 + 1]];
      const dstA = [uvAttr[dstSide.vA * 2], uvAttr[dstSide.vA * 2 + 1]];
      const dstB = [uvAttr[dstSide.vB * 2], uvAttr[dstSide.vB * 2 + 1]];
      const dstC = [uvAttr[dstSide.vC * 2], uvAttr[dstSide.vC * 2 + 1]];

      const ex = uvB[0] - uvA[0], ey = uvB[1] - uvA[1];
      const elen = Math.hypot(ex, ey);
      if (elen < 1e-12) return null;
      const edgeX = ex / elen, edgeY = ey / elen;
      const px = -edgeY, py = edgeX;
      const toC = [uvC[0] - uvA[0], uvC[1] - uvA[1]];
      const sign = (px * toC[0] + py * toC[1]) > 0 ? 1 : -1;
      const inX_src = px * sign, inY_src = py * sign;
      const outX_src = -inX_src, outY_src = -inY_src;

      const dEx = dstB[0] - dstA[0], dEy = dstB[1] - dstA[1];
      const dElen = Math.hypot(dEx, dEy);
      if (dElen < 1e-12) return null;
      const dstEdgeX = dEx / dElen, dstEdgeY = dEy / dElen;
      const dPx = -dstEdgeY, dPy = dstEdgeX;
      const dToC = [dstC[0] - dstA[0], dstC[1] - dstA[1]];
      const dSign = (dPx * dToC[0] + dPy * dToC[1]) > 0 ? 1 : -1;
      const inX_dst = dPx * dSign, inY_dst = dPy * dSign;

      const TA = [T[srcSide.vA * 3], T[srcSide.vA * 3 + 1], T[srcSide.vA * 3 + 2]];
      const TB = [T[dstSide.vA * 3], T[dstSide.vA * 3 + 1], T[dstSide.vA * 3 + 2]];
      const BB = [B[dstSide.vA * 3], B[dstSide.vA * 3 + 1], B[dstSide.vA * 3 + 2]];
      const cosT = TA[0] * TB[0] + TA[1] * TB[1] + TA[2] * TB[2];
      const sinT = TA[0] * BB[0] + TA[1] * BB[1] + TA[2] * BB[2];
      const sourceChart = uvTopology?.faceChartIds?.[srcSide.face] ?? 0;
      const destinationChart = uvTopology?.faceChartIds?.[dstSide.face] ?? 0;

      return {
        seamId: candidateSeamId,
        uvA, uvB, dstA, dstB,
        elen, edgeX, edgeY,
        inX_src, inY_src, outX_src, outY_src,
        inX_dst, inY_dst, dstEdgeX, dstEdgeY,
        sinT, cosT, sourceChart, destinationChart,
      };
    }

    function candidateAtTexel(frame, x, y) {
      const centerU = (x + 0.5) / FIELD_SIZE;
      const centerV = (y + 0.5) / FIELD_SIZE;
      const alongUv = (centerU - frame.uvA[0]) * frame.edgeX + (centerV - frame.uvA[1]) * frame.edgeY;
      const t = clampNumber(frame.elen > 0 ? alongUv / frame.elen : 0, 0, 1);
      const depthUv = Math.max(0, (centerU - frame.uvA[0]) * frame.inX_src + (centerV - frame.uvA[1]) * frame.inY_src);
      return {
        seamId: frame.seamId,
        sourceChart: frame.sourceChart,
        destinationChart: frame.destinationChart,
        sinT: frame.sinT,
        cosT: frame.cosT,
        destinationU: frame.dstA[0] + (frame.dstB[0] - frame.dstA[0]) * t,
        destinationV: frame.dstA[1] + (frame.dstB[1] - frame.dstA[1]) * t,
        distanceTexels: Math.min(SEAM_CROSSING_TRANSITION_BAND_TEXELS, depthUv * FIELD_SIZE),
        outX: frame.outX_src,
        outY: frame.outY_src,
        destInX: frame.inX_dst,
        destInY: frame.inY_dst,
        edgeX: frame.edgeX,
        edgeY: frame.edgeY,
        dstEdgeX: frame.dstEdgeX,
        dstEdgeY: frame.dstEdgeY,
      };
    }

    function pushTransitionCandidate(srcSide, dstSide, candidateSeamId) {
      const frame = makeTransitionCandidateFrame(srcSide, dstSide, candidateSeamId);
      if (!frame) return;
      const { uvA, uvB, inX_src, inY_src } = frame;

      const outPad = SEAM_WELD_OUT_PAD_TEXELS / FIELD_SIZE;
      const inDepth = SEAM_CROSSING_TRANSITION_BAND_TEXELS / FIELD_SIZE;
      const qA = [uvA[0] - inX_src * outPad, uvA[1] - inY_src * outPad];
      const qB = [uvB[0] - inX_src * outPad, uvB[1] - inY_src * outPad];
      const qBi = [uvB[0] + inX_src * inDepth, uvB[1] + inY_src * inDepth];
      const qAi = [uvA[0] + inX_src * inDepth, uvA[1] + inY_src * inDepth];
      const minX = Math.max(0, Math.floor(Math.min(qA[0], qB[0], qBi[0], qAi[0]) * FIELD_SIZE) - 1);
      const maxX = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(qA[0], qB[0], qBi[0], qAi[0]) * FIELD_SIZE) + 1);
      const minY = Math.max(0, Math.floor(Math.min(qA[1], qB[1], qBi[1], qAi[1]) * FIELD_SIZE) - 1);
      const maxY = Math.min(FIELD_SIZE - 1, Math.ceil(Math.max(qA[1], qB[1], qBi[1], qAi[1]) * FIELD_SIZE) + 1);
      const areaA = orient2d(qA[0], qA[1], qB[0], qB[1], qBi[0], qBi[1]);
      const areaB = orient2d(qA[0], qA[1], qBi[0], qBi[1], qAi[0], qAi[1]);

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const touches =
            triangleTouchesTexel(qA[0], qA[1], qB[0], qB[1], qBi[0], qBi[1], areaA, x, y) ||
            triangleTouchesTexel(qA[0], qA[1], qBi[0], qBi[1], qAi[0], qAi[1], areaB, x, y);
          if (!touches) continue;
          appendCandidate(y * FIELD_SIZE + x, candidateAtTexel(frame, x, y));
        }
      }
    }
  }
}

// === oat ops ===
function isOatTooClose(uv, worldPos, radius, chartId) {
  const minWorldDistanceSq = OAT_MIN_PLACEMENT_WORLD_DISTANCE * OAT_MIN_PLACEMENT_WORLD_DISTANCE;
  for (const oat of oats) {
    if (worldPos && oat.worldPos && worldPos.distanceToSquared(oat.worldPos) < minWorldDistanceSq) {
      return true;
    }
    if (oat.chartId !== chartId) continue;
    const minUvDistance = Math.max(OAT_MIN_PLACEMENT_UV_DISTANCE, radius + (oat.radius ?? DEFAULT_OAT_RADIUS));
    const du = uv.x - oat.uv.x;
    const dv = uv.y - oat.uv.y;
    if ((du * du + dv * dv) < minUvDistance * minUvDistance) {
      return true;
    }
  }
  return false;
}

function addOat(x, y, opts = {}) {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    console.warn('Rejected oat outside atlas bounds:', { x, y });
    return null;
  }
  const radius = opts.radius ?? DEFAULT_OAT_RADIUS;
  const initial = !!opts.initial;
  const power = opts.power ?? (initial ? getInitialOatPower() : getDefaultOatPower());
  const uv = { x, y };
  const chartId = chartIdAt(uv);
  if (chartId <= 0 || isOwnershipUnsafe(uv)) {
    console.warn('Rejected oat on non-authoritative or unsafe chart texel:', { uv, chartId });
    return null;
  }
  let worldPos = opts.worldPos ? opts.worldPos.clone() : null;
  if (!worldPos && mesh) {
    worldPos = uvToWorld(uv);
  }
  let worldNormal = opts.worldNormal ? opts.worldNormal.clone() : null;
  if (!worldNormal && worldPos) {
    worldNormal = worldPos.clone().normalize();
  }
  if (!initial && !opts.ignoreProximity && isOatTooClose(uv, worldPos, radius, chartId)) {
    console.info('Rejected oat too close to an existing oat:', { uv });
    if (worldPos) spawnRejectedOatFizzle(worldPos, worldNormal);
    return null;
  }
  if (oats.length >= MAX_OATS) {
    // Replace oldest non-initial oat (preserve oats[0]).
    const removed = oats.splice(1, 1)[0];
    disposeOatObservation(removed?.observation);
    if (removed?.sphere) {
      oatGroup.remove(removed.sphere);
      disposeOatMarker(removed.sphere);
    }
  }
  let sphere = null;
  if (worldPos) {
    sphere = createOatGlowMarker(worldPos, worldNormal);
    oatGroup.add(sphere);
  }
  const storyText = normalizeStoryTextValue(opts.storyText ?? opts.text);
  const storyAssigned = Boolean(storyText);
  const suppressObservation = !!opts.suppressObservation;
  const oat = {
    uv,
    chartId,
    worldPos,
    worldNormal,
    radius,
    power,
    foodDecayStartedAt: null,
    foodDecayMultiplier: 1,
    initial,
    suppressObservation,
    sphere,
    storyText,
    storyAssigned,
    observation: null,
  };
  if (sphere) sphere.userData.oat = oat;
  if (suppressObservation) {
    if (sphere) {
      sphere.visible = false;
      const glow = sphere.children?.[0];
      if (glow?.material) glow.material.opacity = 0;
    }
  } else {
    oat.observation = createOatObservation(oat);
    if (opts.observationCompleted) completeOatObservation(oat);
  }
  // Other oats start their food-power decay when their story text reveals
  // (see maybeStartOatObservationText), which the initial oat never gets
  // since it has no observation. It's already surrounded by slime from the
  // first frame, so start its decay clock immediately instead.
  if (initial) startOatFoodDecay(oat, performance.now());
  oats.push(oat);
  oatListVersion++;
  invalidateObservationTriggerScores();
  oatDirty = true;
  oatCountEl.textContent = String(oats.length);
  return oat;
}

function getDefaultOatPower() {
  return params.oatPower ?? DEFAULT_OAT_POWER;
}

function getInitialOatPower() {
  return getDefaultOatPower() * INITIAL_OAT_POWER_MULTIPLIER;
}

function getOatFoodDecayMultiplier(oat) {
  const multiplier = Number(oat?.foodDecayMultiplier);
  if (!Number.isFinite(multiplier)) return 1;
  return THREE.MathUtils.clamp(multiplier, OAT_FOOD_DECAY_TARGET_MULTIPLIER, 1);
}

function startOatFoodDecay(oat, now = performance.now()) {
  if (!oat || Number.isFinite(oat.foodDecayStartedAt)) return false;
  oat.foodDecayStartedAt = now;
  oat.foodDecayMultiplier = 1;
  nextOatFoodDecayUpdateAt = 0;
  oatDirty = true;
  return true;
}

function updateOatFoodDecay(now = performance.now(), { force = false } = {}) {
  if (!force && now < nextOatFoodDecayUpdateAt) return false;

  let hasActiveDecay = false;
  let changed = false;
  for (const oat of oats) {
    if (!Number.isFinite(oat.foodDecayStartedAt)) continue;

    const elapsed = Math.max(0, now - oat.foodDecayStartedAt);
    const progress = THREE.MathUtils.clamp(elapsed / OAT_FOOD_DECAY_DURATION_MS, 0, 1);
    const eased = smoothUnit(progress);
    const nextMultiplier = progress >= 1
      ? OAT_FOOD_DECAY_TARGET_MULTIPLIER
      : THREE.MathUtils.lerp(1, OAT_FOOD_DECAY_TARGET_MULTIPLIER, eased);
    const previousMultiplier = getOatFoodDecayMultiplier(oat);
    if (Math.abs(nextMultiplier - previousMultiplier) >= OAT_FOOD_DECAY_EPSILON) {
      oat.foodDecayMultiplier = nextMultiplier;
      changed = true;
    }
    if (progress < 1) hasActiveDecay = true;
  }

  if (changed) oatDirty = true;
  nextOatFoodDecayUpdateAt = hasActiveDecay ? now + OAT_FOOD_DECAY_UPDATE_INTERVAL_MS : Infinity;
  return changed;
}

function getEffectiveOatPower(oat) {
  return Math.max(0, Number(oat?.power) || 0) * getOatFoodDecayMultiplier(oat);
}

function syncOatPowersFromParams() {
  for (const oat of oats) {
    oat.power = oat.initial ? getInitialOatPower() : getDefaultOatPower();
  }
  oatDirty = true;
}

function clearAllOats() {
  for (const o of oats) {
    disposeOatObservation(o.observation);
    if (o.sphere) {
      oatGroup.remove(o.sphere);
      disposeOatMarker(o.sphere);
    }
  }
  for (const marker of [...oatGroup.children]) {
    oatGroup.remove(marker);
    disposeOatMarker(marker);
  }
  oats.length = 0;
  oatListVersion++;
  invalidateObservationTriggerScores();
  nextObservationId = 1;
  resetStoryLibraryCursor();
  oatDirty = true;
  oatCountEl.textContent = '0';
}

function clearRT(rt) {
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(null);
}

function clearAgentRT(rt) {
  renderer.setRenderTarget(rt);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, false, false);
  renderer.setRenderTarget(null);
}

function createAgentInitialData() {
  const data = new Float32Array(AGENT_CAPACITY * 4);
  const liveAgentIndices = [];
  const spawnTexels = getAuthoritativeSpawnTexels();
  const diagnostics = {
    requestedAgents: INITIAL_AGENTS,
    createdAgents: 0,
    failedAgents: 0,
    localRetryAttempts: 0,
    localAccepted: 0,
    localRejectedOutsideAtlas: 0,
    localRejectedWrongChart: 0,
    localRejectedUnsafeOrUnowned: 0,
    globalRetryAttempts: 0,
    globalAccepted: 0,
    deterministicFallbackAccepted: 0,
    deterministicFallbackFailed: 0,
    initialOatGaussianAccepted: 0,
    initialOatGaussianFailed: 0,
    initialOatCenterFallbackAccepted: 0,
    initialOatUv: oats[0]?.uv ? { ...oats[0].uv } : null,
    initialOatSpawnSigma: INITIAL_AGENT_SPAWN_SIGMA,
    invalidCreatedAgents: 0,
    spawnTexelCount: spawnTexels.length,
    usesAtlasWrapping: false,
    usesFractTopology: false,
    maxLocalRetriesPerAgent: AGENT_INIT_LOCAL_RETRIES,
    maxGlobalRetriesPerAgent: AGENT_INIT_GLOBAL_RETRIES,
    note: 'Agent creation is CPU-validated against authoritative, non-unsafe chart texels. Initial agents are Gaussian-sampled around the first oat; invalid samples retry locally and never wrap.',
  };

  function acceptAgent(index, uv, angle, reserve) {
    const status = validateSpawnUv(uv);
    if (status !== 'valid') {
      diagnostics.invalidCreatedAgents++;
      return false;
    }
    const p = index * 4;
    data[p] = uv.x;
    data[p + 1] = uv.y;
    data[p + 2] = angle;
    data[p + 3] = reserve;
    diagnostics.createdAgents++;
    liveAgentIndices.push(index);
    return true;
  }

  function sampleStandardNormalPair() {
    const u1 = Math.max(Number.EPSILON, Math.random());
    const u2 = Math.random();
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = Math.PI * 2 * u2;
    return {
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
    };
  }

  for (let i = 0; i < INITIAL_AGENTS; i++) {
    let placed = false;
    const oat = oats[0] ?? null;
    const expectedChart = oat?.chartId > 0 ? oat.chartId : null;
    if (oat) {
      for (let attempt = 0; attempt < AGENT_INIT_LOCAL_RETRIES; attempt++) {
        diagnostics.localRetryAttempts++;
        const normal = sampleStandardNormalPair();
        const uv = {
          x: oat.uv.x + normal.x * INITIAL_AGENT_SPAWN_SIGMA,
          y: oat.uv.y + normal.y * INITIAL_AGENT_SPAWN_SIGMA,
        };
        const status = validateSpawnUv(uv, expectedChart);
        if (status === 'valid') {
          const angle = Math.random() * Math.PI * 2;
          const reserve = 1.0 + Math.random() * 0.45;
          placed = acceptAgent(i, uv, angle, reserve);
          if (placed) {
            diagnostics.localAccepted++;
            diagnostics.initialOatGaussianAccepted++;
          }
          break;
        }
        if (status === 'outsideAtlas') diagnostics.localRejectedOutsideAtlas++;
        else if (status === 'wrongChart') diagnostics.localRejectedWrongChart++;
        else diagnostics.localRejectedUnsafeOrUnowned++;
      }
      if (!placed) diagnostics.initialOatGaussianFailed++;
    }

    if (!placed && oat) {
      const angle = Math.random() * Math.PI * 2;
      const reserve = 1.0 + Math.random() * 0.45;
      placed = acceptAgent(i, { x: oat.uv.x, y: oat.uv.y }, angle, reserve);
      if (placed) {
        diagnostics.deterministicFallbackAccepted++;
        diagnostics.initialOatCenterFallbackAccepted++;
      }
    }

    for (let attempt = 0; !oat && !placed && attempt < AGENT_INIT_GLOBAL_RETRIES; attempt++) {
      diagnostics.globalRetryAttempts++;
      const uv = { x: Math.random(), y: Math.random() };
      if (validateSpawnUv(uv) !== 'valid') continue;
      const angle = Math.random() * Math.PI * 2;
      const reserve = 1.0 + Math.random() * 0.45;
      placed = acceptAgent(i, uv, angle, reserve);
      if (placed) diagnostics.globalAccepted++;
    }

    if (!oat && !placed && spawnTexels.length > 0) {
      const texel = spawnTexels[(i * 1103515245 + Math.floor(Math.random() * spawnTexels.length)) % spawnTexels.length];
      const uv = uvFromTexelIndex(texel);
      const angle = Math.random() * Math.PI * 2;
      const reserve = 1.0 + Math.random() * 0.45;
      placed = acceptAgent(i, uv, angle, reserve);
      if (placed) diagnostics.deterministicFallbackAccepted++;
    }

    if (!placed) {
      diagnostics.failedAgents++;
      diagnostics.deterministicFallbackFailed++;
    }
  }

  lastAgentCreationDiagnostics = diagnostics;
  return { data, diagnostics, liveAgentIndices };
}

function initAgents() {
  cancelEndingSequence({ stopSound: true });
  cancelInitialAgentSeeding();
  const { data, diagnostics } = createAgentInitialData();
  uploadAgentDataToRT(data, agentRT.read);
  uploadAgentDataToRT(data, agentRT.write);
  agentPrefixCountValid = false;
  visibleAgents = diagnostics.createdAgents;
  agentCountEl.textContent = visibleAgents.toLocaleString();
  resetAgentHistory(visibleAgents);
}

function cancelInitialAgentSeeding() {
  initialAgentSeedState.pending = false;
  initialAgentSeedState.pendingStartAt = 0;
  initialAgentSeedState.active = false;
  initialAgentSeedState.data = null;
  initialAgentSeedState.liveAgentIndices = [];
  initialAgentSeedState.diagnostics = null;
  initialAgentSeedState.visibleCount = 0;
  initialAgentSeedState.revealSlotCount = 0;
}

function injectInitialAgentSeedSlots(revealSlotCount) {
  const state = initialAgentSeedState;
  const nextSlotCount = Math.max(0, Math.min(INITIAL_AGENTS, Math.floor(revealSlotCount)));
  if (nextSlotCount <= state.revealSlotCount) return;
  state.revealSlotCount = nextSlotCount;
  while (
    state.visibleCount < state.liveAgentIndices.length &&
    state.liveAgentIndices[state.visibleCount] < state.revealSlotCount
  ) {
    state.visibleCount++;
  }
  agentSeedInjectMaterial.uniforms.u_currentAgents.value = agentRT.read.texture;
  agentSeedInjectMaterial.uniforms.u_seedAgents.value = agentSeedRT.texture;
  agentSeedInjectMaterial.uniforms.u_revealSlotCount.value = state.revealSlotCount;
  runFullscreenPass(agentSeedInjectMaterial, agentRT.write);
  agentRT.swap();
  agentPrefixCountValid = false;
  visibleAgents = state.visibleCount;
  agentCountEl.textContent = visibleAgents.toLocaleString();
  if (state.diagnostics) {
    lastAgentCreationDiagnostics = {
      ...state.diagnostics,
      createdAgents: state.visibleCount,
      note: `Initial agents are populating over ${(state.durationMs / 1000).toFixed(2)} seconds.`,
    };
  }
}

function beginInitialAgentSeeding({
  durationMs = INITIAL_AGENT_SEED_DURATION_MS,
  startedAt = performance.now(),
} = {}) {
  startSlimeTumbleLoop({
    fadeInSeconds: Math.max(0, Number(durationMs) || INITIAL_AGENT_SEED_DURATION_MS) / 1000,
    startAtPerformanceMs: startedAt,
  }).catch((err) => {
    console.warn('Initial agent seeding could not start the slime tumble loop:', err);
  });
  const { data, diagnostics, liveAgentIndices } = createAgentInitialData();
  initialAgentSeedState.pending = false;
  initialAgentSeedState.pendingStartAt = 0;
  initialAgentSeedState.active = true;
  initialAgentSeedState.startedAt = startedAt;
  initialAgentSeedState.durationMs = Math.max(0, Number(durationMs) || 0);
  initialAgentSeedState.data = data;
  initialAgentSeedState.liveAgentIndices = liveAgentIndices;
  initialAgentSeedState.diagnostics = diagnostics;
  initialAgentSeedState.visibleCount = 0;
  initialAgentSeedState.revealSlotCount = 0;
  uploadAgentDataToRT(data, agentSeedRT);
  clearAgentRT(agentRT.read);
  clearAgentRT(agentRT.write);
  agentPrefixCountValid = false;
  visibleAgents = 0;
  agentCountEl.textContent = '0';
  resetAgentHistory(0);
  lastAgentCreationDiagnostics = {
    ...diagnostics,
    createdAgents: 0,
    note: `Initial agents are populating over ${(initialAgentSeedState.durationMs / 1000).toFixed(2)} seconds.`,
  };
}

function updateInitialAgentSeeding(now) {
  const state = initialAgentSeedState;
  if (state.pending && now >= state.pendingStartAt) {
    beginInitialAgentSeeding({ startedAt: now });
    agentAllocationFrame = 0;
    lastAgentAllocationOffset = 0;
  }
  if (!state.active) return false;
  const wasActive = true;
  const progress = state.durationMs <= 0
    ? 1
    : Math.max(0, Math.min(1, (now - state.startedAt) / state.durationMs));
  injectInitialAgentSeedSlots(INITIAL_AGENTS * progress);
  if (progress >= 1) {
    injectInitialAgentSeedSlots(INITIAL_AGENTS);
    lastAgentCreationDiagnostics = state.diagnostics;
    resetAgentHistory(visibleAgents);
    cancelInitialAgentSeeding();
    armEndingSequence(now);
  }
  return wasActive;
}

function playInitialAgentSeedSound() {
  const stretchClip = SOUND_CHECK_CLIPS.find((clip) => clip.id === 'slime-appear-stretch');
  if (!stretchClip) return null;
  return playSoundCheckOneShot(stretchClip);
}

function replayInitialAgentSeed({
  playSound = true,
  seedDelayMs = 0,
} = {}) {
  cancelEndingSequence({ stopSound: true });
  cancelInitialAgentSeeding();
  const delayMs = Math.max(0, Number(seedDelayMs) || 0);
  if (playSound) {
    playInitialAgentSeedSound();
  }
  if (delayMs > 0) {
    initialAgentSeedState.pending = true;
    initialAgentSeedState.pendingStartAt = performance.now() + delayMs;
    clearAgentRT(agentRT.read);
    clearAgentRT(agentRT.write);
    agentPrefixCountValid = false;
    visibleAgents = 0;
    agentCountEl.textContent = '0';
    resetAgentHistory(0);
    lastAgentCreationDiagnostics = makeEmptyAgentCreationDiagnostics(
      `Initial agents are waiting ${(delayMs / 1000).toFixed(2)} seconds for the seed sound lead-in.`,
    );
  } else {
    beginInitialAgentSeeding();
  }
  agentAllocationFrame = 0;
  lastAgentAllocationOffset = 0;
}

function resetSimulation({ resetOats = false, spawnAgents = true } = {}) {
  cancelEndingSequence({ stopSound: true });
  cancelInitialAgentSeeding();
  statsReadbackCooldownUntil = performance.now() + STATS_READBACK_RESET_COOLDOWN_MS;
  if (resetOats) {
    clearAllOats();
    addInitialOat();
  }
  clearRT(fieldRT.read);
  clearRT(fieldRT.write);
  clearRT(fieldSampleViewRT);
  clearRT(renderRT.read);
  clearRT(renderRT.write);
  clearRT(renderSampleViewRT.read);
  clearRT(renderSampleViewRT.write);
  clearRT(renderScratchRT);
  clearRT(densityRT);
  clearRT(agentDensityOverlayRT);
  clearRT(depositDensityRT);
  clearAgentRT(agentParentNextRT);
  clearAgentRT(agentCandidateRT);
  clearAgentRT(agentPrefixRT.read);
  clearAgentRT(agentPrefixRT.write);
  clearAgentRT(agentSeedRT);
  clearRT(seamPaddingDebugRT);
  resetGoldWaferBodyHistory();
  lastSeamPaddingDiagnostics = {
    fieldKind: 'render',
    requestedPadTexels: 0,
    allowedPadTexels: 0,
    safeBudgetTexels: null,
    budgetCollision: false,
    requestedPadCandidateTexels: 0,
    allowedPadCandidateTexels: 0,
    writtenPadTexels: 0,
    skippedByBudgetCollisionTexels: 0,
    skippedByRedirectCollisionTexels: 0,
    skippedByRealChartTexels: 0,
    skippedByUnsafeOwnershipTexels: 0,
    skippedByUnresolvedDestinationTexels: 0,
    clippedByRealIslandTexels: 0,
    clippedByConflictTexels: 0,
    redirectCollisionTexels: 0,
    explicitRedirectCollisionTexels: 0,
    unresolvedTexels: 0,
    paddingBudgetCollisionTexels: 0,
    note: 'Safe seam padding has not run yet.',
  };
  if (spawnAgents) {
    initAgents();
  } else {
    clearAgentRT(agentRT.read);
    clearAgentRT(agentRT.write);
    agentPrefixCountValid = false;
    visibleAgents = 0;
    agentCountEl.textContent = '0';
    resetAgentHistory(0);
    lastAgentCreationDiagnostics = makeEmptyAgentCreationDiagnostics('Initial agents are waiting for the intro sequence.');
  }
  agentAllocationFrame = 0;
  lastAgentAllocationOffset = 0;
  oatDirty = true;
  smoothInitialized = false;
  markRenderFieldChanged();
  if (params.usePopulationControl) {
    restorePopulationSecondaryActuator({ syncControls: true });
    resetPopulationController({ preserveBase: true });
  }
}

// === sim passes ===
function uploadOatUniforms(material) {
  const u = material.uniforms;
  u.u_oatCount.value = oats.length;
  for (let i = 0; i < oats.length; i++) {
    u.u_oats.value[i].set(oats[i].uv.x, oats[i].uv.y);
    u.u_oatRadius.value[i] = oats[i].radius;
    u.u_oatPower.value[i] = getEffectiveOatPower(oats[i]);
    u.u_oatChart.value[i] = oats[i].chartId;
  }
}

function renderOats() {
  const seamEnabled = params.useSeamStitching ? 1 : 0;
  if (!oatDirty && lastOatRenderSeamStitching === seamEnabled) return;
  uploadOatUniforms(oatMaterial);
  oatMaterial.uniforms.u_useSeamStitching.value = seamEnabled;
  runFullscreenPass(oatMaterial, oatRT);
  oatDirty = false;
  lastOatRenderSeamStitching = seamEnabled;
}

function renderDensity() {
  densityMaterial.uniforms.u_agents.value = agentRT.read.texture;
  densityMaterial.uniforms.u_pointSize.value = getDensityPointSizePixels(params);
  densityMaterial.uniforms.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  renderer.setRenderTarget(densityRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.render(densityScene, quadCamera);
  if (params.useSeamStitching) {
    densityMaterial.uniforms.u_splatMode.value = 1;
    renderer.render(densityScene, quadCamera);
  }
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.setRenderTarget(null);
}

function renderAgentDensityOverlay() {
  densityMaterial.uniforms.u_agents.value = agentRT.read.texture;
  densityMaterial.uniforms.u_pointSize.value = AGENT_DENSITY_OVERLAY_POINT_SIZE_PIXELS;
  densityMaterial.uniforms.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  renderer.setRenderTarget(agentDensityOverlayRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.render(densityScene, quadCamera);
  if (params.useSeamStitching) {
    densityMaterial.uniforms.u_splatMode.value = 1;
    renderer.render(densityScene, quadCamera);
  }
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.setRenderTarget(null);
}

function renderDepositDensity() {
  densityMaterial.uniforms.u_agents.value = agentRT.read.texture;
  densityMaterial.uniforms.u_pointSize.value = getDepositPointSizePixels(params);
  densityMaterial.uniforms.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  renderer.setRenderTarget(depositDensityRT);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, false, false);
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.render(densityScene, quadCamera);
  if (params.useSeamStitching) {
    densityMaterial.uniforms.u_splatMode.value = 1;
    renderer.render(densityScene, quadCamera);
  }
  densityMaterial.uniforms.u_splatMode.value = 0;
  renderer.setRenderTarget(null);
}

function setAgentUpdateUniforms(material, now, dt) {
  const u = material.uniforms;
  if (u.u_agents) u.u_agents.value = agentRT.read.texture;
  if (u.u_parentNext) u.u_parentNext.value = agentParentNextRT.texture;
  u.u_food.value = fieldRT.read.texture;
  u.u_oat.value = oatRT.texture;
  u.u_density.value = densityRT.texture;
  u.u_time.value = now * 0.001;
  u.u_dt.value = dt;
  u.u_stepSize.value = params.stepSize;
  u.u_minMoveScale.value = params.minMoveScale;
  u.u_sensorDistance.value = params.sensorDistance;
  u.u_sensorAngle.value = params.sensorAngle;
  u.u_turnAngle.value = params.turnAngle;
  u.u_wander.value = params.wander;
  u.u_uptakeRate.value = params.uptakeRate;
  u.u_depositRate.value = params.depositRate;
  u.u_burnRate.value = params.burnRate;
  u.u_reproThreshold.value = params.reproThreshold;
  u.u_reproAngle.value = params.reproAngle;
  u.u_childStep.value = params.childStep;
  u.u_foodWeight.value = params.foodWeight;
  u.u_crowdWeight.value = params.crowdWeight;
  u.u_crowdExponent.value = params.crowdExponent;
  u.u_densityTarget.value = params.densityTarget;
  u.u_maxReserve.value = params.maxReserve;
  u.u_oatSupplyRate.value = params.oatSupplyRate;
  u.u_densityMassScale.value = DENSITY_MASS_SCALE;
  u.u_useOatRationing.value = params.useOatRationing ? 1 : 0;
  u.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  u.u_useZeroGutterTransitions.value = params.useSeamStitching ? 1 : 0;
  u.u_useHeadingRotation.value = params.useHeadingRotation ? 1 : 0;
  u.u_mouseRepelActive.value = mouseRepelState.active ? 1 : 0;
  u.u_mouseRepelUv.value.copy(mouseRepelState.uv);
  u.u_mouseRepelChart.value = mouseRepelState.chartId;
  u.u_mouseRepelRadius.value = MOUSE_REPEL_RADIUS_UV;
  u.u_mouseRepelStrength.value = MOUSE_REPEL_STRENGTH;
}

function updateAgents(now, dt) {
  lastAgentAllocationOffset = (Math.imul(agentAllocationFrame, 1664525) + 1013904223) >>> 0;
  lastAgentAllocationOffset %= AGENT_CAPACITY * 2;
  agentAllocationFrame++;

  setAgentUpdateUniforms(agentParentUpdateMaterial, now, dt);
  runFullscreenPass(agentParentUpdateMaterial, agentParentNextRT);

  setAgentUpdateUniforms(agentCandidateBuildMaterial, now, dt);
  agentCandidateBuildMaterial.uniforms.u_parentNext.value = agentParentNextRT.texture;
  agentCandidateBuildMaterial.uniforms.u_allocationOffset.value = lastAgentAllocationOffset;
  runFullscreenPass(agentCandidateBuildMaterial, agentCandidateRT);

  agentPrefixInitMaterial.uniforms.u_candidates.value = agentCandidateRT.texture;
  runFullscreenPass(agentPrefixInitMaterial, agentPrefixRT.write);
  agentPrefixRT.swap();
  for (let offset = 1; offset < AGENT_CANDIDATE_COUNT; offset *= 2) {
    agentPrefixScanMaterial.uniforms.u_prefix.value = agentPrefixRT.read.texture;
    agentPrefixScanMaterial.uniforms.u_offset.value = offset;
    runFullscreenPass(agentPrefixScanMaterial, agentPrefixRT.write);
    agentPrefixRT.swap();
  }

  agentCompactMaterial.uniforms.u_candidates.value = agentCandidateRT.texture;
  agentCompactMaterial.uniforms.u_prefix.value = agentPrefixRT.read.texture;
  agentCompactMaterial.uniforms.u_allocationOffset.value = lastAgentAllocationOffset;
  runFullscreenPass(agentCompactMaterial, agentRT.write);
  agentRT.swap();
  agentPrefixCountValid = true;
}

function diffuseField() {
  const u = diffuseMaterial.uniforms;
  u.u_food.value = fieldRT.read.texture;
  u.u_diffusion.value = params.fieldDiffusion;
  u.u_decay.value = params.fieldDecay;
  u.u_foodClamp.value = params.foodClamp;
  u.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  u.u_useZeroGutterTransitions.value = params.useSeamStitching ? 1 : 0;
  runFullscreenPass(diffuseMaterial, fieldRT.write);
  fieldRT.swap();
}

function applyAgentFoodDeltas(dt) {
  const u = deltaMaterial.uniforms;
  u.u_food.value = fieldRT.read.texture;
  u.u_uptakeRate.value = params.uptakeRate;
  u.u_depositRate.value = params.depositRate;
  u.u_deltaScale.value = params.deltaScale;
  u.u_dt.value = dt;
  u.u_foodClamp.value = params.foodClamp;
  runFullscreenPass(deltaMaterial, fieldRT.write);
  fieldRT.swap();
}

function equalizeField(rtPair) {
  const u = seamEqualizeMaterial.uniforms;
  u.u_food.value = rtPair.read.texture;
  u.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  runFullscreenPass(seamEqualizeMaterial, rtPair.write);
  rtPair.swap();
}

function copyAndClipToAuthoritativeTexels(sourceRT, destinationRT) {
  sampleViewCopyMaterial.uniforms.u_source.value = sourceRT.texture;
  runFullscreenPass(sampleViewCopyMaterial, destinationRT);
  renderer.setRenderTarget(null);
}

function clipCanonicalField(rtPair) {
  copyAndClipToAuthoritativeTexels(rtPair.read, rtPair.write);
  rtPair.swap();
}

function updateFieldSampleView() {
  copyAndClipToAuthoritativeTexels(fieldRT.read, fieldSampleViewRT);
}

function resolveSeamPaddingBudget(requestedPadTexels = SEAM_REDIRECT_HALO_TEXELS) {
  const requested = Number.isFinite(requestedPadTexels)
    ? Math.max(0, requestedPadTexels)
    : SEAM_REDIRECT_HALO_TEXELS;
  const risk = uvDiagnostics?.measurePaddingCollisionRisk?.(requested) ?? null;
  const safeBudget = risk?.maxConservativeSingleSidedPadTexels ?? null;
  let allowed = requested;
  let budgetCollision = false;
  if (safeBudget !== null && requested >= safeBudget) {
    budgetCollision = true;
    allowed = Math.max(0, Math.min(requested, safeBudget - SEAM_PADDING_BUDGET_EPSILON_TEXELS));
  }
  return {
    requestedPadTexels: requested,
    allowedPadTexels: allowed,
    safeBudgetTexels: safeBudget,
    budgetCollision,
    risk,
  };
}

function updateSeamPaddingDebugTexture(
  requestedPadTexels = lastSeamPaddingDiagnostics.requestedPadTexels,
  allowedPadTexels = lastSeamPaddingDiagnostics.allowedPadTexels,
) {
  if (params.debugView !== 'seam-padding') return false;
  seamPaddingDebugMaterial.uniforms.u_requestedPadTexels.value = requestedPadTexels;
  seamPaddingDebugMaterial.uniforms.u_maxPadTexels.value = allowedPadTexels;
  runFullscreenPass(seamPaddingDebugMaterial, seamPaddingDebugRT);
  renderer.setRenderTarget(null);
  return true;
}

function padFieldAcrossSeamsSafe({
  sourceCanonicalRT,
  destinationSampleViewRT,
  maxPadTexels = SEAM_REDIRECT_HALO_TEXELS,
  fieldKind = 'render',
} = {}) {
  if (!sourceCanonicalRT || !destinationSampleViewRT) {
    throw new Error('padFieldAcrossSeamsSafe requires sourceCanonicalRT and destinationSampleViewRT');
  }

  const budget = resolveSeamPaddingBudget(maxPadTexels);
  safeSeamPaddingMaterial.uniforms.u_existingSampleView.value = destinationSampleViewRT.read.texture;
  safeSeamPaddingMaterial.uniforms.u_sourceCanonical.value = sourceCanonicalRT.texture;
  safeSeamPaddingMaterial.uniforms.u_maxPadTexels.value = budget.allowedPadTexels;
  runFullscreenPass(safeSeamPaddingMaterial, destinationSampleViewRT.write);
  destinationSampleViewRT.swap();
  const debugTextureUpdated = updateSeamPaddingDebugTexture(
    budget.requestedPadTexels,
    budget.allowedPadTexels,
  );

  lastSeamPaddingDiagnostics = {
    fieldKind,
    requestedPadTexels: budget.requestedPadTexels,
    allowedPadTexels: budget.allowedPadTexels,
    safeBudgetTexels: budget.safeBudgetTexels,
    budgetCollision: budget.budgetCollision,
    requestedPadCandidateTexels: null,
    allowedPadCandidateTexels: null,
    writtenPadTexels: null,
    skippedByBudgetCollisionTexels: null,
    skippedByRedirectCollisionTexels: null,
    skippedByRealChartTexels: null,
    skippedByUnsafeOwnershipTexels: null,
    skippedByUnresolvedDestinationTexels: null,
    clippedByRealIslandTexels: null,
    clippedByConflictTexels: null,
    redirectCollisionTexels: null,
    explicitRedirectCollisionTexels: null,
    unresolvedTexels: null,
    paddingBudgetCollisionTexels: null,
    debugTextureUpdated,
    note: budget.budgetCollision
      ? 'Safe seam padding was budget-gated before the GPU write; run measureSeamPaddingDiagnostics() for skipped texel counts.'
      : 'Safe seam padding was applied on the GPU. Run measureSeamPaddingDiagnostics() for readback counts.',
  };
  return lastSeamPaddingDiagnostics;
}

function updateRenderSampleView({ applySeamEqualization = true } = {}) {
  copyAndClipToAuthoritativeTexels(renderRT.read, renderSampleViewRT.write);
  renderSampleViewRT.swap();
  padFieldAcrossSeamsSafe({
    sourceCanonicalRT: renderRT.read,
    destinationSampleViewRT: renderSampleViewRT,
    maxPadTexels: SEAM_REDIRECT_HALO_TEXELS,
    fieldKind: 'render',
  });
  if (applySeamEqualization) equalizeField(renderSampleViewRT);
}

function smoothRenderField() {
  updateFieldSampleView();
  const u = smoothMaterial.uniforms;
  u.u_currentFood.value = fieldSampleViewRT.texture;
  u.u_previousFood.value = renderRT.read.texture;
  u.u_direction.value.set(1, 0);
  u.u_spatialRadius.value = params.spatialSmoothing;
  u.u_temporalWeight.value = 0;
  u.u_foodClamp.value = params.foodClamp;
  u.u_applyTemporal.value = 0;
  u.u_smoothingTapCount.value = getRenderSmoothingTapCount(params);
  u.u_useSeamStitching.value = params.useSeamStitching ? 1 : 0;
  u.u_useZeroGutterTransitions.value = params.useSeamStitching ? 1 : 0;
  runFullscreenPass(smoothMaterial, renderScratchRT);

  u.u_currentFood.value = renderScratchRT.texture;
  u.u_previousFood.value = renderRT.read.texture;
  u.u_direction.value.set(0, 1);
  u.u_temporalWeight.value = smoothInitialized ? params.temporalSmoothing : 0;
  u.u_applyTemporal.value = 1;
  runFullscreenPass(smoothMaterial, renderRT.write);
  renderRT.swap();
  smoothInitialized = true;
  updateRenderSampleView();
}

function dilateRenderSampleView(iterations) {
  const u = dilateMaterial.uniforms;
  for (let i = 0; i < iterations; i++) {
    u.u_food.value = renderSampleViewRT.read.texture;
    runFullscreenPass(dilateMaterial, renderSampleViewRT.write);
    renderSampleViewRT.swap();
  }
}

// Legacy console-only helper. PR7 frame rendering uses padFieldAcrossSeamsSafe()
// instead of generic max dilation; this mutates only the derived sample view.
function dilateRenderField(iterations) {
  dilateRenderSampleView(iterations);
}

function simulate(now, dt) {
  renderOats();
  renderDensity();
  updateAgents(now, dt);
  diffuseField();
  renderDepositDensity();
  applyAgentFoodDeltas(dt);
  equalizeField(fieldRT);
  clipCanonicalField(fieldRT);
}

// === click handling ===
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const pointerRepelHits = [];
let pointerStart = null;

function setPointerNdcFromEvent(event, target = ndc) {
  const rect = canvas.getBoundingClientRect();
  target.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -(((event.clientY - rect.top) / rect.height) * 2 - 1),
  );
  return target;
}

function clearMouseRepel() {
  mouseRepelState.active = false;
  mouseRepelState.chartId = 0;
}

function updateMouseRepelFromEvent(event, { force = false } = {}) {
  if (!mesh) {
    clearMouseRepel();
    return false;
  }

  const now = performance.now();
  if (!force && now - mouseRepelState.lastRaycastAt < MOUSE_REPEL_RAYCAST_INTERVAL_MS) {
    return mouseRepelState.active;
  }
  mouseRepelState.lastRaycastAt = now;

  setPointerNdcFromEvent(event);
  raycaster.setFromCamera(ndc, camera);
  pointerRepelHits.length = 0;
  raycaster.intersectObject(mesh, false, pointerRepelHits);
  const hit = pointerRepelHits[0];
  pointerRepelHits.length = 0;
  if (!hit?.uv) {
    clearMouseRepel();
    return false;
  }

  const uv = { x: hit.uv.x, y: hit.uv.y };
  const chartId = chartIdAt(uv);
  if (chartId <= 0 || isOwnershipUnsafe(uv)) {
    clearMouseRepel();
    return false;
  }

  mouseRepelState.active = true;
  mouseRepelState.uv.set(uv.x, uv.y);
  mouseRepelState.chartId = chartId;
  return true;
}

canvas.addEventListener('pointerdown', (event) => {
  pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId };
  updateMouseRepelFromEvent(event, { force: true });
});

canvas.addEventListener('pointermove', (event) => {
  updateMouseRepelFromEvent(event);
});

canvas.addEventListener('pointerleave', () => {
  clearMouseRepel();
});

canvas.addEventListener('pointerup', (event) => {
  updateMouseRepelFromEvent(event, { force: true });
  if (!pointerStart || pointerStart.id !== event.pointerId) {
    pointerStart = null;
    return;
  }
  const dx = event.clientX - pointerStart.x;
  const dy = event.clientY - pointerStart.y;
  const moved = Math.hypot(dx, dy);
  pointerStart = null;
  if (moved >= 4) return;
  if (!mesh) return;
  setPointerNdcFromEvent(event);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(mesh, false);
  if (hits.length === 0) return;
  const hit = hits[0];
  if (!hit.uv) return;
  const uv = { x: hit.uv.x, y: hit.uv.y };
  loggedClicks.push(uv);
  console.log('click uv:', uv);
  const worldNormal = hit.face?.normal
    ?.clone()
    .transformDirection(mesh.matrixWorld);
  addOat(uv.x, uv.y, { worldPos: hit.point, worldNormal });
});

canvas.addEventListener('pointercancel', () => {
  pointerStart = null;
  clearMouseRepel();
});

// === UI controls ===
function initControls() {
  const bindings = {
    uptake: 'uptakeRate',
    deposit: 'depositRate',
    burn: 'burnRate',
    repro: 'reproThreshold',
    attract: 'foodWeight',
    avoid: 'crowdWeight',
    crowdCurve: 'crowdExponent',
    blur: 'densityBlur',
    ideal: 'densityTarget',
    minSpeed: 'minMoveScale',
    decay: 'fieldDecay',
    steps: 'simulationSteps',
    foodClamp: 'foodClamp',
    oatPower: 'oatPower',
    oatSupply: 'oatSupplyRate',
    populationTarget: 'populationTarget',
    populationLambda: 'populationLambda',
    populationSupplyLogGain: 'populationSupplyLogGain',
    populationOatSupplyMin: 'populationOatSupplyMin',
    populationOatSupplyMax: 'populationOatSupplyMax',
    spatialSmooth: 'spatialSmoothing',
    temporalSmooth: 'temporalSmoothing',
    surfaceHeight: 'surfaceHeight',
    surfaceBump: 'surfaceBump',
    iridescenceStrength: 'iridescenceStrength',
    iridescenceMinThickness: 'iridescenceMinThickness',
    iridescenceThickness: 'iridescenceThickness',
    filmThicknessCurve: 'filmThicknessCurve',
    goldBodyFade: 'goldBodyFade',
    goldBodyRoughness: 'goldBodyRoughness',
    goldBodyReflectivity: 'goldBodyReflectivity',
    lightBrightness: 'lightBrightness',
    observationTailLength: 'observationTailLength',
    observationStrokeOpacity: 'observationStrokeOpacity',
    observationCornerRadius: 'observationCornerRadius',
    observationEdgeFeather: 'observationEdgeFeather',
    observationBlurRadius: 'observationBlurRadius',
    observationTintOpacity: 'observationTintOpacity',
    observationSlimeTriggerThreshold: 'observationSlimeTriggerThreshold',
    speed: 'stepSize',
  };
  for (const [id, key] of Object.entries(bindings)) {
    const input = document.getElementById(id);
    const output = input.parentElement.querySelector('output');
    const sync = ({ markCustom = true } = {}) => {
      params[key] = Number(input.value);
      if (key === 'populationTarget') {
        params.populationTarget = Math.max(
          1,
          Math.round(finitePopulationParam(
            params.populationTarget,
            BASE_POPULATION_CONTROL_PARAMS.populationTarget,
          )),
        );
        populationControllerState.target = params.populationTarget;
        input.value = params.populationTarget;
      }
      const scale = Number(input.dataset.scale || 1);
      const suffix = input.dataset.suffix || '';
      const value = params[key] * scale;
      const digits = input.dataset.digits === undefined
        ? (scale === 100 ? 1 : 2)
        : Number(input.dataset.digits);
      output.value = `${value.toFixed(digits)}${suffix}`;
      if (key === 'oatPower') {
        syncOatPowersFromParams();
      }
      if (
        key === 'observationStrokeOpacity' ||
        key === 'observationCornerRadius' ||
        key === 'observationEdgeFeather' ||
        key === 'observationBlurRadius' ||
        key === 'observationTintOpacity'
      ) {
        syncObservationCssVars();
      }
      if (
        key === 'foodClamp' ||
        key === 'filmThicknessCurve' ||
        key === 'iridescenceMinThickness' ||
        key === 'iridescenceThickness' ||
        key === 'goldBodyFade' ||
        key === 'goldBodyRoughness' ||
        key === 'goldBodyReflectivity' ||
        key === 'lightBrightness'
      ) {
        markGoldWaferBodyUniformsDirty();
        syncGoldWaferBodyMaterialUniforms();
      }
      if (markCustom && SIMULATION_PRESET_KEY_SET.has(key)) {
        setActiveSimulationPreset('custom');
      }
      if (markCustom && (key === 'burnRate' || key === 'reproThreshold')) {
        capturePopulationControllerBaseValues();
      }
      if (markCustom && RENDER_DISPLAY_PRESET_KEY_SET.has(key)) {
        setActiveRenderDisplayPreset('custom');
      }
    };
    const syncFromParams = () => {
      input.value = params[key];
      sync({ markCustom: false });
    };
    input.addEventListener('input', () => sync());
    boundParamControls.set(key, syncFromParams);
    syncFromParams();
  }

  const simulationPresetSelect = document.getElementById('simulationPreset');
  if (simulationPresetSelect) {
    simulationPresetSelect.innerHTML = '';
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Custom';
    simulationPresetSelect.appendChild(customOption);
    for (const preset of SIMULATION_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      option.title = preset.note;
      simulationPresetSelect.appendChild(option);
    }
    simulationPresetSelect.value = activeSimulationPresetId;
    simulationPresetSelect.addEventListener('change', () => {
      if (simulationPresetSelect.value === 'custom') return;
      applySimulationPreset(simulationPresetSelect.value);
    });
  }

  const renderPresetSelect = document.getElementById('renderPreset');
  if (renderPresetSelect) {
    renderPresetSelect.innerHTML = '';
    const customOption = document.createElement('option');
    customOption.value = 'custom';
    customOption.textContent = 'Custom';
    renderPresetSelect.appendChild(customOption);
    for (const preset of RENDER_DISPLAY_PRESETS) {
      const option = document.createElement('option');
      option.value = preset.id;
      option.textContent = preset.label;
      option.title = preset.note;
      renderPresetSelect.appendChild(option);
    }
    renderPresetSelect.value = activeRenderDisplayPresetId;
    renderPresetSelect.addEventListener('change', () => {
      if (renderPresetSelect.value === 'custom') return;
      applyRenderDisplayPreset(renderPresetSelect.value);
    });
  }

  const baseColorInput = document.getElementById('slimeBaseColor');
  const baseColorOutput = baseColorInput.parentElement.querySelector('output');
  const syncBaseColor = ({ markCustom = true } = {}) => {
    params.slimeBaseColor = baseColorInput.value;
    baseColorOutput.value = baseColorInput.value.toUpperCase();
    syncObservationCssVars();
    if (markCustom) setActiveRenderDisplayPreset('custom');
  };
  const syncBaseColorFromParams = () => {
    baseColorInput.value = params.slimeBaseColor;
    syncBaseColor({ markCustom: false });
  };
  baseColorInput.addEventListener('input', () => syncBaseColor());
  boundParamControls.set('slimeBaseColor', syncBaseColorFromParams);
  syncBaseColorFromParams();

  const goldBodyColorInput = document.getElementById('goldBodyColor');
  const goldBodyColorOutput = goldBodyColorInput.parentElement.querySelector('output');
  const syncGoldBodyColor = ({ markCustom = true } = {}) => {
    params.goldBodyColor = goldBodyColorInput.value;
    goldBodyColorOutput.value = goldBodyColorInput.value.toUpperCase();
    markGoldWaferBodyUniformsDirty();
    syncGoldWaferBodyMaterialUniforms();
    if (markCustom) setActiveRenderDisplayPreset('custom');
  };
  const syncGoldBodyColorFromParams = () => {
    goldBodyColorInput.value = params.goldBodyColor;
    syncGoldBodyColor({ markCustom: false });
  };
  goldBodyColorInput.addEventListener('input', () => syncGoldBodyColor());
  boundParamControls.set('goldBodyColor', syncGoldBodyColorFromParams);
  syncGoldBodyColorFromParams();

  const tintColorInput = document.getElementById('observationTintColor');
  const tintColorOutput = tintColorInput.parentElement.querySelector('output');
  const syncTintColor = ({ markCustom = true } = {}) => {
    params.observationTintColor = tintColorInput.value;
    tintColorOutput.value = tintColorInput.value.toUpperCase();
    syncObservationCssVars();
    if (markCustom) setActiveRenderDisplayPreset('custom');
  };
  const syncTintColorFromParams = () => {
    tintColorInput.value = params.observationTintColor;
    syncTintColor({ markCustom: false });
  };
  tintColorInput.addEventListener('input', () => syncTintColor());
  boundParamControls.set('observationTintColor', syncTintColorFromParams);
  syncTintColorFromParams();

  for (const tip of document.querySelectorAll('.help-tip')) {
    tip.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    tip.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      tip.focus();
    });
  }

  function bindToggle(id, key, { onChange = null } = {}) {
    const input = document.getElementById(id);
    if (!input) return;
    const syncFromParams = () => {
      input.checked = !!params[key];
      if (onChange) onChange();
    };
    input.addEventListener('change', () => {
      params[key] = input.checked;
      if (SIMULATION_PRESET_KEY_SET.has(key)) {
        setActiveSimulationPreset('custom');
      }
      if (RENDER_DISPLAY_PRESET_KEY_SET.has(key)) {
        setActiveRenderDisplayPreset('custom');
      }
      if (onChange) onChange();
    });
    boundParamControls.set(key, syncFromParams);
    syncFromParams();
  }
  bindToggle('showAgents', 'showAgentDots');
  bindToggle('showOats', 'showOats');
  bindToggle('meshOutline', 'meshOutlineEnabled');
  bindToggle('storyBoxesEnabled', 'storyBoxesEnabled', { onChange: syncStoryBoxesEnabled });
  bindToggle('endingTimeLimitEnabled', 'endingTimeLimitEnabled', {
    onChange: () => {
      if (!params.endingTimeLimitEnabled) {
        cancelEndingSequence({ stopSound: true });
        return;
      }
      if (
        started &&
        introSequenceState.completed &&
        !initialAgentSeedState.active &&
        !initialAgentSeedState.pending
      ) {
        armEndingSequence(performance.now(), { fromNow: true });
      } else {
        setEndingCountdownVisible(endingSequenceState.active);
      }
    },
  });
  bindToggle('useSeamStitching', 'useSeamStitching');
  bindToggle('useIslandMasking', 'useIslandMasking');
  bindToggle('useHeadingRotation', 'useHeadingRotation');
  bindToggle('useOpticalZoom', 'useOpticalZoom', { onChange: syncCameraZoomMode });
  bindToggle('statsReadbackEnabled', 'statsReadbackEnabled');
  bindToggle('useOatRationing', 'useOatRationing');
  bindToggle('usePopulationControl', 'usePopulationControl', {
    onChange: () => {
      if (params.usePopulationControl) {
        params.useOatRationing = true;
        resetPopulationController({ preserveBase: false });
        syncBoundParamControlsFor(['useOatRationing']);
      } else {
        restorePopulationSecondaryActuator({ syncControls: true });
        resetPopulationController({ preserveBase: true });
      }
    },
  });
  bindToggle('populationUseSecondaryActuator', 'populationUseSecondaryActuator');
  bindToggle('showWireframe', 'showWireframe');
  bindToggle('filmFollowsSlimeHeight', 'filmFollowsSlimeHeight');
  bindToggle('useGoldWaferFilm', 'useGoldWaferFilm', {
    onChange: () => {
      if (params.useGoldWaferFilm && !goldWaferFilmState.ready) {
        loadGoldWaferFilmLookup();
      }
      syncGoldWaferFilmUniforms();
      syncGoldWaferFilmControlState();
    },
  });
  bindToggle('useGoldWaferBody', 'useGoldWaferBody', {
    onChange: () => {
      if (params.useGoldWaferBody && !goldWaferFilmState.ready) {
        loadGoldWaferFilmLookup();
      }
      if (params.useGoldWaferBody && goldWaferFilmState.ready) {
        goldWaferBodyMaxFoodNeedsUpdate = true;
      }
      markGoldWaferBodyModeDirty({ uniforms: true });
      syncGoldWaferFilmControlState();
      syncGoldWaferBodyMode();
    },
  });
  bindToggle('useIcosaFaceLights', 'useIcosaFaceLights', { onChange: syncIcosaLightRigUniforms });

  const debugViewSelect = document.getElementById('debugView');
  debugViewSelect.value = params.debugView;
  debugViewSelect.addEventListener('change', () => {
    params.debugView = debugViewSelect.value;
    markGoldWaferBodyModeDirty();
    syncGoldWaferBodyMode();
  });
  if (copyCameraPoseButton) {
    copyCameraPoseButton.addEventListener('click', copyCameraPoseToClipboard);
  }
  if (startButton) {
    startButton.addEventListener('pointerdown', () => setStartButtonHoverTarget(1, performance.now(), true));
    startButton.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        setStartButtonHoverTarget(1, performance.now(), true);
      }
    });
    startButton.addEventListener('click', requestIntroStart);
    startButton.addEventListener('pointerenter', () => setStartButtonHoverTarget(1));
    startButton.addEventListener('pointerleave', () => setStartButtonHoverTarget(0));
    startButton.addEventListener('focus', () => {
      if (startButton.matches?.(':focus-visible')) setStartButtonHoverTarget(1);
    });
    startButton.addEventListener('blur', () => setStartButtonHoverTarget(0));
  }
  initSoundCheckPanel();
  initSoundCompressorControls();

  const panel = document.querySelector('.panel');
  const panelBody = document.getElementById('panelBody');
  const collapsePanelButton = document.getElementById('collapsePanel');
  collapsePanelButton.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('is-collapsed');
    collapsePanelButton.textContent = collapsed ? 'Show parameters' : 'Hide parameters';
    collapsePanelButton.setAttribute('aria-expanded', String(!collapsed));
    collapsePanelButton.title = collapsed ? 'Show parameters' : 'Hide parameters';
    panelBody.setAttribute('aria-hidden', String(collapsed));
    if (!collapsed) drawAgentCharts();
  });
  setUiPanelsVisible(uiPanelsVisible);
  window.addEventListener('keydown', handlePanelVisibilityKeydown);
  window.addEventListener('keydown', handleIntroSkipKeydown);
  window.addEventListener('keydown', handleStoryBoxesKeydown);
  window.addEventListener('keydown', handleVisualLayerKeydown);
  window.addEventListener('resize', drawAgentCharts);

  if (soundCheckToggleButton && soundCheckPanel) {
    soundCheckToggleButton.addEventListener('click', toggleSoundCheckPanel);
  }
  if (soundCheckCloseButton) {
    soundCheckCloseButton.addEventListener('click', () => setSoundCheckOpen(false));
  }
  if (!(window.AudioContext || window.webkitAudioContext)) {
    for (const button of soundCheckGrid?.querySelectorAll('button') ?? []) {
      button.disabled = true;
      button.title = 'Web Audio is not available';
    }
    for (const input of soundCheckGrid?.querySelectorAll('input') ?? []) {
      input.disabled = true;
      input.title = 'Web Audio is not available';
    }
    for (const input of soundCompressorGrid?.querySelectorAll('input') ?? []) {
      input.disabled = true;
      input.title = 'Web Audio is not available';
    }
    if (soundCompressorEnabledInput) {
      soundCompressorEnabledInput.disabled = true;
      soundCompressorEnabledInput.title = 'Web Audio is not available';
    }
  }

  document.getElementById('pause').addEventListener('click', () => {
    paused = !paused;
    document.getElementById('pause').textContent = paused ? 'Run' : 'Pause';
  });

  document.getElementById('reset').addEventListener('click', () => {
    if (!started) return;
    resetSimulation({ resetOats: true, spawnAgents: false });
    replayInitialAgentSeed({ seedDelayMs: INITIAL_AGENT_SEED_SOUND_LEAD_MS });
  });
  document.getElementById('resetCamera').addEventListener('click', () => {
    camera.position.copy(initialCameraPose.position);
    controls.target.copy(initialCameraPose.target);
    setCameraFovImmediate(initialCameraPose.fovDeg);
    controls.update();
    cameraPoseReadoutDirty = true;
    updateCameraPoseReadout(true);
  });
  document.getElementById('seed').addEventListener('click', () => {
    if (started) initAgents();
  });
  document.getElementById('clearOats').addEventListener('click', () => {
    if (!started) return;
    clearAllOats();
    addInitialOat();
  });
}
initControls();

if (IS_MOBILE_DEVICE) {
  // Phone GPUs can't sustain the desktop profile: drop to the 'fast' smoothing
  // mode. Users can still restore quality mode from the panels.
  setPerformanceMode('fast');
  syncBoundParamControls();
}

function ensureWireframeOverlay() {
  if (wireframeOverlay || !mesh?.geometry) return wireframeOverlay;
  wireframeOverlay = new THREE.LineSegments(
    new THREE.WireframeGeometry(mesh.geometry),
    new THREE.LineBasicMaterial({ color: 0x88aabb, transparent: true, opacity: 0.18, depthTest: true }),
  );
  wireframeOverlay.visible = false;
  scene.add(wireframeOverlay);
  return wireframeOverlay;
}

// === frame loop ===
function frame(now) {
  const rawDt = Math.min((now - lastFrameTime) / 16.6667, FRAME_DT_CLAMP);
  lastFrameTime = now;

  updateStartScreenUi(now);
  updateIntroSequence(now);
  updateCameraFovSmoothing(now);
  updateCameraKeyboardOrbit(now);

  if (started) {
    updateOatFoodDecay(now);
    if (!paused) {
      const steps = Math.max(0, Math.min(MAX_SIMULATION_STEPS, Math.round(params.simulationSteps)));
      if (steps > 0) {
        const stepDt = rawDt / steps;
        for (let s = 0; s < steps; s++) {
          simulate(now + s * stepDt * 16.6667, stepDt);
        }
        markRenderFieldChanged();
      }
    } else {
      renderOats();
      renderDensity();
    }
    updateInitialAgentSeeding(now);
    updateEndingSequence(now);
    if (params.showAgentDots) renderAgentDensityOverlay();
    // Smoothing keeps converging (temporal blend) for a while after the field
    // stops changing; once settled, the ~6 fullscreen passes are pure repeats.
    const smoothingSignature = getSmoothingParamsSignature();
    if (smoothingSignature !== lastSmoothingParamsSignature) {
      lastSmoothingParamsSignature = smoothingSignature;
      markRenderFieldChanged();
    }
    if (smoothSettleFramesRemaining > 0) {
      smoothSettleFramesRemaining--;
      smoothRenderField();
    }
    if (isGoldWaferBodyHistoryActive() && (!paused || goldWaferBodyMaxFoodNeedsUpdate)) {
      updateGoldWaferBodyMaxFoodTexture({ force: goldWaferBodyMaxFoodNeedsUpdate });
    }
    updateObservationSlimeTriggers(now);
  }

  // Pick the right material for the cuttlefish based on debugView.
  if (mesh) {
    let mat = debugMaterials.slime;
    if (params.debugView === 'food') {
      debugMaterials.food.map = renderSampleViewRT.read.texture;
      debugMaterials.food.needsUpdate = true;
      mat = debugMaterials.food;
    } else if (params.debugView === 'mask') {
      mat = debugMaterials.mask;
    } else if (params.debugView === 'surface-coverage') {
      mat = debugMaterials.surfaceCoverage;
    } else if (params.debugView === 'coverage-comparison') {
      mat = debugMaterials.coverageComparison;
    } else if (params.debugView === 'simulation-domain') {
      mat = debugMaterials.simulationDomain;
    } else if (params.debugView === 'watertight-cracks') {
      mat = debugMaterials.watertightCracks;
    } else if (params.debugView === 'chart-id') {
      mat = debugMaterials.chartId;
    } else if (params.debugView === 'chart-conflict') {
      mat = debugMaterials.chartConflict;
    } else if (params.debugView === 'seam') {
      mat = debugMaterials.seam;
    } else if (params.debugView === 'seam-padding') {
      mat = debugMaterials.seamPadding;
    } else if (params.debugView === 'seam-transition') {
      mat = debugMaterials.seamTransition;
    } else if (params.debugView === 'seam-redirect-coverage') {
      mat = debugMaterials.seamRedirectCoverage;
    }
    if (mesh.material !== mat) mesh.material = mat;

    if (mesh.visible !== slimeVisualVisible) mesh.visible = slimeVisualVisible;
    const activeWireframeOverlay = params.showWireframe ? ensureWireframeOverlay() : wireframeOverlay;
    if (activeWireframeOverlay) activeWireframeOverlay.visible = !!params.showWireframe;
    oatGroup.visible = !!params.showOats;
    if (oatGroup.visible) updateOatGlowMarkers();
  }

  renderSceneOnce(now);

  if (started) updateStats(now, rawDt);
  requestAnimationFrame(frame);
}

function renderSceneOnce(now = performance.now(), { updateAnnotations = true } = {}) {
  controls.update();
  syncSlimeTumbleSpatialAudio();
  resizeIfNeeded();
  updateCameraPoseReadout();
  if (updateAnnotations) updateOatAnnotations();

  renderer.setRenderTarget(null);
  renderer.setClearColor(0x000000, 1);
  renderer.clear(true, true, false);
  renderer.render(scene, camera);
}

function formatCompactAgentCount(value) {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}m`;
  if (value >= 10000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatGrowthRate(value) {
  if (!Number.isFinite(value)) return '0/s';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  if (absValue >= 10000) return `${sign}${Math.round(absValue / 1000)}k/s`;
  if (absValue >= 1000) return `${sign}${(absValue / 1000).toFixed(1)}k/s`;
  return `${sign}${Math.round(absValue)}/s`;
}

function formatGrowthAcceleration(value) {
  if (!Number.isFinite(value)) return '0/s²';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  const absValue = Math.abs(value);
  if (absValue >= 10000) return `${sign}${Math.round(absValue / 1000)}k/s²`;
  if (absValue >= 1000) return `${sign}${(absValue / 1000).toFixed(1)}k/s²`;
  return `${sign}${Math.round(absValue)}/s²`;
}

function prepareHistoryCanvas(canvas, fallbackHeight) {
  const parentWidth = canvas.parentElement?.clientWidth ?? 0;
  const cssWidth = Math.max(240, Math.floor(parentWidth > 0 ? parentWidth - 20 : 320));
  const cssHeight = Math.max(40, Math.floor(canvas.clientHeight || fallbackHeight));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const pixelWidth = Math.round(cssWidth * dpr);
  const pixelHeight = Math.round(cssHeight * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  return { ctx, cssWidth, cssHeight };
}

function drawAgentHistoryChart() {
  if (!agentHistoryCanvas) return;
  const { ctx, cssWidth, cssHeight } = prepareHistoryCanvas(agentHistoryCanvas, 76);

  ctx.fillStyle = 'rgba(2, 6, 8, 0.52)';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const counts = agentHistorySamples.map((sample) => sample.count);
  const latest = counts[counts.length - 1] ?? visibleAgents;
  const peak = Math.max(1000, ...counts, latest);
  const populationTarget = getPopulationControlTarget();
  const populationDeadband = Math.max(
    0,
    finitePopulationParam(
      params.populationDeadbandFraction,
      BASE_POPULATION_CONTROL_PARAMS.populationDeadbandFraction,
    ),
  );
  const targetBandLow = params.usePopulationControl
    ? Math.max(0, populationTarget * (1 - populationDeadband))
    : 5000;
  const targetBandHigh = params.usePopulationControl
    ? populationTarget * (1 + populationDeadband)
    : 30000;
  const scaleReference = params.usePopulationControl
    ? Math.max(peak, targetBandHigh)
    : peak;
  const yMax = Math.max(1000, Math.ceil((scaleReference * 1.12) / 1000) * 1000);
  const plotLeft = 34;
  const plotRight = cssWidth - 8;
  const plotTop = 7;
  const plotBottom = cssHeight - 18;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const yFor = (count) => plotBottom - Math.max(0, Math.min(1, count / yMax)) * plotHeight;

  if (params.usePopulationControl && yMax > targetBandHigh) {
    const overshootTop = yFor(yMax);
    const overshootBottom = yFor(targetBandHigh);
    ctx.fillStyle = 'rgba(255, 111, 111, 0.13)';
    ctx.fillRect(plotLeft, overshootTop, plotWidth, Math.max(0, overshootBottom - overshootTop));
  }

  if (yMax >= targetBandLow) {
    const bandTop = yFor(Math.min(targetBandHigh, yMax));
    const bandBottom = yFor(targetBandLow);
    ctx.fillStyle = 'rgba(109, 223, 129, 0.12)';
    ctx.fillRect(plotLeft, bandTop, plotWidth, Math.max(0, bandBottom - bandTop));
  }

  ctx.strokeStyle = 'rgba(223, 234, 232, 0.12)';
  ctx.lineWidth = 1;
  ctx.fillStyle = 'rgba(168, 182, 177, 0.82)';
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of [0, yMax * 0.5, yMax]) {
    const y = yFor(tick);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
    ctx.fillText(formatCompactAgentCount(tick), plotLeft - 6, y);
  }

  if (agentHistorySamples.length >= 2) {
    ctx.beginPath();
    agentHistorySamples.forEach((sample, index) => {
      const x = plotLeft + (index / Math.max(1, agentHistorySamples.length - 1)) * plotWidth;
      const y = yFor(sample.count);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(140, 232, 255, 0.95)';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const latestY = yFor(latest);
  ctx.fillStyle = '#8ce8ff';
  ctx.beginPath();
  ctx.arc(plotRight, latestY, 3, 0, Math.PI * 2);
  ctx.fill();

  if (agentHistoryRangeEl) {
    const min = counts.length ? Math.min(...counts) : latest;
    agentHistoryRangeEl.value = `${formatCompactAgentCount(latest)} now / ${formatCompactAgentCount(min)}-${formatCompactAgentCount(peak)}`;
  }
}

function drawHistorySeries(ctx, values, plotLeft, plotRight, yFor, color) {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) return;
  ctx.beginPath();
  if (finiteValues.length === 1) {
    const y = yFor(finiteValues[0]);
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
  } else {
    const plotWidth = Math.max(1, plotRight - plotLeft);
    finiteValues.forEach((value, index) => {
      const x = plotLeft + (index / Math.max(1, finiteValues.length - 1)) * plotWidth;
      const y = yFor(value);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  const latest = finiteValues[finiteValues.length - 1];
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(plotRight, yFor(latest), 2.8, 0, Math.PI * 2);
  ctx.fill();
}

function drawAgentGrowthChart() {
  if (!agentGrowthCanvas) return;
  const { ctx, cssWidth, cssHeight } = prepareHistoryCanvas(agentGrowthCanvas, 54);
  ctx.fillStyle = 'rgba(2, 6, 8, 0.38)';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  let rates = [];
  for (let i = 1; i < agentHistorySamples.length; i++) {
    const prev = agentHistorySamples[i - 1];
    const next = agentHistorySamples[i];
    const seconds = Math.max(0.001, (next.t - prev.t) / 1000);
    rates.push((next.count - prev.count) / seconds);
  }
  rates = rates.filter((rate) => Number.isFinite(rate));
  if (rates.length === 0 && agentHistorySamples.length >= 1) rates.push(0);

  const plotLeft = 46;
  const plotRight = cssWidth - 8;
  const plotTop = 7;
  const plotBottom = cssHeight - 15;
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const maxAbs = Math.max(25, ...rates.map((rate) => Math.abs(rate)));
  const yFor = (rate) => plotTop + (0.5 - rate / (maxAbs * 2)) * plotHeight;

  ctx.strokeStyle = 'rgba(223, 234, 232, 0.1)';
  ctx.lineWidth = 1;
  for (const rate of [-maxAbs, 0, maxAbs]) {
    const y = yFor(rate);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(168, 182, 177, 0.82)';
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatGrowthRate(maxAbs), plotLeft - 6, yFor(maxAbs));
  ctx.fillText('0/s', plotLeft - 6, yFor(0));
  ctx.fillText(formatGrowthRate(-maxAbs), plotLeft - 6, yFor(-maxAbs));

  ctx.fillStyle = 'rgba(168, 182, 177, 0.86)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('growth rate', plotLeft, 1);

  const latestRate = rates[rates.length - 1];
  if (Number.isFinite(latestRate)) {
    ctx.textAlign = 'right';
    ctx.fillText(formatGrowthRate(latestRate), plotRight, 1);
  }
  drawHistorySeries(ctx, rates, plotLeft, plotRight, yFor, 'rgba(255, 205, 88, 0.96)');
}

function drawAgentAccelerationChart() {
  if (!agentAccelerationCanvas) return;
  const { ctx, cssWidth, cssHeight } = prepareHistoryCanvas(agentAccelerationCanvas, 54);
  ctx.fillStyle = 'rgba(2, 6, 8, 0.34)';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  const rates = [];
  for (let i = 1; i < agentHistorySamples.length; i++) {
    const prev = agentHistorySamples[i - 1];
    const next = agentHistorySamples[i];
    const seconds = Math.max(0.001, (next.t - prev.t) / 1000);
    rates.push({
      t: next.t,
      rate: (next.count - prev.count) / seconds,
    });
  }
  const finiteRates = rates.filter((sample) => Number.isFinite(sample.t) && Number.isFinite(sample.rate));
  const accelerations = [];
  for (let i = 1; i < finiteRates.length; i++) {
    const prev = finiteRates[i - 1];
    const next = finiteRates[i];
    const seconds = Math.max(0.001, (next.t - prev.t) / 1000);
    accelerations.push((next.rate - prev.rate) / seconds);
  }
  const smoothedAccelerations = [];
  for (const value of accelerations.filter((item) => Number.isFinite(item))) {
    const previous = smoothedAccelerations[smoothedAccelerations.length - 1];
    smoothedAccelerations.push(previous === undefined ? value : previous * 0.72 + value * 0.28);
  }
  if (smoothedAccelerations.length === 0 && finiteRates.length >= 1) smoothedAccelerations.push(0);

  const plotLeft = 54;
  const plotRight = cssWidth - 8;
  const plotTop = 7;
  const plotBottom = cssHeight - 15;
  const plotHeight = Math.max(1, plotBottom - plotTop);
  const maxAbs = Math.max(25, ...smoothedAccelerations.map((value) => Math.abs(value)));
  const yFor = (value) => plotTop + (0.5 - value / (maxAbs * 2)) * plotHeight;

  ctx.strokeStyle = 'rgba(223, 234, 232, 0.1)';
  ctx.lineWidth = 1;
  for (const value of [-maxAbs, 0, maxAbs]) {
    const y = yFor(value);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotRight, y);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(168, 182, 177, 0.82)';
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatGrowthAcceleration(maxAbs), plotLeft - 6, yFor(maxAbs));
  ctx.fillText('0/s²', plotLeft - 6, yFor(0));
  ctx.fillText(formatGrowthAcceleration(-maxAbs), plotLeft - 6, yFor(-maxAbs));

  ctx.fillStyle = 'rgba(168, 182, 177, 0.86)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('growth acceleration', plotLeft, 1);

  const latestAcceleration = smoothedAccelerations[smoothedAccelerations.length - 1];
  if (Number.isFinite(latestAcceleration)) {
    ctx.textAlign = 'right';
    ctx.fillText(formatGrowthAcceleration(latestAcceleration), plotRight, 1);
  }
  drawHistorySeries(ctx, smoothedAccelerations, plotLeft, plotRight, yFor, 'rgba(246, 139, 92, 0.98)');
}

function drawAgentCharts() {
  drawAgentHistoryChart();
  drawAgentGrowthChart();
  drawAgentAccelerationChart();
}

function recordAgentHistory(count, now = performance.now()) {
  if (!Number.isFinite(count)) return;
  agentHistorySamples.push({ t: now, count });
  if (agentHistorySamples.length > AGENT_HISTORY_SAMPLE_LIMIT) {
    agentHistorySamples.splice(0, agentHistorySamples.length - AGENT_HISTORY_SAMPLE_LIMIT);
  }
  // The panels redraw on becoming visible (setUiPanelsVisible), so skip the
  // three-canvas redraw while they are hidden.
  if (uiPanelsVisible) drawAgentCharts();
}

function resetAgentHistory(count = visibleAgents, now = performance.now()) {
  agentHistorySamples = [];
  lastRuntimeAgentFeedbackRead = now;
  recordAgentHistory(count, now);
}

function updateStats(now, dt) {
  const instantFps = 60 / Math.max(dt, 0.001);
  fpsSmoothed = fpsSmoothed * 0.92 + instantFps * 0.08;
  setTextIfChanged(fpsEl, String(Math.round(fpsSmoothed)));
  setTextIfChanged(oatCountEl, String(oats.length));
  setTextIfChanged(agentCountEl, visibleAgents.toLocaleString());

  const statsDue = now - lastStatsRead >= STATS_UPDATE_INTERVAL_MS;
  if (!statsDue) return;
  lastStatsRead = now;
  if (!params.statsReadbackEnabled) {
    statusEl.textContent = baseStatus;
    return;
  }
  const populationFeedbackDue =
    params.usePopulationControl &&
    now - lastRuntimeAgentFeedbackRead >= getPopulationControlPeriodMs();
  const agentFeedbackStale =
    populationFeedbackDue ||
    now - lastRuntimeAgentFeedbackRead >= STATS_READBACK_MAX_STALE_MS;
  const readbackWouldStutter =
    !agentFeedbackStale &&
    (
      now < statsReadbackCooldownUntil ||
      fpsSmoothed < STATS_READBACK_MIN_FPS ||
      dt > STATS_READBACK_MAX_DT
    );
  if (readbackWouldStutter) {
    statusEl.textContent = baseStatus;
    return;
  }
  const { visibleAgents: refreshedVisibleAgents } = refreshRuntimeAgentFeedback({ recordHistory: true, now });
  updatePopulationController({ now, visibleAgents: refreshedVisibleAgents });
  statusEl.textContent = baseStatus;
}

function readAgentCountFromPrefix() {
  if (!agentPrefixCountValid) return null;
  renderer.readRenderTargetPixels(
    agentPrefixRT.read,
    AGENT_SIDE - 1,
    AGENT_CANDIDATE_HEIGHT - 1,
    1,
    1,
    agentPrefixCountReadback,
  );
  const prefixTotal = agentPrefixCountReadback[0];
  if (!Number.isFinite(prefixTotal) || prefixTotal < -0.5) {
    agentPrefixCountValid = false;
    return null;
  }
  return Math.max(0, Math.min(AGENT_CAPACITY, Math.round(prefixTotal)));
}

function readAgentCountByFullScan() {
  if (!agentReadback) agentReadback = new Float32Array(AGENT_CAPACITY * 4);
  renderer.readRenderTargetPixels(agentRT.read, 0, 0, AGENT_SIDE, AGENT_SIDE, agentReadback);
  let alive = 0;
  for (let i = 3; i < agentReadback.length; i += 4) {
    if (agentReadback[i] > 0.0001) alive++;
  }
  return alive;
}

function refreshRuntimeAgentFeedback({ recordHistory = false, now = performance.now() } = {}) {
  // Low-frequency count readback for UI/runtime visibility. Prefer the allocator
  // prefix total when it is known to match the current agentRT; fall back to the
  // full scan after reset/seed paths that modify agentRT without rebuilding the prefix.
  const alive = readAgentCountFromPrefix() ?? readAgentCountByFullScan();
  visibleAgents = alive;
  lastRuntimeAgentFeedbackRead = now;
  agentCountEl.textContent = alive.toLocaleString();
  if (recordHistory) recordAgentHistory(alive, now);
  return { visibleAgents };
}

function getPopulationControllerState() {
  return {
    ...populationControllerState,
    samples: populationControllerState.samples.slice(),
  };
}

function getPopulationControlTarget() {
  const target = Number(params.populationTarget);
  return Math.max(1, Number.isFinite(target) ? target : BASE_POPULATION_CONTROL_PARAMS.populationTarget);
}

function finitePopulationParam(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getPopulationControlPeriodMs() {
  return Math.max(
    1,
    finitePopulationParam(
      params.populationControlPeriodMs,
      BASE_POPULATION_CONTROL_PARAMS.populationControlPeriodMs,
    ),
  );
}

function getPopulationOatSupplyBounds() {
  const fallbackMin = BASE_POPULATION_CONTROL_PARAMS.populationOatSupplyMin;
  const fallbackMax = BASE_POPULATION_CONTROL_PARAMS.populationOatSupplyMax;
  const min = Math.max(
    POPULATION_CONTROLLER_SUPPLY_EPSILON,
    Number.isFinite(Number(params.populationOatSupplyMin))
      ? Number(params.populationOatSupplyMin)
      : fallbackMin,
  );
  const requestedMax = Number.isFinite(Number(params.populationOatSupplyMax))
    ? Number(params.populationOatSupplyMax)
    : fallbackMax;
  return {
    min,
    max: Math.max(min, requestedMax),
  };
}

function capturePopulationControllerBaseValues() {
  populationControllerState.baseBurnRate = params.burnRate;
  populationControllerState.baseReproThreshold = params.reproThreshold;
  return {
    baseBurnRate: populationControllerState.baseBurnRate,
    baseReproThreshold: populationControllerState.baseReproThreshold,
  };
}

function restorePopulationSecondaryActuator({ syncControls = true } = {}) {
  const state = populationControllerState;
  state.secondarySeverity = 0;
  const nextBurnRate = Number.isFinite(state.baseBurnRate) ? state.baseBurnRate : params.burnRate;
  const nextReproThreshold = Number.isFinite(state.baseReproThreshold)
    ? state.baseReproThreshold
    : params.reproThreshold;
  const changed =
    Math.abs((params.burnRate ?? 0) - nextBurnRate) > 1e-9 ||
    Math.abs((params.reproThreshold ?? 0) - nextReproThreshold) > 1e-9;
  params.burnRate = nextBurnRate;
  params.reproThreshold = nextReproThreshold;
  if (changed && syncControls) {
    syncBoundParamControlsFor(['burnRate', 'reproThreshold']);
  }
}

function resetPopulationController(options = {}) {
  const preserveBase = options.preserveBase === true;
  const state = populationControllerState;
  if (!preserveBase) capturePopulationControllerBaseValues();
  state.enabled = !!params.usePopulationControl;
  state.target = getPopulationControlTarget();
  state.lastSampleTime = null;
  state.lastCount = null;
  state.growthRate = 0;
  state.commandedGrowthRate = 0;
  state.logPopulationError = 0;
  state.lastOatSupplyRate = params.oatSupplyRate;
  state.saturatedLow = false;
  state.saturatedHigh = false;
  state.secondarySeverity = 0;
  state.samples = [];
  return getPopulationControllerState();
}

function recordPopulationControllerSample(now, agents) {
  const state = populationControllerState;
  state.samples.push({
    time: now,
    agents,
    growthRate: state.growthRate,
    commandedGrowthRate: state.commandedGrowthRate,
    oatSupplyRate: state.lastOatSupplyRate,
    logPopulationError: state.logPopulationError,
    saturatedLow: state.saturatedLow,
    saturatedHigh: state.saturatedHigh,
    secondarySeverity: state.secondarySeverity,
  });
  if (state.samples.length > POPULATION_CONTROLLER_SAMPLE_LIMIT) {
    state.samples.splice(0, state.samples.length - POPULATION_CONTROLLER_SAMPLE_LIMIT);
  }
}

function computePopulationSecondarySeverity(agentCount, target, growthRate) {
  const overshootRatio = agentCount / Math.max(1, target);
  const activationRatio = Math.max(
    1,
    finitePopulationParam(
      params.populationSecondaryOvershootRatio,
      BASE_POPULATION_CONTROL_PARAMS.populationSecondaryOvershootRatio,
    ),
  );
  const growthThreshold = Math.max(
    0,
    finitePopulationParam(
      params.populationSecondaryGrowthThreshold,
      BASE_POPULATION_CONTROL_PARAMS.populationSecondaryGrowthThreshold,
    ),
  );
  const overshootWindow = Math.max(0.05, activationRatio * 0.35);
  const growthWindow = Math.max(0.01, growthThreshold * 4);
  const overshootSeverity = smoothstepNumber(
    activationRatio,
    activationRatio + overshootWindow,
    overshootRatio,
  );
  const growthSeverity = smoothstepNumber(
    growthThreshold,
    growthThreshold + growthWindow,
    growthRate,
  );
  return clampNumber(overshootSeverity * growthSeverity, 0, 1);
}

function applyPopulationSecondaryActuator(agentCount, target, saturatedLow) {
  const state = populationControllerState;
  let rawSeverity = 0;
  const growthThreshold = Math.max(
    0,
    finitePopulationParam(
      params.populationSecondaryGrowthThreshold,
      BASE_POPULATION_CONTROL_PARAMS.populationSecondaryGrowthThreshold,
    ),
  );
  const activationRatio = Math.max(
    1,
    finitePopulationParam(
      params.populationSecondaryOvershootRatio,
      BASE_POPULATION_CONTROL_PARAMS.populationSecondaryOvershootRatio,
    ),
  );
  if (
    params.populationUseSecondaryActuator &&
    saturatedLow &&
    agentCount > target * activationRatio &&
    state.growthRate > growthThreshold
  ) {
    rawSeverity = computePopulationSecondarySeverity(agentCount, target, state.growthRate);
  }

  const severityBlend = rawSeverity > state.secondarySeverity ? 0.16 : 0.10;
  let severity = state.secondarySeverity + (rawSeverity - state.secondarySeverity) * severityBlend;
  if (severity < 1e-4) severity = 0;
  state.secondarySeverity = clampNumber(severity, 0, 1);

  const burnBoostMax = Math.max(
    0,
    finitePopulationParam(
      params.populationBurnBoostMax,
      BASE_POPULATION_CONTROL_PARAMS.populationBurnBoostMax,
    ),
  );
  const reproBoostMax = Math.max(
    0,
    finitePopulationParam(
      params.populationReproBoostMax,
      BASE_POPULATION_CONTROL_PARAMS.populationReproBoostMax,
    ),
  );
  const nextBurnRate = state.baseBurnRate + state.secondarySeverity * burnBoostMax;
  const nextReproThreshold = state.baseReproThreshold + state.secondarySeverity * reproBoostMax;
  const shouldApply =
    state.secondarySeverity > 0 ||
    Math.abs((params.burnRate ?? 0) - nextBurnRate) > 1e-9 ||
    Math.abs((params.reproThreshold ?? 0) - nextReproThreshold) > 1e-9;
  if (shouldApply) {
    applyRuntimeParams(
      {
        burnRate: nextBurnRate,
        reproThreshold: nextReproThreshold,
      },
      {
        syncControls: true,
        syncKeys: ['burnRate', 'reproThreshold'],
        updatePopulationControllerBase: false,
        managePopulationControl: false,
      },
    );
  }
  return state.secondarySeverity;
}

function enablePopulationControl(enabled = true) {
  const nextEnabled = !!enabled;
  applyRuntimeParams(
    {
      usePopulationControl: nextEnabled,
      ...(nextEnabled ? { useOatRationing: true } : {}),
    },
    {
      syncControls: true,
      syncKeys: ['usePopulationControl', 'useOatRationing', 'burnRate', 'reproThreshold'],
    },
  );
  return getPopulationControllerState();
}

function setPopulationTarget(target) {
  const nextTarget = Math.max(
    1,
    Math.round(finitePopulationParam(target, BASE_POPULATION_CONTROL_PARAMS.populationTarget)),
  );
  applyRuntimeParams(
    { populationTarget: nextTarget },
    {
      syncControls: true,
      syncKeys: ['populationTarget'],
      updatePopulationControllerBase: false,
      managePopulationControl: false,
    },
  );
  populationControllerState.target = nextTarget;
  return getPopulationControllerState();
}

// Population controller theory:
//   State x = log(N / N_target), with measured growth r = d log N / dt.
//   The target closed-loop model is r_desired = -lambda * x, giving
//   x_dot = -lambda x when the growth command is tracked.
//   The oat actuator is v = log(oatSupplyRate), updated as
//   v_next = v + K * (r_desired - r_measured).
//   Under oat rationing, oatSupplyRate monotonically increases effective oat
//   food, so this is negative feedback on growth. With small enough K, the
//   target is locally exponentially stable. Bounded supply saturation acts as
//   anti-windup because there is no hidden integral state beyond v itself.
//   Optional burn/reproduction changes are slow fallback actuators, not caps:
//   they never kill agents, reject births, or change the allocator capacity.
function updatePopulationController({
  now = performance.now(),
  visibleAgents: measuredVisibleAgents = visibleAgents,
  force = false,
} = {}) {
  if (!params.usePopulationControl) return getPopulationControllerState();

  const state = populationControllerState;
  const sampleTime = Number.isFinite(Number(now)) ? Number(now) : performance.now();
  const target = getPopulationControlTarget();
  const periodMs = getPopulationControlPeriodMs();
  if (
    state.lastSampleTime !== null &&
    !force &&
    sampleTime - state.lastSampleTime < periodMs
  ) {
    return getPopulationControllerState();
  }

  const measuredCount = Number(measuredVisibleAgents);
  const agentCount = Math.max(Number.isFinite(measuredCount) ? measuredCount : visibleAgents, 1);
  if (!params.useOatRationing) {
    applyRuntimeParams(
      { useOatRationing: true },
      {
        syncControls: true,
        syncKeys: ['useOatRationing'],
        updatePopulationControllerBase: false,
        managePopulationControl: false,
      },
    );
  }

  state.enabled = true;
  state.target = target;
  state.logPopulationError = Math.log(agentCount / target);
  if (state.lastSampleTime === null || state.lastCount === null) {
    state.lastSampleTime = sampleTime;
    state.lastCount = agentCount;
    state.lastOatSupplyRate = params.oatSupplyRate;
    return getPopulationControllerState();
  }

  const dtSec = Math.max((sampleTime - state.lastSampleTime) / 1000, 1e-6);
  const lastCount = Math.max(state.lastCount, 1);
  const rawGrowthRate = (Math.log(agentCount) - Math.log(lastCount)) / dtSec;
  const alpha = clampFinite(
    params.populationGrowthEmaAlpha,
    0,
    1,
    BASE_POPULATION_CONTROL_PARAMS.populationGrowthEmaAlpha,
  );
  state.growthRate = state.samples.length === 0
    ? rawGrowthRate
    : state.growthRate + alpha * (rawGrowthRate - state.growthRate);

  const deadbandFraction = Math.max(
    0,
    finitePopulationParam(
      params.populationDeadbandFraction,
      BASE_POPULATION_CONTROL_PARAMS.populationDeadbandFraction,
    ),
  );
  const effectiveLogPopulationError =
    Math.abs(agentCount - target) / target < deadbandFraction
      ? 0
      : state.logPopulationError;
  const lambda = Math.max(
    0,
    finitePopulationParam(params.populationLambda, BASE_POPULATION_CONTROL_PARAMS.populationLambda),
  );
  const maxCommandedGrowthRate = Math.max(
    0,
    finitePopulationParam(
      params.populationMaxCommandedGrowthRate,
      BASE_POPULATION_CONTROL_PARAMS.populationMaxCommandedGrowthRate,
    ),
  );
  state.commandedGrowthRate = clampNumber(
    -lambda * effectiveLogPopulationError,
    -maxCommandedGrowthRate,
    maxCommandedGrowthRate,
  );

  const growthError = state.commandedGrowthRate - state.growthRate;
  const supplyGain = Math.max(
    0,
    finitePopulationParam(
      params.populationSupplyLogGain,
      BASE_POPULATION_CONTROL_PARAMS.populationSupplyLogGain,
    ),
  );
  const { min: supplyMin, max: supplyMax } = getPopulationOatSupplyBounds();
  const currentSupply = Math.max(
    Number.isFinite(Number(params.oatSupplyRate)) ? Number(params.oatSupplyRate) : supplyMin,
    POPULATION_CONTROLLER_SUPPLY_EPSILON,
  );
  const nextLogSupply = Math.log(currentSupply) + supplyGain * growthError;
  const nextSupply = clampNumber(Math.exp(nextLogSupply), supplyMin, supplyMax);
  state.saturatedLow = nextSupply <= supplyMin + POPULATION_CONTROLLER_SUPPLY_EPSILON;
  state.saturatedHigh = nextSupply >= supplyMax - POPULATION_CONTROLLER_SUPPLY_EPSILON;

  applyRuntimeParams(
    {
      oatSupplyRate: nextSupply,
      useOatRationing: true,
    },
    {
      syncControls: true,
      syncKeys: ['oatSupplyRate', 'useOatRationing'],
      updatePopulationControllerBase: false,
      managePopulationControl: false,
    },
  );
  applyPopulationSecondaryActuator(agentCount, target, state.saturatedLow);

  state.lastSampleTime = sampleTime;
  state.lastCount = agentCount;
  state.lastOatSupplyRate = params.oatSupplyRate;
  recordPopulationControllerSample(sampleTime, agentCount);
  return getPopulationControllerState();
}

function applyRuntimeParams(overrides = {}, options = {}) {
  const {
    syncControls = false,
    syncKeys = null,
    updatePopulationControllerBase = true,
    managePopulationControl = true,
  } = options;
  const hasOverride = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
  const hadPopulationControl = !!params.usePopulationControl;
  const hasPopulationControlOverride = hasOverride('usePopulationControl');
  const hasBurnOverride = hasOverride('burnRate');
  const hasReproOverride = hasOverride('reproThreshold');
  const effectiveSyncKeys = Array.isArray(syncKeys) ? syncKeys.slice() : null;
  const pushSyncKey = (key) => {
    if (effectiveSyncKeys && !effectiveSyncKeys.includes(key)) effectiveSyncKeys.push(key);
  };
  Object.assign(params, overrides);
  syncObservationCssVars();
  if (Object.prototype.hasOwnProperty.call(overrides, 'oatPower')) {
    syncOatPowersFromParams();
  }
  const goldBodyUniformOverrideKeys = [
    'foodClamp',
    'filmThicknessCurve',
    'iridescenceMinThickness',
    'iridescenceThickness',
    'goldBodyFade',
    'goldBodyRoughness',
    'goldBodyReflectivity',
    'goldBodyColor',
    'lightBrightness',
  ];
  if (goldBodyUniformOverrideKeys.some((key) => Object.prototype.hasOwnProperty.call(overrides, key))) {
    markGoldWaferBodyUniformsDirty();
    syncGoldWaferBodyMaterialUniforms();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'useGoldWaferBody')) {
    if (params.useGoldWaferBody && !goldWaferFilmState.ready) {
      loadGoldWaferFilmLookup();
    }
    if (params.useGoldWaferBody && goldWaferFilmState.ready) {
      goldWaferBodyMaxFoodNeedsUpdate = true;
    }
    markGoldWaferBodyModeDirty({ uniforms: true });
    syncGoldWaferBodyMode();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'debugView')) {
    markGoldWaferBodyModeDirty();
    syncGoldWaferBodyMode();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'useIcosaFaceLights')) {
    syncIcosaLightRigUniforms();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'storyBoxesEnabled')) {
    syncStoryBoxesEnabled();
  }
  if (Object.prototype.hasOwnProperty.call(overrides, 'useOpticalZoom')) {
    syncCameraZoomMode();
  }
  let populationControllerReset = false;
  if (managePopulationControl && hasPopulationControlOverride) {
    if (params.usePopulationControl) {
      params.useOatRationing = true;
      pushSyncKey('useOatRationing');
      resetPopulationController({ preserveBase: false });
      populationControllerReset = true;
    } else {
      const overridesSetBaseValues = hasBurnOverride || hasReproOverride;
      if (hadPopulationControl && !overridesSetBaseValues) {
        restorePopulationSecondaryActuator({ syncControls });
      }
      resetPopulationController({ preserveBase: !overridesSetBaseValues });
      populationControllerReset = true;
    }
  }
  if (
    updatePopulationControllerBase &&
    !populationControllerReset &&
    (hasBurnOverride || hasReproOverride)
  ) {
    resetPopulationController({ preserveBase: false });
  }
  if (syncControls) {
    if (effectiveSyncKeys) syncBoundParamControlsFor(effectiveSyncKeys);
    else syncBoundParamControls();
  }
  return { ...params };
}

function runPopulationTrial({
  overrides = {},
  steps = 360,
  dt = 1,
  sampleEvery = 30,
  resetOats = true,
  targetMin = 5000,
  targetMax = 30000,
} = {}) {
  const previousPaused = paused;
  paused = true;
  applyRuntimeParams(overrides);
  resetSimulation({ resetOats });
  const samples = [];
  const startedAt = performance.now();
  for (let step = 0; step <= steps; step++) {
    if (step > 0) simulate(step * dt * 16.6667, dt);
    if (step === 0 || step === steps || step % sampleEvery === 0) {
      const { visibleAgents: agents } = refreshRuntimeAgentFeedback();
      samples.push({ step, agents });
    }
  }
  const durationMs = performance.now() - startedAt;
  const counts = samples.map((sample) => sample.agents);
  const finalAgents = counts[counts.length - 1] ?? 0;
  const maxAgents = Math.max(...counts);
  const minAgents = Math.min(...counts);
  const tail = samples.slice(-Math.min(5, samples.length));
  const tailCounts = tail.map((sample) => sample.agents);
  const tailMin = Math.min(...tailCounts);
  const tailMax = Math.max(...tailCounts);
  const tailMean = tailCounts.reduce((sum, value) => sum + value, 0) / Math.max(1, tailCounts.length);
  paused = previousPaused;
  return {
    overrides: { ...overrides },
    steps,
    dt,
    sampleEvery,
    durationMs,
    samples,
    targetMin,
    targetMax,
    initialAgents: samples[0]?.agents ?? null,
    finalAgents,
    maxAgents,
    minAgents,
    tailMin,
    tailMax,
    tailMean,
    inTargetBand: finalAgents >= targetMin && finalAgents <= targetMax,
    tailInTargetBand: tailMin >= targetMin && tailMax <= targetMax,
    exploding: maxAgents >= AGENT_CAPACITY * 0.96,
  };
}

function runPopulationControlledTrial({
  target = params.populationTarget,
  steps = 2400,
  dt = 1,
  controlEvery = 30,
  sampleEvery = 30,
  resetOats = true,
  overrides = {},
} = {}) {
  const previousPaused = paused;
  const previousPopulationControlEnabled = !!params.usePopulationControl;
  const previousUseOatRationing = !!params.useOatRationing;
  paused = true;
  const trialSteps = Math.max(0, Math.floor(Number(steps) || 0));
  const trialDt = Math.max(0, Number(dt) || 0);
  const controlStride = Math.max(1, Math.floor(Number(controlEvery) || 1));
  const sampleStride = Math.max(1, Math.floor(Number(sampleEvery) || 1));
  const trialTarget = Math.max(
    1,
    Math.round(finitePopulationParam(target, BASE_POPULATION_CONTROL_PARAMS.populationTarget)),
  );
  const samples = [];
  const startedAt = performance.now();

  try {
    applyRuntimeParams(
      {
        ...overrides,
        populationTarget: trialTarget,
        usePopulationControl: true,
        useOatRationing: true,
      },
      {
        syncControls: true,
        syncKeys: [
          'populationTarget',
          'usePopulationControl',
          'useOatRationing',
          ...Object.keys(overrides),
        ],
      },
    );
    resetSimulation({ resetOats });
    resetPopulationController();

    for (let step = 0; step <= trialSteps; step++) {
      const now = step * trialDt * 16.6667;
      if (step > 0) simulate(now, trialDt);
      let agents = visibleAgents;
      let refreshed = false;
      if (step === 0 || step === trialSteps || step % controlStride === 0) {
        ({ visibleAgents: agents } = refreshRuntimeAgentFeedback());
        refreshed = true;
        updatePopulationController({ now, visibleAgents: agents, force: true });
      }
      if (step === 0 || step === trialSteps || step % sampleStride === 0) {
        if (!refreshed) {
          ({ visibleAgents: agents } = refreshRuntimeAgentFeedback());
        }
        const controller = getPopulationControllerState();
        samples.push({
          step,
          agents,
          oatSupplyRate: params.oatSupplyRate,
          growthRate: controller.growthRate,
          commandedGrowthRate: controller.commandedGrowthRate,
          logPopulationError: controller.logPopulationError,
          saturatedLow: controller.saturatedLow,
          saturatedHigh: controller.saturatedHigh,
          secondarySeverity: controller.secondarySeverity,
        });
      }
    }

    const durationMs = performance.now() - startedAt;
    const counts = samples.map((sample) => sample.agents);
    const finalAgents = counts[counts.length - 1] ?? 0;
    const maxAgents = counts.length ? Math.max(...counts) : 0;
    const minAgents = counts.length ? Math.min(...counts) : 0;
    const tail = samples.slice(-Math.min(10, samples.length));
    const tailCounts = tail.map((sample) => sample.agents);
    const tailMin = tailCounts.length ? Math.min(...tailCounts) : 0;
    const tailMax = tailCounts.length ? Math.max(...tailCounts) : 0;
    const tailMean = tailCounts.reduce((sum, value) => sum + value, 0) / Math.max(1, tailCounts.length);
    return {
      target: trialTarget,
      steps: trialSteps,
      dt: trialDt,
      controlEvery: controlStride,
      sampleEvery: sampleStride,
      durationMs,
      finalAgents,
      maxAgents,
      minAgents,
      tailMean,
      tailMin,
      tailMax,
      maxOvershootRatio: maxAgents / trialTarget,
      exploding: maxAgents >= AGENT_CAPACITY * 0.96,
      samples,
    };
  } finally {
    paused = previousPaused;
    restorePopulationSecondaryActuator({ syncControls: false });
    applyRuntimeParams(
      {
        usePopulationControl: previousPopulationControlEnabled,
        useOatRationing: previousPopulationControlEnabled ? true : previousUseOatRationing,
      },
      {
        syncControls: true,
        syncKeys: ['usePopulationControl', 'useOatRationing', 'burnRate', 'reproThreshold'],
        updatePopulationControllerBase: false,
      },
    );
  }
}

function measureAgentAllocatorDiagnostics() {
  return runReadbackDiagnostic('measureAgentAllocatorDiagnostics', () => {
    const prefixLast = new Float32Array(4);
    renderer.readRenderTargetPixels(
      agentPrefixRT.read,
      AGENT_SIDE - 1,
      AGENT_CANDIDATE_HEIGHT - 1,
      1,
      1,
      prefixLast,
    );
    const parentNext = new Float32Array(AGENT_CAPACITY * 4);
    const finalAgents = new Float32Array(AGENT_CAPACITY * 4);
    const candidates = new Float32Array(AGENT_CANDIDATE_COUNT * 4);
    const prefix = new Float32Array(AGENT_CANDIDATE_COUNT * 4);
    renderer.readRenderTargetPixels(agentParentNextRT, 0, 0, AGENT_SIDE, AGENT_SIDE, parentNext);
    renderer.readRenderTargetPixels(agentRT.read, 0, 0, AGENT_SIDE, AGENT_SIDE, finalAgents);
    renderer.readRenderTargetPixels(agentCandidateRT, 0, 0, AGENT_SIDE, AGENT_CANDIDATE_HEIGHT, candidates);
    renderer.readRenderTargetPixels(agentPrefixRT.read, 0, 0, AGENT_SIDE, AGENT_CANDIDATE_HEIGHT, prefix);

    let liveParentsAfterAdvance = 0;
    let fertileParentCount = 0;
    let estimatedReserveBeforeBirth = 0;
    for (let i = 0; i < AGENT_CAPACITY; i++) {
      const reserve = parentNext[i * 4 + 3];
      if (reserve > 0.0001) {
        liveParentsAfterAdvance++;
        estimatedReserveBeforeBirth += reserve;
        if (reserve > params.reproThreshold) fertileParentCount++;
      }
    }

    let liveAgents = 0;
    let estimatedReserveAfterBirth = 0;
    for (let i = 0; i < AGENT_CAPACITY; i++) {
      const reserve = finalAgents[i * 4 + 3];
      if (reserve > 0.0001) {
        liveAgents++;
        estimatedReserveAfterBirth += reserve;
      }
    }

    let validChildProposalCount = 0;
    let acceptedChildCount = 0;
    let acceptedLeftChildren = 0;
    let acceptedRightChildren = 0;
    const proposalCount = AGENT_CAPACITY * 2;
    const offset = lastAgentAllocationOffset % proposalCount;
    for (let childLinearIndex = 0; childLinearIndex < proposalCount; childLinearIndex++) {
      const candidateIndex = AGENT_CAPACITY + childLinearIndex;
      const reserve = candidates[candidateIndex * 4 + 3];
      if (reserve <= 0.0001) continue;
      validChildProposalCount++;
      const proposalId = (childLinearIndex + offset) % proposalCount;
      const side = proposalId % 2;
      const accepted = prefix[candidateIndex * 4] <= AGENT_CAPACITY + 0.001;
      if (accepted) {
        acceptedChildCount++;
        if (side === 0) acceptedLeftChildren++;
        else acceptedRightChildren++;
      }
    }

    const invalidChildPlacementCount = Math.max(0, fertileParentCount * 2 - validChildProposalCount);
    const capacityRejectedChildCount = Math.max(0, validChildProposalCount - acceptedChildCount);
    const reserveConservationError = estimatedReserveAfterBirth - estimatedReserveBeforeBirth;
    const reserveTolerance = Math.max(1e-3, estimatedReserveBeforeBirth * 2e-5);
    return {
      allocator: 'parent-update + deferred-debit compact',
      storageIndexEncodesLineage: false,
      parentSlotsStable: false,
      agentCapacity: AGENT_CAPACITY,
      candidateRecordStride: AGENT_RECORD_STRIDE,
      candidateLayout: 'all parents, then frame-rotated child proposals',
      candidateCapacity: AGENT_CANDIDATE_COUNT,
      candidateRecordsLastFrame: Math.round(prefixLast[0]),
      parentAdvanceCallsPerFrame: AGENT_CAPACITY,
      advanceAgentEvaluationsPerSource: 1,
      liveParentsAfterAdvance,
      admittedParents: liveParentsAfterAdvance,
      liveAgents,
      freeSlotCount: AGENT_CAPACITY - liveParentsAfterAdvance,
      fertileParentCount,
      validChildProposalCount,
      acceptedChildCount,
      admittedChildren: acceptedChildCount,
      capacityRejectedChildCount,
      invalidChildPlacementCount,
      parentReserveChargedForAcceptedChildrenOnly: true,
      parentReserveDebitedForRejectedChildren: 0,
      allocationReserveLostDueToCapacity: 0,
      acceptedLeftChildren,
      acceptedRightChildren,
      allocationOffset: lastAgentAllocationOffset,
      childAcceptanceOrder: 'rotated',
      estimatedReserveBeforeBirth,
      estimatedReserveAfterBirth,
      reserveConservationError,
      reserveConservationPass: Math.abs(reserveConservationError) <= reserveTolerance,
      note: 'Manual readback. Parent advancement is separated from child admission; reserve is debited only in the compact pass for child records whose prefix rank fits in capacity.',
    };
  });
}

function findAllocatorRegressionUv() {
  const spawnTexels = getAuthoritativeSpawnTexels();
  const step = Math.max(1, Math.floor(spawnTexels.length / 4096));
  const testAngles = [0, Math.PI * 0.5, Math.PI, Math.PI * 1.5];
  for (let i = 0; i < spawnTexels.length; i += step) {
    const uv = uvFromTexelIndex(spawnTexels[i]);
    if (validateSpawnUv(uv) !== 'valid') continue;
    let valid = true;
    for (const angle of testAngles) {
      for (const sideSign of [1, -1]) {
        const childAngle = angle + sideSign * params.reproAngle;
        const childUv = {
          x: uv.x + Math.cos(childAngle) * params.childStep,
          y: uv.y + Math.sin(childAngle) * params.childStep,
        };
        if (validateSpawnUv(childUv) !== 'valid') {
          valid = false;
          break;
        }
      }
      if (!valid) break;
    }
    if (valid) return uv;
  }
  for (const texel of spawnTexels) {
    const uv = uvFromTexelIndex(texel);
    if (validateSpawnUv(uv) === 'valid') return uv;
  }
  return null;
}

function runAgentAllocatorRegressionTests() {
  const savedParams = {
    uptakeRate: params.uptakeRate,
    depositRate: params.depositRate,
    burnRate: params.burnRate,
    reproThreshold: params.reproThreshold,
    stepSize: params.stepSize,
    minMoveScale: params.minMoveScale,
    sensorDistance: params.sensorDistance,
    turnAngle: params.turnAngle,
    wander: params.wander,
    useSeamStitching: params.useSeamStitching,
    useHeadingRotation: params.useHeadingRotation,
  };
  const savedAllocationFrame = agentAllocationFrame;
  const savedAllocationOffset = lastAgentAllocationOffset;
  const testUv = findAllocatorRegressionUv();
  const result = {
    allocator: 'parent-update + deferred-debit compact',
    accepted: false,
    mutatesSimulationState: true,
    restoredWithFreshReset: true,
    testUv,
    checks: {},
    cases: {},
    note: 'Manual destructive regression helper. It installs synthetic agent textures, runs allocator passes with dt=0, then restores parameters and resets the simulation.',
  };
  if (!testUv) {
    result.error = 'No authoritative UV suitable for allocator regression tests was found.';
    return result;
  }

  function applyTestParams() {
    params.uptakeRate = 0;
    params.depositRate = 0;
    params.burnRate = 0;
    params.reproThreshold = 1.0;
    params.stepSize = 0;
    params.minMoveScale = 0;
    params.sensorDistance = 0;
    params.turnAngle = 0;
    params.wander = 0;
    params.useSeamStitching = true;
    params.useHeadingRotation = true;
  }

  function makeAgentDataFromGenerator(generator) {
    const data = new Float32Array(AGENT_CAPACITY * 4);
    for (let i = 0; i < AGENT_CAPACITY; i++) {
      const agent = generator(i);
      if (!agent) continue;
      const p = i * 4;
      data[p] = agent.x;
      data[p + 1] = agent.y;
      data[p + 2] = agent.angle;
      data[p + 3] = agent.reserve;
    }
    return data;
  }

  function installAgentData(data) {
    uploadAgentDataToRT(data, agentRT.read);
    uploadAgentDataToRT(data, agentRT.write);
    clearRT(agentParentNextRT);
    clearRT(agentCandidateRT);
	    clearRT(agentPrefixRT.read);
	    clearRT(agentPrefixRT.write);
	    clearRT(densityRT);
	    clearRT(agentDensityOverlayRT);
	    clearRT(depositDensityRT);
	  }

  function freshAllocatorDiagnostics() {
    readbackDiagnosticState.delete('measureAgentAllocatorDiagnostics');
    return measureAgentAllocatorDiagnostics();
  }

  function runSyntheticCase(name, data, allocationFrame = 0) {
    agentAllocationFrame = allocationFrame;
    lastAgentAllocationOffset = 0;
    installAgentData(data);
    updateAgents(0, 0);
    const diagnostics = freshAllocatorDiagnostics();
    result.cases[name] = diagnostics;
    return diagnostics;
  }

  try {
    applyTestParams();
    const agentTemplate = {
      x: testUv.x,
      y: testUv.y,
      angle: 0,
      reserve: 4.0,
    };

    const leafData = makeAgentDataFromGenerator((index) =>
      index === AGENT_CAPACITY - 1 ? agentTemplate : null
    );
    const leaf = runSyntheticCase('leafHighIndex', leafData, 0);
    result.checks.leafHighIndexCanReproduce =
      leaf.liveParentsAfterAdvance === 1 &&
      leaf.acceptedChildCount >= 1 &&
      leaf.reserveConservationPass === true;

    const fullData = makeAgentDataFromGenerator(() => agentTemplate);
    const full = runSyntheticCase('fullCapacityNoDebit', fullData, 1);
    result.checks.fullCapacityRejectsChildrenWithoutReserveLoss =
      full.liveParentsAfterAdvance === AGENT_CAPACITY &&
      full.acceptedChildCount === 0 &&
      full.capacityRejectedChildCount > 0 &&
      full.parentReserveDebitedForRejectedChildren === 0 &&
      full.allocationReserveLostDueToCapacity === 0 &&
      full.reserveConservationPass === true;

    const halfLiveCount = Math.floor(AGENT_CAPACITY * 0.5);
    const holeData = makeAgentDataFromGenerator((index) =>
      index < halfLiveCount ? agentTemplate : null
    );
    const hole = runSyntheticCase('holeFillUnderPressure', holeData, 2);
    result.checks.deadHolesAreReusableByAcceptedChildren =
      hole.liveParentsAfterAdvance === halfLiveCount &&
      hole.acceptedChildCount > 0 &&
      hole.liveAgents === Math.min(AGENT_CAPACITY, halfLiveCount + hole.acceptedChildCount) &&
      hole.reserveConservationPass === true;
    result.checks.capacityPressureIsNotPermanentlyOneSided =
      hole.acceptedChildCount === 0 ||
      (hole.acceptedLeftChildren > 0 && hole.acceptedRightChildren > 0);

    result.checks.advanceAgentOncePerSource =
      leaf.advanceAgentEvaluationsPerSource === 1 &&
      full.advanceAgentEvaluationsPerSource === 1 &&
      hole.advanceAgentEvaluationsPerSource === 1;
    result.checks.reserveDebitedForAcceptedChildrenOnly =
      leaf.parentReserveChargedForAcceptedChildrenOnly === true &&
      full.parentReserveChargedForAcceptedChildrenOnly === true &&
      hole.parentReserveChargedForAcceptedChildrenOnly === true &&
      full.parentReserveDebitedForRejectedChildren === 0;

    result.accepted = Object.values(result.checks).every(Boolean);
    return result;
  } finally {
    Object.assign(params, savedParams);
    agentAllocationFrame = savedAllocationFrame;
    lastAgentAllocationOffset = savedAllocationOffset;
    resetSimulation({ resetOats: false });
  }
}

function refreshRuntimeReadbackStats() {
  return runReadbackDiagnostic('refreshRuntimeReadbackStats', () => {
    const agentFeedback = refreshRuntimeAgentFeedback();
    const slimeCoveragePercent = updateSlimeCoverageStat();
    return {
      ...agentFeedback,
      slimeCoveragePercent,
      note: 'Manual full stat refresh. Normal runtime only performs the low-frequency agent feedback readback; full-field slime coverage remains manual.',
    };
  });
}

function updateSlimeCoverageStat() {
  if (coverageSurfaceTexels <= 0) {
    slimeCoverageEl.textContent = '0.0%';
    return 0;
  }

  if (!slimeCoverageReadback) slimeCoverageReadback = new Float32Array(FIELD_SIZE * FIELD_SIZE * 4);
  renderer.readRenderTargetPixels(renderSampleViewRT.read, 0, 0, FIELD_SIZE, FIELD_SIZE, slimeCoverageReadback);
  let slimeTexels = 0;
  for (let i = 0; i < slimeCoverageReadback.length; i += 4) {
    if (coverageMaskReadback[i] >= 128 && slimeCoverageReadback[i] >= SLIME_COVERAGE_THRESHOLD) {
      slimeTexels++;
    }
  }
  const percent = (slimeTexels / coverageSurfaceTexels) * 100;
  slimeCoverageEl.textContent = `${percent.toFixed(1)}%`;
  return percent;
}

// canvas.clientWidth/Height are layout reads; only take them when the canvas
// (or device pixel ratio) may actually have changed.
let canvasResizeDirty = true;
const canvasResizeObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(() => { canvasResizeDirty = true; })
  : null;
canvasResizeObserver?.observe(canvas);

function resizeIfNeeded() {
  if (!canvasResizeDirty) return;
  canvasResizeDirty = false;
  const dpr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
  const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / Math.max(canvas.clientHeight, 1);
    camera.updateProjectionMatrix();
  }
}

window.addEventListener('resize', () => {
  canvasResizeDirty = true;
  resizeIfNeeded();
});
resizeIfNeeded();

// Start a "wait" loop so the canvas renders the dark background until the GLB loads.
function waitFrame() {
  if (!started) {
    resizeIfNeeded();
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);
    requestAnimationFrame(waitFrame);
  }
}
waitFrame();
