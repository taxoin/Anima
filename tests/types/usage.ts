// Проверка типов (npm run test:types): типичное использование пакета должно компилироваться в strict-режиме,
// а ошибки (@ts-expect-error) — ловиться.
import EmotionalHead, { CHANNELS, EMOTIONS, SKIN_TONES, OUTFITS, VISEMES, parseNarrative, type Channels, type Look, type PhotoReport } from 'emotional-head';
import { EmotionalHeadElement } from 'emotional-head/element';
import { resolveEmotion, type ARKitChannel } from 'emotional-head/emotions';
import { buildTimeline, parseMarkup, type Viseme } from 'emotional-head/lipsync';

const head = new EmotionalHead('#stage', { gender: 'female', detail: 'adaptive', look: { skin: 'olive', iris: ['#335', '#112'], outfit: 'blazer', glasses: { style: 'round', metal: true } } });
head.setEmotion('contempt + slight_amusement*0.5', 0.9, 0.6, { restraint: 0.3 }).gesture('nod').micro('browFlick', { side: 'left' });
head.setEmotion({ contempt: 0.6, boredom: 0.4 });
head.on('detailChange', (e) => console.log(e.detail, e.pixelRatio.toFixed(1)));
head.on('photoAvatar', (r) => r?.warnings.forEach((w) => console.log(w)));
head.on('cue', (c) => { if (c.type === 'gesture') console.log(c.value); });
const ch: Channels = { jawOpen: 0.3, mouthSmileLeft: 0.5, pupil: 1 };
head.setChannels({ ...ch, jawOpen: null });
head.renderStill(ch, { yaw: 0.3 });
const first: ARKitChannel = CHANNELS[0];
const v: Viseme = 'aa';
console.log(first, v, Object.keys(EMOTIONS).length, SKIN_TONES.olive?.skin, OUTFITS.blazer.cloth2, VISEMES.aa.jawOpen);

async function main() {
  await head.speak('[e:coldIrony] Привет. *Слегка* улыбаюсь.', { emotion: 'auto', revert: true, rate: 1.1 });
  const rep: PhotoReport = await head.fromPhoto('/me.jpg', { caricature: 1.5, gender: 'auto', onProgress: (t) => console.log(t) });
  console.log(rep.issues.length, rep.gender?.value, rep.profile?.params.nose);
  const pr = await head.addProfile('/side.jpg');
  console.log(pr.params.chin, pr.side);
  await head.fromPhoto('/me.jpg', { profile: '/side.jpg' });
  const json: string = await head.exportAvatar({ format: 'json' });
  await head.importAvatar(json);
  const glb: ArrayBuffer = await head.exportGLB({ detail: 'medium' });
  const gltf: Record<string, unknown> = await head.exportGLB({ binary: false });
  console.log(glb.byteLength, Object.keys(gltf));
  const stop = head.listenStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
  stop();
  const ad = head.getAdaptive();
  if (ad) console.log(ad.step, ad.refreshHz);
}
main();

const look: Look = { hairStyle: 'bob', hairGray: 0.4, beard: null, mask: 'n95', contactShadows: false, skinScatter: 0.5, eyeBags: 0.6 };
head.setLook(look, { replace: true });
console.log(resolveEmotion('jaded').mix, parseNarrative('Я хмурюсь').gestures, buildTimeline('привет').duration, parseMarkup('[g:nod] да').cues[0]?.type);

const el = document.querySelector('emotional-head');
el?.addEventListener('speakEnd', (e) => console.log(e.detail));
el?.setEmotion('happy');
const el2: EmotionalHeadElement | null = el;
console.log(el2?.head?.getDetail());
head.setFlat({ pixel: 2, bands: 4 }).setFlat(false);
head.setFlat({ tris: 3000 }).setFlat({ tris: 0 }).setFlat({ outline: 1.5, outlineColor: '#202020', rim: 0.6 });
head.on('flatChange', (f) => console.log(f?.pixel));
const q: 'lite' | 'high' = head.setQuality('high').setQuality().getQuality();
head.on('qualityChange', (e) => console.log(e.quality, q));
head.setInsets({ bottom: 320, top: 40 }).setInsets(null).setIdleFps(24).setIdleFps(0);

// ожидаемые ошибки
// @ts-expect-error неизвестная детализация
head.setDetail('ultra');
// @ts-expect-error неизвестное качество
head.setQuality('ultra');
// @ts-expect-error неверная детализация плоского режима
head.setFlat({ detail: 'tiny' });
// @ts-expect-error неизвестное событие
head.on('nope', () => {});
// @ts-expect-error неизвестный канал
const bad: Channels = { jawOpn: 1 };
// @ts-expect-error неверный стиль причёски
const badLook: Look = { hairStyle: 'mohawk' };
console.log(bad, badLook);
