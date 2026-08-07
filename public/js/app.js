/* IndexMePlease - front-end helpers (no external dependencies) */
(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";

  /* ----------------------------------------------------------- theme */

  const storedTheme = localStorage.getItem("imp-theme");
  if (storedTheme) document.documentElement.setAttribute("data-theme", storedTheme);

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("imp-theme", next);
    document.querySelectorAll("[data-chart]").forEach(renderChart);
  }

  /* ----------------------------------------------------------- flashes */

  function initFlashes() {
    document.querySelectorAll(".flash").forEach((el) => {
      const close = el.querySelector("button");
      if (close) close.addEventListener("click", () => el.remove());
      setTimeout(() => {
        el.style.transition = "opacity .3s, transform .3s";
        el.style.opacity = "0";
        el.style.transform = "translateX(20px)";
        setTimeout(() => el.remove(), 320);
      }, 7000);
    });
  }

  /* ------------------------------------------------------ bulk selection */

  function initBulkSelect() {
    document.querySelectorAll("[data-select-all]").forEach((master) => {
      const scope = document.querySelector(master.dataset.selectAll);
      if (!scope) return;
      const boxes = () => scope.querySelectorAll('input[type="checkbox"][name="url_ids"]');

      master.addEventListener("change", () => {
        boxes().forEach((box) => {
          box.checked = master.checked;
        });
        updateBulkBar(scope);
      });
      scope.addEventListener("change", (event) => {
        if (event.target.name === "url_ids") updateBulkBar(scope);
      });
      updateBulkBar(scope);
    });
  }

  function updateBulkBar(scope) {
    const selected = scope.querySelectorAll('input[name="url_ids"]:checked').length;
    document.querySelectorAll("[data-bulk-count]").forEach((el) => {
      el.textContent = selected;
    });
    document.querySelectorAll("[data-bulk-bar]").forEach((bar) => {
      bar.classList.toggle("hidden", selected === 0);
    });
  }

  /* ------------------------------------------------------------ confirm */

  function initConfirms() {
    document.querySelectorAll("[data-confirm]").forEach((el) => {
      el.addEventListener("submit", (event) => {
        if (!window.confirm(el.dataset.confirm)) event.preventDefault();
      });
      if (el.tagName === "A" || el.tagName === "BUTTON") {
        el.addEventListener("click", (event) => {
          if (el.form) return;
          if (!window.confirm(el.dataset.confirm)) event.preventDefault();
        });
      }
    });
  }

  /* -------------------------------------------------------- busy buttons */

  function initSubmitStates() {
    document.querySelectorAll("form[data-busy]").forEach((form) => {
      form.addEventListener("submit", () => {
        const button = form.querySelector('button[type="submit"], button:not([type])');
        if (!button || button.dataset.noBusy) return;
        button.disabled = true;
        button.insertAdjacentHTML("afterbegin", '<span class="spinner"></span> ');
      });
    });
  }

  /* -------------------------------------------------------------- charts */

  function chartColors() {
    const style = getComputedStyle(document.documentElement);
    return {
      brand: style.getPropertyValue("--brand").trim() || "#5b5bd6",
      ok: style.getPropertyValue("--ok").trim() || "#12805c",
      warn: style.getPropertyValue("--warn").trim() || "#a1620b",
      bad: style.getPropertyValue("--bad").trim() || "#c62a45",
      info: style.getPropertyValue("--info").trim() || "#1f6fb2",
      border: style.getPropertyValue("--border").trim() || "#e6e8f0",
      faint: style.getPropertyValue("--text-faint").trim() || "#8b91a8",
    };
  }

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    Object.entries(attrs || {}).forEach(([key, value]) => node.setAttribute(key, value));
    if (parent) parent.appendChild(node);
    return node;
  }

  function renderChart(host) {
    let config;
    try {
      config = JSON.parse(host.dataset.chart);
    } catch (err) {
      return;
    }
    host.innerHTML = "";
    if (config.type === "donut") return renderDonut(host, config);
    return renderArea(host, config);
  }

  function renderArea(host, config) {
    const colors = chartColors();
    const width = host.clientWidth || 640;
    const height = config.height || 220;
    const padding = { top: 14, right: 12, bottom: 26, left: 40 };
    const series = config.series || [];
    const labels = config.labels || [];
    const points = labels.length;

    const svg = el("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, height }, host);
    if (!points) return;

    const maxValue = Math.max(
      1,
      ...series.flatMap((s) => s.data.map((v) => Number(v) || 0))
    );
    const niceMax = niceCeil(maxValue);
    const plotW = width - padding.left - padding.right;
    const plotH = height - padding.top - padding.bottom;
    const xAt = (i) => padding.left + (points === 1 ? plotW / 2 : (i / (points - 1)) * plotW);
    const yAt = (v) => padding.top + plotH - (Math.max(0, v) / niceMax) * plotH;

    for (let i = 0; i <= 4; i += 1) {
      const y = padding.top + (i / 4) * plotH;
      el("line", {
        x1: padding.left, x2: width - padding.right, y1: y, y2: y,
        stroke: colors.border, "stroke-width": 1,
      }, svg);
      const label = el("text", {
        x: padding.left - 8, y: y + 4, "text-anchor": "end",
        "font-size": 10, fill: colors.faint,
      }, svg);
      label.textContent = formatShort(Math.round(niceMax * (1 - i / 4)));
    }

    series.forEach((s, index) => {
      const color = colors[s.color] || s.color || colors.brand;
      const gradientId = `grad-${Math.random().toString(36).slice(2, 9)}`;
      const defs = el("defs", {}, svg);
      const gradient = el("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
      el("stop", { offset: "0%", "stop-color": color, "stop-opacity": 0.28 }, gradient);
      el("stop", { offset: "100%", "stop-color": color, "stop-opacity": 0.02 }, gradient);

      const line = s.data.map((v, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
      if (s.fill !== false && index === 0) {
        const area = `${line} L${xAt(points - 1).toFixed(1)},${padding.top + plotH} L${xAt(0).toFixed(1)},${padding.top + plotH} Z`;
        el("path", { d: area, fill: `url(#${gradientId})` }, svg);
      }
      el("path", {
        d: line, fill: "none", stroke: color, "stroke-width": 2.2,
        "stroke-linejoin": "round", "stroke-linecap": "round",
      }, svg);

      s.data.forEach((v, i) => {
        if (points <= 40 || i === points - 1) {
          const dot = el("circle", { cx: xAt(i), cy: yAt(v), r: i === points - 1 ? 3.6 : 2.2, fill: color }, svg);
          const title = el("title", {}, dot);
          title.textContent = `${labels[i]} — ${s.name}: ${v}`;
        }
      });
    });

    const maxLabels = Math.max(2, Math.floor(plotW / 52));
    const step = Math.max(1, Math.ceil(points / maxLabels));
    const minGap = plotW / (maxLabels + 0.5);
    let lastLabelX = -Infinity;
    labels.forEach((label, i) => {
      const isLast = i === points - 1;
      if (i % step !== 0 && !isLast) return;
      const x = xAt(i);
      if (x - lastLabelX < minGap && !isLast) return;
      if (isLast && x - lastLabelX < minGap) {
        svg.lastElementChild.remove();
      }
      lastLabelX = x;
      const text = el("text", {
        x, y: height - 7, "text-anchor": "middle", "font-size": 10, fill: colors.faint,
      }, svg);
      text.textContent = shortDate(label);
    });
  }

  function renderDonut(host, config) {
    const colors = chartColors();
    const size = config.size || 170;
    const stroke = 20;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const data = (config.data || []).filter((d) => d.value > 0);
    const total = data.reduce((sum, d) => sum + d.value, 0);

    const svg = el("svg", {
      class: "chart", width: size, height: size, viewBox: `0 0 ${size} ${size}`,
      style: `flex:0 0 ${size}px`,
    }, host);
    const group = el("g", { transform: `rotate(-90 ${size / 2} ${size / 2})` }, svg);

    el("circle", {
      cx: size / 2, cy: size / 2, r: radius, fill: "none",
      stroke: colors.border, "stroke-width": stroke,
    }, group);

    let offset = 0;
    data.forEach((slice) => {
      const fraction = slice.value / total;
      const arc = el("circle", {
        cx: size / 2, cy: size / 2, r: radius, fill: "none",
        stroke: colors[slice.color] || slice.color || colors.brand,
        "stroke-width": stroke,
        "stroke-dasharray": `${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`,
        "stroke-dashoffset": (-offset * circumference).toFixed(2),
      }, group);
      const title = el("title", {}, arc);
      title.textContent = `${slice.label}: ${slice.value}`;
      offset += fraction;
    });

    const center = el("text", {
      x: size / 2, y: size / 2 - 2, "text-anchor": "middle",
      "font-size": 24, "font-weight": 700, fill: "currentColor",
    }, svg);
    center.textContent = formatShort(total);
    const caption = el("text", {
      x: size / 2, y: size / 2 + 16, "text-anchor": "middle",
      "font-size": 10.5, fill: colors.faint,
    }, svg);
    caption.textContent = config.caption || "URL-i";
  }

  function niceCeil(value) {
    const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
    return Math.ceil(value / magnitude) * magnitude;
  }

  function formatShort(value) {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return String(value);
  }

  function shortDate(iso) {
    const parts = String(iso).split("-");
    return parts.length === 3 ? `${parts[2]}.${parts[1]}` : iso;
  }

  /* ------------------------------------------------------- task polling */

  function initTaskPolling() {
    const indicator = document.querySelector("[data-task-indicator]");
    if (!indicator) return;

    const poll = () => {
      fetch("/api/tasks", { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then((response) => (response.ok ? response.json() : null))
        .then((data) => {
          if (!data || typeof data.busy !== "boolean") return;
          // Tylko aktualizuj badge — NIE reloaduj strony.
          // Na Hostingerze jest kilka instancji Node; runningTasks() jest
          // w pamieci procesu, wiec busy miga true/false i reload robil petle.
          indicator.classList.toggle("hidden", !data.busy);
          if (data.busy) {
            indicator.dataset.busy = "1";
          } else {
            indicator.dataset.busy = "0";
          }
        })
        .catch(() => {});
    };
    setInterval(poll, 8000);
    poll();
  }

  /* ---------------------------------------------------------- clipboard */

  function initCopy() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", () => {
        const value = button.dataset.copy;
        navigator.clipboard.writeText(value).then(() => {
          const original = button.textContent;
          button.textContent = "Skopiowano";
          setTimeout(() => {
            button.textContent = original;
          }, 1500);
        });
      });
    });
  }

  /* ------------------------------------------------------------- drawer */

  function initDrawer() {
    const toggle = document.querySelector("[data-nav-toggle]");
    if (toggle) {
      toggle.addEventListener("click", () => document.body.classList.toggle("nav-open"));
    }
    document.addEventListener("click", (event) => {
      if (!document.body.classList.contains("nav-open")) return;
      if (event.target.closest(".sidebar") || event.target.closest("[data-nav-toggle]")) return;
      document.body.classList.remove("nav-open");
    });
  }

  /* --------------------------------------------------------- url counter */

  function initUrlCounter() {
    document.querySelectorAll("[data-url-counter]").forEach((textarea) => {
      const output = document.querySelector(textarea.dataset.urlCounter);
      if (!output) return;
      const update = () => {
        const count = textarea.value
          .split(/[\s,]+/)
          .filter((token) => token.trim().length > 3).length;
        output.textContent = count;
      };
      textarea.addEventListener("input", update);
      update();
    });
  }

  /* ---------------------------------------------------------------- init */

  document.addEventListener("DOMContentLoaded", () => {
    const themeButton = document.querySelector("[data-theme-toggle]");
    if (themeButton) themeButton.addEventListener("click", toggleTheme);

    initFlashes();
    initBulkSelect();
    initConfirms();
    initSubmitStates();
    initTaskPolling();
    initCopy();
    initDrawer();
    initUrlCounter();
    document.querySelectorAll("[data-chart]").forEach(renderChart);

    let resizeTimer;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        document.querySelectorAll("[data-chart]").forEach(renderChart);
      }, 180);
    });
  });
})();
