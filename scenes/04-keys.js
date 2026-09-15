/* Глава 04 — Ключ решает партицию. Эталонная сцена: полёт записи, живая формула. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "keys",
    num: 4,
    group: ["Устройство", "How it works"],
    nav: ["Ключ и порядок", "Keys and order"],
    title: ["Ключ решает, в какую партицию ляжет запись", "The key decides which partition a record lands in"],
    lede: [
      "У сообщения есть <b>ключ</b> и <b>значение</b>. Значение — сами данные. А ключ определяет партицию: <code>hash(ключ) % число партиций</code>. Отсюда главное свойство Kafka — порядок.",
      "A message has a <b>key</b> and a <b>value</b>. The value is the data itself. The key picks the partition: <code>hash(key) % number of partitions</code>. That is where Kafka’s defining property — order — comes from."
    ],

    build: function (root, api) {

      root.appendChild(ui.prose(L(
        "<p>Формула короткая, а следствие огромное: <strong>все сообщения с одинаковым ключом всегда попадают в одну партицию</strong>. " +
        "А внутри партиции записи лежат строго по порядку.</p>",

        "<p>The formula is short, the consequence is huge: <strong>every message with the same key always lands in the same partition</strong>. " +
        "And inside a partition records sit in strict order.</p>"
      )));

      root.appendChild(ui.note("key", L("закон", "law"), L(
        "<p><strong>Порядок гарантирован ТОЛЬКО внутри [[партиция|партиции]]. Между партициями порядка нет.</strong></p>" +
        "<p>Практически: берёшь ключом <code>userId</code> → все события пользователя 42 в одной партиции → обрабатываются строго по порядку. " +
        "События разных пользователей — параллельно. Порядок там, где нужен; параллелизм там, где можно.</p>",

        "<p><strong>Order is guaranteed ONLY inside a [[partition]]. Between partitions there is no order at all.</strong></p>" +
        "<p>In practice: take <code>userId</code> as the key → every event of user 42 sits in one partition → it is handled in strict order. " +
        "Events of different users go in parallel. Order where you need it; parallelism where you can have it.</p>"
      )));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: L("Раскладка по ключу", "Spreading by key"),
        hint: L("Отправь один ключ несколько раз — он всегда попадёт в ту же партицию",
          "Send the same key a few times — it always lands in the same partition")
      });

      var N = 3;
      var useKey = true;
      var rr = 0;                 // счётчик раскладки по кругу для режима «без ключа»
      var strips = [];
      var logWrap = el("div.kv-log");
      var FLY_MS = 380;
      /* Поколение топика. «Очистить» и ползунок пересобирают ленты, и записи,
         которые в этот момент летят, относятся к УЖЕ ВЫРЕЗАННЫМ из DOM лентам:
         дописывать их некуда, а формула под стендом считалась по старому числу
         партиций. Поэтому каждая отправка запоминает поколение и на приземлении
         сверяет его. */
      var epoch = 0;
      var skewTimer = null;       // серия «Перекос» — ровно одна за раз

      var producer = ui.node("producer", L("продюсер", "producer"), "orders");
      var producerBox = el("div", { style: { "margin-bottom": "14px" } },
        el("div.kv-row", null, producer,
          el("span", { style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" } },
            L("→ топик orders", "→ topic orders"))));

      /* Ключи для затравки: при открытии главы лента не должна быть пустой,
         иначе главный урок — «повторы одного ключа ложатся в одну партицию» —
         не виден, пока не нажмёшь. */
      var SEED = ["user-1", "user-7", "user-3", "user-7", "user-1", "user-42", "user-3"];

      function seed() {
        SEED.forEach(function (k) {
          strips[util.partitionFor(k, N)].push({ key: k });
        });
        renderCounts();
      }

      function rebuild(reason, withSeed) {
        epoch++;          // всё, что сейчас в полёте, приземлять уже некуда
        stopSkew();
        KV.clear(logWrap);
        strips = []; rr = 0;
        for (var i = 0; i < N; i++) {
          (function (i) {
            var s = ui.logStrip({
              label: L("партиция ", "partition ") + i,
              sub: L("брокер ", "broker ") + (i % 3 + 1)
            });
            strips.push(s);
            logWrap.appendChild(s.el);
          })(i);
        }
        if (withSeed) seed(); else renderCounts();
        /* reason бывает функцией: подпись про затравку можно собрать только
           ПОСЛЕ посева — она считается по тому, что реально легло в ленты. */
        if (reason) stage.say(typeof reason === "function" ? reason() : reason);
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
          countRow.appendChild(ui.stat(L("партиция ", "partition ") + i, n, {
            unit: util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records")),
            tone: skew ? "bad" : n === 0 && total >= 6 ? "warn" : null
          }).el);
        });
      }

      /* --- отправка --- */

      function send(key) {
        var target, formula;
        if (!useKey) {
          target = rr % N; rr++;
          formula = L("Ключа нет → партицию выбирает <b>сам продюсер</b>: стенд кладёт по одной по кругу ",
            "No key → the partition is picked by the <b>producer itself</b>: this demo lays records out one by one around the ring ") +
            "(<span class=\"kv-term\" tabindex=\"0\" data-term=\"round-robin\">round-robin</span>) → " +
            L("<b>партиция ", "<b>partition ") + target +
            L("</b>. У стенда нагрузка выходит ровная (в жизни — пачками), " +
              "но <b>порядок не гарантирован</b> в обоих случаях.",
              "</b>. In the demo the load comes out even (in real life it comes in batches), " +
              "but <b>order is not guaranteed</b> either way.");
        } else {
          var h = util.hash(key);
          target = h % N;
          formula = "<code>hash(\"" + util.escape(key) + "\") = " + util.num(h) + "</code> &nbsp;→&nbsp; " +
            "<code>" + util.num(h) + " % " + N + " = " + target + "</code> &nbsp;→&nbsp; " +
            L("<b>партиция ", "<b>partition ") + target + "</b>";
        }

        var s = strips[target];
        var plate = s.el.querySelector(".kv-part__label") || s.el;
        var color = useKey ? util.keyColor(key) : "var(--muted)";
        var mine = epoch;

        /* Пролёт — только украшение: он живёт на rAF, а тот замирает в фоновой
           вкладке. Модель двигает таймер — и он же сверяет поколение топика. */
        KV.fly(producer, plate, {
          label: useKey ? util.shortKey(key) : "—",
          color: color,
          soft: useKey ? util.keyColorSoft(key) : "var(--surface-2)",
          ms: api.reduced ? 0 : FLY_MS
        });
        api.timeout(api.reduced ? 0 : FLY_MS, function () {
          if (mine !== epoch) return;     // топик пересобрали, пока запись летела
          var off = s.leo();
          s.push(useKey ? { key: key } : { key: null, label: "•", color: "var(--muted)" });
          renderCounts();
          stage.say(formula + " &nbsp;·&nbsp; offset <b>" + off + "</b>");
        });
      }

      /* --- контролы --- */

      var keyInput = el("input.kv-input", {
        type: "text", value: "user-42",
        "aria-label": L("ключ сообщения", "message key"), maxlength: "18"
      });
      keyInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); doSend(); }
      });

      function doSend() {
        var k = keyInput.value.trim() || "user-42";
        send(k);
      }

      var quick = el("div.kv-row");
      var quickBtns = [];
      ["user-1", "user-3", "user-7", "user-42"].forEach(function (k) {
        var b = ui.btn(k, function () { keyInput.value = k; send(k); }, { sm: true });
        b.style.fontFamily = "var(--f-mono)";
        b.style.color = util.keyColor(k);
        b.style.borderColor = util.keyColor(k);
        quickBtns.push(b);
        quick.appendChild(b);
      });

      stage.body.appendChild(producerBox);
      stage.body.appendChild(logWrap);
      stage.body.appendChild(countRow);
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } },
        ui.legend([
          { color: "var(--k0)", label: L("каждый ключ — свой цвет", "each key gets its own colour") },
          { color: "var(--muted)", label: L("без ключа", "no key") }
        ])));

      var keyToggle = ui.toggle(L("писать с ключом", "write with a key"), true, function (on) {
        useKey = on;
        keyInput.disabled = !on;
        /* disabled, а не одна прозрачность: pointer-events гасит только мышь,
           с клавиатуры кнопка всё равно получала бы фокус и срабатывала. */
        quickBtns.forEach(function (b) { b.disabled = !on; });
        stage.say(on
          ? L("Ключ включён: партицию выбирает <code>hash(ключ) % ",
              "The key is on: the partition is picked by <code>hash(key) % ") + N + "</code>."
          : L("Ключа нет: партицию выбирает <b>сам продюсер</b>, а не брокер. Стенд кладёт записи по одной по кругу; " +
          "настоящая Kafka с версии 2.4 делает это «липко» — набивает одну партицию целой пачкой и только потом берёт " +
          "следующую, так что ровно выходит <b>по пачкам, а не по сообщениям</b>. Итог для тебя один: два события одного " +
          "пользователя могут лечь в разные партиции — <b>порядок между ними не гарантирован</b>.",

            "No key: the partition is picked by the <b>producer itself</b>, not by the broker. The demo lays records out one by one " +
            "around the ring; real Kafka has done it “stickily” since 2.4 — it fills one partition with a whole batch and only then takes " +
            "the next, so it evens out <b>across batches, not across messages</b>. For you the upshot is the same either way: two events " +
            "of one user can land in different partitions — <b>order between them is not guaranteed</b>."));
      });

      var nRange = ui.range({
        label: L("партиций", "partitions"), min: 2, max: 5, value: N,
        onInput: function (v) {
          N = v;
          rebuild(L("Партиций теперь ", "Now there are ") + N +
            L(". Раскладка пересобрана с нуля: <b>тот же ключ уходит уже в другую партицию</b> — " +
            "именно поэтому число партиций тяжело менять на живом топике, порядок нарушается. " +
            "Сравни, где лежали те же ключи секунду назад.",
              " partitions. The layout has been rebuilt from scratch: <b>the same key now goes to a different partition</b> — " +
              "which is exactly why the number of partitions is painful to change on a live topic: order breaks. " +
              "Compare where those same keys were sitting a second ago."), true);
        }
      });

      KV.append(stage.controls,
        ui.ctl(L("ключ", "key"), keyInput),
        ui.btn(L("Отправить", "Send"), doSend, { variant: "primary" }),
        quick,
        ui.btn(L("Перекос: 8× user-42", "Skew: 8× user-42"), function () {
          if (skewTimer) return;          // серия уже идёт — второго таймера быть не должно
          keyInput.value = "user-42";
          var mine = epoch;
          var before = strips.map(function (s) { return s.records.length; });
          var i = 0;
          var plain = true;   // ни одна запись серии не ушла с ключом
          skewTimer = api.interval(230, function () {
            if (mine !== epoch) { stopSkew(); return; }
            if (i++ >= 8) { stopSkew(); showSkew(mine, before, plain); return; }
            if (useKey) plain = false;   // тумблер могли щёлкнуть посреди серии
            send("user-42");
          });
        }, { sm: true, variant: "danger" }),
        keyToggle.el,
        nRange.el,
        ui.btn(L("Очистить", "Clear"), function () {
          rebuild(L("Топик пуст. Отправляй ключи и смотри, куда они ложатся.",
            "The topic is empty. Send some keys and watch where they land."));
        }, { sm: true, variant: "ghost" }));

      function stopSkew() {
        if (skewTimer) { api.stop(skewTimer); skewTimer = null; }
      }

      /* Вердикт считается по ФАКТУ: сколько записей серии куда легло.
         При выключенном ключе восемь записей уходят по кругу, и говорить
         про hot key нельзя — картинка показывает ровную загрузку. */
      function showSkew(mine, before, plain) {
        api.timeout(api.reduced ? 60 : 420, function () {
          if (mine !== epoch) return;
          var spread = strips.map(function (s, i) {
            return Math.max(0, s.records.length - (before[i] || 0));
          });
          var sent = spread.reduce(function (a, n) { return a + n; }, 0);
          var top = 0, at = 0;
          spread.forEach(function (n, i) { if (n > top) { top = n; at = i; } });
          if (!sent) return;
          if (top === sent) {
            stage.say(L("<b>Перекос ключа (<span class=\"kv-term\" tabindex=\"0\" data-term=\"hot key\">hot key</span>).</b> " +
              "Вся серия — ",
              "<b>Key skew (<span class=\"kv-term\" tabindex=\"0\" data-term=\"hot key\">hot key</span>).</b> " +
              "The whole run — ") +
              sent + " " + util.plural(sent, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
              L(" — легла в партицию ", " — landed in partition ") + at +
              L(": она перегружена, остальные простаивают. Ключ обязан давать <b>равномерное</b> распределение.",
                ": it is overloaded while the others sit idle. A key has to spread the load <b>evenly</b>."));
          } else if (plain) {
            stage.say(L("<b>Перекоса не вышло: ключ выключен.</b> Записи ушли без ключа и разошлись по кругу (",
              "<b>No skew this time: the key is off.</b> The records went out without a key and spread around the ring (") +
              spread.join(" / ") +
              L(") — партицию тут выбирает продюсер, а сам <code>user-42</code> ни на что не влияет. " +
              "Включи «писать с ключом» и нажми ещё раз: тогда вся серия соберётся в одной партиции — вот это и есть " +
              "<span class=\"kv-term\" tabindex=\"0\" data-term=\"hot key\">hot key</span>.",
                ") — here the partition is picked by the producer, and <code>user-42</code> itself changes nothing. " +
                "Turn on “write with a key” and press again: then the whole run gathers in one partition — and that is exactly what a " +
                "<span class=\"kv-term\" tabindex=\"0\" data-term=\"hot key\">hot key</span> is."));
          } else {
            stage.say(L("Записи легли так: <b>", "The records landed like this: <b>") + spread.join(" / ") +
              L("</b>. В одну партицию всё не собралось — " +
              "значит в серию вмешалось что-то ещё: отправки с другими ключами или переключённый по ходу тумблер. " +
              "Нажми «Очистить» и повтори серию начисто.",
                "</b>. They did not all gather in one partition — so something else got into the run: sends with other keys, " +
                "or the toggle flipped halfway through. " +
                "Press “Clear” and start the run again from scratch."));
          }
        });
      }

      /* Подпись под затравкой считается по тому, что реально легло в ленты:
         «разные ключи → разные партиции» — заблуждение, хеш обещает только
         постоянный адрес. Если два ключа съехались в одну — так и скажем. */
      function seedNote() {
        var shared = null;
        strips.forEach(function (s, i) {
          if (shared) return;
          var seen = {}, keys = [];
          s.records.forEach(function (r) {
            if (r.key && !seen[r.key]) { seen[r.key] = 1; keys.push(r.key); }
          });
          if (keys.length > 1) shared = { at: i, keys: keys };
        });
        /* перечисление по-русски: «a, b и c», а не «a и b и c» */
        function listOf(keys) {
          if (keys.length < 2) return keys[0];
          return keys.slice(0, -1).join("</b>, <b>") + L("</b> и <b>", "</b> and <b>") + keys[keys.length - 1];
        }
        var intro = L("Так топик выглядит после семи записей. Повтор ключа всегда ложится туда же, где первая запись: " +
          "<b>user-1</b>, <b>user-7</b> и <b>user-3</b> отправлены дважды — и оба раза адрес совпал. ",
          "This is how the topic looks after seven records. A repeated key always lands where its first record did: " +
          "<b>user-1</b>, <b>user-7</b> and <b>user-3</b> were sent twice — and both times the address matched. ");
        return intro +
          (shared
            ? L("А вот расходиться по разным партициям разные ключи не обязаны: <b>",
                "But different keys are under no obligation to spread across different partitions: <b>") + listOf(shared.keys) +
              L("</b> сейчас делят партицию ", "</b> are sharing partition ") + shared.at +
              L(". Хеш обещает постоянный адрес, а не разный.",
                " right now. The hash promises a constant address, not a different one.")
            : L("Сейчас каждый ключ занял свою партицию, но это совпадение: хеш обещает постоянный адрес, а не разный — " +
              "подвинь ползунок, и два ключа съедутся в одну ленту.",
                "Right now every key has taken a partition of its own, but that is a coincidence: the hash promises a constant " +
                "address, not a different one — move the slider and two keys will slide into the same strip.")) +
          L(" Дальше отправляй сам.", " From here on, send them yourself.");
      }

      rebuild(seedNote, true);
      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(L(
        "<h3>Почему это дизайн-решение номер один</h3>" +
        "<p>Выбор ключа — это выбор, <em>где тебе нужен порядок</em>, а <em>где можно распараллелить</em>. " +
        "Ключ <code>userId</code> сериализует события одного пользователя и распараллеливает разных. " +
        "Ключ <code>countryCode</code> сериализует целую страну — и в час пик одна партиция ляжет.</p>" +
        "<h4>Если ключ не задать</h4>" +
        "<p>Партицию тогда выбирает <strong>сам продюсер</strong> — клиентская библиотека, а не брокер. " +
        "Раньше он честно чередовал партиции по одной ([[round-robin]]); с Kafka 2.4 дефолтный партиционер " +
        "<b>«липкий»</b> (sticky): он набивает одну партицию, пока не закроется пачка (<code>batch.size</code> / " +
        "<code>linger.ms</code>), и только потом берёт следующую. С версии 3.3 это встроенное поведение, а старые " +
        "<code>DefaultPartitioner</code> и <code>UniformStickyPartitioner</code> объявлены устаревшими. " +
        "То есть нагрузка выравнивается <b>по пачкам, а не по сообщениям</b>: три записи подряд почти наверняка лягут " +
        "в одну партицию. Стенд выше это упрощает и раскладывает строго по кругу — так виднее.</p>" +
        "<p>На гарантии это не влияет: без ключа порядка между партициями нет всё равно. " +
        "Для телеметрии это нормально, для событий одной сущности — почти всегда ошибка.</p>",

        "<h3>Why this is design decision number one</h3>" +
        "<p>Choosing a key is choosing <em>where you need order</em> and <em>where you can go parallel</em>. " +
        "The key <code>userId</code> serialises the events of one user and parallelises different users. " +
        "The key <code>countryCode</code> serialises a whole country — and at peak hour one partition buckles under the load.</p>" +
        "<h4>If you set no key</h4>" +
        "<p>Then the partition is picked by the <strong>producer itself</strong> — the client library, not the broker. " +
        "It used to cycle through the partitions one record at a time ([[round-robin]]); since Kafka 2.4 the default " +
        "partitioner is <b>“sticky”</b>: it fills one partition until the batch closes (<code>batch.size</code> / " +
        "<code>linger.ms</code>) and only then takes the next. Since 3.3 that is the built-in behaviour, and the old " +
        "<code>DefaultPartitioner</code> and <code>UniformStickyPartitioner</code> are deprecated. " +
        "So the load evens out <b>across batches, not across messages</b>: three records in a row will almost certainly land " +
        "in the same partition. The demo above simplifies that and lays records strictly around the ring — it makes the point easier to see.</p>" +
        "<p>None of this touches the guarantee: without a key there is no order between partitions anyway. " +
        "For telemetry that is fine; for the events of a single entity it is almost always a mistake.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "<code>номер партиции = hash(ключ) % количество партиций</code>.",
          "Одинаковый ключ → всегда одна и та же партиция → <b>строгий порядок</b>. Разные ключи расходятся по партициям и идут параллельно — но <b>расходиться не обязаны</b>: хеш обещает постоянный адрес, а не разный.",
          "Между партициями порядка <b>нет вообще</b> — ни глобального времени, ни общего счётчика.",
          "Плохой ключ = [[hot key]]: одна партиция горит, остальные простаивают.",
          "Менять число партиций задним числом больно: отображение ключей на партиции меняется, порядок рвётся."
        ],
        [
          "<code>partition number = hash(key) % number of partitions</code>.",
          "The same key → always the same partition → <b>strict order</b>. Different keys spread across partitions and go in parallel — but they are <b>not obliged to spread</b>: the hash promises a constant address, not a different one.",
          "Between partitions there is <b>no order at all</b> — no global clock, no shared counter.",
          "A bad key = [[hot key]]: one partition burns while the rest sit idle.",
          "Changing the number of partitions after the fact hurts: the mapping of keys onto partitions shifts and ordering breaks."
        ]
      )));
    }
  });
})();
