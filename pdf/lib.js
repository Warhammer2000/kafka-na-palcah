/* ============================================================
   lib.js — ядро сборщика «Kafka в PDF».

   В PDF нет ни HTML, ни CSS. Всё, что здесь есть, — это поля
   формы (AcroForm) и документный JavaScript. Отсюда два правила,
   на которых держится вся конструкция:

   1. ЦВЕТ НЕЛЬЗЯ ПОМЕНЯТЬ НА ЛЕТУ. PDFium игнорирует fillColor.
      Поэтому в каждой точке лежит СТОПКА заранее окрашенных
      виджетов, а скрипт показывает нужный через display.
   2. ТЕКСТ МЕНЯТЬ МОЖНО — значение текстового поля обновляется
      вживую, кириллица работает при встроенном шрифте.

   Проверено в Chrome/Edge (PDFium) и Acrobat.
   ============================================================ */

const fs = require("fs");
const path = require("path");
const fontkit = require("@pdf-lib/fontkit");
const { PDFDocument, rgb, PDFName, PDFString } = require("pdf-lib");

/* ---------------- палитра (та же, что на странице) ---------------- */

const C = {
  bg: rgb(0.945, 0.957, 0.973),
  surface: rgb(1, 1, 1),
  surface2: rgb(0.953, 0.965, 0.980),
  ink: rgb(0.075, 0.102, 0.137),
  ink2: rgb(0.208, 0.255, 0.310),
  muted: rgb(0.357, 0.416, 0.486),
  faint: rgb(0.549, 0.600, 0.659),
  line: rgb(0.808, 0.843, 0.890),
  write: rgb(0.600, 0.369, 0.071),
  read: rgb(0.063, 0.463, 0.420),
  good: rgb(0.165, 0.463, 0.282),
  warn: rgb(0.596, 0.349, 0.059),
  bad: rgb(0.722, 0.212, 0.286),
  white: rgb(1, 1, 1),
};

/** Палитра ключей — цвет данных. Индекс = ключ. */
const KEYS = [
  rgb(0.239, 0.392, 0.737), // k0 синий
  rgb(0.659, 0.275, 0.373), // k1 розовый
  rgb(0.200, 0.463, 0.306), // k2 зелёный
  rgb(0.498, 0.298, 0.729), // k3 фиолетовый
  rgb(0.580, 0.365, 0.094), // k4 янтарный
  rgb(0.094, 0.451, 0.518), // k5 бирюзовый
];

const PAGE = { w: 842, h: 595 };
const CELL = 30;
const GAP = 4;
const STEP = CELL + GAP;

/* ---------------- язык документа ----------------
   Документ собирается на ОДНОМ языке. Публикуется английский — его читают
   в ленте; русский собирается тем же сборщиком и теми же стендами, чтобы
   исходный разбор не остался только в истории git.
   Двух языков внутри одного файла нет сознательно: PDF читают линейно, и
   вторая колонка на чужом языке там только мешает.
     node build.js ../dist/kafka-v-pdf.pdf          — английский (по умолчанию)
     node build.js ../dist/kafka-v-pdf-ru.pdf ru    — русский */

let LANG = String(process.env.KAFKA_LANG || "en").toLowerCase() === "ru" ? "ru" : "en";

/** Переключить язык сборки. Вызывается ДО createDoc: метаданные документа
 *  пишутся там же. */
function setLang(l) { LANG = String(l).toLowerCase() === "ru" ? "ru" : "en"; }
function lang() { return LANG; }

/** Строка на языке сборки. Имя T, а не L: L в сборщиках занято самим lib. */
function T(ru, en) { return LANG === "ru" ? ru : (en === undefined ? ru : en); }

/** Значение, записанное парой ["ru","en"]; строку отдаёт как есть.
 *  Нужна там, где текст объявлен НА УРОВНЕ МОДУЛЯ: стенды подключаются
 *  раньше, чем разобраны аргументы командной строки, и T() в их заголовках
 *  застыл бы на языке по умолчанию. Пара разбирается в момент отрисовки. */
function pick(v) { return Array.isArray(v) ? T(v[0], v[1]) : v; }

/** Снять язык из аргументов командной строки: «... out.pdf ru». */
function langFromArgv(argv) {
  const a = (argv || process.argv).slice(2).find((v) => v === "ru" || v === "en");
  if (a) setLang(a);
  return LANG;
}

/* ---------------- документ ---------------- */

async function createDoc() {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);

  // ШРИФТЫ ВСТРАИВАЮТСЯ ЦЕЛИКОМ, без subset. Подмножество собирается по
  // тексту, известному во время сборки, а половину строк здесь подставляет
  // JavaScript уже в просмотрщике: «ёлочки», тире и любая буква, не попавшая
  // в статику, отрисовались бы пустотой. Цена — около мегабайта на файл.
  const dir = path.join(__dirname, "fonts");
  const fonts = {
    sans: await doc.embedFont(fs.readFileSync(path.join(dir, "PTSans.ttf")), { subset: false }),
    bold: await doc.embedFont(fs.readFileSync(path.join(dir, "PTSans-Bold.ttf")), { subset: false }),
    mono: await doc.embedFont(fs.readFileSync(path.join(dir, "Mono.ttf")), { subset: false }),
    monoBold: await doc.embedFont(fs.readFileSync(path.join(dir, "Mono-Bold.ttf")), { subset: false }),
  };

  doc.setTitle(T("Kafka на пальцах — живые стенды в PDF",
    "Kafka hands-on — live demos inside a PDF"));
  doc.setAuthor("kafka-na-palcah");
  doc.setSubject(T("Интерактивный разбор Apache Kafka внутри PDF-документа",
    "An interactive walkthrough of Apache Kafka inside a PDF document"));
  doc.setKeywords(T(["kafka", "pdf", "интерактив", "обучение"],
    ["kafka", "pdf", "interactive", "learning"]));
  doc.setLanguage(T("ru-RU", "en-US"));

  const fk = {
    sans: fontkit.create(fs.readFileSync(path.join(dir, "PTSans.ttf"))),
    bold: fontkit.create(fs.readFileSync(path.join(dir, "PTSans-Bold.ttf"))),
    mono: fontkit.create(fs.readFileSync(path.join(dir, "Mono.ttf"))),
    monoBold: fontkit.create(fs.readFileSync(path.join(dir, "Mono-Bold.ttf"))),
  };

  return { doc, form: doc.getForm(), fonts, fk };
}

/* ---------------- сторож глифов ----------------
   Шрифт молча рисует пустоту вместо символа, которого в нём нет, —
   ни ошибки при сборке, ни следа в файле. Живой пример: в PT Sans
   НЕТ стрелки «→», она есть только в моноширинном. Поэтому каждую
   строку проверяем по таблице символов того шрифта, которым её рисуют. */

const GLYPH_MISS = [];

function coverage(ctx, font) {
  for (const name of Object.keys(ctx.fonts)) {
    if (ctx.fonts[name] === font) return ctx.fk[name];
  }
  return null;
}

function checkGlyphs(ctx, font, text, where) {
  const fk = coverage(ctx, font);
  if (!fk) return;
  const bad = [];
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (cp === 10 || cp === 13 || cp === 32) continue;
    if (!fk.hasGlyphForCodePoint(cp) && bad.indexOf(ch) < 0) bad.push(ch);
  }
  if (bad.length) {
    // одна метка — это N одинаковых виджетов, жаловаться N раз незачем
    const msg = where + ": в шрифте нет «" + bad.join(" ") + "» — текст «" +
      String(text).slice(0, 40) + "»";
    if (GLYPH_MISS.indexOf(msg) < 0) GLYPH_MISS.push(msg);
  }
}

/** Подпись виджета (кнопки, метки, стопки) сторож глифов сам не видит:
 *  она идёт не через page.drawText, а через addToPage. А пустой глиф в
 *  подписи — самый незаметный дефект: метка просто окажется пустой. */
function checkCaption(ctx, font, text, where) {
  if (text === undefined || text === null || text === "") return;
  checkGlyphs(ctx, font, text, where);
}

/* ---------------- сторож перекрытий ----------------
   Виджет формы рисуется ПОВЕРХ содержимого страницы, и, если у него есть
   заливка, он закрывает собой всё, что под ним. Подпись, поставленную
   вплотную к ленте, так и съедает метка в своей крайней позиции — причём
   видно это только тогда, когда стенд до этой позиции дойдёт. Глазами такое
   не ловится (виджет прячется, пока не придёт его черёд), поэтому считаем
   прямоугольники: ВСЕ позиции метки, включая скрытые на старте. */

const OVERLAP = [];
const BOUNDS = [];   // подписи, вылезшие за поле страницы
const BOXES = [];    // непрозрачные виджеты
const LABELS = [];   // подписи, нарисованные на самой странице
let pageSeq = 0;

function pageId(page) {
  if (!page.__kvId) page.__kvId = ++pageSeq;
  return page.__kvId;
}

/** Запомнить непрозрачный виджет. */
function noteBox(page, box, fill) {
  if (!fill) return;
  BOXES.push({ p: pageId(page), x: box.x, y: box.y, w: box.w, h: box.h });
}

function noteLabel(ctx, page, text, o, where) {
  const size = o.size || 12;
  const font = o.font || ctx.fonts.sans;
  const s = String(text);
  const w = font.widthOfTextAtSize(s, size) + (o.characterSpacing || 0) * s.length;
  LABELS.push({
    p: pageId(page), where, text: s,
    x: o.x, y: o.y - size * 0.22, w, h: size * 0.94,
  });
  /* Подпись, вылезшая за карточку, — самый вероятный дефект при смене языка:
     координата у строки своя, а длина чужая. Заголовок, набранный по-русски
     впритык, по-английски молча уезжает под обрез. */
  if (o.x < 40 || o.x + w > PAGE.w - 40 || o.y < 34 || o.y > PAGE.h - 40) {
    BOUNDS.push(where + ": «" + s.slice(0, 34) + "» x " + Math.round(o.x) + ".." +
      Math.round(o.x + w) + ", y " + Math.round(o.y) + " — за полем страницы");
  }
}

function checkOverlaps() {
  LABELS.forEach((l) => {
    for (const b of BOXES) {
      if (b.p !== l.p) continue;
      if (l.x + l.w <= b.x || b.x + b.w <= l.x) continue;
      if (l.y + l.h <= b.y || b.y + b.h <= l.y) continue;
      OVERLAP.push(l.where + ": подпись «" + l.text.slice(0, 28) +
        "» (x " + Math.round(l.x) + ".." + Math.round(l.x + l.w) +
        ", y " + Math.round(l.y) + ") закрыта виджетом x " +
        Math.round(b.x) + ".." + Math.round(b.x + b.w) + ", y " +
        Math.round(b.y) + ".." + Math.round(b.y + b.h));
      return;   // одной жалобы на подпись достаточно: позиций у метки много
    }
  });
}

/** Обернуть страницу проверкой глифов и учётом подписей. */
function guardPage(ctx, page, where) {
  const draw = page.drawText.bind(page);
  page.drawText = (s, o) => {
    checkGlyphs(ctx, o.font, s, where);
    noteLabel(ctx, page, s, o, where);
    return draw(s, o);
  };
  return page;
}

/** Новая страница-стенд с заголовком и подвалом. */
function addStand(ctx, opts) {
  const { doc, fonts } = ctx;
  const page = guardPage(ctx, doc.addPage([PAGE.w, PAGE.h]), "стенд " + (opts.id || opts.title));

  page.drawRectangle({ x: 0, y: 0, width: PAGE.w, height: PAGE.h, color: C.bg });
  page.drawRectangle({
    x: 28, y: 28, width: PAGE.w - 56, height: PAGE.h - 56,
    color: C.surface, borderColor: C.line, borderWidth: 1,
  });

  /* Заголовки стенда объявлены парой ["ru","en"] — разбираем здесь, а не
     при подключении модуля: язык становится известен позже. */
  const eyebrow = pick(opts.eyebrow);
  const title = pick(opts.title);
  const subtitle = pick(opts.subtitle);

  if (eyebrow) {
    page.drawText(eyebrow.toUpperCase(), {
      x: 56, y: PAGE.h - 74, size: 8.5, font: fonts.monoBold, color: C.write,
      characterSpacing: 1.4,
    });
  }
  page.drawText(title, {
    x: 56, y: PAGE.h - 104, size: 22, font: fonts.bold, color: C.ink,
  });
  if (subtitle) {
    wrapText(page, subtitle, {
      x: 56, y: PAGE.h - 126, width: PAGE.w - 260, size: 10.5,
      font: fonts.sans, color: C.muted, leading: 14,
    });
  }

  page.drawText(T(
    "Ничего не двигается? Открой этот файл в Chrome, Edge или Acrobat Reader — в них PDF умеет исполнять скрипты.",
    "Nothing moving? Open this file in Chrome, Edge or Acrobat Reader — those run the scripts a PDF carries."
  ), {
    x: 56, y: 44, size: 7.5, font: fonts.sans, color: C.faint,
  });

  return page;
}

/** Простой перенос строк по ширине. Возвращает y последней строки. */
function wrapText(page, text, o) {
  const words = String(text).split(/\s+/);
  let line = "";
  let y = o.y;
  const lines = [];
  for (const w of words) {
    const probe = line ? line + " " + w : w;
    if (o.font.widthOfTextAtSize(probe, o.size) > o.width && line) {
      lines.push(line);
      line = w;
    } else {
      line = probe;
    }
  }
  if (line) lines.push(line);
  for (const l of lines) {
    page.drawText(l, { x: o.x, y, size: o.size, font: o.font, color: o.color });
    y -= o.leading || o.size * 1.4;
  }
  return y;
}

/* ---------------- примитивы интерфейса ---------------- */

/** Ссылка-аннотация поверх области страницы.
 *  Нарисованный адрес читатель на компьютере иначе перенабирает руками —
 *  а весь смысл финальной страницы в том, чтобы он дошёл до сайта.
 *  Рамку не рисуем: подложку и текст уже нарисовала сама страница. */
function link(ctx, page, box, url) {
  const annot = ctx.doc.context.register(ctx.doc.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: [box.x, box.y, box.x + box.w, box.y + box.h],
    Border: [0, 0, 0],
    F: 4,                                   // Print — иначе ссылки нет на печати
    A: ctx.doc.context.obj({
      Type: PDFName.of("Action"),
      S: PDFName.of("URI"),
      URI: PDFString.of(url),
    }),
  }));
  const key = PDFName.of("Annots");
  const existing = page.node.Annots();
  if (existing) existing.push(annot);
  else page.node.set(key, ctx.doc.context.obj([annot]));
  return annot;
}

/** Мелкая моноширинная подпись-ярлык. */
function tag(page, fonts, text, x, y, color) {
  page.drawText(String(text).toUpperCase(), {
    x, y, size: 7.5, font: fonts.mono, color: color || C.faint, characterSpacing: 1.1,
  });
}

/**
 * СТОПКА состояний в одной точке. Показывается ровно одно — через display.
 * states: [{ fill, border, caption, captionColor }]
 * Возвращает базовое имя; в скрипте переключать через show(base, idx, count).
 */
function stack(ctx, page, base, states, box) {
  const { form, fonts } = ctx;
  states.forEach((s, k) => {
    const b = form.createButton(base + "_" + k);
    const font = s.mono ? fonts.mono : fonts.sans;
    checkCaption(ctx, font, s.caption, "стопка «" + base + "»");
    b.addToPage(s.caption || "", page, {
      x: box.x, y: box.y, width: box.w, height: box.h,
      font,
      backgroundColor: s.fill,
      borderColor: s.border || s.fill,
      borderWidth: s.borderWidth === undefined ? 1 : s.borderWidth,
      textColor: s.captionColor || C.white,
    });
    fit(b, font, s.size || box.size || 8);
    noteBox(page, box, s.fill);
    if (k !== (box.initial || 0)) hide(ctx, b);
  });
  return { base, count: states.length };
}

/** Кегль подписи кнопки задаётся только ПОСЛЕ размещения — иначе нет /DA
 *  и просмотрщик растягивает надпись на всю кнопку, обрезая её. */
function fit(field, font, size) {
  field.setFontSize(size);
  field.updateAppearances(font);
}

function hide(ctx, field) {
  const w = field.acroField.getWidgets()[0];
  w.dict.set(PDFName.of("F"), ctx.doc.context.obj(2)); // бит 2 — Hidden
}

/** Клетка лога: пустая (бледная) либо окрашенная в цвет ключа. */
function logCell(ctx, page, base, x, y, keyIdx, caption) {
  return stack(ctx, page, base, [
    { fill: C.surface2, border: C.line, caption: "", captionColor: C.muted },
    { fill: KEYS[keyIdx % KEYS.length], border: KEYS[keyIdx % KEYS.length], caption: caption || "", captionColor: C.white, mono: true },
  ], { x, y, w: CELL, h: CELL, initial: 0 });
}

/** Подвижная метка над/под лентой: по виджету на каждую позицию. */
function slider(ctx, page, base, positions, x0, y, opts) {
  const states = [];
  for (let i = 0; i < positions; i++) states.push(i);
  const o = opts || {};
  states.forEach((i) => {
    const b = ctx.form.createButton(base + "_" + i);
    const cap = o.caption ? o.caption(i) : String(i);
    checkCaption(ctx, ctx.fonts.mono, cap, "метка «" + base + "»");
    b.addToPage(cap, page, {
      x: x0 + i * STEP + (o.dx || 0), y,
      width: o.w || CELL, height: o.h || 14,
      font: ctx.fonts.mono,
      backgroundColor: o.fill,
      borderColor: o.border || o.fill,
      borderWidth: o.borderWidth === undefined ? 0 : o.borderWidth,
      textColor: o.textColor || C.white,
    });
    fit(b, ctx.fonts.mono, o.size || 7.5);
    noteBox(page, { x: x0 + i * STEP + (o.dx || 0), y, w: o.w || CELL, h: o.h || 14 }, o.fill);
    if (i !== (o.initial || 0)) hide(ctx, b);
  });
  return { base, count: positions };
}

/** Текстовое поле — единственный способ показать МЕНЯЮЩИЙСЯ текст.
 *  ВАЖНО: однострочное поле обрезает длинную строку на правом краю молча —
 *  ни переноса, ни многоточия, ни следа в файле. Для пояснений, которые
 *  собираются из чисел на лету и заранее не измеряются, ставь multiline. */
function readout(ctx, page, name, box, opts) {
  const o = opts || {};
  const f = ctx.form.createTextField(name);
  f.setText(o.text || "");
  checkCaption(ctx, o.mono ? ctx.fonts.mono : ctx.fonts.sans, o.text, "поле «" + name + "»");
  if (o.align === "center") f.setAlignment(1);
  if (o.align === "right") f.setAlignment(2);
  if (o.multiline) f.enableMultiline();
  const font = o.mono ? ctx.fonts.mono : ctx.fonts.sans;
  noteBox(page, box, o.fill === null ? undefined : (o.fill || C.surface2));
  f.addToPage(page, {
    x: box.x, y: box.y, width: box.w, height: box.h,
    font,
    backgroundColor: o.fill === null ? undefined : (o.fill || C.surface2),
    borderColor: o.border === null ? undefined : (o.border || C.line),
    borderWidth: o.borderWidth === undefined ? 1 : o.borderWidth,
    textColor: o.textColor,
  });
  // /DA появляется только после размещения — размер шрифта ставим здесь,
  // иначе просмотрщик растянет текст на всю высоту поля.
  f.setFontSize(o.size || 10);
  f.updateAppearances(font);
  f.enableReadOnly();
  if (!ctx.fieldFont) ctx.fieldFont = {};
  ctx.fieldFont[name] = font;
  return f;
}

/** Кнопка, запускающая функцию документного скрипта. */
function action(ctx, page, name, caption, box, js, opts) {
  const o = opts || {};
  const b = ctx.form.createButton(name);
  checkCaption(ctx, ctx.fonts.bold, caption, "кнопка «" + name + "»");
  b.addToPage(caption, page, {
    x: box.x, y: box.y, width: box.w, height: box.h,
    font: ctx.fonts.bold,
    backgroundColor: o.fill || C.surface,
    borderColor: o.border || C.line,
    borderWidth: 1,
    textColor: o.textColor || C.ink,
  });
  fit(b, ctx.fonts.bold, o.size || 9.5);
  noteBox(page, box, o.fill || C.surface);
  const w = b.acroField.getWidgets()[0];
  w.dict.set(
    PDFName.of("A"),
    ctx.doc.context.obj({ S: PDFName.of("JavaScript"), JS: PDFString.of(js) })
  );
  return b;
}

/* ---------------- runtime для документного скрипта ---------------- */

const RUNTIME = `
var doc = this;

function F(n) { try { return doc.getField(n); } catch (e) { return null; } }

/** Показать ровно одно состояние стопки. idx = -1 прячет все. */
function show(base, idx, count) {
  for (var k = 0; k < count; k++) {
    var f = F(base + "_" + k);
    if (f) f.display = (k === idx) ? display.visible : display.hidden;
  }
}

/** Подвинуть метку: показать виджет нужной позиции. */
function moveTo(base, pos, count) {
  for (var i = 0; i < count; i++) {
    var f = F(base + "_" + i);
    if (f) f.display = (i === pos) ? display.visible : display.hidden;
  }
}

function txt(name, s) { var f = F(name); if (f) f.value = String(s); }

/** Один таймер на весь документ: каждый стенд кладёт сюда свою функцию.
 *  Несколько app.setInterval на документ работают нестабильно. */
var TICKERS = [];
function kvTick() {
  for (var i = 0; i < TICKERS.length; i++) {
    try { TICKERS[i](); } catch (e) { }
  }
}

/** Возврат app.setInterval ОБЯЗАН лежать в долгоживущей переменной.
 *  Acrobat считает объект интервала мусором, если на него никто не ссылается,
 *  и собирает его вместе с таймером: анимация молча встаёт через минуту-другую,
 *  а в PDFium (Chrome/Edge) этого не видно — там таймер держит сам движок.
 *  Отсюда KV_TIMER: одна ссылка на весь документ, и повторный запуск запрещён. */
var KV_TIMER = null;
function kvStart(ms) {
  if (KV_TIMER) return;
  KV_TIMER = app.setInterval("kvTick()", ms);
}
`;

/** Собрать и записать документный скрипт.
 *  Заодно проверяем строки, которые скрипт кладёт в поля: они появятся
 *  уже у читателя, и символа, которого нет в шрифте ЭТОГО поля, никто
 *  не заметит — поле просто нарисует пустоту. */
function attachScript(ctx, name, body) {
  const src = String(body);
  const re = /txt\(\s*"([A-Za-z0-9_]+)"\s*,([\s\S]*?)\);/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const font = ctx.fieldFont && ctx.fieldFont[m[1]];
    if (!font) continue;
    const literals = m[2].match(/"(?:[^"\\]|\\.)*"/g) || [];
    literals.forEach((lit) => {
      checkGlyphs(ctx, font, lit.slice(1, -1), 'скрипт, поле "' + m[1] + '"');
    });
  }
  ctx.doc.addJavaScript(name, RUNTIME + "\n" + body);
}

async function save(ctx, out) {
  // NeedAppearances=true заставляет просмотрщик ПЕРЕРИСОВАТЬ все поля своими
  // силами — и он делает это грубо, растягивая подписи кнопок и обрезая их.
  // Свои внешние виды у нас уже собраны правильным шрифтом, поэтому флаг снят.
  ctx.form.acroForm.dict.set(PDFName.of("NeedAppearances"), ctx.doc.context.obj(false));
  // Свой внешний вид каждому полю уже задан через fit() нужным шрифтом.
  // Автоматический проход pdf-lib пересобрал бы их стандартным Helvetica,
  // в котором нет кириллицы, — и сборка падает на первой же букве.
  checkOverlaps();
  if (OVERLAP.length) {
    console.log("ПОДПИСИ ПОД ВИДЖЕТАМИ (" + OVERLAP.length + "):");
    OVERLAP.forEach((m) => console.log("  " + m));
  }
  if (GLYPH_MISS.length) {
    console.log("ПРОПАВШИЕ ГЛИФЫ (" + GLYPH_MISS.length + "):");
    GLYPH_MISS.forEach((m) => console.log("  " + m));
  }
  if (BOUNDS.length) {
    console.log("ПОДПИСИ ЗА ПОЛЕМ (" + BOUNDS.length + "):");
    BOUNDS.forEach((m) => console.log("  " + m));
  }
  const bytes = await ctx.doc.save({ updateFieldAppearances: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  return bytes.length;
}

module.exports = {
  fit, guardPage, checkGlyphs, GLYPH_MISS, checkOverlaps, OVERLAP, BOUNDS,
  C, KEYS, PAGE, CELL, GAP, STEP,
  T, pick, setLang, lang, langFromArgv,
  createDoc, addStand, wrapText, tag, link,
  stack, hide, logCell, slider, readout, action,
  RUNTIME, attachScript, save,
};
