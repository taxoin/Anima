/**
 * Подстройка сходства глазами (14.6): логика раундов без рендера — какие черты показать, куда и на сколько сдвинуть.
 * Как у окулиста («так лучше или так?»): у каждой черты свой шаг (в σ — разбросах черты по набору портретов).
 *   выбран вариант — черта сдвигается туда; дважды подряд в одну сторону — шаг ×1.3, после разворота — ×0.5;
 *   «как сейчас лучше» — у показанных черт шаг ×0.5;
 *   черта подобрана, когда шаг меньше MIN_STEP или выборов по ней 5; дальше показываются следующие.
 * Рендер вариантов — EmotionalHead.tuneLikeness().
 */
const MIN_STEP = 0.15, MAX_STEP = 1.2, MAX_PICKS = 5, LIMIT = 3;

export class LikenessTuner {
  /**
   * @param {string[]} order черты по приоритету (Portrait.tuneOrder())
   * @param {Record<string, number>} [start] уже выбранные поправки
   * @param {{ step?: number, labels?: Record<string, string> }} [o]
   */
  constructor(order, start = {}, o = {}) {
    this.order = order.slice();
    this.labels = o.labels || {};
    this.step0 = o.step ?? 0.8;
    this.start = { ...start };
    this.reset();
    this.tune = { ...start };
  }

  reset() {
    this.tune = {};
    this.state = Object.fromEntries(this.order.map((f) => [f, { step: this.step0, picks: 0, last: 0, shown: 0 }]));
    this.history = [];
    this.picks = 0;
  }

  /** Все черты подобраны. */
  get done() { return this.order.every((f) => this._done(f)); }
  _done(f) { const s = this.state[f]; return s.step < MIN_STEP || s.picks >= MAX_PICKS; }

  /** Черты следующего раунда: неподобранные, реже показанные — раньше, при равенстве — по приоритету. */
  features(n) {
    const open = this.order.filter((f) => !this._done(f));
    return open.map((f, i) => ({ f, i })).sort((a, b) => this.state[a.f].shown - this.state[b.f].shown || a.i - b.i).slice(0, n).map((x) => x.f).sort((a, b) => this.order.indexOf(a) - this.order.indexOf(b));
  }

  /**
   * Варианты раунда: по паре «меньше / больше» на черту.
   * @param {number} n сколько вариантов (чётное: 2 — одна черта, 6 — три)
   * @returns {{ feature: string, label: string, dir: -1|1, step: number, tune: Record<string, number> }[]}
   */
  variants(n = 6) {
    const out = [];
    for (const f of this.features(Math.max(1, Math.floor(n / 2)))) {
      const s = this.state[f], cur = this.tune[f] || 0;
      for (const dir of [-1, 1]) {
        const v = Math.max(-LIMIT, Math.min(LIMIT, cur + dir * s.step));
        if (Math.abs(v - cur) < 1e-3) continue;              // у предела: в эту сторону дальше некуда
        out.push({ feature: f, label: this.labels[f] || f, dir, step: s.step, tune: { ...this.tune, [f]: +v.toFixed(3) } });
      }
    }
    return out;
  }

  /**
   * Выбор пользователя.
   * @param {object|null} v вариант из variants() или null — «как сейчас лучше»
   * @param {string[]} shown черты, которые были в раунде
   */
  pick(v, shown = v ? [v.feature] : []) {
    this.history.push({ tune: { ...this.tune }, state: JSON.parse(JSON.stringify(this.state)), picks: this.picks });
    this.picks++;
    for (const f of shown) if (this.state[f]) this.state[f].shown++;
    if (!v) {
      for (const f of shown) { const s = this.state[f]; if (s) { s.step *= 0.5; s.picks++; } }
      return;
    }
    const s = this.state[v.feature];
    if (s.last === v.dir) s.step = Math.min(MAX_STEP, s.step * 1.3);
    else if (s.last === -v.dir) s.step *= 0.5;
    s.last = v.dir; s.picks++;
    this.tune = { ...v.tune };
  }

  /** Забыть черты (их поправили точками по фото, 14.7): поправка — 0, шаг и счёт выборов — с начала. */
  forget(features) {
    for (const f of features) {
      delete this.tune[f];
      if (this.state[f]) this.state[f] = { step: this.step0, picks: 0, last: 0, shown: 0 };
    }
  }

  /** Отменить последний выбор. @returns {boolean} было что отменять */
  undo() {
    const h = this.history.pop();
    if (!h) return false;
    Object.assign(this, { tune: h.tune, state: h.state, picks: h.picks });
    return true;
  }
}
