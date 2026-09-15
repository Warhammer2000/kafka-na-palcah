/* Сборка интерактивного PDF. Запуск: node build.js ../dist/kafka-v-pdf.pdf
   Стенды лежат по модулю на файл в stands/ и подключаются списком ниже. */

const fs = require("fs");
const path = require("path");
const L = require("./lib");
const { C, KEYS, PAGE } = L;

const OUT = process.argv[2] || "../dist/kafka-v-pdf.pdf";
const SITE = "warhammer2000.github.io/kafka-na-palcah";

/* Подключаем только те стенды, что уже написаны, — чтобы сборка не падала,
   пока остальные в работе. */
const STANDS = ["01-log", "02-keys", "03-lag", "04-acks"]
  .map((n) => {
    const f = path.join(__dirname, "stands", n + ".js");
    return fs.existsSync(f) ? require(f) : null;
  })
  .filter(Boolean);

/* ---------------- обложка ---------------- */

function cover(ctx) {
  const { fonts } = ctx;
  const page = L.guardPage(ctx, ctx.doc.addPage([PAGE.w, PAGE.h]), "обложка/финал");
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

  L.tag(page, fonts, "проверка просмотрщика", 56, 228);
  L.readout(ctx, page, "probe", { x: 56, y: 192, w: 520, h: 30 }, {
    text: "Скрипты не запущены — здесь нужен Chrome, Edge или Acrobat Reader",
    size: 11,
  });

  L.wrapText(page, "Если строка выше сменилась — всё работает. Если осталась такой, как есть, значит просмотрщик не умеет исполнять PDF-скрипты: так ведут себя Просмотр на macOS, встроенные читалки телефонов и предпросмотр внутри соцсетей. Скачай файл и открой в браузере на компьютере.", {
    x: 56, y: 170, width: 520, size: 9.5, font: fonts.sans, color: C.faint, leading: 13,
  });

  /* декоративная лента-лог: сразу показывает, о чём вообще речь */
  for (let i = 0; i < 6; i++) {
    page.drawRectangle({
      x: 610 + i * 26, y: 300, width: 22, height: 22,
      color: KEYS[i], borderColor: KEYS[i], borderWidth: 1,
    });
    page.drawText(String(i), { x: 618 + i * 26, y: 288, size: 7, font: fonts.mono, color: C.faint });
  }
  page.drawText("append-only", { x: 610, y: 330, size: 8, font: fonts.mono, color: C.faint });

  page.drawText("Листай дальше →", { x: 56, y: 60, size: 11, font: fonts.monoBold, color: C.write });
}

/* ---------------- финальная страница со ссылкой ---------------- */

function outro(ctx) {
  const { fonts } = ctx;
  const page = L.guardPage(ctx, ctx.doc.addPage([PAGE.w, PAGE.h]), "обложка/финал");
  page.drawRectangle({ x: 0, y: 0, width: PAGE.w, height: PAGE.h, color: C.bg });
  page.drawRectangle({
    x: 28, y: 28, width: PAGE.w - 56, height: PAGE.h - 56,
    color: C.surface, borderColor: C.line, borderWidth: 1,
  });

  page.drawText("ЭТО БЫЛА КОРОТКАЯ ВЕРСИЯ", {
    x: 56, y: PAGE.h - 108, size: 9, font: fonts.monoBold, color: C.write, characterSpacing: 2,
  });
  page.drawText("Полный разбор —", { x: 56, y: PAGE.h - 156, size: 34, font: fonts.bold, color: C.ink });
  page.drawText("пятнадцать глав в браузере", { x: 56, y: PAGE.h - 196, size: 34, font: fonts.bold, color: C.ink });

  L.wrapText(page, "Партиции и ключи, consumer groups и ребалансы, retention и compaction, лидер и ISR, acks и тихая потеря записи, диагностика lag по партициям, песочница и шпаргалка для собеседования. Всё интерактивное, открывается в любом браузере и работает на телефоне.", {
    x: 56, y: PAGE.h - 234, width: 560, size: 12, font: fonts.sans, color: C.muted, leading: 18,
  });

  page.drawRectangle({
    x: 56, y: 240, width: 560, height: 54,
    color: C.surface2, borderColor: C.write, borderWidth: 1.5,
  });
  page.drawText(SITE, { x: 76, y: 262, size: 17, font: fonts.mono, color: C.write });

  L.wrapText(page, "А этот PDF — побочный опыт: интерактив внутри документа собран из полей формы и документного JavaScript, потому что ни HTML, ни CSS в PDF не существует. Исходники сборщика лежат там же, в репозитории.", {
    x: 56, y: 206, width: 560, size: 9.5, font: fonts.sans, color: C.faint, leading: 13,
  });
}

/* ---------------- сборка ---------------- */

(async () => {
  const ctx = await L.createDoc();

  cover(ctx);

  let script = 'txt("probe", "Скрипты работают — стенды на следующих страницах живые");\n';

  for (const stand of STANDS) {
    const page = L.addStand(ctx, stand);
    script += "\n/* ---- " + stand.id + " ---- */\n" + stand.build(ctx, L, page);
  }

  outro(ctx);

  // Один таймер на весь документ: каждый стенд кладёт в TICKERS свою функцию.
  // Запуск только через kvStart: он держит возврат app.setInterval в переменной.
  // Брошенный возврат Acrobat считает мусором и собирает вместе с таймером —
  // стенды молча встают, а в Chrome/Edge этого не воспроизвести.
  script += '\nkvStart(700);\n';

  L.attachScript(ctx, "kafka", script);

  const size = await L.save(ctx, OUT);
  console.log("собрано: " + OUT + " — " + Math.round(size / 1024) + " КБ, стендов: " + STANDS.length);
})();
