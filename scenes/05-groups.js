/* Глава 05 — Consumer group: раздача партиций, ребаланс, независимость групп. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "groups",
    num: 5,
    group: "Чтение",
    nav: "Consumer group",
    title: "Consumer group: кто какие партиции читает",
    lede: "Сервис почти никогда не живёт в одном экземпляре: копий три, пять, десять. Все они читают <b>один</b> топик — и не должны обработать один и тот же заказ трижды. Кто решает, какая копия читает какую партицию, и что будет, когда одна упадёт?",

    build: function (root, api) {

      var PARTS = 6;
      var ANA_COPIES = 2;

      root.appendChild(ui.prose(
        "<p>Сам по себе [[топик]] делить не умеет: подписчик всегда получает из него всё. Разделить работу можно только одним способом — " +
        "прописать копиям в конфиге одинаковый <code>group.id = billing</code>, и тогда для Kafka они перестают быть тремя подписчиками и становятся одним.</p>" +
        "<p>Дальше делёж берёт на себя Kafka: она раздаёт [[партиция|партиции]] между членами группы и следит, чтобы раздача оставалась честной, когда кто-то приходит или уходит. " +
        "Всё поведение группы выводится из одного правила.</p>"
      ));

      root.appendChild(ui.note("key", "закон",
        "<p><strong>Одну партицию внутри группы читает максимум ОДИН [[консьюмер]].</strong> Не «обычно», а всегда — это и есть механизм, который не даёт обработать сообщение дважды внутри группы.</p>" +
        "<p>Отсюда потолок: <b>параллелизм группы ≤ число партиций</b>. Шесть партиций и десять копий — четыре копии будут живы, подключены и совершенно бесполезны. " +
        "Хочешь читать быстрее — добавляй партиции, а не копии.</p>"
      ));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Раздача партиций между копиями",
        hint: "Двигай ползунок, убивай копии кнопкой в строке, включай вторую группу"
      });

      function say(html) { stage.say(KV.terms(html)); }

      /* ---- данные топика: ключи разложены той же формулой hash(ключ) % 6 ---- */
      var PER_LANE = 7;
      var LANES = [];
      for (var li = 0; li < PARTS; li++) LANES.push([]);
      function laneShort() { return LANES.some(function (l) { return l.length < PER_LANE; }); }
      /* Берём ключи, пока КАЖДАЯ лента не наберёт свои 7: раскладка зависит от
         util.hash, и пустая лента сломала бы стенд, а не только картинку. */
      for (var kn = 1; kn <= 400 && laneShort(); kn++) {
        var key = "u-" + kn;
        var lane = LANES[util.partitionFor(key, PARTS)];
        if (lane.length < PER_LANE) lane.push({ key: key, label: String(kn) });
      }

      var strips = [], subEls = [];
      var logWrap = el("div.kv-log");
      for (var pi = 0; pi < PARTS; pi++) {
        var s = ui.logStrip({ label: "партиция " + pi, sub: "—", records: LANES[pi] });
        s.strip.style.paddingBottom = "44px";   /* два ряда флажков: billing сверху, analytics снизу */
        strips.push(s);
        /* подпись владельца живёт в <span> внутри .kv-part__label; если разметка
           ядра изменится — заводим свой узел, чтобы сцена не падала. */
        var subEl = s.el.querySelector(".kv-part__label span");
        if (!subEl) {
          subEl = el("span");
          (s.el.querySelector(".kv-part__label") || s.el).appendChild(subEl);
        }
        subEls.push(subEl);
        logWrap.appendChild(s.el);
      }

      /* ---- состояние ---- */
      var members = [];                 // [{n, alive}] — копии группы billing
      var owners = [];                  // партиция -> индекс копии-владельца или -1
      var billPos = [];                 // committed offset группы billing по партициям
      var anaPos = [];                  // то же для группы analytics
      var anaOwn = [0, 0, 0, 1, 1, 1];  // раздача партиций внутри analytics (2 копии)
      var anaOn = false;
      var busy = false;                 // идёт ребаланс
      var wanted = 3;
      var pending = null;
      var rebalTimer = null;            // таймер текущего ребаланса
      var stopBar = null;               // остановка rAF полоски ребаланса
      var gen = 0;                      // поколение: «Сбросить» отменяет висящий ребаланс

      function liveIdx() {
        var out = [];
        members.forEach(function (m, idx) { if (m.alive) out.push(idx); });
        return out;
      }

      /* Раздача диапазонами — так же делит штатный RangeAssignor. */
      function assign() {
        owners = [];
        for (var q = 0; q < PARTS; q++) owners.push(-1);
        var live = liveIdx();
        if (!live.length) return;
        var per = Math.floor(PARTS / live.length);
        var extra = PARTS % live.length;
        var at = 0;
        live.forEach(function (mi, j) {
          var cnt = per + (j < extra ? 1 : 0);
          for (var c = 0; c < cnt; c++) owners[at + c] = mi;
          at += cnt;
        });
      }

      function partsOf(mi) {
        var out = [];
        owners.forEach(function (o, p) { if (o === mi) out.push(p); });
        return out;
      }
      function nameOf(mi) { return "копия " + members[mi].n; }

      /* ---- отрисовка ---- */

      function paintMarkers() {
        for (var p = 0; p < PARTS; p++) {
          var mi = owners[p], label, color;
          if (busy) { label = "ждёт"; color = "var(--faint)"; }
          else if (mi < 0) { label = "никто"; color = "var(--bad)"; }
          else { label = nameOf(mi); color = util.paletteColor(mi); }
          strips[p].marker("billing", { at: billPos[p], label: label, color: color }).style.bottom = "22px";
          if (anaOn) {
            strips[p].marker("ana", {
              at: anaPos[p], label: "analytics " + (anaOwn[p] + 1), color: "var(--read)"
            }).style.bottom = "2px";
          } else {
            strips[p].removeMarker("ana");
          }
        }
      }

      function paintSubs() {
        for (var p = 0; p < PARTS; p++) {
          var mi = owners[p], t, c;
          if (busy) { t = "ждёт назначения"; c = "var(--faint)"; }
          else if (mi < 0) { t = "никто не читает"; c = "var(--bad)"; }
          else { t = "читает " + nameOf(mi); c = util.paletteColor(mi); }
          subEls[p].textContent = t;
          subEls[p].style.color = c;
        }
      }

      var memList = el("div.kv-col");
      var capNote = el("div", {
        style: { "margin-top": "10px", "font-size": "12.5px", "line-height": "1.45", color: "var(--muted)" }
      });

      function renderMembers() {
        KV.clear(memList);
        members.forEach(function (m, idx) {
          var parts = partsOf(idx);
          var meta;
          if (!m.alive) meta = "выбыла из группы";
          else if (busy) meta = "ждёт назначения";
          else if (parts.length) meta = (parts.length > 1 ? "партиции " : "партиция ") + parts.join(", ");
          else meta = "партиций не досталось";

          var node = ui.node("consumer", nameOf(idx), meta);
          if (m.alive) {
            var color = util.paletteColor(idx);
            node.style.borderLeftColor = color;
            node.querySelector(".kv-node__dot").style.background = color;
          }
          if (!m.alive) {
            node.classList.add("kv-node--dead");
            node.appendChild(ui.badge("упала", "bad"));
          } else if (!busy && !parts.length) {
            node.style.opacity = ".6";
            node.appendChild(ui.badge("простаивает", "warn"));
          }
          if (m.alive) {
            var kill = ui.btn("убить", function () { killMember(idx); }, { sm: true, variant: "danger" });
            kill.disabled = busy;
            kill.style.marginLeft = "auto";
            node.appendChild(kill);
          }
          memList.appendChild(node);
        });

        var live = liveIdx();
        if (busy) {
          capNote.innerHTML = "Раздача снята со всех партиций: группа ждёт новых назначений и <b>не читает</b>.";
        } else if (!live.length) {
          capNote.innerHTML = "<b>Живых копий нет.</b> Топик никто не читает: записи лежат на месте, но их никто не обрабатывает.";
        } else if (live.length > PARTS) {
          var over = live.length - PARTS;
          capNote.innerHTML = "Копий " + live.length + ", партиций " + PARTS + ": <b>" + over + "</b> " +
            util.plural(over, "копии", "копиям", "копиям") + " партиций не досталось. " +
            "Они живы и подключены, но не ускорят чтение ни на запись — потолок группы равен числу партиций.";
        } else {
          var per = Math.floor(PARTS / live.length);
          var extra = PARTS % live.length;
          capNote.innerHTML = extra
            ? "Партиции делятся неровно: <b>" + extra + "</b> " +
              util.plural(extra, "копия получила", "копии получили", "копий получили") + " по " + (per + 1) +
              ", остальные — по " + per + "."
            : "Каждой копии досталось по <b>" + per + "</b> " +
              util.plural(per, "партиции", "партиции", "партиций") + ". Все при деле.";
        }
      }

      var anaBox = el("div.kv-col");

      function renderAna() {
        KV.clear(anaBox);
        if (!anaOn) {
          anaBox.appendChild(el("div", { style: { "font-size": "13px", "line-height": "1.45", color: "var(--faint)" } },
            "Группа выключена. Включи тумблер «вторая группа analytics» — она подключится к тому же топику со своими закладками."));
          return;
        }
        for (var c = 0; c < ANA_COPIES; c++) {
          var ps = [];
          anaOwn.forEach(function (o, p) { if (o === c) ps.push(p); });
          anaBox.appendChild(ui.node("consumer", "копия " + (c + 1), "партиции " + ps.join(", ")));
        }
        anaBox.appendChild(el("div", {
          style: { "margin-top": "6px", "font-size": "12.5px", "line-height": "1.45", color: "var(--muted)" }
        }, "Свой group.id, свои закладки. Что делает billing, analytics не видит — и наоборот."));
      }

      var stPart = ui.stat("партиций", PARTS);
      var stCopies = ui.stat("живых копий", 0, { tone: "read" });
      var stWork = ui.stat("работают", 0, { tone: "good" });
      var stIdle = ui.stat("простаивают", 0);

      function renderStats() {
        var live = liveIdx();
        var working = 0, idle = 0;
        live.forEach(function (mi) { if (partsOf(mi).length) working++; else idle++; });
        stCopies.set(live.length, live.length ? "read" : "bad");
        stWork.set(busy ? 0 : working, busy || !working ? "bad" : "good");
        stIdle.set(busy ? live.length : idle, busy || idle ? "warn" : null);
      }

      function render() {
        paintMarkers();
        paintSubs();
        renderMembers();
        renderAna();
        renderStats();
      }

      /* ---- ребаланс ---- */

      var bar = ui.bar(0, "bad");
      var banner = el("div.kv-row.kv-hidden", { style: { "margin-bottom": "12px" } },
        ui.badge("РЕБАЛАНС · потребление всей группы остановлено", "bad"),
        el("div", { style: { flex: "1 1 140px", "min-width": "90px" } }, bar.el));

      function diffText(before, after) {
        var moves = [];
        for (var p = 0; p < PARTS; p++) if (before[p] !== after[p]) moves.push(p);
        if (!moves.length) return "Раздача не изменилась.";
        var groups = {}, order = [];
        moves.forEach(function (p) {
          var k = after[p] >= 0 ? nameOf(after[p]) : "никто";
          if (!groups[k]) { groups[k] = []; order.push(k); }
          groups[k].push(p);
        });
        var orphaned = order.length === 1 && order[0] === "никто";
        return (orphaned ? "Раздавать некому: " : "Переехали: ") + order.map(function (k) {
          var list = groups[k];
          return (list.length > 1 ? "партиции " : "партиция ") + list.join(", ") +
            (k === "никто" ? " → <b>без владельца</b>" : " → <b>" + util.escape(k) + "</b>");
        }).join("; ") + ".";
      }

      function rebalance(why) {
        if (busy) return;
        var before = owners.slice();
        var myGen = ++gen;
        busy = true;
        banner.classList.remove("kv-hidden");
        logWrap.style.opacity = ".5";
        bar.set(0, "bad");
        render();
        syncButtons();
        say(why + " <b>Идёт ребаланс — не читает НИКТО в группе</b>: ни упавшая копия, ни те, кого перемена вообще не касается. " +
          "Владельцы сняты со всех шести партиций, новых пока нет.");

        /* Состояние двигает таймер, rAF — только полоска: в фоновой вкладке
           кадры не приходят, и стенд не должен залипать в ребалансе. */
        var ms = api.reduced ? 150 : 900;
        if (stopBar) stopBar();
        stopBar = api.raf(function (dt, total) { bar.set(total / ms, "bad"); });
        rebalTimer = api.timeout(ms, finish);

        function finish() {
          if (stopBar) { stopBar(); stopBar = null; }
          rebalTimer = null;
          if (myGen !== gen) return;    // стенд сбросили, пока шёл ребаланс
          bar.set(1, "bad");
          busy = false;
          banner.classList.add("kv-hidden");
          logWrap.style.opacity = "";
          assign();
          render();
          syncButtons();
          var haveOwner = owners.some(function (o) { return o >= 0; });
          say("<b>Ребаланс закончен.</b> " + diffText(before, owners) +
            (haveOwner
              ? " Закладки при этом не сбросились: [[committed offset|committed offsets]] принадлежат ГРУППЕ, а не копии — " +
                "новый владелец продолжает ровно с того места, где остановился прежний."
              : " Закладки всё равно на месте: [[committed offset|committed offsets]] лежат в [[__consumer_offsets]] и переживают уход всех копий — " +
                "подними группу, и она продолжит ровно отсюда."));
        }
      }

      /* ---- действия ---- */

      function killMember(idx) {
        if (busy || !members[idx] || !members[idx].alive) return;
        var nm = nameOf(idx);
        var lost = partsOf(idx);
        members[idx].alive = false;
        rebalance("<b>" + util.escape(nm) + " упала.</b> Координатор группы перестал получать от неё heartbeat и объявил " +
          (lost.length
            ? ((lost.length > 1 ? "её партиции " : "её партицию ") + lost.join(", ") + " бесхозными.")
            : "ребаланс (партиций у неё и так не было)."));
      }

      function reviveAll() {
        if (busy) return;
        var dead = members.filter(function (m) { return !m.alive; }).length;
        if (!dead) { say("Упавших копий нет."); return; }
        members.forEach(function (m) { m.alive = true; });
        rebalance("<b>" + dead + " " + util.plural(dead, "копия поднялась", "копии поднялись", "копий поднялось") +
          ".</b> Возвращение в группу — такой же повод для ребаланса, как и уход.");
      }

      function readBilling() {
        if (busy) return;
        var moved = {}, order = [], count = 0, orphan = [], finished = [];
        for (var p = 0; p < PARTS; p++) {
          var mi = owners[p];
          if (mi < 0) { orphan.push(p); continue; }
          if (billPos[p] >= LANES[p].length) { finished.push(p); continue; }
          strips[p].highlight(billPos[p], "is-reading", 700);
          billPos[p]++;
          count++;
          if (!moved[mi]) { moved[mi] = []; order.push(mi); }
          moved[mi].push(p);
        }
        paintMarkers();

        if (!liveIdx().length) {
          say("<b>Читать некому.</b> В группе не осталось ни одной живой копии: все шесть закладок стоят, " +
            "[[lag]] растёт с каждой новой записью. Данные не теряются — но и не обрабатываются.");
          return;
        }
        var msg;
        if (count) {
          msg = "<b>billing читает.</b> " + order.map(function (mi) {
            return util.escape(nameOf(mi)) + " → " + moved[mi].join(", ");
          }).join("; ") + ". За один шаг группа продвинулась на " + count + " " +
            util.plural(count, "запись", "записи", "записей") + ": партиции читаются параллельно, каждая — своей копией.";
        } else {
          msg = "<b>billing дочитала всё, что ей досталось.</b> Закладки стоят у конца лога ([[LEO]]) и будут ждать новых записей.";
        }
        if (orphan.length) {
          msg += " " + (orphan.length > 1 ? "Партиции " : "Партицию ") + orphan.join(", ") +
            " читать некому — там закладка не двинулась, [[lag]] копится.";
        }
        if (finished.length && count) {
          msg += " " + (finished.length > 1 ? "Партиции " : "Партиция ") + finished.join(", ") + " уже дочитаны до конца.";
        }
        say(msg);
      }

      function readAnalytics() {
        if (busy || !anaOn) return;
        var count = 0;
        for (var p = 0; p < PARTS; p++) {
          if (anaPos[p] >= LANES[p].length) continue;
          strips[p].highlight(anaPos[p], "is-reading", 700);
          anaPos[p]++;
          count++;
        }
        paintMarkers();
        say(count
          ? "<b>analytics читает.</b> Её две копии идут по своим партициям (копия 1 — 0, 1, 2; копия 2 — 3, 4, 5), за этот шаг продвинулись " +
            count + " " + util.plural(count, "закладка", "закладки", "закладок") + ". " +
            "Флажки billing не сдвинулись ни на клетку: у каждой группы свой [[committed offset]] в [[__consumer_offsets]]. " +
            "Один и тот же лог читают двое, и они друг другу не мешают."
          : "<b>analytics дочитала топик до конца.</b> Позиции billing это никак не затронуло — группы полностью независимы.");
      }

      /* ---- контролы ---- */

      var readBillBtn = ui.btn("billing читает", readBilling, { variant: "read" });
      var readAnaBtn = ui.btn("analytics читает", readAnalytics, { sm: true });
      var reviveBtn = ui.btn("Поднять упавшие", reviveAll, { sm: true, variant: "ghost" });

      function syncButtons() {
        readBillBtn.disabled = busy;
        readAnaBtn.disabled = busy || !anaOn;
        reviveBtn.disabled = busy || !members.some(function (m) { return !m.alive; });
      }

      function setCount(n) {
        while (members.length < n) members.push({ n: members.length + 1, alive: true });
        if (members.length > n) members.length = n;
      }

      function applyCopies() {
        pending = null;
        if (busy) { pending = api.timeout(200, applyCopies); return; }
        if (wanted === members.length) return;
        var was = members.length;
        var d = Math.abs(wanted - was);
        setCount(wanted);
        /* В списке могут оставаться упавшие строки, поэтому считаем живых, а не слоты. */
        var nowLive = liveIdx().length;
        rebalance(wanted > was
          ? "<b>" + (d === 1 ? "Новая копия вошла" : d + " " + util.plural(d, "копия вошла", "копии вошли", "копий вошло")) +
            " в группу.</b> Живых копий в группе: " + nowLive + "."
          : "<b>" + (d === 1 ? "Копия вышла" : d + " " + util.plural(d, "копия вышла", "копии вышли", "копий вышло")) +
            " из группы по-хорошему.</b> Живых копий в группе: " + nowLive + ".");
      }

      var copies = ui.range({
        label: "копий в billing", min: 1, max: 8, value: 3,
        onInput: function (v) {
          wanted = v;
          if (pending) api.stop(pending);
          pending = api.timeout(280, applyCopies);
        }
      });

      var anaToggle = ui.toggle("вторая группа analytics", false, function (on) {
        anaOn = on;
        render();
        syncButtons();
        say(on
          ? "<b>Подключилась группа analytics</b> — тот же топик, свой <code>group.id</code>. Её закладки (бирюзовые, нижний ряд) стоят в других местах: " +
            "она читает медленнее и ведёт собственный счёт. Обрати внимание: у billing при этом <b>ничего не дрогнуло</b> — ребаланс касается только своей группы."
          : "analytics отключилась. На billing это не повлияло никак: ни ребаланса, ни сдвига закладок.");
      });

      /* ---- сборка стенда ---- */

      stage.body.appendChild(banner);
      stage.body.appendChild(logWrap);
      stage.body.appendChild(el("div", { style: { "margin-top": "12px" } },
        ui.legend([
          { color: "var(--k0)", label: "верхний флажок — billing, цвет копии-владельца" },
          { color: "var(--read)", label: "нижний флажок — вторая группа analytics" },
          { color: "var(--bad)", label: "партицию не читает никто" }
        ])));
      var statsRow = ui.stats(stPart.el, stCopies.el, stWork.el, stIdle.el);
      statsRow.style.marginTop = "14px";
      stage.body.appendChild(statsRow);
      stage.body.appendChild(el("div.kv-split", { style: { "margin-top": "16px" } },
        ui.panel("ГРУППА billing", memList, capNote),
        ui.panel("ГРУППА analytics", anaBox)));

      KV.append(stage.controls,
        readBillBtn, readAnaBtn, copies.el, anaToggle.el, reviveBtn,
        ui.btn("Сбросить", reset, { sm: true, variant: "ghost" }));

      function reset() {
        if (pending) { api.stop(pending); pending = null; }
        if (rebalTimer) { api.stop(rebalTimer); rebalTimer = null; }
        if (stopBar) { stopBar(); stopBar = null; }
        gen++;
        busy = false;
        banner.classList.add("kv-hidden");
        logWrap.style.opacity = "";
        members = [];
        wanted = 3;
        setCount(3);
        copies.set(3);
        billPos = [];
        anaPos = [];
        var start = [4, 3, 5, 2, 4, 3], astart = [1, 2, 1, 1, 2, 1];
        for (var p = 0; p < PARTS; p++) {
          billPos.push(Math.min(start[p], LANES[p].length));
          anaPos.push(Math.min(astart[p], LANES[p].length));
        }
        anaOn = false;
        anaToggle.set(false);
        assign();
        render();
        syncButtons();
        say("Топик <code>orders</code>: 6 партиций, в каждой лежат записи (подпись на клетке — ключ, тот самый <code>hash(ключ) % 6</code> из прошлой главы). " +
          "Группа billing из трёх копий: каждой досталось по две партиции. Флажок под лентой говорит, <b>кто</b> читает партицию и где стоит закладка группы: " +
          "[[committed offset]] указывает на запись, которую прочитают <b>следующей</b>, а не на последнюю обработанную.");
      }

      reset();
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
        "<h3>Что стенд показал</h3>" +
        "<ul>" +
        "<li><strong>Ползунок на 7–8.</strong> Лишним копиям нечего дать: партиций всего шесть. Они живы, подключены к группе, " +
        "видны координатору — и не обрабатывают ничего. Плитка «простаивают» — это деньги, потраченные впустую.</li>" +
        "<li><strong>«Убить копию».</strong> Её партиции не зависают бесхозными: живые разбирают их и продолжают с <em>той же</em> закладки. " +
        "Позиция хранится у группы, а не в памяти конкретного процесса.</li>" +
        "<li><strong>Вторая группа.</strong> analytics читает тот же лог, её флажки стоят в других местах и двигаются только своей кнопкой. " +
        "Ни одно действие billing на них не влияет — и наоборот.</li>" +
        "</ul>" +
        "<h4>Как это устроено внутри</h4>" +
        "<p>Один из брокеров назначается координатором группы. Члены группы шлют ему heartbeat: «я жив, я держу свои партиции». " +
        "Выбыть можно двумя разными способами. Первый: heartbeat не приходил дольше <code>session.timeout.ms</code> (процесс убит, сеть отвалилась) — " +
        "координатор сам объявляет копию мёртвой. Второй: heartbeat идёт исправно (его шлёт отдельный фоновый поток), но копия не вернулась " +
        "за новой порцией дольше [[max.poll.interval.ms]] — застряла на обработке; тогда она выходит из группы <em>сама</em>. " +
        "Итог в обоих случаях один — [[ребаланс]]. Ровно то же самое происходит, когда копия <em>приходит</em>: " +
        "деплой, автоскейл, перезапуск — всё это ребалансы.</p>"
      ));

      root.appendChild(ui.note("warn", "цена",
        "<p><strong>Ребаланс — это stop-the-world для всей группы.</strong> Пока идёт перераспределение, не читает никто: ни упавшая копия, ни девять живых, " +
        "которых перемена не касалась. Секунда ребаланса на группе из десяти копий — это секунда простоя всех десяти.</p>" +
        "<p>Отсюда неочевидное следствие: «перекатить под нагрузкой десять копий по очереди» — это не десять ребалансов, а около двадцати: " +
        "каждая копия сначала уходит, а потом возвращается, и каждое движение стоит группе остановки. Почему так и как это смягчают — в главе 13.</p>"
      ));

      root.appendChild(ui.takeaway([
        "[[consumer group]] — копии одного сервиса с общим <code>group.id</code>. Kafka сама делит партиции между её членами.",
        "Одну партицию в группе читает <b>максимум один</b> консьюмер. Потолок параллелизма = число партиций; лишние копии простаивают.",
        "Копия ушла или пришла → [[ребаланс]]: партиции переезжают, а закладки остаются — [[committed offset|committed offsets]] принадлежат группе, а не процессу.",
        "Ребаланс останавливает <b>всю группу</b>, а не только упавшую копию.",
        "Разные группы полностью независимы: свои закладки, свой темп, никакого взаимного влияния."
      ]));
    }
  });
})();
