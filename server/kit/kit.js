/*
 * Lens Kit: the building blocks an AI-written study page is made of. Runs
 * inside a sandboxed iframe (scripts only, opaque origin); talks to the app
 * only through postMessage: its height, citations the student clicks, and
 * progress on the page's exercises.
 *
 * Elements: lk-hook, lk-callout, lk-reveal, lk-quiz/lk-option, lk-steps/lk-step,
 * lk-blank, lk-var, lk-out, lk-plot/lk-series/lk-point, lk-canvas, lk-sort,
 * lk-flip, lk-sandbox, lk-cite. Text like [p.12] or [12:34] becomes a citation.
 */
(function () {
  "use strict";
  var post = function (msg) {
    try {
      parent.postMessage(Object.assign({ lk: 1 }, msg), "*");
    } catch (e) {}
  };
  var UNIT = document.documentElement.getAttribute("data-unit") || "time";
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };
  var num = function (v, d) {
    var n = parseFloat(v);
    return isFinite(n) ? n : d;
  };

  // --- variables and expressions ---------------------------------------------
  var vars = {};
  var listeners = [];
  var MATH = Object.getOwnPropertyNames(Math);
  var compiled = {};
  function evaluate(expr, extra) {
    var scope = Object.assign({}, vars, extra || {});
    var names = MATH.concat(Object.keys(scope));
    var key = names.join(",") + "|" + expr;
    try {
      var fn = compiled[key] || (compiled[key] = new Function(names.join(","), "return (" + expr + ");"));
      return fn.apply(null, MATH.map(function (k) { return Math[k]; }).concat(Object.keys(scope).map(function (k) { return scope[k]; })));
    } catch (e) {
      return NaN;
    }
  }
  function fmt(v, digits) {
    if (typeof v !== "number") return String(v);
    if (!isFinite(v)) return "—";
    var d = digits == null ? (Math.abs(v) >= 100 ? 1 : Math.abs(v) >= 1 ? 2 : 3) : digits;
    return Number(v.toFixed(d)).toLocaleString("ko-KR", { maximumFractionDigits: d });
  }
  function setVar(name, value) {
    vars[name] = value;
    listeners.forEach(function (f) { try { f(); } catch (e) {} });
  }
  function onVars(f) {
    listeners.push(f);
    f();
  }

  // --- progress ----------------------------------------------------------------
  var tasks = new Map();
  var bar;
  function track(el) {
    tasks.set(el, tasks.get(el) || { done: false, correct: false });
    renderScore();
  }
  function complete(el, correct) {
    var t = tasks.get(el) || {};
    if (t.done) return;
    tasks.set(el, { done: true, correct: !!correct });
    renderScore();
  }
  function renderScore() {
    var total = tasks.size;
    if (!total) return;
    var done = 0, correct = 0;
    tasks.forEach(function (t) { if (t.done) done++; if (t.correct) correct++; });
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "lk-score";
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.innerHTML = "<span>연습 " + done + " / " + total + "</span><span class=\"bar\"><i style=\"width:" + Math.round((done / total) * 100) + "%\"></i></span><span>정답 " + correct + "</span>";
    post({ type: "progress", done: done, total: total, correct: correct });
  }

  // --- citations ------------------------------------------------------------------
  var CITE_RE = /\[(p\.\s?\d{1,4}(?:\s*[-–~]\s*(?:p\.\s?)?\d{1,4})?|\d{1,2}:\d{2}(?::\d{2})?(?:\s*[-–~]\s*\d{1,2}:\d{2}(?::\d{2})?)?)\]/g;
  function citeValue(label) {
    var m = /^p\.\s?(\d+)/.exec(label);
    if (m) return { unit: "page", value: +m[1] };
    var t = label.split(/[-–~]/)[0].trim().split(":").map(Number);
    return { unit: "time", value: t.reduce(function (a, b) { return a * 60 + b; }, 0) };
  }
  function citeButton(label) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "lk-cite";
    b.textContent = (citeValue(label).unit === "page" ? "📄 " : "▶ ") + label;
    b.addEventListener("click", function () {
      var c = citeValue(label);
      post({ type: "seek", unit: c.unit, value: c.value });
    });
    return b;
  }
  function linkCitations(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentElement;
        if (!p || /^(SCRIPT|STYLE|CODE|PRE|TEXTAREA|BUTTON)$/.test(p.tagName) || p.closest(".katex")) return NodeFilter.FILTER_REJECT;
        CITE_RE.lastIndex = 0;
        return CITE_RE.test(n.data) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(function (n) {
      var frag = document.createDocumentFragment();
      var last = 0;
      n.data.replace(CITE_RE, function (whole, label, offset) {
        frag.appendChild(document.createTextNode(n.data.slice(last, offset)));
        frag.appendChild(citeButton(label));
        last = offset + whole.length;
        return whole;
      });
      frag.appendChild(document.createTextNode(n.data.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
  }

  // --- elements --------------------------------------------------------------------
  function label(el, text) {
    if (el.querySelector(":scope > .lk-label")) return;
    var l = document.createElement("div");
    l.className = "lk-label";
    l.textContent = el.getAttribute("title") || text;
    el.insertBefore(l, el.firstChild);
  }
  function button(text, cls, onClick) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "lk-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }

  var CALLOUT = { key: "핵심", tip: "팁", warn: "흔한 실수", example: "예시", note: "참고" };

  var builders = {
    "lk-hook": function (el) { label(el, "생각해 보기"); },
    "lk-callout": function (el) { label(el, CALLOUT[el.getAttribute("kind")] || "핵심"); },
    "lk-sandbox": function (el) { label(el, "직접 실험해 보기"); },

    "lk-reveal": function (el) {
      label(el, el.hasAttribute("write") ? "먼저 떠올려 보기" : "스스로 답해 보기");
      var hidden = document.createElement("div");
      hidden.className = "lk-hidden";
      var answerNodes = Array.prototype.filter.call(el.childNodes, function (n) { return !(n.classList && n.classList.contains("lk-label")); });
      var prompt = el.querySelector(":scope > lk-prompt");
      answerNodes.forEach(function (n) { if (n !== prompt) hidden.appendChild(n); });
      hidden.hidden = true;
      if (prompt) el.appendChild(prompt);
      var area;
      if (el.hasAttribute("write")) {
        area = document.createElement("textarea");
        area.className = "lk-input";
        area.rows = 2;
        area.placeholder = "보기 전에 내 말로 적어 보세요";
        el.appendChild(area);
      }
      var row = document.createElement("div");
      row.className = "lk-row";
      var b = button(el.getAttribute("button") || "답 보기", "primary", function () {
        hidden.hidden = false;
        b.remove();
        complete(el, area ? area.value.trim().length > 0 : true);
        typeset(hidden);
        resize();
      });
      row.appendChild(b);
      el.appendChild(row);
      el.appendChild(hidden);
      track(el);
    },

    "lk-quiz": function (el) {
      label(el, "확인 문제");
      var answer = num(el.getAttribute("answer"), 1) - 1; // 1-based in the markup
      var explain = el.querySelector(":scope > lk-explain");
      var opts = el.querySelectorAll(":scope > lk-option");
      var q = el.querySelector(":scope > lk-question");
      var list = document.createElement("div");
      list.className = "lk-options";
      var feedback = document.createElement("div");
      feedback.className = "lk-feedback";
      feedback.hidden = true;
      var buttons = [];
      Array.prototype.forEach.call(opts, function (o, i) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "lk-opt";
        b.innerHTML = "<span class=\"lk-key\">" + (i + 1) + "</span><span></span>";
        while (o.firstChild) b.lastChild.appendChild(o.firstChild);
        var why = o.getAttribute("why");
        b.addEventListener("click", function () {
          var right = i === answer;
          buttons.forEach(function (x, k) {
            x.disabled = true;
            if (k === answer) x.classList.add("correct");
          });
          if (!right) b.classList.add("wrong");
          feedback.hidden = false;
          feedback.className = "lk-feedback " + (right ? "good" : "bad");
          feedback.innerHTML = "<b>" + (right ? "정답이에요." : "아쉬워요. 정답은 " + (answer + 1) + "번이에요.") + "</b> ";
          if (!right && why) feedback.appendChild(document.createTextNode(why + " "));
          if (explain) {
            var d = document.createElement("div");
            d.innerHTML = explain.innerHTML;
            feedback.appendChild(d);
          }
          complete(el, right);
          typeset(feedback);
          linkCitations(feedback);
          resize();
        });
        buttons.push(b);
        list.appendChild(b);
        o.remove();
      });
      if (q) q.classList.add("lk-q");
      if (explain) explain.remove();
      el.appendChild(list);
      el.appendChild(feedback);
      track(el);
    },

    "lk-steps": function (el) {
      label(el, el.getAttribute("title") || "단계별로 따라가기");
      var steps = Array.prototype.slice.call(el.querySelectorAll(":scope > lk-step"));
      if (!steps.length) return;
      var stage = document.createElement("div");
      stage.className = "lk-stage";
      steps.forEach(function (s) { stage.appendChild(s); });
      el.appendChild(stage);
      var i = 0;
      var row = document.createElement("div");
      row.className = "lk-row";
      var prev = button("← 이전", "", function () { go(i - 1); });
      var next = button("다음 단계 →", "primary", function () { go(i + 1); });
      var all = button("전체 보기", "", function () {
        el.classList.toggle("all");
        all.textContent = el.classList.contains("all") ? "한 단계씩" : "전체 보기";
        resize();
      });
      var dots = document.createElement("div");
      dots.className = "lk-dots";
      steps.forEach(function () { dots.appendChild(document.createElement("span")); });
      row.appendChild(prev);
      row.appendChild(next);
      row.appendChild(all);
      row.appendChild(dots);
      el.appendChild(row);
      function go(k) {
        i = Math.max(0, Math.min(steps.length - 1, k));
        steps.forEach(function (s, n) {
          // a step stays visible once reached, so the derivation reads top to bottom
          s.classList.toggle("on", n <= i);
        });
        Array.prototype.forEach.call(dots.children, function (d, n) { d.classList.toggle("on", n <= i); });
        prev.disabled = i === 0;
        next.disabled = i === steps.length - 1;
        next.textContent = i === steps.length - 1 ? "끝" : "다음 단계 →";
        var cur = steps[i];
        var stepAnim = cur.getAttribute("set");
        if (stepAnim) stepAnim.split(";").forEach(function (pair) {
          var kv = pair.split("=");
          if (kv.length === 2) setVar(kv[0].trim(), evaluate(kv[1].trim()));
        });
        resize();
      }
      go(0);
    },

    "lk-blank": function (el) {
      var answers = (el.getAttribute("answer") || "").split("|").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      var tol = num(el.getAttribute("tolerance"), 0);
      var input = document.createElement("input");
      input.setAttribute("aria-label", el.getAttribute("hint") || "빈칸");
      input.placeholder = el.getAttribute("hint") || "?";
      input.style.width = Math.max(4, Math.min(16, (answers[0] || "").length + 3)) + "em";
      var mark = document.createElement("span");
      mark.className = "lk-mark";
      el.textContent = "";
      el.appendChild(input);
      el.appendChild(mark);
      var check = function () {
        var v = input.value.trim().toLowerCase().replace(/\s+/g, " ");
        if (!v) return;
        var n = parseFloat(v);
        var ok = answers.some(function (a) {
          var an = parseFloat(a);
          if (isFinite(n) && isFinite(an) && /^[-+.\d\se]+$/.test(a)) return Math.abs(n - an) <= (tol || Math.abs(an) * 1e-6 + 1e-9);
          return a.replace(/\s+/g, " ") === v;
        });
        el.classList.toggle("right", ok);
        el.classList.toggle("wrong", !ok);
        mark.textContent = ok ? "✓" : "✗";
        mark.title = ok ? "" : "정답: " + answers[0];
        if (ok) complete(el, true);
      };
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") check(); });
      input.addEventListener("blur", check);
      track(el);
    },

    "lk-var": function (el) {
      var name = el.getAttribute("name") || "x";
      var min = num(el.getAttribute("min"), 0), max = num(el.getAttribute("max"), 10);
      var step = num(el.getAttribute("step"), (max - min) / 100);
      var value = num(el.getAttribute("value"), min);
      var digits = el.hasAttribute("digits") ? num(el.getAttribute("digits"), 2) : null;
      var lab = document.createElement("label");
      lab.textContent = el.getAttribute("label") || name;
      var range = document.createElement("input");
      range.type = "range";
      range.min = min;
      range.max = max;
      range.step = step;
      range.value = value;
      var out = document.createElement("output");
      el.textContent = "";
      el.appendChild(lab);
      el.appendChild(range);
      el.appendChild(out);
      var show = function () { out.textContent = fmt(+range.value, digits) + (el.getAttribute("unit") || ""); };
      range.addEventListener("input", function () { show(); setVar(name, +range.value); });
      vars[name] = value;
      show();
      onVars(function () {
        if (+range.value !== vars[name]) {
          range.value = vars[name];
          show();
        }
      });
    },

    "lk-out": function (el) {
      var expr = el.getAttribute("expr") || el.textContent;
      var digits = el.hasAttribute("digits") ? num(el.getAttribute("digits"), 2) : null;
      onVars(function () { el.textContent = fmt(evaluate(expr), digits) + (el.getAttribute("unit") || ""); });
    },

    "lk-plot": function (el) {
      var series = Array.prototype.map.call(el.querySelectorAll(":scope > lk-series"), function (s, i) {
        return { expr: s.getAttribute("expr") || "0", label: s.getAttribute("label") || "", color: s.getAttribute("color") || ["var(--accent)", "#e0794b", "#2f8f5b", "#b7791f"][i % 4] };
      });
      var points = Array.prototype.map.call(el.querySelectorAll(":scope > lk-point"), function (p) {
        return { x: p.getAttribute("x") || "0", y: p.getAttribute("y") || "0", label: p.getAttribute("label") || "" };
      });
      if (!series.length && el.getAttribute("expr")) series.push({ expr: el.getAttribute("expr"), label: "", color: "var(--accent)" });
      var xr = (el.getAttribute("x") || "-5,5").split(",").map(Number);
      var yr = (el.getAttribute("y") || "auto").split(",").map(Number);
      var W = 640, H = num(el.getAttribute("height"), 300), P = 34;
      var cap = el.getAttribute("title");
      el.textContent = "";
      if (cap) label(el, cap);
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 " + W + " " + H);
      el.appendChild(svg);
      onVars(function () {
        var N = 220, data = series.map(function (s) {
          var pts = [];
          for (var k = 0; k <= N; k++) {
            var x = xr[0] + ((xr[1] - xr[0]) * k) / N;
            pts.push([x, evaluate(s.expr, { x: x })]);
          }
          return pts;
        });
        var lo = yr[0], hi = yr[1];
        if (!isFinite(lo) || !isFinite(hi)) {
          var ys = [];
          data.forEach(function (d) { d.forEach(function (p) { if (isFinite(p[1])) ys.push(p[1]); }); });
          lo = ys.length ? Math.min.apply(null, ys) : -1;
          hi = ys.length ? Math.max.apply(null, ys) : 1;
          if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
          var pad = (hi - lo) * 0.08;
          lo -= pad;
          hi += pad;
        }
        var sx = function (x) { return P + ((x - xr[0]) / (xr[1] - xr[0])) * (W - 2 * P); };
        var sy = function (y) { return H - P + 6 - ((y - lo) / (hi - lo)) * (H - 2 * P); };
        var html = "";
        for (var g = 0; g <= 4; g++) {
          var gx = xr[0] + ((xr[1] - xr[0]) * g) / 4, gy = lo + ((hi - lo) * g) / 4;
          html += "<line class='grid' x1='" + sx(gx) + "' x2='" + sx(gx) + "' y1='" + sy(lo) + "' y2='" + sy(hi) + "'/>";
          html += "<line class='grid' x1='" + sx(xr[0]) + "' x2='" + sx(xr[1]) + "' y1='" + sy(gy) + "' y2='" + sy(gy) + "'/>";
          html += "<text class='tick' x='" + sx(gx) + "' y='" + (H - 8) + "' text-anchor='middle'>" + fmt(gx, 2) + "</text>";
          html += "<text class='tick' x='4' y='" + (sy(gy) + 4) + "'>" + fmt(gy, 2) + "</text>";
        }
        if (lo < 0 && hi > 0) html += "<line class='axis' x1='" + sx(xr[0]) + "' x2='" + sx(xr[1]) + "' y1='" + sy(0) + "' y2='" + sy(0) + "'/>";
        if (xr[0] < 0 && xr[1] > 0) html += "<line class='axis' x1='" + sx(0) + "' x2='" + sx(0) + "' y1='" + sy(lo) + "' y2='" + sy(hi) + "'/>";
        data.forEach(function (d, i) {
          var path = "", pen = false;
          d.forEach(function (p) {
            if (!isFinite(p[1]) || p[1] < lo - (hi - lo) || p[1] > hi + (hi - lo)) { pen = false; return; }
            path += (pen ? "L" : "M") + sx(p[0]).toFixed(1) + " " + sy(p[1]).toFixed(1);
            pen = true;
          });
          html += "<path d='" + path + "' fill='none' stroke='" + esc(series[i].color) + "' stroke-width='2.5' stroke-linejoin='round'/>";
          if (series[i].label) html += "<text class='legend' x='" + (W - P - 4) + "' y='" + (P + i * 16) + "' text-anchor='end' fill='" + esc(series[i].color) + "'>" + esc(series[i].label) + "</text>";
        });
        points.forEach(function (p) {
          var x = evaluate(p.x), y = evaluate(p.y);
          if (!isFinite(x) || !isFinite(y)) return;
          html += "<circle cx='" + sx(x) + "' cy='" + sy(y) + "' r='5.5' fill='#e0794b' stroke='var(--surface)' stroke-width='2'/>";
          if (p.label) html += "<text class='legend' x='" + (sx(x) + 8) + "' y='" + (sy(y) - 8) + "'>" + esc(p.label) + "</text>";
        });
        svg.innerHTML = html;
      });
    },

    "lk-canvas": function (el) {
      var cap = el.getAttribute("title");
      if (cap) label(el, cap);
      var canvas = document.createElement("canvas");
      var W = num(el.getAttribute("width"), 640), H = num(el.getAttribute("height"), 320);
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      el.appendChild(canvas);
      var row = document.createElement("div");
      row.className = "lk-row";
      el.appendChild(row);
      el.__lk = { canvas: canvas, W: W, H: H, dpr: dpr, row: row };
    },

    "lk-sort": function (el) {
      label(el, el.getAttribute("title") || "순서 맞추기");
      var items = Array.prototype.map.call(el.querySelectorAll(":scope > lk-item"), function (it, i) { return { html: it.innerHTML, i: i }; });
      Array.prototype.forEach.call(el.querySelectorAll(":scope > lk-item"), function (n) { n.remove(); });
      var shuffled = items.slice();
      for (var k = shuffled.length - 1; k > 0; k--) {
        var j = Math.floor(Math.random() * (k + 1));
        var t = shuffled[k]; shuffled[k] = shuffled[j]; shuffled[j] = t;
      }
      if (shuffled.every(function (x, n) { return x.i === n; }) && shuffled.length > 1) shuffled.push(shuffled.shift());
      var ol = document.createElement("ol");
      shuffled.forEach(function (x) {
        var li = document.createElement("li");
        li.dataset.i = x.i;
        li.innerHTML = "<span class='lk-grip'>⠿</span><span>" + x.html + "</span>";
        ol.appendChild(li);
      });
      el.appendChild(ol);
      var dragging = null;
      ol.addEventListener("pointerdown", function (e) {
        var li = e.target.closest("li");
        if (!li) return;
        dragging = li;
        li.classList.add("dragging");
        li.setPointerCapture(e.pointerId);
        Array.prototype.forEach.call(ol.children, function (c) { c.classList.remove("ok", "no"); });
      });
      ol.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var over = document.elementFromPoint(e.clientX, e.clientY);
        var li = over && over.closest("li");
        if (!li || li === dragging || li.parentNode !== ol) return;
        var r = li.getBoundingClientRect();
        ol.insertBefore(dragging, e.clientY > r.top + r.height / 2 ? li.nextSibling : li);
      });
      var drop = function () { if (dragging) { dragging.classList.remove("dragging"); dragging = null; } };
      ol.addEventListener("pointerup", drop);
      ol.addEventListener("pointercancel", drop);
      var row = document.createElement("div");
      row.className = "lk-row";
      row.appendChild(button("확인", "primary", function () {
        var ok = true;
        Array.prototype.forEach.call(ol.children, function (li, n) {
          var good = +li.dataset.i === n;
          ok = ok && good;
          li.classList.toggle("ok", good);
          li.classList.toggle("no", !good);
        });
        if (ok) complete(el, true);
      }));
      el.appendChild(row);
      track(el);
    },

    "lk-flip": function (el) {
      var front = el.querySelector(":scope > lk-front"), back = el.querySelector(":scope > lk-back");
      var inner = document.createElement("div");
      inner.className = "lk-inner";
      var f = document.createElement("div"), b = document.createElement("div");
      f.className = "lk-face";
      b.className = "lk-face lk-back";
      f.innerHTML = "<div class='lk-label'>카드 · 눌러서 뒤집기</div>" + (front ? front.innerHTML : "");
      b.innerHTML = back ? back.innerHTML : "";
      inner.appendChild(f);
      inner.appendChild(b);
      el.textContent = "";
      el.appendChild(inner);
      el.tabIndex = 0;
      var flip = function () { el.classList.toggle("flipped"); };
      el.addEventListener("click", flip);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
      requestAnimationFrame(function () {
        inner.style.minHeight = Math.max(f.scrollHeight, b.scrollHeight, 110) + "px";
        resize();
      });
    },

    "lk-cite": function (el) {
      var at = el.getAttribute("at") || el.textContent.trim();
      var lbl = /^\d+$/.test(at) && UNIT === "page" ? "p." + at : at;
      el.replaceWith(citeButton(lbl));
    },
  };

  // --- public API for page scripts -----------------------------------------------------
  /** LK.canvas("id", function (ctx, s) { ... }) draws every frame; s = { t, dt, w, h, vars, playing }. */
  var built = false, pending = [];
  function ready(fn) {
    if (built) { try { fn(); } catch (e) { post({ type: "error", message: String(e.message || e) }); } }
    else pending.push(fn);
  }
  window.LK = {
    vars: vars,
    set: setVar,
    eval: evaluate,
    /** run after the kit has built the page's elements */
    ready: ready,
    canvas: function (id, draw, opts) {
      if (!built) return ready(function () { window.LK.canvas(id, draw, opts); });
      var host = document.getElementById(id);
      if (!host || !host.__lk) return;
      var c = host.__lk, ctx = c.canvas.getContext("2d");
      var playing = !(opts && opts.paused), t = 0, last = 0;
      var toggle = button(playing ? "일시정지" : "재생", "", function () {
        playing = !playing;
        toggle.textContent = playing ? "일시정지" : "재생";
        if (playing) { last = 0; requestAnimationFrame(frame); }
      });
      var reset = button("처음부터", "", function () { t = 0; once(); });
      c.row.appendChild(toggle);
      c.row.appendChild(reset);
      function once() {
        ctx.setTransform(c.dpr, 0, 0, c.dpr, 0, 0);
        ctx.clearRect(0, 0, c.W, c.H);
        try {
          draw(ctx, { t: t, dt: 0, w: c.W, h: c.H, vars: vars, playing: playing, color: getComputedStyle(document.documentElement) });
        } catch (e) {
          playing = false;
          host.insertAdjacentHTML("beforeend", "<div class='lk-error'>애니메이션 오류: " + esc(e.message) + "</div>");
        }
      }
      function frame(now) {
        if (!playing) return;
        var dt = last ? Math.min(0.05, (now - last) / 1000) : 0;
        last = now;
        t += dt;
        once();
        requestAnimationFrame(frame);
      }
      onVars(function () { if (!playing) once(); });
      if (playing) requestAnimationFrame(frame);
      else once();
    },
    css: function (name) { return getComputedStyle(document.documentElement).getPropertyValue("--" + name).trim(); },
  };

  // --- boot ------------------------------------------------------------------------------
  function typeset(root) {
    if (window.renderMathInElement) {
      try {
        window.renderMathInElement(root, {
          delimiters: [
            { left: "$$", right: "$$", display: true },
            { left: "\\[", right: "\\]", display: true },
            { left: "$", right: "$", display: false },
            { left: "\\(", right: "\\)", display: false },
          ],
          throwOnError: false,
          ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option", "input"],
        });
      } catch (e) {}
    }
  }

  var lastH = 0;
  function resize() {
    var h = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(h - lastH) > 1) {
      lastH = h;
      post({ type: "height", height: h });
    }
  }

  function build() {
    // inner elements first, so a quiz inside a step is ready when the step is built
    var order = ["lk-cite", "lk-blank", "lk-var", "lk-out", "lk-plot", "lk-canvas", "lk-quiz", "lk-reveal", "lk-sort", "lk-flip", "lk-steps", "lk-hook", "lk-callout", "lk-sandbox"];
    order.forEach(function (tag) {
      Array.prototype.forEach.call(document.querySelectorAll(tag), function (el) {
        try {
          builders[tag](el);
        } catch (e) {
          el.insertAdjacentHTML("beforeend", "<div class='lk-error'>" + esc(tag) + " 표시 오류: " + esc(e.message) + "</div>");
        }
      });
    });
    typeset(document.body);
    linkCitations(document.body);
    built = true;
    pending.splice(0).forEach(ready);
    resize();
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (d && d.lk && d.type === "theme") document.documentElement.classList.toggle("dark", !!d.dark);
  });
  window.addEventListener("error", function (e) { post({ type: "error", message: String(e.message || e) }); });
  new ResizeObserver(resize).observe(document.documentElement);
  window.addEventListener("load", resize);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", build);
  else build();
})();
