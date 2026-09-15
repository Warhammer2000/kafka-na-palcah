/* Глава 03 — Offset: координата записи, а не номер в очереди. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  var TOPIC = "orders";

  /* Три партиции одного топика. Длины РАЗНЫЕ — счётчики независимы.
     Ключ у каждой записи живёт только в своей партиции, как и положено.
     Собирается заново на каждую сборку главы: подписи событий двуязычны,
     а L() обязан читать язык в момент вызова, а не на загрузке файла. */
  function makeData() {
    return [
      [ /* партиция 0 — 7 записей */
        { k: "user-17", l: L("нов", "new"), v: L("создан заказ #4417", "order #4417 created") },
        { k: "user-17", l: L("опл", "pay"), v: L("оплата 4 200 ₽", "payment 4,200 ₽") },
        { k: "user-03", l: L("нов", "new"), v: L("создан заказ #4418", "order #4418 created") },
        { k: "user-17", l: L("дст", "shp"), v: L("передан в доставку", "shipped out") },
        { k: "user-03", l: L("опл", "pay"), v: L("оплата 990 ₽", "payment 990 ₽") },
        { k: "user-17", l: L("воз", "ref"), v: L("возврат 4 200 ₽", "refund 4,200 ₽") },
        { k: "user-03", l: L("пол", "dlv"), v: L("доставлен клиенту", "delivered to the customer") }
      ],
      [ /* партиция 1 — 9 записей */
        { k: "user-42", l: L("нов", "new"), v: L("создан заказ #4419", "order #4419 created") },
        { k: "user-42", l: L("опл", "pay"), v: L("оплата 12 900 ₽", "payment 12,900 ₽") },
        { k: "user-08", l: L("нов", "new"), v: L("создан заказ #4420", "order #4420 created") },
        { k: "user-42", l: L("прм", "prm"), v: L("применён промокод SPRING", "promo code SPRING applied") },
        { k: "user-08", l: L("опл", "pay"), v: L("оплата 350 ₽", "payment 350 ₽") },
        { k: "user-42", l: L("отм", "cnc"), v: L("отменён клиентом", "cancelled by the customer") },
        { k: "user-08", l: L("дст", "shp"), v: L("передан в доставку", "shipped out") },
        { k: "user-42", l: L("воз", "ref"), v: L("возврат 12 900 ₽", "refund 12,900 ₽") },
        { k: "user-08", l: L("пол", "dlv"), v: L("доставлен клиенту", "delivered to the customer") }
      ],
      [ /* партиция 2 — 4 записи */
        { k: "user-99", l: L("нов", "new"), v: L("создан заказ #4421", "order #4421 created") },
        { k: "user-99", l: L("опл", "pay"), v: L("оплата 79 ₽", "payment 79 ₽") },
        { k: "user-99", l: L("жлб", "cmp"), v: L("жалоба в поддержку", "complaint to support") },
        { k: "user-99", l: L("пол", "dlv"), v: L("доставлен клиенту", "delivered to the customer") }
      ]
    ];
  }

  /* Длины от языка не зависят — их можно снять один раз, на загрузке. */
  var LENS = makeData().map(function (p) { return p.length; });
  var MAXOFF = LENS.reduce(function (m, n) { return Math.max(m, n - 1); }, 0);
  var CUT = 3; /* сколько записей съест retention в партиции 0 */

  KV.scene({
    id: "offset",
    num: 3,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Устройство", "How it works"],
    nav: ["Offset", "Offset"],
    title: [
      "Offset — координата, а не номер в очереди",
      "Offset — a coordinate, not a place in a queue"
    ],
    lede: [
      "У каждой партиции свой счётчик записей, и он стартует с нуля. Поэтому <code>offset 5</code> сам по себе не адресует ничего: пятых в топике столько, сколько партиций доросло до этого номера.",
      "Every partition has its own record counter, and it starts at zero. That is why <code>offset 5</code> on its own addresses nothing: a topic holds as many fifth records as it has partitions that grew that far."
    ],

    build: function (root, api) {

      var DATA = makeData();
      /* Внутри build: и союз, и форма слова зависят от языка. */
      var LENS_TXT = LENS.slice(0, -1).join(", ") + L(" и ", " and ") + LENS[LENS.length - 1] + " " +
        util.plural(LENS[LENS.length - 1], L("запись", "record"), L("записи", "records"), L("записей", "records"));

      root.appendChild(ui.prose(L(
        "<p>Offset — самая простая вещь в Kafka: счётчик 0, 1, 2, 3… Брокер выдаёт номер в тот момент, " +
        "когда запись ложится в [[партиция|партицию]], и больше этот номер не трогает никогда.</p>" +
        "<p>Ловит людей само слово «номер». Номер намекает на очередь: пятый стоит за четвёртым, десятый где-то дальше. " +
        "Внутри одной партиции так и есть. Но партиций несколько, счётчик у каждой свой, и друг о друге они не знают ничего.</p>",

        "<p>The offset is the simplest thing in Kafka: a counter — 0, 1, 2, 3… The broker hands out the number the moment " +
        "the record lands in a [[partition]], and it never touches that number again.</p>" +
        "<p>What trips people up is the word “number”. A number hints at a queue: the fifth stands behind the fourth, the tenth is somewhere further on. " +
        "Inside one partition that is true. But there are several partitions, each counts on its own, and they know nothing about each other.</p>"
      )));

      root.appendChild(ui.note("key", L("закон", "the law"), L(
        "<p><strong>[[offset]] уникален внутри партиции, а не внутри [[топик|топика]].</strong> " +
        "В партиции 0 есть запись с offset 5, и в партиции 1 есть своя запись с offset 5. " +
        "Это два разных сообщения: разное содержимое, разные ключи, разное время. Общий у них только номер — и он ничего не значит.</p>",

        "<p><strong>An [[offset]] is unique inside a partition, not inside a [[topic]].</strong> " +
        "Partition 0 has a record with offset 5, and partition 1 has its own record with offset 5. " +
        "These are two different messages: different content, different keys, different time. All they share is the number — and it means nothing.</p>"
      )));

      /* ==================== стенд ==================== */

      var stage = ui.stage({
        title: L("Один offset — три разные записи", "One offset — three different records"),
        hint: L("Кликни любую клетку — покажет полный адрес",
          "Click any cell — it shows the full address")
      });

      var strips = [];
      var logWrap = el("div.kv-log");

      function makeRecords(pi) {
        return DATA[pi].map(function (d, i) {
          return {
            key: d.k, label: d.l, val: d.v, off: i,
            title: TOPIC + L(" · партиция ", " · partition ") + pi + " · offset " + i + " — " + d.v +
              L(" (ключ ", " (key ") + d.k + ")"
          };
        });
      }

      /* --- карточка адреса --- */

      var aTopic = ui.stat(L("топик", "topic"), TOPIC);
      var aPart = ui.stat(L("партиция", "partition"), "—");
      var aOff = ui.stat("offset", "—");
      var aWhat = el("div", {
        style: { "margin-top": "10px", "font-size": "13.5px", "line-height": "1.5" }
      });

      var addrCard = ui.panel(L("ПОЛНЫЙ АДРЕС ЗАПИСИ", "THE FULL ADDRESS OF A RECORD"),
        ui.stats(aTopic.el, aPart.el, aOff.el),
        aWhat);

      /* --- диапазоны offset по партициям --- */

      var rangeRow = el("div.kv-stats", { style: { "margin-top": "14px" } });

      function renderRanges() {
        KV.clear(rangeRow);
        strips.forEach(function (s, i) {
          var n = s.records.length;
          rangeRow.appendChild(ui.stat(
            L("партиция ", "partition ") + i + " · " + n + " " +
              util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records")),
            n ? s.base + "…" + (s.leo() - 1) : "—",
            { unit: n ? "offset" : "", tone: s.base > 0 ? "warn" : null }
          ).el);
        });
      }

      /* --- доступ к записи по адресу --- */

      function recordAt(pi, off) {
        var s = strips[pi];
        if (!s) return null;
        var i = off - s.base;
        if (i < 0 || i >= s.records.length) return null;
        return s.records[i];
      }

      function missReason(pi, off) {
        var s = strips[pi];
        if (off < s.base) {
          var cut = L("запись удалена по retention — лог партиции ",
            "the record was deleted by retention — the log of partition ");
          return cut + pi + L(" начинается с offset ", " starts at offset ") + s.base;
        }
        var n = s.records.length;
        var lead = L("в партиции ", "partition ");
        return lead + pi + L(" всего ", " holds only ") + n + " " +
          util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
          L(", последний offset — ", ", the last offset is ") + (s.leo() - 1);
      }

      function addrOf(pi, off) { return TOPIC + "-" + pi + ":" + off; }

      /* --- показать запись в карточке адреса --- */

      function showRecord(pi, off, silent) {
        var rec = recordAt(pi, off);
        aPart.set(pi, rec ? "read" : "bad");
        aOff.set(off, rec ? "read" : "bad");

        KV.clear(aWhat);
        KV.append(aWhat,
          el("b", {
            text: addrOf(pi, off),
            style: { "font-family": "var(--f-mono)", color: rec ? "var(--ink)" : "var(--bad)" }
          }),
          rec
            ? el("span", { text: " — " + rec.val })
            : el("span", {
                text: L(" — записи нет: ", " — no such record: ") + missReason(pi, off),
                style: { color: "var(--bad)" }
              }),
          rec ? el("span", {
            text: L(" · ключ ", " · key ") + rec.key,
            style: { color: "var(--faint)" }
          }) : null);

        if (silent) return;

        if (!rec) {
          stage.say("<code>" + addrOf(pi, off) + L("</code> — <b>пусто:</b> ", "</code> — <b>nothing there:</b> ") +
            missReason(pi, off) + L(". Партиции живут своей жизнью: длина у каждой своя.",
              ". Partitions live their own lives: each has its own length."));
          return;
        }

        strips[pi].highlight(off, "is-reading", 1400);

        var also = [];
        strips.forEach(function (s, i) { if (i !== pi && recordAt(i, off)) also.push(i); });

        stage.say("<code>" + addrOf(pi, off) + L("</code> — «", "</code> — “") + util.escape(rec.val) +
          L("», ключ <code>", "”, key <code>") +
          util.escape(rec.key) + "</code>.<br>" +
          L("Полный адрес — <b>тройка</b>: топик, партиция, offset. Убери любую часть, и запись не найти: ",
            "The full address is a <b>triple</b>: topic, partition, offset. Drop any part of it and the record is unreachable: ") +
          (also.length
            ? L("номер ", "number ") + off + L(" занят ещё и в ", " is taken in ") +
              (also.length === 1
                ? L("партиции ", "partition ") + also[0]
                : L("партициях ", "partitions ") + also.join(L(" и ", " and "))) +
              L(" — там лежат совсем другие события.", " as well — and completely different events sit there.")
            : L("номер ", "number ") + off +
              L(" сейчас есть только здесь, но это случайность длины — завтра его получат и соседи.",
                " exists only here right now, but that is an accident of length — tomorrow the neighbours will get it too.")));
      }

      /* --- лента партиции: клики и клавиатура --- */

      /* Ходим только через публичный s.cell(off): адрес клетки живёт
         в её собственном data-off, а не в порядке детей ленты. */
      function decorate(s) {
        for (var k = 0; k < s.records.length; k++) {
          var off = s.base + k;
          var c = s.cell(off);
          if (!c) continue;
          c.style.cursor = "pointer";
          c.setAttribute("tabindex", "0");
          c.setAttribute("role", "button");
          c.setAttribute("data-off", String(off));
        }
      }

      function offsetOfEvent(s, target) {
        var c = target && target.closest ? target.closest("[data-off]") : null;
        if (!c || !s.track.contains(c)) return null;
        var off = Number(c.getAttribute("data-off"));
        return isNaN(off) ? null : off;
      }

      for (var i = 0; i < DATA.length; i++) {
        (function (pi) {
          var s = ui.logStrip({
            label: L("партиция ", "partition ") + pi,
            sub: TOPIC,
            records: makeRecords(pi)
          });
          s.track.addEventListener("click", function (e) {
            var off = offsetOfEvent(s, e.target);
            if (off !== null) showRecord(pi, off);
          });
          s.track.addEventListener("keydown", function (e) {
            if (e.key !== "Enter" && e.key !== " ") return;
            var off = offsetOfEvent(s, e.target);
            if (off === null) return;
            e.preventDefault();
            showRecord(pi, off);
          });
          strips.push(s);
          logWrap.appendChild(s.el);
          decorate(s);
        })(i);
      }

      /* --- поиск одного offset во всех партициях --- */

      function findAll(off) {
        var found = [], lines = [];

        strips.forEach(function (s, pi) {
          var rec = recordAt(pi, off);
          if (rec) {
            found.push(pi);
            s.marker("find", { at: off, label: "offset " + off, color: "var(--read)" });
            api.timeout(110 * pi, function () { s.highlight(off, "is-reading", 1500); });
            lines.push("<code>" + addrOf(pi, off) + L("</code> — «", "</code> — “") + util.escape(rec.val) +
              L("», ключ <code>", "”, key <code>") + util.escape(rec.key) + "</code>");
          } else {
            s.removeMarker("find");
            lines.push("<code>" + addrOf(pi, off) +
              L("</code> — <b>нет такой записи</b>: ", "</code> — <b>no such record</b>: ") + missReason(pi, off));
          }
        });

        var head;
        if (found.length === strips.length) {
          head = "<b>offset " + off + L(" есть в каждой партиции — и это ",
            " exists in every partition — and these are ") + found.length +
            L(" разные записи, не связанные ничем:</b>", " different records with nothing in common:</b>");
        } else if (found.length === 0) {
          head = "<b>offset " + off + L(" не существует ни в одной партиции:</b>",
            " does not exist in any partition:</b>");
        } else {
          head = "<b>offset " + off + L(" нашёлся не везде</b> — счётчики независимы, длины разные:",
            " was not found everywhere</b> — the counters are independent, the lengths differ:");
        }

        if (found.length) {
          showRecord(found[0], off, true);
        } else {
          aPart.set("—", "bad"); aOff.set(off, "bad");
          KV.clear(aWhat);
          aWhat.appendChild(el("span", {
            text: "offset " + off + L(" не адресует ничего: ни в одной партиции такой записи нет.",
              " addresses nothing: no partition holds a record with that number."),
            style: { color: "var(--bad)" }
          }));
        }

        stage.say(head + "<br>" + lines.join("<br>") +
          L("<br>Одинаковый номер — совпадение счётчиков, а не родство записей.",
            "<br>The same number means the counters happened to meet, not that the records are related."));
      }

      /* --- «что было раньше» --- */

      function compare() {
        var a = recordAt(0, 5), b = recordAt(1, 5);
        offRange.set(5); syncFindLabel();
        if (!a || !b) { findAll(5); return; }

        strips[0].marker("find", { at: 5, label: "?", color: "var(--warn)" });
        strips[1].marker("find", { at: 5, label: "?", color: "var(--warn)" });
        strips[2].removeMarker("find");
        strips[0].highlight(5, "is-reading", 1600);
        api.timeout(140, function () { strips[1].highlight(5, "is-reading", 1600); });

        aPart.set(L("0 и 1", "0 and 1"), "warn"); aOff.set(5, "warn");
        KV.clear(aWhat);
        aWhat.appendChild(el("span", {
          text: L("два разных адреса с одинаковым номером — сравнить их нечем",
            "two different addresses with the same number — there is nothing to compare them by"),
          style: { color: "var(--warn)" }
        }));

        stage.say(L("<b>У вопроса нет ответа.</b> <code>", "<b>The question has no answer.</b> <code>") +
          addrOf(0, 5) + L("</code> — «", "</code> — “") + util.escape(a.val) +
          L("», <code>", "”, <code>") + addrOf(1, 5) + L("</code> — «", "</code> — “") +
          util.escape(b.val) + L("». ", "”. ") +
          L("Каждая пятая в <b>своём</b> логе, и только там номер что-то значит.<br>",
            "Each fifth record sits in <b>its own</b> log, and only there does the number mean anything.<br>") +
          L("Kafka не держит ни общего счётчика, ни доверенного времени между партициями: порядок существует " +
            "только внутри партиции. Между партициями сравнивать просто нечего.",
            "Kafka keeps neither a shared counter nor trusted time across partitions: order exists " +
            "only inside a partition. Between partitions there is simply nothing to compare."));
      }

      /* --- retention --- */

      var retBtn;

      function retention() {
        var s = strips[0];
        /* флажки предыдущего поиска/сравнения снимаем со ВСЕХ лент,
           иначе на соседней остаётся висеть половина пары «?». */
        strips.forEach(function (x) { x.clearMarkers(); });
        s.setRecords(makeRecords(0).slice(CUT));
        s.setBase(CUT);
        decorate(s);
        renderRanges();
        retBtn.disabled = true;

        showRecord(0, s.base, true);
        stage.say(L(
          "<b>retention удалил три самые старые записи партиции 0.</b> Смотри на номера под клетками: " +
          "оставшиеся как были <code>3 4 5 6</code> — так и остались. Перенумерации <b>нет</b>: " +
          "лог просто начинается не с нуля.<br>" +
          "Иначе рухнуло бы всё: <span class=\"kv-term\" tabindex=\"0\" data-term=\"committed offset\">committed offset</span> " +
          "каждой группы — это число, " +
          "и после сдвига нумерации оно указывало бы не туда. Запрос offset 0 теперь вернёт ошибку " +
          "<code>OffsetOutOfRange</code>, а не первую живую запись.",

          "<b>retention deleted the three oldest records of partition 0.</b> Look at the numbers under the cells: " +
          "the ones left were <code>3 4 5 6</code> — and that is what they stayed. There is <b>no</b> renumbering: " +
          "the log simply does not start at zero.<br>" +
          "Otherwise everything would fall apart: the <span class=\"kv-term\" tabindex=\"0\" data-term=\"committed offset\">committed offset</span> " +
          "of every group is a number, " +
          "and after a shift it would point at the wrong place. A request for offset 0 now returns an " +
          "<code>OffsetOutOfRange</code> error instead of the first surviving record."));
      }

      /* --- переход по введённому адресу --- */

      var addrInput = el("input.kv-input", {
        type: "text", value: "1:5", maxlength: "14",
        "aria-label": L("адрес записи: партиция и offset", "record address: partition and offset")
      });
      addrInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); goAddr(); }
      });

      function goAddr() {
        var raw = addrInput.value;
        var t = String(raw).trim().toLowerCase().replace(/^orders\s*[-:]?\s*/, "");
        var m = /^(\d+)\s*[:\-.\s]\s*(\d+)$/.exec(t);
        if (!m) {
          stage.say(L("Не разобрал адрес «", "Could not parse the address “") + util.escape(raw) +
            L("». Формат — <code>партиция:offset</code>, ", "”. The format is <code>partition:offset</code>, ") +
            L("например <code>1:5</code> или <code>orders-2:0</code>. ",
              "for example <code>1:5</code> or <code>orders-2:0</code>. ") +
            L("Одного числа мало: без партиции адрес не полон.",
              "One number is not enough: without a partition the address is incomplete."));
          return;
        }
        var pi = Number(m[1]), off = Number(m[2]);
        if (pi >= strips.length) {
          stage.say(L("В топике <code>", "Topic <code>") + TOPIC +
            L("</code> три партиции: 0, 1 и 2. Партиции ",
              "</code> has three partitions: 0, 1 and 2. There is no partition ") + pi +
            L(" нет — а значит, нет и адреса. Номер партиции — такая же обязательная часть адреса, как offset.",
              " — so there is no such address either. The partition number is as mandatory a part of the address as the offset."));
          return;
        }
        offRange.set(util.clamp(off, 0, MAXOFF));
        syncFindLabel();
        showRecord(pi, off);
      }

      /* --- контролы --- */

      var findBtn = ui.btn(L("Найти offset 5 во всех партициях", "Find offset 5 in every partition"), function () {
        findAll(offRange.value());
      }, { variant: "primary" });

      function syncFindLabel() {
        findBtn.textContent = L("Найти offset ", "Find offset ") + offRange.value() +
          L(" во всех партициях", " in every partition");
      }

      var offRange = ui.range({
        label: "offset", min: 0, max: MAXOFF, value: 5,
        onInput: function () { syncFindLabel(); }
      });

      retBtn = ui.btn(L("retention съел первые 3 записи партиции 0", "retention ate the first 3 records of partition 0"),
        retention, { sm: true, variant: "danger" });

      function reset() {
        strips.forEach(function (s, pi) {
          s.clearMarkers();
          s.setRecords(makeRecords(pi));
          s.setBase(0);
          decorate(s);
        });
        renderRanges();
        retBtn.disabled = false;
        offRange.set(5);
        syncFindLabel();
        showRecord(1, 5, true);
        stage.say(L("Три партиции топика <code>", "Three partitions of topic <code>") + TOPIC +
          L("</code>: в них ", "</code>: they hold ") + LENS_TXT + ". " +
          L("Нумерация у каждой своя и начинается с нуля. Нажми «Найти offset 5» — или кликни любую клетку.",
            "Each has its own numbering, and it starts at zero. Press “Find offset 5” — or click any cell."));
      }

      /* --- сборка стенда --- */

      stage.body.appendChild(addrCard);
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, logWrap));
      stage.body.appendChild(el("div", {
        style: {
          "margin-top": "10px", "font-family": "var(--f-mono)",
          "font-size": "11px", color: "var(--faint)"
        },
        text: L("в клетке — код события, под клеткой — offset, цвет клетки — ключ; наведи или кликни",
          "the cell shows the event code, the number under it is the offset, the colour is the key; hover or click")
      }));
      stage.body.appendChild(rangeRow);

      KV.append(stage.controls,
        offRange.el,
        findBtn,
        ui.btn(L("Что было раньше: orders-0:5 или orders-1:5?", "Which came first: orders-0:5 or orders-1:5?"),
          compare, { sm: true, variant: "read" }),
        ui.ctl(L("адрес", "address"), addrInput),
        ui.btn(L("Перейти", "Go"), goAddr, { sm: true }),
        retBtn,
        ui.btn(L("Сбросить", "Reset"), reset, { sm: true, variant: "ghost" }));

      reset();
      root.appendChild(stage.el);

      /* ==================== разбор ==================== */

      root.appendChild(ui.prose(L(
        "<h3>Почему нумерация не сдвигается</h3>" +
        "<p>[[retention]] удаляет записи <em>только с начала лога</em> и никогда не трогает номера оставшихся. " +
        "Лог начинается с offset 3 — и это нормальное состояние, у него даже есть имя: <code>log start offset</code>. " +
        "Конец лога — [[LEO]], номер, который получит следующая запись.</p>" +
        "<p>Если бы Kafka уплотняла нумерацию, каждая сохранённая позиция мгновенно стала бы враньём: " +
        "[[committed offset]] — это просто число, никак не привязанное к содержимому. " +
        "Группа, вернувшаяся после простоя, читала бы не то, что не дочитала, а случайный кусок. " +
        "Поэтому offset — <strong>идентификатор</strong>, а не индекс в массиве.</p>" +
        "<h4>Куда прыгает консьюмер, если его offset уже удалён</h4>" +
        "<p>Запрос записи ниже начала лога — ошибка <code>OffsetOutOfRange</code>. " +
        "Что делать дальше, решает настройка <code>auto.offset.reset</code>: " +
        "<code>earliest</code> — прыгнуть в начало живого лога (получишь гору старых сообщений), " +
        "<code>latest</code> — в конец (тихо потеряешь всё, что не дочитал), <code>none</code> — упасть с ошибкой.</p>",

        "<h3>Why the numbering never shifts</h3>" +
        "<p>[[retention]] deletes records <em>only from the start of the log</em> and never touches the numbers of the ones left. " +
        "A log that starts at offset 3 is a perfectly normal state — it even has a name: <code>log start offset</code>. " +
        "The end of the log is the [[LEO]], the number the next record will get.</p>" +
        "<p>If Kafka closed the gaps in the numbering, every saved position would instantly turn into a lie: " +
        "a [[committed offset]] is just a number, tied to no content at all. " +
        "A group coming back after downtime would read a random chunk instead of what it had not finished. " +
        "That is why an offset is an <strong>identifier</strong>, not an index into an array.</p>" +
        "<h4>Where a consumer jumps if its offset is already gone</h4>" +
        "<p>Asking for a record below the start of the log is an <code>OffsetOutOfRange</code> error. " +
        "What happens next is decided by the <code>auto.offset.reset</code> setting: " +
        "<code>earliest</code> — jump to the start of the surviving log (you get a mountain of old messages), " +
        "<code>latest</code> — to the end (you quietly lose everything you had not read), <code>none</code> — fail with an error.</p>"
      )));

      root.appendChild(ui.note("warn", L("ловушка", "trap"), L(
        "<p><strong>Offset — не бизнес-идентификатор.</strong> Записать в свою базу «обработали сообщение 5» " +
        "и позже по нему что-то искать нельзя: без топика и партиции это число не значит ничего, " +
        "а с ними — перестаёт значить после переезда на другой кластер или пересоздания топика: " +
        "те же события получат там другие номера.</p>" +
        "<p>Для дедупликации и ссылок нужен <em>свой</em> идентификатор внутри значения сообщения. " +
        "Offset — служебная координата Kafka, а не id события.</p>",

        "<p><strong>An offset is not a business identifier.</strong> Writing “processed message 5” into your own database " +
        "and looking something up by it later does not work: without the topic and the partition that number means nothing, " +
        "and even with them it stops meaning anything after a move to another cluster or a re-created topic: " +
        "the same events get different numbers there.</p>" +
        "<p>For deduplication and references you need your <em>own</em> identifier inside the message value. " +
        "An offset is Kafka’s internal coordinate, not the id of an event.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "[[offset]] — порядковый номер записи <b>внутри партиции</b>: 0, 1, 2… Присваивается при записи и не меняется никогда.",
          "Полный адрес записи — тройка <code>топик · партиция · offset</code>. Одного offset недостаточно, чтобы найти хоть что-нибудь.",
          "В каждой партиции есть свой offset 5, и это разные сообщения. Совпадение номеров не значит ровным счётом ничего.",
          "[[retention]] удаляет с начала лога, но <b>не перенумеровывает</b>: лог может начинаться с offset 3 — так и должно быть.",
          "Глобального порядка нет: «что было раньше, <code>orders-0:5</code> или <code>orders-1:5</code>» — вопрос без ответа."
        ],
        [
          "An [[offset]] is the sequential number of a record <b>inside a partition</b>: 0, 1, 2… It is assigned on write and never changes.",
          "The full address of a record is the triple <code>topic · partition · offset</code>. An offset alone is not enough to find anything at all.",
          "Every partition has its own offset 5, and those are different messages. Matching numbers mean absolutely nothing.",
          "[[retention]] deletes from the start of the log but <b>does not renumber</b>: a log may start at offset 3 — and that is how it should be.",
          "There is no global order: “which came first, <code>orders-0:5</code> or <code>orders-1:5</code>” is a question with no answer."
        ]
      )));
    }
  });
})();
