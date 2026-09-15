/* Глава 02 — Топик и партиции. Стенд про пропускную способность. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "partitions",
    num: 2,
    group: "Устройство",
    nav: "Топик и партиции",
    title: "Топик — это несколько логов сразу",
    lede: "<code>orders</code> — это <b>имя</b>, а не файл. Физически топик разрезан на несколько независимых логов — партиций. Вопрос главы: что ты покупаешь каждой следующей партицией.",

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(
        "<p>В коде живёт только [[топик]]: продюсер пишет «в <code>orders</code>», консьюмер читает «из <code>orders</code>». " +
        "Это логический уровень — именованный поток событий одного типа: <code>orders</code>, <code>payments</code>, <code>user-clicks</code>. " +
        "Слово «партиция» в прикладном коде почти не встречается.</p>" +
        "<p>А на дисках брокеров лежит другое. Топик <code>orders</code> — это набор [[партиция|партиций]], и каждая партиция " +
        "самостоятельный append-only лог со своей нумерацией с нуля. Скажем, партиция 0 — записи 0…4, партиция 1 — 0…2, партиция 2 — 0…6. " +
        "<strong>Длины разные, и это нормально:</strong> партиции ничего друг о друге не знают, общего счётчика у топика нет.</p>"
      ));

      root.appendChild(ui.note("key", "выучить дословно",
        "<p><strong>«[[партиция|Партиция]] — единица параллелизма в Kafka».</strong></p>" +
        "<p>Один лог — один поток записи, и упирается он в одну машину: это потолок. Три партиции — три независимых потока, " +
        "а лежат они на разных [[брокер|брокерах]], то есть делится не только работа, но и железо. " +
        "Число партиций — это и есть объявленная пропускная способность топика.</p>"
      ));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: "Пропускная способность топика",
        hint: "Двигай ползунок и смотри, за сколько тактов ляжет один и тот же поток"
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

      function pPart(n) { return util.plural(n, "партиция", "партиции", "партиций"); }
      function pPartLoc(n) { return util.plural(n, "партиции", "партициях", "партициях"); }
      function pTick(n) { return util.plural(n, "такт", "такта", "тактов"); }
      function pRec(n) { return util.plural(n, "запись", "записи", "записей"); }
      function pEv(n) { return util.plural(n, "событие", "события", "событий"); }
      function pLog(n) { return util.plural(n, "лог", "лога", "логов"); }
      function pBrok(n) { return util.plural(n, "брокер", "брокера", "брокеров"); }
      function brokerOf(i) { return (i % BROKERS) + 1; }
      function used() { return Math.min(N, BROKERS); }
      function needTicks(n) { return Math.ceil(TOTAL / n); }
      function paintCell(c) { if (c) c.style.background = "var(--write-soft)"; }

      var RUN_LABEL = "Пустить поток из " + TOTAL + " " + pEv(TOTAL);

      function timesWord(r) {
        if (Math.abs(r - Math.round(r)) < 0.05) {
          var n = Math.round(r);
          return n + " " + util.plural(n, "раз", "раза", "раз");
        }
        return (Math.round(r * 10) / 10).toFixed(1).replace(".", ",") + " раза";
      }

      /* --- поток от продюсера --- */

      var producer = ui.node("producer", "продюсер", "пишет в orders");

      var streamTrack = el("div.kv-strip__track", { style: { "padding-right": "8px" } });
      var streamEmpty = el("div.kv-strip__empty", {
        text: "поток разобран — все " + TOTAL + " " + pEv(TOTAL) + " лежат в партициях"
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
          var c = el("div.kv-cell", { title: "событие №" + ev + " — ещё не записано" }, String(ev));
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
          "за такт топик принимает по одной записи на партицию &nbsp;·&nbsp; " +
          "<b>" + TOTAL + "</b> " + pEv(TOTAL) + " ÷ <b>" + N + "</b> " + pPart(N) +
          " → <b>" + t + " " + pTick(t) + "</b>" +
          (TOTAL % N ? " <span>(последний такт неполный)</span>" : "");
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
            label: "партиция " + i,
            sub: "брокер " + brokerOf(i),
            empty: "пусто"
          });
          strips.push(s);
          logWrap.appendChild(s.el);
        }
        topicTitle.textContent = "топик orders · " + N + " " + pPart(N) +
          " на " + used() + " " + util.plural(used(), "брокере", "брокерах", "брокерах");
      }

      var readHint = el("div", {
        style: { "font-size": "12px", color: "var(--faint)", "margin-top": "10px", "max-width": "70ch" },
        text: "В клетке — номер события в общем потоке, под клеткой — его offset внутри партиции. " +
          "Номера потока идут подряд, а offset-ы у каждой партиции свои и начинаются с нуля."
      });

      /* --- показатели --- */

      var stTicks = ui.stat("тактов затрачено", 0);
      var stRate = ui.stat("за такт принимает", N, { unit: "зап." });
      var stDone = ui.stat("записано", 0, { unit: "из " + TOTAL });
      var stWait = ui.stat("ждут в потоке", TOTAL);
      var stBrok = ui.stat("брокеров под нагрузкой", BROKERS, { unit: "из " + BROKERS });
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
      var loadPanel = ui.panel("загрузка партиций",
        el("div", {
          style: { "font-size": "12px", color: "var(--faint)", "margin-bottom": "9px" },
          text: "какая доля потока досталась каждой"
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
              text: "п" + i + " · брокер " + brokerOf(i)
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
      var brokersPanel = ui.panel("кластер: " + BROKERS + " " + pBrok(BROKERS), brokersBody);

      function buildBrokers() {
        KV.clear(brokersBody);
        for (var b = 1; b <= BROKERS; b++) {
          var mine = [];
          for (var i = 0; i < N; i++) if (brokerOf(i) === b) mine.push("п" + i);
          var node = ui.node(null, "брокер " + b, mine.length ? mine.join(", ") : "по этому топику простаивает");
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
        histRow.appendChild(el("span.kv-ctl__label", { text: "прогоны" }));
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
            title: "событие №" + ev + " · партиция " + p + " · offset " + off
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
        stage.say("Такт <b>" + ticks + "</b>: топик разом откусил от потока " + takeNow + " " + pRec(takeNow) +
          (takeNow === N
            ? " — по одной на каждую партицию. "
            : " — поток кончается, и работы хватило не всем партициям: остальные в этом такте простояли. ") +
          "В потоке осталось " + pending.length + ".");
      }

      function conclude() {
        var lens = strips.map(function (s) { return s.records.length; });
        var even = lens.every(function (v) { return v === lens[0]; });

        var html = "<b>Поток разложен за " + ticks + " " + pTick(ticks) + ".</b> " +
          "За один такт топик принимает столько записей, сколько у него партиций — " + N + ". " +
          "Отсюда вся арифметика: " + TOTAL + " ÷ " + N + " → " + ticks + ". ";

        if (N === 1) {
          html += "Одна партиция — один поток записи: события выстроились в затылок друг другу, и никакое железо этого не ускорит. ";
        } else {
          html += "Партиции работали параллельно и независимо: каждая вела свою нумерацию с нуля. ";
        }

        html += N === 1
          ? "В единственном логе " + lens[0] + " " + pRec(lens[0]) + " — весь поток целиком. "
          : "Длины получились " + lens.join(", ") +
            (even ? " — поток разделился без остатка. "
                  : " — разные, и это нормально: общего счётчика у топика нет. ");

        html += used() < BROKERS
          ? "Под нагрузкой " + used() + " " + pBrok(used()) +
            " из " + BROKERS + " — остальное железо по этому топику простаивает."
          : "Все " + BROKERS + " " + pBrok(BROKERS) +
            " под нагрузкой — запись делится не только между потоками, но и между машинами.";

        var cmp = null;
        Object.keys(history).map(Number).forEach(function (k) {
          if (k === N || history[k] === ticks) return;
          if (cmp === null || Math.abs(history[k] - ticks) > Math.abs(history[cmp] - ticks)) cmp = k;
        });
        if (cmp !== null) {
          var t2 = history[cmp];
          html += " <b>Для сравнения:</b> при " + cmp + " " + pPartLoc(cmp) + " тот же поток уложился за " +
            t2 + " " + pTick(t2) + " — в " +
            (t2 > ticks ? timesWord(t2 / ticks) + " дольше." : timesWord(ticks / t2) + " быстрее.");
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
        stage.say("Остановлено на такте <b>" + ticks + "</b>: из " + TOTAL + " " + pEv(TOTAL) +
          " топик успел забрать " + (TOTAL - pending.length) + ", в потоке ещё " +
          (pending.length === 1 ? "ждёт" : "ждут") + " " + pending.length + ". " +
          "Жми «пустить поток» — прогон начнётся с чистого топика.");
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
        runBtn.textContent = "Стоп";
        nRange.input.disabled = true;
        renderStats();
        step();
        timer = api.interval(TICK_MS, step);
      }

      function setN(v) {
        N = v;
        arm("Партиций теперь <b>" + N + "</b>. Пропускная способность топика — " + N + " " + pRec(N) +
          " за такт, значит " + TOTAL + " " + pEv(TOTAL) + " лягут за <b>" + needTicks(N) + " " + pTick(needTicks(N)) + "</b>. " +
          (N === 1
            ? "Одна партиция — один поток: всё выстроится в очередь."
            : "Партиций " + N + ", брокеров под нагрузкой " + used() + ".") +
          " Жми «пустить поток» и проверь.");
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
              title: "событие №" + ev + " · партиция " + p + " · offset " + recs[p].length
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
        stage.say("Так выглядит топик <code>orders</code> после одного прогона: " + N + " независимых " + pLog(N) +
          " на " + used() + " " + util.plural(used(), "брокере", "брокерах", "брокерах") +
          ", " + TOTAL + " " + pEv(TOTAL) + " уже разъехались по ним за <b>" + t + " " + pTick(t) + "</b>. " +
          "Длины партиций разные — партиции друг о друге не знают. Нажми «пустить поток», чтобы увидеть это по тактам, " +
          "а потом поставь ползунок на 1 и сравни.");
      }

      /* --- контролы --- */

      var runBtn = ui.btn(RUN_LABEL, function () {
        if (running) stopEarly(); else startRun();
      }, { variant: "primary" });

      var nRange = ui.range({
        label: "партиций", min: 1, max: 6, value: N,
        onInput: function (v) { setN(v); }
      });

      var resetBtn = ui.btn("Сброс", function () {
        arm("Сброшено: топик пуст, " + TOTAL + " " + pEv(TOTAL) + " снова ждут в потоке. Партиций " + N +
          " — по расчёту понадобится " + needTicks(N) + " " + pTick(needTicks(N)) + ".");
      }, { variant: "ghost", sm: true });

      var clearHist = ui.btn("Очистить журнал", function () {
        history = {};
        renderHistory();
        stage.say("Журнал прогонов пуст.");
      }, { variant: "ghost", sm: true });

      /* --- сборка стенда --- */

      stage.body.appendChild(ui.panel("поток от продюсера · " + TOTAL + " " + pEv(TOTAL),
        el("div.kv-row", { style: { "margin-bottom": "8px" } },
          producer,
          ui.badge("события идут по порядку: 0 → " + (TOTAL - 1), "write")),
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

      root.appendChild(ui.prose(
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
        "Это тема отдельной главы, но решение принимается здесь — в момент, когда выбирается число партиций.</p>"
      ));

      root.appendChild(ui.note("warn", "цена вопроса",
        "<p>Партиции не бесплатны, и это не абстрактное «накладные расходы»:</p>" +
        "<ul>" +
        "<li>Партиций легко <b>добавить</b> и <b>нельзя убрать</b>. Единственный способ уменьшить — новый топик и перелив данных.</li>" +
        "<li>Добавление пересобирает раскладку по [[ключ|ключам]]: <code>hash(ключ) % N</code> с новым <code>N</code> даёт другую партицию. " +
        "Уже записанное при этом никуда не переезжает — старые события ключа остаются на старом месте, новые уходят в другое, " +
        "и порядок для этого ключа рвётся. Об этом — глава про ключ.</li>" +
        "<li>Каждая партиция — это открытые файлы, память под буферы, свои реплики и время на выборы лидеров, когда брокер упал. " +
        "Счёт идёт на тысячи партиций на брокер: потолок упирается в железо и в скорость восстановления, а не в строчку конфига.</li>" +
        "<li>Порядок гарантирован <b>только внутри партиции</b>. Разрезав топик на шесть частей, ты разрезал и порядок.</li>" +
        "</ul>"
      ));

      root.appendChild(ui.takeaway([
        "[[топик|Топик]] — логическое имя потока, [[партиция|партиции]] — физические логи под ним. Один топик = несколько независимых append-only логов.",
        "<b>«Партиция — единица параллелизма в Kafka»</b>: N партиций = N параллельных потоков записи и не больше N читателей в одной [[consumer group|группе]].",
        "Партиции разложены по [[брокер|брокерам]] — нагрузка делится между машинами, а не только между потоками.",
        "Длины партиций разные, [[offset|offset]]-ы у каждой свои и начинаются с нуля. Общего счётчика у топика нет — как и общего порядка.",
        "Партиций легко добавить и нельзя убрать, а добавление перетасовывает раскладку по [[ключ|ключам]]. Число партиций — решение на годы вперёд."
      ]));
    }
  });
})();
