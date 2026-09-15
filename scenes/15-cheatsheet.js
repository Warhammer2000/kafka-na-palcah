/* Глава 15 — Шпаргалка, ответы на собесе и глоссарий. Справочная глава. */
(function () {
  "use strict";
  var el = KV.el, ui = KV.ui, util = KV.util, L = KV.L;

  KV.scene({
    id: "cheatsheet",
    num: 15,
    /* Метаданные читаются вне build() — значит парой, а не через L(). */
    group: ["Прод", "Production"],
    nav: ["Шпаргалка", "Cheat sheet"],
    title: ["Шпаргалка, ответы на собесе и глоссарий", "Cheat sheet, interview answers and glossary"],
    lede: [
      "Механику ты уже трогал руками. Осталось уложить её в слова: чем <b>лог</b> отличается от очереди, что отвечать на «расскажи про Kafka» и что значит каждый термин из жаргона.",
      "You have already handled the mechanics yourself. What is left is putting them into words: how a <b>log</b> differs from a queue, how to answer “tell me about Kafka”, and what every bit of the jargon means."
    ],

    build: function (root, api) {

      /* ============================================================
         подводка
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<p>Эту главу открывают за час до разговора. Здесь нет анимаций — здесь формулировки, которые надо унести " +
        "с собой и уметь произнести вслух.</p>" +
        "<p>Правило ответа простое: <strong>сначала формула, потом следствие</strong>. «Порядок гарантирован только внутри партиции» — формула. " +
        "«Поэтому события одного пользователя я кладу с одним ключом» — следствие. Ответ без следствия звучит как строчка, " +
        "заученная из документации, и следующий вопрос это вскроет.</p>",

        "<p>This is the chapter you open an hour before the conversation. No animations here — just the wordings you have to " +
        "take with you and be able to say out loud.</p>" +
        "<p>The rule for an answer is simple: <strong>formula first, consequence second</strong>. “Order is guaranteed only within a partition” — that is the formula. " +
        "“So I write one user’s events under a single key” — that is the consequence. An answer without the consequence sounds like a line " +
        "memorised from the docs, and the next question will expose it.</p>"
      )));

      /* ============================================================
         ЧАСТЬ 1 — Kafka против очередей
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Kafka против очередей</h3>" +
        "<p>Вся таблица выводится из первой строки. Раз запись не удаляется при чтении — позицию обязан помнить читатель; " +
        "раз позицию помнит читатель — её можно отмотать назад; раз её можно отмотать — читателей бывает сколько угодно, " +
        "и они не мешают друг другу.</p>",

        "<h3>Kafka versus queues</h3>" +
        "<p>The whole table follows from its first row. If a record is not deleted when it is read, the reader has to remember the position; " +
        "if the reader remembers the position, it can rewind it; and if it can be rewound, there can be any number of readers, " +
        "and they do not get in each other’s way.</p>"
      )));

      root.appendChild(ui.table(
        L(["что сравниваем", "RabbitMQ, Service Bus", "Kafka"],
          ["what we compare", "RabbitMQ, Service Bus", "Kafka"]),
        [
          [L("Модель", "Model"),
            L("<b>очередь</b> — сообщение ждёт получателя",
              "<b>a queue</b> — the message waits for a receiver"),
            KV.terms(L("<b>[[лог]]</b> — записи лежат подряд, новая дописывается в конец",
              "<b>a [[log]]</b> — records sit one after another, a new one is appended at the end"))],
          [L("После чтения", "After reading"),
            L("<b>удаляется</b> — доставили и забыли",
              "<b>deleted</b> — delivered and forgotten"),
            KV.terms(L("<b>остаётся</b>, пока не истечёт [[retention]]",
              "<b>kept</b> until [[retention]] expires"))],
          [L("Кто помнит позицию", "Who remembers the position"),
            L("<b>брокер</b>: он ведёт учёт доставленного",
              "<b>the broker</b>: it keeps track of what it delivered"),
            KV.terms(L("<b>читатель</b>: свой [[offset]], [[commit|коммит]] в служебный топик",
              "<b>the reader</b>: its own [[offset]], with a [[commit]] into an internal topic"))],
          [L("Перечитать историю", "Re-read the history"),
            L("<b>нет</b> — прочитанного больше не существует",
              "<b>no</b> — what was read no longer exists"),
            L("<b>да</b> — отмотал offset назад и читаешь заново",
              "<b>yes</b> — rewind the offset and read it all again")],
          [L("Много читателей одного потока", "Many readers of one stream"),
            L("нужно <b>дублировать</b>: по копии сообщения каждому",
              "you have to <b>duplicate</b>: a copy of the message for each of them"),
            KV.terms(L("<b>из коробки</b>: у каждой [[consumer group|группы]] свой offset",
              "<b>out of the box</b>: every [[consumer group|group]] has its own offset"))],
          [L("Порядок", "Order"),
            L("одна очередь + <b>один</b> читатель, иначе рвётся",
              "one queue + <b>one</b> reader, otherwise it breaks"),
            KV.terms(L("внутри [[партиция|партиции]]: куда ляжет запись, решает [[ключ]]",
              "within a [[partition]]: where a record lands is decided by the [[key]]"))],
          [L("Потолок параллелизма", "Ceiling on parallelism"),
            L("<b>число консьюмеров</b>: добавил ещё — стало быстрее",
              "<b>the number of consumers</b>: add one more and it goes faster"),
            KV.terms(L("<b>число [[партиция|партиций]]</b>: консьюмеры сверх него простаивают",
              "<b>the number of [[partition|partitions]]</b>: consumers beyond it sit idle"))]
        ]
      ));

      /* ============================================================
         ЧАСТЬ 2 — когда что
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Когда что</h3>" +
        "<p>Признак дешёвый и надёжный: спроси, нужна ли этим данным <em>история</em> и сколько у них <em>читателей</em>. " +
        "Один исполнитель и перечитывать нечего — очередь. Много подписчиков и «а что было вчера?» — лог.</p>",

        "<h3>Which one when</h3>" +
        "<p>The test is cheap and reliable: ask whether this data needs a <em>history</em> and how many <em>readers</em> it has. " +
        "One worker and nothing to re-read — a queue. Many subscribers and “what happened yesterday?” — a log.</p>"
      )));

      var kafkaPanel = ui.panel(L("Kafka — поток событий", "Kafka — a stream of events"),
        el("div.kv-row", { style: { "margin-bottom": "10px" } },
          ui.badge(L("много читателей", "many readers"), "read"),
          ui.badge(L("нужна история", "history needed"), "good"),
          ui.badge(L("большой объём", "high volume"))),
        el("ul", { style: { margin: "0", "padding-left": "18px", "font-size": "14px", "line-height": "1.5" } },
          el("li", { html: L("геймплейные события, клики, показы, телеметрия устройств",
            "gameplay events, clicks, impressions, device telemetry") }),
          el("li", { html: L("логи и метрики — поток, который всегда больше, чем кажется",
            "logs and metrics — a stream that is always bigger than it looks") }),
          el("li", { html: L("интеграция аналитики: хранилище читает <b>тот же</b> поток, что и боевой сервис, каждый в своём темпе",
            "analytics integration: the warehouse reads <b>the same</b> stream as the production service, each at its own pace") }),
          el("li", { html: KV.terms(L("события домена, на которые подписываются несколько сервисов — своя [[consumer group|группа]] у каждого",
            "domain events several services subscribe to — each with its own [[consumer group|group]]")) })),
        el("div", { style: { "margin-top": "10px", "font-size": "13px", color: "var(--muted)" },
          html: L("<b>Вопрос-детектор:</b> «завтра появится ещё один потребитель этих данных?» Если «скорее да» — Kafka.",
            "<b>The telltale question:</b> “will another consumer of this data show up tomorrow?” If the answer is “probably” — Kafka.") }));

      var mqPanel = ui.panel(L("Rabbit / Service Bus — задача исполнителю", "Rabbit / Service Bus — a job for a worker"),
        el("div.kv-row", { style: { "margin-bottom": "10px" } },
          ui.badge(L("точечная задача", "one specific job")),
          ui.badge(L("приоритеты", "priorities")),
          ui.badge(L("DLQ на сообщение", "per-message DLQ"), "bad")),
        el("ul", { style: { margin: "0", "padding-left": "18px", "font-size": "14px", "line-height": "1.5" } },
          el("li", { html: L("«отправь письмо», «обработай платёж», «сгенерируй отчёт» — работа для одного исполнителя",
            "“send the email”, “process the payment”, “generate the report” — work for a single worker") }),
          el("li", { html: L("гибкая маршрутизация: routing key, темы, отложенная доставка",
            "flexible routing: routing keys, topics, delayed delivery") }),
          el("li", { html: L("приоритеты и повторы на уровне <b>отдельного</b> сообщения",
            "priorities and retries at the level of an <b>individual</b> message") }),
          el("li", { html: L("DLQ, куда падает конкретное неудавшееся сообщение и не держит остальные",
            "a DLQ where one failed message lands without holding up the rest") })),
        el("div", { style: { "margin-top": "10px", "font-size": "13px", color: "var(--muted)" },
          html: L("<b>Вопрос-детектор:</b> «это нужно будет перечитать?» Если нет и исполнитель один — очередь проще во всём.",
            "<b>The telltale question:</b> “will this ever need re-reading?” If not, and there is one worker — a queue is simpler in every way.") }));

      root.appendChild(el("div.kv-split", null, kafkaPanel, mqPanel));

      root.appendChild(ui.note("warn", L("ловушка", "trap"), L(
        "<p><strong>Kafka как очередь задач</strong> — самая частая ошибка при переезде. Приоритетов в ней нет вовсе, " +
        "отложенной доставки нет, а «отложить одно сообщение» невозможно в принципе: [[партиция|партиция]] читается строго по порядку, " +
        "и застрявшая запись держит всё, что за ней. DLQ приходится собирать руками — отдельный топик плюс счётчик попыток в заголовках.</p>" +
        "<p>Обратное тоже верно: очередь, из которой хотят «перечитать вчерашнее», не перечитает ничего — сообщений уже нет.</p>",

        "<p><strong>Kafka as a job queue</strong> is the most common mistake people make when migrating. It has no priorities at all, " +
        "no delayed delivery, and “postpone this one message” is impossible in principle: a [[partition]] is read strictly in order, " +
        "and a stuck record holds up everything behind it. You build the DLQ by hand — a separate topic plus a retry counter in the headers.</p>" +
        "<p>The reverse holds too: ask a queue to “re-read yesterday” and it will re-read nothing — the messages are already gone.</p>"
      )));

      /* ============================================================
         ЧАСТЬ 3 — что говорить на собесе
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Что говорить на собесе</h3>" +
        "<p>Семь вопросов, которые задают почти всегда. Сначала читай только вопрос и проговаривай ответ вслух — " +
        "и лишь потом открывай карточку. Узнать ответ и уметь его сказать — разные умения, и на собесе проверяется второе.</p>",

        "<h3>What to say in the interview</h3>" +
        "<p>Seven questions that come up almost every time. First read just the question and say your answer out loud — " +
        "and only then open the card. Recognising an answer and being able to say it are different skills, and an interview tests the second one.</p>"
      )));

      var QA = [
        {
          tag: L("суть", "the gist"),
          q: L("Что такое Kafka и чем она отличается от очереди?",
            "What is Kafka and how is it different from a queue?"),
          a: L("Kafka — не очередь, а распределённый [[лог]]: сообщения хранятся по [[retention]] и не удаляются после чтения, " +
             "читатели держат свои [[offset]]. Отсюда replay, независимые группы потребителей и устойчивость к падениям.",

             "Kafka is not a queue but a distributed [[log]]: messages are kept for as long as [[retention]] says and are not deleted after being read, " +
             "and readers hold their own [[offset]]. Hence replay, independent consumer groups and surviving crashes."),
          more: L("Спросят, где тогда живёт позиция: в самой Kafka, в служебном топике [[__consumer_offsets]] — но двигает её консьюмер, а не брокер.",
            "Then they will ask where the position lives: inside Kafka itself, in the internal [[__consumer_offsets]] topic — but it is the consumer that moves it, not the broker.")
        },
        {
          tag: L("порядок", "order"),
          q: L("Как Kafka гарантирует порядок сообщений?",
            "How does Kafka guarantee message order?"),
          a: L("Гарантирован только внутри [[партиция|партиции]]. [[ключ|Ключ]] определяет партицию, поэтому связанные события кладу с одним ключом — " +
             "порядок там, где нужен, параллелизм между ключами.",

             "Only within a [[partition]]. The [[key]] picks the partition, so I write related events under a single key — " +
             "order where it is needed, parallelism between keys."),
          more: L("Продолжение: чем плох ключ вроде кода страны — вся страна ложится в одну партицию, это [[hot key]], она горит, остальные простаивают.",
            "The follow-up: what is wrong with a key like a country code — the whole country lands in one partition, and that is a [[hot key]]: one partition on fire while the rest sit idle.")
        },
        {
          tag: L("надёжность", "durability"),
          q: L("Как настроить, чтобы не потерять сообщения?",
            "How do you set it up so you don’t lose messages?"),
          a: L("Тройка: replication factor 3, [[acks|acks=all]], [[min.insync.replicas|min.insync.replicas=2]]. " +
             "Без последнего <code>acks=all</code> обманчив — при схлопнувшемся [[ISR]] он ждёт одну реплику.",

             "All three together: replication factor 3, [[acks|acks=all]], [[min.insync.replicas|min.insync.replicas=2]]. " +
             "Without the last one <code>acks=all</code> is deceptive — with a collapsed [[ISR]] it waits for a single replica."),
          more: L("Почему не factor 2: при падении одного брокера <code>min.insync.replicas=2</code> уже не собрать, и запись встанет. Три копии — это запас, а не роскошь.",
            "Why not factor 2: lose one broker and <code>min.insync.replicas=2</code> can no longer be met, so writes stop. Three copies are headroom, not luxury.")
        },
        {
          tag: L("гарантии", "guarantees"),
          q: L("Exactly-once есть или нет?", "Is there exactly-once or not?"),
          a: L("[[at-least-once|At-least-once]] по умолчанию, поэтому обработчик идемпотентный. [[exactly-once|Exactly-once]] есть, " +
             "но работает в контуре Kafka-to-Kafka; при записи во внешнюю базу всё равно нужна [[идемпотентность]].",

             "[[at-least-once|At-least-once]] by default, so the handler is idempotent. [[exactly-once|Exactly-once]] does exist, " +
             "but it works inside the Kafka-to-Kafka loop; writing to an external database still needs [[idempotency]] on your side."),
          more: L("Где именно работает: read-process-write внутри Kafka — идемпотентный продюсер плюс транзакции. Внешнюю базу транзакция Kafka не охватывает.",
            "Where exactly it works: read-process-write inside Kafka — an idempotent producer plus transactions. A Kafka transaction does not reach an external database.")
        },
        {
          tag: L("коммиты", "commits"),
          q: L("Как ты коммитишь offset?", "How do you commit offsets?"),
          a: L("Автокоммит отключаю — он коммитит по таймеру независимо от завершения обработки и при падении тихо превращает " +
             "[[at-least-once]] в at-most-once.",

             "I turn auto-commit off — it commits on a timer regardless of whether processing finished, and on a crash it quietly turns " +
             "[[at-least-once]] into at-most-once."),
          more: L("Уточнение, которое ценят: [[committed offset]] — номер <b>следующего</b> сообщения для чтения, а не последнего обработанного. Коммит идёт после обработки, не до.",
            "The detail they appreciate: a [[committed offset]] is the number of the <b>next</b> message to read, not of the last one processed. The commit goes after processing, not before.")
        },
        {
          tag: L("диагностика", "diagnosis"),
          q: L("Потребление отстаёт. Что смотришь?",
            "Consumption is falling behind. What do you look at?"),
          a: L("Смотрю [[lag]] по партициям, а не суммарный. Растёт одна — перекос ключа. Растут все — не хватает потребителей, " +
             "но потолок задан числом [[партиция|партиций]], так что может понадобиться редизайн топика.",

             "I look at [[lag]] per partition, not the total. One partition growing — key skew. All of them growing — not enough consumers, " +
             "but the ceiling is set by the number of [[partition|partitions]], so the topic may need a redesign."),
          more: L("Ловушка в ответе «добавим консьюмеров»: сверх числа партиций они просто встанут без работы. Сначала смотришь партиции, потом штат.",
            "The trap in answering “we will add consumers”: past the number of partitions they will just stand there with no work. Partitions first, headcount second.")
        },
        {
          tag: L("ребалансы", "rebalances"),
          q: L("Группа постоянно ребалансится. Что делаешь?",
            "The group keeps rebalancing. What do you do?"),
          a: L("Шторм обычно от того, что обработка не укладывается в [[max.poll.interval.ms]], и живого консьюмера считают мёртвым. " +
             "[[ребаланс|Ребаланс]] останавливает потребление во всей группе. Лечу уменьшением <code>max.poll.records</code>, " +
             "static membership и cooperative-sticky.",

             "The storm usually comes from processing not fitting into [[max.poll.interval.ms]], so a live consumer is counted as dead. " +
             "A [[rebalance]] stops consumption across the whole group. I cure it with a smaller <code>max.poll.records</code>, " +
             "static membership and cooperative-sticky."),
          more: L("Почему именно cooperative-sticky: при нём группа не встаёт целиком — переезжают только затронутые партиции, остальные продолжают читать.",
            "Why cooperative-sticky in particular: with it the group does not stop as a whole — only the affected partitions move, the rest keep reading.")
        }
      ];

      var stage = ui.stage({
        title: L("Семь вопросов", "Seven questions"),
        hint: L("Нажми на карточку, чтобы открыть ответ", "Click a card to open the answer")
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
            html: L("<b>Если копнут:</b> ", "<b>If they dig deeper:</b> ") + KV.terms(item.more)
          }));

        var toggleBtn = ui.btn(L("Показать ответ", "Show the answer"), null, { sm: true, variant: "ghost" });
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
          toggleBtn.textContent = open ? L("Скрыть ответ", "Hide the answer") : L("Показать ответ", "Show the answer");
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
          L("Раскрыто <b>", "<b>") + n + L("</b> из ", "</b> of ") + cards.length +
          L(" карточек", " cards open") +
          (n === 0 && !msg
            ? L(" — так и надо: сначала вопрос, ответ вслух, и только потом проверка.",
                " — and that is how it should start: the question first, the answer out loud, and the check only after that.")
            : "."));
      }

      function openAll(v) {
        cancelPending();
        if (api.reduced || !v) {
          cards.forEach(function (c) { c.setOpen(v); });
          report(v
            ? L("Все ответы на виду — режим чтения.", "Every answer is in view — reading mode.")
            : L("Свёрнуто. Режим самопроверки.", "Collapsed. Self-test mode."));
          return;
        }
        cards.forEach(function (c, i) { later(i * 45, function () { c.setOpen(true); }); });
        later(cards.length * 45 + 20, function () {
          report(L("Все ответы на виду — режим чтения.", "Every answer is in view — reading mode."));
        });
      }

      /* подсветка случайной карточки: держим её таймер, чтобы второе нажатие
         не гасило подсветку раньше срока и не оставляло рамку на прошлой карточке */
      var hlTimer = 0, hlCard = null, lastPick = -1;
      function clearHighlight() {
        if (hlTimer) { api.stop(hlTimer); hlTimer = 0; }
        if (hlCard) { hlCard.style.boxShadow = ""; hlCard = null; }
      }

      KV.append(stage.controls,
        ui.btn(L("Раскрыть все", "Open all"), function () { openAll(true); }, { sm: true, variant: "read" }),
        ui.btn(L("Свернуть все", "Collapse all"), function () { openAll(false); }, { sm: true, variant: "ghost" }),
        ui.btn(L("Случайный вопрос", "Random question"), function () {
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
          report(L("Вопрос ", "Question ") + (i + 1) +
            L(": проговори ответ вслух, потом открой карточку.",
              ": say the answer out loud, then open the card."));
        }, { sm: true }));

      stage.body.appendChild(cardsWrap);
      root.appendChild(stage.el);

      /* первая карточка открыта: сразу видно, как устроен ответ */
      cards[0].setOpen(true);
      report(L("Первая карточка открыта для примера.", "The first card is open as an example."));

      root.appendChild(ui.note("bad", L("чего не говорить", "what not to say"), L(
        "<p><b>«Kafka быстрая, потому что пишет последовательно на диск».</b> Верно, но это ответ не на тот вопрос: " +
        "спрашивают про модель данных, а не про производительность диска.</p>" +
        "<p><b>«У нас включён exactly-once».</b> Дальше спросят, куда пишет обработчик. Если во внешнюю базу — " +
        "[[идемпотентность]] всё равно на твоей стороне.</p>" +
        "<p><b>«Отстаём — добавим консьюмеров».</b> Без взгляда на число [[партиция|партиций]] это обещание, которое нечем выполнить.</p>",

        "<p><b>“Kafka is fast because it writes to disk sequentially”.</b> True, but it answers the wrong question: " +
        "they are asking about the data model, not about disk throughput.</p>" +
        "<p><b>“We have exactly-once turned on”.</b> The next question will be where the handler writes. If it is an external database, " +
        "[[idempotency]] is still on you.</p>" +
        "<p><b>“We are behind — we will add consumers”.</b> Without a look at the number of [[partition|partitions]] that is a promise with nothing behind it.</p>"
      )));

      /* ============================================================
         ЧАСТЬ 4 — глоссарий (строится из KV.glossary)
         ============================================================ */

      root.appendChild(ui.prose(L(
        "<h3>Глоссарий</h3>" +
        "<p>Это те же определения, что всплывают под пунктирными словами в остальных главах — список собран прямо из них, " +
        "поэтому разойтись они не могут. Поиск ищет и в термине, и в определении: набери «poll», «репл» или «offset».</p>",

        "<h3>Glossary</h3>" +
        "<p>These are the same definitions that pop up under the dotted words in the other chapters — the list is built straight from them, " +
        "so they cannot drift apart. The search looks in the term and in the definition alike: type “poll”, “repl” or “offset”.</p>"
      )));

      var gstage = ui.stage({
        title: L("Глоссарий", "Glossary"),
        hint: L("Фильтр по части слова", "Filter by part of a word")
      });

      var terms = Object.keys(KV.glossary).sort(function (a, b) {
        return a.localeCompare(b, "ru");
      });

      var haystack = terms.map(function (t) {
        return (t + " " + KV.glossary[t]).toLowerCase();
      });

      var gtable = ui.table(
        L(["термин", "что это"], ["term", "what it is"]),
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
        text: L("Ничего не нашлось. Попробуй часть слова: «off», «репл», «poll».",
          "Nothing found. Try a part of a word: “off”, “repl”, “poll”.")
      });

      var search = el("input.kv-input", {
        type: "text",
        value: "",
        placeholder: L("offset, реплика…", "offset, replica…"),
        "aria-label": L("поиск по глоссарию", "glossary search"),
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
          ? L("Показаны все <b>", "All <b>") + terms.length + "</b> " +
            util.plural(terms.length, L("термин", "term"), L("термина", "terms"), L("терминов", "terms")) +
            L(" курса — тот самый список, из которого берутся подсказки под пунктирными словами в главах.",
              " in the course are shown — the very list that every hint under a dotted word in the chapters comes from.")
          : L("Совпадений: <b>", "Matches: <b>") + shown + L("</b> из ", "</b> of ") + terms.length + ".");
      }

      search.addEventListener("input", applyFilter);

      KV.append(gstage.controls,
        ui.ctl(L("поиск", "search"), search),
        ui.btn(L("Сбросить", "Reset"), function () { search.value = ""; applyFilter(); }, { sm: true, variant: "ghost" }));

      gstage.body.appendChild(gtable);
      gstage.body.appendChild(emptyMsg);
      applyFilter();
      root.appendChild(gstage.el);

      /* ============================================================
         вынос всего курса
         ============================================================ */

      root.appendChild(ui.takeaway(L(
        [
          "Kafka — <b>[[лог]], а не очередь</b>: чтение ничего не удаляет, позицию помнит читатель. Отсюда replay, независимые группы и спокойные падения.",
          "[[ключ|Ключ]] → [[партиция]] → порядок. Партиция же — единица параллелизма и жёсткий потолок числа полезных консьюмеров в группе.",
          "Надёжность — это <b>тройка целиком</b>: replication factor 3 + [[acks|acks=all]] + [[min.insync.replicas|min.insync.replicas=2]]. Две настройки из трёх дают ложное спокойствие.",
          "[[at-least-once|At-least-once]] по умолчанию: обработчик обязан быть [[идемпотентность|идемпотентным]], а [[commit|коммит]] идёт <b>после</b> обработки, не по таймеру.",
          "Здоровье системы читается по [[lag]] <b>по партициям</b>, а живучесть группы — по тому, укладывается ли обработка в [[max.poll.interval.ms]]."
        ],
        [
          "Kafka is a <b>[[log]], not a queue</b>: reading deletes nothing, and the reader remembers the position. Hence replay, independent groups and crashes you can stay calm about.",
          "[[key|Key]] → [[partition]] → order. And the partition is also the unit of parallelism and a hard ceiling on how many consumers in a group can do any work.",
          "Durability is <b>all three together</b>: replication factor 3 + [[acks|acks=all]] + [[min.insync.replicas|min.insync.replicas=2]]. Two of the three give you a false sense of calm.",
          "[[at-least-once|At-least-once]] by default: the handler must be [[idempotency|idempotent]], and the [[commit]] goes <b>after</b> processing, not on a timer.",
          "The health of the system is read from [[lag]] <b>per partition</b>, and the survival of the group from whether processing fits into [[max.poll.interval.ms]]."
        ]
      )));
    }
  });
})();
