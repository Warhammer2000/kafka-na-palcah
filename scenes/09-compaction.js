/* Глава 09 — Compaction: из истории в снимок состояния. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "compaction",
    num: 9,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Хранение", "Storage"],
    nav: ["Compaction", "Compaction"],
    title: [
      "Compaction: из истории в снимок состояния",
      "Compaction: from history to a snapshot of state"
    ],
    lede: [
      "Retention выбрасывает <b>старое</b> и не смотрит, что внутри записи. Но если у записей есть <b>ключ</b>, выбрасывать можно <b>устаревшее</b> — всё, для чего уже есть свежая версия: <code>cleanup.policy=compact</code> превращает топик из истории изменений в снимок состояния.",
      "Retention throws out the <b>old</b> and never looks inside a record. But if records have a <b>key</b>, you can throw out the <b>stale</b> instead — everything that already has a fresher version: <code>cleanup.policy=compact</code> turns a topic from a history of changes into a snapshot of state."
    ],

    build: function (root, api) {

      root.appendChild(ui.prose(L(
        "<p>Для журнала событий это правильный критерий: клик недельной давности никому не нужен, и его сносят целым сегментом. " +
        "Но есть [[топик|топики]], где запись — не событие, а <em>текущее значение</em> сущности: профиль пользователя, настройки, прайс-лист. " +
        "Здесь возраст не значит ничего — [[retention]] срежет самую старую запись, не спросив, единственная ли она у живой сущности.</p>" +
        "<p>Вопрос, на который надо отвечать, другой: <strong>есть ли для этого [[ключ|ключа]] что-то посвежее</strong>. " +
        "Если есть — предыдущую версию можно выбросить хоть сразу, и никто не заметит: читателю нужно последнее значение, а не путь к нему.</p>",

        "<p>For an event log that is the right test: a week-old click is no use to anyone, and it goes out with a whole segment. " +
        "But there are [[topic|topics]] where a record is not an event but the <em>current value</em> of an entity: a user profile, settings, a price list. " +
        "Here age means nothing — [[retention]] will cut the oldest record without ever asking whether it was the only one a live entity had.</p>" +
        "<p>The question that actually needs answering is a different one: <strong>is there anything fresher for this [[key]]</strong>. " +
        "If there is, the previous version can go right away and nobody will notice: the reader wants the last value, not the road to it.</p>"
      )));

      root.appendChild(ui.note("key", L("правило", "rule"), L(
        "<p><strong>[[compaction|Compaction]] оставляет для каждого ключа ровно одну запись — последнюю.</strong> Всё, что было раньше, вычищается независимо от возраста.</p>" +
        "<p>Работает это только там, где ключ — идентификатор сущности (<code>userId</code>, <code>sku</code>, <code>accountId</code>), а значение — её <b>полное состояние</b>, а не приращение. " +
        "«Списать 100 рублей» уплотнять нельзя — потеряешь половину списаний. «Баланс = 900» — можно.</p>",

        "<p><strong>[[compaction|Compaction]] keeps exactly one record for each key — the last one.</strong> Everything written before it is swept away, whatever its age.</p>" +
        "<p>This only works where the key is the id of an entity (<code>userId</code>, <code>sku</code>, <code>accountId</code>) and the value is its <b>full state</b>, not a delta. " +
        "“Deduct 100 roubles” must never be compacted — you would lose half the deductions. “Balance = 900” is fine.</p>"
      )));

      /* ======================= стенд ======================= */

      var stage = ui.stage({
        title: L("Уплотнение по ключу", "Compaction by key"),
        hint: L("Дописывай версии и запускай уплотнение — следи за оффсетами",
          "Append versions, run compaction — and watch the offsets")
      });

      var CITY2 = L(["Киев", "Варшава", "Берлин", "Лиссабон"], ["Kyiv", "Warsaw", "Berlin", "Lisbon"]);
      var CITY3 = L(["Прага", "Вена", "Рига"], ["Prague", "Vienna", "Riga"]);

      var recs = [];          // { key, name, city, tomb, state, swept }
      var policy = "compact";
      var busy = false;       // идёт уборка — записи ждут
      var c2 = 1, c3 = 0;

      /* Слот палитры на ключ задаём руками: util.keyColor даёт user1 и user2 ОДИН
         цвет (hash % 6 совпал), а вся глава держится на «цвет = ключ». */
      var SLOTS = { user1: 0, user2: 3, user3: 1 };   // k0 синий, k3 фиолетовый, k1 розовый
      function slotOf(k) { var i = SLOTS[k]; return typeof i === "number" ? i : 5; }
      function keyColor(k) { return util.paletteColor(slotOf(k)); }
      function keySoft(k) { return "var(--k" + slotOf(k) + "-soft)"; }

      /* ---------------- модель записи ---------------- */

      function rec(key, name, city) {
        return { key: key, name: name, city: city || "", tomb: false, state: "ok" };
      }
      function tombRec(key) {
        return { key: key, name: "", city: "", tomb: true, state: "tomb", swept: false };
      }
      function valText(r) {
        if (r.tomb) return "null";
        var s = L("{имя: «", "{name: “") + r.name + L("»", "”");
        if (r.city) s += L(", город: «", ", city: “") + r.city + L("»", "”");
        return s + "}";
      }
      function mono(s, color) {
        return '<span style="font-family:var(--f-mono);font-size:.92em' +
          (color ? ";color:" + color : "") + '">' + util.escape(s) + "</span>";
      }
      function valHtml(r) {
        if (r.tomb) {
          return mono("null", "var(--bad)") + L(
            ' <span style="color:var(--faint);font-size:12px">надгробие</span>',
            ' <span style="color:var(--faint);font-size:12px">tombstone</span>');
        }
        return mono(valText(r));
      }
      function shortKey(k) { return "u" + String(k).replace(/[^0-9]/g, ""); }

      function stripRec(r, off) {
        return {
          key: r.key,
          label: r.tomb ? "∅" : shortKey(r.key),
          color: keyColor(r.key),
          state: r.state,
          title: "offset " + off + " · " + r.key + " → " + valText(r)
        };
      }

      /* Свой цвет клетки core уже не заливает мягким фоном — доливаем сами.
         Надгробию заливку не даём: под ней должна быть видна штриховка .is-tomb. */
      function tint(off) {
        var r = recs[off], c = strip.cell(off);
        if (r && c && !r.tomb) c.style.background = keySoft(r.key);
      }

      function latestLive(key) {
        var found = null;
        recs.forEach(function (r) { if (r.key === key && r.state !== "dropped") found = r; });
        return found;
      }
      function offList(arr) {
        if (!arr.length) return "—";
        if (arr.length <= 12) return arr.join(", ");
        return arr.slice(0, 12).join(", ") + ", …";
      }
      function offsets(arr) {
        return (arr.length === 1 ? "offset " : "offsets ") + offList(arr);
      }

      /* ---------------- лог ---------------- */

      var producer = ui.node("producer", L("продюсер", "producer"), "topic: users");
      var policyTag = el("span");
      var strip = ui.logStrip({ empty: L("лог пуст", "the log is empty") });

      var logPanel = ui.panel(L("Лог топика users · партиция 0", "Log of the users topic · partition 0"),
        el("div.kv-row", { style: { "margin-bottom": "8px" } }, producer, policyTag),
        strip.el,
        el("div", { style: { "margin-top": "2px" } }, ui.legend([
          { color: keyColor("user1"), label: "u1 — user1" },
          { color: keyColor("user2"), label: "u2 — user2" },
          { color: keyColor("user3"), label: "u3 — user3" },
          { color: "var(--muted)", label: L("∅ — надгробие, значение null", "∅ — tombstone, value null") },
          { color: "var(--line)", label: L("зачёркнутая клетка в пунктирной рамке — выброшена уплотнением",
            "a struck-through cell in a dashed frame — thrown out by compaction") }
        ])));

      /* ---------------- снимок состояния ---------------- */

      var snapBox = el("div");
      var snapNote = el("div", { style: { "font-size": "12.5px", color: "var(--muted)", "margin-top": "10px" } });
      var bar = ui.bar(1);
      var barCap = el("div", { style: { "font-size": "12px", color: "var(--muted)", "margin-top": "6px" } });

      var snapPanel = ui.panel(L("Снимок состояния", "Snapshot of state"),
        el("div", {
          style: { "font-size": "12.5px", color: "var(--faint)", "margin-bottom": "6px" },
          text: L("что соберёт новый сервис, прочитав топик с нуля",
            "what a new service builds by reading the topic from zero")
        }),
        snapBox, snapNote,
        el("div", { style: { "margin-top": "12px" } }, bar.el, barCap));

      /* ---------------- показатели ---------------- */

      var stOff = ui.stat(L("оффсетов выдано", "offsets issued"), 0);
      var stLive = ui.stat(L("живых записей", "live records"), 0);
      var stDrop = ui.stat(L("выброшено", "thrown out"), 0);
      var stKeys = ui.stat(L("ключей в снимке", "keys in the snapshot"), 0, { tone: "read" });

      stage.body.appendChild(el("div.kv-split", null, logPanel, snapPanel));
      stage.body.appendChild(el("div", { style: { "margin-top": "14px" } },
        ui.stats(stOff.el, stLive.el, stDrop.el, stKeys.el)));

      /* ---------------- пересчёт ---------------- */

      function snapshot() {
        var map = {}, order = [];
        recs.forEach(function (r, off) {
          if (r.state === "dropped") return;
          if (!map[r.key]) order.push(r.key);
          map[r.key] = { rec: r, off: off };
        });
        return { map: map, order: order };
      }

      function renderSnap(snap) {
        KV.clear(snapBox);
        if (!snap.order.length) {
          snapBox.appendChild(el("div", {
            style: { "font-family": "var(--f-mono)", "font-size": "12px", color: "var(--faint)" },
            text: L("ни одного ключа — снимок пуст", "not a single key — the snapshot is empty")
          }));
          return;
        }
        snap.order.forEach(function (k) {
          var it = snap.map[k], r = it.rec;
          snapBox.appendChild(el("div", {
            style: {
              display: "grid", "grid-template-columns": "auto minmax(0,1fr) auto",
              gap: "10px", "align-items": "baseline",
              padding: "6px 0", "border-top": "1px solid var(--line-soft)"
            }
          },
            el("span", {
              style: {
                "font-family": "var(--f-mono)", "font-size": "12.5px",
                color: r.tomb ? "var(--faint)" : keyColor(k),
                "text-decoration": r.tomb ? "line-through" : "none"
              },
              text: k
            }),
            el("span", { html: valHtml(r), style: { "overflow-wrap": "anywhere", "min-width": "0" } }),
            el("span", {
              style: { "font-family": "var(--f-mono)", "font-size": "11px", color: "var(--faint)" },
              text: "off " + it.off
            })));
        });
      }

      function paint() {
        var snap = snapshot();
        var live = 0, drop = 0;
        recs.forEach(function (r) { if (r.state === "dropped") drop++; else live++; });
        var liveKeys = snap.order.filter(function (k) { return !snap.map[k].rec.tomb; });
        var tombKeys = snap.order.filter(function (k) { return snap.map[k].rec.tomb; });

        renderSnap(snap);

        stOff.set(recs.length);
        stLive.set(live);
        stDrop.set(drop, drop ? "warn" : null);
        stKeys.set(liveKeys.length, "read");

        bar.set(recs.length ? live / recs.length : 0);
        barCap.innerHTML = L("Чтобы собрать этот снимок, новый сервис прочитает <b>",
          "To build this snapshot, a new service will read <b>") + live + "</b> " +
          util.plural(live, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
          L(" из <b>", " out of <b>") + recs.length + "</b> " +
          util.plural(recs.length,
            L("выданного оффсета", "issued offset"),
            L("выданных оффсетов", "issued offsets"),
            L("выданных оффсетов", "issued offsets")) + ".";

        if (policy !== "compact") {
          /* Текст считаем из ленты: после уплотнения «вся история» уже не лежит,
             и обещать её, когда рядом видны зачёркнутые клетки, нельзя. */
          snapNote.innerHTML = drop
            ? L("<b>Уплотнение уже прошло:</b> ", "<b>Compaction has already run:</b> ") + drop + " " +
              util.plural(drop,
                L("запись выброшена", "record was thrown out"),
                L("записи выброшены", "records were thrown out"),
                L("записей выброшено", "records were thrown out")) +
              L(", и снимок держится на том, что уцелело. " +
                "С <code>cleanup.policy=delete</code> новых уплотнений не будет, но и выброшенное не вернётся. " +
                "А дальше придёт retention, срежет старые сегменты — и ключ, которого давно не обновляли, исчезнет " +
                "из снимка вместе со своей последней записью, хотя сущность жива.",

                ", and the snapshot rests on whatever survived. " +
                "With <code>cleanup.policy=delete</code> there will be no new compaction, but nothing thrown out comes back either. " +
                "And then retention arrives, cuts the old segments away — and a key nobody has updated for a long time disappears " +
                "from the snapshot together with its last record, even though the entity is alive.")
            : L("<b>Сейчас этот снимок держится на честном слове:</b> он верен только потому, " +
              "что в логе ещё лежит вся история. Придёт retention, срежет старые сегменты — и ключ, которого давно " +
              "не обновляли, исчезнет из снимка вместе со своей единственной записью, хотя сущность жива.",

              "<b>Right now this snapshot holds together on nothing but luck:</b> it is correct only because " +
              "the whole history is still in the log. Retention will arrive, cut the old segments away — and a key nobody " +
              "has updated for a long time will disappear from the snapshot together with its only record, even though the entity is alive.");
        } else if (tombKeys.length) {
          snapNote.innerHTML = L("Ключ ", "Key ") + mono(tombKeys[0]) +
            L(" перечёркнут: дочитав до надгробия, консьюмер " +
              "<b>удаляет</b> его из своей карты. В снимке его больше нет.",
              " is struck through: once a consumer reads as far as the tombstone, it " +
              "<b>deletes</b> the key from its own map. It is no longer in the snapshot.");
        } else {
          snapNote.innerHTML = L("Для каждого ключа показана его последняя запись в логе. Это и есть «текущее состояние».",
            "For every key you see its last record in the log. That is exactly what “current state” means.");
        }

        var u3 = latestLive("user3");
        btn3.textContent = u3 && !u3.tomb ? L("user3 обновился", "user3 updated") : L("user3 появился", "user3 appeared");
      }

      function syncPolicy() {
        KV.clear(policyTag);
        policyTag.appendChild(ui.badge("cleanup.policy = " + policy, policy === "compact" ? "read" : null));
        compactBtn.disabled = busy || policy !== "compact";
        compactBtn.title = policy === "compact" ? "" : L("у топика с cleanup.policy=delete уплотнения нет",
          "a topic with cleanup.policy=delete has no compaction at all");
      }

      /** Пока идёт уборка, писать и сбрасывать нельзя — иначе оффсеты поедут. */
      function setBusy(b) {
        busy = b;
        [btn1, btn2, btn3, tombBtn, resetBtn].forEach(function (x) { x.disabled = b; });
        compactBtn.disabled = b || policy !== "compact";
      }

      /* ---------------- запись ---------------- */

      function writeRec(r, describe) {
        if (busy) return;
        var plate = strip.el.querySelector(".kv-part__label") || strip.strip;
        /* Пока запись летит, лог трогать нельзя: второй клик успел бы посчитать
           состояние до приземления — два надгробия подряд, уборка по старому логу. */
        setBusy(true);
        KV.fly(producer, plate, {
          label: r.tomb ? "∅" : shortKey(r.key),
          color: keyColor(r.key),
          soft: r.tomb ? "var(--surface-3)" : keySoft(r.key),
          ms: api.reduced ? 0 : 340
        }).then(function () {
          var off = recs.length;
          recs.push(r);
          strip.push(stripRec(r, off));
          tint(off);
          strip.highlight(off, "is-hot", 700);
          setBusy(false);
          paint();
          stage.say(describe(off));
        });
      }

      function writeUser1() {
        if (busy) return;
        var city = String(cityInput.value || "").trim().slice(0, 18) || L("Ташкент", "Tashkent");
        var prev = latestLive("user1");
        var mode = !prev ? "gone" : prev.tomb ? "tomb" : "live";
        writeRec(rec("user1", L("Иван", "Ivan"), city), function (off) {
          var head = L("Дописана новая версия user1 → ", "A new version of user1 was appended → ") +
            mono(L("{имя: «Иван», город: «", "{name: “Ivan”, city: “") + city + L("»}", "”}")) +
            ", offset <b>" + off + "</b>. ";
          return head + (
              mode === "tomb"
                ? L("Ключ <b>воскрес</b>: после надгробия его можно записать заново — это обычная новая запись с тем же ключом, и она перебивает удаление.",
                  "The key has <b>come back to life</b>: after a tombstone you can write it again — an ordinary new record with the same key, and it overrides the deletion.")
              : mode === "gone"
                ? L("От прежнего user1 в логе не осталось ничего — уплотнение вынесло всё, включая надгробие. Для читателей это просто новый ключ.",
                  "Nothing is left of the old user1 in the log — compaction swept it all away, tombstone included. To readers this is simply a new key.")
                : L("Прежние версии user1 <b>всё ещё лежат</b> в логе: уплотнение — фоновая уборка, а не действие продюсера.",
                  "The earlier versions of user1 are <b>still sitting</b> in the log: compaction is background cleanup, not something the producer does.")
            );
        });
      }

      function writeUser2() {
        if (busy) return;
        var city = CITY2[c2 % CITY2.length]; c2++;
        writeRec(rec("user2", L("Пётр", "Pyotr"), city), function (off) {
          var head = L("user2 сменил город на «", "user2 changed city to “") + util.escape(city) +
            L("», offset <b>", "”, offset <b>") + off + "</b>. ";
          return head + L("Предыдущая версия user2 в ту же секунду стала устаревшей — для этого ключа есть свежее.",
            "The previous version of user2 went stale that very second — there is something fresher for this key now.");
        });
      }

      function writeUser3() {
        if (busy) return;
        var prev = latestLive("user3");
        var fresh = !prev || prev.tomb;
        var city = fresh ? "" : CITY3[c3++ % CITY3.length];
        writeRec(rec("user3", L("Ольга", "Olga"), city), function (off) {
          return fresh
            ? L("Появился новый ключ user3, offset <b>", "A new key user3 appeared, offset <b>") + off + "</b>. " +
              L("В снимке стало на строку больше, и это не задело ни одной чужой записи.",
                "The snapshot has one more row, and not a single other record was touched.")
            : L("user3 обновился («", "user3 updated (“") + util.escape(city) +
              L("»), offset <b>", "”), offset <b>") + off + "</b>.";
        });
      }

      function writeTomb() {
        if (busy) return;
        var prev = latestLive("user1");
        if (prev && prev.tomb) {
          stage.say(L("У user1 уже стоит надгробие. Второе ничего не изменит: ключа в снимке и так нет.",
            "user1 already has a tombstone. A second one changes nothing: the key is not in the snapshot anyway."));
          return;
        }
        writeRec(tombRec("user1"), function (off) {
          return policy === "compact"
            ? L("Надгробие для user1 на offset <b>", "A tombstone for user1 at offset <b>") + off +
              L("</b> — запись с ключом и значением ", "</b> — a record with a key and the value ") + mono("null") + ". " +
              L("Это не «пустое значение», а команда уборщику: <b>вынести все записи этого ключа</b>. " +
                "Консьюмер, дочитав сюда, удаляет user1 у себя.",
                "This is not “an empty value”, it is an order to the cleaner: <b>sweep out every record with this key</b>. " +
                "A consumer that reads this far deletes user1 on its own side.")
            : L("Надгробие записано (offset <b>", "The tombstone is written (offset <b>") + off +
              L("</b>), но при ", "</b>), but with ") + mono("cleanup.policy=delete") +
              L(" его никто не исполнит: уборщик не смотрит на ключи. Для такого топика это обычная запись со значением ",
                " nobody will carry it out: the cleaner never looks at keys. For a topic like that it is an ordinary record with the value ") +
              mono("null") + ".";
        });
      }

      /* ---------------- уборка ---------------- */

      function runCompaction() {
        if (busy || policy !== "compact") return;

        var last = {};
        recs.forEach(function (r, off) { if (r.state !== "dropped") last[r.key] = off; });

        var victims = [], sweep = [];
        recs.forEach(function (r, off) {
          if (r.state === "dropped") return;
          if (last[r.key] !== off) { victims.push(off); return; }   // для ключа есть свежее
          if (r.tomb) {
            if (r.swept) victims.push(off);                          // надгробие уже пережило проход
            else sweep.push(off);
          }
        });

        if (!victims.length && !sweep.length) {
          stage.say(L("Уплотнять нечего: у каждого ключа ровно одна версия. Топик уже равен снимку состояния — " +
            "compacted-топик это и есть его нормальное состояние, а не разовая операция.",
            "There is nothing to compact: every key has exactly one version. The topic already equals the snapshot of state — " +
            "for a compacted topic that is the normal condition, not a one-off operation."));
          return;
        }

        if (!victims.length) {
          sweep.forEach(function (off) { recs[off].swept = true; });
          paint();
          stage.say(L("Устаревших версий нет. Надгробию (", "There are no stale versions. The tombstone (") +
            offsets(sweep) + L(") засчитан первый проход: " +
            "оно обязано дожить до отставших читателей. Запусти уплотнение ещё раз — уйдёт и оно.",
            ") has been credited with its first pass: " +
            "it has to survive until the readers lagging behind catch up. Run compaction once more and it will go too."));
          return;
        }

        setBusy(true);
        var i = 0;
        var t = api.interval(api.reduced ? 1 : 130, function () {
          if (i >= victims.length) {
            api.stop(t);
            finishCompaction(victims, sweep);
            return;
          }
          var off = victims[i++];
          recs[off].state = "dropped";
          strip.setState(off, "dropped");
          paint();
        });
      }

      function finishCompaction(victims, sweep) {
        setBusy(false);
        sweep.forEach(function (off) { recs[off].swept = true; });
        paint();

        var alive = [];
        recs.forEach(function (r, off) { if (r.state !== "dropped") alive.push(off); });

        var msg = L("<b>Уплотнение прошло.</b> Выброшено: ", "<b>Compaction is done.</b> Thrown out: ") + victims.length + " " +
          util.plural(victims.length, L("запись", "record"), L("записи", "records"), L("записей", "records")) +
          " — " + offsets(victims) + ". " +
          (alive.length === 1 ? L("Остался ", "What is left: ") : L("Остались ", "What is left: ")) +
          "<b>" + offsets(alive) + L("</b>: номера ", "</b> — the numbers ") +
          L("<b>не сдвинулись</b>, в логе просто появились дырки. ",
            "<b>did not shift</b>, the log simply grew holes. ") +
          L("Следующая запись всё равно получит offset ", "The next record will still get offset ") +
          recs.length + L(", а не ", ", not ") + alive.length + ".";
        if (sweep.length) {
          msg += L(" Надгробие (", " The tombstone (") + offsets(sweep) +
            L(") пока оставлено — ему надо дожить до отставших читателей (",
              ") is left in place for now — it has to survive until the readers lagging behind catch up (") +
            mono("delete.retention.ms") + L("). Ещё один проход уберёт и его.",
              "). One more pass will take it away too.");
        }
        stage.say(msg);
      }

      /* ---------------- контролы ---------------- */

      var cityInput = el("input.kv-input", {
        type: "text", value: L("Алматы", "Almaty"), maxlength: "18",
        "aria-label": L("новый город для user1", "a new city for user1"),
        style: { width: "104px" }
      });
      cityInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); writeUser1(); }
      });

      var btn1 = ui.btn(L("Записать", "Append"), writeUser1, { sm: true });
      var btn2 = ui.btn(L("user2 сменил город", "user2 changed city"), writeUser2, { sm: true });
      var btn3 = ui.btn(L("user3 появился", "user3 appeared"), writeUser3, { sm: true });
      var tombBtn = ui.btn(L("Удалить user1 (tombstone)", "Delete user1 (tombstone)"), writeTomb, { sm: true, variant: "danger" });
      var compactBtn = ui.btn(L("Запустить уплотнение", "Run compaction"), runCompaction, { variant: "primary" });

      var seg = ui.seg(
        [{ value: "compact", label: "compact" }, { value: "delete", label: "delete" }],
        "compact",
        function (v) {
          if (busy) {                 // уборка уже идёт — на полпути политику не меняем
            seg.set(policy);
            stage.say(L("Дождись конца уплотнения — политику топика меняем на спокойном логе.",
              "Wait for compaction to finish — the topic policy gets changed on a quiet log."));
            return;
          }
          policy = v;
          syncPolicy();
          paint();
          stage.say(v === "compact"
            ? L("<b>cleanup.policy = compact.</b> Уборщик сравнивает записи по ключу и оставляет для каждого последнюю. Возраст записи не важен вообще.",
              "<b>cleanup.policy = compact.</b> The cleaner compares records by key and keeps the last one for each. The age of a record does not matter at all.")
            : L("<b>cleanup.policy = delete.</b> Режим из прошлой главы: уборщик режет лог по возрасту и размеру, целыми сегментами, " +
              "внутрь записи не заглядывая. Он не знает ни про ключи, ни про то, что у user1 есть свежая версия — поэтому " +
              "кнопка уплотнения погасла: у такого топика этого механизма просто нет.",

              "<b>cleanup.policy = delete.</b> The mode from the previous chapter: the cleaner cuts the log by age and size, whole segments at a time, " +
              "never looking inside a record. It knows nothing about keys, and nothing about user1 having a fresher version — which is why " +
              "the compaction button went dark: a topic like this simply does not have that mechanism."));
        });

      var resetBtn = ui.btn(L("Сбросить", "Reset"), function () {
        reset(L("Лог вернулся к исходному примеру: пять записей, два ключа, три из них устарели.",
          "The log is back to the starting example: five records, two keys, three of them stale."));
      }, { sm: true, variant: "ghost" });

      KV.append(stage.controls,
        ui.ctl(L("user1 переехал в", "user1 moved to"), cityInput, btn1),
        btn2, btn3, tombBtn, compactBtn,
        ui.ctl("cleanup.policy", seg.el),
        resetBtn);

      /* ---------------- старт ---------------- */

      function reset(msg) {
        recs = [
          rec("user1", L("Иван", "Ivan"), ""),
          rec("user2", L("Пётр", "Pyotr"), ""),
          rec("user1", L("Иван", "Ivan"), L("Москва", "Moscow")),
          rec("user1", L("Иван", "Ivan"), L("Ташкент", "Tashkent")),
          rec("user2", L("Пётр", "Pyotr"), L("Киев", "Kyiv"))
        ];
        c2 = 1; c3 = 0;
        setBusy(false);
        cityInput.value = L("Алматы", "Almaty");
        strip.setRecords(recs.map(function (r, i) { return stripRec(r, i); }));
        recs.forEach(function (r, i) { tint(i); });
        paint();
        stage.say(msg);
      }

      syncPolicy();
      reset(L("В логе лежит пример из материала: пять записей, два ключа. Три записи уже устарели — " +
        "для user1 свежее лежит на offset 3, для user2 на offset 4. Нажми «Запустить уплотнение».",

        "The log holds the example from the text above: five records, two keys. Three records are already stale — " +
        "for user1 the fresher one sits at offset 3, for user2 at offset 4. Press “Run compaction”."));

      root.appendChild(stage.el);

      /* ======================= разбор ======================= */

      root.appendChild(ui.prose(L(
        "<h3>Что произошло с логом</h3>" +
        "<p>Он стал <strong>разреженным</strong>. Уцелевшие записи сохранили свои номера — 3 и 4, а не 0 и 1. " +
        "[[offset|Оффсет]] в Kafka не индекс массива, а вечный номер: выдан один раз и никогда не пересчитывается. " +
        "[[консьюмер|Консьюмер]] с сохранённой позицией 2 просто получит следующую существующую запись — дырки его не смущают.</p>" +
        "<p>И вот ради чего всё затевалось: чтобы узнать текущее состояние всех сущностей, новому сервису больше не надо " +
        "перечитывать миллион исторических правок. Он читает compacted-топик с начала, кладёт каждую запись в карту по ключу — " +
        "и на последнем оффсете у него в памяти актуальный снимок. Ровно так работают KTable в Kafka Streams и " +
        "changelog-топики. Kafka делает это и для себя: [[__consumer_offsets]] — compacted-топик, где ключ это " +
        "«группа + топик + партиция», а значение — [[committed offset]].</p>",

        "<h3>What happened to the log</h3>" +
        "<p>It went <strong>sparse</strong>. The surviving records kept their numbers — 3 and 4, not 0 and 1. " +
        "An [[offset]] in Kafka is not an array index but a permanent number: issued once and never recomputed. " +
        "A [[consumer]] with a saved position of 2 simply gets the next record that still exists — the holes do not bother it.</p>" +
        "<p>And here is what the whole thing was for: to learn the current state of every entity, a new service no longer has to " +
        "re-read a million historical edits. It reads the compacted topic from the start, puts every record into a map by key — " +
        "and at the last offset it is holding an up-to-date snapshot in memory. This is exactly how KTables in Kafka Streams and " +
        "changelog topics work. Kafka does it for itself too: [[__consumer_offsets]] is a compacted topic where the key is " +
        "“group + topic + partition” and the value is the [[committed offset]].</p>"
      )));

      root.appendChild(ui.table(
        ["", "cleanup.policy = delete", "cleanup.policy = compact"],
        L([
          ["Удаляет", "старое: по возрасту <code>retention.ms</code> или размеру <code>retention.bytes</code>",
            "устаревшее: всё, для чего у ключа есть свежая запись"],
          ["Остаётся", "всё за последние N дней", "последнее значение каждого ключа"],
          ["Топик это", "история событий", "снимок состояния, по сути key-value"],
          ["Читать с нуля", "вся история за N дней", "по одной записи на сущность"],
          ["Пример", "лог действий, аудит, клики", "профили, настройки, прайсы, <code>__consumer_offsets</code>"]
        ], [
          ["Deletes", "the old: by age <code>retention.ms</code> or size <code>retention.bytes</code>",
            "the stale: everything a key already has a fresher record for"],
          ["What stays", "everything from the last N days", "the last value of every key"],
          ["The topic is", "a history of events", "a snapshot of state, key-value in effect"],
          ["Reading from zero", "the whole N days of history", "one record per entity"],
          ["Example", "an action log, audit trail, clicks", "profiles, settings, price lists, <code>__consumer_offsets</code>"]
        ])));

      root.appendChild(ui.note("warn", L("ловушка", "trap"), L(
        "<p><strong>«Уплотнён» не значит «без дубликатов».</strong> Уборщик работает в фоне и никогда не трогает активный сегмент — " +
        "тот, куда пишут прямо сейчас. Просыпается он, когда доля «грязных» записей перевалит за <code>min.cleanable.dirty.ratio</code> " +
        "(по умолчанию 0,5). Пока этого не случилось, несколько версий одного ключа спокойно лежат рядом и приезжают консьюмеру.</p>" +
        "<p>Гарантия здесь одна: <b>последнее значение каждого ключа точно на месте</b>. А не «лишнего нет». Значит, консьюмер обязан " +
        "переживать повторы и просто применять записи по порядку — последняя победит.</p>",

        "<p><strong>“Compacted” does not mean “no duplicates”.</strong> The cleaner works in the background and never touches the active segment — " +
        "the one being written to right now. It wakes up when the share of “dirty” records goes past <code>min.cleanable.dirty.ratio</code> " +
        "(0.5 by default). Until that happens, several versions of one key sit side by side quite happily and arrive at the consumer.</p>" +
        "<p>There is exactly one guarantee here: <b>the last value of every key is definitely in place</b>. Not “there is nothing extra”. So the consumer has to " +
        "survive repeats and simply apply records in order — the last one wins.</p>"
      )));

      root.appendChild(ui.prose(L(
        "<h4>Мелочи, о которые спотыкаются</h4>" +
        "<ul>" +
        "<li>Писать в compacted-топик <b>без ключа нельзя</b>: брокер отвечает ошибкой " +
        /* Длинную строку ошибки переносим по словам: с nowrap (по умолчанию
           у .kv-prose code) она в одну строку растягивает всю главу вбок на
           узком экране — 454 px при ширине 360. */
        "<code style=\"white-space:normal\">Compacted topic cannot accept message without key</code>. " +
        "Уплотнять нечего — не по чему группировать.</li>" +
        "<li>Политики совмещаются: <code>cleanup.policy=compact,delete</code> — последнее значение каждого ключа, " +
        "но не старше <code>retention.ms</code>. Снимок есть, вечного хранения нет.</li>" +
        "<li>[[tombstone|Надгробие]] после первого прохода не исчезает: оно живёт ещё <code>delete.retention.ms</code> " +
        "(сутки по умолчанию), чтобы отставший консьюмер успел увидеть удаление и вычистить ключ у себя. " +
        "Уйдёт раньше — сервис, который читал медленно, не увидит надгробия и останется с призраком удалённого ключа в памяти навсегда.</li>" +
        "</ul>",

        "<h4>Small things people trip over</h4>" +
        "<ul>" +
        "<li>Writing to a compacted topic <b>without a key is not allowed</b>: the broker answers with the error " +
        "<code style=\"white-space:normal\">Compacted topic cannot accept message without key</code>. " +
        "There is nothing to compact — nothing to group by.</li>" +
        "<li>The policies combine: <code>cleanup.policy=compact,delete</code> — the last value of every key, " +
        "but nothing older than <code>retention.ms</code>. You get the snapshot without keeping it forever.</li>" +
        "<li>A [[tombstone]] does not vanish after the first pass: it lives another <code>delete.retention.ms</code> " +
        "(a day by default) so that a consumer lagging behind has time to see the deletion and clear the key on its side. " +
        "Let it go sooner and a service that was reading slowly never sees the tombstone and keeps the ghost of a deleted key in memory forever.</li>" +
        "</ul>"
      )));

      root.appendChild(ui.takeaway(L([
        "<code>cleanup.policy=compact</code> удаляет не <b>старое</b>, а <b>устаревшее</b>: для каждого [[ключ|ключа]] остаётся только последняя запись.",
        "[[offset|Оффсеты]] уцелевших записей не меняются — лог становится разреженным, и это норма: оффсет выдан навсегда.",
        "[[tombstone|Надгробие]] — запись с ключом и значением <code>null</code>: команда «забудь этот ключ» и уборщику, и консьюмеру.",
        "Compacted-топик — это key-value снимок состояния: новый сервис читает его с нуля и получает актуальную картину по всем сущностям, а не миллион исторических правок.",
        "Гарантируется только «последнее значение на месте». Уборка фоновая, хвост лога не трогает — консьюмер обязан спокойно переживать несколько версий одного ключа."
      ], [
        "<code>cleanup.policy=compact</code> deletes not the <b>old</b> but the <b>stale</b>: for every [[key]] only the last record is kept.",
        "The [[offset|offsets]] of the surviving records do not change — the log goes sparse, and that is normal: an offset is issued once and for good.",
        "A [[tombstone]] is a record with a key and the value <code>null</code>: the order “forget this key”, addressed to the cleaner and to the consumer alike.",
        "A compacted topic is a key-value snapshot of state: a new service reads it from zero and gets an up-to-date picture of every entity instead of a million historical edits.",
        "The only guarantee is “the last value is in place”. Cleanup runs in the background and never touches the end of the log — the consumer has to take several versions of one key in its stride."
      ])));
    }
  });
})();
