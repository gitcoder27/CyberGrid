/**
 * Synth — every sound is generated with Web Audio at runtime (PRD §13, no assets).
 * The context is created lazily on the first user gesture so autoplay policies
 * never block the game; the game itself never depends on audio.
 */
import type { Snapshot, Sfx } from '@cybergrid/engine';

export class Synth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private alarm: {
    osc1: OscillatorNode;
    osc2: OscillatorNode;
    gain: GainNode;
    lfo: OscillatorNode;
  } | null = null;

  /** Call from a user-gesture handler. */
  unlock(): void {
    this.ensure();
    void this.ctx?.resume();
  }

  private ensure(): boolean {
    if (this.ctx) return true;
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
      const len = Math.floor(this.ctx.sampleRate * 0.05);
      this.noiseBuffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      return true;
    } catch {
      return false;
    }
  }

  applySettings(snap: Snapshot): void {
    if (!this.master || !this.ctx) return;
    const vol = snap.settings.muted ? 0 : snap.settings.volume;
    this.master.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.05);
  }

  /** Mechanical keyclick on every keystroke (PRD §13). */
  keyclick(): void {
    if (!this.ensure() || !this.ctx || !this.master || !this.noiseBuffer) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 2600 + Math.random() * 1400;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.16, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.045);
    src.connect(filter).connect(gain).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + 0.05);
  }

  /** Persistent alarm whose pitch rises with the trace meter. */
  setAlarm(trace: number | null): void {
    if (trace === null) {
      if (this.alarm && this.ctx) {
        const a = this.alarm;
        a.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
        const stopAt = this.ctx.currentTime + 0.6;
        try {
          a.osc1.stop(stopAt);
          a.osc2.stop(stopAt);
          a.lfo.stop(stopAt);
        } catch {
          /* already stopped */
        }
        this.alarm = null;
      }
      return;
    }
    if (!this.ensure() || !this.ctx || !this.master) return;
    if (!this.alarm) {
      const ctx = this.ctx;
      const osc1 = ctx.createOscillator();
      osc1.type = 'sawtooth';
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 5.4;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 9;
      lfo.connect(lfoGain).connect(osc1.frequency);
      osc1.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(this.master);
      osc1.start();
      osc2.start();
      lfo.start();
      gain.gain.setTargetAtTime(0.045, ctx.currentTime, 0.4);
      this.alarm = { osc1, osc2, gain, lfo };
    }
    const { osc1, osc2 } = this.alarm;
    const base = 150 + (trace / 100) * 240; // pitch rises with trace % (PRD §13)
    const t = this.ctx.currentTime;
    osc1.frequency.setTargetAtTime(base, t, 0.25);
    osc2.frequency.setTargetAtTime(base * 1.5 + 2, t, 0.25);
  }

  play(name: Sfx): void {
    if (!this.ensure() || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const tone = (
      freq: number,
      start: number,
      dur: number,
      type: OscillatorType,
      vol: number,
      slideTo?: number
    ) => {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now + start);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, now + start + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now + start);
      g.gain.exponentialRampToValueAtTime(vol, now + start + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      osc.connect(g).connect(this.master!);
      osc.start(now + start);
      osc.stop(now + start + dur + 0.02);
    };

    switch (name) {
      case 'ok':
        tone(523.25, 0, 0.09, 'sine', 0.14);
        tone(783.99, 0.09, 0.14, 'sine', 0.14);
        break;
      case 'err':
        tone(140, 0, 0.16, 'sawtooth', 0.12, 90);
        break;
      case 'connect':
        tone(320, 0, 0.1, 'sine', 0.1, 640);
        tone(640, 0.08, 0.08, 'sine', 0.08);
        break;
      case 'breachStart':
        tone(180, 0, 0.28, 'sawtooth', 0.08, 560);
        break;
      case 'breachHit':
        tone(392, 0, 0.1, 'square', 0.1);
        tone(523.25, 0.08, 0.1, 'square', 0.1);
        tone(659.25, 0.16, 0.2, 'sine', 0.14);
        break;
      case 'cash':
        tone(987.77, 0, 0.07, 'square', 0.09);
        tone(1318.5, 0.07, 0.12, 'square', 0.09);
        break;
      case 'hint':
        tone(880, 0, 0.12, 'sine', 0.09, 660);
        break;
      case 'skip':
        tone(110, 0, 0.2, 'sawtooth', 0.12, 55);
        break;
      case 'alarm':
        tone(880, 0, 0.12, 'square', 0.08);
        tone(880, 0.18, 0.12, 'square', 0.08);
        break;
      case 'busted':
        tone(220, 0, 0.5, 'sawtooth', 0.16, 55);
        tone(233, 0.1, 0.5, 'square', 0.1, 49);
        break;
      case 'clean':
        tone(523.25, 0, 0.16, 'sine', 0.12);
        tone(659.25, 0.14, 0.16, 'sine', 0.12);
        tone(783.99, 0.28, 0.34, 'sine', 0.14);
        tone(1046.5, 0.28, 0.34, 'sine', 0.08);
        break;
      case 'type':
        tone(1200, 0, 0.02, 'sine', 0.03);
        break;
    }
  }
}
