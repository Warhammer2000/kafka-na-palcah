/* ============================================================
   app.js — оболочка: хребет глав, роутинг, монтирование сцен.
   Загружается ПОСЛЕДНИМ, после core.js и всех scenes/*.js.
   ============================================================ */
(function (global) {
  "use strict";

  var KV = global.KV;
  var el = KV.el;
  var L = KV.L;

  var scenes = KV.scenes.slice().sort(function (a, b) { return a.num - b.num; });
  var byId = {};
  scenes.forEach(function (s) { byId[s.id] = s; });

  /* Метаданные главы записаны парой ["ru","en"] — достаём через KV.text. */
  function navOf(s) { return KV.text(s.nav) || KV.text(s.title); }

  var current = null;      // { def, life }
  var navButtons = {};

  /* ---------------- тема ---------------- */

  var THEMES = ["auto", "light", "dark"];
  var THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };
  function themeLabel(t) {
    if (t === "light") return L("Тема: светлая", "Theme: light");
    if (t === "dark") return L("Тема: тёмная", "Theme: dark");
    return L("Тема: как в системе", "Theme: match system");
  }

  function readTheme() {
    try { return localStorage.getItem("kv-theme") || "auto"; } catch (e) { return "auto"; }
  }
  function applyTheme(t) {
    if (t === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", t);
    try { localStorage.setItem("kv-theme", t); } catch (e) { /* приватное окно */ }
  }

  var theme = readTheme();
  applyTheme(theme);

  var themeBtn = el("button.kv-btn.kv-btn--sm.kv-btn--ghost", {
    type: "button", title: themeLabel(theme), "aria-label": themeLabel(theme)
  }, THEME_ICON[theme]);
  themeBtn.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    themeBtn.textContent = THEME_ICON[theme];
    themeBtn.title = themeLabel(theme);
    themeBtn.setAttribute("aria-label", themeLabel(theme));
  });

  /* ---------------- язык ----------------
     Переключатель показывает оба языка сразу, а не «следующий», как у темы:
     у темы три состояния и подпись всё равно нужна, а тут два, и увидеть
     СВОЙ язык в списке важнее, чем сэкономить кнопку — читатель, попавший
     на незнакомый язык, ищет глазами «RU», а не догадывается про смысл
     единственной кнопки. */

  var LANG_NAME = { ru: "Русский", en: "English" };
  var langBtns = {};
  var langSeg = el("div.kv-seg.kv-lang", { role: "group" });
  KV.langs.forEach(function (lang) {
    var b = el("button", {
      type: "button", lang: lang,
      "aria-pressed": String(lang === KV.lang),
      title: LANG_NAME[lang], "aria-label": LANG_NAME[lang]
    }, lang.toUpperCase());
    b.addEventListener("click", function () { KV.setLang(lang); });
    langBtns[lang] = b;
    langSeg.appendChild(b);
  });

  var tools = el("div.kv-rail__tools", null, langSeg, themeBtn);

  /* ---------------- каркас ---------------- */

  var nav = el("nav.kv-nav");

  var wordmarkTail = el("span");
  var wordmarkSub = el("small");
  var wordmark = el("h2.kv-wordmark", null, "Kafka ", wordmarkTail, wordmarkSub);

  var rail = el("aside.kv-rail", null,
    el("div.kv-rail__head", null, wordmark, tools),
    nav);

  var crumb = el("div.kv-topbar__crumb");
  var topbar = el("div.kv-topbar", null, crumb);

  var chapterEl = el("article.kv-chapter");
  var pager = el("div.kv-pager");
  var main = el("main.kv-main", null, topbar, chapterEl, pager);

  var app = el("div.kv-app", null, rail, main);

  /* ---------------- навигация ---------------- */

  function buildNav() {
    KV.clear(nav);
    navButtons = {};
    nav.setAttribute("aria-label", L("Главы", "Chapters"));
    var lastGroup = null;
    scenes.forEach(function (s) {
      var group = KV.text(s.group);
      if (group !== lastGroup) {
        nav.appendChild(el("div.kv-nav__group", { text: group }));
        lastGroup = group;
      }
      var b = el("button.kv-nav__item", { type: "button" },
        el("span.kv-nav__num", { text: String(s.num).padStart(2, "0") }),
        el("span", { text: navOf(s) }));
      b.addEventListener("click", function () { go(s.id); });
      navButtons[s.id] = b;
      nav.appendChild(b);
    });
    if (current) markCurrent(current.def);
  }

  function markCurrent(def) {
    Object.keys(navButtons).forEach(function (k) {
      navButtons[k].setAttribute("aria-current", String(k === def.id));
    });
  }

  function paintChrome() {
    wordmarkTail.textContent = L("на пальцах", "hands-on");
    wordmarkSub.textContent = L("интерактивный разбор", "interactive walkthrough");
    themeBtn.title = themeLabel(theme);
    themeBtn.setAttribute("aria-label", themeLabel(theme));
    langSeg.setAttribute("aria-label", L("Язык страницы", "Page language"));
    KV.langs.forEach(function (lang) {
      langBtns[lang].setAttribute("aria-pressed", String(lang === KV.lang));
    });
  }

  /* ---------------- монтирование ---------------- */

  function go(id, noHash, force) {
    var def = byId[id] || scenes[0];
    if (!force && current && current.def.id === def.id) return;

    if (current) {
      current.life.destroy();
      current = null;
    }

    KV.clear(chapterEl);
    KV.clear(pager);

    var life = KV.lifecycle(go);
    var group = KV.text(def.group);
    var title = KV.text(def.title);
    var lede = KV.text(def.lede);

    var body = el("div.kv-chapter__body");
    KV.append(chapterEl,
      el("div.kv-chapter__num", {
        text: L("Глава ", "Chapter ") + String(def.num).padStart(2, "0") + " · " + group
      }),
      el("h1", { text: title }),
      lede ? el("p.kv-lede", { html: KV.terms(lede) }) : null,
      body);

    crumb.textContent = group + " / " + navOf(def);
    document.title = title + L(" — Kafka на пальцах", " — Kafka hands-on");

    markCurrent(def);

    try {
      def.build(body, life.api);
    } catch (err) {
      body.appendChild(KV.ui.note("bad", L("сбой", "failure"),
        L("Глава не смогла отрисоваться: <code>", "The chapter failed to render: <code>") +
        KV.util.escape(err && err.message || err) + "</code>"));
      if (global.console) global.console.error(err);
    }

    current = { def: def, life: life };

    // пагинатор
    var i = scenes.indexOf(def);
    var prev = scenes[i - 1], next = scenes[i + 1];
    pager.appendChild(prev
      ? el("button", { type: "button", on: { click: function () { go(prev.id); } } },
        el("small", null, L("← предыдущая", "← previous")), el("span", { text: navOf(prev) }))
      : el("button", { type: "button", disabled: true },
        el("small", null, L("начало", "start")),
        el("span", null, L("Это первая глава", "This is the first chapter"))));
    pager.appendChild(next
      ? el("button", { type: "button", on: { click: function () { go(next.id); } } },
        el("small", null, L("следующая →", "next →")), el("span", { text: navOf(next) }))
      : el("button", { type: "button", disabled: true },
        el("small", null, L("конец", "end")),
        el("span", null, L("Это последняя глава", "This is the last chapter"))));

    var active = navButtons[def.id];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    if (!force) global.scrollTo(0, 0);

    // Каждый переход — отдельная запись в истории: «Назад» в браузере
    // обязан возвращать на предыдущую главу, а не на предыдущий сайт.
    if (!noHash) setAddress(def.id, false);
  }

  function setAddress(id, replace) {
    var url = "#/" + id;
    try { global.history[replace ? "replaceState" : "pushState"](null, "", url); }
    catch (e) { global.location.hash = url; }
  }

  /* Выбранный язык кладём в адрес: ссылку на английскую версию нужно уметь
     передать целиком, а не «откройте и переключите». Ставим только после
     явного выбора — у пришедшего впервые адрес остаётся чистым, и язык
     определяется по браузеру. */
  function setLangAddress(lang) {
    try {
      var loc = global.location;
      var q = (loc.search || "").replace(/[?&]lang=(ru|en)\b/g, "").replace(/^&/, "?");
      q = q && q !== "?" ? q + "&lang=" + lang : "?lang=" + lang;
      global.history.replaceState(null, "", loc.pathname + q + (loc.hash || ""));
    } catch (e) { /* file:// и приватные окна такое запрещают — не беда */ }
  }

  KV.onLang(function (lang) {
    paintChrome();
    buildNav();
    setLangAddress(lang);
    // Глава перерисовывается целиком: L() внутри build() читает язык в
    // момент вызова, поэтому перемонтирование — единственный честный способ
    // сменить в ней все строки разом. Состояние стенда при этом сбрасывается,
    // и это правильнее, чем оставить наполовину переведённый стенд.
    if (current) go(current.def.id, true, true);
  });

  /* ---------------- клавиатура ---------------- */

  // Стрелки листают главы только тогда, когда их некому потратить.
  // Кнопка стенда, ползунок, поле, прокручиваемая вбок лента — каждый
  // из них сам ждёт стрелку; отобрать её значит снести главу вместе с
  // состоянием стенда, которое читатель набирал руками.
  function ownsArrows(t) {
    if (!t || t.nodeType !== 1) return false;
    var tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return true;
    if (t !== document.body && t !== document.documentElement
      && t.scrollWidth - t.clientWidth > 1) return true;   // есть куда прокрутить вбок
    return !!(t.closest && t.closest(".kv-stage"));         // что угодно внутри стенда
  }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    if (ownsArrows(e.target)) return;
    if (!current) return;
    var i = scenes.indexOf(current.def);
    if (e.key === "ArrowRight" && scenes[i + 1]) { go(scenes[i + 1].id); e.preventDefault(); }
    if (e.key === "ArrowLeft" && scenes[i - 1]) { go(scenes[i - 1].id); e.preventDefault(); }
  });

  global.addEventListener("hashchange", function () {
    var id = (global.location.hash || "").replace(/^#\/?/, "");
    if (id && byId[id] && (!current || current.def.id !== id)) go(id, true);
  });

  /* ---------------- старт ---------------- */

  function boot() {
    document.body.appendChild(app);
    paintChrome();
    buildNav();
    var id = (global.location.hash || "").replace(/^#\/?/, "");
    var first = byId[id] ? id : scenes[0].id;
    go(first, true);
    // Первую главу кладём в историю заменой: тогда «Назад» со второй
    // главы возвращает сюда, а не на то, что было до страницы.
    setAddress(first, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})(window);
