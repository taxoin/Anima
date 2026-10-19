/** Типы для lipsync.js — виземы, разметка речи, таймлайны, Web Speech, анализ аудио. */
import type { Channels, NarrativeResult } from './emotions.js';
export { parseNarrative } from './emotions.js';

/** Виземы (Oculus / MPEG-4-подобный набор из 15). */
export type Viseme = 'sil' | 'PP' | 'FF' | 'TH' | 'DD' | 'kk' | 'CH' | 'SS' | 'nn' | 'RR' | 'aa' | 'E' | 'I' | 'O' | 'U';

export declare const VISEMES: Record<Viseme, Channels>;
/** Каналы, которыми владеет речевой слой (эмоция в них ослабляется во время речи). */
export declare const SPEECH_CHANNELS: readonly string[];
/** Azure viseme ID (0–21) → визем. */
export declare const AZURE_VISEMES: readonly Viseme[];

/** Событие разметки, привязанное к позиции символа i в тексте без тегов. */
export interface Cue {
  i: number;
  type: 'emotion' | 'gesture' | 'micro' | 'pause' | 'emphasis' | 'narrative';
  value: string | number | NarrativeResult | Record<string, unknown>;
  /** Время срабатывания, с (заполняется при построении реплики). */
  t?: number;
  [key: string]: unknown;
}

/** Разметка: [e:contempt] [g:nod] [m:browFlick] [pause:800] *акцент* *ремарка из 3+ слов*. */
export declare function parseMarkup(text: string): { plain: string; cues: Cue[] };

export interface TimelineItem { t: number; dur: number; v: Viseme; i: number }
export interface Timeline { items: TimelineItem[]; words: Array<{ i: number; t: number }>; duration: number }

export declare function buildTimeline(text: string, opts?: { rate?: number }): Timeline;
/** Таймлайн из выравнивания по символам (ElevenLabs alignment, Whisper timestamps…). */
export declare function timelineFromAlignment(chars: ArrayLike<string>, times: ArrayLike<number>): Timeline;
/** Таймлайн из списка визем [{ t, v }]: v — имя визема или Azure ID. */
export declare function timelineFromVisemes(list: Array<{ t: number; v: Viseme | number }>): Timeline;
/** Каналы визем в момент t (с коартикуляцией). */
export declare function visemeChannelsAt(tl: Timeline, t: number, out?: Channels): Channels;

export declare const WebSpeech: {
  available(): boolean;
  voices(): SpeechSynthesisVoice[];
  /** Голос по языку и полу (эвристика по имени голоса). */
  pickVoice(lang?: string, gender?: 'female' | 'male'): SpeechSynthesisVoice | null;
};

export declare function detectLang(text: string): 'ru-RU' | 'en-US';

/** RMS-уровень и спектральный центроид живого аудио. */
export declare class AudioAnalyser {
  constructor(source: HTMLMediaElement | MediaStream);
  read(): { level: number; rms: number; centroid: number };
  dispose(): void;
}

/** Внутренний контроллер реплики (используется EmotionalHead). */
export declare class SpeechController {
  constructor(host: Record<string, unknown>);
  readonly active: boolean;
  channels: Channels;
  level: number;
  speak(text: string, opts?: Record<string, unknown>): Promise<void>;
  stop(silent?: boolean): void;
  update(dt: number): void;
}
