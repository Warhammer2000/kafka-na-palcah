/* Сборка интерактивного PDF. Запуск: node build.js ../dist/kafka-v-pdf.pdf
   Язык вторым аргументом: node build.js ../dist/kafka-v-pdf-ru.pdf ru
   Стенды лежат по модулю на файл в stands/ и подключаются списком ниже. */

const fs = require("fs");
const path = require("path");
const L = require("./lib");
L.langFromArgv();   // до всего остального: язык нужен уже в createDoc
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

  page.drawText(L.T("KAFKA НА ПАЛЬЦАХ", "KAFKA HANDS-ON"), {
    x: 56, y: PAGE.h - 108, size: 9, font: fonts.monoBold, color: C.write, characterSpacing: 2,
  });
  page.drawText(L.T("Живые стенды", "Live demos"),
    { x: 56, y: PAGE.h - 156, size: 40, font: fonts.bold, color: C.ink });
  page.drawText(L.T("внутри PDF-документа", "inside a PDF file"),
    { x: 56, y: PAGE.h - 200, size: 40, font: fonts.bold, color: C.ink });

  L.wrapText(page, L.T(
    "В PDF нет ни HTML, ни CSS — только поля форм и собственный JavaScript. Стенды на следующих страницах собраны из них: клетки лога это кнопки, движение — таймер, подписи — текстовые поля. Нажимай кнопки, они настоящие.",
    "A PDF has no HTML and no CSS — only form fields and its own JavaScript. The demos on the next pages are built out of them: log cells are buttons, motion is a timer, captions are text fields. Press the buttons, they are real."
  ), {
    x: 56, y: PAGE.h - 240, width: 520, size: 12, font: fonts.sans, color: C.muted, leading: 18,
  });

  L.tag(page, fonts, L.T("проверка просмотрщика", "viewer check"), 56, 228);
  L.readout(ctx, page, "probe", { x: 56, y: 192, w: 520, h: 30 }, {
    text: L.T("Скрипты не запущены — здесь нужен Chrome, Edge или Acrobat Reader",
      "Scripts are not running — this needs Chrome, Edge or Acrobat Reader"),
    size: 11,
  });

  L.wrapText(page, L.T(
    "Если строка выше сменилась — всё работает. Если осталась такой, как есть, значит просмотрщик не умеет исполнять PDF-скрипты: так ведут себя Просмотр на macOS, встроенные читалки телефонов и предпросмотр внутри соцсетей. Скачай файл и открой в браузере на компьютере.",
    "If the line above changed — everything works. If it stayed exactly as it is, the viewer cannot run PDF scripts: that is how Preview on macOS, the built-in readers on phones and the previews inside social apps behave. Download the file and open it in a browser on a computer."
  ), {
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

  page.drawText(L.T("Листай дальше →", "Keep scrolling →"),
    { x: 56, y: 60, size: 11, font: fonts.monoBold, color: C.write });
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

  page.drawText(L.T("ЭТО БЫЛА КОРОТКАЯ ВЕРСИЯ", "THAT WAS THE SHORT VERSION"), {
    x: 56, y: PAGE.h - 108, size: 9, font: fonts.monoBold, color: C.write, characterSpacing: 2,
  });
  page.drawText(L.T("Полный разбор —", "The full walkthrough —"),
    { x: 56, y: PAGE.h - 156, size: 34, font: fonts.bold, color: C.ink });
  page.drawText(L.T("пятнадцать глав в браузере", "fifteen chapters in a browser"),
    { x: 56, y: PAGE.h - 196, size: 34, font: fonts.bold, color: C.ink });

  L.wrapText(page, L.T(
    "Партиции и ключи, consumer groups и ребалансы, retention и compaction, лидер и ISR, acks и тихая потеря записи, диагностика lag по партициям, песочница и шпаргалка для собеседования. Всё интерактивное, открывается в любом браузере и работает на телефоне.",
    "Partitions and keys, consumer groups and rebalances, retention and compaction, leader and ISR, acks and the silently lost write, lag diagnosis partition by partition, a sandbox and a cheat sheet for interviews. All of it is interactive, opens in any browser and works on a phone."
  ), {
    x: 56, y: PAGE.h - 234, width: 560, size: 12, font: fonts.sans, color: C.muted, leading: 18,
  });

  page.drawRectangle({
    x: 56, y: 240, width: 560, height: 54,
    color: C.surface2, borderColor: C.write, borderWidth: 1.5,
  });
  page.drawText(SITE, { x: 76, y: 262, size: 17, font: fonts.mono, color: C.write });
  /* Нарисованный адрес читатель иначе перенабирает руками — а вся эта
     страница ради того, чтобы он дошёл до сайта. Показываем короткий адрес,
     а ведём с меткой языка: документ английский, значит и открыться должен
     английский, даже у читателя с русским браузером. */
  L.link(ctx, page, { x: 56, y: 240, w: 560, h: 54 },
    "https://" + SITE + "/?lang=" + L.lang());

  L.wrapText(page, L.T(
    "А этот PDF — побочный опыт: интерактив внутри документа собран из полей формы и документного JavaScript, потому что ни HTML, ни CSS в PDF не существует. Исходники сборщика лежат там же, в репозитории.",
    "And this PDF is a side experiment: the interactivity inside the document is made of form fields and document JavaScript, because a PDF has neither HTML nor CSS. The builder sources sit in the same repository."
  ), {
    x: 56, y: 206, width: 560, size: 9.5, font: fonts.sans, color: C.faint, leading: 13,
  });
}

/* ---------------- сборка ---------------- */

(async () => {
  const ctx = await L.createDoc();

  cover(ctx);

  let script = 'txt("probe", "' + L.T(
    "Скрипты работают — стенды на следующих страницах живые",
    "Scripts are running — the demos on the next pages are alive"
  ) + '");\n';

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
