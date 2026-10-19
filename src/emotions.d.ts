/** Типы для emotions.js — каналы ARKit, эмоции, микровыражения, жесты, разбор текста. */

/** 52 ARKit-канала (0..1). */
export type ARKitChannel =
  | 'eyeBlinkLeft' | 'eyeLookDownLeft' | 'eyeLookInLeft' | 'eyeLookOutLeft' | 'eyeLookUpLeft' | 'eyeSquintLeft' | 'eyeWideLeft'
  | 'eyeBlinkRight' | 'eyeLookDownRight' | 'eyeLookInRight' | 'eyeLookOutRight' | 'eyeLookUpRight' | 'eyeSquintRight' | 'eyeWideRight'
  | 'jawForward' | 'jawLeft' | 'jawRight' | 'jawOpen'
  | 'mouthClose' | 'mouthFunnel' | 'mouthPucker' | 'mouthLeft' | 'mouthRight'
  | 'mouthSmileLeft' | 'mouthSmileRight' | 'mouthFrownLeft' | 'mouthFrownRight'
  | 'mouthDimpleLeft' | 'mouthDimpleRight' | 'mouthStretchLeft' | 'mouthStretchRight'
  | 'mouthRollLower' | 'mouthRollUpper' | 'mouthShrugLower' | 'mouthShrugUpper'
  | 'mouthPressLeft' | 'mouthPressRight' | 'mouthLowerDownLeft' | 'mouthLowerDownRight'
  | 'mouthUpperUpLeft' | 'mouthUpperUpRight'
  | 'browDownLeft' | 'browDownRight' | 'browInnerUp' | 'browOuterUpLeft' | 'browOuterUpRight'
  | 'cheekPuff' | 'cheekSquintLeft' | 'cheekSquintRight' | 'noseSneerLeft' | 'noseSneerRight'
  | 'tongueOut';

/** Каналы сверх ARKit: tongueUp (кончик языка к альвеолам), pupil (размер зрачка, −1…1.5). */
export type ExtraChannel = 'tongueUp' | 'pupil';
export type Channel = ARKitChannel | ExtraChannel;

/** Значения каналов; в setChannels значение null снимает ручное управление каналом. */
export type Channels = Partial<Record<Channel, number>>;

export declare const CHANNELS: readonly ARKitChannel[];

/** Не-мимические параметры состояния: поза головы (@pitch, @yaw, @roll), взгляд (@gazeX, @gazeY), поведение. */
export declare const STATE_DEFAULTS: Record<string, number>;

/** Описание эмоции: AU / каналы ARKit, поза, метка; поля зависят от эмоции. */
export interface EmotionDef {
  label?: string;
  /** Каналы ARKit; без Left/Right — на обе стороны (mouthSmile → mouthSmileLeft + mouthSmileRight). */
  au: Record<string, number>;
  /** Поза головы, радианы. */
  pose?: { pitch?: number; yaw?: number; roll?: number };
  /** Взгляд: aversion — вероятность отвести глаза, steady — пристальность, x/y — смещение. */
  gaze?: { aversion?: number; steady?: number; x?: number; y?: number };
  /** Поведение: размах движений головы, артикуляция, темп и высота голоса. */
  behavior?: { headMotion?: number; artic?: number; rate?: number; pitchVoice?: number; [key: string]: number | undefined };
  /** Микровыражения, которые эмоция подбрасывает в idle. */
  micro?: string[];
  /** Размер зрачка от эмоции (−1…1.5). */
  pupil?: number;
  [key: string]: unknown;
}

/** Микровыражение: каналы и длительность, с. */
export interface MicroDef { au: Record<string, number>; dur?: number; [key: string]: unknown }

/** Жест: дорожки ключей [время, значение] по каналам и параметрам позы ('@pitch', '@yaw', '@roll'). */
export interface GestureDef { dur: number; tracks: Record<string, Array<[number, number]>>; [key: string]: unknown }

/** Эмоция: имя ('contempt'), строка-смесь ('contempt + slight_amusement*0.5'), веса { contempt: 0.6, boredom: 0.4 } или своё описание { au, pose, … }. */
export type EmotionInput = string | Record<string, number> | EmotionDef;

export declare const EMOTIONS: Record<string, EmotionDef>;
export declare const ALIASES: Record<string, string>;
export declare const MICRO: Record<string, MicroDef>;
export declare const GESTURES: Record<string, GestureDef>;
export declare const EMOTION_RULES: ReadonlyArray<Record<string, unknown>>;

export interface ResolvedEmotion {
  /** Итоговые каналы и параметры состояния ('@pitch', '@gazeX'…). */
  state: Record<string, number>;
  /** Пул микровыражений: имя → вес. */
  micro: Record<string, number>;
  /** Веса составляющих эмоций. */
  mix: Record<string, number>;
}

export declare function expandChannels(au: Record<string, number>, w?: number): Channels;
export declare function mirrorVector<T extends Record<string, number>>(vec: T): T;
export declare function resolveName(name: string): string | null;
export declare function parseEmotionString(str: string): Record<string, number>;
export declare function resolveEmotion(emotion: EmotionInput, intensity?: number, opts?: { mirror?: boolean }): ResolvedEmotion;
export declare function applyRestraint(state: Record<string, number>, restraint: number): Record<string, number>;

/** Результат разбора повествования: смесь эмоций, жесты, сдержанность. */
export interface NarrativeResult {
  mix: Record<string, number>;
  gestures: string[];
  restraint?: number;
  [key: string]: unknown;
}
export declare function parseNarrative(text: string): NarrativeResult;
