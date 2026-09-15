/* Сборка ОДНОГО стенда — для разработки и проверки в отрыве от остальных.
   Запуск: node build-one.js stands/02-keys.js ../dist/probe-02.pdf [ru] */

const path = require("path");
const L = require("./lib");

/* Язык снимаем ДО подключения стенда: заголовки модуля читаются при require. */
L.langFromArgv();

const MOD = process.argv[2];
const OUT = process.argv[3] && process.argv[3] !== "ru" && process.argv[3] !== "en"
  ? process.argv[3] : "../dist/one.pdf";

if (!MOD) {
  console.error("укажи модуль стенда: node build-one.js stands/02-keys.js out.pdf");
  process.exit(1);
}

(async () => {
  const stand = require(path.resolve(MOD));
  const ctx = await L.createDoc();

  const page = L.addStand(ctx, stand);
  const script = stand.build(ctx, L, page);

  // kvStart, а не голый app.setInterval: ссылку на интервал нужно держать,
  // иначе сборщик мусора Acrobat остановит анимацию.
  L.attachScript(ctx, "one", script + '\nkvStart(700);\n');

  const size = await L.save(ctx, OUT);
  console.log("стенд «" + L.pick(stand.title) + "» (" + L.lang() + ") собран: " +
    OUT + " — " + Math.round(size / 1024) + " КБ");
})().catch((e) => {
  console.error("СБОРКА УПАЛА: " + e.message);
  process.exit(1);
});
