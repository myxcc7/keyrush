/**
 * 程序化生成的背景音乐（Web Audio，无需任何外部音频文件）。
 * 场景系统：
 * - auth  登录界面：温暖静谧（Cmaj7-Am7 慢速和声垫 + 柔和低音 + 星光点缀）
 * - list  房间列表：轻松慵懒（Fmaj7-Cmaj7-Am7-Gsus 琶音）
 * - lobby 房间内：蓄势待发（缓慢心跳 + Am-Am-F-G 暗色垫，节奏比对战稀疏）
 * - race  对战进行中：心跳低音 + 时钟滴答 + 暗色和弦垫循环
 * - 倒计时 3/2/1/GO 与胜负结算各有提示音
 * - 决胜局（赛点）自动收紧节奏、加密低音
 * - 右下角按钮可随时静音，偏好存入 localStorage
 */

const STORE_KEY = 'keyrush.audio';

class GameAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.musicBus = null;
    this.noiseBuf = null;
    this.playing = false;
    this.urgent = false;
    this.scene = null;
    this.timer = 0;
    this.step = 0;
    this.nextTime = 0;
    this.muted = localStorage.getItem(STORE_KEY) === 'off';
  }

  /** 必须在用户手势后调用（浏览器自动播放策略） */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.gain.value = 1;
      this.musicBus.connect(this.master);

      // 白噪声缓冲，用作时钟滴答
      const len = Math.floor(this.ctx.sampleRate * 0.08);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i += 1) data[i] = Math.random() * 2 - 1;

      // 调试用句柄（测试脚本读取）
      window.__keyrushAudio = this;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(muted) {
    this.muted = !!muted;
    localStorage.setItem(STORE_KEY, this.muted ? 'off' : 'on');
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.6;
  }

  toggleMuted() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  setUrgent(urgent) {
    this.urgent = !!urgent;
  }

  /* ---------- 音色 ---------- */

  kick(t, strong, vol) {
    const v = vol === undefined ? 1 : vol;
    const { ctx, musicBus } = this;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(strong ? 150 : 120, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.14);
    gain.gain.setValueAtTime((strong ? 0.85 : 0.5) * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + (strong ? 0.2 : 0.14));
    osc.connect(gain).connect(musicBus);
    osc.start(t);
    osc.stop(t + 0.24);
  }

  tick(t, accent) {
    const { ctx, musicBus, noiseBuf } = this;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(accent ? 0.16 : 0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(hp).connect(gain).connect(musicBus);
    src.start(t);
    src.stop(t + 0.06);
  }

  bass(t, freq, dur, vol) {
    const v = vol === undefined ? 1 : vol;
    const { ctx, musicBus } = this;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 320;
    lp.Q.value = 4;
    osc.type = 'sawtooth';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.24 * v, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(lp).connect(gain).connect(musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  pad(t, freqs, dur, cutoff, vol) {
    const co = cutoff === undefined ? 700 : cutoff;
    const v = vol === undefined ? 1 : vol;
    const { ctx, musicBus } = this;
    const gain = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(co, t);
    lp.frequency.linearRampToValueAtTime(co * 0.35, t + dur);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(0.07 * v, t + dur * 0.3);
    gain.gain.linearRampToValueAtTime(0.0001, t + dur);
    lp.connect(gain).connect(musicBus);
    freqs.forEach((f) => {
      // 双振荡器轻微失谐，做出暗色宽垫
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      o1.type = 'sawtooth';
      o2.type = 'sawtooth';
      o1.frequency.value = f;
      o2.frequency.value = f * 1.006;
      o1.connect(lp);
      o2.connect(lp);
      o1.start(t);
      o1.stop(t + dur + 0.1);
      o2.start(t);
      o2.stop(t + dur + 0.1);
    });
  }

  /** 柔和正弦拨音（登录/列表场景的星光与琶音） */
  pluck(t, freq, dur, vol) {
    const { ctx, musicBus } = this;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(musicBus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  blip(t, freq, type, dur, vol) {
    const { ctx, master } = this;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /* ---------- 循环调度（lookahead scheduler） ---------- */

  startRaceMusic() {
    this.setScene('race');
  }

  stopRaceMusic() {
    if (this.scene === 'race') this.setScene(null);
  }

  /** 切换场景音乐：'auth' | 'list' | 'lobby' | 'race' | null（停止） */
  setScene(scene) {
    this.unlock();
    if (!this.ctx || this.scene === scene) return;
    this.scene = scene;
    if (scene && !this.playing) {
      this.playing = true;
      this.step = 0;
      this.nextTime = this.ctx.currentTime + 0.1;
      this.timer = setInterval(() => this.schedule(), 25);
    }
    if (!scene && this.playing) {
      this.playing = false;
      clearInterval(this.timer);
      this.timer = 0;
    }
    // 环境场景比对战轻柔
    const busVol = scene === 'race' ? 1 : 0.62;
    this.musicBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.musicBus.gain.setTargetAtTime(busVol, this.ctx.currentTime, 0.25);
  }

  schedule() {
    if (!this.playing || !this.ctx) return;
    // 场景被挂起后（如后台标签页） currentTime 会大幅前移，这里对齐防止积压
    if (this.nextTime < this.ctx.currentTime) this.nextTime = this.ctx.currentTime + 0.05;
    const bpms = { race: this.urgent ? 150 : 128, lobby: 92, list: 76, auth: 60 };
    const steps = { race: 64, lobby: 64, list: 64, auth: 32 };
    const bpm = bpms[this.scene] || 100;
    const total = steps[this.scene] || 64;
    const stepDur = 60 / bpm / 4; // 十六分音符
    while (this.nextTime < this.ctx.currentTime + 0.15) {
      this.scheduleStep(this.step, this.nextTime, stepDur);
      this.step = (this.step + 1) % total;
      this.nextTime += stepDur;
    }
  }

  scheduleStep(step, t, dur) {
    if (this.scene === 'race') this.raceStep(step, t, dur);
    else this.ambientStep(step, t, dur);
  }

  raceStep(step, t, dur) {
    const bar = Math.floor(step / 16);
    const pos = step % 16;

    // 心跳：每半小节“咚-咚”
    if (pos === 0 || pos === 8) this.kick(t, true);
    if (pos === 3 || pos === 11) this.kick(t, false);

    // 时钟滴答：每个八分音符
    if (pos % 2 === 0) this.tick(t, pos % 8 === 0);

    // 低音进行：Am - Am - F - G（A1 A1 F1 G1）
    const roots = [55, 55, 43.65, 49];
    if (pos === 0) this.bass(t, roots[bar], dur * 6);
    // 赛点时加密低音脉冲
    if (this.urgent && pos === 10) this.bass(t, roots[bar] * 2, dur * 2);

    // 和弦垫
    const chords = [
      [220, 261.63, 329.63], // Am
      [220, 261.63, 329.63], // Am
      [174.61, 220, 261.63], // F
      [196, 246.94, 293.66]  // G
    ];
    if (pos === 0) this.pad(t, chords[bar], dur * 15);
  }

  /** 登录 / 房间列表 / 房间内的环境音乐 */
  ambientStep(step, t, dur) {
    const bar = Math.floor(step / 16);
    const pos = step % 16;

    if (this.scene === 'auth') {
      // 登录：60 BPM，Cmaj7 → Am7，温暖静谧
      const roots = [130.81, 110]; // C3 / A2
      const chords = [
        [261.63, 329.63, 392, 493.88], // Cmaj7
        [220, 261.63, 329.63, 392]     // Am7
      ];
      if (pos === 0) {
        this.pluck(t, roots[bar], dur * 10, 0.16);
        this.pad(t, chords[bar], dur * 14, 900, 0.9);
      }
      if (pos === 6) this.pluck(t, 1567.98, 0.9, 0.045); // G6 星光
      if (pos === 12 && bar === 1) this.pluck(t, 1318.51, 0.9, 0.04); // E6
    } else if (this.scene === 'list') {
      // 房间列表：76 BPM，Fmaj7 → Cmaj7 → Am7 → Gsus，慵懒琶音
      const chords = [
        [349.23, 440, 523.25, 554.37], // Fmaj7
        [261.63, 329.63, 392, 493.88], // Cmaj7
        [220, 261.63, 329.63, 392],    // Am7
        [196, 293.66, 349.23, 392]     // Gsus4
      ];
      if (pos === 0) this.pad(t, chords[bar], dur * 14, 800, 0.9);
      if (pos === 4 || pos === 8 || pos === 12) {
        const tone = chords[bar][((pos / 4) + bar) % 4] * 2;
        this.pluck(t, tone, dur * 3, 0.09);
      }
    } else if (this.scene === 'lobby') {
      // 房间内：92 BPM，Am → Am → F → G，缓慢心跳蓄势
      const roots = [55, 55, 43.65, 49];
      const chords = [
        [220, 261.63, 329.63],
        [220, 261.63, 329.63],
        [174.61, 220, 261.63],
        [196, 246.94, 293.66]
      ];
      if (pos === 0 || pos === 8) this.kick(t, true, 0.45);
      if (pos === 0) {
        this.bass(t, roots[bar], dur * 6, 0.75);
        this.pad(t, chords[bar], dur * 15, 500, 0.8);
      }
      if (pos === 0) this.tick(t, true);
    }
  }

  /* ---------- 提示音 ---------- */

  countdownTick(isGo) {
    this.unlock();
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    if (isGo) this.blip(t, 1046.5, 'sawtooth', 0.3, 0.3);
    else this.blip(t, 740, 'square', 0.08, 0.2);
  }

  playSting(kind) {
    this.unlock();
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + 0.05;
    const seq = {
      win: [[523.25, 0], [659.25, 0.09], [783.99, 0.18], [1046.5, 0.3]],
      lose: [[329.63, 0], [261.63, 0.14], [220, 0.3]],
      draw: [[440, 0]]
    }[kind] || [[440, 0]];
    seq.forEach(([freq, offset], index) => {
      const last = index === seq.length - 1;
      this.blip(t0 + offset, freq, 'triangle', last ? 0.6 : 0.22, 0.22);
    });
  }
}

export const audio = new GameAudio();
