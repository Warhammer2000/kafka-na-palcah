/* Глава 04 — Ключ решает партицию. Эталонная сцена: полёт записи, живая формула. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "keys",
    num: 4,
    group: "Устройство",
    nav: "Ключ и порядок",
    title: "Ключ решает, в какую партицию ляжет запись",
    lede: "У сообщения есть <b>ключ</b> и <b>значение</b>. Значение — сами данные. А ключ определяет партицию: <code>hash(ключ) % число партиций</code>. Отсюда главное свойство Kafka — порядок.",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>Формула короткая, а следствие огромное: <strong>все сообщения с одинаковым ключом всегда попадают в одну партицию</strong>. " +
        "А внутри партиции записи лежат строго по порядку.</p>"
      ));

      root.appendChild(ui.note("key", "закон",
        "<p><strong>Порядок гарантирован ТОЛЬКО внутри [[партиция|партиции]]. Между партициями порядка нет.</strong></p>" +
        "<p>Практически: берёшь ключом <code>userId</code> → все события пользователя 42 в одной партиции → обрабатываются строго по порядку. " +
        "События разных пользователей — параллельно. Порядок там, где нужен; параллелизм там, где можно.</p>"
      ));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: "Раскладка по ключу",
        hint: "Отправь один ключ несколько раз — он всегда попадёт в ту же партицию"
      });

      var N = 3;
      var useKey = true;
      var rr = 0;                 // счётчик round-robin для режима «без ключа»
      var strips = [];
      var logWrap = el("div.kv-log");

      var producer = ui.node("producer", "продюсер", "orders");
      var producerBox = el("div", { style: { "margin-bottom": "14px" } },
        el("div.kv-row", null, producer,
          el("span", { style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" } },
            "→ топик orders")));

      function rebuild(reason) {
        KV.clear(logWrap);
        strips = []; rr = 0;
        for (var i = 0; i < N; i++) {
          (function (i) {
            var s = ui.logStrip({ label: "партиция " + i, sub: "brokersum-" + (i % 3 + 1) });
            strips.push(s);
            logWrap.appendChild(s.el);
          })(i);
        }
        renderCounts();
        if (reason) stage.say(reason);
      }

      /* --- счётчики по партициям --- */
      var countRow = el("div.kv-stats", { style: { "margin-top": "14px" } });

      function renderCounts() {
        KV.clear(countRow);
        var total = strips.reduce(function (a, s) { return a + s.records.length; }, 0);
        var max = 0;
        strips.forEach(function (s) { max = Math.max(max, s.records.length); });
        strips.forEach(function (s, i) {
          var n = s.records.length;
          var skew = total >= 6 && n === max && max >= total * 0.6;
          countRow.appendChild(ui.stat("партиция " + i, n, {
            unit: util.plural(n, "запись", "записи", "записей"),
            tone: skew ? "bad" : n === 0 && total >= 6 ? "warn" : null
          }).el);
        });
      }

      /* --- отправка --- */

      function send(key) {
        var target, formula;
        if (!useKey) {
          target = rr % N; rr++;
          formula = "Ключа нет → раскладка по кругу (<span class=\"kv-term\" tabindex=\"0\" data-term=\"round-robin\">round-robin</span>) → " +
            "<b>партиция " + target + "</b>. Равномерно, но <b>без гарантии порядка</b>.";
        } else {
          var h = util.hash(key);
          target = h % N;
          formula = "<code>hash(\"" + util.escape(key) + "\") = " + util.num(h) + "</code> &nbsp;→&nbsp; " +
            "<code>" + util.num(h) + " % " + N + " = " + target + "</code> &nbsp;→&nbsp; <b>партиция " + target + "</b>";
        }

        var s = strips[target];
        var plate = s.el.querySelector(".kv-part__label") || s.el;
        var color = useKey ? util.keyColor(key) : "var(--muted)";

        KV.fly(producer, plate, {
          label: useKey ? String(key).slice(0, 3) : "—",
          color: color,
          soft: useKey ? util.keyColorSoft(key) : "var(--surface-2)",
          ms: api.reduced ? 0 : 380
        }).then(function () {
          var off = s.leo();
          s.push(useKey ? { key: key } : { key: null, label: "•", color: "var(--muted)" });
          renderCounts();
          stage.say(formula + " &nbsp;·&nbsp; offset <b>" + off + "</b>");
        });
      }

      /* --- контролы --- */

      var keyInput = el("input.kv-input", { type: "text", value: "user-42", "aria-label": "ключ сообщения", maxlength: "18" });
      keyInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSend(); }
      });

      function doSend() {
        var k = keyInput.value.trim() || "user-42";
        send(k);
      }

      var quick = el("div.kv-row");
      ["user-1", "user-7", "user-42", "order-903"].forEach(function (k) {
        var b = ui.btn(k, function () { keyInput.value = k; send(k); }, { sm: true });
        b.style.fontFamily = "var(--f-mono)";
        b.style.color = util.keyColor(k);
        b.style.borderColor = util.keyColor(k);
        quick.appendChild(b);
      });

      stage.body.appendChild(producerBox);
      stage.body.appendChild(logWrap);
      stage.body.appendChild(countRow);
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } },
        ui.legend([
          { color: "var(--k0)", label: "каждый ключ — свой цвет" },
          { color: "var(--muted)", label: "без ключа" }
        ])));

      var keyToggle = ui.toggle("писать с ключом", true, function (on) {
        useKey = on;
        keyInput.disabled = !on;
        quick.style.opacity = on ? "1" : ".4";
        quick.style.pointerEvents = on ? "" : "none";
        stage.say(on
          ? "Ключ включён: партицию выбирает <code>hash(ключ) % " + N + "</code>."
          : "Ключа нет: Kafka раскладывает записи по кругу. Нагрузка ровная, но два события одного пользователя могут лечь в разные партиции — <b>порядок между ними не гарантирован</b>.");
      });

      var nRange = ui.range({
        label: "партиций", min: 2, max: 5, value: N,
        onInput: function (v) {
          N = v;
          rebuild("Партиций теперь " + N + ". Раскладка пересобрана с нуля: <b>тот же ключ уходит уже в другую партицию</b> — " +
            "именно поэтому число партиций тяжело менять на живом топике, порядок нарушается.");
        }
      });

      KV.append(stage.controls,
        ui.ctl("ключ", keyInput),
        ui.btn("Отправить", doSend, { variant: "primary" }),
        quick,
        ui.btn("Перекос: 8× user-42", function () {
          keyInput.value = "user-42";
          var i = 0;
          var t = api.interval(230, function () {
            if (i++ >= 8) { api.stop(t); showSkew(); return; }
            send("user-42");
          });
        }, { sm: true, variant: "danger" }),
        keyToggle.el,
        nRange.el,
        ui.btn("Очистить", function () { rebuild("Топик пуст."); }, { sm: true, variant: "ghost" }));

      function showSkew() {
        api.timeout(420, function () {
          var h = util.hash("user-42") % N;
          stage.say("<b>Перекос ключа (<span class=\"kv-term\" tabindex=\"0\" data-term=\"hot key\">hot key</span>).</b> " +
            "Все восемь событий легли в партицию " + h + " — она перегружена, остальные простаивают. " +
            "Ключ обязан давать <b>равномерное</b> распределение.");
        });
      }

      rebuild("Отправь ключ и посмотри, куда он ляжет. Один и тот же ключ всегда попадает в одну партицию.");
      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(
        "<h3>Почему это дизайн-решение номер один</h3>" +
        "<p>Выбор ключа — это выбор, <em>где вам нужен порядок</em> и <em>где вы готовы на параллелизм</em>. " +
        "Ключ <code>userId</code> сериализует события одного пользователя и распараллеливает разных. " +
        "Ключ <code>countryCode</code> сериализует целую страну — и в час пик одна партиция ляжет.</p>" +
        "<h4>Если ключ не задать</h4>" +
        "<p>Сообщения раскидываются по партициям равномерно ([[round-robin]]), но без гарантии порядка. " +
        "Для телеметрии это нормально, для событий одной сущности — почти всегда ошибка.</p>"
      ));

      root.appendChild(ui.takeaway([
        "<code>номер партиции = hash(ключ) % количество партиций</code>.",
        "Одинаковый ключ → одна партиция → <b>строгий порядок</b>. Разные ключи → разные партиции → параллельно.",
        "Между партициями порядка <b>нет вообще</b> — ни глобального времени, ни общего счётчика.",
        "Плохой ключ = [[hot key]]: одна партиция горит, остальные простаивают.",
        "Менять число партиций задним числом больно: отображение ключей на партиции меняется, порядок рвётся."
      ]));
    }
  });
})();
