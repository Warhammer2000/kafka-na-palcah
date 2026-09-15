/* Глава 14 — Песочница: собери свой топик. Всё изученное в одном живом стенде. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "sandbox",
    num: 14,
    group: ["Прод", "Production"],
    nav: ["Песочница", "Sandbox"],
    title: ["Песочница: собери свой топик", "Sandbox: build your own topic"],
    lede: [
      "Партиции, ключи, группа, <code>lag</code> и <code>retention</code> — здесь всё крутится одновременно и по-настоящему. Вопрос один: <b>какой ручкой ты сломаешь этот топик первым</b>?",
      "Partitions, keys, a consumer group, <code>lag</code> and <code>retention</code> — here it all runs at once, and for real. Only one question: <b>which knob will you break this topic with first</b>?"
    ],

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(L(
        "<p>Стенд уже работает: три [[партиция|партиции]], продюсер пишет 4 сообщения в секунду, два консьюмера их разбирают. " +
        "Пока «пишут ≤ читают», система выглядит скучно — так и должен выглядеть здоровый прод.</p>" +
        "<p>Дальше твоя работа: крути ручки по одной и смотри не на красоту лент, а на три числа — суммарный [[lag]], " +
        "число простаивающих консьюмеров и счётчик съеденного по [[retention]]. Переключатель <b>ключ</b> — это стратегия продюсера: " +
        "пять разных <code>uid-…</code>, горячий ключ (80 % событий с одним <code>uid-999</code>) или вовсе без ключа ([[round-robin]]).</p>",

        "<p>The demo is already running: three [[partition|partitions]], the producer writes 4 messages per second, two consumers work through them. " +
        "While “writes ≤ reads”, the system looks boring — and that is exactly how healthy production should look.</p>" +
        "<p>From here it is your turn: turn one knob at a time and watch not the pretty strips but three numbers — total [[lag]], " +
        "the number of idle consumers, and the counter of what [[retention]] has eaten. The <b>key</b> switch is the producer’s strategy: " +
        "five different <code>uid-…</code>, a hot key (80 % of the events carrying one <code>uid-999</code>) or no key at all ([[round-robin]]).</p>"
      )));

      var tasks = L([
        "Оставь <b>одного</b> консьюмера на 6 партиций — смотри, как [[lag]] растёт ровно на разницу скоростей.",
        "Поставь консьюмеров <b>больше, чем партиций</b>, — найди тех, кому не досталось ни одной. Они не помогают, они просто стоят.",
        "Включи <b>горячий ключ</b> — найди по столбцу <code>lag</code> перекошенную партицию, пока соседние спят.",
        "<b>Убей консьюмера</b> в разгар потока — засеки простой на [[ребаланс]]е и на сколько за него вырос lag.",
        "Урежь <b>retention</b> до 5 секунд при медленной группе — лог начнёт съедать сообщения раньше, чем их прочитают."
      ], [
        "Leave <b>one</b> consumer on 6 partitions — watch [[lag]] grow by exactly the difference in speeds.",
        "Put <b>more consumers than partitions</b> — find the ones that got none at all. They do not help, they just stand there.",
        "Turn on the <b>hot key</b> — use the <code>lag</code> column to spot the skewed partition while its neighbours sleep.",
        "<b>Kill a consumer</b> mid-flow — time the pause the [[rebalance]] costs and how much lag grew during it.",
        "Cut <b>retention</b> to 5 seconds with a slow group — the log will start eating messages before anyone reads them."
      ]);
      var taskList = el("ol", { style: { margin: "0", "padding-left": "20px", "font-size": "15px", "line-height": "1.55" } });
      tasks.forEach(function (t, i) {
        taskList.appendChild(el("li", { html: KV.terms(t), style: { "margin-top": i ? "7px" : "0" } }));
      });
      root.appendChild(ui.panel(L("Попробуй сам", "Try it yourself"), taskList));

      /* ================= состояние модели ================= */

      var TICK = 250;          // один такт симуляции, мс
      var MAX_CELLS = 44;      // сколько клеток влезает в ленту (роль retention.bytes)
      var REBAL_TICKS = 8;     // сколько тактов группа не читает на ребалансе
      var WARM_TICKS = 16;     // прогрев: и при открытии, и после «Сброса» стенд уже живой
      /* Ключи подобраны так, чтобы hash % n раскладывал их насколько возможно
         ровно: при 2..5 партициях ни одна не остаётся пустой (3/2, 1/2/2,
         2/1/1/1, 1/1/1/1/1), а на шести пятью ключами шестую занять нечем —
         она честно стоит пустой, и это отдельный урок: параллелизм упирается
         не в число партиций, а в число РАЗНЫХ ключей.
         Ровность тут не косметика. При раскладке вида 2/2/1 консьюмеру C1
         (ему по RangeAssignor достаются p0+p1) шло бы 80 % потока — 3,2/с при
         мощности 3/с, — и «скучный здоровый прод» по умолчанию тихо копил бы
         lag и терял данные по retention. Сейчас на C1 идёт 60 % = 2,4/с.
         uid-999 (горячий) отличается от всех пяти цветом, поэтому перекос видно
         сразу; отдельная партиция достаётся ему только при шести — при меньшем
         числе он неизбежно делит ленту с кем-то из пяти. */
      var USERS = ["uid-143", "uid-278", "uid-399", "uid-435", "uid-813"];
      var HOT = "uid-999";
      var SEED = 20260914;

      var DEF = { parts: 3, rate: 4, strategy: "users", cons: 2, speed: 3, keep: 20 };
      var cfg = { parts: DEF.parts, rate: DEF.rate, strategy: DEF.strategy, cons: DEF.cons, speed: DEF.speed, keep: DEF.keep };
      var st = { run: true, ms: 0, total: 0, lost: 0, reb: 0, rebLeft: 0, acc: 0, rr: 0 };

      var rnd = util.rng(SEED);
      var plog = [];   // [{ s: logStrip, committed:number, subEl:Node }]
      var owner = [];  // партиция -> индекс консьюмера или -1
      var cAcc = [];   // накопленный «бюджет обработки» консьюмера
      var cCur = [];   // курсор round-robin по своим партициям
      var pend = [];   // копим удаления, чтобы писать в журнал раз в секунду, а не 4 раза
      var lastIdle = "";  // подпись последней записанной в журнал строки о простое

      function consColor(c) { return util.paletteColor(c); }

      function strategyName() {
        return cfg.strategy === "hot" ? L("горячий ключ (80 % один)", "hot key (80 % on one)")
          : cfg.strategy === "none" ? L("без ключа, round-robin", "no key, round-robin")
            : L("userId, 5 разных", "userId, 5 different keys");
      }

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Топик orders · consumer group orders-worker", "Topic orders · consumer group orders-worker"),
        hint: L("цвет клетки — ключ · цвет флажка и подписи — консьюмер",
          "cell colour is the key · flag and label colour is the consumer")
      });

      /* --- журнал --- */

      var term = ui.terminal("");
      term.el.style.maxHeight = "236px";
      term.el.style.overflowY = "auto";
      var jLines = [];

      function j(cls, head, text) {
        var t = (st.ms / 1000).toFixed(1);
        jLines.push('<span class="t-dim">' + t + L(" с", " s") + "</span>  " +
          (cls ? '<span class="' + cls + '">' + head + "</span>" : head) +
          (text ? "  " + text : ""));
        if (jLines.length > 60) jLines = jLines.slice(-60);
        term.clear();
        term.write(jLines.join("\n"));
      }

      /* --- плитки --- */

      var stTotal = ui.stat(L("записано всего", "written in total"), 0, { tone: "write" });
      var stLag = ui.stat(L("суммарный lag", "total lag"), 0);
      var stCons = ui.stat(L("работает / простаивает", "working / idle"), "0 / 0");
      var stReb = ui.stat(L("ребалансов", "rebalances"), 0);
      var stLost = ui.stat(L("съедено непрочитанным", "eaten unread"), 0);
      var statsRow = ui.stats(stTotal.el, stLag.el, stCons.el, stReb.el, stLost.el);

      /* --- узлы --- */

      var producer = ui.node("producer", L("продюсер", "producer"), L("4 сообщ/с", "4 msg/s"));
      var prodMeta = producer.querySelector(".kv-node__meta");
      var topicBadge = ui.badge(L("топик orders · 3 партиции", "topic orders · 3 partitions"), "write");
      var topRow = el("div.kv-row", { style: { "margin": "14px 0 10px" } },
        producer,
        el("span", { style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" }, text: "→" }),
        topicBadge);

      var consRow = el("div.kv-row", { style: { "margin-bottom": "14px" } });

      /* --- ленты партиций --- */

      var logBox = ui.log();

      /* --- таблица --- */

      var tableBox = el("div");

      function drawTable() {
        var rows = plog.map(function (p, i) {
          var leo = p.s.leo(), lag = leo - p.committed, o = owner[i];
          var tone = lag === 0 ? null : lag < 12 ? "warn" : "bad";
          var lagCell = el("div", null,
            el("div", {
              style: { "font-family": "var(--f-mono)", "font-weight": "600", color: lag === 0 ? "var(--good)" : lag < 12 ? "var(--warn)" : "var(--bad)" },
              text: String(lag)
            }),
            el("div", { style: { width: "76px", "margin-top": "4px" } }, ui.bar(lag / 40, tone).el));
          return [
            "p" + i,
            '<span style="font-family:var(--f-mono)">' + leo + "</span>" +
            ' <span style="color:var(--faint);font-size:12px">' +
            (p.s.records.length ? L("хранится с ", "kept from ") + p.s.base : L("лог пуст", "the log is empty")) + "</span>",
            '<span style="font-family:var(--f-mono)">' + p.committed + "</span>",
            lagCell,
            o >= 0
              ? '<span style="color:' + consColor(o) + ';font-weight:600">C' + (o + 1) + "</span>"
              : '<span style="color:var(--faint)">' + L("никто", "nobody") + "</span>"
          ];
        });
        KV.clear(tableBox);
        tableBox.appendChild(ui.table(L(["партиция", "LEO", "committed", "lag", "читает"],
          ["partition", "LEO", "committed", "lag", "read by"]), rows));
      }

      /* ================= механика ================= */

      function buildTopic() {
        KV.clear(logBox);
        plog = []; pend = [];
        for (var i = 0; i < cfg.parts; i++) {
          var s = ui.logStrip({ label: L("партиция ", "partition ") + i, sub: "—", empty: L("пусто", "empty") });
          logBox.appendChild(s.el);
          plog.push({ s: s, committed: 0, subEl: s.el.querySelector(".kv-part__label span") });
          pend.push({ time: 0, cap: 0, lost: 0 });
        }
        assign();
      }

      /** Раздача партиций по членам группы: непрерывными кусками, как RangeAssignor. */
      function assign() {
        owner = [];
        for (var i = 0; i < cfg.parts; i++) owner.push(-1);
        if (cfg.cons > 0) {
          var per = Math.floor(cfg.parts / cfg.cons), rem = cfg.parts % cfg.cons, p = 0;
          for (var c = 0; c < cfg.cons && p < cfg.parts; c++) {
            var take = per + (c < rem ? 1 : 0);
            for (var k = 0; k < take; k++) owner[p++] = c;
          }
        }
        cAcc = []; cCur = [];
        for (var q = 0; q < cfg.cons; q++) { cAcc.push(0); cCur.push(0); }
        paintLabels();
        renderConsumers();

        var idle = [];
        for (var z = 0; z < cfg.cons; z++) if (owner.indexOf(z) < 0) idle.push("C" + (z + 1));
        /* при смене числа партиций assign() зовётся дважды подряд (пересборка топика
           и следом ребаланс) — один и тот же простой в журнал не дублируем */
        var sig = idle.join(" ") + "/" + cfg.cons + "/" + cfg.parts;
        if (idle.length && sig !== lastIdle) {
          j("t-dim", L("простой", "idle"), idle.join(" ") +
            L(" без партиций: консьюмеров ", " got no partitions: consumers ") + cfg.cons +
            L(", партиций ", ", partitions ") + cfg.parts +
            L(" — партицию в группе читает максимум один", " — a partition is read by at most one member of the group"));
        }
        lastIdle = sig;
      }

      function paintLabels() {
        plog.forEach(function (p, i) {
          if (!p.subEl) return;
          var o = owner[i];
          p.subEl.textContent = o >= 0 ? L("читает C", "read by C") + (o + 1) : L("читателя нет", "no reader");
          p.subEl.style.color = o >= 0 ? consColor(o) : "var(--faint)";
        });
      }

      function paintMarkers() {
        plog.forEach(function (p, i) {
          var o = owner[i];
          p.s.marker("commit", {
            at: p.committed,
            label: (o >= 0 ? "C" + (o + 1) + " · " : "") + p.committed,
            color: o >= 0 ? consColor(o) : "var(--muted)"
          });
        });
      }

      function renderConsumers() {
        KV.clear(consRow);
        consRow.appendChild(el("span.kv-ctl__label", { text: L("группа orders-worker", "group orders-worker") }));
        if (!cfg.cons) {
          consRow.appendChild(el("span", {
            style: { "font-size": "13px", color: "var(--faint)" },
            text: L("в группе никого — топик пишется, но не читается",
              "nobody in the group — the topic is written to, but nobody reads it")
          }));
          return;
        }
        var load = [];
        for (var c = 0; c < cfg.cons; c++) load.push([]);
        owner.forEach(function (o, i) { if (o >= 0 && o < cfg.cons) load[o].push("p" + i); });
        load.forEach(function (list, ci) {
          var idle = !list.length;
          var color = idle ? "var(--warn)" : consColor(ci);
          var n = ui.node("consumer", "C" + (ci + 1), idle ? L("простаивает", "idle") : list.join(" "));
          n.style.borderLeftColor = color;
          var dot = n.querySelector(".kv-node__dot");
          if (dot) dot.style.background = color;
          var meta = n.querySelector(".kv-node__meta");
          if (meta) meta.style.color = idle ? "var(--warn)" : "var(--faint)";
          consRow.appendChild(n);
        });
      }

      /** Разных ключей может быть меньше, чем партиций: тогда часть лент
       *  останется пустой навсегда, и это не перекос, а арифметика. */
      function noteKeyShortage() {
        if (cfg.strategy !== "users" || cfg.parts <= USERS.length) return;
        j("t-dim", L("ключей меньше, чем партиций", "fewer keys than partitions"),
          L("разных ключей ", "different keys ") + USERS.length + L(", партиций ", ", partitions ") + cfg.parts +
          L(" — минимум одна лента останется пустой: параллелизм упирается не в партиции, а в число разных ключей",
            " — at least one strip will stay empty for good: parallelism is capped not by partitions but by the number of different keys"));
      }

      function nextKey() {
        if (cfg.strategy === "none") return null;
        if (cfg.strategy === "hot") return rnd() < 0.8 ? HOT : util.pick(USERS, rnd);
        return util.pick(USERS, rnd);
      }

      function produceOne() {
        var key = nextKey();
        var pi = key === null ? (st.rr++ % cfg.parts) : util.partitionFor(key, cfg.parts);
        var p = plog[pi];
        /* label задаём явно: у всех ключей общий префикс, и автоподпись из трёх
           первых символов сделала бы все клетки одинаковыми «uid». */
        p.s.push(key === null
          ? { key: null, label: "•", color: "var(--muted)", t: st.ms }
          : { key: key, label: key.slice(4), t: st.ms });
        st.total += 1;
        return { p: pi, key: key };
      }

      function consume() {
        if (!cfg.cons || !cfg.speed) return;
        var mine = [];
        for (var c = 0; c < cfg.cons; c++) mine.push([]);
        owner.forEach(function (o, i) { if (o >= 0 && o < cfg.cons) mine[o].push(i); });

        var reads = {};
        for (var ci = 0; ci < cfg.cons; ci++) {
          if (!mine[ci].length) { cAcc[ci] = 0; continue; }
          cAcc[ci] += cfg.speed * TICK / 1000;
          var guard = 0;
          while (cAcc[ci] >= 1 && guard++ < 40) {
            var got = false;
            for (var k = 0; k < mine[ci].length; k++) {
              var idx = mine[ci][(cCur[ci] + k) % mine[ci].length];
              var p = plog[idx];
              if (p.committed < p.s.leo()) {
                reads[idx] = p.committed;
                p.committed += 1;
                cCur[ci] = (cCur[ci] + k + 1) % mine[ci].length;
                cAcc[ci] -= 1;
                got = true;
                break;
              }
            }
            /* читать нечего — не копим бесконечный кредит на будущее */
            if (!got) { cAcc[ci] = Math.min(cAcc[ci], 1); break; }
          }
        }
        Object.keys(reads).forEach(function (idx) {
          plog[idx].s.highlight(reads[idx], "is-reading", 220);
        });
      }

      /** Retention: удаляем всё старше cfg.keep и всё, что не влезает в ленту. */
      function retain() {
        var cut = st.ms - cfg.keep * 1000;
        plog.forEach(function (p, i) {
          var recs = p.s.records;
          var byTime = 0;
          while (byTime < recs.length && recs[byTime].t <= cut) byTime++;
          var over = recs.length - MAX_CELLS;
          var count = Math.max(byTime, over > 0 ? over : 0);
          if (count <= 0) return;

          var base = p.s.base;
          for (var k = 0; k < count; k++) recs.shift();
          p.s.setBase(base + count);

          var unread = 0;
          if (p.committed < base + count) {
            unread = base + count - p.committed;
            p.committed = base + count;
            st.lost += unread;
          }
          /* в журнал пишем не каждый такт, а раз в секунду — иначе на скорости 12/с он превращается в кашу */
          pend[i].time += byTime;
          pend[i].cap += count - byTime;
          pend[i].lost += unread;
        });
      }

      function flushJournal() {
        pend.forEach(function (q, i) {
          if (q.time) {
            j("t-dim", "retention", "p" + i + ": " +
              util.plural(q.time, L("удалена", "deleted"), L("удалено", "deleted"), L("удалено", "deleted")) + " " + q.time + " " +
              util.plural(q.time, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
              L(" старше ", " older than ") + cfg.keep + L(" с", " s"));
          }
          if (q.cap) {
            j("t-dim", L("лента полна", "the strip is full"), "p" + i + ": " +
              util.plural(q.cap, L("убрана", "dropped"), L("убрано", "dropped"), L("убрано", "dropped")) + " " + q.cap + " " +
              util.plural(q.cap, L("клетка", "cell"), L("клетки", "cells"), L("клеток", "cells")) +
              L(" из начала — в ленте максимум ", " from the front — the strip holds at most ") + MAX_CELLS);
          }
          if (q.lost) {
            j("t-bad", L("ПОТЕРЯ", "DATA LOSS"), "p" + i + ": " + q.lost + " " +
              util.plural(q.lost,
                L("запись съедена", "record was eaten by"),
                L("записи съедены", "records were eaten by"),
                L("записей съедено", "records were eaten by")) +
              L(" retention ДО того, как группа ", " retention BEFORE the group read ") +
              util.plural(q.lost, L("её", "it"), L("их", "them"), L("их", "them")) + L(" прочитала", ""));
          }
          q.time = 0; q.cap = 0; q.lost = 0;
        });
      }

      function rebalance(why) {
        st.reb += 1;
        st.rebLeft = REBAL_TICKS;
        assign();
        j("t-bad", L("РЕБАЛАНС", "REBALANCE"), why + L(" → чтение всей группы стоит ", " → the whole group stops reading for ") +
          (REBAL_TICKS * TICK / 1000).toFixed(1) + L(" с, партиции раздаются заново", " s, the partitions are handed out again"));
      }

      /** Какая доля потока приходится на каждую партицию.
       *  Считается из самой стратегии ключа, а не замером по окну: у стенда
       *  все вероятности известны точно, и вердикт не должен дрожать из-за
       *  случайности выборки. «5 ключей» — по 1/5 на ключ, «горячий» — 0,8 на
       *  uid-999 и 0,2 на пятерых, «без ключа» — поровну по кругу. */
      function shareByPartition() {
        var sh = [], i;
        for (i = 0; i < cfg.parts; i++) sh.push(0);
        if (cfg.strategy === "none") {
          for (i = 0; i < cfg.parts; i++) sh[i] = 1 / cfg.parts;
          return sh;
        }
        var hotShare = cfg.strategy === "hot" ? 0.8 : 0;
        var each = (1 - hotShare) / USERS.length;
        USERS.forEach(function (k) { sh[util.partitionFor(k, cfg.parts)] += each; });
        if (hotShare) sh[util.partitionFor(HOT, cfg.parts)] += hotShare;
        return sh;
      }

      /** Сколько сообщений в секунду РЕАЛЬНО приходится на каждого консьюмера.
       *  Сумма скоростей группы — это только потолок: партицию читает максимум
       *  один, и перекошенный ключ упирает одного консьюмера в его собственную
       *  скорость, сколько бы запаса ни было «в сумме». */
      function loadPerConsumer() {
        var per = [];
        for (var c = 0; c < cfg.cons; c++) per.push(0);
        var sh = shareByPartition();
        owner.forEach(function (o, i) {
          if (o >= 0 && o < cfg.cons) per[o] += sh[i] * cfg.rate;
        });
        return per;
      }

      /* Дробный разделитель — часть языка, а не числа: в русском запятая, в английском точка. */
      function dec(x) { return (Math.round(x * 10) / 10).toString().replace(".", L(",", ".")); }

      function render() {
        var lag = 0, hot = -1, hotLag = -1;
        plog.forEach(function (p, i) {
          var l = p.s.leo() - p.committed;
          lag += l;
          if (l > hotLag) { hotLag = l; hot = i; }
        });

        var counts = [], work = 0, idle = 0;
        for (var c = 0; c < cfg.cons; c++) counts.push(0);
        owner.forEach(function (o) { if (o >= 0 && o < cfg.cons) counts[o] += 1; });
        counts.forEach(function (n) { if (n > 0) work += 1; else idle += 1; });

        stTotal.set(util.num(st.total));
        stLag.set(util.num(lag), lag === 0 ? "good" : lag < 12 ? "warn" : "bad");
        stCons.set(st.rebLeft > 0 ? L("РЕБАЛАНС", "REBALANCE") : work + " / " + idle,
          st.rebLeft > 0 || work === 0 ? "bad" : idle > 0 ? "warn" : "read");
        stReb.set(util.num(st.reb));
        stLost.set(util.num(st.lost), st.lost > 0 ? "bad" : "good");

        prodMeta.textContent = cfg.rate + L(" сообщ/с · ", " msg/s · ") + strategyName();
        topicBadge.textContent = L("топик orders · ", "topic orders · ") + cfg.parts + " " +
          util.plural(cfg.parts, L("партиция", "partition"), L("партиции", "partitions"), L("партиций", "partitions"));
        consRow.style.opacity = st.rebLeft > 0 ? ".45" : "1";

        paintMarkers();
        drawTable();

        var cap = work * cfg.speed;
        /* Потолок группы достижим только при ровной раскладке. Ищем консьюмера,
           которому несут больше, чем он тянет: сумма скоростей ничего не решает,
           потому что его партиции не с кем разделить. */
        var load = loadPerConsumer();
        var worst = -1, over = 0;
        load.forEach(function (d, c) {
          if (d - cfg.speed > over) { over = d - cfg.speed; worst = c; }
        });

        var verdict;
        if (st.rebLeft > 0) verdict = L("<b>РЕБАЛАНС</b> — группа не читает вообще, lag растёт на полной скорости продюсера",
          "<b>REBALANCE</b> — the group is not reading at all, lag grows at the producer’s full speed");
        else if (cfg.cons === 0) verdict = L("<b>в группе никого</b> — читать некому, весь поток уходит в lag",
          "<b>nobody in the group</b> — there is no one to read, the whole stream turns into lag");
        else if (cap === 0) verdict = L("<b>обработка 0/с</b> — консьюмеры держат партиции, но не разбирают ничего",
          "<b>processing 0/s</b> — the consumers hold their partitions but work through nothing");
        else if (cap < cfg.rate) verdict = L("дефицит <b>−", "shortfall <b>−") + (cfg.rate - cap) +
          L("/с</b> — примерно на столько lag растёт каждую секунду", "/s</b> — roughly how much lag grows every second");
        else if (worst >= 0 && over > 0.01) {
          verdict = L("в сумме запас есть, но на <b>C", "in total there is headroom, but <b>C") + (worst + 1) +
            L("</b> одного идёт <b>", "</b> alone is handed <b>") + dec(load[worst]) +
            L("/с</b> при его <b>", "/s</b> against its own <b>") + cfg.speed +
            L("/с</b>: его партиции не разделить ни с кем — ", "/s</b>: its partitions cannot be shared with anyone — ") +
            L("<b>потолок группы недостижим</b>, лишнее копится в них, пока у соседей простаивает запас",
              "<b>the group ceiling is out of reach</b>, the surplus piles up there while the neighbours’ headroom sits unused");
        } else if (lag === 0) verdict = L("запас <b>+", "headroom <b>+") + (cap - cfg.rate) +
          L("/с</b>, lag держится у нуля", "/s</b>, lag stays at zero");
        else if (cap === cfg.rate) verdict = L("запас <b>+0/с</b> — каждому несут ровно столько, сколько он тянет: ",
          "headroom <b>+0/s</b> — each one is handed exactly as much as it can take: ") +
          L("накопленные <b>", "the <b>") + lag +
          L("</b> так и останутся висеть, разбирать их нечем", "</b> already piled up will just hang there; there is nothing spare to work through them");
        else verdict = L("запас <b>+", "headroom <b>+") + (cap - cfg.rate) +
          L("/с</b> — lag рассасывается", "/s</b> — lag is draining");

        var extra = idle > 0
          ? L(" · простаивает <b>", " · <b>") + idle + "</b> " +
          util.plural(idle, L("консьюмер", "consumer idle"), L("консьюмера", "consumers idle"), L("консьюмеров", "consumers idle")) +
          L(": партиций ", ": partitions ") + cfg.parts + L(", консьюмеров ", ", consumers ") + cfg.cons
          : "";
        var skew = (cfg.parts > 1 && lag >= 8 && hotLag > lag * 0.6)
          ? L(" · перекос: <b>p", " · skew: <b>p") + hot + L("</b> держит ", "</b> holds ") +
          Math.round(hotLag / lag * 100) + L(" % всего lag", " % of all the lag")
          : "";

        stage.say(L("продюсер <b>", "producer <b>") + cfg.rate +
          L("/с</b> · потолок группы <b>", "/s</b> · group ceiling <b>") + work + " × " + cfg.speed +
          " = " + cap + L("/с</b> → ", "/s</b> → ") + verdict + extra + skew);
      }

      function tick() {
        st.ms += TICK;

        var writes = [];
        if (cfg.rate > 0) {
          st.acc += cfg.rate * TICK / 1000;
          var guard = 0;
          while (st.acc >= 1 && guard++ < 8) { st.acc -= 1; writes.push(produceOne()); }
        } else {
          st.acc = 0;
        }
        if (writes.length) {
          var by = {};
          writes.forEach(function (w) { by[w.p] = (by[w.p] || 0) + 1; });
          j("t-w", L("запись", "write"), "×" + writes.length + "   " + Object.keys(by).sort().map(function (p) {
            return "p" + p + "×" + by[p];
          }).join("  ") + "   " + util.escape(writes[writes.length - 1].key || L("без ключа", "no key")));
        }

        if (st.rebLeft > 0) {
          st.rebLeft -= 1;
          if (st.rebLeft === 0) j("t-good", L("ребаланс", "rebalance"),
            L("завершён — группа снова читает с committed", "done — the group reads from committed again"));
        } else {
          consume();
        }

        retain();
        if (st.ms % 1000 === 0) flushJournal();
        render();
      }

      /** Прокрутить несколько тактов вхолостую: стенд не должен быть пустым
       *  ни при открытии главы, ни сразу после «Сброса». */
      function warmUp() {
        for (var i = 0; i < WARM_TICKS; i++) tick();
        render();
      }

      /* ================= контролы ================= */

      var pRange = ui.range({
        label: L("партиций", "partitions"), min: 1, max: 6, value: cfg.parts,
        onInput: function (v) {
          cfg.parts = v;
          buildTopic();
          j("t-dim", L("топик пересобран", "topic rebuilt"),
            v + " " + util.plural(v, L("партиция", "partition"), L("партиции", "partitions"), L("партиций", "partitions")) +
            L(": ключи раскладываются заново, лог начат с нуля", ": the keys are spread again, the log starts from zero"));
          noteKeyShortage();
          rebalance(L("изменилось число партиций", "the number of partitions changed"));
          render();
        }
      });

      var rateRange = ui.range({
        label: L("продюсер", "producer"), min: 0, max: 12, value: cfg.rate, unit: L("/с", "/s"),
        onInput: function (v) { cfg.rate = v; j("t-w", L("продюсер", "producer"), v + L(" сообщ/с", " msg/s")); render(); }
      });

      var keySeg = ui.seg([
        { value: "users", label: L("5 ключей", "5 keys") },
        { value: "hot", label: L("горячий", "hot") },
        { value: "none", label: L("без ключа", "no key") }
      ], cfg.strategy, function (v) {
        cfg.strategy = v;
        j("t-w", L("стратегия ключа", "key strategy"), strategyName());
        noteKeyShortage();
        render();
      });

      var consRange = ui.range({
        label: L("консьюмеров", "consumers"), min: 0, max: 6, value: cfg.cons,
        onInput: function (v) {
          cfg.cons = v;
          rebalance(L("в группе теперь ", "the group now has ") + v + " " +
            util.plural(v, L("консьюмер", "consumer"), L("консьюмера", "consumers"), L("консьюмеров", "consumers")));
          render();
        }
      });

      var speedRange = ui.range({
        label: L("обработка", "processing"), min: 0, max: 8, value: cfg.speed, unit: L("/с", "/s"),
        onInput: function (v) { cfg.speed = v; j("t-r", L("обработка", "processing"), v + L(" сообщ/с на консьюмера", " msg/s per consumer")); render(); }
      });

      var keepRange = ui.range({
        label: L("хранить", "keep for"), min: 5, max: 60, value: cfg.keep, unit: L("с", "s"),
        onInput: function (v) { cfg.keep = v; j("t-dim", "retention", L("хранить ", "keep for ") + v + L(" с", " s")); render(); }
      });

      var pauseBtn = ui.btn(L("Пауза", "Pause"), function () {
        st.run = !st.run;
        pauseBtn.textContent = st.run ? L("Пауза", "Pause") : L("Пуск", "Run");
        j("t-dim", st.run ? L("пуск", "run") : L("пауза", "pause"),
          st.run ? L("время идёт", "time is running")
            : L("время стоит, ручки и «шаг» работают", "time is stopped; the knobs and “step” still work"));
        render();
      }, { sm: true });

      var stepBtn = ui.btn(L("Шаг", "Step"), function () { tick(); },
        { sm: true, variant: "ghost", title: L("один такт 250 мс", "one tick, 250 ms") });

      var killBtn = ui.btn(L("Убить консьюмера", "Kill a consumer"), function () {
        if (cfg.cons <= 0) { j("t-dim", L("некого убивать", "nobody to kill"), L("в группе и так пусто", "the group is empty already")); return; }
        var dead = cfg.cons;
        cfg.cons -= 1;
        consRange.set(cfg.cons);
        rebalance(L("консьюмер C", "consumer C") + dead + L(" отвалился", " dropped out"));
        render();
      }, { sm: true, variant: "danger" });

      var resetBtn = ui.btn(L("Сброс", "Reset"), function () { reset(); }, { sm: true, variant: "ghost" });

      function reset() {
        cfg.parts = DEF.parts; cfg.rate = DEF.rate; cfg.strategy = DEF.strategy;
        cfg.cons = DEF.cons; cfg.speed = DEF.speed; cfg.keep = DEF.keep;
        pRange.set(cfg.parts); rateRange.set(cfg.rate); keySeg.set(cfg.strategy);
        consRange.set(cfg.cons); speedRange.set(cfg.speed); keepRange.set(cfg.keep);
        st = { run: true, ms: 0, total: 0, lost: 0, reb: 0, rebLeft: 0, acc: 0, rr: 0 };
        rnd = util.rng(SEED);
        jLines = [];
        lastIdle = "";
        term.clear();
        pauseBtn.textContent = L("Пауза", "Pause");
        buildTopic();
        j("t-dim", L("сброс", "reset"), L("3 партиции · продюсер 4/с · 2 консьюмера по 3/с · retention 20 с",
          "3 partitions · producer 4/s · 2 consumers at 3/s each · retention 20 s"));
        warmUp();
      }

      KV.append(stage.controls,
        pRange.el, rateRange.el, ui.ctl(L("ключ", "key"), keySeg.el),
        consRange.el, speedRange.el, keepRange.el,
        el("div.kv-row", null, pauseBtn, stepBtn, killBtn, resetBtn));

      /* ================= сборка стенда ================= */

      KV.append(stage.body,
        statsRow,
        topRow,
        consRow,
        logBox,
        el("div", { style: { "margin": "12px 0 16px" } },
          ui.legend([
            { color: "var(--write)", label: L("LEO — конец лога, куда пишет продюсер", "LEO — the end of the log, where the producer writes") },
            { color: "var(--read)", label: L("флажок committed — докуда дочитала группа", "the committed flag — how far the group has read") },
            { color: "var(--muted)", label: L("«•» — запись без ключа", "“•” — a record with no key") }
          ])),
        el("div.kv-col", null,
          ui.panel(L("Состояние партиций", "Partition state"), tableBox),
          ui.panel(L("Журнал событий", "Event log"), term.el)));

      root.appendChild(stage.el);

      /* ================= запуск ================= */

      buildTopic();
      j("t-dim", L("старт", "start"), L("3 партиции · продюсер 4/с · 2 консьюмера по 3/с · retention 20 с",
        "3 partitions · producer 4/s · 2 consumers at 3/s each · retention 20 s"));
      warmUp();   // стенд открывается уже живым

      api.interval(TICK, function () { if (st.run) tick(); });

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
        "<h3>Что именно ты крутишь</h3>" +
        "<ul>" +
        "<li><strong>Потолок группы = число НЕ простаивающих консьюмеров × скорость каждого.</strong> " +
        "Седьмой консьюмер на шести партициях прибавляет ровно ноль: [[партиция|партицию]] в группе читает максимум один. " +
        "И это именно <em>потолок</em>, а не обещание: поток делится между консьюмерами так, как ключи легли по партициям. " +
        "Включи горячий ключ — и тот, кому досталась горячая партиция, упрётся в СВОЮ скорость, хотя у группы «в сумме» " +
        "ещё запас. Разделить эту партицию не с кем, поэтому сумма скоростей тут ничего не спасает.</li>" +
        "<li><strong>[[lag]] — это интеграл разницы.</strong> Дефицит 3 сообщения в секунду даёт +180 к lag за минуту и не рассосётся сам: " +
        "всплеск выгребается, постоянный дефицит — нет.</li>" +
        "<li><strong>[[ребаланс]] — стоп-кадр для всей группы.</strong> Так ведёт себя классическая (eager) стратегия, её и показывает песочница: пока партиции раздаются заново, не читает никто, " +
        "включая тех, у кого ничего не менялось. Продюсер при этом не останавливается.</li>" +
        "<li><strong>[[hot key]] виден не в сумме, а в строке.</strong> Суммарный lag может быть скромным, " +
        "а одна партиция при этом держит почти весь его — сравнивай партиции между собой, а не с нулём.</li>" +
        "</ul>" +
        "<p>Что здесь условно: [[ребаланс]] всегда длится ровно 2 секунды, и новая раздача видна сразу в его начале " +
        "(в Kafka назначение приезжает в конце); «убить консьюмера» уносит последнего по номеру; лента хранит максимум " +
        "44 клетки — в настоящей Kafka такой предел задаёт <code>retention.bytes</code>. Режим «без ключа» стенд " +
        "раскладывает строго по кругу, по одной записи на партицию; настоящий продюсер с Kafka 2.4 делает это «липко» — " +
        "набивает партицию целой пачкой и лишь потом берёт следующую, так что ровно выходит по пачкам, а не по сообщениям " +
        "(и решает это, кстати, сам продюсер, а не брокер). И главное: ползунок «партиций» " +
        "здесь пересобирает топик с нуля, чтобы новая раскладка по ключам была видна сразу. " +
        "В жизни партиции можно только <b>добавлять</b> (уменьшать — нельзя), данные при этом не удаляются и " +
        "[[offset|offset'ы]] не сбрасываются, но старые ключи с этого момента считаются по новому модулю и " +
        "разъезжаются по другим партициям — порядок по ключу на стыке ломается. " +
        "Остальное — скорости, [[lag]], [[committed offset|committed]], [[retention]] — считается честно.</p>",

        "<h3>What exactly you are turning</h3>" +
        "<ul>" +
        "<li><strong>The group ceiling = the number of NON-idle consumers × the speed of each.</strong> " +
        "A seventh consumer on six partitions adds exactly zero: a [[partition]] is read by at most one member of the group. " +
        "And it really is a <em>ceiling</em>, not a promise: the stream is split between the consumers the way the keys fell across the partitions. " +
        "Turn the hot key on and whoever got the hot partition hits THEIR OWN speed limit, even though the group still has headroom " +
        "“in total”. There is no one to share that partition with, so the sum of the speeds saves nothing here.</li>" +
        "<li><strong>[[lag]] is the integral of the difference.</strong> A shortfall of 3 messages per second adds +180 to lag over a minute and will not drain on its own: " +
        "a spike gets worked off, a permanent shortfall does not.</li>" +
        "<li><strong>A [[rebalance]] is a freeze-frame for the whole group.</strong> That is how the classic (eager) strategy behaves, and it is the one the sandbox shows: while the partitions are handed out again, nobody reads, " +
        "including those whose assignment did not change at all. The producer, meanwhile, does not stop.</li>" +
        "<li><strong>A [[hot key]] shows up in a row, not in the total.</strong> Total lag can look modest " +
        "while one partition holds almost all of it — compare the partitions with each other, not with zero.</li>" +
        "</ul>" +
        "<p>What is simplified here: a [[rebalance]] always lasts exactly 2 seconds, and the new assignment is visible right at its start " +
        "(in Kafka it arrives at the end); “kill a consumer” always takes the highest-numbered one; a strip holds at most " +
        "44 cells — in real Kafka that limit is set by <code>retention.bytes</code>. In “no key” mode the demo spreads records " +
        "strictly around the ring, one record per partition; a real producer since Kafka 2.4 does it “stickily” — " +
        "it fills one partition with a whole batch and only then takes the next, so it evens out across batches, not across messages " +
        "(and it is the producer that decides this, by the way, not the broker). And the big one: the “partitions” slider " +
        "here rebuilds the topic from scratch, so that the new key layout is visible right away. " +
        "In real life partitions can only be <b>added</b> (never removed), no data is deleted in the process and " +
        "[[offset|offsets]] are not reset, but from that moment old keys are hashed modulo the new number and " +
        "scatter into other partitions — order by key breaks at the seam. " +
        "Everything else — the speeds, [[lag]], [[committed offset|committed]], [[retention]] — is computed honestly.</p>"
      )));

      root.appendChild(ui.note("bad", L("ловушка", "trap"), L(
        "<p>Следи за плиткой «съедено непрочитанным». Когда [[retention]] начинает удалять записи, до которых группа не дошла, " +
        "<b>lag падает сам собой</b> — на дашборде это выглядит как «догнали». На самом деле это потеря данных: " +
        "единственная метрика, которая её покажет, — счётчик пропущенных, а не lag.</p>" +
        "<p>Механика внутри: [[committed offset|committed]] группы оказывается левее начала лога, консьюмер получает " +
        "<code>OffsetOutOfRange</code> и по <code>auto.offset.reset</code> прыгает вперёд — на первое уцелевшее сообщение " +
        "(<code>earliest</code>, так считает стенд) или сразу в конец лога (<code>latest</code>, значение по умолчанию). " +
        "Пропуск — ровно этот прыжок, и никакого следа в lag он не оставляет.</p>",

        "<p>Keep an eye on the “eaten unread” tile. When [[retention]] starts deleting records the group never reached, " +
        "<b>lag drops all by itself</b> — on a dashboard that looks like “we caught up”. It is data loss: " +
        "the only metric that will show it is the counter of skipped records, not lag.</p>" +
        "<p>The mechanics behind it: the group’s [[committed offset|committed]] ends up to the left of the start of the log, the consumer gets " +
        "<code>OffsetOutOfRange</code> and, following <code>auto.offset.reset</code>, jumps forward — to the first surviving message " +
        "(<code>earliest</code>, which is what this demo does) or straight to the end of the log (<code>latest</code>, the default). " +
        "The skip is exactly that jump, and it leaves no trace at all in lag.</p>"
      )));

      root.appendChild(ui.takeaway(L([
        "Потолок группы = <b>консьюмеры, которым достались партиции</b> × скорость каждого. Лишние сверх числа партиций просто стоят. Но это потолок, а не пропускная способность: перекошенный ключ упирает одного консьюмера в его собственную скорость, и группа не догоняет при любой сумме.",
        "[[lag]] растёт ровно на разницу «пишут минус читают». Устойчивый рост — это дефицит мощности, а не всплеск.",
        "[[ребаланс]] останавливает чтение у <b>всей</b> группы, а запись — нет. Каждый рестарт консьюмера оплачивается ростом lag.",
        "[[hot key]] перекашивает одну партицию: смотри распределение lag по партициям, а не только сумму.",
        "[[retention]] не спрашивает, прочитали ли. Не успел — данные ушли, и <b>lag при этом уменьшится</b>."
      ], [
        "The group ceiling = <b>the consumers that actually got partitions</b> × the speed of each. The extras beyond the number of partitions just stand there. But it is a ceiling, not throughput: a skewed key pins one consumer to its own speed, and the group never catches up no matter what the sum says.",
        "[[lag]] grows by exactly the difference “writes minus reads”. Steady growth is a capacity shortfall, not a spike.",
        "A [[rebalance]] stops reading for the <b>whole</b> group; writing carries on. Every consumer restart is paid for in lag.",
        "A [[hot key]] skews one partition: look at how lag is spread across the partitions, not only at the total.",
        "[[retention]] does not ask whether anyone has read. Miss it and the data is gone — and <b>lag goes down</b> as it happens."
      ])));
    }
  });
})();
