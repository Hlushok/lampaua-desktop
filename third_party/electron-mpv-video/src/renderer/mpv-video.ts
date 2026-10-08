import type { MpvPlayerSession, PlayerEvent, PlayerFrame, RenderMode } from '../shared/types.js';


interface FrameRenderer {
  readonly name: string;
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  draw(frame: PlayerFrame): void;
}

interface SharedFrameRenderer {
  readonly name: string;
  readonly canvas: HTMLCanvasElement;
  resize(width: number, height: number): void;
  drawVideoFrame(frame: VideoFrame): Promise<void>;
}

class Canvas2DRenderer implements FrameRenderer {
  readonly name = 'Canvas 2D';
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.ctx = ctx;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  draw(frame: PlayerFrame) {
    this.resize(frame.width, frame.height);
    const image = new ImageData(new Uint8ClampedArray(frame.rgba), frame.width, frame.height);
    this.ctx.putImageData(image, 0, 0);
  }
}

class WebGLUploadRenderer implements FrameRenderer {
  readonly name = 'WebGL upload';
  readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly texture: WebGLTexture;
  private readonly vao: WebGLVertexArrayObject;
  private readonly samplerLocation: WebGLUniformLocation;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;

    const program = this.createProgram(
      `#version 300 es
      in vec2 a_position;
      in vec2 a_texCoord;
      out vec2 v_texCoord;
      void main() {
        gl_Position = vec4(a_position, 0.0, 1.0);
        v_texCoord = a_texCoord;
      }`,
      `#version 300 es
      precision mediump float;
      uniform sampler2D u_frame;
      in vec2 v_texCoord;
      out vec4 outColor;
      void main() {
        outColor = texture(u_frame, v_texCoord);
      }`,
    );

    const vertices = new Float32Array([
      -1,  1, 0, 0,
      -1, -1, 0, 1,
       1,  1, 1, 0,
       1, -1, 1, 1,
    ]);

    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    const samplerLocation = gl.getUniformLocation(program, 'u_frame');
    if (!vao || !buffer || !texture || !samplerLocation) {
      throw new Error('Failed to initialize WebGL resources');
    }

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    const positionLocation = gl.getAttribLocation(program, 'a_position');
    const texCoordLocation = gl.getAttribLocation(program, 'a_texCoord');
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(texCoordLocation);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 16, 8);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.uniform1i(samplerLocation, 0);

    this.texture = texture;
    this.vao = vao;
    this.samplerLocation = samplerLocation;
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.gl.viewport(0, 0, width, height);
    }
  }

  draw(frame: PlayerFrame) {
    const gl = this.gl;
    this.resize(frame.width, frame.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      frame.width,
      frame.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(frame.rgba),
    );
    gl.uniform1i(this.samplerLocation, 0);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  private createShader(type: number, source: string) {
    const shader = this.gl.createShader(type);
    if (!shader) throw new Error('Failed to create WebGL shader');
    this.gl.shaderSource(shader, source);
    this.gl.compileShader(shader);
    if (!this.gl.getShaderParameter(shader, this.gl.COMPILE_STATUS)) {
      const log = this.gl.getShaderInfoLog(shader) || 'Unknown shader error';
      this.gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  private createProgram(vertexSource: string, fragmentSource: string) {
    const vertex = this.createShader(this.gl.VERTEX_SHADER, vertexSource);
    const fragment = this.createShader(this.gl.FRAGMENT_SHADER, fragmentSource);
    const program = this.gl.createProgram();
    if (!program) throw new Error('Failed to create WebGL program');
    this.gl.attachShader(program, vertex);
    this.gl.attachShader(program, fragment);
    this.gl.linkProgram(program);
    this.gl.deleteShader(vertex);
    this.gl.deleteShader(fragment);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const log = this.gl.getProgramInfoLog(program) || 'Unknown program error';
      this.gl.deleteProgram(program);
      throw new Error(log);
    }
    return program;
  }
}

class SharedTextureWebGpuRenderer implements SharedFrameRenderer {
  readonly name = 'Shared texture';
  readonly canvas: HTMLCanvasElement;
  private ready: Promise<void>;
  private device: any = null;
  private context: any = null;
  private pipeline: any = null;
  private sampler: any = null;
  private format = 'bgra8unorm';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ready = this.init();
  }

  resize(width: number, height: number) {
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  async prepare() {
    await this.ready;
  }

  async drawVideoFrame(frame: VideoFrame) {
    await this.ready;
    if (!this.device || !this.context || !this.pipeline || !this.sampler) return;
    this.resize(frame.displayWidth || frame.codedWidth, frame.displayHeight || frame.codedHeight);
    const externalTexture = this.device.importExternalTexture({ source: frame });
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: externalTexture },
      ],
    });
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(6);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
    // The preload releases the shared frame when this callback resolves.
    await this.device.queue.onSubmittedWorkDone();
  }

  private async init() {
    const gpu = (navigator as any).gpu;
    if (!gpu) throw new Error('WebGPU is not available');
    const adapter = await gpu.requestAdapter();
    if (!adapter) throw new Error('No WebGPU adapter available');
    this.device = await adapter.requestDevice();
    this.context = this.canvas.getContext('webgpu');
    if (!this.context) throw new Error('WebGPU canvas context is not available');
    this.format = gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque',
    });
    this.sampler = this.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: this.device.createShaderModule({
          code: `
            struct VertexOut {
              @builtin(position) position: vec4f,
              @location(0) uv: vec2f,
            }

            @vertex
            fn main(@builtin(vertex_index) index: u32) -> VertexOut {
              var positions = array<vec2f, 6>(
                vec2f(-1.0, -1.0),
                vec2f( 1.0, -1.0),
                vec2f(-1.0,  1.0),
                vec2f(-1.0,  1.0),
                vec2f( 1.0, -1.0),
                vec2f( 1.0,  1.0)
              );
              var uvs = array<vec2f, 6>(
                vec2f(0.0, 0.0),
                vec2f(1.0, 0.0),
                vec2f(0.0, 1.0),
                vec2f(0.0, 1.0),
                vec2f(1.0, 0.0),
                vec2f(1.0, 1.0)
              );
              var out: VertexOut;
              out.position = vec4f(positions[index], 0.0, 1.0);
              out.uv = uvs[index];
              return out;
            }
          `,
        }),
        entryPoint: 'main',
      },
      fragment: {
        module: this.device.createShaderModule({
          code: `
            @group(0) @binding(0) var videoSampler: sampler;
            @group(0) @binding(1) var videoTexture: texture_external;

            @fragment
            fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
              return textureSampleBaseClampToEdge(videoTexture, videoSampler, uv);
            }
          `,
        }),
        entryPoint: 'main',
        targets: [{ format: this.format }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });
  }
}

export class MpvVideoElement extends HTMLElement {
  static observedAttributes = ['src', 'loop', 'volume', 'render-mode'];

  private readonly surfaceRoot = this.attachShadow({ mode: 'open' });
  private player: MpvPlayerSession | null = null;
  private canvas2d = document.createElement('canvas');
  private webglCanvas = document.createElement('canvas');
  private sharedCanvas = document.createElement('canvas');
  private canvasRenderer: Canvas2DRenderer | null = null;
  private webglRenderer: WebGLUploadRenderer | null = null;
  private sharedRenderer: SharedTextureWebGpuRenderer | null = null;
  private activeRenderer: FrameRenderer | null = null;
  private activeSharedRenderer: SharedFrameRenderer | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private disposers: Array<() => void> = [];
  private ready: Promise<void> | null = null;
  private destroying: Promise<void> | null = null;
  private disposed = false;
  private renderMode: RenderMode = 'shared-texture';
  private status = 'Idle';
  private openedSource = '';
  private state = {
    time: 0,
    duration: 0,
    width: 0,
    height: 0,
    codec: '-',
    fps: 0,
  };

  get currentTime() {
    return this.state.time;
  }

  get duration() {
    return this.state.duration;
  }

  get videoWidth() {
    return this.state.width;
  }

  get videoHeight() {
    return this.state.height;
  }

  get rendererName() {
    return this.activeSharedRenderer?.name || this.activeRenderer?.name || '-';
  }

  get playerId() {
    return this.player?.id || '';
  }

  get src() {
    return this.getAttribute('src') || '';
  }

  set src(value: string) {
    if (value) {
      this.setAttribute('src', value);
    } else {
      this.removeAttribute('src');
    }
  }

  get loop() {
    return this.hasAttribute('loop');
  }

  set loop(value: boolean) {
    this.toggleAttribute('loop', value);
  }

  get volume() {
    const value = Number(this.getAttribute('volume') ?? 80);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 80;
  }

  set volume(value: number) {
    this.setAttribute('volume', String(value));
  }

  get mode() {
    return this.renderMode;
  }

  connectedCallback() {
    this.attachSurfaces();
    if (this.hasAttribute('defer-init')) return;
    if (this.destroying) {
      void this.destroying.then(() => {
        if (this.isConnected && !this.ready) this.startInitialize();
      });
    } else if (!this.ready) {
      this.startInitialize();
    }
  }

  disconnectedCallback() {
    void this.destroy();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;
    if (!this.isConnected) return;
    if (name === 'src' && newValue && newValue !== this.openedSource) {
      this.open(newValue).catch((error) => this.emitError(error));
    }
    if (name === 'volume' && newValue !== null) {
      this.setVolume(Number(newValue)).catch((error) => this.emitError(error));
    }
    if (name === 'render-mode' && newValue && newValue !== this.renderMode) {
      this.setRenderMode(newValue as RenderMode).catch((error) => this.emitError(error));
    }
  }

  async open(filePath: string) {
    await this.ensureReady();
    if (!this.player) return;
    this.status = 'Opening';
    this.dispatchState();
    await this.player.open(filePath);
    await this.player.setVolume(this.volume);
    this.openedSource = filePath;
    if (this.getAttribute('src') !== filePath) this.setAttribute('src', filePath);
    this.status = 'Loaded';
    this.dispatchState();
  }

  async play() {
    await this.ensureReady();
    await this.player?.play();
  }

  async pause() {
    await this.ensureReady();
    await this.player?.pause();
  }

  async stop() {
    await this.ensureReady();
    await this.player?.stop();
  }

  async seek(seconds: number) {
    await this.ensureReady();
    await this.player?.seek(seconds);
  }

  async setVolume(value: number) {
    await this.ensureReady();
    const volume = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 80;
    if (this.getAttribute('volume') !== String(volume)) {
      this.setAttribute('volume', String(volume));
    }
    await this.player?.setVolume(volume);
  }

  async setRenderMode(mode: RenderMode) {
    await this.ensureReady();
    const nextMode = this.resolveRenderMode(mode);
    if (nextMode === this.renderMode) return;
    await this.player?.setRenderMode(nextMode);
    this.renderMode = nextMode;
    if (this.getAttribute('render-mode') !== nextMode) this.setAttribute('render-mode', nextMode);
    this.activeSharedRenderer = nextMode === 'shared-texture' ? this.sharedRenderer : null;
    this.activeRenderer = nextMode === 'webgl' ? this.webglRenderer : this.canvasRenderer;
    this.updateVisibleSurface();
    this.updateRenderSize();
    this.dispatchState();
  }

  async destroy() {
    if (this.destroying) return this.destroying;
    const task = this.destroyInternal();
    this.destroying = task;
    try {
      await task;
    } finally {
      if (this.destroying === task) this.destroying = null;
    }
  }

  private async destroyInternal() {
    this.disposed = true;
    await this.ready?.catch(() => {});
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers = [];
    if (this.player) {
      const player = this.player;
      this.player = null;
      await player.destroy();
    }
    this.ready = null;
    this.openedSource = '';
    this.status = 'Idle';
  }

  private startInitialize() {
    const ready = this.initialize();
    this.ready = ready;
    void ready.catch((error) => this.emitError(error));
  }

  private async initialize() {
    this.canvasRenderer = new Canvas2DRenderer(this.canvas2d);
    this.activeRenderer = this.canvasRenderer;

    try {
      this.webglRenderer = new WebGLUploadRenderer(this.webglCanvas);
      this.activeRenderer = this.webglRenderer;
      this.renderMode = 'webgl';
    } catch (error) {
      this.emitError(error);
    }

    if (window._electronMpvVideo.supportsSharedTexture) {
      try {
        const sharedRenderer = new SharedTextureWebGpuRenderer(this.sharedCanvas);
        await sharedRenderer.prepare();
        this.sharedRenderer = sharedRenderer;
        this.activeSharedRenderer = sharedRenderer;
        this.renderMode = 'shared-texture';
      } catch (error) {
        this.emitError(error);
      }
    }

    const requestedMode = (this.getAttribute('render-mode') as RenderMode | null) ?? this.renderMode;
    this.renderMode = this.resolveRenderMode(requestedMode);
    this.player = await window._electronMpvVideo.create({
      renderMode: this.renderMode,
      width: this.clientWidth || 960,
      height: this.clientHeight || 540,
    });
    if (this.disposed) {
      await this.player.destroy();
      this.player = null;
      return;
    }
    this.activeSharedRenderer = this.renderMode === 'shared-texture' ? this.sharedRenderer : null;
    this.activeRenderer = this.renderMode === 'webgl' ? this.webglRenderer : this.canvasRenderer;

    this.disposers.push(this.player.onFrame((frame) => {
      if (this.renderMode === 'shared-texture') return;
      this.activeRenderer?.draw(frame);
    }));
    if (this.sharedRenderer) {
      this.disposers.push(this.player.onSharedTextureFrame(async (frame) => {
        if (this.renderMode !== 'shared-texture') return;
        await this.activeSharedRenderer?.drawVideoFrame(frame);
      }));
    }
    this.disposers.push(this.player.onEvent((event) => this.handlePlayerEvent(event)));

    this.resizeObserver = new ResizeObserver(() => this.updateRenderSize());
    this.resizeObserver.observe(this);
    this.updateVisibleSurface();
    this.updateRenderSize();
    await this.player.setVolume(this.volume);
    if (this.src) {
      await this.player.open(this.src);
      await this.player.setVolume(this.volume);
      this.openedSource = this.src;
      this.status = 'Loaded';
    }
    this.status = 'Ready';
    this.dispatchState();
  }

  private attachSurfaces() {
    if (this.surfaceRoot.contains(this.canvas2d)) return;
    const style = document.createElement('style');
    style.textContent = `
      :host {
        display: block;
        position: relative;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
        background: #000;
      }
      canvas {
        position: absolute;
        inset: 0;
        display: block;
        width: 100%;
        height: 100%;
        background: #000;
      }
      canvas[hidden] {
        display: none;
      }
    `;
    this.surfaceRoot.append(style, this.canvas2d, this.webglCanvas, this.sharedCanvas);
  }

  private async ensureReady() {
    if (this.disposed) throw new Error('MPV element is destroyed');
    if (!this.ready) {
      this.ready = this.initialize();
    }
    await this.ready;
  }

  async setSpeed(value: number) { await this.ensureReady(); await this.player?.setSpeed(value); }
  async setAudioTrack(id: number | 'no') { await this.ensureReady(); await this.player?.setAudioTrack(id); }
  async setSubtitleTrack(id: number | 'no') { await this.ensureReady(); await this.player?.setSubtitleTrack(id); }

  private resolveRenderMode(mode: RenderMode): RenderMode {
    if (mode === 'shared-texture' && this.sharedRenderer) return 'shared-texture';
    if (mode === 'webgl' && this.webglRenderer) return 'webgl';
    if (mode === 'canvas2d') return 'canvas2d';
    if (this.webglRenderer) return 'webgl';
    return 'canvas2d';
  }

  private updateVisibleSurface() {
    this.sharedCanvas.hidden = this.renderMode !== 'shared-texture';
    this.webglCanvas.hidden = this.renderMode !== 'webgl';
    this.canvas2d.hidden = this.renderMode !== 'canvas2d';
  }

  private updateRenderSize() {
    const rect = this.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(160, Math.floor(rect.width * ratio));
    const height = Math.max(90, Math.floor(rect.height * ratio));
    this.canvasRenderer?.resize(width, height);
    this.webglRenderer?.resize(width, height);
    this.sharedRenderer?.resize(width, height);
    this.player?.setRenderSize(width, height).catch((error) => this.emitError(error));
  }

  private handlePlayerEvent(event: PlayerEvent) {
    if (event.type === 'render-error' || event.type === 'event-error') {
      this.status = event.type;
      this.emitError(event.data);
      this.dispatchState();
      return;
    }

    switch (event.name) {
      case 'time-pos':
        this.state.time = typeof event.data === 'number' ? event.data : 0;
        break;
      case 'duration':
        this.state.duration = typeof event.data === 'number' ? event.data : 0;
        break;
      case 'width':
        this.state.width = typeof event.data === 'number' ? event.data : 0;
        break;
      case 'height':
        this.state.height = typeof event.data === 'number' ? event.data : 0;
        break;
      case 'video-codec':
        this.state.codec = typeof event.data === 'string' ? event.data : '-';
        break;
      case 'container-fps':
        this.state.fps = typeof event.data === 'number' ? event.data : 0;
        break;
      case 'pause':
        this.status = event.data ? 'Paused' : 'Playing';
        break;
      case 'eof-reached':
        if (event.data && this.loop) {
          this.seek(0).then(() => this.play()).catch((error) => this.emitError(error));
        } else if (event.data) {
          this.status = 'Ended';
        }
        break;
    }

    this.dispatchEvent(new CustomEvent('mpv-event', { detail: event }));
    this.dispatchState();
  }

  private dispatchState() {
    this.dispatchEvent(new CustomEvent('mpv-state', {
      detail: {
        playerId: this.playerId,
        status: this.status,
        renderMode: this.renderMode,
        rendererName: this.rendererName,
        ...this.state,
      },
    }));
  }

  private emitError(error: unknown) {
    this.dispatchEvent(new CustomEvent('mpv-error', {
      detail: error instanceof Error ? error.message : String(error),
    }));
  }
}


declare global {
  interface HTMLElementTagNameMap {
    'mpv-video': MpvVideoElement;
  }
}
