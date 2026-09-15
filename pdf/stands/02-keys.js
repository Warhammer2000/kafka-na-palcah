/* Стенд 02 — «Ключ решает партицию».
   Три ленты по 8 клеток, по ленте на партицию. Кнопка-ключ зажигает
   следующую свободную клетку СВОЕЙ партиции — какой именно, посчитано
   здесь, при сборке, и зашито в скрипт таблицей: в просмотрщике хеш
   никто не считает.

   Про цвет. Клетка рождается уже окрашенной, поменять её на лету PDF
   не даст. Поэтому в каждой точке лежит стопка из трёх заранее
   окрашенных состояний: пусто / запись своего ключа / запись без ключа
   (round-robin). Скрипт только показывает нужное. Это тот же приём, что
   в L.logCell, просто состояний три, а не два: без третьего кнопка
   «без ключа» зажигала бы клетку чужого цвета и врала. */

/* CRC32 (IEEE): короткий, узнаваемый и, в отличие от murmur2, разводит
   наши три ключа по трём разным партициям — стенд показывает закон, а не
   случайное совпадение хешей. Оговорка про murmur2 стоит под стендом. */
function crc32(str) {
  const bytes = Buffer.from(str, "utf8");
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const NPART = 3;
const NCELL = 8;
const HOT = 2;      // какой ключ давит на свою партицию в демонстрации перекоса

/* Ключи стенда. Номер партиции НЕ пишется руками — он считается. */
const KEYDEF = [
  { name: "user-1", short: "u1", color: 0 },
  { name: "user-7", short: "u7", color: 1 },
  { name: "user-42", short: "u42", color: 2 },
].map((k) => {
  const h = crc32(k.name);
  return Object.assign({}, k, { hash: String(h), part: h % NPART });
});

module.exports = {
  id: "s2",
  eyebrow: "стенд 02",
  title: "Ключ решает партицию",
  subtitle: "Продюсер не выбирает партицию руками — за него это делает ключ: номер = hash(ключ) % число партиций. Что из этого следует для порядка записей и что случается, когда один ключ перетягивает всё на себя?",

  build(ctx, L, page) {
    const { C, KEYS, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;

    const X0 = 120;            // слева место под подписи «партиция N»
    const ROW = [350, 310, 270];
    const CX = 420;            // колонка счётчиков
    const LX = 520;            // колонка легенды

    /* ---- состояния клеток каждой партиции ----
       [0] пусто, далее по состоянию на каждый ключ этой партиции,
       последнее — запись без ключа. Индексы уезжают в скрипт таблицей. */
    const ST = [];   // ST[p][j] — состояние ключа j в партиции p (или -1)
    const NOK = [];  // NOK[p]   — состояние «без ключа»
    const NST = [];  // NST[p]   — сколько всего состояний
    const cellStates = [];

    for (let p = 0; p < NPART; p++) {
      const states = [
        { fill: C.surface2, border: C.line, caption: "", captionColor: C.muted },
      ];
      const row = [];
      for (let j = 0; j < KEYDEF.length; j++) {
        if (KEYDEF[j].part !== p) { row.push(-1); continue; }
        row.push(states.length);
        states.push({
          fill: KEYS[KEYDEF[j].color], border: KEYS[KEYDEF[j].color],
          caption: KEYDEF[j].short, captionColor: C.white, mono: true,
        });
      }
      NOK.push(states.length);
      states.push({ fill: C.faint, border: C.faint, caption: "?", captionColor: C.white, mono: true });
      ST.push(row);
      NST.push(states.length);
      cellStates.push(states);
    }

    /* ---- ленты ---- */
    for (let p = 0; p < NPART; p++) {
      for (let i = 0; i < NCELL; i++) {
        L.stack(ctx, page, "s2_p" + p + "_c" + i, cellStates[p], {
          x: X0 + i * STEP, y: ROW[p], w: CELL, h: CELL, initial: 0, size: 8,
        });
      }
      L.tag(page, fonts, "партиция " + p, 56, ROW[p] + 11, C.ink2);
    }

    /* номера оффсетов — общая шапка над всеми тремя лентами */
    for (let i = 0; i < NCELL; i++) {
      const s = String(i);
      page.drawText(s, {
        x: X0 + i * STEP + (CELL - fonts.mono.widthOfTextAtSize(s, 7.5)) / 2,
        y: 386, size: 7.5, font: fonts.mono, color: C.faint,
      });
    }
    L.tag(page, fonts, "offset", 56, 386);

    /* ---- счётчики: перекос должен быть виден числом ---- */
    L.tag(page, fonts, "записей", CX, 386);
    for (let p = 0; p < NPART; p++) {
      L.readout(ctx, page, "s2_n" + p, { x: CX, y: ROW[p] + 3, w: 76, h: 24 }, {
        text: "0", size: 13, mono: true, align: "center",
      });
    }

    /* ---- легенда: ключ, его хеш и куда он ведёт ---- */
    L.tag(page, fonts, "ключ → партиция", LX, 386);
    KEYDEF.forEach((k, j) => {
      const y = 368 - j * 26;
      page.drawRectangle({ x: LX, y, width: 11, height: 11, color: KEYS[k.color] });
      page.drawText(k.name + " → партиция " + k.part, {
        x: LX + 17, y: y + 1.5, size: 8.5, font: fonts.mono, color: C.ink,
      });
      page.drawText("crc32 " + k.hash + " % 3 = " + k.part, {
        x: LX + 17, y: y - 9, size: 7, font: fonts.mono, color: C.faint,
      });
    });
    page.drawRectangle({ x: LX, y: 290, width: 11, height: 11, color: C.faint });
    page.drawText("? — без ключа, по кругу", {
      x: LX + 17, y: 291.5, size: 8.5, font: fonts.mono, color: C.muted,
    });

    /* ---- живая формула ---- */
    L.tag(page, fonts, "как выбрана партиция", X0, 252);
    L.readout(ctx, page, "s2_calc", { x: X0, y: 222, w: PAGE.w - 112 - (X0 - 56), h: 26 }, {
      text: "hash(ключ) % 3 = номер партиции", size: 11, mono: true,
    });

    /* ---- кнопки ---- */
    const BY = 170;
    KEYDEF.forEach((k, j) => {
      L.action(ctx, page, "s2_k" + j, k.name, { x: X0 + j * 98, y: BY, w: 92, h: 30 },
        "s2_key(" + j + ");", { fill: KEYS[k.color], border: KEYS[k.color], textColor: C.white });
    });
    L.action(ctx, page, "s2_nokey", "без ключа", { x: X0 + 294, y: BY, w: 100, h: 30 },
      "s2_nokey();", { fill: C.faint, border: C.faint, textColor: C.white });
    L.action(ctx, page, "s2_hot", "Перекос: 6 раз " + KEYDEF[HOT].name, { x: X0 + 402, y: BY, w: 172, h: 30 },
      "s2_hot();", { fill: C.bad, border: C.bad, textColor: C.white });
    L.action(ctx, page, "s2_reset", "Сброс", { x: X0 + 582, y: BY, w: 76, h: 30 },
      "s2_reset();");

    L.readout(ctx, page, "s2_say", { x: X0, y: 120, w: PAGE.w - 112 - (X0 - 56), h: 34 }, {
      text: "Демонстрация идёт сама — нажми любую кнопку, чтобы взять управление",
      size: 10.5,
    });

    L.wrapText(page, "Хеш берётся от байтов ключа: пока число партиций не меняется, ключ всегда приводит в одну и ту же партицию. Добавили партиций — делитель другой, тот же ключ уезжает в другую ленту, а записанное раньше остаётся на старом месте. Разные ключи могут съехаться в одну партицию: хеш обещает стабильность адреса, а не разные адреса. Запись без ключа продюсер раскладывает сам — здесь по кругу, в нынешней Kafka «липкими» пачками. Хеш у Kafka — murmur2, здесь для наглядности crc32: арифметика та же.", {
      x: X0, y: 100, width: PAGE.w - 112 - (X0 - 56), size: 9,
      font: fonts.sans, color: C.faint, leading: 12,
    });

    /* ---- документный скрипт стенда ---- */
    return `
var s2_N = ${NCELL};
var s2_NP = ${NPART};
var s2_NAME = ${JSON.stringify(KEYDEF.map((k) => k.name))};
var s2_HASH = ${JSON.stringify(KEYDEF.map((k) => k.hash))};
var s2_P = ${JSON.stringify(KEYDEF.map((k) => k.part))};
var s2_ST = ${JSON.stringify(ST)};
var s2_NOK = ${JSON.stringify(NOK)};
var s2_NST = ${JSON.stringify(NST)};
var s2_cnt = [0, 0, 0];
var s2_rr = 0;
var s2_manual = false, s2_tick = 0, s2_full = 0;

function s2_stats() {
  for (var p = 0; p < s2_NP; p++) txt("s2_n" + p, s2_cnt[p]);
}

/* Зажечь следующую свободную клетку партиции нужным состоянием. */
function s2_put(p, st) {
  if (s2_cnt[p] >= s2_N) return false;
  show("s2_p" + p + "_c" + s2_cnt[p], st, s2_NST[p]);
  s2_cnt[p]++;
  return true;
}

function s2_formula(j) {
  var p = s2_P[j];
  txt("s2_calc", "hash(«" + s2_NAME[j] + "») = " + s2_HASH[j] + "   →   " + s2_HASH[j] + " % 3 = " + p + "   →   партиция " + p);
}

function s2_key(j) {
  s2_manual = true;
  var p = s2_P[j];
  s2_formula(j);
  if (!s2_put(p, s2_ST[p][j])) {
    txt("s2_say", "Партиция " + p + " заполнена до края стенда. Другой партиции этому ключу не достанется — жми «Сброс».");
    return;
  }
  s2_stats();
  txt("s2_say", "Ключ тот же — партиция та же: события " + s2_NAME[j] + " всегда ложатся в партицию " + p + ", и порядок Kafka обещает только внутри неё.");
}

function s2_nokey() {
  s2_manual = true;
  var p = s2_rr % s2_NP;
  var tries = 0;
  while (tries < s2_NP && s2_cnt[p] >= s2_N) { s2_rr++; p = s2_rr % s2_NP; tries++; }
  if (!s2_put(p, s2_NOK[p])) {
    txt("s2_say", "Свободных клеток не осталось ни в одной партиции. Жми «Сброс».");
    return;
  }
  s2_rr++;
  txt("s2_calc", "ключа нет   →   round-robin   →   партиция " + p);
  s2_stats();
  txt("s2_say", "Ключа нет — запись ушла по кругу в партицию " + p + ". Нагрузка ровная, но порядок между партициями не гарантирован.");
}

function s2_clear() {
  for (var p = 0; p < s2_NP; p++) {
    for (var i = 0; i < s2_N; i++) show("s2_p" + p + "_c" + i, 0, s2_NST[p]);
    s2_cnt[p] = 0;
  }
  s2_rr = 0;
}

/* Перекос всегда считается С ЧИСТЫХ ЛЕНТ. Иначе кнопка врёт: автодемонстрация
   заканчивается на 7/7/7, свободна одна клетка, и «перекос» дописал бы ОДНУ
   запись, объявив при этом соседние партиции простаивающими. */
function s2_hot() {
  s2_manual = true;
  var j = ${HOT};
  var p = s2_P[j];
  s2_clear();
  for (var i = 0; i < 6; i++) s2_put(p, s2_ST[p][j]);
  s2_formula(j);
  s2_stats();
  var other = "";
  for (var q = 0; q < s2_NP; q++) {
    if (q === p) continue;
    if (other !== "") other = other + " и ";
    other = other + s2_cnt[q];
  }
  txt("s2_say", "Перекос: с чистых лент шесть раз " + s2_NAME[j] + " — все шесть в партиции " + p + ", в других " + other + ". Ключ задаёт партицию жёстко.");
}

function s2_reset() {
  s2_manual = true;
  s2_clear();
  s2_tick = 0;
  s2_full = 0;
  s2_stats();
  txt("s2_calc", "hash(ключ) % 3 = номер партиции");
  txt("s2_say", "Партиции пусты. Жми ключи: один и тот же ключ всегда приводит в одну и ту же партицию.");
}

function s2_auto() {
  if (s2_manual) return;
  var j = s2_tick % 3;
  s2_tick++;
  var p = s2_P[j];
  s2_formula(j);
  if (s2_put(p, s2_ST[p][j])) {
    s2_full = 0;
    s2_stats();
    txt("s2_say", "Показ: " + s2_NAME[j] + " уходит в партицию " + p + " — ключ тот же, значит и партиция та же.");
  } else {
    s2_full++;
  }
  if (s2_full >= s2_NP || s2_tick >= 21) {
    s2_manual = true;
    txt("s2_say", "Показ окончен. Жми «Сброс» и пробуй сам — кнопки настоящие.");
  }
}

s2_stats();
TICKERS.push(s2_auto);
`;
  },
};
