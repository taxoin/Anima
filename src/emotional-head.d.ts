/**
 * Типы для emotional-head.js — главный класс EmotionalHead и пресеты внешности.
 * Три.js — peer-зависимость: import 'three' должен разрешаться (importmap, сборщик).
 */
import type * as THREE from 'three';
import type { Channels, EmotionInput, NarrativeResult, EmotionDef, MicroDef, GestureDef } from './emotions.js';
import type { Cue, Viseme } from './lipsync.js';

export type { ARKitChannel, Channel, Channels, EmotionInput, EmotionDef, MicroDef, GestureDef, NarrativeResult, ResolvedEmotion } from './emotions.js';
export type { Cue, Viseme, Timeline, TimelineItem } from './lipsync.js';
export { CHANNELS, EMOTIONS, MICRO, GESTURES, ALIASES, parseNarrative, parseEmotionString, resolveEmotion } from './emotions.js';
export { VISEMES, WebSpeech, parseMarkup } from './lipsync.js';

export type Gender = 'female' | 'male';
export type DetailLevel = 'high' | 'medium' | 'low';
export type DetailOption = DetailLevel | 'auto' | 'adaptive';
export type LightingPreset = 'studio' | 'warm' | 'cool' | 'noir' | 'soft';
export type Framing = 'portrait' | 'close' | 'bust';
export type Color = string;

/** Свет: [цвет, сила, [x, y, z]] для ключевого, заполняющего и контрового, полусфера и окружение. */
export interface LightingDef {
  key: [Color, number, [number, number, number]];
  fill: [Color, number, [number, number, number]];
  rim: [Color, number, [number, number, number]];
  hemi: [Color, Color, number];
  env: number;
  exposure: number;
}

export type GlassesStyle = 'round' | 'rect' | 'cat' | 'aviator' | 'sun';
export type BeardStyle = 'full' | 'short' | 'goatee' | 'chinstrap' | 'moustache' | 'walrus' | 'pencil';
export type HairStyle = 'short' | 'long' | 'none' | 'bob' | 'pixie' | 'buzz' | 'undercut' | 'receding' | 'afro' | 'curly' | 'ponytail' | 'bun';
export type HatStyle = 'beanie' | 'cap' | 'fedora' | 'bowler' | 'cloche' | 'headband';
export type Outfit = 'crew' | 'vneck' | 'scoop' | 'turtleneck' | 'shirt' | 'hoodie' | 'blazer';
export type MakeupPreset = 'natural' | 'day' | 'evening' | 'smoky' | 'bold';

/**
 * Внешность (options.look / setLook). Имена пресетов или цвета; тонкие параметры — числа.
 * Полный список — README, раздел «Внешность». Неизвестные ключи передаются модели как есть.
 */
export interface Look {
  /** Мультяшность 0…1: пропорции 3D-мультфильма (крупные глаза и радужка, маленькие нос и рот, круглые щёки, короткий подбородок). Фототекстура кожи при > 0.2 снимается. */
  toon?: number;
  // кожа и цвет
  skin?: 'porcelain' | 'fair' | 'light' | 'medium' | 'olive' | 'tan' | 'brown' | 'deep' | Color;
  undertone?: 'warm' | 'cool' | 'olive';
  lip?: Color;
  iris?: 'dark' | 'brown' | 'amber' | 'hazel' | 'green' | 'gray' | 'blue' | 'lightblue' | Color | [Color, Color];
  irisRight?: Look['iris'];
  pupil?: number;
  cornea?: boolean;
  /** Подповерхностное рассеяние кожи (по умолчанию 0.7, false — выкл.). */
  skinScatter?: number | false;
  /** Контактные тени аксессуаров (по умолчанию 1, false — выкл.). */
  contactShadows?: number | false;
  // глаза
  eyeShape?: 'almond' | 'round' | 'upturned' | 'downturned' | 'narrow' | 'wide' | 'hooded' | 'monolid';
  eyeR?: number;
  /** Размер радужки (1 — обычная). */
  irisScale?: number;
  lidUpSkew?: number; lidUpFull?: number; lidLoSkew?: number; lidLoFull?: number;
  hood?: number; lidCrease?: number; epicanthus?: number; lashLen?: number;
  eyeOpenL?: number; eyeOpenR?: number; eyeLiftL?: number; eyeLiftR?: number;
  glasses?: GlassesStyle | false | { style?: GlassesStyle; color?: Color; tint?: Color; size?: number; aspect?: number; thickness?: number; metal?: boolean };
  // рот и зубы
  mouthHW?: number;
  mouthCornerL?: number; mouthCornerR?: number;
  lipUAsym?: number; lipLAsym?: number; lipLoShape?: number;
  lipProfile?: 'flat' | 'average' | 'full' | 'protruding';
  lipPro?: number; lipDepthU?: number; lipDepthL?: number; philtrum?: number;
  teethColor?: 'white' | 'natural' | 'ivory' | 'yellow' | 'gray' | Color;
  teethGap?: number; teethCrooked?: number;
  braces?: boolean | 'metal' | 'ceramic' | Color;
  // нос
  noseShape?: 'straight' | 'roman' | 'snub' | 'button' | 'greek' | 'bulbous' | 'wide' | 'narrow';
  noseBridge?: number; noseHump?: number; noseRoot?: number; noseUp?: number; noseBulb?: number; noseFlare?: number;
  // волосы
  hair?: Color;
  hairStyle?: HairStyle;
  hairVol?: number[]; hairCurl?: number; hairThick?: number; hairTemples?: number; hairTail?: number;
  hairGray?: number; hairGrayColor?: Color; hairStreaks?: number; hairStreakColor?: Color; hairVar?: number;
  hairCards?: boolean; hairAniso?: number; hairSpec2?: number | false;
  browGray?: number;
  beard?: BeardStyle | null | { style?: BeardStyle; moustache?: string | false; length?: number; color?: Color };
  beardGray?: number;
  stubble?: number;
  // кожа: декали
  makeup?: MakeupPreset | { blush?: [Color, number]; contour?: number; eyeshadow?: [Color, number]; eyeliner?: number; wing?: number; lipstick?: Color | null; gloss?: number };
  freckles?: number; moles?: number; age?: number;
  // одежда и аксессуары
  outfit?: Outfit;
  cloth?: Color; cloth2?: Color; tie?: Color | false; clothFolds?: number;
  hat?: HatStyle | { style?: HatStyle; color?: Color; y0?: number; /** цвет ленты на тулье мультяшной шляпы (fedora, bowler) */ band?: Color };
  earrings?: 'stud' | 'hoop' | 'drop' | { style?: string; color?: Color; size?: number };
  headphones?: 'over' | 'headset' | 'earbuds' | { style?: 'over' | 'headset' | 'earbuds'; color?: Color };
  mask?: 'medical' | 'cloth' | 'n95' | { style?: 'medical' | 'cloth' | 'n95'; color?: Color };
  [key: string]: unknown;
}

/** Внешность по полу: { female: {...}, male: {...} } — своя для каждой основы. */
export type LookOption = Look | { female?: Look; male?: Look };

export interface VoiceOptions {
  lang?: string;
  voice?: string | SpeechSynthesisVoice;
  rate?: number;
  pitch?: number;
  volume?: number;
}

/** Внешний TTS: возвращает аудио и (желательно) выравнивание по символам или виземы. */
export type TTSFunction = (text: string, info: { lang: string; gender: Gender; rate?: number; pitchVoice?: number }) =>
  Promise<{ audio: string | Blob | ArrayBuffer | HTMLAudioElement; alignment?: { chars: string[]; times: number[] }; visemes?: Array<{ t: number; v: Viseme | number }> }>;

export interface EmotionalHeadOptions {
  gender?: Gender;
  /** 'dark' | 'light' | 'transparent' или любой CSS background. */
  background?: 'dark' | 'light' | 'transparent' | string;
  lighting?: LightingPreset | LightingDef;
  framing?: Framing;
  emotion?: EmotionInput;
  intensity?: number;
  idle?: boolean;
  shadows?: boolean;
  followPointer?: boolean;
  vignette?: boolean;
  maxPixelRatio?: number;
  /** auto — medium на телефонах; adaptive — по скорости кадров (событие detailChange). */
  detail?: DetailOption;
  tts?: 'webspeech' | 'none' | TTSFunction;
  voice?: VoiceOptions;
  look?: LookOption;
}

/** Поза головы и взгляда (радианы), breath — фаза дыхания, focus — расстояние до точки взгляда. */
export interface Pose {
  pitch?: number; yaw?: number; roll?: number;
  eyeYaw?: number; eyePitch?: number;
  breath?: number; focus?: number;
}

export interface EmotionState {
  emotion: EmotionInput;
  intensity: number;
  mix: Record<string, number>;
  restraint: number;
  mirror: boolean;
}

export interface HeadState extends EmotionState {
  channels: Channels;
  pose: Required<Pose>;
  speaking: boolean;
}

export interface SpeakOptions extends VoiceOptions {
  /** Эмоция на время фразы; 'auto' — определить по тексту. */
  emotion?: EmotionInput | 'auto';
  intensity?: number;
  restraint?: number;
  mirror?: boolean;
  duration?: number;
  tts?: 'webspeech' | 'none' | TTSFunction;
  /** Вернуть прежнюю эмоцию после фразы. */
  revert?: boolean;
  onEnd?: () => void;
}

export interface SpeakAudioOptions extends SpeakOptions {
  text?: string;
  alignment?: { chars: string[]; times: number[] };
  visemes?: Array<{ t: number; v: Viseme | number }>;
}

export interface PhotoOptions {
  /** 0 — стандартные пропорции, 1 — как на фото, 1.5–2.5 — шарж. */
  caricature?: number;
  /** Сила фото-текстуры кожи (0 — ровный тон). */
  texture?: number;
  realism?: number;
  /** auto — по фото, если модель уверена; keep — текущий пол. */
  gender?: Gender | 'auto' | 'keep';
  /** Сразу подогнать форму по точкам лица (+1.5–3 с). */
  shape?: boolean;
  /** 'full' — очки и уборы по многоклассовому сегментатору (+16 МБ модель). */
  detail?: 'full';
  accessories?: boolean;
  /** Второй снимок — строго в профиль: глубина носа, губ, подбородка (см. addProfile). */
  profile?: File | Blob | string | HTMLImageElement | HTMLCanvasElement;
  onProgress?: (text: string) => void;
}

/** Параметры глубины по снимку в профиль. */
export interface ProfileParams { nose: number; noseRoot: number; noseHump: number; noseUp: number; lipPro: number; lipDepthL: number; chin: number }
export interface ProfileResult { params: ProfileParams; rms: number; side: 1 | -1; warnings: string[] }

/** Отчёт распознавания фото: предупреждения, найденные цвета и детали, меры лица. */
export interface PhotoReport {
  warnings: string[];
  issues: string[];
  gender?: { value: Gender; guess?: { gender: Gender; p: number; confident: boolean } };
  colors?: Record<string, string>;
  /** Данные снимка в профиль, если он добавлен. */
  profile?: { params: ProfileParams; rms: number; warnings: string[] } | null;
  [key: string]: unknown;
}

export interface LikenessReport {
  rms: number;
  regions: Record<string, number>;
  direction?: number;
  gain?: number;
  [key: string]: unknown;
}

export interface AdaptiveState {
  step: number;
  detail: DetailLevel;
  pixelRatio: number;
  refreshHz: number | null;
  ceiling: number;
  changes: Array<{ t: number; detail: DetailLevel; pixelRatio: number; step: number; reason: string }>;
}

export interface ExportAvatarOptions {
  /** Макс. сторона текстуры (0 — без неё, ~5 КБ). */
  size?: number;
  quality?: number;
  format?: 'object' | 'json';
}

export interface ExportGLBOptions {
  /** Уровень детализации файла (по умолчанию текущий). */
  detail?: DetailOption;
  /** Морф-цели ARKit (по умолчанию true). */
  morphs?: boolean;
  /** Метров на единицу модели (по умолчанию 0.115: голова ≈ 23 см). */
  scale?: number;
  /** .glb (по умолчанию) или JSON glTF. */
  binary?: boolean;
  /** Разреженные морф-цели (по умолчанию true). */
  sparse?: boolean;
  name?: string;
}

export interface LoadModelOptions {
  /** Канал ARKit → имя морфа модели. */
  mapping?: Partial<Record<string, string>>;
  fit?: boolean;
  rotation?: [number, number, number];
  scale?: number;
  offset?: [number, number, number];
  transcoderPath?: string;
}

/** События и их данные. */
export interface EmotionalHeadEvents {
  emotionChange: EmotionState;
  speakStart: { text: string };
  speakEnd: Record<string, never>;
  word: { i: number; t: number };
  cue: Cue;
  gesture: { name: string; intensity?: number; speed?: number; mirror?: boolean };
  micro: { name: string | Record<string, number>; intensity?: number; duration?: number; side?: 'left' | 'right' };
  express: NarrativeResult;
  genderChange: { gender: Gender; source?: 'photo' };
  blink: Record<string, never>;
  modelLoaded: { url: string };
  photoAvatar: PhotoReport | null;
  lookChange: LookOption;
  detailChange: { detail: DetailLevel; pixelRatio: number; step: number; reason: string };
}
export type EmotionalHeadEvent = keyof EmotionalHeadEvents;

export declare class EmotionalHead {
  /** @param container элемент или CSS-селектор */
  constructor(container: HTMLElement | string, options?: EmotionalHeadOptions);

  readonly options: EmotionalHeadOptions;
  readonly gender: Gender;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** Текущий риг (процедурная голова или glTF-модель). */
  readonly rig: { object3D: THREE.Object3D; [key: string]: unknown };
  readonly speaking: boolean;
  /** Распознанный портрет фото-аватара или null. */
  readonly portrait: unknown | null;

  // эмоции и мимика
  setEmotion(emotion: EmotionInput, intensity?: number, duration?: number, opts?: { restraint?: number; mirror?: boolean }): this;
  addEmotion(emotion: EmotionInput, weight?: number, duration?: number): this;
  getEmotion(): EmotionState;
  getState(): HeadState;
  micro(name: string | Record<string, number>, o?: { intensity?: number; duration?: number; side?: 'left' | 'right' }): this;
  gesture(name: string | GestureDef, o?: { intensity?: number; speed?: number; mirror?: boolean }): this;
  /** Эмоция и жесты по описанию: «Я медленно поднимаю бровь…». */
  express(text: string, o?: { duration?: number; intensity?: number }): NarrativeResult;
  setChannels(obj: Partial<Record<keyof Channels, number | null>>): this;
  clearChannels(): this;
  lookAt(x: number | null, y?: number, o?: { head?: number }): this;
  followPointer(on?: boolean): this;
  setIdle(on?: boolean): this;

  // речь
  speak(text: string, o?: SpeakOptions): Promise<void>;
  speakAudio(audio: string | Blob | ArrayBuffer | HTMLAudioElement, o?: SpeakAudioOptions): Promise<void>;
  /** Lip-sync по живому потоку (микрофон, WebRTC); возвращает функцию остановки. */
  listenStream(stream: MediaStream): () => void;
  stopSpeaking(): this;

  // внешность и сцена
  setGender(gender: Gender): this;
  setLook(look?: LookOption, o?: { replace?: boolean }): this;
  getLook(): LookOption;
  setLighting(preset: LightingPreset | LightingDef): this;
  setBackground(bg: 'dark' | 'light' | 'transparent' | string): this;
  setFraming(name: Framing): this;
  setDetail(detail?: DetailOption): this;
  getDetail(): DetailLevel;
  getAdaptive(): AdaptiveState | null;

  // фото-аватар
  fromPhoto(src: File | Blob | string | HTMLImageElement | HTMLCanvasElement, o?: PhotoOptions): Promise<PhotoReport>;
  setPhotoOptions(o?: Partial<Pick<PhotoOptions, 'caricature' | 'texture' | 'realism'>>): this;
  clearPhoto(): this;
  /** Глубина лица по снимку строго в профиль; с фото-аватаром — дополняет его, без него — меняет look. */
  addProfile(src: File | Blob | string | HTMLImageElement | HTMLCanvasElement, o?: { onProgress?: (text: string) => void }): Promise<ProfileResult>;
  clearProfile(): this;
  likeness(o?: { base?: boolean; expression?: boolean; size?: number }): Promise<LikenessReport>;
  refinePhoto(o?: { iterations?: number; alpha?: number; onProgress?: (text: string) => void }): Promise<number[]>;
  refineShape(o?: { iterations?: number; alpha?: number; realism?: number; onProgress?: (text: string) => void }): Promise<number[]>;
  exportAvatar(o: ExportAvatarOptions & { format: 'json' }): Promise<string>;
  exportAvatar(o?: ExportAvatarOptions): Promise<Record<string, unknown>>;
  importAvatar(src: string | File | Blob | Record<string, unknown>, o?: { caricature?: number; texture?: number; realism?: number; gender?: Gender; look?: LookOption }): Promise<PhotoReport | null>;

  // модели и экспорт
  loadModel(url: string, o?: LoadModelOptions): Promise<unknown>;
  useProcedural(gender?: Gender): this;
  exportGLB(o?: ExportGLBOptions & { binary?: true }): Promise<ArrayBuffer>;
  exportGLB(o: ExportGLBOptions & { binary: false }): Promise<Record<string, unknown>>;

  // кадр и цикл
  snapshot(type?: string): string;
  /** Детерминированный кадр: каналы (остальные = 0) и поза, без анимационного цикла. */
  renderStill(channels?: Channels, pose?: Pose, camera?: THREE.Camera): HTMLCanvasElement;
  pause(): this;
  resume(): this;
  dispose(): void;

  // события
  on<K extends EmotionalHeadEvent>(evt: K, cb: (e: EmotionalHeadEvents[K]) => void): this;
  off<K extends EmotionalHeadEvent>(evt: K, cb: (e: EmotionalHeadEvents[K]) => void): this;
  once<K extends EmotionalHeadEvent>(evt: K, cb: (e: EmotionalHeadEvents[K]) => void): this;
}
export default EmotionalHead;

export declare const LIGHTING: Record<LightingPreset, LightingDef>;
export declare const BACKGROUNDS: Record<'dark' | 'light' | 'transparent', string>;

// пресеты внешности
export declare const SKIN_TONES: Record<string, { skin: Color; lip?: Color }>;
export declare const EYE_COLORS: Record<string, [Color, Color]>;
export declare const EYE_SHAPES: Record<string, Partial<Look>>;
export declare const NOSE_SHAPES: Record<string, Partial<Look>>;
export declare const LIP_PROFILES: Record<string, Partial<Look>>;
export declare const HAIR_STYLES: Record<string, Partial<Look>>;
export declare const TEETH_COLORS: Record<string, Color>;
export declare const OUTFITS: Record<Outfit, { cloth2?: Color; tie?: boolean }>;
export declare const HEADPHONES: Record<string, { style: string; color?: Color }>;
export declare const MASKS: Record<string, { style: string; color?: Color }>;
export declare const GLASSES: Record<string, { style: GlassesStyle; color?: Color; tint?: Color; size?: number; aspect?: number; thickness?: number; metal?: boolean }>;
export declare const BEARDS: Record<string, { style: BeardStyle; moustache?: string | false; length?: number }>;
export declare const HATS: Record<string, { style: HatStyle; color?: Color; y0?: number }>;
export declare const EARRINGS: Record<string, { style: string; color?: Color; size?: number }>;
export declare const MAKEUP: Record<MakeupPreset, Record<string, unknown>>;
