/* ============================================================
   speech.js — голосовой ввод через Web Speech API (офлайн-зависит
   от браузера). Fallback: если не поддерживается — текстовый ввод.
   ============================================================ */
(function (global) {
  'use strict';

  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  function isSupported() { return !!SR; }

  function createRecognizer(opts) {
    if (!SR) return null;
    const rec = new SR();
    rec.lang = (opts && opts.lang) || 'ru-RU';
    rec.interimResults = true;
    rec.continuous = true;
    rec.maxAlternatives = 1;
    return rec;
  }

  global.Speech = { isSupported, createRecognizer };
})(window);
