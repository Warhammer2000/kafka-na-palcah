/* Глава 06 — Lag: committed offset, LEO и разрыв между ними. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "lag",
    num: 6,
    group: "Чтение",
    nav: "Committed offset и lag",
    title: "Lag — главная метрика здоровья",
    lede: "Продюсер пишет, консьюмер читает — и почти никогда с одинаковой скоростью. Разрыв между концом лога и закладкой группы называется <b>lag</b>: <code>LEO − committed offset</code>. Это первое число, на которое смотрят, когда спрашивают «у нас всё в порядке?».",

    build: function (root, api) {

      /* ================= подводка ================= */

      root.appendChild(ui.prose(
        "<p>У группы есть закладка — [[committed offset]]. Это номер <strong>следующего</strong> сообщения, которое группа " +
        "возьмёт, а не номер последнего обработанного: закладка на <code>5</code> означает, что <code>0…4</code> разобраны, " +
        "а <code>5</code> ещё нет. Лежит она не в памяти процесса, а <strong>в самой Kafka</strong>, в служебном топике " +
        "[[__consumer_offsets]]. Поэтому падение консьюмера почти ничего не стоит: поднялся, спросил у Kafka свою позицию, " +
        "продолжил с неё.</p>" +
        "<p>У партиции есть конец — [[LEO]], номер, который получит следующая запись продюсера. Обе позиции живут в одной " +
        "шкале offset'ов и всегда внутри <strong>одной</strong> партиции — отсюда и простое вычитание, и то, что [[lag]] " +
        "у каждой партиции свой.</p>"
      ));

      root.appendChild(ui.note("key", "пример",
        "<p>Продюсер дописал [[партиция|партицию]] до <code>LEO 9</code>, группа стоит на <code>5</code> → " +
        "<code>lag = 9 − 5 = 4</code>. Не прочитаны записи 5, 6, 7, 8 — четыре сообщения отставания.</p>" +
        "<p>Это лента новостей: написали сто постов, ты прочитал шестьдесят — отстал на сорок. " +
        "Пишут быстрее, чем ты читаешь, — разрыв растёт, и всё, что ты видишь, всё дальше от «сейчас».</p>"
      ));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Продюсер, консьюмер и разрыв между ними",
        hint: "Разгони продюсера сильнее консьюмера и смотри, что делает lag"
      });

      var N = 3;
      var TICK = 100;           // мс на такт потока
      var WINDOW = 60;          // сколько записей держим в ленте
      var TRIM = 20;            // на сколько подрезаем за раз
      var CATCHUP_RATE = 9;     // скорость чтения после подъёма
      var W = [0.42, 0.34, 0.24]; // доли ключей по партициям — потоки неравные, как в жизни

      var rnd = util.rng(60606);

      /* --- ключи разложены по партициям настоящей формулой hash(ключ) % 3 --- */
      var buckets = [];
      for (var b = 0; b < N; b++) buckets.push([]);
      for (var ki = 1; ki <= 48; ki++) {
        var kk = "u" + ki;
        buckets[util.partitionFor(kk, N)].push(kk);
      }
      for (b = 0; b < N; b++) if (!buckets[b].length) buckets[b].push("u" + b);

      /* --- состояние --- */
      var parts = [];
      var prodRate = 3, consRate = 3;
      var alive = true, paused = false, catchUp = false;
      var stalled = -1;
      var prodAcc = 0, consAcc = 0;
      var tickN = 0, dirty = true;
      var lagHist = [];

      /* --- узлы --- */
      var prodNode = ui.node("producer", "продюсер", "пишет 3/с");
      var consNode = ui.node("consumer", "группа orders-worker", "читает 3/с");
      var prodMeta = prodNode.querySelector(".kv-node__meta");
      var consMeta = consNode.querySelector(".kv-node__meta");
      var statusBadge = ui.badge("поток в норме", "good");
      var trendBadge = ui.badge("lag держится", null);

      var topRow = el("div.kv-row", { style: { "margin-bottom": "14px" } },
        prodNode,
        el("span.kv-ctl__label", { text: "→ топик orders, 3 партиции →" }),
        consNode,
        statusBadge,
        trendBadge);

      /* --- верхние плитки --- */
      var sumLag = ui.stat("lag группы", 0, { unit: "сообщ.", tone: "good" });
      sumLag.el.style.minWidth = "168px";
      var sumLeo = ui.stat("записано всего", 0, { tone: "write" });
      var sumCom = ui.stat("прочитано всего", 0, { tone: "read" });
      var freshStat = ui.stat("свежесть данных", 0, { unit: "с назад" });
      var topStats = ui.stats(sumLag.el, sumLeo.el, sumCom.el, freshStat.el);
      topStats.style.marginBottom = "16px";

      /* --- ряды партиций --- */
      var rows = el("div.kv-col");

      for (var i = 0; i < N; i++) {
        (function (idx) {
          var strip = ui.logStrip({ empty: "лог пуст" });
          var sLeo = ui.stat("LEO", 0, { tone: "write" });
          var sCom = ui.stat("committed", 0, { tone: "read" });
          var sLag = ui.stat("lag", 0, { tone: "good" });
          var bar = ui.bar(0);
          var barWrap = el("div", { style: { margin: "10px 0 4px" } }, bar.el);
          var panel = ui.panel("партиция " + idx,
            ui.stats(sLeo.el, sCom.el, sLag.el),
            barWrap,
            strip.el);
          rows.appendChild(panel);
          parts.push({
            strip: strip, committed: 0, keys: buckets[idx],
            sLeo: sLeo, sCom: sCom, sLag: sLag, bar: bar,
            titleEl: panel.querySelector(".kv-panel__t")
          });
        })(i);
      }

      /* --- живая формула и служебный топик --- */
      var formula = ui.terminal("");
      var offsets = ui.terminal("");
      var bottom = el("div.kv-split", { style: { "margin-top": "16px" } },
        ui.panel("живая формула", formula.el),
        ui.panel("__consumer_offsets · где лежит закладка", offsets.el));

      KV.append(stage.body, topRow, topStats, rows, bottom);

      /* ================= модель ================= */

      function lagOf(p) { return p.strip.leo() - p.committed; }

      function totalLag() {
        var s = 0;
        parts.forEach(function (p) { s += lagOf(p); });
        return s;
      }

      /** Отставание по партициям, которые консьюмер реально разбирает. */
      function reachableLag() {
        var s = 0;
        parts.forEach(function (p, idx) { if (idx !== stalled) s += lagOf(p); });
        return s;
      }

      function pickPartition() {
        var r = rnd(), acc = 0;
        for (var j = 0; j < N; j++) { acc += W[j]; if (r < acc) return j; }
        return N - 1;
      }

      function randKey(p) { return p.keys[Math.floor(rnd() * p.keys.length)]; }

      function trim(p) {
        var len = p.strip.records.length;
        if (len <= WINDOW + TRIM) return;
        var drop = len - WINDOW;
        var kept = p.strip.records.slice(drop);
        var nb = p.strip.base + drop;
        p.strip.setRecords(kept);
        p.strip.setBase(nb);
      }

      function produceOne() {
        var p = parts[pickPartition()];
        p.strip.push({ key: randKey(p) });
        trim(p);
      }

      /** Консьюмер разбирает партицию с самым большим отставанием. */
      function consumeOne() {
        var best = -1, bestLag = 0;
        for (var j = 0; j < N; j++) {
          if (j === stalled) continue;
          var lg = lagOf(parts[j]);
          if (lg > bestLag) { bestLag = lg; best = j; }
        }
        if (best < 0) return false;
        var p = parts[best];
        p.strip.highlight(p.committed, "is-reading", 280);
        p.committed++;
        return true;
      }

      function consumerRate() {
        if (!alive) return 0;
        return catchUp ? Math.max(consRate, CATCHUP_RATE) : consRate;
      }

      function simulate() {
        var dt = TICK / 1000, guard;

        /* обычная скорость уже не ниже «догоняющей» — догонять нечем */
        if (catchUp && consRate >= CATCHUP_RATE) { catchUp = false; dirty = true; }

        prodAcc += prodRate * dt;
        guard = 0;
        while (prodAcc >= 1 && guard++ < 24) { prodAcc -= 1; produceOne(); dirty = true; }

        var cr = consumerRate();
        if (cr <= 0) { consAcc = 0; return; }
        consAcc += cr * dt;
        guard = 0;
        while (consAcc >= 1 && guard++ < 24) {
          consAcc -= 1;
          if (!consumeOne()) { consAcc = 0; break; }
          dirty = true;
        }

        if (catchUp && reachableLag() <= 1) {
          catchUp = false;
          dirty = true;
          stage.say("<b>Догнал.</b> Ни одна запись не прочитана дважды и ни одна не пропущена: чтение пошло ровно с сохранённых " +
            "позиций. Догнать удалось только потому, что консьюмер читал <b>быстрее</b>, чем писал продюсер, — при равных скоростях " +
            "разрыв просто застыл бы на месте.");
        }
      }

      /* ================= отрисовка ================= */

      function lagTone(lg) { return lg > 15 ? "bad" : lg > 6 ? "warn" : "good"; }
      function barTone(lg) { return lg > 15 ? "bad" : lg > 6 ? "warn" : null; }

      function pad(v, w) {
        var s = String(v);
        while (s.length < w) s = " " + s;
        return s;
      }
      function cell(v, cls) { return '<span class="' + cls + '">' + pad(v, 4) + "</span>"; }

      function refresh() {
        var tLeo = 0, tCom = 0;
        var fLines = ['<span class="t-dim">lag = LEO − committed offset</span>'];
        var oLines = ['<span class="t-dim">group = orders-worker</span>'];

        parts.forEach(function (p, idx) {
          var leo = p.strip.leo(), com = p.committed, lg = leo - com;
          tLeo += leo; tCom += com;
          p.sLeo.set(leo, "write");
          p.sCom.set(com, "read");
          p.sLag.set(lg, lagTone(lg));
          p.bar.set(lg / 30, barTone(lg));
          p.strip.marker("committed", {
            at: com,
            label: "committed " + com + (com < p.strip.base ? " ◀" : ""),
            color: "var(--read)"
          });
          p.titleEl.textContent = idx === stalled
            ? "партиция " + idx + " · обработка подвисла"
            : "партиция " + idx;
          fLines.push("партиция " + idx + "   " + cell(leo, "t-w") + " − " + cell(com, "t-r") +
            " = " + cell(lg, lg > 15 ? "t-bad" : lg > 6 ? "t-w" : "t-good"));
          oLines.push("orders-" + idx + "   offset =" + cell(com, "t-r"));
        });

        var lag = tLeo - tCom;
        sumLag.set(lag, lag > 45 ? "bad" : lag > 18 ? "warn" : "good");
        sumLeo.set(tLeo, "write");
        sumCom.set(tCom, "read");

        var rate = alive ? consRate : 0;
        freshStat.set(rate > 0 ? fmtSec(lag / rate) : "∞", rate > 0 && lag / rate > 10 ? "bad" : null);

        fLines.push('<span class="t-dim">' + new Array(32).join("─") + "</span>");
        fLines.push("группа       " + cell(tLeo, "t-w") + " − " + cell(tCom, "t-r") +
          " = " + cell(lag, lag > 45 ? "t-bad" : lag > 18 ? "t-w" : "t-good"));
        formula.clear();
        formula.line(fLines.join("\n"));

        oLines.push(alive
          ? '<span class="t-dim">commit = запись в этот топик</span>'
          : '<span class="t-good">процесс мёртв, а позиции целы</span>');
        offsets.clear();
        offsets.line(oLines.join("\n"));

        consNode.classList.toggle("kv-node--dead", !alive);
        consMeta.textContent = !alive ? "процесс упал"
          : catchUp ? "догоняет, " + consumerRate() + "/с"
            : "читает " + consRate + "/с";
        prodMeta.textContent = "пишет " + prodRate + "/с";

        setBadge(statusBadge, statusText(lag), statusTone(lag));
      }

      function fmtSec(v) {
        if (v >= 10) return String(Math.round(v));
        return v.toFixed(1).replace(".", ",");
      }

      function setBadge(node, text, tone) {
        node.textContent = text;
        node.className = "kv-badge" + (tone ? " kv-badge--" + tone : "");
      }

      function statusText(lag) {
        if (!alive) return "консьюмер упал";
        if (paused) return "пауза";
        if (stalled >= 0) return "партиция " + stalled + " не обрабатывается";
        if (catchUp) return "догоняет";
        if (consRate === 0) return "консьюмер не читает";
        if (lag > 45) return "группа отстаёт";
        return "поток в норме";
      }

      function statusTone(lag) {
        if (!alive) return "bad";
        if (paused) return null;
        if (stalled >= 0 || lag > 45) return "warn";
        if (catchUp) return "read";
        if (consRate === 0) return "warn";
        return "good";
      }

      function updateTrend() {
        if (paused) { setBadge(trendBadge, "поток на паузе", null); return; }
        if (lagHist.length < 2) { setBadge(trendBadge, "lag держится", null); return; }
        var d = lagHist[lagHist.length - 1] - lagHist[0];
        if (d > 1.5) setBadge(trendBadge, "lag растёт ▲", "bad");
        else if (d < -1.5) setBadge(trendBadge, "lag падает ▼", "good");
        else setBadge(trendBadge, "lag держится", null);
      }

      /* ================= такт ================= */

      api.interval(TICK, function () {
        if (!paused) simulate();
        if (dirty) { refresh(); dirty = false; }
        if (++tickN % 10 === 0) {
          lagHist.push(totalLag());
          if (lagHist.length > 4) lagHist.shift();
          updateTrend();
        }
      });

      /* ================= управление ================= */

      var prodRange = ui.range({
        label: "продюсер, сообщ/с", min: 0, max: 10, value: prodRate,
        onInput: function (v) {
          prodRate = v;
          dirty = true;
          refresh();
          if (!alive) {
            stage.say(v > 0
              ? "Консьюмер лежит, разбирать некому — весь поток уходит в отставание: <b>" + v + "</b> сообщ/с прибавляется " +
                "к lag каждую секунду. Скорость чтения снова начнёт что-то значить только после «поднять консьюмера»."
              : "И консьюмер лежит, и продюсер молчит — lag застыл на достигнутом. Ничего не потеряно: записи в логе, " +
                "позиции — в <code>__consumer_offsets</code>.");
          } else if (v > consRate) {
            stage.say("Продюсер пишет <b>" + v + "/с</b>, консьюмер разбирает <b>" + consRate + "/с</b>. " +
              "Разница <b>" + (v - consRate) + "</b> сообщ/с копится каждую секунду: lag растёт линейно и сам не остановится.");
          } else if (v < consRate) {
            stage.say("Продюсер медленнее консьюмера — накопленный lag начнёт таять со скоростью <b>" +
              (consRate - v) + "</b> сообщ/с.");
          } else {
            stage.say("Скорости сравнялись на <b>" + v + "/с</b>. Lag больше не растёт — но и накопленный разрыв так не уйдёт: " +
              "он просто застывает на достигнутом.");
          }
        }
      });

      var consRange = ui.range({
        label: "консьюмер, сообщ/с", min: 0, max: 10, value: consRate,
        onInput: function (v) {
          consRate = v;
          if (v > 0) catchUp = false;
          dirty = true;
          refresh();
          if (!alive) {
            stage.say("Ползунок стоит на <b>" + v + "/с</b>, но процесс лежит — читать всё равно некому. " +
              "Эта скорость заработает только после «поднять консьюмера».");
          } else if (v === 0) {
            stage.say("Консьюмер жив, но не читает ни одного сообщения — для lag это ровно то же самое, что падение. " +
              "Метрика меряет <b>результат</b>, а не самочувствие процесса.");
          } else {
            stage.say("Скорость чтения <b>" + v + "/с</b> против записи <b>" + prodRate + "/с</b>. " +
              (v > prodRate ? "Запас есть — отставание будет рассасываться."
                : v === prodRate ? "Скорости равны: lag не растёт, но и накопленный разрыв сам не уйдёт."
                  : "Читаем медленнее, чем пишем, — отставание копится."));
          }
        }
      });

      var btnDrop = ui.btn("Уронить консьюмера", function () {
        if (!alive) return;
        alive = false; catchUp = false; consAcc = 0;
        btnDrop.disabled = true; btnUp.disabled = false;
        dirty = true; refresh();
        stage.say("<b>Консьюмер упал.</b> Продюсер этого даже не заметил и пишет как писал — значит, lag теперь растёт ровно со " +
          "скоростью записи. Ничего не потеряно: записи лежат в логе, а закладки группы — в <code>__consumer_offsets</code>, " +
          "смотри правую панель.");
      }, { variant: "danger" });

      var btnUp = ui.btn("Поднять консьюмера", function () {
        if (alive) return;
        alive = true; catchUp = true;
        btnDrop.disabled = false; btnUp.disabled = true;
        parts.forEach(function (p) { p.strip.highlight(p.committed, "is-reading", 1200); });
        var pos = parts.map(function (p, idx) { return "p" + idx + " = " + p.committed; }).join(", ");
        dirty = true; refresh();
        stage.say("<b>Консьюмер поднялся.</b> Первым делом он спросил у Kafka свои позиции — <code>" + pos + "</code> — " +
          "и продолжил <b>ровно с них</b>: не с нуля и не с конца лога. Пока разрыв большой, он читает на полной скорости " +
          "(" + consumerRate() + "/с) и догоняет.");
      }, { variant: "read" });
      btnUp.disabled = true;

      var btnStall = ui.btn("Подвесить обработку партиции 2", function () {
        stalled = stalled === 2 ? -1 : 2;
        var on = stalled === 2;
        btnStall.textContent = on ? "Отпустить партицию 2" : "Подвесить обработку партиции 2";
        btnStall.setAttribute("aria-pressed", String(on));
        dirty = true; refresh();
        stage.say((on
          ? "Обработчик партиции 2 залип на медленном запросе. Остальные две партиции читаются как ни в чём не бывало и уходят " +
            "в ноль, поэтому <b>суммарный</b> lag растёт лениво и дежурного не будит. Подожди, пока полоска партиции 2 покраснеет, " +
            "и сравни её со спокойным числом наверху."
          : "Обработчик отпустило — партиция 2 разбирает накопленное.") +
          (alive ? "" : " Но сейчас лежит весь консьюмер — сначала подними его, иначе разницы между партициями не увидеть."));
      }, { sm: true });

      var btnPause = ui.btn("Пауза", function () {
        paused = !paused;
        btnPause.textContent = paused ? "Продолжить" : "Пауза";
        btnPause.setAttribute("aria-pressed", String(paused));
        dirty = true; refresh(); updateTrend();
        stage.say(paused
          ? "Время остановлено. Числа замерли: <code>LEO − committed</code> считается не по таймеру, а просто по двум позициям."
          : "Поток пошёл дальше.");
      }, { sm: true, variant: "ghost" });

      var btnReset = ui.btn("Сброс", function () { reset(true); }, { sm: true, variant: "ghost" });

      KV.append(stage.controls, prodRange.el, consRange.el, btnDrop, btnUp, btnStall, btnPause, btnReset);

      /* ================= старт ================= */

      function reset(loud) {
        parts.forEach(function (p) {
          var n = 12 + Math.floor(rnd() * 5);
          var recs = [];
          for (var j = 0; j < n; j++) recs.push({ key: randKey(p) });
          p.strip.setBase(0);
          p.strip.setRecords(recs);
          p.committed = Math.max(0, n - 1 - Math.floor(rnd() * 3));
          p.strip.scrollEnd();
        });
        prodRate = 3; consRate = 3;
        prodRange.set(3); consRange.set(3);
        alive = true; catchUp = false; paused = false; stalled = -1;
        prodAcc = 0; consAcc = 0; lagHist = [];
        btnDrop.disabled = false; btnUp.disabled = true;
        btnPause.textContent = "Пауза"; btnPause.setAttribute("aria-pressed", "false");
        btnStall.textContent = "Подвесить обработку партиции 2";
        btnStall.setAttribute("aria-pressed", "false");
        dirty = true; refresh(); updateTrend();
        stage.say(loud
          ? "Сброшено: снова 3/с против 3/с."
          : "Поток уже идёт: продюсер пишет 3 сообщ/с, консьюмер разбирает столько же, lag болтается около нуля — " +
            "так выглядит здоровая система. Дальше ломай: разгони продюсера или урони консьюмера.");
      }

      root.appendChild(stage.el);
      reset(false);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
        "<h3>Что ты сейчас покрутил</h3>" +
        "<ul>" +
        "<li><strong>Скорости равны</strong> — lag стоит на месте: сколько записей пришло, столько и разобрали. Это и есть «здорово».</li>" +
        "<li><strong>Продюсер быстрее</strong> — lag растёт <em>линейно</em> и сам не вернётся. Чтобы догнать, нужен запас скорости, " +
        "а не равенство: при 5 против 5 уже накопленный разрыв просто застывает на достигнутом.</li>" +
        "<li><strong>Консьюмер упал</strong> — lag растёт ровно со скоростью записи. Копится не потеря, а <em>работа</em>: " +
        "записи лежат в логе целыми.</li>" +
        "<li><strong>Консьюмер поднялся</strong> — он начал с [[committed offset]], а не с нуля и не с конца лога. " +
        "Ни одного повтора, ни одного пропуска. Именно за это отвечает <code>__consumer_offsets</code>.</li>" +
        "</ul>" +
        "<h4>Lag в сообщениях и lag во времени</h4>" +
        "<p>«Тысяча сообщений отставания» сама по себе не значит ничего. При 500 сообщ/с это две секунды — норма. " +
        "При 5 сообщ/с это больше трёх минут — для антифрода катастрофа. Поэтому lag переводят во время: плитка " +
        "<strong>«свежесть данных»</strong> делит его на скорость чтения. Пока чтение и запись идут вровень, это и есть " +
        "возраст самой старой неразобранной записи; а когда консьюмер встал, плитка честно показывает <code>∞</code> — " +
        "разбирать накопленное нечем.</p>" +
        "<p>Оговорка по стенду: здесь группа делает [[commit]] сразу после каждой записи. В жизни коммитят пачками и по таймеру, " +
        "поэтому committed offset скачет не по одному — на смысл lag это не влияет, а на риск повторной обработки влияет сильно. " +
        "Это следующая глава.</p>"
      ));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>Суммарный lag прячет мёртвую партицию.</strong> Нажми «подвесить обработку партиции 2»: " +
        "две партиции читаются, общее число растёт лениво и не тревожит дежурного, а одна партиция не двигается вовсе — " +
        "и по её ключам данные уже безнадёжно устарели.</p>" +
        "<p>Поэтому lag всегда смотрят <strong>по партициям</strong>, а алерт ставят на максимум по партициям, а не на сумму. " +
        "Подробный разбор — в главе 13.</p>"
      ));

      root.appendChild(ui.takeaway([
        "<code>lag = LEO − committed offset</code> — сколько записей группа ещё не прочитала.",
        "[[committed offset]] хранится в самой Kafka ([[__consumer_offsets]]), поэтому упавший [[консьюмер]] поднимается и продолжает со своей позиции, а не с нуля.",
        "Lag — это не потеря данных, а <b>накопленная работа</b>. Записи целы; вопрос только в том, насколько устарело то, что ты видишь.",
        "Растущий lag сам не рассосётся: чтобы догнать, нужно читать <b>быстрее</b>, чем пишет продюсер, а не с той же скоростью.",
        "Переводи lag во время (<code>lag ÷ скорость чтения</code>) и смотри его <b>по партициям</b> — сумма прячет одну намертво вставшую."
      ]));
    }
  });
})();
