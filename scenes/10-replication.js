/* Глава 10 — Репликация и ISR: лидер, реплики, выборы. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "replication",
    num: 10,
    group: "Надёжность",
    nav: "Репликация и ISR",
    title: "Лидер, реплики и список ISR",
    lede: "Партиция лежит не в одном экземпляре: при <code>replication factor = 3</code> её копия есть на трёх брокерах. Одна копия — <b>лидер</b>, через неё идёт вся работа; остальные повторяют за ней. Вопрос главы: кого делать лидером, когда текущий умрёт.",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>[[брокер|Брокер]] — это один сервер Kafka, кластер — несколько таких серверов. " +
        "Копии каждой [[партиция|партиции]] раскладывают по разным брокерам, а лидерство раздают вразнобой: " +
        "один и тот же сервер ведёт <code>orders-0</code> и одновременно всего лишь повторяет за чужим лидером <code>orders-1</code>. " +
        "Поэтому упавший брокер не «выключает топик» — он отбирает лидерство у той горстки партиций, которые вёл именно он.</p>" +
        "<p>Реплика (follower) клиентов не обслуживает: она сама ходит к лидеру за новыми записями и дописывает их себе в том же порядке. " +
        "[[продюсер|Продюсер]] и [[консьюмер]] по умолчанию о репликах вообще не думают — спрашивают у кластера «кто сейчас лидер <code>orders-0</code>» и идут по адресу. " +
        "Вся соль в том, что тянут реплики <em>асинхронно</em>: в любой момент времени копии чуть-чуть разные, и в секунду смерти лидера выбирать приходится из <b>неодинаковых</b> логов.</p>"
      ));

      root.appendChild(ui.note("key", "ISR",
        "<p><strong>[[ISR]] — In-Sync Replicas, список реплик, которые прямо сейчас успевают за лидером.</strong> " +
        "Попадание в него не навсегда: затормозила сеть, сервер занят, диск захлебнулся — реплика перестала догонять, и Kafka выкидывает её из ISR. " +
        "Догнала — возвращает обратно. Это живой список, который меняется сам, а не настройка в конфиге.</p>"
      ));

      /* ================= стенд ================= */

      var stage = ui.stage({
        title: "Кластер из трёх брокеров · партиция orders-0",
        hint: "Подними задержку реплики и смотри на строку ISR"
      });

      var RF = 3;
      var LAG_MAX = 2500;   // «replica.lag.time.max.ms» в миниатюре
      var TICK = 120;
      var AUTO_MS = 900;
      var AUTO_CAP = 36;
      var KEYS = ["оплата", "заказ", "клик", "вход", "отказ", "возврат"];

      var brokers = [];
      var unclean = false;
      var lostTotal = 0;
      var writeSeq = 0;
      var offlineLen = 0;   // LEO партиции на момент, когда она осталась без лидера
      var autoId = null;
      var lastTick = Date.now();
      /* Модельные миллисекунды. И копирование, и порог ISR, и журнал считают
         время ПО НЕМУ — иначе в фоновой вкладке (интервалы душатся до ~1 с)
         реплика копировала бы по зажатому dt, а из ISR вылетала бы по
         настоящим часам, то есть раньше, чем обещает ползунок. */
      var clock = 0;

      function say(html) { stage.say(KV.terms(html)); }
      function fmt1(x) { return x.toFixed(1).replace(".", ","); }
      function recs(n) { return n + " " + util.plural(n, "запись", "записи", "записей"); }
      function offsets(a, b) {
        return a === b - 1 ? "offset " + a : "offsets " + a + "…" + (b - 1);
      }

      /* ---- журнал кластера ---- */
      var term = ui.terminal("");
      var journal = [];
      function jrn(tone, msg) {
        var cls = tone === "bad" ? "t-bad" : tone === "good" ? "t-good"
          : tone === "warn" ? "t-w" : tone === "read" ? "t-r" : "t-dim";
        var stamp = "+" + fmt1(clock / 1000) + " с";
        while (stamp.length < 9) stamp = " " + stamp;
        journal.push('<span class="t-dim">' + util.escape(stamp) + "</span>  " +
          '<span class="' + cls + '">' + util.escape(msg) + "</span>");
        if (journal.length > 7) journal.shift();
        term.clear();
        journal.forEach(function (l) { term.line(l); });
      }

      /* ---- продюсер и строка ISR ---- */
      var producer = ui.node("producer", "продюсер", "пишет только в лидера");

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
        b.metaEl = el("span.kv-node__meta", { text: "копия партиции orders-0" });
        b.nodeEl = el("div.kv-node", null, b.dotEl, el("span", { text: "брокер " + b.id }), b.metaEl);

        b.badgeEl = el("span.kv-badge");
        b.lagEl = el("span", {
          style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--muted)" }
        });

        b.actBtn = ui.btn("убить", function () {
          if (b.alive) kill(b); else revive(b);
        }, { sm: true });

        b.strip = ui.logStrip({ label: "orders-0", sub: "брокер " + b.id, empty: "копии нет" });

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
          { color: "var(--write)", label: "лидер — обведён, через него вся запись и чтение" },
          { color: "var(--good)", label: "реплика в ISR — успевает за лидером" },
          { color: "var(--bad)", label: "реплика вне ISR — отстала, лидером стать не может" },
          { color: "var(--muted)", label: "брокер мёртв" }
        ])));

      /* ---- плитки ---- */
      var sRf = ui.stat("replication factor", RF, { unit: "копии" });
      var sIsr = ui.stat("размер ISR", RF, { unit: "из " + RF, tone: "good" });
      var sLeader = ui.stat("лидер", "брокер 1", { tone: "write" });
      var sLeo = ui.stat("записей в партиции", 0);
      var sLost = ui.stat("потеряно навсегда", 0);
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
          jrn("bad", "запись отклонена: у партиции нет лидера");
          say("<b>Запись отклонена.</b> У партиции нет лидера — идти продюсеру некуда. " +
            "Это не «медленно», это <b>недоступно</b>: пока лидер не выбран, партиция не принимает ни записи, ни чтения.");
          render();
          return;
        }
        var key = KEYS[writeSeq % KEYS.length];
        writeSeq++;
        var plate = L.strip.el.querySelector(".kv-part__label") || L.strip.el;

        KV.fly(producer, plate, {
          label: key.slice(0, 3),
          color: util.keyColor(key),
          soft: util.keyColorSoft(key),
          ms: api.reduced ? 0 : 320
        }).then(function () {
          var L2 = leader();
          if (!L2) {
            jrn("bad", "запись «" + key + "» пропала: лидер умер в момент отправки");
            say("<b>Лидер умер прямо во время записи.</b> Подтверждения продюсер не получит — " +
              "и это единственный честный исход: записывать было некуда.");
            render();
            return;
          }
          var off = L2.log.length;
          L2.log.push({ key: key });
          L2.strip.push({ key: key });
          L2.strip.highlight(off, "is-hot", 450);
          render();
          say("Лидер (брокер " + L2.id + ") принял запись на <b>offset " + off + "</b>. " +
            "Реплики о ней ещё не знают — они узнают, когда дотянутся за ней сами. " +
            "Разрыв между лентами и есть отставание реплики.");
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
              jrn("good", "брокер " + b.id + " догнал лидера → возвращён в ISR");
              say("<b>Брокер " + b.id + " догнал лидера и вернулся в ISR.</b> " +
                "Список ISR живой: никто не чинил его руками — реплика перестала отставать, и Kafka сама вернула её в строй.");
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
            jrn("warn", "брокер " + b.id + " отстаёт дольше " + fmt1(LAG_MAX / 1000) + " с → выкинут из ISR");
            if (b.alive) {
              say("<b>Брокер " + b.id + " выпал из ISR.</b> Он не сломан и не мёртв — он просто не успевает: " +
                "последний раз был вровень с лидером более " + fmt1(LAG_MAX / 1000) + " с назад. " +
                "В настоящей Kafka этот порог зовётся <code>replica.lag.time.max.ms</code> и по умолчанию равен 30 с.");
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
        jrn("bad", "брокер " + b.id + (wasLeader ? " (лидер) упал" : " упал"));

        if (wasLeader) {
          elect(b.log.length, false);
        } else {
          render();
          var left = isrIds();
          say("<b>Упала реплика (брокер " + b.id + ").</b> Для продюсера и консьюмера не изменилось ничего: " +
            "лидер жив, запись и чтение идут через него. Изменился только ISR — теперь в нём " +
            (left.length === 1 ? "остался один участник" :
              "осталось " + left.length + " " + util.plural(left.length, "участник", "участника", "участников")) +
            ": <code>[" + left.join(", ") + "]</code>. Запас прочности стал тоньше.");
        }
      }

      function revive(b) {
        if (b.alive) return;
        b.alive = true;
        b.acc = 0;
        b.caughtAt = clock;
        jrn("good", "брокер " + b.id + " вернулся в кластер");

        var ghost = b.stale || 0;
        if (ghost) { b.stale = 0; paint(b); }

        var L = leader();
        if (L) {
          var cut = retain(b, L.log.length) + ghost;
          b.isr = b.log.length >= L.log.length;
          b.wasIsr = b.isr;
          render();
          say("<b>Брокер " + b.id + " вернулся — репликой, а не лидером.</b> " +
            (cut
              ? "Первым делом он <b>выбросил " + recs(cut) + "</b>, которые были только у него: лидер про них не знает, " +
                "а расходиться с лидером реплике нельзя. "
              : "") +
            "Дальше он догоняет лидера с offset " + b.log.length + " и вернётся в ISR, когда поравняется.");
        } else {
          say("<b>Брокер " + b.id + " вернулся.</b> Партиция была без лидера — контроллер сразу пробует выборы.");
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
          if (!x.alive) excluded.push("брокер " + x.id + " — мёртв");
          else if (!x.isr) excluded.push("брокер " + x.id + " — вне ISR (" + x.log.length + " из " + oldLen + " записей)");
        });

        brokers.forEach(function (x) {
          if (x === nw || x.log.length <= keep) return;
          if (x.alive) retain(x, keep); else markDropped(x, keep);
        });
        if (lost) lostTotal += lost;
        offlineLen = keep;
        render();

        if (isUnclean) {
          jrn("bad", "unclean election: лидером назначен брокер " + nw.id + " вне ISR, потеряно " + lost);
          say("<b>Unclean leader election.</b> В ISR живых не осталось, но переключатель разрешил взять кого угодно — " +
            "лидером стал брокер " + nw.id + ", <b>он был вне ISR</b>. Его лог короче на " + recs(lost) + " (" +
            offsets(keep, oldLen) + ") — эти записи <b>стёрты навсегда</b>, хотя продюсер получил на них подтверждение. " +
            "Партиция снова принимает запись ценой дыры в данных.");
          return;
        }

        jrn("read", "выборы: лидером стал брокер " + nw.id + (lost ? ", потеряно " + lost : ", без потерь"));
        say("<b>Выборы. Новый лидер — брокер " + nw.id + ".</b> " +
          (currentIsr
            ? "Кандидатов брали <b>только из ISR</b>: он был в списке, то есть по определению шёл почти вровень (" +
              nw.log.length + " из " + oldLen + " записей). "
            : "Партиция стояла без лидера и дождалась брокера " + nw.id + " — <b>последнего, кто числился в ISR перед смертью</b>. " +
              "Выборы всё равно чистые, но пока он лежал, старый лидер принимал записи дальше, и разрыв успел вырасти (" +
              nw.log.length + " из " + oldLen + " записей). ") +
          (excluded.length ? "Не рассматривались: " + excluded.join("; ") + ". " : "") +
          (lost
            ? "<b>" + (currentIsr ? "И всё же " : "") + recs(lost) + " (" + offsets(keep, oldLen) + ") потеряно</b> — " +
              "у нового лидера их нет, а остальные копии обрезаны по его логу. " +
              "Продюсер с <code>acks=1</code> считал их записанными. Об этом — следующая глава."
            : "Реплика была вровень с лидером, поэтому <b>не потеряно ничего</b>: переключение прошло незаметно для продюсера."));
      }

      function goOffline(oldLen) {
        offlineLen = Math.max(offlineLen, oldLen);
        render();
        var aliveOut = brokers.filter(function (b) { return b.alive; });
        jrn("bad", aliveOut.length
          ? "лидера нет: в ISR не осталось живых реплик — партиция offline"
          : "лидера нет: все копии партиции лежат — партиция offline");
        if (aliveOut.length) {
          var who = aliveOut.map(function (b) {
            return "брокер " + b.id + " (" + b.log.length + " из " + oldLen + ")";
          }).join(", ");
          say("<b>Партиция осталась без лидера.</b> Живые брокеры есть — " + who +
            " — но все они <b>вне ISR</b>: отстали и части записей у них нет. " +
            "Назначить такого лидером — значит объявить его укороченный лог единственно верным и стереть хвост. " +
            "По умолчанию Kafka выбирает <b>простой</b>: партиция не принимает ни запись, ни чтение и ждёт возвращения реплики из ISR. " +
            "Дальше два пути: вернуть брокер из ISR (данные целы) или включить переключатель " +
            "<code>unclean leader election</code> — контроллер тут же назначит лидером отставшую реплику и сотрёт хвост.");
        } else {
          say("<b>Весь кластер лежит.</b> Копий партиции не осталось ни одной живой: ни записи, ни чтения. " +
            "Верни любой брокер — тот, кто был в ISR, станет лидером и партиция оживёт.");
        }
      }

      /* ================= отрисовка ================= */

      var killLeaderBtn, autoToggle;

      function render() {
        var L = leader();
        var ids = isrIds();

        brokers.forEach(function (b) {
          var role, tone, dot;
          if (!b.alive) { role = "мёртв"; tone = ""; dot = "var(--muted)"; }
          else if (b.leader) { role = "ЛИДЕР"; tone = "write"; dot = "var(--write)"; }
          else if (b.isr) { role = "реплика · в ISR"; tone = "good"; dot = "var(--good)"; }
          else { role = "реплика · вне ISR"; tone = "bad"; dot = "var(--bad)"; }

          b.badgeEl.className = "kv-badge" + (tone ? " kv-badge--" + tone : "");
          b.badgeEl.textContent = role;
          b.dotEl.style.background = dot;
          b.nodeEl.classList.toggle("kv-node--dead", !b.alive);
          b.panel.style.borderColor = b.alive && b.leader ? "var(--write)" : "var(--line)";
          b.panel.style.boxShadow = b.alive && b.leader ? "inset 3px 0 0 var(--write)" : "none";
          b.strip.el.style.opacity = !b.alive ? ".45" : b.isr ? "1" : ".62";
          b.actBtn.className = "kv-btn kv-btn--sm" + (b.alive ? " kv-btn--danger" : "");
          b.actBtn.textContent = b.alive ? "убить" : "вернуть";
          b.metaEl.textContent = b.alive && b.leader ? "принимает запись и чтение"
            : !b.alive ? "копия заморожена" : "копирует за лидером";

          var txt, col;
          if (!b.alive) { txt = "не отвечает"; col = "var(--muted)"; }
          else if (b.leader) { txt = "источник истины"; col = "var(--write)"; }
          else if (!L) { txt = "лидера нет"; col = "var(--muted)"; }
          else {
            var behind = L.log.length - b.log.length;
            var secs = (clock - b.caughtAt) / 1000;
            if (behind <= 0) { txt = "вровень с лидером"; col = "var(--good)"; }
            else {
              txt = "отстаёт на " + recs(behind) + " · " + fmt1(secs) + " с";
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
        isrWhy.textContent = !L ? "лидера нет — партиция недоступна"
          : ids.length === RF ? "все копии успевают за лидером"
          : ids.length === 1 ? "в ISR только лидер: живая копия данных одна"
          : "копия выпала из списка — лидером она стать не может";

        sIsr.set(ids.length, ids.length >= RF ? "good" : ids.length >= 2 ? "warn" : "bad");
        sLeader.set(L ? "брокер " + L.id : "нет", L ? "write" : "bad");
        sLeo.set(leo());
        sLost.set(lostTotal, lostTotal ? "bad" : null);
        if (killLeaderBtn) killLeaderBtn.disabled = !L;
      }

      /* ================= управление ================= */

      function stopAuto() {
        if (autoId !== null) { api.stop(autoId); autoId = null; }
        if (autoToggle) autoToggle.set(false);
      }

      autoToggle = ui.toggle("непрерывный поток", false, function (on) {
        if (!on) { stopAuto(); return; }
        autoId = api.interval(AUTO_MS, function () {
          if (leo() >= AUTO_CAP) {
            stopAuto();
            say("<b>Поток остановлен:</b> в демо-логе уже " + recs(AUTO_CAP) + ", дальше смотреть нечего. " +
              "Сбрось стенд или пиши по одной.");
            return;
          }
          doWrite();
        });
        say("Продюсер пишет непрерывно, примерно раз в " + fmt1(AUTO_MS / 1000) + " с. " +
          "Теперь задержка реплики имеет значение: если копировать медленнее, чем приходит поток, отставание растёт без остановки.");
      });

      var d2 = ui.range({
        label: "задержка реплики 2", min: 100, max: 2000, step: 100, value: 250, unit: "мс",
        onInput: function (v) { setDelay(1, v); }
      });
      var d3 = ui.range({
        label: "задержка реплики 3", min: 100, max: 2000, step: 100, value: 250, unit: "мс",
        onInput: function (v) { setDelay(2, v); }
      });

      function setDelay(idx, v) {
        brokers[idx].delay = v;
        say("Брокер " + brokers[idx].id + " копирует примерно одну запись за " + fmt1(v / 1000) + " с. " +
          (autoId !== null
            ? "Поток идёт — теперь это видно сразу: копирует медленнее, чем приходят записи, значит разрыв растёт, " +
              "и как только реплика не поравняется с лидером " + fmt1(LAG_MAX / 1000) + " с подряд, её выкинут из ISR."
            : "Пока продюсер молчит, это ничего не меняет: <b>отставать не от чего</b>, и реплика остаётся в ISR. " +
              "Из списка её выкинет только реальный разрыв с лидером дольше " + fmt1(LAG_MAX / 1000) + " с."));
      }

      killLeaderBtn = ui.btn("Убить лидера", function () {
        var L = leader();
        if (L) kill(L);
      }, { variant: "danger" });

      var uncleanToggle = ui.toggle("unclean leader election", false, function (on) {
        unclean = on;
        if (on) {
          if (!leader()) {
            jrn("warn", "unclean election разрешён — контроллер повторяет выборы");
            elect(offlineLen, false);
            return;
          }
          say("<b>Включён <code>unclean.leader.election.enable=true</code>.</b> Теперь, если в ISR не останется живых, " +
            "лидером назначат отставшую реплику: партиция продолжит работать, но записи, которых у неё нет, исчезнут. " +
            "Обмен «доступность взамен полноты данных» сделан осознанно.");
        } else {
          say("<b>Выключен <code>unclean.leader.election.enable</code>: это значение по умолчанию.</b> " +
            "Лидером станет только реплика из ISR. Нет такой — партиция ждёт, но данные целы.");
        }
        render();
      });

      KV.append(stage.controls,
        ui.btn("Записать", doWrite, { variant: "primary" }),
        autoToggle.el,
        d2.el,
        d3.el,
        killLeaderBtn,
        uncleanToggle.el,
        ui.btn("Сбросить стенд", reset, { variant: "ghost", sm: true }));

      /* ================= старт ================= */

      function reset() {
        stopAuto();
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
        jrn("read", "кластер поднят: RF=3, лидер — брокер 1, ISR = [1, 2, 3]");
        render();
        say("Кластер в порядке: шесть записей лежат на всех трёх брокерах, ISR полный. " +
          "Пиши в лидера и смотри, как реплики повторяют за ним — а потом сломай что-нибудь.");
      }

      reset();
      api.interval(TICK, tick);
      root.appendChild(stage.el);

      /* ================= разбор ================= */

      root.appendChild(ui.prose(
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
        "</ul>"
      ));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>RF=3 не значит «три копии каждой записи прямо сейчас».</strong> Это значит «три брокера держат эту партицию». " +
        "Сколько копий у конкретной свежей записи в конкретный момент — вопрос к ISR, а он всё время меняется. " +
        "Схлопнувшийся до одного участника ISR выглядит снаружи совершенно нормально: лидер жив, запись идёт, метрики зелёные. " +
        "Пока лидер не умрёт.</p>"
      ));

      root.appendChild(ui.prose(
        "<p>Отсюда прямая дорога в следующую главу. Продюсер может потребовать подтверждения не только от лидера, " +
        "а от всех реплик из ISR — это [[acks|acks=all]]. Но «все из ISR» при ISR из одного участника означает «только лидер», " +
        "и надёжная на бумаге настройка тихо превращается в <code>acks=1</code>. Лечится это парой " +
        "<code>acks=all</code> + [[min.insync.replicas]].</p>"
      ));

      root.appendChild(ui.takeaway([
        "Партиция хранится в RF копиях на разных [[брокер|брокерах]]; работу ведёт только [[лидер]], реплики повторяют за ним и клиентам не видны.",
        "[[ISR]] — живой список реплик, которые успевают. Отстала дольше <code>replica.lag.time.max.ms</code> (по умолчанию 30 с) — выпала; догнала — вернулась сама.",
        "Умер лидер — нового берут <b>из ISR</b>. Реплика вне ISR лидером не станет: её лог короче, и это были бы стёртые записи.",
        "<code>unclean.leader.election.enable=false</code> по умолчанию: Kafka предпочитает недоступную партицию потерянным данным.",
        "Размер ISR — главная метрика надёжности. Именно на схлопнувшемся ISR ломается [[acks|acks=all]] — это следующая глава."
      ]));
    }
  });
})();
