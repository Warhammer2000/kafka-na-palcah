/* Глава 09 — Compaction: из истории в снимок состояния. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "compaction",
    num: 9,
    group: "Хранение",
    nav: "Compaction",
    title: "Compaction: из истории в снимок состояния",
    lede: "Retention выбрасывает <b>старое</b> и не смотрит, что внутри записи. Но если у записей есть <b>ключ</b>, выбрасывать можно <b>устаревшее</b> — всё, для чего уже есть свежая версия: <code>cleanup.policy=compact</code> превращает топик из истории изменений в снимок состояния.",

    build: function (root, api) {

      root.appendChild(ui.prose(
        "<p>Для журнала событий это правильный критерий: клик недельной давности никому не нужен, и его сносят целым сегментом. " +
        "Но есть [[топик|топики]], где запись — не событие, а <em>текущее значение</em> сущности: профиль пользователя, настройки, прайс-лист. " +
        "Здесь возраст не значит ничего — [[retention]] срежет самую старую запись, не спросив, единственная ли она у живой сущности.</p>" +
        "<p>Вопрос, на который надо отвечать, другой: <strong>есть ли для этого [[ключ|ключа]] что-то посвежее</strong>. " +
        "Если есть — предыдущую версию можно выбросить хоть сразу, и никто не заметит: читателю нужно последнее значение, а не путь к нему.</p>"
      ));

      root.appendChild(ui.note("key", "правило",
        "<p><strong>[[compaction|Compaction]] оставляет для каждого ключа ровно одну запись — последнюю.</strong> Всё, что было раньше, вычищается независимо от возраста.</p>" +
        "<p>Работает это только там, где ключ — идентификатор сущности (<code>userId</code>, <code>sku</code>, <code>accountId</code>), а значение — её <b>полное состояние</b>, а не приращение. " +
        "«Списать 100 рублей» уплотнять нельзя — потеряешь половину списаний. «Баланс = 900» — можно.</p>"
      ));

      /* ======================= стенд ======================= */

      var stage = ui.stage({
        title: "Уплотнение по ключу",
        hint: "Дописывай версии и запускай уплотнение — следи за оффсетами"
      });

      var CITY2 = ["Киев", "Варшава", "Берлин", "Лиссабон"];
      var CITY3 = ["Прага", "Вена", "Рига"];

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
        return "{имя: «" + r.name + "»" + (r.city ? ", город: «" + r.city + "»" : "") + "}";
      }
      function mono(s, color) {
        return '<span style="font-family:var(--f-mono);font-size:.92em' +
          (color ? ";color:" + color : "") + '">' + util.escape(s) + "</span>";
      }
      function valHtml(r) {
        if (r.tomb) {
          return mono("null", "var(--bad)") +
            ' <span style="color:var(--faint);font-size:12px">надгробие</span>';
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

      var producer = ui.node("producer", "продюсер", "topic: users");
      var policyTag = el("span");
      var strip = ui.logStrip({ empty: "лог пуст" });

      var logPanel = ui.panel("Лог топика users · партиция 0",
        el("div.kv-row", { style: { "margin-bottom": "8px" } }, producer, policyTag),
        strip.el,
        el("div", { style: { "margin-top": "2px" } }, ui.legend([
          { color: keyColor("user1"), label: "u1 — user1" },
          { color: keyColor("user2"), label: "u2 — user2" },
          { color: keyColor("user3"), label: "u3 — user3" },
          { color: "var(--muted)", label: "∅ — надгробие, значение null" },
          { color: "var(--faint)", label: "выцветшая клетка — выброшена уплотнением" }
        ])));

      /* ---------------- снимок состояния ---------------- */

      var snapBox = el("div");
      var snapNote = el("div", { style: { "font-size": "12.5px", color: "var(--muted)", "margin-top": "10px" } });
      var bar = ui.bar(1);
      var barCap = el("div", { style: { "font-size": "12px", color: "var(--muted)", "margin-top": "6px" } });

      var snapPanel = ui.panel("Снимок состояния",
        el("div", {
          style: { "font-size": "12.5px", color: "var(--faint)", "margin-bottom": "6px" },
          text: "что соберёт новый сервис, прочитав топик с нуля"
        }),
        snapBox, snapNote,
        el("div", { style: { "margin-top": "12px" } }, bar.el, barCap));

      /* ---------------- показатели ---------------- */

      var stOff = ui.stat("оффсетов выдано", 0);
      var stLive = ui.stat("живых записей", 0);
      var stDrop = ui.stat("выброшено", 0);
      var stKeys = ui.stat("ключей в снимке", 0, { tone: "read" });

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
            text: "ни одного ключа — снимок пуст"
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
        barCap.innerHTML = "Чтобы собрать этот снимок, новый сервис прочитает <b>" + live + "</b> " +
          util.plural(live, "запись", "записи", "записей") + " из <b>" + recs.length + "</b> " +
          util.plural(recs.length, "выданного оффсета", "выданных оффсетов", "выданных оффсетов") + ".";

        if (policy !== "compact") {
          snapNote.innerHTML = "<b>Сейчас этот снимок держится на честном слове:</b> он верен только потому, " +
            "что в логе ещё лежит вся история. Придёт retention, срежет старые сегменты — и ключ, которого давно " +
            "не обновляли, исчезнет из снимка вместе со своей единственной записью, хотя сущность жива.";
        } else if (tombKeys.length) {
          snapNote.innerHTML = "Ключ " + mono(tombKeys[0]) + " перечёркнут: дочитав до надгробия, консьюмер " +
            "<b>удаляет</b> его из своей карты. В снимке его больше нет.";
        } else {
          snapNote.innerHTML = "Для каждого ключа показана его последняя запись в логе. Это и есть «текущее состояние».";
        }

        var u3 = latestLive("user3");
        btn3.textContent = u3 && !u3.tomb ? "user3 обновился" : "user3 появился";
      }

      function syncPolicy() {
        KV.clear(policyTag);
        policyTag.appendChild(ui.badge("cleanup.policy = " + policy, policy === "compact" ? "read" : null));
        compactBtn.disabled = busy || policy !== "compact";
        compactBtn.title = policy === "compact" ? "" : "у топика с cleanup.policy=delete уплотнения нет";
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
        var city = String(cityInput.value || "").trim().slice(0, 18) || "Ташкент";
        var prev = latestLive("user1");
        var mode = !prev ? "gone" : prev.tomb ? "tomb" : "live";
        writeRec(rec("user1", "Иван", city), function (off) {
          return "Дописана новая версия user1 → " + mono("{имя: «Иван», город: «" + city + "»}") +
            ", offset <b>" + off + "</b>. " + (
              mode === "tomb"
                ? "Ключ <b>воскрес</b>: после надгробия его можно записать заново — это обычная новая запись с тем же ключом, и она перебивает удаление."
              : mode === "gone"
                ? "От прежнего user1 в логе не осталось ничего — уплотнение вынесло всё, включая надгробие. Для читателей это просто новый ключ."
                : "Прежние версии user1 <b>всё ещё лежат</b> в логе: уплотнение — фоновая уборка, а не действие продюсера."
            );
        });
      }

      function writeUser2() {
        if (busy) return;
        var city = CITY2[c2 % CITY2.length]; c2++;
        writeRec(rec("user2", "Пётр", city), function (off) {
          return "user2 сменил город на «" + util.escape(city) + "», offset <b>" + off + "</b>. " +
            "Предыдущая версия user2 в ту же секунду стала устаревшей — для этого ключа есть свежее.";
        });
      }

      function writeUser3() {
        if (busy) return;
        var prev = latestLive("user3");
        var fresh = !prev || prev.tomb;
        var city = fresh ? "" : CITY3[c3++ % CITY3.length];
        writeRec(rec("user3", "Ольга", city), function (off) {
          return fresh
            ? "Появился новый ключ user3, offset <b>" + off + "</b>. В снимке стало на строку больше, " +
              "и это не задело ни одной чужой записи."
            : "user3 обновился («" + util.escape(city) + "»), offset <b>" + off + "</b>.";
        });
      }

      function writeTomb() {
        if (busy) return;
        var prev = latestLive("user1");
        if (prev && prev.tomb) {
          stage.say("У user1 уже стоит надгробие. Второе ничего не изменит: ключа в снимке и так нет.");
          return;
        }
        writeRec(tombRec("user1"), function (off) {
          return policy === "compact"
            ? "Надгробие для user1 на offset <b>" + off + "</b> — запись с ключом и значением " + mono("null") + ". " +
              "Это не «пустое значение», а команда уборщику: <b>вынести все записи этого ключа</b>. " +
              "Консьюмер, дочитав сюда, удаляет user1 у себя."
            : "Надгробие записано (offset <b>" + off + "</b>), но при " + mono("cleanup.policy=delete") +
              " его никто не исполнит: уборщик не смотрит на ключи. Для такого топика это обычная запись со значением " +
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
          stage.say("Уплотнять нечего: у каждого ключа ровно одна версия. Топик уже равен снимку состояния — " +
            "compacted-топик это и есть его нормальное состояние, а не разовая операция.");
          return;
        }

        if (!victims.length) {
          sweep.forEach(function (off) { recs[off].swept = true; });
          paint();
          stage.say("Устаревших версий нет. Надгробию (" + offsets(sweep) + ") засчитан первый проход: " +
            "оно обязано дожить до отставших читателей. Запусти уплотнение ещё раз — уйдёт и оно.");
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

        var msg = "<b>Уплотнение прошло.</b> Выброшено: " + victims.length + " " +
          util.plural(victims.length, "запись", "записи", "записей") + " — " + offsets(victims) + ". " +
          (alive.length === 1 ? "Остался " : "Остались ") + "<b>" + offsets(alive) + "</b>: номера " +
          "<b>не сдвинулись</b>, в логе просто появились дырки. " +
          "Следующая запись всё равно получит offset " + recs.length + ", а не " + alive.length + ".";
        if (sweep.length) {
          msg += " Надгробие (" + offsets(sweep) + ") пока оставлено — ему надо дожить до отставших читателей (" +
            mono("delete.retention.ms") + "). Ещё один проход уберёт и его.";
        }
        stage.say(msg);
      }

      /* ---------------- контролы ---------------- */

      var cityInput = el("input.kv-input", {
        type: "text", value: "Алматы", maxlength: "18",
        "aria-label": "новый город для user1",
        style: { width: "104px" }
      });
      cityInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); writeUser1(); }
      });

      var btn1 = ui.btn("Записать", writeUser1, { sm: true });
      var btn2 = ui.btn("user2 сменил город", writeUser2, { sm: true });
      var btn3 = ui.btn("user3 появился", writeUser3, { sm: true });
      var tombBtn = ui.btn("Удалить user1 (tombstone)", writeTomb, { sm: true, variant: "danger" });
      var compactBtn = ui.btn("Запустить уплотнение", runCompaction, { variant: "primary" });

      var seg = ui.seg(
        [{ value: "compact", label: "compact" }, { value: "delete", label: "delete" }],
        "compact",
        function (v) {
          if (busy) {                 // уборка уже идёт — на полпути политику не меняем
            seg.set(policy);
            stage.say("Дождись конца уплотнения — политику топика меняем на спокойном логе.");
            return;
          }
          policy = v;
          syncPolicy();
          paint();
          stage.say(v === "compact"
            ? "<b>cleanup.policy = compact.</b> Уборщик сравнивает записи по ключу и оставляет для каждого последнюю. Возраст записи не важен вообще."
            : "<b>cleanup.policy = delete.</b> Режим из прошлой главы: уборщик режет лог по возрасту и размеру, целыми сегментами, " +
              "внутрь записи не заглядывая. Он не знает ни про ключи, ни про то, что у user1 есть свежая версия — поэтому " +
              "кнопка уплотнения погасла: у такого топика этого механизма просто нет.");
        });

      var resetBtn = ui.btn("Сбросить", function () {
        reset("Лог вернулся к исходному примеру: пять записей, два ключа, три из них устарели.");
      }, { sm: true, variant: "ghost" });

      KV.append(stage.controls,
        ui.ctl("user1 переехал в", cityInput, btn1),
        btn2, btn3, tombBtn, compactBtn,
        ui.ctl("cleanup.policy", seg.el),
        resetBtn);

      /* ---------------- старт ---------------- */

      function reset(msg) {
        recs = [
          rec("user1", "Иван", ""),
          rec("user2", "Пётр", ""),
          rec("user1", "Иван", "Москва"),
          rec("user1", "Иван", "Ташкент"),
          rec("user2", "Пётр", "Киев")
        ];
        c2 = 1; c3 = 0;
        setBusy(false);
        cityInput.value = "Алматы";
        strip.setRecords(recs.map(function (r, i) { return stripRec(r, i); }));
        recs.forEach(function (r, i) { tint(i); });
        paint();
        stage.say(msg);
      }

      syncPolicy();
      reset("В логе лежит пример из материала: пять записей, два ключа. Три записи уже устарели — " +
        "для user1 свежее лежит на offset 3, для user2 на offset 4. Нажми «Запустить уплотнение».");

      root.appendChild(stage.el);

      /* ======================= разбор ======================= */

      root.appendChild(ui.prose(
        "<h3>Что произошло с логом</h3>" +
        "<p>Он стал <strong>разреженным</strong>. Уцелевшие записи сохранили свои номера — 3 и 4, а не 0 и 1. " +
        "[[offset|Оффсет]] в Kafka не индекс массива, а вечный номер: выдан один раз и никогда не пересчитывается. " +
        "[[консьюмер|Консьюмер]] с сохранённой позицией 2 просто получит следующую существующую запись — дырки его не смущают.</p>" +
        "<p>И вот ради чего всё затевалось: чтобы узнать текущее состояние всех сущностей, новому сервису больше не надо " +
        "перечитывать миллион исторических правок. Он читает compacted-топик с начала, кладёт каждую запись в карту по ключу — " +
        "и на последнем оффсете у него в памяти актуальный снимок. Ровно так работают KTable в Kafka Streams и " +
        "changelog-топики. Kafka делает это и для себя: [[__consumer_offsets]] — compacted-топик, где ключ это " +
        "«группа + топик + партиция», а значение — [[committed offset]].</p>"
      ));

      root.appendChild(ui.table(
        ["", "cleanup.policy = delete", "cleanup.policy = compact"],
        [
          ["Удаляет", "старое: по возрасту <code>retention.ms</code> или размеру <code>retention.bytes</code>",
            "устаревшее: всё, для чего у ключа есть свежая запись"],
          ["Остаётся", "всё за последние N дней", "последнее значение каждого ключа"],
          ["Топик это", "история событий", "снимок состояния, по сути key-value"],
          ["Читать с нуля", "вся история за N дней", "по одной записи на сущность"],
          ["Пример", "лог действий, аудит, клики", "профили, настройки, прайсы, <code>__consumer_offsets</code>"]
        ]));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>«Уплотнён» не значит «без дубликатов».</strong> Уборщик работает в фоне и никогда не трогает активный сегмент — " +
        "тот, куда пишут прямо сейчас. Просыпается он, когда доля «грязных» записей перевалит за <code>min.cleanable.dirty.ratio</code> " +
        "(по умолчанию 0,5). Пока этого не случилось, несколько версий одного ключа спокойно лежат рядом и приезжают консьюмеру.</p>" +
        "<p>Гарантия здесь одна: <b>последнее значение каждого ключа точно на месте</b>. А не «лишнего нет». Значит, консьюмер обязан " +
        "переживать повторы и просто применять записи по порядку — последняя победит.</p>"
      ));

      root.appendChild(ui.prose(
        "<h4>Мелочи, о которые спотыкаются</h4>" +
        "<ul>" +
        "<li>Писать в compacted-топик <b>без ключа нельзя</b>: брокер отвечает ошибкой " +
        "<code>Compacted topic cannot accept message without key</code>. Уплотнять нечего — не по чему группировать.</li>" +
        "<li>Политики совмещаются: <code>cleanup.policy=compact,delete</code> — последнее значение каждого ключа, " +
        "но не старше <code>retention.ms</code>. Снимок есть, вечного хранения нет.</li>" +
        "<li>[[tombstone|Надгробие]] после первого прохода не исчезает: оно живёт ещё <code>delete.retention.ms</code> " +
        "(сутки по умолчанию), чтобы отставший консьюмер успел увидеть удаление и вычистить ключ у себя. " +
        "Уйдёт раньше — сервис, который читал медленно, не увидит надгробия и останется с призраком удалённого ключа в памяти навсегда.</li>" +
        "</ul>"
      ));

      root.appendChild(ui.takeaway([
        "<code>cleanup.policy=compact</code> удаляет не <b>старое</b>, а <b>устаревшее</b>: для каждого [[ключ|ключа]] остаётся только последняя запись.",
        "[[offset|Оффсеты]] уцелевших записей не меняются — лог становится разреженным, и это норма: оффсет выдан навсегда.",
        "[[tombstone|Надгробие]] — запись с ключом и значением <code>null</code>: команда «забудь этот ключ» и уборщику, и консьюмеру.",
        "Compacted-топик — это key-value снимок состояния: новый сервис читает его с нуля и получает актуальную картину по всем сущностям, а не миллион исторических правок.",
        "Гарантируется только «последнее значение на месте». Уборка фоновая, хвост лога не трогает — консьюмер обязан спокойно переживать несколько версий одного ключа."
      ]));
    }
  });
})();
