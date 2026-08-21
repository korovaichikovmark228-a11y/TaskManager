/* ============================================================
   focus.js — таймер помодоро + процедурная фоновая музыка.
   Звук генерируется в браузере через Web Audio API:
   ни файлов, ни лицензий, ни трафика. Пресеты: lo-fi пэд,
   дождь, тёплый шум, бинауральные биения.
   (Файлы mp3 в /music тоже поддерживаются — см. README.)
   ============================================================ */
(function (global) {
  'use strict';

  // ---------------- ТАЙМЕР ----------------
  function Timer() {
    this.workMin = 25;
    this.breakMin = 5;
    this.phase = 'work';       // 'work' | 'break'
    this.remaining = 25 * 60;  // сек
    this.total = 25 * 60;
    this.running = false;
    this._interval = null;
    this.onTick = null;        // (remaining, total, phase)
    this.onComplete = null;    // (phase)
  }
  Timer.prototype.configure = function (workMin, breakMin) {
    this.workMin = workMin; this.breakMin = breakMin;
    if (!this.running) this.reset();
  };
  Timer.prototype.reset = function () {
    this.stop();
    this.phase = 'work';
    this.total = this.workMin * 60;
    this.remaining = this.total;
    this._emitTick();
  };
  Timer.prototype.start = function () {
    if (this.running) return;
    this.running = true;
    const self = this;
    this._interval = setInterval(function () {
      self.remaining--;
      if (self.remaining <= 0) {
        self.remaining = 0;
        self._emitTick();
        self.stop();
        const finished = self.phase;
        // переключаем фазу
        self.phase = (self.phase === 'work') ? 'break' : 'work';
        self.total = (self.phase === 'work' ? self.workMin : self.breakMin) * 60;
        self.remaining = self.total;
        if (self.onComplete) self.onComplete(finished);
        self._emitTick();
        return;
      }
      self._emitTick();
    }, 1000);
  };
  Timer.prototype.stop = function () {
    this.running = false;
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
  };
  Timer.prototype.toggle = function () { this.running ? this.stop() : this.start(); };
  Timer.prototype._emitTick = function () {
    if (this.onTick) this.onTick(this.remaining, this.total, this.phase);
  };

  // ---------------- ПРОЦЕДУРНАЯ МУЗЫКА ----------------
  function Soundscape() {
    this.ctx = null;
    this.master = null;
    this.nodes = [];
    this.current = 'none';
    this.volume = 0.45;
  }
  Soundscape.prototype._ensure = function () {
    if (!this.ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  };
  Soundscape.prototype.setVolume = function (v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  };
  Soundscape.prototype._noiseBuffer = function () {
    const ctx = this.ctx;
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02; // brown-ish
      data[i] = last * 3.5;
    }
    return buf;
  };
  Soundscape.prototype.play = function (type) {
    this.stop();
    if (type === 'none') { this.current = 'none'; return; }
    this._ensure();
    this.current = type;
    const ctx = this.ctx;

    if (type === 'brown' || type === 'rain') {
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer();
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = (type === 'rain') ? 1400 : 600;
      const g = ctx.createGain();
      g.gain.value = (type === 'rain') ? 0.5 : 0.7;
      src.connect(filter); filter.connect(g); g.connect(this.master);
      src.start();
      this.nodes.push(src, filter, g);
      if (type === 'rain') {
        // лёгкая модуляция «капель»
        const lfo = ctx.createOscillator();
        const lfoG = ctx.createGain();
        lfo.frequency.value = 0.15; lfoG.gain.value = 300;
        lfo.connect(lfoG); lfoG.connect(filter.frequency);
        lfo.start();
        this.nodes.push(lfo, lfoG);
      }
    } else if (type === 'binaural') {
      // 200 Гц + 210 Гц → 10 Гц биения (альфа, концентрация). Нужны наушники.
      const merger = ctx.createChannelMerger(2);
      const oscL = ctx.createOscillator(); oscL.frequency.value = 200;
      const oscR = ctx.createOscillator(); oscR.frequency.value = 210;
      const gL = ctx.createGain(); gL.gain.value = 0.25;
      const gR = ctx.createGain(); gR.gain.value = 0.25;
      oscL.connect(gL); gL.connect(merger, 0, 0);
      oscR.connect(gR); gR.connect(merger, 0, 1);
      merger.connect(this.master);
      oscL.start(); oscR.start();
      this.nodes.push(oscL, oscR, gL, gR, merger);
    } else if (type === 'lofi') {
      // мягкий пэд из аккорда + тёплый шум
      const chord = [220, 277.18, 329.63]; // A, C#, E
      chord.forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = f;
        const g = ctx.createGain();
        g.gain.value = 0.0;
        osc.connect(g); g.connect(this.master);
        osc.start();
        // плавное дыхание громкости
        const lfo = ctx.createOscillator();
        const lfoG = ctx.createGain();
        lfo.frequency.value = 0.06 + i * 0.02;
        lfoG.gain.value = 0.09;
        lfo.connect(lfoG); lfoG.connect(g.gain);
        g.gain.value = 0.1;
        lfo.start();
        this.nodes.push(osc, g, lfo, lfoG);
      });
      // тёплый шумовой фон
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer();
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 500;
      const g = ctx.createGain(); g.gain.value = 0.15;
      src.connect(filter); filter.connect(g); g.connect(this.master);
      src.start();
      this.nodes.push(src, filter, g);
    }
  };
  Soundscape.prototype.stop = function () {
    this.nodes.forEach((n) => { try { n.stop && n.stop(); n.disconnect && n.disconnect(); } catch (e) {} });
    this.nodes = [];
    this.current = 'none';
  };

  global.Focus = { Timer, Soundscape };
})(window);
