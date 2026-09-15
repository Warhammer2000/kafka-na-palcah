/* Сборка «Kafka в PDF». Запуск: node build.js ../dist/kafka-v-pdf.pdf */

const L = require("./lib");
const { C, KEYS, PAGE, CELL, STEP } = L;

const OUT = process.argv[2] || "../dist/kafka-v-pdf.pdf";

/* Последовательность записей фиксирована — значит цвет и подпись каждой
   клетки известны заранее и запекаются в её окрашенное состояние. */
const SEQ = [
  { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u42", c: 0 }, { k: "u13", c: 2 },
  { k: "u42", c: 0 }, { k: "u07", c: 1 }, { k: "u91", c: 3 }, { k: "u42", c: 0 },
  { k: "u13", c: 2 }, { k: "u91", c: 3 }, { k: "u07", c: 1 }, { k: "u42", c: 0 },
  { k: "u55", c: 4 }, { k: "u13", c: 2 },
];
const N = SEQ.length;

(async () => {
  const ctx = await L.createDoc();
  const { fonts } = ctx;

  /* ================= страница 1 — обложка и самопроверка ================= */
  {
    const page = ctx.doc.addPage([PAGE.w, PAGE.h]);
    page.drawRectangle({ x: 0, y: 0, width: PAGE.w, height: PAGE.h, color: C.bg });
    page.drawRectangle({
      x: 28, y: 28, width: PAGE.w - 56, height: PAGE.h - 56,
      color: C.surface, borderColor: C.line, borderWidth: 1,
    });

    page.drawText("KAFKA НА ПАЛЬЦАХ", {
      x: 56, y: PAGE.h - 108, size: 9, font: fonts.monoBold, color: C.write, characterSpacing: 2,
    });
    page.drawText("Живые стенды", { x: 56, y: PAGE.h - 156, size: 40, font: fonts.bold, color: C.ink });
    page.drawText("внутри PDF-документа", { x: 56, y: PAGE.h - 200, size: 40, font: fonts.bold, color: C.ink });

    L.wrapText(page, "В PDF нет ни HTML, ни CSS — только поля форм и собственный JavaScript. Стенды на следующих страницах собраны из них: клетки лога это кнопки, движение — таймер, подписи — текстовые поля. Нажимай кнопки, они настоящие.", {
      x: 56, y: PAGE.h - 240, width: 520, size: 12, font: fonts.sans, color: C.muted, leading: 18,
    });

    /* самопроверка: если скрипты живы, поле перепишется само */
    L.tag(page, fonts, "проверка просмотрщика", 56, 228);
    L.readout(ctx, page, "probe", { x: 56, y: 192, w: 520, h: 30 }, {
      text: "Скрипты не запущены — здесь нужен Chrome, Edge или Acrobat Reader",
      size: 11,
    });

    L.wrapText(page, "Если строка выше сменилась на зелёную — всё работает. Если осталась такой, как есть, значит просмотрщик не умеет исполнять PDF-скрипты: так ведут себя Просмотр на macOS, встроенные читалки телефонов и предпросмотр внутри соцсетей. Скачай файл и открой в браузере.", {
      x: 56, y: 170, width: 520, size: 9.5, font: fonts.sans, color: C.faint, leading: 13,
    });

    page.drawText("warhammer2000.github.io/kafka-na-palcah", {
      x: 56, y: 60, size: 10, font: fonts.mono, color: C.read,
    });
    page.drawText("Полная версия — 15 глав в браузере", {
      x: 56, y: 46, size: 8, font: fonts.sans, color: C.faint,
    });

    /* декоративная лента-лог справа: статичная, показывает, о чём речь */
    for (let i = 0; i < 6; i++) {
      page.drawRectangle({
        x: 610 + i * 26, y: 300, width: 22, height: 22,
        color: KEYS[i], borderColor: KEYS[i], borderWidth: 1,
      });
      page.drawText(String(i), {
        x: 618 + i * 26, y: 288, size: 7, font: fonts.mono, color: C.faint,
      });
    }
    page.drawText("append-only", { x: 610, y: 330, size: 8, font: fonts.mono, color: C.faint });
  }

  /* ================= страница 2 — стенд «лог и закладки» ================= */
  {
    const page = L.addStand(ctx, {
      eyebrow: "стенд 01",
      title: "Лог, а не очередь",
      subtitle: "Чтение ничего не удаляет. Продюсер дописывает в конец, а каждый читатель держит собственную закладку и двигает только её. Отсюда и перемотка, и независимые потребители.",
    });

    const X0 = 100;   // место слева под подписи «партиция» и «offset»
    const Y = 330;

    /* метка конца лога */
    L.slider(ctx, page, "s1_leo", N + 1, X0, Y + CELL + 8, {
      w: L.CELL, h: 13, fill: C.surface, textColor: C.write, size: 7, borderWidth: 0,
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
      w: L.CELL, h: 13, fill: C.surface, textColor: C.read, size: 7, borderWidth: 0, caption: (i) => "A" + i,
    });
    L.slider(ctx, page, "s1_b", N + 1, X0, Y - 50, {
      w: L.CELL, h: 13, fill: C.surface, textColor: KEYS[3], size: 7, borderWidth: 0, caption: (i) => "B" + i,
    });

    L.tag(page, fonts, "группа A", X0 + N * STEP + 10, Y - 29, C.read);
    L.tag(page, fonts, "группа B", X0 + N * STEP + 10, Y - 47, KEYS[3]);
    L.tag(page, fonts, "конец лога", X0 + N * STEP + 10, Y + CELL + 11, C.write);
    L.tag(page, fonts, "offset", X0 - 44, Y - 12);
    L.tag(page, fonts, "партиция", X0 - 44, Y + 16, C.ink2);
    L.tag(page, fonts, "0", X0 - 44, Y + 6, C.ink2);

    /* показатели */
    const stats = [
      { n: "s1_written", l: "записей в логе", x: X0 },
      { n: "s1_laga", l: "lag группы A", x: X0 + 150 },
      { n: "s1_lagb", l: "lag группы B", x: X0 + 300 },
    ];
    stats.forEach((s) => {
      L.tag(page, fonts, s.l, s.x, 250);
      L.readout(ctx, ctx.doc.getPages()[1], s.n, { x: s.x, y: 222, w: 120, h: 24 }, {
        text: "0", size: 13, mono: true, align: "center",
      });
    });

    /* кнопки */
    const BY = 170;
    L.action(ctx, page, "s1_write", "Продюсер пишет", { x: X0, y: BY, w: 130, h: 30 },
      "s1_write();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s1_reada", "A читает", { x: X0 + 140, y: BY, w: 90, h: 30 },
      "s1_read('a');", { fill: C.read, border: C.read, textColor: C.white });
    L.action(ctx, page, "s1_readb", "B читает", { x: X0 + 238, y: BY, w: 90, h: 30 },
      "s1_read('b');", { fill: KEYS[3], border: KEYS[3], textColor: C.white });
    L.action(ctx, page, "s1_rew", "Перемотать A в начало", { x: X0 + 336, y: BY, w: 160, h: 30 },
      "s1_rewind();");
    L.action(ctx, page, "s1_reset", "Сброс", { x: X0 + 504, y: BY, w: 70, h: 30 },
      "s1_reset();");

    /* строка пояснения */
    L.readout(ctx, page, "s1_say", { x: X0, y: 120, w: PAGE.w - 112, h: 34 }, {
      text: "Демонстрация идёт сама — нажми любую кнопку, чтобы взять управление",
      size: 10.5,
    });

    L.wrapText(page, "Обрати внимание: когда A читает, клетка остаётся на месте — двигается только закладка. Кнопка перемотки возвращает A в начало, и вся история читается заново. В очереди такой кнопки не существует: там прочитанное удалено.", {
      x: X0, y: 100, width: PAGE.w - 112, size: 9, font: fonts.sans, color: C.faint, leading: 12,
    });
  }

  /* ================= документный скрипт ================= */
  const KEYNAMES = JSON.stringify(SEQ.map((r) => r.k));

  L.attachScript(ctx, "kafka", `
var N = ${N};
var KEYNAMES = ${KEYNAMES};
var written = 0, posA = 0, posB = 0;
var manual = false, tick = 0;

txt("probe", "Скрипты работают — стенды на следующих страницах живые");

function s1_stats() {
  txt("s1_written", written);
  txt("s1_laga", written - posA);
  txt("s1_lagb", written - posB);
}

function s1_write() {
  manual = true;
  if (written >= N) { txt("s1_say", "Лог заполнен до конца стенда. Нажми «Сброс», чтобы начать заново."); return; }
  show("s1_c" + written, 1, 2);
  written++;
  moveTo("s1_leo", written, N + 1);
  s1_stats();
  txt("s1_say", "Продюсер дописал «" + KEYNAMES[written - 1] + "» в конец лога: offset " + (written - 1) + ". Закладки читателей не сдвинулись — им это ещё предстоит прочитать.");
}

function s1_read(who) {
  manual = true;
  var pos = (who === "a") ? posA : posB;
  var name = (who === "a") ? "A" : "B";
  if (pos >= written) {
    txt("s1_say", "Группа " + name + " дочитала до конца лога (offset " + pos + "). Читать нечего, пока продюсер не допишет новое.");
    return;
  }
  if (who === "a") { posA++; moveTo("s1_a", posA, N + 1); }
  else { posB++; moveTo("s1_b", posB, N + 1); }
  s1_stats();
  txt("s1_say", "Группа " + name + " прочитала offset " + pos + " («" + KEYNAMES[pos] + "»). Запись осталась на месте — сдвинулась только закладка " + name + ", теперь она на " + ((who === "a") ? posA : posB) + ". Вторая группа этого даже не заметила.");
}

function s1_rewind() {
  manual = true;
  posA = 0;
  moveTo("s1_a", 0, N + 1);
  s1_stats();
  txt("s1_say", "Закладка A вернулась на offset 0 — вся история читается заново. Это и есть replay: записи никуда не делись.");
}

function s1_reset() {
  manual = true;
  for (var i = 0; i < N; i++) show("s1_c" + i, 0, 2);
  written = 0; posA = 0; posB = 0;
  moveTo("s1_leo", 0, N + 1);
  moveTo("s1_a", 0, N + 1);
  moveTo("s1_b", 0, N + 1);
  s1_stats();
  txt("s1_say", "Лог пуст. Нажимай «Продюсер пишет» и смотри, как расходятся закладки.");
}

/* автодемонстрация до первого клика */
function autoplay() {
  if (manual) return;
  tick++;
  if (tick % 2 === 1 && written < N) {
    show("s1_c" + written, 1, 2);
    written++;
    moveTo("s1_leo", written, N + 1);
  }
  if (tick % 3 === 0 && posA < written) { posA++; moveTo("s1_a", posA, N + 1); }
  if (tick % 5 === 0 && posB < written) { posB++; moveTo("s1_b", posB, N + 1); }
  s1_stats();
  if (written >= N && posA >= N && posB >= N) { manual = true; txt("s1_say", "Демонстрация закончилась. Жми «Сброс» и пробуй сам — кнопки настоящие."); return; }
  txt("s1_say", "Демонстрация идёт сама: продюсер пишет, группы читают в своём темпе. Нажми любую кнопку, чтобы взять управление.");
}

s1_stats();
app.setInterval("autoplay()", 700);
`);

  const size = await L.save(ctx, OUT);
  console.log("собрано: " + OUT + " — " + Math.round(size / 1024) + " КБ");
})();
