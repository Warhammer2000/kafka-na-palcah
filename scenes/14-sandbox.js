/* Глава 14 — Песочница: собери свой топик. Всё изученное в одном живом стенде. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "sandbox",
    num: 14,
    group: "Прод",
    nav: "Песочница",
    title: "Песочница: собери свой топик",
    lede: "Партиции, ключи, группа, <code>lag</code> и <code>retention</code> — здесь всё крутится одновременно и по-настоящему. Вопрос один: <b>какой ручкой ты сломаешь этот топик первым</b>?",

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(
        "<p>Стенд уже работает: три [[партиция|партиции]], продюсер пишет 4 сообщения в секунду, два консьюмера их разбирают. " +
        "Пока «пишут ≤ читают», система выглядит скучно — так и должен выглядеть здоровый прод.</p>" +
        "<p>Дальше твоя работа: крути ручки по одной и смотри не на красоту лент, а на три числа — суммарный [[lag]], " +
        "число простаивающих консьюмеров и счётчик съеденного по [[retention]]. Переключатель <b>ключ</b> — это стратегия продюсера: " +
        "пять разных <code>uid-…</code>, горячий ключ (80 % событий с одним <code>uid-999</code>) или вовсе без ключа ([[round-robin]]).</p>"
      ));

      var tasks = [
        "Оставь <b>одного</b> консьюмера на 6 партиций — смотри, как [[lag]] растёт ровно на разницу скоростей.",
        "Поставь консьюмеров <b>больше, чем партиций</b>, — найди тех, кому не досталось ни одной. Они не помогают, они просто стоят.",
        "Включи <b>горячий ключ</b> — найди по столбцу <code>lag</code> перекошенную партицию, пока соседние спят.",
        "<b>Убей консьюмера</b> в разгар потока — засеки простой на [[ребаланс]]е и на сколько за него вырос lag.",
        "Урежь <b>retention</b> до 5 секунд при медленной группе — лог начнёт съедать сообщения раньше, чем их прочитают."
      ];
      var taskList = el("ol", { style: { margin: "0", "padding-left": "20px", "font-size": "15px", "line-height": "1.55" } });
      tasks.forEach(function (t, i) {
        taskList.appendChild(el("li", { html: KV.terms(t), style: { "margin-top": i ? "7px" : "0" } }));
      });
      root.appendChild(ui.panel("Попробуй сам", taskList));

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
        return cfg.strategy === "hot" ? "горячий ключ (80 % один)"
          : cfg.strategy === "none" ? "без ключа, round-robin"
            : "userId, 5 разных";
      }

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Топик orders · consumer group orders-worker",
        hint: "цвет клетки — ключ · цвет флажка и подписи — консьюмер"
      });

      /* --- журнал --- */

      var term = ui.terminal("");
      term.el.style.maxHeight = "236px";
      term.el.style.overflowY = "auto";
      var jLines = [];

      function j(cls, head, text) {
        var t = (st.ms / 1000).toFixed(1);
        jLines.push('<span class="t-dim">' + t + " с</span>  " +
          (cls ? '<span class="' + cls + '">' + head + "</span>" : head) +
          (text ? "  " + text : ""));
        if (jLines.length > 60) jLines = jLines.slice(-60);
        term.clear();
        term.write(jLines.join("\n"));
      }

      /* --- плитки --- */

      var stTotal = ui.stat("записано всего", 0, { tone: "write" });
      var stLag = ui.stat("суммарный lag", 0);
      var stCons = ui.stat("работает / простаивает", "0 / 0");
      var stReb = ui.stat("ребалансов", 0);
      var stLost = ui.stat("съедено непрочитанным", 0);
      var statsRow = ui.stats(stTotal.el, stLag.el, stCons.el, stReb.el, stLost.el);

      /* --- узлы --- */

      var producer = ui.node("producer", "продюсер", "4 сообщ/с");
      var prodMeta = producer.querySelector(".kv-node__meta");
      var topicBadge = ui.badge("топик orders · 3 партиции", "write");
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
            (p.s.records.length ? "хранится с " + p.s.base : "лог пуст") + "</span>",
            '<span style="font-family:var(--f-mono)">' + p.committed + "</span>",
            lagCell,
            o >= 0
              ? '<span style="color:' + consColor(o) + ';font-weight:600">C' + (o + 1) + "</span>"
              : '<span style="color:var(--faint)">никто</span>'
          ];
        });
        KV.clear(tableBox);
        tableBox.appendChild(ui.table(["партиция", "LEO", "committed", "lag", "читает"], rows));
      }

      /* ================= механика ================= */

      function buildTopic() {
        KV.clear(logBox);
        plog = []; pend = [];
        for (var i = 0; i < cfg.parts; i++) {
          var s = ui.logStrip({ label: "партиция " + i, sub: "—", empty: "пусто" });
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
          j("t-dim", "простой", idle.join(" ") + " без партиций: консьюмеров " + cfg.cons +
            ", партиций " + cfg.parts + " — партицию в группе читает максимум один");
        }
        lastIdle = sig;
      }

      function paintLabels() {
        plog.forEach(function (p, i) {
          if (!p.subEl) return;
          var o = owner[i];
          p.subEl.textContent = o >= 0 ? "читает C" + (o + 1) : "читателя нет";
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
        consRow.appendChild(el("span.kv-ctl__label", { text: "группа orders-worker" }));
        if (!cfg.cons) {
          consRow.appendChild(el("span", {
            style: { "font-size": "13px", color: "var(--faint)" },
            text: "в группе никого — топик пишется, но не читается"
          }));
          return;
        }
        var load = [];
        for (var c = 0; c < cfg.cons; c++) load.push([]);
        owner.forEach(function (o, i) { if (o >= 0 && o < cfg.cons) load[o].push("p" + i); });
        load.forEach(function (list, ci) {
          var idle = !list.length;
          var color = idle ? "var(--warn)" : consColor(ci);
          var n = ui.node("consumer", "C" + (ci + 1), idle ? "простаивает" : list.join(" "));
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
        j("t-dim", "ключей меньше, чем партиций",
          "разных ключей " + USERS.length + ", партиций " + cfg.parts +
          " — минимум одна лента останется пустой: параллелизм упирается не в партиции, а в число разных ключей");
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
              util.plural(q.time, "удалена", "удалено", "удалено") + " " + q.time + " " +
              util.plural(q.time, "запись", "записи", "записей") + " старше " + cfg.keep + " с");
          }
          if (q.cap) {
            j("t-dim", "лента полна", "p" + i + ": " +
              util.plural(q.cap, "убрана", "убрано", "убрано") + " " + q.cap + " " +
              util.plural(q.cap, "клетка", "клетки", "клеток") + " из начала — в ленте максимум " + MAX_CELLS);
          }
          if (q.lost) {
            j("t-bad", "ПОТЕРЯ", "p" + i + ": " + q.lost + " " +
              util.plural(q.lost, "запись съедена", "записи съедены", "записей съедено") +
              " retention ДО того, как группа " + util.plural(q.lost, "её", "их", "их") + " прочитала");
          }
          q.time = 0; q.cap = 0; q.lost = 0;
        });
      }

      function rebalance(why) {
        st.reb += 1;
        st.rebLeft = REBAL_TICKS;
        assign();
        j("t-bad", "РЕБАЛАНС", why + " → чтение всей группы стоит " +
          (REBAL_TICKS * TICK / 1000).toFixed(1) + " с, партиции раздаются заново");
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

      function dec(x) { return (Math.round(x * 10) / 10).toString().replace(".", ","); }

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
        stCons.set(st.rebLeft > 0 ? "РЕБАЛАНС" : work + " / " + idle,
          st.rebLeft > 0 || work === 0 ? "bad" : idle > 0 ? "warn" : "read");
        stReb.set(util.num(st.reb));
        stLost.set(util.num(st.lost), st.lost > 0 ? "bad" : "good");

        prodMeta.textContent = cfg.rate + " сообщ/с · " + strategyName();
        topicBadge.textContent = "топик orders · " + cfg.parts + " " +
          util.plural(cfg.parts, "партиция", "партиции", "партиций");
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
        if (st.rebLeft > 0) verdict = "<b>РЕБАЛАНС</b> — группа не читает вообще, lag растёт на полной скорости продюсера";
        else if (cfg.cons === 0) verdict = "<b>в группе никого</b> — читать некому, весь поток уходит в lag";
        else if (cap === 0) verdict = "<b>обработка 0/с</b> — консьюмеры держат партиции, но не разбирают ничего";
        else if (cap < cfg.rate) verdict = "дефицит <b>−" + (cfg.rate - cap) + "/с</b> — примерно на столько lag растёт каждую секунду";
        else if (worst >= 0 && over > 0.01) {
          verdict = "в сумме запас есть, но на <b>C" + (worst + 1) + "</b> одного идёт <b>" + dec(load[worst]) +
            "/с</b> при его <b>" + cfg.speed + "/с</b>: его партиции не разделить ни с кем — " +
            "<b>потолок группы недостижим</b>, лишнее копится в них, пока у соседей простаивает запас";
        } else if (lag === 0) verdict = "запас <b>+" + (cap - cfg.rate) + "/с</b>, lag держится у нуля";
        else if (cap === cfg.rate) verdict = "запас <b>+0/с</b> — каждому несут ровно столько, сколько он тянет: " +
          "накопленные <b>" + lag + "</b> так и останутся висеть, разбирать их нечем";
        else verdict = "запас <b>+" + (cap - cfg.rate) + "/с</b> — lag рассасывается";

        var extra = idle > 0
          ? " · простаивает <b>" + idle + "</b> " + util.plural(idle, "консьюмер", "консьюмера", "консьюмеров") +
          ": партиций " + cfg.parts + ", консьюмеров " + cfg.cons
          : "";
        var skew = (cfg.parts > 1 && lag >= 8 && hotLag > lag * 0.6)
          ? " · перекос: <b>p" + hot + "</b> держит " + Math.round(hotLag / lag * 100) + " % всего lag"
          : "";

        stage.say("продюсер <b>" + cfg.rate + "/с</b> · потолок группы <b>" + work + " × " + cfg.speed +
          " = " + cap + "/с</b> → " + verdict + extra + skew);
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
          j("t-w", "запись", "×" + writes.length + "   " + Object.keys(by).sort().map(function (p) {
            return "p" + p + "×" + by[p];
          }).join("  ") + "   " + util.escape(writes[writes.length - 1].key || "без ключа"));
        }

        if (st.rebLeft > 0) {
          st.rebLeft -= 1;
          if (st.rebLeft === 0) j("t-good", "ребаланс", "завершён — группа снова читает с committed");
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
        label: "партиций", min: 1, max: 6, value: cfg.parts,
        onInput: function (v) {
          cfg.parts = v;
          buildTopic();
          j("t-dim", "топик пересобран", v + " " + util.plural(v, "партиция", "партиции", "партиций") +
            ": ключи раскладываются заново, лог начат с нуля");
          noteKeyShortage();
          rebalance("изменилось число партиций");
          render();
        }
      });

      var rateRange = ui.range({
        label: "продюсер", min: 0, max: 12, value: cfg.rate, unit: "/с",
        onInput: function (v) { cfg.rate = v; j("t-w", "продюсер", v + " сообщ/с"); render(); }
      });

      var keySeg = ui.seg([
        { value: "users", label: "5 ключей" },
        { value: "hot", label: "горячий" },
        { value: "none", label: "без ключа" }
      ], cfg.strategy, function (v) {
        cfg.strategy = v;
        j("t-w", "стратегия ключа", strategyName());
        noteKeyShortage();
        render();
      });

      var consRange = ui.range({
        label: "консьюмеров", min: 0, max: 6, value: cfg.cons,
        onInput: function (v) {
          cfg.cons = v;
          rebalance("в группе теперь " + v + " " + util.plural(v, "консьюмер", "консьюмера", "консьюмеров"));
          render();
        }
      });

      var speedRange = ui.range({
        label: "обработка", min: 0, max: 8, value: cfg.speed, unit: "/с",
        onInput: function (v) { cfg.speed = v; j("t-r", "обработка", v + " сообщ/с на консьюмера"); render(); }
      });

      var keepRange = ui.range({
        label: "хранить", min: 5, max: 60, value: cfg.keep, unit: "с",
        onInput: function (v) { cfg.keep = v; j("t-dim", "retention", "хранить " + v + " с"); render(); }
      });

      var pauseBtn = ui.btn("Пауза", function () {
        st.run = !st.run;
        pauseBtn.textContent = st.run ? "Пауза" : "Пуск";
        j("t-dim", st.run ? "пуск" : "пауза", st.run ? "время идёт" : "время стоит, ручки и «шаг» работают");
        render();
      }, { sm: true });

      var stepBtn = ui.btn("Шаг", function () { tick(); }, { sm: true, variant: "ghost", title: "один такт 250 мс" });

      var killBtn = ui.btn("Убить консьюмера", function () {
        if (cfg.cons <= 0) { j("t-dim", "некого убивать", "в группе и так пусто"); return; }
        var dead = cfg.cons;
        cfg.cons -= 1;
        consRange.set(cfg.cons);
        rebalance("консьюмер C" + dead + " отвалился");
        render();
      }, { sm: true, variant: "danger" });

      var resetBtn = ui.btn("Сброс", function () { reset(); }, { sm: true, variant: "ghost" });

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
        pauseBtn.textContent = "Пауза";
        buildTopic();
        j("t-dim", "сброс", "3 партиции · продюсер 4/с · 2 консьюмера по 3/с · retention 20 с");
        warmUp();
      }

      KV.append(stage.controls,
        pRange.el, rateRange.el, ui.ctl("ключ", keySeg.el),
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
            { color: "var(--write)", label: "LEO — конец лога, куда пишет продюсер" },
            { color: "var(--read)", label: "флажок committed — докуда дочитала группа" },
            { color: "var(--muted)", label: "«•» — запись без ключа" }
          ])),
        el("div.kv-col", null,
          ui.panel("Состояние партиций", tableBox),
          ui.panel("Журнал событий", term.el)));

      root.appendChild(stage.el);

      /* ================= запуск ================= */

      buildTopic();
      j("t-dim", "старт", "3 партиции · продюсер 4/с · 2 консьюмера по 3/с · retention 20 с");
      warmUp();   // стенд открывается уже живым

      api.interval(TICK, function () { if (st.run) tick(); });

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
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
        "Остальное — скорости, [[lag]], [[committed offset|committed]], [[retention]] — считается честно.</p>"
      ));

      root.appendChild(ui.note("bad", "ловушка",
        "<p>Следи за плиткой «съедено непрочитанным». Когда [[retention]] начинает удалять записи, до которых группа не дошла, " +
        "<b>lag падает сам собой</b> — на дашборде это выглядит как «догнали». На самом деле это потеря данных: " +
        "единственная метрика, которая её покажет, — счётчик пропущенных, а не lag.</p>" +
        "<p>Механика внутри: [[committed offset|committed]] группы оказывается левее начала лога, консьюмер получает " +
        "<code>OffsetOutOfRange</code> и по <code>auto.offset.reset</code> прыгает вперёд — на первое уцелевшее сообщение " +
        "(<code>earliest</code>, так считает стенд) или сразу в конец лога (<code>latest</code>, значение по умолчанию). " +
        "Пропуск — ровно этот прыжок, и никакого следа в lag он не оставляет.</p>"
      ));

      root.appendChild(ui.takeaway([
        "Потолок группы = <b>консьюмеры, которым достались партиции</b> × скорость каждого. Лишние сверх числа партиций просто стоят. Но это потолок, а не пропускная способность: перекошенный ключ упирает одного консьюмера в его собственную скорость, и группа не догоняет при любой сумме.",
        "[[lag]] растёт ровно на разницу «пишут минус читают». Устойчивый рост — это дефицит мощности, а не всплеск.",
        "[[ребаланс]] останавливает чтение у <b>всей</b> группы, а запись — нет. Каждый рестарт консьюмера оплачивается ростом lag.",
        "[[hot key]] перекашивает одну партицию: смотри распределение lag по партициям, а не только сумму.",
        "[[retention]] не спрашивает, прочитали ли. Не успел — данные ушли, и <b>lag при этом уменьшится</b>."
      ]));
    }
  });
})();
