/* Глава 07 — Commit: авто и ручной. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "commit",
    num: 7,
    group: "Чтение",
    nav: "Commit: авто и ручной",
    title: "Автокоммит тихо теряет сообщения",
    lede: "Commit — это «запомни, что я дочитал до сюда». Kafka умеет ставить эту закладку сама, по таймеру, — <b>не спрашивая, закончил ли ты обработку</b>. Одно падение процесса в неудачную секунду, и сообщение исчезает: без исключения, без строчки в логе, с зелёным мониторингом.",

    build: function (root, api) {

      /* ============================================================
         1. подводка
         ============================================================ */

      root.appendChild(ui.prose(
        "<p>Позицию помнит читатель, но хранит не у себя: [[commit]] кладёт её в саму Kafka, в служебный " +
        "топик [[__consumer_offsets]]. Поэтому закладка переживает и перезапуск процесса, и [[ребаланс]], " +
        "и принадлежит не отдельной копии сервиса, а всей [[consumer group|группе]] — на каждую партицию " +
        "по одному числу.</p>" +
        "<p>Первая ловушка — арифметическая. [[committed offset]] — это номер <strong>следующего</strong> сообщения " +
        "для чтения, а не последнего обработанного. Ошибка на единицу тут не падает с исключением: " +
        "она либо тихо пропускает сообщение, либо так же тихо перечитывает его.</p>"
      ));

      /* ============================================================
         2. врезка: committed = следующий для чтения
         ============================================================ */

      var box = ui.stage({
        title: "Куда встаёт флажок",
        hint: "offsets 0…3 уже обработаны — какое число коммитить?"
      });

      var MINI_KEYS = ["клик", "заказ", "вход", "отказ", "оплата", "возврат"];
      var MDONE = 3;                 // последний обработанный offset во врезке
      var choice = MDONE + 1;

      var mini = ui.logStrip({ label: "партиция 0", sub: "топик payments", showLeo: false });

      /** Перешагнутая запись ЦЕЛА — она лежит в логе. Выцветание (.is-dropped)
       *  в этом курсе означает «записи больше нет» (глава 09), поэтому клетку
       *  не гасим, а обводим тревожным кольцом: видно, что с ней беда,
       *  но она на месте. Кольцо снимается само при перерисовке ленты. */
      function markSkipped(c) {
        if (!c) return;
        c.style.boxShadow = "0 0 0 2px var(--bad)";
        c.title = "offset 4 — запись лежит в логе, но группа её перешагнула";
      }

      function paintMini() {
        mini.setRecords(MINI_KEYS.map(function (k) { return { key: k }; }));
        for (var i = 0; i <= MDONE; i++) {
          var done = mini.cell(i);
          if (done) done.style.opacity = ".45";
        }
        var ok = choice === MDONE + 1;
        mini.marker("c", {
          at: choice,
          label: "committed " + choice,
          color: ok ? "var(--read)" : "var(--bad)"
        });

        var say;
        if (choice === MDONE) {
          var c3 = mini.cell(MDONE);
          if (c3) { c3.style.opacity = "1"; c3.classList.add("is-reading"); }
          say = "<b>Минус один.</b> Коммитить номер последнего обработанного — значит после перезапуска " +
            "начать с offset 3, который уже отработан. Тихий дубль на каждом рестарте.";
        } else if (ok) {
          var c4 = mini.cell(4);
          if (c4) c4.classList.add("is-reading");
          say = "<b>Верно.</b> Обработал до offset 3 → коммитишь <b>4</b>: «следующим дай мне четвёртый». " +
            "Флажок всегда стоит ПОСЛЕ последней обработанной клетки, а не на ней.";
        } else {
          markSkipped(mini.cell(4));
          var c5 = mini.cell(5);
          if (c5) c5.classList.add("is-reading");
          say = "<b>Плюс один.</b> Offset 4 («оплата») эта группа уже не прочитает: по закладке он «дочитан». " +
            "Запись никуда не делась — она лежит в логе, — но обработана не будет. Ни ошибки, ни следа: " +
            "сообщение просто перешагнули.";
        }
        box.say(say);
      }

      var miniSeg = ui.seg([
        { value: MDONE, label: "commit(3)" },
        { value: MDONE + 1, label: "commit(4)" },
        { value: MDONE + 2, label: "commit(5)" }
      ], choice, function (v) { choice = v; paintMini(); });

      box.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "10px" } },
        ui.badge("обработано: 0…3", "read"),
        ui.badge("формула: committed = последний обработанный + 1")));
      box.body.appendChild(mini.el);
      box.controls.appendChild(ui.ctl("коммитим", miniSeg.el));
      paintMini();
      root.appendChild(box.el);

      /* ============================================================
         3. две строки конфига
         ============================================================ */

      root.appendChild(ui.note("info", "две строки конфига",
        "<p><code>enable.auto.commit=true</code> — Kafka коммитит сама, по таймеру " +
        "<code>auto.commit.interval.ms</code> (по умолчанию 5 секунд). Твой код про коммиты не знает ничего: " +
        "таймер тикает независимо от того, доработал ли обработчик.</p>" +
        "<p><code>enable.auto.commit=false</code> — коммитишь ты, руками, <b>после</b> обработки: " +
        "<code>consumer.commitSync()</code>. Один лишний вызов, и поведение при сбое меняется на противоположное.</p>" +
        "<p>Поправка к картинке «фоновый таймер»: автокоммит выполняет сам <code>poll()</code> — очередной " +
        "вызов коммитит позицию, до которой дочитала предыдущая порция, если с прошлого коммита прошло больше " +
        "интервала. От таймера это неотличимо ровно тогда, когда обработка не держит poll-цикл: пачку отдали " +
        "в пул потоков, в очередь, в асинхронный вызов — и сразу вернулись за следующей. Именно в этом режиме " +
        "автокоммит и теряет; его и показывает стенд ниже.</p>"
      ));

      /* ============================================================
         4. главный стенд — прогон по секундам
         ============================================================ */

      var stage = ui.stage({
        title: "Сбой на 7-й секунде",
        hint: "одна секунда сценария ≈ полсекунды на экране"
      });

      var CRASH = 7;        // секунда падения процесса
      var MAXT = 10;        // длина линейки времени
      var TARGET = 4;       // offset сообщения в работе
      var LEO = 5;          // конец лога: записей 0…4

      var mode = "auto";
      var procSec = 8;      // сколько секунд занимает обработка
      var ivSec = 5;        // auto.commit.interval.ms в секундах

      var plan = null;      // текущий просчитанный сценарий
      var cursor = null;    // секунда, на которой сейчас проигрывание
      var committedNow = TARGET;
      var timerId = null;
      var running = false;

      /* ---------- модель: весь сценарий считается ДО проигрывания ---------- */

      function buildPlan() {
        var evs = [], commits = [];
        var committed = TARGET, processed = false, premature = null;

        evs.push({ t: 0, kind: "fetch" });

        for (var n = 1; n <= CRASH; n++) {
          /* 1) обработка успевает закончиться */
          if (n === procSec) { processed = true; evs.push({ t: n, kind: "done" }); }

          /* 2) тик фонового таймера автокоммита */
          if (mode === "auto" && n % ivSec === 0 && committed !== LEO) {
            var pre = !processed;
            if (pre && premature === null) premature = n;
            committed = LEO;
            commits.push({ t: n, premature: pre });
            evs.push({ t: n, kind: "commit", auto: true, premature: pre });
          }

          /* 3) процесса не стало — всё, что ниже, уже не выполнится */
          if (n === CRASH) {
            evs.push({ t: n, kind: "crash", processed: processed, saved: committed === LEO });
            break;
          }

          /* 4) ручной коммит — отдельный вызов после обработки */
          if (mode === "manual" && n === procSec) {
            committed = LEO;
            commits.push({ t: n, premature: false });
            evs.push({ t: n, kind: "commit", auto: false, premature: false });
          }
        }

        evs.push({ t: CRASH + 1, kind: "restart" });
        evs.push({ t: CRASH + 2, kind: "verdict" });

        return {
          evs: evs, commits: commits, mode: mode, proc: procSec, iv: ivSec,
          committed: committed, processed: processed, premature: premature,
          lost: committed === LEO && !processed,
          dup: committed === TARGET && processed,
          redeliver: committed === TARGET && !processed,
          clean: committed === LEO && processed
        };
      }

      /* ---------- лента партиции ---------- */

      var REC_KEYS = ["клик", "заказ", "вход", "отказ", "оплата"];
      var strip = ui.logStrip({ label: "партиция 0", sub: "топик payments", empty: "лог пуст" });

      function freshRecords() {
        return REC_KEYS.map(function (k, i) {
          return { key: k, title: "offset " + i + " · " + k + (i === TARGET ? " 12 400 ₽" : "") };
        });
      }

      /* ---------- узел консьюмера, часы, показатели ---------- */

      var consumer = ui.node("consumer", "payments-svc", "группа billing");
      var badges = el("div.kv-row", { style: { "margin-left": "auto" } });

      var clockStat = ui.stat("секунда", "—");
      var commStat = ui.stat("committed", TARGET, { tone: "read" });
      var lagStat = ui.stat("lag", LEO - TARGET);
      var stateStat = ui.stat("консьюмер", "ждёт");

      /* ---------- линейка времени ---------- */

      var tlCells = [];
      var tlRow = el("div", {
        style: { display: "flex", gap: "3px", "align-items": "flex-end", "min-width": "min-content" }
      });

      for (var ti = 0; ti <= MAXT; ti++) {
        (function (i) {
          var mark = el("div", {
            style: {
              height: "13px", "line-height": "13px", "text-align": "center",
              "font-family": "var(--f-mono)", "font-size": "10px", color: "var(--faint)"
            }
          });
          var cell = el("div", {
            style: {
              width: "30px", height: "26px", "border-radius": "var(--r-sm)",
              border: "1px solid var(--line)", background: "var(--surface-2)",
              display: "flex", "align-items": "center", "justify-content": "center",
              "font-family": "var(--f-mono)", "font-size": "12px", color: "var(--muted)"
            }
          });
          var num = el("div", {
            text: String(i),
            style: {
              "text-align": "center", "margin-top": "3px",
              "font-family": "var(--f-mono)", "font-size": "9.5px", color: "var(--faint)"
            }
          });
          tlCells.push({ mark: mark, cell: cell, i: i });
          tlRow.appendChild(el("div", { style: { width: "30px", flex: "none" } }, mark, cell, num));
        })(ti);
      }

      function paintTimeline() {
        var p = plan;
        tlCells.forEach(function (c) {
          var i = c.i;
          var bg = "var(--surface-2)", bd = "solid 1px var(--line)", fg = "var(--muted)";
          var txt = "", tip = "секунда " + i + " — ничего не происходит", op = "1";

          if (i <= CRASH && i < p.proc) {
            bg = "var(--write-soft)"; bd = "solid 1px var(--write)"; fg = "var(--write)";
            txt = "·"; tip = "секунда " + i + " — обработка идёт";
          }
          if (p.premature !== null && i >= p.premature && i < p.proc && i <= CRASH) {
            bg = "var(--bad-soft)"; bd = "solid 1px var(--bad)"; fg = "var(--bad)";
            txt = "!"; tip = "секунда " + i + " — окно риска: коммит уже сделан, обработка ещё нет";
          }
          if (i === p.proc && p.proc <= CRASH) {
            bg = "var(--good-soft)"; bd = "solid 1px var(--good)"; fg = "var(--good)";
            txt = "✓"; tip = "секунда " + i + " — обработка завершена";
          }
          if (i > CRASH && i <= p.proc) {
            bg = "var(--surface-2)"; bd = "dashed 1px var(--line)"; fg = "var(--faint)";
            txt = "·"; op = ".45";
            tip = "секунда " + i + " — обработка закончилась бы здесь, но процесса уже нет";
          }
          if (i === CRASH) {
            bg = "var(--bad-soft)"; bd = "solid 1px var(--bad)"; fg = "var(--bad)";
            txt = "×"; op = "1"; tip = "секунда " + CRASH + " — процесс упал";
          }
          if (i === CRASH + 1) {
            bg = "var(--read-soft)"; bd = "solid 1px var(--read)"; fg = "var(--read)";
            txt = "↻"; op = "1"; tip = "секунда " + (CRASH + 1) + " — перезапуск, читаем с committed";
          }

          c.mark.textContent = "";
          c.mark.removeAttribute("title");
          p.commits.forEach(function (cm) {
            if (cm.t !== i) return;
            c.mark.textContent = "▲";
            c.mark.style.color = cm.premature ? "var(--bad)" : "var(--read)";
            c.mark.setAttribute("title", cm.premature
              ? "коммит раньше времени: обработка ещё не закончилась"
              : "коммит после обработки");
          });

          if (cursor !== null && i > cursor) op = ".2";

          c.cell.style.background = bg;
          c.cell.style.border = bd;
          c.cell.style.color = fg;
          c.cell.style.opacity = op;
          c.cell.textContent = txt;
          c.cell.setAttribute("title", tip);
          c.mark.style.opacity = op;
        });
      }

      /* ---------- журнал ---------- */

      var term = ui.terminal("");

      function sec(n) { return '<span class="t-dim">сек ' + n + (n < 10 ? " " : "") + '</span> ';  }

      /* ---------- показатели ---------- */

      function paintStats() {
        commStat.set(committedNow, committedNow === LEO && plan.lost ? "bad" : "read");
        var lag = LEO - committedNow;
        lagStat.set(lag, lag === 0 ? "good" : null);
      }

      function setBadges() {
        KV.clear(badges);
        for (var i = 0; i < arguments.length; i++) badges.appendChild(arguments[i]);
      }

      function ring(on) {
        var c = strip.cell(TARGET);
        if (!c) return;
        if (on) c.classList.add("is-reading"); else c.classList.remove("is-reading");
      }

      /* ---------- сброс ---------- */

      function reset(silent) {
        if (timerId) { api.stop(timerId); timerId = null; }
        running = false;
        runBtn.disabled = false;
        cursor = null;
        committedNow = TARGET;
        plan = buildPlan();

        strip.setRecords(freshRecords());
        strip.marker("committed", { at: TARGET, label: "committed " + TARGET, color: "var(--read)" });
        consumer.classList.remove("kv-node--dead");

        clockStat.set("—");
        stateStat.set("ждёт", null);
        paintStats();
        paintTimeline();
        setBadges(ui.badge("offsets 0…3 обработаны и закоммичены"));

        term.clear();
        term.line('<span class="t-dim">консьюмер payments-svc · группа billing · партиция 0</span>');
        term.line('<span class="t-dim">committed = ' + TARGET + ' · в логе ' + LEO + " " +
          util.plural(LEO, "запись", "записи", "записей") + ' (LEO ' + LEO + ') · lag = ' + (LEO - TARGET) + '</span>');
        term.line('<span class="t-dim">' + (mode === "auto"
          ? "enable.auto.commit=true · auto.commit.interval.ms=" + ivSec + "000"
          : "enable.auto.commit=false · commitSync() после обработки") + '</span>');

        if (!silent) forecast();
      }

      /* ---------- прогноз до запуска ---------- */

      function forecast() {
        var p = plan, s;
        if (p.mode === "auto") {
          if (p.premature !== null) {
            s = "обработка (" + p.proc + " с) длиннее интервала автокоммита (" + p.iv + " с), поэтому коммит на " +
              p.premature + "-й секунде обгонит работу. Окно риска — с " + p.premature + "-й по " + p.proc +
              "-ю секунду; сбой на " + CRASH + "-й " + (CRASH >= p.premature && CRASH < p.proc ? "<b>попадает</b>" : "не попадает") +
              " в него.";
          } else if (p.iv > CRASH) {
            s = "первый тик автокоммита — только на " + p.iv + "-й секунде, а процесс умрёт на " + CRASH +
              "-й: закладка не сдвинется вовсе.";
          } else {
            s = "обработка (" + p.proc + " с) не длиннее интервала автокоммита (" + p.iv + " с) — коммит ни разу " +
              "не обгонит работу. Автокоммит здесь безопасен.";
          }
        } else {
          s = "закладка сдвинется только после конца обработки, на " + p.proc + "-й секунде" +
            (p.proc >= CRASH ? ", то есть уже никогда: сбой на " + CRASH + "-й придёт раньше." : ".");
        }
        stage.say("<b>Прогноз.</b> " + s + " Жми «Прогнать со сбоем на " + CRASH + "-й секунде» и следи за флажком committed.");
      }

      /* ---------- проигрывание ---------- */

      function apply(e) {
        if (e.kind === "fetch") {
          ring(true);
          stateStat.set("обработка", "write");
          term.line(sec(0) + 'poll() вернул <span class="t-w">offset 4</span> («оплата», 12 400 ₽) · ' +
            'обработка началась, ей нужно ' + plan.proc + ' с');
          term.line(sec(0) + '<span class="t-dim">позиция консьюмера в памяти = 5, но в Kafka пока committed = 4</span>');
          return;
        }
        if (e.kind === "done") {
          ring(false);
          stateStat.set("свободен", null);
          term.line(sec(e.t) + '<span class="t-good">обработка завершена</span>: платёж записан в базу');
          return;
        }
        if (e.kind === "commit") {
          committedNow = LEO;
          strip.marker("committed", {
            at: LEO, label: "committed " + LEO,
            color: e.premature ? "var(--bad)" : "var(--read)"
          });
          if (e.auto && e.premature) {
            term.line(sec(e.t) + '<span class="t-bad">АВТОКОММИТ по таймеру → committed = 5</span> · ' +
              'обработка ЕЩЁ ИДЁТ, Kafka об этом не знает');
          } else if (e.auto) {
            term.line(sec(e.t) + '<span class="t-r">автокоммит по таймеру → committed = 5</span> · ' +
              'обработка уже закончилась, коммит честный');
          } else {
            term.line(sec(e.t) + '<span class="t-r">commitSync(5) подтверждён → committed = 5</span> · ' +
              'сначала работа, потом закладка');
          }
          return;
        }
        if (e.kind === "crash") {
          ring(false);
          consumer.classList.add("kv-node--dead");
          stateStat.set("упал", "bad");
          term.line(sec(e.t) + '<span class="t-bad">ПРОЦЕСС УПАЛ</span> · ' + (!e.processed
            ? 'обработка не завершена — она была на ' + e.t + '-й из ' + plan.proc + ' с'
            : e.saved
              ? 'обработка завершена и закоммичена — этот сбой безобиден'
              : 'обработка завершена, но коммит уйти не успел'));
          setBadges(ui.badge("процесс упал", "bad"));
          return;
        }
        if (e.kind === "restart") {
          consumer.classList.remove("kv-node--dead");
          stateStat.set("поднялся", "read");
          term.line(sec(e.t) + '<span class="t-r">консьюмер поднялся</span> · poll() читает с committed = ' + committedNow);
          if (plan.lost) {
            markSkipped(strip.cell(TARGET));
            setBadges(ui.badge("offset 4 перешагнули — запись цела", "bad"), ui.badge("lag = 0", "good"));
            term.line(sec(e.t) + '<span class="t-bad">offset 4 пропущен</span>: по закладке он «дочитан», ' +
              'а обработан не был');
            term.line(sec(e.t) + '<span class="t-dim">исключений нет · lag = 0 · мониторинг зелёный</span>');
          } else if (plan.dup) {
            ring(true);
            setBadges(ui.badge("offset 4 обработан дважды", "warn"));
            term.line(sec(e.t) + '<span class="t-w">offset 4 читается снова</span> · платёж уже был в базе → ' +
              'обработка повторная');
          } else if (plan.redeliver) {
            ring(true);
            setBadges(ui.badge("offset 4 перечитан заново", "read"));
            term.line(sec(e.t) + '<span class="t-r">offset 4 читается снова</span> · его обработка не была ' +
              'закончена, повторная доставка корректна');
          } else {
            setBadges(ui.badge("ничего не потеряно", "good"));
            term.line(sec(e.t) + '<span class="t-good">читать нечего</span>: offset 4 обработан и закоммичен ' +
              'до сбоя');
          }
          paintStats();
          return;
        }
        if (e.kind === "verdict") {
          if (plan.lost) stateStat.set("потеря", "bad");
          else if (plan.dup) stateStat.set("дубль", "warn");
          else stateStat.set("цел", "good");
          if (plan.dup || plan.redeliver) {
            ring(false);
            term.line(sec(e.t) + '<span class="t-good">offset 4 обработан</span> → commit(5) → committed = 5');
            committedNow = LEO;
            strip.marker("committed", { at: LEO, label: "committed " + LEO, color: "var(--read)" });
            paintStats();
          }
          stage.say(verdict());
        }
      }

      function idle(n) {
        if (n > CRASH) return;
        if (n < plan.proc) {
          term.line(sec(n) + '<span class="t-dim">обработка идёт (' + n + ' из ' + plan.proc + ' с)</span>');
        } else {
          term.line(sec(n) + '<span class="t-dim">обработчик свободен, новых сообщений нет</span>');
        }
      }

      function step(n) {
        cursor = n;
        clockStat.set(n);
        var acted = false;
        plan.evs.forEach(function (e) { if (e.t === n) { acted = true; apply(e); } });
        if (!acted) idle(n);
        paintTimeline();
        paintStats();
      }

      function run() {
        if (running) return;
        reset(true);
        running = true;
        runBtn.disabled = true;
        step(0);
        var n = 0;
        timerId = api.interval(api.reduced ? 300 : 520, function () {
          n++;
          step(n);
          if (n >= CRASH + 2) {
            api.stop(timerId); timerId = null;
            running = false; runBtn.disabled = false;
          }
        });
      }

      /* ---------- вердикт ---------- */

      function verdict() {
        var p = plan;
        if (p.mode === "auto") {
          if (p.lost) {
            return "<b>offset 4 ПОТЕРЯН.</b> Автокоммит сработал на " + p.premature + "-й секунде и записал " +
              "<code>committed = 5</code> — «дочитано до пятого», — хотя обработка платежа шла и не закончилась. " +
              "На " + CRASH + "-й процесса не стало, на " + (CRASH + 1) + "-й он поднялся и честно читает с 5-го. " +
              "Offset 4 не удалён — он лежит в логе до конца retention, — но эта группа его уже не прочитает. " +
              "Исключений не было, в логе чисто, <b>lag = 0</b> — " +
              "в мониторинге всё зелено. Это и есть «автокоммит тихо превращает at-least-once в at-most-once».";
          }
          if (p.premature !== null) {
            return "<b>Пронесло — но случайно.</b> Коммит на " + p.premature + "-й секунде обогнал обработку: " +
              "окно риска — с " + p.premature + "-й по " + p.proc + "-ю секунду. Сбой пришёлся на " + CRASH +
              "-ю, когда обработка уже закончилась, и сообщение уцелело. Сделай обработку длиннее " + CRASH +
              " с — сбой попадёт внутрь окна, и платёж исчезнет.";
          }
          if (p.clean) {
            return "<b>Чисто, и не случайно.</b> Обработка (" + p.proc + " с) не длиннее интервала автокоммита (" +
              p.iv + " с), поэтому таймер ни разу не тикнул внутри незаконченной работы: коммит на " +
              p.commits[0].t + "-й секунде закрепил уже сделанное. Автокоммит опасен не сам по себе — " +
              "опасно, когда обработка длиннее интервала.";
          }
          if (p.dup) {
            return "<b>Дубль, но не потеря.</b> Автокоммит не успел сработать ни разу: первый тик — на " + p.iv +
              "-й секунде, а процесс умер на " + CRASH + "-й. committed остался 4, offset 4 перечитан и обработан " +
              "<b>второй раз</b>. Автокоммит спасла собственная медлительность, а не правильность: " +
              "поставь интервал 5 с при обработке в 9 — и получишь потерю.";
          }
          return "<b>Потери нет.</b> Автокоммит не успел сработать (первый тик — на " + p.iv + "-й секунде, сбой — на " +
            CRASH + "-й), обработка тоже не закончилась. committed остался 4, offset 4 перечитан с нуля. " +
            "Повезло дважды — сделай интервал меньше времени обработки и посмотри снова.";
        }
        if (p.dup) {
          return "<b>Дубль, но НЕ потеря.</b> Обработка закончилась на " + p.proc + "-й секунде — платёж уже в базе, — " +
            "а <code>commitSync(5)</code> уйти не успел: процесс умер в зазоре между «сделал» и «запомнил, что сделал». " +
            "После подъёма offset 4 читается снова и обрабатывается повторно. Этот зазор не закрывается ничем — " +
            "поэтому обработчик обязан быть идемпотентным.";
        }
        if (p.redeliver) {
          return "<b>offset 4 перечитан заново: потери нет.</b> Обработка не успела закончиться, коммита не было — " +
            "после подъёма сообщение читается с нуля. Сбой тот же и в ту же секунду, что и при автокоммите, " +
            "а платёж цел. Цена — возможный дубль: поставь обработку ровно " + CRASH + " с, и сбой попадёт " +
            "между концом обработки и коммитом.";
        }
        return "<b>Чисто.</b> Обработка закончилась на " + p.proc + "-й секунде, <code>commitSync(5)</code> прошёл " +
          "сразу за ней, сбой на " + CRASH + "-й уже ничего не решает. Ручной коммит всегда идёт ПОСЛЕ работы — " +
          "поэтому закладка физически не может обогнать обработку.";
      }

      /* ---------- контролы ---------- */

      var modeSeg = ui.seg([
        { value: "auto", label: "автокоммит" },
        { value: "manual", label: "ручной коммит" }
      ], mode, function (v) {
        mode = v;
        ivRange.el.style.opacity = v === "auto" ? "1" : ".4";
        ivRange.input.disabled = v !== "auto";
        reset();
      });

      var procRange = ui.range({
        label: "обработка", min: 1, max: 10, value: procSec, unit: "с",
        onInput: function (v) { procSec = v; reset(); }
      });

      var ivRange = ui.range({
        label: "auto.commit.interval", min: 1, max: 10, value: ivSec, unit: "с",
        onInput: function (v) { ivSec = v; reset(); }
      });

      var runBtn = ui.btn("Прогнать со сбоем на " + CRASH + "-й секунде", run, { variant: "primary" });

      KV.append(stage.controls,
        modeSeg.el,
        procRange.el,
        ivRange.el,
        runBtn,
        ui.btn("Сброс", function () { reset(); }, { variant: "ghost", sm: true }));

      /* ---------- сборка стенда ---------- */

      stage.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "12px" } }, consumer, badges));
      stage.body.appendChild(strip.el);
      stage.body.appendChild(el("div.kv-stats", { style: { "margin-top": "6px" } },
        clockStat.el, commStat.el, lagStat.el, stateStat.el));
      stage.body.appendChild(el("div.kv-panel", { style: { "margin-top": "14px" } },
        el("div.kv-panel__t", { text: "линейка времени · секунды" }),
        el("div", { style: { "overflow-x": "auto", "padding-bottom": "2px" } }, tlRow),
        el("div", { style: { "margin-top": "10px" } }, ui.legend([
          { color: "var(--write)", label: "обработка идёт" },
          { color: "var(--bad)", label: "окно риска: коммит сделан, обработка — нет" },
          { color: "var(--read)", label: "▲ коммит" },
          { color: "var(--good)", label: "обработка завершена" }
        ]))));
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } }, term.el));

      reset();
      root.appendChild(stage.el);

      /* ============================================================
         5. разбор
         ============================================================ */

      root.appendChild(ui.prose(
        "<h3>Почему потеря беззвучная</h3>" +
        "<p>Разбери сценарий по умолчанию посекундно. <em>Секунда 0</em> — консьюмер получил offset 4 и начал " +
        "обработку. <em>Секунда 5</em> — тикнул таймер автокоммита и записал <code>committed = 5</code>; " +
        "он не спрашивал обработчик, он спрашивал часы. <em>Секунда 7</em> — процесс умер, работа не доделана. " +
        "<em>Секунда 8</em> — поднялись, читаем со следующего. Сообщения нет.</p>" +
        "<p>Ни одна из этих четырёх секунд не выглядит как ошибка. Нет исключения, нет упавшего запроса, " +
        "[[lag]] после перезапуска равен нулю — по всем приборам группа дочитала топик. " +
        "Дефект виден только там, где его никто не мерит: в базе нет платежа.</p>" +
        "<h4>Условие, а не приговор</h4>" +
        "<p>Автокоммит опасен не всегда. Опасно ровно одно сочетание: <strong>коммит успел, обработка — нет, " +
        "и в этот промежуток пришёл сбой</strong>. Поставь на стенде обработку короче интервала — окно риска " +
        "исчезнет вовсе. Именно поэтому «выключите автокоммит» — плохой ответ на собеседовании, " +
        "а «автокоммит коммитит по таймеру, а не по факту обработки» — хороший.</p>" +
        "<p>При ручном коммите тот же сбой в тот же момент даёт не потерю, а <strong>дубль</strong>: сообщение " +
        "перечитается и обработается повторно. Это и есть [[at-least-once]] — базовая гарантия Kafka. " +
        "Зазор между «записал в базу» и «закоммитил» не закрывается ничем, поэтому обработчик " +
        "обязан быть [[идемпотентность|идемпотентным]]: проверять id сообщения и молча пропускать уже сделанное.</p>"
      ));

      root.appendChild(ui.note("bad", "формулировка",
        "<p><strong>Автокоммит тихо превращает at-least-once в at-most-once при падении.</strong> " +
        "Ручной коммит после обработки оставляет at-least-once — потерь нет, дубли есть, " +
        "и с ними разбирается [[идемпотентность|идемпотентный]] обработчик.</p>"
      ));

      root.appendChild(ui.takeaway([
        "[[committed offset]] — номер <b>следующего</b> сообщения, а не последнего обработанного. Дочитал до 3 — коммить 4.",
        "Автокоммит коммитит <b>по таймеру</b>, а не по факту обработки. Обработка дольше <code>auto.commit.interval.ms</code> — появляется окно, в котором закладка уже сдвинута, а работа ещё идёт.",
        "Падение внутри этого окна = <b>потеря без следов</b>: исключений нет, [[lag]] нулевой, мониторинг зелёный.",
        "Ручной коммит после обработки меняет потерю на <b>дубль</b>: это [[at-least-once]], и обработчик обязан быть [[идемпотентность|идемпотентным]].",
        "Зазор между «сделал работу» и «закоммитил» есть всегда — гарантии строятся не на его отсутствии, а на идемпотентности."
      ]));
    }
  });
})();
