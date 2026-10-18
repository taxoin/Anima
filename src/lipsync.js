/**
 * lipsync.js — текст → визем-таймлайн, разметка речи, TTS-драйверы (Web Speech / аудио / внешний сервис).
 *
 * Принцип: речь — это ОТДЕЛЬНЫЙ слой, который управляет только "речевыми" каналами рта
 * (jawOpen, funnel, pucker, press, roll...). Улыбка/хмурость/брови/глаза остаются от эмоции,
 * поэтому персонаж может говорить с презрительной полуулыбкой.
 *
 * Разметка внутри текста для speak():
 *   [emotion:contempt+boredom]  или [e:jaded*0.8]   — сменить эмоцию в этой точке фразы
 *   [gesture:nod]  [g:creakyLaugh]                    — жест
 *   [micro:contempt]  [m:browFlick]                   — микро-выражение
 *   [pause:800]  [pause]                              — пауза (мс, по умолчанию 600)
 *   *слово*  **слово**                                — акцент (кивок/брови/сужение глаз)
 *   *я усмехаюсь, без радости*                         — 3+ слова в звёздочках = ремарка: не произносится,
 *                                                       разбирается parseNarrative() и применяется как эмоция
 */
import { parseNarrative } from './emotions.js';

// ---------------------------------------------------------------- виземы (Oculus/MPEG-4-подобный набор из 15)
export const VISEMES = {
  sil: {},
  PP: { mouthClose: 0.35, mouthPressLeft: 0.4, mouthPressRight: 0.4, jawOpen: 0.03 },
  FF: { jawOpen: 0.08, mouthRollLower: 0.55, mouthUpperUpLeft: 0.18, mouthUpperUpRight: 0.18 },
  TH: { jawOpen: 0.14, tongueOut: 0.45, tongueUp: 0.3 },
  DD: { jawOpen: 0.18, mouthStretchLeft: 0.1, mouthStretchRight: 0.1, tongueUp: 0.85 },
  kk: { jawOpen: 0.24, mouthStretchLeft: 0.12, mouthStretchRight: 0.12 },
  CH: { jawOpen: 0.14, mouthFunnel: 0.5, mouthPucker: 0.2, mouthUpperUpLeft: 0.1, mouthUpperUpRight: 0.1, tongueUp: 0.45 },
  SS: { jawOpen: 0.07, mouthStretchLeft: 0.3, mouthStretchRight: 0.3, tongueUp: 0.4 },
  nn: { jawOpen: 0.15, mouthStretchLeft: 0.06, mouthStretchRight: 0.06, tongueUp: 0.9 },
  RR: { jawOpen: 0.15, mouthFunnel: 0.28, tongueUp: 0.6 },
  aa: { jawOpen: 0.58, mouthLowerDownLeft: 0.15, mouthLowerDownRight: 0.15 },
  E: { jawOpen: 0.34, mouthStretchLeft: 0.32, mouthStretchRight: 0.32 },
  I: { jawOpen: 0.18, mouthStretchLeft: 0.45, mouthStretchRight: 0.45, mouthSmileLeft: 0.08, mouthSmileRight: 0.08 },
  O: { jawOpen: 0.42, mouthFunnel: 0.6 },
  U: { jawOpen: 0.16, mouthPucker: 0.75, mouthFunnel: 0.2 },
};
/**
 * Каналы, которыми владеет речевой слой (эмоция в них ослабляется во время речи).
 * tongueUp — не ARKit: кончик языка к альвеолам (Т, Д, Н, Л, Р, С, Ш). Процедурная голова его показывает, glTF игнорирует.
 */
export const SPEECH_CHANNELS = ['jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthPressLeft', 'mouthPressRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'mouthStretchLeft', 'mouthStretchRight', 'tongueOut', 'tongueUp'];

/** Azure Speech viseme ID (0..21) → наш визем. Для ElevenLabs/OpenAI используйте alignment по символам. */
export const AZURE_VISEMES = ['sil', 'aa', 'aa', 'O', 'E', 'RR', 'I', 'U', 'O', 'aa', 'O', 'aa', 'kk', 'RR', 'nn', 'SS', 'CH', 'TH', 'FF', 'DD', 'kk', 'PP'];

const RU = {
  а: 'aa', я: 'aa', о: 'O', ё: 'O', у: 'U', ю: 'U', э: 'E', е: 'E', и: 'I', ы: 'I', й: 'I',
  п: 'PP', б: 'PP', м: 'PP', ф: 'FF', в: 'FF', т: 'DD', д: 'DD', н: 'nn', л: 'nn',
  к: 'kk', г: 'kk', х: 'kk', ш: 'CH', щ: 'CH', ж: 'CH', ч: 'CH', с: 'SS', з: 'SS', ц: 'SS', р: 'RR',
};
const EN = {
  a: 'aa', e: 'E', i: 'I', o: 'O', u: 'U', y: 'I', p: 'PP', b: 'PP', m: 'PP', f: 'FF', v: 'FF',
  t: 'DD', d: 'DD', n: 'nn', l: 'nn', k: 'kk', g: 'kk', c: 'kk', q: 'kk', x: 'kk', h: 'kk',
  j: 'CH', s: 'SS', z: 'SS', r: 'RR', w: 'U',
};
const EN_DIGRAPHS = { th: 'TH', sh: 'CH', ch: 'CH', ph: 'FF', oo: 'U', ee: 'I', ou: 'aa', ow: 'O', ck: 'kk', ng: 'nn', wh: 'U' };
const VOWELS = new Set(['aa', 'E', 'I', 'O', 'U']);
const PAUSES = { ',': 0.22, ';': 0.26, ':': 0.26, '.': 0.42, '!': 0.42, '?': 0.42, '…': 0.55, '—': 0.24, '–': 0.2, '\n': 0.35 };

// ---------------------------------------------------------------- разметка

/**
 * @returns {{ plain: string, cues: Array<{i:number, type:string, value:any}> }}
 *   plain — текст для TTS (без тегов), cues — события, привязанные к позиции символа в plain.
 */
export function parseMarkup(text) {
  const cues = [];
  let plain = '';
  const re = /\[(emotion|e|gesture|g|micro|m|pause|p)(?::\s*([^\]]*))?\]|\*\*([^*]+)\*\*|\*([^*]+)\*/gi;
  let last = 0, m;
  while ((m = re.exec(text))) {
    plain += text.slice(last, m.index);
    last = re.lastIndex;
    if (m[1]) {
      const kind = m[1].toLowerCase()[0];
      const val = (m[2] || '').trim();
      if (kind === 'e') cues.push({ i: plain.length, type: 'emotion', value: val });
      else if (kind === 'g') cues.push({ i: plain.length, type: 'gesture', value: val });
      else if (kind === 'm') cues.push({ i: plain.length, type: 'micro', value: val });
      else cues.push({ i: plain.length, type: 'pause', value: parseFloat(val) || 600 });
    } else if (m[3]) {
      cues.push({ i: plain.length, type: 'emphasis', value: 1 });
      plain += m[3];
    } else if (m[4]) {
      const inner = m[4].trim();
      if (inner.split(/\s+/).length >= 3) {
        // ремарка-действие: *усмехается, глядя сквозь тебя*
        cues.push({ i: plain.length, type: 'narrative', value: inner });
      } else {
        cues.push({ i: plain.length, type: 'emphasis', value: 0.6 });
        plain += inner;
      }
    }
  }
  plain += text.slice(last);
  // схлопываем пробелы, сохраняя индексы cues согласованными
  const out = [];
  const map = new Array(plain.length + 1);
  let prevSpace = true;
  for (let i = 0; i < plain.length; i++) {
    map[i] = out.length;
    const ch = plain[i];
    const sp = ch === ' ' || ch === '\t';
    if (sp && prevSpace) continue;
    out.push(ch);
    prevSpace = sp;
  }
  map[plain.length] = out.length;
  for (const c of cues) c.i = map[Math.min(c.i, plain.length)];
  return { plain: out.join('').trim(), cues };
}

// ---------------------------------------------------------------- таймлайн

/** Текст → [{ t, dur, v, i }] (секунды). rate — как SpeechSynthesisUtterance.rate. */
export function buildTimeline(text, { rate = 1 } = {}) {
  const items = [], words = [];
  const k = 1 / Math.max(0.3, rate);
  let t = 0, inWord = false;
  const low = text.toLowerCase();
  for (let i = 0; i < low.length; i++) {
    const ch = low[i];
    if (PAUSES[ch] !== undefined || (ch === '.' && low.slice(i, i + 3) === '...')) {
      let d = PAUSES[ch];
      if (low.slice(i, i + 3) === '...') { d = PAUSES['…']; i += 2; }
      items.push({ t, dur: d * k, v: 'sil', i });
      t += d * k; inWord = false;
      continue;
    }
    if (/\s/.test(ch)) { items.push({ t, dur: 0.03 * k, v: 'sil', i }); t += 0.03 * k; inWord = false; continue; }
    let v = RU[ch], len = 1;
    if (!v) {
      const dg = EN_DIGRAPHS[low.slice(i, i + 2)];
      if (dg) { v = dg; len = 2; } else v = EN[ch];
    }
    if (!v && /\d/.test(ch)) v = 'aa';
    if (!v) continue; // ь, ъ, апострофы и прочее
    if (!inWord) { words.push({ i, t }); inWord = true; }
    const d = (VOWELS.has(v) ? 0.095 : v === 'PP' ? 0.07 : 0.058) * k * (len === 2 ? 1.2 : 1);
    // одинаковые подряд согласные сливаем
    const prev = items[items.length - 1];
    if (prev && prev.v === v && !VOWELS.has(v)) { prev.dur += d * 0.5; t += d * 0.5; }
    else { items.push({ t, dur: d, v, i }); t += d; }
    i += len - 1;
  }
  items.push({ t, dur: 0.15, v: 'sil', i: text.length });
  return { items, words, duration: t };
}

/** Таймлайн из выравнивания по символам (ElevenLabs alignment, OpenAI/Whisper timestamps и т.п.). */
export function timelineFromAlignment(chars, times) {
  const items = [], words = [];
  let inWord = false;
  for (let i = 0; i < chars.length; i++) {
    const ch = String(chars[i]).toLowerCase();
    const t = times[i], dur = (times[i + 1] ?? t + 0.08) - t;
    let v = RU[ch] || EN[ch] || (PAUSES[ch] !== undefined || /\s/.test(ch) ? 'sil' : null);
    if (!v) continue;
    if (v !== 'sil' && !inWord) { words.push({ i, t }); inWord = true; }
    if (v === 'sil') inWord = false;
    items.push({ t, dur, v, i });
  }
  const end = items.length ? items[items.length - 1].t + items[items.length - 1].dur : 0;
  items.push({ t: end, dur: 0.15, v: 'sil', i: chars.length });
  return { items, words, duration: end };
}

/** Таймлайн из списка визем [{t, v}] (v — имя визема или Azure ID). */
export function timelineFromVisemes(list) {
  const items = list.map((x, n) => {
    const v = typeof x.v === 'number' ? AZURE_VISEMES[x.v] || 'sil' : x.v;
    const next = list[n + 1];
    return { t: x.t, dur: next ? next.t - x.t : 0.12, v, i: -1 };
  });
  const end = items.length ? items[items.length - 1].t + items[items.length - 1].dur : 0;
  return { items, words: [], duration: end };
}

function findItem(items, t) {
  let lo = 0, hi = items.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (items[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Каналы рта в момент t (с ко-артикуляцией: в конце звука губы уже готовятся к следующему). */
export function visemeChannelsAt(tl, t, out = {}) {
  for (const k in out) out[k] = 0;
  if (!tl || !tl.items.length) return out;
  const n = findItem(tl.items, t);
  const it = tl.items[n], next = tl.items[n + 1];
  const u = it.dur > 0 ? (t - it.t) / it.dur : 1;
  const a = VISEMES[it.v] || {};
  let blend = 0;
  if (next && it.v !== 'PP' && u > 0.55) blend = Math.min(1, (u - 0.55) / 0.45) * 0.55;
  for (const k in a) out[k] = (out[k] || 0) + a[k] * (1 - blend);
  if (blend && next) { const b = VISEMES[next.v] || {}; for (const k in b) out[k] = (out[k] || 0) + b[k] * blend; }
  return out;
}

// ---------------------------------------------------------------- Web Speech API

export const WebSpeech = {
  available: () => typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  voices() { return this.available() ? speechSynthesis.getVoices() : []; },
  /** Подбирает голос по языку и полу (эвристика по имени голоса). */
  pickVoice(lang = 'ru', gender = 'female') {
    const all = this.voices();
    const pref = lang.slice(0, 2).toLowerCase();
    const list = all.filter((v) => v.lang && v.lang.toLowerCase().startsWith(pref));
    if (!list.length) return null;
    const F = /female|woman|milena|irina|svetlana|alena|alyona|anna|elena|tatyana|ekaterina|daria|dariya|google русский|samantha|victoria|karen|zira|aria|jenny|sonia|libby|natasha|xenia/i;
    const M = /\bmale\b|\bman\b|pavel|dmitr|yuri|maxim|nikolai|alex|daniel|david|mark|guy|ryan|george|fred|aleksandr|artem|ivan/i;
    const want = gender === 'male' ? list.filter((v) => M.test(v.name) && !F.test(v.name)) : list.filter((v) => F.test(v.name));
    return (want.find((v) => v.localService) || want[0]) || list.find((v) => v.localService) || list[0];
  },
};

export function detectLang(text) {
  return /[а-яё]/i.test(text) ? 'ru-RU' : 'en-US';
}

// ---------------------------------------------------------------- анализ аудио

/** RMS-уровень и спектральный центроид живого аудио (HTMLAudioElement или MediaStream). */
export class AudioAnalyser {
  constructor(source) {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = AudioAnalyser._ctx || (AudioAnalyser._ctx = new AC());
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.node = this.ctx.createAnalyser();
    this.node.fftSize = 1024;
    this.node.smoothingTimeConstant = 0.5;
    if (source instanceof MediaStream) {
      this.src = this.ctx.createMediaStreamSource(source);
      this.src.connect(this.node); // без вывода в колонки (микрофон)
    } else {
      // createMediaElementSource можно вызвать только один раз на элемент
      this.src = source.__ehSource || (source.__ehSource = this.ctx.createMediaElementSource(source));
      this.src.connect(this.node);
      this.node.connect(this.ctx.destination);
    }
    this.td = new Float32Array(this.node.fftSize);
    this.fd = new Uint8Array(this.node.frequencyBinCount);
    this.peak = 0.05;
  }
  /** @returns {{ level: number, centroid: number }} level 0..1 (адаптивная нормализация), centroid 0..1 */
  read() {
    this.node.getFloatTimeDomainData(this.td);
    let s = 0;
    for (let i = 0; i < this.td.length; i++) s += this.td[i] * this.td[i];
    const rms = Math.sqrt(s / this.td.length);
    this.peak = Math.max(rms, this.peak * 0.995, 0.02);
    this.node.getByteFrequencyData(this.fd);
    let num = 0, den = 0;
    const maxBin = Math.min(this.fd.length, 200); // ~0..10 кГц
    for (let i = 2; i < maxBin; i++) { num += i * this.fd[i]; den += this.fd[i]; }
    return { level: Math.min(1, rms / this.peak), rms, centroid: den ? num / den / maxBin : 0 };
  }
  dispose() {
    try { this.src.disconnect(this.node); this.node.disconnect(); } catch (e) { /* noop */ }
  }
}

// ---------------------------------------------------------------- контроллер речи

/**
 * Управляет одной "репликой": разбиение на куски (по паузам и предложениям), TTS, часы таймлайна,
 * пересинхронизация по onboundary, события cues. EmotionalHead вызывает update(dt) каждый кадр.
 */
export class SpeechController {
  constructor(host) {
    this.host = host;          // { onCue(cue), onWord(i), onStart(), onEnd(), gender, emotionVoice() }
    this.active = false;
    this.channels = {};
    this.level = 0;            // "громкость" речи 0..1 (для кивков/дыхания)
    this._token = 0;
  }

  /**
   * @param {string} text  текст с разметкой
   * @param {object} opts  { tts: 'webspeech'|'none'|fn, voice, lang, rate, pitch, volume, audio, alignment, visemes }
   */
  speak(text, opts = {}) {
    this.stop(true);
    const token = ++this._token;
    const { plain, cues } = parseMarkup(text);
    this.plain = plain;
    this.opts = opts;
    this.active = true;
    this.host.onStart?.(plain);
    return new Promise((resolve) => {
      this._resolve = resolve;
      const run = async () => {
        try {
          if (typeof opts.tts === 'function') {
            const res = await opts.tts(plain, { lang: opts.lang || detectLang(plain), gender: this.host.gender, ...this.host.emotionVoice?.() });
            if (token !== this._token) return;
            await this._playAudio(res.audio, plain, cues, res, token);
          } else if (opts.audio) {
            await this._playAudio(opts.audio, plain, cues, opts, token);
          } else {
            const useTTS = opts.tts !== 'none' && WebSpeech.available();
            for (const chunk of splitChunks(plain, cues)) {
              if (token !== this._token) return;
              await this._playChunk(chunk, useTTS, token);
              if (token !== this._token) return;
              if (chunk.pauseAfter) await this._wait(chunk.pauseAfter / 1000, token);
            }
          }
        } catch (err) {
          console.warn('[emotional-head] speech error', err);
        }
        if (token === this._token) this._finish();
      };
      run();
    });
  }

  stop(silent = false) {
    this._token++;
    if (WebSpeech.available() && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
    if (this._audio) { this._audio.pause(); this._audio = null; }
    if (this._analyser) { this._analyser.dispose(); this._analyser = null; }
    this._chunk = null;
    if (this.active && !silent) this._finish();
    else this.active = false;
  }

  _finish() {
    this.active = false;
    this._chunk = null;
    for (const k in this.channels) this.channels[k] = 0;
    const r = this._resolve;
    this._resolve = null;
    this.host.onEnd?.();
    r?.();
  }

  _wait(sec, token) {
    return new Promise((res) => {
      this._chunk = { waiting: true, until: sec, clock: 0, token, done: res, tl: null, cues: [] };
    });
  }

  /** Один кусок текста через Web Speech (или "беззвучно" по оценочному таймингу). */
  _playChunk(chunk, useTTS, token) {
    const voiceOpts = this.host.emotionVoice?.() || {};
    const rate = (this.opts.rate ?? 1) * (voiceOpts.rate ?? 1);
    const tl = buildTimeline(chunk.text, { rate });
    return new Promise((done) => {
      const st = { tl, cues: chunk.cues.map((c) => ({ ...c, t: cueTime(tl, c.i) })), clock: 0, speed: 1, running: !useTTS,
        ended: false, token, done, words: tl.words, wordIdx: 0, mode: useTTS ? 'tts' : 'silent' };
      this._chunk = st;
      // cue в самом начале куска — сразу (эмоция до первого слова)
      if (!chunk.text.trim()) { st.running = true; return; }
      if (!useTTS) return;
      const u = new SpeechSynthesisUtterance(chunk.text);
      const lang = this.opts.lang || detectLang(chunk.text);
      u.lang = lang;
      const voice = typeof this.opts.voice === 'object' && this.opts.voice ? this.opts.voice
        : (typeof this.opts.voice === 'string' ? WebSpeech.voices().find((v) => v.name === this.opts.voice) : null) || WebSpeech.pickVoice(lang, this.host.gender);
      if (voice) u.voice = voice;
      u.rate = rate;
      u.pitch = Math.max(0.1, Math.min(2, (this.opts.pitch ?? 1) * (voiceOpts.pitchVoice ?? 1) * (this.host.gender === 'female' ? 1.04 : 0.96)));
      u.volume = this.opts.volume ?? 1;
      let started = false;
      u.onstart = () => { started = true; st.running = true; st.clock = 0; };
      u.onboundary = (e) => {
        if (e.name && e.name !== 'word') return;
        // пересинхронизация: прыгаем к оценочному времени слова и подстраиваем скорость часов
        let w = 0;
        while (w + 1 < st.words.length && st.words[w + 1].i <= e.charIndex) w++;
        const est = st.words[w]?.t ?? st.clock;
        if (st.clock > 0.25 && est > 0.25) st.speed = clamp(st.speed * 0.6 + (est / st.clock) * st.speed * 0.4, 0.5, 2);
        st.clock = est;
      };
      u.onend = u.onerror = () => {
        if (st.abandoned) return;
        // синтез «закончил», так и не начав (нет голосов, ошибка движка) → доигрываем беззвучно, губы всё равно двигаются
        if (!started && token === this._token) { st.abandoned = true; st.mode = 'silent'; st.clock = 0; st.running = true; return; }
        st.ended = true; st.running = false; done();
      };
      speechSynthesis.speak(u);
      // нет голосов / заблокировано автоплеем → беззвучный режим, чтобы губы всё равно двигались
      setTimeout(() => { if (!started && !st.ended && token === this._token) { st.abandoned = true; speechSynthesis.cancel(); st.mode = 'silent'; st.clock = 0; st.running = true; } }, 1500);
    });
  }

  async _playAudio(audioSrc, plain, cues, info, token) {
    let el;
    if (audioSrc instanceof HTMLAudioElement) el = audioSrc;
    else {
      el = new Audio();
      el.crossOrigin = 'anonymous';
      if (audioSrc instanceof Blob) el.src = URL.createObjectURL(audioSrc);
      else if (audioSrc instanceof ArrayBuffer) el.src = URL.createObjectURL(new Blob([audioSrc], { type: info.mimeType || 'audio/mpeg' }));
      else el.src = audioSrc;
    }
    this._audio = el;
    let tl = null;
    if (info.visemes) tl = timelineFromVisemes(info.visemes);
    else if (info.alignment) tl = timelineFromAlignment(info.alignment.chars || info.alignment.characters, info.alignment.times || info.alignment.character_start_times_seconds);
    else if (plain) tl = buildTimeline(plain);
    try { this._analyser = new AudioAnalyser(el); } catch (e) { this._analyser = null; }
    await new Promise((res) => { if (el.readyState >= 1) res(); else el.addEventListener('loadedmetadata', res, { once: true }); el.addEventListener('error', res, { once: true }); });
    const exact = !!(info.visemes || info.alignment);
    const scale = tl && !exact && isFinite(el.duration) && el.duration > 0 ? tl.duration / el.duration : 1;
    return new Promise((done) => {
      const st = { tl, cues: cues.map((c) => ({ ...c, t: tl ? cueTime(tl, c.i) : 0 })), clock: 0, speed: 1, running: true, ended: false,
        token, done, words: tl ? tl.words : [], wordIdx: 0, mode: 'audio', el, scale, deadSince: 0 };
      this._chunk = st;
      el.addEventListener('ended', () => { st.ended = true; st.running = false; done(); }, { once: true });
      el.addEventListener('error', () => { st.ended = true; st.running = false; done(); }, { once: true });
      el.play().catch((err) => { console.warn('[emotional-head] audio play blocked', err); st.ended = true; done(); });
    });
  }

  /** Вызывается каждый кадр. Возвращает объект каналов речевого слоя. */
  update(dt) {
    const st = this._chunk;
    const ch = this.channels;
    for (const k in ch) ch[k] = 0;
    if (!this.active || !st) { this.level = 0; return ch; }
    if (st.waiting) {
      st.clock += dt;
      if (st.clock >= st.until) { this._chunk = null; st.done(); }
      this.level = 0;
      return ch;
    }
    if (st.mode === 'audio') {
      st.clock = st.el.currentTime * st.scale;
      const a = this._analyser ? this._analyser.read() : null;
      if (a && a.rms < 1e-5 && !st.el.paused) st.deadSince += dt; else st.deadSince = 0;
      const deadAnalyser = !a || st.deadSince > 0.4; // CORS без заголовков → анализатор возвращает нули
      const gate = deadAnalyser ? 1 : smooth01((a.level - 0.08) / 0.25);
      if (st.tl) {
        visemeChannelsAt(st.tl, st.clock, ch);
        for (const k in ch) ch[k] *= gate;
      } else if (a) {
        // только амплитуда: открытие челюсти + форма по спектру (высокие → "и/с", низкие → "о/у")
        ch.jawOpen = a.level * 0.55;
        ch.mouthStretchLeft = ch.mouthStretchRight = smooth01((a.centroid - 0.25) * 4) * 0.4 * a.level;
        ch.mouthFunnel = smooth01((0.2 - a.centroid) * 6) * 0.5 * a.level;
      }
      this.level = deadAnalyser ? (ch.jawOpen || 0) * 2 : a.level;
    } else if (st.running) {
      st.clock += dt * st.speed;
      if (st.clock <= st.tl.duration) visemeChannelsAt(st.tl, st.clock, ch);
      else if (st.mode === 'tts' && !st.ended) babble(st.clock, ch);   // оценка короче реального звука
      else if (st.mode === 'silent' && st.clock > st.tl.duration + 0.1) { st.running = false; st.ended = true; this._chunk = null; st.done(); }
      this.level = Math.min(1, (ch.jawOpen || 0) * 2.2);
    }
    // cues и слова
    for (const c of st.cues) if (!c.fired && st.clock >= c.t - 0.02) { c.fired = true; this.host.onCue?.(c); }
    while (st.wordIdx < st.words.length && st.words[st.wordIdx].t <= st.clock) { this.host.onWord?.(st.words[st.wordIdx]); st.wordIdx++; }
    return ch;
  }
}

function cueTime(tl, i) {
  for (const it of tl.items) if (it.i >= i) return it.t;
  return tl.duration;
}

/** Разбиение на куски: по [pause] и по концам предложений (короткие utterances стабильнее в Chrome). */
function splitChunks(plain, cues) {
  const cuts = new Map();
  for (const c of cues) if (c.type === 'pause') cuts.set(c.i, (cuts.get(c.i) || 0) + c.value);
  const re = /[.!?…]+["»”)]*\s+/g;
  let m;
  while ((m = re.exec(plain))) if (!cuts.has(m.index + m[0].length)) cuts.set(m.index + m[0].length, 0);
  const points = [...cuts.keys()].sort((a, b) => a - b);
  const chunks = [];
  let start = 0;
  for (const p of [...points, plain.length]) {
    if (p < start) continue;
    const text = plain.slice(start, p);
    const own = cues.filter((c) => c.type !== 'pause' && c.i >= start && (c.i < p || (p === plain.length && c.i <= p)))
      .map((c) => ({ ...c, i: c.i - start }));
    if (text.trim() || own.length || cuts.get(p)) chunks.push({ text, cues: own, pauseAfter: cuts.get(p) || 0 });
    start = p;
  }
  return chunks;
}

const BABBLE = ['aa', 'nn', 'E', 'DD', 'O', 'kk', 'I', 'PP'];
function babble(t, out) {
  const n = Math.floor(t / 0.11);
  const a = VISEMES[BABBLE[n % BABBLE.length]];
  for (const k in a) out[k] = a[k] * 0.8;
}
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };

export { parseNarrative };
