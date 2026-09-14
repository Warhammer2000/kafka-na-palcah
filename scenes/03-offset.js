/* Глава 03 — Offset: координата записи, а не номер в очереди. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  var TOPIC = "orders";

  /* Три партиции одного топика. Длины РАЗНЫЕ — счётчики независимы.
     Ключ у каждой записи живёт только в своей партиции, как и положено. */
  var DATA = [
    [ /* партиция 0 — 7 записей */
      { k: "user-17", l: "нов", v: "создан заказ #4417" },
      { k: "user-17", l: "опл", v: "оплата 4 200 ₽" },
      { k: "user-03", l: "нов", v: "создан заказ #4418" },
      { k: "user-17", l: "дст", v: "передан в доставку" },
      { k: "user-03", l: "опл", v: "оплата 990 ₽" },
      { k: "user-17", l: "воз", v: "возврат 4 200 ₽" },
      { k: "user-03", l: "пол", v: "доставлен клиенту" }
    ],
    [ /* партиция 1 — 9 записей */
      { k: "user-42", l: "нов", v: "создан заказ #4419" },
      { k: "user-42", l: "опл", v: "оплата 12 900 ₽" },
      { k: "user-08", l: "нов", v: "создан заказ #4420" },
      { k: "user-42", l: "прм", v: "применён промокод SPRING" },
      { k: "user-08", l: "опл", v: "оплата 350 ₽" },
      { k: "user-42", l: "отм", v: "отменён клиентом" },
      { k: "user-08", l: "дст", v: "передан в доставку" },
      { k: "user-42", l: "воз", v: "возврат 12 900 ₽" },
      { k: "user-08", l: "пол", v: "доставлен клиенту" }
    ],
    [ /* партиция 2 — 4 записи */
      { k: "user-99", l: "нов", v: "создан заказ #4421" },
      { k: "user-99", l: "опл", v: "оплата 79 ₽" },
      { k: "user-99", l: "жлб", v: "жалоба в поддержку" },
      { k: "user-99", l: "пол", v: "доставлен клиенту" }
    ]
  ];

  var MAXOFF = DATA.reduce(function (m, p) { return Math.max(m, p.length - 1); }, 0);
  var CUT = 3; /* сколько записей съест retention в партиции 0 */

  var LENS = DATA.map(function (p) { return p.length; });
  var LENS_TXT = LENS.slice(0, -1).join(", ") + " и " + LENS[LENS.length - 1] + " " +
    util.plural(LENS[LENS.length - 1], "запись", "записи", "записей");

  KV.scene({
    id: "offset",
    num: 3,
    group: "Устройство",
    nav: "Offset",
    title: "Offset — координата, а не номер в очереди",
    lede: "У каждой партиции свой счётчик записей, и он стартует с нуля. Поэтому <code>offset 5</code> сам по себе не адресует ничего: пятых в топике столько, сколько партиций доросло до этого номера.",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>Offset — самая простая вещь в Kafka: счётчик 0, 1, 2, 3… Брокер выдаёт номер в тот момент, " +
        "когда запись ложится в [[партиция|партицию]], и больше этот номер не трогает никогда.</p>" +
        "<p>Ловит людей само слово «номер». Номер намекает на очередь: пятый стоит за четвёртым, десятый где-то дальше. " +
        "Внутри одной партиции так и есть. Но партиций несколько, счётчик у каждой свой, и друг о друге они не знают ничего.</p>"
      ));

      root.appendChild(ui.note("key", "закон",
        "<p><strong>[[offset]] уникален внутри партиции, а не внутри [[топик|топика]].</strong> " +
        "В партиции 0 есть запись с offset 5, и в партиции 1 есть своя запись с offset 5. " +
        "Это два разных сообщения: разное содержимое, разные ключи, разное время. Общий у них только номер — и он ничего не значит.</p>"
      ));

      /* ==================== стенд ==================== */

      var stage = ui.stage({
        title: "Один offset — три разные записи",
        hint: "Кликни любую клетку — покажет полный адрес"
      });

      var strips = [];
      var logWrap = el("div.kv-log");

      function makeRecords(pi) {
        return DATA[pi].map(function (d, i) {
          return {
            key: d.k, label: d.l, val: d.v, off: i,
            title: TOPIC + " · партиция " + pi + " · offset " + i + " — " + d.v + " (ключ " + d.k + ")"
          };
        });
      }

      /* --- карточка адреса --- */

      var aTopic = ui.stat("топик", TOPIC);
      var aPart = ui.stat("партиция", "—");
      var aOff = ui.stat("offset", "—");
      var aWhat = el("div", {
        style: { "margin-top": "10px", "font-size": "13.5px", "line-height": "1.5" }
      });

      var addrCard = ui.panel("ПОЛНЫЙ АДРЕС ЗАПИСИ",
        ui.stats(aTopic.el, aPart.el, aOff.el),
        aWhat);

      /* --- диапазоны offset по партициям --- */

      var rangeRow = el("div.kv-stats", { style: { "margin-top": "14px" } });

      function renderRanges() {
        KV.clear(rangeRow);
        strips.forEach(function (s, i) {
          var n = s.records.length;
          rangeRow.appendChild(ui.stat(
            "партиция " + i + " · " + n + " " + util.plural(n, "запись", "записи", "записей"),
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
          return "запись удалена по retention — лог партиции " + pi + " начинается с offset " + s.base;
        }
        var n = s.records.length;
        return "в партиции " + pi + " всего " + n + " " + util.plural(n, "запись", "записи", "записей") +
          ", последний offset — " + (s.leo() - 1);
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
            : el("span", { text: " — записи нет: " + missReason(pi, off), style: { color: "var(--bad)" } }),
          rec ? el("span", { text: " · ключ " + rec.key, style: { color: "var(--faint)" } }) : null);

        if (silent) return;

        if (!rec) {
          stage.say("<code>" + addrOf(pi, off) + "</code> — <b>пусто:</b> " +
            missReason(pi, off) + ". Партиции живут своей жизнью: длина у каждой своя.");
          return;
        }

        strips[pi].highlight(off, "is-reading", 1400);

        var also = [];
        strips.forEach(function (s, i) { if (i !== pi && recordAt(i, off)) also.push(i); });

        stage.say("<code>" + addrOf(pi, off) + "</code> — «" + util.escape(rec.val) + "», ключ <code>" +
          util.escape(rec.key) + "</code>.<br>" +
          "Полный адрес — <b>тройка</b>: топик, партиция, offset. Убери любую часть, и запись не найти: " +
          (also.length
            ? "номер " + off + " занят ещё и в " +
              (also.length === 1 ? "партиции " + also[0] : "партициях " + also.join(" и ")) +
              " — там лежат совсем другие события."
            : "номер " + off + " сейчас есть только здесь, но это случайность длины — завтра его получат и соседи."));
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
            label: "партиция " + pi,
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
            lines.push("<code>" + addrOf(pi, off) + "</code> — «" + util.escape(rec.val) +
              "», ключ <code>" + util.escape(rec.key) + "</code>");
          } else {
            s.removeMarker("find");
            lines.push("<code>" + addrOf(pi, off) + "</code> — <b>нет такой записи</b>: " + missReason(pi, off));
          }
        });

        var head;
        if (found.length === strips.length) {
          head = "<b>offset " + off + " есть в каждой партиции — и это " + found.length +
            " разные записи, не связанные ничем:</b>";
        } else if (found.length === 0) {
          head = "<b>offset " + off + " не существует ни в одной партиции:</b>";
        } else {
          head = "<b>offset " + off + " нашёлся не везде</b> — счётчики независимы, длины разные:";
        }

        if (found.length) {
          showRecord(found[0], off, true);
        } else {
          aPart.set("—", "bad"); aOff.set(off, "bad");
          KV.clear(aWhat);
          aWhat.appendChild(el("span", {
            text: "offset " + off + " не адресует ничего: ни в одной партиции такой записи нет.",
            style: { color: "var(--bad)" }
          }));
        }

        stage.say(head + "<br>" + lines.join("<br>") +
          "<br>Одинаковый номер — совпадение счётчиков, а не родство записей.");
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

        aPart.set("0 и 1", "warn"); aOff.set(5, "warn");
        KV.clear(aWhat);
        aWhat.appendChild(el("span", {
          text: "два разных адреса с одинаковым номером — сравнить их нечем",
          style: { color: "var(--warn)" }
        }));

        stage.say("<b>У вопроса нет ответа.</b> <code>" + addrOf(0, 5) + "</code> — «" + util.escape(a.val) +
          "», <code>" + addrOf(1, 5) + "</code> — «" + util.escape(b.val) + "». " +
          "Каждая пятая в <b>своём</b> логе, и только там номер что-то значит.<br>" +
          "Kafka не держит ни общего счётчика, ни доверенного времени между партициями: порядок существует " +
          "только внутри партиции. Между партициями сравнивать просто нечего.");
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
        stage.say("<b>retention удалил три самые старые записи партиции 0.</b> Смотри на номера под клетками: " +
          "оставшиеся как были <code>3 4 5 6</code> — так и остались. Перенумерации <b>нет</b>: " +
          "лог просто начинается не с нуля.<br>" +
          "Иначе рухнуло бы всё: <span class=\"kv-term\" tabindex=\"0\" data-term=\"committed offset\">committed offset</span> " +
          "каждой группы — это число, " +
          "и после сдвига нумерации оно указывало бы не туда. Запрос offset 0 теперь вернёт ошибку " +
          "<code>OffsetOutOfRange</code>, а не первую живую запись.");
      }

      /* --- переход по введённому адресу --- */

      var addrInput = el("input.kv-input", {
        type: "text", value: "1:5", maxlength: "14",
        "aria-label": "адрес записи: партиция и offset"
      });
      addrInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); goAddr(); }
      });

      function goAddr() {
        var raw = addrInput.value;
        var t = String(raw).trim().toLowerCase().replace(/^orders\s*[-:]?\s*/, "");
        var m = /^(\d+)\s*[:\-.\s]\s*(\d+)$/.exec(t);
        if (!m) {
          stage.say("Не разобрал адрес «" + util.escape(raw) + "». Формат — <code>партиция:offset</code>, " +
            "например <code>1:5</code> или <code>orders-2:0</code>. " +
            "Одного числа мало: без партиции адрес не полон.");
          return;
        }
        var pi = Number(m[1]), off = Number(m[2]);
        if (pi >= strips.length) {
          stage.say("В топике <code>" + TOPIC + "</code> три партиции: 0, 1 и 2. Партиции " + pi +
            " нет — а значит, нет и адреса. Номер партиции — такая же обязательная часть адреса, как offset.");
          return;
        }
        offRange.set(util.clamp(off, 0, MAXOFF));
        syncFindLabel();
        showRecord(pi, off);
      }

      /* --- контролы --- */

      var findBtn = ui.btn("Найти offset 5 во всех партициях", function () {
        findAll(offRange.value());
      }, { variant: "primary" });

      function syncFindLabel() {
        findBtn.textContent = "Найти offset " + offRange.value() + " во всех партициях";
      }

      var offRange = ui.range({
        label: "offset", min: 0, max: MAXOFF, value: 5,
        onInput: function () { syncFindLabel(); }
      });

      retBtn = ui.btn("retention съел первые 3 записи партиции 0", retention, { sm: true, variant: "danger" });

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
        stage.say("Три партиции топика <code>" + TOPIC + "</code>: в них " + LENS_TXT + ". " +
          "Нумерация у каждой своя и начинается с нуля. Нажми «Найти offset 5» — или кликни любую клетку.");
      }

      /* --- сборка стенда --- */

      stage.body.appendChild(addrCard);
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, logWrap));
      stage.body.appendChild(el("div", {
        style: {
          "margin-top": "10px", "font-family": "var(--f-mono)",
          "font-size": "11px", color: "var(--faint)"
        },
        text: "в клетке — код события, под клеткой — offset, цвет клетки — ключ; наведи или кликни"
      }));
      stage.body.appendChild(rangeRow);

      KV.append(stage.controls,
        offRange.el,
        findBtn,
        ui.btn("Что было раньше: orders-0:5 или orders-1:5?", compare, { sm: true, variant: "read" }),
        ui.ctl("адрес", addrInput),
        ui.btn("Перейти", goAddr, { sm: true }),
        retBtn,
        ui.btn("Сбросить", reset, { sm: true, variant: "ghost" }));

      reset();
      root.appendChild(stage.el);

      /* ==================== разбор ==================== */

      root.appendChild(ui.prose(
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
        "<code>latest</code> — в конец (тихо потеряешь всё, что не дочитал), <code>none</code> — упасть с ошибкой.</p>"
      ));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>Offset — не бизнес-идентификатор.</strong> Записать в свою базу «обработали сообщение 5» " +
        "и позже по нему что-то искать нельзя: без топика и партиции это число не значит ничего, " +
        "а с ними — перестаёт значить после переезда на другой кластер или пересоздания топика: " +
        "те же события получат там другие номера.</p>" +
        "<p>Для дедупликации и ссылок нужен <em>свой</em> идентификатор внутри значения сообщения. " +
        "Offset — служебная координата Kafka, а не id события.</p>"
      ));

      root.appendChild(ui.takeaway([
        "[[offset]] — порядковый номер записи <b>внутри партиции</b>: 0, 1, 2… Присваивается при записи и не меняется никогда.",
        "Полный адрес записи — тройка <code>топик · партиция · offset</code>. Одного offset недостаточно, чтобы найти хоть что-нибудь.",
        "В каждой партиции есть свой offset 5, и это разные сообщения. Совпадение номеров не значит ровным счётом ничего.",
        "[[retention]] удаляет с начала лога, но <b>не перенумеровывает</b>: лог может начинаться с offset 3 — так и должно быть.",
        "Глобального порядка нет: «что было раньше, <code>orders-0:5</code> или <code>orders-1:5</code>» — вопрос без ответа."
      ]));
    }
  });
})();
