/* Глава 08 — Retention: почему запись всё-таки исчезает. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "retention",
    num: 8,
    group: "Хранение",
    nav: "Retention",
    title: "Почему запись всё-таки исчезает",
    lede: "Чтение ничего не удаляет — значит, удаляет что-то другое. Это <b>retention</b>: срок хранения или лимит размера. И он не спрашивает, прочитал ли кто-нибудь: <code>retention.ms = 7 дней</code> означает «неделя», а не «неделя после последнего читателя».",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>Если бы лог только рос, диск кончился бы на второй месяц. Он не растёт вечно: у каждого топика есть правило, " +
        "по которому старое уезжает из начала. Вариантов ровно два, и оба считают физику, а не читателей: " +
        "<code>retention.ms</code> — сколько запись живёт, <code>retention.bytes</code> — сколько места занимает [[партиция]].</p>"
      ));

      root.appendChild(ui.note("key", "закон",
        "<p><strong>Удаление не зависит от того, прочитал кто-то или нет.</strong> Никто не открывал топик неделю — " +
        "записи всё равно исчезнут по сроку. Все группы дочитали до конца ещё вчера — записи всё равно пролежат " +
        "положенные семь дней.</p>" +
        "<p>Газетный архив: подшивки хранят год и выбрасывают по дате, а не по числу посетителей. " +
        "Пока подшивка на полке — приходи и перечитывай сколько угодно. Это и есть replay.</p>"
      ));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Чистильщик лога · партиция orders-0",
        hint: "Мотай сутки и смотри, что уезжает из начала"
      });

      var EVENTS = ["оплата", "заказ", "клик", "вход", "отказ", "показ"];
      var SEED = 80808;
      var HIST = 6;          // сколько суток истории насыпаем при открытии
      var START = 41;        // лог начинается не с нуля: до нас уже что-то съели

      var rnd = util.rng(SEED);
      var mode = "time";     // "time" | "size"
      var retDays = 7;
      var limit = 18;
      var day = 0;
      var slow = START, fast = START;
      var lostTotal = 0;
      var oor = false;
      var alertHtml = "";
      var lastMsg = "";
      var autoId = null;
      var pendingDrop = null;

      /* --- узлы --- */
      var prodNode = ui.node("producer", "продюсер", "2–4 записи в сутки");
      var fastNode = ui.node("consumer", "reports", "lag 0");
      var slowNode = ui.node("consumer", "slow-consumer", "lag 0");
      var oorBadge = ui.badge("OffsetOutOfRange", "bad");
      oorBadge.classList.add("kv-hidden");
      var fastMeta = fastNode.querySelector(".kv-node__meta");
      var slowMeta = slowNode.querySelector(".kv-node__meta");

      /* --- шкала «сколько лога заполнено» --- */
      var capEl = el("div", { style: { "font-size": "12.5px", color: "var(--muted)", "margin-bottom": "5px" } });
      var fillBar = ui.bar(0);
      var ruleEl = el("div", {
        style: {
          "font-family": "var(--f-mono)", "font-size": "11px",
          color: "var(--faint)", "margin-top": "5px"
        }
      });
      var barBlock = el("div", { style: { "max-width": "560px", "margin-bottom": "16px" } },
        capEl, fillBar.el, ruleEl);

      /* --- лента --- */
      var strip = ui.logStrip({
        label: "orders-0",
        sub: "cleanup.policy=delete",
        empty: "лог пуст — всё вычищено",
        base: START
      });

      /* --- плитки --- */
      var stDay = ui.stat("день", 0);
      var stCount = ui.stat("записей в логе", 0);
      var stOldest = ui.stat("самый старый offset", START);
      var stNewest = ui.stat("самый новый offset", START);
      var stAge = ui.stat("возраст лога", 0, { unit: "дн" });
      var stSlow = ui.stat("закладка slow-consumer", START);
      var stLost = ui.stat("потеряно навсегда", 0);
      var statsRow = ui.stats(stDay.el, stCount.el, stOldest.el, stNewest.el, stAge.el, stSlow.el, stLost.el);
      statsRow.style.marginTop = "14px";

      /* --- журнал чистильщика --- */
      var term = ui.terminal();
      term.el.style.marginTop = "14px";
      term.el.style.maxHeight = "112px";
      term.el.style.overflowY = "auto";

      /* ================= модель ================= */

      function baseOff() { return strip.base; }
      function leo() { return strip.leo(); }
      function ageOf(rec) { return day - rec.born; }
      function dayWord(n) { return util.plural(n, "день", "дня", "дней"); }
      function recWord(n) { return util.plural(n, "запись", "записи", "записей"); }
      function msgWord(n) { return util.plural(n, "сообщение", "сообщения", "сообщений"); }
      /* Родительный падеж — после «больше», «из», «≥»: «из 4 записей», «≥ 3 дней». */
      function recGen(n) { return util.plural(n, "записи", "записей", "записей"); }
      function dayGen(n) { return util.plural(n, "дня", "дней", "дней"); }

      function say(html) {
        lastMsg = html;
        if (oor) buildAlert();          // цифры в прилипшем разборе не должны стухать
        stage.say(KV.terms(html) +
          (alertHtml ? "<div style=\"margin-top:7px\">" + KV.terms(alertHtml) + "</div>" : ""));
      }

      /** Возраст пишем прямо в клетку — он меняется каждые сутки. */
      function refreshCells() {
        var b = baseOff(), rs = strip.records;
        for (var i = 0; i < rs.length; i++) {
          var r = rs[i], a = ageOf(r);
          r.label = a + "д";
          r.title = "ключ «" + r.key + "» · offset " + (b + i) +
            " · записана в день " + r.born + " · возраст " + a + " " + dayWord(a);
          var c = strip.cell(b + i);
          if (c) { c.textContent = r.label; c.title = r.title; }
        }
      }

      function paintMarkers() {
        strip.marker("fast", { at: fast, label: "reports " + fast, color: "var(--read)" });
        strip.marker("slow", {
          at: slow,
          label: oor ? "✕ " + slow : "slow " + slow,
          color: oor ? "var(--bad)" : "var(--k3)"
        });
      }

      function updateStats() {
        var rs = strip.records, b = baseOff();
        var oldAge = rs.length ? ageOf(rs[0]) : 0;

        stDay.set(day);
        stCount.set(rs.length);
        stOldest.set(rs.length ? b : "—");
        stNewest.set(rs.length ? leo() - 1 : "—");
        stAge.set(oldAge, mode === "time" && oldAge >= retDays - 1 ? "warn" : null);
        stSlow.set(slow, oor ? "bad" : null);
        stLost.set(lostTotal, lostTotal ? "bad" : null);

        fastMeta.textContent = "lag " + Math.max(0, leo() - fast);
        slowMeta.textContent = oor ? "закладка вне лога" : "lag " + Math.max(0, leo() - slow);
        slowNode.classList.toggle("kv-node--dead", oor);
        oorBadge.classList.toggle("kv-hidden", !oor);

        if (mode === "time") {
          var f = retDays ? oldAge / retDays : 0;
          fillBar.set(f, f >= 0.85 ? "warn" : null);
          capEl.innerHTML = "самой старой записи <b>" + oldAge + "</b> из " + retDays + " " +
            dayGen(retDays) + " — дальше снос";
          ruleEl.textContent = "правило: удалять всё, чему ≥ " + retDays + " " + dayGen(retDays) +
            "  ·  retention.ms = " + util.num(retDays * 86400000);
        } else {
          fillBar.set(rs.length / limit, rs.length >= limit ? "warn" : null);
          capEl.innerHTML = "в логе <b>" + rs.length + "</b> из " + limit + " " + recGen(limit) +
            " — что сверху лимита, вытесняется снизу";
          ruleEl.textContent = "правило: держать не больше " + limit + " " + recGen(limit) +
            "  ·  retention.bytes (лимит на партицию, не на топик)";
        }
      }

      /* ---- продюсер и консьюмеры ---- */

      function writeDay() {
        var n = 2 + Math.floor(rnd() * 3);
        var names = [];
        for (var i = 0; i < n; i++) {
          var k = util.pick(EVENTS, rnd);
          names.push(k);
          strip.push({ key: k, born: day, label: "0д" });
        }
        return names;
      }

      /** @returns {boolean} сдвинулась ли закладка отставшей группы */
      function moveConsumers() {
        fast = leo();                                  // успевающая группа всегда в конце
        if (oor || slow >= leo()) return false;         // вне лога или уже в конце — стоит
        slow += 1;                                      // отставшая ползёт по одной записи в сутки
        return true;
      }

      /* ---- retention ---- */

      function doomedCount() {
        var rs = strip.records;
        if (mode === "time") {
          var n = 0;
          while (n < rs.length && ageOf(rs[n]) >= retDays) n++;
          return n;
        }
        return Math.max(0, rs.length - limit);
      }

      function flushDrop() {
        var f = pendingDrop;
        pendingDrop = null;
        if (f) f();
      }

      function scheduleDrop(n) {
        var fn = function () { dropNow(n); };
        pendingDrop = fn;
        api.timeout(api.reduced ? 1 : 520, function () {
          if (pendingDrop === fn) flushDrop();
        });
      }

      /** Второй такт: просроченные уезжают из начала лога. */
      function dropNow(n) {
        var b = baseOff();
        var newBase = b + n;
        var rest = strip.records.slice(n);
        strip.setBase(newBase);
        strip.setRecords(rest);

        term.line("        <span class=\"t-bad\">− удалено " + n + " " + recWord(n) +
          ", лог начинается с " + newBase + "</span> <span class=\"t-dim\">// читателей не спрашивали</span>");

        if (slow < newBase) {
          lostTotal += newBase - Math.max(slow, b);
          if (!oor) {
            term.line("        <span class=\"t-bad\">OffsetOutOfRange: slow-consumer " + slow +
              " < начало лога " + newBase + "</span>");
            strip.strip.scrollLeft = 0;      // показать красный флажок у самого начала лога
          }
          oor = true;
          buildAlert();
        }
        if (fast < newBase) fast = newBase;

        refreshCells();
        paintMarkers();
        updateStats();
        say(lastMsg);
      }

      /** Первый такт: просроченные гаснут, но ещё лежат. */
      function evaluate() {
        flushDrop();
        var n = doomedCount();
        if (!n) return 0;
        var b = baseOff();
        for (var i = 0; i < n; i++) strip.setState(b + i, "expired");
        scheduleDrop(n);
        return n;
      }

      function buildAlert() {
        var b = baseOff(), gap = b - slow, r = resetSel.value();
        alertHtml =
          "<span class=\"kv-badge kv-badge--bad\">OffsetOutOfRange</span> " +
          "закладка группы <b>slow-consumer</b> стоит на offset <b>" + slow + "</b>, а лог начинается с <b>" + b + "</b>. " +
          "Удалено непрочитанными: <b>" + gap + "</b> " + msgWord(gap) + " — этого куска на диске больше нет, " +
          "группа его не прочитает <b>никогда</b>. " +
          (r === "earliest"
            ? "По <code>auto.offset.reset=earliest</code> клиент начнёт с offset " + b +
              " — молча, без единой ошибки в приложении: дыра просто не случится в логах."
            : "По <code>auto.offset.reset=latest</code> клиент прыгнет в конец (offset " + leo() +
              ") и пропустит вдобавок ещё " + (leo() - b) + " " + msgWord(leo() - b) + " — тоже молча.");
      }

      function clearAlert() { oor = false; alertHtml = ""; }

      /* ---- такт времени ---- */

      function tick() {
        flushDrop();                 // сначала доносим отложенный снос, потом трогаем лог и закладки
        day++;
        var names = writeDay();
        var moved = moveConsumers();
        refreshCells();

        term.line("<span class=\"t-dim\">день " + day + "</span>  <span class=\"t-w\">+ " + names.length +
          " " + recWord(names.length) + " (" + util.escape(names.join(", ")) + ")</span>");

        var doomed = evaluate();
        paintMarkers();
        updateStats();

        var rs = strip.records;
        var oldAge = rs.length ? ageOf(rs[0]) : 0;
        var msg = "<b>День " + day + ".</b> Продюсер дописал " + names.length + " " + recWord(names.length) + ". ";

        if (doomed) {
          msg += mode === "time"
            ? "Чистильщик пометил под снос " + doomed + " " + recWord(doomed) + " — возраст ≥ " + retDays + " " +
              dayGen(retDays) + ". Сейчас они выцвели, через мгновение уедут из лога."
            : "В логе стало больше " + limit + " " + recGen(limit) + " — лишнее вытесняется с начала: " +
              doomed + " " + recWord(doomed) + ", хотя самой старой всего " + oldAge + " " + dayWord(oldAge) + ".";
          msg += " <b>reports дочитала всё ещё вчера — на удаление это никак не повлияло.</b>";
        } else {
          msg += "Удалять нечего: самой старой записи " + oldAge + " " + dayWord(oldAge) + ". " +
            (oor
              ? "Закладка slow-consumer осталась вне лога и не двигается — [[retention]] на неё и не смотрел."
              : moved
                ? "Закладка reports в конце, закладка slow-consumer сдвинулась на одну — [[retention]] на это не смотрит."
                : "Обе закладки стоят в конце лога — [[retention]] на это не смотрит.");
        }
        say(msg);
      }

      /* ================= контролы ================= */

      var daysRange = ui.range({
        label: "retention.ms", min: 1, max: 14, value: retDays, unit: "дн",
        onInput: function (v) {
          retDays = v;
          var n = evaluate();
          paintMarkers();
          updateStats();
          say("<b>retention.ms = " + v + " " + dayWord(v) + ".</b> " +
            (n ? "Правило поменялось задним числом: мгновенно оказалось просрочено " + n + " " + recWord(n) +
                 " — уезжают из лога."
               : "Под снос пока ничего не попало — самая старая запись моложе срока."));
        }
      });

      var limitRange = ui.range({
        label: "лимит", min: 4, max: 40, value: limit, unit: "зап",
        onInput: function (v) {
          limit = v;
          var n = evaluate();
          paintMarkers();
          updateStats();
          say("<b>retention.bytes ≈ " + v + " " + recWord(v) + ".</b> " +
            (n ? "Прямо сейчас вытесняется " + n + " " + recWord(n) +
                 " — возраст тут ни при чём, важен только размер."
               : "Лимит не исчерпан, вытеснять нечего."));
        }
      });

      var modeSeg = ui.seg([
        { value: "time", label: "по времени" },
        { value: "size", label: "по размеру" }
      ], "time", function (v) {
        mode = v;
        syncMode();
        var n = evaluate();
        paintMarkers();
        updateStats();
        say(v === "time"
          ? "<b>retention.ms</b> — хранение по сроку. Запись живёт " + retDays + " " + dayWord(retDays) +
            " и исчезает по возрасту, сколько бы места ни оставалось на диске."
          : "<b>retention.bytes</b> — хранение по размеру. Лог держит не больше " + limit + " " + recGen(limit) +
            "; запись может умереть молодой, если позади неё насыпали слишком много. " +
            (n ? "Лишнее уже помечено: " + n + " " + recWord(n) + "." : ""));
      });

      function syncMode() {
        daysRange.el.classList.toggle("kv-hidden", mode !== "time");
        limitRange.el.classList.toggle("kv-hidden", mode !== "size");
      }

      var resetSel = ui.select("auto.offset.reset", [
        { value: "earliest", label: "earliest" },
        { value: "latest", label: "latest" }
      ], "earliest", function () {
        if (oor) { buildAlert(); say(lastMsg); }
        else {
          say("<code>auto.offset.reset = " + util.escape(resetSel.value()) + "</code>. " +
            "Настройка срабатывает только в двух случаях: у группы вообще нет [[committed offset]] (она новая) " +
            "или её offset оказался вне лога. В обычной жизни она не делает ничего.");
        }
      });

      var autoTog = ui.toggle("время идёт само", false, function (on) {
        if (autoId) { api.stop(autoId); autoId = null; }   // второго таймера быть не должно
        if (on) {
          autoId = api.interval(1600, tick);
          stage.hint("Сутки идут сами · выключи тумблер, чтобы остановить");
        } else {
          stage.hint("Мотай сутки и смотри, что уезжает из начала");
        }
      });

      function catchUp() {
        flushDrop();                       // сначала досносим просроченное, потом двигаем закладку
        var b = baseOff(), from = slow, missed = Math.max(0, leo() - Math.max(from, b));
        var wasOor = oor;
        if (!wasOor && !missed) {                       // повторный клик: двигать нечего
          say("<b>Уже в конце.</b> Закладка slow-consumer стоит на offset " + slow + ", лаг ноль — " +
            "догонять нечего. Промотай сутки: продюсер снова уйдёт вперёд.");
          return;
        }
        clearAlert();
        slow = leo();
        paintMarkers();
        updateStats();
        strip.scrollEnd();
        term.line("        <span class=\"t-r\">slow-consumer → offset " + slow + " (seek to end)</span>");
        say(wasOor
          ? "<b>Догнали.</b> Закладка прыгнула в конец, offset " + slow + ". Ошибка ушла, лаг ноль — " +
            "но дыру это не лечит: стёрто с диска и потеряно навсегда " + lostTotal + " " + msgWord(lostTotal) +
            ". Догнать можно позицию, а не данные."
          : "<b>Догнали.</b> Закладка прыгнула с " + from + " в конец, offset " + slow + ". " +
            missed + " " + msgWord(missed) + " группа пропустила — они <b>ещё лежат</b> в логе, " +
            "просто эта группа их читать не станет. Так тушат лаг ценой пропуска.");
      }

      function rewind() {
        flushDrop();
        var b = baseOff();
        clearAlert();
        slow = b;
        paintMarkers();
        updateStats();
        strip.strip.scrollLeft = 0;
        term.line("        <span class=\"t-r\">slow-consumer → offset " + b + " (seek to beginning)</span>");
        say("<b>Replay.</b> Закладка на самом старом уцелевшем offset " + b + " — группа перечитает весь лог заново, " +
          "все " + strip.records.length + " " + recWord(strip.records.length) + ". Именно [[retention]] и делает это возможным: " +
          "пока запись не истекла, её можно читать сколько угодно раз. То, что истекло, вернуть неоткуда.");
      }

      function applyReset() {
        flushDrop();
        if (!oor) {
          say("Сейчас закладка внутри лога, читать можно — <code>auto.offset.reset</code> молчит. " +
            "Он вмешивается, только когда offset оказался вне лога или у группы его вовсе нет.");
          return;
        }
        var b = baseOff(), from = slow, r = resetSel.value();
        clearAlert();
        if (r === "earliest") {
          slow = b;
          term.line("        <span class=\"t-r\">auto.offset.reset=earliest → offset " + b + "</span>");
          say("<b>earliest.</b> Клиент начал с самого старого уцелевшего offset " + b + ". " +
            "Дыра в " + (b - from) + " " + msgWord(b - from) + " осталась навсегда, но приложение об этом " +
            "<b>не узнает</b>: ни ошибки, ни строчки в логе — просто в данных не хватает куска.");
        } else {
          var extra = leo() - b;
          slow = leo();
          term.line("        <span class=\"t-r\">auto.offset.reset=latest → offset " + slow + "</span>");
          say("<b>latest.</b> Клиент прыгнул в конец, offset " + slow + ". Кроме потерянных навсегда (" +
            (b - from) + "), группа пропустит ещё " + extra + " " + msgWord(extra) +
            " — они лежат в логе целыми, но прочитаны не будут. <b>latest на проде почти всегда ошибка.</b>");
        }
        paintMarkers();
        updateStats();
      }

      /* ================= старт ================= */

      /** Словами — правило, которое действует прямо сейчас. */
      function ruleText() {
        return mode === "time"
          ? "не старше " + retDays + " " + dayGen(retDays)
          : "не больше " + limit + " " + recGen(limit);
      }

      /** @returns {number} сколько записей правило накрыло сразу после посева */
      function seed() {
        pendingDrop = null;
        rnd = util.rng(SEED);
        day = 0; lostTotal = 0;
        clearAlert();
        strip.setRecords([]);
        strip.setBase(START);
        slow = START; fast = START;

        writeDay();
        for (var d = 1; d <= HIST; d++) { day = d; writeDay(); moveConsumers(); }
        fast = leo();

        refreshCells();
        /* Чистильщик смотрит на лог всегда, а не только по кнопке «сутки»:
           иначе после сброса стенд показывал бы лог, который сам же нарушает
           действующее правило, и ничего бы не удалял. */
        var doomed = evaluate();
        paintMarkers();
        updateStats();

        term.clear();
        term.line("<span class=\"t-dim\">// журнал чистильщика, партиция orders-0</span>");
        term.line("<span class=\"t-dim\">день " + day + " · " + strip.records.length + " " +
          recWord(strip.records.length) + ", offsets " + baseOff() + "…" + (leo() - 1) +
          " · offsets 0…" + (START - 1) + " съедены раньше</span>");

        say("Лог живёт седьмые сутки. Цифра в клетке — <b>возраст записи в днях</b>. " +
          "Группа <b>reports</b> успевает и стоит в конце; группа <b>slow-consumer</b> ползёт по одной записи в сутки " +
          "и уже отстала на " + (leo() - slow) + " " + msgWord(leo() - slow) + ". " +
          (doomed
            ? "Действующее правило (" + ruleText() + ") накрыло сразу " + doomed + " " + recWord(doomed) +
              " — они выцвели и сейчас уедут из лога. "
            : "") +
          "Мотай сутки: продюсер дописывает, чистильщик сносит старое — " +
          "и смотри, кто кого обгонит.");

        return doomed;
      }

      /* --- сборка стенда --- */

      stage.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "16px" } },
        prodNode,
        el("span", { style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" } }, "→"),
        fastNode,
        el("div.kv-row", { style: { gap: "6px" } }, slowNode, oorBadge)));

      stage.body.appendChild(barBlock);
      stage.body.appendChild(strip.el);
      stage.body.appendChild(statsRow);
      stage.body.appendChild(el("div", { style: { "margin-top": "12px" } },
        ui.legend([
          { color: "var(--k0)", label: "запись · цвет — по ключу события, цифра = возраст в днях" },
          { color: "var(--faint)", label: "выцвела = просрочена, сейчас уедет" },
          { color: "var(--read)", label: "закладка reports" },
          { color: "var(--k3)", label: "закладка slow-consumer" }
        ])));
      stage.body.appendChild(term.el);

      KV.append(stage.controls,
        ui.btn("Промотать сутки", tick, { variant: "primary" }),
        autoTog.el,
        ui.ctl("правило", modeSeg.el),
        daysRange.el,
        limitRange.el,
        resetSel.el,
        ui.btn("Применить reset", applyReset, { sm: true, variant: "danger" }),
        ui.btn("Догнать", catchUp, { sm: true, variant: "read" }),
        ui.btn("Перемотать в начало", rewind, { sm: true }),
        ui.btn("Сбросить", function () {
          var n = seed();
          say("Стенд собран заново: день 6, семь суток истории, offsets с " + START + ". " +
            (n
              ? "Правило осталось прежним (" + ruleText() + ") и сразу накрыло " + n + " " + recWord(n) +
                " — они выцвели и уезжают."
              : "По действующему правилу (" + ruleText() + ") сносить пока нечего."));
        }, { sm: true, variant: "ghost" }));

      syncMode();
      seed();
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
        "<h3>Что здесь важно увидеть</h3>" +
        "<p>Лента уезжает влево с той же скоростью, с какой продюсер пишет справа. Ни одна кнопка читателя на это " +
        "не влияет: <b>reports</b> с нулевым лагом и <b>slow-consumer</b>, которая не прочитала почти ничего, " +
        "для чистильщика одинаково не существуют. Он сравнивает возраст записи со сроком — и всё.</p>" +
        "<h4>Удаляются сегменты, а не записи</h4>" +
        "<p>Партиция на диске нарезана на файлы-сегменты (<code>log.segment.bytes</code>, по умолчанию 1 ГБ, " +
        "или <code>segment.ms</code>, по умолчанию неделя). Чистильщик сносит <em>целый закрытый сегмент</em> и " +
        "только когда просрочена его самая молодая запись. Поэтому реальный срок хранения всегда чуть больше " +
        "заявленного, а просыпается уборщик раз в <code>log.retention.check.interval.ms</code> (5 минут). " +
        "И поэтому же «удалить одно конкретное сообщение» Kafka не умеет в принципе.</p>" +
        "<h4>Два правила работают одновременно</h4>" +
        "<p><code>retention.ms</code> по умолчанию 7 дней, <code>retention.bytes</code> — <code>-1</code>, то есть " +
        "без лимита. Если заданы оба, срабатывает тот, что наступит раньше. Считаются они <b>на партицию</b>: " +
        "<code>retention.bytes = 100 ГБ</code> при 12 партициях — это до 1,2 ТБ на топик, а не 100 ГБ.</p>"
      ));

      root.appendChild(ui.note("bad", "ловушка",
        "<p><strong>Отстал сильнее, чем retention — потерял данные молча.</strong> [[committed offset]] группы " +
        "оказывается левее начала лога, клиент получает <code>OffsetOutOfRange</code> и чинит это сам по " +
        "<code>auto.offset.reset</code>: <code>earliest</code> — начнёт с самого старого уцелевшего и пропустит дыру, " +
        "<code>latest</code> — прыгнет в конец и пропустит ещё больше. Оба варианта <b>не бросают ошибку в приложение</b>. " +
        "Заметен только третий, <code>none</code>: он бросает исключение — и поэтому его стоит ставить там, " +
        "где пропуск данных дороже падения сервиса.</p>" +
        "<p>Отсюда правило мониторинга: [[lag]] в сообщениях — половина картины. Мерить надо ещё и возраст самой старой " +
        "непрочитанной записи против <code>retention.ms</code>. Лаг в два миллиона сообщений при недельном сроке — " +
        "рабочая ситуация; лаг в шесть дней при том же сроке — пожар, даже если сообщений в нём десять тысяч.</p>"
      ));

      root.appendChild(ui.takeaway([
        "<b>Retention — это срок или размер, а не «пока не прочитают».</b> Никто не читал — удалится; все прочитали — пролежит положенное.",
        "Два правила: <code>retention.ms</code> (по умолчанию 7 дней) и <code>retention.bytes</code> (по умолчанию без лимита). Считаются на [[партиция|партицию]]; срабатывает тот, что наступит раньше.",
        "Replay живёт ровно столько, сколько [[retention]]: пока запись не истекла, перематывай [[offset]] назад и перечитывай сколько угодно.",
        "Отстал сильнее retention — <code>OffsetOutOfRange</code>, и по <code>auto.offset.reset</code> клиент <b>молча</b> начнёт с earliest или latest. Следи не только за [[lag|лагом]] в сообщениях, но и за его возрастом.",
        "Удаляются целые сегменты, а не отдельные записи. Точечно стереть сообщение по ключу — это уже [[compaction]], следующая глава."
      ]));
    }
  });
})();
