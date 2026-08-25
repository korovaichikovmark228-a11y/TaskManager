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

  // iOS/iPadOS: Safari на iPad 13+ маскируется под «Macintosh», ловим по тач-точкам.
  function isIOS() {
    const ua = global.navigator ? (global.navigator.userAgent || '') : '';
    const touchMac = /Macintosh/.test(ua) && global.navigator && global.navigator.maxTouchPoints > 1;
    return /iP(hone|ad|od)/.test(ua) || touchMac;
  }

  // ---------------- ПРОЦЕДУРНАЯ МУЗЫКА ----------------
  function Soundscape() {
    this.ctx = null;
    this.master = null;
    this.nodes = [];
    this._intervals = [];
    this.current = 'none';
    this.volume = 0.45;
    this._audioEl = null;   // на iOS звук идёт через <audio> (медиа-канал, не «звонок»)
    this._streamDest = null;
    this._unlocked = false;
    this._bus = null;       // шина текущего запуска — её гасим при стопе
  }
  Soundscape.prototype._ensure = function () {
    if (!this.ctx) {
      const AC = global.AudioContext || global.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      // На iOS обычный WebAudio идёт через канал звонка и глушится переключателем/
      // режимом «без звука». Гоним звук в скрытый <audio> — он играет через медиа-канал.
      let routed = false;
      if (isIOS() && typeof this.ctx.createMediaStreamDestination === 'function') {
        try {
          this._streamDest = this.ctx.createMediaStreamDestination();
          this.master.connect(this._streamDest);
          const el = global.document.createElement('audio');
          el.setAttribute('playsinline', '');
          el.playsInline = true;
          el.autoplay = true;
          el.srcObject = this._streamDest.stream;
          el.style.display = 'none';
          global.document.body.appendChild(el);
          this._audioEl = el;
          routed = true;
        } catch (e) { routed = false; }
      }
      if (!routed) this.master.connect(this.ctx.destination);
    }
    // Разблокировка внутри жеста: resume + короткий тихий буфер + play() на <audio>.
    if (this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) {} }
    if (!this._unlocked) {
      try {
        const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
        const s = this.ctx.createBufferSource();
        s.buffer = b; s.connect(this.ctx.destination); s.start(0);
        this._unlocked = true;
      } catch (e) {}
    }
    if (this._audioEl) { const p = this._audioEl.play(); if (p && p.catch) p.catch(function () {}); }
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

    // Отдельная «шина» для этого запуска: гасим её при остановке, не трогая общий
    // уровень (master). Так стоп проходит без щелчков и без искажений на iOS.
    const bus = ctx.createGain();
    bus.gain.value = 1;
    bus.connect(this.master);
    this._bus = bus;
    this.nodes.push(bus);

    if (type === 'brown' || type === 'rain') {
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer();
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = (type === 'rain') ? 1400 : 600;
      const g = ctx.createGain();
      g.gain.value = (type === 'rain') ? 0.5 : 0.7;
      src.connect(filter); filter.connect(g); g.connect(bus);
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
      merger.connect(bus);
      oscL.start(); oscR.start();
      this.nodes.push(oscL, oscR, gL, gR, merger);
    } else if (type === 'lofi') {
      // лоу-фай: медленная смена аккордов (Am–F–C–G) + тёплый шум
      const oscs = [];
      for (let i = 0; i < 3; i++) {
        const osc = ctx.createOscillator();
        osc.type = (i === 0) ? 'triangle' : 'sine';
        const g = ctx.createGain(); g.gain.value = 0.07;
        osc.connect(g); g.connect(bus); osc.start();
        oscs.push(osc); this.nodes.push(osc, g);
      }
      const chords = [
        [220.00, 261.63, 329.63], // Am
        [174.61, 220.00, 261.63], // F
        [261.63, 329.63, 392.00], // C
        [196.00, 246.94, 293.66], // G
      ];
      let ci = 0;
      const setChord = () => {
        const c = chords[ci % chords.length];
        c.forEach((f, i) => { try { oscs[i].frequency.setTargetAtTime(f, ctx.currentTime, 0.5); } catch (e) {} });
        ci++;
      };
      setChord();
      this._intervals.push(setInterval(setChord, 4000));
      // тёплый шумовой фон
      const src = ctx.createBufferSource();
      src.buffer = this._noiseBuffer();
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass'; filter.frequency.value = 800;
      const g = ctx.createGain(); g.gain.value = 0.12;
      src.connect(filter); filter.connect(g); g.connect(bus);
      src.start();
      this.nodes.push(src, filter, g);
    }
  };
  Soundscape.prototype.stop = function () {
    this._intervals.forEach((iv) => clearInterval(iv));
    this._intervals = [];
    this.current = 'none';

    const ctx = this.ctx;
    const nodes = this.nodes;
    const bus = this._bus;
    this.nodes = [];
    this._bus = null;

    // Резкий disconnect осцилляторов даёт щелчок, а на iOS-пути через MediaStream
    // ещё и «затыкает» поток (искажённый луп). Поэтому: сначала плавно гасим шину
    // этого запуска до нуля (граф отдаёт тишину), и только потом рвём узлы. Общий
    // уровень (master) и медиа-маршрут не трогаем — громкость сохраняется.
    const hardStop = () => {
      nodes.forEach((n) => { try { n.stop && n.stop(); } catch (e) {} try { n.disconnect && n.disconnect(); } catch (e) {} });
    };

    if (ctx && bus && nodes.length) {
      try {
        bus.gain.cancelScheduledValues(ctx.currentTime);
        bus.gain.setValueAtTime(bus.gain.value, ctx.currentTime);
        bus.gain.setTargetAtTime(0.00001, ctx.currentTime, 0.02); // ~60мс фейд
      } catch (e) {}
      setTimeout(hardStop, 90);
    } else {
      hardStop();
    }
  };

  global.Focus = { Timer, Soundscape };
})(window);
