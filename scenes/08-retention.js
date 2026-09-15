/* Глава 08 — Retention: почему запись всё-таки исчезает. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "retention",
    num: 8,
    group: ["Хранение", "Storage"],
    nav: ["Retention", "Retention"],
    title: ["Почему запись всё-таки исчезает", "Why a record disappears after all"],
    lede: [
      "Чтение ничего не удаляет — значит, удаляет что-то другое. Это <b>retention</b>: срок хранения или лимит размера. И он не спрашивает, прочитал ли кто-нибудь: <code>retention.ms = 7 дней</code> означает «неделя», а не «неделя после последнего читателя».",
      "Reading deletes nothing — so something else must. That something is <b>retention</b>: a time limit or a size limit. And it never asks whether anyone has read the data: <code>retention.ms = 7 days</code> means “a week”, not “a week after the last reader”."
    ],

    build: function (root, api) {

      root.appendChild(ui.prose(L(
        "<p>Если бы лог только рос, диск кончился бы на второй месяц. Он не растёт вечно: у каждого топика есть правило, " +
        "по которому старое уезжает из начала. Вариантов ровно два, и оба считают физику, а не читателей: " +
        "<code>retention.ms</code> — сколько запись живёт, <code>retention.bytes</code> — сколько места занимает [[партиция]].</p>",

        "<p>If the log only ever grew, you would run out of disk in the second month. It does not grow forever: every topic has a rule " +
        "by which the old stuff leaves from the front. There are exactly two options, and both count physics, not readers: " +
        "<code>retention.ms</code> — how long a record lives, <code>retention.bytes</code> — how much space a [[partition]] takes.</p>"
      )));

      root.appendChild(ui.note("key", L("закон", "the law"), L(
        "<p><strong>Удаление не зависит от того, прочитал кто-то или нет.</strong> Никто не открывал топик неделю — " +
        "записи всё равно исчезнут по сроку. Все группы дочитали до конца ещё вчера — записи всё равно пролежат " +
        "положенные семь дней.</p>" +
        "<p>Газетный архив: подшивки хранят год и выбрасывают по дате, а не по числу посетителей. " +
        "Пока подшивка на полке — приходи и перечитывай сколько угодно. Это и есть replay.</p>",

        "<p><strong>Deletion does not depend on whether anyone has read the data.</strong> Nobody opened the topic for a week — " +
        "the records still disappear when their time is up. Every group read to the end yesterday — the records still sit there " +
        "for their full seven days.</p>" +
        "<p>A newspaper archive: bound volumes are kept for a year and thrown out by date, not by how many people came. " +
        "While a volume is on the shelf, come and re-read it as much as you like. That is exactly what replay is.</p>"
      )));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Чистильщик лога · партиция orders-0", "The log cleaner · partition orders-0"),
        hint: L("Мотай сутки и смотри, что уезжает из начала",
          "Advance the days and watch what leaves the front")
      });

      var EVENTS = L(
        ["оплата", "заказ", "клик", "вход", "отказ", "показ"],
        ["payment", "order", "click", "login", "reject", "impression"]
      );
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
      var prodNode = ui.node("producer", L("продюсер", "producer"), L("2–4 записи в сутки", "2–4 records a day"));
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
        empty: L("лог пуст — всё вычищено", "the log is empty — everything has been cleaned out"),
        base: START
      });

      /* --- плитки --- */
      var stDay = ui.stat(L("день", "day"), 0);
      var stCount = ui.stat(L("записей в логе", "records in the log"), 0);
      var stOldest = ui.stat(L("самый старый offset", "oldest offset"), START);
      var stNewest = ui.stat(L("самый новый offset", "newest offset"), START);
      var stAge = ui.stat(L("возраст лога", "age of the log"), 0, { unit: L("дн", "d") });
      var stSlow = ui.stat(L("закладка slow-consumer", "slow-consumer bookmark"), START);
      var stLost = ui.stat(L("потеряно навсегда", "lost forever"), 0);
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
      function dayWord(n) { return util.plural(n, L("день", "day"), L("дня", "days"), L("дней", "days")); }
      function recWord(n) { return util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records")); }
      function msgWord(n) { return util.plural(n, L("сообщение", "message"), L("сообщения", "messages"), L("сообщений", "messages")); }
      /* Родительный падеж — после «больше», «из», «≥»: «из 4 записей», «≥ 3 дней».
         Английскому падежи не нужны, поэтому там те же day/record — важно лишь,
         чтобы в форме «один» стояло единственное число: «≥ 1 day», а не «1 days». */
      function recGen(n) { return util.plural(n, L("записи", "record"), L("записей", "records"), L("записей", "records")); }
      function dayGen(n) { return util.plural(n, L("дня", "day"), L("дней", "days"), L("дней", "days")); }

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
          r.label = a + L("д", "d");
          r.title = L("ключ «", "key “") + r.key + L("» · offset ", "” · offset ") + (b + i) +
            L(" · записана в день ", " · written on day ") + r.born +
            L(" · возраст ", " · age ") + a + " " + dayWord(a);
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
        slowMeta.textContent = oor ? L("закладка вне лога", "bookmark outside the log") : "lag " + Math.max(0, leo() - slow);
        slowNode.classList.toggle("kv-node--dead", oor);
        oorBadge.classList.toggle("kv-hidden", !oor);

        if (mode === "time") {
          var f = retDays ? oldAge / retDays : 0;
          fillBar.set(f, f >= 0.85 ? "warn" : null);
          capEl.innerHTML = L("самой старой записи <b>", "the oldest record has used <b>") + oldAge +
            L("</b> из ", "</b> of ") + retDays + " " +
            dayGen(retDays) + L(" — дальше снос", " — past that it gets dropped");
          ruleEl.textContent = L("правило: удалять всё, чему ≥ ", "rule: delete everything aged ≥ ") +
            retDays + " " + dayGen(retDays) +
            "  ·  retention.ms = " + util.num(retDays * 86400000);
        } else {
          fillBar.set(rs.length / limit, rs.length >= limit ? "warn" : null);
          capEl.innerHTML = L("в логе <b>", "the log holds <b>") + rs.length +
            L("</b> из ", "</b> of ") + limit + " " + recGen(limit) +
            L(" — что сверху лимита, вытесняется снизу", " — whatever is over the limit is pushed out from the front");
          ruleEl.textContent = L("правило: держать не больше ", "rule: keep no more than ") +
            limit + " " + recGen(limit) +
            L("  ·  retention.bytes (лимит на партицию, не на топик)",
              "  ·  retention.bytes (a limit per partition, not per topic)");
        }
      }

      /* ---- продюсер и консьюмеры ---- */

      function writeDay() {
        var n = 2 + Math.floor(rnd() * 3);
        var names = [];
        for (var i = 0; i < n; i++) {
          var k = util.pick(EVENTS, rnd);
          names.push(k);
          strip.push({ key: k, born: day, label: L("0д", "0d") });
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

        term.line("        <span class=\"t-bad\">− " + L("удалено ", "deleted ") + n + " " + recWord(n) +
          L(", лог начинается с ", ", the log now starts at ") + newBase + "</span> <span class=\"t-dim\">// " +
          L("читателей не спрашивали", "nobody asked the readers") + "</span>");

        if (slow < newBase) {
          lostTotal += newBase - Math.max(slow, b);
          if (!oor) {
            term.line("        <span class=\"t-bad\">OffsetOutOfRange: slow-consumer " + slow +
              L(" < начало лога ", " < start of log ") + newBase + "</span>");
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
          L("закладка группы <b>slow-consumer</b> стоит на offset <b>",
            "the bookmark of group <b>slow-consumer</b> sits at offset <b>") + slow +
          L("</b>, а лог начинается с <b>", "</b>, and the log starts at <b>") + b + "</b>. " +
          L("Удалено непрочитанными: <b>", "Deleted unread: <b>") + gap + "</b> " + msgWord(gap) +
          L(" — этого куска на диске больше нет, ", " — that chunk is not on disk any more, ") +
          L("группа его не прочитает <b>никогда</b>. ", "and the group will <b>never</b> read it. ") +
          (r === "earliest"
            ? L("По <code>auto.offset.reset=earliest</code> клиент начнёт с offset ",
                "With <code>auto.offset.reset=earliest</code> the client starts from offset ") + b +
              L(" — молча, без единой ошибки в приложении: дыра просто не случится в логах.",
                " — silently, without a single error in the application: the hole just never shows up in your logs.")
            : L("По <code>auto.offset.reset=latest</code> клиент прыгнет в конец (offset ",
                "With <code>auto.offset.reset=latest</code> the client jumps to the end (offset ") + leo() +
              L(") и пропустит вдобавок ещё ", ") and skips another ") + (leo() - b) + " " + msgWord(leo() - b) +
              L(" — тоже молча.", " on top — also silently."));
      }

      function clearAlert() { oor = false; alertHtml = ""; }

      /* ---- такт времени ---- */

      function tick() {
        flushDrop();                 // сначала доносим отложенный снос, потом трогаем лог и закладки
        day++;
        var names = writeDay();
        var moved = moveConsumers();
        refreshCells();

        term.line("<span class=\"t-dim\">" + L("день ", "day ") + day + "</span>  <span class=\"t-w\">+ " + names.length +
          " " + recWord(names.length) + " (" + util.escape(names.join(", ")) + ")</span>");

        var doomed = evaluate();
        paintMarkers();
        updateStats();

        var rs = strip.records;
        var oldAge = rs.length ? ageOf(rs[0]) : 0;
        var msg = L("<b>День ", "<b>Day ") + day +
          L(".</b> Продюсер дописал ", ".</b> The producer appended ") + names.length + " " + recWord(names.length) + ". ";

        if (doomed) {
          msg += mode === "time"
            ? L("Чистильщик пометил под снос ", "The cleaner marked ") + doomed + " " + recWord(doomed) +
              L(" — возраст ≥ ", " for removal — age ≥ ") + retDays + " " +
              dayGen(retDays) + L(". Сейчас они выцвели, через мгновение уедут из лога.",
                ". Faded out now, and in a moment gone from the log.")
            : L("В логе стало больше ", "The log went over ") + limit + " " + recGen(limit) +
              L(" — лишнее вытесняется с начала: ", " — the excess is pushed out from the front: ") +
              doomed + " " + recWord(doomed) +
              L(", хотя самой старой всего ", ", even though the oldest one is only ") + oldAge + " " + dayWord(oldAge) +
              L(".", " old.");
          msg += L(" <b>reports дочитала всё ещё вчера — на удаление это никак не повлияло.</b>",
            " <b>reports finished reading everything yesterday — that changed nothing about the deletion.</b>");
        } else {
          msg += L("Удалять нечего: самой старой записи ", "Nothing to delete: the oldest record is ") +
            oldAge + " " + dayWord(oldAge) + L(". ", " old. ") +
            (oor
              ? L("Закладка slow-consumer осталась вне лога и не двигается — [[retention]] на неё и не смотрел.",
                  "The slow-consumer bookmark is still outside the log and is not moving — [[retention]] never looked at it anyway.")
              : moved
                ? L("Закладка reports в конце, закладка slow-consumer сдвинулась на одну — [[retention]] на это не смотрит.",
                    "The reports bookmark is at the end, the slow-consumer bookmark moved by one — [[retention]] does not look at that.")
                : L("Обе закладки стоят в конце лога — [[retention]] на это не смотрит.",
                    "Both bookmarks sit at the end of the log — [[retention]] does not look at that."));
        }
        say(msg);
      }

      /* ================= контролы ================= */

      var daysRange = ui.range({
        label: "retention.ms", min: 1, max: 14, value: retDays, unit: L("дн", "d"),
        onInput: function (v) {
          retDays = v;
          var n = evaluate();
          paintMarkers();
          updateStats();
          say("<b>retention.ms = " + v + " " + dayWord(v) + ".</b> " +
            (n ? L("Правило поменялось задним числом: мгновенно оказалось просрочено ",
                   "The rule changed retroactively: ") + n + " " + recWord(n) +
                 L(" — уезжают из лога.", " went out of date on the spot — straight out of the log.")
               : L("Под снос пока ничего не попало — самая старая запись моложе срока.",
                   "Nothing falls under the axe yet — the oldest record is younger than the limit.")));
        }
      });

      var limitRange = ui.range({
        label: L("лимит", "limit"), min: 4, max: 40, value: limit, unit: L("зап", "rec"),
        onInput: function (v) {
          limit = v;
          var n = evaluate();
          paintMarkers();
          updateStats();
          say("<b>retention.bytes ≈ " + v + " " + recWord(v) + ".</b> " +
            (n ? L("Прямо сейчас вытесняется ", "Being pushed out right now: ") + n + " " + recWord(n) +
                 L(" — возраст тут ни при чём, важен только размер.",
                   " — age has nothing to do with it, only size matters.")
               : L("Лимит не исчерпан, вытеснять нечего.", "The limit is not reached yet — nothing to push out.")));
        }
      });

      var modeSeg = ui.seg([
        { value: "time", label: L("по времени", "by time") },
        { value: "size", label: L("по размеру", "by size") }
      ], "time", function (v) {
        mode = v;
        syncMode();
        var n = evaluate();
        paintMarkers();
        updateStats();
        say(v === "time"
          ? L("<b>retention.ms</b> — хранение по сроку. Запись живёт ",
              "<b>retention.ms</b> — storage by time. A record lives ") + retDays + " " + dayWord(retDays) +
            L(" и исчезает по возрасту, сколько бы места ни оставалось на диске.",
              " and then disappears by age, however much room is left on the disk.")
          : L("<b>retention.bytes</b> — хранение по размеру. Лог держит не больше ",
              "<b>retention.bytes</b> — storage by size. The log keeps no more than ") + limit + " " + recGen(limit) +
            L("; запись может умереть молодой, если позади неё насыпали слишком много. ",
              "; a record can die young if too much piled up behind it. ") +
            (n ? L("Лишнее уже помечено: ", "The excess is already marked: ") + n + " " + recWord(n) + "." : ""));
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
            L("Настройка срабатывает только в двух случаях: у группы вообще нет [[committed offset]] (она новая) " +
              "или её offset оказался вне лога. В обычной жизни она не делает ничего.",
              "This setting fires in exactly two cases: the group has no [[committed offset]] at all (it is new) " +
              "or its offset ended up outside the log. In everyday life it does nothing."));
        }
      });

      var autoTog = ui.toggle(L("время идёт само", "time runs on its own"), false, function (on) {
        if (autoId) { api.stop(autoId); autoId = null; }   // второго таймера быть не должно
        if (on) {
          autoId = api.interval(1600, tick);
          stage.hint(L("Сутки идут сами · выключи тумблер, чтобы остановить",
            "The days run on their own · flip the switch to stop"));
        } else {
          stage.hint(L("Мотай сутки и смотри, что уезжает из начала",
            "Advance the days and watch what leaves the front"));
        }
      });

      function catchUp() {
        flushDrop();                       // сначала досносим просроченное, потом двигаем закладку
        var b = baseOff(), from = slow, missed = Math.max(0, leo() - Math.max(from, b));
        var wasOor = oor;
        if (!wasOor && !missed) {                       // повторный клик: двигать нечего
          say(L("<b>Уже в конце.</b> Закладка slow-consumer стоит на offset ",
                "<b>Already at the end.</b> The slow-consumer bookmark sits at offset ") + slow +
            L(", лаг ноль — догонять нечего. Промотай сутки: продюсер снова уйдёт вперёд.",
              ", lag is zero — there is nothing to catch up with. Advance a day: the producer will run ahead again."));
          return;
        }
        clearAlert();
        slow = leo();
        paintMarkers();
        updateStats();
        strip.scrollEnd();
        term.line("        <span class=\"t-r\">slow-consumer → offset " + slow + " (seek to end)</span>");
        say(wasOor
          ? L("<b>Догнали.</b> Закладка прыгнула в конец, offset ",
              "<b>Caught up.</b> The bookmark jumped to the end, offset ") + slow +
            L(". Ошибка ушла, лаг ноль — но дыру это не лечит: стёрто с диска и потеряно навсегда ",
              ". The error is gone, lag is zero — but that does not heal the hole. Wiped from disk and lost forever: ") +
            lostTotal + " " + msgWord(lostTotal) +
            L(". Догнать можно позицию, а не данные.", ". You can catch up to a position, not to the data.")
          : L("<b>Догнали.</b> Закладка прыгнула с ",
              "<b>Caught up.</b> The bookmark jumped from ") + from +
            L(" в конец, offset ", " to the end, offset ") + slow + ". " +
            missed + " " + msgWord(missed) +
            L(" группа пропустила — они <b>ещё лежат</b> в логе, ",
              " skipped by the group — <b>still sitting</b> in the log, ") +
            L("просто эта группа их читать не станет. Так тушат лаг ценой пропуска.",
              "just not on this group’s reading list. That is how you make lag disappear — at the price of skipped data."));
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
        say(L("<b>Replay.</b> Закладка на самом старом уцелевшем offset ",
              "<b>Replay.</b> The bookmark is on the oldest surviving offset ") + b +
          L(" — группа перечитает весь лог заново, все ",
            " — the group will read the whole log again, all ") +
          strip.records.length + " " + recWord(strip.records.length) +
          L(". Именно [[retention]] и делает это возможным: пока запись не истекла, её можно читать сколько угодно раз. " +
            "То, что истекло, вернуть неоткуда.",
            ". [[retention]] is exactly what makes this possible: until a record expires, you can read it as many times as you like. " +
            "Once it has expired, there is nowhere to get it back from."));
      }

      function applyReset() {
        flushDrop();
        if (!oor) {
          say(L("Сейчас закладка внутри лога, читать можно — <code>auto.offset.reset</code> молчит. " +
                "Он вмешивается, только когда offset оказался вне лога или у группы его вовсе нет.",
                "Right now the bookmark is inside the log and reading works — <code>auto.offset.reset</code> stays quiet. " +
                "It steps in only when the offset has ended up outside the log, or the group has none at all."));
          return;
        }
        var b = baseOff(), from = slow, r = resetSel.value();
        clearAlert();
        if (r === "earliest") {
          slow = b;
          term.line("        <span class=\"t-r\">auto.offset.reset=earliest → offset " + b + "</span>");
          say(L("<b>earliest.</b> Клиент начал с самого старого уцелевшего offset ",
                "<b>earliest.</b> The client started from the oldest surviving offset ") + b + ". " +
            L("Дыра в ", "A hole of ") + (b - from) + " " + msgWord(b - from) +
            L(" осталась навсегда, но приложение об этом <b>не узнает</b>: ни ошибки, ни строчки в логе — " +
              "просто в данных не хватает куска.",
              " is there forever, but the application will <b>never know</b>: no error, not a line in the log — " +
              "a chunk of the data is simply missing."));
        } else {
          var extra = leo() - b;
          slow = leo();
          term.line("        <span class=\"t-r\">auto.offset.reset=latest → offset " + slow + "</span>");
          say(L("<b>latest.</b> Клиент прыгнул в конец, offset ",
                "<b>latest.</b> The client jumped to the end, offset ") + slow +
            L(". Кроме потерянных навсегда (", ". On top of the ones lost forever (") +
            (b - from) + L("), группа пропустит ещё ", "), the group will skip another ") + extra + " " + msgWord(extra) +
            L(" — они лежат в логе целыми, но прочитаны не будут. <b>latest на проде почти всегда ошибка.</b>",
              " — still intact in the log, and never to be read. " +
              "<b>latest in production is almost always a mistake.</b>"));
        }
        paintMarkers();
        updateStats();
      }

      /* ================= старт ================= */

      /** Словами — правило, которое действует прямо сейчас. */
      function ruleText() {
        return mode === "time"
          ? L("не старше ", "no older than ") + retDays + " " + dayGen(retDays)
          : L("не больше ", "no more than ") + limit + " " + recGen(limit);
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
        term.line("<span class=\"t-dim\">// " +
          L("журнал чистильщика, партиция orders-0", "cleaner journal, partition orders-0") + "</span>");
        term.line("<span class=\"t-dim\">" + L("день ", "day ") + day + " · " + strip.records.length + " " +
          recWord(strip.records.length) + ", offsets " + baseOff() + "…" + (leo() - 1) +
          " · offsets 0…" + (START - 1) + L(" съедены раньше", " were eaten earlier") + "</span>");

        say(L("Лог живёт седьмые сутки. Цифра в клетке — <b>возраст записи в днях</b>. " +
              "Группа <b>reports</b> успевает и стоит в конце; группа <b>slow-consumer</b> ползёт по одной записи в сутки " +
              "и уже отстала на ",
              "The log is on its seventh day. The number in a cell is the <b>age of the record in days</b>. " +
              "Group <b>reports</b> keeps up and stands at the end; group <b>slow-consumer</b> crawls one record a day " +
              "and is already behind by ") + (leo() - slow) + " " + msgWord(leo() - slow) + ". " +
          (doomed
            ? L("Действующее правило (", "The current rule (") + ruleText() +
              L(") накрыло сразу ", ") caught ") + doomed + " " + recWord(doomed) +
              L(" — они выцвели и сейчас уедут из лога. ",
                " straight away — faded out and about to leave the log. ")
            : "") +
          L("Мотай сутки: продюсер дописывает, чистильщик сносит старое — и смотри, кто кого обгонит.",
            "Advance the days: the producer appends, the cleaner takes out the old — and see who outruns whom."));

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
          { color: "var(--k0)", label: L("запись · цвет — по ключу события, цифра = возраст в днях",
              "record · the colour comes from the event key, the number is the age in days") },
          { color: "var(--faint)", label: L("выцвела = просрочена, сейчас уедет",
              "faded = expired, about to leave") },
          { color: "var(--read)", label: L("закладка reports", "reports bookmark") },
          { color: "var(--k3)", label: L("закладка slow-consumer", "slow-consumer bookmark") }
        ])));
      stage.body.appendChild(term.el);

      KV.append(stage.controls,
        ui.btn(L("Промотать сутки", "Advance a day"), tick, { variant: "primary" }),
        autoTog.el,
        ui.ctl(L("правило", "rule"), modeSeg.el),
        daysRange.el,
        limitRange.el,
        resetSel.el,
        ui.btn(L("Применить reset", "Apply reset"), applyReset, { sm: true, variant: "danger" }),
        ui.btn(L("Догнать", "Catch up"), catchUp, { sm: true, variant: "read" }),
        ui.btn(L("Перемотать в начало", "Rewind to the start"), rewind, { sm: true }),
        ui.btn(L("Сбросить", "Reset"), function () {
          var n = seed();
          say(L("Стенд собран заново: день 6, семь суток истории, offsets с ",
                "The demo is rebuilt: day 6, seven days of history, offsets from ") + START + ". " +
            (n
              ? L("Правило осталось прежним (", "The rule is unchanged (") + ruleText() +
                L(") и сразу накрыло ", ") and it caught ") + n + " " + recWord(n) +
                L(" — они выцвели и уезжают.", " straight away — faded out and on the way out.")
              : L("По действующему правилу (", "By the current rule (") + ruleText() +
                L(") сносить пока нечего.", ") there is nothing to take out yet.")));
        }, { sm: true, variant: "ghost" }));

      syncMode();
      seed();
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
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
        "<code>retention.bytes = 100 ГБ</code> при 12 партициях — это до 1,2 ТБ на топик, а не 100 ГБ.</p>",

        "<h3>What matters here</h3>" +
        "<p>The strip moves left at exactly the speed the producer writes on the right. No reader button changes that: " +
        "<b>reports</b> with zero lag and <b>slow-consumer</b>, which has read almost nothing, are equally non-existent " +
        "as far as the cleaner is concerned. It compares the age of a record against the limit — and that is all.</p>" +
        "<h4>Segments get deleted, not records</h4>" +
        "<p>On disk a partition is cut into segment files (<code>log.segment.bytes</code>, 1 GB by default, " +
        "or <code>segment.ms</code>, a week by default). The cleaner takes out <em>a whole closed segment</em>, and " +
        "only once its youngest record has expired. That is why the real retention is always a little longer than " +
        "the one you configured; and on top of that, the cleaner only wakes up every <code>log.retention.check.interval.ms</code> (5 minutes). " +
        "And it is the same reason Kafka simply cannot “delete one particular message”.</p>" +
        "<h4>Both rules are in force at once</h4>" +
        "<p><code>retention.ms</code> is 7 days by default, <code>retention.bytes</code> is <code>-1</code>, that is, " +
        "no limit at all. If both are set, whichever comes first wins. They are counted <b>per partition</b>: " +
        "<code>retention.bytes = 100 GB</code> across 12 partitions is up to 1.2 TB per topic, not 100 GB.</p>"
      )));

      root.appendChild(ui.note("bad", L("ловушка", "trap"), L(
        "<p><strong>Отстал сильнее, чем retention — потерял данные молча.</strong> [[committed offset]] группы " +
        "оказывается левее начала лога, клиент получает <code>OffsetOutOfRange</code> и чинит это сам по " +
        "<code>auto.offset.reset</code>: <code>earliest</code> — начнёт с самого старого уцелевшего и пропустит дыру, " +
        "<code>latest</code> — прыгнет в конец и пропустит ещё больше. Оба варианта <b>не бросают ошибку в приложение</b>. " +
        "Заметен только третий, <code>none</code>: он бросает исключение — и поэтому его стоит ставить там, " +
        "где пропуск данных дороже падения сервиса.</p>" +
        "<p>Отсюда правило мониторинга: [[lag]] в сообщениях — половина картины. Мерить надо ещё и возраст самой старой " +
        "непрочитанной записи против <code>retention.ms</code>. Лаг в два миллиона сообщений при недельном сроке — " +
        "рабочая ситуация; лаг в шесть дней при том же сроке — пожар, даже если сообщений в нём десять тысяч.</p>",

        "<p><strong>Fall further behind than retention and you lose data silently.</strong> The group’s [[committed offset]] " +
        "ends up to the left of the start of the log, the client gets <code>OffsetOutOfRange</code> and repairs it itself by " +
        "<code>auto.offset.reset</code>: <code>earliest</code> — starts from the oldest survivor and skips the hole, " +
        "<code>latest</code> — jumps to the end and skips even more. Neither of them <b>throws an error into the application</b>. " +
        "Only the third one, <code>none</code>, is visible: it throws an exception — and that is why it belongs wherever " +
        "missing data costs more than a service going down.</p>" +
        "<p>Hence the monitoring rule: [[lag]] in messages is half the picture. You also have to measure the age of the oldest " +
        "unread record against <code>retention.ms</code>. A lag of two million messages with a week of retention is " +
        "business as usual; a lag of six days with the same retention is a fire, even if it is only ten thousand messages.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "<b>Retention — это срок или размер, а не «пока не прочитают».</b> Никто не читал — удалится; все прочитали — пролежит положенное.",
          "Два правила: <code>retention.ms</code> (по умолчанию 7 дней) и <code>retention.bytes</code> (по умолчанию без лимита). Считаются на [[партиция|партицию]]; срабатывает тот, что наступит раньше.",
          "Replay живёт ровно столько, сколько [[retention]]: пока запись не истекла, перематывай [[offset]] назад и перечитывай сколько угодно.",
          "Отстал сильнее retention — <code>OffsetOutOfRange</code>, и по <code>auto.offset.reset</code> клиент <b>молча</b> начнёт с earliest или latest. Следи не только за [[lag|лагом]] в сообщениях, но и за его возрастом.",
          "Удаляются целые сегменты, а не отдельные записи. Точечно стереть сообщение по ключу — это уже [[compaction]], следующая глава."
        ],
        [
          "<b>Retention is a deadline or a size, not “until someone reads it”.</b> Nobody read it — it goes; everybody read it — it still sits out its term.",
          "Two rules: <code>retention.ms</code> (7 days by default) and <code>retention.bytes</code> (no limit by default). They are counted per [[partition]]; whichever comes first wins.",
          "Replay lives exactly as long as [[retention]]: until a record expires, rewind the [[offset]] back and re-read it as often as you like.",
          "Fall further behind than retention and you get <code>OffsetOutOfRange</code>, and by <code>auto.offset.reset</code> the client <b>silently</b> starts from earliest or latest. Watch not only the [[lag]] in messages, but its age too.",
          "Whole segments get deleted, not individual records. Erasing one message by key is already [[compaction]], the next chapter."
        ]
      )));
    }
  });
})();
