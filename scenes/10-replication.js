/* Глава 10 — Репликация и ISR: лидер, реплики, выборы. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "replication",
    num: 10,
    group: ["Надёжность", "Reliability"],
    nav: ["Репликация и ISR", "Replication and the ISR"],
    title: ["Лидер, реплики и список ISR", "The leader, the replicas and the ISR list"],
    lede: [
      "Партиция лежит не в одном экземпляре: при <code>replication factor = 3</code> её копия есть на трёх брокерах. Одна копия — <b>лидер</b>, через неё идёт вся работа; остальные повторяют за ней. Вопрос главы: кого делать лидером, когда текущий умрёт.",
      "A partition does not live in a single copy: with <code>replication factor = 3</code> a copy of it sits on three brokers. One copy is the <b>leader</b> — all the work goes through it; the rest replay it. The question of this chapter: who becomes leader when the current one dies."
    ],

    build: function (root, api) {

      root.appendChild(ui.prose(L(
        "<p>[[брокер|Брокер]] — это один сервер Kafka, кластер — несколько таких серверов. " +
        "Копии каждой [[партиция|партиции]] раскладывают по разным брокерам, а лидерство раздают вразнобой: " +
        "один и тот же сервер ведёт <code>orders-0</code> и одновременно всего лишь повторяет за чужим лидером <code>orders-1</code>. " +
        "Поэтому упавший брокер не «выключает топик» — он отбирает лидерство у той горстки партиций, которые вёл именно он.</p>" +
        "<p>Реплика (follower) клиентов не обслуживает: она сама ходит к лидеру за новыми записями и дописывает их себе в том же порядке. " +
        "[[продюсер|Продюсер]] и [[консьюмер]] по умолчанию о репликах вообще не думают — спрашивают у кластера «кто сейчас лидер <code>orders-0</code>» и идут по адресу. " +
        "Вся соль в том, что тянут реплики <em>асинхронно</em>: в любой момент времени копии чуть-чуть разные, и в секунду смерти лидера выбирать приходится из <b>неодинаковых</b> логов.</p>",

        "<p>A [[broker]] is one Kafka server; a cluster is several such servers. " +
        "The copies of every [[partition]] are spread across different brokers, and leadership is handed out unevenly: " +
        "the same server leads <code>orders-0</code> while at the very same time it merely replays someone else’s leader for <code>orders-1</code>. " +
        "That is why a broker going down does not “switch a topic off” — it takes leadership away from the handful of partitions it happened to lead.</p>" +
        "<p>A replica (a follower) serves no clients: it goes to the leader itself for new records and appends them in the same order. " +
        "By default the [[producer]] and the [[consumer]] do not think about replicas at all — they ask the cluster “who is the leader of <code>orders-0</code> right now” and go to that address. " +
        "The whole catch is that replicas pull <em>asynchronously</em>: at any given moment the copies are slightly different, and in the second the leader dies you have to choose between <b>unequal</b> logs.</p>"
      )));

      root.appendChild(ui.note("key", "ISR", L(
        "<p><strong>[[ISR]] — In-Sync Replicas, список реплик, которые прямо сейчас успевают за лидером.</strong> " +
        "Попадание в него не навсегда: затормозила сеть, сервер занят, диск захлебнулся — реплика перестала догонять, и Kafka выкидывает её из ISR. " +
        "Догнала — возвращает обратно. Это живой список, который меняется сам, а не настройка в конфиге.</p>",

        "<p><strong>[[ISR]] — In-Sync Replicas, the list of replicas that are keeping up with the leader right now.</strong> " +
        "Getting into it is not forever: the network slowed down, the server got busy, the disk choked — the replica stopped catching up, and Kafka drops it from the ISR. " +
        "It catches up — Kafka puts it back. This is a live list that changes by itself, not a setting in a config file.</p>"
      )));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: L("Кластер из трёх брокеров · партиция orders-0", "A cluster of three brokers · partition orders-0"),
        hint: L("Подними задержку реплики и смотри на строку ISR", "Raise a replica’s delay and watch the ISR line")
      });

      var RF = 3;
      var LAG_MAX = 2500;   // «replica.lag.time.max.ms» в миниатюре
      var TICK = 120;
      var AUTO_MS = 900;
      var AUTO_CAP = 36;
      var KEYS = L(["оплата", "заказ", "клик", "вход", "отказ", "возврат"],
        ["payment", "order", "click", "login", "reject", "refund"]);

      var brokers = [];
      var unclean = false;
      var lostTotal = 0;
      var writeSeq = 0;
      var offlineLen = 0;   // LEO партиции на момент, когда она осталась без лидера
      var autoId = null;
      var epoch = 0;        // поколение стенда: «Сбросить» обрывает всё, что летит
      var lastTick = Date.now();
      /* Модельные миллисекунды. И копирование, и порог ISR, и журнал считают
         время ПО НЕМУ — иначе в фоновой вкладке (интервалы душатся до ~1 с)
         реплика копировала бы по зажатому dt, а из ISR вылетала бы по
         настоящим часам, то есть раньше, чем обещает ползунок. */
      var clock = 0;

      function say(html) { stage.say(KV.terms(html)); }
      function fmt1(x) { return x.toFixed(1).replace(".", L(",", ".")); }
      function recs(n) {
        return n + " " + util.plural(n, L("запись", "record"), L("записи", "records"), L("записей", "records"));
      }
      function offsets(a, b) {
        return a === b - 1 ? "offset " + a : "offsets " + a + "…" + (b - 1);
      }

      /* ---- журнал кластера ---- */
      var term = ui.terminal("");
      var journal = [];
      function jrn(tone, msg) {
        var cls = tone === "bad" ? "t-bad" : tone === "good" ? "t-good"
          : tone === "warn" ? "t-w" : tone === "read" ? "t-r" : "t-dim";
        var stamp = "+" + fmt1(clock / 1000) + L(" с", " s");
        while (stamp.length < 9) stamp = " " + stamp;
        journal.push('<span class="t-dim">' + util.escape(stamp) + "</span>  " +
          '<span class="' + cls + '">' + util.escape(msg) + "</span>");
        if (journal.length > 7) journal.shift();
        term.clear();
        journal.forEach(function (l) { term.line(l); });
      }

      /* ---- продюсер и строка ISR ---- */
      var producer = ui.node("producer", L("продюсер", "producer"),
        L("пишет только в лидера", "writes only to the leader"));

      var isrVal = el("b", {
        style: {
          "font-family": "var(--f-mono)", "font-size": "20px",
          "line-height": "1.2", "letter-spacing": ".01em", color: "var(--ink)"
        }
      }, "[1, 2, 3]");
      var isrWhy = el("span", { style: { "font-size": "12px", color: "var(--muted)" } });
      var isrBox = el("div.kv-row", {
        style: {
          gap: "10px", padding: "8px 13px", "border-radius": "var(--r-md)",
          border: "1px solid var(--good)", background: "var(--surface-2)"
        }
      }, el("span.kv-ctl__label", { text: "ISR" }), isrVal, isrWhy);

      stage.body.appendChild(el("div.kv-row", {
        style: { "justify-content": "space-between", "margin-bottom": "14px" }
      }, producer, isrBox));

      /* ---- панели брокеров ---- */
      var rack = el("div.kv-col");
      stage.body.appendChild(rack);

      function makeBroker(i) {
        var b = {
          id: i + 1,
          alive: true,
          leader: i === 0,
          isr: true,
          wasIsr: true,
          log: [],
          acc: 0,
          delay: 250,
          stale: 0,
          caughtAt: 0
        };

        b.dotEl = el("span.kv-node__dot");
        b.metaEl = el("span.kv-node__meta", { text: L("копия партиции orders-0", "a copy of partition orders-0") });
        b.nodeEl = el("div.kv-node", null, b.dotEl,
          el("span", { text: L("брокер ", "broker ") + b.id }), b.metaEl);

        b.badgeEl = el("span.kv-badge");
        b.lagEl = el("span", {
          style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)" }
        });

        b.actBtn = ui.btn(L("убить", "kill"), function () {
          if (b.alive) kill(b); else revive(b);
        }, { sm: true });

        b.strip = ui.logStrip({
          label: "orders-0",
          sub: L("брокер ", "broker ") + b.id,
          empty: L("копии нет", "no copy here")
        });

        var head = el("div.kv-row", {
          style: { "justify-content": "space-between", "margin-bottom": "8px" }
        },
          el("div.kv-row", null, b.nodeEl, b.badgeEl),
          el("div.kv-row", null, b.lagEl, b.actBtn));

        b.panel = ui.panel(null, head, b.strip.el);
        rack.appendChild(b.panel);
        brokers.push(b);
      }

      for (var i = 0; i < RF; i++) makeBroker(i);

      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } },
        ui.legend([
          { color: "var(--write)", label: L("лидер — обведён, через него вся запись и чтение",
            "the leader — outlined; all writing and reading goes through it") },
          { color: "var(--good)", label: L("реплика в ISR — успевает за лидером",
            "a replica in the ISR — keeping up with the leader") },
          { color: "var(--bad)", label: L("реплика вне ISR — отстала, лидером стать не может",
            "a replica outside the ISR — fallen behind, cannot become leader") },
          { color: "var(--muted)", label: L("брокер мёртв", "the broker is dead") }
        ])));

      /* ---- плитки ---- */
      var sRf = ui.stat("replication factor", RF, { unit: L("копии", "copies") });
      var sIsr = ui.stat(L("размер ISR", "ISR size"), RF, { unit: L("из ", "of ") + RF, tone: "good" });
      var sLeader = ui.stat(L("лидер", "leader"), L("брокер 1", "broker 1"), { tone: "write" });
      var sLeo = ui.stat(L("записей в партиции", "records in the partition"), 0);
      var sLost = ui.stat(L("потеряно навсегда", "lost forever"), 0);
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } },
        ui.stats(sRf.el, sIsr.el, sLeader.el, sLeo.el, sLost.el)));

      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } }, term.el));

      /* ================= модель ================= */

      function leader() {
        for (var k = 0; k < brokers.length; k++) {
          if (brokers[k].leader && brokers[k].alive) return brokers[k];
        }
        return null;
      }

      function leo() {
        var L = leader();
        return L ? L.log.length : offlineLen;
      }

      function isrIds() {
        var out = [];
        brokers.forEach(function (b) { if (b.alive && b.isr) out.push(b.id); });
        out.sort(function (a, c) { return a - c; });
        return out;
      }

      function paint(b) {
        b.strip.setRecords(b.log.map(function (r) { return { key: r.key }; }));
      }

      /** Обрезать лог реплики до длины len (у лидера этих записей нет). */
      function retain(b, len) {
        if (b.log.length <= len) return 0;
        var cut = b.log.length - len;
        b.log.length = len;
        paint(b);
        return cut;
      }

      /** Данные мёртвого брокера сверх лога нового лидера: стереть, но оставить видимыми. */
      function markDropped(b, from) {
        var cut = b.log.length - from;
        if (cut <= 0) return 0;
        for (var off = from; off < b.log.length; off++) b.strip.setState(off, "dropped");
        b.log.length = from;
        b.stale = (b.stale || 0) + cut;
        return cut;
      }

      /* ---- запись ---- */

      function doWrite() {
        var L = leader();
        if (!L) {
          stopAuto();
          jrn("bad", KV.L("запись отклонена: у партиции нет лидера", "write rejected: the partition has no leader"));
          say(KV.L(
            "<b>Запись отклонена.</b> У партиции нет лидера — идти продюсеру некуда. " +
            "Это не «медленно», это <b>недоступно</b>: пока лидер не выбран, партиция не принимает ни записи, ни чтения.",

            "<b>Write rejected.</b> The partition has no leader — the producer has nowhere to go. " +
            "This is not “slow”, this is <b>unavailable</b>: until a leader is elected the partition takes neither writes nor reads."));
          render();
          return;
        }
        var key = KEYS[writeSeq % KEYS.length];
        writeSeq++;
        var plate = L.strip.el.querySelector(".kv-part__label") || L.strip.el;
        var mine = epoch;

        KV.fly(producer, plate, {
          label: key.slice(0, 3),
          color: util.keyColor(key),
          soft: util.keyColorSoft(key),
          ms: api.reduced ? 0 : 320
        }).then(function () {
          /* Стенд успели сбросить, пока запись летела: дописывать её в свежий
             кластер нельзя — она принадлежит прошлому поколению. */
          if (mine !== epoch) return;
          var L2 = leader();
          if (!L2) {
            jrn("bad", KV.L("запись «", "the write “") + key +
              KV.L("» пропала: лидер умер в момент отправки", "” is gone: the leader died as it was being sent"));
            say(KV.L(
              "<b>Лидер умер прямо во время записи.</b> Подтверждения продюсер не получит — " +
              "и это единственный честный исход: записывать было некуда.",

              "<b>The leader died right in the middle of the write.</b> The producer will get no acknowledgement — " +
              "and that is the only honest outcome: there was nowhere to write."));
            render();
            return;
          }
          var off = L2.log.length;
          L2.log.push({ key: key });
          L2.strip.push({ key: key });
          L2.strip.highlight(off, "is-hot", 450);
          render();
          say(KV.L("Лидер (брокер ", "The leader (broker ") + L2.id +
            KV.L(") принял запись на <b>offset ", ") took the record at <b>offset ") + off +
            KV.L("</b>. " +
              "Реплики о ней ещё не знают — они узнают, когда дотянутся за ней сами. " +
              "Разрыв между лентами и есть отставание реплики.",

              "</b>. " +
              "The replicas do not know about it yet — they will find out when they come and fetch it themselves. " +
              "The gap between the strips is exactly what replica lag is."));
        });
      }

      /* ---- такт репликации ---- */

      function tick() {
        var L = leader();
        var n = Date.now();
        /* Шаг меряем по часам, а не по номиналу таймера, но зажимаем: в фоновой
           вкладке интервалы душатся до ~1 с. Зажатый dt идёт и в копирование,
           и в clock, поэтому порог ISR остаётся ровно тем, что на ползунке. */
        var dt = util.clamp(n - lastTick, 0, 500);
        lastTick = n;
        clock += dt;

        brokers.forEach(function (b) {
          if (!b.alive) return;
          if (b.leader) { b.caughtAt = clock; return; }
          if (!L) return;

          b.acc += dt;
          var guard = 0;
          while (b.acc >= b.delay && b.log.length < L.log.length && guard++ < 24) {
            b.acc -= b.delay;
            var rec = L.log[b.log.length];
            b.log.push({ key: rec.key });
            b.strip.push({ key: rec.key });
          }
          if (b.log.length >= L.log.length) {
            b.acc = 0;
            b.caughtAt = clock;
            if (!b.isr) {
              b.isr = true;
              b.wasIsr = true;
              jrn("good", KV.L("брокер ", "broker ") + b.id +
                KV.L(" догнал лидера → возвращён в ISR", " caught up with the leader → back in the ISR"));
              say(KV.L("<b>Брокер ", "<b>Broker ") + b.id +
                KV.L(" догнал лидера и вернулся в ISR.</b> " +
                  "Список ISR живой: никто не чинил его руками — реплика перестала отставать, и Kafka сама вернула её в строй.",

                  " caught up with the leader and is back in the ISR.</b> " +
                  "The ISR is a live list: nobody fixed it by hand — the replica stopped falling behind, and Kafka put it back in line itself."));
            }
          }
        });

        brokers.forEach(function (b) {
          if (!b.isr || (b.leader && b.alive)) return;
          if (!b.alive || clock - b.caughtAt > LAG_MAX) {
            b.isr = false;
            /* Выпав из ISR, реплика перестаёт быть членом «последнего известного
               ISR»: иначе после ухода партиции в offline она сошла бы за чистого
               кандидата на выборах и стёрла хвост под видом безопасных выборов. */
            if (b.alive) b.wasIsr = false;
            jrn("warn", KV.L("брокер ", "broker ") + b.id +
              KV.L(" отстаёт дольше ", " has been behind for more than ") + fmt1(LAG_MAX / 1000) +
              KV.L(" с → выкинут из ISR", " s → dropped from the ISR"));
            if (b.alive) {
              say(KV.L("<b>Брокер ", "<b>Broker ") + b.id +
                KV.L(" выпал из ISR.</b> Он не сломан и не мёртв — он просто не успевает: " +
                  "последний раз был вровень с лидером более ",

                  " dropped out of the ISR.</b> It is not broken and not dead — it simply cannot keep up: " +
                  "the last time it was level with the leader was more than ") + fmt1(LAG_MAX / 1000) +
                KV.L(" с назад. " +
                  "В настоящей Kafka этот порог зовётся <code>replica.lag.time.max.ms</code> и по умолчанию равен 30 с.",

                  " s ago. " +
                  "In real Kafka this threshold is called <code>replica.lag.time.max.ms</code> and defaults to 30 s."));
            }
          }
        });

        render();
      }

      /* ---- смерть и выборы ---- */

      function kill(b) {
        if (!b.alive) return;
        var wasLeader = b.leader;
        b.alive = false;
        b.wasIsr = b.isr || wasLeader;
        b.isr = false;
        b.acc = 0;
        b.leader = false;
        jrn("bad", L("брокер ", "broker ") + b.id +
          (wasLeader ? L(" (лидер) упал", " (the leader) went down") : L(" упал", " went down")));

        if (wasLeader) {
          elect(b.log.length, false);
        } else {
          render();
          var left = isrIds();
          say(L("<b>Упала реплика (брокер ", "<b>A replica went down (broker ") + b.id +
            L(").</b> Для продюсера и консьюмера не изменилось ничего: " +
              "лидер жив, запись и чтение идут через него. Изменился только ISR — теперь в нём ",

              ").</b> For the producer and the consumer nothing has changed: " +
              "the leader is alive, writes and reads still go through it. Only the ISR changed — it now ") +
            (left.length === 1 ? L("остался один участник", "has a single member") :
              L("осталось ", "has ") + left.length + " " +
              util.plural(left.length, L("участник", "member"), L("участника", "members"), L("участников", "members"))) +
            ": <code>[" + left.join(", ") + "]</code>. " +
            L("Запас прочности стал тоньше.", "The safety margin just got thinner."));
        }
      }

      function revive(b) {
        if (b.alive) return;
        b.alive = true;
        b.acc = 0;
        b.caughtAt = clock;
        jrn("good", KV.L("брокер ", "broker ") + b.id + KV.L(" вернулся в кластер", " is back in the cluster"));

        var ghost = b.stale || 0;
        if (ghost) { b.stale = 0; paint(b); }

        var L = leader();
        if (L) {
          var cut = retain(b, L.log.length) + ghost;
          b.isr = b.log.length >= L.log.length;
          b.wasIsr = b.isr;
          render();
          say(KV.L("<b>Брокер ", "<b>Broker ") + b.id +
            KV.L(" вернулся — репликой, а не лидером.</b> ", " is back — as a replica, not as the leader.</b> ") +
            (cut
              ? KV.L("Первым делом он <b>выбросил ", "The first thing it did was <b>throw away ") + recs(cut) +
                KV.L("</b>, которые были только у него: лидер про них не знает, " +
                  "а расходиться с лидером реплике нельзя. ",

                  "</b> that only it had: the leader knows nothing about them, " +
                  "and a replica must not diverge from its leader. ")
              : "") +
            KV.L("Дальше он догоняет лидера с offset ", "From here it catches up with the leader from offset ") +
            b.log.length +
            KV.L(" и вернётся в ISR, когда поравняется.", " and will come back into the ISR once it draws level."));
        } else {
          say(KV.L("<b>Брокер ", "<b>Broker ") + b.id +
            KV.L(" вернулся.</b> Партиция была без лидера — контроллер сразу пробует выборы.",
              " is back.</b> The partition had no leader — the controller tries an election right away."));
          elect(offlineLen, true);
        }
      }

      function candidates(allowWasIsr) {
        return brokers.filter(function (b) {
          return b.alive && !b.leader && (b.isr || (allowWasIsr && b.wasIsr));
        });
      }

      function byLog(a, c) { return (c.log.length - a.log.length) || (a.id - c.id); }

      function elect(oldLen, allowWasIsr) {
        offlineLen = Math.max(offlineLen, oldLen);
        var pool = candidates(allowWasIsr);
        if (pool.length) {
          pool.sort(byLog);
          promote(pool[0], oldLen, false);
          return;
        }
        if (unclean) {
          var any = brokers.filter(function (b) { return b.alive && !b.leader; });
          if (any.length) {
            any.sort(byLog);
            promote(any[0], oldLen, true);
            return;
          }
        }
        goOffline(oldLen);
      }

      function promote(nw, oldLen, isUnclean) {
        /* Чистые выборы бывают двух разных видов: лидера сменили на реплику,
           которая в ISR ПРЯМО СЕЙЧАС (разрыв крошечный), либо партиция стояла
           offline и дождалась того, кто был в ISR в момент своей смерти —
           тогда разрыв может быть огромным, и «шёл вровень» было бы неправдой. */
        var currentIsr = nw.isr;
        nw.leader = true;
        nw.isr = true;
        nw.wasIsr = true;
        nw.acc = 0;
        nw.caughtAt = clock;

        var keep = nw.log.length;
        var lost = Math.max(0, oldLen - keep);

        /* Список «кого не рассматривали» считаем ДО обрезки: после неё у всех
           длина лога уже равна keep, и объяснение «N из M записей» врало бы. */
        var excluded = [];
        brokers.forEach(function (x) {
          if (x === nw) return;
          if (!x.alive) excluded.push(L("брокер ", "broker ") + x.id + L(" — мёртв", " — dead"));
          else if (!x.isr) excluded.push(L("брокер ", "broker ") + x.id +
            L(" — вне ISR (", " — outside the ISR (") + x.log.length +
            L(" из ", " of ") + oldLen + L(" записей)", " records)"));
        });

        brokers.forEach(function (x) {
          if (x === nw || x.log.length <= keep) return;
          if (x.alive) retain(x, keep); else markDropped(x, keep);
        });
        if (lost) lostTotal += lost;
        offlineLen = keep;
        render();

        if (isUnclean) {
          jrn("bad", L("unclean election: лидером назначен брокер ", "unclean election: broker ") + nw.id +
            L(" вне ISR, потеряно ", ", outside the ISR, was made leader; lost ") + lost);
          say(L("<b>Unclean leader election.</b> В ISR живых не осталось, но переключатель разрешил взять кого угодно — " +
            "лидером стал брокер ",

            "<b>Unclean leader election.</b> No live replica was left in the ISR, but the switch allowed taking anyone — " +
            "the leader is now broker ") + nw.id +
            L(", <b>он был вне ISR</b>. Его лог короче на ",
              ", <b>and it was outside the ISR</b>. Its log is shorter by ") + recs(lost) + " (" +
            offsets(keep, oldLen) +
            L(") — эти записи <b>стёрты навсегда</b>, хотя продюсер получил на них подтверждение. " +
              "Партиция снова принимает запись ценой дыры в данных.",

              ") — those records are <b>erased forever</b>, even though the producer got an acknowledgement for them. " +
              "The partition takes writes again, at the price of a hole in the data."));
          return;
        }

        jrn("read", L("выборы: лидером стал брокер ", "election: the leader is now broker ") + nw.id +
          (lost ? L(", потеряно ", "; lost ") + lost : L(", без потерь", "; nothing lost")));
        say(L("<b>Выборы. Новый лидер — брокер ", "<b>Election. The new leader is broker ") + nw.id + ".</b> " +
          (currentIsr
            ? L("Кандидатов брали <b>только из ISR</b>: он был в списке, то есть по определению шёл почти вровень (",
                "Candidates were taken <b>only from the ISR</b>: it was on the list, which by definition means it was running almost level (") +
              nw.log.length + L(" из ", " of ") + oldLen + L(" записей). ", " records). ")
            /* Разрыв считаем по фактическим длинам логов: этой веткой партиция
               проходит и тогда, когда после смерти лидера не было ни одной
               записи, — «лог ушёл вперёд» там было бы неправдой. */
            : L("Партиция стояла без лидера и дождалась брокера ",
                "The partition stood there with no leader and waited for broker ") + nw.id +
              L(" — <b>последнего, кто числился в ISR перед смертью</b>. " +
                "Выборы всё равно чистые. ",

                " — <b>the last one on the ISR list before the partition died</b>. " +
                "The election is clean all the same. ") +
              (lost
                ? L("Но лог у него короче: ", "But its log is shorter: ") + nw.log.length +
                  L(" из ", " of ") + oldLen +
                  L(" записей — остальные до этой копии дойти не успели. ",
                    " records — the rest never made it to this copy. ")
                : L("Лог у него полный, все ", "Its log is complete, all ") + oldLen + " " +
                  util.plural(oldLen, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
                  L(" на месте. ", " are in place. "))) +
          (excluded.length ? L("Не рассматривались: ", "Not considered: ") + excluded.join("; ") + ". " : "") +
          (lost
            ? "<b>" + (currentIsr ? L("И всё же ", "Even so, ") : "") + recs(lost) + " (" + offsets(keep, oldLen) +
              L(") потеряно</b> — ", ") — gone</b> — ") +
              L("у нового лидера их нет, а остальные копии обрезаны по его логу. " +
                "Продюсер с <code>acks=1</code> считал их записанными. Об этом — следующая глава.",

                "the new leader does not have them, and the other copies were truncated down to its log. " +
                "A producer with <code>acks=1</code> counted them as written. That is the next chapter.")
            : currentIsr
              ? L("Реплика была вровень с лидером, поэтому <b>не потеряно ничего</b>: переключение прошло незаметно для продюсера.",
                  "The replica was level with the leader, so <b>nothing was lost</b>: the producer never noticed the switch.")
              : L("<b>Не потеряно ничего</b>: партиция вернулась в работу с полным логом.",
                  "<b>Nothing was lost</b>: the partition came back to work with a complete log.")));
      }

      function goOffline(oldLen) {
        offlineLen = Math.max(offlineLen, oldLen);
        render();
        var aliveOut = brokers.filter(function (b) { return b.alive; });
        jrn("bad", aliveOut.length
          ? L("лидера нет: в ISR не осталось живых реплик — партиция offline",
              "no leader: no live replica is left in the ISR — the partition is offline")
          : L("лидера нет: все копии партиции лежат — партиция offline",
              "no leader: every copy of the partition is down — the partition is offline"));
        if (aliveOut.length) {
          var who = aliveOut.map(function (b) {
            var name = L("брокер ", "broker ") + b.id;
            return name + " (" + b.log.length + L(" из ", " of ") + oldLen + ")";
          }).join(", ");
          say(L("<b>Партиция осталась без лидера.</b> Живые брокеры есть — ",
              "<b>The partition is left without a leader.</b> There are live brokers — ") + who +
            L(" — но все они <b>вне ISR</b>: отстали и части записей у них нет. " +
              "Назначить такого лидером — значит объявить его укороченный лог единственно верным и стереть хвост. " +
              "По умолчанию Kafka выбирает <b>простой</b>: партиция не принимает ни запись, ни чтение и ждёт возвращения реплики из ISR. " +
              "Дальше два пути: вернуть брокер из ISR (данные целы) или включить переключатель " +
              "<code>unclean leader election</code> — контроллер тут же назначит лидером отставшую реплику и сотрёт хвост.",

              " — but every one of them is <b>outside the ISR</b>: they fell behind and part of the records is missing. " +
              "Making one of them leader means declaring its truncated log the only true one and erasing the end of the log. " +
              "By default Kafka picks <b>downtime</b>: the partition takes neither writes nor reads and waits for a replica from the ISR to come back. " +
              "Two ways out from here: bring back a broker that was in the ISR (the data is intact) or flip the " +
              "<code>unclean leader election</code> switch — the controller will instantly make the lagging replica leader and wipe the end of the log."));
        } else {
          say(L("<b>Весь кластер лежит.</b> Копий партиции не осталось ни одной живой: ни записи, ни чтения. " +
            "Верни любой брокер — тот, кто был в ISR, станет лидером и партиция оживёт.",

            "<b>The whole cluster is down.</b> Not one live copy of the partition is left: no writes, no reads. " +
            "Bring any broker back — the one that was in the ISR becomes leader and the partition comes alive."));
        }
      }

      /* ================= отрисовка ================= */

      var killLeaderBtn, autoToggle;

      function render() {
        var L = leader();
        var ids = isrIds();

        brokers.forEach(function (b) {
          var role, tone, dot;
          if (!b.alive) { role = KV.L("мёртв", "dead"); tone = ""; dot = "var(--muted)"; }
          else if (b.leader) { role = KV.L("ЛИДЕР", "LEADER"); tone = "write"; dot = "var(--write)"; }
          else if (b.isr) { role = KV.L("реплика · в ISR", "replica · in the ISR"); tone = "good"; dot = "var(--good)"; }
          else { role = KV.L("реплика · вне ISR", "replica · outside the ISR"); tone = "bad"; dot = "var(--bad)"; }

          b.badgeEl.className = "kv-badge" + (tone ? " kv-badge--" + tone : "");
          b.badgeEl.textContent = role;
          b.dotEl.style.background = dot;
          b.nodeEl.classList.toggle("kv-node--dead", !b.alive);
          b.panel.style.borderColor = b.alive && b.leader ? "var(--write)" : "var(--line)";
          b.panel.style.boxShadow = b.alive && b.leader ? "inset 3px 0 0 var(--write)" : "none";
          b.strip.el.style.opacity = !b.alive ? ".45" : b.isr ? "1" : ".62";
          b.actBtn.className = "kv-btn kv-btn--sm" + (b.alive ? " kv-btn--danger" : "");
          b.actBtn.textContent = b.alive ? KV.L("убить", "kill") : KV.L("вернуть", "revive");
          b.metaEl.textContent = b.alive && b.leader ? KV.L("принимает запись и чтение", "takes writes and reads")
            : !b.alive ? KV.L("копия заморожена", "the copy is frozen") : KV.L("копирует за лидером", "copying from the leader");

          var txt, col;
          if (!b.alive) { txt = KV.L("не отвечает", "not responding"); col = "var(--muted)"; }
          else if (b.leader) { txt = KV.L("источник истины", "the source of truth"); col = "var(--write)"; }
          else if (!L) { txt = KV.L("лидера нет", "no leader"); col = "var(--muted)"; }
          else {
            var behind = L.log.length - b.log.length;
            var secs = (clock - b.caughtAt) / 1000;
            if (behind <= 0) { txt = KV.L("вровень с лидером", "level with the leader"); col = "var(--good)"; }
            else {
              txt = KV.L("отстаёт на ", "behind by ") + recs(behind) + " · " + fmt1(secs) + KV.L(" с", " s");
              col = !b.isr ? "var(--bad)" : secs > LAG_MAX / 1600 ? "var(--warn)" : "var(--muted)";
            }
          }
          b.lagEl.textContent = txt;
          b.lagEl.style.color = col;
        });

        isrVal.textContent = "[" + ids.join(", ") + "]";
        var tone = ids.length >= RF ? "good" : ids.length >= 2 ? "warn" : "bad";
        isrVal.style.color = "var(--" + tone + ")";
        isrBox.style.borderColor = "var(--" + tone + ")";
        isrWhy.textContent = !L ? KV.L("лидера нет — партиция недоступна", "no leader — the partition is unavailable")
          : ids.length === RF ? KV.L("все копии успевают за лидером", "every copy is keeping up with the leader")
          : ids.length === 1 ? KV.L("в ISR только лидер: живая копия данных одна",
              "only the leader is in the ISR: there is a single live copy of the data")
          : KV.L("копия выпала из списка — лидером она стать не может",
              "a copy has dropped off the list — it cannot become leader");

        sIsr.set(ids.length, ids.length >= RF ? "good" : ids.length >= 2 ? "warn" : "bad");
        sLeader.set(L ? KV.L("брокер ", "broker ") + L.id : KV.L("нет", "none"), L ? "write" : "bad");
        sLeo.set(leo());
        sLost.set(lostTotal, lostTotal ? "bad" : null);
        if (killLeaderBtn) killLeaderBtn.disabled = !L;
      }

      /* ================= управление ================= */

      function stopAuto() {
        if (autoId !== null) { api.stop(autoId); autoId = null; }
        if (autoToggle) autoToggle.set(false);
      }

      autoToggle = ui.toggle(L("непрерывный поток", "continuous stream"), false, function (on) {
        if (!on) { stopAuto(); return; }
        autoId = api.interval(AUTO_MS, function () {
          if (leo() >= AUTO_CAP) {
            stopAuto();
            say(L("<b>Поток остановлен:</b> в демо-логе уже ", "<b>Stream stopped:</b> the demo log already holds ") +
              recs(AUTO_CAP) +
              L(", дальше смотреть нечего. " + "Сбрось стенд или пиши по одной.",
                ", there is nothing more to see. " + "Reset the demo or write one record at a time."));
            return;
          }
          doWrite();
        });
        say(L("Продюсер пишет непрерывно, примерно раз в ", "The producer writes continuously, about once every ") +
          fmt1(AUTO_MS / 1000) +
          L(" с. " +
            "Теперь задержка реплики имеет значение: если копировать медленнее, чем приходит поток, отставание растёт без остановки.",

            " s. " +
            "Now the replica delay matters: copy slower than the stream arrives, and the lag grows without ever stopping."));
      });

      /* Ползунок привязан к БРОКЕРУ, а не к роли: после выборов брокер 2 может
         оказаться лидером, и «задержка реплики 2» стала бы неправдой. */
      var d2 = ui.range({
        label: L("задержка брокера 2", "broker 2 delay"),
        min: 100, max: 2000, step: 100, value: 250, unit: L("мс", "ms"),
        onInput: function (v) { setDelay(1, v); }
      });
      var d3 = ui.range({
        label: L("задержка брокера 3", "broker 3 delay"),
        min: 100, max: 2000, step: 100, value: 250, unit: L("мс", "ms"),
        onInput: function (v) { setDelay(2, v); }
      });

      function setDelay(idx, v) {
        var b = brokers[idx];
        b.delay = v;
        if (!b.alive) {
          say(L("Брокер ", "Broker ") + b.id +
            L(" сейчас лежит — копировать ему нечего. Задержка ",
              " is down right now — it has nothing to copy. A delay of ") + fmt1(v / 1000) +
            L(" с запомнена и заработает, когда он вернётся в кластер репликой.",
              " s is remembered and will kick in when it comes back to the cluster as a replica."));
          return;
        }
        if (b.leader) {
          say(L("Брокер ", "Broker ") + b.id +
            L(" сейчас <b>лидер</b>: он источник истины и ни за кем не копирует, " +
              "поэтому отставать ему не от чего и из ISR его не выкидывают. Задержка ",

              " is the <b>leader</b> right now: it is the source of truth and copies from nobody, " +
              "so there is nobody for it to fall behind, and nothing drops it from the ISR. A delay of ") + fmt1(v / 1000) +
            L(" с пригодится, когда он снова станет репликой — например, после возвращения старого лидера.",
              " s will matter when it becomes a replica again — after the old leader comes back, for instance."));
          return;
        }
        if (!leader()) {
          say(L("Брокер ", "Broker ") + b.id +
            L(" жив, но у партиции сейчас <b>нет лидера</b> — копировать не у кого. " + "Задержка ",
              " is alive, but the partition has <b>no leader</b> right now — there is nobody to copy from. " + "A delay of ") +
            fmt1(v / 1000) +
            L(" с заработает, как только лидер выберется.", " s will kick in as soon as a leader is elected."));
          return;
        }
        say(L("Брокер ", "Broker ") + b.id +
          L(" копирует примерно одну запись за ", " copies about one record every ") + fmt1(v / 1000) +
          L(" с. ", " s. ") +
          (!b.isr
            ? L("Из ISR его уже выкинули: чтобы вернуться в список, ему надо <b>догнать лидера</b> — " +
                "и чем больше задержка, тем дольше это займёт.",

                "It has already been dropped from the ISR: to get back on the list it has to <b>catch up with the leader</b> — " +
                "and the bigger the delay, the longer that takes.")
            : autoId !== null
              ? L("Поток идёт — теперь это видно сразу: копирует медленнее, чем приходят записи, значит разрыв растёт, " +
                  "и как только реплика не поравняется с лидером ",

                  "The stream is running — and now you see it straight away: it copies slower than records arrive, so the gap grows, " +
                  "and the moment the replica fails to draw level with the leader for ") + fmt1(LAG_MAX / 1000) +
                L(" с подряд, её выкинут из ISR.", " s in a row, it is dropped from the ISR.")
              : L("Пока продюсер молчит, это ничего не меняет: <b>отставать не от чего</b>, и реплика остаётся в ISR. " +
                  "Из списка её выкинет только реальный разрыв с лидером дольше ",

                  "While the producer is silent this changes nothing: <b>there is nothing to fall behind on</b>, and the replica stays in the ISR. " +
                  "Only a real gap from the leader lasting longer than ") + fmt1(LAG_MAX / 1000) + L(" с.", " s will drop it from the list.")));
      }

      killLeaderBtn = ui.btn(L("Убить лидера", "Kill the leader"), function () {
        var L = leader();
        if (L) kill(L);
      }, { variant: "danger" });

      var uncleanToggle = ui.toggle("unclean leader election", false, function (on) {
        unclean = on;
        if (on) {
          if (!leader()) {
            jrn("warn", L("unclean election разрешён — контроллер повторяет выборы",
              "unclean election allowed — the controller retries the election"));
            elect(offlineLen, false);
            return;
          }
          say(L("<b>Включён <code>unclean.leader.election.enable=true</code>.</b> Теперь, если в ISR не останется живых, " +
            "лидером назначат отставшую реплику: партиция продолжит работать, но записи, которых у неё нет, исчезнут. " +
            "Обмен «доступность взамен полноты данных» сделан осознанно.",

            "<b><code>unclean.leader.election.enable=true</code> is on.</b> From now on, if no live replica is left in the ISR, " +
            "a lagging replica is made leader: the partition keeps working, but the records it does not have vanish. " +
            "The trade — “availability in exchange for complete data” — is now a deliberate one."));
        } else {
          say(L("<b>Выключен <code>unclean.leader.election.enable</code>: это значение по умолчанию.</b> " +
            "Лидером станет только реплика из ISR. Нет такой — партиция ждёт, но данные целы.",

            "<b><code>unclean.leader.election.enable</code> is off: that is the default.</b> " +
            "Only a replica from the ISR becomes leader. If there is none, the partition waits — but the data is intact."));
        }
        render();
      });

      KV.append(stage.controls,
        ui.btn(L("Записать", "Write"), doWrite, { variant: "primary" }),
        autoToggle.el,
        d2.el,
        d3.el,
        killLeaderBtn,
        uncleanToggle.el,
        ui.btn(L("Сбросить стенд", "Reset the demo"), reset, { variant: "ghost", sm: true }));

      /* ================= старт ================= */

      function reset() {
        stopAuto();
        epoch++;             // всё, что летит прямо сейчас, до нового кластера не долетит
        unclean = false;
        uncleanToggle.set(false);
        lostTotal = 0;
        writeSeq = 0;
        offlineLen = 0;
        lastTick = Date.now();
        clock = 0;
        d2.set(250); d3.set(250);
        brokers.forEach(function (b, k) {
          b.alive = true;
          b.leader = k === 0;
          b.isr = true;
          b.wasIsr = true;
          b.log.length = 0;
          b.acc = 0;
          b.stale = 0;
          b.delay = 250;
          b.caughtAt = 0;
          b.strip.clearMarkers();
        });
        for (var s = 0; s < 6; s++) {
          var key = KEYS[writeSeq % KEYS.length];
          writeSeq++;
          brokers.forEach(function (b) { b.log.push({ key: key }); });
        }
        brokers.forEach(paint);
        offlineLen = brokers[0].log.length;
        journal.length = 0;
        term.clear();
        jrn("read", L("кластер поднят: RF=3, лидер — брокер 1, ISR = [1, 2, 3]",
          "cluster is up: RF=3, leader — broker 1, ISR = [1, 2, 3]"));
        render();
        say(L("Кластер в порядке: шесть записей лежат на всех трёх брокерах, ISR полный. " +
          "Пиши в лидера и смотри, как реплики повторяют за ним — а потом сломай что-нибудь.",

          "The cluster is fine: six records sit on all three brokers, the ISR is full. " +
          "Write to the leader and watch the replicas replay it — and then break something."));
      }

      reset();
      api.interval(TICK, tick);
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(L(
        "<h3>Почему лидера выбирают только из ISR</h3>" +
        "<p>Реплика вне ISR отстала — у неё физически нет части записей. Сделать её лидером значит объявить её короткий лог " +
        "единственно верным: всё, что было записано сверх него, исчезает у всего кластера. " +
        "Это и есть <em>unclean leader election</em>, и по умолчанию Kafka его запрещает. " +
        "Выбор тут честный и неприятный: либо партиция недоступна, пока не вернётся нормальная реплика, либо она доступна, но с дырой в данных.</p>" +
        "<h4>Что видно на стенде</h4>" +
        "<ul>" +
        "<li><strong>Из ISR выкидывает не медленность, а отставание.</strong> Пока продюсер молчит, даже самая тормозная реплика вровень — и остаётся в списке. Нагрузка появляется — и медленная реплика начинает сыпаться.</li>" +
        "<li><strong>Смерть реплики для клиента не событие.</strong> Лидер жив — запись и чтение идут как ни в чём не бывало. Меняется только запас прочности, и виден он единственным местом: размером ISR.</li>" +
        "<li><strong>Даже «чистые» выборы могут потерять хвост.</strong> Реплика в ISR — это «отстаёт не дольше порога», а не «вровень посекундно». Записи, которые успели попасть только на лидера, уходят вместе с ним.</li>" +
        "<li><strong>Вернувшийся брокер сначала выбрасывает лишнее.</strong> Старый лидер, поднявшись, обрезает свой лог до лога нового лидера: расходиться с лидером реплике нельзя.</li>" +
        "</ul>",

        "<h3>Why the leader is only picked from the ISR</h3>" +
        "<p>A replica outside the ISR has fallen behind — it physically does not have part of the records. Making it the leader means declaring its short log " +
        "the only true one: everything written beyond it disappears for the whole cluster. " +
        "That is exactly what <em>unclean leader election</em> is, and by default Kafka forbids it. " +
        "The choice here is honest and unpleasant: either the partition is unavailable until a proper replica comes back, or it is available but with a hole in the data.</p>" +
        "<h4>What the demo shows</h4>" +
        "<ul>" +
        "<li><strong>You are dropped from the ISR for lagging, not for being slow.</strong> While the producer is silent, even the most sluggish replica is level — and stays on the list. Load shows up — and the slow replica starts falling apart.</li>" +
        "<li><strong>A replica dying is a non-event for the client.</strong> The leader is alive — writes and reads carry on as if nothing happened. Only the safety margin changes, and it shows in exactly one place: the size of the ISR.</li>" +
        "<li><strong>Even a “clean” election can lose the end of the log.</strong> A replica in the ISR means “behind by no more than the threshold”, not “level second by second”. Records that only made it to the leader leave together with it.</li>" +
        "<li><strong>A returning broker throws away the excess first.</strong> The old leader, once it is back up, truncates its log down to the new leader’s log: a replica must not diverge from its leader.</li>" +
        "</ul>"
      )));

      root.appendChild(ui.note("warn", L("ловушка", "trap"), L(
        "<p><strong>RF=3 не значит «три копии каждой записи прямо сейчас».</strong> Это значит «три брокера держат эту партицию». " +
        "Сколько копий у конкретной свежей записи в конкретный момент — вопрос к ISR, а он всё время меняется. " +
        "Схлопнувшийся до одного участника ISR выглядит снаружи совершенно нормально: лидер жив, запись идёт, метрики зелёные. " +
        "Пока лидер не умрёт.</p>",

        "<p><strong>RF=3 does not mean “three copies of every record right now”.</strong> It means “three brokers hold this partition”. " +
        "How many copies a particular fresh record has at a particular moment is a question for the ISR — and the ISR keeps changing. " +
        "An ISR collapsed down to a single member looks perfectly normal from the outside: the leader is alive, writes go through, the metrics are green. " +
        "Until the leader dies.</p>"
      )));

      root.appendChild(ui.prose(L(
        "<p>Отсюда прямая дорога в следующую главу. Продюсер может потребовать подтверждения не только от лидера, " +
        "а от всех реплик из ISR — это [[acks|acks=all]]. Но «все из ISR» при ISR из одного участника означает «только лидер», " +
        "и надёжная на бумаге настройка тихо превращается в <code>acks=1</code>. Лечится это парой " +
        "<code>acks=all</code> + [[min.insync.replicas]].</p>",

        "<p>From here it is a straight road into the next chapter. A producer can demand acknowledgements not only from the leader " +
        "but from every replica in the ISR — that is [[acks|acks=all]]. But “everyone in the ISR” with an ISR of one member means “the leader only”, " +
        "and a setting that is reliable on paper quietly turns into <code>acks=1</code>. The cure is the pair " +
        "<code>acks=all</code> + [[min.insync.replicas]].</p>"
      )));

      root.appendChild(ui.takeaway(L(
        [
          "Партиция хранится в RF копиях на разных [[брокер|брокерах]]; работу ведёт только [[лидер]], реплики повторяют за ним и клиентам не видны.",
          "[[ISR]] — живой список реплик, которые успевают. Отстала дольше <code>replica.lag.time.max.ms</code> (по умолчанию 30 с) — выпала; догнала — вернулась сама.",
          "Умер лидер — нового берут <b>из ISR</b>. Реплика вне ISR лидером не станет: её лог короче, и это были бы стёртые записи.",
          "<code>unclean.leader.election.enable=false</code> по умолчанию: Kafka предпочитает недоступную партицию потерянным данным.",
          "Размер ISR — главная метрика надёжности. Именно на схлопнувшемся ISR ломается [[acks|acks=all]] — это следующая глава."
        ],
        [
          "A partition is kept in RF copies on different [[broker|brokers]]; only the [[leader]] does the work, the replicas replay it and clients never see them.",
          "The [[ISR]] is a live list of the replicas that keep up. Behind for longer than <code>replica.lag.time.max.ms</code> (30 s by default) — out; caught up — back in, on its own.",
          "The leader died — the new one is taken <b>from the ISR</b>. A replica outside the ISR will not become leader: its log is shorter, and the records it is missing would be erased.",
          "<code>unclean.leader.election.enable=false</code> is the default: Kafka prefers an unavailable partition to lost data.",
          "The size of the ISR is the main reliability metric. A collapsed ISR is exactly where [[acks|acks=all]] breaks — that is the next chapter."
        ]
      )));
    }
  });
})();
