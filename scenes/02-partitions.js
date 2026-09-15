/* Глава 02 — Топик и партиции. Стенд про пропускную способность. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "partitions",
    num: 2,
    group: ["Устройство", "How it works"],
    nav: ["Топик и партиции", "Topics and partitions"],
    title: ["Топик — это несколько логов сразу", "A topic is several logs at once"],
    lede: [
      "<code>orders</code> — это <b>имя</b>, а не файл. Физически топик разрезан на несколько независимых логов — партиций. Вопрос главы: что ты покупаешь каждой следующей партицией.",
      "<code>orders</code> is a <b>name</b>, not a file. Physically the topic is cut into several independent logs — partitions. The question of this chapter: what exactly do you buy with each extra partition."
    ],

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(L(
        "<p>В коде живёт только [[топик]]: продюсер пишет «в <code>orders</code>», консьюмер читает «из <code>orders</code>». " +
        "Это логический уровень — именованный поток событий одного типа: <code>orders</code>, <code>payments</code>, <code>user-clicks</code>. " +
        "Слово «партиция» в прикладном коде почти не встречается.</p>" +
        "<p>А на дисках брокеров лежит другое. Топик <code>orders</code> — это набор [[партиция|партиций]], и каждая партиция " +
        "самостоятельный append-only лог со своей нумерацией с нуля. Скажем, партиция 0 — записи 0…4, партиция 1 — 0…2, партиция 2 — 0…6. " +
        "<strong>Длины разные, и это нормально:</strong> партиции ничего друг о друге не знают, общего счётчика у топика нет.</p>",

        "<p>Your code only ever sees the [[topic]]: the producer writes “to <code>orders</code>”, the consumer reads “from <code>orders</code>”. " +
        "That is the logical level — a named stream of events of one kind: <code>orders</code>, <code>payments</code>, <code>user-clicks</code>. " +
        "The word “partition” hardly ever shows up in application code.</p>" +
        "<p>On the brokers’ disks it looks different. The topic <code>orders</code> is a set of [[partition|partitions]], and every partition is " +
        "an independent append-only log with its own numbering from zero. Say partition 0 holds records 0…4, partition 1 holds 0…2, partition 2 holds 0…6. " +
        "<strong>The lengths differ, and that is normal:</strong> partitions know nothing about each other, and the topic has no shared counter.</p>"
      )));

      root.appendChild(ui.note("key", L("выучить дословно", "learn it word for word"), L(
        "<p><strong>«[[партиция|Партиция]] — единица параллелизма в Kafka».</strong></p>" +
        "<p>Один лог — один поток записи, и упирается он в одну машину: это потолок. Три партиции — три независимых потока, " +
        "а лежат они на разных [[брокер|брокерах]], то есть делится не только работа, но и железо. " +
        "Число партиций — это и есть объявленная пропускная способность топика.</p>",

        "<p><strong>“A [[partition]] is the unit of parallelism in Kafka.”</strong></p>" +
        "<p>One log is one stream of writes, and it runs into a single machine: that is your ceiling. Three partitions are three independent streams, " +
        "and they sit on different [[broker|brokers]], so it is not only the work that is split but the hardware too. " +
        "The number of partitions is exactly the declared throughput of the topic.</p>"
      )));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: L("Пропускная способность топика", "Topic throughput"),
        hint: L("Двигай ползунок и смотри, за сколько тактов ляжет один и тот же поток",
          "Drag the slider and watch how many ticks the very same stream takes")
      });

      var TOTAL = 24;        // событий в потоке
      var BROKERS = 3;       // серверов в кластере
      var TICK_MS = 380;     // длительность такта
      var FLY_MS = 240;      // пролёт записи от потока к партиции
      var N = 5;             // партиций сейчас

      var pending = [];      // номера событий, ещё не записанных
      var streamCells = {};  // номер события -> клетка в ленте потока
      var strips = [];       // ленты партиций
      var bars = [];         // полоски загрузки
      var history = {};      // партиций -> тактов (журнал прогонов)
      var ticks = 0;
      var landed = 0;        // сколько записей уже долетело до партиций
      var concluded = false; // вывод по прогону уже написан
      var running = false;
      var runId = 0;         // поколение прогона: гасит долетающие записи
      var timer = null;

      function pPart(n) { return util.plural(n, L("партиция", "partition"), L("партиции", "partitions"), L("партиций", "partitions")); }
      function pPartLoc(n) { return util.plural(n, L("партиции", "partition"), L("партициях", "partitions"), L("партициях", "partitions")); }
      function pTick(n) { return util.plural(n, L("такт", "tick"), L("такта", "ticks"), L("тактов", "ticks")); }
      function pRec(n) { return util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records")); }
      function pEv(n) { return util.plural(n, L("событие", "event"), L("события", "events"), L("событий", "events")); }
      function pLog(n) { return util.plural(n, L("лог", "log"), L("лога", "logs"), L("логов", "logs")); }
      function pBrok(n) { return util.plural(n, L("брокер", "broker"), L("брокера", "brokers"), L("брокеров", "brokers")); }
      function brokerOf(i) { return (i % BROKERS) + 1; }
      function used() { return Math.min(N, BROKERS); }
      function needTicks(n) { return Math.ceil(TOTAL / n); }
      function paintCell(c) { if (c) c.style.background = "var(--write-soft)"; }

      var RUN_LABEL = L("Пустить поток из ", "Send a stream of ") + TOTAL + " " + pEv(TOTAL);

      function timesWord(r) {
        if (Math.abs(r - Math.round(r)) < 0.05) {
          var n = Math.round(r);
          return n + " " + util.plural(n, L("раз", "time"), L("раза", "times"), L("раз", "times"));
        }
        return (Math.round(r * 10) / 10).toFixed(1).replace(".", L(",", ".")) + L(" раза", " times");
      }

      /* --- поток от продюсера --- */

      var producer = ui.node("producer", L("продюсер", "producer"), L("пишет в orders", "writes to orders"));

      var streamTrack = el("div.kv-strip__track", { style: { "padding-right": "8px" } });
      var streamEmpty = el("div.kv-strip__empty", {
        text: L("поток разобран — все ", "the stream is drained — all ") + TOTAL + " " + pEv(TOTAL) +
          L(" лежат в партициях", " are sitting in the partitions")
      });
      var streamStrip = el("div.kv-strip", { style: { "min-height": "54px", "padding-bottom": "4px" } },
        streamTrack, streamEmpty);

      /* Пустая лента не должна занимать место: прячем дорожку целиком. */
      function syncStream() {
        var has = pending.length > 0;
        streamEmpty.classList.toggle("kv-hidden", has);
        streamTrack.classList.toggle("kv-hidden", !has);
      }

      function renderStream() {
        KV.clear(streamTrack);
        streamCells = {};
        pending.forEach(function (ev) {
          var c = el("div.kv-cell", {
            title: L("событие №", "event #") + ev + L(" — ещё не записано", " — not written yet")
          }, String(ev));
          c.style.borderColor = "var(--write)";
          c.style.color = "var(--write)";
          var w = el("div.kv-cellwrap", null, c);
          streamCells[ev] = w;
          streamTrack.appendChild(w);
        });
        syncStream();
      }

      /* --- живая формула --- */

      var formulaEl = el("div", {
        style: {
          "font-family": "var(--f-mono)", "font-size": "13px",
          color: "var(--muted)", margin: "14px 0 10px"
        }
      });

      function renderFormula() {
        var t = needTicks(N);
        formulaEl.innerHTML =
          L("за такт топик принимает по одной записи на партицию &nbsp;·&nbsp; ",
            "per tick the topic takes one record per partition &nbsp;·&nbsp; ") +
          "<b>" + TOTAL + "</b> " + pEv(TOTAL) + " ÷ <b>" + N + "</b> " + pPart(N) +
          " → <b>" + t + " " + pTick(t) + "</b>" +
          (TOTAL % N ? L(" <span>(последний такт неполный)</span>", " <span>(the last tick is not full)</span>") : "");
      }

      /* --- сам топик --- */

      var logWrap = el("div.kv-log");
      var topicTitle = el("div.kv-panel__t");
      var topicPanel = el("div.kv-panel", null, topicTitle, logWrap);

      function buildPartitions() {
        KV.clear(logWrap);
        strips = [];
        for (var i = 0; i < N; i++) {
          var s = ui.logStrip({
            label: L("партиция ", "partition ") + i,
            sub: L("брокер ", "broker ") + brokerOf(i),
            empty: L("пусто", "empty")
          });
          strips.push(s);
          logWrap.appendChild(s.el);
        }
        topicTitle.textContent = L("топик orders · ", "topic orders · ") + N + " " + pPart(N) +
          L(" на ", " on ") + used() + " " +
          util.plural(used(), L("брокере", "broker"), L("брокерах", "brokers"), L("брокерах", "brokers"));
      }

      var readHint = el("div", {
        style: { "font-size": "12px", color: "var(--faint)", "margin-top": "10px", "max-width": "70ch" },
        text: L(
          "В клетке — номер события в общем потоке, под клеткой — его offset внутри партиции. " +
          "Номера потока идут подряд, а offset-ы у каждой партиции свои и начинаются с нуля.",

          "Inside a cell is the event’s number in the whole stream; under the cell is its offset inside the partition. " +
          "Stream numbers run one after another, while the offsets belong to each partition and start from zero."
        )
      });

      /* --- показатели --- */

      var stTicks = ui.stat(L("тактов затрачено", "ticks spent"), 0);
      var stRate = ui.stat(L("за такт принимает", "takes per tick"), N, { unit: L("зап.", "rec.") });
      var stDone = ui.stat(L("записано", "written"), 0, { unit: L("из ", "of ") + TOTAL });
      var stWait = ui.stat(L("ждут в потоке", "waiting in the stream"), TOTAL);
      var stBrok = ui.stat(L("брокеров под нагрузкой", "brokers under load"), BROKERS, { unit: L("из ", "of ") + BROKERS });
      var statsRow = ui.stats(stTicks.el, stRate.el, stDone.el, stWait.el, stBrok.el);

      function renderStats() {
        stTicks.set(ticks, ticks === 0 ? null : ticks >= 12 ? "bad" : ticks <= 6 ? "good" : "warn");
        stRate.set(N, "write");
        stDone.set(landed, null);
        stWait.set(pending.length, pending.length ? "warn" : "good");
        stBrok.set(used(), used() === BROKERS ? "good" : "warn");
      }

      /* --- загрузка партиций --- */

      var loadBody = el("div.kv-col", { style: { gap: "7px" } });
      var loadPanel = ui.panel(L("загрузка партиций", "partition load"),
        el("div", {
          style: { "font-size": "12px", color: "var(--faint)", "margin-bottom": "9px" },
          text: L("какая доля потока досталась каждой", "what share of the stream each one got")
        }),
        loadBody);

      function buildBars() {
        KV.clear(loadBody);
        bars = [];
        for (var i = 0; i < N; i++) {
          var bar = ui.bar(0, "write");
          var cnt = el("span", {
            style: {
              "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)",
              "text-align": "right", "font-variant-numeric": "tabular-nums"
            }, text: "0 · 0 %"
          });
          var row = el("div", {
            style: {
              display: "grid", "grid-template-columns": "100px minmax(50px, 1fr) 74px",
              gap: "10px", "align-items": "center"
            }
          },
            el("span", {
              style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--ink-2)" },
              text: L("п", "p") + i + L(" · брокер ", " · broker ") + brokerOf(i)
            }),
            bar.el, cnt);
          bars.push({ bar: bar, cnt: cnt });
          loadBody.appendChild(row);
        }
      }

      function renderBars() {
        for (var i = 0; i < N; i++) {
          if (!bars[i] || !strips[i]) continue;
          var n = strips[i].records.length;
          var frac = n / TOTAL;
          bars[i].bar.set(frac, "write");
          bars[i].cnt.textContent = n + " · " + Math.round(frac * 100) + " %";
        }
      }

      /* --- брокеры --- */

      var brokersBody = el("div.kv-col", { style: { gap: "7px" } });
      var brokersPanel = ui.panel(L("кластер: ", "cluster: ") + BROKERS + " " + pBrok(BROKERS), brokersBody);

      function buildBrokers() {
        KV.clear(brokersBody);
        for (var b = 1; b <= BROKERS; b++) {
          var mine = [];
          for (var i = 0; i < N; i++) if (brokerOf(i) === b) mine.push(L("п", "p") + i);
          var node = ui.node(null, L("брокер ", "broker ") + b,
            mine.length ? mine.join(", ") : L("по этому топику простаивает", "idle as far as this topic goes"));
          if (!mine.length) node.classList.add("kv-node--dead");
          brokersBody.appendChild(node);
        }
      }

      /* --- журнал прогонов --- */

      var histRow = el("div.kv-row", { style: { "margin-top": "14px" } });

      function renderHistory() {
        KV.clear(histRow);
        var keys = Object.keys(history).map(Number).sort(function (a, b) { return a - b; });
        if (!keys.length) return;
        histRow.appendChild(el("span.kv-ctl__label", { text: L("прогоны", "runs") }));
        keys.forEach(function (k) {
          histRow.appendChild(ui.badge(
            k + " " + pPart(k) + " → " + history[k] + " " + pTick(history[k]),
            k === N ? "write" : null));
        });
      }

      /* ---------------- механика прогона ---------------- */

      function land(p, ev) {
        var s = strips[p];
        /* Ленты могли быть пересобраны — картинку рисуем, только если есть куда,
           но счётчик долетевших ведём всегда, иначе прогон не дойдёт до вывода. */
        if (s) {
          var off = s.leo();
          paintCell(s.push({
            label: String(ev),
            color: "var(--write)",
            title: L("событие №", "event #") + ev + L(" · партиция ", " · partition ") + p + " · offset " + off
          }));
          s.highlight(off, "is-hot", 420);
        }
        landed++;
        renderBars();
        renderStats();
        maybeConclude();
      }

      function step() {
        if (!running) return;
        if (!pending.length) { finishRun(); return; }

        ticks++;
        var takeNow = Math.min(N, pending.length);
        var mine = runId;

        for (var p = 0; p < takeNow; p++) {
          (function (p) {
            var ev = pending.shift();
            var src = streamCells[ev];
            var s = strips[p];
            var plate = s.el.querySelector(".kv-part__label") || s.strip;
            /* Пролёт — только украшение: он живёт на rAF, а тот замирает
               в фоновой вкладке. Модель двигает таймер. */
            KV.fly(src || producer, plate, {
              label: String(ev),
              color: "var(--write)",
              soft: "var(--write-soft)",
              ms: FLY_MS
            });
            api.timeout(api.reduced ? 0 : FLY_MS, function () {
              if (mine !== runId) return;
              land(p, ev);
            });
            if (src) { src.remove(); delete streamCells[ev]; }
          })(p);
        }

        syncStream();
        renderStats();
        stage.say(L("Такт <b>", "Tick <b>") + ticks +
          L("</b>: топик разом откусил от потока ", "</b>: the topic bit ") + takeNow + " " + pRec(takeNow) +
          (takeNow === N
            ? L(" — по одной на каждую партицию. ", " off the stream at once — one for every partition. ")
            : L(" — поток кончается, и работы хватило не всем партициям: остальные в этом такте простояли. ",
                " off the stream at once — the stream is running out and there was not enough work for every partition: the rest idled this tick. ")) +
          L("В потоке осталось ", "Left in the stream: ") + pending.length + ".");
      }

      function conclude() {
        var lens = strips.map(function (s) { return s.records.length; });
        var even = lens.every(function (v) { return v === lens[0]; });

        var html = L("<b>Поток разложен за ", "<b>The stream was laid out in ") + ticks + " " + pTick(ticks) + ".</b> " +
          L("За один такт топик принимает столько записей, сколько у него партиций — ",
            "In one tick the topic takes as many records as it has partitions — ") + N + ". " +
          L("Отсюда вся арифметика: ", "That is where all the arithmetic comes from: ") +
          TOTAL + " ÷ " + N + " → " + ticks + ". ";

        if (N === 1) {
          html += L("Одна партиция — один поток записи: события выстроились в затылок друг другу, и никакое железо этого не ускорит. ",
            "One partition is one stream of writes: the events lined up behind one another, and no hardware will make that faster. ");
        } else {
          html += L("Партиции работали параллельно и независимо: каждая вела свою нумерацию с нуля. ",
            "The partitions worked in parallel and independently: each kept its own numbering from zero. ");
        }

        html += N === 1
          ? L("В единственном логе ", "The one and only log holds ") + lens[0] + " " + pRec(lens[0]) +
            L(" — весь поток целиком. ", " — the whole stream. ")
          : L("Длины получились ", "The lengths came out as ") + lens.join(", ") +
            (even ? L(" — поток разделился без остатка. ", " — the stream divided with nothing left over. ")
                  : L(" — разные, и это нормально: общего счётчика у топика нет. ",
                      " — they differ, and that is normal: the topic has no shared counter. "));

        html += used() < BROKERS
          ? L("Под нагрузкой ", "Under load: ") + used() + " " + pBrok(used()) +
            L(" из ", " of ") + BROKERS +
            L(" — остальное железо по этому топику простаивает.", " — the rest of the hardware idles as far as this topic goes.")
          : L("Все ", "All ") + BROKERS + " " + pBrok(BROKERS) +
            L(" под нагрузкой — запись делится не только между потоками, но и между машинами.",
              " are under load — writing is split not only between streams but between machines.");

        var cmp = null;
        Object.keys(history).map(Number).forEach(function (k) {
          if (k === N || history[k] === ticks) return;
          if (cmp === null || Math.abs(history[k] - ticks) > Math.abs(history[cmp] - ticks)) cmp = k;
        });
        if (cmp !== null) {
          var t2 = history[cmp];
          html += L(" <b>Для сравнения:</b> при ", " <b>For comparison:</b> with ") + cmp + " " + pPartLoc(cmp) +
            L(" тот же поток уложился за ", " the same stream took ") +
            t2 + " " + pTick(t2) + L(" — в ", " — ") +
            (t2 > ticks ? timesWord(t2 / ticks) + L(" дольше.", " longer.")
                        : timesWord(ticks / t2) + L(" быстрее.", " faster."));
        }

        stage.say(html);
      }

      /* Поток разобран. Последние записи ещё летят — вывод пишем,
         когда они долетят (см. maybeConclude в land). */
      function finishRun() {
        idle();
        maybeConclude();
      }

      function maybeConclude() {
        if (running || concluded || pending.length || landed < TOTAL) return;
        concluded = true;
        history[N] = ticks;
        renderHistory();
        renderBars();
        renderStats();
        conclude();
      }

      function stopEarly() {
        idle();
        /* Поток мог кончиться до нажатия: последние записи либо уже легли, либо
           долетают. Тогда это не остановка, а финал — вывод и журнал прогонов
           пишет maybeConclude, иначе прогон исчез бы бесследно. */
        if (!pending.length) { maybeConclude(); return; }
        stage.say(L(
          "Остановлено на такте <b>" + ticks + "</b>: из " + TOTAL + " " + pEv(TOTAL) +
          " топик успел забрать " + (TOTAL - pending.length) + ", в потоке ещё " +
          (pending.length === 1 ? "ждёт" : "ждут") + " " + pending.length + ". " +
          "Жми «пустить поток» — прогон начнётся с чистого топика.",

          "Stopped at tick <b>" + ticks + "</b>: out of " + TOTAL + " " + pEv(TOTAL) +
          " the topic managed to take " + (TOTAL - pending.length) + ", and " + pending.length +
          (pending.length === 1 ? " is" : " are") + " still waiting in the stream. " +
          "Press “send a stream” — the run will start from a clean topic."
        ));
      }

      function idle() {
        if (timer !== null) { api.stop(timer); timer = null; }
        running = false;
        runBtn.textContent = RUN_LABEL;
        nRange.input.disabled = false;
      }

      function arm(say) {
        if (timer !== null) { api.stop(timer); timer = null; }
        running = false;
        runId++;
        ticks = 0;
        landed = 0;
        concluded = false;
        pending = [];
        for (var i = 0; i < TOTAL; i++) pending.push(i);
        runBtn.textContent = RUN_LABEL;
        nRange.input.disabled = false;
        buildPartitions();
        buildBars();
        buildBrokers();
        renderStream();
        renderFormula();
        renderBars();
        renderStats();
        renderHistory();
        if (say) stage.say(say);
      }

      function startRun() {
        arm(null);
        running = true;
        runBtn.textContent = L("Стоп", "Stop");
        nRange.input.disabled = true;
        renderStats();
        step();
        timer = api.interval(TICK_MS, step);
      }

      function setN(v) {
        N = v;
        arm(L(
          "Партиций теперь <b>" + N + "</b>. Пропускная способность топика — " + N + " " + pRec(N) +
          " за такт, значит " + TOTAL + " " + pEv(TOTAL) + " лягут за <b>" + needTicks(N) + " " + pTick(needTicks(N)) + "</b>. " +
          (N === 1
            ? "Одна партиция — один поток: всё выстроится в очередь."
            : "Партиций " + N + ", брокеров под нагрузкой " + used() + ".") +
          " Жми «пустить поток» и проверь.",

          "Now the topic has <b>" + N + "</b> " + pPart(N) + ". Its throughput is " + N + " " + pRec(N) +
          " per tick, so " + TOTAL + " " + pEv(TOTAL) + " will land in <b>" + needTicks(N) + " " + pTick(needTicks(N)) + "</b>. " +
          (N === 1
            ? "One partition is one stream: everything lines up in a queue."
            : "Partitions: " + N + ", brokers under load: " + used() + ".") +
          " Press “send a stream” and check."
        ));
      }

      /* --- стартовое состояние: прогон уже сделан --- */

      function preload() {
        arm(null);
        var recs = [], i, t = 0;
        for (i = 0; i < N; i++) recs.push([]);
        while (pending.length) {
          t++;
          for (var p = 0; p < N && pending.length; p++) {
            var ev = pending.shift();
            recs[p].push({
              label: String(ev),
              color: "var(--write)",
              title: L("событие №", "event #") + ev + L(" · партиция ", " · partition ") + p + " · offset " + recs[p].length
            });
          }
        }
        for (i = 0; i < N; i++) {
          strips[i].setRecords(recs[i]);
          for (var off = 0; off < recs[i].length; off++) paintCell(strips[i].cell(off));
        }
        ticks = t;
        landed = TOTAL;
        concluded = true;
        history[N] = t;
        renderStream();
        renderBars();
        renderStats();
        renderHistory();
        stage.say(L(
          "Так выглядит топик <code>orders</code> после одного прогона: " + N + " независимых " + pLog(N) +
          " на " + used() + " " + util.plural(used(), "брокере", "брокерах", "брокерах") +
          ", " + TOTAL + " " + pEv(TOTAL) + " уже разъехались по ним за <b>" + t + " " + pTick(t) + "</b>. " +
          "Длины партиций разные — партиции друг о друге не знают. Нажми «пустить поток», чтобы увидеть это по тактам, " +
          "а потом поставь ползунок на 1 и сравни.",

          "This is what the topic <code>orders</code> looks like after one run: " + N + " independent " + pLog(N) +
          " on " + used() + " " + util.plural(used(), "broker", "brokers", "brokers") +
          ", and " + TOTAL + " " + pEv(TOTAL) + " have already spread across them in <b>" + t + " " + pTick(t) + "</b>. " +
          "The partitions have different lengths — they know nothing about each other. Press “send a stream” to watch it tick by tick, " +
          "then move the slider to 1 and compare."
        ));
      }

      /* --- контролы --- */

      var runBtn = ui.btn(RUN_LABEL, function () {
        if (running) stopEarly(); else startRun();
      }, { variant: "primary" });

      var nRange = ui.range({
        label: L("партиций", "partitions"), min: 1, max: 6, value: N,
        onInput: function (v) { setN(v); }
      });

      var resetBtn = ui.btn(L("Сброс", "Reset"), function () {
        arm(L(
          "Сброшено: топик пуст, " + TOTAL + " " + pEv(TOTAL) + " снова ждут в потоке. Партиций " + N +
          " — по расчёту понадобится " + needTicks(N) + " " + pTick(needTicks(N)) + ".",

          "Reset: the topic is empty and " + TOTAL + " " + pEv(TOTAL) + " are waiting in the stream again. Partitions: " + N +
          " — by the arithmetic it will take " + needTicks(N) + " " + pTick(needTicks(N)) + "."
        ));
      }, { variant: "ghost", sm: true });

      var clearHist = ui.btn(L("Очистить журнал", "Clear the run log"), function () {
        history = {};
        renderHistory();
        stage.say(L("Журнал прогонов пуст.", "The run log is empty."));
      }, { variant: "ghost", sm: true });

      /* --- сборка стенда --- */

      stage.body.appendChild(ui.panel(L("поток от продюсера · ", "stream from the producer · ") + TOTAL + " " + pEv(TOTAL),
        el("div.kv-row", { style: { "margin-bottom": "8px" } },
          producer,
          ui.badge(L("события идут по порядку: 0 → ", "the events come in order: 0 → ") + (TOTAL - 1), "write")),
        streamStrip));

      stage.body.appendChild(formulaEl);
      stage.body.appendChild(topicPanel);
      stage.body.appendChild(readHint);
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, statsRow));
      stage.body.appendChild(el("div.kv-split", { style: { "margin-top": "14px" } }, loadPanel, brokersPanel));
      stage.body.appendChild(histRow);

      KV.append(stage.controls, runBtn, nRange.el, resetBtn, clearHist);

      preload();
      api.onDestroy(function () { runId++; });
      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(L(
        "<h3>Что ты сейчас увидел</h3>" +
        "<p>Модель нарочно примитивная — партиция принимает за такт одну запись, — но пропорция настоящая: " +
        "<code>тактов = ⌈24 / партиций⌉</code>. Одна партиция тянет поток 24 такта, четыре — шесть, шесть — четыре. " +
        "Увеличение числа партиций <em>не ускоряет</em> отдельную запись: оно добавляет независимых линий, по которым записи идут одновременно.</p>" +
        "<p>Второе упрощение — сама раскладка. Стенд кладёт по одной записи в каждую партицию по кругу, потому что так видно " +
        "арифметику. В жизни партицию для записи <b>без ключа</b> выбирает не брокер, а сам [[продюсер]], и с Kafka 2.4 его " +
        "партиционер «липкий»: он набивает <em>одну</em> партицию, пока не закроется пачка (<code>batch.size</code> / " +
        "<code>linger.ms</code>), и только потом переходит к следующей. С Kafka 3.3 это встроено в продюсер, а прежние " +
        "<code>DefaultPartitioner</code> и <code>UniformStickyPartitioner</code> объявлены устаревшими. Значит, нагрузка " +
        "выравнивается <b>по пачкам</b>, а не по сообщениям; на потолок топика это не влияет, а порядка между партициями " +
        "без ключа не появляется всё равно. Подробнее — в главе про [[ключ]].</p>" +
        "<h4>Параллелизм двух сортов</h4>" +
        "<p>Первый — потоки: партиции пишутся независимо, каждая со своей нумерацией. Второй — железо: партиции разложены по " +
        "[[брокер|брокерам]]. Шесть партиций на трёх брокерах — это по две на сервер, то есть три диска и три сетевые карты вместо одной. " +
        "Только не жди, что новая машина в кластере подхватит нагрузку сама: партиции на неё <em>не переезжают</em> автоматически — " +
        "раскладку меняют отдельной операцией, переназначением реплик (<code>kafka-reassign-partitions</code>). " +
        "Зато потолок топика после этого действительно растёт вместе с кластером. " +
        "При одной партиции два брокера из трёх по этому топику просто простаивают — ты это видел на плитке «брокеров под нагрузкой».</p>" +
        "<h4>Чтение считается так же</h4>" +
        "<p>Только с оговоркой: в [[consumer group|группе консьюмеров]] одну партицию читает максимум один консьюмер. " +
        "Значит число партиций — ещё и потолок для читателей: на топике из трёх партиций четвёртый консьюмер группы будет стоять без работы. " +
        "Это тема отдельной главы, но решение принимается здесь — в момент, когда выбирается число партиций.</p>",

        "<h3>What you have just seen</h3>" +
        "<p>The model is primitive on purpose — a partition takes one record per tick — but the proportion is real: " +
        "<code>ticks = ⌈24 / partitions⌉</code>. One partition drags the stream for 24 ticks, four do it in six, six in four. " +
        "Adding partitions does <em>not speed up</em> a single write: it adds independent lanes along which records travel at the same time.</p>" +
        "<p>The second simplification is the layout itself. The demo drops one record into each partition around the ring, because that is what makes " +
        "the arithmetic visible. In real life the partition for a record <b>without a key</b> is chosen not by the broker but by the [[producer]] itself, and since Kafka 2.4 its " +
        "partitioner is “sticky”: it fills <em>one</em> partition until the batch closes (<code>batch.size</code> / " +
        "<code>linger.ms</code>), and only then moves on to the next. Since Kafka 3.3 this is built into the producer, and the older " +
        "<code>DefaultPartitioner</code> and <code>UniformStickyPartitioner</code> are deprecated. So the load " +
        "evens out <b>across batches</b>, not across messages; it makes no difference to the ceiling of the topic, and without a key there is still " +
        "no order between partitions anyway. More on that in the chapter on the [[key]].</p>" +
        "<h4>Two kinds of parallelism</h4>" +
        "<p>The first is streams: partitions are written independently, each with its own numbering. The second is hardware: partitions are spread across " +
        "[[broker|brokers]]. Six partitions on three brokers means two per server — three disks and three network cards instead of one. " +
        "Just do not expect a new machine in the cluster to pick up the load by itself: partitions <em>do not move</em> onto it automatically — " +
        "the layout is changed by a separate operation, by reassigning replicas (<code>kafka-reassign-partitions</code>). " +
        "But after that the ceiling of the topic really does grow together with the cluster. " +
        "With a single partition two brokers out of three simply idle for this topic — you saw it on the “brokers under load” tile.</p>" +
        "<h4>Reading counts the same way</h4>" +
        "<p>With one caveat: inside a [[consumer group]] a partition is read by at most one consumer. " +
        "So the number of partitions is also the ceiling for readers: on a topic with three partitions the fourth consumer of the group will stand around with nothing to do. " +
        "That is a chapter of its own, but the decision is made right here — at the moment you pick the number of partitions.</p>"
      )));

      root.appendChild(ui.note("warn", L("цена вопроса", "what it costs"), L(
        "<p>Партиции не бесплатны, и это не абстрактное «накладные расходы»:</p>" +
        "<ul>" +
        "<li>Партиций легко <b>добавить</b> и <b>нельзя убрать</b>. Единственный способ уменьшить — новый топик и перелив данных.</li>" +
        "<li>Добавление пересобирает раскладку по [[ключ|ключам]]: <code>hash(ключ) % N</code> с новым <code>N</code> даёт другую партицию. " +
        "Уже записанное при этом никуда не переезжает — старые события ключа остаются на старом месте, новые уходят в другое, " +
        "и порядок для этого ключа рвётся. Об этом — глава про ключ.</li>" +
        "<li>Каждая партиция — это открытые файлы, память под буферы, свои реплики и время на выборы лидеров, когда брокер упал. " +
        "Счёт идёт на тысячи партиций на брокер: потолок упирается в железо и в скорость восстановления, а не в строчку конфига.</li>" +
        "<li>Порядок гарантирован <b>только внутри партиции</b>. Разрезав топик на шесть частей, ты разрезал и порядок.</li>" +
        "</ul>",

        "<p>Partitions are not free, and this is not some abstract “overhead”:</p>" +
        "<ul>" +
        "<li>Partitions are easy to <b>add</b> and <b>impossible to remove</b>. The only way to have fewer is a new topic and copying the data over.</li>" +
        "<li>Adding them rebuilds the layout by [[key|keys]]: <code>hash(key) % N</code> with a new <code>N</code> lands on a different partition. " +
        "What is already written does not move anywhere — the old events of a key stay where they were, the new ones go somewhere else, " +
        "and the order for that key is broken. That is what the chapter on the key is about.</li>" +
        "<li>Every partition means open files, memory for buffers, replicas of its own and time spent electing leaders when a broker goes down. " +
        "The count runs into thousands of partitions per broker: the ceiling is set by the hardware and by recovery speed, not by a line in a config.</li>" +
        "<li>Order is guaranteed <b>only inside a partition</b>. By cutting the topic into six pieces you cut the order into six pieces too.</li>" +
        "</ul>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "[[топик|Топик]] — логическое имя потока, [[партиция|партиции]] — физические логи под ним. Один топик = несколько независимых append-only логов.",
          "<b>«Партиция — единица параллелизма в Kafka»</b>: N партиций = N параллельных потоков записи и не больше N читателей в одной [[consumer group|группе]].",
          "Партиции разложены по [[брокер|брокерам]] — нагрузка делится между машинами, а не только между потоками.",
          "Длины партиций разные, [[offset|offset]]-ы у каждой свои и начинаются с нуля. Общего счётчика у топика нет — как и общего порядка.",
          "Партиций легко добавить и нельзя убрать, а добавление перетасовывает раскладку по [[ключ|ключам]]. Число партиций — решение на годы вперёд."
        ],
        [
          "A [[topic]] is the logical name of a stream, [[partition|partitions]] are the physical logs underneath it. One topic = several independent append-only logs.",
          "<b>“A partition is the unit of parallelism in Kafka”</b>: N partitions = N parallel streams of writes, and no more than N readers in one [[consumer group|group]].",
          "Partitions are spread across [[broker|brokers]] — the load is split between machines, not only between streams.",
          "Partitions have different lengths, and each has its own [[offset]]s starting from zero. The topic has no shared counter — and no shared order either.",
          "Partitions are easy to add and impossible to remove, and adding them reshuffles the layout by [[key|keys]]. The number of partitions is a decision for years ahead."
        ]
      )));
    }
  });
})();
