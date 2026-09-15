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
  eyebrow: "стенд 04",
  title: "acks=all обманчив без min.insync.replicas",
  subtitle: "Продюсер ждёт подтверждения «всех реплик» — но всех из ISR, а список ISR умеет схлопываться до одного лидера. Сколько копий у записи, за которую уже сказали «ok»?",

  build(ctx, L, page) {
    const { C, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;

    const N = 6;            // записей в ленте
    const LEFT = 56;
    const WIDE = PAGE.w - 112;   // 730 — рабочая ширина
    const X0 = 152;         // начало лент: слева живут подписи брокеров
    const RX = 500;         // правая колонка с переключателями

    L.tag(page, fonts, "топик orders, партиция 0, replication.factor = 3", LEFT, 402, C.ink2);

    /* ---- три ленты по шесть клеток: лидер и две реплики ---- */
    const ROWS = [
      { base: "s4_a", y: 362, name: "брокер 1", role: "лидер", st: "s4_st1", stText: "лидер, жив", color: C.write },
      { base: "s4_b", y: 320, name: "брокер 2", role: "реплика", st: "s4_st2", stText: "в ISR", color: C.muted },
      { base: "s4_c", y: 278, name: "брокер 3", role: "реплика", st: "s4_st3", stText: "в ISR", color: C.muted },
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
    L.tag(page, fonts, "acks — чего ждёт продюсер", RX, 396, C.write);
    ["0", "1", "all"].forEach((a, i) => {
      L.action(ctx, page, "s4_btn_a" + i, a, { x: RX + i * 58, y: 364, w: 52, h: 26 },
        "s4_pickAcks(" + i + ");");
    });
    L.readout(ctx, page, "s4_acksv", { x: RX + 180, y: 364, w: 106, h: 26 }, {
      text: "all", size: 13, mono: true, align: "center",
    });

    /* ---- переключатель min.insync.replicas ---- */
    L.tag(page, fonts, "min.insync.replicas — минимум реплик в ISR", RX, 336, C.read);
    [1, 2, 3].forEach((v, i) => {
      L.action(ctx, page, "s4_btn_m" + v, String(v), { x: RX + i * 58, y: 304, w: 52, h: 26 },
        "s4_pickMin(" + v + ");");
    });
    L.readout(ctx, page, "s4_minv", { x: RX + 180, y: 304, w: 106, h: 26 }, {
      text: "1", size: 13, mono: true, align: "center",
    });

    /* ---- сам ISR ---- */
    L.tag(page, fonts, "ISR — реплики, которые успевают за лидером", RX, 276, C.ink2);
    L.readout(ctx, page, "s4_isrv", { x: RX, y: 244, w: 286, h: 26 }, {
      text: "ISR = [1, 2, 3]", size: 13, mono: true, align: "center",
    });

    /* ---- вердикт: стопка заранее окрашенных состояний ---- */
    L.stack(ctx, page, "s4_vd", [
      { fill: C.surface2, border: C.line, caption: "вердикт появится, когда убьёшь лидера", captionColor: C.muted, size: 12 },
      { fill: C.good, border: C.good, caption: "СОХРАНЕНО — у каждой записи есть копия на живом брокере", captionColor: C.white, size: 13 },
      { fill: C.bad, border: C.bad, caption: "ТИХАЯ ПОТЕРЯ — продюсер считает запись сохранённой, данных нет", captionColor: C.white, size: 13 },
      { fill: C.warn, border: C.warn, caption: "ЗАПИСЬ ОТКЛОНЕНА — NotEnoughReplicasException, данные целы", captionColor: C.white, size: 13 },
    ], { x: LEFT, y: 204, w: WIDE, h: 32, initial: 0 });

    /* ---- кнопки ---- */
    const BY = 170;
    L.action(ctx, page, "s4_btn_write", "Записать", { x: LEFT, y: BY, w: 96, h: 30 },
      "s4_write();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s4_btn_kill", "Убить лидера", { x: LEFT + 104, y: BY, w: 112, h: 30 },
      "s4_kill();", { fill: C.bad, border: C.bad, textColor: C.white });
    L.action(ctx, page, "s4_btn_lag", "Реплики отстали", { x: LEFT + 224, y: BY, w: 132, h: 30 },
      "s4_lag();");
    L.action(ctx, page, "s4_btn_catch", "Реплики догнали", { x: LEFT + 364, y: BY, w: 132, h: 30 },
      "s4_catch();");
    L.action(ctx, page, "s4_btn_preset", "Надёжная тройка", { x: LEFT + 504, y: BY, w: 136, h: 30 },
      "s4_preset();", { fill: C.good, border: C.good, textColor: C.white });
    L.action(ctx, page, "s4_btn_reset", "Сброс", { x: LEFT + 648, y: BY, w: 66, h: 30 },
      "s4_reset();");

    L.readout(ctx, page, "s4_say", { x: LEFT, y: 120, w: WIDE, h: 34 }, {
      text: "Демонстрация идёт сама — нажми любую кнопку, чтобы взять управление",
      size: 10,
    });

    L.wrapText(page, "acks=all не обещает трёх копий — он обещает дождаться тех, кто сейчас в ISR. Схлопнулся ISR до одного лидера — и «все» означает одного, а продюсер всё равно получает ok. Явный отказ лучше тихой потери: replication.factor = 3, acks = all, min.insync.replicas = 2.", {
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
    txt("s4_st1", "лидер, жив");
    if (s4_isrN === 3) {
      txt("s4_isrv", "ISR = [1, 2, 3]");
      txt("s4_st2", "в ISR");
      txt("s4_st3", "в ISR");
    } else {
      txt("s4_isrv", "ISR = [1]");
      txt("s4_st2", "выпала из ISR");
      txt("s4_st3", "выпала из ISR");
    }
  } else {
    /* Мёртвого лидера контроллер выкидывает из ISR. Если в ISR больше никого
       не осталось, взять партицию некому: без unclean-выборов она без лидера. */
    txt("s4_st1", "МЁРТВ");
    if (s4_isrN === 3) {
      txt("s4_isrv", "ISR = [2, 3]");
      txt("s4_st2", "новый лидер");
      txt("s4_st3", "в ISR");
    } else {
      txt("s4_isrv", "ISR = [] — лидера нет");
      txt("s4_st2", "вне ISR");
      txt("s4_st3", "вне ISR");
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
    txt("s4_say", "Брокер 1 мёртв — писать некуда. Нажми «Сброс», чтобы поднять кластер заново.");
    return;
  }
  if (s4_n >= s4_N) {
    txt("s4_say", "Лента кончилась: шесть записей — весь размер стенда. Нажми «Сброс».");
    return;
  }
  if (s4_a === 2 && s4_isrN < s4_m) {
    s4_setVd(3);
    txt("s4_say", "acks=all ждёт всех ИЗ ISR, а там один лидер: " + s4_isrN + " < min.insync = " + s4_m + ". Брокер отказал: NotEnoughReplicasException. Ничего не записано.");
    return;
  }
  var i = s4_n;
  show("s4_a" + i, 1, 2);
  s4_n++;
  s4_setVd(0);
  if (s4_a === 0) {
    txt("s4_say", "acks=0: продюсер отправил запись #" + (i + 1) + " и не стал ждать ответа. Он уже считает её сохранённой — что бы дальше ни случилось.");
  } else if (s4_a === 1) {
    txt("s4_say", "acks=1: лидер записал #" + (i + 1) + " к себе и сразу ответил «ok». Реплики о ней пока не знают — копия доедет к ним на следующем такте.");
  } else if (s4_isrN === 3) {
    /* acks=all отвечает «ok» ТОЛЬКО когда копии уже лежат у всех из ISR.
       Поэтому реплики зажигаются в тот же миг: отложить их на такт значило бы
       показать принятую запись, которой продюсеру ещё не подтверждали. */
    s4_rep[i] = 1;
    show("s4_b" + i, 1, 2);
    show("s4_c" + i, 1, 2);
    txt("s4_say", "acks=all: лидер записал #" + (i + 1) + " и ответил «ok» только после того, как обе реплики из ISR подтвердили её. Копий сразу три.");
  } else {
    txt("s4_say", "acks=all: лидер записал #" + (i + 1) + ", а ждать не от кого — в ISR он один. «ok» ушёл сразу, копия ровно одна.");
  }
}

function s4_doKill() {
  if (!s4_alive) {
    txt("s4_say", "Брокер 1 уже мёртв. «Сброс» поднимет кластер заново.");
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
    txt("s4_say", "Брокер 1 умер, но записей ещё не было — терять нечего. Сначала запиши хоть что-нибудь.");
  } else if (lost === 0 && s4_isrN === 3) {
    s4_setVd(1);
    txt("s4_say", "Лидер умер, но каждая запись успела уехать в реплики. Брокер 2 был в ISR — он и становится лидером, данные целы.");
  } else if (lost === 0) {
    /* Копии есть, но обе реплики вне ISR: чистых выборов из них не сделать. */
    s4_setVd(1);
    txt("s4_say", "Лидер умер. Копии есть на брокерах 2 и 3, но оба вне ISR: без unclean-выборов партиция остаётся без лидера — данные целы, но недоступны.");
  } else {
    s4_setVd(2);
    txt("s4_say", "Лидер умер. Записей, живших только на нём: " + lost + ". Продюсер уже считает их записанными и ошибки не увидит — это тихая потеря.");
  }
}

function s4_doLag() {
  if (!s4_alive) {
    txt("s4_say", "Брокер 1 мёртв — списку ISR уже нечего описывать. Нажми «Сброс».");
    return;
  }
  if (s4_isrN === 1) {
    txt("s4_say", "Реплики и так вне ISR: ISR = [1]. Верни их кнопкой «Реплики догнали».");
    return;
  }
  s4_isrN = 1;
  s4_setVd(0);
  s4_render();
  txt("s4_say", "Брокеры 2 и 3 отстали и выпали из ISR. Старое у них осталось, новое не приезжает. В синхроне один лидер.");
}

function s4_doCatch() {
  if (!s4_alive) {
    txt("s4_say", "Догонять некого: брокер 1 мёртв. Нажми «Сброс».");
    return;
  }
  if (s4_isrN === 3) {
    txt("s4_say", "Реплики и так в ISR: ISR = [1, 2, 3].");
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
  txt("s4_say", "Реплики догнали лидера и вернулись в ISR. Всё, что лежало только у него, скопировано — копий снова три.");
}

function s4_doPreset() {
  s4_a = 2;
  s4_m = 2;
  if (s4_alive) s4_setVd(0);
  s4_render();
  txt("s4_say", "Надёжная тройка: replication.factor = 3, acks = all, min.insync.replicas = 2. Схлопнутый ISR даст ошибку, а не тихое «ok».");
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
  txt("s4_say", "Кластер собран заново: ISR = [1, 2, 3], acks = all, min.insync = 1. Схлопни ISR, запиши и убей лидера.");
}

/* ---- обработчики кнопок: забирают управление у автодемонстрации ---- */

function s4_pickAcks(i) {
  s4_manual = true;
  s4_doAcks(i);
  if (i === 0) {
    txt("s4_say", "acks=0: отправил и забыл. Продюсер не ждёт ни лидера, ни реплик — о потере он не узнает никогда.");
  } else if (i === 1) {
    txt("s4_say", "acks=1: ждём подтверждения лидера. Умер до того, как реплики скачали запись, — она исчезла.");
  } else {
    txt("s4_say", "acks=all: ждём подтверждения всех, кто СЕЙЧАС в ISR. Сколько их — зависит от того, кто успевает.");
  }
}

function s4_pickMin(v) {
  s4_manual = true;
  s4_doMin(v);
  var m = "";
  if (v === 1) {
    m = "min.insync=1: хватает одного лидера в ISR. Это умолчание, и оно делает acks=all обманчивым.";
  } else if (v === 2) {
    m = "min.insync=2: при факторе 3 одну реплику потерять можно, две — уже нет, запись встанет с ошибкой.";
  } else {
    m = "min.insync=3: требовать весь ISR. Надёжно, но хрупко — упал любой брокер, и запись встала.";
  }
  if (s4_a !== 2) m = m + " (при acks=" + s4_ACKS[s4_a] + " не проверяется)";
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
    txt("s4_say", "Брокеры 2 и 3 скачали запись #" + (last + 1) + ": копий стало три. Окно, в котором она жила в одном экземпляре, закрылось.");
  } else if (n > 1) {
    txt("s4_say", "Брокеры 2 и 3 догнали лидера: копии доехали до записи #" + (last + 1) + " включительно — снова по три копии у каждой.");
  }
}

/* ---- автодемонстрация: acks=all, ISR схлопнулся, лидер умер, данных нет ---- */

function s4_auto() {
  if (s4_manual) return;
  s4_step++;
  if (s4_step === 1) {
    s4_doAcks(2);
    s4_doMin(1);
    txt("s4_say", "Ставим acks=all при min.insync.replicas=1 — так и есть по умолчанию. Выглядит надёжно: ждём всех.");
  } else if (s4_step === 3) {
    s4_doWrite();
  } else if (s4_step === 6) {
    s4_doWrite();
  } else if (s4_step === 9) {
    s4_doLag();
  } else if (s4_step === 11) {
    s4_doWrite();
  } else if (s4_step === 13) {
    txt("s4_say", "Запись #3 принята, продюсер получил «ok». Но копия у неё одна: реплик в ISR нет, а acks=all соблюдён.");
  } else if (s4_step === 15) {
    s4_doKill();
  } else if (s4_step === 17) {
    s4_manual = true;
    txt("s4_say", "Вот она, тихая потеря. Нажми «Надёжная тройка», потом «Сброс» — и повтори: будет явная ошибка.");
  }
}

function s4_tick() { s4_pump(); s4_auto(); }

s4_render();
TICKERS.push(s4_tick);
`;
  },
};
