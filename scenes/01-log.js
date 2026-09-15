/* Глава 01 — Лог, а не очередь. Эталонная сцена: показывает принятый стиль,
   в том числе двуязычие. Правило простое: всё, что видит читатель, идёт
   через L("по-русски", "in English"); комментарии и имена остаются русскими. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "log",
    num: 1,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Главная идея", "The big idea"],
    nav: ["Лог, а не очередь", "A log, not a queue"],
    title: ["Забудь слово «очередь»", "Forget the word “queue”"],
    lede: [
      "Kafka — это <b>лог</b>: файл, в который можно только дописывать в конец. Ничего не стирается и не вставляется в середину. Из одного этого свойства вырастает всё остальное.",
      "Kafka is a <b>log</b>: a file you can only add to at the end. Nothing is erased, nothing is inserted in the middle. Everything else grows out of that one property."
    ],

    build: function (root, api) {

      root.appendChild(ui.prose(L(
        "<p>Лог здесь — не «логи приложения», а структура данных. Как тетрадь, где ты пишешь строчку за строчкой и никогда ничего не стираешь.</p>" +
        "<p>В RabbitMQ сообщение <em>доставили и удалили</em>. В Kafka — <em>записали и оставили</em>. " +
        "Раз записи не удаляются, возникает вопрос: а как понять, кто что прочитал? Ответ: каждый читатель сам помнит свою позицию. " +
        "Как закладка в книге. Книга общая и никуда не девается, а закладки у всех свои.</p>",

        "<p>“Log” here does not mean application logs — it means a data structure. Like a notebook where you write line after line and never erase anything.</p>" +
        "<p>In RabbitMQ a message is <em>delivered and deleted</em>. In Kafka it is <em>written and kept</em>. " +
        "And since nothing is deleted, one question follows: how do you tell who has read what? The answer: every reader remembers its own position. " +
        "Like a bookmark in a book. The book is shared and stays where it is; the bookmarks are personal.</p>"
      )));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: L("Очередь против лога", "Queue versus log"),
        hint: L("Нажимай «читает» в обеих колонках и сравнивай",
          "Press “reads” in both columns and compare")
      });

      var SEED = L(
        ["оплата", "заказ", "клик", "вход", "отказ", "заказ"],
        ["payment", "order", "click", "login", "reject", "order"]
      );

      /* --- левая колонка: очередь --- */
      var qTrack = el("div.kv-strip__track", { style: { "padding-right": "8px" } });
      var qEmpty = el("div.kv-strip__empty", {
        text: L("очередь пуста — сообщений больше нет", "the queue is empty — no messages left")
      });
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
      var log = ui.logStrip({ empty: L("лог пуст", "the log is empty") });
      var posA = 0, posB = 0;
      var qGot = { A: 0, B: 0 };   // кому сколько досталось из очереди

      function paintMarkers() {
        log.marker("A", { at: posA, label: "A " + posA, color: "var(--read)" });
        log.marker("B", { at: posB, label: "B " + posB, color: "var(--k3)" });
      }

      function reset() {
        queue = SEED.slice();
        qGot.A = 0; qGot.B = 0;
        renderQueue();
        log.setRecords(SEED.map(function (k) { return { key: k }; }));
        posA = 0; posB = 0;
        paintMarkers();
        stage.say(L(
          "Слева и справа лежат одни и те же шесть событий. Дальше они поведут себя по-разному.",
          "The same six events sit on the left and on the right. From here on they behave differently."
        ));
      }

      /* --- действия --- */

      function queueRead(who) {
        if (!queue.length) {
          /* Итог считаем из фактической раздачи, а не заготовленной фразой:
             второй читатель мог вычерпать половину очереди сам. */
          var total = qGot.A + qGot.B;
          var other = who === "A" ? "B" : "A";
          stage.say(L("<b>Очередь пуста.</b> Все ", "<b>The queue is empty.</b> All ") + total + " " +
            util.plural(total, L("сообщение", "message"), L("сообщения", "messages"), L("сообщений", "messages")) +
            L(" уже доставлены и удалены: читателю A — ", " have been delivered and deleted: ") + qGot.A +
            L(", читателю B — ", " went to reader A, ") + qGot.B +
            L(". Каждое досталось <b>ровно одному</b> — ни перечитать его, ни отдать читателю ",
              " to reader B. Each one went to <b>exactly one</b> of them — the broker can neither replay it nor hand it to reader ") +
            other + L(" брокер уже не может.", " now."));
          return;
        }
        var r = queue.shift();
        qGot[who]++;
        renderQueue();
        stage.say(L("<b>Очередь:</b> «", "<b>Queue:</b> “") + util.escape(r) +
          L("» доставлено читателю ", "” was delivered to reader ") + who +
          L(" и <b>удалено</b>. Осталось ", " and <b>deleted</b>. ") + queue.length +
          L(". Брокер помнит, что доставлено — читатель не помнит ничего.",
            " left. The broker remembers what was delivered — the reader remembers nothing."));
      }

      function logRead(who) {
        var pos = who === "A" ? posA : posB;
        if (pos >= log.records.length) {
          stage.say(L("<b>Лог:</b> читатель ", "<b>Log:</b> reader ") + who +
            L(" дочитал до конца (offset ", " has read to the end (offset ") + pos +
            L("). Записи на месте — как только продюсер допишет новую, он её и прочитает.",
              "). The records are still there — as soon as the producer appends a new one, this reader will read it."));
          return;
        }
        log.highlight(pos, "is-reading", 700);
        var key = log.records[pos].key;
        if (who === "A") posA++; else posB++;
        paintMarkers();
        stage.say(L("<b>Лог:</b> читатель ", "<b>Log:</b> reader ") + who +
          L(" прочитал offset ", " read offset ") + pos +
          " (" + L("«", "“") + util.escape(key) + L("»", "”") + ")." +
          L(" Запись <b>осталась на месте</b> — сдвинулась только закладка ",
            " The record <b>stayed where it was</b> — only bookmark ") + who +
          L(", до ", " moved, to ") + (who === "A" ? posA : posB) +
          L(". Второй читатель этого даже не заметил.", ". The other reader did not even notice."));
      }

      /* --- сборка --- */

      var readerA = L("Читатель A читает", "Reader A reads");
      var readerB = L("Читатель B читает", "Reader B reads");

      var left = ui.panel(L("RabbitMQ · очередь", "RabbitMQ · queue"),
        el("div.kv-row", { style: { "margin-bottom": "6px" } },
          ui.badge(L("брокер помнит, что доставлено", "the broker remembers what it delivered")),
          ui.badge(L("прочитано → удалено", "read → deleted"), "bad")),
        qStrip,
        el("div.kv-row", null,
          ui.btn(readerA, function () { queueRead("A"); }, { sm: true }),
          ui.btn(readerB, function () { queueRead("B"); }, { sm: true })));

      var right = ui.panel(L("Kafka · лог", "Kafka · log"),
        el("div.kv-row", { style: { "margin-bottom": "6px" } },
          ui.badge(L("закладка у каждого своя", "every reader has its own bookmark"), "read"),
          ui.badge(L("прочитано → осталось", "read → still there"), "good")),
        log.el,
        el("div.kv-row", null,
          ui.btn(readerA, function () { logRead("A"); }, { sm: true, variant: "read" }),
          ui.btn(readerB, function () { logRead("B"); }, { sm: true }),
          ui.btn(L("Перемотать A в начало", "Rewind A to the start"), function () {
            posA = 0; paintMarkers();
            stage.say(L(
              "<b>Перемотка.</b> Закладка A вернулась на offset 0 — вся история читается заново. " +
              "В очереди такой кнопки не существует в принципе: перечитывать нечего.",
              "<b>Rewind.</b> Bookmark A is back at offset 0 — the whole history can be read again. " +
              "A queue cannot have this button at all: there is nothing left to re-read."
            ));
          }, { sm: true, variant: "ghost" })));

      stage.body.appendChild(el("div.kv-split", null, left, right));

      stage.controls.appendChild(ui.btn(L("Продюсер пишет новое событие", "Producer writes a new event"), function () {
        var k = util.pick(L(
          ["возврат", "оплата", "клик", "отказ"],
          ["refund", "payment", "click", "reject"]
        ));
        queue.push(k); renderQueue();
        log.push({ key: k });
        paintMarkers();
        stage.say(L("Продюсер дописал «", "The producer appended “") + util.escape(k) +
          L("». Слева оно встало в хвост очереди; справа получило <b>offset ",
            "”. On the left it joined the tail of the queue; on the right it got <b>offset ") +
          (log.records.length - 1) +
          L("</b> и будет лежать там, пока не истечёт ", "</b> and will stay there until ") +
          "<span class=\"kv-term\" tabindex=\"0\" data-term=\"retention\">retention</span>" +
          L(".", " expires."));
      }, { variant: "primary" }));
      stage.controls.appendChild(ui.btn(L("Сбросить", "Reset"), reset, { variant: "ghost", sm: true }));

      reset();
      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(L(
        "<h3>Три следствия, ради которых Kafka вообще существует</h3>" +
        "<ul>" +
        "<li><strong>Можно перечитать прошлое.</strong> Поставил закладку в начало — прочитал всю историю заново.</li>" +
        "<li><strong>Много независимых читателей одного потока.</strong> Каждый со своей закладкой, в своём темпе, не мешая другим.</li>" +
        "<li><strong>Падение читателя ничего не рушит.</strong> Закладка сохранена: поднялся — продолжил с того же места.</li>" +
        "</ul>",

        "<h3>The three consequences Kafka exists for</h3>" +
        "<ul>" +
        "<li><strong>You can re-read the past.</strong> Move the bookmark back to the start and the whole history is read again.</li>" +
        "<li><strong>Many independent readers of one stream.</strong> Each with its own bookmark, at its own pace, without disturbing the others.</li>" +
        "<li><strong>A reader crashing breaks nothing.</strong> The bookmark is saved: it comes back up and carries on from the same place.</li>" +
        "</ul>"
      )));

      root.appendChild(ui.note("key", L("формула", "formula"), L(
        "<p><strong>«Глупый брокер, умный консьюмер».</strong> Kafka просто хранит лог и не отслеживает, кто что прочитал — " +
        "это забота читателя. У Rabbit наоборот: брокер умный, он маршрутизирует и помнит, что доставлено.</p>",

        "<p><strong>“Dumb broker, smart consumer”.</strong> Kafka just stores the log and does not track who read what — " +
        "that is the reader's job. Rabbit is the other way round: the broker is smart, it routes and it remembers what it delivered.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "Kafka — <b>append-only log</b>: дописать в конец можно, стереть или вставить в середину нельзя.",
          "Чтение <b>не удаляет</b> запись. Запись живёт, пока не истечёт [[retention]].",
          "Позицию помнит <b>читатель</b>, а не брокер — отсюда перемотка, независимые группы и устойчивость к падениям."
        ],
        [
          "Kafka is an <b>append-only log</b>: you can add at the end, you cannot erase or insert in the middle.",
          "Reading <b>does not delete</b> a record. It lives until [[retention]] expires.",
          "The position is remembered by the <b>reader</b>, not the broker — hence rewinding, independent groups and surviving crashes."
        ]
      )));
    }
  });
})();
