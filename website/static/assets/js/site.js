/* Site behaviour. Vanilla JS, no dependencies, no network calls, no tracking.
   Everything degrades: without JS the menu is visible, the walkthrough shows all steps,
   forms fall back to mailto:, and the ROI estimator shows its defaults as text. */
(function () {
  "use strict";
  var doc = document.documentElement;
  doc.classList.remove("no-js");
  doc.classList.add("js");
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Theme toggle: remembers the choice in localStorage on this device only. */
  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    var current = function () {
      var t = doc.getAttribute("data-theme");
      if (t) return t;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    };
    var sync = function () {
      var dark = current() === "dark";
      toggle.setAttribute("aria-pressed", dark ? "true" : "false");
    };
    sync();
    toggle.addEventListener("click", function () {
      var next = current() === "dark" ? "light" : "dark";
      doc.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) { /* private mode: ignore */ }
      sync();
    });
  }

  /* Mobile menu */
  var menuBtn = document.querySelector(".menu-toggle");
  var nav = document.getElementById("site-nav");
  if (menuBtn && nav) {
    menuBtn.addEventListener("click", function () {
      var open = menuBtn.getAttribute("aria-expanded") === "true";
      menuBtn.setAttribute("aria-expanded", open ? "false" : "true");
      nav.classList.toggle("open", !open);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("open")) {
        nav.classList.remove("open");
        menuBtn.setAttribute("aria-expanded", "false");
        menuBtn.focus();
      }
    });
  }

  /* Disclosure submenus (Product, Solutions, Compare) */
  var discs = Array.prototype.slice.call(document.querySelectorAll(".nav-disclosure"));
  var closeAll = function (except) {
    discs.forEach(function (b) {
      if (b === except) return;
      b.setAttribute("aria-expanded", "false");
      var p = document.getElementById(b.getAttribute("aria-controls"));
      if (p) p.hidden = true;
    });
  };
  discs.forEach(function (btn) {
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    btn.addEventListener("click", function () {
      var open = btn.getAttribute("aria-expanded") === "true";
      closeAll(btn);
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      if (panel) panel.hidden = open;
    });
    btn.parentElement.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") {
        btn.setAttribute("aria-expanded", "false");
        if (panel) panel.hidden = true;
        btn.focus();
      }
    });
    btn.parentElement.addEventListener("focusout", function (e) {
      if (!btn.parentElement.contains(e.relatedTarget)) {
        btn.setAttribute("aria-expanded", "false");
        if (panel) panel.hidden = true;
      }
    });
  });
  document.addEventListener("click", function (e) {
    if (!e.target.closest || !e.target.closest(".nav-list > li")) closeAll(null);
  });

  /* Reveal on scroll (purely cosmetic; skipped when reduced motion is on) */
  var reveals = document.querySelectorAll(".reveal");
  if (!reduceMotion && "IntersectionObserver" in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); }
      });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (el) { io.observe(el); });
  } else {
    reveals.forEach(function (el) { el.classList.add("in"); });
  }

  /* Walkthrough: tabs of real screenshots, with an optional play button. Never autoplays. */
  document.querySelectorAll("[data-walk]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
    var playBtn = root.querySelector("[data-walk-play]");
    var bar = root.querySelector(".progress > i");
    var idx = 0, timer = null, started = 0, DURATION = 5000, raf = null;
    var show = function (i, focus) {
      idx = (i + tabs.length) % tabs.length;
      tabs.forEach(function (t, j) {
        var on = j === idx;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
        panels[j].hidden = !on;
        if (on && !reduceMotion) { panels[j].classList.remove("enter"); void panels[j].offsetWidth; panels[j].classList.add("enter"); }
      });
      if (focus) tabs[idx].focus();
    };
    var stop = function () {
      clearInterval(timer); timer = null; cancelAnimationFrame(raf);
      if (bar) bar.style.width = "0";
      if (playBtn) { playBtn.setAttribute("aria-pressed", "false"); playBtn.querySelector("span").textContent = playBtn.getAttribute("data-play"); }
    };
    var tick = function () {
      if (!timer || !bar) return;
      var p = Math.min(1, (Date.now() - started) / DURATION);
      bar.style.width = (p * 100).toFixed(1) + "%";
      raf = requestAnimationFrame(tick);
    };
    var play = function () {
      if (playBtn) { playBtn.setAttribute("aria-pressed", "true"); playBtn.querySelector("span").textContent = playBtn.getAttribute("data-pause"); }
      started = Date.now();
      timer = setInterval(function () {
        if (idx === tabs.length - 1) { stop(); return; }
        show(idx + 1); started = Date.now();
      }, DURATION);
      if (!reduceMotion) tick();
    };
    tabs.forEach(function (t, i) {
      t.addEventListener("click", function () { stop(); show(i); });
      t.addEventListener("keydown", function (e) {
        var k = e.key;
        if (k === "ArrowDown" || k === "ArrowRight") { e.preventDefault(); stop(); show(idx + 1, true); }
        else if (k === "ArrowUp" || k === "ArrowLeft") { e.preventDefault(); stop(); show(idx - 1, true); }
        else if (k === "Home") { e.preventDefault(); stop(); show(0, true); }
        else if (k === "End") { e.preventDefault(); stop(); show(tabs.length - 1, true); }
      });
    });
    if (playBtn) {
      playBtn.hidden = false;
      playBtn.addEventListener("click", function () {
        if (timer) { stop(); } else { if (idx === tabs.length - 1) show(0); play(); }
      });
    }
    show(0);
  });

  /* ROI estimator: client-side arithmetic only; nothing is sent anywhere. */
  document.querySelectorAll("[data-roi]").forEach(function (form) {
    var lang = doc.lang || "en";
    var locale = lang === "hi" ? "hi-IN" : "en-IN";
    var fmt = function (n, d) { return Number(n).toLocaleString(locale, { maximumFractionDigits: d || 0 }); };
    var sym = form.getAttribute("data-currency") || "₹";
    var get = function (name) {
      var el = form.elements[name]; var v = parseFloat(el && el.value);
      if (!isFinite(v)) v = 0;
      var lo = parseFloat(el.min), hi = parseFloat(el.max);
      if (isFinite(lo)) v = Math.max(lo, v);
      if (isFinite(hi)) v = Math.min(hi, v);
      return v;
    };
    var out = function (k, v) { var el = form.querySelector('[data-out="' + k + '"]'); if (el) el.textContent = v; };
    var calc = function () {
      var people = Math.max(0, get("people"));
      var hours = Math.max(0, get("hours"));
      var share = Math.min(100, Math.max(0, get("share")));
      var cost = Math.max(0, get("cost"));
      var weeks = Math.min(52, Math.max(0, get("weeks")));
      var spent = people * hours * weeks;
      var saved = spent * share / 100;
      var value = saved * cost;
      out("spent", fmt(spent));
      out("saved", fmt(saved));
      out("value", sym + fmt(value));
      out("perMonth", sym + fmt(value / 12));
      out("days", fmt(saved / 8, 0));
    };
    /* keep range and number inputs in step */
    form.querySelectorAll("[data-sync]").forEach(function (el) {
      el.addEventListener("input", function () {
        var other = form.querySelector('[data-sync="' + el.getAttribute("data-sync") + '"]:not([id="' + el.id + '"])');
        if (other && other !== el) other.value = el.value;
        calc();
      });
    });
    form.addEventListener("input", calc);
    form.addEventListener("submit", function (e) { e.preventDefault(); calc(); });
    form.addEventListener("reset", function () { setTimeout(calc, 0); });
    calc();
  });

  /* Forms: no third-party service. If a form has data-endpoint it posts there (configured in
     site.config.json); otherwise it composes an email in the visitor's own mail app (mailto:). */
  document.querySelectorAll("form[data-mailto]").forEach(function (form) {
    var status = form.querySelector(".form-status");
    form.addEventListener("submit", function (e) {
      if (!form.checkValidity()) return; /* let the browser show its messages */
      if (form.getAttribute("data-endpoint")) return; /* real POST: the configured hook */
      e.preventDefault();
      var lines = [];
      Array.prototype.forEach.call(form.elements, function (el) {
        if (!el.name || el.type === "submit" || el.name === "consent" || el.name === "_hp") return;
        if ((el.type === "checkbox" || el.type === "radio") && !el.checked) return;
        var label = el.getAttribute("data-label") || el.name;
        if (el.value) lines.push(label + ": " + el.value);
      });
      lines.push("", "Consent to be contacted about this request: yes");
      var subject = form.getAttribute("data-subject") || "Website enquiry";
      var href = "mailto:" + form.getAttribute("data-mailto") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(lines.join("\n"));
      if (status) { status.hidden = false; status.focus(); }
      window.location.href = href;
    });
  });

  /* Prefill a topic from ?topic= on the contact page */
  var topicSel = document.querySelector('select[name="topic"]');
  if (topicSel && window.URLSearchParams) {
    var t = new URLSearchParams(window.location.search).get("topic");
    if (t && topicSel.querySelector('option[value="' + t.replace(/[^a-z-]/g, "") + '"]')) topicSel.value = t;
  }

  /* Print button on the pricing page */
  document.querySelectorAll("[data-print]").forEach(function (b) {
    b.hidden = false;
    b.addEventListener("click", function () { window.print(); });
  });
})();
