/* Стенд 03 — «Lag: насколько устарели твои данные».
   Собран по форме эталонного stands/01-log.js. */

module.exports = {
  id: "s3",
  /* Заголовки читаются РАНЬШЕ, чем разобраны аргументы командной строки,
     поэтому здесь не T(), а пара ["ru","en"]: её разбирает сам lib в момент
     отрисовки, когда язык уже известен. */
  eyebrow: ["стенд 03", "demo 03"],
  title: ["Lag: насколько устарели твои данные", "Lag: how stale your data is"],
  subtitle: [
    "Сколько сообщений консьюмер ещё не прочитал прямо сейчас? Lag — это разница между концом лога и сохранённой позицией группы, и именно он отвечает на вопрос «насколько свежи мои данные».",
    "Right now, how many messages has the consumer not read yet? Lag is the gap between the end of the log and the group’s committed position, and it is what answers “how fresh is my data”.",
  ],

  /* 18 клеток одной партиции. Цвет клетки запекается заранее: менять его
     на лету PDF не даёт, поэтому каждая клетка — стопка из двух состояний. */
  N: 18,

  build(ctx, L, page) {
    const { C, KEYS, PAGE, CELL, STEP } = L;
    const { fonts } = ctx;
    const N = this.N;

    const X0 = 104;   // слева остаётся место под подписи «партиция» и «offset»
    const Y = 330;

    /* Метка конца лога (LEO) — над лентой, белая, цвет несёт подпись.
       ЧИСЛА НА САМОЙ МЕТКЕ НЕТ, и это принципиально: подпись кнопки-виджета
       запекается при сборке и на лету не меняется, а лента здесь — ОКНО,
       которое едет вправо. Номер позиции внутри окна и настоящий offset
       расходятся с первого же сдвига (окно 7..24 — метка стояла бы на «12»
       при LEO 19), да ещё и шагали бы назад при каждой перекладке — ровно та
       ложь, против которой переписан весь стенд. Номер отдают те, кто умеет
       меняться: строка offset'ов под клетками и большое поле «leo». Стрелка
       вниз просто показывает место; в стенде 01 лог укладывается в ленту
       целиком, окна нет, и там номер на метке честный — потому он и остался. */
    L.slider(ctx, page, "s3_leo", N + 1, X0, Y + CELL + 8, {
      w: CELL, h: 13, fill: C.surface, textColor: C.write, size: 9, borderWidth: 0,
      caption: () => "↓",
    });

    /* Клетки лога, а под ними номера оффсетов — ПОЛЯМИ, а не рисунком.
       Лента здесь окно на 18 позиций, и когда оно едет вправо, номера обязаны
       ехать вместе с ним: нарисованные намертво «0..17» превратили бы сдвиг
       окна в откат лога назад, а именно этого в Kafka и не бывает. */
    for (let i = 0; i < N; i++) {
      L.logCell(ctx, page, "s3_c" + i, X0 + i * STEP, Y, i % KEYS.length, "");
      L.readout(ctx, page, "s3_o" + i, { x: X0 + i * STEP, y: Y - 20, w: CELL, h: 11 }, {
        text: String(i), size: 7.5, mono: true, align: "center",
        fill: null, border: null, borderWidth: 0, textColor: C.faint,
      });
    }

    /* Закладка группы — committed offset, под лентой. Числа на метке нет по той
       же причине, что и у LEO: настоящий offset показывают строка под клетками
       и поле «committed». */
    L.slider(ctx, page, "s3_com", N + 1, X0, Y - 34, {
      w: CELL, h: 13, fill: C.surface, textColor: C.read, size: 9, borderWidth: 0,
      caption: () => "↑",
    });

    /* Подписи меткам стоят ВЫШЕ и НИЖЕ их дорожек, а не вровень с ними.
       У метки позиций N+1: крайняя («одна за концом ленты») сидит правее
       последней клетки, и её виджет — непрозрачный белый прямоугольник поверх
       содержимого страницы. Вровень поставленная подпись им закрывается:
       читатель видит обрубок вместо слова. */
    const RX = X0 + (N - 1) * STEP + CELL + 12;
    L.tag(page, fonts, "leo", RX, Y + CELL + 24, C.write);
    L.tag(page, fonts, "committed", RX, Y - 48, C.read);
    L.tag(page, fonts, "offset", 58, Y - 17);
    /* Слева до первой клетки ровно 46 пунктов, а моноширинный ярлык стоит
       5,6 пункта на знак: «ПАРТИЦИЯ» (8 знаков) влезает впритык, «PARTITION»
       (9) уезжает под клетку — сторож перекрытий это и ловит. Двигать подпись
       нельзя, поэтому английский ярлык сокращён; номер под ним не меняется. */
    L.tag(page, fonts, L.T("партиция", "part."), 58, Y + 16, C.ink2);
    L.tag(page, fonts, "0", 58, Y + 6, C.ink2);

    /* три крупных показателя плюс соседнее поле с самим вычитанием */
    [
      { n: "s3_leo_v", l: L.T("leo (конец лога)", "leo (end of log)"), x: X0, w: 110, size: 13, txt: "0" },
      { n: "s3_com_v", l: "committed", x: X0 + 118, w: 110, size: 13, txt: "0" },
      { n: "s3_lag_v", l: "lag", x: X0 + 236, w: 110, size: 13, txt: "0" },
      { n: "s3_calc", l: L.T("как считается", "how it adds up"), x: X0 + 354, w: 238, size: 11, txt: "lag = 0 - 0 = 0" },
    ].forEach((s) => {
      L.tag(page, fonts, s.l, s.x, 250);
      L.readout(ctx, page, s.n, { x: s.x, y: 222, w: s.w, h: 24 }, {
        text: s.txt, size: s.size, mono: true, align: "center",
      });
    });

    /* кнопки */
    const BY = 170;
    L.action(ctx, page, "s3_btn_prod", L.T("Продюсер быстрее", "Producer faster"), { x: 56, y: BY, w: 140, h: 30 },
      "s3_prod_fast();", { fill: C.write, border: C.write, textColor: C.white });
    L.action(ctx, page, "s3_btn_cons", L.T("Консьюмер быстрее", "Consumer faster"), { x: 204, y: BY, w: 150, h: 30 },
      "s3_cons_fast();", { fill: C.read, border: C.read, textColor: C.white });
    L.action(ctx, page, "s3_btn_down", L.T("Уронить консьюмера", "Crash the consumer"), { x: 362, y: BY, w: 152, h: 30 },
      "s3_down();", { fill: C.bad, border: C.bad, textColor: C.white });
    L.action(ctx, page, "s3_btn_up", L.T("Поднять консьюмера", "Bring it back up"), { x: 522, y: BY, w: 152, h: 30 },
      "s3_up();", { fill: C.good, border: C.good, textColor: C.white });
    L.action(ctx, page, "s3_btn_reset", L.T("Сброс", "Reset"), { x: 682, y: BY, w: 68, h: 30 },
      "s3_reset();");

    /* multiline и три строки высоты: пояснение собирается из чисел на лету, и
       однострочное поле обрезало бы длинную фразу посреди слова — молча. */
    L.readout(ctx, page, "s3_say", { x: 56, y: 118, w: PAGE.w - 112, h: 46 }, {
      text: L.T(
        "Симуляция уже идёт: продюсер пишет по одной записи за такт, консьюмер читает по одной. Нажми любую кнопку, чтобы сбить равновесие.",
        "The simulation is already running: the producer writes one record per tick, the consumer reads one. Press any button to break the balance."
      ),
      size: 10.5, multiline: true,
    });

    L.wrapText(page, L.T(
      "Committed offset хранится не у консьюмера, а в самой Kafka — в служебном топике __consumer_offsets. Поэтому упавший консьюмер поднимается и продолжает с сохранённой позиции, а не с нуля. И ещё тонкость: committed — это номер СЛЕДУЮЩЕГО сообщения для чтения, а не последнего обработанного. Лента здесь — окно на 18 позиций бесконечного лога: когда конец лога упирается в правый край, окно едет вправо и номера под клетками меняются вместе с ним — offset при этом только растёт, как и в Kafka. А если отставание переросло ленту, конец лога уходит за правый край: рисовать его негде, но числа считают дальше — потолка у lag нет, пока записи не удалит retention.",
      "The committed offset is stored inside Kafka itself, in the internal topic __consumer_offsets, not in the consumer. That is why a crashed consumer comes back and carries on from the stored position instead of from zero. One more subtlety: committed is the number of the NEXT message to read, not of the last one processed. The strip here is a window onto 18 positions of an endless log: when the end of the log hits the right edge, the window slides right and the numbers under the cells slide with it — offset itself only grows, just as in Kafka. And once the lag outgrows the strip, the end of the log leaves the right edge: there is nowhere to draw it, but the numbers keep counting — lag has no ceiling until retention deletes the records."
    ), {
      x: 56, y: 100, width: PAGE.w - 112, size: 9,
      font: fonts.sans, color: C.faint, leading: 12,
    });

    /* Тело согласования числительного — своё на каждый язык, поэтому оно
       собирается здесь, а не живёт в шаблоне. Русское правило в английском
       прямо вредит: 21 % 10 === 1 дало бы «21 message». */
    const WORD = L.T(
      "var a = n % 100;\n" +
      "  if (a >= 11 && a <= 14) return many;\n" +
      "  a = n % 10;\n" +
      "  if (a === 1) return one;\n" +
      "  if (a >= 2 && a <= 4) return few;\n" +
      "  return many;",
      "return (n === 1) ? one : many;"
    );

    /* ---- документный скрипт стенда ---- */
    return `
var s3_N = ${N};         // КЛЕТОК НА ЛЕНТЕ. Это окно, а не весь лог.
var s3_written = 0;      // LEO: номер следующей записи, то есть конец лога
var s3_committed = 0;    // позиция группы: номер следующего сообщения для чтения
var s3_base = 0;         // offset самой левой клетки окна
var s3_drawnBase = 0;    // какой base уже подписан под клетками
var s3_lit = [];         // что сейчас показано в каждой клетке: 0 пусто, 1 запись
var s3_prod = 1;         // записей за такт
var s3_cons = 1;         // прочитанных за такт
var s3_manual = false;   // первый клик выключает сценарий автопоказа
var s3_beat = 0;
var s3_hold = 4;         // сколько тактов не перебивать пояснение; на старте
                         // держим приглашение «нажми любую кнопку»
var s3_prevLag = 0;
var s3_SHIFT = 6;        // на столько позиций окно едет вправо за одну перекладку
for (var s3_k = 0; s3_k < s3_N; s3_k++) s3_lit[s3_k] = 0;

/* Согласование числительного: 1 сообщение, 2 сообщения, 5 сообщений.
   Строки собираются из чисел на лету, и без этого в поле регулярно
   попадало бы «ровно 4 сообщений» — в обучающем тексте это заметно.
   Тело подставляется по языку сборки: форм две, а не три. */
function s3_word(n, one, few, many) {
  ${WORD}
}

/* ОКНО. Лента короткая, лог бесконечный, поэтому лента показывает s3_N подряд
   идущих offset'ов начиная с s3_base — а числа LEO, committed и lag всегда
   настоящие, абсолютные и только растут. Обратное (подгонять числа под ленту)
   один раз уже стоило стенду committed, уехавшего назад к нулю, и фразы
   «продолжил с сохранённой позиции 0, а не с нуля».

   Правило сдвига: окно едет вправо, только когда конец лога упёрся в правый
   край, и НИКОГДА не обгоняет закладку — иначе committed вылетит за левый край
   именно в тот момент, когда на него и надо смотреть. Пока отставание влезает
   в ленту, слева остаётся прочитанная история: если бы окно прижималось к
   концу лога, в равновесии оно схлопывалось бы почти в ноль и «лента поехала»
   читалось бы как «лог обнулился» — ровно та ошибка, против которой стенд 01.
   Когда отставание перерастает ленту, окно встаёт на закладке, а конец лога
   уходит за правый край: метка LEO прячется, числа считают дальше. */
function s3_frame() {
  if (s3_written - s3_base > s3_N) {
    var want = s3_written - s3_N + s3_SHIFT;
    if (want > s3_committed) want = s3_committed;
    if (want > s3_base) s3_base = want;
  }
}

function s3_paint() {
  s3_frame();
  var lag = s3_written - s3_committed;
  var i, on;
  for (i = 0; i < s3_N; i++) {
    on = (s3_base + i < s3_written) ? 1 : 0;
    if (s3_lit[i] !== on) { show("s3_c" + i, on, 2); s3_lit[i] = on; }
  }
  if (s3_base !== s3_drawnBase) {
    for (i = 0; i < s3_N; i++) txt("s3_o" + i, s3_base + i);
    s3_drawnBase = s3_base;
  }
  /* Метка, уехавшая за пределы ленты, не жмётся к краю, а прячется: прижатая
     показывала бы конец лога там, где его нет. -1 в moveTo скрывает все позиции. */
  var l = s3_written - s3_base;
  var c = s3_committed - s3_base;
  moveTo("s3_leo", (l >= 0 && l <= s3_N) ? l : -1, s3_N + 1);
  moveTo("s3_com", (c >= 0 && c <= s3_N) ? c : -1, s3_N + 1);
  txt("s3_leo_v", s3_written);
  txt("s3_com_v", s3_committed);
  txt("s3_lag_v", lag);
  txt("s3_calc", "lag = " + s3_written + " - " + s3_committed + " = " + lag);
}

/* Продюсер не упирается ни в какой потолок: лежачий консьюмер его не тормозит,
   и lag растёт без границы — в Kafka его останавливает только retention. */
function s3_step() {
  var i;
  for (i = 0; i < s3_prod; i++) s3_written++;
  for (i = 0; i < s3_cons; i++) {
    if (s3_committed >= s3_written) break;
    s3_committed++;
  }
  s3_paint();
}

function s3_talk() {
  if (s3_hold > 0) { s3_hold--; return; }
  var lag = s3_written - s3_committed;
  /* Отставание переросло ленту — говорим об этом прямо, иначе читатель решит,
     что стенд застрял, или что у lag есть потолок. */
  var off = (lag > s3_N) ? "${L.T(" Конец лога ушёл за правый край: отставание длиннее ленты, а число считает дальше — потолка у lag нет.", " The end of the log has left the right edge: the lag is longer than the strip, but the number keeps counting — lag has no ceiling.")}" : "";
  var s;
  if (s3_cons === 0) {
    s = "${L.T("Консьюмер лежит: committed застыл на ", "The consumer is down: committed is stuck at ")}" + s3_committed + "${L.T(", а LEO уехал на ", " while LEO has run ahead to ")}" + s3_written + ". Lag " + lag + "${L.T(" — столько сообщений уже ждут, и данные устаревают на глазах.", " — that many messages are already waiting, and the data goes stale before your eyes.")}";
  } else if (lag === 0) {
    s = "${L.T("Lag 0: консьюмер вровень с продюсером, данные свежие. committed = LEO = ", "Lag 0: the consumer is level with the producer, the data is fresh. committed = LEO = ")}" + s3_written + "${L.T(" — номер СЛЕДУЮЩЕГО сообщения, а не последнего обработанного.", " — the number of the NEXT message, not of the last one processed.")}";
  } else if (lag > s3_prevLag) {
    s = "${L.T("Lag вырос с ", "Lag grew from ")}" + s3_prevLag + "${L.T(" до ", " to ")}" + lag + "${L.T(": пишут быстрее, чем читают. Отставание копится, и всё, что ты видишь на выходе, всё старее.", ": they write faster than they read. The backlog piles up, and everything you see downstream keeps getting older.")}";
  } else if (lag < s3_prevLag) {
    s = "${L.T("Lag упал с ", "Lag fell from ")}" + s3_prevLag + "${L.T(" до ", " to ")}" + lag + "${L.T(": консьюмер читает быстрее продюсера и подтягивает committed к концу лога. Данные снова свежеют.", ": the consumer reads faster than the producer and pulls committed toward the end of the log. The data is getting fresher again.")}";
  } else {
    s = "${L.T("Lag держится на ", "Lag holds at ")}" + lag + "${L.T(": продюсер и консьюмер в одном темпе. Отставание постоянное — ровно ", ": producer and consumer run at the same pace. The gap is constant — exactly ")}" + lag + " " + s3_word(lag, ${L.T('"сообщение", "сообщения", "сообщений"', '"message", "messages", "messages"')}) + "${L.T(" между концом лога и закладкой.", " between the end of the log and the bookmark.")}";
  }
  txt("s3_say", s + off);
}

/* Сценарий автопоказа: равновесие, продюсер разгоняется, консьюмер догоняет.
   Фазы обязаны быть СИММЕТРИЧНЫ: разгон длится 8 тактов (6..13), значит и
   догон обязан длиться 8 (14..21). Иначе за круг накапливается лишнее
   отставание, оно копится круг за кругом, и через несколько минут показа
   конец лога навсегда уезжает за правый край — метка LEO пропадает, а подпись
   продолжает обещать «консьюмер догоняет». Числа здесь абсолютные и назад не
   ходят, поэтому такой перекос уже ничем не маскируется. */
function s3_scene() {
  var phase = s3_beat % 26;
  if (phase === 0) { s3_prod = 1; s3_cons = 1; }
  else if (phase === 6) { s3_prod = 2; s3_cons = 1; }
  else if (phase === 14) { s3_prod = 1; s3_cons = 2; }
  else if (phase === 22) { s3_prod = 1; s3_cons = 1; }
}

/* Движок тикает всегда: кнопки не запускают шаги, они меняют скорости. */
function s3_auto() {
  s3_beat++;
  if (!s3_manual) s3_scene();
  s3_step();
  s3_talk();
  s3_prevLag = s3_written - s3_committed;
}

/* Обе подписи считают итог ИЗ ТЕМПОВ, а не обещают заранее заготовленное:
   «разрыв растёт» верно только при продюсере быстрее консьюмера, а
   «lag схлопывается к нулю» — только при обратном. */
function s3_prod_fast() {
  s3_manual = true;
  s3_prod = 2;
  s3_hold = 5;
  var s = "${L.T("Продюсер ускорился: 2 записи за такт против ", "Producer sped up: 2 records written per tick against ")}" + s3_cons + " " + s3_word(s3_cons, ${L.T('"прочитанной", "прочитанных", "прочитанных"', '"record read", "records read", "records read"')}) + ". ";
  if (s3_prod > s3_cons) s = s + "${L.T("LEO убегает, разрыв между метками растёт — это и есть растущий lag.", "LEO runs away, the gap between the two markers widens — that gap is lag, and it is growing.")}";
  else if (s3_prod === s3_cons) s = s + "${L.T("Темпы сравнялись: lag больше не растёт, но и не тает — он застывает на том, что уже накопилось.", "The pace is even now: lag stops growing, but it does not melt away either — it freezes at whatever has piled up.")}";
  else s = s + "${L.T("Консьюмер всё равно быстрее: накопленное он продолжает разгребать, просто теперь медленнее — разница темпов сократилась.", "The consumer is still faster: it keeps clearing the backlog, only slower now — the difference in pace has narrowed.")}";
  txt("s3_say", s);
  s3_paint();
}

function s3_cons_fast() {
  s3_manual = true;
  s3_cons = 2;
  s3_hold = 5;
  var s = "${L.T("Консьюмер ускорился: 2 записи за такт против ", "Consumer sped up: 2 records read per tick against ")}" + s3_prod + " " + s3_word(s3_prod, ${L.T('"записанной", "записанных", "записанных"', '"record written", "records written", "records written"')}) + ". ";
  if (s3_cons > s3_prod) s = s + "${L.T("Он вычитывает накопленное, committed нагоняет LEO, и lag схлопывается к нулю.", "It eats through the backlog, committed catches up with LEO, and lag collapses to zero.")}";
  else s = s + "${L.T("Но пишут столько же, сколько он читает: отставание перестало расти и таким и останется. Разгрести его можно, только читая быстрее, чем пишут.", "But they write exactly as much as it reads: the backlog stopped growing and will stay where it is. The only way to clear it is to read faster than they write.")}";
  txt("s3_say", s);
  s3_paint();
}

function s3_down() {
  s3_manual = true;
  s3_cons = 0;
  s3_hold = 6;
  txt("s3_say", "${L.T("Консьюмер упал: LEO уходит вперёд, lag растёт на глазах. Но committed = ", "The consumer crashed: LEO moves ahead, lag grows before your eyes. But committed = ")}" + s3_committed + "${L.T(" лежит в самой Kafka, в топике __consumer_offsets, — позиция цела.", " sits inside Kafka itself, in the topic __consumer_offsets — the position is safe.")}");
  s3_paint();
}

/* Текст зависит от того, лежал ли консьюмер: обещать «поднялся с сохранённой
   позиции» тому, кто и не падал, — врать на ровном месте. */
function s3_up() {
  s3_manual = true;
  var lay = (s3_cons === 0);
  s3_cons = 2;
  s3_hold = 6;
  if (lay && s3_committed === 0) {
    /* «Продолжил с позиции 0, а не с нуля» — самопротиворечие. Если группа не
       успела прочитать ничего, сохранённая позиция и есть ноль. */
    txt("s3_say", "${L.T("Поднялся и взял позицию из __consumer_offsets. Прочитать он ничего не успел, поэтому сохранён там ноль — читать будет с начала лога. Теперь берёт по 2 за такт.", "It came back up and took its position from __consumer_offsets. It had not managed to read anything, so what is stored there is zero — it will read from the start of the log. Now it takes 2 per tick.")}");
  } else if (lay) {
    txt("s3_say", "${L.T("Поднялся и продолжил С СОХРАНЁННОЙ ПОЗИЦИИ ", "It came back up and carried on FROM THE STORED POSITION ")}" + s3_committed + "${L.T(", а не с нуля: committed он прочитал из __consumer_offsets. Теперь берёт по 2 за такт.", ", not from zero: it read committed out of __consumer_offsets. Now it takes 2 per tick.")}");
  } else {
    txt("s3_say", "${L.T("Консьюмер и не падал — он просто читает по 2 записи за такт. Урони его, дай отставанию подрасти и подними: тогда видно, откуда он продолжит.", "The consumer never crashed — it simply reads 2 records per tick. Crash it, let the lag grow and bring it back up: then you can see where it resumes from.")}");
  }
  s3_paint();
}

function s3_reset() {
  s3_manual = true;
  var i;
  for (i = 0; i < s3_N; i++) { show("s3_c" + i, 0, 2); s3_lit[i] = 0; }
  s3_written = 0;
  s3_committed = 0;
  s3_base = 0;
  s3_prod = 1;
  s3_cons = 1;
  s3_prevLag = 0;
  s3_hold = 4;
  txt("s3_say", "${L.T("Лог пуст, обе метки на нуле, темпы равные — по записи за такт. Движок идёт: жми кнопки и смотри, что каждая делает с lag.", "The log is empty, both markers sit at zero, the pace is even — one record per tick. The engine keeps running: press the buttons and watch what each one does to lag.")}");
  s3_paint();
}

s3_paint();
TICKERS.push(s3_auto);
`;
  },
};
