/* Глава 11 — acks и min.insync.replicas: лаборатория отказа. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "acks",
    num: 11,
    group: "Надёжность",
    nav: "acks и min.insync",
    title: "acks=all обманчив без min.insync.replicas",
    lede: "<code>acks=all</code> читается как «дождались всех». На самом деле — «дождались всех, кто <b>сейчас</b> в ISR», а ISR умеет схлопнуться до одного лидера. Настройка соблюдена, копия одна.",

    build: function (root, api) {

      /* ---------------- подводка ---------------- */

      root.appendChild(ui.prose(
        "<p>[[продюсер|Продюсер]] отправил сообщение. Когда считать, что <em>отправка удалась</em>? " +
        "Момент выбирается не сам собой: запись ушла в сеть, легла в память [[лидер|лидера]], попала на диск, " +
        "разошлась по копиям — на любом из этих шагов можно объявить «готово» и пойти дальше.</p>" +
        "<p>Настройка <code>acks</code> (acknowledgements, подтверждения) и выбирает этот момент. " +
        "Чем позже — тем дольше ждёшь и тем меньше рискуешь.</p>"
      ));

      root.appendChild(ui.table(
        ["acks", "чего ждёт продюсер", "аналогия с почтой", "чем платишь"],
        [
          ["<code>0</code>", "ничего — отправил и забыл",
            "бросил письмо в ящик и ушёл",
            "потеря при любом сбое — и <b>ты о ней не узнаешь</b>"],
          ["<code>1</code>", "подтверждение лидера",
            "дождался, пока приняли на почте",
            "лидер умер до репликации → потеря"],
          ["<code>all</code>", "подтверждения всех реплик <b>из ISR</b>",
            "дождался, пока разослали по филиалам",
            "задержка выше; и есть ловушка — см. стенд"]
        ]
      ));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>Список [[ISR]] не зафиксирован — Kafka пересобирает его на ходу.</strong> Реплика, отставшая дольше " +
        "<code>replica.lag.time.max.ms</code> (по умолчанию 30 секунд), вычёркивается автоматически: ни рестарта, ни правки конфига.</p>" +
        "<p>Было: <code>ISR = [лидер, реплика-2, реплика-3]</code> → ждём троих. Реплики отстали и выпали из ISR: " +
        "<code>ISR = [лидер]</code> → тот же <code>acks=all</code> ждёт <b>одного</b>. " +
        "Конфигурацию никто не менял, а защиты больше нет.</p>"
      ));

      /* ---------------- стенд ---------------- */

      var stage = ui.stage({
        title: "Лаборатория отказа",
        hint: "Ловушка собирается в три клика: acks=all · реплика отстала · min.insync = 1"
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
      var producer = ui.node("producer", "продюсер", "orders · партиция 0");
      var waitEl = el("span", {
        style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" }
      });
      var producerRow = el("div.kv-row", { style: { "margin-bottom": "14px" } }, producer, waitEl);

      /* --- панель ISR --- */
      var isrBadges = el("div.kv-row");
      var isrNote = el("div", { style: { "font-size": "12.5px", color: "var(--muted)", "margin-top": "8px" } });
      var lagBtn = ui.btn("Реплика отстала", function () { lag(); }, { sm: true, variant: "danger" });
      var catchBtn = ui.btn("Реплики догнали", function () { catchUp(); }, { sm: true });
      var isrPanel = ui.panel("Кто сейчас синхронен",
        isrBadges,
        isrNote,
        el("div.kv-row", { style: { "margin-top": "10px" } }, lagBtn, catchBtn));

      /* --- кластер --- */
      var logWrap = ui.log();

      function makeNode(i) {
        var s = ui.logStrip({ label: "брокер " + (i + 1), sub: "реплика", empty: "лог пуст" });
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

      var term = ui.terminal('<span class="t-dim">кластер поднят: 3 брокера, replication.factor = 3</span>');

      /* --- плитки --- */
      var stAcks = ui.stat("acks", "all", { tone: "good" });
      var stIsr = ui.stat("ISR", "3 / 3", { tone: "good" });
      var stMin = ui.stat("min.insync", "1", { tone: "warn" });
      var stVerdict = ui.stat("вердикт", "—");
      var stOk = ui.stat("подтверждено", "0");
      var stLost = ui.stat("тихих потерь", "0");
      var stRej = ui.stat("явных отказов", "0");

      /* ---------------- состояние ---------------- */

      function aliveNodes() { return nodes.filter(function (n) { return n.alive; }); }
      function isr() { return nodes.filter(function (n) { return n.alive && (n.leader || n.sync); }); }
      function leaderNode() {
        for (var k = 0; k < nodes.length; k++) if (nodes[k].alive && nodes[k].leader) return nodes[k];
        return null;
      }
      function isrStr() {
        return "[" + isr().map(function (n) { return "бр" + (n.i + 1); }).join(", ") + "]";
      }
      function toCell(r, off) {
        return { key: r.key, label: r.label, title: "запись " + r.label + " · offset " + off };
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
          if (!n.alive) { role = "мёртв"; color = "var(--bad)"; }
          else if (n.leader) { role = "лидер · пишем сюда"; color = "var(--write)"; }
          else if (n.sync) { role = "реплика · в ISR"; color = "var(--good)"; }
          else { role = "реплика · отстала"; color = "var(--warn)"; }
          n.roleEl.textContent = role;
          n.roleEl.style.color = color;
          n.labelEl.classList.toggle("kv-node--dead", !n.alive);
        });

        KV.clear(isrBadges);
        nodes.forEach(function (n) {
          var text = "брокер " + (n.i + 1), tone;
          if (!n.alive) { text += " · мёртв"; tone = "bad"; }
          else if (n.leader) { text += " · лидер"; tone = "write"; }
          else if (n.sync) { text += " · в ISR"; tone = "good"; }
          else { text += " · вне ISR"; tone = "warn"; }
          isrBadges.appendChild(ui.badge(text, tone));
        });

        var c = isr().length;
        isrNote.textContent = "ISR = " + isrStr() + " — " + c + " " +
          util.plural(c, "синхронная копия", "синхронные копии", "синхронных копий") +
          ". Именно этот список ждёт acks=all.";

        if (acksMode === "0") waitEl.textContent = "→ ждёт: ничего";
        else if (acksMode === "1") waitEl.textContent = "→ ждёт: лидера (1 подтверждение)";
        else waitEl.textContent = "→ ждёт: всех из ISR, сейчас это " + c;

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
          stage.say("<b>Писать некуда.</b> У партиции не осталось живого лидера — нажми «Поднять кластер заново».");
          return;
        }
        setBusy(true);
        seq++;
        var rec = { seq: seq, key: "m" + seq, label: String(seq) };
        var isrNow = isr();

        term.line('<span class="t-dim">&gt; produce(запись ' + rec.label + ')   acks=' + acksMode +
          "   ISR=" + isrStr() + "   min.insync=" + minIsr + "</span>");

        /* --- порог брокера проверяется ТОЛЬКО при acks=all --- */
        if (acksMode === "all" && isrNow.length < minIsr) {
          term.line('  <span class="t-dim">проверка брокера: |ISR| = ' + isrNow.length +
            " &lt; min.insync.replicas = " + minIsr + "</span>");
          term.line('  <span class="t-bad">x NotEnoughReplicasException — запись отклонена, в лог не попала</span>');
          counters.rejected++;
          stVerdict.set("отказ", "warn");
          stage.say("<b>ЯВНАЯ ОШИБКА · NotEnoughReplicasException.</b> В ISR " + isrNow.length + " " +
            util.plural(isrNow.length, "копия", "копии", "копий") + ", а <code>min.insync.replicas = " + minIsr +
            "</code> — брокер отказался принимать запись. Продюсер получил исключение и знает, что делать: " +
            "повторить, придержать в буфере, разбудить дежурного. <b>Данные целы; потеряна доступность на запись</b> — " +
            "и это верный размен.");
          paint();
          setBusy(false);
          return;
        }
        if (acksMode !== "all" && minIsr > 1) {
          term.line('  <span class="t-dim">min.insync.replicas = ' + minIsr +
            " не проверяется: он действует только при acks=all</span>");
        }

        /* --- acks=0: «ok» выдаётся до того, как запись куда-то доехала --- */
        if (acksMode === "0") {
          term.line('  <span class="t-w">→ ok продюсеру сразу: acks=0 не ждёт ничего</span>');
          counters.ok++;
          if (kill) {
            term.line('  <span class="t-bad">! лидер падает, пока запись ещё в полёте</span>');
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
          term.line('  <span class="t-w">брокер ' + (L.i + 1) + " (лидер): append offset " + off + "</span>");
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
              term.line('  <span class="t-good">репликация догнала: запись ' + rec.label +
                " лежит на " + (late.length + 1) + " " +
                util.plural(late.length + 1, "копии", "копиях", "копиях") + "</span>");
            } else {
              term.line('  <span class="t-bad">копировать некому: в ISR только лидер</span>');
            }
            done(late.length + 1);
          });
        }

        function copyChain(list, k, after) {
          if (k >= list.length) { after(); return; }
          api.timeout(HOP, function () {
            var f = list[k];
            var off = pushTo(f, rec);
            term.line('  <span class="t-good">брокер ' + (f.i + 1) + ": скопировал offset " + off +
              ", подтвердил лидеру</span>");
            copyChain(list, k + 1, after);
          });
        }

        function ack(n) {
          if (acksMode === "0") return;
          counters.ok++;
          if (acksMode === "1") {
            term.line('  <span class="t-w">→ ok продюсеру: ждали только лидера</span>');
          } else if (n <= 1) {
            term.line('  <span class="t-w">→ ok продюсеру: ждали всех из ISR, а в ISR один лидер</span>');
          } else {
            term.line('  <span class="t-good">→ ok продюсеру: дождались всех из ISR (' + n + ")</span>");
          }
        }

        function done(copies) {
          var txt;
          if (acksMode === "all" && copies >= 2) {
            stVerdict.set("записано", "good");
            txt = "<b>СОХРАНЕНО.</b> «ok» пришёл только после того, как запись " + rec.label + " легла на " +
              copies + " " + util.plural(copies, "копию", "копии", "копий") +
              ". Убей сейчас лидера — запись переживёт его: новым лидером станет копия, у которой она есть.";
          } else if (acksMode === "all") {
            stVerdict.set("записано", "warn");
            txt = "<b>Записано — но копия ровно одна.</b> <code>acks=all</code> честно дождался всех из ISR, " +
              "а в ISR был только лидер. Формально настройка соблюдена, фактически защиты нет. " +
              "Жми «Записать и убить лидера в момент ok» — увидишь, чем это заканчивается.";
          } else if (acksMode === "1") {
            stVerdict.set("записано", "warn");
            txt = "<b>Записано.</b> «ok» ушёл сразу после лидера, реплики скопировали запись позже. " +
              "В этом окне между «ok» и репликацией и живёт потеря — кнопка «убить лидера в момент ok» бьёт ровно туда.";
          } else {
            stVerdict.set("записано", "warn");
            txt = "<b>Записано, но продюсер этого не проверял.</b> При <code>acks=0</code> «ok» выдан ещё до того, " +
              "как запись доехала до брокера. В этот раз совпало; не совпадёт — ответ будет тем же «успех».";
          }
          stage.say(txt);
          paint();
          setBusy(false);
        }
      }

      var BOLT = '  <span class="t-bad">! лидер падает ровно в момент ok</span>';

      /* ---------------- смерть лидера и выборы ---------------- */

      function doKill(o) {
        var L = leaderNode();
        L.alive = false; L.leader = false; L.sync = false;
        term.line('  <span class="t-bad">! брокер ' + (L.i + 1) + " (лидер) упал</span>");

        var alive = aliveNodes();
        if (!alive.length) {
          counters.lost += L.log.length + (o.inflight ? 1 : 0);
          stVerdict.set("кластер мёртв", "bad");
          term.line('  <span class="t-bad">живых копий не осталось: партиция недоступна, лог потерян</span>');
          stage.say("<b>Живых копий не осталось.</b> Партиция без единой реплики — ни читать, ни писать. " +
            "Нажми «Поднять кластер заново».");
          paint();
          setBusy(false);
          return;
        }

        var inIsr = alive.filter(function (n) { return n.sync; });
        var pool = inIsr.length ? inIsr : alive;
        var nl = pool[0];
        pool.forEach(function (n) { if (n.log.length > nl.log.length) nl = n; });
        if (!inIsr.length) {
          term.line('  <span class="t-bad">в ISR не осталось никого: при unclean.leader.election.enable=true ' +
            "лидером становится отставшая копия — по умолчанию флаг выключен, и партиция просто ушла бы в offline</span>");
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
        term.line('  <span class="t-dim">новый лидер: брокер ' + (nl.i + 1) + ", его LEO = " + nl.log.length + "</span>");

        if (nLost === 0) {
          stVerdict.set("пережила", "good");
          term.line('  <span class="t-good">потерь нет: все подтверждённые записи есть у нового лидера</span>');
          stage.say("<b>СОХРАНЕНО.</b> Лидер умер, но всё, что он успел подтвердить, уже лежало на брокере " +
            (nl.i + 1) + " — он и стал лидером. Ни одна подтверждённая запись не пропала: " +
            "<code>acks=all</code> ждал живых копий, а не формальности.");
        } else {
          stVerdict.set("потеря", "bad");
          var list = lost.map(function (r) { return r.label; }).join(", ");
          term.line('  <span class="t-bad">потеряно навсегда: ' + nLost + " " +
            util.plural(nLost, "запись", "записи", "записей") +
            (list ? " (" + list + ")" : "") + " — по ним уже отдан ok</span>");

          var head = "<b>ТИХАЯ ПОТЕРЯ — продюсер получил ok, данных нет.</b> ";
          if (o.inflight) {
            stage.say(head + "Запись " + o.rec.label + " даже не доехала до брокера, а «успех» продюсер выдал себе сам: " +
              "при <code>acks=0</code> он не ждёт ответа и не узнает об отказе никогда. " +
              "Ни исключения, ни метрики, ни строчки в логе — сверка через месяц, и то если повезёт.");
          } else if (acksMode === "all") {
            stage.say(head + "<code>acks=all</code> дождался всех из ISR — а в ISR был один лидер. " +
              "«Все» оказались «одним»: <code>min.insync.replicas = " + minIsr + "</code> разрешил принять запись " +
              "при единственной копии, копия умерла вместе с брокером. Потеряно записей: " + nLost +
              ". Подними <code>min.insync.replicas</code> до 2 и повтори — та же ситуация даст явную ошибку вместо тишины.");
          } else {
            stage.say(head + "Лидер подтвердил запись и умер раньше, чем реплики её скопировали. " +
              "Продюсер видел «ok», в кластере записи нет. Разница между <code>acks=1</code> и <code>acks=all</code> — " +
              "ровно это окно: при <code>all</code> ответ не уходит, пока копии не подтвердят.");
          }
        }
        paint();
        setBusy(false);
      }

      /* ---------------- ISR: отстали / догнали ---------------- */

      function lag() {
        if (!leaderNode()) { stage.say("Живого лидера нет — отставать не от кого. Нажми «Поднять кластер заново»."); return; }
        var victims = nodes.filter(function (n) { return n.alive && !n.leader && n.sync; });
        if (!victims.length) {
          stage.say("В ISR остался один лидер — схлопываться дальше некуда.");
          return;
        }
        var v = victims[victims.length - 1];
        v.sync = false;
        paint();
        var c = isr().length;
        term.line('<span class="t-bad">! брокер ' + (v.i + 1) +
          " отстал → выбит из ISR (replica.lag.time.max.ms)</span>");
        stage.say("<b>ISR схлопнулся до " + c + ".</b> Брокер " + (v.i + 1) +
          " перестал успевать за лидером, и Kafka вычеркнула его из списка синхронных. " +
          "Конфигурацию никто не трогал, но <code>acks=all</code> теперь ждёт " + c + " " +
          util.plural(c, "подтверждение", "подтверждения", "подтверждений") + " вместо трёх.");
      }

      function catchUp() {
        var L = leaderNode();
        if (!L) { stage.say("Сначала подними кластер: живого лидера нет."); return; }
        var back = 0;
        nodes.forEach(function (n) {
          if (!n.alive || n.leader) return;
          if (!n.sync) back++;
          n.sync = true;
          syncTo(n, L);
        });
        paint();
        term.line('<span class="t-good">+ реплики дочитали лог лидера и вернулись в ISR</span>');
        stage.say(back
          ? "<b>Реплики догнали.</b> Они дочитали хвост лога и вернулись в ISR — теперь в нём " + isr().length +
            " " + util.plural(isr().length, "копия", "копии", "копий") +
            ", и <code>acks=all</code> снова ждёт настоящих подтверждений."
          : "Все живые реплики и так были в ISR — ждать нечего.");
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
        term.line('<span class="t-w">= ловушка собрана: acks=all, min.insync.replicas=1, ISR=[лидер]</span>');
        stage.say("<b>Ловушка собрана.</b> <code>acks=all</code>, <code>min.insync.replicas = 1</code>, обе реплики " +
          "выпали из ISR. На бумаге конфигурация безопасна — «ждём всех». Жми «Записать и убить лидера в момент ok».");
      }

      function preset() {
        resetCluster();
        acksMode = "all"; acksSeg.set("all");
        minIsr = 2; minRange.set(2);
        paint();
        term.line('<span class="t-good">= надёжная тройка: replication.factor=3, acks=all, min.insync.replicas=2</span>');
        stage.say("<b>Надёжная тройка выставлена:</b> <code>replication.factor = 3</code>, <code>acks = all</code>, " +
          "<code>min.insync.replicas = 2</code>. Одну смерть кластер переживает и продолжает принимать запись; " +
          "при второй — отказывает с явной ошибкой. Проверь оба случая кнопкой «Реплика отстала».");
      }

      /* ---------------- контролы ---------------- */

      var ACKS_TEXT = {
        "0": "<b>acks=0</b> — бросил письмо в ящик и ушёл. Продюсер не ждёт ответа вообще: ни «принял», ни «не принял». " +
          "Быстро и без гарантий: любой сбой превращается в тихую потерю, о которой отправитель не узнает.",
        "1": "<b>acks=1</b> — дождался, пока приняли на почте. Лидер записал у себя и ответил «ok», реплики копируют " +
          "потом, в фоне. Умер лидер в этом промежутке — запись исчезла вместе с ним.",
        "all": "<b>acks=all</b> — дождался, пока разослали по филиалам. «ok» приходит после подтверждения всех реплик " +
          "<b>из текущего ISR</b>. Вся соль — в словах «из текущего ISR»."
      };

      var MIN_TEXT = {
        1: "<code>min.insync.replicas = 1</code> — заводское значение по умолчанию. Порог не значит ничего: одной копии " +
          "(самого лидера) хватает всегда. Как только ISR схлопнется, <code>acks=all</code> перестанет защищать — молча.",
        2: "<code>min.insync.replicas = 2</code> при <code>factor = 3</code> — рабочая настройка. Две живые синхронные " +
          "копии — пишем; осталась одна — <b>отказ вместо тихой потери</b>.",
        3: "<code>min.insync.replicas = 3</code> при <code>factor = 3</code> требует, чтобы синхронны были все. " +
          "Любой перезапуск брокера кладёт запись целиком: запас на отказ равен нулю. Так не ставят."
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

      var writeBtn = ui.btn("Записать", function () { write(false); }, { variant: "primary" });
      var killBtn = ui.btn("Записать и убить лидера в момент ok", function () { write(true); }, { variant: "danger" });
      var trapBtn = ui.btn("Собрать ловушку", trap, { sm: true });
      var presetBtn = ui.btn("Надёжная тройка", preset, { sm: true });
      var resetBtn = ui.btn("Поднять кластер заново", function () {
        counters.ok = 0; counters.lost = 0; counters.rejected = 0;
        term.clear();
        term.line('<span class="t-dim">кластер поднят заново: 3 брокера, replication.factor = 3</span>');
        resetCluster();
        stage.say("Кластер собран заново: три живых брокера, у каждого своя копия партиции.");
      }, { sm: true, variant: "ghost" });

      /* ---------------- сборка стенда ---------------- */

      stage.body.appendChild(producerRow);
      stage.body.appendChild(isrPanel);
      stage.body.appendChild(el("div", { style: { "margin-top": "16px" } }, logWrap));
      stage.body.appendChild(el("div", { style: { "margin-top": "12px" } },
        ui.legend([
          { color: "var(--write)", label: "лидер — вся запись идёт сюда" },
          { color: "var(--good)", label: "реплика в ISR — копия есть" },
          { color: "var(--warn)", label: "реплика вне ISR — копии нет" },
          { color: "var(--bad)", label: "мёртв · запись утрачена" }
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
      stage.say("Три брокера, на каждом копия партиции. Сейчас <code>acks=all</code> и " +
        "<code>min.insync.replicas = 1</code> — так выглядит «у нас всё надёжно» из коробки. " +
        "Нажми «Записать», затем выбей реплики из ISR и повтори.");

      root.appendChild(stage.el);

      /* ---------------- разбор ---------------- */

      root.appendChild(ui.prose(
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
        "копии уходит в offline и ждёт. Включишь — получишь доступность ценой ровно той потери, что видно на стенде.</p>"
      ));

      root.appendChild(ui.note("good", "надёжная тройка",
        "<p><code>replication.factor = 3</code> &nbsp;·&nbsp; <code>acks = all</code> &nbsp;·&nbsp; " +
        "<code>min.insync.replicas = 2</code></p>" +
        "<p>Запоминай одним куском: по отдельности каждая настройка обманывает. " +
        "Фактор без acks — копии есть, но их не ждут. acks без порога — ждут пустой список. " +
        "Порог без фактора — писать негде.</p>"
      ));

      root.appendChild(ui.takeaway([
        "<code>acks=0</code> — не ждём ничего, <code>acks=1</code> — [[лидер|лидера]], <code>acks=all</code> — всех из <b>текущего</b> [[ISR]].",
        "«Все» в <code>acks=all</code> — это «все из ISR». Схлопнулся ISR до одного лидера — и <code>acks=all</code> ждёт одного.",
        "[[min.insync.replicas]] — порог брокера: синхронных копий меньше → <code>NotEnoughReplicasException</code>, запись не принята. Действует <b>только</b> вместе с <code>acks=all</code>.",
        "Явная ошибка лучше тихой потери: исключение можно повторить, потерю — нельзя, её даже не видно.",
        "Держи в голове как одно целое: <code>replication.factor=3</code> + <code>acks=all</code> + <code>min.insync.replicas=2</code>."
      ]));
    }
  });
})();
