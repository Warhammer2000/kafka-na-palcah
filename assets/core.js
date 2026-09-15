/* ============================================================
   core.js — ядро «Kafka на пальцах».
   Глобальный объект KV: реестр глав, DOM-хелперы, компоненты.
   Загружается ПЕРВЫМ, до scenes/*.js и app.js.
   Классический <script>, без модулей — чтобы файл открывался
   двойным кликом с диска.
   ============================================================ */
(function (global) {
  "use strict";

  var KV = {};
  global.KV = KV;

  /* ---------------- реестр глав ---------------- */
  KV.scenes = [];

  /**
   * Зарегистрировать главу.
   * @param {{id:string, num:number, group:string, nav:string,
   *          title:string, lede:string,
   *          build:function(HTMLElement, object):void}} def
   *  build(root, api) — root это пустой контейнер главы; сцена сама
   *  добавляет в него прозу, стенды и вынос.
   *  api = { interval(ms,fn), timeout(ms,fn), raf(fn), onDestroy(fn),
   *          reduced:boolean, go(sceneId) }
   */
  KV.scene = function (def) {
    KV.scenes.push(def);
  };

  /* ---------------- DOM ---------------- */

  /**
   * KV.el('div.foo#id', {attr:..}, child, child)
   * Дети: строка (текст), Node, массив, null (пропускается).
   * Спецключи атрибутов: html (innerHTML), text, style (объект),
   * on (объект слушателей), data (объект data-*).
   */
  function el(spec, attrs) {
    var m = /^([a-z0-9]+)?/i.exec(spec);
    var rawTag = (m && m[1]) || "";          // ".kv-row" без тега тоже допустим
    var rest = spec.slice(rawTag.length);
    var node = document.createElement(rawTag || "div");

    rest.replace(/([.#])([^.#]+)/g, function (_, sym, val) {
      if (sym === ".") node.classList.add(val);
      else node.id = val;
      return "";
    });

    var children = Array.prototype.slice.call(arguments, 2);

    if (attrs && (attrs.nodeType || typeof attrs === "string" || Array.isArray(attrs))) {
      children.unshift(attrs);
      attrs = null;
    }

    if (attrs) {
      for (var k in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
        var v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k === "class" || k === "className") node.className += (node.className ? " " : "") + v;
        else if (k === "style" && typeof v === "object") { for (var s in v) node.style.setProperty(s, v[s]); }
        else if (k === "on" && typeof v === "object") { for (var e in v) node.addEventListener(e, v[e]); }
        else if (k === "data" && typeof v === "object") { for (var d in v) node.setAttribute("data-" + d, v[d]); }
        else if (k === "value") node.value = v;
        else if (k === "checked") node.checked = !!v;
        else node.setAttribute(k, v === true ? "" : v);
      }
    }

    append(node, children);
    return node;
  }

  function append(node, children) {
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c === null || c === undefined || c === false) continue;
      if (Array.isArray(c)) { append(node, c); continue; }
      node.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
    }
  }

  KV.el = el;
  KV.append = function (parent) { append(parent, Array.prototype.slice.call(arguments, 1)); return parent; };
  KV.clear = function (node) { while (node.firstChild) node.removeChild(node.firstChild); return node; };

  /* ---------------- утилиты ---------------- */

  var KEY_COLORS = ["--k0", "--k1", "--k2", "--k3", "--k4", "--k5"];

  var util = {
    /** Детерминированный 32-битный хеш строки (FNV-1a).
     *  Именно его показываем в демо «hash(ключ) % партиций».
     *
     *  ВНИМАНИЕ на Math.imul. Записать умножение как (h * 16777619) >>> 0
     *  нельзя: числа в JavaScript — это double, произведение доходит до
     *  7e16 и вылезает за предел точной целочисленной арифметики (9e15).
     *  Младшие биты округляются и обнуляются, а остаток от деления на
     *  число партиций берётся ровно из них — в итоге почти всё сваливается
     *  в партицию 0. Замерено на 2000 ключах по 4 партициям:
     *  было 1742/36/168/54, стало 501/499/499/501.
     *  Math.imul делает настоящее 32-битное умножение. */
    hash: function (str) {
      var h = 2166136261;
      str = String(str);
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h >>> 0;
    },
    /** Номер партиции для ключа: hash(key) % n */
    partitionFor: function (key, n) { return util.hash(key) % n; },
    /** Короткая подпись ключа для клетки. Берём различающий хвост, а не
     *  первые буквы: у user-1, user-7 и user-42 первые три символа
     *  одинаковые («use»), и в ленте они выглядели бы одной записью. */
    shortKey: function (key) {
      var s = String(key);
      var m = /(\d+)$/.exec(s);
      if (m) return m[1].length > 4 ? m[1].slice(-4) : m[1];
      var seg = s.split(/[-_.:/ ]/).pop() || s;
      return seg.slice(0, 4);
    },
    /** Стабильный индекс палитры (0..5) для ключа. */
    keyIndex: function (key) { return util.hash(key) % KEY_COLORS.length; },
    /** CSS-переменная цвета ключа: 'var(--k3)' */
    keyColor: function (key) { return "var(" + KEY_COLORS[util.keyIndex(key)] + ")"; },
    /** Бледная заливка того же ключа: 'var(--k3-soft)' */
    keyColorSoft: function (key) { return "var(" + KEY_COLORS[util.keyIndex(key)] + "-soft)"; },
    /** Цвет палитры по индексу (для групп, консьюмеров и т.п.) */
    paletteColor: function (i) { return "var(" + KEY_COLORS[((i % 6) + 6) % 6] + ")"; },
    clamp: function (v, a, b) { return v < a ? a : v > b ? b : v; },
    /** Детерминированный ГПСЧ — демо повторяемы. */
    rng: function (seed) {
      var s = seed >>> 0 || 1;
      return function () {
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 4294967296;
      };
    },
    pick: function (arr, rnd) { return arr[Math.floor((rnd ? rnd() : Math.random()) * arr.length)]; },
    /** «12» -> «12», 1200 -> «1 200» */
    num: function (n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "); },
    plural: function (n, one, few, many) {
      var m10 = n % 10, m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return one;
      if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
      return many;
    },
    escape: function (s) {
      return String(s).replace(/[&<>"]/g, function (c) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
      });
    }
  };
  KV.util = util;

  /* ---------------- глоссарий и подсказки ---------------- */

  KV.glossary = {
    "лог": "Append-only log — файл, в который можно только дописывать в конец. Ничего не стирается и не вставляется в середину.",
    "топик": "Именованный поток сообщений одного типа: orders, payments, user-clicks. Логическая единица; физически состоит из партиций.",
    "партиция": "Один независимый лог внутри топика. Единица параллелизма: сколько партиций — столько параллельных потоков записи и чтения.",
    "offset": "Порядковый номер записи ВНУТРИ партиции: 0, 1, 2… Уникален только внутри своей партиции и не меняется никогда.",
    "брокер": "Один сервер Kafka. Кластер состоит из нескольких брокеров, партиции распределены между ними.",
    "продюсер": "Тот, кто пишет в топик. Роль, а не тип сервиса — один сервис часто и пишет, и читает.",
    "консьюмер": "Тот, кто читает из топика. Сам помнит свою позицию (offset) — «глупый брокер, умный консьюмер».",
    "ключ": "key сообщения. Определяет партицию: hash(ключ) % количество партиций. Одинаковый ключ → всегда одна партиция → порядок.",
    "consumer group": "Несколько копий одного сервиса, читающих топик совместно. Kafka раздаёт партиции между членами группы; одну партицию читает максимум один консьюмер группы.",
    "ребаланс": "Переназначение партиций между членами группы, когда кто-то ушёл или пришёл. На время ребаланса ВСЁ потребление в группе останавливается.",
    "committed offset": "Позиция, до которой дочитала группа. Хранится в самой Kafka, в служебном топике __consumer_offsets. Это номер СЛЕДУЮЩЕГО сообщения для чтения, а не последнего обработанного.",
    "LEO": "Log-end offset — номер, который получит следующая записанная в партицию запись. Конец лога.",
    "lag": "Отставание: LEO минус committed offset. Сколько сообщений консьюмер ещё не прочитал. Главная метрика здоровья.",
    "commit": "Действие «запомни, что я дочитал до сюда». Бывает автоматическим (по таймеру) и ручным (после обработки).",
    "retention": "Правило хранения: по времени (retention.ms) или по размеру (retention.bytes). Удаление НЕ зависит от того, прочитал кто-то или нет.",
    "compaction": "Уплотнение: для каждого ключа остаётся только последнее значение. Топик превращается из истории изменений в снимок состояния.",
    "tombstone": "«Надгробие» — запись с ключом и значением null. Указывает compaction удалить все записи этого ключа.",
    "репликация": "Хранение партиции в нескольких копиях на разных брокерах. Replication factor — сколько копий; обычно 3.",
    "лидер": "Копия партиции, через которую идёт вся запись и чтение. Остальные копии (followers) повторяют за ней.",
    "ISR": "In-Sync Replicas — список реплик, которые успевают за лидером. Отстала сильно — выкидывается из ISR; догнала — возвращается.",
    "acks": "Сколько подтверждений ждёт продюсер: 0 (никаких), 1 (лидер), all (все реплики из текущего ISR).",
    "min.insync.replicas": "Минимум синхронных реплик, при котором запись вообще принимается. При factor 3 ставят 2. Без него acks=all обманчив.",
    "идемпотентность": "«Повтори сколько угодно раз — результат тот же». Обработчик проверяет уникальный id сообщения и пропускает уже обработанные.",
    "at-least-once": "Базовая гарантия: сообщение точно будет доставлено, но может прийти дважды. Отсюда требование идемпотентности.",
    "exactly-once": "Ровно один раз. В Kafka работает в контуре Kafka → Kafka (идемпотентный продюсер + транзакции). Для внешней базы всё равно нужна идемпотентность на своей стороне.",
    "hot key": "Перекос: если большая часть событий идёт с одним ключом, все они лягут в одну партицию. Она перегружена, остальные простаивают.",
    "max.poll.interval.ms": "Интервал, за который консьюмер обязан вернуться за новой порцией. Не успел — Kafka считает его мёртвым и запускает ребаланс.",
    "round-robin": "Раскладка по кругу: без ключа сообщения раскидываются по партициям равномерно, но без гарантии порядка.",
    "__consumer_offsets": "Служебный топик самой Kafka, где хранятся committed offsets всех групп."
  };

  var tipEl = null;
  function ensureTip() {
    if (!tipEl) {
      tipEl = el("div.kv-tip", { role: "tooltip" });
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function showTip(target) {
    var term = target.getAttribute("data-term");
    var text = KV.glossary[term];
    if (!text) return;
    var t = ensureTip();
    t.innerHTML = "<b>" + util.escape(term) + "</b> — " + util.escape(text);
    t.style.left = "-9999px";
    t.style.top = "0px";
    t.classList.add("is-on");
    var r = target.getBoundingClientRect();
    var tw = t.offsetWidth, th = t.offsetHeight;
    var left = util.clamp(r.left + r.width / 2 - tw / 2, 10, global.innerWidth - tw - 10);
    var top = r.top - th - 8;
    if (top < 8) top = r.bottom + 8;
    t.style.left = left + "px";
    t.style.top = top + "px";
  }
  function hideTip() { if (tipEl) tipEl.classList.remove("is-on"); }

  document.addEventListener("mouseover", function (e) {
    var t = e.target.closest && e.target.closest("[data-term]");
    if (t) showTip(t);
  });
  document.addEventListener("mouseout", function (e) {
    if (e.target.closest && e.target.closest("[data-term]")) hideTip();
  });
  document.addEventListener("focusin", function (e) {
    var t = e.target.closest && e.target.closest("[data-term]");
    if (t) showTip(t);
  });
  document.addEventListener("focusout", hideTip);
  global.addEventListener("scroll", hideTip, true);

  /* ---------------- компоненты ---------------- */

  var ui = {};
  KV.ui = ui;

  /**
   * Развернуть [[термин]] / [[термин|видимый текст]] в подчёркнутое слово
   * с всплывающей подсказкой из KV.glossary. Работает в prose, note и takeaway.
   */
  KV.terms = function (html) {
    return String(html).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, function (_, term, label) {
      return '<span class="kv-term" tabindex="0" data-term="' + util.escape(term.trim()) + '">' +
        util.escape((label || term).trim()) + "</span>";
    });
  };

  /** Проза главы. Поддерживает [[термин]]. */
  ui.prose = function (html) {
    return el("div.kv-prose", { html: KV.terms(html) });
  };

  /** Врезка. tone: 'info'|'warn'|'bad'|'good'|'key' */
  ui.note = function (tone, tag, html) {
    return el("div.kv-note" + (tone && tone !== "info" ? ".kv-note--" + tone : ""), null,
      el("div.kv-note__tag", { text: tag }),
      el("div", { html: KV.terms(html) }));
  };

  /**
   * Стенд — рамка вокруг интерактива.
   * @returns {{el, body, controls, foot, say(html), hint(text)}}
   */
  ui.stage = function (opts) {
    opts = opts || {};
    var title = el("div.kv-stage__title", { text: opts.title || "Стенд" });
    var hint = el("div.kv-stage__hint", { text: opts.hint || "" });
    var head = el("div.kv-stage__head", null, title, hint);
    var body = el("div.kv-stage__body");
    var controls = el("div.kv-stage__controls");
    var foot = el("div.kv-stage__foot", { html: opts.foot || "" });
    var root = el("div.kv-stage", null, head, body, controls, foot);
    if (opts.noFoot) foot.classList.add("kv-hidden");
    if (opts.noControls) controls.classList.add("kv-hidden");
    return {
      el: root, head: head, body: body, controls: controls, foot: foot,
      say: function (html) { foot.innerHTML = html; foot.classList.remove("kv-hidden"); },
      hint: function (t) { hint.textContent = t; }
    };
  };

  /** Кнопка. variant: 'primary'|'read'|'danger'|'ghost'|undefined */
  ui.btn = function (label, onClick, opts) {
    opts = opts || {};
    var cls = "button.kv-btn";
    if (opts.variant) cls += ".kv-btn--" + opts.variant;
    if (opts.sm) cls += ".kv-btn--sm";
    var b = el(cls, { type: "button", title: opts.title || null }, label);
    if (onClick) b.addEventListener("click", onClick);
    return b;
  };

  /** Обёртка «подпись + контрол» для панели управления. */
  ui.ctl = function (label) {
    var kids = Array.prototype.slice.call(arguments, 1);
    return el("div.kv-ctl", null, label ? el("span.kv-ctl__label", { text: label }) : null, kids);
  };

  /**
   * Ползунок. onInput(value) вызывается при изменении.
   * @returns {{el, input, valEl, set(v), value()}}
   */
  ui.range = function (opts) {
    var input = el("input.kv-range", {
      type: "range", min: opts.min, max: opts.max,
      step: opts.step || 1, value: opts.value
    });
    var val = el("span.kv-ctl__val", { text: fmtVal(opts.value) });
    function fmtVal(v) { return v + (opts.unit ? " " + opts.unit : ""); }
    input.addEventListener("input", function () {
      val.textContent = fmtVal(input.value);
      if (opts.onInput) opts.onInput(Number(input.value));
    });
    var wrap = ui.ctl(opts.label, input, val);
    return {
      el: wrap, input: input, valEl: val,
      value: function () { return Number(input.value); },
      set: function (v) { input.value = v; val.textContent = fmtVal(v); }
    };
  };

  /** Переключатель. @returns {{el, input, checked(), set(b)}} */
  ui.toggle = function (label, initial, onChange) {
    var input = el("input", { type: "checkbox", checked: !!initial });
    var track = el("span.kv-switch__track");
    var root = el("label.kv-switch", null, input, track, el("span", { text: label }));
    input.addEventListener("change", function () { if (onChange) onChange(input.checked); });
    return {
      el: root, input: input,
      checked: function () { return input.checked; },
      set: function (b) { input.checked = !!b; }
    };
  };

  /** Сегментированный переключатель. items: [{value,label}] */
  ui.seg = function (items, value, onChange) {
    var btns = [];
    var root = el("div.kv-seg", { role: "group" });
    items.forEach(function (it) {
      var b = el("button", { type: "button", "aria-pressed": String(it.value === value) }, it.label);
      b.addEventListener("click", function () {
        value = it.value;
        btns.forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
        if (onChange) onChange(it.value);
      });
      btns.push(b);
      root.appendChild(b);
    });
    return {
      el: root,
      value: function () { return value; },
      set: function (v) {
        value = v;
        btns.forEach(function (x, i) { x.setAttribute("aria-pressed", String(items[i].value === v)); });
      }
    };
  };

  /** Выпадающий список. options: [{value,label}] */
  ui.select = function (label, options, value, onChange) {
    var sel = el("select.kv-select");
    options.forEach(function (o) {
      sel.appendChild(el("option", { value: o.value, selected: o.value === value }, o.label));
    });
    sel.addEventListener("change", function () { if (onChange) onChange(sel.value); });
    return { el: ui.ctl(label, sel), select: sel, value: function () { return sel.value; } };
  };

  /** Плитка-показатель. tone: 'good'|'warn'|'bad'|'read'|'write' */
  ui.stat = function (label, value, opts) {
    opts = opts || {};
    var v = el("div.kv-stat__v", null, String(value), opts.unit ? el("small", null, " " + opts.unit) : null);
    var root = el("div.kv-stat" + (opts.tone ? ".kv-stat--" + opts.tone : ""), null,
      el("div.kv-stat__l", { text: label }), v);
    return {
      el: root, valEl: v,
      set: function (val, tone) {
        KV.clear(v);
        v.appendChild(document.createTextNode(String(val)));
        if (opts.unit) v.appendChild(el("small", null, " " + opts.unit));
        root.className = "kv-stat" + (tone ? " kv-stat--" + tone : opts.tone ? " kv-stat--" + opts.tone : "");
      }
    };
  };

  ui.stats = function () {
    return el("div.kv-stats", null, Array.prototype.slice.call(arguments));
  };

  /** Легенда. items: [{color, label}] */
  ui.legend = function (items) {
    return el("div.kv-legend", null, items.map(function (i) {
      return el("span.kv-legend__i", null,
        el("span.kv-legend__sw", { style: { background: i.color } }),
        i.label);
    }));
  };

  /** Бейдж. tone: 'good'|'warn'|'bad'|'read'|'write' */
  ui.badge = function (text, tone) {
    return el("span.kv-badge" + (tone ? ".kv-badge--" + tone : ""), { text: text });
  };

  /** Таблица. head: [строки], rows: [[ячейки]] — ячейка может быть HTML-строкой или Node. */
  ui.table = function (head, rows) {
    var thead = el("thead", null, el("tr", null, head.map(function (h) { return el("th", { html: h }); })));
    var tbody = el("tbody", null, rows.map(function (r) {
      return el("tr", null, r.map(function (c) {
        return c && c.nodeType ? el("td", null, c) : el("td", { html: c == null ? "" : String(c) });
      }));
    }));
    return el("div.kv-tablewrap", null, el("table.kv-table", null, thead, tbody));
  };

  /** Псевдо-консоль для журналов. @returns {{el, write(html), clear()}} */
  ui.terminal = function (initial) {
    var root = el("pre.kv-terminal", { html: initial || "" });
    return {
      el: root,
      write: function (html) {
        root.insertAdjacentHTML("beforeend", (root.innerHTML ? "\n" : "") + html);
        root.scrollTop = root.scrollHeight;
      },
      line: function (html) {
        root.insertAdjacentHTML("beforeend", (root.innerHTML ? "\n" : "") + html);
        root.scrollTop = root.scrollHeight;
      },
      clear: function () { root.innerHTML = ""; }
    };
  };

  /** Узел топологии. kind: 'producer'|'consumer'|undefined */
  ui.node = function (kind, label, meta) {
    return el("div.kv-node" + (kind ? ".kv-node--" + kind : ""), null,
      el("span.kv-node__dot"),
      el("span", { text: label }),
      meta ? el("span.kv-node__meta", { text: meta }) : null);
  };

  /** Панель внутри стенда. */
  ui.panel = function (title) {
    var kids = Array.prototype.slice.call(arguments, 1);
    return el("div.kv-panel", null, title ? el("div.kv-panel__t", { text: title }) : null, kids);
  };

  /** Полоска-индикатор. @returns {{el, set(fraction, tone)}} */
  ui.bar = function (fraction, tone) {
    var fill = el("div.kv-bar__fill" + (tone ? ".kv-bar__fill--" + tone : ""), {
      style: { width: util.clamp(fraction, 0, 1) * 100 + "%" }
    });
    var root = el("div.kv-bar", null, fill);
    return {
      el: root,
      set: function (f, t) {
        fill.style.width = util.clamp(f, 0, 1) * 100 + "%";
        fill.className = "kv-bar__fill" + (t ? " kv-bar__fill--" + t : tone ? " kv-bar__fill--" + tone : "");
      }
    };
  };

  /** Вынос главы: список «что запомнить». Поддерживает [[термин]]. */
  ui.takeaway = function (items) {
    return el("div.kv-takeaway", null,
      el("div.kv-takeaway__t", { text: "Что запомнить" }),
      el("ul", null, items.map(function (i) { return el("li", { html: KV.terms(i) }); })));
  };

  /* ---------------- лог-лента (главный компонент) ---------------- */

  var CELL = 34, GAP = 4, STEP = CELL + GAP;

  /**
   * Лента одной партиции: клетки записей, флажки-закладки, метка LEO.
   *
   * Запись: { key?:string, label?:string, color?:string, state?:string, title?:string }
   *   state: 'ok' (по умолчанию) | 'expired' (удалена по retention)
   *          | 'tomb' (tombstone) | 'dropped' (вытеснена compaction)
   *   Если color не задан, берётся из key (util.keyColor).
   *   Если label не задан, берётся первые 3 символа key.
   *
   * Маркер: { at:number (offset), label:string, color?:string }
   *   at может равняться LEO — тогда флажок встаёт в «следующий слот»,
   *   что ровно соответствует смыслу committed offset.
   *
   * @returns {{el, track, push(rec), setRecords(arr), records,
   *            marker(id,opts), removeMarker(id), setLeo(bool),
   *            cell(off), highlight(off,cls,ms), base, setBase(n),
   *            leo(), clear(), scrollEnd()}}
   */
  ui.logStrip = function (opts) {
    opts = opts || {};
    var base = opts.base || 0;
    var records = [];
    var markers = {};
    var track = el("div.kv-strip__track");
    var empty = el("div.kv-strip__empty", { text: opts.empty || "лог пуст" });
    var strip = el("div.kv-strip", null, track, empty);
    var leoEl = null;

    if (opts.showLeo !== false) {
      leoEl = el("div.kv-leo", null, el("span", { text: "LEO 0" }));
      strip.appendChild(leoEl);
    }

    var wrap;
    if (opts.label) {
      wrap = el("div.kv-part", null,
        el("div.kv-part__label", null,
          el("b", { text: opts.label }),
          opts.sub ? el("span", { text: opts.sub }) : null),
        strip);
    } else {
      wrap = strip;
    }

    function cellEl(rec, off) {
      var color = rec.color || (rec.key ? util.keyColor(rec.key) : null);
      var soft = rec.key && !rec.color ? util.keyColorSoft(rec.key) : null;
      var label = rec.label !== undefined ? rec.label : (rec.key ? util.shortKey(rec.key) : "");
      var c = el("div.kv-cell", {
        title: rec.title || (rec.key ? "ключ " + rec.key + " · offset " + off : "offset " + off),
        "aria-label": (rec.key ? "ключ " + rec.key + ", " : "") + "offset " + off
      }, String(label));
      if (color) {
        c.style.borderColor = color;
        c.style.color = color;
        if (soft) c.style.background = soft;
      }
      if (rec.state && rec.state !== "ok") c.classList.add("is-" + rec.state);
      var w = el("div.kv-cellwrap", null, c, el("span.kv-cell__off", { text: String(off) }));
      w._cell = c;
      return w;
    }

    function leo() { return base + records.length; }

    function layoutMarkers() {
      Object.keys(markers).forEach(function (id) {
        var m = markers[id];
        var idx = util.clamp(m.at - base, 0, records.length);
        m.el.style.left = (idx * STEP + CELL / 2) + "px";
      });
      if (leoEl) {
        leoEl.style.left = (records.length * STEP) + "px";
        leoEl.firstChild.textContent = "LEO " + leo();
      }
      empty.classList.toggle("kv-hidden", records.length > 0);
    }

    function render() {
      KV.clear(track);
      records.forEach(function (r, i) { track.appendChild(cellEl(r, base + i)); });
      layoutMarkers();
    }

    var api = {
      el: wrap,
      strip: strip,
      track: track,
      records: records,
      get base() { return base; },

      /** Дописать запись в конец. Возвращает элемент клетки. */
      push: function (rec) {
        rec = rec || {};
        records.push(rec);
        var off = base + records.length - 1;
        var w = cellEl(rec, off);
        w._cell.classList.add("is-new");
        track.appendChild(w);
        layoutMarkers();
        api.scrollEnd();
        return w._cell;
      },

      /** Заменить весь набор записей. */
      setRecords: function (arr) {
        records.length = 0;
        (arr || []).forEach(function (r) { records.push(r); });
        render();
        return api;
      },

      /** Изменить состояние записи по offset ('expired'|'tomb'|'dropped'|'ok'). */
      setState: function (off, state) {
        var i = off - base;
        if (i < 0 || i >= records.length) return;
        records[i].state = state;
        var w = track.children[i];
        if (!w) return;
        var c = w._cell || w.firstChild;
        c.classList.remove("is-expired", "is-tomb", "is-dropped");
        if (state && state !== "ok") c.classList.add("is-" + state);
      },

      /** Поставить/подвинуть флажок-закладку. */
      marker: function (id, o) {
        var m = markers[id];
        if (!m) {
          var pin = el("span.kv-flag__pin");
          var txt = el("span.kv-flag__txt", { text: o.label || id });
          var node = el("span.kv-flag", null, pin, txt);
          m = markers[id] = { el: node, at: o.at || 0 };
          strip.appendChild(node);
        }
        m.at = o.at;
        m.el.style.color = o.color || "var(--read)";
        m.el.querySelector(".kv-flag__txt").textContent = o.label || id;
        m.el.querySelector(".kv-flag__txt").style.color = o.color || "var(--read)";
        layoutMarkers();
        return m.el;
      },

      removeMarker: function (id) {
        if (markers[id]) { markers[id].el.remove(); delete markers[id]; }
      },

      clearMarkers: function () {
        Object.keys(markers).forEach(api.removeMarker);
      },

      /** Элемент клетки по offset (или null). */
      cell: function (off) {
        var w = track.children[off - base];
        return w ? (w._cell || w.firstChild) : null;
      },

      /** Мигнуть клеткой: cls = 'is-hot' (запись) или 'is-reading' (чтение). */
      highlight: function (off, cls, ms) {
        var c = api.cell(off);
        if (!c) return;
        c.classList.add(cls || "is-reading");
        setTimeout(function () { c.classList.remove(cls || "is-reading"); }, ms || 600);
      },

      /** Сдвинуть начало лога (удаление старого по retention). */
      setBase: function (n) { base = n; render(); return api; },

      leo: leo,

      clear: function () { records.length = 0; render(); return api; },

      scrollEnd: function () { strip.scrollLeft = strip.scrollWidth; },

      /** Пересчитать позиции флажков (после смены размеров). */
      refresh: layoutMarkers
    };

    if (opts.records) api.setRecords(opts.records);
    else layoutMarkers();
    return api;
  };

  /** Контейнер для нескольких партиций. */
  ui.log = function () {
    return el("div.kv-log", null, Array.prototype.slice.call(arguments));
  };

  /* ---------------- анимация полёта записи ---------------- */

  /**
   * Пролёт «токена» от одного элемента к другому.
   * @returns Promise, который резолвится по прибытии.
   */
  KV.fly = function (fromEl, toEl, opts) {
    opts = opts || {};
    var reduced = global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fromEl || !toEl || reduced) return Promise.resolve();
    var a = fromEl.getBoundingClientRect(), b = toEl.getBoundingClientRect();
    var color = opts.color || "var(--write)";
    var node = el("div.kv-fly", {
      style: {
        left: (a.left + a.width / 2 - 17) + "px",
        top: (a.top + a.height / 2 - 17) + "px",
        background: opts.soft || "var(--surface)",
        border: "1px solid " + color,
        color: color
      }
    }, opts.label || "");
    document.body.appendChild(node);
    var ms = opts.ms || 420;
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        node.style.transition = "transform " + ms + "ms cubic-bezier(.35,.7,.3,1), opacity " + ms + "ms ease";
        node.style.transform = "translate(" +
          (b.left + b.width / 2 - 17 - (a.left + a.width / 2 - 17)) + "px," +
          (b.top + b.height / 2 - 17 - (a.top + a.height / 2 - 17)) + "px)";
        setTimeout(function () { node.remove(); resolve(); }, ms);
      });
    });
  };

  /* ---------------- жизненный цикл сцены ---------------- */

  /** Создаёт api, передаваемый в build(root, api). Используется app.js. */
  KV.lifecycle = function (go) {
    var timers = [], rafs = [], disposers = [];
    var alive = true;
    return {
      api: {
        reduced: !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches),
        go: go,
        interval: function (ms, fn) { var id = setInterval(fn, ms); timers.push(id); return id; },
        timeout: function (ms, fn) { var id = setTimeout(fn, ms); timers.push(id); return id; },
        stop: function (id) { clearInterval(id); clearTimeout(id); },
        /** Покадровый цикл: fn(dtMs, totalMs). Останавливается вместе с главой.
         *  Возвращает функцию остановки. */
        raf: function (fn) {
          var start = null, last = null, stopped = false;
          var handle = { id: 0 };
          function step(ts) {
            if (stopped || !alive) return;
            if (start === null) { start = ts; last = ts; }
            var dt = ts - last; last = ts;
            fn(dt, ts - start);
            handle.id = requestAnimationFrame(step);
          }
          handle.id = requestAnimationFrame(step);
          rafs.push(handle);
          return function () { stopped = true; cancelAnimationFrame(handle.id); };
        },
        onDestroy: function (fn) { disposers.push(fn); }
      },
      destroy: function () {
        alive = false;
        timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
        rafs.forEach(function (r) { cancelAnimationFrame(r.id); });
        disposers.forEach(function (d) { try { d(); } catch (e) { /* ignore */ } });
        timers = []; rafs = []; disposers = [];
        hideTip();
      }
    };
  };

})(window);
