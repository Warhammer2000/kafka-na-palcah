/* Глава 15 — Шпаргалка, ответы на собесе и глоссарий. Справочная глава. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util;

  KV.scene({
    id: "cheatsheet",
    num: 15,
    group: "Прод",
    nav: "Шпаргалка",
    title: "Шпаргалка, ответы на собесе и глоссарий",
    lede: "Механику ты уже трогал руками. Осталось уложить её в слова: чем <b>лог</b> отличается от очереди, что отвечать на «расскажи про Kafka» и что значит каждый термин из жаргона.",

    build: function (root, api) {

      /* ============================================================
         подводка
         ============================================================ */

      root.appendChild(ui.prose(
        "<p>Эту главу открывают за час до разговора. Здесь нет анимаций — здесь формулировки, которые надо унести " +
        "с собой и уметь произнести вслух.</p>" +
        "<p>Правило ответа простое: <strong>сначала формула, потом следствие</strong>. «Порядок гарантирован только внутри партиции» — формула. " +
        "«Поэтому события одного пользователя я кладу с одним ключом» — следствие. Ответ без следствия звучит как строчка, " +
        "заученная из документации, и следующий вопрос это вскроет.</p>"
      ));

      /* ============================================================
         ЧАСТЬ 1 — Kafka против очередей
         ============================================================ */

      root.appendChild(ui.prose(
        "<h3>Kafka против очередей</h3>" +
        "<p>Вся таблица выводится из первой строки. Раз запись не удаляется при чтении — позицию обязан помнить читатель; " +
        "раз позицию помнит читатель — её можно отмотать назад; раз её можно отмотать — читателей бывает сколько угодно, " +
        "и они не мешают друг другу.</p>"
      ));

      root.appendChild(ui.table(
        ["что сравниваем", "RabbitMQ, Service Bus", "Kafka"],
        [
          ["Модель",
            "<b>очередь</b> — сообщение ждёт получателя",
            KV.terms("<b>[[лог]]</b> — записи лежат подряд, новая дописывается в конец")],
          ["После чтения",
            "<b>удаляется</b> — доставили и забыли",
            KV.terms("<b>остаётся</b>, пока не истечёт [[retention]]")],
          ["Кто помнит позицию",
            "<b>брокер</b>: он ведёт учёт доставленного",
            KV.terms("<b>читатель</b>: свой [[offset]], [[commit|коммит]] в служебный топик")],
          ["Перечитать историю",
            "<b>нет</b> — прочитанного больше не существует",
            "<b>да</b> — отмотал offset назад и читаешь заново"],
          ["Много читателей одного потока",
            "нужно <b>дублировать</b>: по копии сообщения каждому",
            KV.terms("<b>из коробки</b>: у каждой [[consumer group|группы]] свой offset")],
          ["Порядок",
            "одна очередь + <b>один</b> читатель, иначе рвётся",
            KV.terms("внутри [[партиция|партиции]]: куда ляжет запись, решает [[ключ]]")],
          ["Потолок параллелизма",
            "<b>число консьюмеров</b>: добавил ещё — стало быстрее",
            KV.terms("<b>число [[партиция|партиций]]</b>: консьюмеры сверх него простаивают")]
        ]
      ));

      /* ============================================================
         ЧАСТЬ 2 — когда что
         ============================================================ */

      root.appendChild(ui.prose(
        "<h3>Когда что</h3>" +
        "<p>Признак дешёвый и надёжный: спроси, нужна ли этим данным <em>история</em> и сколько у них <em>читателей</em>. " +
        "Один исполнитель и перечитывать нечего — очередь. Много подписчиков и «а что было вчера?» — лог.</p>"
      ));

      var kafkaPanel = ui.panel("Kafka — поток событий",
        el("div.kv-row", { style: { "margin-bottom": "10px" } },
          ui.badge("много читателей", "read"),
          ui.badge("нужна история", "good"),
          ui.badge("большой объём")),
        el("ul", { style: { margin: "0", "padding-left": "18px", "font-size": "14px", "line-height": "1.5" } },
          el("li", { html: "геймплейные события, клики, показы, телеметрия устройств" }),
          el("li", { html: "логи и метрики — поток, который всегда больше, чем кажется" }),
          el("li", { html: "интеграция аналитики: хранилище читает <b>тот же</b> поток, что и боевой сервис, каждый в своём темпе" }),
          el("li", { html: KV.terms("события домена, на которые подписываются несколько сервисов — своя [[consumer group|группа]] у каждого") })),
        el("div", { style: { "margin-top": "10px", "font-size": "13px", color: "var(--muted)" },
          html: "<b>Вопрос-детектор:</b> «завтра появится ещё один потребитель этих данных?» Если «скорее да» — Kafka." }));

      var mqPanel = ui.panel("Rabbit / Service Bus — задача исполнителю",
        el("div.kv-row", { style: { "margin-bottom": "10px" } },
          ui.badge("точечная задача"),
          ui.badge("приоритеты"),
          ui.badge("DLQ на сообщение", "bad")),
        el("ul", { style: { margin: "0", "padding-left": "18px", "font-size": "14px", "line-height": "1.5" } },
          el("li", { html: "«отправь письмо», «обработай платёж», «сгенерируй отчёт» — работа для одного исполнителя" }),
          el("li", { html: "гибкая маршрутизация: routing key, темы, отложенная доставка" }),
          el("li", { html: "приоритеты и повторы на уровне <b>отдельного</b> сообщения" }),
          el("li", { html: "DLQ, куда падает конкретное неудавшееся сообщение и не держит остальные" })),
        el("div", { style: { "margin-top": "10px", "font-size": "13px", color: "var(--muted)" },
          html: "<b>Вопрос-детектор:</b> «это нужно будет перечитать?» Если нет и исполнитель один — очередь проще во всём." }));

      root.appendChild(el("div.kv-split", null, kafkaPanel, mqPanel));

      root.appendChild(ui.note("warn", "ловушка",
        "<p><strong>Kafka как очередь задач</strong> — самая частая ошибка при переезде. Приоритетов в ней нет вовсе, " +
        "отложенной доставки нет, а «отложить одно сообщение» невозможно в принципе: [[партиция|партиция]] читается строго по порядку, " +
        "и застрявшая запись держит всё, что за ней. DLQ приходится собирать руками — отдельный топик плюс счётчик попыток в заголовках.</p>" +
        "<p>Обратное тоже верно: очередь, из которой хотят «перечитать вчерашнее», не перечитает ничего — сообщений уже нет.</p>"
      ));

      /* ============================================================
         ЧАСТЬ 3 — что говорить на собесе
         ============================================================ */

      root.appendChild(ui.prose(
        "<h3>Что говорить на собесе</h3>" +
        "<p>Семь вопросов, которые задают почти всегда. Сначала читай только вопрос и проговаривай ответ вслух — " +
        "и лишь потом открывай карточку. Узнать ответ и уметь его сказать — разные умения, и на собесе проверяется второе.</p>"
      ));

      var QA = [
        {
          tag: "суть",
          q: "Что такое Kafka и чем она отличается от очереди?",
          a: "Kafka — не очередь, а распределённый [[лог]]: сообщения хранятся по [[retention]] и не удаляются после чтения, " +
             "читатели держат свои [[offset]]. Отсюда replay, независимые группы потребителей и устойчивость к падениям.",
          more: "Спросят, где тогда живёт позиция: в самой Kafka, в служебном топике [[__consumer_offsets]] — но двигает её консьюмер, а не брокер."
        },
        {
          tag: "порядок",
          q: "Как Kafka гарантирует порядок сообщений?",
          a: "Гарантирован только внутри [[партиция|партиции]]. [[ключ|Ключ]] определяет партицию, поэтому связанные события кладу с одним ключом — " +
             "порядок там, где нужен, параллелизм между ключами.",
          more: "Продолжение: чем плох ключ вроде кода страны — вся страна ложится в одну партицию, это [[hot key]], она горит, остальные простаивают."
        },
        {
          tag: "надёжность",
          q: "Как настроить, чтобы не потерять сообщения?",
          a: "Тройка: replication factor 3, [[acks|acks=all]], [[min.insync.replicas|min.insync.replicas=2]]. " +
             "Без последнего <code>acks=all</code> обманчив — при схлопнувшемся [[ISR]] он ждёт одну реплику.",
          more: "Почему не factor 2: при падении одного брокера <code>min.insync.replicas=2</code> уже не собрать, и запись встанет. Три копии — это запас, а не роскошь."
        },
        {
          tag: "гарантии",
          q: "Exactly-once есть или нет?",
          a: "[[at-least-once|At-least-once]] по умолчанию, поэтому обработчик идемпотентный. [[exactly-once|Exactly-once]] есть, " +
             "но работает в контуре Kafka-to-Kafka; при записи во внешнюю базу всё равно нужна [[идемпотентность]].",
          more: "Где именно работает: read-process-write внутри Kafka — идемпотентный продюсер плюс транзакции. Внешнюю базу транзакция Kafka не охватывает."
        },
        {
          tag: "коммиты",
          q: "Как ты коммитишь offset?",
          a: "Автокоммит отключаю — он коммитит по таймеру независимо от завершения обработки и при падении тихо превращает " +
             "[[at-least-once]] в at-most-once.",
          more: "Уточнение, которое ценят: [[committed offset]] — номер <b>следующего</b> сообщения для чтения, а не последнего обработанного. Коммит идёт после обработки, не до."
        },
        {
          tag: "диагностика",
          q: "Потребление отстаёт. Что смотришь?",
          a: "Смотрю [[lag]] по партициям, а не суммарный. Растёт одна — перекос ключа. Растут все — не хватает потребителей, " +
             "но потолок задан числом [[партиция|партиций]], так что может понадобиться редизайн топика.",
          more: "Ловушка в ответе «добавим консьюмеров»: сверх числа партиций они просто встанут без работы. Сначала смотришь партиции, потом штат."
        },
        {
          tag: "ребалансы",
          q: "Группа постоянно ребалансится. Что делаешь?",
          a: "Шторм обычно от того, что обработка не укладывается в [[max.poll.interval.ms]], и живого консьюмера считают мёртвым. " +
             "[[ребаланс|Ребаланс]] останавливает потребление во всей группе. Лечу уменьшением <code>max.poll.records</code>, " +
             "static membership и cooperative-sticky.",
          more: "Почему именно cooperative-sticky: при нём группа не встаёт целиком — переезжают только затронутые партиции, остальные продолжают читать."
        }
      ];

      var stage = ui.stage({
        title: "Семь вопросов",
        hint: "Нажми на карточку, чтобы открыть ответ"
      });

      var cardsWrap = el("div.kv-col");
      var cards = [];

      /* очередь ступенчатого показа: любое новое действие отменяет недоигранное,
         иначе «Свернуть все» посреди раскрытия тут же перебивается хвостом таймеров */
      var pending = [];
      function later(ms, fn) { pending.push(api.timeout(ms, fn)); }
      function cancelPending() {
        pending.forEach(function (id) { api.stop(id); });
        pending.length = 0;
      }

      QA.forEach(function (item, i) {
        var open = false;

        var answer = el("div.kv-hidden", { style: { "margin-top": "10px" } },
          el("div", {
            style: {
              "border-left": "2px solid var(--read)",
              "padding-left": "11px",
              "font-size": "15px",
              "line-height": "1.55",
              color: "var(--ink-2)"
            },
            html: KV.terms(item.a)
          }),
          el("div", {
            style: { "margin-top": "9px", "font-size": "13px", color: "var(--muted)" },
            html: "<b>Если копнут:</b> " + KV.terms(item.more)
          }));

        var toggleBtn = ui.btn("Показать ответ", null, { sm: true, variant: "ghost" });
        toggleBtn.setAttribute("aria-expanded", "false");

        var card = ui.panel(
          (i + 1 < 10 ? "0" : "") + (i + 1) + " · " + item.tag,
          el("div", { html: "<b>" + item.q + "</b>", style: { "font-size": "15.5px", "line-height": "1.45" } }),
          answer,
          el("div.kv-row", { style: { "margin-top": "10px" } }, toggleBtn));
        card.style.cursor = "pointer";

        function setOpen(v) {
          open = !!v;
          answer.classList.toggle("kv-hidden", !open);
          toggleBtn.textContent = open ? "Скрыть ответ" : "Показать ответ";
          toggleBtn.setAttribute("aria-expanded", String(open));
        }

        card.addEventListener("click", function (e) {
          /* клик по пунктирному термину — это вызов подсказки, а не переключатель карточки */
          if (e.target && e.target.closest && e.target.closest(".kv-term")) return;
          /* выделил текст ответа, чтобы скопировать — не захлопываем его под курсором */
          var sel = window.getSelection && window.getSelection();
          if (sel && !sel.isCollapsed && sel.anchorNode && card.contains(sel.anchorNode)) return;
          cancelPending();
          setOpen(!open);
          report();
        });

        cards.push({ el: card, setOpen: setOpen, isOpen: function () { return open; } });
        cardsWrap.appendChild(card);
      });

      function openCount() {
        return cards.filter(function (c) { return c.isOpen(); }).length;
      }

      function report(msg) {
        var n = openCount();
        stage.say((msg ? msg + " &nbsp;·&nbsp; " : "") +
          "Раскрыто <b>" + n + "</b> из " + cards.length + " карточек" +
          (n === 0 && !msg ? " — так и надо: сначала вопрос, ответ вслух, и только потом проверка." : "."));
      }

      function openAll(v) {
        cancelPending();
        if (api.reduced || !v) {
          cards.forEach(function (c) { c.setOpen(v); });
          report(v ? "Все ответы на виду — режим чтения." : "Свёрнуто. Режим самопроверки.");
          return;
        }
        cards.forEach(function (c, i) { later(i * 45, function () { c.setOpen(true); }); });
        later(cards.length * 45 + 20, function () { report("Все ответы на виду — режим чтения."); });
      }

      /* подсветка случайной карточки: держим её таймер, чтобы второе нажатие
         не гасило подсветку раньше срока и не оставляло рамку на прошлой карточке */
      var hlTimer = 0, hlCard = null, lastPick = -1;
      function clearHighlight() {
        if (hlTimer) { api.stop(hlTimer); hlTimer = 0; }
        if (hlCard) { hlCard.style.boxShadow = ""; hlCard = null; }
      }

      KV.append(stage.controls,
        ui.btn("Раскрыть все", function () { openAll(true); }, { sm: true, variant: "read" }),
        ui.btn("Свернуть все", function () { openAll(false); }, { sm: true, variant: "ghost" }),
        ui.btn("Случайный вопрос", function () {
          cancelPending();
          clearHighlight();
          cards.forEach(function (c) { c.setOpen(false); });
          var i = Math.floor(Math.random() * cards.length);
          if (cards.length > 1 && i === lastPick) i = (i + 1) % cards.length;
          lastPick = i;
          var c = cards[i];
          c.el.scrollIntoView({ block: "center", behavior: api.reduced ? "auto" : "smooth" });
          c.el.style.boxShadow = "0 0 0 2px var(--read)";
          hlCard = c.el;
          hlTimer = api.timeout(1600, clearHighlight);
          report("Вопрос " + (i + 1) + ": проговори ответ вслух, потом открой карточку.");
        }, { sm: true }));

      stage.body.appendChild(cardsWrap);
      root.appendChild(stage.el);

      /* первая карточка открыта: сразу видно, как устроен ответ */
      cards[0].setOpen(true);
      report("Первая карточка открыта для примера.");

      root.appendChild(ui.note("bad", "чего не говорить",
        "<p><b>«Kafka быстрая, потому что пишет последовательно на диск».</b> Верно, но это ответ не на тот вопрос: " +
        "спрашивают про модель данных, а не про производительность диска.</p>" +
        "<p><b>«У нас включён exactly-once».</b> Дальше спросят, куда пишет обработчик. Если во внешнюю базу — " +
        "[[идемпотентность]] всё равно на твоей стороне.</p>" +
        "<p><b>«Отстаём — добавим консьюмеров».</b> Без взгляда на число [[партиция|партиций]] это обещание, которое нечем выполнить.</p>"
      ));

      /* ============================================================
         ЧАСТЬ 4 — глоссарий (строится из KV.glossary)
         ============================================================ */

      root.appendChild(ui.prose(
        "<h3>Глоссарий</h3>" +
        "<p>Это те же определения, что всплывают под пунктирными словами в остальных главах — список собран прямо из них, " +
        "поэтому разойтись они не могут. Поиск ищет и в термине, и в определении: набери «poll», «репл» или «offset».</p>"
      ));

      var gstage = ui.stage({
        title: "Глоссарий",
        hint: "Фильтр по части слова"
      });

      var terms = Object.keys(KV.glossary).sort(function (a, b) {
        return a.localeCompare(b, "ru");
      });

      var haystack = terms.map(function (t) {
        return (t + " " + KV.glossary[t]).toLowerCase();
      });

      var gtable = ui.table(
        ["термин", "что это"],
        terms.map(function (t) {
          return [
            "<code>" + util.escape(t) + "</code>",
            util.escape(KV.glossary[t])
          ];
        })
      );

      var rows = gtable.querySelectorAll("tbody tr");

      var emptyMsg = el("div.kv-hidden", {
        style: {
          "margin-top": "12px",
          "font-family": "var(--f-mono)",
          "font-size": "12px",
          color: "var(--faint)"
        },
        text: "Ничего не нашлось. Попробуй часть слова: «off», «репл», «poll»."
      });

      var search = el("input.kv-input", {
        type: "text",
        value: "",
        placeholder: "offset, реплика…",
        "aria-label": "поиск по глоссарию",
        maxlength: "24"
      });

      function applyFilter() {
        var q = search.value.trim().toLowerCase();
        var shown = 0;
        for (var i = 0; i < rows.length; i++) {
          var hit = !q || haystack[i].indexOf(q) >= 0;
          rows[i].classList.toggle("kv-hidden", !hit);
          if (hit) shown++;
        }
        emptyMsg.classList.toggle("kv-hidden", shown > 0);
        gstage.say(shown === terms.length
          ? "Показаны все <b>" + terms.length + "</b> " + util.plural(terms.length, "термин", "термина", "терминов") +
            " — ровно те, что подсвечены пунктиром в остальных главах."
          : "Совпадений: <b>" + shown + "</b> из " + terms.length + ".");
      }

      search.addEventListener("input", applyFilter);

      KV.append(gstage.controls,
        ui.ctl("поиск", search),
        ui.btn("Сбросить", function () { search.value = ""; applyFilter(); }, { sm: true, variant: "ghost" }));

      gstage.body.appendChild(gtable);
      gstage.body.appendChild(emptyMsg);
      applyFilter();
      root.appendChild(gstage.el);

      /* ============================================================
         вынос всего курса
         ============================================================ */

      root.appendChild(ui.takeaway([
        "Kafka — <b>[[лог]], а не очередь</b>: чтение ничего не удаляет, позицию помнит читатель. Отсюда replay, независимые группы и спокойные падения.",
        "[[ключ|Ключ]] → [[партиция]] → порядок. Партиция же — единица параллелизма и жёсткий потолок числа полезных консьюмеров в группе.",
        "Надёжность — это <b>тройка целиком</b>: replication factor 3 + [[acks|acks=all]] + [[min.insync.replicas|min.insync.replicas=2]]. Две настройки из трёх дают ложное спокойствие.",
        "[[at-least-once|At-least-once]] по умолчанию: обработчик обязан быть [[идемпотентность|идемпотентным]], а [[commit|коммит]] идёт <b>после</b> обработки, не по таймеру.",
        "Здоровье системы читается по [[lag]] <b>по партициям</b>, а живучесть группы — по тому, укладывается ли обработка в [[max.poll.interval.ms]]."
      ]));
    }
  });
})();
