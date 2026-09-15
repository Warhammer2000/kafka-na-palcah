/* Глава 07 — Commit: авто и ручной. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "commit",
    num: 7,
    group: ["Чтение", "Reading"],
    nav: ["Commit: авто и ручной", "Commit: auto and manual"],
    title: ["Автокоммит тихо теряет сообщения", "Auto-commit quietly loses messages"],
    lede: [
      "Commit — это «запомни, что я дочитал до сюда». Kafka умеет ставить эту закладку сама, по таймеру, — <b>не спрашивая, закончил ли ты обработку</b>. Одно падение процесса в неудачную секунду, и сообщение исчезает: без исключения, без строчки в логе, с зелёным мониторингом.",
      "A commit says “remember that I have read up to here”. Kafka can place that bookmark for you, on a timer — <b>without ever asking whether you have finished processing</b>. One process crash in the wrong second and the message is gone: no exception, no line in the log, monitoring all green."
    ],

    build: function (root, api) {

      /* ============================================================
         1. подводка
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<p>Позицию помнит читатель, но хранит не у себя: [[commit]] кладёт её в саму Kafka, в служебный " +
        "топик [[__consumer_offsets]]. Поэтому закладка переживает и перезапуск процесса, и [[ребаланс]], " +
        "и принадлежит не отдельной копии сервиса, а всей [[consumer group|группе]] — на каждую партицию " +
        "по одному числу.</p>" +
        "<p>Первая ловушка — арифметическая. [[committed offset]] — это номер <strong>следующего</strong> сообщения " +
        "для чтения, а не последнего обработанного. Ошибка на единицу тут не падает с исключением: " +
        "она либо тихо пропускает сообщение, либо так же тихо перечитывает его.</p>",

        "<p>The reader remembers its position, but does not keep it at home: a [[commit]] puts it into Kafka " +
        "itself, into the internal [[__consumer_offsets]] topic. That is why the bookmark survives a process " +
        "restart and a [[rebalance]], and belongs not to one copy of the service but to the whole " +
        "[[consumer group|group]] — one number per partition.</p>" +
        "<p>The first trap is arithmetic. A [[committed offset]] is the number of the <strong>next</strong> " +
        "message to read, not of the last one processed. An off-by-one here does not blow up with an exception: " +
        "it either quietly skips a message or just as quietly re-reads it.</p>"
      )));

      /* ============================================================
         2. врезка: committed = следующий для чтения
         ============================================================ */

      var box = ui.stage({
        title: L("Куда встаёт флажок", "Where the flag goes"),
        hint: L("offsets 0…3 уже обработаны — какое число коммитить?",
          "offsets 0…3 are already processed — which number do you commit?")
      });

      var MINI_KEYS = L(
        ["клик", "заказ", "вход", "отказ", "оплата", "возврат"],
        ["click", "order", "login", "reject", "payment", "refund"]
      );
      var MDONE = 3;                 // последний обработанный offset во врезке
      var choice = MDONE + 1;

      var mini = ui.logStrip({
        label: L("партиция 0", "partition 0"),
        sub: L("топик payments", "topic payments"),
        showLeo: false
      });

      /** Перешагнутая запись ЦЕЛА — она лежит в логе. Выцветание (.is-dropped)
       *  в этом курсе означает «записи больше нет» (глава 09), поэтому клетку
       *  не гасим, а обводим тревожным кольцом: видно, что с ней беда,
       *  но она на месте. Кольцо снимается само при перерисовке ленты. */
      function markSkipped(c) {
        if (!c) return;
        c.style.boxShadow = "0 0 0 2px var(--bad)";
        c.title = L("offset 4 — запись лежит в логе, но группа её перешагнула",
          "offset 4 — the record is in the log, but the group stepped over it");
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
          say = L(
            "<b>Минус один.</b> Коммитить номер последнего обработанного — значит после перезапуска " +
            "начать с offset 3, который уже отработан. Тихий дубль на каждом рестарте.",

            "<b>One too low.</b> Committing the number of the last record you processed means that after a " +
            "restart you begin at offset 3, which is already done. A quiet duplicate on every restart."
          );
        } else if (ok) {
          var c4 = mini.cell(4);
          if (c4) c4.classList.add("is-reading");
          say = L(
            "<b>Верно.</b> Обработал до offset 3 → коммитишь <b>4</b>: «следующим дай мне четвёртый». " +
            "Флажок всегда стоит ПОСЛЕ последней обработанной клетки, а не на ней.",

            "<b>Right.</b> Processed up to offset 3 → you commit <b>4</b>: “give me the fourth one next”. " +
            "The flag always stands AFTER the last processed cell, never on it."
          );
        } else {
          markSkipped(mini.cell(4));
          var c5 = mini.cell(5);
          if (c5) c5.classList.add("is-reading");
          say = L(
            "<b>Плюс один.</b> Offset 4 («оплата») эта группа уже не прочитает: по закладке он «дочитан». " +
            "Запись никуда не делась — она лежит в логе, — но обработана не будет. Ни ошибки, ни следа: " +
            "сообщение просто перешагнули.",

            "<b>One too high.</b> This group will never read offset 4 (“payment”): the bookmark says it is " +
            "already read. The record has not gone anywhere — it is right there in the log — but it will " +
            "never be processed. No error, no trace: the message was simply stepped over."
          );
        }
        box.say(say);
      }

      var miniSeg = ui.seg([
        { value: MDONE, label: "commit(3)" },
        { value: MDONE + 1, label: "commit(4)" },
        { value: MDONE + 2, label: "commit(5)" }
      ], choice, function (v) { choice = v; paintMini(); });

      box.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "10px" } },
        ui.badge(L("обработано: 0…3", "processed: 0…3"), "read"),
        ui.badge(L("формула: committed = последний обработанный + 1",
          "formula: committed = last processed + 1"))));
      box.body.appendChild(mini.el);
      box.controls.appendChild(ui.ctl(L("коммитим", "we commit"), miniSeg.el));
      paintMini();
      root.appendChild(box.el);

      /* ============================================================
         3. две строки конфига
         ============================================================ */

      root.appendChild(ui.note("info", L("две строки конфига", "two config lines"), L(
        "<p><code>enable.auto.commit=true</code> — Kafka коммитит сама, по таймеру " +
        "<code>auto.commit.interval.ms</code> (по умолчанию 5 секунд). Твой код про коммиты не знает ничего: " +
        "таймер тикает независимо от того, доработал ли обработчик.</p>" +
        "<p><code>enable.auto.commit=false</code> — коммитишь ты, руками, <b>после</b> обработки: " +
        "<code>consumer.commitSync()</code>. Один лишний вызов, и поведение при сбое меняется на противоположное.</p>" +
        "<p>Поправка к картинке «фоновый таймер»: автокоммит выполняет сам <code>poll()</code> — очередной " +
        "вызов коммитит позицию, до которой дочитала предыдущая порция, если с прошлого коммита прошло больше " +
        "интервала. От таймера это неотличимо ровно тогда, когда обработка не держит poll-цикл: пачку отдали " +
        "в пул потоков, в очередь, в асинхронный вызов — и сразу вернулись за следующей. Именно в этом режиме " +
        "автокоммит и теряет; его и показывает стенд ниже.</p>",

        "<p><code>enable.auto.commit=true</code> — Kafka commits by itself, on the " +
        "<code>auto.commit.interval.ms</code> timer (5 seconds by default). Your code knows nothing about " +
        "commits: the timer ticks whether or not the handler has finished.</p>" +
        "<p><code>enable.auto.commit=false</code> — you commit, by hand, <b>after</b> processing: " +
        "<code>consumer.commitSync()</code>. One extra call, and the behaviour on a crash flips to the opposite.</p>" +
        "<p>A correction to that “background timer” picture: the auto-commit is done by <code>poll()</code> " +
        "itself — the next call commits the position the previous batch read up to, if more than the interval " +
        "has passed since the last commit. That is indistinguishable from a timer exactly when processing does " +
        "not hold up the poll loop: the batch goes off to a thread pool, to a queue, to an async call — and you " +
        "come straight back for the next one. That is the mode in which auto-commit loses, and that is the mode " +
        "the demo below shows.</p>"
      )));

      /* ============================================================
         4. главный стенд — прогон по секундам
         ============================================================ */

      var stage = ui.stage({
        title: L("Сбой на 7-й секунде", "A crash in second 7"),
        hint: L("одна секунда сценария ≈ полсекунды на экране",
          "one second of the scenario ≈ half a second on screen")
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

      var REC_KEYS = L(
        ["клик", "заказ", "вход", "отказ", "оплата"],
        ["click", "order", "login", "reject", "payment"]
      );
      var strip = ui.logStrip({
        label: L("партиция 0", "partition 0"),
        sub: L("топик payments", "topic payments"),
        empty: L("лог пуст", "the log is empty")
      });

      function freshRecords() {
        return REC_KEYS.map(function (k, i) {
          return { key: k, title: "offset " + i + " · " + k + (i === TARGET ? " 12 400 ₽" : "") };
        });
      }

      /* ---------- узел консьюмера, часы, показатели ---------- */

      var consumer = ui.node("consumer", "payments-svc", L("группа billing", "billing group"));
      var badges = el("div.kv-row", { style: { "margin-left": "auto" } });

      var clockStat = ui.stat(L("секунда", "second"), "—");
      var commStat = ui.stat("committed", TARGET, { tone: "read" });
      var lagStat = ui.stat("lag", LEO - TARGET);
      var stateStat = ui.stat(L("консьюмер", "consumer"), L("ждёт", "waiting"));

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
          var sc = L("секунда ", "second ");
          var txt = "", tip = sc + i + L(" — ничего не происходит", " — nothing happens"), op = "1";

          if (i <= CRASH && i < p.proc) {
            bg = "var(--write-soft)"; bd = "solid 1px var(--write)"; fg = "var(--write)";
            txt = "·"; tip = sc + i + L(" — обработка идёт", " — processing is running");
          }
          if (p.premature !== null && i >= p.premature && i < p.proc && i <= CRASH) {
            bg = "var(--bad-soft)"; bd = "solid 1px var(--bad)"; fg = "var(--bad)";
            txt = "!"; tip = sc + i + L(" — окно риска: коммит уже сделан, обработка ещё нет",
              " — the risk window: the commit is already done, the processing is not");
          }
          if (i === p.proc && p.proc <= CRASH) {
            bg = "var(--good-soft)"; bd = "solid 1px var(--good)"; fg = "var(--good)";
            txt = "✓"; tip = sc + i + L(" — обработка завершена", " — processing finished");
          }
          if (i > CRASH && i <= p.proc) {
            bg = "var(--surface-2)"; bd = "dashed 1px var(--line)"; fg = "var(--faint)";
            txt = "·"; op = ".45";
            tip = sc + i + L(" — обработка закончилась бы здесь, но процесса уже нет",
              " — processing would have finished here, but the process is gone");
          }
          if (i === CRASH) {
            bg = "var(--bad-soft)"; bd = "solid 1px var(--bad)"; fg = "var(--bad)";
            txt = "×"; op = "1"; tip = sc + CRASH + L(" — процесс упал", " — the process crashed");
          }
          if (i === CRASH + 1) {
            bg = "var(--read-soft)"; bd = "solid 1px var(--read)"; fg = "var(--read)";
            txt = "↻"; op = "1"; tip = sc + (CRASH + 1) + L(" — перезапуск, читаем с committed",
              " — restart, we read from committed");
          }

          c.mark.textContent = "";
          c.mark.removeAttribute("title");
          p.commits.forEach(function (cm) {
            if (cm.t !== i) return;
            c.mark.textContent = "▲";
            c.mark.style.color = cm.premature ? "var(--bad)" : "var(--read)";
            c.mark.setAttribute("title", cm.premature
              ? L("коммит раньше времени: обработка ещё не закончилась",
                "a commit ahead of time: the processing has not finished yet")
              : L("коммит после обработки", "a commit after processing"));
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

      function sec(n) { return '<span class="t-dim">' + L("сек ", "sec ") + n + (n < 10 ? " " : "") + '</span> ';  }

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
        stateStat.set(L("ждёт", "waiting"), null);
        paintStats();
        paintTimeline();
        setBadges(ui.badge(L("offsets 0…3 обработаны и закоммичены",
          "offsets 0…3 are processed and committed")));

        term.clear();
        term.line('<span class="t-dim">' + L("консьюмер payments-svc · группа billing · партиция 0",
          "consumer payments-svc · billing group · partition 0") + '</span>');
        term.line('<span class="t-dim">committed = ' + TARGET + L(' · в логе ', ' · ') + LEO + " " +
          util.plural(LEO, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
          L('', ' in the log') + ' (LEO ' + LEO + ') · lag = ' + (LEO - TARGET) + '</span>');
        term.line('<span class="t-dim">' + (mode === "auto"
          ? "enable.auto.commit=true · auto.commit.interval.ms=" + ivSec + "000"
          : L("enable.auto.commit=false · commitSync() после обработки",
            "enable.auto.commit=false · commitSync() after processing")) + '</span>');

        if (!silent) forecast();
      }

      /* ---------- прогноз до запуска ---------- */

      function forecast() {
        var p = plan, s;
        if (p.mode === "auto") {
          if (p.premature !== null) {
            s = L("обработка (", "processing (") + p.proc +
              L(" с) длиннее интервала автокоммита (", " s) is longer than the auto-commit interval (") + p.iv +
              L(" с), поэтому коммит на ", " s), so the commit in second ") + p.premature +
              L("-й секунде обгонит работу. Окно риска — с ",
                " overtakes the work. The risk window runs from second ") + p.premature +
              L("-й по ", " to second ") + p.proc +
              L("-ю секунду; сбой на ", "; the crash in second ") + CRASH +
              (CRASH >= p.premature && CRASH < p.proc
                ? L("-й <b>попадает</b>", " <b>falls</b>")
                : L("-й не попадает", " does not fall")) +
              L(" в него.", " inside it.");
          } else if (p.iv > CRASH) {
            s = L("первый тик автокоммита — только на ",
              "the first auto-commit tick comes only in second ") + p.iv +
              L("-й секунде, а процесс умрёт на ", ", and the process dies in second ") + CRASH +
              L("-й: закладка не сдвинется вовсе.", ": the bookmark never moves at all.");
          } else {
            s = L("обработка (", "processing (") + p.proc +
              L(" с) не длиннее интервала автокоммита (",
                " s) is no longer than the auto-commit interval (") + p.iv +
              L(" с) — коммит ни разу не обгонит работу. Автокоммит здесь безопасен.",
                " s) — the commit never overtakes the work. Auto-commit is safe here.");
          }
        } else {
          s = L("закладка сдвинется только после конца обработки, на ",
            "the bookmark moves only after processing ends, in second ") + p.proc +
            (p.proc >= CRASH
              ? L("-й секунде, то есть уже никогда: сбой на ",
                ", which is to say never: the crash in second ") + CRASH +
                L("-й придёт раньше.", " comes first.")
              : L("-й секунде.", "."));
        }
        stage.say(L("<b>Прогноз.</b> ", "<b>Forecast.</b> ") + s +
          L(" Жми «Прогнать со сбоем на ", " Press “Run with a crash in second ") + CRASH +
          L("-й секунде» и следи за флажком committed.", "” and watch the committed flag."));
      }

      /* ---------- проигрывание ---------- */

      function apply(e) {
        if (e.kind === "fetch") {
          ring(true);
          stateStat.set(L("обработка", "processing"), "write");
          term.line(sec(0) + L('poll() вернул <span class="t-w">offset 4</span> («оплата», 12 400 ₽) · ' +
            'обработка началась, ей нужно ',
            'poll() returned <span class="t-w">offset 4</span> (“payment”, 12 400 ₽) · ' +
            'processing has started, it needs ') + plan.proc + L(' с', ' s'));
          term.line(sec(0) + '<span class="t-dim">' +
            L("позиция консьюмера в памяти = 5, но в Kafka пока committed = 4",
              "the consumer’s in-memory position = 5, but in Kafka committed is still 4") + '</span>');
          return;
        }
        if (e.kind === "done") {
          ring(false);
          stateStat.set(L("свободен", "idle"), null);
          term.line(sec(e.t) + L('<span class="t-good">обработка завершена</span>: платёж записан в базу',
            '<span class="t-good">processing finished</span>: the payment is written to the database'));
          return;
        }
        if (e.kind === "commit") {
          committedNow = LEO;
          strip.marker("committed", {
            at: LEO, label: "committed " + LEO,
            color: e.premature ? "var(--bad)" : "var(--read)"
          });
          if (e.auto && e.premature) {
            term.line(sec(e.t) + L('<span class="t-bad">АВТОКОММИТ по таймеру → committed = 5</span> · ' +
              'обработка ЕЩЁ ИДЁТ, Kafka об этом не знает',
              '<span class="t-bad">AUTO-COMMIT on the timer → committed = 5</span> · ' +
              'processing IS STILL RUNNING, Kafka has no idea'));
          } else if (e.auto) {
            term.line(sec(e.t) + L('<span class="t-r">автокоммит по таймеру → committed = 5</span> · ' +
              'обработка уже закончилась, коммит честный',
              '<span class="t-r">auto-commit on the timer → committed = 5</span> · ' +
              'processing has already finished, the commit is honest'));
          } else {
            term.line(sec(e.t) + L('<span class="t-r">commitSync(5) подтверждён → committed = 5</span> · ' +
              'сначала работа, потом закладка',
              '<span class="t-r">commitSync(5) acknowledged → committed = 5</span> · ' +
              'work first, bookmark second'));
          }
          return;
        }
        if (e.kind === "crash") {
          ring(false);
          consumer.classList.add("kv-node--dead");
          stateStat.set(L("упал", "crashed"), "bad");
          term.line(sec(e.t) + L('<span class="t-bad">ПРОЦЕСС УПАЛ</span> · ',
            '<span class="t-bad">THE PROCESS CRASHED</span> · ') + (!e.processed
            ? L('обработка не завершена — она была на ',
              'processing is not finished — it was ') + e.t +
              L('-й из ', ' s into ') + plan.proc + L(' с', ' s of work')
            : e.saved
              ? L('обработка завершена и закоммичена — этот сбой безобиден',
                'processing finished and was committed — this crash is harmless')
              : L('обработка завершена, но коммит уйти не успел',
                'processing finished, but the commit never got out')));
          setBadges(ui.badge(L("процесс упал", "the process crashed"), "bad"));
          return;
        }
        if (e.kind === "restart") {
          consumer.classList.remove("kv-node--dead");
          stateStat.set(L("поднялся", "back up"), "read");
          term.line(sec(e.t) + L('<span class="t-r">консьюмер поднялся</span> · poll() читает с committed = ',
            '<span class="t-r">the consumer is back up</span> · poll() reads from committed = ') + committedNow);
          if (plan.lost) {
            markSkipped(strip.cell(TARGET));
            setBadges(ui.badge(L("offset 4 перешагнули — запись цела",
              "offset 4 was stepped over — the record is intact"), "bad"), ui.badge("lag = 0", "good"));
            term.line(sec(e.t) + L('<span class="t-bad">offset 4 пропущен</span>: по закладке он «дочитан», ' +
              'а обработан не был',
              '<span class="t-bad">offset 4 was skipped</span>: the bookmark says it is “read”, ' +
              'but it was never processed'));
            term.line(sec(e.t) + L('<span class="t-dim">исключений нет · lag = 0 · мониторинг зелёный</span>',
              '<span class="t-dim">no exceptions · lag = 0 · monitoring is green</span>'));
          } else if (plan.dup) {
            ring(true);
            setBadges(ui.badge(L("offset 4 обработан дважды", "offset 4 processed twice"), "warn"));
            term.line(sec(e.t) + L('<span class="t-w">offset 4 читается снова</span> · платёж уже был в базе → ' +
              'обработка повторная',
              '<span class="t-w">offset 4 is read again</span> · the payment was already in the database → ' +
              'this run is a repeat'));
          } else if (plan.redeliver) {
            ring(true);
            setBadges(ui.badge(L("offset 4 перечитан заново", "offset 4 re-read from scratch"), "read"));
            term.line(sec(e.t) + L('<span class="t-r">offset 4 читается снова</span> · его обработка не была ' +
              'закончена, повторная доставка корректна',
              '<span class="t-r">offset 4 is read again</span> · its processing never finished, ' +
              'so redelivery is correct'));
          } else {
            setBadges(ui.badge(L("ничего не потеряно", "nothing was lost"), "good"));
            term.line(sec(e.t) + L('<span class="t-good">читать нечего</span>: offset 4 обработан и закоммичен ' +
              'до сбоя',
              '<span class="t-good">nothing to read</span>: offset 4 was processed and committed ' +
              'before the crash'));
          }
          paintStats();
          return;
        }
        if (e.kind === "verdict") {
          if (plan.lost) stateStat.set(L("потеря", "lost"), "bad");
          else if (plan.dup) stateStat.set(L("дубль", "duplicate"), "warn");
          else stateStat.set(L("цел", "intact"), "good");
          if (plan.dup || plan.redeliver) {
            ring(false);
            term.line(sec(e.t) + L('<span class="t-good">offset 4 обработан</span> → commit(5) → committed = 5',
              '<span class="t-good">offset 4 processed</span> → commit(5) → committed = 5'));
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
          term.line(sec(n) + '<span class="t-dim">' + L('обработка идёт (', 'processing is running (') + n +
            L(' из ', ' of ') + plan.proc + L(' с)', ' s)') + '</span>');
        } else {
          term.line(sec(n) + '<span class="t-dim">' +
            L('обработчик свободен, новых сообщений нет', 'the handler is idle, no new messages') + '</span>');
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
            return (L("<b>offset 4 ПОТЕРЯН.</b> Автокоммит сработал на ",
              "<b>offset 4 IS LOST.</b> Auto-commit fired in second ") + p.premature +
              L("-й секунде и записал ", " and wrote ") +
              L("<code>committed = 5</code> — «дочитано до пятого», — хотя обработка платежа шла и не закончилась. " +
                "На ",
                "<code>committed = 5</code> — “read up to the fifth” — even though the payment was still being " +
                "processed and never finished. In second ") + CRASH +
              L("-й процесса не стало, на ", " the process was gone; in second ") + (CRASH + 1) +
              L("-й он поднялся и честно читает с 5-го. ", " it came back up and honestly reads from the fifth. ") +
              L("Offset 4 не удалён — он лежит в логе до конца retention, — но эта группа его уже не прочитает. " +
                "Исключений не было, в логе чисто, <b>lag = 0</b> — " +
                "в мониторинге всё зелено. Это и есть «автокоммит тихо превращает at-least-once в at-most-once».",

                "Offset 4 was not deleted — it lies in the log until retention expires — but this group will " +
                "never read it. There was no exception, the log is clean, <b>lag = 0</b> — " +
                "monitoring is all green. This is exactly what “auto-commit quietly turns at-least-once into " +
                "at-most-once” means."));
          }
          if (p.premature !== null) {
            return (L("<b>Пронесло — но случайно.</b> Коммит на ",
              "<b>You got away with it — by luck.</b> The commit in second ") + p.premature +
              L("-й секунде обогнал обработку: окно риска — с ",
                " overtook the processing: the risk window runs from second ") + p.premature +
              L("-й по ", " to second ") + p.proc +
              L("-ю секунду. Сбой пришёлся на ", ". The crash landed in second ") + CRASH +
              L("-ю, когда обработка уже закончилась, и сообщение уцелело. Сделай обработку длиннее ",
                ", when processing had already finished, and the message survived. Make processing longer than ") +
              CRASH + L(" с — сбой попадёт внутрь окна, и платёж исчезнет.",
                " s — the crash falls inside the window and the payment disappears."));
          }
          if (p.clean) {
            return (L("<b>Чисто, и не случайно.</b> Обработка (",
              "<b>Clean, and not by luck.</b> Processing (") + p.proc +
              L(" с) не длиннее интервала автокоммита (",
                " s) is no longer than the auto-commit interval (") + p.iv +
              L(" с), поэтому таймер ни разу не тикнул внутри незаконченной работы: коммит на ",
                " s), so the timer never ticked in the middle of unfinished work: the commit in second ") +
              p.commits[0].t +
              L("-й секунде закрепил уже сделанное. Автокоммит опасен не сам по себе — " +
                "опасно, когда обработка длиннее интервала.",
                " locked in work that was already done. Auto-commit is not dangerous in itself — " +
                "what is dangerous is processing that runs longer than the interval."));
          }
          if (p.dup) {
            return (L("<b>Дубль, но не потеря.</b> Автокоммит не успел сработать ни разу: первый тик — на ",
              "<b>A duplicate, but not a loss.</b> Auto-commit never got to fire: the first tick is in second ") +
              p.iv + L("-й секунде, а процесс умер на ", ", and the process died in second ") + CRASH +
              L("-й. committed остался 4, offset 4 перечитан и обработан " +
                "<b>второй раз</b>. Автокоммит спасла собственная медлительность, а не правильность: " +
                "поставь интервал 5 с при обработке в 9 — и получишь потерю.",

                ". committed stayed at 4, offset 4 was re-read and processed " +
                "<b>a second time</b>. Auto-commit was saved by its own slowness, not by being right: " +
                "set the interval to 5 s with 9 s of processing — and you get a loss."));
          }
          return (L("<b>Потери нет.</b> Автокоммит не успел сработать (первый тик — на ",
            "<b>Nothing is lost.</b> Auto-commit never got to fire (the first tick is in second ") + p.iv +
            L("-й секунде, сбой — на ", ", the crash in second ") + CRASH +
            L("-й), обработка тоже не закончилась. committed остался 4, offset 4 перечитан с нуля. " +
              "Повезло дважды — сделай интервал меньше времени обработки и посмотри снова.",

              "), and processing did not finish either. committed stayed at 4, offset 4 is read from scratch. " +
              "Lucky twice over — make the interval shorter than the processing time and look again."));
        }
        if (p.dup) {
          return (L("<b>Дубль, но НЕ потеря.</b> Обработка закончилась на ",
            "<b>A duplicate, but NOT a loss.</b> Processing finished in second ") + p.proc +
            L("-й секунде — платёж уже в базе, — " +
              "а <code>commitSync(5)</code> уйти не успел: процесс умер в зазоре между «сделал» и «запомнил, что сделал». " +
              "После подъёма offset 4 читается снова и обрабатывается повторно. Этот зазор не закрывается ничем — " +
              "поэтому обработчик обязан быть идемпотентным.",

              " — the payment is already in the database — " +
              "but <code>commitSync(5)</code> never got out: the process died in the gap between “did it” and " +
              "“remembered that I did it”. After the restart offset 4 is read again and processed a second time. " +
              "Nothing closes that gap — which is why the handler has to be idempotent."));
        }
        if (p.redeliver) {
          return (L("<b>offset 4 перечитан заново: потери нет.</b> Обработка не успела закончиться, коммита не было — " +
            "после подъёма сообщение читается с нуля. Сбой тот же и в ту же секунду, что и при автокоммите, " +
            "а платёж цел. Цена — возможный дубль: поставь обработку ровно ",

            "<b>offset 4 is re-read from scratch: nothing is lost.</b> Processing never finished and there was " +
            "no commit — after the restart the message is read from scratch. The same crash, in the same second " +
            "as with auto-commit, and the payment is intact. The price is a possible duplicate: set processing " +
            "to exactly ") + CRASH +
            L(" с, и сбой попадёт между концом обработки и коммитом.",
              " s and the crash lands between the end of processing and the commit."));
        }
        return (L("<b>Чисто.</b> Обработка закончилась на ",
          "<b>Clean.</b> Processing finished in second ") + p.proc +
          L("-й секунде, <code>commitSync(5)</code> прошёл сразу за ней, сбой на ",
            ", <code>commitSync(5)</code> went through right behind it, and the crash in second ") + CRASH +
          L("-й уже ничего не решает. Ручной коммит всегда идёт ПОСЛЕ работы — " +
            "поэтому закладка физически не может обогнать обработку.",
            " changes nothing any more. A manual commit always comes AFTER the work — " +
            "so the bookmark physically cannot overtake the processing."));
      }

      /* ---------- контролы ---------- */

      var modeSeg = ui.seg([
        { value: "auto", label: L("автокоммит", "auto-commit") },
        { value: "manual", label: L("ручной коммит", "manual commit") }
      ], mode, function (v) {
        mode = v;
        ivRange.el.style.opacity = v === "auto" ? "1" : ".4";
        ivRange.input.disabled = v !== "auto";
        reset();
      });

      var procRange = ui.range({
        label: L("обработка", "processing"), min: 1, max: 10, value: procSec, unit: L("с", "s"),
        onInput: function (v) { procSec = v; reset(); }
      });

      var ivRange = ui.range({
        label: "auto.commit.interval", min: 1, max: 10, value: ivSec, unit: L("с", "s"),
        onInput: function (v) { ivSec = v; reset(); }
      });

      var runBtn = ui.btn(L("Прогнать со сбоем на " + CRASH + "-й секунде",
        "Run with a crash in second " + CRASH), run, { variant: "primary" });

      KV.append(stage.controls,
        modeSeg.el,
        procRange.el,
        ivRange.el,
        runBtn,
        ui.btn(L("Сброс", "Reset"), function () { reset(); }, { variant: "ghost", sm: true }));

      /* ---------- сборка стенда ---------- */

      stage.body.appendChild(el("div.kv-row", { style: { "margin-bottom": "12px" } }, consumer, badges));
      stage.body.appendChild(strip.el);
      stage.body.appendChild(el("div.kv-stats", { style: { "margin-top": "6px" } },
        clockStat.el, commStat.el, lagStat.el, stateStat.el));
      stage.body.appendChild(el("div.kv-panel", { style: { "margin-top": "14px" } },
        el("div.kv-panel__t", { text: L("линейка времени · секунды", "timeline · seconds") }),
        el("div", { style: { "overflow-x": "auto", "padding-bottom": "2px" } }, tlRow),
        el("div", { style: { "margin-top": "10px" } }, ui.legend([
          { color: "var(--write)", label: L("обработка идёт", "processing is running") },
          { color: "var(--bad)", label: L("окно риска: коммит сделан, обработка — нет",
            "risk window: the commit is done, the processing is not") },
          { color: "var(--read)", label: L("▲ коммит", "▲ commit") },
          { color: "var(--good)", label: L("обработка завершена", "processing finished") }
        ]))));
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } }, term.el));

      reset();
      root.appendChild(stage.el);

      /* ============================================================
         5. разбор
         ============================================================ */

      root.appendChild(ui.prose(L(
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
        "обязан быть [[идемпотентность|идемпотентным]]: проверять id сообщения и молча пропускать уже сделанное.</p>",

        "<h3>Why the loss is silent</h3>" +
        "<p>Walk through the default scenario second by second. <em>Second 0</em> — the consumer got offset 4 " +
        "and started processing. <em>Second 5</em> — the auto-commit timer ticked and wrote " +
        "<code>committed = 5</code>; it did not ask the handler, it asked the clock. <em>Second 7</em> — the " +
        "process died with the work unfinished. <em>Second 8</em> — back up, reading from the next one. " +
        "The message is gone.</p>" +
        "<p>Not one of those four seconds looks like an error. No exception, no failed request, " +
        "[[lag]] is zero after the restart — by every instrument the group has read the topic to the end. " +
        "The defect shows only where nobody is measuring: the payment is not in the database.</p>" +
        "<h4>A condition, not a verdict</h4>" +
        "<p>Auto-commit is not dangerous all the time. Exactly one combination is: <strong>the commit made it, " +
        "the processing did not, and the crash arrived in between</strong>. Set processing shorter than the " +
        "interval on the demo and the risk window disappears entirely. That is why “turn auto-commit off” is a " +
        "bad interview answer, and “auto-commit commits on a timer, not when the processing is actually done” is a good one.</p>" +
        "<p>With a manual commit the same crash at the same moment gives you not a loss but a " +
        "<strong>duplicate</strong>: the message is re-read and processed again. That is [[at-least-once]] — " +
        "Kafka’s baseline guarantee. Nothing closes the gap between “written to the database” and “committed”, " +
        "so the handler has to be [[idempotency|idempotent]]: check the id of the message and silently skip " +
        "whatever is already done.</p>"
      )));

      root.appendChild(ui.note("bad", L("формулировка", "the wording"), L(
        "<p><strong>Автокоммит тихо превращает at-least-once в at-most-once при падении.</strong> " +
        "Ручной коммит после обработки оставляет at-least-once — потерь нет, дубли есть, " +
        "и с ними разбирается [[идемпотентность|идемпотентный]] обработчик.</p>",

        "<p><strong>Auto-commit quietly turns at-least-once into at-most-once on a crash.</strong> " +
        "A manual commit after processing keeps at-least-once — no losses, duplicates yes, " +
        "and an [[idempotency|idempotent]] handler deals with them.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "[[committed offset]] — номер <b>следующего</b> сообщения, а не последнего обработанного. Дочитал до 3 — коммить 4.",
          "Автокоммит коммитит <b>по таймеру</b>, а не по факту обработки. Обработка дольше <code>auto.commit.interval.ms</code> — появляется окно, в котором закладка уже сдвинута, а работа ещё идёт.",
          "Падение внутри этого окна = <b>потеря без следов</b>: исключений нет, [[lag]] нулевой, мониторинг зелёный.",
          "Ручной коммит после обработки меняет потерю на <b>дубль</b>: это [[at-least-once]], и обработчик обязан быть [[идемпотентность|идемпотентным]].",
          "Зазор между «сделал работу» и «закоммитил» есть всегда — гарантии строятся не на его отсутствии, а на идемпотентности."
        ],
        [
          "A [[committed offset]] is the number of the <b>next</b> message, not of the last one processed. Read up to 3 — commit 4.",
          "Auto-commit commits <b>on a timer</b>, not when the processing is actually done. Processing that runs longer than <code>auto.commit.interval.ms</code> opens a window in which the bookmark has already moved while the work is still going.",
          "A crash inside that window = <b>a loss without a trace</b>: no exceptions, [[lag]] is zero, monitoring is green.",
          "A manual commit after processing turns the loss into a <b>duplicate</b>: that is [[at-least-once]], and the handler has to be [[idempotency|idempotent]].",
          "The gap between “did the work” and “committed it” is always there — guarantees are built not on its absence but on idempotency."
        ]
      )));
    }
  });
})();
