/* Стенд 03 — «Lag: насколько устарели твои данные».
   Собран по форме эталонного stands/01-log.js. */

module.exports = {
  id: "s3",
  eyebrow: "стенд 03",
  title: "Lag: насколько устарели твои данные",
  subtitle: "Сколько сообщений консьюмер ещё не прочитал прямо сейчас? Lag — это разница между концом лога и сохранённой позицией группы, и именно он отвечает на вопрос «насколько свежи мои данные».",

  /* 18 клеток одной партиции. Цвет клетки запекается заранее: менять его
     на лету PDF не даёт, поэтому каждая клетка — стопка из двух состояний. */
  N: 18,

  build(ctx, L, page) {
    const { C, KEYS, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;
    const N = this.N;

    const X0 = 104;   // слева остаётся место под подписи «партиция» и «offset»
    const Y = 330;

    /* метка конца лога (LEO) — над лентой, белая, цвет несёт подпись */
    L.slider(ctx, page, "s3_leo", N + 1, X0, Y + CELL + 8, {
      w: CELL, h: 13, fill: C.surface, textColor: C.write, size: 7, borderWidth: 0,
      caption: (i) => "→" + i,
    });

    /* клетки лога и статичные номера оффсетов под ними */
    for (let i = 0; i < N; i++) {
      L.logCell(ctx, page, "s3_c" + i, X0 + i * STEP, Y, i % KEYS.length, "");
      const lbl = String(i);
      page.drawText(lbl, {
        x: X0 + i * STEP + (CELL - fonts.mono.widthOfTextAtSize(lbl, 7.5)) / 2,
        y: Y - 12, size: 7.5, font: fonts.mono, color: C.faint,
      });
    }

    /* закладка группы — committed offset, под лентой */
    L.slider(ctx, page, "s3_com", N + 1, X0, Y - 34, {
      w: CELL, h: 13, fill: C.surface, textColor: C.read, size: 7, borderWidth: 0,
      caption: (i) => "C" + i,
    });

    const RX = X0 + (N - 1) * STEP + CELL + 12;
    L.tag(page, fonts, "leo", RX, Y + CELL + 11, C.write);
    L.tag(page, fonts, "committed", RX, Y - 31, C.read);
    L.tag(page, fonts, "offset", 58, Y - 12);
    L.tag(page, fonts, "партиция", 58, Y + 16, C.ink2);
    L.tag(page, fonts, "0", 58, Y + 6, C.ink2);

    /* три крупных показателя плюс соседнее поле с самим вычитанием */
    [
      { n: "s3_leo_v", l: "leo (конец лога)", x: X0, w: 110, size: 13, txt: "0" },
      { n: "s3_com_v", l: "committed", x: X0 + 118, w: 110, size: 13, txt: "0" },
      { n: "s3_lag_v", l: "lag", x: X0 + 236, w: 110, size: 13, txt: "0" },
      { n: "s3_calc", l: "как считается", x: X0 + 354, w: 238, size: 11, txt: "lag = 0 - 0 = 0" },
    ].forEach((s) => {
      L.tag(page, fonts, s.l, s.x, 250);
      L.readout(ctx, page, s.n, { x: s.x, y: 222, w: s.w, h: 24 }, {
        text: s.txt, size: s.size, mono: true, align: "center",
      });
    });

    /* кнопки */
    const BY = 170;
    L.action(ctx, page, "s3_btn_prod", "Продюсер быстрее", { x: 56, y: BY, w: 140, h: 30 },
      "s3_prod_fast();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s3_btn_cons", "Консьюмер быстрее", { x: 204, y: BY, w: 150, h: 30 },
      "s3_cons_fast();", { fill: C.read, border: C.read, textColor: C.white });
    L.action(ctx, page, "s3_btn_down", "Уронить консьюмера", { x: 362, y: BY, w: 152, h: 30 },
      "s3_down();", { fill: C.bad, border: C.bad, textColor: C.white });
    L.action(ctx, page, "s3_btn_up", "Поднять консьюмера", { x: 522, y: BY, w: 152, h: 30 },
      "s3_up();", { fill: C.good, border: C.good, textColor: C.white });
    L.action(ctx, page, "s3_btn_reset", "Сброс", { x: 682, y: BY, w: 68, h: 30 },
      "s3_reset();");

    L.readout(ctx, page, "s3_say", { x: 56, y: 120, w: PAGE.w - 112, h: 34 }, {
      text: "Симуляция уже идёт: продюсер пишет по одной записи за такт, консьюмер читает по одной. Нажми любую кнопку, чтобы сбить равновесие.",
      size: 10.5,
    });

    L.wrapText(page, "Committed offset хранится не у консьюмера, а в самой Kafka — в служебном топике __consumer_offsets. Поэтому упавший консьюмер поднимается и продолжает с сохранённой позиции, а не с нуля. И ещё тонкость: committed — это номер СЛЕДУЮЩЕГО сообщения для чтения, а не последнего обработанного.", {
      x: 56, y: 100, width: PAGE.w - 112, size: 9,
      font: fonts.sans, color: C.faint, leading: 12,
    });

    /* ---- документный скрипт стенда ---- */
    return `
var s3_N = ${N};
var s3_written = 0;      // LEO: номер следующей записи, то есть конец лога
var s3_committed = 0;    // позиция группы: номер следующего сообщения для чтения
var s3_prod = 1;         // записей за такт
var s3_cons = 1;         // прочитанных за такт
var s3_manual = false;   // первый клик выключает сценарий автопоказа
var s3_beat = 0;
var s3_hold = 0;         // сколько тактов не перебивать пояснение от кнопки
var s3_prevLag = 0;

function s3_paint() {
  var lag = s3_written - s3_committed;
  moveTo("s3_leo", s3_written, s3_N + 1);
  moveTo("s3_com", s3_committed, s3_N + 1);
  txt("s3_leo_v", s3_written);
  txt("s3_com_v", s3_committed);
  txt("s3_lag_v", lag);
  txt("s3_calc", "lag = " + s3_written + " - " + s3_committed + " = " + lag);
}

/* Лента кончилась — перекладываем хвост в начало и идём дальше, чтобы показ
   был бесконечным. Отставание переносим как есть: прокрутка ленты его не лечит.
   Пара уже прочитанных клеток слева остаётся, иначе committed падал бы в ноль
   и «поднялся с сохранённой позиции» читалось бы как «начал с начала». */
function s3_wrap() {
  var lag = s3_written - s3_committed;
  if (lag > s3_N - 3) lag = s3_N - 3;
  if (lag < 0) lag = 0;
  var keep = 2;
  if (keep > s3_committed) keep = s3_committed;
  var lit = keep + lag;
  var i;
  for (i = 0; i < s3_N; i++) show("s3_c" + i, (i < lit) ? 1 : 0, 2);
  s3_committed = keep;
  s3_written = lit;
}

function s3_step() {
  var i;
  for (i = 0; i < s3_prod; i++) {
    if (s3_written >= s3_N) { s3_wrap(); break; }
    show("s3_c" + s3_written, 1, 2);
    s3_written++;
  }
  for (i = 0; i < s3_cons; i++) {
    if (s3_committed >= s3_written) break;
    s3_committed++;
  }
  s3_paint();
}

function s3_talk() {
  if (s3_hold > 0) { s3_hold--; return; }
  var lag = s3_written - s3_committed;
  if (s3_cons === 0) {
    txt("s3_say", "Консьюмер лежит: committed застыл на " + s3_committed + ", а LEO уехал на " + s3_written + ". Lag " + lag + " — столько сообщений уже ждут, и данные устаревают на глазах.");
  } else if (lag === 0) {
    txt("s3_say", "Lag 0: консьюмер вровень с продюсером, данные свежие. committed = LEO = " + s3_written + " — номер СЛЕДУЮЩЕГО сообщения, а не последнего обработанного.");
  } else if (lag > s3_prevLag) {
    txt("s3_say", "Lag вырос с " + s3_prevLag + " до " + lag + ": пишут быстрее, чем читают. Отставание копится, и всё, что ты видишь на выходе, всё старее.");
  } else if (lag < s3_prevLag) {
    txt("s3_say", "Lag упал с " + s3_prevLag + " до " + lag + ": консьюмер читает быстрее продюсера и подтягивает committed к концу лога. Данные снова свежеют.");
  } else {
    txt("s3_say", "Lag держится на " + lag + ": продюсер и консьюмер в одном темпе. Отставание постоянное — ровно " + lag + " сообщений между концом лога и закладкой.");
  }
}

/* Сценарий автопоказа: равновесие, продюсер разгоняется, консьюмер догоняет. */
function s3_scene() {
  var phase = s3_beat % 26;
  if (phase === 0) { s3_prod = 1; s3_cons = 1; }
  else if (phase === 6) { s3_prod = 2; s3_cons = 1; }
  else if (phase === 14) { s3_prod = 1; s3_cons = 2; }
  else if (phase === 20) { s3_prod = 1; s3_cons = 1; }
}

/* Движок тикает всегда: кнопки не запускают шаги, они меняют скорости. */
function s3_auto() {
  s3_beat++;
  if (!s3_manual) s3_scene();
  s3_step();
  s3_talk();
  s3_prevLag = s3_written - s3_committed;
}

function s3_prod_fast() {
  s3_manual = true;
  s3_prod = 2;
  s3_hold = 5;
  txt("s3_say", "Продюсер ускорился: 2 записи за такт против " + s3_cons + " прочитанных. LEO убегает, разрыв между метками растёт — это и есть растущий lag.");
  s3_paint();
}

function s3_cons_fast() {
  s3_manual = true;
  s3_cons = 2;
  s3_hold = 5;
  txt("s3_say", "Консьюмер ускорился: 2 записи за такт. Он вычитывает накопленное, committed нагоняет LEO, и lag схлопывается к нулю.");
  s3_paint();
}

function s3_down() {
  s3_manual = true;
  s3_cons = 0;
  s3_hold = 6;
  txt("s3_say", "Консьюмер упал: LEO уходит вперёд, lag растёт на глазах. Но committed = " + s3_committed + " лежит в самой Kafka, в топике __consumer_offsets, — позиция цела.");
  s3_paint();
}

function s3_up() {
  s3_manual = true;
  s3_cons = 2;
  s3_hold = 6;
  txt("s3_say", "Поднялся и продолжил С СОХРАНЁННОЙ ПОЗИЦИИ " + s3_committed + ", а не с нуля: committed он прочитал из __consumer_offsets. Теперь берёт по 2 за такт.");
  s3_paint();
}

function s3_reset() {
  s3_manual = true;
  var i;
  for (i = 0; i < s3_N; i++) show("s3_c" + i, 0, 2);
  s3_written = 0;
  s3_committed = 0;
  s3_prod = 1;
  s3_cons = 1;
  s3_prevLag = 0;
  s3_hold = 4;
  txt("s3_say", "Лог пуст, обе метки на нуле, темпы равные — по записи за такт. Движок идёт: жми кнопки и смотри, что каждая делает с lag.");
  s3_paint();
}

s3_paint();
TICKERS.push(s3_auto);
`;
  },
};
