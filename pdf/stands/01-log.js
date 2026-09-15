/* Стенд 01 — «Лог, а не очередь».
   Эталонный модуль: по его форме собираются остальные стенды. */

module.exports = {
  id: "s1",
  eyebrow: ["стенд 01", "demo 01"],
  title: ["Лог, а не очередь", "A log, not a queue"],
  subtitle: [
    "Чтение ничего не удаляет. Продюсер дописывает в конец, а каждый читатель держит собственную закладку и двигает только её. Отсюда и перемотка, и независимые потребители.",
    "Reading deletes nothing. The producer appends to the end, and every reader keeps a bookmark of its own and moves only that one. Hence replay, and hence independent consumers.",
  ],

  /* Последовательность записей фиксирована — значит цвет и подпись каждой
     клетки известны заранее и запекаются в её окрашенное состояние.
     Менять цвет на лету PDF не позволяет. */
  SEQ: [
    { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u42", c: 0 }, { k: "u13", c: 2 },
    { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u91", c: 3 }, { k: "u42", c: 0 },
    { k: "u13", c: 2 }, { k: "u91", c: 3 }, { k: "u07", c: 1 }, { k: "u42", c: 0 },
    { k: "u55", c: 4 }, { k: "u13", c: 2 },
  ],

  build(ctx, L, page) {
    const { C, KEYS, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;
    const SEQ = this.SEQ;
    const N = SEQ.length;

    const X0 = 104;   // место слева под подписи «партиция» и «offset»: 46 пунктов,
                      // меньше — и «ПАРТИЦИЯ» уезжает под первую клетку
    const Y = 330;

    /* метка конца лога */
    L.slider(ctx, page, "s1_leo", N + 1, X0, Y + CELL + 8, {
      w: CELL, h: 13, fill: C.surface, textColor: C.write, size: 7, borderWidth: 0,
      caption: (i) => "→" + i,
    });

    /* клетки и статичные номера оффсетов */
    SEQ.forEach((r, i) => {
      L.logCell(ctx, page, "s1_c" + i, X0 + i * STEP, Y, r.c, r.k);
      page.drawText(String(i), {
        x: X0 + i * STEP + (CELL - fonts.mono.widthOfTextAtSize(String(i), 7.5)) / 2,
        y: Y - 12, size: 7.5, font: fonts.mono, color: C.faint,
      });
    });

    /* закладки двух групп */
    L.slider(ctx, page, "s1_a", N + 1, X0, Y - 32, {
      w: CELL, h: 13, fill: C.surface, textColor: C.read, size: 7, borderWidth: 0,
      caption: (i) => "A" + i,
    });
    L.slider(ctx, page, "s1_b", N + 1, X0, Y - 50, {
      w: CELL, h: 13, fill: C.surface, textColor: KEYS[3], size: 7, borderWidth: 0,
      caption: (i) => "B" + i,
    });

    /* Подписи ставим ПОСЛЕ последней позиции метки, а не после последней клетки.
       У метки позиций N+1: крайняя (offset = N, «одна за концом») стоит правее
       ленты на целую клетку, а её виджет — непрозрачный белый прямоугольник
       поверх содержимого страницы. Подпись, прижатая к ленте, им просто
       закрывается, и читатель видит «ППА A» вместо «ГРУППА A». */
    const RX = X0 + N * STEP + CELL + 8;
    L.tag(page, fonts, L.T("группа A", "group A"), RX, Y - 29, C.read);
    L.tag(page, fonts, L.T("группа B", "group B"), RX, Y - 47, KEYS[3]);
    L.tag(page, fonts, L.T("конец лога", "end of log"), RX, Y + CELL + 11, C.write);
    L.tag(page, fonts, "offset", X0 - 46, Y - 12);
    /* Слева до первой клетки ровно 46 пунктов, и «ПАРТИЦИЯ» занимает 44,8 из
       них. Английское PARTITION — 50,4: последняя буква уезжает под клетку и
       закрывается её виджетом. Поэтому здесь сокращение, а не сдвиг подписи. */
    L.tag(page, fonts, L.T("партиция", "part."), X0 - 46, Y + 16, C.ink2);
    L.tag(page, fonts, "0", X0 - 46, Y + 6, C.ink2);

    /* показатели */
    [
      { n: "s1_written", l: L.T("записей в логе", "records in log"), x: X0 },
      { n: "s1_laga", l: L.T("lag группы A", "group A lag"), x: X0 + 150 },
      { n: "s1_lagb", l: L.T("lag группы B", "group B lag"), x: X0 + 300 },
    ].forEach((s) => {
      L.tag(page, fonts, s.l, s.x, 250);
      L.readout(ctx, page, s.n, { x: s.x, y: 222, w: 120, h: 24 }, {
        text: "0", size: 13, mono: true, align: "center",
      });
    });

    /* кнопки */
    const BY = 170;
    L.action(ctx, page, "s1_write", L.T("Продюсер пишет", "Producer writes"), { x: X0, y: BY, w: 130, h: 30 },
      "s1_write();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s1_reada", L.T("A читает", "A reads"), { x: X0 + 140, y: BY, w: 90, h: 30 },
      "s1_read('a');", { fill: C.read, border: C.read, textColor: C.white });
    L.action(ctx, page, "s1_readb", L.T("B читает", "B reads"), { x: X0 + 238, y: BY, w: 90, h: 30 },
      "s1_read('b');", { fill: KEYS[3], border: KEYS[3], textColor: C.white });
    L.action(ctx, page, "s1_rew", L.T("Перемотать A в начало", "Rewind A to the start"), { x: X0 + 336, y: BY, w: 160, h: 30 },
      "s1_rewind();");
    L.action(ctx, page, "s1_reset", L.T("Сброс", "Reset"), { x: X0 + 504, y: BY, w: 70, h: 30 },
      "s1_reset();");

    /* multiline: пояснения собираются из чисел на лету и в одну строку не
       умещаются — однострочное поле обрезало бы их посреди слова. */
    L.readout(ctx, page, "s1_say", { x: X0, y: 120, w: PAGE.w - 112 - (X0 - 56), h: 34 }, {
      text: L.T("Демонстрация идёт сама — нажми любую кнопку, чтобы взять управление",
        "The demo runs by itself — press any button to take over"),
      size: 10.5, multiline: true,
    });

    L.wrapText(page, L.T(
      "Обрати внимание: когда A читает, клетка остаётся на месте — двигается только закладка. Кнопка перемотки возвращает A в начало, и вся история читается заново. В очереди такой кнопки не существует: там прочитанное удалено.",
      "Notice: when A reads, the cell stays where it is — only the bookmark moves. The rewind button sends A back to the start, and the whole history is read again. A queue has no such button: there, whatever was read is gone."
    ), {
      x: X0, y: 100, width: PAGE.w - 112 - (X0 - 56), size: 9,
      font: fonts.sans, color: C.faint, leading: 12,
    });

    /* ---- документный скрипт стенда ---- */
    return `
var s1_N = ${N};
var s1_KEYS = ${JSON.stringify(SEQ.map((r) => r.k))};
var s1_written = 0, s1_posA = 0, s1_posB = 0;
var s1_manual = false, s1_tick = 0;

function s1_stats() {
  txt("s1_written", s1_written);
  txt("s1_laga", s1_written - s1_posA);
  txt("s1_lagb", s1_written - s1_posB);
}

function s1_write() {
  s1_manual = true;
  if (s1_written >= s1_N) { txt("s1_say", "${L.T(
    "Лог заполнен до конца стенда. Нажми «Сброс», чтобы начать заново.",
    "The log is full to the end of this demo. Press “Reset” to start over."
  )}"); return; }
  show("s1_c" + s1_written, 1, 2);
  s1_written++;
  moveTo("s1_leo", s1_written, s1_N + 1);
  s1_stats();
  txt("s1_say", ${L.T(
    '"Продюсер дописал «" + s1_KEYS[s1_written - 1] + "» в конец лога: offset " + (s1_written - 1) + ". Закладки читателей не сдвинулись — им это ещё предстоит прочитать."',
    '"The producer appended “" + s1_KEYS[s1_written - 1] + "” to the end of the log: offset " + (s1_written - 1) + ". The readers’ bookmarks did not move — this record is still ahead of them."'
  )});
}

function s1_read(who) {
  s1_manual = true;
  var pos = (who === "a") ? s1_posA : s1_posB;
  var name = (who === "a") ? "A" : "B";
  if (pos >= s1_written) {
    txt("s1_say", ${L.T(
      '"Группа " + name + " дочитала до конца лога (offset " + pos + "). Читать нечего, пока продюсер не допишет новое."',
      '"Group " + name + " has read to the end of the log (offset " + pos + "). Nothing left to read until the producer appends something new."'
    )});
    return;
  }
  if (who === "a") { s1_posA++; moveTo("s1_a", s1_posA, s1_N + 1); }
  else { s1_posB++; moveTo("s1_b", s1_posB, s1_N + 1); }
  s1_stats();
  txt("s1_say", ${L.T(
    '"Группа " + name + " прочитала offset " + pos + " («" + s1_KEYS[pos] + "»). Запись осталась на месте — сдвинулась только закладка " + name + ", теперь она на " + ((who === "a") ? s1_posA : s1_posB) + ". Вторая группа этого даже не заметила."',
    '"Group " + name + " read offset " + pos + " (“" + s1_KEYS[pos] + "”). The record stayed where it was — only bookmark " + name + " moved, it now sits at " + ((who === "a") ? s1_posA : s1_posB) + ". The other group never noticed."'
  )});
}

function s1_rewind() {
  s1_manual = true;
  s1_posA = 0;
  moveTo("s1_a", 0, s1_N + 1);
  s1_stats();
  txt("s1_say", "${L.T(
    "Закладка A вернулась на offset 0 — вся история читается заново. Это и есть replay: записи никуда не делись.",
    "Bookmark A is back at offset 0 — the whole history is read again. That is replay: the records never went anywhere."
  )}");
}

function s1_reset() {
  s1_manual = true;
  for (var i = 0; i < s1_N; i++) show("s1_c" + i, 0, 2);
  s1_written = 0; s1_posA = 0; s1_posB = 0;
  moveTo("s1_leo", 0, s1_N + 1);
  moveTo("s1_a", 0, s1_N + 1);
  moveTo("s1_b", 0, s1_N + 1);
  s1_stats();
  txt("s1_say", "${L.T(
    "Лог пуст. Нажимай «Продюсер пишет» и смотри, как расходятся закладки.",
    "The log is empty. Press “Producer writes” and watch the bookmarks drift apart."
  )}");
}

function s1_auto() {
  if (s1_manual) return;
  s1_tick++;
  if (s1_tick % 2 === 1 && s1_written < s1_N) {
    show("s1_c" + s1_written, 1, 2);
    s1_written++;
    moveTo("s1_leo", s1_written, s1_N + 1);
  }
  if (s1_tick % 3 === 0 && s1_posA < s1_written) { s1_posA++; moveTo("s1_a", s1_posA, s1_N + 1); }
  if (s1_tick % 5 === 0 && s1_posB < s1_written) { s1_posB++; moveTo("s1_b", s1_posB, s1_N + 1); }
  s1_stats();
  if (s1_written >= s1_N && s1_posA >= s1_N && s1_posB >= s1_N) {
    s1_manual = true;
    txt("s1_say", "${L.T(
      "Демонстрация закончилась. Жми «Сброс» и пробуй сам — кнопки настоящие.",
      "The demo is over. Press “Reset” and try it yourself — the buttons are real."
    )}");
  }
}

s1_stats();
TICKERS.push(s1_auto);
`;
  },
};
