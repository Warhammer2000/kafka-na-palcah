/* Глава 05 — Consumer group: раздача партиций, ребаланс, независимость групп. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "groups",
    num: 5,
    group: ["Чтение", "Reading"],
    nav: ["Consumer group", "Consumer group"],
    title: ["Consumer group: кто какие партиции читает", "Consumer group: who reads which partitions"],
    lede: [
      "Сервис почти никогда не живёт в одном экземпляре: копий три, пять, десять. Все они читают <b>один</b> топик — и не должны обработать один и тот же заказ трижды. Кто решает, какая копия читает какую партицию, и что будет, когда одна упадёт?",
      "A service almost never runs as a single instance: there are three copies of it, or five, or ten. All of them read <b>one</b> topic — and they must not process the same order three times over. Who decides which instance reads which partition, and what happens when one of them dies?"
    ],

    build: function (root, api) {

      var PARTS = 6;
      var ANA_COPIES = 2;

      root.appendChild(ui.prose(L(
        "<p>Сам по себе [[топик]] делить не умеет: подписчик всегда получает из него всё. Разделить работу можно только одним способом — " +
        "прописать копиям в конфиге одинаковый <code>group.id = billing</code>, и тогда для Kafka они перестают быть тремя подписчиками и становятся одним.</p>" +
        "<p>Дальше делёж берёт на себя Kafka: она раздаёт [[партиция|партиции]] между членами группы и следит, чтобы раздача оставалась честной, когда кто-то приходит или уходит. " +
        "Всё поведение группы выводится из одного правила.</p>",

        "<p>A [[topic]] on its own cannot split anything up: a subscriber always gets everything out of it. There is exactly one way to divide the work — " +
        "put the same <code>group.id = billing</code> into the config of every instance, and from that moment Kafka stops seeing three subscribers and sees one.</p>" +
        "<p>From there on Kafka does the dividing itself: it hands the [[partition|partitions]] out among the members of the group and keeps the split fair when someone joins or leaves. " +
        "Everything a group does follows from one rule.</p>"
      )));

      root.appendChild(ui.note("key", L("закон", "law"), L(
        "<p><strong>Одну партицию внутри группы читает максимум ОДИН [[консьюмер]].</strong> Не «обычно», а всегда: " +
        "две копии одной группы никогда не держат одну и ту же партицию одновременно, поэтому запись не разъезжается " +
        "по двум обработчикам сразу.</p>" +
        "<p>Только не читай это как «ровно один раз». Если копия сделала работу, но упала до того, как записала закладку, " +
        "партицию заберёт другая — и перечитает всё после последнего [[commit|коммита]]. Правило убирает одновременное " +
        "чтение, а не повтор: обработчик всё равно обязан переживать вторую встречу с тем же сообщением. Почему так — в главе 7.</p>" +
        "<p>Отсюда потолок: <b>параллелизм группы ≤ число партиций</b>. Шесть партиций и десять копий — четыре копии будут живы, подключены и совершенно бесполезны. " +
        "Хочешь читать быстрее — добавляй партиции, а не копии.</p>",

        "<p><strong>Inside a group a partition is read by at most ONE [[consumer]].</strong> Not “usually” — always: " +
        "two instances of one group never hold the same partition at the same time, so a record never goes to two handlers " +
        "at once.</p>" +
        "<p>Just do not read that as “exactly once”. If an instance did the work but died before it wrote the bookmark, " +
        "another one takes the partition over — and re-reads everything after the last [[commit]]. The rule removes simultaneous " +
        "reading, not repeats: the handler still has to survive meeting the same message a second time. Why that is — chapter 7.</p>" +
        "<p>Hence the ceiling: <b>a group’s parallelism ≤ the number of partitions</b>. Six partitions and ten instances — four instances will be alive, connected and completely useless. " +
        "Want to read faster — add partitions, not instances.</p>"
      )));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Раздача партиций между копиями", "Handing the partitions out among the instances"),
        hint: L("Двигай ползунок, убивай копии кнопкой в строке, включай вторую группу",
          "Drag the slider, kill instances with the button in their row, switch the second group on")
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
        var s = ui.logStrip({ label: L("партиция ", "partition ") + pi, sub: "—", records: LANES[pi] });
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
      function nameOf(mi) { return (L("копия ", "instance ") + members[mi].n); }

      /* ---- отрисовка ---- */

      function paintMarkers() {
        for (var p = 0; p < PARTS; p++) {
          var mi = owners[p], label, color;
          if (busy) { label = L("ждёт", "waiting"); color = "var(--faint)"; }
          else if (mi < 0) { label = L("никто", "nobody"); color = "var(--bad)"; }
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
          if (busy) { t = L("ждёт назначения", "waiting to be assigned"); c = "var(--faint)"; }
          else if (mi < 0) { t = L("никто не читает", "nobody is reading it"); c = "var(--bad)"; }
          else { t = L("читает " + nameOf(mi), nameOf(mi) + " is reading"); c = util.paletteColor(mi); }
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
          if (!m.alive) meta = L("выбыла из группы", "dropped out of the group");
          else if (busy) meta = L("ждёт назначения", "waiting to be assigned");
          else if (parts.length) meta = (parts.length > 1 ? L("партиции ", "partitions ") : L("партиция ", "partition ")) + parts.join(", ");
          else meta = L("партиций не досталось", "got no partitions");

          var node = ui.node("consumer", nameOf(idx), meta);
          if (m.alive) {
            var color = util.paletteColor(idx);
            node.style.borderLeftColor = color;
            node.querySelector(".kv-node__dot").style.background = color;
          }
          if (!m.alive) {
            node.classList.add("kv-node--dead");
            node.appendChild(ui.badge(L("упала", "dead"), "bad"));
          } else if (!busy && !parts.length) {
            node.style.opacity = ".6";
            node.appendChild(ui.badge(L("простаивает", "idle"), "warn"));
          }
          if (m.alive) {
            var kill = ui.btn(L("убить", "kill"), function () { killMember(idx); }, { sm: true, variant: "danger" });
            kill.disabled = busy;
            kill.style.marginLeft = "auto";
            node.appendChild(kill);
          }
          memList.appendChild(node);
        });

        var live = liveIdx();
        if (busy) {
          capNote.innerHTML = L("Раздача снята со всех партиций: группа ждёт новых назначений и <b>не читает</b>.",
            "Every partition has been revoked: the group is waiting for new assignments and is <b>not reading</b>.");
        } else if (!live.length) {
          capNote.innerHTML = L("<b>Живых копий нет.</b> Топик никто не читает: записи лежат на месте, но их никто не обрабатывает.",
            "<b>No live instances left.</b> Nobody is reading the topic: the records stay where they are, and nothing processes them.");
        } else if (live.length > PARTS) {
          var over = live.length - PARTS;
          capNote.innerHTML = L("Копий ", "") + live.length + L(", партиций ", " instances, ") + PARTS + L(": <b>", " partitions: <b>") + over + "</b> " +
            util.plural(over, L("копии", "instance has"), L("копиям", "instances have"), L("копиям", "instances have")) +
            L(" партиций не досталось. ", " nothing to read. ") +
            L("Они живы и подключены, но не ускорят чтение ни на запись — потолок группы равен числу партиций.",
              "They are alive and connected, but they will not speed the reading up by a single record — a group’s ceiling is the number of partitions.");
        } else {
          var per = Math.floor(PARTS / live.length);
          var extra = PARTS % live.length;
          capNote.innerHTML = extra
            ? L("Партиции делятся неровно: <b>", "The partitions do not divide evenly: <b>") + extra + "</b> " +
              util.plural(extra, L("копия получила", "instance got"), L("копии получили", "instances each got"), L("копий получили", "instances each got")) +
              L(" по ", " ") + (per + 1) +
              L(", остальные — по ", ", the rest got ") + per + "."
            : L("Каждой копии досталось по <b>", "Every instance got <b>") + per + "</b> " +
              util.plural(per, L("партиции", "partition"), L("партиции", "partitions"), L("партиций", "partitions")) +
              L(". Все при деле.", ". Nobody is idle.");
        }
      }

      var anaBox = el("div.kv-col");

      function renderAna() {
        KV.clear(anaBox);
        if (!anaOn) {
          anaBox.appendChild(el("div", { style: { "font-size": "13px", "line-height": "1.45", color: "var(--faint)" } },
            L("Группа выключена. Включи тумблер «вторая группа analytics» — она подключится к тому же топику со своими закладками.",
              "The group is off. Flip the “second group analytics” switch — it will connect to the same topic with bookmarks of its own.")));
          return;
        }
        for (var c = 0; c < ANA_COPIES; c++) {
          var ps = [];
          anaOwn.forEach(function (o, p) { if (o === c) ps.push(p); });
          anaBox.appendChild(ui.node("consumer", L("копия ", "instance ") + (c + 1), L("партиции ", "partitions ") + ps.join(", ")));
        }
        anaBox.appendChild(el("div", {
          style: { "margin-top": "6px", "font-size": "12.5px", "line-height": "1.45", color: "var(--muted)" }
        }, L("Свой group.id, свои закладки. Что делает billing, analytics не видит — и наоборот.",
          "Its own group.id, its own bookmarks. analytics does not see what billing does — and the other way round.")));
      }

      var stPart = ui.stat(L("партиций", "partitions"), PARTS);
      var stCopies = ui.stat(L("живых копий", "live instances"), 0, { tone: "read" });
      var stWork = ui.stat(L("работают", "working"), 0, { tone: "good" });
      var stIdle = ui.stat(L("простаивают", "idle"), 0);

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
        ui.badge(L("РЕБАЛАНС · потребление всей группы остановлено", "REBALANCE · consumption stopped for the whole group"), "bad"),
        el("div", { style: { flex: "1 1 140px", "min-width": "90px" } }, bar.el));

      function diffText(before, after) {
        var moves = [];
        for (var p = 0; p < PARTS; p++) if (before[p] !== after[p]) moves.push(p);
        if (!moves.length) return (L("Раздача не изменилась.", "The assignment did not change."));
        var nobody = L("никто", "nobody");
        var groups = {}, order = [];
        moves.forEach(function (p) {
          var k = after[p] >= 0 ? nameOf(after[p]) : nobody;
          if (!groups[k]) { groups[k] = []; order.push(k); }
          groups[k].push(p);
        });
        var orphaned = order.length === 1 && order[0] === nobody;
        return (orphaned ? L("Раздавать некому: ", "There is nobody to hand them to: ") : L("Переехали: ", "Moved: ")) + order.map(function (k) {
          var list = groups[k];
          return (list.length > 1 ? L("партиции ", "partitions ") : L("партиция ", "partition ")) + list.join(", ") +
            (k === nobody ? L(" → <b>без владельца</b>", " → <b>no owner</b>") : " → <b>" + util.escape(k) + "</b>");
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
        say(why + L(" <b>Идёт ребаланс — не читает НИКТО в группе</b>: ни упавшая копия, ни те, кого перемена вообще не касается. " +
          "Владельцы сняты со всех шести партиций, новых пока нет.",
          " <b>A rebalance is running — NOBODY in the group is reading</b>: not the instance that died, and not the ones the change does not touch at all. " +
          "All six partitions have had their owner revoked, and the new ones are not there yet."));

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
          say(L("<b>Ребаланс закончен.</b> ", "<b>The rebalance is over.</b> ") + diffText(before, owners) +
            (haveOwner
              ? L(" Закладки при этом не сбросились: [[committed offset|committed offsets]] принадлежат ГРУППЕ, а не копии — " +
                "новый владелец продолжает ровно с того места, где остановился прежний.",
                " The bookmarks were not reset along the way: [[committed offset|committed offsets]] belong to the GROUP, not to an instance — " +
                "the new owner carries on from exactly where the previous one stopped.")
              : L(" Закладки всё равно на месте: [[committed offset|committed offsets]] лежат в [[__consumer_offsets]] и переживают уход всех копий — " +
                "подними группу, и она продолжит ровно отсюда.",
                " The bookmarks are still there anyway: [[committed offset|committed offsets]] live in [[__consumer_offsets]] and outlive every instance leaving — " +
                "bring the group back up and it carries on from exactly this point.")));
        }
      }

      /* ---- действия ---- */

      function killMember(idx) {
        if (busy || !members[idx] || !members[idx].alive) return;
        var nm = nameOf(idx);
        var lost = partsOf(idx);
        members[idx].alive = false;
        rebalance("<b>" + util.escape(nm) + L(" упала.</b> Координатор группы перестал получать от неё heartbeat и объявил ",
          " has died.</b> The group coordinator stopped getting heartbeats from it and declared ") +
          (lost.length
            ? ((lost.length > 1 ? L("её партиции ", "its partitions ") : L("её партицию ", "its partition ")) + lost.join(", ") +
              L(" бесхозными.", " ownerless."))
            : L("ребаланс (партиций у неё и так не было).", "a rebalance (it had no partitions anyway).")));
      }

      function reviveAll() {
        if (busy) return;
        var dead = members.filter(function (m) { return !m.alive; }).length;
        if (!dead) { say(L("Упавших копий нет.", "There are no dead instances.")); return; }
        members.forEach(function (m) { m.alive = true; });
        rebalance("<b>" + dead + " " + util.plural(dead, L("копия поднялась", "instance came back up"),
          L("копии поднялись", "instances came back up"), L("копий поднялось", "instances came back up")) +
          L(".</b> Возвращение в группу — такой же повод для ребаланса, как и уход.",
            ".</b> Coming back into the group is just as good a reason for a rebalance as leaving it."));
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
          say(L("<b>Читать некому.</b> В группе не осталось ни одной живой копии: все шесть закладок стоят, " +
            "[[lag]] растёт с каждой новой записью. Данные не теряются — но и не обрабатываются.",
            "<b>There is nobody to read.</b> Not one live instance is left in the group: all six bookmarks stand still, " +
            "[[lag]] grows with every new record. The data is not lost — but it is not processed either."));
          return;
        }
        var msg;
        if (count) {
          /* Хвост считаем из фактической раскладки: «каждая партиция — своей копией»
             верно только тогда, когда копий хватило на все партиции. */
          var atWork = liveIdx().filter(function (mi) { return partsOf(mi).length > 0; });
          var workers = atWork.length;
          var solo = workers > 0 && atWork.every(function (mi) { return partsOf(mi).length === 1; });
          var tail;
          if (workers < 2) {
            tail = L(": всё это забрала одна копия — свои партиции она обходит в одном цикле опроса, одну за другой. " +
              "Параллелизма в группе сейчас нет: он появляется только тогда, когда партиции разобраны РАЗНЫМИ копиями.",
              ": one single instance took all of it — it walks its partitions inside one poll cycle, one after another. " +
              "There is no parallelism in the group right now: it appears only when the partitions are held by DIFFERENT instances.");
          } else if (solo) {
            tail = ": " + workers + " " + util.plural(workers, L("копия работает", "instance works"),
              L("копии работают", "instances work"), L("копий работают", "instances work")) +
              L(" параллельно, и каждой досталось ровно по одной партиции — быстрее эта группа читать уже не сможет.",
                " in parallel, and each one got exactly one partition — this group cannot read any faster than that.");
          } else {
            tail = ": " + workers + " " + util.plural(workers, L("копия работает", "instance works"),
              L("копии работают", "instances work"), L("копий работают", "instances work")) +
              L(" параллельно, но партиций больше, чем работающих копий, — кому досталось несколько, тот обходит их в одном цикле опроса, одну за другой.",
                " in parallel, but there are more partitions than working instances — whoever got several walks them inside one poll cycle, one after another.");
          }
          msg = L("<b>billing читает.</b> ", "<b>billing reads.</b> ") + order.map(function (mi) {
            return util.escape(nameOf(mi)) + " → " + moved[mi].join(", ");
          }).join("; ") + L(". За один шаг группа продвинулась на ", ". In one step the group moved forward by ") + count + " " +
            util.plural(count, L("запись", "record"), L("записи", "records"), L("записей", "records")) + tail;
        } else {
          msg = L("<b>billing дочитала всё, что ей досталось.</b> Закладки стоят у конца лога ([[LEO]]) и будут ждать новых записей.",
            "<b>billing has read everything it was given.</b> The bookmarks stand at the end of the log ([[LEO]]) and will wait for new records.");
        }
        if (orphan.length) {
          msg += " " + (orphan.length > 1 ? L("Партиции ", "Nobody is reading partitions ") : L("Партицию ", "Nobody is reading partition ")) + orphan.join(", ") +
            L(" читать некому — там закладка не двинулась, [[lag]] копится.",
              " — no bookmark moved there, [[lag]] piles up.");
        }
        if (finished.length && count) {
          msg += " " + (finished.length > 1
            ? L("Партиции ", "Partitions ") + finished.join(", ") + L(" уже дочитаны до конца.", " have already been read to the end.")
            : L("Партиция ", "Partition ") + finished[0] + L(" уже дочитана до конца.", " has already been read to the end."));
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
          ? L("<b>analytics читает.</b> Её две копии идут по своим партициям (копия 1 — 0, 1, 2; копия 2 — 3, 4, 5), за этот шаг продвинулись ",
              "<b>analytics reads.</b> Its two instances walk their own partitions (instance 1 — 0, 1, 2; instance 2 — 3, 4, 5), and in this step ") +
            count + " " + util.plural(count, L("закладка", "bookmark"), L("закладки", "bookmarks"), L("закладок", "bookmarks")) +
            L(". ", " moved forward. ") +
            L("Флажки billing не сдвинулись ни на клетку: у каждой группы свой [[committed offset]] в [[__consumer_offsets]]. " +
              "Один и тот же лог читают двое, и они друг другу не мешают.",
              "The billing markers did not shift by a single cell: every group has its own [[committed offset]] in [[__consumer_offsets]]. " +
              "Two readers read the same log, and they do not get in each other’s way.")
          : L("<b>analytics дочитала топик до конца.</b> Позиции billing это никак не затронуло — группы полностью независимы.",
              "<b>analytics has read the topic to the end.</b> That did not touch billing’s positions at all — the groups are completely independent."));
      }

      /* ---- контролы ---- */

      var readBillBtn = ui.btn(L("billing читает", "billing reads"), readBilling, { variant: "read" });
      var readAnaBtn = ui.btn(L("analytics читает", "analytics reads"), readAnalytics, { sm: true });
      var reviveBtn = ui.btn(L("Поднять упавшие", "Bring the dead ones back"), reviveAll, { sm: true, variant: "ghost" });

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
        var liveWas = liveIdx().length;
        setCount(wanted);
        /* В списке могут оставаться упавшие строки, поэтому считаем живых, а не слоты. */
        var nowLive = liveIdx().length;
        var d = Math.abs(nowLive - liveWas);
        if (!d) {
          /* Срезали только строки уже упавших копий. Для группы они выбыли ещё тогда,
             когда координатор не дождался heartbeat: их партиции разобрали на ТОМ
             ребалансе, и вычеркнуть строку теперь группе ничего не стоит. */
          var gone = was - wanted;
          render();
          syncButtons();
          say((gone === 1
            ? L("<b>Из списка убрали строку копии, которая уже упала.</b> Нового ребаланса нет, и это не поблажка стенда: " +
              "из группы она выбыла ещё на прошлом ребалансе, тогда же её партиции разобрали живые. ",
              "<b>The row of an instance that had already died was dropped from the list.</b> There is no new rebalance, and that is not the demo going easy on you: " +
              "it left the group back at the previous rebalance, and the live ones took its partitions right then. ")
            : L("<b>Из списка убрали строки копий, которые уже упали.</b> Нового ребаланса нет, и это не поблажка стенда: " +
              "из группы они выбыли ещё на прошлом ребалансе, тогда же их партиции разобрали живые. ",
              "<b>The rows of instances that had already died were dropped from the list.</b> There is no new rebalance, and that is not the demo going easy on you: " +
              "they left the group back at the previous rebalance, and the live ones took their partitions right then. ")) +
            L("Живых копий по-прежнему <b>", "There are still <b>") + nowLive +
            L("</b>, раздача не меняется.", "</b> live instances, and the assignment does not change."));
          return;
        }
        rebalance(nowLive > liveWas
          ? "<b>" + (d === 1 ? L("Новая копия вошла", "A new instance joined") : d + " " + util.plural(d,
              L("копия вошла", "instance joined"), L("копии вошли", "instances joined"), L("копий вошло", "instances joined"))) +
            L(" в группу.</b> Живых копий в группе: ", " the group.</b> Live instances in the group: ") + nowLive + "."
          : "<b>" + (d === 1 ? L("Копия вышла", "An instance left") : d + " " + util.plural(d,
              L("копия вышла", "instance left"), L("копии вышли", "instances left"), L("копий вышло", "instances left"))) +
            L(" из группы по-хорошему.</b> Живых копий в группе: ", " the group gracefully, not by crashing.</b> Live instances in the group: ") + nowLive + ".");
      }

      var copies = ui.range({
        label: L("копий в billing", "instances in billing"), min: 1, max: 8, value: 3,
        onInput: function (v) {
          wanted = v;
          if (pending) api.stop(pending);
          pending = api.timeout(280, applyCopies);
        }
      });

      var anaToggle = ui.toggle(L("вторая группа analytics", "second group analytics"), false, function (on) {
        anaOn = on;
        render();
        syncButtons();
        say(on
          ? L("<b>Подключилась группа analytics</b> — тот же топик, свой <code>group.id</code>. Её закладки (бирюзовые, нижний ряд) стоят в других местах: " +
            "она читает медленнее и ведёт собственный счёт. Обрати внимание: у billing при этом <b>ничего не дрогнуло</b> — ребаланс касается только своей группы.",
            "<b>The analytics group has connected</b> — same topic, its own <code>group.id</code>. Its bookmarks (teal, bottom row) stand in other places: " +
            "it reads more slowly and keeps a count of its own. Note that nothing in billing <b>even flinched</b> — a rebalance only ever concerns its own group.")
          : L("analytics отключилась. На billing это не повлияло никак: ни ребаланса, ни сдвига закладок.",
            "analytics disconnected. That had no effect on billing whatsoever: no rebalance, no bookmark moving."));
      });

      /* ---- сборка стенда ---- */

      stage.body.appendChild(banner);
      stage.body.appendChild(logWrap);
      stage.body.appendChild(el("div", { style: { "margin-top": "12px" } },
        ui.legend([
          { color: "var(--k0)", label: L("верхний флажок — billing, цвет копии-владельца", "top marker — billing, in the colour of the owning instance") },
          { color: "var(--read)", label: L("нижний флажок — вторая группа analytics", "bottom marker — the second group, analytics") },
          { color: "var(--bad)", label: L("партицию не читает никто", "nobody is reading this partition") }
        ])));
      var statsRow = ui.stats(stPart.el, stCopies.el, stWork.el, stIdle.el);
      statsRow.style.marginTop = "14px";
      stage.body.appendChild(statsRow);
      stage.body.appendChild(el("div.kv-split", { style: { "margin-top": "16px" } },
        ui.panel(L("ГРУППА billing", "GROUP billing"), memList, capNote),
        ui.panel(L("ГРУППА analytics", "GROUP analytics"), anaBox)));

      KV.append(stage.controls,
        readBillBtn, readAnaBtn, copies.el, anaToggle.el, reviveBtn,
        ui.btn(L("Сбросить", "Reset"), reset, { sm: true, variant: "ghost" }));

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
        say(L("Топик <code>orders</code>: 6 партиций, в каждой лежат записи (подпись на клетке — ключ, тот самый <code>hash(ключ) % 6</code> из прошлой главы). " +
          "Группа billing из трёх копий: каждой досталось по две партиции. Флажок под лентой говорит, <b>кто</b> читает партицию и где стоит закладка группы: " +
          "[[committed offset]] указывает на запись, которую прочитают <b>следующей</b>, а не на последнюю обработанную.",
          "Topic <code>orders</code>: 6 partitions, each holding records (the caption on a cell is the key, the very same <code>hash(key) % 6</code> from the previous chapter). " +
          "The billing group has three instances: each one got two partitions. The marker under the strip says <b>who</b> reads that partition and where the group’s bookmark stands: " +
          "[[committed offset]] points at the record that will be read <b>next</b>, not at the last one processed."));
      }

      reset();
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
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
        "деплой, автоскейл, перезапуск — всё это ребалансы.</p>",

        "<h3>What the demo showed</h3>" +
        "<ul>" +
        "<li><strong>The slider at 7–8.</strong> There is nothing to give the extra instances: there are only six partitions. They are alive, connected to the group, " +
        "visible to the coordinator — and they process nothing. That “idle” tile is money burned for nothing.</li>" +
        "<li><strong>“Kill an instance”.</strong> Its partitions do not hang there ownerless: the live ones take them over and carry on from the <em>same</em> bookmark. " +
        "The position is kept by the group, not in the memory of one particular process.</li>" +
        "<li><strong>The second group.</strong> analytics reads the same log, its markers stand in other places and move only when you press its own button. " +
        "Nothing billing does affects them — and the other way round.</li>" +
        "</ul>" +
        "<h4>How it works inside</h4>" +
        "<p>One of the brokers is made the coordinator of the group. The members send it heartbeats: “I am alive, I am holding my partitions”. " +
        "There are two different ways to drop out. The first: no heartbeat arrived for longer than <code>session.timeout.ms</code> (the process was killed, the network went away) — " +
        "and the coordinator declares that instance dead itself. The second: the heartbeats keep coming (a separate background thread sends them), but the instance did not come back " +
        "for its next batch within [[max.poll.interval.ms]] — it is stuck processing; then it leaves the group <em>by itself</em>. " +
        "The outcome is the same in both cases — a [[rebalance]]. Exactly the same thing happens when an instance <em>joins</em>: " +
        "a deploy, an autoscale, a restart — all of those are rebalances.</p>"
      )));

      root.appendChild(ui.note("warn", L("цена", "price"), L(
        "<p><strong>Обычный (eager) ребаланс — это stop-the-world для всей группы.</strong> Пока идёт перераспределение, не читает никто: " +
        "ни упавшая копия, ни девять живых, которых перемена не касалась. Секунда ребаланса на группе из десяти копий — " +
        "это секунда простоя всех десяти; именно такой ребаланс показывает стенд.</p>" +
        "<p>Отсюда неочевидное следствие: «перекатить под нагрузкой десять копий по очереди» — это не десять ребалансов, а около двадцати: " +
        "каждая копия сначала уходит, а потом возвращается, и каждое движение стоит группе остановки. " +
        "Полной остановки можно избежать: инкрементальная (cooperative) стратегия отбирает только те партиции, которые действительно " +
        "переезжают, а остальные читаются без перерыва. Почему так и как это смягчают — в главе 13.</p>",

        "<p><strong>An ordinary (eager) rebalance is a stop-the-world for the entire group.</strong> While the redistribution runs, nobody reads: " +
        "not the instance that died, and not the nine live ones the change never touched. A second of rebalance on a group of ten instances " +
        "is a second of downtime for all ten; that is exactly the kind of rebalance the demo shows.</p>" +
        "<p>Hence a consequence you would not guess: “roll ten instances one by one under load” is not ten rebalances but about twenty: " +
        "every instance first leaves and then comes back, and each move costs the group a full stop. " +
        "That full stop can be avoided: the incremental (cooperative) strategy revokes only the partitions that actually " +
        "move, and the rest keep being read without a break. Why it works that way and how the pain is eased — chapter 13.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "[[consumer group]] — копии одного сервиса с общим <code>group.id</code>. Kafka сама делит партиции между её членами.",
          "Одну партицию в группе читает <b>максимум один</b> консьюмер. Потолок параллелизма = число партиций; лишние копии простаивают.",
          "Копия ушла или пришла → [[ребаланс]]: партиции переезжают, а закладки остаются — [[committed offset|committed offsets]] принадлежат группе, а не процессу.",
          "Обычный (eager) ребаланс останавливает <b>всю группу</b>, а не только упавшую копию; инкрементальная стратегия оставляет на месте тех, кого перемена не касается — глава 13.",
          "Разные группы полностью независимы: свои закладки, свой темп, никакого взаимного влияния."
        ],
        [
          "A [[consumer group]] is the instances of one service sharing a <code>group.id</code>. Kafka divides the partitions among its members itself.",
          "A partition in a group is read by <b>at most one</b> consumer. The parallelism ceiling = the number of partitions; the spare instances idle.",
          "An instance left or joined → a [[rebalance]]: the partitions move, the bookmarks stay — [[committed offset|committed offsets]] belong to the group, not to a process.",
          "An ordinary (eager) rebalance stops <b>the whole group</b>, not just the instance that died; the incremental strategy leaves alone the ones the change does not touch — chapter 13.",
          "Different groups are completely independent: their own bookmarks, their own pace, no influence on each other."
        ]
      )));
    }
  });
})();
