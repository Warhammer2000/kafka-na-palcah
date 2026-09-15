/* Глава 11 — acks и min.insync.replicas: лаборатория отказа. */
(function () {
  "use strict";
  /* Осторожно: write/doKill/catchUp объявляют свою «var L = leaderNode()»,
     и короткое имя L там перекрыто. Внутри этих трёх функций — только KV.L. */
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "acks",
    num: 11,
    group: ["Надёжность", "Reliability"],
    nav: ["acks и min.insync", "acks and min.insync"],
    title: ["acks=all обманчив без min.insync.replicas", "acks=all is deceptive without min.insync.replicas"],
    lede: [
      "<code>acks=all</code> читается как «дождались всех». На самом деле — «дождались всех, кто <b>сейчас</b> в ISR», а ISR умеет схлопнуться до одного лидера. Настройка соблюдена, копия одна.",
      "<code>acks=all</code> reads as “we waited for everyone”. It really means “we waited for everyone who is in the ISR <b>right now</b>” — and the ISR can collapse down to the leader alone. The setting is honoured; the copy is one."
    ],

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(L(
        "<p>[[продюсер|Продюсер]] отправил сообщение. Когда считать, что <em>отправка удалась</em>? " +
        "Момент выбирается не сам собой: запись ушла в сеть, легла в память [[лидер|лидера]], попала на диск, " +
        "разошлась по копиям — на любом из этих шагов можно объявить «готово» и пойти дальше.</p>" +
        "<p>Настройка <code>acks</code> (acknowledgements, подтверждения) и выбирает этот момент. " +
        "Чем позже — тем дольше ждёшь и тем меньше рискуешь.</p>",

        "<p>A [[producer]] has sent a message. When do you count the <em>send as successful</em>? " +
        "That moment does not pick itself: the record went out on the wire, landed in the [[leader]]’s memory, hit the disk, " +
        "spread across the copies — at any of those steps you can declare “done” and move on.</p>" +
        "<p>The <code>acks</code> setting (short for acknowledgements) is what picks that moment. " +
        "The later it is, the longer you wait and the less you risk.</p>"
      )));

      root.appendChild(ui.table(
        L(["acks", "чего ждёт продюсер", "аналогия с почтой", "чем платишь"],
          ["acks", "what the producer waits for", "the postal analogy", "what it costs you"]),
        L([
          ["<code>0</code>", "ничего — отправил и забыл",
            "бросил письмо в ящик и ушёл",
            "потеря при любом сбое — и <b>ты о ней не узнаешь</b>"],
          ["<code>1</code>", "подтверждение лидера",
            "дождался, пока приняли на почте",
            "лидер умер до репликации → потеря"],
          ["<code>all</code>", "подтверждения всех реплик <b>из ISR</b>",
            "дождался, пока разослали по филиалам",
            "задержка выше; и есть ловушка — см. стенд"]
        ], [
          ["<code>0</code>", "nothing — fire and forget",
            "dropped the letter in the box and walked away",
            "a loss on any failure — and <b>you will never hear about it</b>"],
          ["<code>1</code>", "the leader’s acknowledgement",
            "waited until the post office took it in",
            "the leader dies before replication → loss"],
          ["<code>all</code>", "acknowledgements from every replica <b>in the ISR</b>",
            "waited until it went out to the branch offices",
            "higher latency; and there is a trap — see the demo"]
        ])
      ));

      root.appendChild(ui.note("warn", L("ловушка", "the trap"), L(
        "<p><strong>Список [[ISR]] не зафиксирован — Kafka пересобирает его на ходу.</strong> Реплика, отставшая дольше " +
        "<code>replica.lag.time.max.ms</code> (по умолчанию 30 секунд), вычёркивается автоматически: ни рестарта, ни правки конфига.</p>" +
        "<p>Было: <code>ISR = [лидер, реплика-2, реплика-3]</code> → ждём троих. Реплики отстали и выпали из ISR: " +
        "<code>ISR = [лидер]</code> → тот же <code>acks=all</code> ждёт <b>одного</b>. " +
        "Конфигурацию никто не менял, а защиты больше нет.</p>",

        "<p><strong>The [[ISR]] list is not fixed — Kafka rebuilds it on the fly.</strong> A replica that falls behind for longer than " +
        "<code>replica.lag.time.max.ms</code> (30 seconds by default) is struck off automatically: no restart, no config change.</p>" +
        "<p>Before: <code>ISR = [leader, replica-2, replica-3]</code> → we wait for three. The replicas fall behind and drop out of the ISR: " +
        "<code>ISR = [leader]</code> → the very same <code>acks=all</code> now waits for <b>one</b>. " +
        "Nobody touched the configuration, and the protection is gone.</p>"
      )));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: L("Лаборатория отказа", "A failure lab"),
        hint: L("Ловушка собирается в три клика: acks=all · реплика отстала · min.insync = 1",
          "The trap takes three clicks to build: acks=all · a replica falls behind · min.insync = 1")
      });

      var T = api.reduced ? 0.12 : 1;
      var FLY = Math.max(1, Math.round(340 * T));
      var HOP = Math.max(1, Math.round(340 * T));
      var WINDOW = Math.max(1, Math.round(950 * T));

      var nodes = [];
      var seq = 0;
      var busy = false;
      var gone = false;                     // глава закрыта — продолжать прогон нельзя
      api.onDestroy(function () { gone = true; });
      var minIsr = 1;
      var acksMode = "all";
      var counters = { ok: 0, lost: 0, rejected: 0 };

      /* --- продюсер --- */
      var producer = ui.node("producer", L("продюсер", "producer"), L("orders · партиция 0", "orders · partition 0"));
      var waitEl = el("span", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" }
      });
      var producerRow = el("div.kv-row", { style: { "margin-bottom": "14px" } }, producer, waitEl);

      /* --- панель ISR --- */
      var isrBadges = el("div.kv-row");
      var isrNote = el("div", { style: { "font-size": "12.5px", color: "var(--muted)", "margin-top": "8px" } });
      var lagBtn = ui.btn(L("Реплика отстала", "A replica falls behind"), function () { lag(); }, { sm: true, variant: "danger" });
      var catchBtn = ui.btn(L("Реплики догнали", "Replicas caught up"), function () { catchUp(); }, { sm: true });
      var isrPanel = ui.panel(L("Кто сейчас синхронен", "Who is in sync right now"),
        isrBadges,
        isrNote,
        el("div.kv-row", { style: { "margin-top": "10px" } }, lagBtn, catchBtn));

      /* --- кластер --- */
      var logWrap = ui.log();

      function makeNode(i) {
        var s = ui.logStrip({
          label: L("брокер ", "broker ") + (i + 1),
          sub: L("реплика", "replica"),
          empty: L("лог пуст", "the log is empty")
        });
        var lab = s.el.querySelector(".kv-part__label");
        var n = {
          i: i, strip: s, el: s.el, labelEl: lab,
          nameEl: lab.querySelector("b"), roleEl: lab.querySelector("span"),
          alive: true, leader: i === 0, sync: true, log: []
        };
        logWrap.appendChild(s.el);
        return n;
      }
      for (var i = 0; i < 3; i++) nodes.push(makeNode(i));

      var term = ui.terminal(L('<span class="t-dim">кластер поднят: 3 брокера, replication.factor = 3</span>',
        '<span class="t-dim">cluster up: 3 brokers, replication.factor = 3</span>'));

      /* --- плитки --- */
      var stAcks = ui.stat("acks", "all", { tone: "good" });
      var stIsr = ui.stat("ISR", "3 / 3", { tone: "good" });
      var stMin = ui.stat("min.insync", "1", { tone: "warn" });
      var stVerdict = ui.stat(L("вердикт", "verdict"), "—");
      var stOk = ui.stat(L("подтверждено", "acknowledged"), "0");
      var stLost = ui.stat(L("тихих потерь", "silent losses"), "0");
      var stRej = ui.stat(L("явных отказов", "explicit rejections"), "0");

      /* ---------------- состояние ---------------- */

      function aliveNodes() { return nodes.filter(function (n) { return n.alive; }); }
      function isr() { return nodes.filter(function (n) { return n.alive && (n.leader || n.sync); }); }
      function leaderNode() {
        for (var k = 0; k < nodes.length; k++) if (nodes[k].alive && nodes[k].leader) return nodes[k];
        return null;
      }
      function isrStr() {
        var br = L("бр", "br");
        return "[" + isr().map(function (n) { return br + (n.i + 1); }).join(", ") + "]";
      }
      function toCell(r, off) {
        return { key: r.key, label: r.label, title: L("запись ", "record ") + r.label + " · offset " + off };
      }
      function pushTo(node, r) {
        var off = node.log.length;
        node.log.push(r);
        node.strip.push(toCell(r, off));
        return off;
      }
      function syncTo(node, source) {
        node.log = source.log.slice();
        node.strip.setRecords(node.log.map(toCell));
      }

      function paint() {
        nodes.forEach(function (n) {
          var role, color;
          if (!n.alive) { role = L("мёртв", "dead"); color = "var(--bad)"; }
          else if (n.leader) { role = L("лидер · пишем сюда", "leader · writes go here"); color = "var(--write)"; }
          else if (n.sync) { role = L("реплика · в ISR", "replica · in the ISR"); color = "var(--good)"; }
          else { role = L("реплика · отстала", "replica · fell behind"); color = "var(--warn)"; }
          n.roleEl.textContent = role;
          n.roleEl.style.color = color;
          n.labelEl.classList.toggle("kv-node--dead", !n.alive);
        });

        KV.clear(isrBadges);
        nodes.forEach(function (n) {
          var text = L("брокер ", "broker ") + (n.i + 1), tone;
          if (!n.alive) { text += L(" · мёртв", " · dead"); tone = "bad"; }
          else if (n.leader) { text += L(" · лидер", " · leader"); tone = "write"; }
          else if (n.sync) { text += L(" · в ISR", " · in the ISR"); tone = "good"; }
          else { text += L(" · вне ISR", " · out of the ISR"); tone = "warn"; }
          isrBadges.appendChild(ui.badge(text, tone));
        });

        var c = isr().length;
        isrNote.textContent = "ISR = " + isrStr() + " — " + c + " " +
          util.plural(c, L("синхронная копия", "in-sync copy"), L("синхронные копии", "in-sync copies"),
            L("синхронных копий", "in-sync copies")) +
          L(". Именно этот список ждёт acks=all.", ". This is exactly the list acks=all waits for.");

        if (acksMode === "0") waitEl.textContent = L("→ ждёт: ничего", "→ waiting for: nothing");
        else if (acksMode === "1") waitEl.textContent = L("→ ждёт: лидера (1 подтверждение)", "→ waiting for: the leader (1 acknowledgement)");
        else waitEl.textContent = L("→ ждёт: всех из ISR, сейчас это ", "→ waiting for: everyone in the ISR, right now that is ") + c;

        stAcks.set(acksMode, acksMode === "all" ? "good" : acksMode === "1" ? "warn" : "bad");
        stIsr.set(c + " / " + aliveNodes().length, c >= 3 ? "good" : c === 2 ? "warn" : "bad");
        stMin.set(String(minIsr), minIsr === 2 ? "good" : minIsr === 1 ? "warn" : "bad");
        stOk.set(String(counters.ok));
        stLost.set(String(counters.lost), counters.lost ? "bad" : null);
        stRej.set(String(counters.rejected), counters.rejected ? "warn" : null);
      }

      function setBusy(b) {
        busy = b;
        [writeBtn, killBtn, lagBtn, catchBtn, trapBtn, presetBtn, resetBtn].forEach(function (x) {
          x.disabled = b;
        });
        /* Конфигурацию тоже замораживаем на время прогона: иначе acks или min.insync
           успевают смениться между «ok» и репликацией, и вердикт разъезжается с тем,
           что человек только что видел. */
        minRange.input.disabled = b;
        Array.prototype.forEach.call(acksSeg.el.querySelectorAll("button"), function (x) {
          x.disabled = b;
        });
      }

      /* ---------------- прогон записи ---------------- */

      function write(kill) {
        if (busy) return;
        var L = leaderNode();
        if (!L) {
          stage.say(KV.L("<b>Писать некуда.</b> У партиции не осталось живого лидера — нажми «Поднять кластер заново».",
            "<b>Nowhere to write.</b> The partition has no live leader left — press “Bring the cluster back up”."));
          return;
        }
        setBusy(true);
        seq++;
        var rec = { seq: seq, key: "m" + seq, label: String(seq) };
        var isrNow = isr();

        term.line(KV.L('<span class="t-dim">&gt; produce(запись ', '<span class="t-dim">&gt; produce(record ') +
          rec.label + ')   acks=' + acksMode +
          "   ISR=" + isrStr() + "   min.insync=" + minIsr + "</span>");

        /* --- порог брокера проверяется ТОЛЬКО при acks=all --- */
        if (acksMode === "all" && isrNow.length < minIsr) {
          term.line(KV.L('  <span class="t-dim">проверка брокера: |ISR| = ', '  <span class="t-dim">broker check: |ISR| = ') +
            isrNow.length + " &lt; min.insync.replicas = " + minIsr + "</span>");
          term.line(KV.L('  <span class="t-bad">x NotEnoughReplicasException — запись отклонена, в лог не попала</span>',
            '  <span class="t-bad">x NotEnoughReplicasException — the write was rejected, it never reached the log</span>'));
          counters.rejected++;
          stVerdict.set(KV.L("отказ", "rejected"), "warn");
          stage.say(KV.L("<b>ЯВНАЯ ОШИБКА · NotEnoughReplicasException.</b> В ISR ",
            "<b>AN EXPLICIT ERROR · NotEnoughReplicasException.</b> The ISR holds ") + isrNow.length + " " +
            util.plural(isrNow.length, KV.L("копия", "copy"), KV.L("копии", "copies"), KV.L("копий", "copies")) +
            KV.L(", а <code>min.insync.replicas = ", ", while <code>min.insync.replicas = ") + minIsr +
            KV.L("</code> — брокер отказался принимать запись. Продюсер получил исключение и знает, что делать: " +
              "повторить, придержать в буфере, разбудить дежурного. <b>Данные целы; потеряна доступность на запись</b> — " +
              "и это верный размен.",
              "</code> — so the broker refused to take the write. The producer got an exception and knows what to do: " +
              "retry, hold it in a buffer, page the on-call. <b>The data is intact; what you lost is availability for writes</b> — " +
              "and that is the right trade."));
          paint();
          setBusy(false);
          return;
        }
        if (acksMode !== "all" && minIsr > 1) {
          term.line('  <span class="t-dim">min.insync.replicas = ' + minIsr +
            KV.L(" не проверяется: он действует только при acks=all</span>",
              " is not checked: it only applies with acks=all</span>"));
        }

        /* --- acks=0: «ok» выдаётся до того, как запись куда-то доехала --- */
        if (acksMode === "0") {
          term.line(KV.L('  <span class="t-w">→ ok продюсеру сразу: acks=0 не ждёт ничего</span>',
            '  <span class="t-w">→ ok to the producer right away: acks=0 waits for nothing</span>'));
          counters.ok++;
          if (kill) {
            term.line(KV.L('  <span class="t-bad">! лидер падает, пока запись ещё в полёте</span>',
              '  <span class="t-bad">! the leader dies while the record is still in flight</span>'));
            doKill({ rec: rec, inflight: true, copies: 0 });
            return;
          }
        }

        KV.fly(producer, L.labelEl, {
          label: rec.label,
          color: util.keyColor(rec.key),
          soft: util.keyColorSoft(rec.key),
          ms: FLY
        }).then(function () { if (!gone) landed(); });

        function landed() {
          var off = pushTo(L, rec);
          term.line(KV.L('  <span class="t-w">брокер ', '  <span class="t-w">broker ') + (L.i + 1) +
            KV.L(" (лидер): append offset ", " (the leader): append offset ") + off + "</span>");
          var followers = isr().filter(function (n) { return !n.leader; });

          if (acksMode === "all") {
            copyChain(followers, 0, function () {
              var copies = followers.length + 1;
              ack(copies);
              if (kill) { term.line(BOLT); doKill({ rec: rec, inflight: false, copies: copies }); }
              else done(copies);
            });
            return;
          }

          if (acksMode === "1") ack(1);
          if (kill) { term.line(BOLT); doKill({ rec: rec, inflight: false, copies: 1 }); return; }

          api.timeout(WINDOW, function () {
            var late = isr().filter(function (n) { return !n.leader; });
            late.forEach(function (n) { pushTo(n, rec); });
            if (late.length) {
              term.line(KV.L('  <span class="t-good">репликация догнала: запись ',
                '  <span class="t-good">replication caught up: record ') + rec.label +
                KV.L(" лежит на ", " now sits on ") + (late.length + 1) + " " +
                util.plural(late.length + 1, KV.L("копии", "copy"), KV.L("копиях", "copies"),
                  KV.L("копиях", "copies")) + "</span>");
            } else {
              term.line(KV.L('  <span class="t-bad">копировать некому: в ISR только лидер</span>',
                '  <span class="t-bad">nobody to copy to: the ISR holds only the leader</span>'));
            }
            done(late.length + 1);
          });
        }

        function copyChain(list, k, after) {
          if (k >= list.length) { after(); return; }
          api.timeout(HOP, function () {
            var f = list[k];
            var off = pushTo(f, rec);
            term.line(KV.L('  <span class="t-good">брокер ', '  <span class="t-good">broker ') + (f.i + 1) +
              KV.L(": скопировал offset ", ": copied offset ") + off +
              KV.L(", подтвердил лидеру</span>", ", acknowledged to the leader</span>"));
            copyChain(list, k + 1, after);
          });
        }

        function ack(n) {
          if (acksMode === "0") return;
          counters.ok++;
          if (acksMode === "1") {
            term.line(KV.L('  <span class="t-w">→ ok продюсеру: ждали только лидера</span>',
              '  <span class="t-w">→ ok to the producer: we only waited for the leader</span>'));
          } else if (n <= 1) {
            term.line(KV.L('  <span class="t-w">→ ok продюсеру: ждали всех из ISR, а в ISR один лидер</span>',
              '  <span class="t-w">→ ok to the producer: we waited for everyone in the ISR, and the ISR is the leader alone</span>'));
          } else {
            term.line(KV.L('  <span class="t-good">→ ok продюсеру: дождались всех из ISR (',
              '  <span class="t-good">→ ok to the producer: we waited for everyone in the ISR (') + n + ")</span>");
          }
        }

        function done(copies) {
          var txt;
          if (acksMode === "all" && copies >= 2) {
            stVerdict.set(KV.L("записано", "written"), "good");
            txt = KV.L("<b>СОХРАНЕНО.</b> «ok» пришёл только после того, как запись ",
              "<b>SAVED.</b> The “ok” came only after record ") + rec.label +
              KV.L(" легла на ", " had landed on ") +
              copies + " " + util.plural(copies, KV.L("копию", "copy"), KV.L("копии", "copies"), KV.L("копий", "copies")) +
              KV.L(". Убей сейчас лидера — запись переживёт его: новым лидером станет копия, у которой она есть.",
                ". Kill the leader now and the record outlives it: the new leader will be a copy that has it.");
          } else if (acksMode === "all") {
            stVerdict.set(KV.L("записано", "written"), "warn");
            txt = KV.L("<b>Записано — но копия ровно одна.</b> <code>acks=all</code> честно дождался всех из ISR, " +
              "а в ISR был только лидер. Формально настройка соблюдена, фактически защиты нет. " +
              "Жми «Записать и убить лидера в момент ok» — увидишь, чем это заканчивается.",
              "<b>Written — but there is exactly one copy.</b> <code>acks=all</code> honestly waited for everyone in the ISR, " +
              "and the ISR held the leader alone. On paper the setting is honoured; in practice there is no protection. " +
              "Press “Write and kill the leader at the moment of ok” — you will see how that ends.");
          } else if (acksMode === "1") {
            stVerdict.set(KV.L("записано", "written"), "warn");
            txt = KV.L("<b>Записано.</b> «ok» ушёл сразу после лидера, реплики скопировали запись позже. " +
              "В этом окне между «ok» и репликацией и живёт потеря — кнопка «убить лидера в момент ok» бьёт ровно туда.",
              "<b>Written.</b> The “ok” went out right after the leader, and the replicas copied the record later. " +
              "The loss lives in that window between the “ok” and replication — the “kill the leader at the moment of ok” button aims right at it.");
          } else {
            stVerdict.set(KV.L("записано", "written"), "warn");
            txt = KV.L("<b>Записано, но продюсер этого не проверял.</b> При <code>acks=0</code> «ok» выдан ещё до того, " +
              "как запись доехала до брокера. В этот раз совпало; не совпадёт — ответ будет тем же «успех».",
              "<b>Written, but the producer never checked.</b> With <code>acks=0</code> the “ok” was issued before " +
              "the record even reached the broker. This time it worked out; when it does not, the answer will be the same “success”.");
          }
          stage.say(txt);
          paint();
          setBusy(false);
        }
      }

      var BOLT = L('  <span class="t-bad">! лидер падает ровно в момент ok</span>',
        '  <span class="t-bad">! the leader dies at the exact moment of ok</span>');

      /* ---------------- смерть лидера и выборы ---------------- */

      function doKill(o) {
        var L = leaderNode();
        L.alive = false; L.leader = false; L.sync = false;
        term.line(KV.L('  <span class="t-bad">! брокер ', '  <span class="t-bad">! broker ') + (L.i + 1) +
          KV.L(" (лидер) упал</span>", " (the leader) is down</span>"));

        var alive = aliveNodes();
        if (!alive.length) {
          counters.lost += L.log.length + (o.inflight ? 1 : 0);
          stVerdict.set(KV.L("кластер мёртв", "cluster dead"), "bad");
          term.line(KV.L('  <span class="t-bad">живых копий не осталось: партиция недоступна, лог потерян</span>',
            '  <span class="t-bad">no live copies left: the partition is unavailable, the log is gone</span>'));
          stage.say(KV.L("<b>Живых копий не осталось.</b> Партиция без единой реплики — ни читать, ни писать. " +
            "Нажми «Поднять кластер заново».",
            "<b>No live copies left.</b> A partition without a single replica — you can neither read nor write. " +
            "Press “Bring the cluster back up”."));
          paint();
          setBusy(false);
          return;
        }

        var inIsr = alive.filter(function (n) { return n.sync; });
        var pool = inIsr.length ? inIsr : alive;
        var nl = pool[0];
        pool.forEach(function (n) { if (n.log.length > nl.log.length) nl = n; });
        if (!inIsr.length) {
          term.line(KV.L('  <span class="t-bad">в ISR не осталось никого: при unclean.leader.election.enable=true ' +
            "лидером становится отставшая копия — по умолчанию флаг выключен, и партиция просто ушла бы в offline</span>",
            '  <span class="t-bad">nobody is left in the ISR: with unclean.leader.election.enable=true ' +
            "a copy that fell behind becomes the leader — by default the flag is off, and the partition would simply go offline</span>"));
        }
        nl.leader = true; nl.sync = true;

        var have = {};
        nl.log.forEach(function (r) { have[r.seq] = true; });
        var lost = [];
        L.log.forEach(function (r, off) {
          if (!have[r.seq]) { lost.push(r); L.strip.setState(off, "dropped"); }
        });
        alive.forEach(function (n) { if (n !== nl && n.sync) syncTo(n, nl); });

        var nLost = lost.length + (o.inflight ? 1 : 0);
        counters.lost += nLost;
        term.line(KV.L('  <span class="t-dim">новый лидер: брокер ', '  <span class="t-dim">new leader: broker ') +
          (nl.i + 1) + KV.L(", его LEO = ", ", its LEO = ") + nl.log.length + "</span>");

        if (nLost === 0) {
          stVerdict.set(KV.L("пережила", "survived"), "good");
          term.line(KV.L('  <span class="t-good">потерь нет: все подтверждённые записи есть у нового лидера</span>',
            '  <span class="t-good">no losses: the new leader has every acknowledged record</span>'));
          stage.say(KV.L("<b>СОХРАНЕНО.</b> Лидер умер, но всё, что он успел подтвердить, уже лежало на брокере ",
            "<b>SAVED.</b> The leader died, but everything it had managed to acknowledge was already on broker ") +
            (nl.i + 1) + KV.L(" — он и стал лидером. Ни одна подтверждённая запись не пропала: " +
              "<code>acks=all</code> ждал живых копий, а не формальности.",
              " — and that is the one that became leader. Not a single acknowledged record was lost: " +
              "<code>acks=all</code> waited for live copies, not for a formality."));
        } else {
          stVerdict.set(KV.L("потеря", "data loss"), "bad");
          var list = lost.map(function (r) { return r.label; }).join(", ");
          term.line(KV.L('  <span class="t-bad">потеряно навсегда: ', '  <span class="t-bad">lost for good: ') + nLost + " " +
            util.plural(nLost, KV.L("запись", "record"), KV.L("записи", "records"), KV.L("записей", "records")) +
            (list ? " (" + list + ")" : "") +
            KV.L(" — по ним уже отдан ok</span>", " — already acknowledged to the producer</span>"));

          var head = KV.L("<b>ТИХАЯ ПОТЕРЯ — продюсер получил ok, данных нет.</b> ",
            "<b>A SILENT LOSS — the producer got an ok, the data is gone.</b> ");
          if (o.inflight) {
            stage.say(head + KV.L("Запись ", "Record ") + o.rec.label +
              KV.L(" даже не доехала до брокера, а «успех» продюсер выдал себе сам: " +
                "при <code>acks=0</code> он не ждёт ответа и не узнает об отказе никогда. " +
                "Ни исключения, ни метрики, ни строчки в логе — сверка через месяц, и то если повезёт.",
                " never even reached the broker, and the producer handed itself the “success”: " +
                "with <code>acks=0</code> it waits for no answer and will never learn about the failure. " +
                "No exception, no metric, not a line in the log — a reconciliation a month later, and only if you are lucky."));
          } else if (acksMode === "all") {
            stage.say(head + KV.L("<code>acks=all</code> дождался всех из ISR — а в ISR был один лидер. " +
              "«Все» оказались «одним»: <code>min.insync.replicas = ",
              "<code>acks=all</code> waited for everyone in the ISR — and the ISR held one leader. " +
              "“Everyone” turned out to be “one”: <code>min.insync.replicas = ") + minIsr +
              KV.L("</code> разрешил принять запись " +
                "при единственной копии, копия умерла вместе с брокером. Потеряно записей: ",
                "</code> allowed the write to be taken " +
                "with a single copy, and that copy died together with the broker. Records lost: ") + nLost +
              KV.L(". Подними <code>min.insync.replicas</code> до 2 и повтори — та же ситуация даст явную ошибку вместо тишины.",
                ". Raise <code>min.insync.replicas</code> to 2 and try again — the same situation will give an explicit error instead of silence."));
          } else {
            stage.say(head + KV.L("Лидер подтвердил запись и умер раньше, чем реплики её скопировали. " +
              "Продюсер видел «ok», в кластере записи нет. Разница между <code>acks=1</code> и <code>acks=all</code> — " +
              "ровно это окно: при <code>all</code> ответ не уходит, пока копии не подтвердят.",
              "The leader acknowledged the record and died before the replicas copied it. " +
              "The producer saw an “ok”; the record is nowhere in the cluster. The difference between <code>acks=1</code> and <code>acks=all</code> " +
              "is exactly that window: with <code>all</code> the answer does not go out until the copies confirm."));
          }
        }
        paint();
        setBusy(false);
      }

      /* ---------------- ISR: отстали / догнали ---------------- */

      function lag() {
        if (!leaderNode()) {
          stage.say(L("Живого лидера нет — отставать не от кого. Нажми «Поднять кластер заново».",
            "There is no live leader — nobody to fall behind. Press “Bring the cluster back up”."));
          return;
        }
        var victims = nodes.filter(function (n) { return n.alive && !n.leader && n.sync; });
        if (!victims.length) {
          stage.say(L("В ISR остался один лидер — схлопываться дальше некуда.",
            "Only the leader is left in the ISR — there is nowhere further to collapse."));
          return;
        }
        var v = victims[victims.length - 1];
        v.sync = false;
        paint();
        var c = isr().length;
        term.line(L('<span class="t-bad">! брокер ', '<span class="t-bad">! broker ') + (v.i + 1) +
          L(" отстал → выбит из ISR (replica.lag.time.max.ms)</span>",
            " fell behind → struck off the ISR (replica.lag.time.max.ms)</span>"));
        stage.say(L("<b>ISR схлопнулся до ", "<b>The ISR collapsed to ") + c +
          L(".</b> Брокер ", ".</b> Broker ") + (v.i + 1) +
          L(" перестал успевать за лидером, и Kafka вычеркнула его из списка синхронных. " +
            "Конфигурацию никто не трогал, но <code>acks=all</code> теперь ждёт ",
            " stopped keeping up with the leader, and Kafka struck it off the in-sync list. " +
            "Nobody touched the configuration, but <code>acks=all</code> now waits for ") + c + " " +
          util.plural(c, L("подтверждение", "acknowledgement"), L("подтверждения", "acknowledgements"),
            L("подтверждений", "acknowledgements")) + L(" вместо трёх.", " instead of three."));
      }

      function catchUp() {
        var L = leaderNode();
        if (!L) {
          stage.say(KV.L("Сначала подними кластер: живого лидера нет.",
            "Bring the cluster back up first: there is no live leader."));
          return;
        }
        var back = 0;
        nodes.forEach(function (n) {
          if (!n.alive || n.leader) return;
          if (!n.sync) back++;
          n.sync = true;
          syncTo(n, L);
        });
        paint();
        term.line(KV.L('<span class="t-good">+ реплики дочитали лог лидера и вернулись в ISR</span>',
          '<span class="t-good">+ the replicas read the leader’s log to the end and came back into the ISR</span>'));
        stage.say(back
          ? KV.L("<b>Реплики догнали.</b> Они дочитали хвост лога и вернулись в ISR — теперь в нём ",
              "<b>The replicas caught up.</b> They read the tail of the log and returned to the ISR — it now holds ") + isr().length +
            " " + util.plural(isr().length, KV.L("копия", "copy"), KV.L("копии", "copies"), KV.L("копий", "copies")) +
            KV.L(", и <code>acks=all</code> снова ждёт настоящих подтверждений.",
              ", and <code>acks=all</code> is waiting for real acknowledgements again.")
          : KV.L("Все живые реплики и так были в ISR — ждать нечего.",
              "Every live replica was in the ISR already — there is nothing to wait for."));
      }

      /* ---------------- пресеты и сброс ---------------- */

      function resetCluster() {
        seq = 0;
        nodes.forEach(function (n, k) {
          n.alive = true; n.leader = (k === 0); n.sync = true;
          n.log = [];
          n.strip.clear();
        });
        for (var s = 0; s < 3; s++) {
          seq++;
          var r = { seq: seq, key: "m" + seq, label: String(seq) };
          nodes.forEach(function (n) { n.log.push(r); });
        }
        nodes.forEach(function (n) { n.strip.setRecords(n.log.map(toCell)); });
        stVerdict.set("—", null);
        paint();
      }

      function trap() {
        resetCluster();
        acksMode = "all"; acksSeg.set("all");
        minIsr = 1; minRange.set(1);
        nodes.forEach(function (n) { if (!n.leader) n.sync = false; });
        paint();
        term.line(L('<span class="t-w">= ловушка собрана: acks=all, min.insync.replicas=1, ISR=[лидер]</span>',
          '<span class="t-w">= the trap is set: acks=all, min.insync.replicas=1, ISR=[leader]</span>'));
        stage.say(L("<b>Ловушка собрана.</b> <code>acks=all</code>, <code>min.insync.replicas = 1</code>, обе реплики " +
          "выпали из ISR. На бумаге конфигурация безопасна — «ждём всех». Жми «Записать и убить лидера в момент ok».",
          "<b>The trap is set.</b> <code>acks=all</code>, <code>min.insync.replicas = 1</code>, and both replicas " +
          "have dropped out of the ISR. On paper the configuration is safe — “we wait for everyone”. Press “Write and kill the leader at the moment of ok”."));
      }

      function preset() {
        resetCluster();
        acksMode = "all"; acksSeg.set("all");
        minIsr = 2; minRange.set(2);
        paint();
        term.line(L('<span class="t-good">= надёжная тройка: replication.factor=3, acks=all, min.insync.replicas=2</span>',
          '<span class="t-good">= the reliable trio: replication.factor=3, acks=all, min.insync.replicas=2</span>'));
        stage.say(L("<b>Надёжная тройка выставлена:</b> <code>replication.factor = 3</code>, <code>acks = all</code>, " +
          "<code>min.insync.replicas = 2</code>. Одну смерть кластер переживает и продолжает принимать запись; " +
          "при второй — отказывает с явной ошибкой. Проверь оба случая кнопкой «Реплика отстала».",
          "<b>The reliable trio is set:</b> <code>replication.factor = 3</code>, <code>acks = all</code>, " +
          "<code>min.insync.replicas = 2</code>. The cluster survives one death and keeps accepting writes; " +
          "on the second it refuses with an explicit error. Try both with the “A replica falls behind” button."));
      }

      /* ---------------- контролы ---------------- */

      var ACKS_TEXT = {
        "0": L("<b>acks=0</b> — бросил письмо в ящик и ушёл. Продюсер не ждёт ответа вообще: ни «принял», ни «не принял». " +
          "Быстро и без гарантий: любой сбой превращается в тихую потерю, о которой отправитель не узнает.",
          "<b>acks=0</b> — you dropped the letter in the box and walked away. The producer waits for no answer at all: " +
          "neither “got it” nor “did not get it”. Fast and without guarantees: any failure turns into a silent loss the sender never hears about."),
        "1": L("<b>acks=1</b> — дождался, пока приняли на почте. Лидер записал у себя и ответил «ok», реплики копируют " +
          "потом, в фоне. Умер лидер в этом промежутке — запись исчезла вместе с ним.",
          "<b>acks=1</b> — you waited until the post office took it in. The leader wrote it down and answered “ok”; the replicas copy it " +
          "later, in the background. If the leader dies in that gap, the record disappears with it."),
        "all": L("<b>acks=all</b> — дождался, пока разослали по филиалам. «ok» приходит после подтверждения всех реплик " +
          "<b>из текущего ISR</b>. Вся соль — в словах «из текущего ISR».",
          "<b>acks=all</b> — you waited until it went out to the branch offices. The “ok” arrives once every replica " +
          "<b>in the current ISR</b> has acknowledged. The whole catch is in the words “in the current ISR”.")
      };

      var MIN_TEXT = {
        1: L("<code>min.insync.replicas = 1</code> — заводское значение по умолчанию. Порог не значит ничего: одной копии " +
          "(самого лидера) хватает всегда. Как только ISR схлопнется, <code>acks=all</code> перестанет защищать — молча.",
          "<code>min.insync.replicas = 1</code> — the factory default. The threshold means nothing: one copy " +
          "(the leader itself) is always enough. The moment the ISR collapses, <code>acks=all</code> stops protecting you — silently."),
        2: L("<code>min.insync.replicas = 2</code> при <code>factor = 3</code> — рабочая настройка. Две живые синхронные " +
          "копии — пишем; осталась одна — <b>отказ вместо тихой потери</b>.",
          "<code>min.insync.replicas = 2</code> with <code>factor = 3</code> — the setting that works. Two live in-sync " +
          "copies and we write; one left and you get <b>a rejection instead of a silent loss</b>."),
        3: L("<code>min.insync.replicas = 3</code> при <code>factor = 3</code> требует, чтобы синхронны были все. " +
          "Любой перезапуск брокера кладёт запись целиком: запас на отказ равен нулю. Так не ставят.",
          "<code>min.insync.replicas = 3</code> with <code>factor = 3</code> demands that every copy be in sync. " +
          "Any broker restart takes writes down entirely: the margin for failure is zero. Nobody sets it that way.")
      };

      var acksSeg = ui.seg([
        { value: "0", label: "acks=0" },
        { value: "1", label: "acks=1" },
        { value: "all", label: "acks=all" }
      ], "all", function (v) {
        acksMode = v;
        paint();
        stage.say(ACKS_TEXT[v]);
      });

      var minRange = ui.range({
        label: "min.insync.replicas", min: 1, max: 3, value: 1,
        onInput: function (v) {
          minIsr = v;
          paint();
          stage.say(MIN_TEXT[v]);
        }
      });

      var writeBtn = ui.btn(L("Записать", "Write"), function () { write(false); }, { variant: "primary" });
      var killBtn = ui.btn(L("Записать и убить лидера в момент ok", "Write and kill the leader at the moment of ok"),
        function () { write(true); }, { variant: "danger" });
      var trapBtn = ui.btn(L("Собрать ловушку", "Set the trap"), trap, { sm: true });
      var presetBtn = ui.btn(L("Надёжная тройка", "The reliable trio"), preset, { sm: true });
      var resetBtn = ui.btn(L("Поднять кластер заново", "Bring the cluster back up"), function () {
        counters.ok = 0; counters.lost = 0; counters.rejected = 0;
        term.clear();
        term.line(L('<span class="t-dim">кластер поднят заново: 3 брокера, replication.factor = 3</span>',
          '<span class="t-dim">cluster brought back up: 3 brokers, replication.factor = 3</span>'));
        resetCluster();
        stage.say(L("Кластер собран заново: три живых брокера, у каждого своя копия партиции.",
          "The cluster is rebuilt: three live brokers, each with its own copy of the partition."));
      }, { sm: true, variant: "ghost" });

      /* ---------------- сборка стенда ---------------- */

      stage.body.appendChild(producerRow);
      stage.body.appendChild(isrPanel);
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, logWrap));
      stage.body.appendChild(el("div", { style: { "margin-top": "12px" } },
        ui.legend([
          { color: "var(--write)", label: L("лидер — вся запись идёт сюда", "leader — every write goes here") },
          { color: "var(--good)", label: L("реплика в ISR — копия есть", "replica in the ISR — the copy is there") },
          { color: "var(--warn)", label: L("реплика вне ISR — копии нет", "replica out of the ISR — no copy") },
          { color: "var(--bad)", label: L("мёртв · запись утрачена", "dead · the record is gone") }
        ])));
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, term.el));
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } },
        ui.stats(stAcks.el, stIsr.el, stMin.el, stVerdict.el)));
      stage.body.appendChild(el("div", { style: { "margin-top": "10px" } },
        ui.stats(stOk.el, stLost.el, stRej.el)));

      KV.append(stage.controls,
        ui.ctl("acks", acksSeg.el),
        minRange.el,
        writeBtn,
        killBtn,
        trapBtn,
        presetBtn,
        resetBtn);

      resetCluster();
      stage.say(L("Три брокера, на каждом копия партиции. Сейчас <code>acks=all</code> и " +
        "<code>min.insync.replicas = 1</code> — так выглядит «у нас всё надёжно» из коробки. " +
        "Нажми «Записать», затем выбей реплики из ISR и повтори.",
        "Three brokers, each with a copy of the partition. Right now it is <code>acks=all</code> and " +
        "<code>min.insync.replicas = 1</code> — that is what “we are safe here” looks like out of the box. " +
        "Press “Write”, then knock the replicas out of the ISR and do it again."));

      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(L(
        "<h3>Зачем нужен min.insync.replicas</h3>" +
        "<p><code>acks</code> — это про продюсера: чего он ждёт. <code>min.insync.replicas</code> — про брокера: " +
        "при скольких синхронных копиях он вообще согласен принять запись. Работают они только в паре — " +
        "<strong>порог проверяется лишь при <code>acks=all</code></strong>. Поставил 2, а продюсер шлёт с " +
        "<code>acks=1</code> — брокер не проверит ничего, и настройка остаётся строчкой в конфиге.</p>" +
        "<p>При <code>replication.factor = 3</code> ставят <code>2</code>: смерть одной копии кластер переживает " +
        "и продолжает принимать запись, смерть второй — останавливает. Поставить <code>3</code> заманчиво, " +
        "но тогда любой перезапуск брокера кладёт запись целиком: запаса на отказ не остаётся.</p>" +
        "<h4>Ошибка вместо потери</h4>" +
        "<p><code>NotEnoughReplicasException</code> — не авария, а сигнал. Продюсер получил отказ: можно повторить, " +
        "сложить в буфер, поднять алерт, в конце концов отказать пользователю честно. " +
        "Тихая потеря не даёт ничего — ни исключения, ни метрики; она всплывает через месяц на сверке, " +
        "когда восстанавливать уже нечего.</p>" +
        "<h4>Чего этот стенд не показывает</h4>" +
        "<p>Подтверждение — не то же самое, что «лежит на диске»: Kafka отвечает после записи в страничный кэш ОС, " +
        "а на диск сбрасывает позже. Именно поэтому копии важнее фсинка: три машины не гаснут одновременно, " +
        "а одна — запросто.</p>" +
        "<p>И ещё: стенд всегда выбирает нового лидера, даже когда [[ISR]] пуст. В реальном кластере это " +
        "<code>unclean.leader.election.enable</code>, и он <b>выключен по умолчанию</b> — партиция без живой синхронной " +
        "копии уходит в offline и ждёт. Включишь — получишь доступность ценой ровно той потери, что видно на стенде.</p>",

        "<h3>What min.insync.replicas is for</h3>" +
        "<p><code>acks</code> is about the producer: what it waits for. <code>min.insync.replicas</code> is about the broker: " +
        "how many in-sync copies it needs before it agrees to take a write at all. They only work as a pair — " +
        "<strong>the threshold is checked only with <code>acks=all</code></strong>. Set it to 2 while the producer sends with " +
        "<code>acks=1</code> and the broker checks nothing; the setting stays a line in a config file.</p>" +
        "<p>With <code>replication.factor = 3</code> you set <code>2</code>: the cluster survives the death of one copy " +
        "and keeps accepting writes, and the death of the second stops it. Setting <code>3</code> is tempting, " +
        "but then any broker restart takes writes down entirely: no margin for failure is left.</p>" +
        "<h4>An error instead of a loss</h4>" +
        "<p><code>NotEnoughReplicasException</code> is not an outage, it is a signal. The producer got a rejection: it can retry, " +
        "buffer the record, raise an alert, or in the end tell the user “no” honestly. " +
        "A silent loss gives you nothing — no exception, no metric; it surfaces a month later during reconciliation, " +
        "when there is nothing left to restore.</p>" +
        "<h4>What this demo does not show</h4>" +
        "<p>An acknowledgement is not the same as “it is on disk”: Kafka answers once the write reaches the OS page cache " +
        "and flushes to disk later. That is exactly why copies matter more than fsync: three machines do not go dark at once, " +
        "one easily can.</p>" +
        "<p>And one more thing: the demo always elects a new leader, even when the [[ISR]] is empty. In a real cluster that is " +
        "<code>unclean.leader.election.enable</code>, and it is <b>off by default</b> — a partition without a live in-sync " +
        "copy goes offline and waits. Turn it on and you buy availability at the price of exactly the loss the demo shows.</p>"
      )));

      root.appendChild(ui.note("good", L("надёжная тройка", "the reliable trio"), L(
        "<p><code>replication.factor = 3</code> &nbsp;·&nbsp; <code>acks = all</code> &nbsp;·&nbsp; " +
        "<code>min.insync.replicas = 2</code></p>" +
        "<p>Запоминай одним куском: по отдельности каждая настройка обманывает. " +
        "Фактор без acks — копии есть, но их не ждут. acks без порога — ждут пустой список. " +
        "Порог без фактора — писать негде.</p>",

        "<p><code>replication.factor = 3</code> &nbsp;·&nbsp; <code>acks = all</code> &nbsp;·&nbsp; " +
        "<code>min.insync.replicas = 2</code></p>" +
        "<p>Remember it as one piece: taken separately, every one of them deceives you. " +
        "The factor without acks — the copies exist, but nobody waits for them. acks without the threshold — you wait for an empty list. " +
        "The threshold without the factor — there is nowhere to write.</p>"
      )));

      root.appendChild(ui.takeaway(L([
        "<code>acks=0</code> — не ждём ничего, <code>acks=1</code> — [[лидер|лидера]], <code>acks=all</code> — всех из <b>текущего</b> [[ISR]].",
        "«Все» в <code>acks=all</code> — это «все из ISR». Схлопнулся ISR до одного лидера — и <code>acks=all</code> ждёт одного.",
        "[[min.insync.replicas]] — порог брокера: синхронных копий меньше → <code>NotEnoughReplicasException</code>, запись не принята. Действует <b>только</b> вместе с <code>acks=all</code>.",
        "Явная ошибка лучше тихой потери: исключение можно повторить, потерю — нельзя, её даже не видно.",
        "Держи в голове как одно целое: <code>replication.factor=3</code> + <code>acks=all</code> + <code>min.insync.replicas=2</code>."
      ], [
        "<code>acks=0</code> — wait for nothing, <code>acks=1</code> — for the [[leader]], <code>acks=all</code> — for everyone in the <b>current</b> [[ISR]].",
        "“Everyone” in <code>acks=all</code> means “everyone in the ISR”. Let the ISR collapse to a single leader and <code>acks=all</code> waits for one.",
        "[[min.insync.replicas]] is the broker’s threshold: fewer in-sync copies → <code>NotEnoughReplicasException</code>, the write is not accepted. It works <b>only</b> together with <code>acks=all</code>.",
        "An explicit error beats a silent loss: an exception can be retried, a loss cannot — you cannot even see it.",
        "Keep it in your head as one whole: <code>replication.factor=3</code> + <code>acks=all</code> + <code>min.insync.replicas=2</code>."
      ])));
    }
  });
})();
