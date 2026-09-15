/* Карусель для LinkedIn. Запуск: node build-carousel.js ../dist/kafka-linkedin.pdf

   Здесь НЕТ ни одной кнопки и ни одного поля формы — сознательно.
   LinkedIn превращает загруженный документ в набор картинок, поэтому
   всё интерактивное там всё равно умрёт, а неработающая кнопка выглядит
   поломкой. Вместо интерактива — КАДРЫ: соседние слайды это одно и то же
   состояние с шагом вперёд, так что пролистывание само работает анимацией.

   Формат 1080×1350 (4:5) — вертикаль под телефон, которым листают ленту.
   Ссылка только на последнем слайде: дай её раньше — и листать станет незачем. */

const fs = require("fs");
const path = require("path");
const fontkit = require("@pdf-lib/fontkit");
const { PDFDocument, rgb } = require("pdf-lib");
const L = require("./lib");
const { C, KEYS } = L;

const OUT = process.argv[2] || "../dist/kafka-linkedin.pdf";
const SITE = "warhammer2000.github.io/kafka-na-palcah";

const W = 1080, H = 1350;
const M = 64;                 // поле от края листа
const PAD = 52;               // поле внутри карточки

let doc, F, slideNo = 0;

/* ---------------- каркас слайда ---------------- */

/* Сторож вёрстки. Глазами все десять слайдов не пересмотришь, а вылезший
   за карточку элемент — самый вероятный дефект. Поэтому перехватываем
   отрисовку и считаем границы: дешевле и надёжнее скриншотов. */
const VIOL = [];
function guard(page, no) {
  const L0 = M + PAD - 20, R0 = W - M - PAD + 20;
  const B0 = M + 10, T0 = H - M - 10;
  const rect = page.drawRectangle.bind(page);
  const text = page.drawText.bind(page);

  page.drawRectangle = (o) => {
    const r = o.x + (o.width || 0), t = o.y + (o.height || 0);
    if (o.x < M - 1 || r > W - M + 1 || o.y < B0 || t > T0) {
      VIOL.push(`слайд ${no}: прямоугольник x=${Math.round(o.x)}..${Math.round(r)} y=${Math.round(o.y)}..${Math.round(t)}`);
    }
    return rect(o);
  };
  page.drawText = (s, o) => {
    const w = (o.font || F.sans).widthOfTextAtSize(String(s), o.size || 12);
    if (o.x < L0 || o.x + w > R0 || o.y < B0 || o.y > T0) {
      VIOL.push(`слайд ${no}: текст «${String(s).slice(0, 34)}» x=${Math.round(o.x)}..${Math.round(o.x + w)} y=${Math.round(o.y)}`);
    }
    return text(s, o);
  };
  return page;
}

function slide(opts) {
  slideNo++;
  const raw = doc.addPage([W, H]);
  // фон и карточку рисуем ДО сторожа: они по определению во весь лист
  raw.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C.bg });
  raw.drawRectangle({
    x: M, y: M, width: W - M * 2, height: H - M * 2,
    color: C.surface, borderColor: C.line, borderWidth: 1.5,
  });
  const page = guard(raw, slideNo);

  const x = M + PAD;
  let y = H - M - PAD - 34;

  if (opts.eyebrow) {
    page.drawText(opts.eyebrow.toUpperCase(), {
      x, y, size: 20, font: F.monoBold, color: C.write, characterSpacing: 3,
    });
    y -= 58;
  }

  if (opts.title) {
    const lines = wrap(opts.title, F.bold, 54, W - M * 2 - PAD * 2);
    lines.forEach((l) => {
      page.drawText(l, { x, y, size: 54, font: F.bold, color: C.ink });
      y -= 64;
    });
    y -= 10;
  }

  if (opts.lede) {
    const lines = wrap(opts.lede, F.sans, 26, W - M * 2 - PAD * 2);
    lines.forEach((l) => {
      page.drawText(l, { x, y, size: 26, font: F.sans, color: C.muted });
      y -= 36;
    });
  }

  // номер слайда
  page.drawText(String(slideNo).padStart(2, "0"), {
    x: W - M - PAD - 28, y: M + PAD - 14, size: 20, font: F.mono, color: C.faint,
  });

  return { page, x, top: y - 20 };
}

function wrap(text, font, size, width) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const probe = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(probe, size) > width && line) { lines.push(line); line = w; }
    else line = probe;
  }
  if (line) lines.push(line);
  return lines;
}

/** Подпись-вывод внизу слайда. */
function footnote(page, text, tone) {
  const lines = wrap(text, F.sans, 24, W - M * 2 - PAD * 2 - 10);
  let y = M + PAD + 46 + (lines.length - 1) * 33;
  page.drawRectangle({
    x: M + PAD - 18, y: M + PAD + 22,
    width: 5, height: 33 * lines.length,
    color: tone || C.write,
  });
  lines.forEach((l) => {
    page.drawText(l, { x: M + PAD, y, size: 24, font: F.sans, color: C.ink2 });
    y -= 33;
  });
}

/* ---------------- лента лога ---------------- */

/* Ширина содержимого — 848 пунктов (от 116 до 964). Десять клеток с шагом 84
   занимают ровно 840, поэтому лента помещается впритык и не лезет за карточку. */
const CELL = 76, GAP = 8, STEP = CELL + GAP, NCELL = 10;
const CX = M + PAD;                       // левый край содержимого
const CW = W - (M + PAD) * 2;             // ширина содержимого
const SEQ = [
  { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u42", c: 0 }, { k: "u13", c: 2 },
  { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u91", c: 3 }, { k: "u42", c: 0 },
  { k: "u13", c: 2 }, { k: "u55", c: 4 },
];

/** Одна и та же лента в одних и тех же координатах — чтобы соседние
 *  слайды читались как кадры одного движения. */
function strip(page, top, st) {
  const x0 = CX;
  const y = top - 34 - CELL;   // top — базовая линия подписи над лентой

  page.drawText("ПАРТИЦИЯ 0", { x: x0, y: top, size: 18, font: F.mono, color: C.ink2, characterSpacing: 2 });

  for (let i = 0; i < NCELL; i++) {
    const on = i < st.written;
    const x = x0 + i * STEP;
    page.drawRectangle({
      x, y, width: CELL, height: CELL,
      color: on ? KEYS[SEQ[i].c] : C.surface2,
      borderColor: on ? KEYS[SEQ[i].c] : C.line,
      borderWidth: 1.5,
    });
    if (on) {
      const t = SEQ[i].k;
      page.drawText(t, {
        x: x + (CELL - F.mono.widthOfTextAtSize(t, 22)) / 2,
        y: y + CELL / 2 - 8, size: 22, font: F.mono, color: C.white,
      });
    }
    page.drawText(String(i), {
      x: x + (CELL - F.mono.widthOfTextAtSize(String(i), 18)) / 2,
      y: y - 28, size: 18, font: F.mono, color: C.faint,
    });
  }

  // конец лога: вертикальная черта, подпись прижата внутрь карточки
  if (st.written <= NCELL) {
    const lx = x0 + st.written * STEP - 4;
    page.drawRectangle({ x: lx, y: y - 6, width: 3, height: CELL + 12, color: C.write });
    const cap = "LEO " + st.written;
    const cw = F.mono.widthOfTextAtSize(cap, 18);
    const cxp = Math.min(lx + 10, CX + CW - cw);
    page.drawText(cap, { x: cxp, y: top, size: 18, font: F.mono, color: C.write });
  }

  // закладки: подпись группы идёт СЛЕВА от ленты не помещается,
  // поэтому несём её цветом и буквой в самой метке
  let by = y - 62;
  if (st.posA !== undefined) { bookmark(page, x0, by, st.posA, "A", C.read); by -= 50; }
  if (st.posB !== undefined) { bookmark(page, x0, by, st.posB, "B", KEYS[3]); by -= 50; }

  return by - 10;
}

function bookmark(page, x0, y, pos, letter, color) {
  const x = x0 + pos * STEP;
  page.drawRectangle({ x, y, width: CELL, height: 34, color });
  const t = letter + pos;
  page.drawText(t, {
    x: x + (CELL - F.mono.widthOfTextAtSize(t, 20)) / 2,
    y: y + 9, size: 20, font: F.mono, color: C.white,
  });
  const lbl = "группа " + letter;
  const lw = F.mono.widthOfTextAtSize(lbl, 16);
  page.drawText(lbl, {
    x: Math.min(x + CELL + 14, CX + CW - lw),
    y: y + 9, size: 16, font: F.mono, color,
  });
}

/* ---------------- счётчики ---------------- */

function stats(page, top, items) {
  const w = 268, gap = 20;
  items.forEach((it, i) => {
    const x = M + PAD + i * (w + gap);
    page.drawRectangle({ x, y: top - 92, width: w, height: 92, color: C.surface2, borderColor: C.line, borderWidth: 1 });
    page.drawText(it.label.toUpperCase(), { x: x + 18, y: top - 34, size: 16, font: F.mono, color: C.faint, characterSpacing: 1.5 });
    page.drawText(String(it.value), {
      x: x + 18, y: top - 78, size: 40, font: F.monoBold, color: it.tone || C.ink,
    });
  });
  return top - 120;
}

/* ================= слайды ================= */

async function main() {
  doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const dir = path.join(__dirname, "fonts");
  F = {
    sans: await doc.embedFont(fs.readFileSync(path.join(dir, "PTSans.ttf")), { subset: true }),
    bold: await doc.embedFont(fs.readFileSync(path.join(dir, "PTSans-Bold.ttf")), { subset: true }),
    mono: await doc.embedFont(fs.readFileSync(path.join(dir, "Mono.ttf")), { subset: true }),
    monoBold: await doc.embedFont(fs.readFileSync(path.join(dir, "Mono-Bold.ttf")), { subset: true }),
  };
  doc.setTitle("Kafka на пальцах");
  doc.setSubject("Почему Kafka — не очередь, и что из этого следует");

  /* --- 01 обложка --- */
  {
    const s = slide({
      eyebrow: "разбор для тех, кому не зашло",
      title: "Kafka — это не очередь.",
      lede: "И пока держишь в голове очередь, ничего не сходится: ни перемотка, ни ребалансы, ни потерянные сообщения.",
    });
    strip(s.page, s.top, { written: 10, posA: 6, posB: 3 });
    footnote(s.page, "Десять слайдов, чтобы это наконец щёлкнуло. Листай.", C.write);
  }

  /* --- 02 очередь против лога --- */
  {
    const s = slide({
      eyebrow: "разница в одном",
      title: "Очередь удаляет. Лог оставляет.",
      lede: "В RabbitMQ сообщение доставили и стёрли. В Kafka записали и оставили лежать.",
    });
    const x0 = CX;
    let y = s.top - 40;

    s.page.drawText("ОЧЕРЕДЬ ПОСЛЕ ЧТЕНИЯ", { x: x0, y, size: 18, font: F.mono, color: C.bad, characterSpacing: 2 });
    y -= 100;
    for (let i = 0; i < 6; i++) {
      const gone = i < 3;
      s.page.drawRectangle({
        x: x0 + i * STEP, y, width: CELL, height: CELL,
        color: gone ? C.surface : KEYS[SEQ[i].c],
        borderColor: gone ? C.line : KEYS[SEQ[i].c],
        borderWidth: gone ? 1.5 : 1.5,
        opacity: gone ? 0.25 : 1,
        borderOpacity: gone ? 0.5 : 1,
      });
      if (gone) {
        s.page.drawText("×", { x: x0 + i * STEP + 32, y: y + 28, size: 34, font: F.sans, color: C.bad });
      }
    }
    y -= 90;
    s.page.drawText("ЛОГ ПОСЛЕ ЧТЕНИЯ", { x: x0, y, size: 18, font: F.mono, color: C.good, characterSpacing: 2 });
    y -= 100;
    for (let i = 0; i < 6; i++) {
      s.page.drawRectangle({
        x: x0 + i * STEP, y, width: CELL, height: CELL,
        color: KEYS[SEQ[i].c], borderColor: KEYS[SEQ[i].c], borderWidth: 1.5,
      });
    }
    bookmark(s.page, x0, y - 54, 3, "A", C.read, "прочитал до сюда");

    footnote(s.page, "Читатель двигает только свою закладку. Записи остаются на месте — поэтому их можно перечитать.", C.good);
  }

  /* --- 03-06 кадры: лог наполняется --- */
  const frames = [
    { written: 0, posA: 0, posB: 0, note: "Лог пуст. Обе группы стоят на offset 0 — читать ещё нечего." },
    { written: 4, posA: 2, posB: 1, note: "Продюсер дописал четыре записи. Группы читают в своём темпе и уже разъехались." },
    { written: 9, posA: 6, posB: 3, note: "Отставание видно глазом: у группы B накопилось шесть непрочитанных сообщений." },
  ];
  frames.forEach((f, i) => {
    const s = slide({
      eyebrow: "кадр " + (i + 1) + " из 3",
      title: i === 0 ? "Каждый читатель\nсо своей закладкой" : (i === 1 ? "Продюсер пишет\nв конец" : "Так выглядит lag"),
      lede: i === 2 ? "lag = конец лога минус позиция группы. Главная метрика здоровья: насколько устарели данные прямо сейчас." : "",
    });
    const y = strip(s.page, s.top, f);
    stats(s.page, y, [
      { label: "записей", value: f.written },
      { label: "lag группы A", value: f.written - f.posA, tone: f.written - f.posA > 4 ? C.warn : C.ink },
      { label: "lag группы B", value: f.written - f.posB, tone: f.written - f.posB > 4 ? C.bad : C.ink },
    ]);
    footnote(s.page, f.note, i === 2 ? C.bad : C.write);
  });

  /* --- 07 перемотка --- */
  {
    const s = slide({
      eyebrow: "чего очередь не умеет",
      title: "Закладку можно\nперемотать назад",
      lede: "Записи никуда не делись, поэтому историю читают заново — это и называется replay.",
    });
    strip(s.page, s.top, { written: 9, posA: 0, posB: 3 });
    footnote(s.page, "Новый сервис подключается к работающему топику и вычитывает всё, что было до него. В очереди такой кнопки не существует.", C.read);
  }

  /* --- 08 ключ решает партицию --- */
  {
    const s = slide({
      eyebrow: "закон kafka",
      title: "Ключ решает,\nкуда ляжет запись",
      lede: "номер партиции = hash(ключ) % количество партиций",
    });
    const x0 = CX;
    const c = 64, st = c + 8;
    let y = s.top - 60;
    const rows = [
      [0, 0, 4, 0, 4],
      [1, 5, 1, 1],
      [2, 2, 3, 2],
    ];
    rows.forEach((row) => {
      const p = row[0];
      s.page.drawText("партиция " + p, { x: x0, y: y + 22, size: 18, font: F.mono, color: C.ink2 });
      for (let i = 1; i < row.length; i++) {
        s.page.drawRectangle({
          x: x0 + 150 + (i - 1) * st, y, width: c, height: c,
          color: KEYS[row[i]], borderColor: KEYS[row[i]], borderWidth: 1.5,
        });
      }
      y -= 100;
    });
    y -= 10;
    s.page.drawText("одинаковый ключ  →  одна партиция  →  порядок", {
      x: x0, y, size: 24, font: F.monoBold, color: C.ink,
    });
    footnote(s.page, "Порядок гарантирован только внутри партиции. Между партициями порядка нет вообще — ни общего счётчика, ни общего времени.", C.write);
  }

  /* --- 09 перекос ключа --- */
  {
    const s = slide({
      eyebrow: "как это ломается",
      title: "Плохой ключ —\nи одна партиция горит",
      lede: "Если девять из десяти событий идут с одним ключом, они лягут в одну партицию. Она перегружена, соседние простаивают.",
    });
    const x0 = CX;
    const c = 64, st = c + 8;
    let y = s.top - 70;
    const load = [8, 1, 1];
    load.forEach((n, p) => {
      s.page.drawText("партиция " + p, { x: x0, y: y + 22, size: 18, font: F.mono, color: C.ink2 });
      for (let i = 0; i < 8; i++) {
        const on = i < n;
        s.page.drawRectangle({
          x: x0 + 150 + i * st, y, width: c, height: c,
          color: on ? (p === 0 ? C.bad : KEYS[2]) : C.surface2,
          borderColor: on ? (p === 0 ? C.bad : KEYS[2]) : C.line, borderWidth: 1.5,
        });
      }
      s.page.drawText(p === 0 ? "перегружена" : "простаивает", {
        x: x0 + 150 + 8 * st + 16, y: y + 22, size: 18, font: F.mono,
        color: p === 0 ? C.bad : C.faint,
      });
      y -= 100;
    });
    footnote(s.page, "Добавить потребителей не поможет: одну партицию в группе читает ровно один из них. Потолок задан числом партиций.", C.bad);
  }

  /* --- 10 acks --- */
  {
    const s = slide({
      eyebrow: "самая дорогая ловушка",
      title: "acks=all\nне значит «все»",
      lede: "Он ждёт подтверждения всех реплик ИЗ ISR — списка тех, кто успевает за лидером. А список умеет схлопываться.",
    });
    const x0 = CX;
    let y = s.top - 70;

    const box = (label, isr, verdict, tone) => {
      s.page.drawRectangle({ x: x0, y: y - 148, width: W - M * 2 - PAD * 2 - 16, height: 148, color: C.surface2, borderColor: C.line, borderWidth: 1 });
      s.page.drawRectangle({ x: x0, y: y - 148, width: 6, height: 148, color: tone });
      s.page.drawText(label, { x: x0 + 28, y: y - 44, size: 24, font: F.bold, color: C.ink });
      s.page.drawText(isr, { x: x0 + 28, y: y - 84, size: 22, font: F.mono, color: C.muted });
      s.page.drawText(verdict, { x: x0 + 28, y: y - 124, size: 22, font: F.monoBold, color: tone });
      y -= 172;
    };

    box("Реплики успевают", "ISR = [1, 2, 3]  ·  acks=all ждёт троих", "ДАННЫЕ ЦЕЛЫ", C.good);
    box("Реплики отстали и выпали", "ISR = [1]  ·  acks=all ждёт ОДНОГО", "ТИХАЯ ПОТЕРЯ ПРИ ПАДЕНИИ ЛИДЕРА", C.bad);
    box("min.insync.replicas = 2", "ISR = [1]  ·  запись не принимается", "ЯВНАЯ ОШИБКА — И ЭТО ХОРОШО", C.write);

    footnote(s.page, "Надёжная тройка, которую помнят как одно целое: replication.factor 3, acks=all, min.insync.replicas 2.", C.write);
  }

  /* --- 11 финал со ссылкой --- */
  {
    const s = slide({
      eyebrow: "а теперь самое странное",
      title: "Всё это —\nживое. В PDF.",
      lede: "Слайды выше — кадры настоящих стендов. В PDF нет ни HTML, ни CSS, но есть поля форм и собственный JavaScript: клетки лога это кнопки, движение — таймер, подписи — текстовые поля.",
    });
    const x0 = M + PAD;
    let y = s.top - 40;

    s.page.drawRectangle({
      x: x0, y: y - 120, width: W - M * 2 - PAD * 2, height: 120,
      color: C.surface2, borderColor: C.write, borderWidth: 3,
    });
    s.page.drawText("Пятнадцать интерактивных глав:", { x: x0 + 32, y: y - 48, size: 24, font: F.sans, color: C.muted });
    s.page.drawText(SITE, { x: x0 + 32, y: y - 94, size: 28, font: F.monoBold, color: C.write });

    y -= 170;
    s.page.drawText("Работает в браузере, в том числе на телефоне.", { x: x0, y, size: 24, font: F.sans, color: C.ink2 });
    y -= 40;
    s.page.drawText("Версию с живыми стендами внутри PDF ищи по ссылке в тексте поста —", { x: x0, y, size: 22, font: F.sans, color: C.faint });
    y -= 32;
    s.page.drawText("её нужно скачать и открыть на компьютере, в Chrome, Edge или Acrobat.", { x: x0, y, size: 22, font: F.sans, color: C.faint });

    footnote(s.page, "Здесь, в ленте, всё это статично: LinkedIn превращает любой документ в картинки. Так что кнопок тут нет — они ждут в файле.", C.read);
  }

  const bytes = await doc.save();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, bytes);
  console.log("карусель собрана: " + OUT + " — " + Math.round(bytes.length / 1024) + " КБ, слайдов: " + slideNo);
  if (VIOL.length) {
    console.log("ВЁРСТКА ВЫЛЕЗАЕТ ЗА КАРТОЧКУ (" + VIOL.length + "):");
    VIOL.forEach((v) => console.log("  " + v));
  } else {
    console.log("вёрстка: всё внутри карточки");
  }
}

main().catch((e) => { console.error("СБОРКА УПАЛА: " + e.message); process.exit(1); });
