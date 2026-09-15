/* Сторож языка: перехватывает весь текст, уходящий в PDF, и сам документный скрипт.
   Запуск: node --require ./check-language.js build.js ../dist/probe.pdf [ru]

   Три источника, потому что текст попадает в документ тремя путями:
   page.drawText (страница), addToPage (подпись виджета) и строковые литералы
   внутри документного JavaScript. Скрипт ещё и сохраняем на диск: строка с
   неэкранированной кавычкой ломает его целиком, а в просмотрщике это выглядит
   как «стенды просто не работают», без единого сообщения. */

const fs = require("fs");
const path = require("path");
const pdfLib = require("pdf-lib");

const seen = { page: [], widget: [], script: [] };
const OUT_JS = process.env.KV_DUMP_JS || "";

const origDraw = pdfLib.PDFPage.prototype.drawText;
pdfLib.PDFPage.prototype.drawText = function (s, o) {
  seen.page.push(String(s));
  return origDraw.call(this, s, o);
};

["PDFButton", "PDFTextField"].forEach((name) => {
  const cls = pdfLib[name];
  if (!cls || !cls.prototype.addToPage) return;
  const orig = cls.prototype.addToPage;
  cls.prototype.addToPage = function (...args) {
    if (typeof args[0] === "string") seen.widget.push(args[0]);
    return orig.apply(this, args);
  };
});

const origJs = pdfLib.PDFDocument.prototype.addJavaScript;
pdfLib.PDFDocument.prototype.addJavaScript = function (name, js) {
  String(js).replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (_, lit) => { seen.script.push(lit); return ""; });
  if (OUT_JS) {
    fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
    fs.writeFileSync(OUT_JS, String(js), "utf8");
  }
  return origJs.call(this, name, js);
};

process.on("exit", () => {
  const CYR = /[А-Яа-яЁё]/;
  const all = [];
  Object.keys(seen).forEach((k) => seen[k].forEach((s) => all.push([k, s])));
  const dirty = all.filter(([, s]) => CYR.test(s));
  console.log("--- текст документа: " + all.length + " строк " +
    "(страница " + seen.page.length + ", виджеты " + seen.widget.length +
    ", скрипт " + seen.script.length + ")");
  if (!dirty.length) {
    console.log("--- кириллицы нет");
  } else {
    console.log("--- КИРИЛЛИЦА В " + dirty.length + " строках:");
    dirty.slice(0, 30).forEach(([k, s]) => console.log("    [" + k + "] " + s.slice(0, 90)));
  }
  if (OUT_JS) console.log("--- скрипт документа сохранён: " + OUT_JS);
});
