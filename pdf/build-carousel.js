/* Карусель для LinkedIn. Запуск: node build-carousel.js ../dist/kafka-linkedin.pdf
   Язык третьим аргументом: «... kafka-linkedin-ru.pdf ru». По умолчанию английский —
   карусель уходит в ленту, а русская сборка живёт тем же кодом и теми же кадрами.

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
L.langFromArgv();
const { C, KEYS, T } = L;

const OUT = process.argv[2] || "../dist/kafka-linkedin.pdf";
const SITE = "warhammer2000.github.io/kafka-na-palcah";

/* Адрес самого документа — того, ради чего карусель и затевалась. В ленте она
   превращается в картинки, поэтому адрес читатель перенабирает руками: значит он
   обязан быть читаемым, а не случайным идентификатором с файлопомойки. Оба
   документа лежат на Pages рядом с сайтом, поэтому домен здесь тот же, что в
   SITE, — и берётся из него, чтобы не разъехался при переезде.
   В одну строку адрес всё равно не влезает, поэтому разбит на две моноширинные,
   а поверх карточки лежит аннотация-ссылка: в ленте она бесполезна, но карусель
   ещё и скачивают — там по ней кликают.
   Язык у каждой сборки свой: русскую карусель незачем уводить в английский
   документ. T() на уровне модуля здесь безопасен — langFromArgv отработал выше.
   Ссылка ВЫВОДИТСЯ из нарисованных строк, а не пишется рядом второй константой:
   иначе карточка однажды напечатает один адрес, а аннотация уведёт на другой, и
   в ленте, где кликать нечего, читатель уйдёт в никуда. Так расходиться нечему. */
const DOC_TEXT = [SITE + "/", T("documents/kafka-na-palcah-ru.pdf",
                                "documents/kafka-hands-on-en.pdf")];
const DOC_URL = "https://" + DOC_TEXT.join("");

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
  /* Подписи, наехавшие друг на друга. Сторож границ этого не видит: обе
     строки внутри карточки, просто в одной точке. Живой пример — «LEO 0»
     поверх «ПАРТИЦИЯ 0» на кадре с пустой лентой; глазами это ловится только
     если пересмотреть все десять слайдов, а их пересматривают не всегда. */
  const drawn = [];
  page.drawText = (s, o) => {
    const str = String(s);
    const size = o.size || 12;
    const w = (o.font || F.sans).widthOfTextAtSize(str, size) + (o.characterSpacing || 0) * str.length;
    if (o.x < L0 || o.x + w > R0 || o.y < B0 || o.y > T0) {
      VIOL.push(`слайд ${no}: текст «${str.slice(0, 34)}» x=${Math.round(o.x)}..${Math.round(o.x + w)} y=${Math.round(o.y)}`);
    }
    const box = { x: o.x, y: o.y - size * 0.22, w, h: size * 0.94, s: str };
    for (const b of drawn) {
      if (box.x + box.w <= b.x || b.x + b.w <= box.x) continue;
      if (box.y + box.h <= b.y || b.y + b.h <= box.y) continue;
      VIOL.push(`слайд ${no}: «${str.slice(0, 22)}» налезает на «${b.s.slice(0, 22)}» ` +
        `(x ${Math.round(box.x)}..${Math.round(box.x + box.w)}, y ${Math.round(box.y)})`);
      break;
    }
    drawn.push(box);
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

  /* floor — общая отметка, с которой начинается содержимое. Нужна кадрам:
     соседние слайды читаются как одно движение, только если лента стоит в
     ОДНИХ И ТЕХ ЖЕ координатах. Без неё содержимое начинается сразу под
     заголовком, а у кадров он разной высоты — и при пролистывании лента
     прыгает на высоту строки вместо того, чтобы двигаться. */
  if (opts.floor !== undefined) {
    if (y - 20 < opts.floor) {
      VIOL.push(`слайд ${slideNo}: заголовок дорос до общей отметки кадра (${Math.round(y - 20)} < ${opts.floor})`);
    }
    return { page, x, top: opts.floor };
  }

  return { page, x, top: y - 20 };
}

/* Перенос по ширине, но АВТОРСКИЙ перенос («\n») сильнее: заголовки слайдов
   разбиты по смыслу руками, и split(/\s+/) съедал «\n» как обычный пробел —
   разбивка молча пропадала, заголовок ломался по ширине с висячим словом, а
   кадр, потерявший вторую строку, съезжал вверх на всю её высоту. */
function wrap(text, font, size, width) {
  const lines = [];
  String(text).split("\n").forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    let line = "";
    for (const w of words) {
      const probe = line ? line + " " + w : w;
      if (font.widthOfTextAtSize(probe, size) > width && line) { lines.push(line); line = w; }
      else line = probe;
    }
    if (line) lines.push(line);
  });
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

  page.drawText(T("ПАРТИЦИЯ 0", "PARTITION 0"), { x: x0, y: top, size: 18, font: F.mono, color: C.ink2, characterSpacing: 2 });

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

  /* Конец лога: вертикальная черта, подпись прижата внутрь карточки.
     Подпись идёт СВОЕЙ строкой, на 22 пункта ниже заголовка ленты. На той же
     строке она держалась, пока лента была непустой: у кадра с written = 0
     черта стоит у самого левого края, и «LEO 0» ложилось поверх «ПАРТИЦИЯ 0»
     — то есть ровно на первом кадре, с которого читатель и начинает. */
  if (st.written <= NCELL) {
    const lx = x0 + st.written * STEP - 4;
    page.drawRectangle({ x: lx, y: y - 6, width: 3, height: CELL + 12, color: C.write });
    const cap = "LEO " + st.written;
    const cw = F.mono.widthOfTextAtSize(cap, 18);
    const cxp = Math.min(lx + 10, CX + CW - cw);
    page.drawText(cap, { x: cxp, y: y + CELL + 12, size: 18, font: F.mono, color: C.write });
  }

  // закладки: подпись группы идёт СЛЕВА от ленты не помещается,
  // поэтому несём её цветом и буквой в самой метке
  let by = y - 62;
  if (st.posA !== undefined) { bookmark(page, x0, by, st.posA, "A", C.read); by -= 50; }
  if (st.posB !== undefined) { bookmark(page, x0, by, st.posB, "B", KEYS[3]); by -= 50; }

  return by - 10;
}

/* note — необязательная приписка к подписи закладки («прочитал до сюда»).
   Раньше её передавали седьмым аргументом функции с шестью параметрами:
   JS молча выбрасывал лишний аргумент, и приписка не рисовалась никогда. */
function bookmark(page, x0, y, pos, letter, color, note) {
  const x = x0 + pos * STEP;
  page.drawRectangle({ x, y, width: CELL, height: 34, color });
  const t = letter + pos;
  page.drawText(t, {
    x: x + (CELL - F.mono.widthOfTextAtSize(t, 20)) / 2,
    y: y + 9, size: 20, font: F.mono, color: C.white,
  });
  const g = T("группа ", "group ") + letter;
  const lbl = note ? g + " · " + note : g;
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
  doc.setTitle(T("Kafka на пальцах", "Kafka hands-on"));
  doc.setSubject(T("Почему Kafka — не очередь, и что из этого следует",
    "Why Kafka is not a queue, and what follows from that"));

  /* --- 01 обложка --- */
  {
    const s = slide({
      eyebrow: T("разбор для тех, кому не зашло", "for everyone kafka never clicked for"),
      title: T("Kafka — это не очередь.", "Kafka is not a queue."),
      lede: T("И пока держишь в голове очередь, ничего не сходится: ни перемотка, ни ребалансы, ни потерянные сообщения.",
        "And while you keep a queue in your head, nothing adds up: not replay, not rebalances, not the messages you lose."),
    });
    strip(s.page, s.top, { written: 10, posA: 6, posB: 3 });
    footnote(s.page, T("Десять слайдов, чтобы это наконец щёлкнуло. Листай.",
      "Ten slides to make it finally click. Swipe."), C.write);
  }

  /* --- 02 очередь против лога --- */
  {
    const s = slide({
      eyebrow: T("разница в одном", "the whole difference"),
      title: T("Очередь удаляет. Лог оставляет.", "A queue deletes. A log keeps."),
      lede: T("В RabbitMQ сообщение доставили и стёрли. В Kafka записали и оставили лежать.",
        "RabbitMQ delivers the message and wipes it. Kafka writes it down and leaves it lying there."),
    });
    const x0 = CX;
    let y = s.top - 40;

    s.page.drawText(T("ОЧЕРЕДЬ ПОСЛЕ ЧТЕНИЯ", "QUEUE AFTER READING"), { x: x0, y, size: 18, font: F.mono, color: C.bad, characterSpacing: 2 });
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
    s.page.drawText(T("ЛОГ ПОСЛЕ ЧТЕНИЯ", "LOG AFTER READING"), { x: x0, y, size: 18, font: F.mono, color: C.good, characterSpacing: 2 });
    y -= 100;
    for (let i = 0; i < 6; i++) {
      s.page.drawRectangle({
        x: x0 + i * STEP, y, width: CELL, height: CELL,
        color: KEYS[SEQ[i].c], borderColor: KEYS[SEQ[i].c], borderWidth: 1.5,
      });
    }
    bookmark(s.page, x0, y - 54, 3, "A", C.read, T("прочитала до сюда", "read up to here"));

    footnote(s.page, T("Читатель двигает только свою закладку. Записи остаются на месте — поэтому их можно перечитать.",
      "A consumer moves only its own bookmark. The records stay where they are — that is why they can be read again."), C.good);
  }

  /* --- 03-05 кадры: лог наполняется --- */
  const frames = [
    { written: 0, posA: 0, posB: 0, note: T("Лог пуст. Обе группы стоят на offset 0 — читать ещё нечего.",
      "The log is empty. Both groups sit at offset 0 — there is nothing to read yet.") },
    { written: 4, posA: 2, posB: 1, note: T("Продюсер дописал четыре записи. Группы читают в своём темпе и уже разъехались.",
      "The producer appended four records. The groups read at their own pace and have already drifted apart.") },
    { written: 9, posA: 6, posB: 3, note: T("Отставание видно глазом: у группы B накопилось шесть непрочитанных сообщений.",
      "The lag is plain to see: group B has six unread messages piled up behind its bookmark.") },
  ];
  const FRAME_TOP = 976;   // одна отметка на все три кадра, см. floor в slide()
  frames.forEach((f, i) => {
    const s = slide({
      eyebrow: T("кадр " + (i + 1) + " из 3", "frame " + (i + 1) + " of 3"),
      title: i === 0
        ? T("Каждый читатель\nсо своей закладкой", "Every consumer\nhas its own bookmark")
        : (i === 1
          ? T("Продюсер пишет\nв конец", "The producer writes\nto the end")
          : T("Так выглядит lag", "This is what lag looks like")),
      lede: i === 2 ? T("lag = конец лога минус позиция группы. Главная метрика здоровья: насколько устарели данные прямо сейчас.",
        "lag = end of the log minus the position of the group. The health metric that matters: how stale the data is right now.") : "",
      floor: FRAME_TOP,
    });
    const y = strip(s.page, s.top, f);
    stats(s.page, y, [
      { label: T("записей", "records"), value: f.written },
      { label: T("lag группы A", "lag of group A"), value: f.written - f.posA, tone: f.written - f.posA > 4 ? C.warn : C.ink },
      { label: T("lag группы B", "lag of group B"), value: f.written - f.posB, tone: f.written - f.posB > 4 ? C.bad : C.ink },
    ]);
    footnote(s.page, f.note, i === 2 ? C.bad : C.write);
  });

  /* --- 06 перемотка --- */
  {
    const s = slide({
      eyebrow: T("чего очередь не умеет", "what a queue cannot do"),
      title: T("Закладку можно\nперемотать назад", "A bookmark can be\nrewound"),
      lede: T("Записи никуда не делись, поэтому историю читают заново — это и называется replay.",
        "The records never went anywhere, so the history gets read again — that is what replay means."),
    });
    strip(s.page, s.top, { written: 9, posA: 0, posB: 3 });
    footnote(s.page, T("Новый сервис подключается к работающему топику и вычитывает всё, что было до него. В очереди такой кнопки не существует.",
      "A new service joins a live topic and reads through everything that happened before it. A queue has no such button."), C.read);
  }

  /* --- 07 ключ решает партицию --- */
  {
    const s = slide({
      eyebrow: T("закон kafka", "the law of kafka"),
      title: T("Ключ решает,\nкуда ляжет запись", "The key decides\nwhere a record lands"),
      lede: T("номер партиции = hash(ключ) % количество партиций",
        "partition number = hash(key) % number of partitions"),
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
      s.page.drawText(T("партиция ", "partition ") + p, { x: x0, y: y + 22, size: 18, font: F.mono, color: C.ink2 });
      for (let i = 1; i < row.length; i++) {
        s.page.drawRectangle({
          x: x0 + 150 + (i - 1) * st, y, width: c, height: c,
          color: KEYS[row[i]], borderColor: KEYS[row[i]], borderWidth: 1.5,
        });
      }
      y -= 100;
    });
    y -= 10;
    s.page.drawText(T("одинаковый ключ  →  одна партиция  →  порядок",
      "same key  →  same partition  →  order"), {
      x: x0, y, size: 24, font: F.monoBold, color: C.ink,
    });
    footnote(s.page, T("Порядок гарантирован только внутри партиции. Между партициями порядка нет вообще — ни общего счётчика, ни общего времени.",
      "Order is guaranteed inside a partition only. Across partitions there is no order at all: no shared counter, no shared clock."), C.write);
  }

  /* --- 08 перекос ключа --- */
  {
    const s = slide({
      eyebrow: T("как это ломается", "how it breaks"),
      title: T("Плохой ключ —\nи одна партиция горит", "A bad key —\nand one partition burns"),
      /* Число в тексте и число на картинке обязаны сходиться: ниже рисуется
         восемь клеток в партиции 0 и по одной в соседних — итого десять. */
      lede: T("Если восемь из десяти событий идут с одним ключом, они лягут в одну партицию. Она перегружена, соседние простаивают.",
        "If eight events out of ten carry the same key, all eight land in one partition. It is overloaded, its neighbours idle."),
    });
    const x0 = CX;
    const c = 64, st = c + 8;
    let y = s.top - 70;
    const load = [8, 1, 1];
    load.forEach((n, p) => {
      s.page.drawText(T("партиция ", "partition ") + p, { x: x0, y: y + 22, size: 18, font: F.mono, color: C.ink2 });
      for (let i = 0; i < 8; i++) {
        const on = i < n;
        s.page.drawRectangle({
          x: x0 + 150 + i * st, y, width: c, height: c,
          color: on ? (p === 0 ? C.bad : KEYS[2]) : C.surface2,
          borderColor: on ? (p === 0 ? C.bad : KEYS[2]) : C.line, borderWidth: 1.5,
        });
      }
      s.page.drawText(p === 0 ? T("перегружена", "overloaded") : T("простаивает", "idle"), {
        x: x0 + 150 + 8 * st + 16, y: y + 22, size: 18, font: F.mono,
        color: p === 0 ? C.bad : C.faint,
      });
      y -= 100;
    });
    footnote(s.page, T("Добавить потребителей не поможет: одну партицию в группе читает ровно один из них. Потолок задан числом партиций.",
      "Adding consumers will not help: inside a group one partition is read by exactly one of them. The ceiling is the partition count."), C.bad);
  }

  /* --- 09 acks --- */
  {
    const s = slide({
      eyebrow: T("самая дорогая ловушка", "the most expensive trap"),
      title: T("acks=all\nне значит «все»", "acks=all\ndoes not mean “all”"),
      lede: T("Он ждёт подтверждения всех реплик ИЗ ISR — списка тех, кто успевает за лидером. А список умеет схлопываться.",
        "It waits for an acknowledgement from every replica IN THE ISR — the list of those keeping up with the leader. And that list can shrink."),
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

    box(T("Реплики успевают", "The replicas keep up"),
      T("ISR = [1, 2, 3]  ·  acks=all ждёт троих", "ISR = [1, 2, 3]  ·  acks=all waits for three"),
      T("ДАННЫЕ ЦЕЛЫ", "THE DATA IS SAFE"), C.good);
    box(T("Реплики отстали и выпали", "The replicas fell behind and dropped out"),
      T("ISR = [1]  ·  acks=all ждёт ОДНОГО", "ISR = [1]  ·  acks=all waits for ONE"),
      T("ТИХАЯ ПОТЕРЯ ПРИ ПАДЕНИИ ЛИДЕРА", "SILENT LOSS WHEN THE LEADER DIES"), C.bad);
    box("min.insync.replicas = 2",
      T("ISR = [1]  ·  запись не принимается", "ISR = [1]  ·  the write is refused"),
      T("ЯВНАЯ ОШИБКА — И ЭТО ХОРОШО", "AN OUTRIGHT ERROR — AND THAT IS GOOD"), C.write);

    footnote(s.page, T("Надёжная тройка, которую помнят как одно целое: replication.factor 3, acks=all, min.insync.replicas 2.",
      "The reliable trio, remembered as one thing: replication.factor 3, acks=all, min.insync.replicas 2."), C.write);
  }

  /* --- 10 финал со ссылкой --- */
  {
    const s = slide({
      eyebrow: T("а теперь самое странное", "and now the strangest part"),
      title: T("Всё это —\nживое. В PDF.", "All of this\nis live. In a PDF."),
      lede: T("Слайды выше — кадры настоящих стендов. В PDF нет ни HTML, ни CSS, но есть поля форм и собственный JavaScript: клетки лога это кнопки, движение — таймер, подписи — текстовые поля.",
        "The slides above are frames of real demos. A PDF has no HTML and no CSS, but it does have form fields and JavaScript of its own: the log cells are buttons, the motion is a timer, the captions are text fields."),
    });
    const x0 = M + PAD;
    let y = s.top - 40;

    /* В карточке — сам документ, а не сайт: карусель существует, чтобы до него
       довести, и адрес сайта на её месте уводил читателя мимо. Сайт остаётся
       ниже и мельче — как то же самое, но в браузере. */
    const BOX_W = W - M * 2 - PAD * 2, BOX_H = 150;
    s.page.drawRectangle({
      x: x0, y: y - BOX_H, width: BOX_W, height: BOX_H,
      color: C.surface2, borderColor: C.write, borderWidth: 3,
    });
    s.page.drawText(T("Интерактивный PDF со стендами:", "The interactive PDF with the demos:"), { x: x0 + 32, y: y - 44, size: 24, font: F.sans, color: C.muted });
    s.page.drawText(DOC_TEXT[0], { x: x0 + 32, y: y - 84, size: 26, font: F.monoBold, color: C.write });
    s.page.drawText(DOC_TEXT[1], { x: x0 + 32, y: y - 120, size: 26, font: F.monoBold, color: C.write });
    /* Единственная аннотация во всей карусели. Кнопкой или полем формы она не
       является, поэтому запрет на интерактив её не касается: поломаться в ленте
       нечему — ссылка невидима и просто не сработает. */
    L.link({ doc }, s.page, { x: x0, y: y - BOX_H, w: BOX_W, h: BOX_H }, DOC_URL);

    y -= BOX_H + 50;
    s.page.drawText(T("Скачай и открой на компьютере — в Chrome, Edge или Acrobat.",
      "Download it and open it on a desktop, in Chrome, Edge or Acrobat."), { x: x0, y, size: 24, font: F.sans, color: C.ink2 });
    y -= 46;
    s.page.drawText(T("Те же пятнадцать глав в браузере, в том числе на телефоне:",
      "The same fifteen chapters in a browser, phones included:"), { x: x0, y, size: 22, font: F.sans, color: C.faint });
    y -= 32;
    s.page.drawText(SITE, { x: x0, y, size: 22, font: F.mono, color: C.muted });

    footnote(s.page, T("Здесь, в ленте, всё это статично: LinkedIn превращает любой документ в картинки. Так что кнопок тут нет — они ждут в файле.",
      "Here in the feed it is all static: LinkedIn turns any document into images. So there are no buttons here — they are waiting in the file."), C.read);
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
