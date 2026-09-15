/* Глава 12 — Гарантии доставки: at-least-once, идемпотентность, EOS и его граница. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "guarantees",
    num: 12,
    group: ["Надёжность", "Reliability"],
    nav: ["Гарантии доставки", "Delivery guarantees"],
    title: [
      "At-least-once, и почему exactly-once не то, что кажется",
      "At-least-once, and why exactly-once isn’t what it sounds like"
    ],
    lede: [
      "По умолчанию Kafka даёт <b>at-least-once</b>: сообщение точно дойдёт, но может прийти дважды. <code>exactly-once</code> в Kafka существует по-настоящему — вот только накрывает он не весь твой конвейер, а ровно один его кусок.",
      "By default Kafka gives you <b>at-least-once</b>: the message will certainly arrive, but it may arrive twice. <code>exactly-once</code> in Kafka is real — it just covers one piece of your pipeline, not the whole of it."
    ],

    build: function (root, api) {

      var destroyed = false;
      api.onDestroy(function () { destroyed = true; });

      /* Поколение стенда. «Сбросить» увеличивает его, и все цепочки анимаций,
         запущенные до сброса, тихо обрываются — иначе они дописывают строки
         и двигают committed offset уже в новом состоянии. */
      var epoch = 0;
      function stale(e) { return destroyed || e !== epoch; }

      root.appendChild(ui.prose(L(
        "<p>Смотри, откуда берётся второй экземпляр. [[консьюмер|Консьюмер]] читает запись, обрабатывает её — списывает деньги, пишет строку в базу — и только потом делает [[commit]]: «я дочитал до сюда». " +
        "В коммит при этом уходит номер <b>следующей</b> записи: обработал offset 7 — коммитишь 8. " +
        "Между «обработал» и «закоммитил» есть зазор: десятки миллисекунд при ручном коммите и до нескольких секунд при автоматическом, по таймеру. " +
        "Упал в этот зазор — [[committed offset]] остался прежним; поднялся — прочитал ту же запись снова и списал деньги второй раз.</p>" +
        "<p>Поменять местами не помогает: закоммитить сначала, а обработать потом — это <em>at-most-once</em>, там сообщения просто теряются при падении. " +
        "Зазор неустраним: это свойство сети и двух разных хранилищ, а не недоделка Kafka. Поэтому гарантия честно называется [[at-least-once]] — «минимум один раз».</p>",

        "<p>Look at where the second copy comes from. A [[consumer]] reads a record, processes it — takes the money, writes a row into the database — and only then does a [[commit]]: “I have read up to here”. " +
        "And what goes into that commit is the number of the <b>next</b> record: you processed offset 7, you commit 8. " +
        "Between “processed” and “committed” there is a gap: tens of milliseconds with a manual commit, up to several seconds with the automatic one, on a timer. " +
        "Crash inside that gap and the [[committed offset]] stays where it was; come back up and you read the same record again and take the money a second time.</p>" +
        "<p>Swapping the order does not help: commit first and process afterwards is <em>at-most-once</em>, where messages are simply lost on a crash. " +
        "The gap cannot be removed: it is a property of the network and of two separate stores, not an unfinished corner of Kafka. That is why the guarantee is honestly called [[at-least-once]] — “at least one time”.</p>"
      )));

      root.appendChild(ui.note("key", L("закон", "the law"), L(
        "<p><strong>Раз доставка повторяется, обработчик обязан быть [[идемпотентность|идемпотентным]]:</strong> «повтори сколько угодно раз — результат тот же».</p>" +
        "<p>Рецепт дешёвый и всегда один: у сообщения есть уникальный <code>id</code>, перед работой проверяешь «этот id уже обработан?» — да, пропускаешь. " +
        "Технически это либо таблица обработанных id, либо уникальный индекс, либо <code>UPSERT</code> по ключу вместо <code>INSERT</code>.</p>",

        "<p><strong>Since delivery repeats, the handler has to be [[idempotency|idempotent]]:</strong> “repeat it as many times as you like — the result is the same”.</p>" +
        "<p>The recipe is cheap and always the same: the message carries a unique <code>id</code>, and before doing any work you check “have I already processed this id?” — yes, skip it. " +
        "In practice that is either a table of processed ids, or a unique index, or an <code>UPSERT</code> by key instead of an <code>INSERT</code>.</p>"
      )));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Конвейер и две аварии", "The pipeline and two failures"),
        hint: L("Жми аварии при разных тумблерах и следи за плиткой «дублей»",
          "Trigger the failures with different switches flipped and watch the “duplicates” tile")
      });

      var EVENTS = L(
        ["оплата 1 200 ₽", "возврат 350 ₽", "заказ № 918", "списание 79 ₽", "бонус 50 ₽", "оплата 640 ₽"],
        ["payment 1 200 ₽", "refund 350 ₽", "order #918", "charge 79 ₽", "bonus 50 ₽", "payment 640 ₽"]
      );
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
      var producer = ui.node("producer", L("продюсер", "producer"), "PID " + PID + " · seq → 0");
      var prodMeta = producer.querySelector(".kv-node__meta");
      var prodBadge = ui.badge(L("enable.idempotence: вкл", "enable.idempotence: on"), "good");

      var strip = ui.logStrip({
        label: L("orders · партиция 0", "orders · partition 0"),
        sub: L("брокер 2", "broker 2"),
        empty: L("партиция пуста", "the partition is empty")
      });
      var stripPlate = strip.el.querySelector(".kv-part__label") || strip.el;

      var consumer = ui.node("consumer", L("консьюмер", "consumer"), L("группа billing", "billing group"));
      var consMeta = consumer.querySelector(".kv-node__meta");
      var consBadge = ui.badge(L("dedup по id: выкл", "dedup by id: off"), "bad");

      /* --- панель выхода --- */
      var outTitle = el("div.kv-panel__t", { text: L("внешняя база · orders_db", "external database · orders_db") });
      var outNote = el("div", {
        style: { "font-size": "11.5px", "line-height": "1.4", color: "var(--muted)", "margin-bottom": "8px" }
      });
      var outList = el("div", { style: { "max-height": "182px", "overflow-y": "auto", "min-height": "68px" } });
      var outPanel = el("div.kv-panel", null, outTitle, outNote, outList);

      var term = ui.terminal("");
      term.el.style.setProperty("max-height", "182px");
      term.el.style.setProperty("overflow-y", "auto");

      /* --- счётчики --- */
      var statPart = ui.stat(L("в партиции", "in the partition"), 0, { unit: L("зап.", "rec."), tone: "write" });
      var statProc = ui.stat(L("обработок", "processed"), 0, { unit: L("раз", "times"), tone: "read" });
      var statRows = ui.stat(L("строк на выходе", "rows at the output"), 0);
      var statDup = ui.stat(L("дублей на выходе", "duplicates at the output"), 0, { tone: "good" });

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
        outTitle.textContent = db
          ? L("внешняя база · orders_db", "external database · orders_db")
          : L("топик Kafka · results", "Kafka topic · results");
        outNote.textContent = db
          ? L("SQL снаружи кластера. Транзакция Kafka сюда не дотягивается: то, что записано, записано.",
            "SQL outside the cluster. A Kafka transaction does not reach this far: what is written is written.")
          : (tTx.checked()
            ? L("Тот же кластер. Запись в results и коммит offset идут ОДНОЙ транзакцией; читатель с isolation.level=read_committed незакоммиченное не видит.",
              "The same cluster. The write to results and the offset commit go in ONE transaction; a reader with isolation.level=read_committed does not see the uncommitted part.")
            : L("Тот же кластер, но без transactional.id: запись видна сразу и откатить её нечем.",
              "The same cluster, but without transactional.id: the write is visible at once and there is nothing to roll it back with."));

        KV.clear(outList);
        if (!rows.length) {
          outList.appendChild(el("div", {
            style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)", padding: "10px 0" },
            text: db ? L("в базе пусто", "the database is empty") : L("топик пуст", "the topic is empty")
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
              text: L("из offset ", "from offset ") + r.off
            }),
            info.flags[i] ? ui.badge(L("ДУБЛЬ", "DUPLICATE"), "bad") : null,
            r.pending ? ui.badge(L("не закоммичена", "not committed"), "warn") : null);
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
          ? L("группа billing · УПАЛ", "billing group · DOWN")
          : L("группа billing · committed ", "billing group · committed ") + committed;
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
          title: L("запись ", "record ") + id
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
          term.line(L('<span class="t-w">продюсер</span> → seq ', '<span class="t-w">producer</span> → seq ') +
            rec.seq + ' · ' + util.escape(rec.id) +
            ' <span class="t-good">ack ok</span> <span class="t-dim">offset ' + off + '</span>');
          refresh();
          if (say !== false) {
            stage.say(L("Запись <b>", "Record <b>") + util.escape(rec.id) +
              L("</b> легла в offset ", "</b> landed at offset ") + off +
              L(". Пока сеть не подводит, всё честно: одна отправка — одна запись.",
                ". As long as the network behaves, it is all honest: one send, one record."));
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
          term.line(L('<span class="t-w">продюсер</span> → seq ', '<span class="t-w">producer</span> → seq ') +
            rec.seq + ' · ' + util.escape(rec.id) +
            L(' <span class="t-dim">брокер записал offset ', ' <span class="t-dim">the broker wrote offset ') + off + '</span>');
          term.line(L('<span class="t-bad">✕ ack потерян: таймаут сети. Продюсер не знает, дошло или нет.</span>',
            '<span class="t-bad">✕ ack lost: network timeout. The producer has no idea whether it arrived.</span>'));
          refresh();
          stage.say(L("<b>Таймаут.</b> Брокер запись принял, но подтверждение не вернулось. У продюсера один вариант — отправить ещё раз.",
            "<b>Timeout.</b> The broker took the record, but the acknowledgement never came back. The producer has exactly one option — send it again."));
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
          term.line(L('<span class="t-w">продюсер</span> ретрай: та же запись, тот же seq ',
            '<span class="t-w">producer</span> retry: the same record, the same seq ') + rec.seq);
          if (idem) {
            strip.highlight(off, "is-hot", 900);
            term.line(L('<span class="t-good">брокер: PID ', '<span class="t-good">broker: PID ') +
              PID + ', seq ' + rec.seq +
              L(' уже принят → дубль отброшен, в лог не попал</span>',
                ' already accepted → duplicate dropped, it never reached the log</span>'));
            stage.say(L("<b>enable.idempotence спас.</b> Брокер помнит последний принятый номер для этого PID в этой партиции. " +
              "Ретрай пришёл с тем же <code>seq ",
              "<b>enable.idempotence saved you.</b> The broker remembers the last accepted number for this PID in this partition. " +
              "The retry came in with the same <code>seq ") + rec.seq +
              L("</code> → отброшен. В логе <b>одна</b> запись, offset ",
                "</code> → dropped. There is <b>one</b> record in the log, at offset ") + off + ".");
          } else {
            var off2 = strip.leo();
            strip.push({
              id: rec.id, evt: rec.evt, key: rec.id, label: rec.label,
              seq: rec.seq, title: L("дубль ", "duplicate ") + rec.id
            });
            term.line(L('<span class="t-bad">брокер без enable.idempotence номеров не помнит → вторая копия, offset ',
              '<span class="t-bad">without enable.idempotence the broker remembers no numbers → a second copy, offset ') +
              off2 + '</span>');
            stage.say(L("<b>Дубль в самой партиции.</b> Брокер не отличает ретрай от новой записи: ",
              "<b>A duplicate in the partition itself.</b> The broker cannot tell a retry from a new record: ") +
              util.escape(rec.id) +
              L(" лежит дважды, в offset ", " now sits there twice, at offset ") + off +
              L(" и ", " and ") + off2 +
              L(". Консьюмер честно обработает обе.", ". The consumer will dutifully process both."));
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
            term.line(L('<span class="t-r">консьюмер</span> offset ', '<span class="t-r">consumer</span> offset ') +
              off + ' · ' + util.escape(rec.id) +
              L(' <span class="t-good">уже обработан → пропуск (dedup по id)</span>',
                ' <span class="t-good">already processed → skipped (dedup by id)</span>'));
            if (crashArmed) { crash(off, null, true, e); return; }
            finish(off, null);
            stage.say(L("<b>Идемпотентный обработчик сработал.</b> ", "<b>The idempotent handler did its job.</b> ") +
              util.escape(rec.id) +
              L(" уже есть в таблице обработанных — запись прочитана второй раз, но наружу ничего не ушло. " +
                "Повторная <b>доставка</b> осталась, повторного <b>эффекта</b> нет.",
                " is already in the table of processed ids — the record was read a second time, but nothing went outside. " +
                "The repeated <b>delivery</b> is still there; the repeated <b>effect</b> is not."));
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
            term.line(L('<span class="t-r">консьюмер</span> offset ', '<span class="t-r">consumer</span> offset ') +
              off + ' · ' + util.escape(rec.id) +
              ' → ' + (out === "db"
                ? L("INSERT в orders_db", "INSERT into orders_db")
                : L("запись в топик results", "a write to the results topic")) +
              (row.pending
                ? L(' <span class="t-dim">(внутри транзакции)</span>', ' <span class="t-dim">(inside a transaction)</span>')
                : ''));
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
          (inTx ? L(" · транзакция закоммичена, запись видна read_committed",
            " · transaction committed, the record is visible to read_committed") : "") + '</span>');
        busy = false;
        refresh();
      }

      /* авария 2: падение ПОСЛЕ обработки и ДО коммита */
      function crash(off, row, wasSeen, e) {
        crashArmed = false;
        consumerDown = true;
        busy = false;
        consumer.classList.add("kv-node--dead");

        term.line(L('<span class="t-bad">✕ консьюмер упал ', '<span class="t-bad">✕ the consumer crashed ') +
          (row ? L("после обработки", "after processing") : L("после проверки id", "after the id check")) +
          L(' и ДО коммита. committed offset остался ', ' and BEFORE the commit. The committed offset stayed at ') +
          committed + '</span>');

        if (!row) {
          stage.say(L("<b>Упал, ничего не записав:</b> обработчик распознал знакомый id и наружу не пошёл. " +
            "Коммита нет, поэтому offset ",
            "<b>Crashed without writing anything:</b> the handler recognised a familiar id and never went outside. " +
            "There is no commit, so offset ") + off +
            L(" будет прочитан ещё раз — и снова ничего не произойдёт. " +
              "Вот это и значит «идемпотентно»: лишние чтения перестают быть аварией.",
              " will be read once more — and once more nothing will happen. " +
              "That is exactly what “idempotent” means: extra reads stop being an incident."));
        } else if (row.pending) {
          var i = rows.indexOf(row);
          if (i >= 0) rows.splice(i, 1);
          if (!wasSeen) delete seen[row.id];
          term.line(L('<span class="t-good">транзакция не закоммичена → запись в results отброшена; read_committed её и не видел</span>',
            '<span class="t-good">transaction not committed → the write to results is discarded; read_committed never saw it</span>'));
          stage.say(L("<b>Транзакция откатилась.</b> Выход — топик той же Kafka, поэтому запись результата и коммит offset были одним куском: " +
            "не закоммитили — значит, не было ничего. Консьюмер поднимется, обработает offset ",
            "<b>The transaction rolled back.</b> The output is a topic in the same Kafka, so the result write and the offset commit were one piece: " +
            "nothing was committed, so nothing happened. The consumer comes back up, processes offset ") + off +
            L(" заново, и на выходе останется <b>одна</b> строка.",
              " again, and <b>one</b> row is all that is left at the output."));
        } else if (out === "kafka") {
          stage.say(L("<b>Выход — Kafka, но транзакций нет.</b> Запись в results уже видна всем, коммита offset нет. " +
            "Поднимется — прочитает offset ",
            "<b>The output is Kafka, but there are no transactions.</b> The write to results is already visible to everyone, and the offset is not committed. " +
            "It comes back up, reads offset ") + off +
            L(" снова и запишет второй раз. Включи транзакции и повтори аварию.",
              " again and writes a second time. Turn transactions on and trigger the failure once more."));
        } else {
          stage.say(L("<b>Строка уже в базе, а offset не сдвинулся.</b> База снаружи Kafka: откатывать её брокеру нечем, " +
            "он про неё вообще не знает. Поднимется — прочитает offset ",
            "<b>The row is already in the database, and the offset has not moved.</b> The database is outside Kafka: the broker has nothing to roll it back with, " +
            "it does not even know it exists. It comes back up, reads offset ") + off +
            L(" заново и запишет строку второй раз.", " again and writes the row a second time."));
        }

        refresh();
        api.timeout(api.reduced ? 200 : 1700, function () {
          if (stale(e)) return;
          consumerDown = false;
          consumer.classList.remove("kv-node--dead");
          term.line(L('<span class="t-r">консьюмер поднялся</span> <span class="t-dim">читает с committed offset ',
            '<span class="t-r">the consumer is back</span> <span class="t-dim">reading from committed offset ') +
            committed + L(' — та же запись</span>', ' — the same record</span>'));
          refresh();
        });
      }

      /* ---------- сборка стенда ---------- */

      stage.body.appendChild(el("div.kv-row", null, producer, prodBadge));
      stage.body.appendChild(arrow(L("пишет в топик orders", "writes to the orders topic")));
      stage.body.appendChild(strip.el);
      stage.body.appendChild(arrow(L("читает с committed offset, обрабатывает, коммитит",
        "reads from the committed offset, processes, commits")));
      stage.body.appendChild(el("div.kv-row", null, consumer, consBadge));
      stage.body.appendChild(arrow(L("обработчик пишет результат наружу", "the handler writes the result outside")));
      stage.body.appendChild(el("div.kv-split", { style: { "margin-top": "4px" } },
        outPanel,
        el("div.kv-col", null,
          el("div.kv-panel__t", { text: L("журнал конвейера", "pipeline log") }),
          term.el)));
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.stats(statPart.el, statProc.el, statRows.el, statDup.el)));

      tIdem = ui.toggle("enable.idempotence", true, function (on) {
        prodBadge.textContent = "enable.idempotence: " + (on ? L("вкл", "on") : L("выкл", "off"));
        prodBadge.className = "kv-badge kv-badge--" + (on ? "good" : "bad");
        stage.say(on
          ? L("Продюсер идемпотентный: у него есть PID и сквозная нумерация записей в партиции. Брокер отбросит повтор с уже принятым номером. <b>С Kafka 3.0 это включено по умолчанию.</b>",
            "The producer is idempotent: it has a PID and a sequence number on every record inside the partition. The broker will drop a repeat carrying a number it has already accepted. <b>Since Kafka 3.0 this is on by default.</b>")
          : L("Идемпотентность выключена (так жили до Kafka 3.0). Любой ретрай после таймаута — это новая запись в логе.",
            "Idempotence is off (this is how it was before Kafka 3.0). Every retry after a timeout is a new record in the log."));
      });

      tTx = ui.toggle(L("транзакции Kafka→Kafka", "Kafka→Kafka transactions"), false, function (on) {
        renderOut();
        stage.say(on
          ? L("Транзакции включены: продюсер получил <code>transactional.id</code>, запись результата и коммит offset идут одной атомарной пачкой. <b>Работает это только если выход — тоже Kafka.</b>",
            "Transactions are on: the producer has a <code>transactional.id</code>, and the result write and the offset commit go as one atomic batch. <b>This only works if the output is Kafka too.</b>")
          : L("Транзакций нет: запись результата и коммит offset — два независимых действия. Между ними можно упасть.",
            "No transactions: the result write and the offset commit are two independent actions. You can crash between them."));
      });

      tHandler = ui.toggle(L("идемпотентный обработчик (dedup по id)", "idempotent handler (dedup by id)"), false, function (on) {
        consBadge.textContent = L("dedup по id: ", "dedup by id: ") + (on ? L("вкл", "on") : L("выкл", "off"));
        consBadge.className = "kv-badge kv-badge--" + (on ? "good" : "bad");
        stage.say(on
          ? L("Обработчик стал идемпотентным: перед работой смотрит в таблицу обработанных id и молча пропускает знакомые. Это единственное, что работает при любом выходе.",
            "The handler is idempotent now: before doing any work it looks into the table of processed ids and quietly skips the familiar ones. This is the only thing that works with any output.")
          : L("Обработчик наивный: что прочитал, то и записал. Любая повторная доставка станет повторной строкой.",
            "The handler is naive: whatever it reads, it writes. Every repeated delivery becomes a repeated row."));
      });

      outSeg = ui.seg([
        { value: "db", label: L("внешняя база", "external database") },
        { value: "kafka", label: L("топик Kafka", "Kafka topic") }
      ], "db", function (v) {
        out = v;
        renderOut();
        stage.say(v === "db"
          ? L("Выход — внешняя база. Всё, что записано туда, для Kafka невидимо и неоткатываемо.",
            "The output is an external database. Everything written there is invisible to Kafka and cannot be rolled back.")
          : L("Выход — топик той же Kafka. Только в этом контуре транзакция может накрыть и результат, и коммит offset сразу.",
            "The output is a topic in the same Kafka. Only inside this loop can a transaction cover both the result and the offset commit at once."));
      });

      /* Подпись и переключатель вместе не влезают в стенд на экране 360 px
         (339 px против 326 px), а .kv-stage прячет лишнее под overflow:hidden
         без прокрутки. Разрешаем паре переноситься: на узком экране подпись
         встаёт отдельной строкой, на широком ничего не меняется. */
      var outCtl = ui.ctl(L("выход обработчика", "handler output"), outSeg.el);
      outCtl.style.flexWrap = "wrap";

      function armCrash() {
        if (consumerDown) {
          stage.say(L("Консьюмер сейчас поднимается — дождись, пока он вернётся в строй.",
            "The consumer is coming back up right now — wait until it is on its feet again."));
          return;
        }
        if (crashArmed) {
          stage.say(L("Авария уже взведена — падение случится на ближайшей обработке.",
            "The failure is already armed — the crash will happen on the next record processed."));
          return;
        }
        crashArmed = true;
        if (committed >= strip.records.length) produce(false);
        stage.say(L("<b>Авария взведена.</b> Консьюмер обработает следующую запись и упадёт до коммита — смотри на offset и на выход.",
          "<b>Failure armed.</b> The consumer will process the next record and crash before the commit — watch the offset and the output."));
      }

      KV.append(stage.controls,
        ui.btn(L("Отправить событие", "Send an event"), function () { produce(); }, { variant: "primary" }),
        ui.btn(L("Таймаут сети: продюсер ретраит", "Network timeout: the producer retries"), netTimeout, { variant: "danger", sm: true }),
        ui.btn(L("Уронить консьюмер до коммита", "Crash the consumer before the commit"), armCrash, { variant: "danger", sm: true }),
        tIdem.el,
        tTx.el,
        tHandler.el,
        outCtl,
        ui.btn(L("Сбросить", "Reset"), function () {
          reset(L("Конвейер сброшен: три записи прошли путь целиком, дублей нет. Ломай.",
            "Pipeline reset: three records went all the way through, no duplicates. Now break it."));
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
        term.line(L('<span class="t-dim">штатный режим: 3 записи прошли продюсер → партицию → обработчик → выход</span>',
          '<span class="t-dim">normal mode: 3 records went producer → partition → handler → output</span>'));
        term.line('<span class="t-dim">committed offset ' + committed +
          L(' · дублей нет</span>', ' · no duplicates</span>'));
        refresh();
        stage.say(msg || "");
      }

      reset(L("Конвейер работает вхолостую: три записи уже прошли путь целиком. Теперь ломай его двумя красными кнопками и переключай тумблеры.",
        "The pipeline is idling: three records have already gone all the way through. Now break it with the two red buttons and flip the switches."));
      api.interval(1050, tick);
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
        "<h3>Из чего на самом деле состоит exactly-once</h3>" +
        "<p><strong>1. Идемпотентный продюсер.</strong> Kafka выдаёт продюсеру <code>Producer ID</code> (PID), а каждой записи — порядковый номер внутри [[партиция|партиции]]. " +
        "Брокер помнит последний принятый номер по паре PID+партиция и отбрасывает повтор. Включается <code>enable.idempotence=true</code>, " +
        "в Kafka 3.0+ включён по умолчанию. Ценой этого же механизма держится и порядок при ретраях.</p>" +
        "<p><strong>2. Транзакции.</strong> Для потока «прочитал → обработал → записал» нужна атомарность: продюсер берёт <code>transactional.id</code>, " +
        "и запись сразу в несколько партиций <em>плюс</em> коммит [[offset|offset'ов]] уходят одной транзакцией. " +
        "Читатель обязан выставить <code>isolation.level=read_committed</code> — иначе он увидит и то, что потом откатили.</p>" +
        "<h4>Где проходит граница</h4>" +
        "<p>Сквозная [[exactly-once]] живёт только в контуре <b>Kafka → Kafka</b>. Как только на выходе внешняя система — база, HTTP-вызов, письмо, платёж — " +
        "транзакция брокера её не накрывает: Kafka про неё не знает и откатить её нечем. Ты возвращаешься ровно туда, откуда начали: к идемпотентности на своей стороне.</p>",

        "<h3>What exactly-once is actually made of</h3>" +
        "<p><strong>1. The idempotent producer.</strong> Kafka hands the producer a <code>Producer ID</code> (PID), and every record a sequence number inside its [[partition]]. " +
        "The broker remembers the last accepted number per PID+partition pair and drops the repeat. You turn it on with <code>enable.idempotence=true</code>, " +
        "and since Kafka 3.0 it is on by default. The very same mechanism is what keeps the order intact across retries.</p>" +
        "<p><strong>2. Transactions.</strong> A “read → process → write” flow needs atomicity: the producer takes a <code>transactional.id</code>, " +
        "and a write into several partitions at once <em>plus</em> the commit of the [[offset|offsets]] all go as one transaction. " +
        "The reader has to set <code>isolation.level=read_committed</code> — otherwise it will also see what was rolled back afterwards.</p>" +
        "<h4>Where the boundary runs</h4>" +
        "<p>End-to-end [[exactly-once]] lives only inside the <b>Kafka → Kafka</b> loop. The moment an external system sits at the output — a database, an HTTP call, an email, a payment — " +
        "the broker’s transaction does not cover it: Kafka does not know about it and has nothing to roll it back with. You are right back where we started: idempotency on your own side.</p>"
      )));

      root.appendChild(ui.note("warn", L("ловушка", "the trap"), L(
        "<p><strong>«Включили <code>enable.idempotence</code> — значит, у нас exactly-once».</strong> Нет. " +
        "Идемпотентный продюсер даёт «ровно один раз» <em>для записи в партицию</em> и защищает ровно от одного сценария — ретрая продюсера после потерянного ack.</p>" +
        "<p>Падение [[консьюмер|консьюмера]] между обработкой и [[commit|коммитом]] он не лечит никак: это другая сторона конвейера. " +
        "Там работают либо транзакции (и только Kafka→Kafka), либо твой идемпотентный обработчик.</p>",

        "<p><strong>“We turned <code>enable.idempotence</code> on, so we have exactly-once.”</strong> No. " +
        "The idempotent producer gives you “exactly once” <em>for the write into a partition</em> and protects you from exactly one scenario — a producer retry after a lost ack.</p>" +
        "<p>It does nothing at all about a [[consumer]] crashing between processing and the [[commit]]: that is the other side of the pipeline. " +
        "What works there is either transactions (and only Kafka→Kafka) or your own idempotent handler.</p>"
      )));

      var yes = L('<span class="kv-badge kv-badge--good">спасает</span> ',
        '<span class="kv-badge kv-badge--good">saves you</span> ');
      var no = L('<span class="kv-badge kv-badge--bad">не спасает</span> ',
        '<span class="kv-badge kv-badge--bad">does not save you</span> ');
      var meh = L('<span class="kv-badge">не про это</span> ',
        '<span class="kv-badge">not about this</span> ');

      root.appendChild(ui.table(
        [
          L("Авария", "Failure"),
          "enable.idempotence",
          L("транзакции Kafka→Kafka", "Kafka→Kafka transactions"),
          L("идемпотентный обработчик", "idempotent handler")
        ],
        [
          [
            L("Ретрай продюсера после таймаута", "Producer retry after a timeout"),
            yes + L("брокер видит знакомый PID+seq и отбрасывает дубль",
              "the broker sees a familiar PID+seq and drops the duplicate"),
            meh + L("транзакция про атомарность, а не про ретраи",
              "a transaction is about atomicity, not about retries"),
            yes + L("дубль в партиции останется, но наружу не уйдёт",
              "the duplicate stays in the partition, but never goes outside")
          ],
          [
            L("Падение консьюмера до коммита,<br>выход — <b>внешняя база</b>",
              "Consumer crash before the commit,<br>output is an <b>external database</b>"),
            no + L("это защита записи в партицию, не обработки",
              "this protects the write into the partition, not the processing"),
            no + L("строка уже в базе, Kafka её не откатывает",
              "the row is already in the database, Kafka does not roll it back"),
            yes + L("<b>единственная работающая защита</b>", "<b>the only protection that works</b>")
          ],
          [
            L("Падение консьюмера до коммита,<br>выход — <b>топик Kafka</b>",
              "Consumer crash before the commit,<br>output is a <b>Kafka topic</b>"),
            no + L("та же история", "the same story"),
            yes + L("результат и коммит offset откатятся вместе",
              "the result and the offset commit roll back together"),
            yes + L("работает и здесь, но уже избыточно", "works here too, but by now it is redundant")
          ]
        ]
      ));

      root.appendChild(ui.prose(L(
        "<h4>Что из этого делать руками</h4>" +
        "<p>Проектируй под at-least-once по умолчанию: уникальный <code>id</code> в каждом событии, <code>UPSERT</code> вместо <code>INSERT</code>, " +
        "уникальный индекс в базе как последний рубеж. Тогда повторная доставка перестаёт быть аварией и становится скучной штатной ситуацией — " +
        "а транзакции включаешь только там, где поток действительно не выходит за пределы Kafka (например, Kafka Streams). " +
        "Цена у них не нулевая: лишние round-trip'ы координатору и задержка на стороне <code>read_committed</code>.</p>",

        "<h4>What you have to do yourself</h4>" +
        "<p>Design for at-least-once by default: a unique <code>id</code> in every event, an <code>UPSERT</code> instead of an <code>INSERT</code>, " +
        "a unique index in the database as the last line of defence. Then a repeated delivery stops being an incident and becomes a boring, ordinary situation — " +
        "and you turn transactions on only where the flow really does not leave Kafka (Kafka Streams, for example). " +
        "They are not free: extra round-trips to the coordinator and added latency on the <code>read_committed</code> side.</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "База — [[at-least-once]]: доставка гарантирована, единственность — нет. Зазор между обработкой и [[commit|коммитом]] неустраним.",
          "Поэтому обработчик обязан быть [[идемпотентность|идемпотентным]]: уникальный <code>id</code> + проверка «уже обработан?».",
          "<code>enable.idempotence</code> (PID + номер записи) закрывает <b>только</b> ретрай продюсера и <b>только</b> запись в [[партиция|партицию]]. Это не сквозная гарантия.",
          "Транзакции (<code>transactional.id</code> + <code>read_committed</code>) делают атомарными результат и коммит offset — но лишь в контуре <b>Kafka → Kafka</b>.",
          "Внешняя база, HTTP или письмо на выходе — и [[exactly-once]] заканчивается: остаётся твоя идемпотентность."
        ],
        [
          "The baseline is [[at-least-once]]: delivery is guaranteed, uniqueness is not. The gap between processing and the [[commit]] cannot be removed.",
          "So the handler has to be [[idempotency|idempotent]]: a unique <code>id</code> plus an “already processed?” check.",
          "<code>enable.idempotence</code> (PID + record number) covers <b>only</b> the producer retry and <b>only</b> the write into a [[partition]]. It is not an end-to-end guarantee.",
          "Transactions (<code>transactional.id</code> + <code>read_committed</code>) make the result and the offset commit atomic — but only inside the <b>Kafka → Kafka</b> loop.",
          "An external database, an HTTP call or an email at the output, and [[exactly-once]] ends: what is left is your own idempotency."
        ]
      )));
    }
  });
})();
