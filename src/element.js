/**
 * element.js — Web Component <emotional-head>.
 *
 *   <emotional-head gender="female" emotion="jaded" intensity="0.9" background="dark"
 *                   lighting="studio" framing="portrait" follow-pointer idle></emotional-head>
 *
 *   const el = document.querySelector('emotional-head');
 *   el.setEmotion('contempt + slight_amusement');
 *   el.speak('Это слишком банально.', { emotion: 'coldIrony' });
 *   el.addEventListener('speakEnd', ...)    // события дублируются как DOM CustomEvent (e.detail)
 *   el.head                                  // сам экземпляр EmotionalHead
 */
import { EmotionalHead } from './emotional-head.js';

const METHODS = ['setEmotion', 'addEmotion', 'getEmotion', 'getState', 'micro', 'gesture', 'express', 'speak', 'speakAudio', 'listenStream',
  'stopSpeaking', 'setGender', 'lookAt', 'followPointer', 'setIdle', 'setChannels', 'clearChannels', 'setLighting', 'setBackground',
  'setFraming', 'loadModel', 'useProcedural', 'snapshot', 'fromPhoto', 'setPhotoOptions', 'clearPhoto', 'exportAvatar', 'importAvatar', 'setLook', 'getLook', 'setDetail', 'getDetail', 'pause', 'resume', 'likeness', 'refinePhoto', 'refineShape'];
const EVENTS = ['emotionChange', 'speakStart', 'speakEnd', 'word', 'cue', 'gesture', 'micro', 'express', 'genderChange', 'blink', 'modelLoaded', 'photoAvatar', 'lookChange'];

export class EmotionalHeadElement extends HTMLElement {
  static get observedAttributes() { return ['gender', 'emotion', 'intensity', 'restraint', 'background', 'lighting', 'framing', 'idle', 'follow-pointer', 'detail']; }

  connectedCallback() {
    if (this.head) return;
    const root = this.shadowRoot || this.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>:host{display:block;position:relative;width:100%;height:420px;contain:content}div{position:absolute;inset:0}</style><div></div>';
    const a = (n, d) => this.getAttribute(n) ?? d;
    this.head = new EmotionalHead(root.querySelector('div'), {
      gender: a('gender', 'female'),
      emotion: a('emotion', 'neutral'),
      intensity: parseFloat(a('intensity', '1')),
      background: a('background', 'dark'),
      lighting: a('lighting', 'studio'),
      framing: a('framing', 'portrait'),
      idle: a('idle', 'true') !== 'false',
      shadows: a('shadows', 'true') !== 'false',
      detail: a('detail', 'auto'),
      followPointer: this.hasAttribute('follow-pointer'),
    });
    for (const ev of EVENTS) this.head.on(ev, (detail) => this.dispatchEvent(new CustomEvent(ev, { detail })));
    this._ready = true;
  }

  disconnectedCallback() {
    // откладываем: элемент мог быть просто перемещён в DOM
    queueMicrotask(() => { if (!this.isConnected && this.head) { this.head.dispose(); this.head = null; } });
  }

  attributeChangedCallback(name, _old, v) {
    if (!this._ready || !this.head) return;
    const h = this.head;
    switch (name) {
      case 'gender': h.setGender(v); break;
      case 'emotion': case 'intensity': case 'restraint':
        h.setEmotion(this.getAttribute('emotion') || 'neutral', parseFloat(this.getAttribute('intensity') ?? '1'), 0.6, { restraint: parseFloat(this.getAttribute('restraint') ?? '0') });
        break;
      case 'background': h.setBackground(v); break;
      case 'lighting': h.setLighting(v); break;
      case 'framing': h.setFraming(v); break;
      case 'idle': h.setIdle(v !== 'false'); break;
      case 'follow-pointer': h.followPointer(v !== null); break;
      case 'detail': h.setDetail(v || 'auto'); break;
    }
  }
}
for (const m of METHODS) EmotionalHeadElement.prototype[m] = function (...args) { return this.head?.[m](...args); };

if (!customElements.get('emotional-head')) customElements.define('emotional-head', EmotionalHeadElement);
export { EmotionalHead };
