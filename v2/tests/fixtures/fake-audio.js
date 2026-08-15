export class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }

  cancelScheduledValues(time) { this.events.push({ type: 'cancel', time }); }
  setValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'set', value, time });
  }
  setTargetAtTime(value, time, timeConstant) {
    this.value = value;
    this.events.push({ type: 'target', value, time, timeConstant });
  }
  linearRampToValueAtTime(value, time) {
    this.value = value;
    this.events.push({ type: 'linear', value, time });
  }
}

class FakeNode {
  constructor(kind) {
    this.kind = kind;
    this.connections = [];
    this.disconnectCount = 0;
  }

  connect(destination) {
    this.connections.push(destination);
    return destination;
  }

  disconnect() {
    this.connections = [];
    this.disconnectCount++;
  }
}

class FakeBufferSource extends FakeNode {
  constructor() {
    super('bufferSource');
    this.startCalls = [];
    this.stopCalls = [];
    this.listeners = new Map();
    this.loop = false;
  }

  start(...args) { this.startCalls.push(args); }
  stop(...args) { this.stopCalls.push(args); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  end() { this.listeners.get('ended')?.(); }
}

function paramNode(kind, fields) {
  const node = new FakeNode(kind);
  for (const [field, initialValue] of Object.entries(fields)) node[field] = new FakeAudioParam(initialValue);
  return node;
}

export class FakeAudioContext {
  constructor({ sampleRate = 100, decodeDurations = [30], outputTimestamp = null } = {}) {
    this.currentTime = 0;
    this.sampleRate = sampleRate;
    this.state = 'suspended';
    this.resumeCalls = 0;
    this.destination = new FakeNode('destination');
    this.createdNodes = [];
    this.decodeDurations = [...decodeDurations];
    this.outputTimestamp = outputTimestamp;
    this.listener = paramNode('listener', {
      positionX: 0, positionY: 0, positionZ: 0,
      forwardX: 0, forwardY: 0, forwardZ: -1,
      upX: 0, upY: 1, upZ: 0,
    });
  }

  resume() {
    this.resumeCalls++;
    this.state = 'running';
    return Promise.resolve();
  }

  createGain() { return this.remember(paramNode('gain', { gain: 1 })); }
  createDynamicsCompressor() {
    return this.remember(paramNode('compressor', {
      threshold: -24, knee: 30, ratio: 12, attack: 0.003, release: 0.25,
    }));
  }
  createBufferSource() { return this.remember(new FakeBufferSource()); }
  createPanner() {
    return this.remember(paramNode('panner', { positionX: 0, positionY: 0, positionZ: 0 }));
  }
  createBiquadFilter() {
    return this.remember(paramNode('biquad', { frequency: 350, Q: 1 }));
  }
  createConvolver() { return this.remember(new FakeNode('convolver')); }
  createBuffer(numberOfChannels, length, sampleRate) {
    const channelData = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
    return {
      numberOfChannels,
      length,
      sampleRate,
      getChannelData: (channel) => channelData[channel],
    };
  }
  decodeAudioData() {
    return Promise.resolve({ duration: this.decodeDurations.shift() ?? 30 });
  }
  getOutputTimestamp() { return this.outputTimestamp; }
  remember(node) {
    this.createdNodes.push(node);
    return node;
  }
}

export function createFakeTimers() {
  let nextId = 1;
  const intervals = new Map();
  const timeouts = new Map();
  const idleCallbacks = new Map();
  return {
    intervals,
    timeouts,
    idleCallbacks,
    setInterval(callback, delay) {
      const id = nextId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback, delay) {
      const id = nextId++;
      timeouts.set(id, { callback, delay });
      return id;
    },
    requestIdleCallback(callback, options) {
      const id = nextId++;
      idleCallbacks.set(id, { callback, options });
      return id;
    },
  };
}

export function successfulFetch() {
  return Promise.resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
}
