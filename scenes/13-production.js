/* Глава 13 — Что ломается в проде: lag по партициям и шторм ребалансов. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "production",
    num: 13,
    group: "Прод",
    nav: "Что ломается в проде",
    title: "Диагностика: lag по партициям и шторм ребалансов",
    lede: "Суммарный <b>lag</b> по топику — почти бесполезное число: оно одинаково и когда группа целиком не тянет, и когда горит одна партиция. Диагноз живёт в разбивке по партициям — и в том, за чем поедет lag после <b>ребаланса</b>.",

    build: function (root, api) {

      var rnd = util.rng(20260914);

      /* ================================================================
         подводка
         ================================================================ */

      root.appendChild(ui.prose(
        "<p>В проде нет отладчика — есть графики, и первое движение опытного человека всегда одно: " +
        "развернуть [[lag]] группы <strong>по партициям</strong> [[топик|топика]]. " +
        "Разбивка показывает то, чего в одном числе нет физически: <strong>ровно ли размазана работа</strong>.</p>" +
        "<p>Дальше три вопроса, и все три читаются с одного экрана: растёт одна партиция или все? " +
        "сколько льётся в неё на входе? и главный приём — " +
        "за чем поедет lag <strong>после [[ребаланс|ребаланса]]</strong>: за партицией или за подом.</p>"
      ));

      root.appendChild(ui.note("key", "приём",
        "<p>Ребаланс переставляет партиции между потребителями. Значит это готовый эксперимент: " +
        "<b>lag остался на той же партиции — дело в данных; lag поехал за тем же подом — дело в экземпляре</b>. " +
        "Один клик отделяет «плохие данные» от «плохого сервера» — правда, не бесплатно: " +
        "на время ребаланса группа не читает вообще ничего, и это ты сейчас увидишь на столбиках.</p>"
      ));

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
          label: "перекос ключа",
          inRate: [40, 38, 42, 260, 39, 41],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: -1, sickPower: 0,
          intro: "В партицию 3 льётся вшестеро больше остальных: почти все события идут с одним ключом."
        },
        starved: {
          label: "не хватает потребителей",
          inRate: [128, 132, 130, 129, 131, 130],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: -1, sickPower: 0,
          intro: "Приток ровный и обычный, но группа целиком разбирает медленнее, чем пишут продюсеры."
        },
        badpart: {
          label: "больная партиция",
          inRate: [40, 41, 39, 40, 40, 42],
          hard: [1, 1, 1, 1, 8, 1],
          sickPod: -1, sickPower: 0,
          intro: "Приток всюду одинаковый, но разбор партиции 4 идёт в разы медленнее: сообщения тяжёлые."
        },
        badpod: {
          label: "больной под",
          inRate: [40, 41, 39, 40, 40, 42],
          hard: [1, 1, 1, 1, 1, 1],
          sickPod: 1, sickPower: 18,
          intro: "Приток ровный, данные обычные — а два назначения разбираются еле-еле."
        }
      };

      var scKey = "hotkey";
      var sc = SCEN[scKey];
      var lag = [0, 0, 0, 0, 0, 0];
      var assign = [0, 1, 2, 0, 1, 2];
      var pods = 3;
      var rot = 0;
      var stw = false;          // stop-the-world: идёт ребаланс
      var paused = false;
      var rebalances = 0;
      var meas = null;          // замер после ребаланса
      var gen = 0;              // поколение: отменяет отложенный ребаланс и замер

      var stageA = ui.stage({
        title: "Стенд А · lag по партициям",
        hint: "Выбери картину, посмотри на столбики и нажми «Провести ребаланс»"
      });

      /* --- выбор картины --- */

      var seg = ui.seg([
        { value: "hotkey", label: "перекос ключа" },
        { value: "starved", label: "не хватает потребителей" },
        { value: "badpart", label: "больная партиция" },
        { value: "badpod", label: "больной под" }
      ], scKey, function (v) { setScenario(v); });

      stageA.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "14px" } },
        el("span.kv-ctl__label", { text: "картина" }), seg.el));

      /* --- таблица партиций --- */

      var GRID = "54px minmax(110px, 1fr) 88px 52px 186px";

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

      var partBox = el("div", { style: { "min-width": "530px" } });

      partBox.appendChild(gridRow([
        span("партиция", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span("lag", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span("записей", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span("под", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" }),
        span("приток · обработка", { color: "var(--faint)", "font-size": "10px", "letter-spacing": ".08em", "text-transform": "uppercase" })
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
          { color: "var(--bad)", label: "lag растёт" },
          { color: "var(--read)", label: "lag рассасывается" }
        ])));

      /* --- поды группы --- */

      var podsBox = el("div.kv-row", { style: { "margin-top": "16px" } });
      stageA.body.appendChild(ui.panel("ГРУППА orders-worker", podsBox));

      /* --- показатели --- */

      var stSum = ui.stat("Σ lag по топику", "0", { unit: "записей" });
      var stMax = ui.stat("макс. по партиции", "0", { unit: "записей" });
      var stGrow = ui.stat("растёт партиций", "0", { unit: "из 6" });
      var stReb = ui.stat("ребалансов", "0");
      stageA.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.stats(stSum.el, stMax.el, stGrow.el, stReb.el)));

      /* --- диагноз --- */

      var vBody = el("div", { style: { "font-size": "14px", "line-height": "1.55", color: "var(--ink-2)" } });
      stageA.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.panel("ДИАГНОЗ", vBody)));

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

      function podName(i) { return i < 0 ? "разные поды" : "consumer-" + (i + 1); }
      function plist(arr) {
        return arr.map(function (p) { return "P" + p; }).join(", ");
      }

      function renderPods() {
        KV.clear(podsBox);
        for (var i = 0; i < pods; i++) {
          var mine = podPartitions(i);
          var n = ui.node("consumer", "consumer-" + (i + 1),
            mine.length ? "читает " + plist(mine) : "простаивает: партиций не досталось");
          if (!mine.length) n.classList.add("kv-node--dead");
          var dot = n.querySelector(".kv-node__dot");
          if (dot) dot.style.background = util.paletteColor(i);
          n.style.borderLeftColor = util.paletteColor(i);
          podsBox.appendChild(n);
        }
        if (pods > NP) {
          podsBox.appendChild(ui.badge("подов больше, чем партиций — лишние простаивают", "warn"));
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
          rows[p].rate.textContent = "приток " + Math.round(sc.inRate[p]) + "/с · обработка " + Math.round(c) + "/с";
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
        stageA.say("<b>Stop-the-world.</b> Пока идёт ребаланс, группа не читает <b>ничего</b> — lag растёт на всех шести партициях сразу.");
        vSet("<b>Ребаланс пошёл.</b> Партиции отобраны у всей группы. Это и есть цена каждого ребаланса: " +
          "не «немного медленнее», а полная остановка потребления.");
        render();
        api.timeout(1600, function () {
          if (my !== gen) return;          // картину сменили, пока шёл stop-the-world
          reassign();
          stw = false;
          rebalances++;
          meas = { before: before, suspect: suspect, delta: [0, 0, 0, 0, 0, 0], ticks: 0 };
          vSet(before.length
            ? "Назначение роздано заново. До ребаланса lag рос на <b>" + plist(before) + "</b>, их читал <b>" +
              podName(suspect) + "</b>. Смотрю, за чем он поедет…"
            : "Назначение роздано заново. До ребаланса lag не рос нигде — смотрю, изменится ли что-нибудь…");
          stageA.say("Партиции переставлены между подами. Замер идёт — следи за столбиками.");
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
          head = "<b>Lag не растёт ни на одной партиции.</b>";
          body = "Группа успевает за продюсерами: то, что накопилось, будет рассасываться. " +
            "Если до этого не хватало потребителей — ты их только что добавил.";
        } else if (after.length >= NP - 1) {
          head = "<b>Растут все партиции сразу, ребаланс ничего не изменил.</b>";
          body = "Это не перекос и не больной под: группа просто медленнее продюсеров. " +
            "Добавляй потребителей — но не больше, чем партиций: лишние поды не получат назначения и будут простаивать. " +
            "Упёрся в потолок при шести партициях — дальше только добавлять партиции, а это меняет отображение " +
            "ключей на партиции: порядок по ключу рвётся на стыке.";
        } else if (overloadedSet().length && sameSet(after, overloadedSet())) {
          head = "<b>Горят ровно те партиции, что достались перегруженным подам.</b>";
          body = "6 партиций не делятся нацело на " + pods + " " +
            util.plural(pods, "под", "пода", "подов") + ": кому-то досталось по две, кому-то по одной. " +
            "Двойное назначение не вывозит приток, одинарное вывозит с запасом — и никакой ребаланс этого не выпрямит, " +
            "он лишь переставит, кому не повезёт. Держи число подов делителем числа партиций: 1, 2, 3 или 6.";
        } else if (sameSet(after, m.before)) {
          var mid = medianIn(), hot = 0;
          after.forEach(function (p) { if (sc.inRate[p] >= mid * 2) hot = 1; });
          head = "<b>Lag остался на тех же партициях: " + plist(after) + ".</b> Партиции переехали к другим подам — болезнь переехала вместе с ними.";
          body = hot
            ? "Смотри колонку притока: в " + plist(after) + " льётся в разы больше, чем в остальные. Это перекос ключа " +
              "(hot key): почти все события идут с одним значением ключа и ложатся в одну партицию. " +
              "Подов добавлять бесполезно — одну партицию читает ровно один потребитель группы. " +
              "Лечится ключом: добавь к нему различающую часть или разнеси горячее значение по нескольким партициям вручную."
            : "Приток туда такой же, как везде, значит дело не в объёме, а в самих данных партиции: крупные сообщения, " +
              "ядовитая запись, на которой обработчик уходит в ретраи. Иди смотреть содержимое партиции, поды тут ни при чём.";
        } else if (m.suspect >= 0 && sameSet(after, podPartitions(m.suspect))) {
          head = "<b>Lag поехал за подом.</b> Горели " + plist(m.before) + ", теперь горят " + plist(after) +
            " — ровно те, что достались " + podName(m.suspect) + ".";
          body = "Проблема в конкретном экземпляре, а не в данных: сборка мусора, упёршийся диск, шумный сосед по ноде, " +
            "зависший вызов наружу. Выведи этот под из группы или перезапусти — картина выпрямится. " +
            "Заметь: скорость обработки на его партициях почти ноль, хотя данные обычные.";
        } else {
          head = "<b>Картина смешанная.</b> До ребаланса росли " + plist(m.before) + ", после — " + plist(after) + ".";
          body = "Ни за партицией, ни за подом чисто не поехало. Прогони ребаланс ещё раз и смотри, что повторяется: " +
            "повторяемость и есть доказательство.";
        }
        vSet("<p style='margin:0 0 8px'>" + head + "</p><p style='margin:0'>" + body + "</p>");
        stageA.say("Замер закончен — диагноз в панели выше.");
        render();
      }

      /* --- смена картины --- */

      function setScenario(key) {
        scKey = key;
        sc = SCEN[key];
        cancelPending();
        rebalances = 0;
        rot = 0;
        lag = [0, 0, 0, 0, 0, 0];
        deal();
        for (var i = 0; i < 30; i++) step();   // прогреть модель, чтобы картина была видна сразу
        render();
        vSet("<b>" + util.escape(sc.label) + ".</b> " + util.escape(sc.intro) +
          " Сам по себе график этого не скажет — нажми «Провести ребаланс» и смотри, за чем поедет lag.");
        stageA.say("Показана картина «" + util.escape(sc.label) + "». Столбики — lag каждой партиции, справа — кто её читает.");
      }

      /* --- контролы стенда А --- */

      var podRange = ui.range({
        label: "подов в группе", min: 2, max: 8, value: pods,
        onInput: function (v) {
          var interrupted = stw || !!meas;
          if (interrupted) cancelPending();
          pods = v;
          deal();
          render();
          if (interrupted) {
            vSet("<b>Состав группы изменился прямо во время замера.</b> Замер отменён: сравнивать «до» и «после» " +
              "можно только при неизменном числе подов. Нажми «Провести ребаланс» заново.");
          }
          stageA.say(v > NP
            ? "Подов " + v + ", а партиций 6. Назначение достанется шести, лишние останутся без партиций и будут " +
              "простаивать: <b>число партиций — жёсткий потолок параллелизма группы</b>."
            : "Подов " + v + ". Изменение состава группы — это тоже ребаланс: назначение роздано заново.");
        }
      });

      var pauseBtn = ui.btn("Пауза", function () {
        paused = !paused;
        pauseBtn.textContent = paused ? "Продолжить" : "Пауза";
        stageA.say(paused ? "Модель на паузе — можно спокойно разглядеть числа." : "Модель идёт.");
      }, { sm: true, variant: "ghost" });

      KV.append(stageA.controls,
        ui.btn("Провести ребаланс", doRebalance, { variant: "read" }),
        podRange.el,
        pauseBtn,
        ui.btn("Сбросить картину", function () { setScenario(scKey); }, { sm: true, variant: "ghost" }));

      setScenario("hotkey");
      api.interval(TICK, tick);
      root.appendChild(stageA.el);

      /* ================================================================
         разбор стенда А
         ================================================================ */

      root.appendChild(ui.prose(
        "<h3>Картина → диагноз</h3>" +
        "<p>Вся диагностика сводится к небольшой таблице. Она короткая, но именно она отделяет " +
        "«надо докинуть подов» от «надо лезть в данные» и от «надо смотреть один конкретный сервер».</p>"
      ));

      root.appendChild(ui.table(
        ["Что видно на графике lag", "Что это значит", "Что делать"],
        [
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
        ]
      ));

      root.appendChild(ui.note("warn", "ёмкость",
        "<p>Соблазн «добавим партиций, чтобы добавить подов» дорог. Много [[партиция|партиций]] — это давление на память брокера, " +
        "неэффективное [[compaction|уплотнение]] и лишняя нагрузка на контроллер кластера. " +
        "А само переназначение партиций — тяжёлая операция: Kafka копирует сегменты лога между [[брокер|брокерами]] " +
        "<b>параллельно обычному трафику</b>, конкурируя с ним за диск и сеть, и lag на время переезда растёт. " +
        "Плюс число партиций тяжело менять задним числом: меняется отображение ключей на партиции — рвётся порядок.</p>" +
        "<p><b>Параллелизм без эффективности — это потраченная зря ёмкость.</b></p>"
      ));

      /* ================================================================
         СТЕНД Б — шторм ребалансов
         ================================================================ */

      root.appendChild(ui.prose(
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
        "</ol>"
      ));

      root.appendChild(ui.note("bad", "цена",
        "<p><b>Ребаланс останавливает ВСЁ потребление в группе.</b> Не «немного медленнее» — простой всей группы, " +
        "и в цикле он повторяется бесконечно. При этом на дашборде CPU спокойный: консьюмер постоянно " +
        "логически перезапускается и толком не работает. Самый обманчивый симптом в Kafka.</p>"
      ));

      var stageB = ui.stage({
        title: "Стенд Б · шторм ребалансов",
        hint: "Жми «Пик трафика», пока батч не перестанет укладываться в бюджет"
      });

      var REB = 5;                       // секунд на один ребаланс
      var PEAK = [1, 150, 1400, 3000];   // во сколько раз пик замедляет обработку записи
      var PEAK_TXT = ["нормальный трафик", "пик трафика", "пик + деградация базы", "пик + база на коленях"];

      var records = 500, intervalS = 300, baseMs = 0.4, peak = 0;
      var stormTimer = null, phase = 0, stopped = false;
      var rebCount = 0, downtime = 0, wasted = 0, clock = 0;

      function fmt1(n) {
        return String(Math.round(n * 10) / 10).replace(".", ",");
      }
      function fmtSec(s) {
        if (s < 1) return fmt1(s * 1000) + " мс";
        if (s < 10) return fmt1(s) + " с";
        return util.num(Math.round(s)) + " с";
      }
      function fmtT(s) { return util.num(Math.round(s)) + " с"; }
      /** «в 2 раза», но «в 5 раз» и «в 400 раз»; у дробных всегда «раза». */
      function timesWord(n) {
        var r = Math.round(n * 10) / 10;
        return (r % 1) ? "раза" : util.plural(r, "раз", "раза", "раз");
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
      var mPer = metric("мс на запись");
      var mBatch = metric("время обработки батча");
      var mBudget = metric("max.poll.interval.ms");
      var budgetBar = ui.bar(0);
      var budgetTxt = el("div", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)", "margin-top": "6px" }
      });

      var calcPanel = ui.panel("РАСЧЁТ",
        mRecords.el, mPer.el, mBatch.el, mBudget.el,
        el("div", { style: { "margin-top": "10px" } }, budgetBar.el, budgetTxt));

      /* --- панель дашборда --- */

      var stReb2 = ui.stat("ребалансов", "0");
      var stDown = ui.stat("простой группы", "0", { unit: "с" });
      var stWaste = ui.stat("выброшено работы", "0", { unit: "с" });
      var stCpu = ui.stat("CPU консьюмера", "54", { unit: "%", tone: "good" });

      var consumeBar = ui.bar(1);
      var consumeTxt = el("div", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)", "margin-top": "6px" }
      });
      var workBadge = el("span.kv-badge", { style: { "white-space": "normal" } });

      var dashPanel = ui.panel("ЧТО ВИДНО НА ДАШБОРДЕ",
        ui.stats(stReb2.el, stDown.el, stWaste.el, stCpu.el),
        el("div", { style: { "margin-top": "12px" } },
          el("span.kv-ctl__label", { text: "потребление группы" }),
          el("div", { style: { "margin-top": "6px" } }, consumeBar.el, consumeTxt)),
        el("div", { style: { "margin-top": "10px" } }, workBadge));

      stageB.body.appendChild(el("div.kv-split", null, calcPanel, dashPanel));

      var term = ui.terminal("<span class='t-dim'>журнал группы orders-worker</span>");
      term.el.style.maxHeight = "250px";
      term.el.style.overflowY = "auto";
      stageB.body.appendChild(el("div", { style: { "margin-top": "16px" } }, term.el));

      function say(html) {
        term.line(html);
        var parts = term.el.innerHTML.split("\n");
        if (parts.length > 60) term.el.innerHTML = parts.slice(parts.length - 60).join("\n");
        term.el.scrollTop = term.el.scrollHeight;
      }

      /* --- отрисовка стенда Б --- */

      function paintCalc() {
        var d = derive();
        mRecords.v.textContent = util.num(records) + " записей";
        mPer.v.textContent = peak
          ? fmt1(baseMs) + " × " + util.num(PEAK[peak]) + " = " + fmtSec(d.effMs / 1000)
          : fmt1(baseMs) + " мс";
        mPer.v.style.color = peak ? "var(--bad)" : "var(--ink)";
        mBatch.v.textContent = util.num(records) + " × " + fmtSec(d.effMs / 1000) + " = " + fmtSec(d.batchS);
        mBatch.v.style.color = d.over ? "var(--bad)" : "var(--ink)";
        mBudget.v.textContent = fmtSec(d.budgetS);
        budgetBar.set(Math.min(1, d.ratio), d.over ? "bad" : d.ratio > 0.7 ? "warn" : null);
        budgetTxt.textContent = "батч съедает " +
          (d.ratio < 0.01 ? "меньше 1" : String(Math.round(d.ratio * 100))) + "% бюджета · " +
          (d.over
            ? "превышение в " + fmt1(d.ratio) + " " + timesWord(d.ratio) + " — клиент выйдет из группы сам"
            : "запас " + fmtSec(d.budgetS - d.batchS));
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
          ? (coop ? "читаются 4 партиции из 6: переезжают только две" : "0 из 6 партиций: группа стоит целиком")
          : "6 партиций из 6";
        consumeTxt.style.color = stopped ? "var(--bad)" : "var(--muted)";

        workBadge.className = "kv-badge kv-badge--" + (stormTimer ? "bad" : "good");
        workBadge.textContent = stormTimer
          ? "полезной работы 0: батч выбрасывается на полпути"
          : "полезная работа: " + util.num(records) + " записей за цикл";
      }

      /* --- цикл шторма --- */

      function stormPhase() {
        var d = derive();
        var coop = coopT.checked();
        var cost = coop ? REB * (2 / 6) : REB;

        if (phase === 0) {
          say("<span class='t-dim'>t+" + fmtT(clock) + "  consumer-2 · poll() → взято " + util.num(records) + " записей</span>");
        } else if (phase === 1) {
          clock += d.budgetS;
          wasted += d.budgetS;
          say("<span class='t-w'>t+" + fmtT(clock) + "  батч разбирается " + fmtSec(d.batchS) +
            " при бюджете " + fmtSec(d.budgetS) + " — не успел вернуться за новой порцией</span>");
        } else if (phase === 2) {
          say("<span class='t-bad'>t+" + fmtT(clock) + "  consumer-2: heartbeat шёл, но poll() не вернулся за " +
            fmtSec(d.budgetS) + " → max.poll.interval.ms истёк, выхожу из группы сам</span>");
        } else if (phase === 3) {
          rebCount++;
          stopped = true;
          downtime += cost;
          clock += REB;
          say("<span class='t-bad'>t+" + fmtT(clock) + "  РЕБАЛАНС #" + rebCount + " · " + (coop
            ? "cooperative-sticky: переезжают 2 партиции из 6, остальные читаются дальше"
            : "партиции отобраны у ВСЕЙ группы → потребление остановлено") + "</span>");
        } else if (phase === 4) {
          if (staticT.checked()) {
            say("<span class='t-good'>t+" + fmtT(clock) + "  static membership: group.instance.id тот же → " +
              "consumer-2 забрал свои партиции назад, второго ребаланса нет</span>");
          } else {
            rebCount++;
            downtime += cost;
            clock += REB;
            say("<span class='t-bad'>t+" + fmtT(clock) + "  consumer-2 вернулся в группу → РЕБАЛАНС #" +
              rebCount + " (второй за один цикл)</span>");
          }
        } else {
          stopped = false;
          say("<span class='t-w'>t+" + fmtT(clock) + "  тот же батч, тот же пик → снова " + fmtSec(d.batchS) +
            " при бюджете " + fmtSec(d.budgetS) + ". Цикл пошёл заново</span>");
        }
        phase = (phase + 1) % 6;
        paintLive();
      }

      function startStorm() {
        if (stormTimer) return;
        phase = 0;
        clock = 0;
        say("<span class='t-bad'>--- батч перестал укладываться в max.poll.interval.ms ---</span>");
        stormTimer = api.interval(620, stormPhase);
        stageB.say("<b>Шторм пошёл.</b> Под жив, CPU спокойный, полезной работы — ноль: каждый батч выбрасывается на полпути.");
      }

      function endStorm(reason) {
        if (!stormTimer) return;
        api.stop(stormTimer);
        stormTimer = null;
        phase = 0;
        stopped = false;
        var d = derive();
        say("<span class='t-good'>--- " + reason + ": батч " + fmtSec(d.batchS) + " ≤ бюджет " +
          fmtSec(d.budgetS) + " → консьюмер успевает вернуться, ребалансов нет ---</span>");
        paintLive();
      }

      function recompute(reason) {
        var d = derive();
        paintCalc();
        if (d.over) startStorm();
        else endStorm(reason || "параметры изменены");
        paintLive();
      }

      /* --- контролы стенда Б --- */

      var recRange = ui.range({
        label: "max.poll.records", min: 100, max: 2000, step: 100, value: records,
        onInput: function (v) {
          records = v;
          recompute("max.poll.records = " + v);
          if (!derive().over) {
            stageB.say("<b>max.poll.records вниз</b> — самый прямой рычаг. Берём меньше записей за раз, батч укладывается в бюджет. " +
              "Пропускная способность не падает: записей столько же, просто чаще возвращаешься к брокеру.");
          }
        }
      });

      var intRange = ui.range({
        label: "max.poll.interval.ms", min: 30, max: 600, step: 10, value: intervalS, unit: "с",
        onInput: function (v) {
          intervalS = v;
          recompute("max.poll.interval.ms = " + v + " с");
          if (!derive().over) {
            stageB.say("<b>max.poll.interval.ms вверх</b> — честный ход, если работа объективно долгая. " +
              "Плата: по-настоящему зависший под теперь обнаружат не через прежний срок, а через " + v + " секунд.");
          }
        }
      });

      var msRange = ui.range({
        label: "мс на запись", min: 0.1, max: 2, step: 0.1, value: baseMs, unit: "мс",
        onInput: function (v) { baseMs = v; recompute("время на запись " + fmt1(v) + " мс"); }
      });

      var staticT = ui.toggle("static membership", false, function (on) {
        paintLive();
        stageB.say(on
          ? "<b>static membership (group.instance.id).</b> Консьюмер сохраняет своё назначение: возвращение в группу больше не вызывает ребаланс. " +
            "В цикле шторма это убирает второй ребаланс из двух — но причину не трогает."
          : "static membership выключен: каждый уход и каждое возвращение консьюмера — отдельный ребаланс.");
      });

      var coopT = ui.toggle("cooperative-sticky", false, function (on) {
        paintLive();
        stageB.say(on
          ? "<b>cooperative-sticky.</b> Вместо полного передела переезжают только те партиции, которым надо переехать. " +
            "Остальные читаются прямо во время ребаланса — простой группы падает в разы, но ребалансы всё равно идут."
          : "Стратегия eager: на каждый ребаланс у ВСЕЙ группы отбираются все партиции.");
      });

      var peakBtn = ui.btn("Пик трафика ↑", function () {
        if (peak < PEAK.length - 1) peak++;
        recompute("пик изменён");
        var d = derive();
        stageB.say("<b>" + util.escape(PEAK_TXT[peak]) + ".</b> Внешний сервис отвечает медленнее, кэш промахивается, пошли ретраи: " +
          "теперь на запись уходит " + fmtSec(d.effMs / 1000) + ", батч — " + fmtSec(d.batchS) +
          " при бюджете " + fmtSec(d.budgetS) + ".");
      }, { variant: "danger" });

      KV.append(stageB.controls,
        peakBtn,
        ui.btn("Снять пик", function () {
          peak = 0;
          recompute("пик снят");
          stageB.say("Пик снят — батч снова укладывается в бюджет. В проде так не бывает: пик уходит сам, а настройки остаются.");
        }, { sm: true, variant: "ghost" }),
        recRange.el, intRange.el, msRange.el,
        staticT.el, coopT.el,
        ui.btn("Обнулить счётчики", function () {
          rebCount = 0; downtime = 0; wasted = 0; clock = 0;
          term.clear();
          say("<span class='t-dim'>журнал группы orders-worker</span>");
          paintLive();
        }, { sm: true, variant: "ghost" }));

      paintCalc();
      paintLive();
      say("<span class='t-dim'>t+0 с  consumer-2 · poll() → взято " + util.num(records) + " записей</span>");
      say("<span class='t-good'>t+0 с  батч разобран за " + fmtSec(derive().batchS) + " при бюджете " +
        fmtSec(intervalS) + " — запас огромный, группа здорова</span>");
      stageB.say("Пока всё в порядке: батч разбирается за доли секунды. Нажми «Пик трафика» и смотри, как ломается петля.");
      root.appendChild(stageB.el);

      /* ================================================================
         разбор стенда Б
         ================================================================ */

      root.appendChild(ui.prose(
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
        "Поэтому сначала считай <code>records × время на запись</code> и сравнивай с бюджетом, а тумблеры включай вторым ходом.</p>"
      ));

      root.appendChild(ui.takeaway([
        "Смотри [[lag]] <b>по партициям</b>, а не суммой: одно и то же число получается и когда группа не тянет, и когда горит одна партиция.",
        "[[ребаланс|Ребаланс]] — это готовый диагностический приём (ценой простоя группы): lag остался на той же партиции → дело в данных; поехал за тем же подом → дело в экземпляре.",
        "Потребителей в группе больше, чем партиций, — лишние простаивают. Против [[hot key]] поды не помогают вообще: одну партицию читает ровно один консьюмер.",
        "Шторм ребалансов: батч не уложился в [[max.poll.interval.ms]] → живой консьюмер сам вышел из группы (heartbeat при этом шёл исправно) → ребаланс остановил ВСЮ группу → он вернулся в тот же пик. CPU при этом спокойный, и верить ему нельзя.",
        "Причину шторма лечат два числа: <code>max.poll.records</code> вниз и <code>max.poll.interval.ms</code> вверх. <code>group.instance.id</code> и <code>cooperative-sticky</code> снижают только цену каждого срыва."
      ]));
    }
  });
})();
