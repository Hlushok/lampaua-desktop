/* global gpuGate */
async function start() {
  const config = await gpuGate.config();
  const adapter = await navigator.gpu?.requestAdapter({
    powerPreference: "low-power",
  });
  if (!adapter || adapter.isFallbackAdapter)
    throw new Error("Hardware WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const canvas = document.querySelector("canvas");
  canvas.width = config.width;
  canvas.height = config.height;
  const context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({
    device,
    format,
    alphaMode: "opaque",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  const shader = device.createShaderModule({
    code: `
    struct Output { @builtin(position) position: vec4f, @location(0) uv: vec2f }
    @vertex fn vertex(@builtin(vertex_index) index: u32) -> Output {
      var positions = array<vec2f, 3>(vec2f(-1,-1), vec2f(-1,3), vec2f(3,-1));
      var out: Output;
      let p = positions[index];
      out.position = vec4f(p,0,1);
      out.uv = vec2f(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
      return out;
    }
    @group(0) @binding(0) var video: texture_external;
    @group(0) @binding(1) var sampling: sampler;
    @fragment fn fragment(in: Output) -> @location(0) vec4f {
      return textureSampleBaseClampToEdge(video, sampling, in.uv);
    }
  `,
  });
  const pipeline = await device.createRenderPipelineAsync({
    layout: "auto",
    vertex: { module: shader, entryPoint: "vertex" },
    fragment: { module: shader, entryPoint: "fragment", targets: [{ format }] },
    primitive: { topology: "triangle-list" },
  });
  const sampler = device.createSampler({
    minFilter: "nearest",
    magFilter: "nearest",
  });
  const readers = Array.from({ length: 3 }, () => ({
    busy: false,
    buffer: device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }),
  }));
  let rafFrames = 0;
  let currentSequence = 0;
  let lastRafSequence = 0;
  let heartbeatRunning = true;
  let displayInterval = 1000 / 60;
  let playerId;
  let generation;
  let sourceAnchor;
  let displayAnchor;
  const frameQueue = [];
  const raf = (now) => {
    rafFrames++;
    if (displayAnchor === undefined && frameQueue.length >= 2) {
      sourceAnchor = frameQueue[0].metadata.targetTimeNs;
      displayAnchor = now;
    }
    if (
      frameQueue.length &&
      displayAnchor !== undefined &&
      displayAnchor +
        (frameQueue[0].metadata.targetTimeNs - sourceAnchor) / 1e6 <=
        now + displayInterval / 2
    ) {
      const entry = frameQueue.shift();
      try {
        drawFrame(entry.frame, entry.metadata, entry.receivedAt);
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }
    if (currentSequence !== lastRafSequence) {
      lastRafSequence = currentSequence;
      gpuGate.report({
        type: "raf",
        sequence: currentSequence,
        at: performance.now(),
      });
    }
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const baselineStart = performance.now();
  await new Promise((resolve) =>
    setTimeout(resolve, config.lifecycle ? 100 : 2000),
  );
  const idleRafFps = (rafFrames * 1000) / (performance.now() - baselineStart);
  displayInterval = 1000 / idleRafFps;
  setInterval(() => {
    gpuGate.report({ type: "ui", frames: rafFrames, at: performance.now() });
    rafFrames = 0;
  }, 1000);
  const heartbeat = async () => {
    while (heartbeatRunning) {
      const began = performance.now();
      await gpuGate.heartbeat();
      gpuGate.report({
        type: "heartbeat",
        latencyMs: performance.now() - began,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  void heartbeat().catch((error) =>
    gpuGate.report({ type: "error", message: error.message }),
  );
  device.lost.then((info) => {
    heartbeatRunning = false;
    gpuGate.report({
      type: "error",
      message: `WebGPU device lost: ${info.reason}`,
    });
  });
  function drawFrame(frame, metadata, receivedAt) {
    const reader = readers.find((value) => !value.busy);
    if (reader) reader.busy = true;
    else
      gpuGate.report({ type: "readback-skipped", sequence: metadata.sequence });
    const external = device.importExternalTexture({ source: frame });
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: external },
        { binding: 1, resource: sampler },
      ],
    });
    const output = context.getCurrentTexture();
    const commands = device.createCommandEncoder();
    const pass = commands.beginRenderPass({
      colorAttachments: [
        {
          view: output.createView(),
          loadOp: "clear",
          storeOp: "store",
          clearValue: [0, 0, 0, 1],
        },
      ],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
    pass.end();
    if (reader)
      commands.copyTextureToBuffer(
        { texture: output },
        { buffer: reader.buffer, bytesPerRow: 256 },
        [1, 1],
      );
    device.queue.submit([commands.finish()]);
    currentSequence = metadata.sequence;
    const submittedAt = performance.now();
    if (!reader) return;
    // Readback verifies GPU pixels but does not hold up frame release or the next submit.
    void reader.buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const bytes = new Uint8Array(reader.buffer.getMappedRange());
        const sequence = format.startsWith("bgra")
          ? bytes[2] | (bytes[1] << 8) | (bytes[0] << 16)
          : bytes[0] | (bytes[1] << 8) | (bytes[2] << 16);
        gpuGate.report({
          type: "pixel",
          sequence: metadata.sequence,
          decodedSequence: sequence,
          generation: metadata.generation,
          receivedAt,
          submittedAt,
          readbackAt: performance.now(),
          targetTimeNs: metadata.targetTimeNs,
        });
        reader.buffer.unmap();
      })
      .catch((error) =>
        gpuGate.report({ type: "error", message: error.message }),
      )
      .finally(() => {
        reader.busy = false;
      });
  }
  gpuGate.onFrame(
    (frame, metadata) =>
      new Promise((resolve, reject) => {
        if (config.callbackFailure) {
          reject(new Error("Intentional frame callback failure"));
          return;
        }
        if (
          playerId !== metadata.playerId ||
          generation !== metadata.generation
        ) {
          for (const stale of frameQueue.splice(0)) stale.resolve();
          playerId = metadata.playerId;
          generation = metadata.generation;
          sourceAnchor = displayAnchor = undefined;
        }
        if (frameQueue.length >= 3) {
          reject(new Error("Bounded presentation queue is full"));
          return;
        }
        frameQueue.push({
          frame,
          metadata,
          receivedAt: performance.now(),
          resolve,
          reject,
        });
      }),
  );
  await gpuGate.ready({
    idleRafFps,
    adapter: {
      vendor: adapter.info.vendor,
      architecture: adapter.info.architecture,
      description: adapter.info.description,
    },
    format,
    visibility: document.visibilityState,
  });
}
start().catch((error) =>
  gpuGate.report({ type: "error", message: error.message }),
);
