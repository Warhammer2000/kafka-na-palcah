/* Стенд 04 — «acks=all обманчив без min.insync.replicas».
   Форма модуля скопирована с эталона stands/01-log.js.

   Главная мысль стенда: acks=all обещает дождаться не «всех реплик», а всех,
   кто СЕЙЧАС в ISR. ISR схлопнулся до одного лидера — и «все» означает одного.
   Продюсер получает ok, копия ровно одна, лидер умирает — данных нет, и никто
   об этом не узнал. Спасает min.insync.replicas: явный отказ вместо тихой потери.

   Приёмы PDF, на которых всё держится:
   - ленты брокеров — стопки logCell (пустая / окрашенная запись);
   - вердикт — стопка из четырёх заранее окрашенных состояний, переключается
     через display, потому что перекрасить поле на лету PDFium не даст;
   - активные значения acks и min.insync показываются текстовыми полями,
     а не подсветкой кнопки — по той же причине. */

module.exports = {
  id: "s4",
  eyebrow: ["стенд 04", "demo 04"],
  title: ["acks=all обманчив без min.insync.replicas",
    "acks=all is deceptive without min.insync.replicas"],
  subtitle: ["Продюсер ждёт подтверждения «всех реплик» — но всех из ISR, а список ISR умеет схлопываться до одного лидера. Сколько копий у записи, за которую уже сказали «ok»?",
    "The producer waits for “all replicas” to acknowledge — but only those in ISR right now, and that list can collapse down to the leader alone. How many copies does a record have once the producer has been told “ok”?"],

  build(ctx, L, page) {
    const { C, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;

    const N = 6;            // записей в ленте
    const LEFT = 56;
    const WIDE = PAGE.w - 112;   // 730 — рабочая ширина
    const X0 = 152;         // начало лент: слева живут подписи брокеров
    const RX = 500;         // правая колонка с переключателями

    L.tag(page, fonts, L.T("топик orders, партиция 0, replication.factor = 3",
      "topic orders, partition 0, replication.factor = 3"), LEFT, 402, C.ink2);

    /* ---- три ленты по шесть клеток: лидер и две реплики ---- */
    const LEADER = L.T("лидер", "leader");
    const REPLICA = L.T("реплика", "replica");
    const IN_ISR = L.T("в ISR", "in ISR");
    const ROWS = [
      { base: "s4_a", y: 362, name: L.T("брокер 1", "broker 1"), role: LEADER, st: "s4_st1", stText: L.T("лидер, жив", "leader, alive"), color: C.write },
      { base: "s4_b", y: 320, name: L.T("брокер 2", "broker 2"), role: REPLICA, st: "s4_st2", stText: IN_ISR, color: C.muted },
      { base: "s4_c", y: 278, name: L.T("брокер 3", "broker 3"), role: REPLICA, st: "s4_st3", stText: IN_ISR, color: C.muted },
    ];

    ROWS.forEach((r) => {
      L.tag(page, fonts, r.name, LEFT, r.y + 18, C.ink2);
      L.tag(page, fonts, r.role, LEFT, r.y + 6, r.color);
      for (let i = 0; i < N; i++) {
        L.logCell(ctx, page, r.base + i, X0 + i * STEP, r.y, i, "#" + (i + 1));
      }
      L.readout(ctx, page, r.st, { x: X0 + N * STEP + 8, y: r.y + 7, w: 110, h: 16 }, {
        text: r.stText, size: 8.5, mono: true, fill: null, border: null, borderWidth: 0,
      });
    });

    /* ---- переключатель acks ---- */
    L.tag(page, fonts, L.T("acks — чего ждёт продюсер",
      "acks — what the producer waits for"), RX, 396, C.write);
    ["0", "1", "all"].forEach((a, i) => {
      L.action(ctx, page, "s4_btn_a" + i, a, { x: RX + i * 58, y: 364, w: 52, h: 26 },
        "s4_pickAcks(" + i + ");");
    });
    L.readout(ctx, page, "s4_acksv", { x: RX + 180, y: 364, w: 106, h: 26 }, {
      text: "all", size: 13, mono: true, align: "center",
    });

    /* ---- переключатель min.insync.replicas ---- */
    L.tag(page, fonts, L.T("min.insync.replicas — минимум реплик в ISR",
      "min.insync.replicas — minimum replicas in ISR"), RX, 336, C.read);
    [1, 2, 3].forEach((v, i) => {
      L.action(ctx, page, "s4_btn_m" + v, String(v), { x: RX + i * 58, y: 304, w: 52, h: 26 },
        "s4_pickMin(" + v + ");");
    });
    L.readout(ctx, page, "s4_minv", { x: RX + 180, y: 304, w: 106, h: 26 }, {
      text: "1", size: 13, mono: true, align: "center",
    });

    /* ---- сам ISR ---- */
    L.tag(page, fonts, L.T("ISR — реплики, которые успевают за лидером",
      "ISR — replicas keeping up with the leader"), RX, 276, C.ink2);
    L.readout(ctx, page, "s4_isrv", { x: RX, y: 244, w: 286, h: 26 }, {
      text: "ISR = [1, 2, 3]", size: 13, mono: true, align: "center",
    });

    /* ---- вердикт: стопка заранее окрашенных состояний ---- */
    L.stack(ctx, page, "s4_vd", [
      { fill: C.surface2, border: C.line, caption: L.T("вердикт появится, когда убьёшь лидера", "the verdict shows up once you kill the leader"), captionColor: C.muted, size: 12 },
      { fill: C.good, border: C.good, caption: L.T("СОХРАНЕНО — у каждой записи есть копия на живом брокере", "SURVIVED — every record has a copy on a live broker"), captionColor: C.white, size: 13 },
      { fill: C.bad, border: C.bad, caption: L.T("ТИХАЯ ПОТЕРЯ — продюсер считает запись сохранённой, данных нет", "SILENT LOSS — the producer counts the record as saved, the data is gone"), captionColor: C.white, size: 13 },
      { fill: C.warn, border: C.warn, caption: L.T("ЗАПИСЬ ОТКЛОНЕНА — NotEnoughReplicasException, данные целы", "WRITE REJECTED — NotEnoughReplicasException, the data is intact"), captionColor: C.white, size: 13 },
    ], { x: LEFT, y: 204, w: WIDE, h: 32, initial: 0 });

    /* ---- кнопки ---- */
    const BY = 170;
    /* Названия кнопок повторяются в пояснениях внизу («нажми Сброс»), поэтому
       живут переменными: надпись на кнопке и её упоминание разойтись не должны. */
    const B_CATCH = L.T("Реплики догнали", "Replicas catch up");
    const B_PRESET = L.T("Надёжная тройка", "Safe trio");
    const B_RESET = L.T("Сброс", "Reset");
    /* Кавычки у названия кнопки тоже свои на каждом языке: «ёлочки» против “лапок”. */
    const Q = (s) => L.T("«" + s + "»", "“" + s + "”");
    L.action(ctx, page, "s4_btn_write", L.T("Записать", "Write"), { x: LEFT, y: BY, w: 96, h: 30 },
      "s4_write();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s4_btn_kill", L.T("Убить лидера", "Kill the leader"), { x: LEFT + 104, y: BY, w: 112, h: 30 },
      "s4_kill();", { fill: C.bad, border: C.bad, textColor: C.white });
    L.action(ctx, page, "s4_btn_lag", L.T("Реплики отстали", "Replicas fall behind"), { x: LEFT + 224, y: BY, w: 132, h: 30 },
      "s4_lag();");
    L.action(ctx, page, "s4_btn_catch", B_CATCH, { x: LEFT + 364, y: BY, w: 132, h: 30 },
      "s4_catch();");
    L.action(ctx, page, "s4_btn_preset", B_PRESET, { x: LEFT + 504, y: BY, w: 136, h: 30 },
      "s4_preset();", { fill: C.good, border: C.good, textColor: C.white });
    L.action(ctx, page, "s4_btn_reset", B_RESET, { x: LEFT + 648, y: BY, w: 66, h: 30 },
      "s4_reset();");

    /* multiline: строки собираются из чисел на лету, и однострочное поле
       обрезало бы длинную фразу на правом краю — молча, посреди слова. */
    L.readout(ctx, page, "s4_say", { x: LEFT, y: 120, w: WIDE, h: 34 }, {
      text: L.T("Демонстрация идёт сама — нажми любую кнопку, чтобы взять управление",
        "The demo runs itself — press any button to take over"),
      size: 10, multiline: true,
    });

    L.wrapText(page, L.T("acks=all не обещает трёх копий — он обещает дождаться тех, кто сейчас в ISR. Схлопнулся ISR до одного лидера — и «все» означает одного, а продюсер всё равно получает ok. Явный отказ лучше тихой потери: replication.factor = 3, acks = all, min.insync.replicas = 2.",
      "acks=all does not promise three copies — it promises to wait for whoever is in ISR right now. Let ISR collapse to the leader alone and “all” means one, yet the producer still gets its ok. An explicit refusal beats a silent loss: replication.factor = 3, acks = all, min.insync.replicas = 2."), {
      x: LEFT, y: 102, width: WIDE, size: 9, font: fonts.sans, color: C.faint, leading: 12,
    });

    /* ---- документный скрипт стенда (СТАРЫЙ JavaScript: var/function) ---- */
    return `
var s4_N = ${N};
var s4_ACKS = ["0", "1", "all"];
var s4_a = 2;          /* индекс acks: 0 -> "0", 1 -> "1", 2 -> "all" */
var s4_m = 1;          /* min.insync.replicas */
var s4_isrN = 3;       /* размер ISR: 3 (полный) или 1 (только лидер) */
var s4_n = 0;          /* сколько записей принял лидер */
var s4_alive = 1;
var s4_rep = [];       /* доехала ли запись до реплик */
var s4_manual = false;
var s4_step = 0;
for (var s4_k = 0; s4_k < s4_N; s4_k++) s4_rep[s4_k] = 0;

function s4_setVd(k) { show("s4_vd", k, 4); }

function s4_render() {
  txt("s4_acksv", s4_ACKS[s4_a]);
  txt("s4_minv", s4_m);
  if (s4_alive) {
    txt("s4_st1", "${L.T("лидер, жив", "leader, alive")}");
    if (s4_isrN === 3) {
      txt("s4_isrv", "ISR = [1, 2, 3]");
      txt("s4_st2", "${IN_ISR}");
      txt("s4_st3", "${IN_ISR}");
    } else {
      txt("s4_isrv", "ISR = [1]");
      txt("s4_st2", "${L.T("выпала из ISR", "fell out of ISR")}");
      txt("s4_st3", "${L.T("выпала из ISR", "fell out of ISR")}");
    }
  } else {
    /* Мёртвого лидера контроллер выкидывает из ISR — но только пока в ISR есть
       кто-то ещё. ПОСЛЕДНЮЮ реплику из ISR не удаляют никогда: вместо пустого
       списка партиция получает «лидера нет» (leader = -1). Поэтому у
       схлопнутого ISR так и остаётся ISR = [1] с мёртвым брокером внутри — и
       именно из этого положения выводит unclean.leader.election. */
    if (s4_isrN === 3) {
      txt("s4_st1", "${L.T("МЁРТВ", "DEAD")}");
      txt("s4_isrv", "ISR = [2, 3]");
      txt("s4_st2", "${L.T("новый лидер", "new leader")}");
      txt("s4_st3", "${IN_ISR}");
    } else {
      txt("s4_st1", "${L.T("МЁРТВ, но в ISR", "DEAD, still in ISR")}");
      txt("s4_isrv", "${L.T("ISR = [1] — лидера нет", "ISR = [1] — no leader")}");
      txt("s4_st2", "${L.T("вне ISR", "out of ISR")}");
      txt("s4_st3", "${L.T("вне ISR", "out of ISR")}");
    }
  }
}

/* ---- ядро: функции без флага s4_manual, ими пользуется и автодемонстрация ---- */

function s4_doAcks(i) {
  s4_a = i;
  if (s4_alive) s4_setVd(0);
  s4_render();
}

function s4_doMin(v) {
  s4_m = v;
  if (s4_alive) s4_setVd(0);
  s4_render();
}

function s4_doWrite() {
  if (!s4_alive) {
    txt("s4_say", "${L.T("Брокер 1 мёртв — писать некуда. Нажми " + Q(B_RESET) + ", чтобы поднять кластер заново.",
      "Broker 1 is dead — nowhere to write. Press " + Q(B_RESET) + " to bring the cluster back up.")}");
    return;
  }
  if (s4_n >= s4_N) {
    txt("s4_say", "${L.T("Лента кончилась: шесть записей — весь размер стенда. Нажми " + Q(B_RESET) + ".",
      "The log is full: six records is the whole demo. Press " + Q(B_RESET) + ".")}");
    return;
  }
  if (s4_a === 2 && s4_isrN < s4_m) {
    s4_setVd(3);
    txt("s4_say", "${L.T("acks=all ждёт всех ИЗ ISR, а там один лидер: ",
      "acks=all waits for everyone IN ISR, and the leader is alone there: ")}" + s4_isrN + " < min.insync = " + s4_m + "${L.T(". Брокер отказал: NotEnoughReplicasException. Ничего не записано.",
      ". The broker refused: NotEnoughReplicasException. Nothing was written.")}");
    return;
  }
  var i = s4_n;
  show("s4_a" + i, 1, 2);
  s4_n++;
  s4_setVd(0);
  if (s4_a === 0) {
    txt("s4_say", "${L.T("acks=0: продюсер отправил запись #", "acks=0: the producer sent record #")}" + (i + 1) + "${L.T(" и не стал ждать ответа. Он уже считает её сохранённой — что бы дальше ни случилось.",
      " and never waited for an answer. It already counts the record as saved — whatever happens next.")}");
  } else if (s4_a === 1) {
    txt("s4_say", "${L.T("acks=1: лидер записал #", "acks=1: the leader wrote #")}" + (i + 1) + "${L.T(" к себе и сразу ответил «ok». Реплики о ней пока не знают — копия доедет к ним на следующем такте.",
      " to itself and answered “ok” right away. The replicas know nothing about it yet — the copy reaches them on the next tick.")}");
  } else if (s4_isrN === 3) {
    /* acks=all отвечает «ok» ТОЛЬКО когда копии уже лежат у всех из ISR.
       Поэтому реплики зажигаются в тот же миг: отложить их на такт значило бы
       показать принятую запись, которой продюсеру ещё не подтверждали. */
    s4_rep[i] = 1;
    show("s4_b" + i, 1, 2);
    show("s4_c" + i, 1, 2);
    txt("s4_say", "${L.T("acks=all: лидер записал #", "acks=all: the leader wrote #")}" + (i + 1) + "${L.T(" и ответил «ok» только после того, как обе реплики из ISR подтвердили её. Копий сразу три.",
      " and answered “ok” only after both replicas in ISR had confirmed it. Three copies at once.")}");
  } else {
    txt("s4_say", "${L.T("acks=all: лидер записал #", "acks=all: the leader wrote #")}" + (i + 1) + "${L.T(", а ждать не от кого — в ISR он один. «ok» ушёл сразу, копия ровно одна.",
      ", and there is nobody to wait for — it is alone in ISR. The “ok” went out at once, and there is exactly one copy.")}");
  }
}

function s4_doKill() {
  if (!s4_alive) {
    txt("s4_say", "${L.T("Брокер 1 уже мёртв. " + Q(B_RESET) + " поднимет кластер заново.",
      "Broker 1 is already dead. " + Q(B_RESET) + " brings the cluster back up.")}");
    return;
  }
  s4_alive = 0;
  var i;
  for (i = 0; i < s4_N; i++) show("s4_a" + i, 0, 2);
  var lost = 0;
  for (i = 0; i < s4_n; i++) { if (!s4_rep[i]) lost++; }
  s4_render();
  if (s4_n === 0) {
    s4_setVd(0);
    txt("s4_say", "${L.T("Брокер 1 умер, но записей ещё не было — терять нечего. Сначала запиши хоть что-нибудь.",
      "Broker 1 died, but there were no records yet — nothing to lose. Write something first.")}");
  } else if (lost === 0 && s4_isrN === 3) {
    s4_setVd(1);
    txt("s4_say", "${L.T("Лидер умер, но каждая запись успела уехать в реплики. Брокер 2 был в ISR — он и становится лидером, данные целы.",
      "The leader died, but every record had already reached the replicas. Broker 2 was in ISR — it becomes the leader, and the data is intact.")}");
  } else if (lost === 0) {
    /* Копии есть, но обе реплики вне ISR: чистых выборов из них не сделать. */
    s4_setVd(1);
    txt("s4_say", "${L.T("Лидер умер. Копии есть на брокерах 2 и 3, но оба вне ISR: без unclean-выборов партиция остаётся без лидера — данные целы, но недоступны. Пустым ISR при этом не становится: в нём так и висит мёртвый брокер 1.",
      "The leader died. Copies sit on brokers 2 and 3, but both are out of ISR: without an unclean election the partition stays leaderless — the data is intact, just unreachable. ISR does not go empty either: the dead broker 1 still hangs in it.")}");
  } else {
    s4_setVd(2);
    txt("s4_say", "${L.T("Лидер умер. Записей, живших только на нём: ", "The leader died. Records that lived on it alone: ")}" + lost + "${L.T(". Продюсер уже считает их записанными и ошибки не увидит — это тихая потеря.",
      ". The producer already counts them as written and will never see an error — this is the silent loss.")}");
  }
}

function s4_doLag() {
  if (!s4_alive) {
    txt("s4_say", "${L.T("Брокер 1 мёртв — списку ISR уже нечего описывать. Нажми " + Q(B_RESET) + ".",
      "Broker 1 is dead — there is nothing left for ISR to describe. Press " + Q(B_RESET) + ".")}");
    return;
  }
  if (s4_isrN === 1) {
    txt("s4_say", "${L.T("Реплики и так вне ISR: ISR = [1]. Верни их кнопкой " + Q(B_CATCH) + ".",
      "The replicas are already out of ISR: ISR = [1]. Bring them back with " + Q(B_CATCH) + ".")}");
    return;
  }
  s4_isrN = 1;
  s4_setVd(0);
  s4_render();
  txt("s4_say", "${L.T("Брокеры 2 и 3 отстали и выпали из ISR. Старое у них осталось, новое не приезжает. В синхроне один лидер.",
    "Brokers 2 and 3 fell behind and dropped out of ISR. What they already had stays; nothing new arrives. Only the leader is in sync now.")}");
}

function s4_doCatch() {
  if (!s4_alive) {
    txt("s4_say", "${L.T("Догонять некого: брокер 1 мёртв. Нажми " + Q(B_RESET) + ".",
      "Nobody to catch up with: broker 1 is dead. Press " + Q(B_RESET) + ".")}");
    return;
  }
  if (s4_isrN === 3) {
    txt("s4_say", "${L.T("Реплики и так в ISR: ISR = [1, 2, 3].",
      "The replicas are already in ISR: ISR = [1, 2, 3].")}");
    return;
  }
  s4_isrN = 3;
  var i;
  for (i = 0; i < s4_n; i++) {
    s4_rep[i] = 1;
    show("s4_b" + i, 1, 2);
    show("s4_c" + i, 1, 2);
  }
  s4_setVd(0);
  s4_render();
  txt("s4_say", "${L.T("Реплики догнали лидера и вернулись в ISR. Всё, что лежало только у него, скопировано — копий снова три.",
    "The replicas caught up with the leader and are back in ISR. Everything that sat on it alone is copied — three copies again.")}");
}

function s4_doPreset() {
  s4_a = 2;
  s4_m = 2;
  if (s4_alive) s4_setVd(0);
  s4_render();
  txt("s4_say", "${L.T("Надёжная тройка: replication.factor = 3, acks = all, min.insync.replicas = 2. Схлопнутый ISR даст ошибку, а не тихое «ok».",
    "The safe trio: replication.factor = 3, acks = all, min.insync.replicas = 2. A collapsed ISR now gives an error instead of a quiet “ok”.")}");
}

function s4_doReset() {
  var i;
  for (i = 0; i < s4_N; i++) {
    show("s4_a" + i, 0, 2);
    show("s4_b" + i, 0, 2);
    show("s4_c" + i, 0, 2);
    s4_rep[i] = 0;
  }
  s4_n = 0;
  s4_alive = 1;
  s4_isrN = 3;
  s4_a = 2;
  s4_m = 1;
  s4_setVd(0);
  s4_render();
  txt("s4_say", "${L.T("Кластер собран заново: ISR = [1, 2, 3], acks = all, min.insync = 1. Схлопни ISR, запиши и убей лидера.",
    "The cluster is rebuilt: ISR = [1, 2, 3], acks = all, min.insync = 1. Collapse ISR, write, then kill the leader.")}");
}

/* ---- обработчики кнопок: забирают управление у автодемонстрации ---- */

function s4_pickAcks(i) {
  s4_manual = true;
  s4_doAcks(i);
  if (i === 0) {
    txt("s4_say", "${L.T("acks=0: отправил и забыл. Продюсер не ждёт ни лидера, ни реплик — о потере он не узнает никогда.",
      "acks=0: fire and forget. The producer waits for neither the leader nor the replicas — it will never learn about a loss.")}");
  } else if (i === 1) {
    txt("s4_say", "${L.T("acks=1: ждём подтверждения лидера. Умер до того, как реплики скачали запись, — она исчезла.",
      "acks=1: we wait for the leader’s acknowledgement. It dies before the replicas pull the record — and the record is gone.")}");
  } else {
    txt("s4_say", "${L.T("acks=all: ждём подтверждения всех, кто СЕЙЧАС в ISR. Сколько их — зависит от того, кто успевает.",
      "acks=all: we wait for everyone who is in ISR RIGHT NOW. How many that is depends on who keeps up.")}");
  }
}

function s4_pickMin(v) {
  s4_manual = true;
  s4_doMin(v);
  var m = "";
  if (v === 1) {
    m = "${L.T("min.insync=1: хватает одного лидера в ISR. Это умолчание, и оно делает acks=all обманчивым.",
      "min.insync=1: one leader in ISR is enough. That is the default, and that is what makes acks=all deceptive.")}";
  } else if (v === 2) {
    m = "${L.T("min.insync=2: при факторе 3 одну реплику потерять можно, две — уже нет, запись встанет с ошибкой.",
      "min.insync=2: with factor 3 you may lose one replica, but not two — the write then stops with an error.")}";
  } else {
    m = "${L.T("min.insync=3: требовать весь ISR. Надёжно, но хрупко — упал любой брокер, и запись встала.",
      "min.insync=3: demand the whole ISR. Safe but brittle — any broker goes down and the write stops.")}";
  }
  if (s4_a !== 2) m = m + "${L.T(" (при acks=", " (not checked at acks=")}" + s4_ACKS[s4_a] + "${L.T(" не проверяется)", ")")}";
  txt("s4_say", m);
}

function s4_write() { s4_manual = true; s4_doWrite(); }
function s4_kill() { s4_manual = true; s4_doKill(); }
function s4_lag() { s4_manual = true; s4_doLag(); }
function s4_catch() { s4_manual = true; s4_doCatch(); }
function s4_preset() { s4_manual = true; s4_doPreset(); }
function s4_reset() { s4_manual = true; s4_doReset(); }

/* ---- репликация: догоняет лидера через такт, работает всегда ---- */

function s4_pump() {
  if (!s4_alive) return;
  if (s4_isrN < 3) return;
  /* Догоняем ВСЁ, что ещё не уехало, а не одну запись: две кнопки «Записать»
     внутри одного такта иначе оставили бы первую копию несуществующей навсегда
     и стенд соврал бы про потерю там, где ничего не терялось. */
  var i, n = 0, last = -1;
  for (i = 0; i < s4_n; i++) {
    if (!s4_rep[i]) {
      s4_rep[i] = 1;
      show("s4_b" + i, 1, 2);
      show("s4_c" + i, 1, 2);
      n++; last = i;
    }
  }
  if (n === 1) {
    txt("s4_say", "${L.T("Брокеры 2 и 3 скачали запись #", "Brokers 2 and 3 pulled record #")}" + (last + 1) + "${L.T(": копий стало три. Окно, в котором она жила в одном экземпляре, закрылось.",
      ": three copies now. The window where it lived in a single copy has closed.")}");
  } else if (n > 1) {
    txt("s4_say", "${L.T("Брокеры 2 и 3 догнали лидера: копии доехали до записи #",
      "Brokers 2 and 3 caught up with the leader: the copies reached record #")}" + (last + 1) + "${L.T(" включительно — снова по три копии у каждой.",
      " inclusive — every record has three copies again.")}");
  }
}

/* ---- автодемонстрация: acks=all, ISR схлопнулся, лидер умер, данных нет ---- */

function s4_auto() {
  if (s4_manual) return;
  s4_step++;
  if (s4_step === 1) {
    s4_doAcks(2);
    s4_doMin(1);
    txt("s4_say", "${L.T("Ставим acks=all при min.insync.replicas=1 — так и есть по умолчанию. Выглядит надёжно: ждём всех.",
      "We set acks=all with min.insync.replicas=1 — exactly what the defaults give you. Looks safe: we wait for everyone.")}");
  } else if (s4_step === 3) {
    s4_doWrite();
  } else if (s4_step === 6) {
    s4_doWrite();
  } else if (s4_step === 9) {
    s4_doLag();
  } else if (s4_step === 11) {
    s4_doWrite();
  } else if (s4_step === 13) {
    txt("s4_say", "${L.T("Запись #3 принята, продюсер получил «ok». Но копия у неё одна: реплик в ISR нет, а acks=all соблюдён.",
      "Record #3 is accepted and the producer got its “ok”. But it has exactly one copy: no replicas in ISR, and acks=all is satisfied.")}");
  } else if (s4_step === 15) {
    s4_doKill();
  } else if (s4_step === 17) {
    s4_manual = true;
    /* Порядок кнопок именно такой: s4_doReset() возвращает min.insync в 1,
       то есть сброс ПОСЛЕ пресета стёр бы как раз то, ради чего его жали, и
       повтор дал бы ту же тихую потерю вместо обещанной ошибки. */
    txt("s4_say", "${L.T("Вот она, тихая потеря. Нажми " + Q(B_RESET) + ", потом " + Q(B_PRESET) + " — и повтори: будет явная ошибка.",
      "There it is, the silent loss. Press " + Q(B_RESET) + ", then " + Q(B_PRESET) + ", and run it again: this time you get an explicit error.")}");
  }
}

function s4_tick() { s4_pump(); s4_auto(); }

s4_render();
TICKERS.push(s4_tick);
`;
  },
};
