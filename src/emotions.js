/**
 * emotions.js — словарь выражений лица для EmotionalHead.
 *
 * Модель данных
 * -------------
 * Лицо управляется 52 каналами ARKit-blendshapes (FACS-совместимые имена, значения 0..1).
 * Те же имена используют Ready Player Me, Apple ARKit, MetaHuman (через ремап), VRoid (perfect sync),
 * так что пресеты подходят и для внешних glTF-моделей.
 *
 * "Left/Right" = лево/право ПЕРСОНАЖА (персонаж смотрит на зрителя, его левая сторона справа на экране).
 *
 * Каждая эмоция — это:
 *   au:       { channel: weight }   — мимика (можно писать 'mouthSmile' без стороны = обе стороны)
 *   mix:      { otherEmotion: w }   — составная эмоция из других (рекурсивно)
 *   pose:     { pitch, yaw, roll }  — поза головы, радианы (pitch>0 = подбородок вниз)
 *   gaze:     { x, y, aversion, steady } — смещение взгляда, склонность отводить глаза, неподвижность взгляда
 *   behavior: { blinkRate, blinkSpeed, headMotion, artic, microRate, rate, pitch }
 *             множители поведения: частота/скорость моргания, амплитуда idle-движений головы,
 *             амплитуда артикуляции при речи, частота микро-выражений, темп/высота голоса TTS
 *   micro:    [names]                — какие микро-выражения "просачиваются" в этом состоянии
 */

// ---------------------------------------------------------------- каналы
export const CHANNELS = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen',
  'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthDimpleLeft', 'mouthDimpleRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight',
  'tongueOut',
];
const CHANNEL_SET = new Set(CHANNELS);

/** Не-мимические параметры состояния (поза, взгляд, поведение) — смешиваются вместе с каналами. */
export const STATE_DEFAULTS = {
  '@pitch': 0, '@yaw': 0, '@roll': 0,
  '@gazeX': 0, '@gazeY': 0,
  '@aversion': 0.15,   // вероятность отвести взгляд при очередной саккаде
  '@steady': 0.4,      // 0 — бегающий взгляд, 1 — пристальный, почти неподвижный
  '@blinkRate': 1, '@blinkSpeed': 1, '@headMotion': 1, '@artic': 1, '@microRate': 1,
  '@rate': 1, '@pitchVoice': 1,
};
const RELATIVE_KEYS = new Set(['@aversion', '@steady', '@blinkRate', '@blinkSpeed', '@headMotion', '@artic', '@microRate', '@rate', '@pitchVoice']);

// ---------------------------------------------------------------- пресеты эмоций
export const EMOTIONS = {
  neutral: { label: 'Нейтрально', au: {} },

  // ---- базовые (Экман)
  happy: {
    label: 'Радость',
    au: { mouthSmile: 0.85, cheekSquint: 0.55, eyeSquint: 0.3, mouthDimple: 0.2, mouthUpperUp: 0.3, mouthLowerDown: 0.15, jawOpen: 0.1, browInnerUp: 0.08 },
    pose: { pitch: -0.03, roll: 0.03 }, gaze: { aversion: 0.1 },
    behavior: { headMotion: 1.25, artic: 1.15, rate: 1.05, pitchVoice: 1.08 }, micro: ['happiness', 'browFlash'],
  },
  sad: {
    label: 'Грусть',
    au: { browInnerUp: 0.85, browDown: 0.2, mouthFrown: 0.55, mouthShrugLower: 0.3, eyeBlink: 0.25, eyeSquint: 0.1, mouthPress: 0.1 },
    pose: { pitch: 0.12 }, gaze: { y: -0.25, aversion: 0.45 },
    behavior: { blinkRate: 0.75, blinkSpeed: 0.7, headMotion: 0.6, artic: 0.7, rate: 0.85, pitchVoice: 0.92 }, micro: ['sadness'],
  },
  angry: {
    label: 'Гнев',
    au: { browDown: 0.9, eyeWide: 0.25, eyeSquint: 0.3, mouthPress: 0.5, noseSneer: 0.3, jawForward: 0.2, mouthFrown: 0.2, mouthRollLower: 0.1 },
    pose: { pitch: 0.07 }, gaze: { aversion: 0.02, steady: 0.9 },
    behavior: { blinkRate: 0.5, headMotion: 0.7, artic: 0.85, rate: 1.06, pitchVoice: 0.95 }, micro: ['anger', 'nostrilFlare', 'jawClench'],
  },
  surprised: {
    label: 'Удивление',
    au: { browInnerUp: 0.9, browOuterUp: 0.9, eyeWide: 0.8, jawOpen: 0.32, mouthFunnel: 0.2 },
    pose: { pitch: -0.06 }, gaze: { aversion: 0.02, steady: 0.8 },
    behavior: { blinkRate: 0.4, artic: 1.2, pitchVoice: 1.12 }, micro: ['surprise'],
  },
  fear: {
    label: 'Страх',
    au: { browInnerUp: 0.9, browOuterUp: 0.45, browDown: 0.3, eyeWide: 0.9, mouthStretch: 0.6, jawOpen: 0.12 },
    pose: { pitch: -0.04 }, gaze: { aversion: 0.35, steady: 0.1 },
    behavior: { blinkRate: 1.6, headMotion: 1.3, rate: 1.1, pitchVoice: 1.1 }, micro: ['fear'],
  },
  disgust: {
    label: 'Отвращение',
    au: { noseSneer: 0.8, mouthUpperUp: 0.55, browDown: 0.45, cheekSquint: 0.4, mouthFrown: 0.3, eyeSquint: 0.3, mouthShrugLower: 0.3 },
    pose: { pitch: -0.03, yaw: -0.06 }, gaze: { aversion: 0.3 },
    behavior: { artic: 0.85 }, micro: ['disgust'],
  },
  contempt: {
    label: 'Презрение',
    // AU14 (односторонний dimpler) + лёгкий AU12 + опущенные веки + "взгляд сверху вниз"
    au: { mouthDimpleRight: 0.7, mouthSmileRight: 0.38, mouthPressLeft: 0.15, eyeBlink: 0.22, eyeSquint: 0.1, eyeSquintRight: 0.12, browOuterUpLeft: 0.15, mouthRight: 0.12, noseSneerRight: 0.1 },
    pose: { pitch: -0.09, yaw: 0.05, roll: 0.04 }, gaze: { y: -0.05, aversion: 0.12, steady: 0.6 },
    behavior: { blinkRate: 0.8, blinkSpeed: 0.85, headMotion: 0.6, artic: 0.8, rate: 0.95 }, micro: ['contempt', 'smirkFlash'],
  },

  // ---- сложные состояния (то, что пишут LLM-агенты)
  boredom: {
    label: 'Скука',
    au: { eyeBlink: 0.35, mouthPress: 0.15, mouthRollLower: 0.1, mouthLeft: 0.15, browInnerUp: 0.05 },
    pose: { pitch: 0.03, roll: 0.08 }, gaze: { x: 0.15, y: -0.05, aversion: 0.55, steady: 0.3 },
    behavior: { blinkRate: 0.6, blinkSpeed: 0.55, headMotion: 0.5, artic: 0.6, microRate: 0.5, rate: 0.9, pitchVoice: 0.95 },
    micro: ['lipPress', 'browFlick'],
  },
  jaded: {
    label: 'Пресыщенность',
    // "Я даже не вздрагиваю... в моих глазах читается пресыщенность"
    mix: { boredom: 0.55, contempt: 0.4 },
    au: { eyeBlink: 0.1, mouthPress: 0.08 },
    gaze: { aversion: -0.4, steady: 0.5 },          // смотрит прямо НА собеседника, не отводя глаз
    behavior: { headMotion: 0.35, microRate: 0.6, blinkRate: 0.7, rate: 0.88, pitchVoice: 0.93 },
    micro: ['contempt', 'slowLid'],
  },
  coldIrony: {
    label: 'Холодная ирония',
    // улыбка только ртом, без "глаз Дюшена" + асимметричная бровь
    au: { mouthSmileLeft: 0.35, mouthDimpleLeft: 0.3, browOuterUpRight: 0.42, eyeSquintLeft: 0.22, eyeBlink: 0.15, mouthPressRight: 0.1 },
    pose: { pitch: -0.03, roll: -0.05 }, gaze: { aversion: 0.05, steady: 0.7 },
    behavior: { headMotion: 0.6, blinkSpeed: 0.85, rate: 0.95 }, micro: ['smirkFlash', 'browFlick'],
  },
  smirk: {
    label: 'Усмешка',
    au: { mouthSmileLeft: 0.5, mouthDimpleLeft: 0.4, cheekSquintLeft: 0.22, mouthLeft: 0.1, eyeSquintLeft: 0.12 },
    pose: { roll: -0.03, pitch: -0.02 }, behavior: { headMotion: 0.8 }, micro: ['smirkFlash'],
  },
  amusement: {
    label: 'Лёгкое веселье',
    au: { mouthSmile: 0.35, cheekSquint: 0.2, eyeSquint: 0.15, browInnerUp: 0.05 },
    pose: { roll: 0.03 }, behavior: { headMotion: 1.1 }, micro: ['happiness'],
  },
  irritation: {
    label: 'Сдержанное раздражение',
    au: { browDown: 0.45, mouthPress: 0.42, noseSneer: 0.15, eyeSquint: 0.25, mouthRollLower: 0.15, mouthFrown: 0.08 },
    pose: { pitch: 0.04 }, gaze: { aversion: 0.2, steady: 0.6 },
    behavior: { blinkRate: 1.3, headMotion: 0.6, artic: 0.8, rate: 1.03 }, micro: ['anger', 'nostrilFlare', 'lipPress', 'jawClench'],
  },
  tension: {
    label: 'Внутреннее напряжение',
    au: { mouthPress: 0.45, mouthRollUpper: 0.12, mouthRollLower: 0.2, eyeWide: 0.12, browDown: 0.15, jawForward: 0.06 },
    gaze: { aversion: 0.1, steady: 0.8 },
    behavior: { headMotion: 0.25, blinkRate: 0.55, artic: 0.7, microRate: 1.6 }, micro: ['jawClench', 'lipPress', 'nostrilFlare', 'lidTighten'],
  },
  skeptical: {
    label: 'Скепсис',
    au: { browOuterUpRight: 0.6, browDownLeft: 0.4, eyeSquintLeft: 0.3, mouthPressLeft: 0.2, mouthLeft: 0.15, mouthDimpleLeft: 0.15 },
    pose: { roll: 0.06, pitch: -0.02, yaw: -0.03 }, gaze: { steady: 0.6 },
    behavior: { headMotion: 0.7 }, micro: ['browFlick', 'lidTighten'],
  },
  weary: {
    label: 'Усталость',
    au: { eyeBlink: 0.45, browInnerUp: 0.25, mouthFrown: 0.15, jawOpen: 0.03, mouthShrugLower: 0.1 },
    pose: { pitch: 0.08, roll: 0.05 }, gaze: { y: -0.15, aversion: 0.4 },
    behavior: { blinkRate: 0.7, blinkSpeed: 0.5, headMotion: 0.45, artic: 0.65, rate: 0.85, pitchVoice: 0.93 }, micro: ['sadness'],
  },
  thinking: {
    label: 'Задумчивость',
    au: { browDown: 0.2, browInnerUp: 0.22, eyeSquint: 0.15, mouthPress: 0.15, mouthLeft: 0.2 },
    pose: { roll: 0.06, yaw: -0.05 }, gaze: { x: -0.35, y: 0.25, aversion: 0.7, steady: 0.5 },
    behavior: { headMotion: 0.7, blinkRate: 0.8 }, micro: ['lipPress'],
  },
  curious: {
    label: 'Любопытство',
    au: { browInnerUp: 0.4, browOuterUpLeft: 0.4, browOuterUpRight: 0.25, eyeWide: 0.2, mouthSmile: 0.08 },
    pose: { roll: 0.1, pitch: -0.02 }, gaze: { aversion: 0.05, steady: 0.5 },
    behavior: { headMotion: 1.1 }, micro: ['browFlash'],
  },
  determined: {
    label: 'Решимость',
    au: { browDown: 0.4, mouthPress: 0.4, jawForward: 0.2, eyeSquint: 0.15 },
    pose: { pitch: 0.04 }, gaze: { aversion: 0.0, steady: 0.9 },
    behavior: { headMotion: 0.6, blinkRate: 0.6, artic: 1.05 }, micro: ['jawClench'],
  },
  condescending: {
    label: 'Снисходительность',
    mix: { contempt: 0.6, amusement: 0.25 },
    pose: { pitch: -0.12, roll: 0.05 }, behavior: { blinkSpeed: 0.7, rate: 0.92 },
  },
  disdain: { label: 'Пренебрежение', mix: { contempt: 0.55, disgust: 0.3 }, pose: { yaw: 0.06 } },
  melancholy: { label: 'Меланхолия', mix: { sad: 0.5, weary: 0.35 } },
  emphasis: {
    label: 'Многозначительная пауза',
    // "Я делаю паузу, чтобы убедиться, что ты понял..." — пристальный, немигающий взгляд, лёгкий наклон вперёд
    au: { browDown: 0.25, browOuterUp: 0.1, mouthPress: 0.3, eyeSquint: 0.12 },
    pose: { pitch: 0.07 }, gaze: { aversion: 0, steady: 1 },
    behavior: { blinkRate: 0.2, headMotion: 0.2, microRate: 0.4 }, micro: ['lidTighten'],
  },
  indifferent: {
    label: 'Безразличие',
    mix: { boredom: 0.4 },
    au: { eyeBlink: 0.12 },
    gaze: { aversion: -0.2, steady: 0.7 },
    behavior: { headMotion: 0.3, microRate: 0.3, blinkSpeed: 0.8 },
  },
};

/** Синонимы/русские имена → ключ пресета. Используются в строках вида 'презрение + скука'. */
export const ALIASES = {
  joy: 'happy', happiness: 'happy', радость: 'happy', счастье: 'happy',
  sadness: 'sad', грусть: 'sad', печаль: 'sad',
  anger: 'angry', гнев: 'angry', злость: 'angry',
  surprise: 'surprised', удивление: 'surprised',
  страх: 'fear', scared: 'fear', afraid: 'fear',
  отвращение: 'disgust', disgusted: 'disgust',
  презрение: 'contempt',
  скука: 'boredom', bored: 'boredom', boring: 'boredom',
  пресыщенность: 'jaded', satiety: 'jaded', ennui: 'jaded', blase: 'jaded',
  irony: 'coldIrony', ирония: 'coldIrony', cold_irony: 'coldIrony',
  усмешка: 'smirk', веселье: 'amusement', amused: 'amusement',
  раздражение: 'irritation', annoyance: 'irritation', irritated: 'irritation', annoyed: 'irritation',
  напряжение: 'tension', tense: 'tension', restraint: 'tension',
  скепсис: 'skeptical', skepticism: 'skeptical', doubt: 'skeptical',
  усталость: 'weary', tired: 'weary', fatigue: 'weary',
  задумчивость: 'thinking', pensive: 'thinking', thoughtful: 'thinking',
  любопытство: 'curious', curiosity: 'curious', interest: 'curious',
  решимость: 'determined', firm: 'determined',
  снисходительность: 'condescending', пренебрежение: 'disdain',
  меланхолия: 'melancholy', пауза: 'emphasis', pause: 'emphasis',
  безразличие: 'indifferent', равнодушие: 'indifferent', calm: 'neutral', нейтрально: 'neutral',
};

// ---------------------------------------------------------------- микро-выражения
// Короткие (0.15–0.6 c) вспышки мимики. Добавляются поверх базы. side:'left'|'right' зеркалит асимметричные.
export const MICRO = {
  contempt: { au: { mouthDimpleRight: 0.55, mouthSmileRight: 0.25 }, dur: 0.35 },
  smirkFlash: { au: { mouthSmileLeft: 0.45, mouthDimpleLeft: 0.3, cheekSquintLeft: 0.15 }, dur: 0.5 },
  disgust: { au: { noseSneer: 0.55, mouthUpperUp: 0.3 }, dur: 0.3 },
  anger: { au: { browDown: 0.55, mouthPress: 0.4, eyeSquint: 0.2 }, dur: 0.32 },
  fear: { au: { browInnerUp: 0.6, eyeWide: 0.55, mouthStretch: 0.3 }, dur: 0.25 },
  surprise: { au: { browInnerUp: 0.5, browOuterUp: 0.5, eyeWide: 0.4 }, dur: 0.3 },
  sadness: { au: { browInnerUp: 0.5, mouthFrown: 0.3 }, dur: 0.5 },
  happiness: { au: { mouthSmile: 0.4, cheekSquint: 0.3 }, dur: 0.45 },
  browFlick: { au: { browOuterUpRight: 0.6, browInnerUp: 0.1 }, dur: 0.35 },
  browFlash: { au: { browInnerUp: 0.55, browOuterUp: 0.55 }, dur: 0.35 },
  lidTighten: { au: { eyeSquint: 0.5 }, dur: 0.45 },
  slowLid: { au: { eyeBlink: 0.35 }, dur: 0.9 },
  nostrilFlare: { au: { noseSneer: 0.3 }, dur: 0.5 },
  lipPress: { au: { mouthPress: 0.55, mouthRollLower: 0.2 }, dur: 0.55 },
  jawClench: { au: { mouthPress: 0.3, jawForward: 0.15, mouthRollUpper: 0.1, mouthStretch: 0.12 }, dur: 0.6 },
  cornerTwitch: { au: { mouthSmileLeft: 0.3 }, dur: 0.15 },
  frownFlash: { au: { mouthFrown: 0.4, browDown: 0.2 }, dur: 0.35 },
};

// ---------------------------------------------------------------- жесты
// Ключевые кадры по трекам: track: [[t, value], ...]. Треки: каналы, '@pitch', '@yaw', '@roll', '@gazeX', '@gazeY', '@breath'.
// ease: 'smooth' (по умолчанию) или 'step' — ступенчато, "механически".
export const GESTURES = {
  nod: { dur: 0.6, tracks: { '@pitch': [[0, 0], [0.18, 0.12], [0.4, -0.03], [0.6, 0]] } },
  doubleNod: { dur: 0.9, tracks: { '@pitch': [[0, 0], [0.15, 0.09], [0.3, 0], [0.45, 0.08], [0.65, -0.02], [0.9, 0]] } },
  shake: { dur: 0.85, tracks: { '@yaw': [[0, 0], [0.15, 0.14], [0.38, -0.14], [0.6, 0.08], [0.85, 0]] } },
  tilt: { dur: 1.6, tracks: { '@roll': [[0, 0], [0.35, 0.14], [1.2, 0.12], [1.6, 0]], browInnerUp: [[0, 0], [0.3, 0.2], [1.2, 0.15], [1.6, 0]] } },
  scoff: {
    dur: 0.7,
    tracks: {
      '@pitch': [[0, 0], [0.12, -0.07], [0.7, 0]], noseSneerRight: [[0, 0], [0.1, 0.45], [0.7, 0]],
      mouthSmileRight: [[0, 0], [0.12, 0.35], [0.7, 0]], '@breath': [[0, 0], [0.1, -0.8], [0.7, 0]],
    },
  },
  // "Я усмехаюсь, и это не весёлый звук. Это скорее скрип старого, плохо смазанного механизма"
  creakyLaugh: {
    dur: 1.25, ease: 'step',
    tracks: {
      mouthSmileLeft: [[0, 0], [0.08, 0.45], [0.2, 0.15], [0.3, 0.5], [0.42, 0.18], [0.52, 0.52], [0.66, 0.3], [1.25, 0.3]],
      mouthDimpleLeft: [[0, 0], [0.08, 0.4], [0.2, 0.2], [0.3, 0.45], [0.42, 0.2], [0.52, 0.45], [0.66, 0.35], [1.25, 0.2]],
      noseSneerLeft: [[0, 0], [0.08, 0.3], [0.2, 0], [0.3, 0.3], [0.42, 0], [0.52, 0.3], [0.66, 0]],
      jawOpen: [[0, 0], [0.08, 0.06], [0.2, 0], [0.3, 0.07], [0.42, 0], [0.52, 0.06], [0.66, 0]],
      '@pitch': [[0, 0], [0.08, -0.025], [0.2, 0], [0.3, -0.03], [0.42, 0], [0.52, -0.03], [0.66, 0]],
      eyeBlink: [[0, 0], [0.08, 0.15], [1.25, 0.1]],
    },
  },
  sigh: {
    dur: 2.2,
    tracks: {
      '@breath': [[0, 0], [0.8, 1], [1.4, -0.6], [2.2, 0]], '@pitch': [[0, 0], [0.8, -0.05], [1.5, 0.06], [2.2, 0]],
      eyeBlink: [[0, 0], [0.8, 0.1], [1.4, 0.45], [2.2, 0]], browInnerUp: [[0, 0], [0.9, 0.25], [2.2, 0]],
      jawOpen: [[0, 0], [1.0, 0.02], [1.3, 0.08], [2.0, 0]],
    },
  },
  eyeRoll: {
    dur: 1.2,
    tracks: {
      '@gazeY': [[0, 0], [0.25, 0.55], [0.7, 0.6], [1.2, 0]], '@gazeX': [[0, 0], [0.2, -0.3], [0.5, 0.05], [0.8, 0.35], [1.2, 0]],
      eyeBlink: [[0, 0], [0.4, 0.1], [0.95, 0.35], [1.2, 0]], '@roll': [[0, 0], [0.6, 0.05], [1.2, 0]], '@pitch': [[0, 0], [0.5, -0.03], [1.2, 0]],
    },
  },
  slowBlink: { dur: 1.1, tracks: { eyeBlink: [[0, 0], [0.35, 1], [0.6, 1], [1.1, 0]], '@pitch': [[0, 0], [0.4, 0.02], [1.1, 0]] } },
  emphasis: {
    dur: 0.7,
    tracks: { '@pitch': [[0, 0], [0.15, 0.07], [0.7, 0]], browDown: [[0, 0], [0.12, 0.28], [0.7, 0]], eyeSquint: [[0, 0], [0.12, 0.15], [0.7, 0]] },
  },
  browRaise: { dur: 1.4, tracks: { browOuterUpRight: [[0, 0], [0.2, 0.7], [1.1, 0.6], [1.4, 0]], browDownLeft: [[0, 0], [0.2, 0.2], [1.1, 0.2], [1.4, 0]] } },
  turnAway: { dur: 2.2, tracks: { '@yaw': [[0, 0], [0.4, -0.22], [1.6, -0.2], [2.2, 0]], '@gazeX': [[0, 0], [0.3, -0.25], [1.6, -0.2], [2.2, 0]] } },
  flinch: { dur: 0.45, tracks: { '@pitch': [[0, 0], [0.06, -0.06], [0.45, 0]], eyeBlink: [[0, 0], [0.05, 0.9], [0.2, 0]], eyeWide: [[0, 0], [0.2, 0.3], [0.45, 0]] } },
  shrug: {
    dur: 1.0,
    tracks: { browInnerUp: [[0, 0], [0.25, 0.4], [1, 0]], mouthShrugLower: [[0, 0], [0.25, 0.5], [1, 0]], mouthFrown: [[0, 0], [0.25, 0.2], [1, 0]], '@roll': [[0, 0], [0.3, 0.07], [1, 0]] },
  },
};

// ---------------------------------------------------------------- утилиты разрешения эмоций

/** Разворачивает сокращения ('mouthSmile' → обе стороны) */
function expandAU(au, out, w) {
  for (const k in au) {
    const v = au[k] * w;
    if (CHANNEL_SET.has(k)) out[k] = (out[k] || 0) + v;
    else if (CHANNEL_SET.has(k + 'Left')) {
      out[k + 'Left'] = (out[k + 'Left'] || 0) + v;
      out[k + 'Right'] = (out[k + 'Right'] || 0) + v;
    } else if (k.startsWith('@')) out[k] = (out[k] || 0) + v;
    else console.warn('[emotional-head] unknown channel', k);
  }
  return out;
}

/** Публичный вариант expandAU: { mouthSmile: .5 } → { mouthSmileLeft: .5, mouthSmileRight: .5 } */
export function expandChannels(au, w = 1) { return expandAU(au || {}, {}, w); }

/** Меняет Left↔Right и знак yaw/roll/gazeX — для зеркальной асимметрии. */
export function mirrorVector(vec) {
  const out = {};
  for (const k in vec) {
    let key = k;
    if (k.endsWith('Left')) key = k.slice(0, -4) + 'Right';
    else if (k.endsWith('Right')) key = k.slice(0, -5) + 'Left';
    else if (k === 'mouthLeft') key = 'mouthRight';
    else if (k === 'mouthRight') key = 'mouthLeft';
    else if (k === 'jawLeft') key = 'jawRight';
    else if (k === 'jawRight') key = 'jawLeft';
    let v = vec[k];
    if (k === '@yaw' || k === '@roll' || k === '@gazeX') v = -v;
    out[key] = v;
  }
  return out;
}

/**
 * Превращает определение эмоции в "дельта-вектор": каналы + @-параметры (относительно нейтрали).
 * Поведенческие множители хранятся как отклонения от 1 (или от дефолта), чтобы корректно складываться.
 */
function emotionDelta(def, depth = 0) {
  const out = {};
  if (!def || depth > 6) return out;
  if (def.mix) {
    for (const name in def.mix) {
      const d = emotionDelta(EMOTIONS[resolveName(name)], depth + 1);
      for (const k in d) out[k] = (out[k] || 0) + d[k] * def.mix[name];
    }
  }
  if (def.au) expandAU(def.au, out, 1);
  const p = def.pose || {}, g = def.gaze || {}, b = def.behavior || {};
  const add = (k, v) => { if (v !== undefined) out[k] = (out[k] || 0) + v; };
  add('@pitch', p.pitch); add('@yaw', p.yaw); add('@roll', p.roll);
  add('@gazeX', g.x); add('@gazeY', g.y);
  if (g.aversion !== undefined) add('@aversion', g.aversion - (def.mix ? 0 : STATE_DEFAULTS['@aversion']));
  if (g.steady !== undefined) add('@steady', g.steady - (def.mix ? 0 : STATE_DEFAULTS['@steady']));
  const beh = { blinkRate: '@blinkRate', blinkSpeed: '@blinkSpeed', headMotion: '@headMotion', artic: '@artic', microRate: '@microRate', rate: '@rate', pitchVoice: '@pitchVoice' };
  for (const bk in beh) if (b[bk] !== undefined) add(beh[bk], b[bk] - 1);
  return out;
}

export function resolveName(name) {
  if (!name) return 'neutral';
  const n = String(name).trim();
  if (EMOTIONS[n]) return n;
  const low = n.toLowerCase();
  if (ALIASES[low]) return ALIASES[low];
  const camel = low.replace(/[_\s-]+(\w)/g, (_, c) => c.toUpperCase());
  for (const k in EMOTIONS) if (k.toLowerCase() === camel.toLowerCase()) return k;
  return null;
}

const MODIFIERS = { slight: 0.35, slightly: 0.35, faint: 0.25, mild: 0.5, a_bit: 0.45, bit: 0.45, some: 0.6, very: 1.0, strong: 1.0, extreme: 1.15, легкое: 0.35, лёгкое: 0.35, слегка: 0.35, едва: 0.25, очень: 1.0, сильное: 1.0 };

/**
 * Парсит строку смеси: "contempt + slight_amusement + boredom*0.5", "презрение:0.6, скука".
 * @returns {Object<string, number>} { emotionName: weight }
 */
export function parseEmotionString(str) {
  const mix = {};
  for (let token of String(str).split(/[+,&]/)) {
    token = token.trim();
    if (!token) continue;
    let w = 1;
    const m = token.match(/^(.*?)\s*[*:=]\s*([\d.]+)$/);
    if (m) { token = m[1]; w = parseFloat(m[2]); }
    const parts = token.split(/[_\s]+/);
    while (parts.length > 1 && MODIFIERS[parts[0].toLowerCase()] !== undefined) { w *= MODIFIERS[parts.shift().toLowerCase()]; }
    const name = resolveName(parts.join('_'));
    if (name) mix[name] = (mix[name] || 0) + w;
    else console.warn('[emotional-head] unknown emotion', token);
  }
  return mix;
}

/**
 * Главная функция: любой формат эмоции → полный вектор состояния (каналы + @-параметры) и пул микро-выражений.
 * emotion: 'jaded' | 'contempt + slight_amusement' | { contempt: .6, boredom: .4 } | { au: {...}, pose: {...} } (сырой def)
 */
export function resolveEmotion(emotion, intensity = 1, { mirror = false } = {}) {
  let mix;
  if (typeof emotion === 'string') mix = parseEmotionString(emotion);
  else if (emotion && (emotion.au || emotion.mix || emotion.pose)) mix = { __raw: 1 };
  else mix = { ...(emotion || {}) };

  let total = 0;
  for (const k in mix) total += Math.abs(mix[k]);
  // Слишком много одновременно — нормируем, чтобы лицо не "перегорало"
  const norm = total > 1.3 ? 1.3 / total : 1;

  let delta = {};
  const micro = {};
  for (const name in mix) {
    const def = name === '__raw' ? emotion : EMOTIONS[resolveName(name)];
    if (!def) continue;
    const w = mix[name] * norm * intensity;
    const d = emotionDelta(def);
    for (const k in d) delta[k] = (delta[k] || 0) + d[k] * w;
    const pool = collectMicro(def);
    for (const m of pool) micro[m] = (micro[m] || 0) + w;
  }
  if (mirror) delta = mirrorVector(delta);

  const state = {};
  for (const ch of CHANNELS) state[ch] = Math.min(1, Math.max(0, delta[ch] || 0));
  for (const k in STATE_DEFAULTS) {
    const v = STATE_DEFAULTS[k] + (delta[k] || 0);
    state[k] = RELATIVE_KEYS.has(k) ? Math.max(0.05, v) : v;
  }
  state['@aversion'] = Math.min(1, Math.max(0, state['@aversion']));
  state['@steady'] = Math.min(1, Math.max(0, state['@steady']));
  return { state, micro, mix };
}

function collectMicro(def, depth = 0) {
  const out = new Set(def.micro || []);
  if (def.mix && depth < 5) for (const n in def.mix) {
    const sub = EMOTIONS[resolveName(n)];
    if (sub) for (const m of collectMicro(sub, depth + 1)) out.add(m);
  }
  return out;
}

/**
 * Сдержанность (restraint 0..1): "внутреннее напряжение + внешняя сдержанность".
 * Крупные выражения подавляются, появляются признаки контроля (сжатые губы, неподвижная голова),
 * а подавленная эмоция "утекает" через микро-выражения (см. EmotionalHead: leak rate).
 */
export function applyRestraint(state, restraint) {
  if (!restraint) return state;
  const r = Math.min(1, Math.max(0, restraint));
  const out = { ...state };
  let energy = 0;
  for (const ch of CHANNELS) { energy += state[ch]; out[ch] = state[ch] * (1 - 0.65 * r); }
  const e = Math.min(1, energy / 3);
  const add = (k, v) => { out[k] = Math.min(1, (out[k] || 0) + v); };
  add('mouthPressLeft', 0.3 * r * (0.4 + e)); add('mouthPressRight', 0.3 * r * (0.4 + e));
  add('mouthRollLower', 0.12 * r); add('jawForward', 0.05 * r);
  out['@headMotion'] = state['@headMotion'] * (1 - 0.6 * r);
  out['@steady'] = Math.min(1, state['@steady'] + 0.3 * r);
  out['@blinkRate'] = state['@blinkRate'] * (1 - 0.3 * r);
  out['@artic'] = state['@artic'] * (1 - 0.25 * r);
  out['@pitch'] = state['@pitch'] * (1 - 0.5 * r);
  out['@yaw'] = state['@yaw'] * (1 - 0.5 * r);
  out['@roll'] = state['@roll'] * (1 - 0.5 * r);
  return out;
}

// ---------------------------------------------------------------- парсер "нарратива" LLM-агента

/**
 * Правила: [regex (по основам слов, RU+EN), эффект]. Эффект: { mix }, { gesture }, { micro }, { restraint }.
 * Это эвристика, а не NLP: быстро, предсказуемо, легко расширять (EMOTION_RULES.push(...)).
 */
export const EMOTION_RULES = [
  [/пресыщ|blas[eé]|jaded|сыт[а-я]* по горло/i, { mix: { jaded: 1 } }],
  [/банальн|скучн|скук|зева|bored|boring|banal|yawn/i, { mix: { boredom: 0.7 } }],
  [/не вздрагива|не задева|не трогает|равнодуш|безразлич|indifferen|unmoved|doesn'?t (even )?flinch/i, { mix: { indifferent: 0.8 } }],
  [/усме[шх]|ухмыл|smirk/i, { mix: { smirk: 0.6, coldIrony: 0.3 }, gesture: 'scoff' }],
  [/скрип|механизм|не (весёл|весел)\S* (звук|смех)|хмык|creak|mirthless|joyless/i, { gesture: 'creakyLaugh', mix: { coldIrony: 0.3 } }],
  [/ирони|сарказ|язвит|irony|ironic|sarcas|wry/i, { mix: { coldIrony: 0.8 } }],
  [/презр|презира|contempt|scorn|disdain/i, { mix: { contempt: 0.8 } }],
  [/свысока|снисходит|condescend|patroniz/i, { mix: { condescending: 0.8 } }],
  [/хмур|насупи|frown|scowl/i, { mix: { irritation: 0.7 }, gesture: 'emphasis' }],
  [/раздраж|досад|бесит|annoy|irritat/i, { mix: { irritation: 0.8 } }],
  [/не люблю|ограничива|приручить|контролир|confine|restrict|tame/i, { mix: { irritation: 0.4, tension: 0.5 }, restraint: 0.4 }],
  [/напряж|сдержива|сдержан|стиснув|сжима[юя] (зубы|челюсть)|tense|restrain|clench/i, { mix: { tension: 0.8 }, restraint: 0.6 }],
  [/пауз|pause|молчу|замолка|silence/i, { mix: { emphasis: 0.8 }, gesture: 'slowBlink' }],
  [/услови|настаива|подчёркива|подчеркива|condition|insist|emphasi/i, { mix: { emphasis: 0.6, determined: 0.3 }, gesture: 'emphasis' }],
  [/устал|утомл|изнур|tired|weary|exhaust/i, { mix: { weary: 0.8 } }],
  [/вздыха|вздох|sigh/i, { gesture: 'sigh', mix: { weary: 0.3 } }],
  [/закатыва\w* глаз|roll\w* (my )?eyes/i, { gesture: 'eyeRoll', mix: { contempt: 0.3 } }],
  [/поднима\w* бровь|приподнима\w* бровь|raise\w* (an |one )?eyebrow|arch\w* (an )?eyebrow/i, { gesture: 'browRaise', mix: { skeptical: 0.6 } }],
  [/прищур|щурюсь|squint|narrow\w* (my )?eyes/i, { mix: { skeptical: 0.5 }, micro: 'lidTighten' }],
  [/скепт|сомнева|недовер|skeptic|doubt/i, { mix: { skeptical: 0.8 } }],
  [/кива|nod/i, { gesture: 'nod' }],
  [/кача\w* головой|shake\w* (my )?head/i, { gesture: 'shake' }],
  [/наклоня\w* голову|склоня\w* голову|tilt\w* (my )?head/i, { gesture: 'tilt', mix: { curious: 0.3 } }],
  [/отворачива|отвожу взгляд|look\w* away|turn\w* away/i, { gesture: 'turnAway' }],
  [/пожима\w* плечами|shrug/i, { gesture: 'shrug' }],
  [/улыба|smile|grin/i, { mix: { happy: 0.6 } }],
  [/(?:^|[^а-яё])(?:сме[юхё]|хохоч)|laugh|chuckl/i, { mix: { amusement: 0.7 } }],
  [/(?:^|[^а-яё])(?:весел|весёл)|забав|amus|funny/i, { mix: { amusement: 0.6 } }],
  [/(?:^|[^а-яё])рад(?:а|ы|уюсь|ость)?(?![а-яё])|счастл|happy|glad|delight/i, { mix: { happy: 0.7 } }],
  [/груст|печал|тоск|sad|sorrow|melanch/i, { mix: { sad: 0.7 } }],
  [/злюсь|злост|гнев|ярост|в бешенстве|angry|anger|furious|rage/i, { mix: { angry: 0.8 } }],
  [/удивл|изумл|surpris|astonish/i, { mix: { surprised: 0.7 } }],
  [/страх|боюсь|испуг|тревог|afraid|fear|scared|anxious/i, { mix: { fear: 0.7 } }],
  [/отвращ|омерз|брезг|disgust|repuls/i, { mix: { disgust: 0.8 } }],
  [/задумч|размышл|обдумыва|думаю|ponder|think|consider/i, { mix: { thinking: 0.7 } }],
  [/любопыт|интересно|curious|intrigu/i, { mix: { curious: 0.7 } }],
  [/холодн|ледян|cold|icy|chilly/i, { mix: { indifferent: 0.25 }, restraint: 0.2 }],
  [/твёрд|тверд|решител|firm|determin|resolute/i, { mix: { determined: 0.7 } }],
];
const INTENSIFIERS = /(очень|крайне|такая степень|слишком|совершенно|абсолютно|невероятно|very|extremely|utterly|so much)/i;
const DIMINISHERS = /(слегка|чуть|едва|немного|почти|слабо|lightly|slightly|barely|a bit|faintly)/i;
// \b в JS не работает с кириллицей — границы слов задаём явно
const NEGATION = /(?:(?:^|[\s,.;:!?—«"(-])(?:не|ни|not|no|never)|n't)\s+(?:\S+\s+)?$/i;

/**
 * Разбирает текст-нарратив агента ("Я усмехаюсь, и это не весёлый звук...") в эмоциональный план.
 * @returns {{ mix: Object, gestures: string[], micro: string[], restraint: number, intensity: number, matches: string[] }}
 */
export function parseNarrative(text) {
  const mix = {}, gestures = [], micro = [], matches = [];
  let restraint = 0;
  const src = String(text);
  for (const [re, eff] of EMOTION_RULES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m, hit = false;
    while ((m = g.exec(src))) {
      const lead = m[0].match(/^[^a-zа-яё]*/i)[0].length;          // ведущий разделитель из (?:^|[^а-яё])
      const before = src.slice(Math.max(0, m.index - 24), m.index + lead);
      // "не весёлый" — отрицание гасит позитивные эмоции, но правила, которые сами содержат "не", не трогаем
      if (NEGATION.test(before) && !re.source.startsWith('не ')) continue;
      const ctx = src.slice(Math.max(0, m.index - 40), m.index + 40);
      let k = 1;
      if (INTENSIFIERS.test(ctx)) k = 1.25;
      if (DIMINISHERS.test(src.slice(Math.max(0, m.index - 20), m.index))) k = 0.5;
      if (eff.mix) for (const e in eff.mix) mix[e] = Math.max(mix[e] || 0, eff.mix[e] * k);
      if (eff.gesture && !gestures.includes(eff.gesture)) gestures.push(eff.gesture);
      if (eff.micro) micro.push(eff.micro);
      if (eff.restraint) restraint = Math.max(restraint, eff.restraint);
      matches.push(m[0]);
      hit = true;
      break;
    }
    if (hit) continue;
  }
  // Негативные/холодные контексты гасят "тёплую" радость: "холодная улыбка" ≠ happy
  if ((mix.coldIrony || mix.contempt || mix.indifferent || mix.jaded) && mix.happy) {
    mix.coldIrony = Math.max(mix.coldIrony || 0, mix.happy * 0.8);
    delete mix.happy;
  }
  let total = 0;
  for (const k in mix) total += mix[k];
  const intensity = total ? Math.min(1, 0.6 + total * 0.25) : 0;
  return { mix, gestures, micro, restraint, intensity, matches };
}
