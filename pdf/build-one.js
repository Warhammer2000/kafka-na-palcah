/* Сборка ОДНОГО стенда — для разработки и проверки в отрыве от остальных.
   Запуск: node build-one.js stands/02-keys.js ../dist/probe-02.pdf */

const path = require("path");
const L = require("./lib");

const MOD = process.argv[2];
const OUT = process.argv[3] || "../dist/one.pdf";

if (!MOD) {
  console.error("укажи модуль стенда: node build-one.js stands/02-keys.js out.pdf");
  process.exit(1);
}

(async () => {
  const stand = require(path.resolve(MOD));
  const ctx = await L.createDoc();

  const page = L.addStand(ctx, stand);
  const script = stand.build(ctx, L, page);

  L.attachScript(ctx, "one", script + '\napp.setInterval("kvTick()", 700);\n');

  const size = await L.save(ctx, OUT);
  console.log("стенд «" + stand.title + "» собран: " + OUT + " — " + Math.round(size / 1024) + " КБ");
})().catch((e) => {
  console.error("СБОРКА УПАЛА: " + e.message);
  process.exit(1);
});
