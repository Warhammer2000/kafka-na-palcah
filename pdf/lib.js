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
  write: rgb(0.780, 0.478, 0.090),
  read: rgb(0.071, 0.514, 0.467),
  good: rgb(0.184, 0.522, 0.318),
  warn: rgb(0.725, 0.424, 0.071),
  bad: rgb(0.753, 0.220, 0.298),
  white: rgb(1, 1, 1),
};

/** Палитра ключей — цвет данных. Индекс = ключ. */
const KEYS = [
  rgb(0.290, 0.435, 0.769), // k0 синий
  rgb(0.722, 0.329, 0.431), // k1 розовый
  rgb(0.243, 0.561, 0.369), // k2 зелёный
  rgb(0.541, 0.357, 0.753), // k3 фиолетовый
  rgb(0.753, 0.475, 0.122), // k4 янтарный
  rgb(0.114, 0.541, 0.620), // k5 бирюзовый
];

const PAGE = { w: 842, h: 595 };
const CELL = 30;
const GAP = 4;
const STEP = CELL + GAP;

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

  doc.setTitle("Kafka на пальцах — живые стенды в PDF");
  doc.setAuthor("kafka-na-palcah");
  doc.setSubject("Интерактивный разбор Apache Kafka внутри PDF-документа");
  doc.setKeywords(["kafka", "pdf", "интерактив", "обучение"]);

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
    GLYPH_MISS.push(where + ": в шрифте нет «" + bad.join(" ") + "» — текст «" +
      String(text).slice(0, 40) + "»");
  }
}

/** Обернуть страницу проверкой глифов. */
function guardPage(ctx, page, where) {
  const draw = page.drawText.bind(page);
  page.drawText = (s, o) => {
    checkGlyphs(ctx, o.font, s, where);
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

  if (opts.eyebrow) {
    page.drawText(opts.eyebrow.toUpperCase(), {
      x: 56, y: PAGE.h - 74, size: 8.5, font: fonts.monoBold, color: C.write,
      characterSpacing: 1.4,
    });
  }
  page.drawText(opts.title, {
    x: 56, y: PAGE.h - 104, size: 22, font: fonts.bold, color: C.ink,
  });
  if (opts.subtitle) {
    wrapText(page, opts.subtitle, {
      x: 56, y: PAGE.h - 126, width: PAGE.w - 260, size: 10.5,
      font: fonts.sans, color: C.muted, leading: 14,
    });
  }

  page.drawText("Ничего не двигается? Открой этот файл в Chrome, Edge или Acrobat Reader — в них PDF умеет исполнять скрипты.", {
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
    b.addToPage(s.caption || "", page, {
      x: box.x, y: box.y, width: box.w, height: box.h,
      font,
      backgroundColor: s.fill,
      borderColor: s.border || s.fill,
      borderWidth: s.borderWidth === undefined ? 1 : s.borderWidth,
      textColor: s.captionColor || C.white,
    });
    fit(b, font, s.size || box.size || 8);
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
    b.addToPage(o.caption ? o.caption(i) : String(i), page, {
      x: x0 + i * STEP + (o.dx || 0), y,
      width: o.w || CELL, height: o.h || 14,
      font: ctx.fonts.mono,
      backgroundColor: o.fill,
      borderColor: o.border || o.fill,
      borderWidth: o.borderWidth === undefined ? 0 : o.borderWidth,
      textColor: o.textColor || C.white,
    });
    fit(b, ctx.fonts.mono, o.size || 7.5);
    if (i !== (o.initial || 0)) hide(ctx, b);
  });
  return { base, count: positions };
}

/** Текстовое поле — единственный способ показать МЕНЯЮЩИЙСЯ текст. */
function readout(ctx, page, name, box, opts) {
  const o = opts || {};
  const f = ctx.form.createTextField(name);
  f.setText(o.text || "");
  if (o.align === "center") f.setAlignment(1);
  if (o.align === "right") f.setAlignment(2);
  const font = o.mono ? ctx.fonts.mono : ctx.fonts.sans;
  f.addToPage(page, {
    x: box.x, y: box.y, width: box.w, height: box.h,
    font,
    backgroundColor: o.fill === null ? undefined : (o.fill || C.surface2),
    borderColor: o.border === null ? undefined : (o.border || C.line),
    borderWidth: o.borderWidth === undefined ? 1 : o.borderWidth,
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
  b.addToPage(caption, page, {
    x: box.x, y: box.y, width: box.w, height: box.h,
    font: ctx.fonts.bold,
    backgroundColor: o.fill || C.surface,
    borderColor: o.border || C.line,
    borderWidth: 1,
    textColor: o.textColor || C.ink,
  });
  fit(b, ctx.fonts.bold, o.size || 9.5);
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
  if (GLYPH_MISS.length) {
    console.log("ПРОПАВШИЕ ГЛИФЫ (" + GLYPH_MISS.length + "):");
    GLYPH_MISS.forEach((m) => console.log("  " + m));
  }
  const bytes = await ctx.doc.save({ updateFieldAppearances: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, bytes);
  return bytes.length;
}

module.exports = {
  fit, guardPage, checkGlyphs, GLYPH_MISS,
  C, KEYS, PAGE, CELL, GAP, STEP,
  createDoc, addStand, wrapText, tag,
  stack, hide, logCell, slider, readout, action,
  RUNTIME, attachScript, save,
};
