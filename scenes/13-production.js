/* Глава 13 — Что ломается в проде: lag по партициям и шторм ребалансов. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "production",
    num: 13,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Прод", "Production"],
    nav: ["Что ломается в проде", "What breaks in production"],
    title: [
      "Диагностика: lag по партициям и шторм ребалансов",
      "Diagnostics: lag per partition and the rebalance storm"
    ],
    lede: [
      "Суммарный <b>lag</b> по топику — почти бесполезное число: оно одинаково и когда группа целиком не тянет, и когда горит одна партиция. Диагноз живёт в разбивке по партициям — и в том, за чем поедет lag после <b>ребаланса</b>.",
      "Total <b>lag</b> across a topic is a nearly useless number: it looks the same when the whole group cannot keep up and when a single partition is on fire. The diagnosis lives in the per-partition breakdown — and in what the lag follows after a <b>rebalance</b>."
    ],

    build: function (root, api) {

      var rnd = util.rng(20260914);

      /* ================================================================
         подводка
         ================================================================ */

      root.appendChild(ui.prose(L(
        "<p>В проде нет отладчика — есть графики, и первое движение опытного человека всегда одно: " +
        "развернуть [[lag]] группы <strong>по партициям</strong> [[топик|топика]]. " +
        "Разбивка показывает то, чего в одном числе нет физически: <strong>ровно ли размазана работа</strong>.</p>" +
        "<p>Дальше три вопроса, и все три читаются с одного экрана: растёт одна партиция или все? " +
        "сколько льётся в неё на входе? и главный приём — " +
        "за чем поедет lag <strong>после [[ребаланс|ребаланса]]</strong>: за партицией или за подом.</p>",

        "<p>There is no debugger in production — there are graphs, and an experienced person always makes the same first move: " +
        "break the group’s [[lag]] down <strong>by partition</strong> of the [[topic]]. " +
        "The breakdown shows what a single number physically cannot: <strong>whether the work is spread evenly</strong>.</p>" +
        "<p>Then come three questions, and all three are read off one screen: is one partition growing or all of them? " +
        "how much is flowing into it? and the main trick — " +
        "what does the lag follow <strong>after a [[rebalance]]</strong>: the partition or the pod.</p>"
      )));

      root.appendChild(ui.note("key", L("приём", "trick"), L(
        "<p>Ребаланс переставляет партиции между потребителями. Значит это готовый эксперимент: " +
        "<b>lag остался на той же партиции — дело в данных; lag поехал за тем же подом — дело в экземпляре</b>. " +
        "Один клик отделяет «плохие данные» от «плохого сервера» — правда, не бесплатно: " +
        "при обычной (eager) стратегии на время ребаланса группа не читает вообще ничего, и это ты сейчас увидишь на столбиках.</p>" +
        "<p>Оговорка, без которой приём обманет: он держится на том, что партиции <b>действительно</b> переехали. " +
        "Стенд это подстраивает — раздаёт так, чтобы у каждой партиции сменился владелец. Настоящая Kafka такого не обещает: " +
        "например, при static membership (<code>group.instance.id</code> — тумблер на втором стенде) вернувшийся под забирает " +
        "свои же партиции, раскладка остаётся прежней — и «lag остался на той же партиции» скажет не про данные, а ровно ни о чём. " +
        "Поэтому сначала посмотри фактическую раскладку (<code>kafka-consumer-groups --describe</code>), и только потом читай столбики.</p>",

        "<p>A rebalance moves partitions between consumers. That makes it a ready-made experiment: " +
        "<b>the lag stayed on the same partition — it is the data; the lag followed the same pod — it is the instance</b>. " +
        "One click separates “bad data” from “a bad server” — though not for free: " +
        "with the ordinary (eager) strategy the group reads nothing at all while the rebalance runs, and you are about to see that on the bars.</p>" +
        "<p>One caveat, without which the trick will fool you: it rests on the partitions <b>actually</b> having moved. " +
        "The demo arranges that — it hands them out so that every partition changes owner. Real Kafka promises nothing of the sort: " +
        "with static membership (<code>group.instance.id</code> — the toggle on the second demo), for example, a returning pod takes " +
        "its own partitions back, the layout stays as it was — and “the lag stayed on the same partition” then tells you nothing about the data, and in fact nothing at all. " +
        "So look at the actual assignment first (<code>kafka-consumer-groups --describe</code>), and only then read the bars.</p>"
      )));

      /* ================================================================
         СТЕНД А — lag по партициям
         ================================================================ */

      var NP = 6;            // партиций в топике
      var TICK = 500;        // шаг модели, мс
      var DT = TICK / 1000;  // шаг модели, с
      var POWER = 150;       // записей/с, которые вывозит здоровый под
      var MAXLAG = 60000;

      var SCEN = {
        hotkey: {
          label: L("перекос ключа", "key skew"),
          inRate: [40, 38, 42, 260, 39, 41],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: -1, sickPower: 0,
          intro: L("В партицию 3 льётся вшестеро больше остальных: почти все события идут с одним ключом.",
            "Partition 3 gets six times more than the rest: almost every event carries the same key.")
        },
        starved: {
          label: L("не хватает потребителей", "not enough consumers"),
          inRate: [128, 132, 130, 129, 131, 130],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: -1, sickPower: 0,
          intro: L("Приток ровный и обычный, но группа целиком разбирает медленнее, чем пишут продюсеры.",
            "The inflow is even and ordinary, but the group as a whole processes slower than the producers write.")
        },
        badpart: {
          label: L("больная партиция", "a sick partition"),
          inRate: [40, 41, 39, 40, 40, 42],
          hard: [1, 1, 1, 1, 8, 1],
          sickPod: -1, sickPower: 0,
          intro: L("Приток всюду одинаковый, но разбор партиции 4 идёт в разы медленнее: сообщения тяжёлые.",
            "The inflow is the same everywhere, but partition 4 is processed many times slower: its messages are heavy.")
        },
        badpod: {
          label: L("больной под", "a sick pod"),
          inRate: [40, 41, 39, 40, 40, 42],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: 1, sickPower: 18,
          intro: L("Приток ровный, данные обычные — а два назначения разбираются еле-еле.",
            "Even inflow, ordinary data — and yet two assignments crawl.")
        }
      };

      var scKey = "hotkey";
      var sc = SCEN[scKey];
      var lag = [0, 0, 0, 0, 0, 0];
      var assign = [0, 1, 2, 0, 1, 2];
      var pods = 3;
      var podsCounted = 3;      // состав группы, за который ребаланс уже засчитан
      var podsTimer = null;     // ползунок сыплет промежуточными значениями — ждём, пока состав устоится
      var rot = 0;
      var stw = false;          // stop-the-world: идёт ребаланс
      var paused = false;
      var rebalances = 0;
      var meas = null;          // замер после ребаланса
      var gen = 0;              // поколение: отменяет отложенный ребаланс и замер

      var stageA = ui.stage({
        title: L("Стенд А · lag по партициям", "Demo A · lag per partition"),
        hint: L("Выбери картину, посмотри на столбики и нажми «Провести ребаланс»",
          "Pick a scenario, look at the bars and press “Run a rebalance”")
      });

      /* --- выбор картины --- */

      var seg = ui.seg([
        { value: "hotkey", label: L("перекос ключа", "key skew") },
        { value: "starved", label: L("не хватает потребителей", "not enough consumers") },
        { value: "badpart", label: L("больная партиция", "a sick partition") },
        { value: "badpod", label: L("больной под", "a sick pod") }
      ], scKey, function (v) { setScenario(v); });

      stageA.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "14px" } },
        el("span.kv-ctl__label", { text: L("картина", "scenario") }), seg.el));

      /* --- таблица партиций --- */

      /* Первая колонка по-английски шире: заголовок «PARTITION» в разрядку
         занимает 61 пункт против 53 у русской «ПАРТИЦИИ» и вылезал из своей
         клетки, поэтому по-английски 66, а по-русски прежние 54 — русская
         вёрстка не должна ехать из-за чужого слова. Ширину и там и там держит
         одна константа на всю таблицу, поэтому шапка и строки не могут
         разъехаться. */
      var GRID = L("54px minmax(110px, 1fr) 88px 52px 186px",
        "66px minmax(110px, 1fr) 88px 52px 186px");

      function gridRow(children, extra) {
        var st = {
          display: "grid", "grid-template-columns": GRID,
          gap: "10px", "align-items": "center", padding: "4px 0"
        };
        if (extra) for (var k in extra) st[k] = extra[k];
        return el("div", { style: st }, children);
      }

      function span(text, style) {
        var st = { "font-family": "var(--f-mono)", "font-size": "11.5px" };
        if (style) for (var k in style) st[k] = style[k];
        return el("span", { style: st, text: text });
      }

      var partBox = el("div", { style: { "min-width": L("530px", "542px") } });

      partBox.appendChild(gridRow([
        span(L("партиция", "partition"), { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span("lag", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span(L("записей", "records"), { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span(L("под", "pod"), { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span(L("приток · обработка", "inflow · processing"), { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" })
      ], { "border-bottom": "1px solid var(--line)", "padding-bottom": "7px", "margin-bottom": "4px" }));

      var rows = [];
      for (var p0 = 0; p0 < NP; p0++) {
        (function (p) {
          var bar = ui.bar(0);
          var lagEl = span("0", { "font-size": "13px", color: "var(--muted)" });
          var podEl = el("span.kv-badge", { text: "C1" });
          var rateEl = span("", { color: "var(--faint)", "font-size": "10.5px" });
          var nameEl = span("P" + p, { color: "var(--ink)", "font-size": "12.5px" });
          rows.push({
            bar: bar, lag: lagEl, pod: podEl, rate: rateEl,
            el: gridRow([nameEl, bar.el, lagEl, podEl, rateEl])
          });
          partBox.appendChild(rows[p].el);
        })(p0);
      }
      stageA.body.appendChild(partBox);

      stageA.body.appendChild(el("div", { style: { "margin-top": "10px" } },
        ui.legend([
          { color: "var(--bad)", label: L("lag растёт", "lag is growing") },
          { color: "var(--read)", label: L("lag рассасывается", "lag is draining") }
        ])));

      /* --- поды группы --- */

      var podsBox = el("div.kv-row", { style: { "margin-top": "16px" } });
      stageA.body.appendChild(ui.panel(L("ГРУППА orders-worker", "GROUP orders-worker"), podsBox));

      /* --- показатели --- */

      var stSum = ui.stat(L("Σ lag по топику", "Σ lag across the topic"), "0", { unit: L("записей", "records") });
      var stMax = ui.stat(L("макс. по партиции", "max per partition"), "0", { unit: L("записей", "records") });
      var stGrow = ui.stat(L("растёт партиций", "partitions growing"), "0", { unit: L("из 6", "of 6") });
      var stReb = ui.stat(L("ребалансов", "rebalances"), "0");
      stageA.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.stats(stSum.el, stMax.el, stGrow.el, stReb.el)));

      /* --- диагноз --- */

      var vBody = el("div", { style: { "font-size": "14px", "line-height": "1.55", color: "var(--ink-2)" } });
      stageA.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.panel(L("ДИАГНОЗ", "DIAGNOSIS"), vBody)));

      function vSet(html) { vBody.innerHTML = html; }

      /* --- модель --- */

      function podCount(pi) {
        var n = 0;
        for (var i = 0; i < NP; i++) if (assign[i] === pi) n++;
        return n;
      }

      function podPartitions(pi) {
        var out = [];
        for (var i = 0; i < NP; i++) if (assign[i] === pi) out.push(i);
        return out;
      }

      function consumeRate(p) {
        var pi = assign[p];
        var power = (pi === sc.sickPod) ? sc.sickPower : POWER;
        var n = podCount(pi) || 1;
        return (power / n) / sc.hard[p];
      }

      function growingNow() {
        var out = [];
        for (var p = 0; p < NP; p++) if (sc.inRate[p] > consumeRate(p) + 0.5) out.push(p);
        return out;
      }

      function dealArray(r) {
        var a = new Array(NP);
        for (var i = 0; i < NP; i++) a[(r + i) % NP] = i % pods;
        return a;
      }

      function deal() {
        assign = dealArray(rot);
        renderPods();
      }

      /** Ребаланс обязан сдвинуть КАЖДУЮ партицию на другого потребителя —
       *  иначе приём «за чем поехал lag» не сработает. */
      function reassign() {
        var prev = assign.slice();
        for (var attempt = 0; attempt < NP; attempt++) {
          rot = (rot + 1) % NP;
          var cand = dealArray(rot);
          var allMoved = true;
          for (var i = 0; i < NP; i++) if (cand[i] === prev[i]) { allMoved = false; break; }
          if (allMoved) { assign = cand; renderPods(); return; }
        }
        assign = prev.map(function (x) { return (x + 1) % pods; });
        renderPods();
      }

      function step() {
        for (var p = 0; p < NP; p++) {
          var c = stw ? 0 : consumeRate(p);
          lag[p] = util.clamp(lag[p] + (sc.inRate[p] - c) * DT, 0, MAXLAG);
        }
      }

      /* --- отрисовка --- */

      function podName(i) { return i < 0 ? L("разные поды", "different pods") : "consumer-" + (i + 1); }
      function plist(arr) {
        return arr.map(function (p) { return "P" + p; }).join(", ");
      }

      function renderPods() {
        KV.clear(podsBox);
        for (var i = 0; i < pods; i++) {
          var mine = podPartitions(i);
          var n = ui.node("consumer", "consumer-" + (i + 1),
            mine.length
              ? L("читает ", "reading ") + plist(mine)
              : L("простаивает: партиций не досталось", "idle: got no partitions"));
          if (!mine.length) n.classList.add("kv-node--dead");
          var dot = n.querySelector(".kv-node__dot");
          if (dot) dot.style.background = util.paletteColor(i);
          n.style.borderLeftColor = util.paletteColor(i);
          podsBox.appendChild(n);
        }
        if (pods > NP) {
          podsBox.appendChild(ui.badge(L("подов больше, чем партиций — лишние простаивают",
            "more pods than partitions — the extras idle"), "warn"));
        }
      }

      function render() {
        var scale = 600, sum = 0, mx = 0, grow = 0, p;
        for (p = 0; p < NP; p++) { if (lag[p] > scale) scale = lag[p]; }
        scale *= 1.12;
        for (p = 0; p < NP; p++) {
          var c = stw ? 0 : consumeRate(p);
          var rising = sc.inRate[p] > c + 0.5;
          rows[p].bar.set(lag[p] / scale, rising ? "bad" : null);
          rows[p].lag.textContent = util.num(Math.round(lag[p]));
          rows[p].lag.style.color = rising ? "var(--bad)" : "var(--muted)";
          rows[p].pod.textContent = "C" + (assign[p] + 1);
          rows[p].pod.style.color = util.paletteColor(assign[p]);
          rows[p].pod.style.borderColor = util.paletteColor(assign[p]);
          rows[p].rate.textContent = L("приток ", "inflow ") + Math.round(sc.inRate[p]) +
            L("/с · обработка ", "/s · processing ") + Math.round(c) + L("/с", "/s");
          sum += lag[p];
          if (lag[p] > mx) mx = lag[p];
          if (rising) grow++;
        }
        stSum.set(util.num(Math.round(sum)), sum > 4000 ? "bad" : sum > 800 ? "warn" : "good");
        stMax.set(util.num(Math.round(mx)), mx > 2000 ? "bad" : null);
        stGrow.set(grow, grow === 0 ? "good" : grow >= NP - 1 ? "bad" : "warn");
        stReb.set(rebalances, rebalances ? "warn" : null);
      }

      function tick() {
        if (paused) return;
        var before = meas && !stw ? lag.slice() : null;
        step();
        if (meas && !stw) {
          for (var p = 0; p < NP; p++) meas.delta[p] += lag[p] - before[p];
          meas.ticks++;
          if (meas.ticks >= 8) finishMeasure();
        }
        render();
      }

      /* --- ребаланс и вердикт --- */

      function dominantPod(list) {
        if (!list.length) return -1;
        var cnt = {}, best = -1, bestN = 0;
        list.forEach(function (p) {
          var k = assign[p];
          cnt[k] = (cnt[k] || 0) + 1;
          if (cnt[k] > bestN) { bestN = cnt[k]; best = k; }
        });
        if (bestN === 1 && Object.keys(cnt).length > 1) return -1;
        return best;
      }

      function sameSet(a, b) {
        if (a.length !== b.length || !a.length) return false;
        return a.every(function (x) { return b.indexOf(x) >= 0; });
      }

      function medianIn() {
        var a = sc.inRate.slice().sort(function (x, y) { return x - y; });
        return (a[2] + a[3]) / 2;
      }

      /** Партиции подов, которым досталось больше назначений, чем самому лёгкому поду.
       *  6 партиций не делятся нацело ни на 4, ни на 5 подов — и это видно на графике. */
      function overloadedSet() {
        var minC = NP, i, c, out = [];
        /* простаивающие поды (0 назначений) в минимум не идут: иначе при 7-8 подах
           «перегруженными» окажутся вообще все работающие. */
        for (i = 0; i < pods; i++) { c = podCount(i); if (c > 0 && c < minC) minC = c; }
        for (i = 0; i < pods; i++) if (podCount(i) > minC) out = out.concat(podPartitions(i));
        return out.sort(function (a, b) { return a - b; });
      }

      /** Отменить отложенный ребаланс и идущий замер: картину или состав группы
       *  поменяли на ходу, и старый вердикт считался бы по чужой модели. */
      function cancelPending() {
        gen++;
        meas = null;
        stw = false;
      }

      function doRebalance() {
        if (stw) return;
        var before = growingNow();
        var suspect = dominantPod(before);
        var my = ++gen;
        meas = null;
        stw = true;
        stageA.say(L(
          "<b>Stop-the-world.</b> Пока идёт ребаланс, группа не читает <b>ничего</b> — lag растёт на всех шести партициях сразу.",
          "<b>Stop-the-world.</b> While the rebalance runs, the group reads <b>nothing</b> — lag grows on all six partitions at once."));
        vSet(L(
          "<b>Ребаланс пошёл.</b> Партиции отобраны у всей группы — стенд показывает обычную, eager-стратегию. " +
          "Это и есть её цена: не «немного медленнее», а полная остановка потребления. " +
          "Чем эту цену сбивают, увидишь тумблером <code>cooperative-sticky</code> на стенде Б.",

          "<b>The rebalance has started.</b> Every partition has been revoked from the whole group — the demo shows the ordinary, eager strategy. " +
          "That is its price: not “a bit slower”, but a full stop of consumption. " +
          "How that price is brought down you will see with the <code>cooperative-sticky</code> toggle on demo B."));
        render();
        api.timeout(1600, function () {
          if (my !== gen) return;          // картину сменили, пока шёл stop-the-world
          reassign();
          stw = false;
          rebalances++;
          meas = { before: before, suspect: suspect, delta: [0, 0, 0, 0, 0, 0], ticks: 0 };
          vSet(before.length
            ? L("Назначение роздано заново. До ребаланса lag рос на <b>",
                "The assignment has been handed out again. Before the rebalance the lag was growing on <b>") +
              plist(before) + "</b> — " +
              (suspect >= 0
                ? (before.length > 1
                    ? L("их читал <b>", "they were read by <b>")
                    : L("её читал <b>", "it was read by <b>")) + podName(suspect) +
                  L("</b>. Смотрю, за чем он поедет…", "</b>. Watching what it follows…")
                : L("читали их разные поды. Смотрю, что сдвинется после переезда…",
                    "they were read by different pods. Watching what moves after the handover…"))
            : L("Назначение роздано заново. До ребаланса lag не рос нигде — смотрю, изменится ли что-нибудь…",
                "The assignment has been handed out again. Before the rebalance the lag was not growing anywhere — watching whether anything changes…"));
          stageA.say(L("Партиции переставлены между подами. Замер идёт — следи за столбиками.",
            "The partitions have been shuffled between pods. The measurement is running — watch the bars."));
          render();
        });
      }

      function finishMeasure() {
        var m = meas;
        meas = null;
        var after = [];
        for (var p = 0; p < NP; p++) if (m.delta[p] > 20) after.push(p);

        var head, body;
        if (!after.length) {
          head = L("<b>Lag не растёт ни на одной партиции.</b>",
            "<b>Lag is not growing on any partition.</b>");
          body = L(
            "Группа успевает за продюсерами: то, что накопилось, будет рассасываться. " +
            "Если до этого не хватало потребителей — ты их только что добавил.",

            "The group keeps up with the producers: whatever piled up will drain. " +
            "If you were short of consumers before — you have just added them.");
        } else if (after.length >= NP - 1) {
          head = L("<b>Растут все партиции сразу, ребаланс ничего не изменил.</b>",
            "<b>Every partition is growing at once; the rebalance changed nothing.</b>");
          body = L(
            "Это не перекос и не больной под: группа просто медленнее продюсеров. " +
            "Добавляй потребителей — но не больше, чем партиций: лишние поды не получат назначения и будут простаивать. " +
            "Упёрся в потолок при шести партициях — дальше только добавлять партиции, а это меняет отображение " +
            "ключей на партиции: порядок по ключу рвётся на стыке.",

            "This is not skew and not a sick pod: the group is simply slower than the producers. " +
            "Add consumers — but no more than there are partitions: the extra pods get no assignment and will idle. " +
            "Hit the ceiling at six partitions and the only way on is to add partitions, and that changes how " +
            "keys map to partitions: order by key breaks at the seam.");
        } else if (overloadedSet().length && sameSet(after, overloadedSet())) {
          head = L("<b>Горят ровно те партиции, что достались перегруженным подам.</b>",
            "<b>The partitions on fire are exactly the ones that went to the overloaded pods.</b>");
          body = L("6 партиций не делятся нацело на ", "6 partitions do not divide evenly among ") + pods + " " +
            util.plural(pods, L("под", "pod"), L("пода", "pods"), L("подов", "pods")) +
            L(": кому-то досталось по две, кому-то по одной. " +
              "Двойное назначение не вывозит приток, одинарное вывозит с запасом — и никакой ребаланс этого не выпрямит, " +
              "он лишь переставит, кому не повезёт. Держи число подов делителем числа партиций: 1, 2, 3 или 6.",

              ": some got two, some got one. " +
              "A double assignment cannot keep up with the inflow, a single one keeps up with room to spare — and no rebalance will straighten that out, " +
              "it will only shuffle who gets unlucky. Keep the number of pods a divisor of the number of partitions: 1, 2, 3 or 6.");
        } else if (sameSet(after, m.before)) {
          var mid = medianIn(), hot = 0;
          after.forEach(function (p) { if (sc.inRate[p] >= mid * 2) hot = 1; });
          head = after.length > 1
            ? L("<b>Lag остался на тех же партициях: ", "<b>The lag stayed on the same partitions: ") + plist(after) +
              L(".</b> Партиции переехали к другим подам — болезнь переехала вместе с ними.",
                ".</b> The partitions moved to other pods — the illness moved with them.")
            : L("<b>Lag остался на той же партиции: ", "<b>The lag stayed on the same partition: ") + plist(after) +
              L(".</b> Партиция переехала к другому поду — болезнь переехала вместе с ней.",
                ".</b> The partition moved to another pod — the illness moved with it.");
          body = hot
            ? L("Смотри колонку притока: в ", "Look at the inflow column: ") + plist(after) +
              L(" льётся в разы больше, чем в остальные. Это перекос ключа " +
                "(hot key): почти все события идут с одним значением ключа и ложатся в одну партицию. " +
                "Подов добавлять бесполезно — одну партицию читает ровно один потребитель группы. " +
                "Лечится ключом: добавь к нему различающую часть или разнеси горячее значение по нескольким партициям вручную.",

                " gets many times more than the rest. This is key skew " +
                "(a hot key): almost every event carries the same key value and lands in one partition. " +
                "Adding pods is useless — a partition is read by exactly one consumer of the group. " +
                "The cure is the key: add a distinguishing part to it, or spread the hot value across several partitions by hand.")
            : L("Приток туда такой же, как везде, значит дело не в объёме, а в самих данных партиции: крупные сообщения, " +
                "ядовитая запись, на которой обработчик уходит в ретраи. Иди смотреть содержимое партиции, поды тут ни при чём.",

                "The inflow there is the same as everywhere, so it is not about volume but about the partition’s own data: large messages, " +
                "a poison record the handler keeps retrying. Go and look inside the partition; the pods have nothing to do with it.");
        } else if (m.suspect >= 0 && sameSet(after, podPartitions(m.suspect))) {
          head = L("<b>Lag поехал за подом.</b> Горели ", "<b>The lag followed the pod.</b> On fire before: ") + plist(m.before) +
            L(", теперь горят ", ". On fire now: ") + plist(after) +
            L(" — ровно те, что достались ", " — exactly what went to ") + podName(m.suspect) + ".";
          body = L(
            "Проблема в конкретном экземпляре, а не в данных: сборка мусора, упёршийся диск, шумный сосед по ноде, " +
            "зависший вызов наружу. Выведи этот под из группы или перезапусти — картина выпрямится. " +
            "Заметь: скорость обработки на его партициях почти ноль, хотя данные обычные.",

            "The problem is in one instance, not in the data: garbage collection, a saturated disk, a noisy neighbour on the node, " +
            "a hung outbound call. Take that pod out of the group or restart it — the picture straightens out. " +
            "Note: the processing rate on its partitions is near zero even though the data is ordinary.");
        } else {
          head = L("<b>Картина смешанная.</b> До ребаланса росли ", "<b>A mixed picture.</b> Growing before the rebalance: ") +
            plist(m.before) + L(", после — ", " — after it: ") + plist(after) + ".";
          body = L(
            "Ни за партицией, ни за подом чисто не поехало. Прогони ребаланс ещё раз и смотри, что повторяется: " +
            "повторяемость и есть доказательство.",

            "The lag followed neither the partition nor the pod cleanly. Run the rebalance again and watch what repeats: " +
            "repeatability is the proof.");
        }
        vSet("<p style='margin:0 0 8px'>" + head + "</p><p style='margin:0'>" + body + "</p>");
        stageA.say(L("Замер закончен — диагноз в панели выше.",
          "The measurement is done — the diagnosis is in the panel above."));
        render();
      }

      /* --- смена картины --- */

      function setScenario(key) {
        scKey = key;
        sc = SCEN[key];
        cancelPending();
        if (podsTimer) { api.stop(podsTimer); podsTimer = null; }
        podsCounted = pods;
        rebalances = 0;
        rot = 0;
        lag = [0, 0, 0, 0, 0, 0];
        deal();
        for (var i = 0; i < 30; i++) step();   // прогреть модель, чтобы картина была видна сразу
        render();
        vSet("<b>" + util.escape(sc.label) + ".</b> " + util.escape(sc.intro) +
          L(" Сам по себе график этого не скажет — нажми «Провести ребаланс» и смотри, за чем поедет lag.",
            " The graph alone will not tell you that — press “Run a rebalance” and watch what the lag follows."));
        stageA.say(L("Показана картина «", "Showing the scenario “") + util.escape(sc.label) +
          L("». Столбики — lag каждой партиции, справа — кто её читает.",
            "”. The bars are each partition’s lag; on the right is who reads it."));
      }

      /* --- контролы стенда А --- */

      var podRange = ui.range({
        label: L("подов в группе", "pods in the group"), min: 2, max: 8, value: pods,
        onInput: function (v) {
          var interrupted = stw || !!meas;
          if (interrupted) cancelPending();
          pods = v;
          deal();
          render();
          /* Состав группы поменялся — это настоящий ребаланс, и плитка обязана его
             показать. Ползунок отдаёт каждое промежуточное значение, поэтому считаем
             один раз, когда состав устоялся. */
          if (podsTimer) api.stop(podsTimer);
          podsTimer = api.timeout(400, function () {
            podsTimer = null;
            if (pods === podsCounted) return;
            podsCounted = pods;
            rebalances++;
            render();
          });
          if (interrupted) {
            vSet(L(
              "<b>Состав группы изменился прямо во время замера.</b> Замер отменён: сравнивать «до» и «после» " +
              "можно только при неизменном числе подов. Нажми «Провести ребаланс» заново.",

              "<b>The group membership changed right in the middle of the measurement.</b> The measurement is cancelled: “before” and “after” " +
              "can only be compared while the number of pods stays the same. Press “Run a rebalance” again."));
          }
          stageA.say(v > NP
            ? L("Подов ", "Pods: ") + v +
              L(", а партиций 6. Назначение достанется шести, лишние останутся без партиций и будут " +
                "простаивать: <b>число партиций — жёсткий потолок параллелизма группы</b>.",

                ", partitions: 6. Six of them get an assignment, the extras are left without partitions and will " +
                "idle: <b>the number of partitions is a hard ceiling on the parallelism of the group</b>.")
            : L("Подов ", "Pods: ") + v +
              L(". Изменение состава группы — это тоже ребаланс: назначение роздано заново, " +
                "и плитка «ребалансов» его засчитает.",

                ". A change of group membership is a rebalance too: the assignment is handed out again, " +
                "and the “rebalances” tile will count it."));
        }
      });

      var pauseBtn = ui.btn(L("Пауза", "Pause"), function () {
        paused = !paused;
        pauseBtn.textContent = paused ? L("Продолжить", "Resume") : L("Пауза", "Pause");
        stageA.say(paused
          ? L("Модель на паузе — можно спокойно разглядеть числа.",
              "The model is paused — now you can read the numbers at your leisure.")
          : L("Модель идёт.", "The model is running."));
      }, { sm: true, variant: "ghost" });

      KV.append(stageA.controls,
        ui.btn(L("Провести ребаланс", "Run a rebalance"), doRebalance, { variant: "read" }),
        podRange.el,
        pauseBtn,
        ui.btn(L("Сбросить картину", "Reset the scenario"), function () { setScenario(scKey); }, { sm: true, variant: "ghost" }));

      setScenario("hotkey");
      api.interval(TICK, tick);
      root.appendChild(stageA.el);

      /* ================================================================
         разбор стенда А
         ================================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Картина → диагноз</h3>" +
        "<p>Вся диагностика сводится к небольшой таблице. Она короткая, но именно она отделяет " +
        "«надо докинуть подов» от «надо лезть в данные» и от «надо смотреть один конкретный сервер».</p>",

        "<h3>Picture → diagnosis</h3>" +
        "<p>The whole diagnosis boils down to a small table. It is short, but it is exactly what separates " +
        "“we need to throw in more pods” from “we need to dig into the data” and from “we need to look at one particular server”.</p>"
      )));

      root.appendChild(ui.table(
        L(["Что видно на графике lag", "Что это значит", "Что делать"],
          ["What you see on the lag graph", "What it means", "What to do"]),
        L([
          ["Растёт одна партиция, остальные ровные",
            KV.terms("Перекос ключа ([[hot key]]) или медленный обработчик именно на этом назначении"),
            "Посмотри приток в эту партицию: сильно выше среднего → виноват ключ; ровный → виноват разбор"],
          ["Растут все партиции равномерно",
            "Группа медленнее продюсеров: потребителей не хватает",
            "Добавляй поды — но не больше, чем партиций. Упёрся в потолок → редизайн топика"],
          ["После ребаланса lag остался на <b>той же партиции</b>",
            "Дело в данных партиции",
            "Ищи ядовитую запись, крупные сообщения, горячий ключ. Поды менять бессмысленно"],
          ["После ребаланса lag поехал за <b>тем же подом</b>",
            "Дело в конкретном экземпляре",
            "Смотри этот под: GC, диск, сеть, зависший вызов наружу. Выведи или перезапусти"],
          ["Скорость потребления ≈ 0 при нормальном CPU",
            "Консьюмер заблокирован и не опрашивает брокер",
            "Ищи блокирующий вызов внутри обработки: внешний сервис, дедлок, бесконечный ретрай"]
        ], [
          ["One partition grows, the rest stay flat",
            KV.terms("Key skew (a [[hot key]]) or a slow handler on that one assignment"),
            "Look at the inflow into that partition: well above average → the key is to blame; even → the processing is"],
          ["Every partition grows evenly",
            "The group is slower than the producers: not enough consumers",
            "Add pods — but no more than there are partitions. Hit the ceiling → redesign the topic"],
          ["After a rebalance the lag stayed on <b>the same partition</b>",
            "It is the data in that partition",
            "Look for a poison record, large messages, a hot key. Swapping pods is pointless"],
          ["After a rebalance the lag followed <b>the same pod</b>",
            "It is that one instance",
            "Look at that pod: GC, disk, network, a hung outbound call. Take it out or restart it"],
          ["Consumption rate ≈ 0 while CPU looks normal",
            "The consumer is blocked and is not polling the broker",
            "Look for a blocking call inside the processing: an external service, a deadlock, an endless retry"]
        ])
      ));

      root.appendChild(ui.note("warn", L("ёмкость", "capacity"), L(
        "<p>Соблазн «добавим партиций, чтобы добавить подов» дорог. Много [[партиция|партиций]] — это давление на память брокера, " +
        "неэффективное [[compaction|уплотнение]] и лишняя нагрузка на контроллер кластера. " +
        "А само переназначение партиций — тяжёлая операция: Kafka копирует сегменты лога между [[брокер|брокерами]] " +
        "<b>параллельно обычному трафику</b>, конкурируя с ним за диск и сеть, и lag на время переезда растёт. " +
        "Плюс число партиций тяжело менять задним числом: меняется отображение ключей на партиции — рвётся порядок.</p>" +
        "<p><b>Параллелизм без эффективности — это потраченная зря ёмкость.</b></p>",

        "<p>The temptation to “add partitions so we can add pods” is expensive. Many [[partition|partitions]] mean pressure on broker memory, " +
        "inefficient [[compaction]] and extra load on the cluster controller. " +
        "And reassigning partitions is itself a heavy operation: Kafka copies log segments between [[broker|brokers]] " +
        "<b>alongside the normal traffic</b>, competing with it for disk and network, and the lag grows while the move is on. " +
        "On top of that the number of partitions is hard to change after the fact: the mapping of keys to partitions changes — order breaks.</p>" +
        "<p><b>Parallelism without efficiency is capacity spent for nothing.</b></p>"
      )));

      /* ================================================================
         СТЕНД Б — шторм ребалансов
         ================================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Шторм ребалансов</h3>" +
        "<p>Второй классический отказ выглядит так, будто сломалась сама Kafka. На деле это петля из шести шагов:</p>" +
        "<ol>" +
        "<li>Пик трафика — обработка батча стала занимать больше времени.</li>" +
        "<li>Время обработки перевалило за [[max.poll.interval.ms]] — интервал, за который [[консьюмер]] обязан вернуться за новой порцией.</li>" +
        "<li>Живого консьюмера признают выпавшим. Причём решает это <b>сам клиент</b>: фоновый поток " +
        "всё это время исправно слал heartbeat и для брокера под был жив — но раз <code>poll()</code> " +
        "не вернулся в срок, клиент выходит из группы сам.</li>" +
        "<li>Запускается [[ребаланс]]: партиции отбираются и раздаются заново.</li>" +
        "<li>Консьюмер возвращается — и снова попадает в тот же пик.</li>" +
        "<li>Цикл повторяется.</li>" +
        "</ol>",

        "<h3>The rebalance storm</h3>" +
        "<p>The second classic failure looks as if Kafka itself had broken. In fact it is a loop of six steps:</p>" +
        "<ol>" +
        "<li>A traffic spike — processing a batch started taking longer.</li>" +
        "<li>The processing time went past [[max.poll.interval.ms]] — the interval within which a [[consumer]] must come back for the next portion.</li>" +
        "<li>A perfectly alive consumer is declared gone. And it is <b>the client itself</b> that decides so: the background thread " +
        "had been sending heartbeats all along and to the broker the pod was alive — but since <code>poll()</code> " +
        "did not return in time, the client leaves the group on its own.</li>" +
        "<li>A [[rebalance]] starts: partitions are revoked and handed out again.</li>" +
        "<li>The consumer comes back — and runs straight into the same spike.</li>" +
        "<li>The cycle repeats.</li>" +
        "</ol>"
      )));

      root.appendChild(ui.note("bad", L("цена", "price"), L(
        "<p><b>При обычной (eager) стратегии ребаланс останавливает ВСЁ потребление в группе.</b> Не «немного медленнее» — " +
        "партиции отбираются у всех сразу, то есть простой всей группы, и в цикле он повторяется бесконечно. " +
        "При этом на дашборде CPU спокойный: консьюмер постоянно логически перезапускается и толком не работает. " +
        "Самый обманчивый симптом в Kafka.</p>" +
        "<p>Слово «eager» тут не украшение: при инкрементальной стратегии (<code>cooperative-sticky</code>) отбирают только те " +
        "партиции, которые действительно переезжают, а остальные читаются прямо во время ребаланса. Простой не исчезает, " +
        "но превращается из «стоит вся группа» в «стоят две партиции из шести» — включи тумблер на стенде и сравни " +
        "полоску «потребление группы» и простой в журнале.</p>",

        "<p><b>With the ordinary (eager) strategy a rebalance stops ALL consumption in the group.</b> Not “a bit slower” — " +
        "partitions are revoked from everyone at once, which means the whole group idles, and inside the loop it repeats endlessly. " +
        "Meanwhile the CPU on the dashboard is calm: the consumer keeps logically restarting and never really works. " +
        "The most deceptive symptom in Kafka.</p>" +
        "<p>The word “eager” is not decoration here: with the incremental strategy (<code>cooperative-sticky</code>) only the " +
        "partitions that actually move are revoked, and the rest are read right through the rebalance. The idle time does not disappear, " +
        "but it turns from “the whole group is stopped” into “two partitions out of six are stopped” — flip the toggle on the demo and compare " +
        "the “group consumption” bar and the idle time in the log.</p>"
      )));

      var stageB = ui.stage({
        title: L("Стенд Б · шторм ребалансов", "Demo B · the rebalance storm"),
        hint: L("Жми «Пик трафика», пока батч не перестанет укладываться в бюджет",
          "Press “Traffic spike” until the batch stops fitting into the budget")
      });

      var REB = 5;                       // секунд на один ребаланс
      var PEAK = [1, 150, 1400, 3000];   // во сколько раз пик замедляет обработку записи
      var PEAK_TXT = L(
        ["нормальный трафик", "пик трафика", "пик + деградация базы", "пик + база на коленях"],
        ["normal traffic", "traffic spike", "spike + database degradation", "spike + database on its knees"]);

      var records = 500, intervalS = 300, baseMs = 0.4, peak = 0;
      var stormTimer = null, phase = 0, stopped = false;
      var rebCount = 0, downtime = 0, wasted = 0, clock = 0;

      function fmt1(n) {
        /* Дробная часть: по-русски через запятую, по-английски через точку. */
        return String(Math.round(n * 10) / 10).replace(".", L(",", "."));
      }
      function fmtSec(s) {
        if (s < 1) return fmt1(s * 1000) + L(" мс", " ms");
        if (s < 10) return fmt1(s) + L(" с", " s");
        return util.num(Math.round(s)) + L(" с", " s");
      }
      function fmtT(s) { return util.num(Math.round(s)) + L(" с", " s"); }
      /** «в 2 раза», но «в 5 раз» и «в 400 раз»; у дробных всегда «раза». */
      function timesWord(n) {
        var r = Math.round(n * 10) / 10;
        return (r % 1) ? L("раза", "times") : util.plural(r, L("раз", "time"), L("раза", "times"), L("раз", "times"));
      }

      function derive() {
        var effMs = baseMs * PEAK[peak];
        var batchS = records * effMs / 1000;
        var budgetS = intervalS;
        return {
          effMs: effMs, batchS: batchS, budgetS: budgetS,
          ratio: batchS / budgetS, over: batchS > budgetS
        };
      }

      /* --- панель расчёта --- */

      function metric(label) {
        var v = el("span", { style: { "font-family": "var(--f-mono)", "font-size": "12.5px", color: "var(--ink)", "text-align": "right" } });
        var row = el("div", {
          style: {
            display: "flex", "justify-content": "space-between", gap: "14px",
            "align-items": "baseline", padding: "6px 0", "border-bottom": "1px dashed var(--line-soft)"
          }
        }, el("span", { style: { "font-family": "var(--f-mono)", "font-size": "10.5px", color: "var(--faint)" }, text: label }), v);
        return { el: row, v: v };
      }

      var mRecords = metric("max.poll.records");
      var mPer = metric(L("мс на запись", "ms per record"));
      var mBatch = metric(L("время обработки батча", "batch processing time"));
      var mBudget = metric("max.poll.interval.ms");
      var budgetBar = ui.bar(0);
      var budgetTxt = el("div", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)", "margin-top": "6px" }
      });

      var calcPanel = ui.panel(L("РАСЧЁТ", "THE MATH"),
        mRecords.el, mPer.el, mBatch.el, mBudget.el,
        el("div", { style: { "margin-top": "10px" } }, budgetBar.el, budgetTxt));

      /* --- панель дашборда --- */

      var stReb2 = ui.stat(L("ребалансов", "rebalances"), "0");
      var stDown = ui.stat(L("простой группы", "group downtime"), "0", { unit: L("с", "s") });
      var stWaste = ui.stat(L("выброшено работы", "work thrown away"), "0", { unit: L("с", "s") });
      var stCpu = ui.stat(L("CPU консьюмера", "consumer CPU"), "54", { unit: "%", tone: "good" });

      var consumeBar = ui.bar(1);
      var consumeTxt = el("div", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)", "margin-top": "6px" }
      });
      var workBadge = el("span.kv-badge", { style: { "white-space": "normal" } });

      var dashPanel = ui.panel(L("ЧТО ВИДНО НА ДАШБОРДЕ", "WHAT THE DASHBOARD SHOWS"),
        ui.stats(stReb2.el, stDown.el, stWaste.el, stCpu.el),
        el("div", { style: { "margin-top": "12px" } },
          el("span.kv-ctl__label", { text: L("потребление группы", "group consumption") }),
          el("div", { style: { "margin-top": "6px" } }, consumeBar.el, consumeTxt)),
        el("div", { style: { "margin-top": "10px" } }, workBadge));

      stageB.body.appendChild(el("div.kv-split", null, calcPanel, dashPanel));

      var term = ui.terminal(L("<span class='t-dim'>журнал группы orders-worker</span>",
        "<span class='t-dim'>orders-worker group log</span>"));
      term.el.style.maxHeight = "250px";
      term.el.style.overflowY = "auto";
      stageB.body.appendChild(el("div", { style: { "margin-top": "16px" } }, term.el));

      function say(html) {
        // Подрезку журнала и прокрутку делает сам ui.terminal: он держит
        // потолок строк и НЕ дёргает ленту вниз, если читатель отмотал вверх.
        // Своя подрезка с принудительным доводчиком перебивала это правило
        // и рвала отмотанный журнал вниз на каждой новой строке.
        term.line(html);
      }

      /* --- отрисовка стенда Б --- */

      function paintCalc() {
        var d = derive();
        mRecords.v.textContent = util.num(records) + L(" записей", " records");
        mPer.v.textContent = peak
          ? fmt1(baseMs) + " × " + util.num(PEAK[peak]) + " = " + fmtSec(d.effMs / 1000)
          : fmt1(baseMs) + L(" мс", " ms");
        mPer.v.style.color = peak ? "var(--bad)" : "var(--ink)";
        mBatch.v.textContent = util.num(records) + " × " + fmtSec(d.effMs / 1000) + " = " + fmtSec(d.batchS);
        mBatch.v.style.color = d.over ? "var(--bad)" : "var(--ink)";
        mBudget.v.textContent = fmtSec(d.budgetS);
        budgetBar.set(Math.min(1, d.ratio), d.over ? "bad" : d.ratio > 0.7 ? "warn" : null);
        budgetTxt.textContent = L("батч съедает ", "the batch eats ") +
          (d.ratio < 0.01 ? L("меньше 1", "less than 1") : String(Math.round(d.ratio * 100))) +
          L("% бюджета · ", "% of the budget · ") +
          (d.over
            ? L("превышение в ", "over budget by ") + fmt1(d.ratio) + " " + timesWord(d.ratio) +
              L(" — клиент выйдет из группы сам", " — the client will leave the group by itself")
            : L("запас ", "headroom ") + fmtSec(d.budgetS - d.batchS));
        budgetTxt.style.color = d.over ? "var(--bad)" : "var(--muted)";
      }

      function paintLive() {
        var d = derive();
        var coop = coopT.checked();
        stReb2.set(util.num(rebCount), rebCount ? "bad" : "good");
        stDown.set(util.num(Math.round(downtime)), downtime > 0 ? "bad" : "good");
        stWaste.set(util.num(Math.round(wasted)), wasted > 0 ? "warn" : "good");
        stCpu.set(stormTimer ? 11 + Math.floor(rnd() * 4) : 52 + Math.floor(rnd() * 7), "good");

        var share = stopped ? (coop ? 4 / 6 : 0) : 1;
        consumeBar.set(share, share === 1 ? null : share === 0 ? "bad" : "warn");
        consumeTxt.textContent = stopped
          ? (coop
              ? L("читаются 4 партиции из 6: переезжают только две", "4 partitions out of 6 keep being read: only two move")
              : L("0 из 6 партиций: группа стоит целиком", "0 partitions out of 6: the whole group is stopped"))
          : L("6 партиций из 6", "6 partitions out of 6");
        consumeTxt.style.color = stopped ? "var(--bad)" : "var(--muted)";

        workBadge.className = "kv-badge kv-badge--" + (stormTimer ? "bad" : "good");
        workBadge.textContent = stormTimer
          ? L("полезной работы 0: батч выбрасывается на полпути", "useful work 0: every batch is thrown away halfway")
          : L("полезная работа: ", "useful work: ") + util.num(records) + L(" записей за цикл", " records per cycle");
      }

      /* --- цикл шторма --- */

      function stormPhase() {
        var d = derive();
        var coop = coopT.checked();
        var cost = coop ? REB * (2 / 6) : REB;

        if (phase === 0) {
          say("<span class='t-dim'>t+" + fmtT(clock) + L("  consumer-2 · poll() → взято ", "  consumer-2 · poll() → took ") +
            util.num(records) + L(" записей</span>", " records</span>"));
        } else if (phase === 1) {
          clock += d.budgetS;
          wasted += d.budgetS;
          say("<span class='t-w'>t+" + fmtT(clock) + L("  батч разбирается ", "  the batch takes ") + fmtSec(d.batchS) +
            L(" при бюджете ", " on a budget of ") + fmtSec(d.budgetS) +
            L(" — не успел вернуться за новой порцией</span>", " — it did not come back for the next portion in time</span>"));
        } else if (phase === 2) {
          say("<span class='t-bad'>t+" + fmtT(clock) +
            L("  consumer-2: heartbeat шёл, но poll() не вернулся за ",
              "  consumer-2: heartbeats kept coming, but poll() did not return within ") +
            fmtSec(d.budgetS) +
            L(" → max.poll.interval.ms истёк, выхожу из группы сам</span>",
              " → max.poll.interval.ms expired, leaving the group on my own</span>"));
        } else if (phase === 3) {
          rebCount++;
          stopped = true;
          downtime += cost;
          clock += REB;
          say("<span class='t-bad'>t+" + fmtT(clock) + L("  РЕБАЛАНС #", "  REBALANCE #") + rebCount + " · " + (coop
            ? L("cooperative-sticky: переезжают 2 партиции из 6, остальные читаются дальше",
                "cooperative-sticky: 2 partitions out of 6 move, the rest keep being read")
            : L("партиции отобраны у ВСЕЙ группы → потребление остановлено",
                "partitions revoked from the WHOLE group → consumption stopped")) + "</span>");
        } else if (phase === 4) {
          if (staticT.checked()) {
            say("<span class='t-good'>t+" + fmtT(clock) +
              L("  static membership: group.instance.id тот же → " +
                "consumer-2 забрал свои партиции назад, второго ребаланса нет</span>",

                "  static membership: same group.instance.id → " +
                "consumer-2 took its own partitions back, there is no second rebalance</span>"));
          } else {
            rebCount++;
            downtime += cost;
            clock += REB;
            say("<span class='t-bad'>t+" + fmtT(clock) +
              L("  consumer-2 вернулся в группу → РЕБАЛАНС #", "  consumer-2 rejoined the group → REBALANCE #") +
              rebCount + L(" (второй за один цикл)</span>", " (the second in one cycle)</span>"));
          }
        } else {
          stopped = false;
          say("<span class='t-w'>t+" + fmtT(clock) + L("  тот же батч, тот же пик → снова ", "  same batch, same spike → ") +
            fmtSec(d.batchS) + L(" при бюджете ", " again on a budget of ") + fmtSec(d.budgetS) +
            L(". Цикл пошёл заново</span>", ". The cycle starts over</span>"));
        }
        phase = (phase + 1) % 6;
        paintLive();
      }

      function startStorm() {
        if (stormTimer) return;
        phase = 0;
        clock = 0;
        say(L("<span class='t-bad'>--- батч перестал укладываться в max.poll.interval.ms ---</span>",
          "<span class='t-bad'>--- the batch stopped fitting into max.poll.interval.ms ---</span>"));
        stormTimer = api.interval(620, stormPhase);
        stageB.say(L(
          "<b>Шторм пошёл.</b> Под жив, CPU спокойный, полезной работы — ноль: каждый батч выбрасывается на полпути.",
          "<b>The storm has started.</b> The pod is alive, the CPU is calm, useful work is zero: every batch is thrown away halfway."));
      }

      function endStorm(reason) {
        if (!stormTimer) return;
        api.stop(stormTimer);
        stormTimer = null;
        phase = 0;
        stopped = false;
        var d = derive();
        say("<span class='t-good'>--- " + reason + L(": батч ", ": the batch ") + fmtSec(d.batchS) +
          L(" ≤ бюджет ", " ≤ budget ") + fmtSec(d.budgetS) +
          L(" → консьюмер успевает вернуться, ребалансов нет ---</span>",
            " → the consumer gets back in time, no rebalances ---</span>"));
        paintLive();
      }

      function recompute(reason) {
        var d = derive();
        paintCalc();
        if (d.over) startStorm();
        else endStorm(reason || L("параметры изменены", "parameters changed"));
        paintLive();
      }

      /* --- контролы стенда Б --- */

      var recRange = ui.range({
        label: "max.poll.records", min: 100, max: 2000, step: 100, value: records,
        onInput: function (v) {
          records = v;
          recompute("max.poll.records = " + v);
          if (!derive().over) {
            stageB.say(L(
              "<b>max.poll.records вниз</b> — самый прямой рычаг. Берём меньше записей за раз, батч укладывается в бюджет. " +
              "Пропускная способность не падает: записей столько же, просто чаще возвращаешься к брокеру.",

              "<b>max.poll.records down</b> — the most direct lever. Take fewer records at a time and the batch fits into the budget. " +
              "Throughput does not drop: the same number of records, you just come back to the broker more often."));
          }
        }
      });

      var intRange = ui.range({
        label: "max.poll.interval.ms", min: 30, max: 600, step: 10, value: intervalS, unit: L("с", "s"),
        onInput: function (v) {
          intervalS = v;
          recompute("max.poll.interval.ms = " + v + L(" с", " s"));
          if (!derive().over) {
            stageB.say(L("<b>max.poll.interval.ms вверх</b> — честный ход, если работа объективно долгая. " +
              "Плата: по-настоящему зависший под теперь обнаружат не через прежний срок, а через ",

              "<b>max.poll.interval.ms up</b> — a fair move if the work really is that long. " +
              "The price: a genuinely hung pod will now be spotted not after the old deadline, but after ") +
              v + L(" секунд.", " seconds."));
          }
        }
      });

      var msRange = ui.range({
        label: L("мс на запись", "ms per record"), min: 0.1, max: 2, step: 0.1, value: baseMs, unit: L("мс", "ms"),
        onInput: function (v) {
          baseMs = v;
          recompute(L("время на запись ", "time per record ") + fmt1(v) + L(" мс", " ms"));
        }
      });

      var staticT = ui.toggle("static membership", false, function (on) {
        paintLive();
        stageB.say(on
          ? L("<b>static membership (group.instance.id).</b> Консьюмер сохраняет своё назначение: возвращение в группу больше не вызывает ребаланс. " +
              "В цикле шторма это убирает второй ребаланс из двух — но причину не трогает.",

              "<b>static membership (group.instance.id).</b> The consumer keeps its assignment: rejoining the group no longer triggers a rebalance. " +
              "In the storm cycle that removes one of the two rebalances — but it does not touch the cause.")
          : L("static membership выключен: каждый уход и каждое возвращение консьюмера — отдельный ребаланс.",
              "static membership is off: every departure and every return of the consumer is a rebalance of its own."));
      });

      var coopT = ui.toggle("cooperative-sticky", false, function (on) {
        paintLive();
        stageB.say(on
          ? L("<b>cooperative-sticky.</b> Вместо полного передела переезжают только те партиции, которым надо переехать. " +
              "Остальные читаются прямо во время ребаланса — простой группы падает в разы, но ребалансы всё равно идут.",

              "<b>cooperative-sticky.</b> Instead of a full re-deal, only the partitions that have to move do. " +
              "The rest are read right through the rebalance — group downtime drops several times over, but the rebalances still happen.")
          : L("Стратегия eager: на каждый ребаланс у ВСЕЙ группы отбираются все партиции.",
              "The eager strategy: on every rebalance all partitions are revoked from the WHOLE group."));
      });

      var peakBtn = ui.btn(L("Пик трафика ↑", "Traffic spike ↑"), function () {
        if (peak < PEAK.length - 1) peak++;
        recompute(L("пик изменён", "spike changed"));
        var d = derive();
        stageB.say("<b>" + util.escape(PEAK_TXT[peak]) +
          L(".</b> Внешний сервис отвечает медленнее, кэш промахивается, пошли ретраи: " +
            "теперь на запись уходит ",

            ".</b> The external service answers slower, the cache misses, the retries have started: " +
            "a record now takes ") + fmtSec(d.effMs / 1000) +
          L(", батч — ", ", the batch ") + fmtSec(d.batchS) +
          L(" при бюджете ", " on a budget of ") + fmtSec(d.budgetS) + ".");
      }, { variant: "danger" });

      KV.append(stageB.controls,
        peakBtn,
        ui.btn(L("Снять пик", "Clear the spike"), function () {
          peak = 0;
          recompute(L("пик снят", "spike cleared"));
          stageB.say(L(
            "Пик снят — батч снова укладывается в бюджет. В проде так не бывает: пик уходит сам, а настройки остаются.",
            "The spike is gone — the batch fits into the budget again. Production does not work like that: the spike leaves on its own, the settings stay."));
        }, { sm: true, variant: "ghost" }),
        recRange.el, intRange.el, msRange.el,
        staticT.el, coopT.el,
        ui.btn(L("Обнулить счётчики", "Reset the counters"), function () {
          rebCount = 0; downtime = 0; wasted = 0; clock = 0;
          term.clear();
          say(L("<span class='t-dim'>журнал группы orders-worker</span>",
            "<span class='t-dim'>orders-worker group log</span>"));
          paintLive();
        }, { sm: true, variant: "ghost" }));

      paintCalc();
      paintLive();
      say(L("<span class='t-dim'>t+0 с  consumer-2 · poll() → взято ",
        "<span class='t-dim'>t+0 s  consumer-2 · poll() → took ") +
        util.num(records) + L(" записей</span>", " records</span>"));
      say(L("<span class='t-good'>t+0 с  батч разобран за ",
        "<span class='t-good'>t+0 s  batch processed in ") +
        fmtSec(derive().batchS) + L(" при бюджете ", " on a budget of ") + fmtSec(intervalS) +
        L(" — запас огромный, группа здорова</span>", " — huge headroom, the group is healthy</span>"));
      stageB.say(L(
        "Пока всё в порядке: батч разбирается за доли секунды. Нажми «Пик трафика» и смотри, как ломается петля.",
        "So far so good: a batch is processed in a fraction of a second. Press “Traffic spike” and watch the loop break."));
      root.appendChild(stageB.el);

      /* ================================================================
         разбор стенда Б
         ================================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Чем это лечится</h3>" +
        "<ul>" +
        "<li><code>max.poll.records</code> <strong>вниз</strong> — берём меньше записей за раз. " +
        "Пропускная способность не падает: записей столько же, просто чаще возвращаешься к брокеру.</li>" +
        "<li><code>max.poll.interval.ms</code> <strong>вверх</strong> — если работа объективно долгая. " +
        "Плата честная: по-настоящему зависший под обнаружат позже.</li>" +
        "<li><code>group.instance.id</code> (static membership) — консьюмер сохраняет назначение при перезапуске, " +
        "и возвращение в группу не запускает ребаланс. В цикле шторма это убирает второй ребаланс из двух.</li>" +
        "<li><code>cooperative-sticky</code> — вместо полного передела переезжают только те партиции, которым надо переехать; " +
        "остальные читаются дальше.</li>" +
        "</ul>" +
        "<p>Разница принципиальная: первые два убирают <em>причину</em>, вторые два — только <em>цену</em> срыва. " +
        "Со включёнными тумблерами счётчик ребалансов всё равно тикает, а полезной работы всё равно ноль. " +
        "Поэтому сначала считай <code>records × время на запись</code> и сравнивай с бюджетом, а тумблеры включай вторым ходом.</p>",

        "<h3>What actually cures it</h3>" +
        "<ul>" +
        "<li><code>max.poll.records</code> <strong>down</strong> — take fewer records at a time. " +
        "Throughput does not drop: the same number of records, you just come back to the broker more often.</li>" +
        "<li><code>max.poll.interval.ms</code> <strong>up</strong> — if the work really is that long. " +
        "The price is honest: a genuinely hung pod is spotted later.</li>" +
        "<li><code>group.instance.id</code> (static membership) — the consumer keeps its assignment across a restart, " +
        "and rejoining the group does not start a rebalance. In the storm cycle that removes one of the two rebalances.</li>" +
        "<li><code>cooperative-sticky</code> — instead of a full re-deal only the partitions that have to move do; " +
        "the rest keep being read.</li>" +
        "</ul>" +
        "<p>The difference is fundamental: the first two remove the <em>cause</em>, the other two only the <em>price</em> of a miss. " +
        "With both toggles on, the rebalance counter still ticks and the useful work is still zero. " +
        "So first do the arithmetic — <code>records × time per record</code> — and compare it with the budget; flip the toggles as your second move.</p>"
      )));

      root.appendChild(ui.takeaway(L([
        "Смотри [[lag]] <b>по партициям</b>, а не суммой: одно и то же число получается и когда группа не тянет, и когда горит одна партиция.",
        "[[ребаланс|Ребаланс]] — это готовый диагностический приём (ценой простоя группы): lag остался на той же партиции → дело в данных; поехал за тем же подом → дело в экземпляре. Но сперва убедись, что раскладка вправду сменилась: со static membership под забирает свои же партиции, и сравнивать нечего.",
        "Потребителей в группе больше, чем партиций, — лишние простаивают. Против [[hot key]] поды не помогают вообще: одну партицию читает ровно один консьюмер.",
        "Шторм ребалансов: батч не уложился в [[max.poll.interval.ms]] → живой консьюмер сам вышел из группы (heartbeat при этом шёл исправно) → ребаланс остановил ВСЮ группу (при eager-стратегии; с cooperative-sticky встанут только переезжающие партиции) → он вернулся в тот же пик. CPU при этом спокойный, и верить ему нельзя.",
        "Причину шторма лечат два числа: <code>max.poll.records</code> вниз и <code>max.poll.interval.ms</code> вверх. <code>group.instance.id</code> и <code>cooperative-sticky</code> снижают только цену каждого срыва."
      ], [
        "Read [[lag]] <b>per partition</b>, not as a total: the very same number comes out when the group cannot keep up and when a single partition is on fire.",
        "[[rebalance|A rebalance]] is a ready-made diagnostic trick (at the price of group downtime): the lag stayed on the same partition → it is the data; it followed the same pod → it is the instance. But first make sure the layout really did change: with static membership a pod takes its own partitions back, and there is nothing to compare.",
        "More consumers in the group than partitions — the extras idle. Against a [[hot key]] pods do not help at all: a partition is read by exactly one consumer.",
        "The rebalance storm: the batch did not fit into [[max.poll.interval.ms]] → a live consumer left the group by itself (its heartbeats had been fine all along) → the rebalance stopped the WHOLE group (with the eager strategy; with cooperative-sticky only the moving partitions stop) → it came back into the same spike. The CPU stays calm through all of it, and you cannot trust it.",
        "The cause of a storm is cured by two numbers: <code>max.poll.records</code> down and <code>max.poll.interval.ms</code> up. <code>group.instance.id</code> and <code>cooperative-sticky</code> only cut the price of each miss."
      ])));
    }
  });
})();
