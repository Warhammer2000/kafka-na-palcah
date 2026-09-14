/* Глава 01 — Лог, а не очередь. Эталонная сцена: показывает принятый стиль. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "log",
    num: 1,
    group: "Главная идея",
    nav: "Лог, а не очередь",
    title: "Забудь слово «очередь»",
    lede: "Kafka — это <b>лог</b>: файл, в который можно только дописывать в конец. Ничего не стирается и не вставляется в середину. Из одного этого свойства вырастает всё остальное.",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>Лог здесь — не «логи приложения», а структура данных. Как тетрадь, где ты пишешь строчку за строчкой и никогда ничего не стираешь.</p>" +
        "<p>В RabbitMQ сообщение <em>доставили и удалили</em>. В Kafka — <em>записали и оставили</em>. " +
        "Раз записи не удаляются, возникает вопрос: а как понять, кто что прочитал? Ответ: каждый читатель сам помнит свою позицию. " +
        "Как закладка в книге. Книга общая и никуда не девается, а закладки у всех свои.</p>"
      ));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: "Очередь против лога",
        hint: "Нажимай «читает» в обеих колонках и сравнивай"
      });

      var SEED = ["оплата", "заказ", "клик", "вход", "отказ", "заказ"];

      /* --- левая колонка: очередь --- */
      var qTrack = el("div.kv-strip__track", { style: { "padding-right": "8px" } });
      var qEmpty = el("div.kv-strip__empty", { text: "очередь пуста — сообщений больше нет" });
      var qStrip = el("div.kv-strip", { style: { "min-height": "60px", "padding-bottom": "6px" } }, qTrack, qEmpty);
      var queue = [];

      function renderQueue() {
        KV.clear(qTrack);
        queue.forEach(function (r) {
          var c = el("div.kv-cell", { title: r }, r.slice(0, 3));
          c.style.borderColor = util.keyColor(r);
          c.style.color = util.keyColor(r);
          c.style.background = util.keyColorSoft(r);
          qTrack.appendChild(el("div.kv-cellwrap", null, c));
        });
        qEmpty.classList.toggle("kv-hidden", queue.length > 0);
      }

      /* --- правая колонка: лог --- */
      var log = ui.logStrip({ empty: "лог пуст" });
      var posA = 0, posB = 0;

      function paintMarkers() {
        log.marker("A", { at: posA, label: "A " + posA, color: "var(--read)" });
        log.marker("B", { at: posB, label: "B " + posB, color: "var(--k3)" });
      }

      function reset() {
        queue = SEED.slice();
        renderQueue();
        log.setRecords(SEED.map(function (k) { return { key: k }; }));
        posA = 0; posB = 0;
        paintMarkers();
        stage.say("Слева и справа лежат одни и те же шесть событий. Дальше они поведут себя по-разному.");
      }

      /* --- действия --- */

      function queueRead(who) {
        if (!queue.length) {
          stage.say("<b>Очередь пуста.</b> Сообщения удалены при доставке — перечитать нечего, и второму читателю тоже ничего не досталось.");
          return;
        }
        var r = queue.shift();
        renderQueue();
        stage.say("<b>Очередь:</b> «" + util.escape(r) + "» доставлено читателю " + who +
          " и <b>удалено</b>. Осталось " + queue.length + ". Брокер помнит, что доставлено — читатель не помнит ничего.");
      }

      function logRead(who) {
        var pos = who === "A" ? posA : posB;
        if (pos >= log.records.length) {
          stage.say("<b>Лог:</b> читатель " + who + " дочитал до конца (offset " + pos +
            "). Записи на месте — как только продюсер допишет новую, он её и прочитает.");
          return;
        }
        log.highlight(pos, "is-reading", 700);
        var key = log.records[pos].key;
        if (who === "A") posA++; else posB++;
        paintMarkers();
        stage.say("<b>Лог:</b> читатель " + who + " прочитал offset " + pos + " («" + util.escape(key) +
          "»). Запись <b>осталась на месте</b> — сдвинулась только закладка " + who + ", до " +
          (who === "A" ? posA : posB) + ". Второй читатель этого даже не заметил.");
      }

      /* --- сборка --- */

      var left = ui.panel("RabbitMQ · очередь",
        el("div.kv-row", { style: { "margin-bottom": "6px" } },
          ui.badge("брокер помнит, что доставлено"),
          ui.badge("прочитано → удалено", "bad")),
        qStrip,
        el("div.kv-row", null,
          ui.btn("Читатель A читает", function () { queueRead("A"); }, { sm: true }),
          ui.btn("Читатель B читает", function () { queueRead("B"); }, { sm: true })));

      var right = ui.panel("Kafka · лог",
        el("div.kv-row", { style: { "margin-bottom": "6px" } },
          ui.badge("закладка у каждого своя", "read"),
          ui.badge("прочитано → осталось", "good")),
        log.el,
        el("div.kv-row", null,
          ui.btn("Читатель A читает", function () { logRead("A"); }, { sm: true, variant: "read" }),
          ui.btn("Читатель B читает", function () { logRead("B"); }, { sm: true }),
          ui.btn("Перемотать A в начало", function () {
            posA = 0; paintMarkers();
            stage.say("<b>Перемотка.</b> Закладка A вернулась на offset 0 — вся история читается заново. " +
              "В очереди такой кнопки не существует в принципе: перечитывать нечего.");
          }, { sm: true, variant: "ghost" })));

      stage.body.appendChild(el("div.kv-split", null, left, right));

      stage.controls.appendChild(ui.btn("Продюсер пишет новое событие", function () {
        var k = util.pick(["возврат", "оплата", "клик", "отказ"]);
        queue.push(k); renderQueue();
        log.push({ key: k });
        paintMarkers();
        stage.say("Продюсер дописал «" + util.escape(k) + "». Слева оно встало в хвост очереди; " +
          "справа получило <b>offset " + (log.records.length - 1) + "</b> и будет лежать там, пока не истечёт " +
          "<span class=\"kv-term\" tabindex=\"0\" data-term=\"retention\">retention</span>.");
      }, { variant: "primary" }));
      stage.controls.appendChild(ui.btn("Сбросить", reset, { variant: "ghost", sm: true }));

      reset();
      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(
        "<h3>Три следствия, ради которых Kafka вообще существует</h3>" +
        "<ul>" +
        "<li><strong>Можно перечитать прошлое.</strong> Поставил закладку в начало — прочитал всю историю заново.</li>" +
        "<li><strong>Много независимых читателей одного потока.</strong> Каждый со своей закладкой, в своём темпе, не мешая другим.</li>" +
        "<li><strong>Падение читателя ничего не рушит.</strong> Закладка сохранена: поднялся — продолжил с того же места.</li>" +
        "</ul>"
      ));

      root.appendChild(ui.note("key", "формула",
        "<p><strong>«Глупый брокер, умный консьюмер».</strong> Kafka просто хранит лог и не отслеживает, кто что прочитал — " +
        "это забота читателя. У Rabbit наоборот: брокер умный, он маршрутизирует и помнит, что доставлено.</p>"
      ));

      root.appendChild(ui.takeaway([
        "Kafka — <b>append-only log</b>: дописать в конец можно, стереть или вставить в середину нельзя.",
        "Чтение <b>не удаляет</b> запись. Запись живёт, пока не истечёт [[retention]].",
        "Позицию помнит <b>читатель</b>, а не брокер — отсюда перемотка, независимые группы и устойчивость к падениям."
      ]));
    }
  });
})();
