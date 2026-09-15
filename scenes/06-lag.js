/* Глава 06 — Lag: committed offset, LEO и разрыв между ними. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "lag",
    num: 6,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Чтение", "Reading"],
    nav: ["Committed offset и lag", "Committed offset and lag"],
    title: ["Lag — главная метрика здоровья", "Lag — the main health metric"],
    lede: [
      "Продюсер пишет, консьюмер читает — и почти никогда с одинаковой скоростью. Разрыв между концом лога и закладкой группы называется <b>lag</b>: <code>LEO − committed offset</code>. Это первое число, на которое смотрят, когда спрашивают «у нас всё в порядке?».",
      "The producer writes, the consumer reads — and almost never at the same speed. The gap between the end of the log and the group’s bookmark is called <b>lag</b>: <code>LEO − committed offset</code>. It is the first number anyone looks at when someone asks “are we OK?”."
    ],

    build: function (root, api) {

      /* ================= подводка ================= */

      root.appendChild(ui.prose(L(
        "<p>У группы есть закладка — [[committed offset]]. Это номер <strong>следующего</strong> сообщения, которое группа " +
        "возьмёт, а не номер последнего обработанного: закладка на <code>5</code> означает, что <code>0…4</code> разобраны, " +
        "а <code>5</code> ещё нет. Лежит она не в памяти процесса, а <strong>в самой Kafka</strong>, в служебном топике " +
        "[[__consumer_offsets]]. Поэтому падение консьюмера почти ничего не стоит: поднялся, спросил у Kafka свою позицию, " +
        "продолжил с неё.</p>" +
        "<p>У партиции есть конец — [[LEO]], номер, который получит следующая запись продюсера. Обе позиции живут в одной " +
        "шкале offset'ов и всегда внутри <strong>одной</strong> партиции — отсюда и простое вычитание, и то, что [[lag]] " +
        "у каждой партиции свой.</p>",

        "<p>A group has a bookmark — its [[committed offset]]. It is the number of the <strong>next</strong> message the group " +
        "will take, not the number of the last one processed: a bookmark at <code>5</code> means <code>0…4</code> are done " +
        "and <code>5</code> is not. It lives not in the process’s memory but <strong>inside Kafka itself</strong>, in the " +
        "internal [[__consumer_offsets]] topic. That is why a consumer crash costs almost nothing: it comes back up, asks " +
        "Kafka where it was, and carries on from there.</p>" +
        "<p>A partition has an end — its [[LEO]], the number the producer’s next record will get. Both positions live on the " +
        "same offset scale and always inside <strong>one</strong> partition — hence the plain subtraction, and hence every " +
        "partition having its own [[lag]].</p>"
      )));

      root.appendChild(ui.note("key", L("пример", "example"), L(
        "<p>Продюсер дописал [[партиция|партицию]] до <code>LEO 9</code>, группа стоит на <code>5</code> → " +
        "<code>lag = 9 − 5 = 4</code>. Не прочитаны записи 5, 6, 7, 8 — четыре сообщения отставания.</p>" +
        "<p>Это лента новостей: написали сто постов, ты прочитал шестьдесят — отстал на сорок. " +
        "Пишут быстрее, чем ты читаешь, — разрыв растёт, и всё, что ты видишь, всё дальше от «сейчас».</p>",

        "<p>The producer has filled the [[partition]] up to <code>LEO 9</code>, the group sits at <code>5</code> → " +
        "<code>lag = 9 − 5 = 4</code>. Records 5, 6, 7 and 8 are unread — four messages of lag.</p>" +
        "<p>It is a news feed: a hundred posts were written, you have read sixty — you are forty behind. " +
        "They write faster than you read, the gap grows, and everything you see is further and further from “now”.</p>"
      )));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Продюсер, консьюмер и разрыв между ними",
          "The producer, the consumer and the gap between them"),
        hint: L("Разгони продюсера сильнее консьюмера и смотри, что делает lag",
          "Push the producer faster than the consumer and watch what lag does")
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
      var clock = 0;            // модельное время, с: по нему считаем ВОЗРАСТ записей

      /* --- узлы --- */
      var prodNode = ui.node("producer", L("продюсер", "producer"), L("пишет 3/с", "writes 3/s"));
      var consNode = ui.node("consumer", L("группа orders-worker", "orders-worker group"),
        L("читает 3/с", "reads 3/s"));
      var prodMeta = prodNode.querySelector(".kv-node__meta");
      var consMeta = consNode.querySelector(".kv-node__meta");
      var statusBadge = ui.badge(L("поток в норме", "stream is healthy"), "good");
      var trendBadge = ui.badge(L("lag держится", "lag is steady"), null);

      var topRow = el("div.kv-row", { style: { "margin-bottom": "14px" } },
        prodNode,
        el("span.kv-ctl__label", {
          text: L("→ топик orders, 3 партиции →", "→ topic orders, 3 partitions →")
        }),
        consNode,
        statusBadge,
        trendBadge);

      /* --- верхние плитки --- */
      var sumLag = ui.stat(L("lag группы", "group lag"), 0, { unit: L("сообщ.", "msg"), tone: "good" });
      sumLag.el.style.minWidth = "168px";
      var sumLeo = ui.stat(L("записано всего", "written in total"), 0, { tone: "write" });
      var sumCom = ui.stat(L("прочитано всего", "read in total"), 0, { tone: "read" });
      var freshStat = ui.stat(L("свежесть данных", "data freshness"), 0, { unit: L("с назад", "s ago") });
      var topStats = ui.stats(sumLag.el, sumLeo.el, sumCom.el, freshStat.el);
      topStats.style.marginBottom = "16px";

      /* --- ряды партиций --- */
      var rows = el("div.kv-col");

      for (var i = 0; i < N; i++) {
        (function (idx) {
          var strip = ui.logStrip({ empty: L("лог пуст", "the log is empty") });
          var sLeo = ui.stat("LEO", 0, { tone: "write" });
          var sCom = ui.stat("committed", 0, { tone: "read" });
          var sLag = ui.stat("lag", 0, { tone: "good" });
          var bar = ui.bar(0);
          var barWrap = el("div", { style: { margin: "10px 0 4px" } }, bar.el);
          var panel = ui.panel(L("партиция ", "partition ") + idx,
            ui.stats(sLeo.el, sCom.el, sLag.el),
            barWrap,
            strip.el);
          rows.appendChild(panel);
          parts.push({
            strip: strip, committed: 0, keys: buckets[idx], times: [],
            sLeo: sLeo, sCom: sCom, sLag: sLag, bar: bar,
            titleEl: panel.querySelector(".kv-panel__t")
          });
        })(i);
      }

      /* --- живая формула и служебный топик --- */
      var formula = ui.terminal("");
      var offsets = ui.terminal("");
      var bottom = el("div.kv-split", { style: { "margin-top": "16px" } },
        ui.panel(L("живая формула", "the formula, live"), formula.el),
        ui.panel(L("__consumer_offsets · где лежит закладка",
          "__consumer_offsets · where the bookmark lives"), offsets.el));

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
        /* times[offset] — когда запись НАПИСАЛИ. Лента подрезается, а этот список
           нет: он индексируется абсолютным offset'ом и хранит возраст любой записи. */
        p.times.push(clock);
        p.strip.push({ key: randKey(p) });
        trim(p);
      }

      /** Возраст самой старой непрочитанной записи группы, с.
       *  Это ВОЗРАСТ: сколько прошло с записи, а не сколько разгребать. */
      function oldestAge() {
        var worst = 0;
        parts.forEach(function (p) {
          if (lagOf(p) <= 0) return;
          var t = p.times[p.committed];
          if (typeof t !== "number") return;
          var age = clock - t;
          if (age > worst) worst = age;
        });
        return worst;
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
        /* Ползунок на нуле — читать нечем: «догоняющей» скорости неоткуда взяться
           у консьюмера, который не берёт ни одного сообщения. */
        if (consRate <= 0) return 0;
        return catchUp ? Math.max(consRate, CATCHUP_RATE) : consRate;
      }

      function simulate() {
        var dt = TICK / 1000, guard;
        clock += dt;

        /* «Свежесть данных» — величина времени: пока есть непрочитанное, она растёт
           сама по себе, даже если ни одна запись не сдвинулась (продюсер молчит,
           консьюмер лежит). Значит перерисовывать надо каждый такт, а не только
           по факту записи или чтения — иначе плитка замерзает и врёт. */
        if (totalLag() > 0) dirty = true;

        /* обычная скорость уже не ниже «догоняющей» — догонять нечем;
           ползунок на нуле — догонять некому */
        if (catchUp && (consRate >= CATCHUP_RATE || consRate <= 0)) { catchUp = false; dirty = true; }

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
          stage.say(L(
            "<b>Догнал.</b> Ни одна запись не прочитана дважды и ни одна не пропущена: чтение пошло ровно с сохранённых " +
            "позиций. Догнать удалось только потому, что консьюмер читал <b>быстрее</b>, чем писал продюсер, — при равных скоростях " +
            "разрыв просто застыл бы на месте.",

            "<b>Caught up.</b> Not one record was read twice and not one was skipped: reading resumed exactly from the saved " +
            "positions. Catching up only worked because the consumer read <b>faster</b> than the producer wrote — at equal speeds " +
            "the gap would simply have frozen where it was."));
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
            ? L("партиция ", "partition ") + idx + L(" · обработка подвисла", " · processing is stuck")
            : L("партиция ", "partition ") + idx;
          /* Отступ после номера подобран так, чтобы колонки сошлись в обоих
             языках: «партиция 0» + 3 пробела и «partition 0» + 2 — ровно 13. */
          fLines.push(L("партиция ", "partition ") + idx + L("   ", "  ") +
            cell(leo, "t-w") + " − " + cell(com, "t-r") +
            " = " + cell(lg, lg > 15 ? "t-bad" : lg > 6 ? "t-w" : "t-good"));
          oLines.push("orders-" + idx + "   offset =" + cell(com, "t-r"));
        });

        var lag = tLeo - tCom;
        sumLag.set(lag, lag > 45 ? "bad" : lag > 18 ? "warn" : "good");
        sumLeo.set(tLeo, "write");
        sumCom.set(tCom, "read");

        /* Свежесть — это возраст самой старой непрочитанной записи: сколько времени
           назад её НАПИСАЛ продюсер. Скорость чтения тут ни при чём — она отвечает
           на другой вопрос, за сколько разгрести накопленное. */
        var age = lag > 0 ? oldestAge() : 0;
        freshStat.set(fmtSec(age), age > 10 ? "bad" : age > 4 ? "warn" : null);

        fLines.push('<span class="t-dim">' + new Array(32).join("─") + "</span>");
        fLines.push(L("группа       ", "group        ") + cell(tLeo, "t-w") + " − " + cell(tCom, "t-r") +
          " = " + cell(lag, lag > 45 ? "t-bad" : lag > 18 ? "t-w" : "t-good"));
        formula.clear();
        formula.line(fLines.join("\n"));

        oLines.push(alive
          ? L('<span class="t-dim">commit = запись в этот топик</span>',
            '<span class="t-dim">commit = a write into this topic</span>')
          : L('<span class="t-good">процесс мёртв, а позиции целы</span>',
            '<span class="t-good">the process is dead, the positions are intact</span>'));
        offsets.clear();
        offsets.line(oLines.join("\n"));

        consNode.classList.toggle("kv-node--dead", !alive);
        consMeta.textContent = !alive ? L("процесс упал", "the process is down")
          : catchUp ? L("догоняет, ", "catching up, ") + consumerRate() + L("/с", "/s")
            : L("читает ", "reads ") + consRate + L("/с", "/s");
        prodMeta.textContent = L("пишет ", "writes ") + prodRate + L("/с", "/s");

        setBadge(statusBadge, statusText(lag), statusTone(lag));
      }

      function fmtSec(v) {
        if (v >= 10) return String(Math.round(v));
        /* Дробный разделитель — тоже часть языка: «1,4 с назад» против «1.4 s ago». */
        return v.toFixed(1).replace(".", L(",", "."));
      }

      function setBadge(node, text, tone) {
        node.textContent = text;
        node.className = "kv-badge" + (tone ? " kv-badge--" + tone : "");
      }

      /* Порядок проверок прежний, просто одна точка выхода: строки собираются
         присваиванием, а не сразу в return. */
      function statusText(lag) {
        var t = L("поток в норме", "stream is healthy");
        if (!alive) t = L("консьюмер упал", "consumer is down");
        else if (paused) t = L("пауза", "paused");
        else if (consRate === 0) t = L("консьюмер не читает", "consumer reads nothing");
        else if (stalled >= 0) t = L("партиция ", "partition ") + stalled +
          L(" не обрабатывается", " is not being processed");
        else if (catchUp) t = L("догоняет", "catching up");
        else if (lag > 45) t = L("группа отстаёт", "the group is falling behind");
        return t;
      }

      function statusTone(lag) {
        if (!alive) return "bad";
        if (paused) return null;
        if (consRate === 0) return "warn";
        if (stalled >= 0 || lag > 45) return "warn";
        if (catchUp) return "read";
        return "good";
      }

      function updateTrend() {
        if (paused) { setBadge(trendBadge, L("поток на паузе", "stream paused"), null); return; }
        if (lagHist.length < 2) { setBadge(trendBadge, L("lag держится", "lag is steady"), null); return; }
        var d = lagHist[lagHist.length - 1] - lagHist[0];
        if (d > 1.5) setBadge(trendBadge, L("lag растёт ▲", "lag is growing ▲"), "bad");
        else if (d < -1.5) setBadge(trendBadge, L("lag падает ▼", "lag is falling ▼"), "good");
        else setBadge(trendBadge, L("lag держится", "lag is steady"), null);
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
        label: L("продюсер, сообщ/с", "producer, msg/s"), min: 0, max: 10, value: prodRate,
        onInput: function (v) {
          prodRate = v;
          dirty = true;
          refresh();
          if (!alive) {
            stage.say(v > 0
              ? L("Консьюмер лежит, разбирать некому — весь поток уходит в отставание: <b>",
                "The consumer is down, nobody is processing anything — the whole stream turns into lag: <b>") + v +
                L("</b> сообщ/с прибавляется " +
                  "к lag каждую секунду. Скорость чтения снова начнёт что-то значить только после «поднять консьюмера».",
                  "</b> msg/s is added to lag every second. The reading speed will mean something again only after " +
                  "“restart the consumer”.")
              : L("И консьюмер лежит, и продюсер молчит — lag застыл на достигнутом. Ничего не потеряно: записи в логе, " +
                "позиции — в <code>__consumer_offsets</code>.",
                "The consumer is down and the producer is silent — lag has frozen where it stood. Nothing is lost: the " +
                "records are in the log, the positions are in <code>__consumer_offsets</code>."));
          } else if (v > consRate) {
            stage.say(L("Продюсер пишет <b>", "The producer writes <b>") + v +
              L("/с</b>, консьюмер разбирает <b>", "/s</b>, the consumer handles <b>") + consRate +
              L("/с</b>. ", "/s</b>. ") +
              L("Разница <b>", "The difference of <b>") + (v - consRate) +
              L("</b> сообщ/с копится каждую секунду: lag растёт линейно и сам не остановится.",
                "</b> msg/s piles up every second: lag grows linearly and will not stop on its own."));
          } else if (v < consRate) {
            stage.say(L("Продюсер медленнее консьюмера — накопленный lag начнёт таять со скоростью <b>",
              "The producer is slower than the consumer — the lag that has piled up will start melting away at <b>") +
              (consRate - v) + L("</b> сообщ/с.", "</b> msg/s."));
          } else {
            stage.say(L("Скорости сравнялись на <b>", "The speeds are level at <b>") + v +
              L("/с</b>. Lag больше не растёт — но и накопленный разрыв так не уйдёт: " +
                "он просто застывает на достигнутом.",
                "/s</b>. Lag stops growing — but the gap you already have will not go away like this either: " +
                "it just freezes where it stands."));
          }
        }
      });

      var consRange = ui.range({
        label: L("консьюмер, сообщ/с", "consumer, msg/s"), min: 0, max: 10, value: consRate,
        onInput: function (v) {
          consRate = v;
          catchUp = false;          // тронул ползунок — скорость чтения теперь ровно та, что на нём
          dirty = true;
          refresh();
          if (!alive) {
            stage.say(L("Ползунок стоит на <b>", "The slider says <b>") + v +
              L("/с</b>, но процесс лежит — читать всё равно некому. " +
                "Эта скорость заработает только после «поднять консьюмера».",
                "/s</b>, but the process is down — there is still nobody to read. " +
                "That speed starts working only after “restart the consumer”."));
          } else if (v === 0) {
            stage.say(L(
              "Консьюмер жив, но не читает ни одного сообщения — для lag это ровно то же самое, что падение. " +
              "Метрика меряет <b>результат</b>, а не самочувствие процесса.",
              "The consumer is alive but reads not a single message — as far as lag is concerned, that is exactly the same " +
              "as a crash. The metric measures the <b>result</b>, not how the process feels."));
          } else {
            stage.say(L("Скорость чтения <b>", "Reading at <b>") + v +
              L("/с</b> против записи <b>", "/s</b> against writing at <b>") + prodRate +
              L("/с</b>. ", "/s</b>. ") +
              (v > prodRate ? L("Запас есть — отставание будет рассасываться.",
                "There is headroom — the lag will drain away.")
                : v === prodRate ? L("Скорости равны: lag не растёт, но и накопленный разрыв сам не уйдёт.",
                  "The speeds match: lag stops growing, but the gap already there will not go away by itself.")
                  : L("Читаем медленнее, чем пишем, — отставание копится.",
                    "We read slower than we write — the lag piles up.")));
          }
        }
      });

      var btnDrop = ui.btn(L("Уронить консьюмера", "Kill the consumer"), function () {
        if (!alive) return;
        alive = false; catchUp = false; consAcc = 0;
        btnDrop.disabled = true; btnUp.disabled = false;
        dirty = true; refresh();
        stage.say(L(
          "<b>Консьюмер упал.</b> Продюсер этого даже не заметил и пишет как писал — значит, lag теперь растёт ровно со " +
          "скоростью записи. Ничего не потеряно: записи лежат в логе, а закладки группы — в <code>__consumer_offsets</code>, " +
          "смотри правую панель.",

          "<b>The consumer is down.</b> The producer did not even notice and writes exactly as before — so lag now grows at " +
          "precisely the write speed. Nothing is lost: the records are in the log, and the group’s bookmarks are in " +
          "<code>__consumer_offsets</code> — look at the right-hand panel."));
      }, { variant: "danger" });

      var btnUp = ui.btn(L("Поднять консьюмера", "Restart the consumer"), function () {
        if (alive) return;
        alive = true;
        catchUp = consRate > 0;   // при ползунке на нуле догонять нечем
        btnDrop.disabled = false; btnUp.disabled = true;
        parts.forEach(function (p) { p.strip.highlight(p.committed, "is-reading", 1200); });
        var pos = parts.map(function (p, idx) { return "p" + idx + " = " + p.committed; }).join(", ");
        dirty = true; refresh();
        stage.say(L("<b>Консьюмер поднялся.</b> Первым делом он спросил у Kafka свои позиции — <code>",
          "<b>The consumer is back up.</b> The first thing it did was ask Kafka for its positions — <code>") + pos +
          L("</code> — " +
            "и продолжил <b>ровно с них</b>: не с нуля и не с конца лога. ",
            "</code> — and it carried on <b>exactly from them</b>: not from zero and not from the end of the log. ") +
          (catchUp
            ? L("Пока разрыв большой, он читает на полной скорости (",
              "While the gap is big it reads at full speed (") + consumerRate() +
              L("/с) и догоняет.", "/s) and catches up.")
            : L("Но ползунок чтения стоит на нуле: процесс поднялся, а разбирать он не начал — lag так и растёт со скоростью записи.",
              "But the reading slider sits at zero: the process is up, yet it has not started handling anything — " +
              "lag keeps growing at the write speed.")));
      }, { variant: "read" });
      btnUp.disabled = true;

      var btnStall = ui.btn(L("Подвесить обработку партиции 2", "Stall processing of partition 2"), function () {
        stalled = stalled === 2 ? -1 : 2;
        var on = stalled === 2;
        btnStall.textContent = on
          ? L("Отпустить партицию 2", "Release partition 2")
          : L("Подвесить обработку партиции 2", "Stall processing of partition 2");
        btnStall.setAttribute("aria-pressed", String(on));
        dirty = true; refresh();
        stage.say((on
          ? L("Обработчик партиции 2 залип на медленном запросе. Остальные две партиции читаются как ни в чём не бывало и уходят " +
            "в ноль, поэтому <b>суммарный</b> lag растёт лениво и дежурного не будит. Подожди, пока полоска партиции 2 покраснеет, " +
            "и сравни её со спокойным числом наверху.",
            "The handler for partition 2 is stuck on a slow request. The other two partitions are read as if nothing happened and " +
            "drop to zero, so the <b>total</b> lag creeps up lazily and wakes nobody on call. Wait for the bar of partition 2 to " +
            "turn red, then compare it with the calm number at the top.")
          : L("Обработчик отпустило — партиция 2 разбирает накопленное.",
            "The handler is unstuck — partition 2 is working through what piled up.")) +
          (alive ? "" : L(" Но сейчас лежит весь консьюмер — сначала подними его, иначе разницы между партициями не увидеть.",
            " But right now the whole consumer is down — restart it first, or the difference between partitions will not show.")));
      }, { sm: true });

      var btnPause = ui.btn(L("Пауза", "Pause"), function () {
        paused = !paused;
        btnPause.textContent = paused ? L("Продолжить", "Resume") : L("Пауза", "Pause");
        btnPause.setAttribute("aria-pressed", String(paused));
        dirty = true; refresh(); updateTrend();
        stage.say(paused
          ? L("Время остановлено. Числа замерли: <code>LEO − committed</code> считается не по таймеру, а просто по двум позициям.",
            "Time is stopped. The numbers froze: <code>LEO − committed</code> is not computed on a timer, just from the two positions.")
          : L("Поток пошёл дальше.", "The stream is running again."));
      }, { sm: true, variant: "ghost" });

      var btnReset = ui.btn(L("Сброс", "Reset"), function () { reset(true); }, { sm: true, variant: "ghost" });

      KV.append(stage.controls, prodRange.el, consRange.el, btnDrop, btnUp, btnStall, btnPause, btnReset);

      /* ================= старт ================= */

      function reset(loud) {
        clock = 0;
        parts.forEach(function (p) {
          var n = 12 + Math.floor(rnd() * 5);
          var recs = [];
          p.times = [];
          for (var j = 0; j < n; j++) {
            recs.push({ key: randKey(p) });
            /* посев писали те же 3 сообщ/с, только до начала отсчёта */
            p.times.push(-(n - j) / 3);
          }
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
        btnPause.textContent = L("Пауза", "Pause"); btnPause.setAttribute("aria-pressed", "false");
        btnStall.textContent = L("Подвесить обработку партиции 2", "Stall processing of partition 2");
        btnStall.setAttribute("aria-pressed", "false");
        dirty = true; refresh(); updateTrend();
        stage.say(loud
          ? L("Сброшено: снова 3/с против 3/с.", "Reset: 3/s against 3/s again.")
          : L("Поток уже идёт: продюсер пишет 3 сообщ/с, консьюмер разбирает столько же, lag болтается около нуля — " +
            "так выглядит здоровая система. Дальше ломай: разгони продюсера или урони консьюмера.",
            "The stream is already running: the producer writes 3 msg/s, the consumer handles the same, lag hovers around " +
            "zero — this is what a healthy system looks like. Now break it: speed up the producer or kill the consumer."));
      }

      root.appendChild(stage.el);
      reset(false);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
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
        "<p>«Тысяча сообщений отставания» сама по себе не значит ничего. Если продюсер пишет 500 сообщ/с, эта тысяча набежала " +
        "за две секунды — норма. Если он пишет 5 сообщ/с, самой старой непрочитанной записи уже больше трёх минут — " +
        "для антифрода катастрофа. Разница только в скорости <strong>записи</strong>: именно она говорит, за какое время " +
        "накопился разрыв, а значит и сколько времени назад положили самую старую непрочитанную запись — " +
        "<code>lag ÷ скорость записи</code>. " +
        "Плитка <strong>«свежесть данных»</strong> показывает ровно это: сколько секунд назад положили в лог ту запись, " +
        "которую группа возьмёт следующей.</p>" +
        "<p>Не путай это с <code>lag ÷ скорость чтения</code>: то — время <em>разгрести</em> очередь, и оно имеет смысл, " +
        "только пока консьюмер читает быстрее продюсера. Урони консьюмера: разгребать нечем, а данные всё равно продолжают " +
        "стареть — плитка считает их возраст дальше, потому что возраст от чтения не зависит.</p>" +
        "<p>Оговорка по стенду: здесь группа делает [[commit]] сразу после каждой записи. В жизни коммитят пачками и по таймеру, " +
        "поэтому committed offset скачет не по одному — на смысл lag это не влияет, а на риск повторной обработки влияет сильно. " +
        "Это следующая глава.</p>",

        "<h3>What you just played with</h3>" +
        "<ul>" +
        "<li><strong>Equal speeds</strong> — lag stands still: as many records are handled as arrive. That is what “healthy” means.</li>" +
        "<li><strong>The producer is faster</strong> — lag grows <em>linearly</em> and will not come back down on its own. To catch up you " +
        "need spare speed, not parity: at 5 against 5 the gap you already have simply freezes where it stands.</li>" +
        "<li><strong>The consumer crashed</strong> — lag grows at exactly the write speed. What piles up is not loss but <em>work</em>: " +
        "the records lie in the log, intact.</li>" +
        "<li><strong>The consumer came back</strong> — it started from the [[committed offset]], not from zero and not from the end of " +
        "the log. Not one repeat, not one skip. That is precisely what <code>__consumer_offsets</code> is for.</li>" +
        "</ul>" +
        "<h4>Lag in messages and lag in time</h4>" +
        "<p>“A thousand messages behind” means nothing on its own. If the producer writes 500 msg/s, that thousand piled up in two " +
        "seconds — normal. If it writes 5 msg/s, the oldest unread record is already more than three minutes old — a disaster for " +
        "fraud detection. The only difference is the <strong>write</strong> speed: it is what tells you how long the gap took to " +
        "accumulate, and therefore how long ago the oldest unread record was put there — <code>lag ÷ write speed</code>. " +
        "The <strong>“data freshness”</strong> tile shows exactly that: how many seconds ago the record the group will take next " +
        "was written into the log.</p>" +
        "<p>Do not confuse it with <code>lag ÷ read speed</code>: that is the time to <em>drain</em> the queue, and it only means " +
        "something while the consumer reads faster than the producer writes. Kill the consumer: there is nothing to drain with, yet " +
        "the data keeps ageing all the same — the tile keeps counting its age, because age does not depend on reading.</p>" +
        "<p>One caveat about this demo: here the group does a [[commit]] right after every record. In real life you commit in batches " +
        "and on a timer, so the committed offset jumps by more than one — that changes nothing about what lag means, but it matters " +
        "a great deal for the risk of processing something twice. That is the next chapter.</p>"
      )));

      root.appendChild(ui.note("warn", L("ловушка", "trap"), L(
        "<p><strong>Суммарный lag прячет мёртвую партицию.</strong> Нажми «подвесить обработку партиции 2»: " +
        "две партиции читаются, общее число растёт лениво и не тревожит дежурного, а одна партиция не двигается вовсе — " +
        "и по её ключам данные уже безнадёжно устарели. Плитка «свежесть данных» это видит первой: она считает возраст " +
        "самой старой непрочитанной записи по всем партициям, и ей всё равно, что сумма выглядит спокойной.</p>" +
        "<p>Поэтому lag всегда смотрят <strong>по партициям</strong>, а алерт ставят на максимум по партициям, а не на сумму. " +
        "Подробный разбор — в главе 13.</p>",

        "<p><strong>Total lag hides a dead partition.</strong> Press “stall processing of partition 2”: two partitions are being " +
        "read, the overall number creeps up lazily and disturbs nobody on call, while one partition does not move at all — and for " +
        "its keys the data is already hopelessly stale. The “data freshness” tile sees this first: it counts the age of the oldest " +
        "unread record across all partitions, and it does not care that the sum looks calm.</p>" +
        "<p>That is why lag is always read <strong>per partition</strong>, and the alert is set on the maximum across partitions, " +
        "not on the sum. The full story is in chapter 13.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "<code>lag = LEO − committed offset</code> — сколько записей группа ещё не прочитала.",
          "[[committed offset]] хранится в самой Kafka ([[__consumer_offsets]]), поэтому упавший [[консьюмер]] поднимается и продолжает со своей позиции, а не с нуля.",
          "Lag — это не потеря данных, а <b>накопленная работа</b>. Записи целы; вопрос только в том, насколько устарело то, что ты видишь.",
          "Растущий lag сам не рассосётся: чтобы догнать, нужно читать <b>быстрее</b>, чем пишет продюсер, а не с той же скоростью.",
          "Переводи lag во время: возраст самой старой непрочитанной записи — это <code>lag ÷ скорость записи</code>, а <code>lag ÷ скорость чтения</code> отвечает на другой вопрос, за сколько разгрести очередь.",
          "Смотри lag <b>по партициям</b>, а не суммой — сумма прячет одну намертво вставшую."
        ],
        [
          "<code>lag = LEO − committed offset</code> — how many records the group has not read yet.",
          "The [[committed offset]] is stored in Kafka itself ([[__consumer_offsets]]), so a crashed [[consumer]] comes back up and carries on from its own position, not from zero.",
          "Lag is not lost data, it is <b>work piled up</b>. The records are intact; the only question is how stale what you see has become.",
          "Growing lag will not sort itself out: to catch up you have to read <b>faster</b> than the producer writes, not at the same speed.",
          "Turn lag into time: the age of the oldest unread record is <code>lag ÷ write speed</code>, while <code>lag ÷ read speed</code> answers a different question — how long it takes to drain the queue.",
          "Watch lag <b>per partition</b>, not as a sum — the sum hides the one that has stopped dead."
        ]
      )));
    }
  });
})();
