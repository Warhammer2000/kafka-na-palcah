/* Глава 12 — Гарантии доставки: at-least-once, идемпотентность, EOS и его граница. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "guarantees",
    num: 12,
    group: "Надёжность",
    nav: "Гарантии доставки",
    title: "At-least-once, и почему exactly-once не то, что кажется",
    lede: "По умолчанию Kafka даёт <b>at-least-once</b>: сообщение точно дойдёт, но может прийти дважды. <code>exactly-once</code> в Kafka существует по-настоящему — вот только накрывает он не весь твой конвейер, а ровно один его кусок.",

    build: function (root, api) {

      var destroyed = false;
      api.onDestroy(function () { destroyed = true; });

      /* Поколение стенда. «Сбросить» увеличивает его, и все цепочки анимаций,
         запущенные до сброса, тихо обрываются — иначе они дописывают строки
         и двигают committed offset уже в новом состоянии. */
      var epoch = 0;
      function stale(e) { return destroyed || e !== epoch; }

      root.appendChild(ui.prose(
        "<p>Смотри, откуда берётся второй экземпляр. [[консьюмер|Консьюмер]] читает запись, обрабатывает её — списывает деньги, пишет строку в базу — и только потом делает [[commit]]: «я дочитал до сюда». " +
        "В коммит при этом уходит номер <b>следующей</b> записи: обработал offset 7 — коммитишь 8. " +
        "Между «обработал» и «закоммитил» есть зазор: десятки миллисекунд при ручном коммите и до нескольких секунд при автоматическом, по таймеру. " +
        "Упал в этот зазор — [[committed offset]] остался прежним; поднялся — прочитал ту же запись снова и списал деньги второй раз.</p>" +
        "<p>Поменять местами не помогает: закоммитить сначала, а обработать потом — это <em>at-most-once</em>, там сообщения просто теряются при падении. " +
        "Зазор неустраним: это свойство сети и двух разных хранилищ, а не недоделка Kafka. Поэтому гарантия честно называется [[at-least-once]] — «минимум один раз».</p>"
      ));

      root.appendChild(ui.note("key", "закон",
        "<p><strong>Раз доставка повторяется, обработчик обязан быть [[идемпотентность|идемпотентным]]:</strong> «повтори сколько угодно раз — результат тот же».</p>" +
        "<p>Рецепт дешёвый и всегда один: у сообщения есть уникальный <code>id</code>, перед работой проверяешь «этот id уже обработан?» — да, пропускаешь. " +
        "Технически это либо таблица обработанных id, либо уникальный индекс, либо <code>UPSERT</code> по ключу вместо <code>INSERT</code>.</p>"
      ));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Конвейер и две аварии",
        hint: "Жми аварии при разных тумблерах и следи за плиткой «дублей»"
      });

      var EVENTS = ["оплата 1 200 ₽", "возврат 350 ₽", "заказ № 918", "списание 79 ₽", "бонус 50 ₽", "оплата 640 ₽"];
      var PID = 7331;

      /* --- состояние конвейера --- */
      var evtNext = 1;          // счётчик номеров событий
      var seqNext = 0;          // следующий порядковый номер продюсера в партиции
      var brokerSeq = -1;       // последний принятый брокером номер для этого PID
      var committed = 0;        // committed offset группы
      var seen = {};            // таблица обработанных id (память идемпотентного обработчика)
      var rows = [];            // строки на выходе: {id, evt, off, pending}
      var processed = 0;        // сколько раз обработчик отработал
      var consumerDown = false; // консьюмер упал
      var crashArmed = false;   // следующая обработка закончится падением
      var busy = false;         // идёт обработка — второй тик не запускаем
      var out = "db";           // куда пишет обработчик: "db" | "kafka"

      /* --- узлы --- */
      var producer = ui.node("producer", "продюсер", "PID " + PID + " · seq → 0");
      var prodMeta = producer.querySelector(".kv-node__meta");
      var prodBadge = ui.badge("enable.idempotence: вкл", "good");

      var strip = ui.logStrip({
        label: "orders · партиция 0",
        sub: "брокер 2",
        empty: "партиция пуста"
      });
      var stripPlate = strip.el.querySelector(".kv-part__label") || strip.el;

      var consumer = ui.node("consumer", "консьюмер", "группа billing");
      var consMeta = consumer.querySelector(".kv-node__meta");
      var consBadge = ui.badge("dedup по id: выкл", "bad");

      /* --- панель выхода --- */
      var outTitle = el("div.kv-panel__t", { text: "внешняя база · orders_db" });
      var outNote = el("div", {
        style: { "font-size": "11.5px", "line-height": "1.4", color: "var(--muted)", "margin-bottom": "8px" }
      });
      var outList = el("div", { style: { "max-height": "182px", "overflow-y": "auto", "min-height": "68px" } });
      var outPanel = el("div.kv-panel", null, outTitle, outNote, outList);

      var term = ui.terminal("");
      term.el.style.setProperty("max-height", "182px");
      term.el.style.setProperty("overflow-y", "auto");

      /* --- счётчики --- */
      var statPart = ui.stat("в партиции", 0, { unit: "зап.", tone: "write" });
      var statProc = ui.stat("обработок", 0, { unit: "раз", tone: "read" });
      var statRows = ui.stat("строк на выходе", 0);
      var statDup = ui.stat("дублей на выходе", 0, { tone: "good" });

      /* --- тумблеры --- */
      var tIdem, tTx, tHandler, outSeg;

      function txLive() { return tTx.checked() && out === "kafka"; }

      function arrow(txt) {
        return el("div", {
          style: {
            margin: "8px 0 8px 8px", "font-family": "var(--f-mono)",
            "font-size": "10.5px", color: "var(--faint)"
          }
        }, "↓ " + txt);
      }

      /* ---------- отрисовка ---------- */

      function dupInfo() {
        var first = {}, d = 0, flags = [];
        rows.forEach(function (r) {
          if (first[r.id]) { d++; flags.push(true); }
          else { first[r.id] = true; flags.push(false); }
        });
        return { count: d, flags: flags };
      }

      function renderOut() {
        var db = out === "db";
        outTitle.textContent = db ? "внешняя база · orders_db" : "топик Kafka · results";
        outNote.textContent = db
          ? "SQL снаружи кластера. Транзакция Kafka сюда не дотягивается: то, что записано, записано."
          : (tTx.checked()
            ? "Тот же кластер. Запись в results и коммит offset идут ОДНОЙ транзакцией; читатель с isolation.level=read_committed незакоммиченное не видит."
            : "Тот же кластер, но без transactional.id: запись видна сразу и откатить её нечем.");

        KV.clear(outList);
        if (!rows.length) {
          outList.appendChild(el("div", {
            style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)", padding: "10px 0" },
            text: db ? "в базе пусто" : "топик пуст"
          }));
          return;
        }
        var info = dupInfo();
        rows.forEach(function (r, i) {
          var line = el("div.kv-row", {
            style: { gap: "8px", padding: "4px 0", "align-items": "baseline" }
          },
            el("span", {
              style: {
                "font-family": "var(--f-mono)", "font-size": "10.5px",
                color: "var(--faint)", "min-width": "2.4em"
              }, text: "#" + (i + 1)
            }),
            el("b", {
              style: { "font-family": "var(--f-mono)", "font-size": "12px", color: util.keyColor(r.id) },
              text: r.id
            }),
            el("span", { style: { "font-size": "12.5px", color: "var(--ink-2)" }, text: r.evt }),
            el("span", {
              style: { "font-family": "var(--f-mono)", "font-size": "10.5px", color: "var(--faint)" },
              text: "из offset " + r.off
            }),
            info.flags[i] ? ui.badge("ДУБЛЬ", "bad") : null,
            r.pending ? ui.badge("не закоммичена", "warn") : null);
          if (r.pending) line.style.opacity = ".55";
          outList.appendChild(line);
        });
        outList.scrollTop = outList.scrollHeight;
      }

      function refresh() {
        var n = strip.records.length;
        var d = dupInfo().count;
        statPart.set(n, "write");
        statProc.set(processed, "read");
        statRows.set(rows.length);
        statDup.set(d, d > 0 ? "bad" : "good");
        prodMeta.textContent = "PID " + PID + " · seq → " + seqNext;
        consMeta.textContent = consumerDown
          ? "группа billing · УПАЛ"
          : "группа billing · committed " + committed;
        strip.marker("committed", {
          at: committed, label: "committed " + committed, color: "var(--read)"
        });
        renderOut();
      }

      /* ---------- продюсер ---------- */

      function newRecord() {
        var n = evtNext++;
        var id = "evt-" + n;
        return {
          id: id,
          evt: EVENTS[(n - 1) % EVENTS.length],
          key: id,
          label: String(n),
          seq: 0,
          title: "запись " + id
        };
      }

      function flyToPartition(rec, color) {
        return KV.fly(producer, stripPlate, {
          label: rec.label,
          color: color || util.keyColor(rec.id),
          soft: util.keyColorSoft(rec.id),
          ms: api.reduced ? 0 : 340
        });
      }

      function produce(say) {
        var e = epoch;
        var rec = newRecord();
        rec.seq = seqNext++;
        flyToPartition(rec).then(function () {
          if (stale(e)) return;
          var off = strip.leo();
          strip.push(rec);
          brokerSeq = rec.seq;
          term.line('<span class="t-w">продюсер</span> → seq ' + rec.seq + ' · ' + util.escape(rec.id) +
            ' <span class="t-good">ack ok</span> <span class="t-dim">offset ' + off + '</span>');
          refresh();
          if (say !== false) {
            stage.say("Запись <b>" + util.escape(rec.id) + "</b> легла в offset " + off +
              ". Пока сеть не подводит, всё честно: одна отправка — одна запись.");
          }
        });
      }

      /* авария 1: ack потерян, продюсер ретраит ту же запись */
      function netTimeout() {
        var e = epoch;
        var rec = newRecord();
        rec.seq = seqNext++;
        flyToPartition(rec).then(function () {
          if (stale(e)) return;
          var off = strip.leo();
          strip.push(rec);
          brokerSeq = rec.seq;
          strip.highlight(off, "is-hot", 900);
          term.line('<span class="t-w">продюсер</span> → seq ' + rec.seq + ' · ' + util.escape(rec.id) +
            ' <span class="t-dim">брокер записал offset ' + off + '</span>');
          term.line('<span class="t-bad">✕ ack потерян: таймаут сети. Продюсер не знает, дошло или нет.</span>');
          refresh();
          stage.say("<b>Таймаут.</b> Брокер запись принял, но подтверждение не вернулось. У продюсера один вариант — отправить ещё раз.");
          api.timeout(api.reduced ? 80 : 700, function () {
            if (stale(e)) return;
            retryLeg(rec, off, e);
          });
        });
      }

      function retryLeg(rec, off, e) {
        /* брокер отбрасывает повтор, только если помнит номера: PID + seq */
        var idem = tIdem.checked() && rec.seq <= brokerSeq;
        flyToPartition(rec, idem ? "var(--bad)" : null).then(function () {
          if (stale(e)) return;
          term.line('<span class="t-w">продюсер</span> ретрай: та же запись, тот же seq ' + rec.seq);
          if (idem) {
            strip.highlight(off, "is-hot", 900);
            term.line('<span class="t-good">брокер: PID ' + PID + ', seq ' + rec.seq +
              ' уже принят → дубль отброшен, в лог не попал</span>');
            stage.say("<b>enable.idempotence спас.</b> Брокер помнит последний принятый номер для этого PID в этой партиции. " +
              "Ретрай пришёл с тем же <code>seq " + rec.seq + "</code> → отброшен. В логе <b>одна</b> запись, offset " + off + ".");
          } else {
            var off2 = strip.leo();
            strip.push({
              id: rec.id, evt: rec.evt, key: rec.id, label: rec.label,
              seq: rec.seq, title: "дубль " + rec.id
            });
            term.line('<span class="t-bad">брокер без enable.idempotence номеров не помнит → вторая копия, offset ' + off2 + '</span>');
            stage.say("<b>Дубль в самой партиции.</b> Брокер не отличает ретрай от новой записи: " + util.escape(rec.id) +
              " лежит дважды, в offset " + off + " и " + off2 + ". Консьюмер честно обработает обе.");
          }
          refresh();
        });
      }

      /* ---------- консьюмер ---------- */

      function tick() {
        if (destroyed || busy || consumerDown) return;
        if (committed >= strip.records.length) return;
        busy = true;

        var e = epoch;
        var off = committed;
        var rec = strip.records[off];
        strip.highlight(off, "is-reading", 800);

        KV.fly(strip.cell(off) || stripPlate, consumer, {
          label: rec.label, color: "var(--read)", soft: "var(--read-soft)",
          ms: api.reduced ? 0 : 320
        }).then(function () {
          if (stale(e)) return;
          processed++;

          var already = !!seen[rec.id];
          if (tHandler.checked() && already) {
            term.line('<span class="t-r">консьюмер</span> offset ' + off + ' · ' + util.escape(rec.id) +
              ' <span class="t-good">уже обработан → пропуск (dedup по id)</span>');
            if (crashArmed) { crash(off, null, true, e); return; }
            finish(off, null);
            stage.say("<b>Идемпотентный обработчик сработал.</b> " + util.escape(rec.id) +
              " уже есть в таблице обработанных — запись прочитана второй раз, но наружу ничего не ушло. " +
              "Повторная <b>доставка</b> осталась, повторного <b>эффекта</b> нет.");
            return;
          }

          KV.fly(consumer, outPanel, {
            label: rec.label, color: "var(--write)", soft: "var(--write-soft)",
            ms: api.reduced ? 0 : 320
          }).then(function () {
            if (stale(e)) return;
            var row = { id: rec.id, evt: rec.evt, off: off, pending: txLive() };
            rows.push(row);
            var wasSeen = already;
            seen[rec.id] = true;
            term.line('<span class="t-r">консьюмер</span> offset ' + off + ' · ' + util.escape(rec.id) +
              ' → ' + (out === "db" ? "INSERT в orders_db" : "запись в топик results") +
              (row.pending ? ' <span class="t-dim">(внутри транзакции)</span>' : ''));
            refresh();

            if (crashArmed) { crash(off, row, wasSeen, e); return; }
            if (row.pending) {
              /* пауза, чтобы было видно: внутри транзакции запись ещё не видна read_committed */
              api.timeout(api.reduced ? 60 : 520, function () {
                if (stale(e)) return;
                finish(off, row);
              });
              return;
            }
            finish(off, row);
          });
        });
      }

      /* успешное завершение обработки: коммит offset */
      function finish(off, row) {
        var inTx = !!(row && row.pending);
        if (row) row.pending = false;
        committed = off + 1;
        term.line('<span class="t-dim">commit offset ' + committed +
          (inTx ? " · транзакция закоммичена, запись видна read_committed" : "") + '</span>');
        busy = false;
        refresh();
      }

      /* авария 2: падение ПОСЛЕ обработки и ДО коммита */
      function crash(off, row, wasSeen, e) {
        crashArmed = false;
        consumerDown = true;
        busy = false;
        consumer.classList.add("kv-node--dead");

        term.line('<span class="t-bad">✕ консьюмер упал ' +
          (row ? "после обработки" : "после проверки id") +
          ' и ДО коммита. committed offset остался ' + committed + '</span>');

        if (!row) {
          stage.say("<b>Упал, ничего не записав:</b> обработчик распознал знакомый id и наружу не пошёл. " +
            "Коммита нет, поэтому offset " + off + " будет прочитан ещё раз — и снова ничего не произойдёт. " +
            "Вот это и значит «идемпотентно»: лишние чтения перестают быть аварией.");
        } else if (row.pending) {
          var i = rows.indexOf(row);
          if (i >= 0) rows.splice(i, 1);
          if (!wasSeen) delete seen[row.id];
          term.line('<span class="t-good">транзакция не закоммичена → запись в results отброшена; read_committed её и не видел</span>');
          stage.say("<b>Транзакция откатилась.</b> Выход — топик той же Kafka, поэтому запись результата и коммит offset были одним куском: " +
            "не закоммитили — значит, не было ничего. Консьюмер поднимется, обработает offset " + off + " заново, и на выходе останется <b>одна</b> строка.");
        } else if (out === "kafka") {
          stage.say("<b>Выход — Kafka, но транзакций нет.</b> Запись в results уже видна всем, коммита offset нет. " +
            "Поднимется — прочитает offset " + off + " снова и запишет второй раз. Включи транзакции и повтори аварию.");
        } else {
          stage.say("<b>Строка уже в базе, а offset не сдвинулся.</b> База снаружи Kafka: откатывать её брокеру нечем, " +
            "он про неё вообще не знает. Поднимется — прочитает offset " + off + " заново и запишет строку второй раз.");
        }

        refresh();
        api.timeout(api.reduced ? 200 : 1700, function () {
          if (stale(e)) return;
          consumerDown = false;
          consumer.classList.remove("kv-node--dead");
          term.line('<span class="t-r">консьюмер поднялся</span> <span class="t-dim">читает с committed offset ' +
            committed + ' — та же запись</span>');
          refresh();
        });
      }

      /* ---------- сборка стенда ---------- */

      stage.body.appendChild(el("div.kv-row", null, producer, prodBadge));
      stage.body.appendChild(arrow("пишет в топик orders"));
      stage.body.appendChild(strip.el);
      stage.body.appendChild(arrow("читает с committed offset, обрабатывает, коммитит"));
      stage.body.appendChild(el("div.kv-row", null, consumer, consBadge));
      stage.body.appendChild(arrow("обработчик пишет результат наружу"));
      stage.body.appendChild(el("div.kv-split", { style: { "margin-top": "4px" } },
        outPanel,
        el("div.kv-col", null,
          el("div.kv-panel__t", { text: "журнал конвейера" }),
          term.el)));
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.stats(statPart.el, statProc.el, statRows.el, statDup.el)));

      tIdem = ui.toggle("enable.idempotence", true, function (on) {
        prodBadge.textContent = "enable.idempotence: " + (on ? "вкл" : "выкл");
        prodBadge.className = "kv-badge kv-badge--" + (on ? "good" : "bad");
        stage.say(on
          ? "Продюсер идемпотентный: у него есть PID и сквозная нумерация записей в партиции. Брокер отбросит повтор с уже принятым номером. <b>С Kafka 3.0 это включено по умолчанию.</b>"
          : "Идемпотентность выключена (так жили до Kafka 3.0). Любой ретрай после таймаута — это новая запись в логе.");
      });

      tTx = ui.toggle("транзакции Kafka→Kafka", false, function (on) {
        renderOut();
        stage.say(on
          ? "Транзакции включены: продюсер получил <code>transactional.id</code>, запись результата и коммит offset идут одной атомарной пачкой. <b>Работает это только если выход — тоже Kafka.</b>"
          : "Транзакций нет: запись результата и коммит offset — два независимых действия. Между ними можно упасть.");
      });

      tHandler = ui.toggle("идемпотентный обработчик (dedup по id)", false, function (on) {
        consBadge.textContent = "dedup по id: " + (on ? "вкл" : "выкл");
        consBadge.className = "kv-badge kv-badge--" + (on ? "good" : "bad");
        stage.say(on
          ? "Обработчик стал идемпотентным: перед работой смотрит в таблицу обработанных id и молча пропускает знакомые. Это единственное, что работает при любом выходе."
          : "Обработчик наивный: что прочитал, то и записал. Любая повторная доставка станет повторной строкой.");
      });

      outSeg = ui.seg([
        { value: "db", label: "внешняя база" },
        { value: "kafka", label: "топик Kafka" }
      ], "db", function (v) {
        out = v;
        renderOut();
        stage.say(v === "db"
          ? "Выход — внешняя база. Всё, что записано туда, для Kafka невидимо и неоткатываемо."
          : "Выход — топик той же Kafka. Только в этом контуре транзакция может накрыть и результат, и коммит offset сразу.");
      });

      /* Подпись и переключатель вместе не влезают в стенд на экране 360 px
         (339 px против 326 px), а .kv-stage прячет лишнее под overflow:hidden
         без прокрутки. Разрешаем паре переноситься: на узком экране подпись
         встаёт отдельной строкой, на широком ничего не меняется. */
      var outCtl = ui.ctl("выход обработчика", outSeg.el);
      outCtl.style.flexWrap = "wrap";

      function armCrash() {
        if (consumerDown) {
          stage.say("Консьюмер сейчас поднимается — дождись, пока он вернётся в строй.");
          return;
        }
        if (crashArmed) {
          stage.say("Авария уже взведена — падение случится на ближайшей обработке.");
          return;
        }
        crashArmed = true;
        if (committed >= strip.records.length) produce(false);
        stage.say("<b>Авария взведена.</b> Консьюмер обработает следующую запись и упадёт до коммита — смотри на offset и на выход.");
      }

      KV.append(stage.controls,
        ui.btn("Отправить событие", function () { produce(); }, { variant: "primary" }),
        ui.btn("Таймаут сети: продюсер ретраит", netTimeout, { variant: "danger", sm: true }),
        ui.btn("Уронить консьюмер до коммита", armCrash, { variant: "danger", sm: true }),
        tIdem.el,
        tTx.el,
        tHandler.el,
        outCtl,
        ui.btn("Сбросить", function () {
          reset("Конвейер сброшен: три записи прошли путь целиком, дублей нет. Ломай.");
        }, { variant: "ghost", sm: true }));

      function reset(msg) {
        epoch++;               // обрываем всё, что летит прямо сейчас
        strip.clear();
        evtNext = 1; seqNext = 0; brokerSeq = -1;
        committed = 0; processed = 0;
        seen = {}; rows = [];
        consumerDown = false; crashArmed = false; busy = false;
        consumer.classList.remove("kv-node--dead");
        term.clear();

        for (var i = 0; i < 3; i++) {
          var rec = newRecord();
          rec.seq = seqNext++;
          brokerSeq = rec.seq;
          strip.push(rec);
          processed++;
          rows.push({ id: rec.id, evt: rec.evt, off: i, pending: false });
          seen[rec.id] = true;
          committed = i + 1;
        }
        term.line('<span class="t-dim">штатный режим: 3 записи прошли продюсер → партицию → обработчик → выход</span>');
        term.line('<span class="t-dim">committed offset ' + committed + ' · дублей нет</span>');
        refresh();
        stage.say(msg || "");
      }

      reset("Конвейер работает вхолостую: три записи уже прошли путь целиком. Теперь ломай его двумя красными кнопками и переключай тумблеры.");
      api.interval(1050, tick);
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
        "<h3>Из чего на самом деле состоит exactly-once</h3>" +
        "<p><strong>1. Идемпотентный продюсер.</strong> Kafka выдаёт продюсеру <code>Producer ID</code> (PID), а каждой записи — порядковый номер внутри [[партиция|партиции]]. " +
        "Брокер помнит последний принятый номер по паре PID+партиция и отбрасывает повтор. Включается <code>enable.idempotence=true</code>, " +
        "в Kafka 3.0+ включён по умолчанию. Ценой этого же механизма держится и порядок при ретраях.</p>" +
        "<p><strong>2. Транзакции.</strong> Для потока «прочитал → обработал → записал» нужна атомарность: продюсер берёт <code>transactional.id</code>, " +
        "и запись сразу в несколько партиций <em>плюс</em> коммит [[offset|offset'ов]] уходят одной транзакцией. " +
        "Читатель обязан выставить <code>isolation.level=read_committed</code> — иначе он увидит и то, что потом откатили.</p>" +
        "<h4>Где проходит граница</h4>" +
        "<p>Сквозная [[exactly-once]] живёт только в контуре <b>Kafka → Kafka</b>. Как только на выходе внешняя система — база, HTTP-вызов, письмо, платёж — " +
        "транзакция брокера её не накрывает: Kafka про неё не знает и откатить её нечем. Ты возвращаешься ровно туда, откуда начали: к идемпотентности на своей стороне.</p>"
      ));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>«Включили <code>enable.idempotence</code> — значит, у нас exactly-once».</strong> Нет. " +
        "Идемпотентный продюсер даёт «ровно один раз» <em>для записи в партицию</em> и защищает ровно от одного сценария — ретрая продюсера после потерянного ack.</p>" +
        "<p>Падение [[консьюмер|консьюмера]] между обработкой и [[commit|коммитом]] он не лечит никак: это другая сторона конвейера. " +
        "Там работают либо транзакции (и только Kafka→Kafka), либо твой идемпотентный обработчик.</p>"
      ));

      var yes = '<span class="kv-badge kv-badge--good">спасает</span> ';
      var no = '<span class="kv-badge kv-badge--bad">не спасает</span> ';
      var meh = '<span class="kv-badge">не про это</span> ';

      root.appendChild(ui.table(
        ["Авария", "enable.idempotence", "транзакции Kafka→Kafka", "идемпотентный обработчик"],
        [
          [
            "Ретрай продюсера после таймаута",
            yes + "брокер видит знакомый PID+seq и отбрасывает дубль",
            meh + "транзакция про атомарность, а не про ретраи",
            yes + "дубль в партиции останется, но наружу не уйдёт"
          ],
          [
            "Падение консьюмера до коммита,<br>выход — <b>внешняя база</b>",
            no + "это защита записи в партицию, не обработки",
            no + "строка уже в базе, Kafka её не откатывает",
            yes + "<b>единственная работающая защита</b>"
          ],
          [
            "Падение консьюмера до коммита,<br>выход — <b>топик Kafka</b>",
            no + "та же история",
            yes + "результат и коммит offset откатятся вместе",
            yes + "работает и здесь, но уже избыточно"
          ]
        ]
      ));

      root.appendChild(ui.prose(
        "<h4>Что из этого делать руками</h4>" +
        "<p>Проектируй под at-least-once по умолчанию: уникальный <code>id</code> в каждом событии, <code>UPSERT</code> вместо <code>INSERT</code>, " +
        "уникальный индекс в базе как последний рубеж. Тогда повторная доставка перестаёт быть аварией и становится скучной штатной ситуацией — " +
        "а транзакции включаешь только там, где поток действительно не выходит за пределы Kafka (например, Kafka Streams). " +
        "Цена у них не нулевая: лишние round-trip'ы координатору и задержка на стороне <code>read_committed</code>.</p>"
      ));

      root.appendChild(ui.takeaway([
        "База — [[at-least-once]]: доставка гарантирована, единственность — нет. Зазор между обработкой и [[commit|коммитом]] неустраним.",
        "Поэтому обработчик обязан быть [[идемпотентность|идемпотентным]]: уникальный <code>id</code> + проверка «уже обработан?».",
        "<code>enable.idempotence</code> (PID + номер записи) закрывает <b>только</b> ретрай продюсера и <b>только</b> запись в [[партиция|партицию]]. Это не сквозная гарантия.",
        "Транзакции (<code>transactional.id</code> + <code>read_committed</code>) делают атомарными результат и коммит offset — но лишь в контуре <b>Kafka → Kafka</b>.",
        "Внешняя база, HTTP или письмо на выходе — и [[exactly-once]] заканчивается: остаётся твоя идемпотентность."
      ]));
    }
  });
})();
