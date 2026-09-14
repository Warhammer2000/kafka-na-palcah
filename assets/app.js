/* ============================================================
   app.js — оболочка: хребет глав, роутинг, монтирование сцен.
   Загружается ПОСЛЕДНИМ, после core.js и всех scenes/*.js.
   ============================================================ */
(function (global) {
  "use strict";

  var KV = global.KV;
  var el = KV.el;

  var scenes = KV.scenes.slice().sort(function (a, b) { return a.num - b.num; });
  var byId = {};
  scenes.forEach(function (s) { byId[s.id] = s; });

  var current = null;      // { def, life }
  var navButtons = {};

  /* ---------------- тема ---------------- */

  var THEMES = ["auto", "light", "dark"];
  var THEME_LABEL = { auto: "Тема: как в системе", light: "Тема: светлая", dark: "Тема: тёмная" };
  var THEME_ICON = { auto: "◐", light: "☀", dark: "☾" };

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
    type: "button", title: THEME_LABEL[theme], "aria-label": THEME_LABEL[theme]
  }, THEME_ICON[theme]);
  themeBtn.addEventListener("click", function () {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    applyTheme(theme);
    themeBtn.textContent = THEME_ICON[theme];
    themeBtn.title = THEME_LABEL[theme];
    themeBtn.setAttribute("aria-label", THEME_LABEL[theme]);
  });

  /* ---------------- каркас ---------------- */

  var nav = el("nav.kv-nav", { "aria-label": "Главы" });

  var rail = el("aside.kv-rail", null,
    el("div.kv-rail__head", null,
      el("h2.kv-wordmark", null, "Kafka ", el("span", null, "на пальцах"),
        el("small", null, "интерактивный разбор")),
      themeBtn),
    nav);

  var crumb = el("div.kv-topbar__crumb");
  var topbar = el("div.kv-topbar", null, crumb);

  var chapterEl = el("article.kv-chapter");
  var pager = el("div.kv-pager");
  var main = el("main.kv-main", null, topbar, chapterEl, pager);

  var app = el("div.kv-app", null, rail, main);

  /* ---------------- навигация ---------------- */

  var lastGroup = null;
  scenes.forEach(function (s) {
    if (s.group !== lastGroup) {
      nav.appendChild(el("div.kv-nav__group", { text: s.group }));
      lastGroup = s.group;
    }
    var b = el("button.kv-nav__item", { type: "button" },
      el("span.kv-nav__num", { text: String(s.num).padStart(2, "0") }),
      el("span", { text: s.nav || s.title }));
    b.addEventListener("click", function () { go(s.id); });
    navButtons[s.id] = b;
    nav.appendChild(b);
  });

  /* ---------------- монтирование ---------------- */

  function go(id, noHash) {
    var def = byId[id] || scenes[0];
    if (current && current.def.id === def.id) return;

    if (current) {
      current.life.destroy();
      current = null;
    }

    KV.clear(chapterEl);
    KV.clear(pager);

    var life = KV.lifecycle(go);

    var body = el("div.kv-chapter__body");
    KV.append(chapterEl,
      el("div.kv-chapter__num", { text: "Глава " + String(def.num).padStart(2, "0") + " · " + def.group }),
      el("h1", { text: def.title }),
      def.lede ? el("p.kv-lede", { html: def.lede }) : null,
      body);

    crumb.textContent = def.group + " / " + (def.nav || def.title);
    document.title = def.title + " — Kafka на пальцах";

    Object.keys(navButtons).forEach(function (k) {
      navButtons[k].setAttribute("aria-current", String(k === def.id));
    });

    try {
      def.build(body, life.api);
    } catch (err) {
      body.appendChild(KV.ui.note("bad", "сбой",
        "Глава не смогла отрисоваться: <code>" + KV.util.escape(err && err.message || err) + "</code>"));
      if (global.console) global.console.error(err);
    }

    current = { def: def, life: life };

    // пагинатор
    var i = scenes.indexOf(def);
    var prev = scenes[i - 1], next = scenes[i + 1];
    pager.appendChild(prev
      ? el("button", { type: "button", on: { click: function () { go(prev.id); } } },
        el("small", null, "← предыдущая"), el("span", { text: prev.nav || prev.title }))
      : el("button", { type: "button", disabled: true }, el("small", null, "начало"), el("span", null, "Это первая глава")));
    pager.appendChild(next
      ? el("button", { type: "button", on: { click: function () { go(next.id); } } },
        el("small", null, "следующая →"), el("span", { text: next.nav || next.title }))
      : el("button", { type: "button", disabled: true }, el("small", null, "конец"), el("span", null, "Это последняя глава")));

    var active = navButtons[def.id];
    if (active && active.scrollIntoView) {
      active.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    global.scrollTo(0, 0);

    if (!noHash) {
      try { global.history.replaceState(null, "", "#/" + def.id); }
      catch (e) { global.location.hash = "#/" + def.id; }
    }
  }

  /* ---------------- клавиатура ---------------- */

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
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
    var id = (global.location.hash || "").replace(/^#\/?/, "");
    go(byId[id] ? id : scenes[0].id, true);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

})(window);
