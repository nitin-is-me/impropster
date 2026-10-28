/**
 * Spatial audio.
 *
 * All samples are synthesised into buffers at boot (no audio assets), then
 * played through Web Audio PannerNodes positioned in world space. The listener
 * is driven by the local player's position and facing so panning stays correct
 * as you turn — which is the whole point of the mechanic: a giggle behind you
 * must sound like it is behind you.
 */

const MAX_VOICES = 18;
const MAX_CUES = 3;

export class AudioController {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Bed of footsteps, gunfire and shatters; ducked while a clue sounds. */
  private ambience: GainNode | null = null;
  /** Giggles and heartbeats. Never competes for the ambience voice pool. */
  private cue: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private voices = 0;
  private cueVoices = 0;
  private lastHeartbeat = 0;
  private threat = 0;

  /** Must be called from a user gesture (browser autoplay policy). */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 24;
      compressor.ratio.value = 6;

      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;

      // Two sub-buses, so a clue is never buried or clipped by the ambience
      // around it. A giggle ducks `ambience` for its whole length.
      this.ambience = this.ctx.createGain();
      this.ambience.gain.value = 0.9;
      this.cue = this.ctx.createGain();
      this.cue.gain.value = 1;

      this.ambience.connect(this.master);
      this.cue.connect(this.master);
      this.master.connect(compressor);
      compressor.connect(this.ctx.destination);
      this.noiseBuffer = this.buildNoiseBuffer(this.ctx);
    }

    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setMasterVolume(value: number): void {
    if (this.master) this.master.gain.setTargetAtTime(value, this.ctx?.currentTime ?? 0, 0.05);
  }

  /** Called every frame with the local player's world position and facing. */
  updateListener(x: number, y: number, aim: number): void {
    const ctx = this.ctx;
    if (!ctx) return;

    const listener = ctx.listener;
    const time = ctx.currentTime;
    const smoothing = 0.02;

    if (listener.positionX) {
      listener.positionX.setTargetAtTime(x, time, smoothing);
      listener.positionY.setTargetAtTime(y, time, smoothing);
      listener.positionZ.setTargetAtTime(0, time, smoothing);
      listener.forwardX.setTargetAtTime(Math.cos(aim), time, smoothing);
      listener.forwardY.setTargetAtTime(Math.sin(aim), time, smoothing);
      listener.forwardZ.setTargetAtTime(0, time, smoothing);
      listener.upX.setTargetAtTime(0, time, smoothing);
      listener.upY.setTargetAtTime(0, time, smoothing);
      listener.upZ.setTargetAtTime(1, time, smoothing);
    } else {
      // Legacy Safari path.
      const legacy = listener as unknown as {
        setPosition?: (x: number, y: number, z: number) => void;
        setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
      };
      legacy.setPosition?.(x, y, 0);
      legacy.setOrientation?.(Math.cos(aim), Math.sin(aim), 0, 0, 0, 1);
    }
  }

  private buildNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const seconds = 0.6;
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buffer;
  }

  private panner(x: number, y: number, hrtf = true): PannerNode | null {
    const ctx = this.ctx;
    if (!ctx) return null;

    const panner = ctx.createPanner();
    panner.panningModel = hrtf ? "HRTF" : "equalpower";
    panner.distanceModel = "inverse";
    panner.refDistance = 95;
    panner.maxDistance = 900;
    panner.rolloffFactor = 1.4;

    if (panner.positionX) {
      panner.positionX.value = x;
      panner.positionY.value = y;
      panner.positionZ.value = 0;
    } else {
      (panner as unknown as { setPosition: (x: number, y: number, z: number) => void }).setPosition(x, y, 0);
    }

    return panner;
  }

  private reserveVoice(): boolean {
    if (this.voices >= MAX_VOICES) return false;
    this.voices += 1;
    return true;
  }

  private releaseVoice(seconds: number): void {
    window.setTimeout(() => {
      this.voices = Math.max(0, this.voices - 1);
    }, seconds * 1000);
  }

  /** Footsteps: filtered noise burst, pitch-varied per stride. */
  footstep(x: number, y: number, step: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.master) return;
    if (!this.reserveVoice()) return;

    const duration = 0.14;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.9 + ((step % 5) * 0.06);

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 420 + ((step * 37) % 260);
    band.Q.value = 1.1;

    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.5, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    const panner = this.panner(x, y);
    source.connect(band).connect(gain);
    const bus = this.ambience ?? this.master;
    if (panner) gain.connect(panner).connect(bus);
    else gain.connect(bus);

    source.start(now);
    source.stop(now + duration + 0.02);
    this.releaseVoice(duration + 0.05);
  }

  /**
   * The mandatory giggle. Five wobbling tones, deliberately cartoonish, and
   * just over a second long so it can actually be located by ear.
   *
   * It plays on the cue bus with its own voice budget: the ambience pool can be
   * full of footsteps without silencing the one sound that matters, and the
   * ambience bed is ducked beneath it so the tail is never masked.
   */
  giggle(x: number, y: number, variant = 0): void {
    const ctx = this.ctx;
    if (!ctx || !this.cue) return;
    if (this.cueVoices >= MAX_CUES) return;
    this.cueVoices += 1;

    const now = ctx.currentTime;
    const duration = 1.15;
    const panner = this.panner(x, y, true);

    // Its own envelope, so the last note is not cut short by a bus fade that
    // was scheduled before the note had finished.
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0.0001, now);
    bus.gain.exponentialRampToValueAtTime(0.95, now + 0.04);
    bus.gain.setValueAtTime(0.95, now + duration - 0.35);
    bus.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    bus.connect(this.cue);

    const base = 470 + variant * 55;
    const notes = 5;

    for (let i = 0; i < notes; i++) {
      const start = now + i * 0.15;
      const hold = 0.16;
      const pitch = base * (i % 2 === 0 ? 1 : 1.26);

      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(pitch * 0.94, start);
      osc.frequency.exponentialRampToValueAtTime(pitch * 1.3, start + 0.06);
      osc.frequency.exponentialRampToValueAtTime(pitch * 0.82, start + hold);

      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, start);
      env.gain.exponentialRampToValueAtTime(0.55, start + 0.015);
      env.gain.exponentialRampToValueAtTime(0.14, start + 0.09);
      env.gain.exponentialRampToValueAtTime(0.0001, start + hold);

      osc.connect(env);
      env.connect(panner ?? bus);

      osc.start(start);
      osc.stop(start + hold + 0.02);
    }

    if (panner) panner.connect(bus);

    this.duckAmbience(duration);

    window.setTimeout(() => {
      this.cueVoices = Math.max(0, this.cueVoices - 1);
      bus.disconnect();
    }, duration * 1000 + 120);
  }

  /** Pulls the ambience bed down so a cue is not masked by its own room. */
  private duckAmbience(seconds: number): void {
    const ctx = this.ctx;
    const ambience = this.ambience;
    if (!ctx || !ambience) return;

    const now = ctx.currentTime;
    const param = ambience.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0.18, now + 0.05);
    param.setValueAtTime(0.18, now + seconds);
    param.linearRampToValueAtTime(0.9, now + seconds + 0.35);
  }

  /**
   * Weapon report. Your own shot is dry and loud (no panning); other people's
   * shots are placed in the world so you can tell where they came from.
   */
  shot(x?: number, y?: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.master) return;
    if (!this.reserveVoice()) return;

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 1.6;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 700;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.6, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    source.connect(highpass).connect(gain);

    if (x !== undefined && y !== undefined) {
      const panner = this.panner(x, y, false);
      if (panner) gain.connect(panner).connect(this.ambience ?? this.master);
      else gain.connect(this.ambience ?? this.master);
    } else {
      gain.connect(this.ambience ?? this.master);
    }

    source.start(now);
    source.stop(now + 0.25);
    this.releaseVoice(0.3);
  }

  /** Disguise shattering. */
  shatter(x: number, y: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuffer || !this.master) return;
    if (!this.reserveVoice()) return;

    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 2.1;

    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 1800;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    const panner = this.panner(x, y, false);
    source.connect(highpass).connect(gain);
    const bus = this.ambience ?? this.master;
    if (panner) gain.connect(panner).connect(bus);
    else gain.connect(bus);

    source.start(now);
    source.stop(now + 0.45);
    this.releaseVoice(0.5);
  }

  /** Empty-handed shot: a dull click that says "you wasted it". */
  dryFire(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;
    if (!this.reserveVoice()) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = 180;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.07);

    osc.connect(gain).connect(this.cue ?? this.master);
    osc.start(now);
    osc.stop(now + 0.08);
    this.releaseVoice(0.1);
  }

  /** Sustained danger pulse; `intensity` is 0..1 and drives rate + volume. */
  updateHeartbeat(intensity: number, now: number): void {
    this.threat = intensity;
    if (!this.ctx || !this.master || intensity <= 0.02) return;

    const interval = 1100 - intensity * 620;
    if (now - this.lastHeartbeat < interval) return;
    this.lastHeartbeat = now;

    const ctx = this.ctx;
    const start = ctx.currentTime;
    const beats = intensity > 0.6 ? 2 : 1;

    for (let i = 0; i < beats; i++) {
      const at = start + i * 0.16;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(74, at);
      osc.frequency.exponentialRampToValueAtTime(46, at + 0.14);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.16 + intensity * 0.22, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.19);

      osc.connect(gain).connect(this.cue ?? this.master);
      osc.start(at);
      osc.stop(at + 0.2);
    }
  }

  get threatLevel(): number {
    return this.threat;
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.ambience = null;
    this.cue = null;
    this.noiseBuffer = null;
    this.cueVoices = 0;
  }
}
