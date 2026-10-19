/** Типы для element.js — Web Component <emotional-head>. Методы проксируются в EmotionalHead, события — DOM CustomEvent. */
import type { EmotionalHead, EmotionalHeadEvents } from './emotional-head.js';
export { EmotionalHead } from './emotional-head.js';
export * from './emotional-head.js';

type Proxied = 'setEmotion' | 'addEmotion' | 'getEmotion' | 'getState' | 'micro' | 'gesture' | 'express' | 'speak' | 'speakAudio' | 'listenStream'
  | 'stopSpeaking' | 'setGender' | 'lookAt' | 'followPointer' | 'setIdle' | 'setChannels' | 'clearChannels' | 'setLighting' | 'setBackground'
  | 'setFraming' | 'loadModel' | 'useProcedural' | 'snapshot' | 'fromPhoto' | 'setPhotoOptions' | 'clearPhoto' | 'exportAvatar' | 'importAvatar' | 'exportGLB'
  | 'setLook' | 'getLook' | 'setDetail' | 'getDetail' | 'getAdaptive' | 'pause' | 'resume' | 'likeness' | 'refinePhoto' | 'refineShape';

/** Атрибуты: gender, emotion, intensity, restraint, background, lighting, framing, idle, follow-pointer, detail, shadows. */
export interface EmotionalHeadElement extends Pick<EmotionalHead, Proxied> {}
export declare class EmotionalHeadElement extends HTMLElement {
  /** Сам экземпляр EmotionalHead (после подключения к DOM). */
  head: EmotionalHead | null;
  addEventListener<K extends keyof EmotionalHeadEvents>(type: K, listener: (this: EmotionalHeadElement, ev: CustomEvent<EmotionalHeadEvents[K]>) => void, options?: boolean | AddEventListenerOptions): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
}

declare global {
  interface HTMLElementTagNameMap { 'emotional-head': EmotionalHeadElement }
}
