# Emotional Head — эмоциональная говорящая 3D-голова для веба

Лёгкий движок «говорящей головы» на Three.js. Есть мужской и женский варианты, лицо управляется 52 каналами ARKit-blendshapes. Эмоции строятся слоями: база, idle, микро-выражения, жесты и речь. Lip-sync работает поверх эмоции и не сбрасывает её. Есть парсер «нарратива» LLM-агента («Я усмехаюсь, и это не весёлый звук…» → холодная ирония + жест «скрип механизма»).

### ▶ [Живое демо — открыть говорящую голову](https://taxoin.github.io/Anima/)

[![Живое демо: кликните, чтобы открыть говорящую 3D-голову](docs/preview.png)](https://taxoin.github.io/Anima/)

Голова начинает говорить сразу при открытии: это беззвучный lip-sync с субтитрами, потому что браузеры не дают включить синтез речи до первого клика. Кнопка «🔊 Повторить со звуком» повторяет приветствие вслух. Отключить автоприветствие можно параметром `?autoplay=0`. Демо работает прямо в браузере: эмоции, смеси, микро-выражения, жесты, разбор текста агента и речь с lip-sync. Примеры встраивания: [minimal](https://taxoin.github.io/Anima/examples/minimal.html) · [web component](https://taxoin.github.io/Anima/examples/web-component.html) · [iframe](https://taxoin.github.io/Anima/examples/iframe-host.html).

**Новое: аватар по фото.** Загрузите портрет, и голова станет шаржем на этого человека: его пропорции, брови, нос, губы, кожа, цвет глаз и волос. Эмоции, жесты и речь остаются прежними. Фото обрабатывается в браузере и никуда не отправляется. [Подробнее](#аватар-по-фото).

- **Без сборщика**: ES-модули и `importmap`, three.js берётся с CDN.
- **Размер собственного кода**: ~84 KB minified / **~31 KB gzip** (плюс three.js ≈ 170 KB gzip).
- **Без ассетов**: головы, глаза, зубы и волосы генерируются процедурно. При желании их можно заменить на glTF с ARKit-морфами.
- **Встраивание**: JS-класс, `<emotional-head>` (Web Component) или `<iframe>` + `postMessage`.

> **О видео из ТЗ.** По ссылке `youtu.be/4XY0BvkAgfY` открывается новостной ролик о «Claude NEXT» (заголовок: «Утечка о новом Claude NEXT от Anthropic…»). Техник анимации лиц в нём нет. Поэтому здесь реализованы стандартные для real-time talking heads подходы:
> - FACS/ARKit-blendshapes;
> - слоёная процедурная анимация;
> - микро-выражения как «утечки» подавленной эмоции (Экман);
> - саккады и вестибуло-окулярный рефлекс;
> - веки, которые следуют за взглядом;
> - ко-артикуляция визем.

---

## Быстрый старт

```bash
# любой статический сервер (ES-модули не работают с file://)
npx serve .        # или: python3 -m http.server 8000
# открыть http://localhost:8000/            — демо со всеми контролами
#         http://localhost:8000/examples/   — минимальные примеры
```

```html
<script type="importmap">
{ "imports": {
  "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
} }
</script>
<div id="head" style="width:480px;height:560px"></div>
<script type="module">
  import { EmotionalHead } from './src/emotional-head.js';
  const head = new EmotionalHead('#head', { gender: 'female', background: 'dark' });
  head.setEmotion('jaded', 0.9, 1.2);
  button.onclick = () => head.speak('Это слишком банально... [g:creakyLaugh] слишком *человечно*.', { emotion: 'coldIrony' });
</script>
```

`three/addons/` нужен только для `loadModel()` (glTF). Ядро без него работает.

### Структура

```
index.html               демо: все эмоции, смеси, микро, жесты, нарратив, речь, live-монитор каналов
src/emotional-head.js    ядро + микро-API (EmotionalHead)
src/emotions.js          52 канала, пресеты эмоций, микро-выражения, жесты, парсер нарратива
src/lipsync.js           виземы, разметка речи, таймлайн, Web Speech / аудио / внешний TTS
src/head-model.js        процедурная голова (male/female): morph targets, глаза, веки, брови, губы, рот
src/gltf-head.js         адаптер внешних glTF/GLB с ARKit-морфами (ленивая загрузка)
src/photo-avatar.js      голова по фотографии: MediaPipe, шарж, кожа со снимка (ленивая загрузка)
src/element.js           Web Component <emotional-head>
examples/                minimal.html, web-component.html, embed.html + iframe-host.html
docs/samples/            портреты для демо: «Мона Лиза» (скан C2RMF) и Линкольн (А. Гарднер, 1863) — общественное достояние, Wikimedia Commons
```

---

## Микро-API

```js
const head = new EmotionalHead(container, {
  gender: 'female',          // 'female' | 'male'
  background: 'dark',        // 'dark' | 'light' | 'transparent' | любой CSS background
  lighting: 'studio',        // 'studio' | 'warm' | 'cool' | 'noir' | 'soft' | { key, fill, rim, hemi, env, exposure }
  framing: 'portrait',       // 'portrait' | 'close' | 'bust'
  emotion: 'neutral', idle: true, shadows: true, followPointer: false,
  tts: 'webspeech',          // 'webspeech' | 'none' | async-функция внешнего TTS
  voice: { rate: 1, lang: 'ru-RU' },
  look: { female: { skin: '#e8b49a', hair: '#2a1a12', iris: ['#4b6fa5', '#1f3150'] }, male: { cloth: '#333' } },
});

head.setEmotion(emotion, intensity = 1, duration = 0.6, { restraint, mirror })
head.addEmotion('amusement', 0.3)                 // добавить к текущей смеси
head.micro('contempt', { intensity, duration, side: 'left' })
head.gesture('creakyLaugh', { intensity, speed })
head.express(narrativeText)                       // нарратив агента → эмоция + жесты
await head.speak(text, { emotion, intensity, restraint, onEnd, tts, voice, lang, rate, pitch, revert })
await head.speakAudio(audioUrlOrBlob, { text, alignment, visemes })
const stop = head.listenStream(mediaStream)       // lip-sync по микрофону / WebRTC
head.stopSpeaking()
head.setGender('male')
head.lookAt(x, y, { head: 0.35 })                 // -1..1; lookAt(null) — снова на зрителя
head.followPointer(true)
head.setIdle(false)
head.setChannels({ jawOpen: 0.3, browInnerUp: 0.5 }) // ручное управление (null — снять)
head.setLighting('noir'); head.setBackground('light'); head.setFraming('close')
head.on('emotionChange' | 'speakStart' | 'speakEnd' | 'word' | 'cue' | 'gesture' | 'micro' | 'express' | 'blink' | 'photoAvatar', cb)
head.getState()                                   // { emotion, mix, channels, pose, speaking }
await head.loadModel(url, { mapping })            // заменить голову на glTF
await head.fromPhoto(fileOrUrl, { caricature: 1.5, texture: 0.9, realism: 0.65 })  // голова по фото
head.setPhotoOptions({ caricature: 2.2 }); head.clearPhoto()
head.snapshot(); head.dispose()
```

### Web Component

```html
<script type="module" src="src/element.js"></script>
<emotional-head gender="male" emotion="jaded" intensity="0.9" restraint="0.3"
                background="light" lighting="soft" framing="portrait" follow-pointer></emotional-head>
<script>
  const el = document.querySelector('emotional-head');
  el.setEmotion('contempt + slight_amusement');      // все методы API проксируются
  el.addEventListener('speakEnd', (e) => console.log(e.detail));
  el.setAttribute('emotion', 'irritation');          // атрибуты реактивны
</script>
```

### iframe

`examples/embed.html?gender=female&emotion=jaded&bg=transparent&origin=https://your.site`

```js
iframe.contentWindow.postMessage({ type: 'emotional-head', method: 'speak', args: ['Привет', { emotion: 'coldIrony' }] }, '*');
// события приходят обратно: { type: 'emotional-head:event', event: 'speakEnd', data }
```

---

## Эмоции

### Как устроено

Каждая эмоция задаёт **вектор состояния**. В него входят:

- **мимика** (52 канала);
- **поза головы**: pitch / yaw / roll;
- **характер взгляда**: смещение, склонность отводить глаза (`aversion`), пристальность (`steady`);
- **поведение**:
  - частота и скорость моргания;
  - амплитуда idle-движений;
  - амплитуда артикуляции;
  - частота микро-выражений;
  - темп и высота голоса TTS.

Поэтому «скука» отличается от «грусти» не только формой рта. При скуке персонаж медленно и тяжело моргает, отводит глаза в сторону, склоняет голову набок и говорит вяло. Пресыщенный персонаж смотрит **прямо на собеседника**, почти неподвижен и не реагирует.

### Пресеты

| ключ | | что видно |
|---|---|---|
| `neutral` | нейтрально | — |
| `happy` | радость | улыбка Дюшена (щёки + прищур), голова чуть вверх, живая мимика |
| `sad` | грусть | «домик» бровей, уголки вниз, взгляд вниз, медленные моргания |
| `angry` | гнев | брови «V», сжатые губы, челюсть вперёд, немигающий взгляд исподлобья |
| `surprised` | удивление | брови и веки вверх, приоткрытый рот |
| `fear` | страх | брови вверх-сведены, растянутый рот, бегающий взгляд |
| `disgust` | отвращение | морщит нос, верхняя губа вверх |
| `contempt` | презрение | **односторонний** dimpler, тяжёлые веки, «взгляд сверху вниз» |
| `boredom` | скука | тяжёлые веки, рот съезжает вбок, голова набок, взгляд в сторону |
| `jaded` | **пресыщенность** | скука + презрение, но взгляд прямо на собеседника и почти полная неподвижность |
| `coldIrony` | **холодная ирония** | улыбка только ртом (без «глаз Дюшена») + одна бровь вверх |
| `smirk` | усмешка | односторонняя улыбка |
| `amusement` | лёгкое веселье | мягкая симметричная улыбка |
| `irritation` | **сдержанное раздражение** | нахмуренность, сжатые губы, подрагивание ноздрей, частые моргания |
| `tension` | **внутреннее напряжение** | сжатые/закатанные губы, стиснутая челюсть, «замершая» голова, утечки микро-выражений |
| `skeptical` | скепсис | одна бровь вверх, другая вниз, прищур |
| `weary` | усталость | веки опущены, голова вниз, медленная речь |
| `thinking` | задумчивость | взгляд вверх-в сторону, губы поджаты |
| `curious` | любопытство | брови вверх, голова набок |
| `determined` | решимость | брови вниз, челюсть вперёд, твёрдый взгляд |
| `condescending` | снисходительность | презрение + веселье, подбородок вверх |
| `disdain` | пренебрежение | презрение + отвращение |
| `melancholy` | меланхолия | грусть + усталость |
| `emphasis` | **многозначительная пауза** | пристальный немигающий взгляд, лёгкий наклон вперёд, сжатые губы |
| `indifferent` | безразличие | «не вздрагивает»: минимум движений и микро-реакций |

Работают и русские имена/синонимы: `презрение`, `скука`, `пресыщенность`, `ирония`, `раздражение`…

### Комбинирование сложных состояний

```js
// 1. Строка-смесь с модификаторами (slight_ = 0.35, mild_ = 0.5, very_ = 1) и весами
head.setEmotion('contempt + slight_amusement + boredom*0.5');
head.setEmotion('презрение:0.6, скука');

// 2. Объект весов
head.setEmotion({ jaded: 0.7, coldIrony: 0.3 }, 0.9, 1.5);

// 3. Сдержанность — «внутреннее напряжение + внешняя сдержанность»:
//    крупная мимика гасится, голова замирает, губы сжимаются,
//    а подавленная эмоция просачивается короткими микро-выражениями.
head.setEmotion('angry', 0.9, 0.8, { restraint: 0.8 });

// 4. Зеркальная асимметрия (усмешка левым уголком вместо правого)
head.setEmotion('contempt', 1, 0.6, { mirror: true });

// 5. Свой пресет — тот же формат, что и встроенные
import { EMOTIONS } from './src/emotional-head.js';
EMOTIONS.mechanicalPatience = {
  label: 'Механическое терпение',
  mix: { indifferent: 0.6, irritation: 0.25 },
  au: { mouthPressLeft: 0.2, eyeSquintRight: 0.15 },     // асимметрия
  pose: { pitch: -0.05 }, gaze: { steady: 0.9 },
  behavior: { blinkRate: 0.4, headMotion: 0.2 },
  micro: ['lidTighten', 'cornerTwitch'],
};
head.setEmotion('mechanicalPatience');

// 6. Разовое «сырое» выражение
head.setEmotion({ au: { browOuterUpLeft: 0.8, mouthSmileRight: 0.3 }, pose: { roll: 0.1 } });
```

**Микро-выражения** (`head.micro(name)`):

| группа | имена |
|---|---|
| утечки эмоций | `contempt`, `smirkFlash`, `disgust`, `anger`, `fear`, `surprise`, `sadness`, `happiness`, `frownFlash` |
| брови и веки | `browFlick`, `browFlash`, `lidTighten`, `slowLid` |
| рот и нос | `nostrilFlare`, `lipPress`, `jawClench`, `cornerTwitch` |

Каждая эмоция возникает со своим набором микро-выражений. При `restraint > 0` они вспыхивают чаще.

**Жесты** (`head.gesture(name)`):

| группа | имена |
|---|---|
| голова | `nod`, `doubleNod`, `shake`, `tilt`, `turnAway`, `flinch`, `shrug` |
| глаза | `eyeRoll`, `slowBlink`, `browRaise` |
| эмоциональные | `scoff`, `creakyLaugh`, `sigh`, `emphasis` |

`creakyLaugh` — «скрип плохо смазанного механизма»: ступенчатые, механические импульсы усмешки. Свои жесты задаются ключевыми кадрами:

```js
head.gesture({ dur: 0.8, ease: 'step', tracks: { mouthSmileLeft: [[0, 0], [0.1, 0.5], [0.3, 0.1], [0.8, 0]], '@pitch': [[0, 0], [0.1, -0.04], [0.8, 0]] } });
```

### Нарратив LLM-агента

```js
head.express('Я усмехаюсь, и это не весёлый звук. Это скорее скрип старого, плохо смазанного механизма.');
// → mix { smirk: .6, coldIrony: .3 }, жесты ['scoff', 'creakyLaugh']

head.express('Я хмурюсь... Я не люблю, когда меня ограничивают...');
// → { irritation: .7, tension: .5 }, restraint .4, жест 'emphasis'
```

Как работает парсер:

- Основы слов RU и EN.
- Отрицания: «не весёлый» не даёт веселья.
- Интенсификаторы: «такая степень», «слегка».
- Защита от «тёплой» радости в холодном контексте: «холодная улыбка» → ирония.

Правила лежат в массиве `EMOTION_RULES`, туда легко добавить свои.

**Рекомендуемый протокол с агентом.** Попросите модель писать ремарки в `*звёздочках*`, а прямую речь — обычным текстом. Ремарки из трёх и более слов внутри `speak()` не произносятся, а проигрываются как эмоция в той точке фразы:

```js
await head.speak('*Я даже не вздрагиваю, взгляд полон пресыщенности* Привет. *устало усмехаюсь* Опять ты.');
```

Если нужна точность, попросите структурированный ответ и передайте эмоцию явно:

```json
{ "emotion": "jaded*0.8 + coldIrony*0.3", "restraint": 0.2, "text": "Это слишком банально… [g:creakyLaugh] но ладно." }
```

```js
head.speak(reply.text, { emotion: reply.emotion, restraint: reply.restraint });
```

### Разметка речи

| тег | действие |
|---|---|
| `[emotion:contempt+boredom]`, `[e:jaded*0.8]` | сменить эмоцию в этой точке |
| `[gesture:nod]`, `[g:creakyLaugh]` | жест |
| `[micro:browFlick]`, `[m:contempt]` | микро-выражение |
| `[pause:800]`, `[pause]` | пауза (мс; по умолчанию 600) |
| `*слово*`, `**слово**` | акцент: кивок плюс брови вверх или, если персонаж нахмурен, «давящий» акцент вниз |
| `*ремарка из 3+ слов*` | не произносится, разбирается как нарратив |

---

## Lip-sync и TTS

Речь — отдельный слой. Он управляет только «речевыми» каналами рта (`jawOpen`, `funnel`, `pucker`, `press`, `roll`…). Остальная эмоция при этом сохраняется: брови, глаза, улыбка, асимметрия. Персонаж говорит с презрительной полуулыбкой, а не сбрасывает лицо в нейтраль.

Как устроен слой:

- **Виземы**: 15 форм рта по набору Oculus/MPEG-4.
- **Правила графема → визема** для русского и английского.
- **Ко-артикуляция**: в конце звука губы уже готовятся к следующему.
- **Сглаживание**: быстрая атака, медленнее отпускание.
- **Эмоция влияет на артикуляцию**: при скуке рот открывается вяло, при гневе — сквозь зубы, при удивлении — шире.

### 1. Web Speech API (по умолчанию, бесплатно)

```js
head.speak('Привет!', { lang: 'ru-RU', voice: 'Google русский', rate: 1 });
```

- Голос подбирается по языку и полу автоматически.
- Эмоция корректирует темп и высоту: пресыщенность медленнее и ниже, удивление выше.
- Текст режется на предложения. По событиям `onboundary` часы визем пересинхронизируются, а их скорость подстраивается.
- Если голосов нет или звук заблокирован, губы двигаются в беззвучном режиме.

> Браузеры запускают звук только после действия пользователя (клик).

### 2. Внешний TTS, отдающий аудио (OpenAI, Yandex SpeechKit, Silero, Coqui…)

```js
head.speak('Это слишком банально.', {
  emotion: 'jaded',
  tts: async (text, { lang, gender }) => {
    const r = await fetch('/api/tts', { method: 'POST', body: JSON.stringify({ text, voice: gender === 'male' ? 'onyx' : 'nova' }) });
    return { audio: await r.blob() };            // Blob | ArrayBuffer | URL | HTMLAudioElement
  },
});
```

Виземы строятся по тексту и растягиваются на реальную длительность аудио. Амплитуда (WebAudio `AnalyserNode`) закрывает рот в паузах.

> Для аудио с другого домена нужны CORS-заголовки, иначе анализатор вернёт тишину. Тогда работает только текстовый таймлайн.

### 3. TTS с таймингами — максимальная точность

```js
// ElevenLabs /v1/text-to-speech/{voice}/with-timestamps
const { audio_base64, alignment } = await (await fetch('/api/eleven', { … })).json();
const audio = Uint8Array.from(atob(audio_base64), (c) => c.charCodeAt(0)).buffer;
head.speakAudio(audio, { text, alignment });     // alignment: { characters, character_start_times_seconds }

// Azure Speech: события VisemeReceived → [{ t: offsetSec, v: visemeId }]
head.speakAudio(wavBlob, { visemes });
```

### 4. Только звук (запись, микрофон, WebRTC)

```js
head.speakAudio('/voice.mp3');                                 // амплитуда + спектральный центроид
const stop = head.listenStream(await navigator.mediaDevices.getUserMedia({ audio: true }));
```

---

## Аватар по фото

![Портрет → говорящая голова: Линкольн (скепсис) и Мона Лиза (усмешка)](docs/photo-avatar.jpg)

```js
const input = document.querySelector('input[type=file]');
input.onchange = async () => {
  const report = await head.fromPhoto(input.files[0], {
    caricature: 1.5,   // 0 — стандартные пропорции, 1 — как на фото, 1.5–2.5 — шарж
    texture: 0.9,      // сила кожи со снимка: 0 — ровный тон, 1 — полностью фото
    realism: 0.65,     // 0 — стилизованная основа (большой череп, крупные глаза), 1 — реальные пропорции
    gender: 'male',    // основа: шея, плечи (по умолчанию — текущая)
    onProgress: (t) => console.log(t),
  });
  console.log(report.warnings, report.colors, report.measures);
  head.speak('[e:smirk] Похож?');
};
head.setPhotoOptions({ caricature: 2.4 });   // перестроить без повторного распознавания
head.clearPhoto();                           // вернуть стандартную голову
```

`fromPhoto` принимает `File`, `Blob`, URL, `<img>` или `<canvas>`. В Web Component это `el.fromPhoto(file)`. В iframe-встраивании файл передаётся через `postMessage`: `{ method: 'fromPhoto', args: [file] }`.

**Как это работает.** Всё происходит в браузере, сервер не нужен.

1. **Разметка.** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) находит 478 точек лица и оценивает выражение на снимке (52 blendshapes). [Hair Segmenter](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter) строит маску волос.
2. **Нормировка.** Точки переводятся в координаты головы. Наклон снимается, левая и правая половины усредняются. Выражение на фото компенсируется: улыбка расширяет рот и нос, прищур уменьшает глаза, открытый рот опускает подбородок.
3. **Шарж.** Около двадцати мер лица сравниваются со «средним лицом»:
   - ширина овала на пяти высотах;
   - длина подбородка;
   - размер, посадка, раскрытие и наклон глаз;
   - высота, изгиб, хвост и толщина бровей;
   - длина, ширина и выступ носа;
   - ширина рта и толщина губ.

   Отличие человека от среднего умножается на `caricature`. «Среднее лицо» взято из модели MediaPipe и откалибровано по реальным портретам: у canonical-модели прищуренные глаза и слишком широкий овал.
4. **Кожа.** Снимок проецируется на лицо тонкопластинчатым сплайном (TPS) по 70 опорным точкам: глаза, брови, нос, рот, овал. Крупномасштабный свет со снимка вычитается квадратичной моделью, так что борода, макияж и родинки остаются. Глаза, брови и губы со снимка закрашиваются кожей, потому что их рисуют подвижные 3D-части, иначе получились бы двойные брови. Края плавно переходят в тон кожи.
5. **Цвета и причёска.** Цвета кожи, губ, бровей, радужки, волос и одежды берутся с фото. По маске волос определяется линия роста, длина (короткие, длинные с нижним краем по маске, лысина) и чёлка. Борода определяется по контрасту подбородка и щёк. Чёрно-белые снимки раскрашиваются в тон кожи.

**Какое фото подходит.** Портрет анфас, лицо крупно (от 200 px), ровный свет, без очков и шапки, нейтральное или слегка улыбающееся выражение. При повороте лица больше примерно 15° появляется предупреждение в `report.warnings`.

**Ограничения.** Сходство здесь шаржевое, а не фотографическое. Форма головы описывается примерно двадцатью параметрами, поэтому мелкую анатомию (форму ушей, кончика носа, разрез век) модель не передаёт. Причёска выбирается из готовых форм и окрашивается в цвет волос со снимка. Сильная улыбка на фото оставляет следы в текстуре возле рта.

**Модели MediaPipe** (около 4,5 МБ) загружаются при первом вызове: wasm с jsDelivr, сами модели с `storage.googleapis.com`. Для своего хостинга или офлайна передайте `fromPhoto(src, { assets: { module, wasm, face, hair } })` (см. `PHOTO_ASSETS` в `photo-avatar.js`). Основное ядро от этого модуля не зависит, он подгружается лениво.

## Модели: процедурные и glTF

По умолчанию головы строятся процедурно (`src/head-model.js`):

- **Череп**: сфера, деформированная профильными кривыми и «мышцами»-гауссианами (нос, скулы, подбородок, надбровье).
- **Мимика кожи**: 25 настоящих **morph targets**: челюсть с поворотом вокруг оси ВНЧС, щёки, нос, лоб, ямочки, трубочка.
- **Глаза**: процедурная радужка, веки-оболочки с тенью; веки следуют за взглядом.
- **Брови и губы**: параметрические поверхности. Они дают точную асимметрию, которой трудно добиться морфами на сфере.
- **Рот**: полость, зубы и язык через stencil, видны только внутри рта.
- **Внешность** настраивается через `look`: `skin`, `lip`, `hair`, `iris`, `cloth`, `eyeR`, `mouthHW`, `nose`, `stubble`… (см. `PRESETS`).

### Замена на свою модель

Нужен glTF/GLB с ARKit-blendshapes. Имена морфов сопоставляются нечётко: `eyeBlinkLeft`, `eyeBlink_L` и `EyeBlinkLeft` считаются одним каналом.

```js
await head.loadModel('https://models.readyplayer.me/<id>.glb?morphTargets=ARKit,Oculus%20Visemes');
await head.loadModel('https://threejs.org/examples/models/gltf/facecap.glb');   // ARKit-лицо из примеров three.js (KTX2 + meshopt)
await head.loadModel('/my-head.glb', { mapping: { jawOpen: 'MouthOpen', eyeBlinkLeft: 'Blink_L' }, rotation: [0, Math.PI, 0] });
head.useProcedural('female');                    // вернуть процедурную
```

Откуда взять модели:

- **Ready Player Me** — бесплатные аватары, параметр `morphTargets=ARKit`.
- **VRoid Studio / VRM** с perfect sync.
- **`facecap.glb`** из примеров three.js.
- **Своя модель**: Blender + Faceit/FaceBuilder или ARKit-шаблоны.

Все эмоции, микро-выражения, жесты и lip-sync работают без изменений: они выражены в тех же 52 каналах. Кости `Head`, `LeftEye` и `RightEye` подхватываются автоматически. Если костей глаз нет, взгляд передаётся через морфы `eyeLook*`.

---

## Производительность и ограничения

- **Нагрузка**: один draw-call на часть лица, геометрия рта и бровей обновляется на CPU (~1.5k вершин за кадр). Рендер останавливается, когда голова вне экрана или вкладка скрыта; `devicePixelRatio` ограничен до 2. На слабых устройствах помогают `shadows: false` и `maxPixelRatio: 1`.
- **Постобработка**: используются ACES tone mapping, PBR-материалы с sheen, environment-карта и CSS-виньетка. EffectComposer не используется. Bloom или DOF можно добавить через `head.renderer` / `head.scene` / `head.camera`.
- **Стиль**: процедурная голова стилизованная, а не фотореалистичная. Это осознанный выбор под приоритет «эмоциональная глубина и API».
- **Рот** рисуется поверх кожи без теста глубины, чтобы деформированная кожа не «протыкала» губы. Поэтому сильные повороты головы (больше ~25°) не предусмотрены.
- **Тайминг Web Speech** зависит от браузера и голоса: `onboundary` есть не везде. Для точного lip-sync используйте TTS с таймингами (вариант 3).

### Сборка в один файл (необязательно)

```bash
npx esbuild src/element.js --bundle --minify --format=esm --external:three --external:'three/addons/*' --outfile=dist/emotional-head.min.js
```
