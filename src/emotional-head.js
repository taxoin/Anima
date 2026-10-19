/**
 * emotional-head.js — ядро "говорящей головы" и микро-API.
 *
 *   import { EmotionalHead } from './src/emotional-head.js';
 *   const head = new EmotionalHead('#stage', { gender: 'female', background: 'dark' });
 *   head.setEmotion('jaded', 0.9, 1.2);
 *   head.speak('Это слишком банально... [g:creakyLaugh] слишком *человечно*.', { emotion: 'coldIrony' });
 *
 * Слои анимации (складываются каждый кадр, сверху вниз):
 *   1. base     — эмоция/смесь эмоций (плавный переход с easing), поза головы, характер взгляда и моргания
 *   2. idle     — дыхание, моргание, саккады, отведение взгляда, дрейф головы, "живой" шум мимики
 *   3. micro    — микро-выражения (вручную или автоматически "просачиваются" из эмоции / сдержанности)
 *   4. gesture  — жесты по ключевым кадрам (кивок, усмешка-скрип, закатывание глаз, вздох...)
 *   5. speech   — виземы поверх эмоции (только каналы рта), кивки на словах, акценты
 *   6. manual   — прямые значения каналов из setChannels() (перекрывают всё)
 */
import * as THREE from 'three';
import { ProceduralHead, DETAIL, resolveDetail, SKIN_TONES, EYE_COLORS, EYE_SHAPES, NOSE_SHAPES, GLASSES, BEARDS, HAIR_STYLES, HATS, EARRINGS, TEETH_COLORS, LIP_PROFILES, OUTFITS, HEADPHONES, MASKS } from './head-model.js';
import { MAKEUP } from './skin-decals.js';
import {
  CHANNELS, STATE_DEFAULTS, EMOTIONS, MICRO, GESTURES, ALIASES,
  resolveEmotion, applyRestraint, parseNarrative, parseEmotionString, expandChannels,
} from './emotions.js';
import { SpeechController, SPEECH_CHANNELS, WebSpeech, VISEMES, parseMarkup, AudioAnalyser } from './lipsync.js';

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth01 = (x) => { x = clamp(x, 0, 1); return x * x * (3 - 2 * x); };
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const rand = (a, b) => a + Math.random() * (b - a);
const noise = (t, s) => (Math.sin(t * 0.31 + s) + 0.6 * Math.sin(t * 0.61 + s * 2.1) + 0.3 * Math.sin(t * 1.13 + s * 3.7)) / 1.9;

// ------------------------------------------------------------------ свет
export const LIGHTING = {
  studio: { key: ['#fff1e0', 2.4, [-2.5, 3, 4]], fill: ['#cfdcff', 0.7, [3, 0.5, 3]], rim: ['#ffffff', 2.2, [2.5, 2.5, -4]], hemi: ['#dfe8ff', '#3a2a24', 0.45], env: 0.8, exposure: 1.0 },
  warm: { key: ['#ffd6ae', 2.6, [-2, 2.5, 4]], fill: ['#ffe6d0', 0.55, [3, 0, 3]], rim: ['#ffb070', 1.8, [2.5, 2, -4]], hemi: ['#ffe0c0', '#40281a', 0.5], env: 0.7, exposure: 1.0 },
  cool: { key: ['#e3edff', 2.3, [-2.5, 3, 4]], fill: ['#b0c8ff', 0.8, [3, 0.5, 3]], rim: ['#7fb0ff', 2.4, [2.5, 2.5, -4]], hemi: ['#c8d8ff', '#20242e', 0.45], env: 0.8, exposure: 1.0 },
  noir: { key: ['#ffffff', 3.6, [-4, 1.6, 1.6]], fill: ['#8090b0', 0.1, [3, 0, 3]], rim: ['#a0c0ff', 3.0, [3, 2, -3]], hemi: ['#405070', '#000000', 0.1], env: 0.2, exposure: 0.95 },
  soft: { key: ['#ffffff', 1.4, [-1.5, 2, 4]], fill: ['#ffffff', 0.9, [2, 1, 4]], rim: ['#ffffff', 1.0, [0, 3, -4]], hemi: ['#ffffff', '#806860', 0.9], env: 1.0, exposure: 1.0 },
};
export const BACKGROUNDS = {
  dark: 'radial-gradient(ellipse at 50% 38%, #2b303c 0%, #12151c 60%, #08090c 100%)',
  light: 'radial-gradient(ellipse at 50% 38%, #ffffff 0%, #e6e9ef 60%, #cfd4dc 100%)',
  transparent: 'transparent',
};
const FRAMING = {
  portrait: { fov: 24, pos: [0, -0.2, 8.4], target: [0, -0.4, 0] },
  close: { fov: 24, pos: [0, 0.05, 5.6], target: [0, -0.1, 0] },
  bust: { fov: 26, pos: [0, -0.5, 10], target: [0, -0.75, 0] },
};

function makeEnvironment(renderer) {
  const pm = new THREE.PMREMGenerator(renderer);
  const s = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 32, 16);
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let i = 0; i < geo.attributes.position.count; i++) {
    const y = geo.attributes.position.getY(i) / 10;
    const t = (y + 1) / 2;
    col.set([0.12 + 0.5 * t * t, 0.11 + 0.52 * t * t, 0.1 + 0.58 * t * t], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const room = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true }));
  s.add(room);
  const boxes = [];
  const box = (w, h, p, k, c = '#ffffff') => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(...p); m.lookAt(0, 0, 0); s.add(m); boxes.push(m);
  };
  box(4, 3, [-5, 4, 6], 4, '#fff4e8');      // софтбокс ключевого света (блик в глазах)
  box(2.5, 5, [6, 1, 3], 1.4, '#e8f0ff');
  box(7, 1.5, [0, 6, -6], 2.5);
  const tex = pm.fromScene(s, 0.02).texture;
  geo.dispose(); room.material.dispose();
  for (const b of boxes) { b.geometry.dispose(); b.material.dispose(); }
  pm.dispose();
  return tex;
}

// ------------------------------------------------------------------ основной класс
const AVATAR_FORMAT = 2;          // версия файла exportAvatar()

export class EmotionalHead {
  /**
   * @param {HTMLElement|string} container  элемент или CSS-селектор
   * @param {object} [options]
   * @param {'female'|'male'} [options.gender='female']
   * @param {'dark'|'light'|'transparent'|string} [options.background='dark']  или любой CSS background
   * @param {'studio'|'warm'|'cool'|'noir'|'soft'|object} [options.lighting='studio']
   * @param {'portrait'|'close'|'bust'} [options.framing='portrait']
   * @param {string|object} [options.emotion='neutral']  начальная эмоция
   * @param {boolean} [options.idle=true]
   * @param {boolean} [options.shadows=true]
   * @param {boolean} [options.followPointer=false]  глаза следят за курсором
   * @param {boolean} [options.vignette=true]
   * @param {number}  [options.maxPixelRatio=2]
   * @param {'auto'|'high'|'medium'|'low'} [options.detail='auto']  детализация геометрии: auto — medium на телефонах
   * @param {'webspeech'|'none'|Function} [options.tts='webspeech']  TTS по умолчанию для speak()
   * @param {object} [options.voice]  { lang, voice, rate, pitch } по умолчанию для speak()
   * @param {object} [options.look]  переопределения внешности: { skin, hair, iris:[c1,c2], cloth, lip }
   */
  constructor(container, options = {}) {
    this.container = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.container) throw new Error('[emotional-head] container not found');
    this.options = {
      gender: 'female', background: 'dark', lighting: 'studio', framing: 'portrait', emotion: 'neutral',
      idle: true, shadows: true, followPointer: false, vignette: true, maxPixelRatio: 2, detail: 'auto', tts: 'webspeech', voice: {}, look: {},
      ...options,
    };
    this._listeners = {};
    this._t = 0;
    this._timers = [];
    this._idle = this.options.idle;

    this._initRenderer();
    this._initState();
    this.rig = this._makeRig(this.options.gender);
    this.scene.add(this.rig.object3D);
    this.gender = this.options.gender;

    const self = this;
    this.speech = new SpeechController({
      onStart: (text) => this._onSpeakStart(text),
      onEnd: () => this._onSpeakEnd(),
      onCue: (c) => this._onCue(c),
      onWord: (w) => this._onWord(w),
      emotionVoice: () => ({ rate: this._base['@rate'], pitchVoice: this._base['@pitchVoice'] }),
      get gender() { return self.gender; },
    });

    this.setBackground(this.options.background);
    this.setLighting(this.options.lighting);
    this.setEmotion(this.options.emotion, this.options.intensity ?? 1, 0);
    if (this.options.followPointer) this.followPointer(true);

    this._loop = this._loop.bind(this);
    this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  // ================================================================== ПУБЛИЧНОЕ API

  /**
   * Установить эмоцию (базовый слой).
   * @param {string|object} emotion  'contempt' | 'contempt + slight_amusement + boredom*0.5' | { contempt: .6, boredom: .4 }
   *                                 | 'презрение + скука' | сырое определение { au: {...}, pose: {...}, gaze: {...}, behavior: {...} }
   * @param {number} [intensity=1]   0..1 (можно чуть больше 1 для гротеска)
   * @param {number} [duration=0.6]  секунды перехода (easeInOutCubic)
   * @param {object} [opts]          { restraint: 0..1 — сдержанность, mirror: bool — зеркальная асимметрия }
   */
  setEmotion(emotion, intensity = 1, duration = 0.6, opts = {}) {
    const { state, micro, mix } = resolveEmotion(emotion, intensity, { mirror: !!opts.mirror });
    const restraint = opts.restraint ?? 0;
    const target = applyRestraint(state, restraint);
    this._from = { ...this._base };
    this._to = target;
    this._tween = { t0: this._t, dur: Math.max(0, duration) };
    if (!duration) Object.assign(this._base, target);
    this._microPool = micro;
    this._restraint = restraint;
    this._mirror = !!opts.mirror;
    this._emotion = { emotion, intensity, mix, restraint, mirror: !!opts.mirror };
    this._emit('emotionChange', { ...this._emotion });
    return this;
  }

  /** Добавить эмоцию к текущей смеси (например, к презрению чуть веселья). */
  addEmotion(emotion, weight = 0.5, duration = 0.6) {
    const mix = { ...(this._emotion?.mix || {}) };
    const add = typeof emotion === 'string' ? parseEmotionString(emotion) : emotion;
    for (const k in add) mix[k] = (mix[k] || 0) + add[k] * weight;
    return this.setEmotion(mix, this._emotion?.intensity ?? 1, duration, { restraint: this._restraint, mirror: this._mirror });
  }

  /** Текущее состояние: эмоция, смесь, итоговые каналы и поза. */
  getEmotion() { return { ...this._emotion }; }
  getState() { return { ...this._emotion, channels: { ...this._out }, pose: { ...this._pose }, speaking: this.speech.active }; }

  /**
   * Микро-выражение: короткая вспышка мимики поверх эмоции.
   * @param {string|object} name  'contempt' | 'browFlick' | ... (см. MICRO) или { channel: value }
   * @param {object} [o] { intensity=1, duration, side: 'left'|'right' }
   */
  micro(name, o = {}) {
    const def = typeof name === 'string' ? MICRO[name] : { au: name, dur: o.duration || 0.35 };
    if (!def) { console.warn('[emotional-head] unknown micro', name); return this; }
    let ch = expandChannels(def.au, o.intensity ?? 1);
    const mirror = o.side ? o.side === 'right' : this._mirror;
    if (mirror) ch = mirrorChannels(ch);
    this._micros.push({ ch, t0: this._t, dur: o.duration || def.dur || 0.35 });
    this._emit('micro', { name, ...o });
    return this;
  }

  /**
   * Жест по ключевым кадрам.
   * @param {string|object} name  'nod'|'shake'|'creakyLaugh'|'scoff'|'sigh'|'eyeRoll'|'slowBlink'|'emphasis'|'browRaise'|'tilt'|'turnAway'|'flinch'|'shrug'
   *                              или собственный { dur, ease, tracks }
   * @param {object} [o] { intensity=1, speed=1, mirror }
   */
  gesture(name, o = {}) {
    const def = typeof name === 'string' ? GESTURES[name] : name;
    if (!def) { console.warn('[emotional-head] unknown gesture', name); return this; }
    const mirror = o.mirror ?? this._mirror;
    const tracks = [];
    for (const key in def.tracks) {
      let targets = key.startsWith('@') ? [key] : Object.keys(expandChannels({ [key]: 1 }));
      if (mirror) targets = targets.map(mirrorName);
      const sign = mirror && (key === '@yaw' || key === '@roll' || key === '@gazeX') ? -1 : 1;
      tracks.push({ targets, keys: def.tracks[key], sign });
    }
    this._gestures.push({ tracks, dur: def.dur, ease: def.ease || 'smooth', t0: this._t, k: o.intensity ?? 1, speed: o.speed ?? 1, name });
    this._emit('gesture', { name: typeof name === 'string' ? name : 'custom', ...o });
    return this;
  }

  /**
   * Разобрать описание-нарратив агента и сыграть его (эмоция + жесты + микро).
   * "Я усмехаюсь, и это не весёлый звук. Это скорее скрип старого механизма." → coldIrony + creakyLaugh
   * @returns {object} результат parseNarrative (для отладки)
   */
  express(text, { duration = 0.9, intensity } = {}) {
    const r = parseNarrative(text);
    if (Object.keys(r.mix).length) this.setEmotion(r.mix, intensity ?? r.intensity, duration, { restraint: r.restraint });
    r.gestures.forEach((g, i) => this._after(0.25 + i * 0.9, () => this.gesture(g)));
    r.micro.forEach((m, i) => this._after(0.5 + i * 0.6, () => this.micro(m)));
    this._emit('express', r);
    return r;
  }

  /**
   * Произнести текст: TTS + lip-sync + эмоция. Возвращает Promise, который резолвится по окончании.
   * @param {string} text  можно с разметкой: [e:contempt] [g:nod] [m:browFlick] [pause:800] *акцент* *ремарка из 3+ слов*
   * @param {object} [o]
   * @param {string|object} [o.emotion]  эмоция на время фразы; 'auto' — определить по тексту
   * @param {number} [o.intensity=1]
   * @param {number} [o.restraint]
   * @param {Function} [o.onEnd]
   * @param {'webspeech'|'none'|Function} [o.tts]  Function: async (text, {lang, gender, rate, pitchVoice}) => ({ audio, alignment?, visemes? })
   * @param {string} [o.lang]   'ru-RU' / 'en-US' (по умолчанию — автоопределение)
   * @param {string|SpeechSynthesisVoice} [o.voice]
   * @param {number} [o.rate] [o.pitch] [o.volume]
   * @param {boolean} [o.revert=false]  вернуть предыдущую эмоцию после фразы
   */
  speak(text, o = {}) {
    const prev = this._emotion;
    if (o.emotion === 'auto') this.express(text, { intensity: o.intensity });
    else if (o.emotion) this.setEmotion(o.emotion, o.intensity ?? 1, o.duration ?? 0.45, { restraint: o.restraint, mirror: o.mirror });
    const opts = { tts: this.options.tts, ...this.options.voice, ...o };
    const p = this.speech.speak(String(text), opts).then(() => {
      if (o.revert && prev) this.setEmotion(prev.emotion, prev.intensity, 0.8, { restraint: prev.restraint, mirror: prev.mirror });
      o.onEnd?.();
    });
    return p;
  }

  /**
   * Lip-sync по готовому аудио (внешний TTS, запись). Текст необязателен, но улучшает форму губ.
   * @param {string|Blob|ArrayBuffer|HTMLAudioElement} audio
   * @param {object} [o] { text, alignment: {chars, times}, visemes: [{t, v}], emotion, onEnd }
   */
  speakAudio(audio, o = {}) { return this.speak(o.text || '', { ...o, audio }); }

  /** Lip-sync по живому потоку (микрофон / WebRTC). Возвращает функцию остановки. */
  listenStream(stream) {
    const ch = this.speech.channels;
    const an = new AudioAnalyser(stream);
    this._stream = () => {
      const a = an.read();
      ch.jawOpen = a.level * 0.5;
      ch.mouthFunnel = smooth01((0.2 - a.centroid) * 6) * 0.4 * a.level;
      ch.mouthStretchLeft = ch.mouthStretchRight = smooth01((a.centroid - 0.25) * 4) * 0.35 * a.level;
      this.speech.level = a.level;
    };
    return () => { this._stream = null; an.dispose(); for (const k in ch) ch[k] = 0; };
  }

  stopSpeaking() { this.speech.stop(); return this; }
  get speaking() { return this.speech.active; }

  /** Сменить пол (пересобирает модель, эмоция и состояние сохраняются). */
  setGender(gender) {
    if (gender !== 'male' && gender !== 'female') throw new Error('gender must be male|female');
    if (gender === this.gender && this.rig && !this._customModel) return this;
    this.gender = gender;
    this._rebuildRig();
    this._emit('genderChange', { gender });
    return this;
  }

  _rebuildRig() {
    this._customModel = false;
    if (this.rig) this.rig.dispose();
    this.rig = this._makeRig(this.gender);
    this.scene.add(this.rig.object3D);
  }

  /**
   * Голова по фотографии: шаржевое портретное сходство + кожа со снимка; эмоции, речь и жесты — те же.
   * Распознавание локальное (MediaPipe в браузере), фото никуда не отправляется. См. photo-avatar.js.
   * @param {File|Blob|string|HTMLImageElement|HTMLCanvasElement} src  файл, URL или изображение
   * @param {object} [o]
   * @param {number} [o.caricature=1.5]  0 — стандартные пропорции, 1 — как на фото, 1.5–2.5 — шарж
   * @param {number} [o.texture=0.9]     сила фото-текстуры кожи (0 — ровный тон)
   * @param {'female'|'male'} [o.gender] основа (шея, плечи, причёска по умолчанию)
   * @param {boolean} [o.shape=false]  сразу подогнать форму по точкам лица (refineShape, +1.5–3 с)
   * @param {'full'} [o.detail]         очки и головные уборы по многоклассовому сегментатору (+16 МБ модель; = accessories: true)
   * @param {function} [o.onProgress]    (text) => void
   * @returns {Promise<object>} отчёт: предупреждения, цвета, меры лица относительно среднего
   */
  async fromPhoto(src, o = {}) {
    const { analyzePortrait } = await import('./photo-avatar.js');
    const portrait = src?.isPortrait ? src : await analyzePortrait(src, o);
    this._portrait = portrait;
    this._photoOpts = { caricature: o.caricature ?? 1.5, texture: o.texture ?? 0.9, realism: o.realism ?? 0.8 };
    if (o.gender) this.gender = o.gender;
    this._rebuildRig();
    if (o.shape) await this.refineShape({ onProgress: o.onProgress });   // деформация по точкам (+1.5–3 с)
    const report = portrait.report;
    this._emit('photoAvatar', report);
    return report;
  }
  /** Изменить шарж/текстуру без повторного распознавания. */
  setPhotoOptions(o = {}) {
    if (!this._portrait) return this;
    Object.assign(this._photoOpts, o);
    this._rebuildRig();
    return this;
  }
  /** Вернуть стандартную голову. */
  clearPhoto() {
    if (!this._portrait) return this;
    this._portrait = null;
    this._rebuildRig();
    this._emit('photoAvatar', null);
    return this;
  }
  get portrait() { return this._portrait || null; }

  /**
   * Метрика сходства фото-аватара: голова рендерится анфас в нейтральном выражении, на рендере ищутся те же
   * 478 точек, что и на фото, и сравниваются в общей нормировке (глаза–рот).
   *   rms / regions — расхождение точек в % расстояния глаза–рот (меньше — ближе к фото; честнее при caricature = 1)
   *   direction     — косинус между отличиями человека от среднего лица и отличиями головы от своей основы (1 — идеально)
   *   gain          — во сколько раз отличия усилены (≈ caricature)
   * Занимает ~0.5 с: две пересборки головы и два распознавания. Нужен фото-аватар.
   * @param {object} [o] { base = true — считать direction/gain, expression = true — рендер с мимикой фото, size = 640 }
   */
  async likeness(o = {}) {
    if (!this._portrait) throw new Error('likeness(): сначала fromPhoto() или importAvatar()');
    const { likenessReport } = await import('./photo-avatar.js');
    // выражение с фото (blendshapes MediaPipe = те же ARKit-каналы): точки сравниваются при одинаковой мимике
    const channels = o.expression !== false && this._portrait.bs ? this._portrait.bs : {};
    const render = await this._shotFace({ ...o, channels });
    let base = null;
    if (o.base !== false) base = await this._withPhotoOpts({ caricature: 0 }, () => this._shotFace({ ...o, channels }));
    return likenessReport(this._portrait, render, base);
  }

  /**
   * Уточнить фото-аватар через рендер: голова рендерится, на рендере измеряются те же черты, что на фото,
   * и параметры подправляются, пока шарж не совпадёт с целью (см. refineStep в photo-avatar.js).
   * Поправки хранятся в портрете и попадают в exportAvatar(). ~1 с на телефоне (3–4 рендера и распознавания).
   * @param {object} [o] { iterations = 2, alpha = 0.8, onProgress }
   * @returns {Promise<number[]>} ошибка по итерациям (нормированная; меньше — точнее)
   */
  async refinePhoto(o = {}) {
    const P = this._portrait;
    if (!P) throw new Error('refinePhoto(): сначала fromPhoto() или importAvatar()');
    const { measureFace, refineStep } = await import('./photo-avatar.js');
    const say = o.onProgress || (() => {});
    const corr = { meas: {}, widths: [0, 0, 0, 0, 0, 0] };
    const setCorr = (c) => { P.corr = c; P._corrV = (P._corrV || 0) + 1; };
    setCorr(null);
    say('Уточняю: основа…');
    const B = measureFace(await this._withPhotoOpts({ caricature: 0 }, () => this._shotFace()));
    const k = this._photoOpts.caricature ?? 1.5, errs = [], n = o.iterations ?? 2;
    let best = { err: Infinity, corr: null };
    // ошибка i-й итерации измерена с поправками i-го шага; оставляем лучшие (распознавание и ограничения параметров шумят)
    for (let it = 0; it <= n; it++) {
      say(it < n ? `Уточняю: шаг ${it + 1}…` : 'Уточняю: проверка…');
      this._rebuildRig();
      const R = measureFace(await this._shotFace());
      const snap = P.corr;
      const err = refineStep(P, corr, R, B, k, { ...o, alpha: it < n ? o.alpha ?? 0.6 : 0 });
      errs.push(+err.toFixed(3));
      if (err < best.err) best = { err, corr: snap };
      if (it < n) setCorr({ ...corr, meas: { ...corr.meas }, widths: [...corr.widths], k });
    }
    setCorr(best.corr);
    this._rebuildRig();
    this._emit('photoAvatar', P.report);
    return errs;
  }

  /**
   * Деформация по точкам лица: овал и нос головы подгоняются под фото по всем точкам контура, а не только
   * по мерам. Голова рендерится с мимикой фото, на рендере ищутся те же точки, и база кожи сдвигается TPS-полем
   * (глаза, брови, губы — неподвижные якоря, морфы и мимика не ломаются). Смещения хранятся в портрете,
   * попадают в exportAvatar() и масштабируются вместе с шаржем. ~1.5 с (4–5 рендеров и распознаваний).
   * Цель: lerp(основа, среднее лицо, realism) + caricature·(фото − среднее); при realism = 1 и caricature = 1 — как на фото.
   * @param {object} [o] { iterations = 3, alpha = 0.7, realism = photoOptions.realism ?? 0.8, onProgress }
   * @returns {Promise<number[]>} ошибка ведущих точек по итерациям, % расстояния глаза–рот
   */
  async refineShape(o = {}) {
    const P = this._portrait;
    if (!P) throw new Error('refineShape(): сначала fromPhoto() или importAvatar()');
    const { shapeStep } = await import('./photo-avatar.js');
    const say = o.onProgress || (() => {});
    const setWarp = (w) => { P.warp = w; P._corrV = (P._corrV || 0) + 1; };
    const k = this._photoOpts.caricature ?? 1.5, channels = P.bs || {}, errs = [], n = o.iterations ?? 3;
    setWarp(null);
    if (!(k > 0)) { this._rebuildRig(); return errs; }
    say('Форма: основа…');
    const re = o.realism ?? this._photoOpts.realism ?? 0.8;
    const B = re >= 1 ? null : await this._withPhotoOpts({ caricature: 0 }, () => this._shotFace({ channels }));
    let best = { err: Infinity, warp: null };
    for (let it = 0; it <= n; it++) {
      say(it < n ? `Форма: шаг ${it + 1}…` : 'Форма: проверка…');
      const R = await this._shotFace({ channels });
      const snap = P.warp && JSON.parse(JSON.stringify(P.warp));
      const err = shapeStep(P, R, B, k, { ...o, realism: re, alpha: it < n ? o.alpha ?? 0.7 : 0 });
      errs.push(+err.toFixed(2));
      if (err < best.err) best = { err, warp: snap };
      if (it < n) { setWarp(P.warp); this._rebuildRig(); }
    }
    setWarp(best.warp);
    this._rebuildRig();
    this._emit('photoAvatar', P.report);
    return errs;
  }

  /** Временно другие настройки фото (с пересборкой), затем вернуть как было. */
  async _withPhotoOpts(opts, fn) {
    const saved = { ...this._photoOpts };
    this._photoOpts = { ...saved, ...opts };
    this._rebuildRig();
    try { return await fn(); } finally { this._photoOpts = saved; this._rebuildRig(); }
  }

  /** Рендер анфас в нейтральном выражении → точки лица на рендере (detectFace). */
  async _shotFace(o = {}) {
    const { detectFace } = await import('./photo-avatar.js');
    const size = o.size ?? 640;
    const cam = this._faceCam ||= new THREE.PerspectiveCamera(11, 1, 1, 60);
    const W = this.renderer.domElement.width, H = this.renderer.domElement.height;
    cam.aspect = W / H; cam.position.set(0, -0.3, 19); cam.lookAt(0, -0.3, 0); cam.updateProjectionMatrix();
    // очки, борода и усы сбивают распознавание на рендере (форма лица под ними та же) — на снимке их нет
    // роговица увеличивает радужку, и MediaPipe сдвигает точки век (глаза +0.5, брови +0.6 к rms); калибровка основы — без неё
    const hide = [this.rig.glasses, ...(this.rig.beard?.parts || []).map((q) => q.mesh)].filter(Boolean);
    hide.forEach((m) => { m.visible = false; m.userData.hidden = true; });
    this.rig.setCornea?.(false);
    this.renderStill(o.channels || {}, {}, cam);
    this.rig.setCornea?.(true);
    hide.forEach((m) => { m.visible = true; m.userData.hidden = false; });
    const s = Math.min(W, H), c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    g.fillStyle = '#6b6f78'; g.fillRect(0, 0, size, size);
    g.drawImage(this.renderer.domElement, (W - s) / 2, (H - s) / 2, s, s, 0, 0, size, size);
    this._render();                                                // вернуть обычный кадр в том же тике (без мигания)
    const d = await detectFace(c);
    if (!d) throw new Error('на рендере не нашлось лица');
    return d;
  }

  /**
   * Детализация геометрии: 'high' (ПК, ~200 тыс. треугольников), 'medium' (телефоны, ~95 тыс.), 'low' (~55 тыс.), 'auto' — medium на телефонах.
   * Пересобирает голову; эмоция и речь продолжаются.
   */
  setDetail(detail = 'auto') {
    this.options.detail = detail;
    this._applyShadows();
    if (this.rig instanceof ProceduralHead) this._rebuildRig();
    return this;
  }
  /** Текущий уровень детализации (после разрешения 'auto'). */
  getDetail() { return this.rig?.detail || resolveDetail(this.options.detail); }

  /**
   * Внешность: тон кожи, цвет глаз, волос, губ, одежды и т.д. Пересобирает голову, эмоция и речь продолжаются.
   *   head.setLook({ skin: 'olive', undertone: 'warm', iris: 'hazel', hair: '#2a1a12' })
   *   head.setLook({ female: { skin: 'tan' }, male: { skin: 'brown' } })
   * Пресеты: SKIN_TONES и EYE_COLORS (head-model.js). Поверх фото-аватара тоже работает.
   * @param {object} look
   * @param {object} [o] { replace: false } — true: заменить, а не дополнить текущие настройки
   */
  setLook(look = {}, o = {}) {
    this.options.look = o.replace ? { ...look } : { ...(this.options.look || {}), ...look };
    if (this.rig instanceof ProceduralHead) this._rebuildRig();      // у glTF-модели своя внешность
    this._emit('lookChange', this.options.look);
    return this;
  }
  getLook() { return { ...(this.options.look || {}) }; }

  /**
   * Экспорт аватара: пол, настройки шаржа и слепок лица (точки, меры, цвета, текстура кожи).
   * Исходного фото внутри нет. Обычно 5–15 КБ JSON — помещается в сообщение, QR-цепочку, localStorage.
   * @param {object} [o] { size=320 — макс. сторона текстуры (0 — без неё, ~5 КБ), quality=0.8, format='object'|'json' }
   * @returns {Promise<object|string>}
   */
  async exportAvatar(o = {}) {
    // v2: + look (пресеты кожи/глаз, цвета, причёска и т.д. из setLook). v1-файлы импортируются как раньше.
    const look = this.options.look || {};
    const d = { format: 'anima-avatar', v: AVATAR_FORMAT, gender: this.gender, look: Object.keys(look).length ? JSON.parse(JSON.stringify(look)) : null,
      photo: this._portrait ? { ...this._photoOpts } : null, portrait: null };
    if (this._portrait) d.portrait = await this._portrait.toData(o);
    return o.format === 'json' ? JSON.stringify(d) : d;
  }
  /**
   * Импорт аватара из exportAvatar(): объект, JSON-строка, File/Blob или URL. MediaPipe не нужен.
   * @param {object} [o] переопределить { caricature, texture, realism, gender, look }
   * @returns {Promise<object|null>} отчёт как у fromPhoto (null — аватар без фото)
   * Внешность (look) из файла заменяет текущую; в файле v1 её нет — текущая сохраняется.
   */
  async importAvatar(src, o = {}) {
    let d = src;
    if (src instanceof Blob) d = await src.text();
    else if (typeof src === 'string' && !/^\s*\{/.test(src)) {
      const r = await fetch(src);
      if (!r.ok) throw new Error(`Аватар не загрузился: ${r.status} ${src}`);
      d = await r.text();
    }
    if (typeof d === 'string') d = JSON.parse(d);
    if (!d || d.format !== 'anima-avatar') throw new Error('Не похоже на файл аватара (format anima-avatar)');
    if (d.v > AVATAR_FORMAT) throw new Error(`Файл аватара новой версии (v${d.v}), обновите библиотеку`);
    const gender = o.gender || d.gender;
    if (o.look || d.look !== undefined) this.options.look = { ...(o.look || d.look || {}) };
    if (!d.portrait) {
      this._portrait = null;
      this._customModel = true;
      this.setGender(gender === 'male' ? 'male' : 'female');
      this._emit('photoAvatar', null);
      return null;
    }
    const { Portrait } = await import('./photo-avatar.js');
    const portrait = await Portrait.fromData(d.portrait);
    return this.fromPhoto(portrait, { ...d.photo, ...o, gender });
  }

  /**
   * Направление взгляда. x, y в диапазоне -1..1 (x>0 — вправо на экране, y>0 — вверх).
   * lookAt(null) — вернуть взгляд к зрителю. o.head — насколько голова поворачивается вслед (0..1).
   */
  lookAt(x, y = 0, o = {}) {
    this._look = x === null || x === undefined ? null : { x: clamp(x, -1.5, 1.5), y: clamp(y, -1.5, 1.5), head: o.head ?? 0.35 };
    this._saccadeAt = 0;
    return this;
  }

  /** Глаза следят за курсором мыши / пальцем. */
  followPointer(on = true) {
    if (this._pointerHandler) { window.removeEventListener('pointermove', this._pointerHandler); this._pointerHandler = null; }
    if (on) {
      this._pointerHandler = (e) => {
        const r = this.renderer.domElement.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height * 0.4;
        this.lookAt((e.clientX - cx) / (r.width * 0.6), -(e.clientY - cy) / (r.height * 0.6), { head: 0.3 });
      };
      window.addEventListener('pointermove', this._pointerHandler, { passive: true });
    } else this.lookAt(null);
    return this;
  }

  /** Включить/выключить idle-анимацию (дыхание, моргание, саккады, дрейф, авто-микровыражения). */
  setIdle(on = true) { this._idle = !!on; return this; }

  /** Прямое управление каналами (перекрывает всё). setChannels({ jawOpen: .3 }); значение null — снять. */
  setChannels(obj) {
    for (const k in obj) {
      if (k === 'pupil') { if (obj[k] === null) delete this._manual.pupil; else this._manual.pupil = obj[k]; continue; }   // зрачок: −1…1.5, мимо expandChannels
      for (const c of Object.keys(expandChannels({ [k]: 1 }))) {
        if (obj[k] === null) delete this._manual[c]; else this._manual[c] = obj[k];
      }
    }
    return this;
  }
  clearChannels() { this._manual = {}; return this; }

  /** Свет: пресет ('studio'|'warm'|'cool'|'noir'|'soft') или объект того же формата. */
  setLighting(preset) {
    const L = typeof preset === 'string' ? LIGHTING[preset] || LIGHTING.studio : { ...LIGHTING.studio, ...preset };
    const set = (light, [color, intensity, pos]) => { light.color.set(color); light.intensity = intensity; light.position.set(...pos).normalize().multiplyScalar(8); };
    set(this.lights.key, L.key); set(this.lights.fill, L.fill); set(this.lights.rim, L.rim);
    this.lights.hemi.color.set(L.hemi[0]); this.lights.hemi.groundColor.set(L.hemi[1]); this.lights.hemi.intensity = L.hemi[2];
    this.scene.environmentIntensity = L.env;   // three r163+; для старых версий используется envMapIntensity материалов
    this.renderer.toneMappingExposure = L.exposure;
    // зрачок от света (2.8): рассеянный свет весит больше направленного; studio ≈ 0, тёмный noir — шире, soft — уже
    const amb = (0.5 * L.key[1] + L.fill[1] + 2 * L.hemi[2] + 0.1 * L.rim[1]) * L.exposure ** 2;
    this._lightPupil = clamp(-0.7 * Math.log2(Math.max(0.05, amb) / 3.02), -0.8, 0.8);
    this._lighting = preset;
    return this;
  }

  /** Фон: 'dark' | 'light' | 'transparent' | любой CSS background. */
  setBackground(bg) {
    this.wrap.style.background = BACKGROUNDS[bg] ?? bg;
    this.vignette.style.display = this.options.vignette && bg !== 'transparent' ? '' : 'none';
    this.vignette.style.background = bg === 'light'
      ? 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(60,70,90,0.18) 100%)'
      : 'radial-gradient(ellipse at 50% 45%, transparent 50%, rgba(0,0,0,0.45) 100%)';
    this._background = bg;
    this._bgPupil = bg === 'light' ? -0.3 : 0;                  // светлый фон — светлая комната: зрачок уже
    return this;
  }

  setFraming(name) {
    const F = FRAMING[name] || FRAMING.portrait;
    this._framing = F;
    this.camera.fov = F.fov;
    this._resize();
    return this;
  }

  /** Подписка на события: 'emotionChange' | 'speakStart' | 'speakEnd' | 'word' | 'cue' | 'gesture' | 'micro' | 'express' | 'genderChange' | 'blink' */
  on(evt, cb) { (this._listeners[evt] ||= new Set()).add(cb); return this; }
  off(evt, cb) { this._listeners[evt]?.delete(cb); return this; }
  once(evt, cb) { const f = (e) => { this.off(evt, f); cb(e); }; return this.on(evt, f); }

  /**
   * Подменить процедурную голову на glTF/GLB с ARKit-blendshapes (Ready Player Me, VRoid perfect-sync, свой).
   * @see gltf-head.js
   */
  async loadModel(url, o = {}) {
    const { GLTFHead } = await import('./gltf-head.js');
    const rig = await GLTFHead.load(url, { renderer: this.renderer, ...o });
    if (this.rig) this.rig.dispose();
    this.rig = rig;
    this._customModel = true;
    this.scene.add(rig.object3D);
    this._emit('modelLoaded', { url });
    return rig;
  }
  /** Вернуться к процедурной голове. */
  useProcedural(gender = this.gender) { this._customModel = true; this._portrait = null; return this.setGender(gender); }

  /** Скриншот текущего кадра (data URL). */
  snapshot(type = 'image/png') { this._render(); return this.renderer.domElement.toDataURL(type); }

  /** Остановить / продолжить анимационный цикл (состояние сохраняется). */
  pause() { cancelAnimationFrame(this._raf); this._raf = 0; this._paused = true; return this; }
  resume() {
    if (!this._paused) return this;
    this._paused = false; this._last = performance.now();
    this._raf = requestAnimationFrame(this._loop);
    return this;
  }
  /**
   * Статичный кадр с заданными каналами и позой, мимо слоёв анимации: тесты, превью, метрика сходства.
   * Состояние головы не меняется — следующий кадр цикла (если он не на паузе) вернёт всё как было.
   * @param {object} [channels]  ARKit-каналы 0..1 (остальные = 0)
   * @param {object} [pose]      { pitch, yaw, roll, eyeYaw, eyePitch, breath, focus }
   * @param {THREE.Camera} [camera]
   * @returns {HTMLCanvasElement}
   */
  renderStill(channels = {}, pose = {}, camera = this.camera) {
    const ch = { ...channels };                                    // + не-ARKit каналы (tongueUp)
    for (const c of CHANNELS) ch[c] = channels[c] || 0;
    this.rig.update(ch, { pitch: 0, yaw: 0, roll: 0, eyeYaw: 0, eyePitch: 0, breath: 0, focus: 8, still: true, pupil: channels.pupil || 0, ...pose });   // still: волосы в равновесии
    this.renderer.render(this.scene, camera);
    return this.renderer.domElement;
  }

  dispose() {
    cancelAnimationFrame(this._raf);
    this.speech.stop(true);
    this.followPointer(false);
    this._ro?.disconnect(); this._io?.disconnect();
    document.removeEventListener('visibilitychange', this._onVis);
    this.rig?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    this.wrap.remove();
    this._listeners = {};
  }

  // ================================================================== внутреннее

  _initRenderer() {
    const wrap = document.createElement('div');
    wrap.className = 'emotional-head';
    wrap.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = !!this.options.shadows;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;';
    const vignette = document.createElement('div');
    vignette.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
    wrap.append(renderer.domElement, vignette);
    this.container.appendChild(wrap);
    if (getComputedStyle(this.container).height === '0px') this.container.style.height = '480px';
    Object.assign(this, { wrap, renderer, vignette });

    this.scene = new THREE.Scene();
    this.scene.environment = makeEnvironment(renderer);
    this.camera = new THREE.PerspectiveCamera(24, 1, 0.1, 60);
    const key = new THREE.DirectionalLight('#ffffff', 2);
    key.castShadow = !!this.options.shadows;
    const sm = DETAIL[resolveDetail(this.options.detail)].shadowMap;
    key.shadow.mapSize.set(sm, sm);
    Object.assign(key.shadow.camera, { left: -1.6, right: 1.6, top: 1.6, bottom: -1.6, near: 1, far: 16 });
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.015;
    key.shadow.radius = 3;
    const fill = new THREE.DirectionalLight('#ffffff', 0.5);
    const rim = new THREE.DirectionalLight('#ffffff', 1.5);
    const hemi = new THREE.HemisphereLight('#ffffff', '#444444', 0.4);
    this.scene.add(key, key.target, fill, rim, hemi);
    this.lights = { key, fill, rim, hemi };
    this._applyShadows();

    this.setFraming(this.options.framing);
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(this.container);
    this._visible = true;
    this._io = new IntersectionObserver((e) => { this._visible = e[0]?.isIntersecting ?? true; });
    this._io.observe(this.container);
    this._onVis = () => { this._last = performance.now(); };
    document.addEventListener('visibilitychange', this._onVis);
  }

  _resize() {
    const w = this.container.clientWidth || 400, h = this.container.clientHeight || 480;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio));
    this.renderer.setSize(w, h, false);
    const F = this._framing || FRAMING.portrait;
    const aspect = w / h;
    this.camera.aspect = aspect;
    const fit = aspect < 0.75 ? 0.75 / aspect : 1;                    // узкий контейнер — отъезжаем
    const [px, py, pz] = F.pos, [tx, ty, tz] = F.target;
    this.camera.position.set(px, py, tz + (pz - tz) * fit);
    this.camera.lookAt(tx, ty, tz);
    this.camera.updateProjectionMatrix();
  }

  _makeRig(gender) {
    const look = this.options.look || {};
    let overrides = look.female || look.male ? look[gender] || {} : look;   // { skin, hair } или { female: {...}, male: {...} }
    if (this._portrait) overrides = { ...this._portrait.fit({ ...this._photoOpts, gender }), ...overrides };
    const shadows = this._applyShadows();                         // уровень детализации мог смениться через options.detail
    return new ProceduralHead({ gender, shadows, overrides, detail: this.options.detail });
  }

  /**
   * Тени по уровню детализации (6.4): на low (shadowMap: 0) прохода теней нет совсем — он почти удваивал вызовы;
   * вместо тени под подбородком голова запекает затенение шеи (ProceduralHead при shadows: false).
   */
  _applyShadows() {
    const sm = DETAIL[resolveDetail(this.options.detail)].shadowMap, on = !!this.options.shadows && sm > 0, key = this.lights?.key;
    this._shadowsOn = on;
    this.renderer.shadowMap.enabled = on;
    if (!key) return on;
    key.castShadow = on;
    if (on && key.shadow.mapSize.x !== sm) { key.shadow.mapSize.set(sm, sm); key.shadow.map?.dispose(); key.shadow.map = null; }
    return on;
  }

  _initState() {
    const neutral = resolveEmotion('neutral').state;
    this._base = { ...neutral };
    this._from = { ...neutral };
    this._to = { ...neutral };
    this._tween = { t0: 0, dur: 0 };
    this._out = {};
    for (const c of CHANNELS) this._out[c] = 0;
    this._speechSm = {};
    for (const c of SPEECH_CHANNELS) this._speechSm[c] = 0;
    this._speechW = 0;
    this._micros = [];
    this._gestures = [];
    this._manual = {};
    this._microPool = {};
    this._restraint = 0;
    this._mirror = false;
    this._pose = { pitch: 0, yaw: 0, roll: 0, eyeYaw: 0, eyePitch: 0, breath: 0, focus: 8 };
    this._blink = null;
    this._nextBlink = 1.5;
    this._fix = { x: 0, y: 0, averted: false };
    this._saccadeAt = 0.5;
    this._eyeW = { yaw: 0, pitch: 0 };
    this._headFollow = { yaw: 0, pitch: 0 };
    this._nod = { p: 0, v: 0 };
    this._look = null;
  }

  _emit(evt, data) { this._listeners[evt]?.forEach((cb) => { try { cb(data); } catch (e) { console.error(e); } }); }
  _after(sec, fn) { this._timers.push({ t: this._t + sec, fn }); }

  // ---------------- речь: колбэки
  _onSpeakStart(text) {
    this._emit('speakStart', { text });
    // в начале реплики люди часто коротко отводят взгляд ("собираются с мыслью")
    if (this._idle && Math.random() < 0.35) this._avert(rand(0.5, 1.0));
  }
  _onSpeakEnd() {
    this._emit('speakEnd', {});
    this._fix = { x: 0, y: 0, averted: false };                       // в конце реплики — взгляд на собеседника
    this._saccadeAt = this._t + rand(0.8, 1.6);
  }
  _onCue(c) {
    this._emit('cue', c);
    if (c.type === 'emotion') this.setEmotion(c.value, 1, 0.4, { restraint: this._restraint });
    else if (c.type === 'gesture') this.gesture(c.value);
    else if (c.type === 'micro') this.micro(c.value);
    else if (c.type === 'narrative') this.express(c.value, { duration: 0.5 });
    else if (c.type === 'emphasis') this._emphasis(c.value);
  }
  _onWord(w) {
    this._emit('word', w);
    if (Math.random() < 0.3) this._nod.v += 0.12 * (this._base['@artic'] || 1) * (this._base['@headMotion'] || 1);
    if (Math.random() < 0.06) this.micro('browFlash', { intensity: 0.35 });
  }
  _emphasis(k = 1) {
    // характер акцента зависит от эмоции: при нахмуренности — давящий (брови вниз), иначе — вскинутые брови
    const frown = ((this._base.browDownLeft || 0) + (this._base.browDownRight || 0)) / 2;
    if (frown > 0.2) this.gesture('emphasis', { intensity: k });
    else this.micro('browFlash', { intensity: 0.6 * k, duration: 0.45 });
    this._nod.v += 0.35 * k;
  }

  // ---------------- взгляд
  _avert(dur) {
    const gx = this._base['@gazeX'], gy = this._base['@gazeY'];
    const dirX = Math.abs(gx) > 0.05 ? Math.sign(gx) : Math.random() < 0.5 ? -1 : 1;
    this._fix = { x: dirX * rand(0.22, 0.45) + gx * 0.6, y: (Math.abs(gy) > 0.05 ? gy * 1.2 : rand(-0.25, 0.12)), averted: true };
    this._saccadeAt = this._t + dur;
    if (Math.random() < 0.4) this._startBlink();
  }

  _updateGaze(dt, gx, gy) {
    const t = this._t, b = this._base;
    if (this._idle && t >= this._saccadeAt) {
      const steady = b['@steady'], aversion = b['@aversion'] * (this.speech.active ? 1.25 : 1);
      if (this._fix.averted) {
        this._fix = { x: rand(-0.02, 0.02), y: rand(-0.015, 0.015), averted: false };
        this._saccadeAt = t + rand(0.6, 1.8) * (0.6 + steady * 2.2);
        if (Math.random() < 0.3) this._startBlink();
      } else if (!this._look && Math.random() < aversion * 0.6) {
        this._avert(rand(0.7, 2.2) * (1 + aversion));
      } else {
        // микро-саккады по "треугольнику" глаза-глаза-рот собеседника
        const pts = [[-0.025, 0.012], [0.025, 0.012], [0, -0.035]];
        const p = pts[Math.floor(Math.random() * 3)];
        const amp = 1 - steady * 0.8;
        this._fix = { x: p[0] * amp, y: p[1] * amp, averted: false };
        this._saccadeAt = t + rand(0.35, 1.6) * (0.5 + steady * 2.5);
      }
    }
    const look = this._look;
    let tyaw = look ? look.x * 0.55 : 0, tpitch = look ? look.y * 0.35 : -0.02;
    tyaw += b['@gazeX'] * 0.25 + this._fix.x + gx;
    tpitch += b['@gazeY'] * 0.25 + this._fix.y + gy;
    if (!this._idle) { tyaw = look ? look.x * 0.55 : b['@gazeX'] * 0.25; tpitch = look ? look.y * 0.35 : b['@gazeY'] * 0.25; tyaw += gx; tpitch += gy; }
    // саккада: очень быстро (≈40 мс)
    const k = Math.min(1, dt * 30);
    const before = this._eyeW.yaw;
    this._eyeW.yaw += (tyaw - this._eyeW.yaw) * k;
    this._eyeW.pitch += (tpitch - this._eyeW.pitch) * k;
    if (Math.abs(this._eyeW.yaw - before) > 0.012 && Math.abs(tyaw - before) > 0.2 && Math.random() < 0.02) this._startBlink();
    // голова догоняет взгляд (медленно)
    const follow = look ? look.head : (this._fix.averted ? 0.3 : 0);
    const hk = Math.min(1, dt * 2.5);
    this._headFollow.yaw += (tyaw * follow - this._headFollow.yaw) * hk;
    this._headFollow.pitch += (-tpitch * follow * 0.8 - this._headFollow.pitch) * hk;
  }

  // ---------------- моргание
  _startBlink(speed) {
    const s = (speed || this._base['@blinkSpeed'] || 1) * rand(0.9, 1.1);
    this._blink = { t0: this._t, c: 0.075 / s, h: 0.035 / s, o: 0.16 / s };
    this._emit('blink', {});
  }
  _blinkValue() {
    const t = this._t;
    if (this._idle && t >= this._nextBlink && !this._blink) {
      this._startBlink();
      const rate = Math.max(0.1, this._base['@blinkRate']) * (this.speech.active ? 1.25 : 1);
      this._nextBlink = t + Math.min(9, (1.0 + -Math.log(1 - Math.random()) * 2.8) / rate);
      if (Math.random() < 0.12) this._after(0.32, () => this._startBlink());   // двойное моргание
    }
    const b = this._blink;
    if (!b) return 0;
    const u = t - b.t0;
    if (u < b.c) return smooth01(u / b.c);
    if (u < b.c + b.h) return 1;
    if (u < b.c + b.h + b.o) return 1 - smooth01((u - b.c - b.h) / b.o);
    this._blink = null;
    return 0;
  }

  // ---------------- главный цикл
  _loop(now) {
    this._raf = requestAnimationFrame(this._loop);
    const raw = Math.max(0, (now - this._last) / 1000);
    const dt = Math.min(0.05, raw);                  // анимация: защищаемся от рывков
    this._rawDt = Math.min(0.5, raw);                // речь: реальное время, чтобы не отставать от звука на медленных устройствах
    this._last = now;
    this._t += dt;
    for (let i = this._timers.length - 1; i >= 0; i--) {
      if (this._timers[i].t <= this._t) { const f = this._timers[i].fn; this._timers.splice(i, 1); f(); }
    }
    this._update(dt);
    if (this._visible && !document.hidden) this._render();
  }

  _render() { this.renderer.render(this.scene, this.camera); }

  _update(dt) {
    const t = this._t, base = this._base, out = this._out, idle = this._idle;

    // 1. base: твин между эмоциями
    const tw = this._tween;
    const p = tw.dur > 0 ? clamp((t - tw.t0) / tw.dur, 0, 1) : 1;
    const e = easeInOutCubic(p);
    for (const k in this._to) base[k] = (this._from[k] ?? this._to[k]) + (this._to[k] - (this._from[k] ?? this._to[k])) * e;

    for (const c of CHANNELS) out[c] = base[c];
    const g = { '@pitch': 0, '@yaw': 0, '@roll': 0, '@gazeX': 0, '@gazeY': 0, '@breath': 0 };

    // 2. idle: живой шум мимики (асимметричный, очень слабый)
    if (idle) {
      const hm = base['@headMotion'];
      out.browInnerUp += 0.035 * Math.max(0, noise(t * 0.7, 11)) * hm;
      out.browOuterUpLeft += 0.02 * Math.max(0, noise(t * 0.6, 12)) * hm;
      out.browOuterUpRight += 0.02 * Math.max(0, noise(t * 0.6, 13)) * hm;
      out.mouthSmileLeft += 0.012 * noise(t * 0.5, 14);
      out.mouthSmileRight += 0.012 * noise(t * 0.5, 15);
      out.eyeSquintLeft += 0.02 * Math.max(0, noise(t * 0.4, 16));
      out.eyeSquintRight += 0.02 * Math.max(0, noise(t * 0.4, 16.5));

      // авто-микровыражения: из пула эмоции + "утечки" при сдержанности
      let poolW = 0;
      for (const m in this._microPool) poolW += this._microPool[m];
      if (poolW > 0) {
        const lambda = 0.07 * base['@microRate'] * Math.min(1.5, poolW) + this._restraint * 0.35;
        if (Math.random() < lambda * dt) {
          let r = Math.random() * poolW;
          for (const m in this._microPool) { r -= this._microPool[m]; if (r <= 0) { this.micro(m, { intensity: rand(0.45, 0.9) * (1 + this._restraint * 0.3) }); break; } }
        }
      }
    }

    // 3. micro
    for (let i = this._micros.length - 1; i >= 0; i--) {
      const m = this._micros[i];
      const u = (t - m.t0) / m.dur;
      if (u >= 1) { this._micros.splice(i, 1); continue; }
      const env = u < 0.2 ? smooth01(u / 0.2) : u < 0.55 ? 1 : 1 - smooth01((u - 0.55) / 0.45);
      for (const k in m.ch) out[k] = (out[k] || 0) + m.ch[k] * env;
    }

    // 4. gestures
    for (let i = this._gestures.length - 1; i >= 0; i--) {
      const G = this._gestures[i];
      const u = (t - G.t0) * G.speed;
      if (u >= G.dur) { this._gestures.splice(i, 1); continue; }
      for (const tr of G.tracks) {
        const v = sampleTrack(tr.keys, u, G.ease) * G.k * tr.sign;
        for (const target of tr.targets) {
          if (target in g) g[target] += v; else out[target] = (out[target] || 0) + v;
        }
      }
    }

    // 5. speech
    const sp = this._stream ? (this._stream(), this.speech.channels) : this.speech.update(this._rawDt ?? dt);
    const active = this.speech.active || !!this._stream;
    this._speechW += ((active ? 1 : 0) - this._speechW) * Math.min(1, dt * 8);
    const artic = base['@artic'];
    for (const c of SPEECH_CHANNELS) {
      const target = (sp[c] || 0) * artic;
      const cur = this._speechSm[c];
      const rate = target > cur ? 26 : 16;
      this._speechSm[c] = cur + (target - cur) * Math.min(1, dt * rate);
      out[c] = (out[c] || 0) * (1 - 0.65 * this._speechW) + this._speechSm[c];   // tongueUp — вне CHANNELS
    }
    // улыбка во время речи растягивает "о/у" — компенсируем, чтобы рот не выворачивало
    if (this._speechW > 0.01) {
      const sm = (out.mouthSmileLeft + out.mouthSmileRight) / 2;
      out.mouthPucker *= 1 - 0.4 * sm;
    }

    // 6. моргание поверх век
    const bl = this._blinkValue();
    out.eyeBlinkLeft = out.eyeBlinkLeft + (1 - out.eyeBlinkLeft) * bl;
    out.eyeBlinkRight = out.eyeBlinkRight + (1 - out.eyeBlinkRight) * bl;

    // 7. manual + clamp
    for (const k in this._manual) out[k] = this._manual[k];
    for (const c of CHANNELS) out[c] = clamp(out[c] || 0, 0, 1);
    out.tongueUp = clamp(out.tongueUp || 0, 0, 1);

    // поза головы
    const hm = idle ? base['@headMotion'] : 0;
    const breathPeriod = 4.2 / (1 + this._restraint * 0.2);
    const breath = (idle ? Math.sin((t / breathPeriod) * Math.PI * 2) * 0.8 : 0) + g['@breath'];
    const N = this._nod;
    N.v += (-120 * N.p - 14 * N.v) * dt;
    N.p += N.v * dt;
    const talk = this.speech.level * this._speechW;
    this._updateGaze(dt, g['@gazeX'], g['@gazeY']);
    const P = this._pose;
    P.pitch = base['@pitch'] + 0.022 * noise(t, 1) * hm + 0.006 * breath + g['@pitch'] + N.p * 0.06 + this._headFollow.pitch + 0.012 * noise(t * 3, 5) * talk;
    P.yaw = base['@yaw'] + 0.035 * noise(t * 0.8, 2) * hm + g['@yaw'] + this._headFollow.yaw + 0.02 * noise(t * 2.2, 4) * talk;
    P.roll = base['@roll'] + 0.016 * noise(t * 0.7, 3) * hm + g['@roll'];
    // глаза относительно головы (вестибуло-окулярный рефлекс: голова качнулась — глаза компенсируют)
    P.eyeYaw = clamp(this._eyeW.yaw - P.yaw, -0.6, 0.6);
    P.eyePitch = clamp(this._eyeW.pitch + P.pitch, -0.45, 0.45);
    P.breath = breath;
    P.focus = this.camera.position.z;
    // зрачок (2.8): свет + эмоция (@pupil) + усилие при речи + гиппус (медленное «дыхание» зрачка);
    // сужается быстро (~0.25 с), расширяется медленно (~1 с). setChannels({ pupil }) — вручную.
    let pt = (this._lightPupil || 0) + (this._bgPupil || 0) + (base['@pupil'] || 0) + 0.12 * this._speechW + (idle ? 0.06 * noise(t * 1.3, 21) : 0);
    if (typeof this._manual.pupil === 'number') pt = this._manual.pupil;
    if (this._pupilV === undefined) this._pupilV = pt;
    this._pupilV += (pt - this._pupilV) * Math.min(1, dt * (pt < this._pupilV ? 4 : 0.9));
    P.pupil = this._pupilV;
    this.rig.update(out, P);
  }
}

// ------------------------------------------------------------------ helpers
function sampleTrack(keys, u, ease) {
  if (u <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, v0] = keys[i], [t1, v1] = keys[i + 1];
    if (u <= t1) {
      if (ease === 'step') return v0;
      return v0 + (v1 - v0) * smooth01((u - t0) / (t1 - t0));
    }
  }
  return keys[keys.length - 1][1] * (ease === 'step' ? 1 : 1);
}
function mirrorName(k) {
  if (k.endsWith('Left')) return k.slice(0, -4) + 'Right';
  if (k.endsWith('Right')) return k.slice(0, -5) + 'Left';
  if (k === 'mouthLeft') return 'mouthRight';
  if (k === 'mouthRight') return 'mouthLeft';
  if (k === 'jawLeft') return 'jawRight';
  if (k === 'jawRight') return 'jawLeft';
  return k;
}
function mirrorChannels(ch) { const o = {}; for (const k in ch) o[mirrorName(k)] = ch[k]; return o; }

// реэкспорт, чтобы хватало одного импорта
export { SKIN_TONES, EYE_COLORS, EYE_SHAPES, NOSE_SHAPES, TEETH_COLORS, LIP_PROFILES, OUTFITS, HEADPHONES, MASKS, GLASSES, BEARDS, HAIR_STYLES, HATS, EARRINGS, MAKEUP, CHANNELS, EMOTIONS, MICRO, GESTURES, ALIASES, VISEMES, WebSpeech, parseNarrative, parseEmotionString, parseMarkup, resolveEmotion };
export default EmotionalHead;
