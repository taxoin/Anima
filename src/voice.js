/**
 * Свой голос (13.1): клонирование по записи и синтез этим голосом с таймингами букв для губ.
 *
 *   const el = new ElevenLabsVoice({ apiKey });
 *   const voice = await el.clone([blob], { name: 'Мой голос' });   // → { provider: 'elevenlabs', id, name }
 *   head.setVoice(voice, { apiKey });                              // speak() говорит этим голосом
 *
 * Ключ API хранится только в памяти (и у демо — в localStorage браузера пользователя) и уходит только на api.elevenlabs.io.
 * ElevenLabs разрешает запросы из браузера (CORS: *), поэтому сервер не нужен. Для чужого сайта ключ лучше прятать
 * за своим прокси: base — его адрес, apiKey можно не передавать.
 */

const EL_BASE = 'https://api.elevenlabs.io';

/** Ошибка провайдера голоса с понятным текстом (нет прав ключа, кончились кредиты, голос не найден…). */
export class VoiceError extends Error {
  constructor(message, { status, code, provider } = {}) { super(message); this.name = 'VoiceError'; Object.assign(this, { status, code, provider }); }
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

async function elError(r) {
  let d = null;
  try { d = (await r.json())?.detail; } catch { /* не JSON */ }
  const code = d?.status || d?.code || '', msg = typeof d === 'string' ? d : d?.message || r.statusText;
  const hint = {
    missing_permissions: 'У ключа нет нужного права — включите его в настройках ключа ElevenLabs (Text to Speech; для клонирования — Voices: write).',
    quota_exceeded: 'Кончились кредиты ElevenLabs.',
    invalid_api_key: 'Неверный ключ ElevenLabs.',
    can_not_use_instant_voice_cloning: 'Клонирование голоса недоступно на этом тарифе ElevenLabs (нужен платный, от Starter).',
    voice_not_found: 'Голос не найден — его удалили или он с другого аккаунта.',
  }[code];
  return new VoiceError(hint ? `${hint} (${msg})` : `ElevenLabs ${r.status}: ${msg}`, { status: r.status, code, provider: 'elevenlabs' });
}

export class ElevenLabsVoice {
  /**
   * @param {object} o
   * @param {string} [o.apiKey]  ключ ElevenLabs (xi-api-key)
   * @param {string} [o.model='eleven_multilingual_v2']  'eleven_flash_v2_5' — быстрее и дешевле, чуть хуже
   * @param {string} [o.base]    адрес API или своего прокси
   * @param {number} [o.cache=24]  сколько последних фраз хранить (повтор той же фразы — без запроса и кредитов)
   */
  constructor({ apiKey, model = 'eleven_multilingual_v2', base = EL_BASE, cache = 24 } = {}) {
    Object.assign(this, { apiKey, model, base: base.replace(/\/$/, ''), cacheSize: cache });
    this._cache = new Map();
  }
  _h(extra = {}) { return this.apiKey ? { 'xi-api-key': this.apiKey, ...extra } : extra; }

  /**
   * Клонировать голос по записям (Instant Voice Cloning): 1–25 файлов, лучше 30 с – 2 мин чистой речи без музыки.
   * @param {Blob|Blob[]} samples
   * @param {object} [o] { name, description, removeNoise=true }
   * @returns {Promise<{provider: 'elevenlabs', id: string, name: string}>}
   */
  async clone(samples, { name = 'Anima', description = 'Голос, записанный в Anima', removeNoise = true } = {}) {
    const fd = new FormData();
    fd.append('name', name);
    fd.append('description', description);
    fd.append('remove_background_noise', String(!!removeNoise));
    [].concat(samples).forEach((b, i) => fd.append('files', b, b.name || `sample-${i + 1}.${/ogg/.test(b.type) ? 'ogg' : /mp4|m4a|aac/.test(b.type) ? 'm4a' : /mpeg|mp3/.test(b.type) ? 'mp3' : /wav/.test(b.type) ? 'wav' : 'webm'}`));
    const r = await fetch(`${this.base}/v1/voices/add`, { method: 'POST', headers: this._h(), body: fd });
    if (!r.ok) throw await elError(r);
    const d = await r.json();
    return { provider: 'elevenlabs', id: d.voice_id, name };
  }

  /** Голоса аккаунта: [{ id, name, category }] (category 'cloned' — свои). Нужно право Voices: read. */
  async voices() {
    const r = await fetch(`${this.base}/v2/voices?page_size=100`, { headers: this._h() });
    if (!r.ok) throw await elError(r);
    return (await r.json()).voices.map((v) => ({ id: v.voice_id, name: v.name, category: v.category }));
  }

  /** Голос по id: { id, name, category }. Ошибка с code 'voice_not_found' — в этом аккаунте его нет. Нужно право Voices: read. */
  async get(id) {
    const r = await fetch(`${this.base}/v1/voices/${encodeURIComponent(id)}`, { headers: this._h() });
    if (!r.ok) throw await elError(r);
    const v = await r.json();
    return { id: v.voice_id, name: v.name, category: v.category };
  }

  /** Удалить голос из аккаунта ElevenLabs. */
  async remove(id) {
    const r = await fetch(`${this.base}/v1/voices/${encodeURIComponent(id)}`, { method: 'DELETE', headers: this._h() });
    if (!r.ok) throw await elError(r);
  }

  /**
   * Синтез с таймингами букв: { audio: Blob (mp3), alignment: { characters, character_start_times_seconds } }.
   * rate — темп от эмоции (1 — обычный), переводится в speed ElevenLabs (0.7…1.2).
   * @param {string} text @param {string} id @param {object} [o] { rate, stability, style, similarity }
   */
  async synth(text, id, { rate = 1, stability = 0.5, style = 0, similarity = 0.8 } = {}) {
    const settings = { stability: clamp(stability, 0, 1), similarity_boost: clamp(similarity, 0, 1), style: clamp(style, 0, 1), speed: +clamp(rate, 0.7, 1.2).toFixed(2), use_speaker_boost: true };
    const key = JSON.stringify([id, this.model, text, settings]);
    if (this._cache.has(key)) { const v = this._cache.get(key); this._cache.delete(key); this._cache.set(key, v); return v; }
    const r = await fetch(`${this.base}/v1/text-to-speech/${encodeURIComponent(id)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST', headers: this._h({ 'content-type': 'application/json' }), body: JSON.stringify({ text, model_id: this.model, voice_settings: settings }),
    });
    if (!r.ok) throw await elError(r);
    const d = await r.json();
    const bin = atob(d.audio_base64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const res = { audio: new Blob([bytes], { type: 'audio/mpeg' }), alignment: d.alignment || d.normalized_alignment || null };
    this._cache.set(key, res);
    while (this._cache.size > this.cacheSize) this._cache.delete(this._cache.keys().next().value);
    return res;
  }

  /**
   * Функция для speak({ tts }): голос id с поправкой на эмоцию — темп из эмоции, при сильной эмоции голос
   * живее (ниже stability, выше style), в покое ровнее.
   */
  tts(id, o = {}) {
    return (text, info = {}) => {
      const arousal = clamp(Math.abs((info.rate ?? 1) - 1) * 4 + Math.abs((info.pitchVoice ?? 1) - 1) * 2, 0, 1);
      return this.synth(text, id, { rate: info.rate ?? 1, stability: (o.stability ?? 0.5) - 0.2 * arousal, style: (o.style ?? 0) + 0.3 * arousal, similarity: o.similarity });
    };
  }
}

// ---------------------------------------------------------------- голосовой пакет (13.4)

/** Формат файла голоса: имя, согласие, по желанию запись с текстом и id голоса у провайдеров. */
export const VOICE_PACK_FORMAT = 'anima-voice';

export async function blobToB64(blob) {
  const u = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBlob(b64, type = 'application/octet-stream') {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type });
}

/**
 * Запись для пакета: короткая (запись из браузера — Opus, ~10 КБ/с) — как есть; большая (WAV, длинный mp3) —
 * 16 кГц моно WAV не длиннее maxSec: клонированию хватает, файл ≤ ~3 МБ.
 */
export async function compactSample(blob, { maxBytes = 3e6, maxSec = 90, rate = 16000 } = {}) {
  if (blob.size <= maxBytes) return blob;
  const src = await new OfflineAudioContext(1, 1, rate).decodeAudioData(await blob.arrayBuffer());
  const len = Math.min(Math.ceil(src.duration * rate), maxSec * rate);
  const ctx = new OfflineAudioContext(1, len, rate), node = ctx.createBufferSource();
  node.buffer = src; node.connect(ctx.destination); node.start();
  const pcm = (await ctx.startRendering()).getChannelData(0), dv = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, t) => { for (let i = 0; i < t.length; i++) dv.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(44 + i * 2, clamp(pcm[i], -1, 1) * 32767, true);
  return new Blob([dv.buffer], { type: 'audio/wav' });
}

/** Провайдеры по имени из профиля голоса ({ provider, id, name }). */
export const VOICE_PROVIDERS = { elevenlabs: ElevenLabsVoice };
