(() => {
  "use strict";

  const charts = {};
  let svgUid = 1;
  let currentTab = "summary";
  let overviewCache = null;
  let dayCache = null;
  let summaryRenderedRef = null;
  let browseRenderedRef = null;
  let allHealthRenderedRef = null;
  let proInsightsRenderedRef = null;
  let proInsightsRenderedTab = "";
  let workoutsRenderedKey = "";
  let dayRenderedDate = "";
  const metricQueryCache = new Map();
  const workoutQueryCache = new Map();
  const workoutsListCache = new Map();
  const daySnapshotCache = new Map();
  const metricInflight = new Map();
  const workoutInflight = new Map();
  const workoutsListInflight = new Map();
  const daySnapshotInflight = new Map();
  let proInsightsInflight = null;
  let preloadEpoch = 0;
  let preloadQueue = [];
  const preloadScheduledKeys = new Set();
  let preloadRunning = false;
  let preloadResumeTimer = null;
  let preloadWakeFn = null;
  let lastUserInputAt = performance.now();
  let firstOverviewPaintAt = null;
  function cacheMapSet(map, key, val, maxSize = 24) {
    if (map.has(key)) map.delete(key);
    map.set(key, val);
    while (map.size > maxSize) {
      map.delete(map.keys().next().value);
    }
  }
  function invalidateViewRenderCaches({ clearData = true } = {}) {
    summaryRenderedRef = null;
    browseRenderedRef = null;
    allHealthRenderedRef = null;
    proInsightsRenderedRef = null;
    proInsightsRenderedTab = "";
    workoutsRenderedKey = "";
    dayRenderedDate = "";
    if (clearData) {
      metricQueryCache.clear();
      workoutQueryCache.clear();
      workoutsListCache.clear();
      daySnapshotCache.clear();
      metricInflight.clear();
      workoutInflight.clear();
      workoutsListInflight.clear();
      daySnapshotInflight.clear();
      proInsightsInflight = null;
      preloadEpoch += 1;
      preloadQueue = [];
      preloadScheduledKeys.clear();
      clearTimeout(preloadResumeTimer);
      preloadResumeTimer = null;
      if (preloadWakeFn) {
        const wake = preloadWakeFn;
        preloadWakeFn = null;
        wake();
      }
    }
  }
  const markPreloadUserInput = () => {
    lastUserInputAt = performance.now();
  };
  window.addEventListener("pointerdown", markPreloadUserInput, { passive: true });
  window.addEventListener("scroll", markPreloadUserInput, { passive: true });

  function isPreloadPaused() {
    return Boolean(
      activeCt ||
      restoringNavigation ||
      localSyncState.busy ||
      document.hidden ||
      (firstOverviewPaintAt !== null && performance.now() - firstOverviewPaintAt < 1800) ||
      (performance.now() - lastUserInputAt < 650)
    );
  }

  function resumeSecondaryPreload() {
    // A paused queue still needs its scheduled wake-up after input or sync.
    if (isPreloadPaused()) return;
    if (preloadResumeTimer) {
      clearTimeout(preloadResumeTimer);
      preloadResumeTimer = null;
    }
    if (preloadWakeFn && !isPreloadPaused()) {
      const wake = preloadWakeFn;
      preloadWakeFn = null;
      wake();
    } else if (!preloadRunning && preloadQueue.length && !isPreloadPaused()) {
      drainPreloadQueue();
    }
  }

  function waitForPreloadSlot(epoch) {
    return new Promise((resolve) => {
      const finish = (ok) => {
        preloadWakeFn = null;
        if (preloadResumeTimer) {
          clearTimeout(preloadResumeTimer);
          preloadResumeTimer = null;
        }
        resolve(ok);
      };
      const probe = () => {
        if (epoch !== preloadEpoch) {
          finish(false);
          return;
        }
        if (isPreloadPaused()) {
          preloadWakeFn = probe;
          preloadResumeTimer = setTimeout(probe, 320);
          return;
        }
        if (typeof window.requestIdleCallback === "function") {
          window.requestIdleCallback(() => {
            if (epoch !== preloadEpoch) finish(false);
            else if (isPreloadPaused()) probe();
            else finish(true);
          }, { timeout: 450 });
        } else {
          preloadResumeTimer = setTimeout(() => {
            if (epoch !== preloadEpoch) finish(false);
            else if (isPreloadPaused()) probe();
            else finish(true);
          }, 60);
        }
      };
      probe();
    });
  }

  function enqueuePreloadTask(key, fn, { high = false } = {}) {
    if (!key || typeof fn !== "function" || preloadScheduledKeys.has(key)) return;
    preloadScheduledKeys.add(key);
    const task = { key, fn };
    if (high) preloadQueue.unshift(task);
    else preloadQueue.push(task);
    if (!preloadRunning) drainPreloadQueue();
  }

  async function drainPreloadQueue() {
    if (preloadRunning) return;
    preloadRunning = true;
    try {
      while (preloadQueue.length) {
        const epoch = preloadEpoch;
        const ok = await waitForPreloadSlot(epoch);
        if (!ok || epoch !== preloadEpoch) continue;
        const task = preloadQueue.shift();
        if (!task) continue;
        try {
          await task.fn(epoch);
        } catch (_) {}
        if (epoch !== preloadEpoch) continue;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      preloadRunning = false;
      if (preloadQueue.length && !isPreloadPaused()) {
        drainPreloadQueue();
      }
    }
  }

  function queueMetricPreload(metric, scope, { endDate = "", ecgId = "", high = false } = {}) {
    const norm = normalizeTemperatureMetric(metric);
    const effScope = scope || defaultMetricScope(norm);
    const state = { metric: norm, scope: effScope, endDate: endDate || "", ecgId: ecgId || "" };
    const key = metricQueryKey(state);
    if (metricQueryCache.has(key)) return;
    enqueuePreloadTask(`m:${key}`, async (epoch) => {
      if (epoch !== preloadEpoch || metricQueryCache.has(key)) return;
      const d = await fetchMetricData(state);
      if (epoch === preloadEpoch && norm === "ecg" && d?.records?.length) {
        queueEcgRecordPreloads(d.records, 4, false);
      }
    }, { high });
  }

  function queueWorkoutPreload(wid, { high = false } = {}) {
    const idStr = wid != null ? String(wid) : "";
    if (!idStr || workoutQueryCache.has(idStr)) return;
    enqueuePreloadTask(`w:${idStr}`, async (epoch) => {
      if (epoch !== preloadEpoch || workoutQueryCache.has(idStr)) return;
      await fetchWorkoutData(wid);
    }, { high });
  }

  function queueEcgRecordPreloads(records, limit = 4, high = false) {
    (records || []).slice(0, limit).forEach((rec) => {
      if (rec?.start_ms != null) {
        queueMetricPreload("ecg_record", "W", { endDate: "", ecgId: String(rec.start_ms), high });
      }
    });
  }

  function queueDayStripPreloads(dateStr) {
    const metrics = ["steps", "heart_rate", "hrv", "spo2", "stress"];
    const targetDate = dateStr || "";
    metrics.forEach((m) => queueMetricPreload(m, "D", { endDate: targetDate }));
  }

  function scheduleHiddenDomPrewarm() {
    enqueuePreloadTask("dom:all-health", async (epoch) => {
      if (epoch !== preloadEpoch || allHealthOpen) return;
      if (overviewCache && !overviewCache.empty && allHealthRenderedRef !== overviewCache) {
        renderAllHealthView(overviewCache);
      }
    }, { high: true });
    enqueuePreloadTask("dom:pro-insights", async (epoch) => {
      if (epoch !== preloadEpoch || proInsightsOpen) return;
      if (proInsightsCache && !proInsightsCache.empty && proInsightsRenderedRef !== proInsightsCache) {
        proInsightsTab = "load";
        renderProInsightsView(proInsightsCache);
      }
    }, { high: true });
  }

  // Begin the exact pending request on contact so the click can reuse it.
  document.addEventListener("pointerdown", event => {
    if (!event.isPrimary || event.button !== 0 || activeCt || restoringNavigation) return;
    const card = event.target.closest?.("[data-metric], [data-wid], [data-ecg-id], #summary-readiness-card, #browse-pro-insights-btn");
    if (!card || !card.closest(".main-content")) return;
    if (card.dataset.wid) {
      fetchWorkoutData(card.dataset.wid).catch(() => {});
    } else if (card.matches("#summary-readiness-card, #browse-pro-insights-btn")) {
      fetchProInsightsData().catch(() => {});
    } else {
      const metric = normalizeTemperatureMetric(card.dataset.ecgId ? "ecg_record" : card.dataset.metric);
      const day = card.matches(".day-tile");
      const scope = day ? "D" : card.matches(".trend-card") ? "M" :
        card.matches(".vitals-row") ? (metric === "sleep" ? "D" : "W") :
        card.dataset.scope || defaultMetricScope(metric);
      fetchMetricData({ metric, scope, endDate: day ? selectedDay : card.dataset.endDate,
        ecgId: card.dataset.ecgId }).catch(() => {});
    }
  }, { passive: true, capture: true });

  function scheduleSecondaryPreload(data) {
    if (!data || data.empty) return;
    preloadQueue = [];
    preloadScheduledKeys.clear();
    const refDate = data.latest_day?.date || data.window?.end_date || "";
    const slpDate = data.latest_night_sleep?.date || refDate;

    // The two primary cards are visible immediately. Warm their dated keys
    // without waiting for the idle queue that also builds hidden DOM.
    for (const [metric, endDate] of [["activity", refDate], ["sleep", slpDate]]) {
      fetchMetricData({ metric, scope: "D", endDate }).catch(() => {});
    }

    // Stage 1: Primary Level-2 Summary Cards & Hidden DOM Pre-render
    enqueuePreloadTask("dom:all-health", async (epoch) => {
      if (epoch !== preloadEpoch || allHealthOpen) return;
      if (overviewCache && !overviewCache.empty && allHealthRenderedRef !== overviewCache) {
        renderAllHealthView(overviewCache);
      }
    });
    queueMetricPreload("activity", "D", { endDate: "" });
    if (refDate) queueMetricPreload("activity", "D", { endDate: refDate });
    queueMetricPreload("sleep", "D", { endDate: "" });
    if (slpDate) queueMetricPreload("sleep", "D", { endDate: slpDate });

    enqueuePreloadTask("pro:insights", async (epoch) => {
      if (epoch !== preloadEpoch) return;
      const d = await fetchProInsightsData();
      if (epoch !== preloadEpoch || !d || d.empty) return;
      if (!proInsightsOpen && proInsightsRenderedRef !== d) {
        proInsightsTab = "load";
        renderProInsightsView(d);
      }
      (d.aerobic_lab?.ef_series || []).slice(-3).reverse().forEach((r) => queueWorkoutPreload(r.workout_id));
    });

    ["heart_rate", "hrv", "spo2", "temperature"].forEach((m) => queueMetricPreload(m, "W", { endDate: "" }));
    document.querySelectorAll("#summary-cards-grid .metric-card").forEach((el) => {
      if (el.dataset.metric) {
        queueMetricPreload(el.dataset.metric, el.dataset.scope || defaultMetricScope(el.dataset.metric), { endDate: "" });
      }
    });
    (data.recent_workouts || []).slice(0, 3).forEach((w) => queueWorkoutPreload(w.workout_id));

    // Stage 2: Remaining Level-2 Cards & Tab Preloads
    queueMetricPreload("vo2max", "6M", { endDate: "" });
    queueMetricPreload("training_index", "M", { endDate: "" });
    queueMetricPreload("running_index", "6M", { endDate: "" });
    document.querySelectorAll("#summary-highlights-stack .hl-insight-card").forEach((el) => {
      if (el.dataset.metric) {
        queueMetricPreload(el.dataset.metric, el.dataset.scope || defaultMetricScope(el.dataset.metric), { endDate: "" });
      }
    });
    document.querySelectorAll("#summary-trends-grid .trend-card").forEach((el) => {
      if (el.dataset.metric) queueMetricPreload(el.dataset.metric, "M", { endDate: "" });
    });
    queueMetricPreload("ecg", "W", { endDate: "" });

    enqueuePreloadTask("tab:workouts", async (epoch) => {
      if (epoch !== preloadEpoch) return;
      const wData = await fetchWorkoutsData("");
      if (epoch !== preloadEpoch) return;
      if (currentTab !== "workouts" && !currentSportFilter && workoutsRenderedKey !== "|1") {
        await loadWorkouts("", { skipDetail: true });
      }
      (wData?.workouts || []).slice(0, 6).forEach((w) => queueWorkoutPreload(w.workout_id));
    });

    enqueuePreloadTask("tab:day", async (epoch) => {
      if (epoch !== preloadEpoch) return;
      const dData = await fetchDaySnapshotData("");
      if (epoch !== preloadEpoch) return;
      if (currentTab !== "browse" && !dayRenderedDate) {
        await loadDaySnapshot("");
      }
      queueDayStripPreloads(dData?.date || "");
    });

    [
      ["steps", "W"],
      ["active_energy", "D"],
      ["basal_energy", "W"],
      ["distance", "D"],
      ["resting_hr", "W"],
      ["stress", "W"],
      ["temperature", "W"],
    ].forEach(([m, s]) => queueMetricPreload(m, s, { endDate: "" }));

    // Stage 3: Key Secondary Scopes
    [
      ["sleep", "W"],
      ["activity", "W"],
      ["heart_rate", "D"],
      ["steps", "D"],
    ].forEach(([m, s]) => queueMetricPreload(m, s, { endDate: "" }));
  }

  window.addEventListener("ct-transition-end", resumeSecondaryPreload);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resumeSecondaryPreload();
  });
  let selectedDay = null;
  let currentSportFilter = "";
  let workoutsCache = null;
  let selectedWorkoutId = null;
  let chartReaders = [];
  const overlaySeries=new Map();
  let routeCursor;
  let loadSport = "";
  let workoutOrigin;
  let workoutRequest = 0;
  let metricRequest = 0;
  let workoutDetailCache = null;
  let lastWorkoutBounds = null;
  let leafletMap = null;
  let leafletLayerGroup = null;
  let activeTileLayer = null;
  let manualMapOverride = null;
  let toastTimer = null;

  let detailState = null; // { metric, scope, endDate, fromTab, scrollY, sleepMode }
  let detailDataCache = null;

  const TAB_INDEX = { summary: 0, workouts: 1, browse: 2, more: 3 };
  const TAB_ORDER = ["summary", "workouts", "browse", "more"];
  const TAB_TITLES = { summary: "摘要", workouts: "体能训练", browse: "浏览", more: "更多" };
  const MAP_ORDER = ["gaode_vec", "gaode_dark", "gaode_sat"];
  const MAP_PROVIDERS = {
    gaode_vec: {
      label: "高德矢量",
      url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      subdomains: "1234",
      darkFilter: false,
      attr: "&copy; 高德地图 AutoNavi",
    },
    gaode_dark: {
      label: "高德暗黑",
      url: "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
      subdomains: "1234",
      darkFilter: true,
      attr: "&copy; 高德地图 AutoNavi",
    },
    gaode_sat: {
      label: "高德卫星",
      url: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
      subdomains: "1234",
      darkFilter: false,
      attr: "&copy; 高德卫星 AutoNavi",
    },
  };
  const SCOPE_LABELS = [
    { id: "D", label: "日" },
    { id: "W", label: "周" },
    { id: "M", label: "月" },
    { id: "6M", label: "6个月" },
    { id: "Y", label: "年" },
  ];

  const METRIC_META = {
    temperature: { title: "温度" },
    ecg: { title: "心电图" },
    ecg_record: { title: "心电图记录" },

    heart_rate: { title: "心率", colorVar: "var(--apple-red)", hexLight: "#FF2D55", hexDark: "#FF375F" },
    resting_hr: { title: "静息心率", colorVar: "var(--apple-red)", hexLight: "#FF2D55", hexDark: "#FF375F" },
    hrv: { title: "心率变异性", colorVar: "var(--apple-green)", hexLight: "#28CD41", hexDark: "#30D158" },
    steps: { title: "步数", colorVar: "var(--apple-orange)", hexLight: "#FF9500", hexDark: "#FF9F0A" },
    active_energy: { title: "活动能量", colorVar: "var(--apple-red)", hexLight: "#FF3B30", hexDark: "#FF453A" },
    basal_energy: { title: "静息能量", colorVar: "var(--apple-orange)", hexLight: "#FF6B00", hexDark: "#FF9F0A" },
    distance: { title: "步行+跑步距离", colorVar: "var(--apple-orange)", hexLight: "#FF6B00", hexDark: "#FF9F0A" },
    sleep: { title: "睡眠", colorVar: "var(--apple-indigo)", hexLight: "#5856D6", hexDark: "#5E5CE6" },
    spo2: { title: "血氧饱和度", colorVar: "var(--apple-teal)", hexLight: "#30B0C7", hexDark: "#64D2FF" },
    stress: { title: "压力与心理状态", colorVar: "var(--apple-purple)", hexLight: "#AF52DE", hexDark: "#BF5AF2" },
    activity: { title: "健身记录", colorVar: "var(--ring-move)", hexLight: "#FA114F", hexDark: "#FA114F" },
    vo2max: { title: "最大摄氧量", colorVar: "var(--apple-red)", hexLight: "#FF3B30", hexDark: "#FF453A" },
    training_index: { title: "训练指数", colorVar: "var(--apple-blue)", hexLight: "#007AFF", hexDark: "#0A84FF" },
    running_index: { title: "跑步指数", colorVar: "var(--apple-green)", hexLight: "#28CD41", hexDark: "#30D158" },
  };

  const $ = (id) => document.getElementById(id);
  const isMobileViewport = () => window.innerWidth < 960;
  const isNarrowPhone = () => window.innerWidth < 640;

  // -----------------------------------------------------------------------
  // Theme Engine (Light / OLED Dark + Liquid Glass)
  // -----------------------------------------------------------------------

  function getTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function getThemePalette() {
    const dark = getTheme() === "dark";
    return dark
      ? {
          dark: true,
          text: "#FFFFFF",
          text2: "#98989D",
          text3: "#6E6E73",
          grid: "rgba(255,255,255,0.10)",
          axisLine: "rgba(255,255,255,0.14)",
          tooltipBg: "rgba(28, 28, 30, 0.96)",
          tooltipBorder: "rgba(255, 255, 255, 0.14)",
          tooltipText: "#FFFFFF",
          surfaceSolid: "#1C1C1E",
          red: "#FF375F",
          green: "#30D158",
          blue: "#0A84FF",
          indigo: "#5E5CE6",
          deep: "#6366F1",
          lightSleep: "#3B82F6",
          rem: "#5AC8FA",
          awake: "#FF785A",
          nap: "#BF5AF2",
          orange: "#FF9F0A",
          teal: "#64D2FF",
          purple: "#BF5AF2",
          move: "#FA114F",
          ex: "#92E82A",
          stand: "#00E5FF",
          track: "rgba(255,255,255,0.14)",
          baselineBand: "rgba(48, 209, 88, 0.18)",
        }
      : {
          dark: false,
          text: "#1C1C1E",
          text2: "#6E6E73",
          text3: "#8E8E93",
          grid: "rgba(60,60,67,0.10)",
          axisLine: "rgba(60,60,67,0.16)",
          tooltipBg: "rgba(255, 255, 255, 0.96)",
          tooltipBorder: "rgba(60, 60, 67, 0.12)",
          tooltipText: "#1C1C1E",
          surfaceSolid: "#FFFFFF",
          red: "#FF2D55",
          green: "#28CD41",
          blue: "#007AFF",
          indigo: "#5856D6",
          deep: "#4338CA",
          lightSleep: "#007AFF",
          rem: "#32ADE6",
          awake: "#FF6B4A",
          nap: "#AF52DE",
          orange: "#FF9500",
          teal: "#30B0C7",
          purple: "#AF52DE",
          move: "#FA114F",
          ex: "#30D158",
          stand: "#00B4F0",
          track: "rgba(120,120,128,0.15)",
          baselineBand: "rgba(40, 205, 65, 0.15)",
        };
  }

  function syncNativeTheme(theme) {
    fetch(`/api/v1/local/theme?mode=${encodeURIComponent(theme)}`, { method: "POST" }).catch(() => {});
  }

  function triggerNativeHaptic(kind = "tick") {
    fetch(`/api/v1/local/haptic?kind=${encodeURIComponent(kind)}`, { method: "POST" }).catch(() => {});
  }

  function applyTheme(mode) {
    const theme = mode === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("hwh_theme", theme);
    } catch (_) {}
    const meta = $("theme-color-meta");
    if (meta) meta.content = theme === "dark" ? "#000000" : "#F2F2F7";
    syncNativeTheme(theme);
    const lbl = $("sidebar-theme-label");
    if (lbl) lbl.textContent = theme === "dark" ? "浅色外观" : "深色外观";

    document.querySelectorAll("#more-theme-segmented .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeVal === theme);
    });

    invalidateViewRenderCaches({ clearData: false });
    if (detailState && detailDataCache) {
      renderMetricDetailScreen(detailDataCache, "resize");
    }
    if (overviewCache && !overviewCache.empty) {
      renderSummaryTab(overviewCache);
      renderBrowseCategories(overviewCache);
      if (allHealthOpen) renderAllHealthView(overviewCache);
    }
    if (proInsightsOpen && proInsightsCache && !proInsightsCache.empty) {
      renderProInsightsView(proInsightsCache);
    }
    if (workoutDetailCache) {
      applyMapTiles();
      renderWorkoutDetailCards(workoutDetailCache, true);
    }
    scheduleHiddenDomPrewarm();
  }

  function toggleTheme() {
    applyTheme(getTheme() === "dark" ? "light" : "dark");
  }

  [$("sidebar-theme-btn"), $("mobile-theme-btn"), $("detail-theme-btn"), $("all-health-theme-btn"), $("pro-insights-theme-btn")].forEach((btn) => {
    if (btn) btn.addEventListener("click", toggleTheme);
  });

  document.querySelectorAll("#more-theme-segmented .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.themeVal));
  });

  // -----------------------------------------------------------------------
  // General Helpers & API
  // -----------------------------------------------------------------------

  function showToast(msg) {
    const el = $("toast");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 2000);
  }

  async function apiJson(url, opts = {}) {
    const resp = await fetch(url, {
      credentials: "same-origin",
      ...opts,
      headers: {
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
        ...(opts.headers || {}),
      },
    });
    const data = await resp.json();
    if (!resp.ok) {
      throw new Error(data.message || data.error || `HTTP ${resp.status}`);
    }
    return data;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fmtNum(v, digits = 0) {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "-";
    return Number(v).toLocaleString("zh-CN", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function fmtMinHm(min) {
    if (min === null || min === undefined || Number.isNaN(Number(min))) return "-";
    const m = Math.round(Number(min));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h}小时${rem}分` : `${rem}分钟`;
  }

  function fmtMinHmCn(min) {
    if (min === null || min === undefined || Number.isNaN(Number(min))) return "-";
    const m = Math.round(Number(min));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return h > 0 ? `${h} 小时 ${rem} 分钟` : `${rem} 分钟`;
  }

  function fmtSplitHmHtml(min) {
    if (min === null || min === undefined || Number.isNaN(Number(min))) return '<span class="num-lg">-</span>';
    const m = Math.round(Number(min));
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (h > 0) {
      return `<span class="num-lg">${h}</span><span class="unit-sm">小时</span><span class="num-lg">${rem}</span><span class="unit-sm">分钟</span>`;
    }
    return `<span class="num-lg">${rem}</span><span class="unit-sm">分钟</span>`;
  }

  function fmtSplitValHtml(valStr, unitStr) {
    return `<span class="num-lg">${escapeHtml(valStr)}</span>${unitStr ? `<span class="unit-sm">${escapeHtml(unitStr)}</span>` : ""}`;
  }

  function fmtDurationSec(sec) {
    if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return "-";
    const s = Math.round(Number(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(rem).padStart(2, "0")}`;
    return `${m}:${String(rem).padStart(2, "0")}`;
  }

  function fmtPace(sPerKm) {
    if (!sPerKm || sPerKm <= 0) return "-";
    const total = Math.round(Number(sPerKm));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}'${String(s).padStart(2, "0")}"/km`;
  }

  function fmtRelDate(dateStr, refLatestDate) {
    if (!dateStr) return "-";
    if (dateStr === refLatestDate) return "最新";
    return dateStr.slice(5);
  }

  function pickLatestValid(daysDesc, getter) {
    for (let i = 0; i < daysDesc.length; i += 1) {
      const val = getter(daysDesc[i]);
      if (val !== null && val !== undefined && !Number.isNaN(Number(val))) {
        return { row: daysDesc[i], value: Number(val) };
      }
    }
    return { row: daysDesc[0] || null, value: null };
  }

  let heroCounterRaf = null;
  function animateHeroNumber(el, fromText, toText, duration = 340) {
    if (!el) return;
    if (heroCounterRaf) {
      cancelAnimationFrame(heroCounterRaf);
      heroCounterRaf = null;
    }
    const sFrom = String(fromText ?? "").trim();
    const sTo = String(toText ?? "").trim();
    if (!sFrom || !sTo || sFrom === "-" || sTo === "-" || sFrom === sTo) {
      el.textContent = sTo;
      return;
    }
    const numRe = /\d+(?:,\d{3})*(?:\.\d+)?/g;
    const fromMatches = [...sFrom.matchAll(numRe)];
    const toMatches = [...sTo.matchAll(numRe)];
    if (!fromMatches.length || fromMatches.length !== toMatches.length) {
      el.textContent = sTo;
      return;
    }
    // Check that non-numeric structure matches
    const tplFrom = sFrom.replace(numRe, "#");
    const tplTo = sTo.replace(numRe, "#");
    if (tplFrom !== tplTo) {
      el.textContent = sTo;
      return;
    }
    const specs = toMatches.map((m, idx) => {
      const rawF = fromMatches[idx][0].replace(/,/g, "");
      const rawT = m[0].replace(/,/g, "");
      const hasComma = m[0].includes(",") || Number(rawT) >= 1000;
      const dotIdx = rawT.indexOf(".");
      const decimals = dotIdx >= 0 ? rawT.length - dotIdx - 1 : 0;
      return {
        from: Number(rawF),
        to: Number(rawT),
        hasComma,
        decimals,
      };
    });
    const parts = sTo.split(numRe);
    const startTs = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - startTs) / duration);
      const ease = 1 - Math.pow(1 - t, 3);
      let out = parts[0] || "";
      for (let i = 0; i < specs.length; i += 1) {
        const sp = specs[i];
        const cur = sp.from + (sp.to - sp.from) * ease;
        const formatted = sp.hasComma
          ? cur.toLocaleString("zh-CN", {
              minimumFractionDigits: sp.decimals,
              maximumFractionDigits: sp.decimals,
            })
          : cur.toFixed(sp.decimals);
        out += formatted + (parts[i + 1] || "");
      }
      el.textContent = out;
      if (t < 1) {
        heroCounterRaf = requestAnimationFrame(step);
      } else {
        el.textContent = sTo;
        heroCounterRaf = null;
      }
    };
    heroCounterRaf = requestAnimationFrame(step);
  }

  let detailExitTimer = null;
  let woExitTimer = null;
  let allHealthOpen = false;
  let allHealthExitTimer = null;
  let allHealthScrollY = 0;
  let proInsightsOpen = false;
  let proInsightsTab = "load";
  let proInsightsFromTab = "summary";
  let proInsightsScrollY = 0;
  let proInsightsExitTimer = null;
  let proInsightsCache = null;
  let polarWindow = "30d";
  let heatmapSpan = "26w";
  let selectedHeatmapDate = null;

  function triggerViewTransition(el, cls = "ios-view-enter") {
    if (!el) return;
    el.classList.remove("ios-view-enter", "ios-view-pop", "ios-view-exit-right");
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function triggerChartMotion(el, cls = "chart-crossfade") {
    if (!el || !cls) return;
    const replay = el.classList.contains(cls);
    el.classList.remove("chart-slide-prev", "chart-slide-next", "chart-crossfade");
    if (replay) void el.offsetWidth;
    el.classList.add(cls);
  }

  // Strip one-shot entrance animations after completion so scrolling/relayout never replays them
  const ONE_SHOT_ANIMS = new Set([
    "ringSweep",
    "barGrowUp",
    "capExpand",
    "sleepBlockIn",
    "sleepGlowIn",
    "fadeIn",
    "cardRiseIn",
    "barFillRight",
    "balance-marker-enter",
  ]);
  function freezePanelAnimations(el) {
    if (!el) return;
    el.classList.remove("ios-view-enter", "ios-view-pop", "ios-view-exit-right", "chart-crossfade");
    el.classList.add("no-anim-replay");
  }
  function sealCardRiseAnimations(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".stagger-card").forEach((el) => el.classList.add("anim-done"));
  }
  const ONE_SHOT_SELECTOR =
    ".stagger-card, .ring-fg, .svg-bar-grow, .svg-cap-expand, .svg-sleep-block, " +
    ".svg-sleep-bridge, .svg-sleep-glow, .svg-line-draw, .hl-fill, " +
    ".sleep-amount-fill, .hr-zone-fill, .split-bar-fill, .balance-marker";
  function sealOneShotAnimations(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(ONE_SHOT_SELECTOR).forEach((el) => el.classList.add("anim-done"));
  }
  document.addEventListener("animationend", (e) => {
    const el = e.target;
    if (!(el instanceof Element)) return;
    const name = e.animationName;
    if (name === "iosPushIn" || name === "iosPopIn") {
      el.classList.remove("ios-view-enter", "ios-view-pop");
    } else if (name === "chartSlidePrev" || name === "chartSlideNext" || name === "chartCrossfade") {
      el.classList.remove("chart-slide-prev", "chart-slide-next", "chart-crossfade");
    } else if (ONE_SHOT_ANIMS.has(name)) {
      el.classList.add("anim-done");
    }
  });

  function blendHex(hexA, hexB, t) {
    const parse = (h) => {
      const s = String(h || "#007AFF").replace("#", "");
      const full = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.padEnd(6, "0");
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ];
    };
    const [r1, g1, b1] = parse(hexA);
    const [r2, g2, b2] = parse(hexB);
    const k = Math.max(0, Math.min(1, t));
    const r = Math.round(r1 + (r2 - r1) * k);
    const g = Math.round(g1 + (g2 - g1) * k);
    const b = Math.round(b1 + (b2 - b1) * k);
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  let lastHapticAt = 0;
  function triggerHapticTick(duration = 4, interval = 28) {
    const now = performance.now();
    if (now - lastHapticAt < interval) return;
    try {
      if (window.__panelNative && typeof window.__panelNative.vibrate === "function") {
        window.__panelNative.vibrate(Math.round(duration));
        lastHapticAt = now;
        return;
      }
      if (navigator.vibrate?.(duration)) lastHapticAt = now;
    } catch (_) {}
  }

  function getChart(id) {
    if (!window.echarts) return null;
    const el = $(id);
    if (!el) return null;
    if (!charts[id]) {
      charts[id] = window.echarts.init(el);
    }
    return charts[id];
  }

  function resizeAllCharts() {
    Object.values(charts).forEach((c) => {
      try {
        if (c.getDom().getClientRects().length) c.resize();
      } catch (_) {}
    });
    if (leafletMap) {
      try {
        leafletMap.invalidateSize();
      } catch (_) {}
    }
  }

  let lastResizeWidth = window.innerWidth;
  let resizeTimer = null;

  window.addEventListener("resize", () => {
    const curW = window.innerWidth;
    if (Math.abs(curW - lastResizeWidth) < 3) {
      // Ignore mobile browser URL-bar collapse/expand height-only resizes on vertical scroll
      return;
    }
    lastResizeWidth = curW;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      resizeAllCharts();
      if (detailState && detailDataCache) {
        renderMetricDetailScreen(detailDataCache, "resize");
      }
      if (currentTab === "workouts" && !detailState) {
        if (!isMobileViewport() && workoutsCache?.workouts?.length && !workoutDetailCache) {
          selectedWorkoutId = selectedWorkoutId || workoutsCache.workouts[0].workout_id;
          loadWorkoutDetail(selectedWorkoutId, false);
        } else if (workoutDetailCache) {
          renderWorkoutDetailCards(workoutDetailCache, true);
        }
      }
    }, 150);
  });

  // -----------------------------------------------------------------------
  // Local panel startup
  // -----------------------------------------------------------------------

  function showAppShell() {
    $("app-shell").classList.remove("hidden");
    const theme = getTheme();
    document.querySelectorAll("#more-theme-segmented .seg-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.themeVal === theme);
    });
    const lbl = $("sidebar-theme-label");
    if (lbl) lbl.textContent = theme === "dark" ? "浅色外观" : "深色外观";
  }

  function openLocalImport() {
    fetch("/api/v1/local/import", { method: "POST" }).catch(() => window.location.assign("/local/import"));
  }

  let localSyncState = {
    busy: false,
    message: null,
    short_label: null,
    error: false,
    needs_huawei_health: false,
    can_launch_huawei_health: false,
    has_cached_key: false,
    auto_sync_on_open: true,
    revision: 0,
    sync_result: null,
    event_seq: 0,
  };
  let lastLocalRevision = -1;
  let lastLocalEventSeq = -1;
  let lastLocalToastKey = "";

  const ONBOARDING_KEY = "hwh_onboarding_v1_done";

  function renderOnboardingLiveStatus() {
    const strip = $("onboarding-live-strip");
    const txt = $("onboarding-live-text");
    const hwhBtn = $("onboarding-open-hwh-btn");
    const primaryBtn = $("onboarding-primary-btn");
    if (strip && txt) {
      strip.classList.remove("is-ready", "is-syncing", "is-warn");
      if (localSyncState.busy) {
        strip.classList.add("is-syncing");
        txt.textContent = localSyncState.message || "正在从华为运动健康同步…";
      } else if (localSyncState.error) {
        strip.classList.add("is-warn");
        txt.textContent = localSyncState.short_label
          ? `${localSyncState.short_label}：${localSyncState.message || "请按下方步骤检查"}`
          : (localSyncState.message || "等待授权与初次同步");
      } else if (overviewCache && !overviewCache.empty) {
        strip.classList.add("is-ready");
        const days = overviewCache.sync_status?.counts?.daily_summary || 0;
        const keyTxt = localSyncState.has_cached_key ? "密钥已安全缓存" : "就绪";
        txt.textContent = `已同步 ${days} 天数据 · ${keyTxt}`;
      } else {
        txt.textContent = "准备就绪 · 授予 Root 后即可自动恢复密钥并同步";
      }
    }
    if (hwhBtn) {
      hwhBtn.classList.toggle("hidden", !localSyncState.can_launch_huawei_health);
    }
    if (primaryBtn) {
      primaryBtn.textContent = (overviewCache?.empty && !localSyncState.busy) ? "开始使用并同步" : "开始使用";
    }
  }

  function openOnboardingGuide(fromSettings = false) {
    const dialog = $("onboarding-dialog");
    if (!dialog || dialog.open) return;
    renderOnboardingLiveStatus();
    const skipBtn = $("onboarding-skip-btn");
    if (skipBtn) skipBtn.classList.toggle("hidden", Boolean(fromSettings));
    dialog.classList.remove("is-closing");
    dialog.showModal();
    syncNativeBackState();
  }

  async function animateDialogDismiss(dialogEl, surfaceEl, backdropSelector, endFrame, duration = 180, useScaleOnly = false) {
    const backdropEl = backdropSelector && dialogEl.nextElementSibling?.matches(backdropSelector)
      ? dialogEl.nextElementSibling
      : null;
    if (backdropEl) {
      backdropEl.style.transition = "";
      backdropEl.style.opacity = "";
    }
    if (surfaceEl && !matchMedia("(prefers-reduced-motion: reduce)").matches && surfaceEl.animate) {
      const startFrame = useScaleOnly
        ? { opacity: 1, scale: "1" }
        : { opacity: 1, transform: "none" };
      const animation = surfaceEl.animate([startFrame, endFrame], { duration, easing: "ease-in", fill: "forwards" });
      await animation.finished.catch(() => {});
      animation.cancel();
    }
    dialogEl.close();
    if (surfaceEl) {
      surfaceEl.style.transition = "";
      surfaceEl.style.transform = "";
      surfaceEl.style.scale = "";
      surfaceEl.style.opacity = "";
    }
    if (backdropEl) {
      backdropEl.style.transition = "";
      backdropEl.style.opacity = "";
    }
  }

  async function closeOnboardingGuide(markSeen = true) {
    const dialog = $("onboarding-dialog");
    if (!dialog || !dialog.open || dialog.classList.contains("is-closing")) return;
    if (markSeen) {
      try {
        localStorage.setItem(ONBOARDING_KEY, "1");
      } catch (_) {}
    }
    dialog.classList.add("is-closing");
    const surface = dialog.querySelector(".onboarding-surface");
    await animateDialogDismiss(
      dialog,
      surface,
      ".onboarding-backdrop",
      { opacity: 0, transform: "translateY(10px) scale(.97)" },
      180,
      false
    );
    dialog.classList.remove("is-closing");
    syncNativeBackState();
  }

  function createPullToRefreshController() {
    const indicator = $("ptr-indicator");
    const ringFill = $("ptr-ring-fill");
    const label = $("ptr-label");
    const mainContent = document.querySelector(".main-content");
    if (!indicator || !ringFill || !label || !mainContent) return null;

    const DEADZONE = 16;
    const THRESHOLD = 165;
    const MAX_OFFSET = 96;
    const CIRCUMFERENCE = 2 * Math.PI * 8.5;

    let phase = "idle"; // idle | dragging | syncing | done
    let ready = false;
    let settleTimer = 0;
    let finishTimer = 0;
    let safetyTimer = 0;

    function clearTimers() {
      clearTimeout(settleTimer);
      clearTimeout(finishTimer);
      clearTimeout(safetyTimer);
    }

    function clearMainTransform() {
      mainContent.classList.remove("ptr-spring-back");
      mainContent.style.transform = "";
    }

    function setRingProgress(progress) {
      const clamped = Math.max(0, Math.min(1, progress));
      ringFill.style.strokeDasharray = CIRCUMFERENCE.toFixed(2);
      ringFill.style.strokeDashoffset = (CIRCUMFERENCE * (1 - clamped)).toFixed(2);
    }

    function resetIdle() {
      clearTimers();
      phase = "idle";
      ready = false;
      indicator.classList.remove("is-dragging", "is-visible", "is-ready", "is-syncing", "is-done", "is-error");
      indicator.style.opacity = "";
      indicator.style.transform = "";
      setRingProgress(0);
      label.textContent = "继续下拉增量刷新";
      mainContent.classList.add("ptr-spring-back");
      mainContent.style.transform = "translate3d(0, 0px, 0)";
      finishTimer = setTimeout(clearMainTransform, 340);
    }

    return {
      isBusyUi() {
        return phase === "syncing" || phase === "done";
      },
      onMove(raw) {
        if (phase === "syncing" || phase === "done") return;
        clearTimers();
        phase = "dragging";
        const effective = Math.max(0, raw - DEADZONE);
        const progress = Math.max(0, Math.min(1, (raw - DEADZONE) / (THRESHOLD - DEADZONE)));
        const visualY = Math.min(MAX_OFFSET, (effective * 0.46) / (1 + effective * 0.0022));
        mainContent.classList.remove("ptr-spring-back");
        mainContent.style.transform = `translate3d(0, ${visualY.toFixed(1)}px, 0)`;

        const nextReady = raw >= THRESHOLD;
        if (nextReady !== ready) {
          ready = nextReady;
          indicator.classList.toggle("is-ready", ready);
          label.textContent = ready ? "松开立即增量同步" : "继续下拉增量刷新";
          if (ready) triggerNativeHaptic("tick");
        }
        indicator.classList.add("is-dragging", "is-visible");
        indicator.classList.remove("is-done", "is-error", "is-syncing");
        const opacity = Math.max(0, Math.min(1, effective / 44));
        const scale = 0.86 + 0.14 * progress;
        const shiftY = Math.max(-18, Math.min(18, (visualY - 46) * 0.35));
        indicator.style.opacity = opacity.toFixed(3);
        indicator.style.transform = `translate3d(-50%, ${shiftY.toFixed(1)}px, 0) scale(${scale.toFixed(3)})`;
        setRingProgress(progress);
      },
      onCancelDrag() {
        if (phase !== "dragging") return;
        resetIdle();
      },
      onEnd(committed) {
        if (phase !== "dragging") return;
        indicator.classList.remove("is-dragging");
        if (!committed || !ready) {
          resetIdle();
          return;
        }
        ready = false;
        phase = "syncing";
        triggerNativeHaptic("confirm");
        indicator.classList.remove("is-ready", "is-done", "is-error");
        indicator.classList.add("is-visible", "is-syncing");
        indicator.style.opacity = "";
        indicator.style.transform = "";
        label.textContent = localSyncState.busy
          ? (localSyncState.short_label || "正在同步…")
          : "增量检查更新…";
        mainContent.classList.add("ptr-spring-back");
        mainContent.style.transform = isMobileViewport() ? "translate3d(0, 44px, 0)" : "translate3d(0, 32px, 0)";
        safetyTimer = setTimeout(resetIdle, 45000);
        if (!localSyncState.busy) {
          triggerLocalSync(false, "pull");
        }
      },
      onSyncProgress(st) {
        if (phase !== "syncing") return;
        label.textContent = st.short_label || "正在增量同步…";
      },
      onSyncFinished(st) {
        if (phase !== "syncing") return;
        clearTimers();
        phase = "done";
        indicator.classList.remove("is-syncing", "is-ready");
        if (st.error) {
          indicator.classList.add("is-error");
          label.textContent = st.short_label || "同步失败";
          triggerNativeHaptic("reject");
        } else {
          indicator.classList.add("is-done");
          label.textContent = st.sync_result === "unchanged" ? "已是最新数据" : "增量同步完成";
        }
        settleTimer = setTimeout(resetIdle, st.error ? 1800 : 1200);
      },
    };
  }

  const ptrController = createPullToRefreshController();
  window.__panelPtr = ptrController;

  async function triggerLocalSync(forceKey = false, mode = "manual") {
    try {
      const qs = `?mode=${encodeURIComponent(mode)}${forceKey ? "&force_key=1" : ""}`;
      const data = await apiJson(`/api/v1/local/sync${qs}`, { method: "POST" });
      window.__onLocalSyncStatus(data);
    } catch (err) {
      ptrController?.onSyncFinished({ error: true, short_label: "同步失败" });
      showToast(err?.message || "无法发起同步");
    }
  }

  async function setAutoSyncOnOpen(enabled) {
    try {
      const data = await apiJson(`/api/v1/local/auto-sync?enabled=${enabled ? "1" : "0"}`, { method: "POST" });
      window.__onLocalSyncStatus(data);
    } catch (err) {
      showToast(err?.message || "设置失败");
    }
  }

  function openHuaweiHealthApp() {
    fetch("/api/v1/local/open-huawei-health", { method: "POST" }).catch(() => {});
  }

  function clearLocalDatabase() {
    fetch("/api/v1/local/clear", { method: "POST" }).catch(() => {});
  }

  function renderEmptySyncCard() {
    const card = $("hero-rings-card");
    if (!card) return;
    card.removeAttribute("role");
    card.removeAttribute("tabindex");
    if (localSyncState.busy) {
      card.innerHTML = `<p class="card-note">${escapeHtml(localSyncState.message || "正在从华为运动健康同步数据…")}</p>`;
      return;
    }
    const statusText = localSyncState.message || "支持打开应用后通过 Root 自动从华为运动健康获取密钥并解密数据库，也可手动导入快照。";
    const openHwhHtml = localSyncState.needs_huawei_health && localSyncState.can_launch_huawei_health
      ? '<button type="button" class="ios-btn-secondary" id="empty-open-hwh-btn">打开华为运动健康</button>'
      : "";
    card.innerHTML = `
      <p class="card-note">${escapeHtml(statusText)}</p>
      <div class="local-sync-actions">
        <button type="button" class="liquid-pill mini-pill-btn" id="empty-auto-sync-btn">从华为运动健康同步</button>
        <button type="button" class="ios-btn-secondary" id="empty-import-btn">手动导入数据库</button>
        ${openHwhHtml}
        <button type="button" class="ios-btn-secondary" id="empty-guide-btn">使用指南</button>
      </div>
    `;
    $("empty-auto-sync-btn").onclick = () => triggerLocalSync(false, "manual");
    $("empty-import-btn").onclick = openLocalImport;
    $("empty-guide-btn").onclick = () => openOnboardingGuide(true);
    const hwhBtn = $("empty-open-hwh-btn");
    if (hwhBtn) hwhBtn.onclick = openHuaweiHealthApp;
  }

  function renderLocalSyncUI() {
    document.querySelectorAll("#more-autosync-segmented .seg-btn").forEach((b) => {
      const want = localSyncState.auto_sync_on_open ? "1" : "0";
      b.classList.toggle("active", b.dataset.autosyncVal === want);
      b.disabled = Boolean(localSyncState.busy);
    });

    if ($("local-key-status")) {
      $("local-key-status").textContent = localSyncState.has_cached_key ? "已安全缓存" : "尚未缓存（同步时自动获取）";
    }
    if ($("local-sync-status-msg")) {
      $("local-sync-status-msg").textContent = localSyncState.message || "准备就绪";
    }
    if ($("local-sync-now-btn")) {
      $("local-sync-now-btn").disabled = Boolean(localSyncState.busy);
      $("local-sync-now-btn").textContent = localSyncState.busy ? (localSyncState.short_label || "同步中…") : "立即同步";
    }
    if ($("local-rekey-btn")) {
      $("local-rekey-btn").disabled = Boolean(localSyncState.busy);
    }
    if ($("local-open-hwh-btn")) {
      $("local-open-hwh-btn").classList.toggle(
        "hidden",
        !(localSyncState.needs_huawei_health && localSyncState.can_launch_huawei_health)
      );
    }

    const syncIso = overviewCache?.sync_status?.sync_meta?.last_synced_iso || "";
    const shortSync = syncIso ? syncIso.slice(5, 16).replace("T", " ") : "本地";
    const pill = $("mobile-sync-pill");
    if (pill) {
      pill.classList.toggle("is-syncing", Boolean(localSyncState.busy));
      pill.classList.toggle("is-error", Boolean(!localSyncState.busy && localSyncState.error));
    }
    if ($("mobile-sync-text")) {
      $("mobile-sync-text").textContent = localSyncState.busy
        ? (localSyncState.short_label || "同步中")
        : (localSyncState.error && overviewCache?.empty ? "同步失败" : shortSync);
    }
    if ($("sidebar-sync-text")) {
      $("sidebar-sync-text").textContent = localSyncState.busy
        ? (localSyncState.short_label || "同步中")
        : `同步 ${shortSync}`;
    }
    if ($("summary-sync-tag")) {
      $("summary-sync-tag").textContent = localSyncState.busy
        ? (localSyncState.message || "正在同步…")
        : `最新同步 ${shortSync}`;
    }
    if (overviewCache?.empty) {
      renderEmptySyncCard();
    }
    renderOnboardingLiveStatus();
  }

  function flushPendingDashboardRefresh() {
    if (activeCt || restoringNavigation || !dashboardRefreshPending) return;
    dashboardRefreshPending = false;
    queueMicrotask(refreshDashboardAfterSync);
  }

  async function refreshDashboardAfterSync() {
    if (activeCt || restoringNavigation) {
      dashboardRefreshPending = true;
      return;
    }
    try {
      if (!(await loadOverview(30, { afterSync: true }))) return;
      if (currentTab === "workouts") {
        await loadWorkouts(currentSportFilter, { skipDetail: navigationRoute.view === "workout" || navigationRoute.view === "overlay" });
      } else if (currentTab === "browse") {
        await loadDaySnapshot(selectedDay);
      }
      if (proInsightsOpen) {
        await fetchAndRenderProInsights();
      }
    } catch (_) {}
  }

  window.__onLocalSyncStatus = function (st) {
    if (!st || typeof st !== "object") return;
    localSyncState = { ...localSyncState, ...st };
    const rev = Number(localSyncState.revision || 0);
    const eventSeq = Number(localSyncState.event_seq || 0);
    if (lastLocalRevision < 0) {
      lastLocalRevision = rev;
    } else if (rev > lastLocalRevision && !localSyncState.busy) {
      lastLocalRevision = rev;
      refreshDashboardAfterSync();
    }
    const ptrActiveForSync = Boolean(ptrController?.isBusyUi());
    if (localSyncState.busy) {
      ptrController?.onSyncProgress(localSyncState);
    }
    if (lastLocalEventSeq < 0) {
      lastLocalEventSeq = eventSeq;
    } else if (eventSeq > lastLocalEventSeq && !localSyncState.busy) {
      lastLocalEventSeq = eventSeq;
      ptrController?.onSyncFinished(localSyncState);
    }
    if (!localSyncState.busy && localSyncState.message) {
      const suppressAutoToast = !localSyncState.error && (
        localSyncState.sync_trigger === "auto" ||
        String(localSyncState.message || "").startsWith("已自动同步")
      );
      const suppressPtrToast = ptrActiveForSync && !localSyncState.error && localSyncState.sync_result === "unchanged";
      const toastKey = `${eventSeq}|${rev}|${Boolean(localSyncState.error)}|${localSyncState.message}`;
      if (toastKey !== lastLocalToastKey) {
        lastLocalToastKey = toastKey;
        if (!suppressPtrToast && !suppressAutoToast) showToast(localSyncState.message);
      }
    }
    renderLocalSyncUI();
    if (!localSyncState.busy) resumeSecondaryPreload();
  };

  async function startOfflinePanel() {
    syncNativeTheme(getTheme());
    showAppShell();
    try {
      const [statusRes, overviewRes] = await Promise.allSettled([
        apiJson("/api/v1/local/sync-status"),
        loadOverview(30),
      ]);
      if (statusRes.status === "fulfilled") {
        window.__onLocalSyncStatus(statusRes.value);
      }
      if (overviewRes.status === "rejected") {
        overviewCache = { empty: true };
        $("app-shell").classList.add("offline-empty");
        renderEmptySyncCard();
      }
    } catch (_) {
      overviewCache = { empty: true };
      $("app-shell").classList.add("offline-empty");
      renderEmptySyncCard();
    }
    try {
      if (localStorage.getItem(ONBOARDING_KEY) !== "1") {
        requestAnimationFrame(() => openOnboardingGuide(false));
      }
    } catch (_) {}
  }

  $("sidebar-logout-btn").addEventListener("click", openLocalImport);
  $("more-logout-btn").addEventListener("click", openLocalImport);
  $("more-clear-btn")?.addEventListener("click", clearLocalDatabase);
  $("more-onboarding-btn")?.addEventListener("click", () => openOnboardingGuide(true));
  $("onboarding-primary-btn")?.addEventListener("click", () => {
    const shouldSync = Boolean(overviewCache?.empty && !localSyncState.busy);
    closeOnboardingGuide(true);
    if (shouldSync) triggerLocalSync(false, "manual");
  });
  $("onboarding-skip-btn")?.addEventListener("click", () => closeOnboardingGuide(true));
  $("onboarding-open-hwh-btn")?.addEventListener("click", openHuaweiHealthApp);
  $("onboarding-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeOnboardingGuide(true);
  });
  $("onboarding-dialog")?.addEventListener("click", (e) => {
    if (e.target === $("onboarding-dialog")) closeOnboardingGuide(true);
  });
  $("local-sync-now-btn")?.addEventListener("click", () => triggerLocalSync(false, "manual"));
  $("local-rekey-btn")?.addEventListener("click", () => triggerLocalSync(true, "manual"));
  $("local-open-hwh-btn")?.addEventListener("click", openHuaweiHealthApp);
  $("mobile-sync-pill")?.addEventListener("click", () => { if (!localSyncState.busy) triggerLocalSync(false, "manual"); });
  $("summary-sync-tag")?.addEventListener("click", () => { if (!localSyncState.busy) triggerLocalSync(false, "manual"); });
  document.querySelectorAll("#more-autosync-segmented .seg-btn").forEach((btn) => {
    btn.addEventListener("click", () => setAutoSyncOnOpen(btn.dataset.autosyncVal === "1"));
  });

  // -----------------------------------------------------------------------
  // 4-Tab Navigation + Detail View Stack
  // -----------------------------------------------------------------------

  function updateDockPosition(tab) {
    const idx = TAB_INDEX[tab] ?? 0;
    const ind = $("dock-indicator");
    if (ind) ind.style.setProperty("--active-idx", String(idx));
  }

  function setDockCompact(compact) {
    const dock = $("bottom-dock");
    if (!dock) return;
    dock.classList.toggle("dock-compact", Boolean(compact));
  }

  function activateBottomTab(targetTab) {
    markPreloadUserInput();
    if (!targetTab) return;
    setDockCompact(false);
    if (targetTab === "workouts") {
      $("workouts-layout")?.classList.remove("mobile-detail-open");
      $("app-shell")?.classList.remove("wo-detail-active");
    }
    switchTab(targetTab);
  }

  let lastDockDragAt = 0;
  function initBottomDockGesture() {
    const dockInner = document.querySelector(".bottom-dock-inner");
    const dock = $("bottom-dock") || dockInner;
    const ind = $("dock-indicator");
    if (!dock || !dockInner || !ind) return;

    let active = false;
    let activePointerId = null;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastTime = 0;
    let startBtn = null;
    let stretch = 0;
    let settleAnimation;
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
    let curFloatIdx = TAB_INDEX[currentTab] ?? 0;
    let lastHoverIdx = curFloatIdx;
    const dockBtns = [...dockInner.querySelectorAll(".bottom-tab-btn")];

    dock.addEventListener("pointerdown", (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      if (active && activePointerId !== null) return;
      if ((activeCt && activeCt.opening) || restoringNavigation) return;
      active = true;
      activePointerId = e.pointerId;
      moved = false;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastTime = e.timeStamp;
      startBtn = e.target instanceof Element ? e.target.closest(".bottom-tab-btn") : null;
      stretch = 0;
      settleAnimation?.cancel();
      curFloatIdx = TAB_INDEX[currentTab] ?? 0;
      lastHoverIdx = Math.round(curFloatIdx);
    });

    dock.addEventListener("pointermove", (e) => {
      if (!active || e.pointerId !== activePointerId) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      if (!moved && dx > 14 && dx > dy) {
        moved = true;
        ind.classList.add("dragging");
        try {
          dock.setPointerCapture(e.pointerId);
        } catch (_) {}
      }
      if (!moved) return;
      const rect = dockInner.getBoundingClientRect();
      const rel = (e.clientX - rect.left) / Math.max(rect.width, 1);
      curFloatIdx = Math.max(0, Math.min(3, rel * 4 - 0.5));
      ind.style.setProperty("--active-idx", curFloatIdx.toFixed(3));
      const speed = Math.abs(e.clientX - lastX) / Math.max(8, e.timeStamp - lastTime);
      stretch = Math.min(.23, .07 + speed * .10);
      lastX = e.clientX;
      lastTime = e.timeStamp;
      ind.style.setProperty("--dock-stretch", stretch.toFixed(3));
      const hoverIdx = Math.max(0, Math.min(3, Math.round(curFloatIdx)));
      if (hoverIdx !== lastHoverIdx) {
        lastHoverIdx = hoverIdx;
        triggerHapticTick();
      }
      dockBtns.forEach((b, i) => b.classList.toggle("active", i === hoverIdx));
    });

    const endDrag = (e, cancelled) => {
      if (!active || e.pointerId !== activePointerId) return;
      active = false;
      activePointerId = null;
      try {
        if (dock.hasPointerCapture(e.pointerId)) {
          dock.releasePointerCapture(e.pointerId);
        }
      } catch (_) {}
      const releasedTransform = getComputedStyle(ind).transform;
      ind.classList.remove("dragging");

      if (moved) {
        lastDockDragAt = performance.now();
        const targetIdx = cancelled ? (TAB_INDEX[currentTab] ?? 0) : Math.max(0, Math.min(3, Math.round(curFloatIdx)));
        const targetTab = TAB_ORDER[targetIdx] || currentTab;
        updateDockPosition(targetTab);
        if (!reducedMotion.matches) {
          const at = (offset, x, y) => `translateX(${(targetIdx + offset) * 100}%) scale(${x},${y})`;
          const overshoot = Math.max(-.13, Math.min(.13, (targetIdx - curFloatIdx) * .28));
          settleAnimation = ind.animate([
            { transform: releasedTransform },
            { transform: at(overshoot, .94, 1.10), offset: .42 },
            { transform: at(-overshoot * .35, 1.035, .96), offset: .68 },
            { transform: at(0, 1, 1) },
          ], { duration: 420, easing: "cubic-bezier(.2,.68,.25,1)" });
        }
        dockBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === targetTab));
        if (!cancelled && targetTab !== currentTab) {
          activateBottomTab(targetTab);
        } else {
          setDockCompact(false);
          updateDockPosition(currentTab);
          dockBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === currentTab));
        }
      } else if (!cancelled && Math.abs(e.clientY - startY) < 48) {
        if ((activeCt && activeCt.opening) || restoringNavigation) return;
        const hitBtn = e.target instanceof Element ? e.target.closest(".bottom-tab-btn") : null;
        let targetTab = hitBtn?.dataset?.tab || startBtn?.dataset?.tab || "";
        if (!targetTab) {
          const rect = dockInner.getBoundingClientRect();
          if (e.clientX >= rect.left - 8 && e.clientX <= rect.right + 8) {
            const rel = (e.clientX - rect.left) / Math.max(rect.width, 1);
            const idx = Math.max(0, Math.min(3, Math.floor(rel * 4)));
            targetTab = TAB_ORDER[idx] || "";
          }
        }
        if (targetTab) {
          lastDockDragAt = performance.now();
          activateBottomTab(targetTab);
        }
      }
    };

    dock.addEventListener("pointerup", (e) => endDrag(e, false));
    dock.addEventListener("pointercancel", (e) => endDrag(e, true));
  }

  function initScrollCompactDock() {
    let previousY = window.scrollY;
    let travel = 0;

    window.addEventListener("scroll", () => {
      const y = Math.max(0, window.scrollY);
      const delta = y - previousY;
      previousY = y;
      if (restoringNavigation || activeCt) {
        travel = 0;
        return;
      }
      if (!delta) return;
      const atEnd = y + window.innerHeight >= document.documentElement.scrollHeight - 24;
      if (!isMobileViewport() || detailState || allHealthOpen || proInsightsOpen ||
          $("app-shell").classList.contains("wo-detail-active") || y < 32 || atEnd) {
        travel = 0;
        setDockCompact(false);
        return;
      }
      travel = Math.sign(travel) === Math.sign(delta) ? travel + delta : delta;
      if (travel <= -18 || (y > 64 && travel >= 24)) {
        setDockCompact(travel > 0);
        travel = 0;
      }
    }, { passive: true });
  }

  const navigationSession = Date.now();
  const baseRoute = { tab: "summary", view: "tab", depth: 0 };
  let navigationRoute = baseRoute;
  let restoringNavigation = false;
  let navigationRestore = Promise.resolve();
  let dashboardRefreshPending = false;
  let lastNativeCanGoBack = null;
  const originByDepth = new Map();
  let activeCt = null;
  let pendingPostTransitionResize = false;
  const CT_OPEN_DURATION = 380;
  const CT_OPEN_BEZIER = [0.22, 0.90, 0.24, 1];
  const CT_CLOSE_DURATION = 340;
  const CT_CLOSE_BEZIER = [0.22, 0.88, 0.28, 1];
  function solveCubicBezierY(x, x1, y1, x2, y2) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const ax = 3 * x1 - 3 * x2 + 1;
    const bx = 3 * x2 - 6 * x1;
    const cx = 3 * x1;
    let t = x;
    for (let i = 0; i < 6; i += 1) {
      const err = ((ax * t + bx) * t + cx) * t - x;
      if (Math.abs(err) < 1e-5) break;
      const dx = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(dx) < 1e-5) break;
      t = Math.max(0, Math.min(1, t - err / dx));
    }
    return Math.max(0, Math.min(1, ((3 * y1 - 3 * y2 + 1) * t * t + (3 * y2 - 6 * y1) * t + 3 * y1) * t));
  }

  function syncCtAnimatingClass() {
    const wasAnimating = document.documentElement.classList.contains("ct-animating");
    const isAnimating = Boolean(activeCt || document.querySelector(".ct-sheet-layer"));
    document.documentElement.classList.toggle("ct-animating", isAnimating);
    if (wasAnimating && !isAnimating) {
      window.dispatchEvent(new Event("ct-transition-end"));
      if (pendingPostTransitionResize) {
        pendingPostTransitionResize = false;
        requestAnimationFrame(resizeAllCharts);
      }
    }
  }

  // App history restores views asynchronously. Browser restoration can race
  // that work and overwrite the scroll position when the source remounts.
  history.scrollRestoration = "manual";
  history.replaceState({ healthSession: navigationSession, route: baseRoute }, "");

  function getTopmostOpenDialog() {
    const openDialogs = [...document.querySelectorAll("dialog[open]:not(.is-closing)")];
    return openDialogs.length ? openDialogs[openDialogs.length - 1] : null;
  }

  function syncNativeBackState(force = false) {
    const canGoBack = Boolean(getTopmostOpenDialog() || activeCt || restoringNavigation || navigationRoute.depth > 0);
    if (!force && canGoBack === lastNativeCanGoBack) return;
    lastNativeCanGoBack = canGoBack;
    window.__panelNative?.setCanGoBack?.(canGoBack);
  }
  window.__syncNativeBackState = syncNativeBackState;
  window.__isPanelTransitionBusy = () => Boolean(activeCt || restoringNavigation);
  syncNativeBackState(true);

  if (typeof MutationObserver === "function" && document.body) {
    const dialogOpenObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.target?.tagName === "DIALOG") {
          syncNativeBackState();
          break;
        }
      }
    });
    dialogOpenObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
  }
  document.addEventListener("close", (e) => {
    if (e.target?.tagName === "DIALOG") syncNativeBackState();
  }, true);

  window.__onNativeBackPress = () => {
    const dlg = getTopmostOpenDialog();
    if (dlg) {
      dlg.dispatchEvent(new Event("cancel", { cancelable: true }));
      return;
    }
    if (restoringNavigation) return;
    if (navigationRoute.depth > 0) {
      history.back();
      return;
    }
    if (activeCt) return;
    syncNativeBackState(true);
    window.__panelNative?.finishFromBack?.();
  };

  function canUseContainerTransform() {
    return isMobileViewport() && !(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  function buildOriginSelector(el) {
    if (!(el instanceof Element)) return "";
    if (el.id) return `#${CSS.escape(el.id)}`;
    const wid = el.dataset?.wid;
    const loadSession = el.dataset?.loadSession;
    const metric = el.dataset?.metric;
    if (el.closest("#summary-cards-grid") && metric) {
      return `#summary-cards-grid .metric-card[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#summary-athletic-grid") && metric) {
      return `#summary-athletic-grid .metric-card[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#summary-vitals-card") && metric) {
      return `#summary-vitals-card .vitals-row[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#summary-highlights-stack") && metric) {
      return `#summary-highlights-stack .hl-insight-card[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#summary-trends-grid") && metric) {
      return `#summary-trends-grid .trend-card[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#summary-recent-workouts") && wid) {
      return `#summary-recent-workouts .grouped-row[data-wid="${CSS.escape(wid)}"]`;
    }
    if (el.closest("#all-health-body") && metric) {
      return `#all-health-body .ah-card[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#workout-list") && wid) {
      return `#workout-list .wo-list-item[data-wid="${CSS.escape(wid)}"]`;
    }
    if (el.closest("#browse-categories") && metric) {
      return `#browse-categories .grouped-row[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#day-strip") && metric) {
      return `#day-strip .day-tile[data-metric="${CSS.escape(metric)}"]`;
    }
    if (el.closest("#heatmap-readout") && loadSession) {
      return `#heatmap-readout [data-load-session="${CSS.escape(loadSession)}"]`;
    }
    if (el.closest("#pro-insights-body") && wid) {
      return `#pro-insights-body .aerobic-run-row[data-wid="${CSS.escape(wid)}"]`;
    }
    if (el.closest("#metric-detail-body") && wid) {
      return `#metric-detail-body .grouped-row[data-wid="${CSS.escape(wid)}"]`;
    }
    return "";
  }

  function clampRectToViewport(rawRect, vw, vh) {
    if (!rawRect) return null;
    const rawW = Number(rawRect.width);
    const rawH = Number(rawRect.height);
    if (!Number.isFinite(rawW) || !Number.isFinite(rawH) || rawW < 4 || rawH < 4) return null;
    const rawLeft = Number(rawRect.left) || 0;
    const rawTop = Number(rawRect.top) || 0;
    const rawRight = rawLeft + rawW;
    const rawBottom = rawTop + rawH;
    if (rawBottom <= 0 || rawTop >= vh || rawRight <= 0 || rawLeft >= vw) return null;
    const left = Math.max(0, Math.min(vw - 12, rawLeft));
    const top = Math.max(0, Math.min(vh - 12, rawTop));
    const right = Math.max(left + 12, Math.min(vw, rawRight));
    const bottom = Math.max(top + 12, Math.min(vh, rawBottom));
    return {
      left,
      top,
      width: Math.max(12, right - left),
      height: Math.max(12, bottom - top),
    };
  }

  function parseOriginRadius(el) {
    if (!(el instanceof Element)) return 20;
    const rawRadius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius);
    return Math.max(16, Math.min(28, Number.isFinite(rawRadius) && rawRadius > 0 ? rawRadius : 20));
  }

  function getUntransformedDomRect(el) {
    const domRect = el.getBoundingClientRect();
    const layoutW = el.offsetWidth;
    const layoutH = el.offsetHeight;
    if (layoutW > 0 && layoutH > 0) {
      const restW = Math.max(domRect.width, layoutW);
      const restH = Math.max(domRect.height, layoutH);
      const cx = domRect.left + domRect.width / 2;
      const cy = domRect.top + domRect.height / 2;
      return {
        left: cx - restW / 2,
        top: cy - restH / 2,
        width: restW,
        height: restH,
      };
    }
    return domRect;
  }

  function captureOriginCard(el) {
    if (!(el instanceof Element) || !el.isConnected) return null;
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const normalizedRect = getUntransformedDomRect(el);
    const rect = clampRectToViewport(normalizedRect, vw, vh);
    if (!rect) return null;
    return {
      el, selector: buildOriginSelector(el), rect,
      top: normalizedRect.top, scrollY: window.scrollY, radius: parseOriginRadius(el),
    };
  }

  function findOriginElement(originMeta) {
    if (originMeta?.el?.isConnected && originMeta.el.getClientRects().length) return originMeta.el;
    return originMeta?.selector ? document.querySelector(originMeta.selector) : null;
  }

  function restoreRouteScroll(route, originMeta, alignCard = false) {
    const top = originMeta?.scrollY ?? route.scrollY ?? 0;
    window.scrollTo({ top, behavior: "instant" });
    if (!alignCard || !originMeta) return;
    const liveEl = findOriginElement(originMeta);
    if (!liveEl?.getClientRects().length || liveEl === originMeta.el) return;
    const delta = liveEl.getBoundingClientRect().top - originMeta.top;
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, behavior: "instant" });
  }

  function resolveOriginForClose(originMeta) {
    if (!originMeta) return null;
    const vw = window.innerWidth || 390;
    const vh = window.innerHeight || 844;
    const liveEl = findOriginElement(originMeta);
    if (liveEl) {
      const domRect = liveEl.getBoundingClientRect();
      const clamped = clampRectToViewport(domRect, vw, vh);
      if (clamped) {
        return { rect: clamped, radius: parseOriginRadius(liveEl) };
      }
    }
    const rect = clampRectToViewport(originMeta.rect, vw, vh);
    return rect ? { rect, radius: originMeta.radius } : null;
  }

  function cancelSheetAnimations(sheet) {
    if (Array.isArray(sheet?._ctAnims)) {
      sheet._ctAnims.forEach((anim) => {
        anim.onfinish = null;
        try { anim.cancel(); } catch (_) {}
      });
      sheet._ctAnims = null;
    }
  }

  function resetCardSheet(sheet) {
    if (!sheet) return;
    cancelSheetAnimations(sheet);
    sheet.classList.remove("ct-sheet-layer", "ct-at-top", "ct-preserve-glass");
    sheet.style.transformOrigin = "";
    sheet.style.transform = "";
    sheet.style.clipPath = "";
    sheet.style.opacity = "";
    sheet.style.animation = "";
    syncCtAnimatingClass();
  }

  function cancelActiveTransition(holdOpeningPose = false) {
    const transition = activeCt;
    if (!transition) return null;
    activeCt = null;
    clearTimeout(transition.timer);
    cancelAnimationFrame(transition.frameId);
    let held = null;
    try {
      if (holdOpeningPose && transition.opening) {
        const { sheet } = transition;
        const pose = transition.getPose();
        const elapsed = transition.getElapsed();
        transition.pinPose?.(pose);
        transition.cancelAnims?.();
        held = { sheet, pose, elapsed };
      }
      transition.finish(held === null);
    } finally {
      syncCtAnimatingClass();
      syncNativeBackState();
      if (!held) flushPendingDashboardRefresh();
    }
    return held;
  }

  function animateCardSheet(sheet, origin, opening, finish, held = null) {
    // Keep the glass at device scale and animate only its visible bounds.
    const {left, top, width, height} = origin.rect;
    const cardPose = { t: top, r: window.innerWidth - left - width,
      b: window.innerHeight - top - height, l: left, rad: origin.radius, op: 0 };
    const fullPose = { t: 0, r: 0, b: 0, l: 0, rad: 0, op: 1 };
    const startPose = held ? { ...held.pose } : (opening ? cardPose : fullPose);
    const endPose = opening ? fullPose : cardPose;
    const duration = opening ? CT_OPEN_DURATION :
      held ? Math.max(90, Math.min(CT_CLOSE_DURATION, held.elapsed)) : CT_CLOSE_DURATION;
    const bezier = opening ? CT_OPEN_BEZIER : CT_CLOSE_BEZIER;

    let startTime = null;

    const formatClipPath = (pose) =>
      `inset(${pose.t.toFixed(2)}px ${pose.r.toFixed(2)}px ${pose.b.toFixed(2)}px ${pose.l.toFixed(2)}px round ${pose.rad.toFixed(2)}px)`;

    const applyPose = (pose) => {
      sheet.style.clipPath = formatClipPath(pose);
      sheet.style.opacity = pose.op.toFixed(4);
    };

    const computePoseAt = (elapsedMs) => {
      if (startTime === null) return { ...startPose };
      const u = Math.max(0, Math.min(1, elapsedMs / duration));
      const p = solveCubicBezierY(u, bezier[0], bezier[1], bezier[2], bezier[3]);
      const lerp = (a, b) => a + (b - a) * p;
      let op;
      if (held) {
        const k = solveCubicBezierY(u, 0.25, 0.46, 0.45, 0.94);
        op = startPose.op * (1 - k);
      } else if (opening) {
        op = u >= 0.32 ? 1 : solveCubicBezierY(u / 0.32, 0.22, 1, 0.36, 1);
      } else if (u <= 0.22) {
        op = 1;
      } else if (u >= 0.88) {
        op = 0;
      } else {
        const k = solveCubicBezierY((u - 0.22) / 0.66, 0.42, 0, 0.58, 1);
        op = 1 - k;
      }
      return {
        t: lerp(startPose.t, endPose.t),
        r: lerp(startPose.r, endPose.r),
        b: lerp(startPose.b, endPose.b),
        l: lerp(startPose.l, endPose.l),
        rad: lerp(startPose.rad, endPose.rad),
        op,
      };
    };

    cancelSheetAnimations(sheet);
    document.documentElement.classList.add("ct-animating");
    applyPose(startPose);

    const transition = {
      sheet,
      opening,
      frameId: 0,
      timer: null,
      getElapsed: () => (startTime === null ? 0 : Math.max(0, performance.now() - startTime)),
      getPose: () => computePoseAt(transition.getElapsed()),
      pinPose: applyPose,
      cancelAnims: () => cancelSheetAnimations(sheet),
      finish: (commit) => {
        try {
          finish(commit);
        } finally {
          // Swap views while the departing layer still has its final clip
          // and opacity. Release it only after it is no longer visible.
          if (commit) {
            resetCardSheet(sheet);
            if (opening) window.scrollTo({ top: 0, behavior: "instant" });
          }
        }
      },
    };
    activeCt = transition;
    syncNativeBackState();

    const complete = () => {
      if (activeCt === transition) cancelActiveTransition();
    };

    const step = (now) => {
      if (activeCt !== transition) return;
      if (startTime === null) startTime = now;
      const elapsed = now - startTime;
      applyPose(computePoseAt(elapsed));
      if (elapsed < duration) {
        transition.frameId = requestAnimationFrame(step);
      } else {
        complete();
      }
    };

    const launch = (now) => {
      if (activeCt !== transition) return;
      clearTimeout(transition.timer);
      startTime = now;
      if (typeof sheet.animate === "function") {
        const easingStr = `cubic-bezier(${bezier[0]}, ${bezier[1]}, ${bezier[2]}, ${bezier[3]})`;
        const geomAnim = sheet.animate(
          [
            { clipPath: formatClipPath(startPose) },
            { clipPath: formatClipPath(endPose) },
          ],
          { duration, easing: easingStr, fill: "both" },
        );
        let opKeyframes;
        if (held) {
          opKeyframes = [
            { opacity: startPose.op, easing: "cubic-bezier(0.25, 0.46, 0.45, 0.94)" },
            { opacity: 0 },
          ];
        } else if (opening) {
          opKeyframes = [
            { opacity: 0, offset: 0, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
            { opacity: 1, offset: 0.32 },
            { opacity: 1, offset: 1 },
          ];
        } else {
          opKeyframes = [
            { opacity: 1, offset: 0 },
            { opacity: 1, offset: 0.22, easing: "ease-in-out" },
            { opacity: 0, offset: 0.88 },
            { opacity: 0, offset: 1 },
          ];
        }
        const opAnim = sheet.animate(opKeyframes, { duration, fill: "both" });
        cancelSheetAnimations(sheet);
        sheet._ctAnims = [geomAnim, opAnim];
        sheet.style.clipPath = "";
        sheet.style.transform = "";
        sheet.style.opacity = "";
        geomAnim.onfinish = complete;
        transition.timer = setTimeout(complete, duration + 250);
      } else {
        transition.frameId = requestAnimationFrame(step);
        transition.timer = setTimeout(complete, duration + 300);
      }
    };

    // WAAPI applies its first keyframe before the next paint. Starting both
    // effects now lets Chromium prepare their layers in the same transaction.
    launch(performance.now());

  }

  // Source cards and dock buttons remain visible behind the moving sheet.
  // Ignore taps there until the navigation transaction is done.
  window.addEventListener("click", (event) => {
    if (!(activeCt || restoringNavigation) || !(event.target instanceof Element)) return;
    if (!event.target.closest("#app-shell") || event.target.closest("dialog")) return;
    if (event.target.closest("#bottom-dock") && activeCt && !activeCt.opening && !restoringNavigation) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  function runContainerOpenTransition({ targetEl, originMeta, prepare, onFinish }) {
    cancelActiveTransition();
    window.__clearGlassTouchLight?.(true);
    window.__panelPtr?.onCancelDrag?.();
    const rect = clampRectToViewport(originMeta?.rect, window.innerWidth, window.innerHeight);
    if (!canUseContainerTransform() || !rect || !targetEl) {
      prepare?.();
      onFinish?.();
      window.scrollTo({ top: 0, behavior: "instant" });
      return Promise.resolve(true);
    }

    targetEl.classList.remove("hidden", "ios-view-enter", "ios-view-pop", "ios-view-exit-right");
    targetEl.classList.add("ct-sheet-layer", "ct-at-top");
    document.documentElement.classList.add("ct-animating");
    if (targetEl === $("workout-detail-card") && $("tab-workouts").classList.contains("hidden")) {
      $("tab-workouts").classList.add("ct-keep-mounted");
    }
    prepare?.();
    // The opening layer clips at the top and cannot retain a scroll offset.
    return new Promise((resolve) => {
      animateCardSheet(targetEl, { rect, radius: originMeta.radius }, true, (commit) => {
        try {
          if (commit) {
            $("tab-workouts").classList.remove("ct-keep-mounted");
            onFinish?.();
            sealOneShotAnimations(targetEl);
          }
        } finally {
          resolve(commit);
        }
      });
    });
  }

  function runContainerCloseTransition({ closingEl, keepTabWorkoutsMounted, originMeta, held, onFinish }) {
    window.__clearGlassTouchLight?.(true);
    window.__panelPtr?.onCancelDrag?.();
    const origin = resolveOriginForClose(originMeta);
    const finish = () => {
      onFinish?.();
      if (keepTabWorkoutsMounted) $("tab-workouts").classList.remove("ct-keep-mounted");
    };
    if (!canUseContainerTransform() || !origin || !closingEl) {
      finish();
      resetCardSheet(closingEl);
      return;
    }
    animateCardSheet(closingEl, origin, false, finish, held);
  }

  function pushHealthView(view, options = {}) {
    if (restoringNavigation) return;
    const previous = { ...navigationRoute, scrollY: window.scrollY, filter: currentSportFilter };
    if (detailState) previous.metricOptions = { ...detailState };
    if (proInsightsOpen) previous.insightsTab = proInsightsTab;
    history.replaceState({ healthSession: navigationSession, route: previous }, "");
    navigationRoute = { tab: currentTab, view, depth: previous.depth + 1, ...options };
    history.pushState({ healthSession: navigationSession, route: navigationRoute }, "");
    syncNativeBackState();
  }

  function requestHealthBack(fallback) {
    if (navigationRoute.depth > 0) history.back();
    else fallback();
  }

  window.addEventListener("popstate", (event) => {
    if (event.state?.healthSession !== navigationSession) return;
    navigationRestore = navigationRestore
      .then(() => restoreHealthRoute(event.state.route))
      .catch((error) => console.error("Could not restore health dashboard view", error));
  });

  async function restoreHealthRoute(route) {
    const prior = navigationRoute;
    const held = cancelActiveTransition(route.depth < prior.depth);
    navigationRoute = route;
    const overlay = document.querySelector(".training-overlay[open]");
    if (overlay) {
      overlay.dispatchEvent(new Event("health-overlay-dismiss"));
      if (prior.view === "overlay" && route.view === "workout" && prior.workoutId === route.workoutId) {
        syncNativeBackState();
        flushPendingDashboardRefresh();
        return;
      }
    }
    if ($("app-shell").classList.contains("hidden")) return;
    window.__clearGlassTouchLight?.();

    const isGoingBack = Boolean(prior && route && Number(prior.depth) > Number(route.depth));
    let closingEl = null;
    if (isGoingBack && canUseContainerTransform()) {
      if (prior.view === "metric" && route.view !== "metric") closingEl = $("metric-detail-view");
      else if (prior.view === "all-health") closingEl = $("all-health-view");
      else if (prior.view === "insights") closingEl = $("pro-insights-view");
      else if (prior.view === "workout") closingEl = $("workout-detail-card");
      if (closingEl && closingEl.classList.contains("hidden") && prior.view !== "workout") {
        closingEl = null;
      }
    }
    const savedOriginMeta = isGoingBack ? (originByDepth.get(prior.depth) || null) : null;
    for (const d of [...originByDepth.keys()]) {
      if (d > (route?.depth ?? 0)) originByDepth.delete(d);
    }

    if (held && held.sheet !== closingEl) {
      resetCardSheet(held.sheet);
      $("tab-workouts").classList.remove("ct-keep-mounted");
    }
    const keepWorkoutsMounted = closingEl === $("workout-detail-card") &&
      (route.tab !== "workouts" || route.view !== "tab");
    const cachedMetricData = detailDataCache;
    const cachedMetricState = detailState ? { ...detailState } : null;
    const mountedMetricAttr = $("metric-detail-body")?.getAttribute("data-mounted-metric");

    if (closingEl) {
      const closingScrollY = held?.sheet === closingEl ? closingEl.scrollTop : window.scrollY || 0;
      closingEl.style.animation = "none";
      closingEl.classList.remove("ios-view-enter", "ios-view-pop", "ios-view-exit-right", "hidden", "ct-preserve-glass");
      closingEl.classList.add("ct-sheet-layer");
      closingEl.classList.toggle("ct-at-top", closingScrollY <= 1);
      document.documentElement.classList.add("ct-animating");
      closingEl.scrollTop = closingScrollY;
      if (keepWorkoutsMounted) {
        $("tab-workouts")?.classList.add("ct-keep-mounted");
        $("tab-workouts")?.classList.remove("hidden");
      }
    }

    restoringNavigation = true;
    syncNativeBackState();
    try {
      ++workoutRequest;
      $("workouts-layout").classList.remove("mobile-detail-open");
      currentSportFilter = route.filter || "";
      const workout = route.view === "workout" || route.view === "overlay";
      await switchTab(
        route.tab,
        workout
          ? { openDetailId: route.workoutId, keepClosingEl: closingEl, keepWorkoutsMounted, forTargetView: route.view }
          : { keepClosingEl: closingEl, keepWorkoutsMounted, forTargetView: route.view }
      );
      if (route.view === "all-health" || route.metricOptions?.fromTab === "all-health") {
        openAllHealthView(null, { keepClosingEl: closingEl });
      }
      if (route.view === "metric") {
        const reqOpts = route.metricOptions || {};
        const canReuseMetric = Boolean(
          cachedMetricData &&
          cachedMetricState &&
          cachedMetricData.metric === route.metric &&
          (reqOpts.scope || cachedMetricState.scope) === cachedMetricState.scope &&
          (reqOpts.endDate || null) === (cachedMetricState.endDate || null) &&
          mountedMetricAttr === route.metric
        );
        await openMetricDetail(route.metric, {
          ...reqOpts,
          keepClosingEl: closingEl,
          reuseCached: canReuseMetric ? { data: cachedMetricData, state: cachedMetricState } : null,
        });
      }
      if (route.view === "insights") {
        await openProInsightsView(route.insightsTab, route.tab, null, { keepClosingEl: closingEl });
      }
      if (route.view === "overlay" && overlaySeries.size) openTrainingOverlay();
      if (closingEl) freezePanelAnimations($("tab-" + (route.tab || "summary")));
      restoreRouteScroll(route, savedOriginMeta, true);
      if (closingEl) {
        runContainerCloseTransition({
          closingEl,
          keepTabWorkoutsMounted: keepWorkoutsMounted,
          originMeta: savedOriginMeta,
          held: held?.sheet === closingEl ? held : null,
          onFinish: () => {
            if (closingEl !== $("workout-detail-card")) {
              closingEl.classList.add("hidden");
              if (closingEl === $("metric-detail-view") && navigationRoute.view !== "metric") {
                $("metric-detail-body")?.removeAttribute("data-mounted-metric");
              }
            } else if (currentTab !== "workouts" || navigationRoute.view !== "tab") {
              $("tab-workouts")?.classList.add("hidden");
            }
            if (keepWorkoutsMounted) {
              $("tab-workouts")?.classList.remove("ct-keep-mounted");
            }
            syncNativeBackState();
          },
        });
      } else {
        syncCtAnimatingClass();
      }
    } catch (error) {
      console.error("Could not restore health dashboard view", error);
      if (closingEl) {
        resetCardSheet(closingEl);
        if (closingEl !== $("workout-detail-card")) {
          closingEl.classList.add("hidden");
          if (closingEl === $("metric-detail-view") && navigationRoute.view !== "metric") {
            $("metric-detail-body")?.removeAttribute("data-mounted-metric");
          }
        }
        $("tab-workouts")?.classList.remove("ct-keep-mounted");
      }
      syncCtAnimatingClass();
    } finally {
      restoringNavigation = false;
      syncNativeBackState();
      flushPendingDashboardRefresh();
    }
  }

  function refitWorkoutMap() {
    if (!leafletMap) return;
    try {
      leafletMap.invalidateSize();
      if (lastWorkoutBounds) leafletMap.fitBounds(lastWorkoutBounds, { padding: [18, 18] });
    } catch (_) {}
  }

  async function switchTab(tab, opts = {}) {
    if (tab === "workouts" && opts.openDetailId && !restoringNavigation && !opts.keepClosingEl && canUseContainerTransform() && opts.originEl) {
      const originMeta = captureOriginCard(opts.originEl);
      if (originMeta) {
        cancelActiveTransition();
        const prevOrigin = {
          tab: currentTab,
          y: window.scrollY,
          detail: detailState && { ...detailState },
          pro: proInsightsOpen ? proInsightsTab : null,
          filter: currentSportFilter,
        };
        pushHealthView("workout", { tab: "workouts", workoutId: opts.openDetailId });
        originByDepth.set(navigationRoute.depth, originMeta);
        workoutOrigin = prevOrigin;
        currentSportFilter = "";
        const finalizeTabSwitch = () => {
          if (detailExitTimer) {
            clearTimeout(detailExitTimer);
            detailExitTimer = null;
          }
          if (woExitTimer) {
            clearTimeout(woExitTimer);
            woExitTimer = null;
          }
          if (allHealthExitTimer) {
            clearTimeout(allHealthExitTimer);
            allHealthExitTimer = null;
          }
          if (proInsightsExitTimer) {
            clearTimeout(proInsightsExitTimer);
            proInsightsExitTimer = null;
          }
          setDockCompact(false);
          currentTab = "workouts";
          allHealthOpen = false;
          proInsightsOpen = false;
          detailState = null;
          detailDataCache = null;
          const mBody = $("metric-detail-body");
          if (mBody) mBody.removeAttribute("data-mounted-metric");
          $("app-shell").classList.remove("detail-active");
          $("app-shell").classList.add("wo-detail-active");
          $("workouts-layout").classList.add("mobile-detail-open");
          $("metric-detail-view")?.classList.add("hidden");
          $("all-health-view")?.classList.add("hidden");
          $("pro-insights-view")?.classList.add("hidden");
          document.querySelectorAll(".tab-panel").forEach((p) => {
            if (p.id === "metric-detail-view" || p.id === "all-health-view" || p.id === "pro-insights-view") return;
            p.classList.toggle("hidden", p.id !== "tab-workouts");
          });
          document.querySelectorAll(".nav-item, .bottom-tab-btn").forEach((b) => {
            b.classList.toggle("active", b.dataset.tab === prevOrigin.tab);
          });
          updateDockPosition(prevOrigin.tab);
          const mTitleEl = $("mobile-page-title");
          if (mTitleEl) mTitleEl.textContent = TAB_TITLES.workouts || "体能训练";

          if (!workoutsCache || workoutsRenderedKey !== "|1") {
            loadWorkouts("", { skipDetail: true }).catch(() => {});
          }
        };
        await loadWorkoutDetail(opts.openDetailId, true, originMeta, { deferFinalize: finalizeTabSwitch });
        return;
      }
    }

    if (opts.openDetailId) {
      pushHealthView("workout", { tab: "workouts", workoutId: opts.openDetailId });
    } else if (!restoringNavigation) {
      cancelActiveTransition();
      originByDepth.clear();
      navigationRoute = { tab, view: "tab", depth: 0, filter: currentSportFilter };
      history.replaceState({ healthSession: navigationSession, route: navigationRoute }, "");
      syncNativeBackState();
    }
    if (detailExitTimer) {
      clearTimeout(detailExitTimer);
      detailExitTimer = null;
    }
    if (woExitTimer) {
      clearTimeout(woExitTimer);
      woExitTimer = null;
    }
    if (allHealthExitTimer) {
      clearTimeout(allHealthExitTimer);
      allHealthExitTimer = null;
    }
    if (proInsightsExitTimer) {
      clearTimeout(proInsightsExitTimer);
      proInsightsExitTimer = null;
    }
    setDockCompact(false);
    if (tab === "workouts" && opts.openDetailId) {
      workoutOrigin = { tab: currentTab, y: window.scrollY, detail: detailState && { ...detailState }, pro: proInsightsOpen ? proInsightsTab : null, filter: currentSportFilter };
      if (!restoringNavigation) currentSportFilter = "";
    } else workoutOrigin = null;
    currentTab = tab;
    allHealthOpen = false;
    proInsightsOpen = false;
    detailState = null;
    detailDataCache = null;
    const keepEl = opts.keepClosingEl || null;
    const body = $("metric-detail-body");
    if (body && keepEl !== $("metric-detail-view")) body.removeAttribute("data-mounted-metric");
    $("app-shell").classList.remove("detail-active");
    if (tab !== "workouts" || !opts.openDetailId) {
      $("app-shell").classList.remove("wo-detail-active");
    }
    if (keepEl !== $("metric-detail-view")) $("metric-detail-view").classList.add("hidden");
    if (keepEl !== $("all-health-view")) $("all-health-view")?.classList.add("hidden");
    if (keepEl !== $("pro-insights-view")) $("pro-insights-view")?.classList.add("hidden");

    document.querySelectorAll(".nav-item, .bottom-tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    updateDockPosition(tab);

    const suppressTabShow = Boolean(
      restoringNavigation && (
        opts.forTargetView === "all-health" ||
        opts.forTargetView === "metric" ||
        opts.forTargetView === "insights"
      )
    );
    document.querySelectorAll(".tab-panel").forEach((p) => {
      if (p.id === "metric-detail-view" || p.id === "all-health-view" || p.id === "pro-insights-view") return;
      if (p.id === "tab-workouts" && opts.keepWorkoutsMounted) {
        p.classList.remove("hidden");
        return;
      }
      const isTarget = !suppressTabShow && p.id === `tab-${tab}`;
      if (isTarget && restoringNavigation) freezePanelAnimations(p);
      p.classList.toggle("hidden", !isTarget);
      if (isTarget && !restoringNavigation) triggerChartMotion(p, "chart-crossfade");
    });
    if (!restoringNavigation) window.scrollTo({ top: 0, behavior: "instant" });

    const mTitle = $("mobile-page-title");
    if (mTitle) mTitle.textContent = TAB_TITLES[tab] || "健康";

    let tabDidRender = false;
    if (tab === "summary") {
      if (!overviewCache) {
        await loadOverview(30);
        tabDidRender = true;
      } else if (summaryRenderedRef !== overviewCache) {
        renderSummaryTab(overviewCache);
        tabDidRender = true;
      }
    } else if (tab === "workouts") {
      const needReloadWorkouts =
        !workoutsCache ||
        Boolean(opts.openDetailId) ||
        workoutsRenderedKey !== `${currentSportFilter || ""}|1`;
      if (needReloadWorkouts) {
        await loadWorkouts(currentSportFilter, opts);
        tabDidRender = true;
      } else if (!isMobileViewport() && !workoutDetailCache && selectedWorkoutId) {
        await loadWorkoutDetail(selectedWorkoutId, false);
      }
    } else if (tab === "browse") {
      if (!overviewCache) {
        await loadOverview(30);
        tabDidRender = true;
      } else if (browseRenderedRef !== overviewCache) {
        renderBrowseCategories(overviewCache);
        tabDidRender = true;
      }
      const wantDay = opts.date || selectedDay;
      if (!dayCache || !dayRenderedDate || (wantDay && dayRenderedDate !== wantDay)) {
        await loadDaySnapshot(wantDay);
        tabDidRender = true;
      }
    } else if (tab === "more") {
      if (!overviewCache) {
        await loadOverview(30);
        tabDidRender = true;
      }
      if (!$("sys-status-box")?.childElementCount) {
        renderMoreTab();
        tabDidRender = true;
      }
    }

    if (!restoringNavigation || tabDidRender) {
      if (opts.keepClosingEl || activeCt) pendingPostTransitionResize = true;
      else setTimeout(resizeAllCharts, 45);
    }
  }

  document.querySelectorAll(".nav-item, .bottom-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("bottom-tab-btn") && performance.now() - lastDockDragAt < 450) {
        return;
      }
      activateBottomTab(btn.dataset.tab);
    });
  });

  initBottomDockGesture();
  initScrollCompactDock();

  $("summary-all-workouts-btn").addEventListener("click", () => {
    $("workouts-layout").classList.remove("mobile-detail-open");
    $("app-shell").classList.remove("wo-detail-active");
    switchTab("workouts");
  });

  $("summary-browse-link").addEventListener("click", () => {
    switchTab("browse");
  });

  $("summary-all-data-btn")?.addEventListener("click", (e) => {
    openAllHealthView(e.currentTarget);
  });

  function openAllHealthView(originEl = null, opts = {}) {
    if (!restoringNavigation) cancelActiveTransition();
    const shouldAnimate = Boolean(!restoringNavigation && originEl && canUseContainerTransform());
    const originMeta = shouldAnimate ? captureOriginCard(originEl) : null;
    pushHealthView("all-health");
    if (originMeta) originByDepth.set(navigationRoute.depth, originMeta);
    if (allHealthExitTimer) {
      clearTimeout(allHealthExitTimer);
      allHealthExitTimer = null;
    }
    allHealthOpen = true;
    allHealthScrollY = window.scrollY || 0;
    setDockCompact(false);
    const ahView = $("all-health-view");
    const renderAllHealthOnOpen = () => {
      if (!overviewCache || overviewCache.empty || allHealthRenderedRef === overviewCache) return;
      if (!restoringNavigation) ahView?.classList.remove("no-anim-replay");
      renderAllHealthView(overviewCache);
    };
    if (originMeta && ahView) {
      runContainerOpenTransition({
        targetEl: ahView,
        originMeta,
        prepare: () => {
          renderAllHealthOnOpen();
          sealOneShotAnimations(ahView);
        },
        onFinish: () => {
          if (!allHealthOpen) return;
          $("app-shell").classList.add("detail-active");
          document.querySelectorAll(".tab-panel").forEach((p) => {
            if (p !== ahView) p.classList.add("hidden");
          });
          ahView.classList.remove("hidden");

        },
      });
      return;
    }
    renderAllHealthOnOpen();
    $("app-shell").classList.add("detail-active");
    const keepEl = opts.keepClosingEl || null;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      if (p === keepEl) return;
      if (p.id === "tab-workouts" && p.classList.contains("ct-keep-mounted")) return;
      p.classList.add("hidden");
    });
    if (ahView) {
      if (restoringNavigation) freezePanelAnimations(ahView);
      ahView.classList.remove("hidden");
      if (!restoringNavigation) triggerViewTransition(ahView, "ios-view-enter");
    }
    if (!restoringNavigation) window.scrollTo({ top: 0, behavior: "instant" });
  }

  function closeAllHealthView() {
    if (!allHealthOpen) return;
    allHealthOpen = false;
    const ahView = $("all-health-view");
    if (!ahView) return;
    triggerViewTransition(ahView, "ios-view-exit-right");

    const finishClose = () => {
      allHealthExitTimer = null;
      ahView.classList.remove("ios-view-exit-right");
      ahView.classList.add("hidden");
      $("app-shell").classList.remove("detail-active");
      document.querySelectorAll(".tab-panel").forEach((p) => {
        if (p.id === "metric-detail-view" || p.id === "all-health-view") return;
        const isBack = p.id === `tab-${currentTab || "summary"}`;
        if (isBack) freezePanelAnimations(p);
        p.classList.toggle("hidden", !isBack);
      });
      updateDockPosition(currentTab || "summary");
      window.scrollTo({ top: allHealthScrollY, behavior: "instant" });
      syncNativeBackState();
      setTimeout(resizeAllCharts, 40);
    };

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      finishClose();
    } else {
      allHealthExitTimer = setTimeout(finishClose, 175);
    }
  }

  $("all-health-back-btn")?.addEventListener("click", () => requestHealthBack(closeAllHealthView));

  async function openProInsightsView(tab = "load", fromTab = currentTab, originEl = null, opts = {}) {
    if (!restoringNavigation) cancelActiveTransition();
    const shouldAnimate = Boolean(!restoringNavigation && originEl && canUseContainerTransform());
    const originMeta = shouldAnimate ? captureOriginCard(originEl) : null;
    pushHealthView("insights", { insightsTab: tab });
    if (originMeta) originByDepth.set(navigationRoute.depth, originMeta);
    if (proInsightsExitTimer) {
      clearTimeout(proInsightsExitTimer);
      proInsightsExitTimer = null;
    }
    proInsightsOpen = true;
    proInsightsTab = tab || "load";
    proInsightsFromTab = fromTab || currentTab || "summary";
    proInsightsScrollY = window.scrollY || 0;
    setDockCompact(false);

    const piView = $("pro-insights-view");
    const piBody = $("pro-insights-body");
    const reuseMountedPro = Boolean(
      restoringNavigation &&
      proInsightsCache &&
      proInsightsRenderedRef === proInsightsCache &&
      proInsightsRenderedTab === proInsightsTab &&
      piBody?.getAttribute("data-mounted-pro") === "1"
    );
    if (!reuseMountedPro && piBody && !proInsightsCache) piBody.removeAttribute("data-mounted-pro");
    if (restoringNavigation && piView) freezePanelAnimations(piView);
    else if (piView) piView.classList.remove("no-anim-replay");

    if (originMeta && piView) {
      const prewarmedPro = proInsightsCache && !proInsightsCache.empty ? proInsightsCache : null;
      const proFetchPromise = prewarmedPro ? null : fetchProInsightsData();
      const afterOpening = runContainerOpenTransition({
        targetEl: piView,
        originMeta,
        prepare: () => {
          if (prewarmedPro && !prewarmedPro.empty) {
            const canReuseHidden = Boolean(
              proInsightsRenderedRef === prewarmedPro &&
              proInsightsRenderedTab === proInsightsTab &&
              piBody?.getAttribute("data-mounted-pro") === "1"
            );
            if (!canReuseHidden) renderProInsightsView(prewarmedPro);
            sealOneShotAnimations(piView);
          } else if (piBody) {
            piBody.innerHTML = '<div class="card"><div class="card-note">正在计算深度生理与训练分析...</div></div>';
          }
        },
        onFinish: () => {
          if (!proInsightsOpen) return;
          $("app-shell").classList.add("detail-active");
          document.querySelectorAll(".tab-panel").forEach((p) => {
            if (p !== piView) p.classList.add("hidden");
          });
          piView.classList.remove("hidden");

        },
      });
      if (!prewarmedPro || prewarmedPro.empty) {
        await fetchAndRenderProInsights({ afterOpening, fetchPromise: proFetchPromise });
      }
      return;
    }

    $("app-shell").classList.add("detail-active");
    const keepEl = opts.keepClosingEl || null;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      if (p === keepEl) return;
      if (p.id === "tab-workouts" && p.classList.contains("ct-keep-mounted")) return;
      p.classList.add("hidden");
    });
    if (piView) {
      piView.classList.remove("hidden");
      if (!restoringNavigation) triggerViewTransition(piView, "ios-view-enter");
    }
    if (!restoringNavigation) window.scrollTo({ top: 0, behavior: "instant" });
    if (!reuseMountedPro) await fetchAndRenderProInsights();
  }

  async function fetchProInsightsData() {
    if (proInsightsCache && !proInsightsCache.empty) return proInsightsCache;
    if (proInsightsInflight) return proInsightsInflight;
    const epoch = preloadEpoch;
    const p = apiJson("/api/v1/dashboard/insights")
      .then((data) => {
        if (epoch === preloadEpoch) proInsightsCache = data;
        return data;
      })
      .finally(() => {
        if (proInsightsInflight === p) proInsightsInflight = null;
      });
    proInsightsInflight = p;
    return p;
  }

  function canPopulateOpening(sheet) {
    return activeCt?.opening && activeCt.sheet === sheet && !restoringNavigation;
  }

  async function fetchAndRenderProInsights(opts = {}) {
    const piBody = $("pro-insights-body");
    if (!proInsightsCache && piBody && !opts.afterOpening) {
      piBody.innerHTML = '<div class="card"><div class="card-note">正在计算深度生理与训练分析...</div></div>';
    }
    const route = navigationRoute;
    try {
      const data = await (opts.fetchPromise || fetchProInsightsData());
      if (opts.afterOpening && !canPopulateOpening($("pro-insights-view")) && !(await opts.afterOpening)) return;
      if (proInsightsOpen && route === navigationRoute) {
        const canReuse = Boolean(
          proInsightsRenderedRef === data &&
          proInsightsRenderedTab === proInsightsTab &&
          piBody?.getAttribute("data-mounted-pro") === "1"
        );
        if (!canReuse) renderProInsightsView(data);
        if (opts.afterOpening) sealOneShotAnimations($("pro-insights-view"));
      }
    } catch (err) {
      if (opts.afterOpening && !(await opts.afterOpening)) return;
      if (piBody && proInsightsOpen && route === navigationRoute) {
        piBody.innerHTML = `<div class="card"><div class="card-note">加载洞察失败：${escapeHtml(err.message)}</div></div>`;
      }
    }
  }

  function closeProInsightsView() {
    if (!proInsightsOpen) return;
    proInsightsOpen = false;
    const piView = $("pro-insights-view");
    if (!piView) return;
    triggerViewTransition(piView, "ios-view-exit-right");

    const finishClose = () => {
      proInsightsExitTimer = null;
      piView.classList.remove("ios-view-exit-right");
      piView.classList.add("hidden");
      $("app-shell").classList.remove("detail-active");
      const targetTab = proInsightsFromTab || currentTab || "summary";
      document.querySelectorAll(".tab-panel").forEach((p) => {
        if (p.id === "metric-detail-view" || p.id === "all-health-view" || p.id === "pro-insights-view") return;
        const isBack = p.id === `tab-${targetTab}`;
        if (isBack) freezePanelAnimations(p);
        p.classList.toggle("hidden", !isBack);
      });
      updateDockPosition(targetTab);
      window.scrollTo({ top: proInsightsScrollY, behavior: "instant" });
      syncNativeBackState();
      setTimeout(resizeAllCharts, 40);
    };

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      finishClose();
    } else {
      proInsightsExitTimer = setTimeout(finishClose, 175);
    }
  }

  $("pro-insights-back-btn")?.addEventListener("click", () => requestHealthBack(closeProInsightsView));
  $("wo-pro-insights-btn")?.addEventListener("click", (e) => openProInsightsView("aerobic", "workouts", e.currentTarget));
  $("browse-pro-insights-btn")?.addEventListener("click", (e) => openProInsightsView("load", "browse", e.currentTarget));

  // Push / Pop Metric Detail Stack
  function normalizeTemperatureMetric(metric) {
    return metric === "body_temperature" || metric === "skin_temperature" ? "temperature" : metric;
  }

  function defaultMetricScope(metric) {
    return metric === "activity" || metric === "sleep" || metric === "active_energy" || metric === "distance"
      ? "D"
      : metric === "vo2max" || metric === "running_index"
        ? "6M"
        : metric === "training_index"
          ? "M"
          : "W";
  }

  async function openMetricDetail(metric, opts = {}, originEl = null) {
    metric = normalizeTemperatureMetric(metric);
    if (!restoringNavigation) cancelActiveTransition();
    const shouldAnimate = Boolean(!restoringNavigation && originEl && canUseContainerTransform());
    const originMeta = shouldAnimate ? captureOriginCard(originEl) : null;
    pushHealthView("metric", { metric, metricOptions: opts });
    if (originMeta) originByDepth.set(navigationRoute.depth, originMeta);
    if (detailExitTimer) {
      clearTimeout(detailExitTimer);
      detailExitTimer = null;
    }
    if (allHealthExitTimer) {
      clearTimeout(allHealthExitTimer);
      allHealthExitTimer = null;
    }

    const mdView = $("metric-detail-view");
    const body = $("metric-detail-body");
    if (opts.reuseCached && mdView) {
      detailDataCache = opts.reuseCached.data;
      detailState = { ...opts.reuseCached.state };
      if (body) body.dataset.mountedMetric = metric;
      freezePanelAnimations(mdView);
      $("app-shell").classList.add("detail-active");
      const keepEl = opts.keepClosingEl || null;
      document.querySelectorAll(".tab-panel").forEach((p) => {
        if (p === mdView || p === keepEl) return;
        if (p.id === "tab-workouts" && p.classList.contains("ct-keep-mounted")) return;
        p.classList.add("hidden");
      });
      mdView.classList.remove("hidden");
      $("detail-back-label").textContent = detailState.fromTab === "all-health" ? "所有健康数据" : (TAB_TITLES[detailState.fromTab] || "返回");
      $("detail-nav-title").textContent = detailDataCache.title || METRIC_META[metric]?.title || "详情";
      return;
    }

    const initScope = opts.scope || defaultMetricScope(metric);
    const initSleepMode = opts.sleepMode || "stages";
    detailState = {
      metric,
      scope: initScope,
      endDate: opts.endDate || null,
      fromTab: opts.fromTab || currentTab,
      scrollY: window.scrollY || 0,
      sleepMode: initSleepMode,
      ecgId: opts.ecgId || null,
      hrMode: getHrChartMode(),
      prevPrimaryText: null,
      pendingDir: "initial",
    };

    if (body) body.removeAttribute("data-mounted-metric");
    $("detail-back-label").textContent = detailState.fromTab === "all-health" ? "所有健康数据" : (TAB_TITLES[detailState.fromTab] || "返回");
    $("detail-nav-title").textContent = METRIC_META[metric]?.title || "详情";
    if (mdView) {
      if (restoringNavigation) freezePanelAnimations(mdView);
      else mdView.classList.remove("no-anim-replay");
    }

    if (originMeta && mdView) {
      detailDataCache = null;
      const stateRef = detailState;
      const routeRef = navigationRoute;
      const request = ++metricRequest;
      const prewarmedData = metricQueryCache.get(metricQueryKey(stateRef)) || null;
      const fetchPromise = prewarmedData ? null : fetchMetricData(stateRef);
      if (restoringNavigation || request !== metricRequest || detailState !== stateRef || navigationRoute !== routeRef) {
        return;
      }
      const finishOpening = () => {
        if (detailState !== stateRef) return;
        $("app-shell").classList.add("detail-active");
        document.querySelectorAll(".tab-panel").forEach((p) => {
          if (p !== mdView) p.classList.add("hidden");
        });
        mdView.classList.remove("hidden");

        setTimeout(resizeAllCharts, 40);
      };
      if (prewarmedData) {
        await runContainerOpenTransition({
          targetEl: mdView,
          originMeta,
          prepare: () => {
            if (detailState !== stateRef) return;
            detailDataCache = prewarmedData;
            detailState.pendingDir = null;
            detailState.endDate = prewarmedData.anchor_date || detailState.endDate;
            $("detail-nav-title").textContent = prewarmedData.title || METRIC_META[metric]?.title || "详情";
            renderMetricDetailScreen(prewarmedData, "initial");
            sealOneShotAnimations(mdView);
          },
          onFinish: finishOpening,
        });
        return;
      }
      const afterOpening = runContainerOpenTransition({
        targetEl: mdView,
        originMeta,
        prepare: () => {
          if (body) body.innerHTML = '<div class="card"><div class="card-note">正在加载详细数据...</div></div>';
        },
        onFinish: finishOpening,
      });
      await fetchAndRenderMetricDetail({ afterOpening, fetchPromise });
      return;
    }

    $("app-shell").classList.add("detail-active");
    const keepEl = opts.keepClosingEl || null;
    document.querySelectorAll(".tab-panel").forEach((p) => {
      if (p === keepEl) return;
      if (p.id === "tab-workouts" && p.classList.contains("ct-keep-mounted")) return;
      p.classList.add("hidden");
    });
    mdView.classList.remove("hidden");
    if (!restoringNavigation) triggerViewTransition(mdView, "ios-view-enter");
    if (!restoringNavigation) window.scrollTo({ top: 0, behavior: "instant" });

    await fetchAndRenderMetricDetail();
  }

  function metricQueryKey(state) {
    return `${state.metric}|${state.scope}|${state.endDate || ""}|${state.ecgId || ""}`;
  }

  async function fetchMetricData(state) {
    const key = metricQueryKey(state);
    if (metricQueryCache.has(key)) return metricQueryCache.get(key);
    if (metricInflight.has(key)) return metricInflight.get(key);
    const epoch = preloadEpoch;
    const req = (async () => {
      let data;
      if (state.metric === "ecg" || state.metric === "ecg_record") {
        const query = state.ecgId ? `?id=${encodeURIComponent(state.ecgId)}` : "";
        data = await apiJson(`/api/v1/dashboard/ecg${query}`);
        data.metric = state.metric;
        data.title = METRIC_META[state.metric].title;
      } else {
        const qs = new URLSearchParams({
          type: state.metric,
          scope: state.scope,
        });
        if (state.endDate) qs.set("end", state.endDate);
        data = await apiJson(`/api/v1/dashboard/metric?${qs.toString()}`);
      }
      if (epoch === preloadEpoch) {
        cacheMapSet(metricQueryCache, key, data, 120);
        if (data?.anchor_date && !state.endDate) {
          cacheMapSet(metricQueryCache, `${state.metric}|${state.scope}|${data.anchor_date}|${state.ecgId || ""}`, data, 120);
        } else if (state.endDate && !data?.next_end) {
          cacheMapSet(metricQueryCache, `${state.metric}|${state.scope}||${state.ecgId || ""}`, data, 120);
        }
      }
      return data;
    })().finally(() => {
      if (metricInflight.get(key) === req) metricInflight.delete(key);
    });
    metricInflight.set(key, req);
    return req;
  }

  async function fetchAndRenderMetricDetail(opts = {}) {
    if (!detailState) return;
    const request = ++metricRequest;
    const state = detailState;

    if ((!detailDataCache || detailDataCache.metric !== detailState.metric) && !opts.afterOpening && !metricQueryCache.has(metricQueryKey(state))) {
      $("metric-detail-body").innerHTML = '<div class="card"><div class="card-note">正在加载详细数据...</div></div>';
    }
    let data;
    try {
      data = await (opts.fetchPromise || fetchMetricData(state));
    } catch (error) {
      if (opts.afterOpening && !(await opts.afterOpening)) return;
      if (request === metricRequest && state === detailState) {
        $("metric-detail-body").innerHTML = `<div class="card"><div class="card-note">加载详细数据失败：${escapeHtml(error.message)}</div></div>`;
      }
      return;
    }
    if (opts.afterOpening && !canPopulateOpening($("metric-detail-view")) && !(await opts.afterOpening)) return;
    if (request !== metricRequest || state !== detailState) return;
    detailDataCache = data;
    if (detailState) {
      const navDir = detailState.pendingDir || "crossfade";
      detailState.pendingDir = null;
      detailState.endDate = data.anchor_date || detailState.endDate;
      $("detail-nav-title").textContent = data.title || METRIC_META[detailState.metric]?.title || "详情";
      renderMetricDetailScreen(data, navDir);
      if (opts.afterOpening) sealOneShotAnimations($("metric-detail-view"));
    }
  }

  function closeMetricDetail() {
    if (!detailState) return;
    const backTab = detailState.fromTab || "summary";
    const restoreY = detailState.scrollY || 0;
    detailState = null;
    detailDataCache = null;
    const body = $("metric-detail-body");
    if (body) body.removeAttribute("data-mounted-metric");

    const mdView = $("metric-detail-view");
    triggerViewTransition(mdView, "ios-view-exit-right");

    const finishClose = () => {
      detailExitTimer = null;
      mdView.classList.remove("ios-view-exit-right");
      mdView.classList.add("hidden");
      const toAllHealth = backTab === "all-health";
      allHealthOpen = toAllHealth;
      $("app-shell").classList.toggle("detail-active", toAllHealth);
      document.querySelectorAll(".tab-panel").forEach((p) => {
        if (p.id === "metric-detail-view") return;
        const isBack = toAllHealth ? p.id === "all-health-view" : p.id === `tab-${backTab}`;
        if (isBack) freezePanelAnimations(p);
        p.classList.toggle("hidden", !isBack);
      });
      if (!toAllHealth) updateDockPosition(backTab);
      window.scrollTo({ top: restoreY, behavior: "instant" });
      syncNativeBackState();
      setTimeout(resizeAllCharts, 40);
    };

    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      finishClose();
    } else {
      detailExitTimer = setTimeout(finishClose, 175);
    }
  }

  $("detail-back-btn").addEventListener("click", () => requestHealthBack(closeMetricDetail));

  // -----------------------------------------------------------------------
  // Micro SVG Visualizers for Summary Cards
  // -----------------------------------------------------------------------

  function renderActivityRingsSvg(moveRatio, exRatio, standRatio, sizeClass = "rings-svg") {
    const rings = [
      { r: 47, ratio: moveRatio, color: "var(--ring-move)", delay: 0 },
      { r: 35, ratio: exRatio, color: "var(--ring-ex)", delay: 70 },
      { r: 23, ratio: standRatio, color: "var(--ring-stand)", delay: 140 },
    ];
    const parts = rings.map((rg) => {
      const circ = 2 * Math.PI * rg.r;
      const clamped = Math.max(0, Math.min(1, Number.isFinite(rg.ratio) ? rg.ratio : 0));
      const offset = circ * (1 - clamped);
      return `
        <circle cx="58" cy="58" r="${rg.r}" fill="none" stroke="var(--ring-track)" stroke-width="9.5"/>
        <circle class="ring-fg" cx="58" cy="58" r="${rg.r}" fill="none" stroke="${rg.color}" stroke-width="9.5"
          stroke-linecap="round"
          stroke-dasharray="${circ.toFixed(1)}"
          stroke-dashoffset="${offset.toFixed(1)}"
          style="--circ:${circ.toFixed(1)};--target-offset:${offset.toFixed(1)};--ring-delay:${rg.delay}ms"
          transform="rotate(-90 58 58)"/>
      `;
    });
    return `<svg viewBox="0 0 116 116" class="${sizeClass}" aria-hidden="true">${parts.join("")}</svg>`;
  }

  function renderMiniRingIcon(moveRatio, exRatio, standRatio) {
    const rings = [
      { r: 12.5, ratio: moveRatio, color: "var(--ring-move)", sw: 3.1, delay: 0 },
      { r: 8.6, ratio: exRatio, color: "var(--ring-ex)", sw: 3.1, delay: 45 },
      { r: 4.8, ratio: standRatio, color: "var(--ring-stand)", sw: 3.1, delay: 90 },
    ];
    const parts = rings.map((rg) => {
      const circ = 2 * Math.PI * rg.r;
      const clamped = Math.max(0, Math.min(1, Number.isFinite(rg.ratio) ? rg.ratio : 0));
      const offset = circ * (1 - clamped);
      return `
        <circle cx="16" cy="16" r="${rg.r}" fill="none" stroke="var(--ring-track)" stroke-width="${rg.sw}"/>
        <circle class="ring-fg" cx="16" cy="16" r="${rg.r}" fill="none" stroke="${rg.color}" stroke-width="${rg.sw}"
          stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"
          style="--circ:${circ.toFixed(1)};--target-offset:${offset.toFixed(1)};--ring-delay:${rg.delay}ms"
          transform="rotate(-90 16 16)"/>
      `;
    });
    return `<svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">${parts.join("")}</svg>`;
  }

  function renderHrCapsuleSvg(days14) {
    const valid = days14.filter((d) => d.hr_min != null && d.hr_max != null && d.hr_max >= d.hr_min);
    if (!valid.length) {
      return '<svg viewBox="0 0 132 48"><line x1="6" y1="24" x2="126" y2="24" stroke="var(--hairline)" stroke-width="2" stroke-dasharray="3 3"/></svg>';
    }
    const allMin = Math.min(...valid.map((d) => Number(d.hr_min)));
    const allMax = Math.max(...valid.map((d) => Number(d.hr_max)));
    const lo = Math.max(30, allMin - 6);
    const hi = Math.max(lo + 20, allMax + 6);
    const n = days14.length;
    const step = 124 / Math.max(n, 1);
    const barW = Math.min(5.5, Math.max(3, step * 0.52));

    const capsules = days14.map((d, idx) => {
      if (d.hr_min == null || d.hr_max == null || d.hr_max < d.hr_min) return "";
      const x = 4 + idx * step + (step - barW) / 2;
      const yTop = 4 + ((hi - Number(d.hr_max)) / (hi - lo)) * 40;
      const yBot = 4 + ((hi - Number(d.hr_min)) / (hi - lo)) * 40;
      const h = Math.max(barW, yBot - yTop);
      const isLast = idx === n - 1;
      const fill = isLast ? "var(--apple-red)" : "rgba(255,45,85,0.45)";
      let restDot = "";
      if (d.hr_rest != null) {
        const yRest = 4 + ((hi - Number(d.hr_rest)) / (hi - lo)) * 40;
        restDot = `<circle cx="${(x + barW / 2).toFixed(1)}" cy="${yRest.toFixed(1)}" r="1.8" fill="var(--surface-solid)"/>`;
      }
      return `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="${fill}"/>${restDot}`;
    });
    return `<svg viewBox="0 0 132 48" aria-hidden="true">${capsules.join("")}</svg>`;
  }

  function renderSparklineSvg(values, strokeVar, fillRgba) {
    const pts = [];
    values.forEach((v, i) => {
      if (v !== null && v !== undefined && !Number.isNaN(Number(v))) pts.push({ i, v: Number(v) });
    });
    if (!pts.length) {
      return '<svg viewBox="0 0 132 48"><line x1="6" y1="24" x2="126" y2="24" stroke="var(--hairline)" stroke-width="2" stroke-dasharray="3 3"/></svg>';
    }
    const minV = Math.min(...pts.map((p) => p.v));
    const maxV = Math.max(...pts.map((p) => p.v));
    const pad = Math.max(1, (maxV - minV) * 0.18);
    const lo = minV - pad;
    const hi = maxV + pad;
    const totalCols = Math.max(values.length - 1, 1);
    const coords = pts.map((p) => ({
      x: 6 + (p.i / totalCols) * 120,
      y: 6 + ((hi - p.v) / Math.max(hi - lo, 1e-6)) * 35,
    }));
    if (coords.length === 1) {
      return `<svg viewBox="0 0 132 48" aria-hidden="true"><circle cx="${coords[0].x.toFixed(1)}" cy="${coords[0].y.toFixed(1)}" r="4" fill="${strokeVar}"/></svg>`;
    }
    const lineD = buildSmoothSvgPath(coords);
    const areaD = `${lineD} L${coords[coords.length - 1].x.toFixed(1)} 45 L${coords[0].x.toFixed(1)} 45 Z`;
    const last = coords[coords.length - 1];
    return `
      <svg viewBox="0 0 132 48" aria-hidden="true">
        <path d="${areaD}" fill="${fillRgba}"/>
        <path d="${lineD}" fill="none" stroke="${strokeVar}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.2" fill="${strokeVar}" stroke="var(--surface-solid)" stroke-width="1.3"/>
      </svg>
    `;
  }

  function renderMiniBarsSvg(values, colorVar, goalVal = null) {
    const clean = values.map((v) => (v !== null && v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : 0));
    const maxV = Math.max(...clean, goalVal || 0, 1);
    const n = clean.length || 1;
    const step = 124 / n;
    const barW = Math.min(6, Math.max(3, step * 0.58));
    let goalLine = "";
    if (goalVal && goalVal > 0) {
      const gy = 43 - (goalVal / maxV) * 37;
      goalLine = `<line x1="4" y1="${gy.toFixed(1)}" x2="128" y2="${gy.toFixed(1)}" stroke="var(--hairline)" stroke-width="1" stroke-dasharray="3 2"/>`;
    }
    const bars = clean.map((v, idx) => {
      const h = v > 0 ? Math.max(3, (v / maxV) * 37) : 2;
      const x = 4 + idx * step + (step - barW) / 2;
      const y = 43 - h;
      const op = idx === n - 1 ? "1" : goalVal && v >= goalVal ? "0.75" : "0.42";
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="${colorVar}" fill-opacity="${op}"/>`;
    });
    return `<svg viewBox="0 0 132 48" aria-hidden="true">${goalLine}${bars.join("")}</svg>`;
  }

  function renderSleepMiniBarsSvg(days14) {
    const totals = days14.map((d) => Number(d.sleep_total_min || 0));
    const maxT = Math.max(...totals, 480);
    const n = days14.length || 1;
    const step = 124 / n;
    const barW = Math.min(6, Math.max(3, step * 0.58));
    const bars = days14.map((d, idx) => {
      const deep = Number(d.sleep_deep_min || 0);
      const light = Number(d.sleep_light_min || 0);
      const rem = Number(d.sleep_rem_min || 0);
      if (deep + light + rem <= 0) return "";
      const x = 4 + idx * step + (step - barW) / 2;
      const scale = 39 / maxT;
      let cursor = 44;
      return [
        { v: deep, c: "var(--apple-deep)" },
        { v: light, c: "var(--apple-light-sleep)" },
        { v: rem, c: "var(--apple-cyan)" },
      ]
        .map((s) => {
          if (s.v <= 0) return "";
          const h = Math.max(1.5, s.v * scale);
          cursor -= h;
          return `<rect x="${x.toFixed(1)}" y="${cursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${s.c}"/>`;
        })
        .join("");
    });
    return `<svg viewBox="0 0 132 48" aria-hidden="true">${bars.join("")}</svg>`;
  }

  function renderAppleBarsMiniSvg(values, accentHex, count = 7) {
    const p = getThemePalette();
    const slice = (values || []).slice(-count);
    const clean = slice.map((v) => (v !== null && v !== undefined && !Number.isNaN(Number(v)) ? Number(v) : 0));
    if (!clean.length || clean.every((v) => v <= 0)) {
      return '<svg viewBox="0 0 112 42" aria-hidden="true"><line x1="6" y1="36" x2="106" y2="36" stroke="var(--hairline)" stroke-width="2" stroke-linecap="round"/></svg>';
    }
    const maxV = Math.max(...clean, 1);
    const n = clean.length;
    const step = 100 / Math.max(n, 1);
    const barW = Math.min(8, Math.max(4, step * 0.56));
    const muted = p.dark ? "rgba(152,152,157,0.34)" : "rgba(142,142,147,0.28)";
    const bars = clean.map((v, idx) => {
      const h = v > 0 ? Math.max(4, (v / maxV) * 32) : 3;
      const x = 6 + idx * step + (step - barW) / 2;
      const y = 38 - h;
      const fill = idx === n - 1 ? accentHex : muted;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="${fill}"/>`;
    });
    return `<svg viewBox="0 0 112 42" aria-hidden="true">${bars.join("")}</svg>`;
  }

  function renderAppleHollowLineMiniSvg(values, accentHex) {
    const p = getThemePalette();
    const slice = (values || []).slice(-7);
    const pts = [];
    slice.forEach((v, i) => {
      if (v !== null && v !== undefined && !Number.isNaN(Number(v))) pts.push({ i, v: Number(v) });
    });
    if (!pts.length) {
      return '<svg viewBox="0 0 112 42" aria-hidden="true"><line x1="6" y1="21" x2="106" y2="21" stroke="var(--hairline)" stroke-width="1.6" stroke-dasharray="3 3"/></svg>';
    }
    const minV = Math.min(...pts.map((pt) => pt.v));
    const maxV = Math.max(...pts.map((pt) => pt.v));
    const pad = Math.max(1, (maxV - minV) * 0.22);
    const lo = minV - pad;
    const hi = maxV + pad;
    const totalCols = Math.max(slice.length - 1, 1);
    const coords = pts.map((pt) => ({
      x: 8 + (pt.i / totalCols) * 94,
      y: 7 + ((hi - pt.v) / Math.max(hi - lo, 1e-6)) * 28,
    }));
    const strokeMuted = p.dark ? "rgba(174,174,178,0.48)" : "rgba(142,142,147,0.45)";
    const polyPts = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
    const circles = coords.map((c, idx) => {
      const isLast = idx === coords.length - 1;
      return `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${isLast ? "3.4" : "2.5"}" fill="${p.surfaceSolid}" stroke="${isLast ? accentHex : strokeMuted}" stroke-width="${isLast ? "2.1" : "1.5"}"/>`;
    });
    return `
      <svg viewBox="0 0 112 42" aria-hidden="true">
        ${coords.length > 1 ? `<polyline points="${polyPts}" fill="none" stroke="${strokeMuted}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>` : ""}
        ${circles.join("")}
      </svg>
    `;
  }

  function renderAppleSleepMiniHypnoSvg(stagePairs, days14) {
    const p = getThemePalette();
    if (!stagePairs || !stagePairs.length) {
      return renderSleepMiniBarsSvg(days14 || []);
    }
    const yRow = { a: 5, r: 13, l: 21, d: 29 };
    const colMap = { a: p.awake, r: p.rem, l: p.lightSleep, d: p.deep };
    const totDur = Math.max(stagePairs.reduce((s, item) => s + Number(item[1] || 0), 0), 1);
    let cursor = 4;
    const wAvail = 104;
    const rects = [];
    const links = [];
    let prevPos = null;
    stagePairs.forEach((item) => {
      const code = String(item[0] || "l");
      const dur = Math.max(1, Number(item[1] || 1));
      const bw = Math.max(2.4, (dur / totDur) * wAvail);
      const y = yRow[code] ?? 21;
      const c = colMap[code] || p.lightSleep;
      if (prevPos) {
        const lx = cursor;
        const y1 = Math.min(prevPos.y + 3, y + 3);
        const y2 = Math.max(prevPos.y + 3, y + 3);
        links.push(`<line x1="${lx.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${lx.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${c}" stroke-width="1.2" opacity="0.55"/>`);
      }
      rects.push(`<rect x="${cursor.toFixed(1)}" y="${y}" width="${bw.toFixed(1)}" height="5.8" rx="2.4" fill="${c}"/>`);
      prevPos = { x: cursor + bw, y };
      cursor += bw;
    });
    return `<svg viewBox="0 0 112 42" aria-hidden="true">${links.join("")}${rects.join("")}</svg>`;
  }

  function renderHeartRateWeekMiniSvg(days, accent) {
    const week = days.slice(-7);
    const ranges = week.flatMap((day, i) =>
      day.hr_min > 0 && day.hr_max >= day.hr_min ? [{ i, low: day.hr_min, high: day.hr_max }] : []);
    if (!ranges.length) return renderAppleHollowLineMiniSvg(week.map(day => day.hr_avg ?? day.hr_last), accent);
    const low = Math.min(...ranges.map(day => day.low));
    const high = Math.max(...ranges.map(day => day.high));
    const y = value => high === low ? 21 : 34 - (value - low) / (high - low) * 26;
    return `<svg viewBox="0 0 112 42" role="img" aria-label="近七天每日心率范围">${ranges.map((day, index) => {
      const x = 10 + day.i * 92 / Math.max(week.length - 1, 1);
      const top = y(day.high);
      return `<rect x="${x-3}" y="${top-2}" width="6" height="${Math.max(4, y(day.low)-top+4)}" rx="3" fill="${index===ranges.length-1 ? accent : "var(--text)"}" opacity="${index===ranges.length-1 ? 1 : .2}"/>`;
    }).join("")}</svg>`;
  }

  // -----------------------------------------------------------------------
  // Overview & Tab 1 (Summary) + Tab 3 (Browse)
  // -----------------------------------------------------------------------

  async function loadOverview(days = 30, { afterSync = false } = {}) {
    const data = await apiJson(`/api/v1/dashboard/overview?days=${days}`);
    if (afterSync) {
      if (activeCt || restoringNavigation) {
        dashboardRefreshPending = true;
        return false;
      }
      workoutsCache = null;
      proInsightsCache = null;
      invalidateViewRenderCaches();
    }
    overviewCache = data;
    $("app-shell").classList.toggle("offline-empty", Boolean(data.empty));

    if (data.empty) {
      renderEmptySyncCard();
      renderBrowseCategories(data);
      renderMoreTab();
      renderLocalSyncUI();
      return true;
    }

    renderSummaryTab(data);
    renderBrowseCategories(data);
    renderMoreTab();
    renderLocalSyncUI();
    firstOverviewPaintAt ??= performance.now();
    scheduleSecondaryPreload(data);
    return true;
  }

  function appleCategoryIconSvg(metric) {
    if (metric === "ecg") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12h5l2-5 3 10 3-7 2 2h5"/></svg>';
    if (metric === "temperature") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M9 14V6a3 3 0 0 1 6 0v8a5 5 0 1 1-6 0Z"/><path d="M12 9v8"/></svg>';
    if (metric === "readiness") {
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="8.5" stroke-opacity="0.28"/>
          <path d="M12 3.5a8.5 8.5 0 1 1-6.5 13.9"/>
          <path d="M9.2 12.4l2 2 4-4.6"/>
        </svg>
      `;
    }
    if (metric === "activity") {
      // Apple Fitness 3-Ring SF Symbol
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9.4" fill="none" stroke="rgba(250,17,79,0.22)" stroke-width="2.4"/>
          <circle cx="12" cy="12" r="9.4" fill="none" stroke="var(--ring-move)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="48 16" transform="rotate(-90 12 12)"/>
          <circle cx="12" cy="12" r="6.3" fill="none" stroke="rgba(48,209,88,0.22)" stroke-width="2.4"/>
          <circle cx="12" cy="12" r="6.3" fill="none" stroke="var(--ring-ex)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="30 12" transform="rotate(-90 12 12)"/>
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="rgba(0,180,240,0.22)" stroke-width="2.4"/>
          <circle cx="12" cy="12" r="3.2" fill="none" stroke="var(--ring-stand)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="15 8" transform="rotate(-90 12 12)"/>
        </svg>
      `;
    }
    if (metric === "sleep") {
      // Apple Health Sleep (bed.double.fill)
      return `
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M2.1 6.5a1 1 0 0 1 2 0v5.7h16.2a1.6 1.6 0 0 1 1.6 1.6v4a1 1 0 1 1-2 0v-1.2H4.1V18a1 1 0 1 1-2 0V6.5z"/>
          <circle cx="6.8" cy="10.1" r="1.65"/>
          <path d="M9.6 9.3c0-.7.6-1.3 1.3-1.3h7.4a2.6 2.6 0 0 1 2.6 2.6v1.6H9.6V9.3z"/>
        </svg>
      `;
    }
    if (metric === "heart_rate" || metric === "resting_hr") {
      // Apple Health Heart (heart.fill + subtle ECG notch)
      return `
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 20.6C12 20.6 3.2 14.9 3.2 8.9A4.8 4.8 0 0 1 12 6.1a4.8 4.8 0 0 1 8.8 2.8c0 6-8.8 11.7-8.8 11.7z" fill="currentColor"/>
          <path d="M6.2 11.2h2.4l1.2-2.6 2 5 1.5-3.2 1 .8h3.5" fill="none" stroke="var(--surface-solid)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      `;
    }
    if (metric === "active_energy" || metric === "basal_energy") {
      // Apple Fitness Flame (flame.fill)
      return `
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12.9 2.3c.3 2.5-.9 4.5-2.6 6-1.5 1.4-2.1 2.7-1.6 4.2.3.8 1 1.4 1.8 1.5-.6-1-.5-2.2.3-3.1.9-1 2.4-1.5 3.1-3.3 1.7 1.3 3.3 3.7 3.3 6.5 0 4.2-3.2 7.6-7.2 7.6S3.2 18.3 3.2 14c0-3.2 1.8-6 4.5-8.1 1.7-1.3 3.4-2.1 5.2-3.6z" transform="translate(1.8 0)"/>
        </svg>
      `;
    }
    if (metric === "distance") {
      // Apple Fitness Walking+Running Distance
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 17h6a3 3 0 0 0 0-6H8a3 3 0 0 1 0-6h11"/>
          <polyline points="15 2 19 5 15 8"/>
          <circle cx="4" cy="17" r="1.6" fill="currentColor" stroke="none"/>
        </svg>
      `;
    }
    if (metric === "hrv") {
      // Apple Health HRV (waveform.path.ecg)
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="4" width="19" height="16" rx="4.5" stroke-width="1.7" opacity="0.32"/>
          <path d="M4.5 12.2h3.1l1.9-5.2 2.9 10 2.5-7.6 1.7 2.8h2.9"/>
        </svg>
      `;
    }
    if (metric === "steps") {
      // Apple Health Activity / Steps (figure.walk)
      return `
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="13.6" cy="4.3" r="2.1"/>
          <path d="M13 7.6c-1.4 0-2.5.7-3.3 1.9l-2 3a1.05 1.05 0 1 0 1.75 1.15l1.55-2.3v3.3l-2.7 5.05a1.15 1.15 0 1 0 2.02 1.1l2.53-4.6 2.35 2.05.75 2.65a1.15 1.15 0 1 0 2.2-.65l-.95-3.25a1.5 1.5 0 0 0-.45-.65l-1.95-1.7v-2.75l1.25 1.15c.42.38 1.05.42 1.52.08l1.95-1.45a1.05 1.05 0 1 0-1.26-1.68l-1.28.95-1.75-1.6c-.72-.68-1.58-.95-2.63-.95z"/>
        </svg>
      `;
    }
    if (metric === "spo2") {
      // Apple Health Respiratory / SpO2 (lungs.fill)
      return `
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 3.2c.55 0 1 .45 1 1v4.4l2.1 1.5a.9.9 0 0 1-1.06 1.45L12 10.1l-2.04 1.45a.9.9 0 1 1-1.06-1.45L11 8.6V4.2c0-.55.45-1 1-1z" opacity="0.88"/>
          <path d="M9.6 8.6C6.4 8.6 3.5 11.4 3.2 15.6c-.2 2.4 1.3 4.2 3.5 4.4 1.9.15 3.6-.85 3.8-2.6l.2-7.6c0-.7-.5-1.2-1.1-1.2zm4.8 0c3.2 0 6.1 2.8 6.4 7 .2 2.4-1.3 4.2-3.5 4.4-1.9.15-3.6-.85-3.8-2.6l-.2-7.6c0-.7.5-1.2 1.1-1.2z"/>
        </svg>
      `;
    }
    if (metric === "vo2max") {
      // Apple Cardio Fitness (heart + ascending VO2 wave)
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 20s-7.5-4.8-7.5-10a4.2 4.2 0 0 1 7.5-2.6A4.2 4.2 0 0 1 19.5 10c0 5.2-7.5 10-7.5 10z" fill="currentColor" fill-opacity="0.16"/>
          <path d="M7.5 12h2l1.3-3 2 5.4 1.3-2.4h2.4"/>
        </svg>
      `;
    }
    if (metric === "training_index") {
      // Apple watchOS Training Load / Index (gauge + flame bars)
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="4" y="13" width="3.5" height="7" rx="1.2" fill="currentColor" fill-opacity="0.35"/>
          <rect x="10.25" y="8" width="3.5" height="12" rx="1.2" fill="currentColor" fill-opacity="0.72"/>
          <rect x="16.5" y="4" width="3.5" height="16" rx="1.2" fill="currentColor"/>
        </svg>
      `;
    }
    if (metric === "running_index") {
      // Running Ability Index (runner + upward vector)
      return `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="13" cy="5" r="2"/>
          <path d="M7 20l3-6 2.5 1.5L15 20"/>
          <path d="M6 12l4-3 3 2 4-3"/>
          <polyline points="16 17 20 13 20 17" stroke-width="1.8"/>
        </svg>
      `;
    }
    // stress: Apple Mindfulness Lotus / Brain Waves
    return `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linejoin="round" aria-hidden="true">
        <ellipse cx="12" cy="12" rx="4.2" ry="7.6" fill="currentColor" fill-opacity="0.22"/>
        <ellipse cx="12" cy="12" rx="4.2" ry="7.6" transform="rotate(60 12 12)" fill="currentColor" fill-opacity="0.22"/>
        <ellipse cx="12" cy="12" rx="4.2" ry="7.6" transform="rotate(120 12 12)" fill="currentColor" fill-opacity="0.22"/>
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>
      </svg>
    `;
  }

  const HR_MODE_STORAGE_KEY = "hwh_hr_chart_mode";

  function getHrChartMode() {
    try {
      return localStorage.getItem(HR_MODE_STORAGE_KEY) === "line" ? "line" : "range";
    } catch (_) {
      return "range";
    }
  }

  function setHrChartMode(mode) {
    const val = mode === "line" ? "line" : "range";
    try {
      localStorage.setItem(HR_MODE_STORAGE_KEY, val);
    } catch (_) {}
    return val;
  }

  function infoIconBtnHtml(modalKey, ariaLabel) {
    return `<button type="button" class="info-icon-btn" data-info-modal="${escapeHtml(modalKey)}" aria-label="${escapeHtml(ariaLabel)}"><svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 9.2v4.3"/><circle cx="10" cy="6.4" r="0.7" fill="currentColor" stroke="none"/></svg></button>`;
  }

  async function closeAnimatedDialog(dialogEl, surfaceSelector = ".glass-modal-surface") {
    if (!dialogEl || !dialogEl.open || dialogEl.classList.contains("is-closing")) return;
    dialogEl.classList.add("is-closing");
    const surface = dialogEl.querySelector(surfaceSelector);
    await animateDialogDismiss(
      dialogEl,
      surface,
      ".glass-modal-backdrop",
      { opacity: 0, transform: "translateY(10px) scale(.97)" },
      170,
      false
    );
    dialogEl.classList.remove("is-closing");
    syncNativeBackState();
  }

  function openGlassSelectSheet({ title = "请选择", subtitle = "", options = [], value = "", port = null, onSelect = null }) {
    const dialog = $("glass-select-dialog");
    const listEl = $("glass-select-list");
    const titleEl = $("glass-select-title");
    const subEl = $("glass-select-sub");
    if (!dialog || !listEl) return;
    if (titleEl) titleEl.textContent = title;
    if (subEl) {
      subEl.textContent = subtitle || "";
      subEl.classList.toggle("hidden", !subtitle);
    }
    const portInput = $("glass-select-port-input");
    $("glass-select-port").classList.toggle("hidden", port === null);
    if (port !== null) portInput.value = port;
    listEl.innerHTML = options
      .map((opt, idx) => {
        const sel = String(opt.value) === String(value);
        return `
          <button type="button" class="glass-select-option ${sel ? "is-selected" : ""}" role="option" aria-selected="${sel ? "true" : "false"}" data-opt-idx="${idx}">
            <div>
              <div class="glass-select-opt-main">${escapeHtml(opt.label)}</div>
              ${opt.meta ? `<div class="glass-select-opt-meta">${escapeHtml(opt.meta)}</div>` : ""}
            </div>
            ${sel ? '<span class="glass-select-check" aria-hidden="true">✓</span>' : ""}
          </button>
        `;
      })
      .join("");
    listEl.querySelectorAll(".glass-select-option").forEach((btn) => {
      btn.addEventListener("click", async () => {
        if (dialog.classList.contains("is-closing")) return;
        const chosen = options[Number(btn.dataset.optIdx)];
        if (port !== null && !portInput.reportValidity()) return;
        const chosenPort = port === null ? null : portInput.valueAsNumber;
        triggerHapticTick(4);
        await closeAnimatedDialog(dialog);
        if (chosen) onSelect?.(chosen.value, chosen, chosenPort);
      });
    });
    if (!dialog.open) {
      dialog.showModal();
      syncNativeBackState();
    }
  }

  function openTrainingIndexInfoModal() {
    const dialog = $("training-info-dialog");
    const body = $("training-info-body");
    if (!dialog || !body) return;

    const buckets = detailDataCache?.metric === "training_index" ? (detailDataCache.buckets || []) : [];
    const latestB = [...buckets].reverse().find((b) => b.tsb != null || b.ctl != null) || null;
    const tInfo = overviewCache?.athletic_summary?.training_index || {};
    const tsb = latestB?.tsb ?? tInfo.tsb;
    const ctl = latestB?.ctl ?? tInfo.ctl;
    const atl = latestB?.atl ?? tInfo.atl;
    const acwr = latestB?.acwr ?? tInfo.acwr;
    const stLbl = latestB?.status ?? tInfo.status ?? "-";

    const tsbBands = [
      { label: "状态巅峰 / 竞赛窗口", range: "+5 ~ +25 分", color: "var(--apple-green)", match: tsb != null && tsb >= 5 && tsb <= 25 },
      { label: "维持与稳态适应", range: "-10 ~ +5 分", color: "var(--apple-blue)", match: tsb != null && tsb >= -10 && tsb < 5 },
      { label: "有效负荷积累期", range: "-30 ~ -10 分", color: "var(--apple-orange)", match: tsb != null && tsb >= -30 && tsb < -10 },
      { label: "过度疲劳 / 减量恢复", range: "< -30 分", color: "var(--apple-red)", match: tsb != null && tsb < -30 },
      { label: "长期停训 / 体能回落", range: "> +25 分", color: "var(--text-2)", match: tsb != null && tsb > 25 },
    ];
    const acwrBands = [
      { label: "负荷偏低 / 保持", range: "< 0.80", color: "var(--text-2)", match: acwr != null && acwr < 0.8 },
      { label: "黄金增能甜点区", range: "0.80 ~ 1.30", color: "var(--apple-green)", match: acwr != null && acwr >= 0.8 && acwr <= 1.3 },
      { label: "进阶冲刺（留意恢复）", range: "1.30 ~ 1.50", color: "var(--apple-orange)", match: acwr != null && acwr > 1.3 && acwr <= 1.5 },
      { label: "过载高风险区", range: "> 1.50", color: "var(--apple-red)", match: acwr != null && acwr > 1.5 },
    ];

    const renderBands = (bands) =>
      `<div class="ti-band-list">${bands
        .map(
          (b) => `
        <div class="ti-band-row ${b.match ? "is-current" : ""}">
          <span class="ti-band-left"><span class="ti-band-dot" style="background:${b.color}"></span>${escapeHtml(b.label)}${b.match ? '<span class="ti-current-pill">当前</span>' : ""}</span>
          <span class="ti-band-right">${escapeHtml(b.range)}</span>
        </div>
      `
        )
        .join("")}</div>`;

    body.innerHTML = `
      <div class="ti-live-grid">
        <div class="ti-live-tile">
          <div class="ti-live-lbl">训练指数 (TSB)</div>
          <div class="ti-live-val" style="color:var(--apple-blue)">${tsb != null ? `${tsb >= 0 ? "+" : ""}${fmtNum(tsb, 1)}` : "-"} 分</div>
        </div>
        <div class="ti-live-tile">
          <div class="ti-live-lbl">当前训练状态</div>
          <div class="ti-live-val" style="font-size:16px;">${escapeHtml(stLbl)}</div>
        </div>
        <div class="ti-live-tile">
          <div class="ti-live-lbl">体能 CTL / 疲劳 ATL</div>
          <div class="ti-live-val" style="font-size:16px;">${ctl != null ? fmtNum(ctl, 1) : "-"} / ${atl != null ? fmtNum(atl, 1) : "-"}</div>
        </div>
        <div class="ti-live-tile">
          <div class="ti-live-lbl">负荷比 (ACWR)</div>
          <div class="ti-live-val" style="color:var(--apple-green)">${acwr != null ? fmtNum(acwr, 2) : "-"}</div>
        </div>
      </div>

      <div class="ti-section">
        <div class="ti-section-head">
          <span class="ti-section-title">训练指数 (TSB · Training Stress Balance)</span>
          <span class="ti-section-tag">TSB = CTL − ATL</span>
        </div>
        <p class="ti-section-desc">衡量当前竞技状态与疲劳储备的净差值：正值代表疲劳消退、身体处于轻盈待发状态；适度负值说明正在有效叠加训练刺激。</p>
        ${renderBands(tsbBands)}
      </div>

      <div class="ti-section">
        <div class="ti-section-head">
          <span class="ti-section-title">体能指数 (CTL) 与疲劳指数 (ATL)</span>
          <span class="ti-section-tag">42 天 / 7 天 EMA</span>
        </div>
        <p class="ti-section-desc"><strong>体能指数 (CTL)</strong> 反映过去约 42 天指数加权积累的有氧与肌耐力底座，提升稳健且消退较慢；<strong>疲劳指数 (ATL)</strong> 反映近 7 天的急性负荷压力，对近期高强度训练或连续休息敏感。</p>
      </div>

      <div class="ti-section">
        <div class="ti-section-head">
          <span class="ti-section-title">急慢性负荷比 (ACWR)</span>
          <span class="ti-section-tag">7日 / 28日</span>
        </div>
        <p class="ti-section-desc">对比最近 1 周与近 4 周周均负荷的增长速率，用于预警短期突击加量带来的伤病风险。</p>
        ${renderBands(acwrBands)}
      </div>

      <div class="ti-section">
        <div class="ti-section-head">
          <span class="ti-section-title">单次训练负荷口径</span>
        </div>
        <p class="ti-section-desc">优先采用手表记录的运动负荷；当部分训练未返回原始负荷值时，自动按运动时长与储备心率百分比（Banister TRIMP 模型）估算补充。</p>
      </div>
    `;
    if (!dialog.open) {
      dialog.showModal();
      syncNativeBackState();
    }
  }

  $("glass-select-close")?.addEventListener("click", () => closeAnimatedDialog($("glass-select-dialog")));
  $("glass-select-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeAnimatedDialog($("glass-select-dialog"));
  });
  $("glass-select-dialog")?.addEventListener("click", (e) => {
    if (e.target === $("glass-select-dialog")) closeAnimatedDialog($("glass-select-dialog"));
  });

  $("training-info-close")?.addEventListener("click", () => closeAnimatedDialog($("training-info-dialog")));
  $("training-info-dialog")?.addEventListener("cancel", (e) => {
    e.preventDefault();
    closeAnimatedDialog($("training-info-dialog"));
  });
  $("training-info-dialog")?.addEventListener("click", (e) => {
    if (e.target === $("training-info-dialog")) closeAnimatedDialog($("training-info-dialog"));
  });

  document.addEventListener("click", (e) => {
    const infoBtn = e.target.closest("[data-info-modal]");
    if (!infoBtn) return;
    e.preventDefault();
    e.stopPropagation();
    triggerHapticTick(4);
    if (infoBtn.dataset.infoModal === "training_index") {
      openTrainingIndexInfoModal();
    }
  });

  function renderMetricCardsGrid(gridEl, cards) {
    if (!gridEl) return;
    gridEl.innerHTML = cards
      .map(
        (c, idx) => `
      <div class="metric-card stagger-card" style="--card-idx:${idx}" data-idx="${idx}" data-metric="${escapeHtml(c.metric)}" data-scope="${escapeHtml(c.scope || "")}" role="button" tabindex="0">
        <div class="metric-card-head">
          <span class="metric-title" style="color:${c.color}">
            <span class="metric-icon-inline">${appleCategoryIconSvg(c.metric)}</span>
            ${escapeHtml(c.title)}
            ${c.metric === "training_index" ? infoIconBtnHtml("training_index", "查看训练指数说明") : ""}
          </span>
          <span class="metric-date-chev">${escapeHtml(c.dateLabel)} ›</span>
        </div>
        <div class="metric-card-body">
          <div class="metric-left">
            <div class="metric-num-row">
              ${
                c.valueHtml
                  ? c.valueHtml
                  : `<span class="metric-num">${escapeHtml(c.value)}</span>${c.unit ? `<span class="metric-unit">${escapeHtml(c.unit)}</span>` : ""}`
              }
            </div>
            <div class="metric-sub">${escapeHtml(c.sub)}</div>
          </div>
          <div class="metric-spark">${c.svg}</div>
        </div>
      </div>
    `
      )
      .join("");

    gridEl.querySelectorAll(".metric-card").forEach((el) => {
      const c = cards[Number(el.dataset.idx)];
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-info-modal]")) return;
        openMetricDetail(c.metric, { scope: c.scope, fromTab: "summary" }, el);
      });
    });
  }

  function drawAvg7HighlightSvg(hl, accentHex, unitLabel) {
    const p = getThemePalette();
    const days = hl?.days || [];
    const vals = days.map((d) => d.val).filter((v) => v != null).map(Number);
    if (!vals.length) {
      return '<div class="card-note">最近 7 天暂无足够记录</div>';
    }
    const avgV = hl.avg != null ? Number(hl.avg) : null;
    const maxV = Math.max(...vals, avgV || 0, 1) * 1.15;
    const W = 320;
    const H = 144;
    const pLeft = 4;
    const pRight = 276;
    const pTop = 12;
    const pBot = 116;
    const plotH = pBot - pTop;
    const mapY = (v) => pBot - (Math.max(0, Number(v)) / maxV) * plotH;
    const stepW = (pRight - pLeft) / Math.max(days.length, 1);
    const barW = Math.min(20, stepW * 0.56);
    const muted = p.dark ? "rgba(152,152,157,0.34)" : "rgba(142,142,147,0.26)";

    const gridLevels = [0, maxV / 2, maxV / 1.15];
    const gridSvg = gridLevels
      .map((t) => {
        const y = mapY(t).toFixed(1);
        const lbl = t >= 1000 ? `${(t / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${t < 10 && t > 0 ? t.toFixed(1) : Math.round(t)}`;
        return `
          <line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>
          <text x="${W - 4}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="${p.text2}">${lbl}</text>
        `;
      })
      .join("");

    const barsSvg = days
      .map((d, idx) => {
        const cx = pLeft + (idx + 0.5) * stepW;
        const tick = `<text x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle" font-size="10" font-weight="600" fill="${d.is_today ? p.text : p.text2}">${escapeHtml(d.tick || "")}</text>`;
        if (d.val == null || Number(d.val) <= 0) return tick;
        const yT = mapY(d.val);
        const bh = Math.max(4, pBot - yT);
        const fill = d.is_today ? accentHex : muted;
        return `
          <rect x="${(cx - barW / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="5" fill="${fill}"/>
          ${tick}
        `;
      })
      .join("");

    let avgLineSvg = "";
    if (avgV != null && avgV > 0) {
      const ay = mapY(avgV);
      avgLineSvg = `
        <line x1="${pLeft}" y1="${ay.toFixed(1)}" x2="${pRight}" y2="${ay.toFixed(1)}" stroke="${p.text2}" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.82"/>
        <rect x="${pLeft + 2}" y="${(ay - 15).toFixed(1)}" width="30" height="14" rx="4" fill="${p.surfaceSolid}" opacity="0.88"/>
        <text x="${pLeft + 6}" y="${(ay - 4.5).toFixed(1)}" font-size="9.5" font-weight="700" fill="${p.text2}">平均</text>
      `;
    }

    return `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
        ${gridSvg}
        ${barsSvg}
        ${avgLineSvg}
      </svg>
    `;
  }

  function drawStepsPacingHighlightSvg(sp, accentHex) {
    const p = getThemePalette();
    const todayCum = sp?.today_cum || [];
    const avgCum = sp?.avg_cum || [];
    if (!todayCum.length && !avgCum.length) {
      return '<div class="card-note">暂无分时步数积累曲线</div>';
    }
    const maxV = Math.max(...todayCum, ...avgCum, 1000) * 1.12;
    const W = 320;
    const H = 144;
    const pLeft = 4;
    const pRight = 276;
    const pTop = 12;
    const pBot = 116;
    const plotW = pRight - pLeft;
    const plotH = pBot - pTop;
    const mapX = (h) => pLeft + (Math.min(23, Math.max(0, h)) / 23) * plotW;
    const mapY = (v) => pBot - (Math.max(0, Number(v)) / maxV) * plotH;

    const yLevels = [0, maxV / 2, maxV / 1.12];
    const gridSvg = yLevels
      .map((t) => {
        const y = mapY(t).toFixed(1);
        const lbl = t >= 1000 ? `${(t / 1000).toFixed(1).replace(/\.0$/, "")}k` : `${Math.round(t)}`;
        return `
          <line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>
          <text x="${W - 4}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="${p.text2}">${lbl}</text>
        `;
      })
      .join("");

    const xTicks = [0, 6, 12, 18, 23]
      .map((h) => {
        const x = mapX(h).toFixed(1);
        const lbl = h === 23 ? "24时" : `${h}时`;
        return `<text x="${x}" y="${H - 7}" text-anchor="${h === 0 ? "start" : h === 23 ? "end" : "middle"}" font-size="10" font-weight="600" fill="${p.text2}">${lbl}</text>`;
      })
      .join("");

    let avgSvg = "";
    if (avgCum.length > 1) {
      const avgPts = avgCum.map((v, h) => ({ x: mapX(h), y: mapY(v) }));
      const avgD = buildSmoothSvgPath(avgPts, 0.2);
      const areaD = `${avgD} L${avgPts[avgPts.length - 1].x.toFixed(1)} ${pBot} L${avgPts[0].x.toFixed(1)} ${pBot} Z`;
      const avgStroke = p.dark ? "rgba(152,152,157,0.5)" : "rgba(142,142,147,0.45)";
      const avgFill = p.dark ? "rgba(152,152,157,0.12)" : "rgba(142,142,147,0.10)";
      avgSvg = `
        <path d="${areaD}" fill="${avgFill}"/>
        <path d="${avgD}" fill="none" stroke="${avgStroke}" stroke-width="1.9" stroke-linecap="round"/>
      `;
    }

    let todaySvg = "";
    if (todayCum.length >= 1) {
      const tPts = todayCum.map((v, h) => ({ x: mapX(h), y: mapY(v) }));
      const td = buildSmoothSvgPath(tPts, 0.2);
      const lastPt = tPts[tPts.length - 1];
      todaySvg = `
        <path d="${td}" fill="none" stroke="${accentHex}" stroke-width="2.8" stroke-linecap="round"/>
        <circle cx="${lastPt.x.toFixed(1)}" cy="${lastPt.y.toFixed(1)}" r="4.2" fill="${accentHex}" stroke="${p.surfaceSolid}" stroke-width="1.8"/>
      `;
    }

    return `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
        ${gridSvg}
        ${xTicks}
        ${avgSvg}
        ${todaySvg}
      </svg>
    `;
  }

  function renderSummaryHighlights(data, refDate) {
    const stack = $("summary-highlights-stack");
    if (!stack) return;
    const p = getThemePalette();
    const sh = data.summary_highlights || {};
    const ae = sh.active_energy_7d || {};
    const ds = sh.distance_7d || {};
    const sp = sh.steps_pacing || {};

    const cards = [
      {
        metric: "active_energy",
        scope: "W",
        title: "活动能量",
        color: p.dark ? "#FF453A" : "#FF3B30",
        hex: p.dark ? "#FF453A" : "#FF3B30",
        dateTxt: "过去7天 ›",
        stmt: ae.text || "过去 7 天活动能量消耗趋势。",
        chartHtml: drawAvg7HighlightSvg(ae, p.dark ? "#FF453A" : "#FF3B30", "千卡"),
        footLeft: ae.avg != null ? `日均 ${fmtNum(ae.avg, 0)} 千卡` : "",
        footRight: ae.today_val != null ? `今天 ${fmtNum(ae.today_val, 0)} 千卡` : "",
      },
      {
        metric: "distance",
        scope: "W",
        title: "步行+跑步距离",
        color: p.dark ? "#FF9F0A" : "#FF6B00",
        hex: p.dark ? "#FF9F0A" : "#FF6B00",
        dateTxt: "过去7天 ›",
        stmt: ds.text || "过去 7 天每日步行与跑步距离。",
        chartHtml: drawAvg7HighlightSvg(ds, p.dark ? "#FF9F0A" : "#FF6B00", "公里"),
        footLeft: ds.avg != null ? `日均 ${fmtNum(ds.avg, 1)} 公里` : "",
        footRight: ds.today_val != null ? `今天 ${fmtNum(ds.today_val, 2)} 公里` : "",
      },
      {
        metric: "steps",
        scope: "D",
        title: "步数",
        color: "var(--apple-orange)",
        hex: p.orange,
        dateTxt: `${fmtRelDate(sp.date || refDate, refDate)} ›`,
        stmt: sp.headline ? `${sp.headline} ${sp.text || ""}` : (sp.text || "今日步数积累曲线对比。"),
        chartHtml: drawStepsPacingHighlightSvg(sp, p.orange),
        footLeft: sp.today_steps ? `今天 ${fmtNum(sp.today_steps, 0)} 步` : "",
        footRight: sp.avg_full_day ? `28日全天均 ${fmtNum(sp.avg_full_day, 0)} 步` : "",
      },
    ];

    stack.innerHTML = cards
      .map(
        (c, idx) => `
      <div class="hl-insight-card" data-metric="${c.metric}" data-scope="${c.scope}" data-idx="${idx}" role="button" tabindex="0">
        <div class="hl-in-head">
          <span class="hl-in-cat" style="color:${c.color}">
            ${appleCategoryIconSvg(c.metric)}
            ${escapeHtml(c.title)}
          </span>
          <span class="hl-in-date">${escapeHtml(c.dateTxt)}</span>
        </div>
        <p class="hl-in-stmt">${escapeHtml(c.stmt)}</p>
        <div class="hl-in-div"></div>
        <div class="hl-in-chart">${c.chartHtml}</div>
        ${
          c.footLeft || c.footRight
            ? `<div class="hl-in-foot"><span>${escapeHtml(c.footLeft)}</span><span>${escapeHtml(c.footRight)}</span></div>`
            : ""
        }
      </div>
    `
      )
      .join("");

    stack.querySelectorAll(".hl-insight-card").forEach((el) => {
      el.addEventListener("click", () => {
        openMetricDetail(el.dataset.metric, { scope: el.dataset.scope, fromTab: "summary" }, el);
      });
    });
  }

  function renderAllHealthView(data) {
    const body = $("all-health-body");
    if (!body || !data || data.empty) return;
    const p = getThemePalette();
    const days14 = data.recent_14d && data.recent_14d.length ? data.recent_14d : (data.daily_series || []).slice(-14);
    const daysDesc = [...days14].reverse();
    const latest = data.latest_day || daysDesc[0] || {};
    const refDate = latest.date || data.window?.end_date || "";

    const hrPick = pickLatestValid(daysDesc, (d) => d.hr_last ?? d.hr_avg ?? d.hr_rest);
    const rhrPick = pickLatestValid(daysDesc, (d) => d.hr_rest);
    const hrvPick = pickLatestValid(daysDesc, (d) => d.hrv_avg ?? d.hrv_last);
    const slpPick = pickLatestValid(daysDesc, (d) => d.sleep_total_min);
    const stepPick = pickLatestValid(daysDesc, (d) => d.steps);
    const aePick = pickLatestValid(daysDesc, (d) => d.calories_kcal);
    const bePick = pickLatestValid(daysDesc, (d) => d.basal_metabolism_kcal);
    const distPick = pickLatestValid(daysDesc, (d) => d.distance_m);
    const spo2Pick = pickLatestValid(daysDesc, (d) => d.spo2_avg);
    const stressPick = pickLatestValid(daysDesc, (d) => d.stress_avg);

    const hrRow = hrPick.row || latest;
    const ath = data.athletic_summary || {};
    const vInfo = ath.vo2max || {};
    const tInfo = ath.training_index || {};
    const rInfo = ath.running_index || {};

    const todayCards = [
      {
        metric: "active_energy",
        scope: "D",
        title: "活动能量",
        color: p.dark ? "#FF453A" : "#FF3B30",
        dateLabel: fmtRelDate(aePick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(aePick.value, 0), "千卡"),
        svg: renderAppleBarsMiniSvg(days14.map((d) => d.calories_kcal), p.dark ? "#FF453A" : "#FF3B30"),
      },
      {
        metric: "basal_energy",
        scope: "W",
        title: "静息能量",
        color: p.dark ? "#FF9F0A" : "#FF6B00",
        dateLabel: fmtRelDate(bePick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(bePick.value, 0), "千卡"),
        svg: renderAppleBarsMiniSvg(days14.map((d) => d.basal_metabolism_kcal), p.dark ? "#FF9F0A" : "#FF6B00"),
      },
      {
        metric: "steps",
        scope: "D",
        title: "步数",
        color: "var(--apple-orange)",
        dateLabel: fmtRelDate(stepPick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(stepPick.value, 0), "步"),
        svg: renderAppleBarsMiniSvg(days14.map((d) => d.steps), p.orange),
      },
      {
        metric: "distance",
        scope: "D",
        title: "步行+跑步距离",
        color: p.dark ? "#FF9F0A" : "#FF6B00",
        dateLabel: fmtRelDate(distPick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(distPick.value != null ? fmtNum(distPick.value / 1000, 2) : "-", "公里"),
        svg: renderAppleBarsMiniSvg(days14.map((d) => (d.distance_m != null ? d.distance_m / 1000 : null)), p.dark ? "#FF9F0A" : "#FF6B00"),
      },
      {
        metric: "heart_rate",
        scope: "D",
        title: "心率",
        color: "var(--apple-red)",
        dateLabel: fmtRelDate(hrPick.row?.date, refDate),
        subTop: "最新",
        valueHtml: fmtSplitValHtml(fmtNum(hrPick.value, 0), "次/分"),
        svg: renderHeartRateWeekMiniSvg(days14, p.red),
      },
      {
        metric: "resting_hr",
        scope: "W",
        title: "静息心率",
        color: "var(--apple-red)",
        dateLabel: fmtRelDate(rhrPick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(rhrPick.value, 0), "次/分"),
        svg: renderAppleHollowLineMiniSvg(days14.map((d) => d.hr_rest ?? null), p.red),
      },
      {
        metric: "hrv",
        scope: "W",
        title: "心率变异性 (HRV)",
        color: "var(--apple-green)",
        dateLabel: fmtRelDate(hrvPick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(hrvPick.value, 0), "毫秒"),
        svg: renderAppleHollowLineMiniSvg(days14.map((d) => d.hrv_avg ?? d.hrv_last ?? null), p.green),
      },
      {
        metric: "sleep",
        scope: "D",
        title: "睡眠",
        color: "var(--apple-indigo)",
        dateLabel: fmtRelDate(data.latest_night_sleep?.date || slpPick.row?.date, refDate),
        subTop: "睡眠时间",
        valueHtml: fmtSplitHmHtml(data.latest_night_sleep?.total_sleep_min ?? slpPick.value),
        svg: renderAppleSleepMiniHypnoSvg(data.latest_night_stages, days14),
      },
      {
        metric: "spo2",
        scope: "W",
        title: "血氧饱和度",
        color: "var(--apple-teal)",
        dateLabel: fmtRelDate(spo2Pick.row?.date, refDate),
        subTop: "最新",
        valueHtml: fmtSplitValHtml(fmtNum(spo2Pick.value, 0), "%"),
        svg: renderAppleHollowLineMiniSvg(days14.map(d => d.spo2_avg ?? d.spo2_last), p.teal),
      },
      {
        metric: "stress",
        scope: "W",
        title: "压力与心理状态",
        color: "var(--apple-purple)",
        dateLabel: fmtRelDate(stressPick.row?.date, refDate),
        subTop: "",
        valueHtml: fmtSplitValHtml(fmtNum(stressPick.value, 0), "分"),
        svg: renderAppleHollowLineMiniSvg(days14.map((d) => d.stress_avg ?? null), p.purple),
      },
    ];

    const athCards = [
      {
        metric: "activity",
        scope: "D",
        title: "健身记录 · 活动",
        color: "var(--ring-move)",
        dateLabel: fmtRelDate(refDate, refDate),
        subTop: "今日活动环",
        valueHtml: fmtSplitValHtml(fmtNum(latest.calories_kcal, 0), "千卡"),
        svg: renderAppleBarsMiniSvg(days14.map((d) => d.calories_kcal), p.move),
      },
      {
        metric: "vo2max",
        scope: "6M",
        title: "最大摄氧量",
        color: "var(--apple-red)",
        dateLabel: fmtRelDate(vInfo.date, refDate),
        subTop: vInfo.level ? `有氧适能 · ${vInfo.level}` : "",
        valueHtml: fmtSplitValHtml(vInfo.latest != null ? fmtNum(vInfo.latest, 1) : "-", "mL/kg·min"),
        svg: renderAppleHollowLineMiniSvg(vInfo.series || [], p.red),
      },
      {
        metric: "training_index",
        scope: "M",
        title: "训练指数",
        color: "var(--apple-blue)",
        dateLabel: fmtRelDate(tInfo.date, refDate),
        subTop: tInfo.status || "",
        valueHtml: fmtSplitValHtml(tInfo.tsb != null ? `${tInfo.tsb >= 0 ? "+" : ""}${fmtNum(tInfo.tsb, 1)}` : "-", "分"),
        svg: renderAppleHollowLineMiniSvg(tInfo.series || [], p.blue),
      },
      {
        metric: "running_index",
        scope: "6M",
        title: "跑步指数 (RAI)",
        color: "var(--apple-green)",
        dateLabel: fmtRelDate(rInfo.date, refDate),
        subTop: rInfo.tier || "",
        valueHtml: fmtSplitValHtml(rInfo.latest != null ? fmtNum(rInfo.latest, 1) : "-", "分"),
        svg: renderAppleHollowLineMiniSvg(rInfo.series || [], p.green),
      },
    ];

    const renderGroup = (title, list) => `
      <div class="ah-section-title">${escapeHtml(title)}</div>
      <div class="ah-list">
        ${list
          .map(
            (c) => `
          <div class="ah-card" data-metric="${c.metric}" data-scope="${c.scope}" role="button" tabindex="0">
            <div class="ah-card-head">
              <span class="metric-title" style="color:${c.color}">
                <span class="metric-icon-inline">${appleCategoryIconSvg(c.metric)}</span>
                ${escapeHtml(c.title)}
                ${c.metric === "training_index" ? infoIconBtnHtml("training_index", "查看训练指数说明") : ""}
              </span>
              <span class="metric-date-chev">${escapeHtml(c.dateLabel)} ›</span>
            </div>
            <div class="ah-card-body">
              <div class="metric-left">
                ${c.subTop ? `<div class="ah-sub-lbl">${escapeHtml(c.subTop)}</div>` : ""}
                <div class="ah-val-row">${c.valueHtml}</div>
              </div>
              <div class="ah-spark">${c.svg}</div>
            </div>
          </div>
        `
          )
          .join("")}
      </div>
    `;

    body.innerHTML = `${renderGroup("今天", todayCards)}${renderGroup("体能与跑力", athCards)}`;
    body.querySelectorAll(".ah-card").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-info-modal]")) return;
        openMetricDetail(el.dataset.metric, { scope: el.dataset.scope, fromTab: "all-health" }, el);
      });
    });
    allHealthRenderedRef = data;
  }

  function renderInlineDisclosureHtml(label, metaText, innerHtml) {
    return `
      <div class="apple-disclosure-wrap">
        <button class="apple-disclosure-btn" type="button" aria-expanded="false">
          <span>${escapeHtml(label)}</span>
          <span class="apple-disclosure-meta">${metaText ? `${escapeHtml(metaText)} ` : ""}<span class="chev-rot">▾</span></span>
        </button>
        <div class="accordion-drawer">
          <div class="accordion-inner">
            <div class="apple-disclosure-body">${innerHtml}</div>
          </div>
        </div>
      </div>
    `;
  }

  function renderSectionDisclosureHtml(label, metaText, innerHtml) {
    return `
      <div class="apple-section-disclosure">
        <button class="all-data-btn" type="button" aria-expanded="false">
          <span>${escapeHtml(label)}</span>
          <span class="card-note">${metaText ? `${escapeHtml(metaText)} ` : ""}<span class="chev-rot">▾</span></span>
        </button>
        <div class="accordion-drawer">
          <div class="accordion-inner">${innerHtml}</div>
        </div>
      </div>
    `;
  }

  function bindAppleDisclosures(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll(".apple-disclosure-btn, .apple-section-disclosure > .all-data-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const nextOpen = !btn.classList.contains("open");
        btn.classList.toggle("open", nextOpen);
        btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
        const drawer = btn.nextElementSibling;
        if (drawer && drawer.classList.contains("accordion-drawer")) {
          drawer.classList.toggle("open", nextOpen);
        }
      });
    });
  }

  function renderReadinessSummaryCard(data) {
    const card = $("summary-readiness-card");
    const browseVal = $("browse-readiness-val");
    const rd = data?.readiness;
    if (browseVal) {
      browseVal.textContent = rd?.score != null ? `${rd.score} 分 ›` : "›";
    }
    if (!card) return;

    const refDate = data?.latest_day?.date || rd?.date || "";
    if (!rd || rd.score == null) {
      card.innerHTML = `
        <div class="ah-card-head">
          <span class="metric-title" style="color:var(--apple-green)">
            <span class="metric-icon-inline">${appleCategoryIconSvg("readiness")}</span>
            准备度
          </span>
          <span class="metric-date-chev">›</span>
        </div>
        <div class="ah-card-body">
          <div class="metric-left">
            <div class="ah-val-row">${fmtSplitValHtml("-", "分")}</div>
          </div>
          <div class="ah-spark">${renderAppleHollowLineMiniSvg([], getThemePalette().green)}</div>
        </div>
      `;
      card.onclick = () => openProInsightsView("load", "summary", card);
      return;
    }

    const p = getThemePalette();
    const col = rd.color || p.green;
    const trendVals = (rd.trend_14d || []).map((t) => t.score);
    card.innerHTML = `
      <div class="ah-card-head">
        <span class="metric-title" style="color:var(--apple-green)">
          <span class="metric-icon-inline">${appleCategoryIconSvg("readiness")}</span>
          准备度
        </span>
        <span class="metric-date-chev">${escapeHtml(fmtRelDate(rd.date, refDate))} ›</span>
      </div>
      <div class="ah-card-body">
        <div class="metric-left">
          <div class="ah-val-row">${fmtSplitValHtml(fmtNum(rd.score, 0), "分")}</div>
        </div>
        <div class="ah-spark">${renderAppleHollowLineMiniSvg(trendVals, col)}</div>
      </div>
    `;
    card.onclick = () => openProInsightsView("load", "summary", card);
  }

  function renderProInsightsView(data) {
    const body = $("pro-insights-body");
    if (!body || !data || data.empty) return;
    const p = getThemePalette();
    const tabs = [
      { id: "load", label: "训练与恢复" },
      { id: "sleep", label: "睡眠与关联" },
      { id: "aerobic", label: "有氧效率" },
    ];
    const curIdx = Math.max(0, tabs.findIndex((t) => t.id === proInsightsTab));

    if (body.dataset.mountedPro !== "1" || !$("pro-tab-content")) {
      body.innerHTML = `
        <div id="pro-seg-bar" class="scope-seg pro-seg has-thumb" role="tablist" aria-label="专业分析维度">
          <div id="pro-seg-thumb" class="seg-thumb" style="--seg-count:3;--seg-idx:${curIdx}"></div>
          ${tabs.map((t) => `<button class="scope-btn ${proInsightsTab === t.id ? "active" : ""}" data-ptab="${t.id}" type="button">${t.label}</button>`).join("")}
        </div>
        <div id="pro-tab-content" class="detail-body"></div>
      `;
      body.dataset.mountedPro = "1";
      body.querySelectorAll("#pro-seg-bar .scope-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (proInsightsTab === b.dataset.ptab) return;
          proInsightsTab = b.dataset.ptab;
          const idx = Math.max(0, tabs.findIndex((t) => t.id === proInsightsTab));
          const thumb = $("pro-seg-thumb");
          if (thumb) thumb.style.setProperty("--seg-idx", String(idx));
          body.querySelectorAll("#pro-seg-bar .scope-btn").forEach((x) => x.classList.toggle("active", x === b));
          if (proInsightsCache) {
            renderProTabContent($("pro-tab-content"), proInsightsCache, p, true);
          }
        });
      });
    } else {
      const thumb = $("pro-seg-thumb");
      if (thumb) thumb.style.setProperty("--seg-idx", String(curIdx));
      body.querySelectorAll("#pro-seg-bar .scope-btn").forEach((x) => x.classList.toggle("active", x.dataset.ptab === proInsightsTab));
    }

    renderProTabContent($("pro-tab-content"), data, p, false);
    proInsightsRenderedRef = data;
  }

  function renderProTabContent(container, data, p, animate) {
    if (!container) return;
    proInsightsRenderedTab = proInsightsTab;
    if (proInsightsTab === "sleep") {
      renderProSleepTab(container, data, p);
    } else if (proInsightsTab === "aerobic") {
      renderProAerobicTab(container, data, p);
    } else {
      renderProLoadTab(container, data, p);
    }
    if (proInsightsOpen) {
      (data?.aerobic_lab?.ef_series || []).slice(-4).reverse().forEach((r) => queueWorkoutPreload(r.workout_id));
    }
    if (animate) triggerChartMotion(container, "chart-crossfade");
  }

  function getReadinessTier(score) {
    const v = Number(score);
    if (!Number.isFinite(v)) return { status: "", color: "#32ADE6" };
    if (v >= 82) return { status: "状态巅峰", color: "#30D158" };
    if (v >= 68) return { status: "恢复良好", color: "#32ADE6" };
    if (v >= 52) return { status: "适度调整", color: "#FF9F0A" };
    return { status: "建议休养", color: "#FF3B30" };
  }

  function buildReadinessTrendLayout(pts) {
    const W = 320;
    const H = 132;
    const pL = 6;
    const pR = 282;
    const pT = 12;
    const pB = 108;
    const mapX = (i) => pL + (i / Math.max(pts.length - 1, 1)) * (pR - pL);
    const mapY = (v) => pB - ((Math.max(20, Math.min(100, Number(v))) - 20) / 80) * (pB - pT);
    const coords = pts.map((pt, idx) => ({ idx, x: mapX(idx), y: mapY(pt.score), pt }));
    return { W, H, pL, pR, pT, pB, mapX, mapY, coords };
  }

  function drawReadinessTrendSvg(pts, accentHex, p) {
    if (!pts || pts.length < 2) return '<div class="card-note">最近 14 天样本积累中</div>';
    const { W, H, pL, pR, pT, pB, mapX, mapY, coords } = buildReadinessTrendLayout(pts);
    const dPath = buildSmoothSvgPath(coords, 0.22);
    const areaD = `${dPath} L${coords[coords.length - 1].x.toFixed(1)} ${pB} L${coords[0].x.toFixed(1)} ${pB} Z`;
    const grid = [40, 60, 80, 100]
      .map((t) => {
        const y = mapY(t).toFixed(1);
        return `<line x1="${pL}" y1="${y}" x2="${pR}" y2="${y}" stroke="${p.grid}" stroke-width="1"/><text x="${W - 4}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="${p.text2}">${t}</text>`;
      })
      .join("");
    const ticks = [0, Math.floor((pts.length - 1) / 2), pts.length - 1]
      .filter((v, idx, arr) => arr.indexOf(v) === idx)
      .map((i) => `<text x="${mapX(i).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}" font-size="10" font-weight="600" fill="${p.text2}">${escapeHtml(pts[i].date.slice(5))}</text>`)
      .join("");
    const dots = coords.map((c, idx) => `<circle data-rd-idx="${idx}" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${idx === coords.length - 1 ? "4" : "2.4"}" fill="${idx === coords.length - 1 ? accentHex : p.surfaceSolid}" stroke="${accentHex}" stroke-width="1.8"/>`).join("");
    return `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="近 14 天准备度趋势">
        ${grid}${ticks}
        <path d="${areaD}" fill="${accentHex}" fill-opacity="0.14"/>
        <path d="${dPath}" fill="none" stroke="${accentHex}" stroke-width="2.4" stroke-linecap="round"/>
        ${dots}
        <g class="scrub-cursor-line" opacity="0">
          <line x1="0" y1="${pT}" x2="0" y2="${pB}" stroke="${p.text2}" stroke-width="1.5"/>
        </g>
        <circle class="readiness-scrub-dot" cx="0" cy="0" r="4.8" fill="${accentHex}" stroke="${p.surfaceSolid}" stroke-width="2" opacity="0"/>
      </svg>
    `;
  }

  function bindReadinessTrendScrub(wrapEl, pts, rd, p) {
    if (!wrapEl || !pts || pts.length < 2) return;
    const svgEl = wrapEl.querySelector("svg");
    if (!svgEl) return;
    const lineEl = svgEl.querySelector(".scrub-cursor-line");
    const dotEl = svgEl.querySelector(".readiness-scrub-dot");
    const pointDots = svgEl.querySelectorAll("[data-rd-idx]");
    svgEl.addEventListener("contextmenu", (e) => e.preventDefault());

    const { W, coords } = buildReadinessTrendLayout(pts);
    const defDate = rd.date || "-";
    const defScore = rd.score != null ? String(rd.score) : "-";
    const defStatus = rd.status || "";
    const defColor = rd.color || p.green;
    let lastIdx = -1;
    let cursorVisible = false;

    const applyReadout = (dateStr, scoreStr, statusStr, colorStr) => {
      const dateEl = $("pro-readiness-date");
      const scoreEl = $("pro-readiness-score");
      const statusEl = $("pro-readiness-status");
      const dotBadge = $("pro-readiness-dot");
      if (dateEl) dateEl.textContent = dateStr;
      if (scoreEl) scoreEl.textContent = scoreStr;
      if (statusEl) {
        statusEl.textContent = statusStr;
        statusEl.style.color = colorStr;
      }
      if (dotBadge) dotBadge.style.background = colorStr;
    };

    const reset = () => {
      lastIdx = -1;
      cursorVisible = false;
      if (lineEl) lineEl.setAttribute("opacity", "0");
      if (dotEl) dotEl.setAttribute("opacity", "0");
      pointDots.forEach((el) => el.setAttribute("opacity", "1"));
      applyReadout(defDate, defScore, defStatus, defColor);
    };

    const pickAtClientX = (clientX, pointerType) => {
      if (!coords.length) return;
      const rect = svgEl.getBoundingClientRect();
      const svgX = ((clientX - rect.left) / Math.max(rect.width, 1)) * W;
      let best = coords[0];
      let bestDist = Infinity;
      for (let i = 0; i < coords.length; i += 1) {
        const d = Math.abs(coords[i].x - svgX);
        if (d < bestDist) {
          bestDist = d;
          best = coords[i];
        }
      }
      if (!best) return;
      if (lineEl) {
        if (!cursorVisible) {
          lineEl.classList.add("no-glide");
          lineEl.style.transform = `translateX(${best.x.toFixed(1)}px)`;
          void lineEl.getBoundingClientRect();
          lineEl.classList.remove("no-glide");
          cursorVisible = true;
        } else {
          lineEl.style.transform = `translateX(${best.x.toFixed(1)}px)`;
        }
        lineEl.setAttribute("opacity", "1");
      }
      const tier = getReadinessTier(best.pt.score);
      if (dotEl) {
        dotEl.setAttribute("cx", best.x.toFixed(1));
        dotEl.setAttribute("cy", best.y.toFixed(1));
        dotEl.setAttribute("fill", tier.color);
        dotEl.setAttribute("opacity", "1");
      }
      pointDots.forEach((el) => {
        el.setAttribute("opacity", Number(el.dataset.rdIdx) === best.idx ? "1" : "0.35");
      });
      if (lastIdx !== best.idx) {
        if (pointerType !== "mouse") triggerHapticTick(lastIdx === -1 ? 10 : 8);
        lastIdx = best.idx;
      }
      applyReadout(best.pt.date || "-", String(best.pt.score), tier.status, tier.color);
    };

    bindChartScrubGesture(svgEl, pickAtClientX, reset);
  }

  function renderProLoadTab(container, data, p) {
    const rd = data.readiness || {};
    const wc = data.weekly_coach;
    const pol = (data.polarization && data.polarization[polarWindow]) || data.polarization?.["30d"] || {};
    const hm = data.heatmap || {};
    const cellsAll = hm.cells || [];
    const spanWeeks = heatmapSpan === "52w" ? 52 : 26;
    const minWeekIdx = Math.max(0, (hm.weeks || 52) - spanWeeks);
    const visibleCells = cellsAll.filter((c) => c.week_idx >= minWeekIdx);
    const defaultSel = selectedHeatmapDate && visibleCells.find((c) => c.date === selectedHeatmapDate)
      ? visibleCells.find((c) => c.date === selectedHeatmapDate)
      : [...visibleCells].reverse().find((c) => c.workouts > 0) || visibleCells[visibleCells.length - 1];
    selectedHeatmapDate = defaultSel ? defaultSel.date : null;

    const lvlColors = p.dark
      ? ["#2C2C2E", "#194D2B", "#267340", "#30A14E", "#30D158"]
      : ["#E5E5EA", "#B7E9C4", "#6FD489", "#30B856", "#1C7D36"];

    const colW = 11.4;
    const boxS = 9.2;
    const hmLeft = 18;
    const svgW = hmLeft + spanWeeks * colW + 4;
    const svgH = 7 * colW + 18;
    const dayLbls = [{ dow: 0, lbl: "一" }, { dow: 2, lbl: "三" }, { dow: 4, lbl: "五" }]
      .map((d) => `<text x="0" y="${(d.dow * colW + 10).toFixed(1)}" font-size="9" font-weight="600" fill="${p.text2}">${d.lbl}</text>`)
      .join("");
    let prevM = "";
    const monthLbls = [];
    visibleCells.forEach((c) => {
      if (c.dow === 0) {
        const m = c.date.slice(5, 7);
        if (m !== prevM) {
          prevM = m;
          const x = hmLeft + (c.week_idx - minWeekIdx) * colW;
          monthLbls.push(`<text x="${x.toFixed(1)}" y="${svgH - 3}" font-size="9" font-weight="600" fill="${p.text2}">${Number(m)}月</text>`);
        }
      }
    });
    const rects = visibleCells
      .map((c) => {
        const x = hmLeft + (c.week_idx - minWeekIdx) * colW;
        const y = 2 + c.dow * colW;
        const sel = c.date === selectedHeatmapDate ? "selected" : "";
        return `<rect class="heatmap-cell ${sel}" data-hdate="${c.date}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${boxS}" height="${boxS}" rx="2.3" fill="${lvlColors[c.level] || lvlColors[0]}"/>`;
      })
      .join("");

    const formatHmReadout = (c) => {
      if (!c) return "点击任意日期方块查看当日负荷";
      const parts = [
        `<strong>${escapeHtml(c.date)}</strong>`,
        c.workouts > 0 ? `${c.workouts} 次训练 · ${c.distance_km} km · 负荷 ${c.load}` : `休息日 · 负荷 ${c.load}`,
        c.sleep_min != null ? `睡 ${fmtMinHm(c.sleep_min)}` : "",
        c.hrv != null ? `HRV ${c.hrv}ms` : "",
      ].filter(Boolean);
      const sessions=(hm.sessions||[]).filter(w=>!loadSport || w.sport===loadSport);
      const day=Date.parse(c.date), mean=n=>sessions.filter(w=>Date.parse(w.date)<=day && Date.parse(w.date)>day-n*86400000).reduce((sum,w)=>sum+w.load,0)/n;
      const list=sessions.filter(w=>w.date===c.date);
      const days=Array.from({length:28},(_,i)=>day-(27-i)*86400000);
      const trend=n=>days.map(end=>sessions.filter(w=>Date.parse(w.date)<=end && Date.parse(w.date)>end-n*86400000).reduce((sum,w)=>sum+w.load,0)/n);
      const weekly=trend(7),monthly=trend(28),max=Math.max(1,...weekly,...monthly);
      const line=values=>values.map((v,i)=>(i?"L":"M")+(8+i*10)+" "+(62-55*v/max).toFixed(1)).join(" ");
      const chart=`<svg role="img" aria-label="近四周训练负荷日均趋势" viewBox="0 0 286 70" width="100%"><path d="${line(monthly)}" fill="none" stroke="var(--text-secondary,#888)" stroke-width="2" stroke-dasharray="4 3"/><path d="${line(weekly)}" fill="none" stroke="var(--apple-blue)" stroke-width="2.5"/></svg><small>实线 7 日均值 · 虚线 28 日均值</small>`;
      return parts.join(" · ")+chart+`<div class="kv-row"><span>训练负荷 · 日均</span><strong>7天 ${mean(7).toFixed(1)} / 28天 ${mean(28).toFixed(1)}</strong></div><small>按单次训练负荷汇总；设备值缺失时按时长和心率估算</small>`+list.map(w=>`<button type="button" class="grouped-row" data-load-session="${w.id}"><span>${escapeHtml(w.sport)}</span><strong>${w.load.toFixed(1)} ›</strong></button>`).join("");

    };

    const factors = rd.factors || [];
    const risk = rd.risk_alert;
    const readinessDetailHtml = `
      ${
        factors.length
          ? `<div class="kv-list">
              ${factors
                .map(
                  (f) => `
                <div class="kv-row">
                  <span class="kv-k">${escapeHtml(f.label)}</span>
                  <span class="kv-v">${escapeHtml(f.display)}${f.delta ? ` <span class="kv-meta-muted">· ${escapeHtml(f.delta)}</span>` : ""} <strong style="color:${f.color};margin-left:6px;">${escapeHtml(f.score)}</strong></span>
                </div>
              `
                )
                .join("")}
            </div>`
          : ""
      }
      ${
        risk
          ? `<div class="pro-risk-inline ${escapeHtml(risk.level || "ok")}">
              <span class="risk-dot"></span>
              <span><strong>${escapeHtml(risk.title)}</strong>：${escapeHtml(risk.text)}</span>
            </div>`
          : ""
      }
      ${rd.advice ? `<p class="pro-note-text">${escapeHtml(rd.advice)}</p>` : ""}
    `;

    const zones = pol.zones || [];
    const maxZoneMin = Math.max(...zones.map((z) => Number(z.duration_min || 0)), 1);
    const polarDetailHtml = `
      ${
        zones.length
          ? `<div class="hr-zones-list" style="margin-top:4px;padding-top:4px;border-top:none;">
              ${zones
                .map(
                  (z) => `
                <div class="hr-zone-row">
                  <div class="hr-zone-meta">
                    <div class="hr-zone-name" style="color:${z.color}">Z${z.zone} · ${escapeHtml(z.name)}</div>
                    <div class="hr-zone-bpm">${fmtNum(z.pct, 1)}%</div>
                  </div>
                  <div class="hr-zone-track">
                    <div class="hr-zone-fill" style="width:${z.duration_min > 0 ? Math.max(4, Math.round((z.duration_min / maxZoneMin) * 100)) : 0}%;background:${z.color}"></div>
                  </div>
                  <div class="hr-zone-dur">${fmtNum(z.duration_min, 0)}m</div>
                </div>
              `
                )
                .join("")}
            </div>`
          : ""
      }
      ${pol.diagnosis ? `<p class="pro-note-text">${escapeHtml(pol.diagnosis)}</p>` : ""}
    `;

    let weeklySectionHtml = "";
    if (wc) {
      const deltaTxt = wc.load_delta_pct != null ? `${wc.load_delta_pct >= 0 ? "+" : ""}${wc.load_delta_pct}%` : "-";
      const tips = wc.tips || [];
      const weeklyBodyHtml = `
        <div class="card">
          <div class="kv-list">
            <div class="kv-row"><span class="kv-k">统计周期</span><span class="kv-v">${escapeHtml(wc.range || "-")}</span></div>
            <div class="kv-row"><span class="kv-k">训练次数</span><span class="kv-v">${fmtNum(wc.workouts_count, 0)} 次</span></div>
            <div class="kv-row"><span class="kv-k">累计距离</span><span class="kv-v">${fmtNum(wc.distance_km, 1)} km</span></div>
            <div class="kv-row"><span class="kv-k">周负荷变化</span><span class="kv-v">${escapeHtml(deltaTxt)}</span></div>
            <div class="kv-row"><span class="kv-k">日均睡眠</span><span class="kv-v">${wc.avg_sleep_min != null ? fmtMinHm(wc.avg_sleep_min) : "-"}</span></div>
            <div class="kv-row"><span class="kv-k">均 HRV / 静息心率</span><span class="kv-v">${wc.avg_hrv != null ? fmtNum(wc.avg_hrv, 0) : "-"} ms / ${wc.avg_rhr != null ? fmtNum(wc.avg_rhr, 0) : "-"} bpm</span></div>
          </div>
          ${
            tips.length
              ? `<ul class="coach-tips" style="margin-top:12px;padding-top:10px;border-top:1px solid var(--hairline);">
                  ${tips.map((t) => `<li class="coach-tip-item"><span class="coach-tip-dot"></span><span>${escapeHtml(t)}</span></li>`).join("")}
                </ul>`
              : ""
          }
        </div>
      `;
      weeklySectionHtml = renderSectionDisclosureHtml(
        "近 7 天复盘与建议",
        `${fmtNum(wc.workouts_count, 0)} 次 · ${fmtNum(wc.distance_km, 1)} km`,
        weeklyBodyHtml
      );
    }

    container.innerHTML = `
      <div class="card">
        <div class="card-header" style="margin-bottom:4px;">
          <h3 class="card-title"><span id="pro-readiness-dot" class="dot-badge" style="background:${rd.color || p.green}"></span>准备度</h3>
          <span id="pro-readiness-date" class="card-note">${escapeHtml(rd.date || "-")}</span>
        </div>
        <div class="pro-hero-row">
          <span id="pro-readiness-score" class="pro-hero-num">${rd.score != null ? escapeHtml(rd.score) : "-"}</span>
          <span class="pro-hero-unit">分</span>
          <span id="pro-readiness-status" class="pro-hero-status" style="color:${rd.color || p.green}">${escapeHtml(rd.status || "")}</span>
        </div>
        <div id="pro-readiness-chart-wrap" class="svg-chart-wrap">
          ${drawReadinessTrendSvg(rd.trend_14d || [], rd.color || p.green, p)}
        </div>
        ${renderInlineDisclosureHtml("生理构成与建议", factors.length ? `${factors.length} 项指标` : "", readinessDetailHtml)}
      </div>

      <div class="card">
        <div class="card-header" style="margin-bottom:6px;">
          <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-orange)"></span>80/20 强度分布</h3>
          <div class="mini-pill-seg">
            <button class="mini-pill-btn ${polarWindow === "30d" ? "active" : ""}" data-pol="30d" type="button">30天</button>
            <button class="mini-pill-btn ${polarWindow === "90d" ? "active" : ""}" data-pol="90d" type="button">90天</button>
          </div>
        </div>
        <div class="apple-stat-strip">
          <div>
            <div class="apple-stat-lbl">低强度 (Z1–2)</div>
            <div class="apple-stat-val" style="color:#30D158">${fmtNum(pol.low_pct, 1)}%</div>
          </div>
          <div>
            <div class="apple-stat-lbl">灰区 (Z3)</div>
            <div class="apple-stat-val" style="color:#FF9F0A">${fmtNum(pol.mid_pct, 1)}%</div>
          </div>
          <div>
            <div class="apple-stat-lbl">高强度 (Z4–5)</div>
            <div class="apple-stat-val" style="color:#FF375F">${fmtNum(pol.high_pct, 1)}%</div>
          </div>
        </div>
        <div class="polar-bar">
          <div class="polar-seg-piece" style="width:${Math.max(2, pol.low_pct || 0)}%;background:#30D158"></div>
          <div class="polar-seg-piece" style="width:${Math.max(2, pol.mid_pct || 0)}%;background:#FFD60A"></div>
          <div class="polar-seg-piece" style="width:${Math.max(2, pol.high_pct || 0)}%;background:#FF375F"></div>
        </div>
        ${renderInlineDisclosureHtml("心率区间明细与分析", `${fmtNum(pol.workouts_count || 0)} 次 · ${fmtNum(pol.total_min || 0)}m`, polarDetailHtml)}
      </div>

      <div class="card heatmap-card">
        <div class="card-header" style="margin-bottom:6px;">
          <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-green)"></span>训练日历</h3>
          <div class="mini-pill-seg">
            <button class="mini-pill-btn ${heatmapSpan === "26w" ? "active" : ""}" data-hspan="26w" type="button">6个月</button>
            <button class="mini-pill-btn ${heatmapSpan === "52w" ? "active" : ""}" data-hspan="52w" type="button">全年</button>
          </div>
        </div>
        <div class="apple-stat-strip">
          <div>
            <div class="apple-stat-lbl">运动日</div>
            <div class="apple-stat-val">${fmtNum(hm.active_days || 0)}<span class="unit-sm">天</span></div>
          </div>
          <div>
            <div class="apple-stat-lbl">总距离</div>
            <div class="apple-stat-val">${fmtNum(hm.total_km || 0, 1)}<span class="unit-sm">km</span></div>
          </div>
          <div>
            <div class="apple-stat-lbl">最长连续</div>
            <div class="apple-stat-val">${fmtNum(hm.longest_streak || 0)}<span class="unit-sm">天</span></div>
          </div>
        </div>
        <div class="heatmap-scroll">
          <svg viewBox="0 0 ${svgW.toFixed(1)} ${svgH.toFixed(1)}" ${spanWeeks === 52 ? `width="${Math.round(svgW)}" height="${Math.round(svgH)}"` : 'class="apple-svg-chart"'}>
            ${dayLbls}${monthLbls.join("")}${rects}
          </svg>
        </div>
        <div class="load-filter-row">
          <span class="load-filter-lbl">训练负荷分类</span>
          <button id="load-filter-btn" class="glass-select-trigger" type="button" aria-haspopup="dialog">
            <span id="load-filter-val">${escapeHtml(loadSport || "所有运动")}</span>
            <svg class="glass-select-chev" viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="5 6 8 3 11 6"/><polyline points="5 10 8 13 11 10"/></svg>
          </button>
        </div>
        <div id="heatmap-readout" class="heatmap-readout">${formatHmReadout(defaultSel)}</div>
      </div>

      ${weeklySectionHtml}
    `;

    bindAppleDisclosures(container);
    bindReadinessTrendScrub($("pro-readiness-chart-wrap"), rd.trend_14d || [], rd, p);
    container.querySelectorAll("[data-pol]").forEach((b) => {
      b.addEventListener("click", () => {
        polarWindow = b.dataset.pol;
        renderProLoadTab(container, data, getThemePalette());
      });
    });
    container.querySelectorAll("[data-hspan]").forEach((b) => {
      b.addEventListener("click", () => {
        heatmapSpan = b.dataset.hspan;
        renderProLoadTab(container, data, getThemePalette());
      });
    });
    $("heatmap-readout").onclick=e=>{const row=e.target.closest("[data-load-session]");if(row)switchTab("workouts",{openDetailId:Number(row.dataset.loadSession),originEl:row});};
    const sportStats = new Map();
    let totalLoadAll = 0;
    (hm.sessions || []).forEach((w) => {
      totalLoadAll += Number(w.load || 0);
      const cur = sportStats.get(w.sport) || { count: 0, load: 0 };
      cur.count += 1;
      cur.load += Number(w.load || 0);
      sportStats.set(w.sport, cur);
    });
    const loadFilterOptions = [
      { value: "", label: "所有运动", meta: `${(hm.sessions || []).length} 次训练 · 累计负荷 ${fmtNum(totalLoadAll, 0)}` },
      ...[...sportStats.entries()]
        .sort((a, b) => b[1].load - a[1].load || b[1].count - a[1].count)
        .map(([name, st]) => ({ value: name, label: name, meta: `${st.count} 次 · 累计负荷 ${fmtNum(st.load, 0)}` })),
    ];
    $("load-filter-btn")?.addEventListener("click", () => {
      triggerHapticTick(4);
      openGlassSelectSheet({
        title: "选择运动负荷分类",
        subtitle: "切换热力图与近 4 周负荷趋势口径",
        options: loadFilterOptions,
        value: loadSport || "",
        onSelect: (nextSport) => {
          loadSport = nextSport;
          if ($("load-filter-val")) $("load-filter-val").textContent = loadSport || "所有运动";
          const ro = $("heatmap-readout");
          if (ro) ro.innerHTML = formatHmReadout(visibleCells.find((c) => c.date === selectedHeatmapDate));
        },
      });
    });
    container.querySelectorAll(".heatmap-cell").forEach((rect) => {
      rect.addEventListener("click", () => {
        const ds = rect.dataset.hdate;
        selectedHeatmapDate = ds;
        container.querySelectorAll(".heatmap-cell").forEach((r) => r.classList.toggle("selected", r.dataset.hdate === ds));
        const obj = visibleCells.find((c) => c.date === ds);
        const ro = $("heatmap-readout");
        if (ro) ro.innerHTML = formatHmReadout(obj);
      });
    });
  }

  function renderProSleepTab(container, data, p) {
    const sr = data.sleep_rhythm || {};
    const bal = sr.nightly_balance_14d || [];
    const corrs = data.correlations || [];

    const W = 320;
    const H = 156;
    const pL = 6;
    const pR = 280;
    const pT = 14;
    const pB = 128;
    const midY = (pT + pB) / 2;
    const maxDelta = Math.max(90, ...bal.map((b) => Math.abs(b.delta_min || 0)));
    const maxDebt = Math.max(120, ...bal.map((b) => b.cum_debt_min || 0));
    const stepW = (pR - pL) / Math.max(bal.length, 1);
    const barW = Math.max(6, Math.min(14, stepW * 0.56));
    const halfH = (pB - pT) * 0.42;

    const barsSvg = bal
      .map((b, i) => {
        const cx = pL + (i + 0.5) * stepW;
        const tick = i % 3 === 0 || i === bal.length - 1
          ? `<text x="${cx.toFixed(1)}" y="${H - 6}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${p.text2}">${escapeHtml(b.date.slice(5))}</text>`
          : "";
        if (b.delta_min == null) return tick;
        const h = Math.max(3, (Math.abs(b.delta_min) / maxDelta) * halfH);
        const isPos = b.delta_min >= 0;
        const y = isPos ? midY - h : midY;
        const col = isPos ? p.indigo : p.orange;
        return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${col}" opacity="0.82"/>${tick}`;
      })
      .join("");

    const debtPts = bal.map((b, i) => ({
      x: pL + (i + 0.5) * stepW,
      y: pB - (b.cum_debt_min / maxDebt) * (pB - pT - 6),
    }));
    const debtLineSvg = debtPts.length > 1
      ? `<path d="${buildSmoothSvgPath(debtPts, 0.22)}" fill="none" stroke="${p.purple}" stroke-width="2.2" stroke-linecap="round"/>`
      : "";

    const sleepDetailHtml = `
      <div class="kv-list">
        <div class="kv-row"><span class="kv-k">工作日均入睡</span><span class="kv-v">${escapeHtml(sr.weekday_bed_hm || "-")}</span></div>
        <div class="kv-row"><span class="kv-k">周末均入睡</span><span class="kv-v">${escapeHtml(sr.weekend_bed_hm || "-")}</span></div>
        <div class="kv-row"><span class="kv-k">社会时差</span><span class="kv-v">${sr.social_jetlag_h != null ? `${sr.social_jetlag_h} 小时` : "-"}</span></div>
      </div>
      ${sr.verdict ? `<p class="pro-note-text">${escapeHtml(sr.verdict)}</p>` : ""}
    `;

    const corrsInnerHtml = corrs.length
      ? `<div class="highlights-stack">${corrs
          .map(
            (c) => `
          <div class="highlight-card">
            <div class="highlight-top">
              <span class="highlight-badge" style="color:${escapeHtml(c.accent || p.indigo)}">
                <span class="dot-badge" style="background:${escapeHtml(c.accent || p.indigo)}"></span>
                ${escapeHtml(c.title)}
              </span>
              <span class="card-note">${escapeHtml(c.badge || "")}</span>
            </div>
            <p class="highlight-insight">${escapeHtml(c.insight)}</p>
            <div class="hl-bars">
              ${(c.bars || [])
                .map(
                  (b) => `
                <div class="hl-bar-row">
                  <div class="hl-bar-head">
                    <span class="hl-lbl">${escapeHtml(b.label)}</span>
                    <span class="hl-val">${escapeHtml(b.display)}</span>
                  </div>
                  <div class="hl-track">
                    <div class="hl-fill ${b.primary ? "" : "muted-fill"}" style="width:${b.pct}%;${b.primary ? `background:${escapeHtml(c.accent || p.indigo)}` : ""}"></div>
                  </div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
          )
          .join("")}</div>`
      : '<div class="card"><div class="card-note">全量相关性洞察需更多连续睡眠与 HRV 样本。</div></div>';

    container.innerHTML = `
      <div class="card">
        <div class="card-header" style="margin-bottom:6px;">
          <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-indigo)"></span>作息规律性与睡眠债</h3>
        </div>
        <div class="apple-stat-strip cols-2">
          <div>
            <div class="apple-stat-lbl">规律性 (SRI)</div>
            <div class="apple-stat-val" style="color:var(--apple-indigo)">${sr.sri_score ?? "-"}<span class="unit-sm">分</span></div>
          </div>
          <div>
            <div class="apple-stat-lbl">14 日睡眠债</div>
            <div class="apple-stat-val">${escapeHtml(fmtMinHmCn(sr.debt_14d_min))}</div>
          </div>
        </div>
        <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          <line x1="${pL}" y1="${midY.toFixed(1)}" x2="${pR}" y2="${midY.toFixed(1)}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="3 3"/>
          <text x="${W - 4}" y="${(pT + 6).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="600" fill="${p.text2}">+睡足</text>
          <text x="${W - 4}" y="${(midY + 3).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="600" fill="${p.text2}">8h线</text>
          <text x="${W - 4}" y="${(pB - 2).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="600" fill="${p.text2}">欠眠</text>
          ${barsSvg}${debtLineSvg}
        </svg>
        <div class="chart-legend-row" style="margin-top:6px;">
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.indigo}"></span>超出 8h</span>
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.orange}"></span>低于 8h</span>
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.purple}"></span>累计睡眠债曲线</span>
        </div>
        ${renderInlineDisclosureHtml("作息明细与解读", sr.social_jetlag_h != null ? `时差 ${sr.social_jetlag_h}h` : "", sleepDetailHtml)}
      </div>

      ${renderSectionDisclosureHtml("个人关联发现", corrs.length ? `${corrs.length} 项结论` : "", corrsInnerHtml)}
    `;

    bindAppleDisclosures(container);
  }

  function renderProAerobicTab(container, data, p) {
    const lab = data.aerobic_lab || {};
    const series = lab.ef_series || [];

    const W = 320;
    const H = 148;
    const pL = 6;
    const pR = 278;
    const pT = 14;
    const pB = 122;

    let chartHtml = '<div class="empty-inline-box">积累至少 2 次带距离与心率的跑步训练即可绘制有氧效率曲线。</div>';
    if (series.length >= 2) {
      const efs = series.map((s) => Number(s.ef));
      const [yLo, yHi, yTicks] = niceBounds(efs, 0.8, 2.2);
      const mapX = (i) => pL + (i / Math.max(series.length - 1, 1)) * (pR - pL);
      const mapY = (v) => pB - ((Number(v) - yLo) / Math.max(yHi - yLo, 1e-6)) * (pB - pT);
      const coords = series.map((s, i) => ({ x: mapX(i), y: mapY(s.ef) }));
      const pathD = buildSmoothSvgPath(coords, 0.22);
      const areaD = `${pathD} L${coords[coords.length - 1].x.toFixed(1)} ${pB} L${coords[0].x.toFixed(1)} ${pB} Z`;
      const grid = yTicks
        .filter((t) => t >= yLo && t <= yHi)
        .map((t) => `<line x1="${pL}" y1="${mapY(t).toFixed(1)}" x2="${pR}" y2="${mapY(t).toFixed(1)}" stroke="${p.grid}" stroke-width="1"/><text x="${W - 4}" y="${(mapY(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="9.5" font-weight="600" fill="${p.text2}">${Number(t).toFixed(2)}</text>`)
        .join("");
      const dots = coords.map((c, idx) => `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${idx === coords.length - 1 ? "4" : "2.6"}" fill="${idx === coords.length - 1 ? p.green : p.surfaceSolid}" stroke="${p.green}" stroke-width="1.8"/>`).join("");
      const ticks = [0, series.length - 1]
        .filter((v, idx, a) => a.indexOf(v) === idx)
        .map((i) => `<text x="${mapX(i).toFixed(1)}" y="${H - 5}" text-anchor="${i === 0 ? "start" : "end"}" font-size="9.5" font-weight="600" fill="${p.text2}">${escapeHtml(series[i].date.slice(5))}</text>`)
        .join("");
      chartHtml = `
        <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}" aria-hidden="true">
          ${grid}${ticks}
          <path d="${areaD}" fill="${p.green}" fill-opacity="0.14"/>
          <path d="${pathD}" fill="none" stroke="${p.green}" stroke-width="2.4" stroke-linecap="round"/>
          ${dots}
        </svg>
      `;
    }

    const deltaTxt = lab.ef_delta_pct != null ? `${lab.ef_delta_pct >= 0 ? "+" : ""}${lab.ef_delta_pct}%` : "-";
    const decTxt = lab.avg_decoupling_pct != null ? `${lab.avg_decoupling_pct > 0 ? "+" : ""}${lab.avg_decoupling_pct}%` : "-";
    const recentRuns = [...series].reverse().slice(0, 12);

    const runsDetailHtml = `
      ${lab.summary_text ? `<p class="pro-note-text" style="margin-top:2px;margin-bottom:8px;">${escapeHtml(lab.summary_text)}</p>` : ""}
      <div style="margin:0 -16px -6px;">
        ${
          recentRuns.length
            ? recentRuns
                .map((r) => {
                  const dec = r.decoupling_pct;
                  const decCol = dec == null ? p.text2 : (dec <= 5 ? p.green : (dec <= 8 ? p.orange : p.red));
                  return `
                  <button class="aerobic-run-row" data-wid="${r.workout_id}" type="button">
                    <div>
                      <div style="font-weight:700;font-size:14px;">${escapeHtml(r.sport_name)} · ${fmtNum(r.distance_km, 2)} km</div>
                      <div class="grouped-sub">${escapeHtml(r.date)} · ${r.pace_s ? fmtWorkoutPace(r, r.pace_s) : `${r.duration_min}m`} · 均心率 ${fmtNum(r.hr_avg, 0)}</div>
                    </div>
                    <div style="text-align:right;">
                      <div style="font-weight:700;font-size:14px;font-variant-numeric:tabular-nums;">EF ${r.ef}</div>
                      <div class="grouped-meta" style="color:${decCol};font-weight:600;">${dec != null ? `解耦 ${dec > 0 ? "+" : ""}${dec}%` : "详情"} ›</div>
                    </div>
                  </button>
                `;
                })
                .join("")
            : '<div style="padding:12px 16px;" class="card-note">暂无跑步记录</div>'
        }
      </div>
    `;

    container.innerHTML = `
      <div class="card">
        <div class="card-header" style="margin-bottom:6px;">
          <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-green)"></span>有氧效率 (EF)</h3>
          ${lab.ef_30d_avg != null ? `<span class="card-note">30日均 ${lab.ef_30d_avg}</span>` : ""}
        </div>
        <div class="apple-stat-strip">
          <div>
            <div class="apple-stat-lbl">最近 EF</div>
            <div class="apple-stat-val" style="color:var(--apple-green)">${lab.latest_ef ?? "-"}</div>
          </div>
          <div>
            <div class="apple-stat-lbl">30日变化</div>
            <div class="apple-stat-val">${escapeHtml(deltaTxt)}</div>
          </div>
          <div>
            <div class="apple-stat-lbl">平均解耦</div>
            <div class="apple-stat-val">${escapeHtml(decTxt)}</div>
          </div>
        </div>
        ${chartHtml}
        ${renderInlineDisclosureHtml("单次跑步解耦与说明", `${recentRuns.length} 次跑步`, runsDetailHtml)}
      </div>
    `;

    bindAppleDisclosures(container);
    container.querySelectorAll(".aerobic-run-row").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedWorkoutId = Number(btn.dataset.wid);
        switchTab("workouts", { openDetailId: selectedWorkoutId, originEl: btn });
      });
    });
  }

  function renderSummaryTab(data) {
    if (!restoringNavigation) $("tab-summary")?.classList.remove("no-anim-replay");
    const days14 = data.recent_14d && data.recent_14d.length ? data.recent_14d : (data.daily_series || []).slice(-14);
    const daysDesc = [...days14].reverse();
    const latest = data.latest_day || daysDesc[0] || {};
    const refDate = latest.date || data.window?.end_date || "";

    // Hero 1: Activity Rings
    const cal = Number(latest.calories_kcal || 0);
    const calGoal = Number(latest.calorie_goal_kcal || 300);
    const exMin = Number(latest.moderate_high_min || 0);
    const exGoal = 25;
    const actHrs = Number(latest.active_hours || 0);
    const actGoal = 12;

    const heroRingsEl = $("hero-rings-card");
    Object.assign(heroRingsEl.dataset, {metric: "activity", scope: "D", endDate: refDate});
    heroRingsEl.innerHTML = `
      <div class="hero-top">
        <span class="hero-cat" style="color:var(--apple-red)">
          <span class="cat-dot" style="background:rgba(255,45,85,0.12);color:var(--apple-red)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 2a10 10 0 1 0 10 10"/></svg>
          </span>
          每日健身圆环
        </span>
        <span class="hero-meta-date">${escapeHtml(fmtRelDate(latest.date, refDate))} ›</span>
      </div>
      <div class="rings-body">
        <div class="rings-svg-wrap">
          ${renderActivityRingsSvg(cal / Math.max(calGoal, 1), exMin / exGoal, actHrs / actGoal)}
        </div>
        <div class="rings-legend">
          <div class="ring-stat-row">
            <span class="ring-lbl"><span class="ring-swatch" style="background:var(--ring-move)"></span>活动</span>
            <span class="ring-val">${fmtNum(cal, 0)} <span class="ring-goal">/ ${fmtNum(calGoal, 0)} 千卡</span></span>
          </div>
          <div class="ring-stat-row">
            <span class="ring-lbl"><span class="ring-swatch" style="background:var(--ring-ex)"></span>锻炼</span>
            <span class="ring-val">${fmtNum(exMin, 0)} <span class="ring-goal">/ ${exGoal} 分钟</span></span>
          </div>
          <div class="ring-stat-row">
            <span class="ring-lbl"><span class="ring-swatch" style="background:var(--ring-stand)"></span>活跃</span>
            <span class="ring-val">${fmtNum(actHrs, 0)} <span class="ring-goal">/ ${actGoal} 小时</span></span>
          </div>
        </div>
      </div>
    `;
    heroRingsEl.onclick = () => openMetricDetail("activity", { scope: "D", endDate: refDate, fromTab: "summary" }, heroRingsEl);

    // Hero 2: Sleep Card
    const slp = data.latest_night_sleep || {};
    const slpDate = slp.date || refDate;
    const totalSlp = slp.total_sleep_min ?? latest.sleep_total_min;
    const deepM = Number(slp.deep_min ?? latest.sleep_deep_min ?? 0);
    const lightM = Number(slp.light_min ?? latest.sleep_light_min ?? 0);
    const remM = Number(slp.rem_min ?? latest.sleep_rem_min ?? 0);
    const awakeM = Number(slp.awake_min ?? latest.sleep_awake_min ?? 0);
    const stageSum = Math.max(deepM + lightM + remM + awakeM, 1);
    const slpScore = slp.sleep_score ?? latest.sleep_score;
    const slpHrv = slp.avg_hrv ?? pickLatestValid(daysDesc, (d) => d.hrv_avg ?? d.hrv_last).value;

    const heroSleepEl = $("hero-sleep-card");
    Object.assign(heroSleepEl.dataset, {metric: "sleep", scope: "D", endDate: slpDate});
    heroSleepEl.innerHTML = `
      <div class="hero-top">
        <span class="hero-cat" style="color:var(--apple-indigo)">
          <span class="cat-dot" style="background:rgba(88,86,214,0.12);color:var(--apple-indigo)">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </span>
          睡眠与分期
        </span>
        <span class="hero-meta-date">${escapeHtml(slpDate ? slpDate.slice(5) : "-")} ›</span>
      </div>
      <div class="sleep-hero-main">
        <div>
          <div class="sleep-big">${fmtMinHm(totalSlp)}</div>
          <div class="card-note">${slp.start_iso ? `${slp.start_iso.slice(11, 16)} 入睡 ~ ${slp.end_iso?.slice(11, 16) || ""}` : "睡眠时长"}</div>
        </div>
        <span class="sleep-score-pill">评分 ${fmtNum(slpScore, 0)}</span>
      </div>
      <div class="stage-pill-bar">
        <div class="stage-seg" style="width:${((deepM / stageSum) * 100).toFixed(1)}%;background:var(--apple-deep)"></div>
        <div class="stage-seg" style="width:${((lightM / stageSum) * 100).toFixed(1)}%;background:var(--apple-light-sleep)"></div>
        <div class="stage-seg" style="width:${((remM / stageSum) * 100).toFixed(1)}%;background:var(--apple-cyan)"></div>
        ${awakeM > 0 ? `<div class="stage-seg" style="width:${((awakeM / stageSum) * 100).toFixed(1)}%;background:var(--apple-awake)"></div>` : ""}
      </div>
      <div hidden class="sleep-hero-foot">
        <span>深睡 ${fmtNum(deepM, 0)}m</span>
        <span>核心 ${fmtNum(lightM, 0)}m</span>
        <span>REM ${fmtNum(remM, 0)}m</span>
        ${slpHrv != null ? `<span style="color:var(--apple-green);font-weight:600;">夜间 HRV ${fmtNum(slpHrv, 0)} ms</span>` : ""}
      </div>
    `;
    heroSleepEl.onclick = () => openMetricDetail("sleep", { scope: "D", endDate: slpDate, fromTab: "summary" }, heroSleepEl);

    renderReadinessSummaryCard(data);

    // iOS 18 Overnight Vitals Card
    const ov = data.overnight_vitals;
    const vitCard = $("summary-vitals-card");
    const vitTag = $("vitals-status-tag");
    if (vitCard && vitTag) {
      if (ov && (ov.items || []).length) {
        const hasOutlier = ov.items.some(it=>["low","high"].includes(it.status));
        vitTag.textContent = ov.summary_text || `${ov.in_range_count}/${ov.total_count} 正常`;
        vitTag.classList.toggle("warn", hasOutlier);
        vitCard.classList.remove("hidden");
        vitCard.innerHTML = `
          <div class="vitals-list">
            ${ov.items
              .map((it) => {
                const isOut = ["low","high"].includes(it.status);
                return `
                  <div class="vitals-row" data-metric="${it.metric}" role="button" tabindex="0">
                    <div>
                      <div class="vitals-name">${escapeHtml(it.label)}</div>
                      <div class="vitals-val ${isOut ? "outlier" : ""}">${escapeHtml(it.display)}</div>
                    </div>
                    <div class="vitals-bar-wrap">
                      <div class="vitals-bar-track">
                        <div class="vitals-typical-band"></div>
                        <div ${it.status==="pending"?"hidden":""} class="vitals-dot ${isOut ? "outlier" : ""}" style="left:${it.pos_pct}%"></div>
                      </div>
                    </div>
                    <div class="vitals-range-txt">${escapeHtml(it.range_display)}</div>
                  </div>
                `;
              })
              .join("")}
          </div>
        `;
        vitCard.insertAdjacentHTML("beforeend",`<details class="source-note"><summary>个人基线 · ${escapeHtml(ov.date)}</summary>${ov.items.map(it=>`<p>${escapeHtml(it.label)} · ${escapeHtml(it.method||"")}</p>`).join("")}</details>`);
        vitCard.querySelectorAll(".vitals-row").forEach((row) => {
          row.addEventListener("click", () => {
            openMetricDetail(row.dataset.metric, { scope: row.dataset.metric === "sleep" ? "D" : "W", fromTab: "summary" }, row);
          });
        });
      } else {
        vitTag.textContent = "暂无基线";
        vitCard.innerHTML = '<div class="card-note">昨晚暂无完整睡眠生命体征记录</div>';
      }
    }

    // Pinned Health Metric Cards (calm mixed typography + Apple micro-charts)
    const hrPick = pickLatestValid(daysDesc, (d) => d.hr_last ?? d.hr_avg ?? d.hr_rest);
    const hrvPick = pickLatestValid(daysDesc, (d) => d.hrv_avg ?? d.hrv_last);
    const slpPick = pickLatestValid(daysDesc, (d) => d.sleep_total_min);
    const stepPick = pickLatestValid(daysDesc, (d) => d.steps);
    const spo2Pick = pickLatestValid(daysDesc, (d) => d.spo2_avg);
    const stressPick = pickLatestValid(daysDesc, (d) => d.stress_avg);

    const kpis = data.kpis || {};
    const stepGoal = stepPick.row?.step_goal || 10000;
    const hrRow = daysDesc.find((d) => d.hr_min != null && d.hr_max != null) || latest;
    const emoRow = daysDesc.find((d) => (d.emotion_total_count || 0) > 0) || latest;
    const emoTot = Number(emoRow.emotion_total_count || 0);
    const emoPeacePct = emoTot > 0 ? Math.round((Number(emoRow.emotion_peace_count || 0) / emoTot) * 100) : null;
    const p = getThemePalette();

    const cards = [
      {
        metric: "heart_rate",
        scope: "D",
        title: "心率",
        color: "var(--apple-red)",
        dateLabel: fmtRelDate(hrPick.row?.date, refDate),
        valueHtml: fmtSplitValHtml(hrRow.hr_min != null && hrRow.hr_max != null ? `${fmtNum(hrRow.hr_min, 0)}–${fmtNum(hrRow.hr_max, 0)}` : fmtNum(hrPick.value, 0), "次/分"),
        sub: `静息 ${fmtNum(pickLatestValid(daysDesc, (d) => d.hr_rest).value, 0)} 次/分`,
        svg: renderHeartRateWeekMiniSvg(days14, p.red),
      },
      {
        metric: "hrv",
        scope: "W",
        title: "心率变异性 (HRV)",
        color: "var(--apple-green)",
        dateLabel: fmtRelDate(hrvPick.row?.date, refDate),
        valueHtml: fmtSplitValHtml(fmtNum(hrvPick.value, 0), "毫秒"),
        sub: `30日均值 ${fmtNum(kpis.hrv_avg?.current, 1)} 毫秒`,
        svg: renderAppleHollowLineMiniSvg(days14.map((d) => d.hrv_avg ?? d.hrv_last ?? null), p.green),
      },
      {
        metric: "steps",
        scope: "D",
        title: "步数",
        color: "var(--apple-orange)",
        dateLabel: fmtRelDate(stepPick.row?.date, refDate),
        valueHtml: fmtSplitValHtml(fmtNum(stepPick.value, 0), "步"),
        sub: `目标 ${fmtNum(stepGoal)} 步 · ${fmtNum((stepPick.row?.distance_m || 0) / 1000, 1)} 公里`,
        svg: renderAppleBarsMiniSvg(days14.map((d) => d.steps ?? 0), p.orange),
      },
      {
        metric: "sleep",
        scope: "W",
        title: "睡眠",
        color: "var(--apple-indigo)",
        dateLabel: fmtRelDate(data.latest_night_sleep?.date || slpPick.row?.date, refDate),
        valueHtml: fmtSplitHmHtml(data.latest_night_sleep?.total_sleep_min ?? slpPick.value),
        sub: `深睡均值 ${fmtNum(kpis.sleep_deep_min?.current, 0)} 分钟`,
        svg: renderAppleSleepMiniHypnoSvg(data.latest_night_stages, days14),
      },
      {
        metric: "spo2",
        scope: "W",
        title: "血氧饱和度",
        color: "var(--apple-teal)",
        dateLabel: fmtRelDate(spo2Pick.row?.date, refDate),
        valueHtml: fmtSplitValHtml(fmtNum(spo2Pick.value, 0), "%"),
        sub: `最低 ${fmtNum(spo2Pick.row?.spo2_min, 0)}% · 均值 ${fmtNum(kpis.spo2_avg?.current, 1)}%`,
        svg: renderAppleHollowLineMiniSvg(days14.map(d => d.spo2_avg ?? d.spo2_last), p.teal),
      },
      {
        metric: "stress",
        scope: "W",
        title: "压力与心理状态",
        color: "var(--apple-purple)",
        dateLabel: fmtRelDate(stressPick.row?.date, refDate),
        valueHtml: fmtSplitValHtml(fmtNum(stressPick.value, 0), "分"),
        sub: emoPeacePct !== null ? `平和情绪 ${emoPeacePct}% · 均值 ${fmtNum(kpis.stress_avg?.current, 1)}` : `均值 ${fmtNum(kpis.stress_avg?.current, 1)}`,
        svg: renderAppleHollowLineMiniSvg(days14.map((d) => d.stress_avg ?? null), p.purple),
      },
    ];

    const grid = $("summary-cards-grid");
    const editor = $("pin-editor");
    const defaults = cards.map((card) => card.metric);
    const catalog = new Map(cards.map((card) => [card.metric, card]));
    for (const item of getBrowseMetricItems(data)) {
      if (!catalog.has(item.metric)) {
        catalog.set(item.metric, { ...item, value: item.val, dateLabel: "", sub: "", svg: "" });
      }
    }

    let stored = {};
    try { stored = JSON.parse(localStorage.getItem("health-pins") || "{}") || {}; } catch {}
    const legacyOrder = Array.isArray(stored.order) ? stored.order : [];
    const legacyHidden = new Set(Array.isArray(stored.hidden) ? stored.hidden : []);
    const selected = Array.isArray(stored.selected)
      ? stored.selected
      : [...legacyOrder, ...defaults].filter((metric) => defaults.includes(metric) && !legacyHidden.has(metric));
    const pinned = [...new Set(selected.map(normalizeTemperatureMetric))].filter((metric) => catalog.has(metric));

    function drawPins() {
      renderMetricCardsGrid(grid, pinned.map((metric) => catalog.get(metric)));
      const available = [...catalog.values()].filter((card) => !pinned.includes(card.metric));
      editor.innerHTML = `
        <h3 class="pin-editor-section">已置顶</h3>
        ${pinned.length ? pinned.map((metric, i) => {
          const title = escapeHtml(catalog.get(metric).title);
          return `<div class="kv-row">
            <span>${title}</span>
            <div class="pin-editor-order">
              <button type="button" class="text-link-btn" data-pin-action="up" data-metric="${metric}" ${i === 0 ? "disabled" : ""} aria-label="上移${title}">上移</button>
              <button type="button" class="text-link-btn" data-pin-action="down" data-metric="${metric}" ${i === pinned.length - 1 ? "disabled" : ""} aria-label="下移${title}">下移</button>
              <button type="button" class="text-link-btn" data-pin-action="remove" data-metric="${metric}" aria-label="移除${title}">移除</button>
            </div>
          </div>`;
        }).join("") : '<p class="card-note">暂无置顶项目</p>'}
        <h3 class="pin-editor-section">可添加</h3>
        ${available.length ? available.map((card) => `<div class="kv-row">
          <span>${escapeHtml(card.title)}</span>
          <button type="button" class="text-link-btn" data-pin-action="add" data-metric="${card.metric}" aria-label="添加${escapeHtml(card.title)}">添加</button>
        </div>`).join("") : '<p class="card-note">所有项目均已置顶</p>'}
      `;
    }

    editor.onclick = (event) => {
      const button = event.target.closest("button[data-pin-action]");
      if (!button || button.disabled) return;
      const { metric, pinAction } = button.dataset;
      const index = pinned.indexOf(metric);
      const scrollTop = editor.scrollTop;
      if (pinAction === "add") pinned.push(metric);
      else if (pinAction === "remove") pinned.splice(index, 1);
      else {
        const target = index + (pinAction === "up" ? -1 : 1);
        [pinned[index], pinned[target]] = [pinned[target], pinned[index]];
      }
      try { localStorage.setItem("health-pins", JSON.stringify({ selected: pinned })); } catch {}
      drawPins();
      editor.scrollTop = scrollTop;
      const rowActions = [...editor.querySelectorAll(`button[data-metric="${metric}"]:enabled`)];
      const next = rowActions.find((item) => item.dataset.pinAction === pinAction) || rowActions[0];
      if (next) {
        // For add/remove the metric moves between sections. Keep the
        // viewport on the current section while the user edits other items.
        if (pinAction === "up" || pinAction === "down") next.focus({ preventScroll: true });
        else editor.querySelector(`button[data-pin-action="${pinAction}"]:enabled`)?.focus({ preventScroll: true });
      }
    };
    const pinDialog = $("pin-editor-dialog");
    const pinTrigger = $("edit-pins");
    const closePinEditor = async () => {
      if (!pinDialog.open || pinDialog.classList.contains("is-closing")) return;
      pinDialog.classList.add("is-closing");
      const surface = pinDialog.querySelector(".pin-editor-surface");
      await animateDialogDismiss(
        pinDialog,
        surface,
        ".pin-editor-backdrop",
        { opacity: 0, transform: "translateY(10px) scale(.97)" },
        180,
        false
      );
      pinDialog.classList.remove("is-closing");
      syncNativeBackState();
      pinTrigger.focus({ preventScroll: true });
    };
    pinTrigger.onclick = () => {
      if (!pinDialog.open) {
        pinDialog.showModal();
        syncNativeBackState();
      }
    };
    $("pin-editor-done").onclick = closePinEditor;
    pinDialog.oncancel = event => {
      event.preventDefault();
      closePinEditor();
    };
    pinDialog.onclick = event => {
      if (event.target === pinDialog) closePinEditor();
    };
    drawPins();
    renderSummaryHighlights(data, refDate);

    // Athletic Performance Grid (VO2 Max, Training Index, Running Index)
    const ath = data.athletic_summary || {};
    const vInfo = ath.vo2max || {};
    const tInfo = ath.training_index || {};
    const rInfo = ath.running_index || {};
    const athCards = [
      {
        metric: "vo2max",
        scope: "6M",
        title: "最大摄氧量",
        color: "var(--apple-red)",
        dateLabel: fmtRelDate(vInfo.date, refDate),
        value: vInfo.latest != null ? fmtNum(vInfo.latest, 1) : "-",
        unit: "mL/kg·min",
        sub: vInfo.level ? `有氧适能等级 · ${vInfo.level}` : "需户外跑步数据",
        svg: renderSparklineSvg(vInfo.series || [], "var(--apple-red)", "rgba(255,45,85,0.14)"),
      },
      {
        metric: "training_index",
        scope: "M",
        title: "训练指数",
        color: "var(--apple-blue)",
        dateLabel: fmtRelDate(tInfo.date, refDate),
        value: tInfo.tsb != null ? `${tInfo.tsb >= 0 ? "+" : ""}${fmtNum(tInfo.tsb, 1)}` : "-",
        unit: "分",
        sub: tInfo.status ? `${tInfo.status} · 7天负荷 ${fmtNum(tInfo.load_7d, 0)}` : "急慢性负荷评估",
        svg: renderSparklineSvg(tInfo.series || [], "var(--apple-blue)", "rgba(0,122,255,0.15)"),
      },
      {
        metric: "running_index",
        scope: "6M",
        title: "跑步指数 (RAI)",
        color: "var(--apple-green)",
        dateLabel: fmtRelDate(rInfo.date, refDate),
        value: rInfo.latest != null ? fmtNum(rInfo.latest, 1) : "-",
        unit: "分",
        sub: rInfo.tier ? `${rInfo.tier} · 完赛能力评估` : "配速心率综合评估",
        svg: renderSparklineSvg(rInfo.series || [], "var(--apple-green)", "rgba(40,205,65,0.15)"),
      },
    ];
    renderMetricCardsGrid($("summary-athletic-grid"), athCards);

    // Recent Trends (7d vs 30d)
    const trendsBox = $("summary-trends-grid");
    const trendsList = data.trends || [];
    if (trendsBox) {
      if (!trendsList.length) {
        trendsBox.innerHTML = '<div class="card"><div class="card-note">近期趋势积累中</div></div>';
      } else {
        trendsBox.innerHTML = trendsList
          .map((t) => {
            const arrow = t.direction === "up" ? "↗" : t.direction === "down" ? "↘" : "→";
            const cmpTxt =
              t.direction === "flat"
                ? `与30日均 ${t.display_30d} 持平`
                : `${t.delta_pct > 0 ? "+" : ""}${t.delta_pct}% · 30日均 ${t.display_30d}`;
            return `
              <div class="trend-card interactive-card" data-metric="${t.metric}" role="button" tabindex="0">
                <div class="trend-arrow-badge ${t.sentiment}">${arrow}</div>
                <div class="trend-info">
                  <div class="trend-title">${escapeHtml(t.label)}</div>
                  <div class="trend-main">${escapeHtml(t.display_7d)}</div>
                  <div class="trend-sub">${escapeHtml(cmpTxt)}</div>
                </div>
              </div>
            `;
          })
          .join("");
        trendsBox.querySelectorAll(".trend-card").forEach((el) => {
          el.addEventListener("click", () => {
            openMetricDetail(el.dataset.metric, { scope: "M", fromTab: "summary" }, el);
          });
        });
      }
    }

    // Recent Workouts
    const recBox = $("summary-recent-workouts");
    const recWos = data.recent_workouts || [];
    summaryRenderedRef = data;
    if (!recWos.length) {
      recBox.innerHTML = '<div style="padding:18px;" class="card-note">暂无最近体能训练</div>';
      return;
    }

    recBox.innerHTML = recWos
      .map(
        (w) => `
      <button class="grouped-row" data-wid="${w.workout_id}" type="button">
        <div class="grouped-row-left">
          <div class="wo-sport-badge">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="5" r="2"/><path d="M7 21l3-6 2.5 1.5L15 21"/><path d="M6 12l4-3 3 2 4-3"/></svg>
          </div>
          <div>
            <div class="grouped-title">
              <span>${escapeHtml(w.sport_name)}</span>
              ${w.has_gps ? '<span class="gps-pill">GPS</span>' : ""}
            </div>
            <div class="grouped-sub">${escapeHtml(w.date)} · ${escapeHtml((w.start_iso || "").slice(11, 16))}${w.pace_avg_s_per_km ? " · " + fmtWorkoutPace(w, w.pace_avg_s_per_km) : ""}</div>
          </div>
        </div>
        <div class="grouped-row-right">
          <div class="grouped-val">${w.distance_m ? (w.distance_m / 1000).toFixed(2) + " km" : fmtDurationSec(w.duration_s)}</div>
          <div class="grouped-meta">${fmtDurationSec(w.duration_s)}${w.hr_avg ? " · " + fmtNum(w.hr_avg, 0) + " bpm" : ""} ›</div>
        </div>
      </button>
    `
      )
      .join("");

    recBox.querySelectorAll(".grouped-row").forEach((b) => {
      b.addEventListener("click", () => {
        selectedWorkoutId = Number(b.dataset.wid);
        switchTab("workouts", { openDetailId: selectedWorkoutId, originEl: b });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Apple Health Metric Detail View & Interactive SVG Engine
  // -----------------------------------------------------------------------

  function getDefaultHeroSub(data) {
    if (!data) return "";
    if (data.metric === "sleep" && data.scope === "D" && data.sleep_detail) {
      const sd = data.sleep_detail;
      const fmtMs = (ms) => (ms ? new Date(Number(ms)).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" }) : "");
      const s = sd.start_iso ? sd.start_iso.slice(11, 16) : (sd.stages?.[0]?.start_iso?.slice(11, 16) || fmtMs(sd.start_ms));
      const e = sd.end_iso ? sd.end_iso.slice(11, 16) : (sd.stages?.[sd.stages.length - 1]?.end_iso?.slice(11, 16) || fmtMs(sd.end_ms));
      if (s) return e ? `${s} 入睡 – ${e} 起床` : `${s} 入睡`;
    }
    if (data.metric === "sleep" && data.scope !== "D" && data.hero?.avg_bed_hm && data.hero.avg_bed_hm !== "-") {
      return `平均入睡 ${data.hero.avg_bed_hm} · 起床 ${data.hero.avg_wake_hm}`;
    }
    const rl = data.hero?.range_label || "";
    if (rl && rl !== data.range_label) return rl;
    return "";
  }

  function syncSleepBreakdownSlot(data, p) {
    const brSlot = $("md-sleep-breakdown-slot");
    if (!brSlot) return;
    const show = data && data.metric === "sleep" && data.scope === "D" && detailState?.sleepMode !== "summary";
    brSlot.innerHTML = show ? renderSleepStageBreakdownHtml(data.sleep_detail, p) : "";
  }

  function signedTemperature(value) {
    return `${value > 0 ? "+" : ""}${fmtNum(value, 1)}`;
  }

  function renderTemperatureDetail(body, data) {
    const scope = data.scope || detailState.scope;
    const daily = scope === "D";
    const values = data.temperature_points || [];
    const formatBody = (value) => Number.isFinite(value) ? `${fmtNum(value, 1)} °C` : "—";
    const formatWrist = (value) => Number.isFinite(value) ? `${signedTemperature(value)} °C` : "—";
    body.innerHTML = `
      <div class="scope-seg" role="group" aria-label="时间范围">
        ${SCOPE_LABELS.map((item) => `<button class="scope-btn ${scope === item.id ? "active" : ""}" type="button"
          aria-pressed="${scope === item.id}" data-temp-scope="${item.id}">${item.label}</button>`).join("")}
      </div>
      <div class="apple-chart-card temperature-chart">
        <div class="period-stepper">
          <button class="stepper-arrow" type="button" data-temp-step="prev" aria-label="上一周期" ${data.prev_end ? "" : "disabled"}>‹</button>
          <div class="stepper-label">${escapeHtml(data.range_label || data.title)}</div>
          <button class="stepper-arrow" type="button" data-temp-step="next" aria-label="下一周期" ${data.next_end ? "" : "disabled"}>›</button>
        </div>
        <div class="temperature-readouts">
          <div class="temperature-body"><span>体温</span><strong id="temperature-body">—</strong></div>
          <div class="temperature-wrist"><span>腕温 · 基线偏差</span><strong id="temperature-wrist">—</strong></div>
        </div>
        <p class="card-note" id="temperature-label"></p>
        <div class="svg-chart-wrap" id="temperature-plot"></div>
      </div>
    `;
    body.querySelectorAll("[data-temp-scope]").forEach((button) => {
      button.onclick = () => {
        if (detailState.scope === button.dataset.tempScope) return;
        detailState.scope = button.dataset.tempScope;
        fetchAndRenderMetricDetail();
      };
    });
    body.querySelectorAll("[data-temp-step]").forEach((button) => {
      button.onclick = () => {
        detailState.endDate = data[`${button.dataset.tempStep}_end`];
        fetchAndRenderMetricDetail();
      };
    });

    const bodyReadout = $("temperature-body");
    const wristReadout = $("temperature-wrist");
    const label = $("temperature-label");
    const bodyValues = values.map((p) => p.body).concat(daily ? [data.daily_body] : []).filter(Number.isFinite);
    const wristValues = values.map((p) => p.wrist).concat(daily ? [data.daily_wrist] : []).filter(Number.isFinite);
    if (!bodyValues.length && !wristValues.length) {
      label.textContent = "本周期暂无体温或腕温记录";
      return;
    }

    const width = 320, height = 188, left = 34, right = 284, top = 17, bottom = 162;
    const warm = "var(--apple-orange)", cool = "var(--apple-purple)";
    const x = (point, index) => daily
      ? left + point.minute / 1440 * (right - left)
      : values.length === 1 ? (left + right) / 2 : left + index * (right - left) / (values.length - 1);
    const bodyLow = Math.min(35.5, ...bodyValues), bodyHigh = Math.max(37.5, ...bodyValues);
    const band = data.typical_band || [];
    const wristLimit = Math.max(1, ...wristValues.concat(band).map(Math.abs));
    const scale = (low, high) => (value) => bottom - (value - low) / (high - low) * (bottom - top);
    const yBody = scale(bodyLow, bodyHigh), yWrist = scale(-wristLimit, wristLimit);
    function series(key, y, color, dashed = false) {
      let path = "";
      let connected = false;
      const dots = [];
      values.forEach((point, index) => {
        if (!Number.isFinite(point[key])) {
          connected = false;
          return;
        }
        const px = x(point, index), py = y(point[key]);
        path += `${connected && !daily ? "L" : "M"}${px},${py} `;
        connected = true;
        dots.push(`<circle cx="${px}" cy="${py}" r="${dashed ? 2.7 : 3.2}" fill="${color}"/>`);
      });
      return `<g data-temp-series="${key}">
        <path d="${path}" stroke="${color}" stroke-width="1.8" fill="none" ${dashed ? 'stroke-dasharray="4 3"' : ""}/>
        ${dots.join("")}
      </g>`;
    }
    const dailyLine = (value, y, color, key) => Number.isFinite(value)
      ? `<line data-temp-daily="${key}" x1="${left}" x2="${right}" y1="${y(value)}" y2="${y(value)}" stroke="${color}" stroke-width="1.8" stroke-dasharray="5 3"/>` : "";
    const ticks = daily
      ? [0, 360, 720, 1080, 1440].map((minute) => ({ px: x({ minute }), tick: `${minute / 60}时` }))
      : values.flatMap((point, index) => point.tick ? [{ px: x(point, index), tick: point.tick }] : []);
    const plot = $("temperature-plot");
    plot.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="体温与腕温偏差叠加图">
      <text x="2" y="10" fill="${warm}" font-size="9">°C</text>
      <text x="316" y="10" fill="${cool}" text-anchor="end" font-size="9">Δ°C</text>
      ${wristValues.length && band.length ? `<rect x="${left}" y="${yWrist(band[1])}" width="${right - left}"
        height="${Math.max(1, yWrist(band[0]) - yWrist(band[1]))}" fill="${cool}" opacity=".12"/>` : ""}
      ${[0, .25, .5, .75, 1].map((fraction) => {
        const y = bottom - fraction * (bottom - top);
        return `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="var(--border)"
          ${fraction === .5 && wristValues.length ? 'stroke-dasharray="4 3"' : ""}/>
          <text x="2" y="${y + 3}" fill="${warm}" font-size="9">${fmtNum(bodyLow + (bodyHigh - bodyLow) * fraction, 1)}</text>
          <text x="316" y="${y + 3}" fill="${cool}" text-anchor="end" font-size="9">${signedTemperature(wristLimit * (fraction * 2 - 1))}</text>`;
      }).join("")}
      ${series("body", yBody, warm)}
      ${daily && !values.length ? dailyLine(data.daily_body, yBody, warm, "body") : ""}
      ${daily ? dailyLine(data.daily_wrist, yWrist, cool, "wrist") : series("wrist", yWrist, cool, true)}
      <line id="temperature-cursor" y1="${top}" y2="${bottom}" stroke="var(--text-2)" opacity=".58" visibility="hidden"/>
      ${ticks.map(({px, tick}) => `<text x="${px}" y="180" text-anchor="middle" font-size="9" fill="var(--text-2)">${escapeHtml(tick)}</text>`).join("")}
    </svg>`;

    const svg = plot.querySelector("svg");
    let lastIndex = -2;
    function select(index, haptic) {
      if (index === lastIndex) return;
      lastIndex = index;
      const point = values[index];
      bodyReadout.textContent = formatBody(point?.body ?? (daily && !values.length ? data.daily_body : null));
      wristReadout.textContent = formatWrist(daily ? data.daily_wrist : point?.wrist);
      label.textContent = [point?.label || data.anchor_date, daily && wristValues.length ? "腕温虚线为当晚偏差" : ""].filter(Boolean).join(" · ");
      const cursor = $("temperature-cursor");
      if (!point) return;
      cursor.setAttribute("x1", x(point, index));
      cursor.setAttribute("x2", x(point, index));
      cursor.setAttribute("visibility", "visible");
      if (haptic) triggerHapticTick(8);
    }
    function scrub(event) {
      const rect = svg.getBoundingClientRect();
      const local = (event.clientX - rect.left) * width / rect.width;
      const closest = values.reduce((best, point, index) =>
        Math.abs(x(point, index) - local) < (best < 0 ? Infinity : Math.abs(x(values[best], best) - local))
          ? index : best, -1);
      select(closest, true);
    }
    svg.onpointerdown = (event) => { svg.setPointerCapture(event.pointerId); scrub(event); };
    svg.onpointermove = (event) => { if (svg.hasPointerCapture(event.pointerId)) scrub(event); };
    select(values.findLastIndex((point) => Number.isFinite(point.body) || Number.isFinite(point.wrist)), false);
  }

  function ecgPreview(samples) {
    if (!samples?.length) return "";
    const peak = Math.max(.5, ...samples.map(Math.abs));
    const coordinates = samples.map((value, index) => `${index * 84 / Math.max(1, samples.length - 1)},${16 - value * 14 / peak}`);
    return `<svg class="ecg-preview" viewBox="0 0 84 32" aria-hidden="true">
      <polyline points="${coordinates.join(" ")}" fill="none" stroke="currentColor" stroke-width="1.2"/>
    </svg>`;
  }

  function renderEcgList(body, records) {
    const icon = `<span class="ecg-symbol">${appleCategoryIconSvg("ecg")}</span>`;
    const hasRecords = records.length > 0;
    body.innerHTML = `
      <header class="ecg-page-heading">
        ${icon}<div><h2 class="large-title">心电图</h2>
          ${hasRecords ? `<p class="card-note">${records.length} 条已同步记录</p>` : ""}</div>
      </header>`;
    if (!hasRecords) {
      body.insertAdjacentHTML("beforeend", `
        <section class="card ecg-empty">
          <h3 class="card-title">暂无心电图记录</h3>
          <p class="card-note">同步支持心电图的设备后，测量记录会显示在这里。</p>
          <button type="button" id="ecg-demo" class="liquid-pill pill-action-btn">查看示例波形</button>
        </section>`);
      $("ecg-demo").onclick = () => {
        const waveform = Array.from({ length: 15000 }, (_, index) => {
          const t = (index / 500) % .82;
          const wave = (center, width, height) => height * Math.exp(-((t - center) ** 2) / (2 * width ** 2));
          return wave(.12, .021, .12) + wave(.25, .012, -.14) + wave(.28, .013, 1.15) +
            wave(.32, .013, -.21) + wave(.52, .041, .31);
        });
        renderEcgRecord(body, { sample_rate_hz: 500, waveform_mv: waveform, classification: "示例波形",
          duration_s: 30, lead_count: 1, symptoms: [] }, true);
        window.scrollTo({ top: 0, behavior: "instant" });
      };
      return;
    }

    const months = new Map();
    records.forEach((row) => {
      const month = row.date.slice(0, 7);
      if (!months.has(month)) months.set(month, []);
      months.get(month).push(row);
    });
    for (const [month, rows] of months) {
      const [year, number] = month.split("-");
      body.insertAdjacentHTML("beforeend", `
        <section class="ecg-month-group" aria-label="${escapeHtml(month)}">
          <h3 class="ecg-section-label">${escapeHtml(year)} 年 ${Number(number)} 月</h3>
          <div class="card ecg-record-list">
            ${rows.map((row) => `
              <button type="button" class="ecg-list-row" data-ecg-id="${escapeHtml(row.start_ms)}">
                <span class="ecg-list-main"><strong>${escapeHtml(row.classification)}</strong>
                  <small>${escapeHtml(row.start_iso.slice(5, 16).replace("T", " "))}${row.avg_hr == null ? "" : ` · ${fmtNum(row.avg_hr, 0)} 次/分`}</small>
                </span>
                ${ecgPreview(row.preview_mv)}
                <span class="ecg-chevron" aria-hidden="true">›</span>
              </button>`).join("")}
          </div>
        </section>`);
    }
    body.querySelectorAll("[data-ecg-id]").forEach((button) => {
      button.onclick = () => openMetricDetail("ecg_record", { ecgId: button.dataset.ecgId, fromTab: detailState?.fromTab });
    });
  }

  const ECG_ALGO_DISCLAIMER = "基于单导联 R 波与 RR 间期特征的本地轻量算法分析，仅供参考，不构成医疗诊断。";

  function analyzeEcgWaveform(samples, sampleRateHz) {
    const res = (type, label, tone, summary, extra = {}) => ({
      type,
      label,
      tone,
      bpm: extra.bpm ?? null,
      beat_count: extra.beat_count ?? null,
      median_rr_ms: extra.median_rr_ms ?? null,
      cv_rr_pct: extra.cv_rr_pct ?? null,
      qrs_ms: extra.qrs_ms ?? null,
      premature_count: extra.premature_count ?? 0,
      summary,
      disclaimer: ECG_ALGO_DISCLAIMER,
    });
    const hz = Number(sampleRateHz);
    if (!Array.isArray(samples) || !samples.length || !Number.isFinite(hz) || hz < 100 || hz > 2000 || samples.length < Math.round(4 * hz)) {
      return res("signal_too_short", "采样过短 / 无法识别", "muted", "有效记录时长不足 4 秒，无法可靠识别节律。");
    }
    const quantile = (sorted, q) => {
      if (!sorted.length) return 0;
      if (sorted.length === 1) return sorted[0];
      const pos = Math.max(0, Math.min(1, q)) * (sorted.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(sorted.length - 1, lo + 1);
      return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    };
    const movingAvg = (arr, win) => {
      const len = arr.length;
      if (!len || win <= 1) return arr.slice();
      const half = win >> 1;
      const prefix = new Float64Array(len + 1);
      for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + arr[i];
      const out = new Float64Array(len);
      for (let i = 0; i < len; i++) {
        const lo = i < half ? 0 : i - half;
        const hi = i + half + 1 > len ? len : i + half + 1;
        out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
      }
      return out;
    };

    const n = samples.length;
    const clean = new Float64Array(n);
    let badCount = 0;
    for (let i = 0; i < n; i++) {
      const v = samples[i];
      if (typeof v === "number" && Number.isFinite(v)) {
        clean[i] = v;
        if (Math.abs(v) > 4.5) badCount += 1;
      } else {
        badCount += 1;
      }
    }
    if (badCount / n > 0.10) {
      return res("poor_signal", "信号质量不佳", "warn", "检测到较多超量程或无效采样点，建议贴合电极后重测。");
    }

    const baseWin = Math.max(3, Math.round(0.20 * hz) | 1);
    const baseline = movingAvg(clean, baseWin);
    const hp = new Float64Array(n);
    for (let i = 0; i < n; i++) hp[i] = clean[i] - baseline[i];

    const edge = Math.min(n >> 2, Math.max(1, Math.round(0.25 * hz)));
    const limitHi = n - edge;
    let maxIntAmp = 0;
    for (let i = edge; i < limitHi; i++) {
      const a = Math.abs(hp[i]);
      if (a > maxIntAmp) maxIntAmp = a;
    }
    if (maxIntAmp < 0.08) {
      return res("poor_signal", "信号质量不佳", "warn", "波形幅值过弱或接近直线，未检测到有效心电信号。");
    }

    const lpWin = Math.max(1, Math.round(0.015 * hz) | 1);
    const smooth = movingAvg(hp, lpWin);
    const magD = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      magD[i] = Math.abs(smooth[i] - smooth[i - 1]);
    }
    const intWin = Math.max(3, Math.round(0.10 * hz) | 1);
    const env = movingAvg(magD, intWin);

    const envInner = Array.from(env.subarray(edge, limitHi)).sort((a, b) => a - b);
    const medEnv = quantile(envInner, 0.50);
    const refEnv = quantile(envInner, 0.98);
    const thresh = Math.max(medEnv + 0.30 * (refEnv - medEnv), 0.28 * refEnv, 1e-5);

    const searchRad = Math.max(2, Math.round(0.08 * hz));
    const refrac = Math.max(10, Math.round(0.24 * hz));
    const rPeaks = [];
    for (let i = edge; i < limitHi; ) {
      if (env[i] < thresh) {
        i += 1;
        continue;
      }
      const segStart = i;
      let bestEnvIdx = i;
      let bestEnvVal = env[i];
      while (i < limitHi && env[i] >= thresh) {
        if (env[i] > bestEnvVal) {
          bestEnvVal = env[i];
          bestEnvIdx = i;
        }
        i += 1;
      }
      const winLo = Math.max(edge, Math.min(segStart, bestEnvIdx) - searchRad);
      const winHi = Math.min(limitHi - 1, Math.max(i - 1, bestEnvIdx) + searchRad);
      let rIdx = bestEnvIdx;
      let bestAmp = -1;
      for (let pos = winLo; pos <= winHi; pos++) {
        const a = Math.abs(hp[pos]);
        if (a > bestAmp) {
          bestAmp = a;
          rIdx = pos;
        }
      }
      if (!rPeaks.length || rIdx - rPeaks[rPeaks.length - 1] >= refrac) {
        rPeaks.push(rIdx);
      } else if (Math.abs(hp[rIdx]) > Math.abs(hp[rPeaks[rPeaks.length - 1]])) {
        rPeaks[rPeaks.length - 1] = rIdx;
      }
    }

    if (rPeaks.length < 4) {
      return res("inconclusive", "波形不明确 / 无法判定", "muted",
        `仅识别出 ${rPeaks.length} 个清晰 QRS 波峰，尚不足以判定节律类型。`,
        { beat_count: rPeaks.length });
    }

    const rawRr = [];
    const validRr = [];
    for (let k = 0; k < rPeaks.length - 1; k++) {
      const rr = (rPeaks[k + 1] - rPeaks[k]) * 1000 / hz;
      rawRr.push(rr);
      if (rr >= 240 && rr <= 2400) validRr.push(rr);
    }
    if (validRr.length < 3) {
      return res("inconclusive", "波形不明确 / 无法判定", "muted",
        "有效 RR 间期数量不足，无法稳定识别心律类型。",
        { beat_count: rPeaks.length });
    }

    const badRrRatio = (rawRr.length - validRr.length) / rawRr.length;
    const quietRad = Math.max(2, Math.round(0.12 * hz));
    let noiseSq = 0;
    let noiseN = 0;
    let peakPtr = 0;
    for (let pos = edge; pos < limitHi; pos++) {
      while (peakPtr < rPeaks.length && pos > rPeaks[peakPtr] + quietRad) peakPtr += 1;
      if (peakPtr < rPeaks.length && pos >= rPeaks[peakPtr] - quietRad && pos <= rPeaks[peakPtr] + quietRad) continue;
      noiseSq += hp[pos] * hp[pos];
      noiseN += 1;
    }
    const rAmps = rPeaks.map((p) => Math.abs(hp[p])).sort((a, b) => a - b);
    const medRAmp = quantile(rAmps, 0.50);
    const noiseRms = noiseN > 0 ? Math.sqrt(noiseSq / noiseN) : 0;
    if (badRrRatio > 0.30 || (noiseN >= hz && medRAmp > 0 && noiseRms > 0.45 * medRAmp)) {
      return res("poor_signal", "信号干扰较大 / 建议重测", "warn",
        "基线干扰或伪差较多，建议保持静止与干燥接触后重新采集。",
        { beat_count: rPeaks.length });
    }

    const sRr = validRr.slice().sort((a, b) => a - b);
    const medianRr = quantile(sRr, 0.50);
    const meanRr = validRr.reduce((acc, v) => acc + v, 0) / validRr.length;
    const stdRr = Math.sqrt(validRr.reduce((acc, v) => acc + (v - meanRr) ** 2, 0) / validRr.length);
    const cvRr = meanRr > 0 ? stdRr / meanRr : 0;
    const cvPct = Number((cvRr * 100).toFixed(1));
    const iqrRatio = medianRr > 0 ? (quantile(sRr, 0.75) - quantile(sRr, 0.25)) / medianRr : 0;
    const rangeRatio = medianRr > 0 ? (sRr[sRr.length - 1] - sRr[0]) / medianRr : 0;
    const diffs = [];
    for (let k = 0; k < validRr.length - 1; k++) diffs.push(Math.abs(validRr[k + 1] - validRr[k]));
    const rmssdRatio = diffs.length && medianRr > 0
      ? Math.sqrt(diffs.reduce((acc, d) => acc + d * d, 0) / diffs.length) / medianRr : 0;
    const irregularStepRatio = diffs.length && medianRr > 0
      ? diffs.filter((d) => d / medianRr > 0.15).length / diffs.length : 0;
    const bpm = medianRr > 0 ? Math.round(60000 / medianRr) : 0;
    const medianRrMs = Math.round(medianRr);

    const maxHalf = Math.max(3, Math.round(0.14 * hz));
    const beatQrs = rPeaks.map((p) => {
      const cutoff = 0.20 * Math.abs(hp[p]);
      let lo = p;
      while (lo > edge && p - lo < maxHalf && Math.abs(hp[lo - 1]) >= cutoff) lo -= 1;
      let hi = p;
      while (hi < limitHi - 1 && hi - p < maxHalf && Math.abs(hp[hi + 1]) >= cutoff) hi += 1;
      return Math.max(40, Math.min(220, (hi - lo) * 1000 / hz));
    });
    const medianQrs = Math.round(quantile(beatQrs.slice().sort((a, b) => a - b), 0.50));

    const tmplRad = Math.max(3, Math.round(0.06 * hz));
    const vecLen = tmplRad * 2 + 1;
    const beatVecs = rPeaks.map((p) => (p - tmplRad >= 0 && p + tmplRad < n ? hp.subarray(p - tmplRad, p + tmplRad + 1) : null));
    const validVecs = beatVecs.filter(Boolean);
    let tmpl = null;
    let tmplNorm = 0;
    if (validVecs.length) {
      tmpl = new Float64Array(vecLen);
      for (let k = 0; k < vecLen; k++) {
        tmpl[k] = quantile(validVecs.map((v) => v[k]).sort((a, b) => a - b), 0.50);
      }
      for (let k = 0; k < vecLen; k++) tmplNorm += tmpl[k] * tmpl[k];
      tmplNorm = Math.sqrt(tmplNorm);
    }
    const beatCorr = beatVecs.map((vec) => {
      if (!vec || !tmpl || tmplNorm <= 1e-9) return 1;
      let vecNorm = 0;
      let dot = 0;
      for (let k = 0; k < vecLen; k++) {
        vecNorm += vec[k] * vec[k];
        dot += vec[k] * tmpl[k];
      }
      vecNorm = Math.sqrt(vecNorm);
      return vecNorm <= 1e-9 ? 0 : dot / (vecNorm * tmplNorm);
    });

    let prematureCount = 0;
    let widePrematureCount = 0;
    const regularBaseline = iqrRatio < 0.14 && irregularStepRatio < 0.45;
    if (regularBaseline && medianRr > 0) {
      for (let idxRr = 0; idxRr < rawRr.length; idxRr++) {
        const rr = rawRr[idxRr];
        if (rr < 240 || rr > 2400) continue;
        if (rr < 0.80 * medianRr) {
          const nextRr = rawRr[idxRr + 1];
          const hasPause = idxRr + 1 < rawRr.length && nextRr >= 240 && nextRr <= 2400 && nextRr > 1.12 * medianRr;
          const bIdx = idxRr + 1;
          const beatAberrant = beatCorr[bIdx] < 0.72 || beatQrs[bIdx] >= 120 || beatQrs[bIdx] > 1.35 * medianQrs;
          if (hasPause || beatAberrant) {
            prematureCount += 1;
            if (beatAberrant) widePrematureCount += 1;
          }
        }
      }
    }

    const common = {
      bpm,
      beat_count: rPeaks.length,
      median_rr_ms: medianRrMs,
      cv_rr_pct: cvPct,
      qrs_ms: medianQrs,
      premature_count: prematureCount,
    };

    if (irregularStepRatio >= 0.45 && (cvRr >= 0.14 || rmssdRatio >= 0.18) && iqrRatio >= 0.12) {
      return res("afib_suspected", "疑似心房颤动（房颤）", "alert",
        `RR 间期呈现明显绝对不规整（节律变异 ${cvPct.toFixed(1)}%，相邻突变占比 ${Math.round(irregularStepRatio * 100)}%），提示房颤节律特征。`,
        common);
    }
    if (regularBaseline && prematureCount >= 1) {
      const isPvc = widePrematureCount >= 1;
      const desc = isPvc ? "伴畸形宽大 QRS 形态及代偿间歇" : "伴提前心搏及代偿间歇，QRS 形态与主导搏一致";
      return res("premature_beat", isPvc ? "疑似室性早搏（早搏）" : "疑似房性早搏（早搏）", "warn",
        `在规整基线心率（${bpm} 次/分）下检测到 ${prematureCount} 次提前搏动（${desc}）。`,
        common);
    }
    if (bpm >= 50 && bpm <= 100 && prematureCount === 0 && irregularStepRatio < 0.45 && (cvRr >= 0.10 || rangeRatio >= 0.22)) {
      return res("sinus_arrhythmia", "窦性心律不齐", "info",
        `心率 ${bpm} 次/分处于正常区间，RR 间期呈渐进周期性波动（变异度 ${cvPct.toFixed(1)}%），符合窦性心律不齐特征。`,
        common);
    }
    if (bpm < 50) {
      return res("sinus_bradycardia", "窦性心动过缓", bpm < 45 ? "warn" : "info",
        `识别平均心率约 ${bpm} 次/分（平均 RR ${medianRrMs} ms），节律规整，低于 50 次/分。`,
        common);
    }
    if (bpm > 100) {
      return res("sinus_tachycardia", "窦性心动过速", "warn",
        `识别平均心率约 ${bpm} 次/分（平均 RR ${medianRrMs} ms），节律规整，高于 100 次/分。`,
        common);
    }
    return res("sinus_rhythm", "窦性心律", "good",
      `心率 ${bpm} 次/分，RR 间期规整（变异度 ${cvPct.toFixed(1)}%），符合窦性心律特征。`,
      common);
  }

  function renderEcgRecord(body, record, example = false) {
    const samples = record.waveform_mv || [];
    const hz = Number(record.sample_rate_hz);
    const hasWave = samples.length > 0 && Number.isFinite(hz) && hz > 0;
    const analysis = hasWave ? (record.analysis || analyzeEcgWaveform(samples, hz)) : null;
    const dateLabel = (record.start_iso || "").slice(0, 16).replace("T", " ");
    const duration = record.duration_s ?? (hasWave ? samples.length / hz : null);
    const leadLabel = record.lead_count > 1 ? `${fmtNum(record.lead_count, 0)} 导联` : "I 导联";
    body.innerHTML = `
      ${example ? `<div class="ecg-example-bar">
        <span>示例 · 模拟数据</span>
        <button type="button" id="ecg-demo-back" class="text-link-btn">返回记录</button>
      </div>` : ""}
      <section class="card ecg-wave-card" aria-labelledby="ecg-wave-title">
        <div class="ecg-wave-head">
          <div><h2 class="card-title" id="ecg-wave-title">心电图波形</h2>
            <p class="card-note">${escapeHtml(dateLabel || (duration == null ? "" : `${fmtNum(duration, 0)} 秒记录`))}</p>
          </div>
          ${hasWave ? `<div class="ecg-zoom" role="group" aria-label="波形缩放">
            <button type="button" id="ecg-zoom-out" aria-label="缩小">−</button>
            <button type="button" id="ecg-zoom-in" aria-label="放大">+</button>
          </div>` : ""}
        </div>
        ${hasWave ? `
          <div class="ecg-grid-scroll" id="ecg-scroll" tabindex="0" aria-label="${escapeHtml(leadLabel)}波形">
            <div class="ecg-grid-track" id="ecg-track"><span id="ecg-cursor" hidden></span></div>
          </div>
          <div class="ecg-wave-footer"><span>${escapeHtml(leadLabel)} · 25 mm/s · 10 mm/mV</span>
            <output id="ecg-readout">0.00 s</output>
          </div>`
          : '<p class="card-note">这条记录没有可显示的波形。</p>'}
      </section>
      <section class="card ecg-result-card" aria-labelledby="ecg-result-title">
        <div class="ecg-result-heading">
          <span class="ecg-symbol">${appleCategoryIconSvg("ecg")}</span>
          <div><p class="ecg-section-label">${example ? "示例结果" : "记录结果"}</p>
            <h2 class="card-title" id="ecg-result-title">${escapeHtml(record.classification || "未提供分类")}</h2>
          </div>
          ${record.avg_hr == null ? "" : `<div class="ecg-result-rate"><strong>${fmtNum(record.avg_hr, 0)}</strong>
            <small>平均 · 次/分</small></div>`}
        </div>
        ${hasWave && !example ? '<button type="button" id="ecg-export-report" class="ecg-export-report">导出心电图报告 <span aria-hidden="true">›</span></button>' : ""}
      </section>
      ${analysis ? `<section class="card ecg-algo-card" aria-labelledby="ecg-algo-title">
        <div class="ecg-algo-head">
          <div class="ecg-algo-title-group">
            <div class="ecg-algo-kicker-row">
              <span class="ecg-algo-badge">波形算法识别</span>
              <span class="ecg-algo-dot tone-${escapeHtml(analysis.tone || "muted")}" aria-hidden="true"></span>
            </div>
            <h2 class="card-title ecg-algo-title" id="ecg-algo-title">${escapeHtml(analysis.label)}</h2>
          </div>
          ${analysis.bpm == null ? "" : `<div class="ecg-result-rate"><strong>${fmtNum(analysis.bpm, 0)}</strong>
            <small>识别 · 次/分</small></div>`}
        </div>
        ${analysis.beat_count != null ? `<div class="ecg-algo-grid">
          <div class="ecg-algo-stat"><span>检测心拍</span><strong>${fmtNum(analysis.beat_count, 0)} 次</strong></div>
          <div class="ecg-algo-stat"><span>平均 RR</span><strong>${analysis.median_rr_ms == null ? "—" : `${fmtNum(analysis.median_rr_ms, 0)} ms`}</strong></div>
          <div class="ecg-algo-stat"><span>节律变异</span><strong>${analysis.cv_rr_pct == null ? "—" : `${fmtNum(analysis.cv_rr_pct, 1)}%`}</strong></div>
          <div class="ecg-algo-stat"><span>${analysis.premature_count > 0 ? "早搏检出" : "QRS 宽度"}</span><strong>${analysis.premature_count > 0 ? `${fmtNum(analysis.premature_count, 0)} 次` : (analysis.qrs_ms == null ? "—" : `${fmtNum(analysis.qrs_ms, 0)} ms`)}</strong></div>
        </div>` : ""}
        <p class="ecg-algo-summary">${escapeHtml(analysis.summary || "")}</p>
        <p class="ecg-algo-disclaimer">${escapeHtml(analysis.disclaimer || "")}</p>
      </section>` : ""}
      ${example ? "" : `<section class="card ecg-details-card"><h2 class="card-title">记录详情</h2>
        <div class="kv-row"><span class="kv-k">记录时间</span><span class="kv-v">${escapeHtml(dateLabel || "—")}</span></div>
        <div class="kv-row"><span class="kv-k">时长</span><span class="kv-v">${duration == null ? "—" : `${fmtNum(duration, 0)} 秒`}</span></div>
        <div class="kv-row"><span class="kv-k">来源设备</span><span class="kv-v">${escapeHtml(record.device_name || "未知")}</span></div>
        <div class="kv-row"><span class="kv-k">症状</span><span class="kv-v">${escapeHtml((record.symptoms || []).join("、") || "无记录")}</span></div>
      </section>`}`;
    if (example) $("ecg-demo-back").onclick = () => renderEcgList(body, []);
    if (!hasWave) return;

    const scroll = $("ecg-scroll");
    const track = $("ecg-track");
    const readout = $("ecg-readout");
    let zoom = 1;
    let cursor = null;
    let programmaticScroll = false;
    let lastDragAt = -Infinity;
    let lastTouchTapAt = -Infinity;
    const totalDuration = samples.length / hz;
    const pixelsPerSecond = () => 25 * (96 / 25.4) * zoom;
    const marker = $("ecg-cursor");
    const tiles = new Map();
    const tileWidth = 512;
    let totalWidth = 0;
    function updateViewportReadout() {
      if (!readout) return;
      const pps = pixelsPerSecond();
      const startSec = Math.max(0, Math.min(totalDuration, scroll.scrollLeft / pps));
      const viewW = scroll.clientWidth;
      if (viewW > 0) {
        const endSec = Math.max(startSec, Math.min(totalDuration, (scroll.scrollLeft + viewW) / pps));
        readout.textContent = `${startSec.toFixed(2)} – ${endSec.toFixed(2)} s`;
      } else {
        readout.textContent = `${startSec.toFixed(2)} s`;
      }
    }
    function hideCursor() {
      if (cursor === null && marker.hidden) return;
      cursor = null;
      marker.hidden = true;
      updateViewportReadout();
    }
    function moveCursor() {
      if (cursor === null) {
        marker.hidden = true;
        return;
      }
      marker.hidden = false;
      marker.style.transform = `translateX(${cursor / hz * pixelsPerSecond()}px)`;
    }
    function fillTiles() {
      // Each tile stays in waveform coordinates. While scrolling, the WebView
      // moves existing pixels and we only paint tiles entering the buffer.
      const viewportWidth = scroll.clientWidth || 320;
      const visibleStart = Math.floor(scroll.scrollLeft / tileWidth);
      const visibleEnd = Math.floor((scroll.scrollLeft + viewportWidth) / tileWidth);
      const first = Math.max(0, visibleStart - 2);
      const last = Math.min(Math.ceil(totalWidth / tileWidth) - 1, visibleEnd + 2);
      for (let index = first; index <= last; index++) {
        if (tiles.has(index)) continue;
        const start = index * tileWidth;
        const tile = document.createElement("canvas");
        tile.setAttribute("aria-hidden", "true");
        tile.style.left = `${start}px`;
        drawEcgWaveform(tile, samples, hz, zoom, false, {
          start,
          width: Math.min(tileWidth, totalWidth - start),
        });
        track.insertBefore(tile, marker);
        tiles.set(index, tile);
      }
      for (const [index, tile] of tiles) {
        if (index >= first && index <= last) continue;
        tiles.delete(index);
        tile.remove();
      }
    }

    function drawTrack(centerSeconds = null) {
      totalWidth = Math.ceil(samples.length / hz * pixelsPerSecond());
      track.style.width = `${totalWidth}px`;
      track.style.height = `${Math.round(50 * 96 / 25.4 * zoom) + 23}px`;
      if (centerSeconds !== null) {
        const maxLeft = Math.max(0, totalWidth - scroll.clientWidth);
        const nextLeft = Math.max(0, Math.min(maxLeft, centerSeconds * pixelsPerSecond() - scroll.clientWidth / 2));
        programmaticScroll = true;
        scroll.scrollLeft = nextLeft;
        requestAnimationFrame(() => { programmaticScroll = false; });
      }
      for (const tile of tiles.values()) tile.remove();
      tiles.clear();
      fillTiles();
      moveCursor();
      if (cursor === null) updateViewportReadout();
    }
    drawTrack();

    function changeZoom(next) {
      const nextZoom = Math.max(.75, Math.min(2.5, next));
      if (nextZoom === zoom) return;
      const middle = (scroll.scrollLeft + scroll.clientWidth / 2) / pixelsPerSecond();
      zoom = nextZoom;
      drawTrack(middle);
    }
    $("ecg-zoom-in").onclick = () => changeZoom(zoom * 1.25);
    $("ecg-zoom-out").onclick = () => changeZoom(zoom / 1.25);
    function read(event, haptic = false) {
      const rect = scroll.getBoundingClientRect();
      const x = event.clientX - rect.left - scroll.clientLeft + scroll.scrollLeft;
      const index = Math.min(samples.length - 1, Math.max(0, Math.round(x / pixelsPerSecond() * hz)));
      if (readout) readout.textContent = `${(index / hz).toFixed(2)} s · ${samples[index].toFixed(3)} mV`;
      const changed = cursor !== index || marker.hidden;
      cursor = index;
      moveCursor();
      if (haptic && changed) triggerHapticTick(6);
    }
    let redrawFrame = 0;
    scroll.addEventListener("scroll", () => {
      if (!programmaticScroll) {
        lastDragAt = performance.now();
        hideCursor();
      }
      if (redrawFrame) return;
      redrawFrame = requestAnimationFrame(() => {
        redrawFrame = 0;
        if (!track.isConnected) return;
        fillTiles();
        if (cursor === null) updateViewportReadout();
      });
    }, { passive: true });
    track.onclick = (event) => {
      const now = performance.now();
      if (now - lastTouchTapAt < 450 || now - lastDragAt < 350) return;
      read(event, true);
    };
    const pinchDistance = (touches) => Math.hypot(
      touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
    let pinch = null;
    let tap = null;
    scroll.addEventListener("touchstart", (event) => {
      if (event.touches.length === 2) {
        tap = null;
        pinch = { distance: pinchDistance(event.touches), zoom };
        lastDragAt = performance.now();
        hideCursor();
        return;
      }
      if (event.touches.length === 1) {
        const pt = event.changedTouches[0] || event.touches[0];
        if (pt) {
          tap = { id: pt.identifier, x: pt.clientX, y: pt.clientY, scrollLeft: scroll.scrollLeft, moved: false };
        }
      }
    }, { passive: true });
    scroll.addEventListener("touchmove", (event) => {
      if (pinch && event.touches.length === 2 && pinch.distance > 0) {
        lastDragAt = performance.now();
        hideCursor();
        const zoomTo = pinch.zoom * pinchDistance(event.touches) / pinch.distance;
        if (Math.abs(zoom - zoomTo) >= .035) changeZoom(zoomTo);
        return;
      }
      if (tap) {
        for (const pt of event.changedTouches) {
          if (pt.identifier !== tap.id) continue;
          if (Math.hypot(pt.clientX - tap.x, pt.clientY - tap.y) > 8 || Math.abs(scroll.scrollLeft - tap.scrollLeft) > 2) {
            tap.moved = true;
            lastDragAt = performance.now();
            hideCursor();
          }
          break;
        }
      }
    }, { passive: true });
    scroll.addEventListener("touchend", (event) => {
      if (event.touches.length < 2) pinch = null;
      if (tap) {
        for (const pt of event.changedTouches) {
          if (pt.identifier !== tap.id) continue;
          const curTap = tap;
          tap = null;
          if (!curTap.moved && Math.abs(scroll.scrollLeft - curTap.scrollLeft) <= 2) {
            lastTouchTapAt = performance.now();
            read(pt, true);
          } else if (curTap.moved) {
            lastDragAt = performance.now();
          }
          break;
        }
      }
    }, { passive: true });
    scroll.addEventListener("touchcancel", () => {
      pinch = null;
      tap = null;
    }, { passive: true });
    const exportButton = $("ecg-export-report");
    if (exportButton) exportButton.onclick = () => openGlassSelectSheet({
      title: "导出心电图报告",
      options: [
        { value: "PDF", label: "PDF", meta: "适合阅读与打印的波形报告" },
        { value: "PNG", label: "PNG", meta: "完整波形图片" },
        { value: "CSV", label: "CSV", meta: "时间与电压采样值" },
      ],
      onSelect: (format) => {
        const exportCanvas = document.createElement("canvas");
        if (format !== "CSV") drawEcgWaveform(exportCanvas, samples, hz, 1, true);
        window.__panelNative?.exportEcg?.(String(record.start_ms), format,
          format === "CSV" ? "" : exportCanvas.toDataURL("image/png").split(",")[1]);
      },
    });
  }

  function drawEcgWaveform(canvas, samples, hz, zoom, forExport = false, viewport = null) {
    const mm = 96 / 25.4 * zoom;
    const sec = mm * 25;
    const width = viewport?.width || Math.ceil(samples.length / hz * sec);
    const start = viewport?.start || 0;
    const height = Math.round(mm * 50);
    const dpr = Math.min(devicePixelRatio || 1, 2, 6144 / width);
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const axisHeight = forExport ? 0 : 23;
    const pixelHeight = Math.max(1, Math.round((height + axisHeight) * dpr));
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height + axisHeight}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const dark = !forExport && getTheme() === "dark";
    ctx.fillStyle = forExport ? "#fff8fa" : dark ? "#171a23" : "#fffafb";
    ctx.fillRect(0, 0, width, height + axisHeight);
    for (const major of [false, true]) {
      const gap = mm * (major ? 5 : 1);
      ctx.strokeStyle = major ? (dark ? "#4b3440" : "#e8c5d0") : (dark ? "#292632" : "#f6e2e8");
      ctx.lineWidth = major ? 1 : .6;
      ctx.beginPath();
      for (let x = -(start % gap); x < width; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, height); }
      for (let y = 0; y < height; y += gap) { ctx.moveTo(0, y); ctx.lineTo(width, y); }
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    ctx.clip();
    ctx.strokeStyle = forExport ? "#592131" : dark ? "#ff6c8e" : "#d62654";
    ctx.lineWidth = 1.55;
    ctx.beginPath();
    const first = Math.max(0, Math.floor(start / sec * hz));
    const last = Math.min(samples.length - 1, Math.ceil((start + width) / sec * hz));
    for (let index = first; index <= last; index++) {
      const x = index / hz * sec - start;
      const y = height / 2 - samples[index] * mm * 10;
      if (index === first) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
    if (axisHeight) {
      ctx.fillStyle = dark ? "#aaa4b5" : "#726473";
      ctx.font = "11px system-ui";
      ctx.textBaseline = "middle";
      for (let index = Math.max(0, Math.floor(start / sec)); index * sec < start + width; index++) {
        const x = index * sec - start;
        ctx.fillRect(x, height, 1, 4);
        ctx.fillText(`${index} s`, x + 3, height + 13);
      }
    }
  }

  function queueContextualMetricPreloads(data, navDir) {
    if (!data?.metric || navDir === "resize" || !detailState) return;
    if (data.metric === "ecg") {
      queueEcgRecordPreloads(data.records || [], 4, true);
      return;
    }
    if (data.metric === "ecg_record") return;
    const anchorOrEmpty = data.anchor_date || detailState.endDate || "";
    if (data.prev_end) {
      queueMetricPreload(data.metric, data.scope, { endDate: data.prev_end });
    }
    const adjScopes = data.scope === "D" ? ["W"] : data.scope === "W" ? ["D", "M"] : data.scope === "M" ? ["W", "6M"] : [];
    adjScopes.forEach((sc) => queueMetricPreload(data.metric, sc, { endDate: anchorOrEmpty }));
    if (data.metric === "heart_rate" && data.latest_ecg?.start_ms != null) {
      queueMetricPreload("ecg", "W", { endDate: "" });
    }
  }

  function renderMetricDetailScreen(data, navDir = "initial") {
    const body = $("metric-detail-body");
    body.classList.toggle("no-anim-replay", navDir === "resize");
    queueContextualMetricPreloads(data, navDir);
    if (data?.metric === "ecg" || data?.metric === "ecg_record") {
      body.dataset.mountedMetric = data.metric;
      if (data.metric === "ecg_record") renderEcgRecord(body, data);
      else renderEcgList(body, data.records || []);
      return;
    }
    if (data?.metric === "temperature") {
      body.dataset.mountedMetric = data.metric;
      renderTemperatureDetail(body, data);
      return;
    }
    if (!data || data.empty) {
      body.removeAttribute("data-mounted-metric");
      body.innerHTML = '<div class="card"><div class="card-note">暂无可用健康数据。</div></div>';
      if (data?.metric === "heart_rate") {
        const button = document.createElement("button");
        button.className = "liquid-pill pill-action-btn";
        button.textContent = "查看心电图记录";
        button.onclick = () => openMetricDetail("ecg", { fromTab: detailState?.fromTab });
        body.firstElementChild.append(button);
      }
      return;
    }

    if (data.metric === "activity") {
      renderActivityDetailView(body, data, navDir);
      return;
    }

    const meta = METRIC_META[data.metric] || METRIC_META.heart_rate;
    const p = getThemePalette();
    const isSleep = data.metric === "sleep";
    const isHrMetric = data.metric === "heart_rate";
    const recentEcg = data.latest_ecg;
    const ecgEntry = isHrMetric ? `<div class="card">
      <button type="button" id="heart-detail-ecg" class="grouped-row ecg-link">
        <span><strong>心电图</strong><small>${recentEcg
          ? escapeHtml(`${recentEcg.classification} · ${recentEcg.date}${recentEcg.avg_hr == null ? "" : ` · ${fmtNum(recentEcg.avg_hr, 0)} 次/分`}`)
          : "暂无心电图记录"}</small></span>
        <span class="ecg-row-meta">${ecgPreview(recentEcg?.preview_mv)}<span class="grouped-val">查看记录 ›</span></span>
      </button>
    </div>` : "";
    const isTrainingIdx = data.metric === "training_index";
    const curScopeIdx = Math.max(0, SCOPE_LABELS.findIndex((s) => s.id === data.scope));
    const curSleepModeIdx = detailState?.sleepMode === "summary" ? 1 : 0;
    const curHrModeIdx = detailState?.hrMode === "line" ? 1 : 0;

    const statusBadge = data.baseline?.status
      ? `<span class="status-pill" style="color:${p.green}">${escapeHtml(data.baseline.status)}</span>`
      : data.classification?.label
        ? `<span class="status-pill" style="color:${escapeHtml(data.classification.color || p.green)}">${escapeHtml(data.classification.label)}</span>`
        : data.hero?.score != null
          ? `<span class="status-pill" style="color:${p.indigo}">睡眠评分 ${fmtNum(data.hero.score, 0)}</span>`
          : "";

    const fallbackNote =
      data.scope === "D" && data.hourly_available === false && data.metric !== "sleep"
        ? '<span class="status-pill">该日仅存汇总值（无分时采样）</span>'
        : "";

    const prevPrimaryText = detailState?.prevPrimaryText;
    const nextPrimaryText = data.hero?.primary || "-";
    if (detailState) detailState.prevPrimaryText = nextPrimaryText;

    const isMounted = body.dataset.mountedMetric === data.metric && Boolean($("detail-chart-card")) && Boolean($("scope-seg-thumb"));
    const lowerAnimCls = isMounted ? (navDir === "resize" ? "" : "chart-crossfade") : "stagger-card";
    let cardSeq = 1;

    const napsList = (isSleep && data.scope === "D" && data.sleep_detail?.naps) ? data.sleep_detail.naps : [];
    const napsHtml = napsList.length
      ? `
        <div class="nap-card ${lowerAnimCls}" style="--card-idx:${cardSeq++}">
          <div class="nap-head">
            <span class="nap-badge">
              <span class="dot-badge" style="background:var(--apple-purple)"></span>
              零星小睡
            </span>
            <span class="card-note">${napsList.length} 次</span>
          </div>
          ${napsList
            .map(
              (n) => `
            <div class="nap-row">
              <div>
                <div style="font-weight:700;font-size:14px;">${escapeHtml(n.label || "零星小睡")}</div>
                <div class="nap-time">${n.start_iso ? `${escapeHtml(n.start_iso.slice(11, 16))} – ${escapeHtml((n.end_iso || "").slice(11, 16))}` : "日间小睡汇总"}</div>
              </div>
              <div class="nap-dur">${fmtNum(n.duration_min, 0)} 分钟</div>
            </div>
          `
            )
            .join("")}
        </div>
      `
      : "";

    const emotionHtml =
      data.metric === "stress" && data.emotion && data.emotion.total > 0
        ? renderEmotionBreakdownCard(data.emotion, p, cardSeq++, lowerAnimCls)
        : "";

    const racePredHtml =
      data.metric === "running_index" && (data.race_predictions || []).length > 0
        ? `
          <div class="card ${lowerAnimCls}" style="--card-idx:${cardSeq++}">
            <div class="card-header" style="margin-bottom:10px;">
              <div>
                <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-green)"></span>完赛成绩预测</h3>
                <p class="card-note">基于当前跑步能力指数推算</p>
              </div>
            </div>
            <div class="race-pred-grid">
              ${data.race_predictions
                .map(
                  (rp) => `
                <div class="race-pred-tile">
                  <div class="race-pred-dist">${escapeHtml(rp.distance)}</div>
                  <div class="race-pred-time">${escapeHtml(rp.time)}</div>
                  <div class="race-pred-pace">均速 ${escapeHtml(rp.pace)}</div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
        : "";

    const highlightsHtml = (data.highlights || []).length
      ? `
        <div class="highlights-section-title">亮点</div>
        ${data.highlights
          .map(
            (h) => `
          <div class="highlight-card ${lowerAnimCls}" style="--card-idx:${cardSeq++}">
            <div class="highlight-top">
              <span class="highlight-badge" style="color:${meta.colorVar}">
                <span class="dot-badge" style="background:${meta.colorVar}"></span>
                ${escapeHtml(h.title)}
              </span>
              <span class="card-note">${escapeHtml(h.badge || "")}</span>
            </div>
            <p class="highlight-insight">${escapeHtml(h.insight)}</p>
            <div class="hl-bars">
              ${(h.bars || [])
                .map(
                  (b) => `
                <div class="hl-bar-row">
                  <div class="hl-bar-head">
                    <span class="hl-lbl">${escapeHtml(b.label)}</span>
                    <span class="hl-val">${escapeHtml(b.display)}</span>
                  </div>
                  <div class="hl-track">
                    <div class="hl-fill ${b.color === "muted" ? "muted-fill" : ""}" style="width:${b.pct}%;${b.color === "muted" ? "" : `background:${meta.colorVar}`}"></div>
                  </div>
                </div>
              `
                )
                .join("")}
            </div>
          </div>
        `
          )
          .join("")}
      `
      : "";

    const subMetricsHtml = (data.sub_metrics || []).length
      ? `
        <div class="card ${lowerAnimCls}" style="--card-idx:${cardSeq++}">
          <div class="card-header" style="margin-bottom:6px;"><h3 class="card-title">相关生理细节</h3></div>
          <div class="kv-list">
            ${data.sub_metrics.map((m) => `<div class="kv-row"><span class="kv-k">${escapeHtml(m.label)}</span><span class="kv-v">${escapeHtml(m.value)}</span></div>`).join("")}
          </div>
        </div>
      `
      : "";

    const records = data.records || [];
    const sourceByMetric={sleep:"睡眠会话与分期 · 跨午夜按会话归属，小睡单列",hrv:"设备报告的 HRV · 分时记录为 RMSSD（毫秒）",steps:"小时步数合计 · 同小时合并",heart_rate:"心率点采样或时段汇总 · 次/分",spo2:"血氧点采样或时段汇总 · %"};
    const recordsHtml = `<details class="card source-note"><summary>数据来源与统计口径</summary><p>华为运动健康 · ${escapeHtml(sourceByMetric[data.metric] || data.title+" · 设备记录与周期汇总")}</p><p>${escapeHtml(data.range_label)} · 同一指标同一时间戳更新覆盖。同步记录未附单条设备编号。</p>${data.source_points?.length?`<details id="metric-source-records"><summary>查看 ${data.source_points.length} 条同步记录</summary><div class="source-scroll"></div></details>`:""}</details>
      <div class="${lowerAnimCls}" style="--card-idx:${cardSeq++}">
        <button id="toggle-all-data-btn" class="all-data-btn" type="button">
          <span>查看本期记录</span>
          <span class="card-note">${records.length} 条记录 <span class="chev-rot">▾</span></span>
        </button>
        <div id="all-data-drawer" class="accordion-drawer">
          <div class="accordion-inner">
            <div class="card all-data-list" style="margin-top:0;">
              <div class="kv-list"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    if (!isMounted) {
      const scopeHtml = `
        <div id="detail-scope-bar" class="scope-seg has-thumb" role="tablist" aria-label="时间颗粒度">
          <div id="scope-seg-thumb" class="seg-thumb" style="--seg-count:5;--seg-idx:${curScopeIdx}"></div>
          ${SCOPE_LABELS.map((s) => `<button class="scope-btn ${data.scope === s.id ? "active" : ""}" data-scope="${s.id}" type="button">${s.label}</button>`).join("")}
        </div>
      `;

      const chartModeToggleHtml = isSleep
        ? `
          <div id="sleep-mode-seg" class="sleep-mode-seg has-thumb">
            <div id="sleep-mode-thumb" class="seg-thumb" style="--seg-count:2;--seg-idx:${curSleepModeIdx}"></div>
            <button class="seg-btn ${detailState?.sleepMode !== "summary" ? "active" : ""}" data-smode="stages" type="button">${data.scope === "D" ? "阶段分布" : "作息时间"}</button>
            <button class="seg-btn ${detailState?.sleepMode === "summary" ? "active" : ""}" data-smode="summary" type="button">${data.scope === "D" ? "各阶段时长占比" : "时长构成"}</button>
          </div>
        `
        : isHrMetric
          ? `
            <div id="hr-mode-seg" class="sleep-mode-seg has-thumb">
              <div id="hr-mode-thumb" class="seg-thumb" style="--seg-count:2;--seg-idx:${curHrModeIdx}"></div>
              <button class="seg-btn ${detailState?.hrMode !== "line" ? "active" : ""}" data-hrmode="range" type="button">范围胶囊</button>
              <button class="seg-btn ${detailState?.hrMode === "line" ? "active" : ""}" data-hrmode="line" type="button">折线视图</button>
            </div>
          `
          : "";

      const showBreakdown = isSleep && data.scope === "D" && detailState?.sleepMode !== "summary";
      const chartCardHtml = `
        <div id="detail-chart-card" class="apple-chart-card stagger-card" style="--card-idx:0">
          <div id="md-period-stepper" class="period-stepper">
            <button id="md-prev-btn" class="stepper-arrow" type="button" aria-label="上一周期" ${data.prev_end ? "" : "disabled"}>‹</button>
            <div id="md-stepper-label" class="stepper-label">${escapeHtml(data.range_label || "")}</div>
            <button id="md-next-btn" class="stepper-arrow" type="button" aria-label="下一周期" ${data.next_end ? "" : "disabled"}>›</button>
          </div>
          <div id="md-scrub-hero" class="scrub-hero">
            <div class="scrub-kicker-row">
              <span id="scrub-kicker" class="scrub-kicker">${escapeHtml(data.hero?.kicker || "")}</span>
              ${isTrainingIdx ? infoIconBtnHtml("training_index", "查看训练指数说明") : ""}
            </div>
            <div class="scrub-main-row">
              <span id="scrub-value" class="scrub-value" style="color:${meta.colorVar}">${escapeHtml(nextPrimaryText)}</span>
              <span id="scrub-unit" class="scrub-unit">${escapeHtml(data.hero?.unit || "")}</span>
            </div>
            <div class="scrub-sub-row">
              <span id="scrub-sub">${escapeHtml(getDefaultHeroSub(data))}</span>
              <span id="scrub-badges">${statusBadge}${fallbackNote}</span>
            </div>
          </div>
          <div id="apple-svg-wrap" class="svg-chart-wrap"></div>
          <div id="md-sleep-mode-slot">${chartModeToggleHtml}</div>
          <div id="md-sleep-breakdown-slot">${showBreakdown ? renderSleepStageBreakdownHtml(data.sleep_detail, p) : ""}</div>
        </div>
      `;

      body.innerHTML = `${scopeHtml}${chartCardHtml}<div id="detail-lower-stack" class="detail-body">${ecgEntry}${napsHtml}${emotionHtml}${racePredHtml}${highlightsHtml}${subMetricsHtml}${recordsHtml}</div>`;
      body.dataset.mountedMetric = data.metric;

      body.querySelectorAll("#detail-scope-bar .scope-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (!detailState || detailState.scope === b.dataset.scope) return;
          const nextIdx = Math.max(0, SCOPE_LABELS.findIndex((s) => s.id === b.dataset.scope));
          const sThumb = $("scope-seg-thumb");
          if (sThumb) sThumb.style.setProperty("--seg-idx", String(nextIdx));
          body.querySelectorAll("#detail-scope-bar .scope-btn").forEach((x) => x.classList.toggle("active", x === b));
          detailState.scope = b.dataset.scope;
          detailState.pendingDir = "crossfade";
          fetchAndRenderMetricDetail();
        });
      });

      const prevB = $("md-prev-btn");
      const nextB = $("md-next-btn");
      if (prevB) {
        prevB.addEventListener("click", () => {
          const cur = detailDataCache;
          if (cur?.prev_end && detailState) {
            detailState.endDate = cur.prev_end;
            detailState.pendingDir = "prev";
            fetchAndRenderMetricDetail();
          }
        });
      }
      if (nextB) {
        nextB.addEventListener("click", () => {
          const cur = detailDataCache;
          if (cur?.next_end && detailState) {
            detailState.endDate = cur.next_end;
            detailState.pendingDir = "next";
            fetchAndRenderMetricDetail();
          }
        });
      }

      body.querySelectorAll("#sleep-mode-seg .seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (!detailState || detailState.sleepMode === b.dataset.smode) return;
          detailState.sleepMode = b.dataset.smode;
          const nextIdx = detailState.sleepMode === "summary" ? 1 : 0;
          const mThumb = $("sleep-mode-thumb");
          if (mThumb) mThumb.style.setProperty("--seg-idx", String(nextIdx));
          body.querySelectorAll("#sleep-mode-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          if (detailDataCache) {
            const themePal = getThemePalette();
            syncSleepBreakdownSlot(detailDataCache, themePal);
            drawDetailSvgChart($("apple-svg-wrap"), detailDataCache, themePal);
            triggerChartMotion($("apple-svg-wrap"), "chart-crossfade");
          }
        });
      });

      body.querySelectorAll("#hr-mode-seg .seg-btn").forEach((b) => {
        b.addEventListener("click", () => {
          if (!detailState || detailState.hrMode === b.dataset.hrmode) return;
          detailState.hrMode = setHrChartMode(b.dataset.hrmode);
          const nextIdx = detailState.hrMode === "line" ? 1 : 0;
          const hThumb = $("hr-mode-thumb");
          if (hThumb) hThumb.style.setProperty("--seg-idx", String(nextIdx));
          body.querySelectorAll("#hr-mode-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
          triggerHapticTick(4);
          if (detailDataCache) {
            drawDetailSvgChart($("apple-svg-wrap"), detailDataCache, getThemePalette());
            triggerChartMotion($("apple-svg-wrap"), "chart-crossfade");
          }
        });
      });
    } else {
      // Persistent Shell: keep #detail-scope-bar & #sleep-mode-seg intact to prevent double animation!
      const sThumb = $("scope-seg-thumb");
      if (sThumb) sThumb.style.setProperty("--seg-idx", String(curScopeIdx));
      body.querySelectorAll("#detail-scope-bar .scope-btn").forEach((x) => x.classList.toggle("active", x.dataset.scope === data.scope));

      const prevB = $("md-prev-btn");
      const nextB = $("md-next-btn");
      const lbl = $("md-stepper-label");
      if (prevB) prevB.disabled = !data.prev_end;
      if (nextB) nextB.disabled = !data.next_end;
      if (lbl) lbl.textContent = data.range_label || "";

      $("scrub-kicker").textContent = data.hero?.kicker || "";
      $("scrub-unit").textContent = data.hero?.unit || "";
      $("scrub-sub").textContent = getDefaultHeroSub(data);
      const badgesEl = $("scrub-badges");
      if (badgesEl) badgesEl.innerHTML = `${statusBadge}${fallbackNote}`;

      const valEl = $("scrub-value");
      if (valEl) {
        valEl.style.color = meta.colorVar;
        if (navDir !== "resize" && prevPrimaryText && prevPrimaryText !== nextPrimaryText) {
          animateHeroNumber(valEl, prevPrimaryText, nextPrimaryText, 340);
        } else {
          valEl.textContent = nextPrimaryText;
        }
      }

      if (isSleep) {
        const mThumb = $("sleep-mode-thumb");
        if (mThumb) mThumb.style.setProperty("--seg-idx", String(curSleepModeIdx));
        const stBtn = body.querySelector('#sleep-mode-seg .seg-btn[data-smode="stages"]');
        const suBtn = body.querySelector('#sleep-mode-seg .seg-btn[data-smode="summary"]');
        if (stBtn) {
          stBtn.textContent = data.scope === "D" ? "阶段分布" : "作息时间";
          stBtn.classList.toggle("active", detailState?.sleepMode !== "summary");
        }
        if (suBtn) {
          suBtn.textContent = data.scope === "D" ? "各阶段时长占比" : "时长构成";
          suBtn.classList.toggle("active", detailState?.sleepMode === "summary");
        }
      } else if (isHrMetric) {
        const hThumb = $("hr-mode-thumb");
        if (hThumb) hThumb.style.setProperty("--seg-idx", String(curHrModeIdx));
        body.querySelectorAll("#hr-mode-seg .seg-btn").forEach((x) => {
          x.classList.toggle("active", x.dataset.hrmode === (detailState?.hrMode === "line" ? "line" : "range"));
        });
      }

      if (navDir !== "resize") {
        syncSleepBreakdownSlot(data, p);
      }
      const lowerStack = $("detail-lower-stack");
      if (lowerStack && navDir !== "resize") {
        lowerStack.innerHTML = `${ecgEntry}${napsHtml}${emotionHtml}${racePredHtml}${highlightsHtml}${subMetricsHtml}${recordsHtml}`;
      }
    }

    const ecgLink = $("heart-detail-ecg");
    if (ecgLink) ecgLink.onclick = () => openMetricDetail("ecg", { fromTab: detailState?.fromTab });
    if (navDir !== "resize") {
      const sourceDetails = $("metric-source-records");
      if (sourceDetails) sourceDetails.ontoggle = () => {
        if (!sourceDetails.open) return;
        sourceDetails.querySelector(".source-scroll").innerHTML = (data.source_points||[]).map(r=>`<div class="kv-row"><span>${escapeHtml(r.ts_iso.slice(11,19))}</span><strong>${fmtNum(r.value,1)} ${escapeHtml(r.unit)}</strong></div>`).join("");
        sourceDetails.ontoggle = null;
      };
      const toggleAllBtn = $("toggle-all-data-btn");
      if (toggleAllBtn) {
        toggleAllBtn.addEventListener("click", () => {
          const dr = $("all-data-drawer");
          if (dr?.classList.toggle("open")) {
            const list = dr.querySelector(".kv-list");
            if (!list.firstElementChild) list.innerHTML = records.length
                    ? records.map((r) => `<div class="kv-row"><span class="kv-k">${escapeHtml(r.time)} · ${escapeHtml(r.label)}</span><span class="kv-v">${escapeHtml(r.value)}</span></div>`).join("")
                    : '<div class="card-note">当前周期暂无原始采样记录</div>';
          }
          toggleAllBtn.classList.toggle("open");
        });
      }
    }

    // Draw the SVG chart & apply directional micro-motion on navigation
    const wrapEl = $("apple-svg-wrap");
    drawDetailSvgChart(wrapEl, data, p);
    if (navDir === "prev") triggerChartMotion(wrapEl, "chart-slide-prev");
    else if (navDir === "next") triggerChartMotion(wrapEl, "chart-slide-next");
    else if (navDir === "crossfade") triggerChartMotion(wrapEl, "chart-crossfade");
  }

  function renderSleepStageBreakdownHtml(slp, p) {
    if (!slp) return "";
    const deep = Number(slp.deep_min || 0);
    const light = Number(slp.light_min || 0);
    const rem = Number(slp.rem_min || 0);
    const awake = Number(slp.awake_min || 0);
    const tot = Math.max(deep + light + rem + awake, 1);
    return `
      <div class="sleep-stage-pills">
        ${[
          { lbl: "深度睡眠", m: deep, c: p.deep },
          { lbl: "核心睡眠", m: light, c: p.lightSleep },
          { lbl: "快速眼动", m: rem, c: p.rem },
          { lbl: "清醒", m: awake, c: p.awake },
        ]
          .map(
            (s) => `
          <div class="stage-legend-item">
            <span class="ring-swatch" style="background:${s.c}"></span>
            <span><b>${fmtNum(s.m, 0)}m</b> <span class="card-note">${s.lbl} (${Math.round((s.m / tot) * 100)}%)</span></span>
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  function renderEmotionBreakdownCard(emo, p, cardIdx = 1, animCls = "stagger-card") {
    const tot = Math.max(emo.total || 0, 1);
    const pct = (v) => ((Number(v || 0) / tot) * 100).toFixed(1);
    return `
      <div class="card ${animCls}" style="--card-idx:${cardIdx}">
        <div class="card-header" style="margin-bottom:4px;">
          <h3 class="card-title">心理状态分布</h3>
          <span class="card-note">共 ${fmtNum(emo.total)} 次情绪检测</span>
        </div>
        <div class="emo-bar-wrap">
          <div class="emo-pill-track">
            <div style="width:${pct(emo.pleasant)}%;background:${p.green}"></div>
            <div style="width:${pct(emo.peace)}%;background:${p.teal}"></div>
            <div style="width:${pct(emo.unpleasant)}%;background:${p.purple}"></div>
          </div>
          <div hidden class="sleep-hero-foot">
            <span><span class="ring-swatch" style="display:inline-block;background:${p.green};margin-right:4px"></span>愉悦 ${pct(emo.pleasant)}% (${emo.pleasant})</span>
            <span><span class="ring-swatch" style="display:inline-block;background:${p.teal};margin-right:4px"></span>平和 ${pct(emo.peace)}% (${emo.peace})</span>
            <span><span class="ring-swatch" style="display:inline-block;background:${p.purple};margin-right:4px"></span>低落/不悦 ${pct(emo.unpleasant)}% (${emo.unpleasant})</span>
          </div>
        </div>
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Custom Pixel-Accurate SVG Chart Engine + Pointer Scrubbing
  // -----------------------------------------------------------------------

  function niceBounds(vals, fallbackMin, fallbackMax) {
    if (!vals.length) return [fallbackMin, fallbackMax, [fallbackMin, (fallbackMin + fallbackMax) / 2, fallbackMax]];
    let mn = Math.min(...vals);
    let mx = Math.max(...vals);
    if (mn === mx) {
      mn -= 5;
      mx += 5;
    }
    const span = mx - mn;
    const rawStep = span / 3;
    const pow10 = Math.pow(10, Math.floor(Math.log10(rawStep || 1)));
    const frac = rawStep / pow10;
    const step = (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow10;
    const lo = Math.floor(mn / step) * step;
    const hi = Math.ceil(mx / step) * step;
    const ticks = [];
    for (let v = lo; v <= hi + step * 0.01; v += step) {
      ticks.push(Math.round(v * 100) / 100);
    }
    return [lo, hi, ticks];
  }

  function smoothNumericSeries(vals, passes = 2) {
    if (!vals || vals.length < 3) return vals ? [...vals] : [];
    const kernel = [1, 2, 3, 2, 1];
    let cur = vals.map(Number);
    const n = cur.length;
    for (let p = 0; p < passes; p += 1) {
      cur = cur.map((v, i) => {
        if (i === 0 || i === n - 1) return v;
        let sw = 0;
        let sv = 0;
        for (let k = -2; k <= 2; k += 1) {
          const j = i + k;
          if (j >= 0 && j < n) {
            const w = kernel[k + 2];
            sw += w;
            sv += cur[j] * w;
          }
        }
        return sv / sw;
      });
    }
    return cur;
  }

  function buildSmoothSvgPath(pts, tension = 0.22) {
    if (!pts || !pts.length) return "";
    if (pts.length === 1) return `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    if (pts.length === 2) return `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)} L${pts[1].x.toFixed(1)} ${pts[1].y.toFixed(1)}`;
    let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    const n = pts.length;
    for (let i = 0; i < n - 1; i += 1) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      const segDx = Math.max(0, p2.x - p1.x);
      const cp1x = p1.x + Math.max(0, Math.min(segDx * 0.45, (p2.x - p0.x) * tension));
      let cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - Math.max(0, Math.min(segDx * 0.45, (p3.x - p1.x) * tension));
      let cp2y = p2.y - (p3.y - p1.y) * tension;
      const minY = Math.min(p1.y, p2.y);
      const maxY = Math.max(p1.y, p2.y);
      cp1y = Math.max(minY, Math.min(maxY, cp1y));
      cp2y = Math.max(minY, Math.min(maxY, cp2y));
      d += ` C${cp1x.toFixed(1)} ${cp1y.toFixed(1)}, ${cp2x.toFixed(1)} ${cp2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
    }
    return d;
  }

  function bindChartScrubGesture(svgEl, onPickX, onReset) {
    let active = false;
    let touchMode = "idle";
    let startX = 0;
    let startY = 0;
    let holdTimer = null;

    const clearHold = () => {
      if (holdTimer) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    };

    svgEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") {
        clearHold();
        active = false;
        touchMode = "pending";
        startX = e.clientX;
        startY = e.clientY;
        holdTimer = setTimeout(() => {
          holdTimer = null;
          if (touchMode === "pending") {
            touchMode = "scrub";
            active = true;
            onPickX(startX, "touch");
          }
        }, 110);
      } else {
        active = true;
        onPickX(e.clientX, e.pointerType);
      }
    });

    svgEl.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") {
        if (touchMode === "scroll") return;
        if (touchMode === "pending") {
          const dx = Math.abs(e.clientX - startX);
          const dy = Math.abs(e.clientY - startY);
          if (dy > 6 && dy >= dx) {
            clearHold();
            touchMode = "scroll";
            return;
          }
          if (dx > 6 && dx > dy) {
            clearHold();
            touchMode = "scrub";
            active = true;
            onPickX(e.clientX, e.pointerType);
          }
          return;
        }
        if (active) onPickX(e.clientX, e.pointerType);
      } else if (active || e.pointerType === "mouse") {
        onPickX(e.clientX, e.pointerType);
      }
    });

    const endScrub = (e) => {
      clearHold();
      const wasActive = active;
      active = false;
      touchMode = "idle";
      if (e.pointerType !== "touch" || wasActive) {
        onReset();
      }
    };

    svgEl.addEventListener("pointerup", endScrub);
    svgEl.addEventListener("pointercancel", endScrub);
    svgEl.addEventListener("pointerleave", endScrub);
  }

  function attachScrubHandlers(svgEl, slotZones, defaultHero, onScrubSlot) {
    const lineEl = svgEl.querySelector(".scrub-cursor-line");
    const items = svgEl.querySelectorAll("[data-slot]");
    const bridges = svgEl.querySelectorAll("[data-bprev]");
    const glows = svgEl.querySelectorAll("[data-glow-slot]");
    let lastIdx = -1;
    let cursorVisible = false;

    const reset = () => {
      lastIdx = -1;
      cursorVisible = false;
      if (lineEl) lineEl.setAttribute("opacity", "0");
      items.forEach((el) => {
        el.classList.remove("scrub-hit", "scrub-dim");
        el.setAttribute("opacity", el.dataset.baseOp || "1");
      });
      bridges.forEach((b) => {
        b.classList.remove("scrub-hit", "scrub-dim");
      });
      glows.forEach((g) => {
        g.classList.remove("scrub-glow-hit", "scrub-glow-dim");
        g.setAttribute("opacity", g.dataset.baseOp || "0.28");
      });
      $("scrub-kicker").textContent = defaultHero.kicker;
      $("scrub-value").textContent = defaultHero.primary;
      $("scrub-unit").textContent = defaultHero.unit;
      $("scrub-sub").textContent = defaultHero.sub;
    };

    const pickAtClientX = (clientX, pointerType) => {
      if (!slotZones.length) return;
      const rect = svgEl.getBoundingClientRect();
      const vb = svgEl.viewBox.baseVal;
      const svgX = ((clientX - rect.left) / Math.max(rect.width, 1)) * vb.width;
      let best = slotZones[0];
      let bestDist = Infinity;
      for (let i = 0; i < slotZones.length; i += 1) {
        const d = Math.abs(svgX - slotZones[i].cx);
        if (d < bestDist) {
          bestDist = d;
          best = slotZones[i];
        }
      }
      if (!best) return;
      if (lineEl) {
        if (!cursorVisible) {
          lineEl.classList.add("no-glide");
          lineEl.style.transform = `translateX(${best.cx.toFixed(1)}px)`;
          void lineEl.getBoundingClientRect();
          lineEl.classList.remove("no-glide");
          cursorVisible = true;
        } else {
          lineEl.style.transform = `translateX(${best.cx.toFixed(1)}px)`;
        }
        lineEl.setAttribute("opacity", "1");
      }
      if (lastIdx !== best.index) {
        if (lastIdx !== -1 && pointerType !== "mouse") triggerHapticTick(8);
        lastIdx = best.index;
      }
      items.forEach((el) => {
        const isHit = Number(el.dataset.slot) === best.index;
        el.classList.toggle("scrub-hit", isHit);
        el.classList.toggle("scrub-dim", !isHit);
      });
      bridges.forEach((b) => {
        b.classList.add("scrub-dim");
      });
      glows.forEach((g) => {
        const isHit = Number(g.dataset.glowSlot) === best.index;
        g.classList.toggle("scrub-glow-hit", isHit);
        g.classList.toggle("scrub-glow-dim", !isHit);
      });
      const chosen=best.bucket?.date || best.bucket?.end_date || best.bucket?.end || best.bucket?.key;
      if(detailState && /^\d{4}-\d{2}-\d{2}$/.test(chosen)) detailState.endDate=chosen;
      const readout = onScrubSlot(best);
      $("scrub-kicker").textContent = readout.kicker;
      $("scrub-value").textContent = readout.primary;
      $("scrub-unit").textContent = readout.unit;
      const sub=$("scrub-sub");
      if(best.stage){
        const parts=(best.stage.vitals||"").split(" · ");
        sub.innerHTML=["心率","血氧","HRV"].map(name=>{
          const value=parts.find(p=>p.startsWith(name+" "))?.slice(name.length+1) || "—";
          return `<span class="sleep-reading"><small>${name}</small><strong>${escapeHtml(value.replace(/(\d+(?:\.\d+)?)–\1(?=\s)/,"$1"))}</strong></span>`;
        }).join("");
      }else sub.textContent=readout.sub;
    };

    bindChartScrubGesture(svgEl, pickAtClientX, reset);
  }

  function drawSleepScheduleSvg(wrapEl, data, p) {
    const buckets = data.buckets || [];
    const allH = [];
    buckets.forEach((b) => {
      if (b.bed_h != null) allH.push(Number(b.bed_h));
      if (b.wake_h != null) allH.push(Number(b.wake_h));
      (b.stage_segs || []).forEach((seg) => {
        if (seg[1] != null) allH.push(Number(seg[1]));
        if (seg[2] != null) allH.push(Number(seg[2]));
      });
    });

    if (!allH.length) {
      wrapEl.innerHTML = '<div class="empty-inline-box">当前周期暂无作息时间记录（可切换 时长构成 查看总时长）</div>';
      return;
    }

    const uid = ++svgUid;
    const W = Math.max(300, Math.round(wrapEl.clientWidth || 340));
    const H = isNarrowPhone() ? 215 : 240;
    const pLeft = 4;
    const pRight = W - 44;
    const pTop = 12;
    const pBot = H - 24;
    const plotW = Math.max(100, pRight - pLeft);
    const plotH = Math.max(90, pBot - pTop);
    const n = Math.max(buckets.length, 1);
    const slotW = plotW / n;
    const barW = Math.max(5, Math.min(18, slotW * 0.52));

    let yLo = Math.floor((Math.min(...allH) - 0.25) / 2) * 2;
    let yHi = Math.ceil((Math.max(...allH) + 0.25) / 2) * 2;
    if (yHi - yLo < 8) yHi = yLo + 8;

    const mapY = (h) => pTop + ((Number(h) - yLo) / Math.max(yHi - yLo, 1e-6)) * plotH;
    const stepH = (yHi - yLo) <= 14 ? 2 : 4;
    const gridLines = [];
    for (let h = yLo; h <= yHi + 0.01; h += stepH) {
      const y = mapY(h).toFixed(1);
      const dispH = Math.round(h) % 24;
      const lbl = `${String(dispH).padStart(2, "0")}:00`;
      gridLines.push(`
        <line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>
        <text x="${W - 2}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="600" fill="${p.text2}">${lbl}</text>
      `);
    }

    const xTicksSvg = buckets
      .map((b, i) => {
        if (!b.tick) return "";
        const x = (pLeft + (i + 0.5) * slotW).toFixed(1);
        return `
          <line x1="${x}" y1="${pTop}" x2="${x}" y2="${pBot}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2 3"/>
          <text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${p.text2}">${escapeHtml(b.tick)}</text>
        `;
      })
      .join("");

    const colMap = { a: p.awake, r: p.rem, l: p.lightSleep, d: p.deep };
    const clipDefs = [];
    const shapes = [];
    const slotZones = [];

    buckets.forEach((b, i) => {
      const cx = pLeft + (i + 0.5) * slotW;
      const staggerMs = Math.min(240, Math.round((i / Math.max(n, 1)) * 200));
      slotZones.push({ index: i, cx, bucket: b });

      const segs = b.stage_segs || [];
      if (segs.length) {
        const sMin = Math.min(...segs.map((s) => Number(s[1])));
        const sMax = Math.max(...segs.map((s) => Number(s[2])));
        const yTop = mapY(sMin);
        const yBot = mapY(sMax);
        const spanH = Math.max(6, yBot - yTop);
        const xL = cx - barW / 2;
        const rad = Math.min(barW / 2, spanH / 2);
        const clipId = `slp-sched-${uid}-${i}`;
        clipDefs.push(`<clipPath id="${clipId}"><rect x="${xL.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${spanH.toFixed(1)}" rx="${rad.toFixed(1)}"/></clipPath>`);
        const segRects = segs
          .map((s) => {
            const c = colMap[s[0]] || p.lightSleep;
            const sy1 = mapY(s[1]);
            const sy2 = mapY(s[2]);
            const sh = Math.max(1.2, sy2 - sy1 + 0.35);
            return `<rect x="${xL.toFixed(1)}" y="${sy1.toFixed(1)}" width="${barW.toFixed(1)}" height="${sh.toFixed(1)}" fill="${c}"/>`;
          })
          .join("");
        shapes.push(`
          <g class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.96" opacity="0.96" clip-path="url(#${clipId})">
            <rect x="${xL.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${spanH.toFixed(1)}" fill="${p.lightSleep}" fill-opacity="0.22"/>
            ${segRects}
          </g>
        `);
      } else if (b.bed_h != null && b.wake_h != null) {
        const yTop = mapY(b.bed_h);
        const yBot = mapY(b.wake_h);
        const spanH = Math.max(6, yBot - yTop);
        const xL = cx - barW / 2;
        const rad = Math.min(barW / 2, spanH / 2);
        shapes.push(`<rect class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.88" opacity="0.88" x="${xL.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${spanH.toFixed(1)}" rx="${rad.toFixed(1)}" fill="${p.indigo}"/>`);
      }
    });

    const hasDetailedSegs = buckets.some((b) => (b.stage_segs || []).length > 0);
    const legendHtml = hasDetailedSegs
      ? `
        <div class="chart-legend-row" style="margin-top:8px;">
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.deep}"></span>深睡</span>
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.lightSleep}"></span>核心</span>
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.rem}"></span>快速眼动</span>
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.awake}"></span>清醒</span>
        </div>
      `
      : "";

    wrapEl.innerHTML = `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        ${clipDefs.length ? `<defs>${clipDefs.join("")}</defs>` : ""}
        ${gridLines.join("")}
        ${xTicksSvg}
        ${shapes.join("")}
        <g class="scrub-cursor-line" opacity="0">
          <line x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text2}" stroke-width="1.5"/>
          <circle cx="0" cy="${pTop}" r="3.5" fill="${p.indigo}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>
        </g>
      </svg>
      ${legendHtml}
    `;

    const defaultHero = {
      kicker: data.hero?.kicker || "",
      primary: data.hero?.primary || "-",
      unit: data.hero?.unit || "",
      sub: getDefaultHeroSub(data),
    };
    const svgEl = wrapEl.querySelector("svg");
    attachScrubHandlers(svgEl, slotZones, defaultHero, ({ bucket: b }) => ({
      kicker: b.scrub_title,
      primary: b.bed_hm && b.bed_hm !== "-" ? `${b.bed_hm} – ${b.wake_hm}` : (b.val != null ? fmtMinHmCn(b.val) : "-"),
      unit: "",
      sub: b.val != null ? `总睡眠 ${fmtMinHmCn(b.val)}${b.score != null ? ` · 评分 ${fmtNum(b.score, 0)}` : ""}` : "无睡眠数据",
    }));
  }

  function drawHeartRateLineChartSvg(wrapEl, data, p) {
    if (!wrapEl) return;
    const accent = p.dark ? METRIC_META.heart_rate.hexDark : METRIC_META.heart_rate.hexLight;
    const W = Math.max(300, Math.round(wrapEl.clientWidth || 340));
    const H = isNarrowPhone() ? 205 : 235;
    const pLeft = 4;
    const pRight = W - 40;
    const pTop = 14;
    const pBot = H - 24;
    const plotW = Math.max(100, pRight - pLeft);
    const plotH = Math.max(80, pBot - pTop);
    const defaultHero = {
      kicker: data.hero?.kicker || "心率范围",
      primary: data.hero?.primary || "-",
      unit: data.hero?.unit || "次/分",
      sub: getDefaultHeroSub(data),
    };

    const hrSeries = data.scope === "D" ? (data.hr_series || []) : [];
    if (data.scope === "D" && hrSeries.length >= 2) {
      const vals = hrSeries.map((pt) => Number(pt.v));
      if (data.rest_ref != null) vals.push(Number(data.rest_ref));
      const [yLo, yHi, yTicks] = niceBounds(vals, 40, 140);
      const mapX = (m) => pLeft + (Math.max(0, Math.min(1440, Number(m))) / 1440) * plotW;
      const mapY = (v) => pTop + ((yHi - Number(v)) / Math.max(yHi - yLo, 1e-6)) * plotH;

      const gridSvg = yTicks
        .filter((t) => t >= yLo && t <= yHi)
        .map((t) => {
          const y = mapY(t).toFixed(1);
          return `<line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/><text x="${W - 2}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="600" fill="${p.text2}">${Math.round(t)}</text>`;
        })
        .join("");
      const xTicksSvg = [0, 360, 720, 1080, 1440]
        .map((m) => {
          const x = mapX(m).toFixed(1);
          const lbl = m === 1440 ? "24时" : `${Math.round(m / 60)}时`;
          const anchor = m === 0 ? "start" : m === 1440 ? "end" : "middle";
          return `<line x1="${x}" y1="${pTop}" x2="${x}" y2="${pBot}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2 3"/><text x="${x}" y="${H - 6}" text-anchor="${anchor}" font-size="10.5" font-weight="600" fill="${p.text2}">${lbl}</text>`;
        })
        .join("");

      const pts = hrSeries.map((pt) => ({ x: mapX(pt.m), y: mapY(pt.v), rawY: Number(pt.v), pt }));
      const groups = [];
      for (const node of pts) {
        const cur = groups.at(-1);
        if (!cur || node.pt.m - cur.at(-1).pt.m > 65) groups.push([node]);
        else cur.push(node);
      }
      const linePaths = groups.map((g) => buildSmoothSvgPath(g, 0.16)).filter(Boolean);
      const areaPaths = groups.map((g, idx) => `${linePaths[idx]} L${g.at(-1).x.toFixed(1)} ${pBot} L${g[0].x.toFixed(1)} ${pBot} Z`).join(" ");
      const lowPt = pts.reduce((a, b) => (a.rawY <= b.rawY ? a : b));
      const highPt = pts.reduce((a, b) => (a.rawY >= b.rawY ? a : b));
      const uid = ++svgUid;
      const restRefSvg = data.rest_ref != null && data.rest_ref >= yLo && data.rest_ref <= yHi
        ? `<line x1="${pLeft}" y1="${mapY(data.rest_ref).toFixed(1)}" x2="${pRight}" y2="${mapY(data.rest_ref).toFixed(1)}" stroke="${p.text2}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.72"/>`
        : "";

      wrapEl.innerHTML = `
        <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
          <defs>
            <linearGradient id="hr-day-grad-${uid}" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="${accent}" stop-opacity="0.28"/>
              <stop offset="100%" stop-color="${accent}" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          ${gridSvg}
          ${xTicksSvg}
          ${restRefSvg}
          <path class="svg-line-draw" d="${areaPaths}" fill="url(#hr-day-grad-${uid})"/>
          ${linePaths.map((lp) => `<path class="svg-line-draw" d="${lp}" fill="none" stroke="${accent}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`).join("")}
          ${extremeDots(lowPt, highPt, accent, (k) => k.x, (k) => k.y, false)}
          <line id="hr-day-cursor-${uid}" x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text2}" stroke-width="1.4" opacity="0"/>
          <circle id="hr-day-dot-${uid}" cx="0" cy="0" r="4.2" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.6" opacity="0"/>
        </svg>
        <div class="chart-legend-row">
          <span class="chart-legend-item"><span class="ring-swatch" style="background:${accent}"></span>连续心率轨迹</span>
          ${data.rest_ref != null ? `<span class="chart-legend-item"><span class="ring-swatch" style="background:${p.text2};opacity:0.7"></span>静息参考 ${data.rest_ref} bpm</span>` : ""}
        </div>
      `;

      const svgEl = wrapEl.querySelector("svg");
      const cursorLine = $(`hr-day-cursor-${uid}`);
      const cursorDot = $(`hr-day-dot-${uid}`);
      let lastHitPt = null;
      bindChartScrubGesture(
        svgEl,
        (clientX, pointerType) => {
          const rect = svgEl.getBoundingClientRect();
          const svgX = Math.max(pLeft, Math.min(pRight, ((clientX - rect.left) * W) / Math.max(rect.width, 1)));
          let best = pts[0];
          let bestDist = Infinity;
          for (let i = 0; i < pts.length; i += 1) {
            const d = Math.abs(pts[i].x - svgX);
            if (d < bestDist) {
              bestDist = d;
              best = pts[i];
            }
          }
          if (!best) return;
          cursorLine.setAttribute("x1", best.x.toFixed(1));
          cursorLine.setAttribute("x2", best.x.toFixed(1));
          cursorLine.setAttribute("opacity", "1");
          cursorDot.setAttribute("cx", best.x.toFixed(1));
          cursorDot.setAttribute("cy", best.y.toFixed(1));
          cursorDot.setAttribute("opacity", "1");
          if (pointerType !== "mouse" && lastHitPt && lastHitPt !== best) {
            triggerHapticTick(8);
          }
          lastHitPt = best;
          $("scrub-kicker").textContent = `${data.anchor_end || ""} ${best.pt.t}`.trim();
          $("scrub-value").textContent = `${Math.round(best.rawY)}`;
          $("scrub-unit").textContent = "次/分";
          $("scrub-sub").textContent = data.rest_ref != null ? `连续心率采样 · 静息参考 ${data.rest_ref} bpm` : "连续心率采样";
        },
        () => {
          lastHitPt = null;
          cursorLine.setAttribute("opacity", "0");
          cursorDot.setAttribute("opacity", "0");
          $("scrub-kicker").textContent = defaultHero.kicker;
          $("scrub-value").textContent = defaultHero.primary;
          $("scrub-unit").textContent = defaultHero.unit;
          $("scrub-sub").textContent = defaultHero.sub;
        }
      );
      return;
    }

    const buckets = data.buckets || [];
    const vals = buckets.flatMap((b) => [b.min, b.max, b.avg, b.rest]).filter((v) => v != null).map(Number);
    const [yLo, yHi, yTicks] = niceBounds(vals, 40, 120);
    const n = Math.max(buckets.length, 1);
    const slotW = plotW / n;
    const mapY = (v) => pTop + ((yHi - Number(v)) / Math.max(yHi - yLo, 1e-6)) * plotH;

    const gridSvg = yTicks
      .filter((t) => t >= yLo && t <= yHi)
      .map((t) => {
        const y = mapY(t).toFixed(1);
        return `<line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/><text x="${W - 2}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="600" fill="${p.text2}">${Math.round(t)}</text>`;
      })
      .join("");
    const xTicksSvg = buckets
      .map((b, i) => {
        if (!b.tick) return "";
        const x = (pLeft + (i + 0.5) * slotW).toFixed(1);
        return `<line x1="${x}" y1="${pTop}" x2="${x}" y2="${pBot}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2 3"/><text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${p.text2}">${escapeHtml(b.tick)}</text>`;
      })
      .join("");

    const avgGroups = [];
    const envGroups = [];
    const restGroups = [];
    const dotShapes = [];
    const slotZones = [];
    let prevAvg = false;
    let prevEnv = false;
    let prevRest = false;

    buckets.forEach((b, i) => {
      const cx = pLeft + (i + 0.5) * slotW;
      slotZones.push({ index: i, cx, bucket: b });
      const avgVal = b.avg ?? (b.min != null && b.max != null ? (Number(b.min) + Number(b.max)) / 2 : b.rest);
      const staggerMs = Math.min(260, Math.round((i / n) * 220));
      if (avgVal != null) {
        const pt = { x: cx, y: mapY(avgVal) };
        if (!prevAvg) avgGroups.push([]);
        avgGroups.at(-1).push(pt);
        prevAvg = true;
        const rad = Math.max(2.8, Math.min(4.8, slotW * 0.16));
        dotShapes.push(`<circle class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" cx="${cx.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="${rad.toFixed(1)}" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>`);
      } else {
        prevAvg = false;
      }

      if (b.min != null && b.max != null) {
        const entry = { x: cx, yTop: mapY(b.max), yBot: mapY(b.min) };
        if (!prevEnv) envGroups.push([]);
        envGroups.at(-1).push(entry);
        prevEnv = true;
      } else {
        prevEnv = false;
      }

      if (b.rest != null) {
        const rPt = { x: cx, y: mapY(b.rest) };
        if (!prevRest) restGroups.push([]);
        restGroups.at(-1).push(rPt);
        prevRest = true;
      } else {
        prevRest = false;
      }
    });

    const envSvg = envGroups
      .map((g) => {
        if (g.length < 2) return "";
        const topPts = g.map((e) => `${e.x.toFixed(1)},${e.yTop.toFixed(1)}`);
        const botPts = [...g].reverse().map((e) => `${e.x.toFixed(1)},${e.yBot.toFixed(1)}`);
        return `<polygon points="${topPts.concat(botPts).join(" ")}" fill="${accent}" fill-opacity="0.14"/>`;
      })
      .join("");
    const lineSvg = avgGroups
      .filter((g) => g.length > 1)
      .map((g) => `<path class="svg-line-draw" d="${buildSmoothSvgPath(g)}" fill="none" stroke="${accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`)
      .join("");
    const restLineSvg = restGroups
      .filter((g) => g.length > 1)
      .map((g) => `<path class="svg-line-draw" d="${buildSmoothSvgPath(g)}" fill="none" stroke="${p.text2}" stroke-width="1.5" stroke-dasharray="4 3" opacity="0.72"/>`)
      .join("");

    wrapEl.innerHTML = `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        ${gridSvg}
        ${xTicksSvg}
        ${envSvg}
        ${restLineSvg}
        ${lineSvg}
        ${dotShapes.join("")}
        <g class="scrub-cursor-line" opacity="0">
          <line x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text2}" stroke-width="1.5"/>
          <circle cx="0" cy="${pTop}" r="3.5" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>
        </g>
      </svg>
      <div class="chart-legend-row">
        <span class="chart-legend-item"><span class="ring-swatch" style="background:${accent}"></span>均值折线</span>
        <span class="chart-legend-item"><span class="ring-swatch" style="background:${accent};opacity:0.25"></span>高低波动带</span>
        <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.text2};opacity:0.7"></span>静息心率</span>
      </div>
    `;

    attachScrubHandlers(wrapEl.querySelector("svg"), slotZones, defaultHero, ({ bucket: b }) => {
      const avgVal = b.avg ?? (b.min != null && b.max != null ? Math.round((Number(b.min) + Number(b.max)) / 2) : null);
      const rngTxt = b.min != null && b.max != null ? `范围 ${b.min}–${b.max} bpm` : "";
      const restTxt = b.rest != null ? `静息 ${b.rest} bpm` : "";
      return {
        kicker: b.scrub_title,
        primary: avgVal != null ? `${fmtNum(avgVal, 1)}` : "-",
        unit: "次/分",
        sub: [rngTxt, restTxt].filter(Boolean).join(" · ") || "暂无记录",
      };
    });
  }

  function drawDetailSvgChart(wrapEl, data, p) {
    if (!wrapEl) return;
    if (data.metric === "heart_rate" && detailState?.hrMode === "line") {
      drawHeartRateLineChartSvg(wrapEl, data, p);
      return;
    }
    if (data.metric === "sleep" && data.scope === "D") {
      if (detailState?.sleepMode === "summary") {
        drawSleepSummaryBarsSvg(wrapEl, data.sleep_detail, p);
      } else {
        drawSleepHypnogramSvg(wrapEl, data, p);
      }
      return;
    }
    if (data.metric === "sleep" && detailState?.sleepMode !== "summary") {
      drawSleepScheduleSvg(wrapEl, data, p);
      return;
    }

    const buckets = data.buckets || [];
    const W = Math.max(300, Math.round(wrapEl.clientWidth || 340));
    const H = isNarrowPhone() ? 205 : 235;
    const pLeft = 4;
    const pRight = W - 40;
    const pTop = 14;
    const pBot = H - 24;
    const plotW = Math.max(100, pRight - pLeft);
    const plotH = Math.max(80, pBot - pTop);
    const n = Math.max(buckets.length, 1);
    const slotW = plotW / n;
    const barW = Math.max(4, Math.min(20, slotW * 0.54));

    const defaultHero = {
      kicker: data.hero?.kicker || "",
      primary: data.hero?.primary || "-",
      unit: data.hero?.unit || "",
      sub: getDefaultHeroSub(data),
    };

    const isBarMetric =
      data.metric === "steps" ||
      data.metric === "active_energy" ||
      data.metric === "basal_energy" ||
      data.metric === "distance";
    const isHollowLine = data.metric === "resting_hr";

    // Determine Y bounds across metrics
    let vals = [];
    if (isBarMetric) {
      vals = buckets.map((b) => b.val).filter((v) => v != null).map(Number);
      if (data.scope !== "D" && data.goal) vals.push(Number(data.goal));
      vals.push(0);
    } else if (data.metric === "sleep") {
      vals = buckets.map((b) => b.val).filter((v) => v != null).map(Number);
      if (data.goal_min) vals.push(Number(data.goal_min));
      vals.push(0);
    } else if (data.metric === "spo2") {
      vals = buckets.flatMap((b) => [b.min, b.max, b.avg]).filter((v) => v != null).map(Number);
      vals.push(95, 100);
    } else if (data.metric === "hrv" || isHollowLine) {
      vals = buckets.flatMap((b) => [b.min, b.max, b.avg]).filter((v) => v != null).map(Number);
      if (data.metric === "hrv" && data.baseline) vals.push(data.baseline.low, data.baseline.high);
    } else if (data.metric === "vo2max" || data.metric === "running_index") {
      vals = buckets.flatMap((b) => [b.min, b.max, b.avg]).filter((v) => v != null).map(Number);
      if (data.metric === "vo2max" && vals.length) vals.push(Math.min(...vals) - 3, Math.max(...vals) + 3, 52);
    } else if (data.metric === "training_index") {
      vals = buckets.flatMap((b) => [b.ctl, b.atl]).filter((v) => v != null).map(Number);
      vals.push(0);
    } else {
      vals = buckets.flatMap((b) => [b.min, b.max, b.rest, b.avg]).filter((v) => v != null).map(Number);
    }

    const fallbackMin =
      isBarMetric || data.metric === "sleep" || data.metric === "training_index"
        ? 0
        : data.metric === "vo2max" || data.metric === "running_index"
          ? 35
          : 40;
    const fallbackMax =
      data.metric === "spo2"
        ? 100
        : data.metric === "steps"
          ? 10000
          : data.metric === "active_energy"
            ? 600
            : data.metric === "basal_energy"
              ? 2200
              : data.metric === "distance"
                ? 10
                : data.metric === "vo2max" || data.metric === "running_index"
                  ? 65
                  : data.metric === "training_index"
                    ? 60
                    : 120;
    const [rawLo, rawHi, yTicks] = niceBounds(vals, fallbackMin, fallbackMax);
    const yLo = isBarMetric || data.metric === "sleep" || data.metric === "training_index" ? 0 : rawLo;
    const yHi = data.metric === "spo2" ? Math.min(100, Math.max(rawHi, 100)) : rawHi;
    const mapY = (v) => pTop + ((yHi - Number(v)) / Math.max(yHi - yLo, 1e-6)) * plotH;

    // Horizontal Y grid + right-aligned Y labels
    const gridSvg = yTicks
      .filter((t) => t >= yLo && t <= yHi)
      .map((t) => {
        const y = mapY(t).toFixed(1);
        const lbl = data.metric === "sleep"
          ? `${Math.round(t / 60)}h`
          : t >= 10000
            ? `${(t / 1000).toFixed(0)}k`
            : data.metric === "distance" && t < 10 && t % 1 !== 0
              ? t.toFixed(1)
              : `${t}`;
        return `
          <line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>
          <text x="${W - 2}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="600" fill="${p.text2}">${lbl}</text>
        `;
      })
      .join("");

    // X ticks + faint vertical week/day markers
    const xTicksSvg = buckets
      .map((b, i) => {
        if (!b.tick) return "";
        const x = (pLeft + (i + 0.5) * slotW).toFixed(1);
        return `
          <line x1="${x}" y1="${pTop}" x2="${x}" y2="${pBot}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2 3"/>
          <text x="${x}" y="${H - 6}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${p.text2}">${escapeHtml(b.tick)}</text>
        `;
      })
      .join("");

    let extraLayer = "";
    const shapes = [];
    const slotZones = [];

    if (data.metric === "hrv" && data.baseline) {
      const byTop = mapY(Math.min(yHi, data.baseline.high));
      const byBot = mapY(Math.max(yLo, data.baseline.low));
      extraLayer += `
        <rect x="${pLeft}" y="${byTop.toFixed(1)}" width="${plotW.toFixed(1)}" height="${Math.max(4, byBot - byTop).toFixed(1)}" rx="6" fill="${p.baselineBand}"/>
        <text x="${pLeft + 6}" y="${(byTop + 12).toFixed(1)}" font-size="10" font-weight="700" fill="${p.green}">个人基线</text>
      `;
    }

    if (data.metric === "vo2max" && (data.classification_bands || []).length) {
      data.classification_bands.forEach((band) => {
        const bLo = Math.max(yLo, band.min);
        const bHi = Math.min(yHi, band.max);
        if (bHi <= bLo) return;
        const yT = mapY(bHi);
        const yB = mapY(bLo);
        const bh = yB - yT;
        extraLayer += `<rect x="${pLeft}" y="${yT.toFixed(1)}" width="${plotW.toFixed(1)}" height="${bh.toFixed(1)}" fill="${band.color}" fill-opacity="0.09"/>`;
        if (bh >= 14) {
          extraLayer += `<text x="${pLeft + 6}" y="${(yT + 12).toFixed(1)}" font-size="9.5" font-weight="700" fill="${band.color}" opacity="0.85">${escapeHtml(band.label)}</text>`;
        }
      });
    }

    if (data.metric === "spo2") {
      const ry = mapY(95).toFixed(1);
      extraLayer += `
        <line x1="${pLeft}" y1="${ry}" x2="${pRight}" y2="${ry}" stroke="${p.teal}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.7"/>
      `;
    }

    const accent = p.dark ? METRIC_META[data.metric].hexDark : METRIC_META[data.metric].hexLight;
    if ((data.metric === "steps" || data.metric === "active_energy") && data.scope !== "D" && data.goal) {
      const gy = mapY(data.goal).toFixed(1);
      extraLayer += `<line x1="${pLeft}" y1="${gy}" x2="${pRight}" y2="${gy}" stroke="${accent}" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.8"/>`;
    }

    if (data.metric === "sleep" && data.goal_min) {
      const gy = mapY(data.goal_min).toFixed(1);
      extraLayer += `<line x1="${pLeft}" y1="${gy}" x2="${pRight}" y2="${gy}" stroke="${p.indigo}" stroke-width="1.3" stroke-dasharray="4 3" opacity="0.8"/>`;
    }

    const hrvLinePts = [];
    const trendPts = [];
    const ctlPts = [];
    const atlPts = [];
    const maxLoad = data.metric === "training_index"
      ? Math.max(...buckets.map((b) => Number(b.load || 0)), 1)
      : 1;

    buckets.forEach((b, i) => {
      const cx = pLeft + (i + 0.5) * slotW;
      const staggerMs = Math.min(260, Math.round((i / Math.max(n, 1)) * 220));
      const isSparse = data.metric === "vo2max" || data.metric === "running_index";
      if (!isSparse || b.avg != null) {
        slotZones.push({ index: i, cx, bucket: b });
      }

      if (isBarMetric) {
        if (b.val == null || b.val <= 0) return;
        const yT = mapY(b.val);
        const h = Math.max(3, pBot - yT);
        const hitGoal = data.scope !== "D" && data.goal && b.val >= data.goal;
        const op = hitGoal || (data.metric === "basal_energy" && i === n - 1) ? "0.96" : "0.74";
        shapes.push(`<rect class="svg-bar-grow" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="${op}" opacity="${op}" x="${(cx - barW / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(5, barW / 2).toFixed(1)}" fill="${accent}"/>`);
      } else if (data.metric === "sleep") {
        if (b.val == null || b.val <= 0) return;
        if (detailState?.sleepMode === "summary") {
          let cursor = pBot;
          const parts = [
            { v: b.deep || 0, c: p.deep },
            { v: b.light || 0, c: p.lightSleep },
            { v: b.rem || 0, c: p.rem },
            { v: b.awake || 0, c: p.awake },
          ];
          const sumStages = parts.reduce((acc, s) => acc + s.v, 0) || b.val;
          const totalPx = Math.max(4, pBot - mapY(b.val));
          parts.forEach((seg) => {
            if (seg.v <= 0) return;
            const sh = (seg.v / sumStages) * totalPx;
            cursor -= sh;
            shapes.push(`<rect class="svg-bar-grow" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.95" opacity="0.95" x="${(cx - barW / 2).toFixed(1)}" y="${cursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, sh - 0.8).toFixed(1)}" rx="2" fill="${seg.c}"/>`);
          });
        } else {
          const yT = mapY(b.val);
          const h = Math.max(4, pBot - yT);
          shapes.push(`<rect class="svg-bar-grow" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.92" opacity="0.92" x="${(cx - barW / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="${Math.min(5, barW / 2).toFixed(1)}" fill="${accent}"/>`);
        }
      } else if (isHollowLine) {
        if (b.avg == null) return;
        const cy = mapY(b.avg);
        hrvLinePts.push({ x: cx, y: cy });
        const rad = Math.min(4.6, Math.max(3, barW * 0.32));
        shapes.push(`<circle class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${rad.toFixed(1)}" fill="${p.surfaceSolid}" stroke="${accent}" stroke-width="2"/>`);
      } else if (data.metric === "hrv") {
        if (b.avg == null && b.min == null) return;
        if (b.min != null && b.max != null && b.max > b.min) {
          const yT = mapY(b.max);
          const yB = mapY(b.min);
          const wW = Math.max(3, Math.min(8, barW * 0.6));
          shapes.push(`<rect class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.28" opacity="0.28" x="${(cx - wW / 2).toFixed(1)}" y="${yT.toFixed(1)}" width="${wW.toFixed(1)}" height="${Math.max(wW, yB - yT).toFixed(1)}" rx="${(wW / 2).toFixed(1)}" fill="${accent}"/>`);
        }
        const av = b.avg ?? b.min;
        if (av != null) {
          const cy = mapY(av);
          hrvLinePts.push({ x: cx, y: cy });
          shapes.push(`<circle class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Math.min(5, Math.max(3, barW * 0.35)).toFixed(1)}" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.3"/>`);
        }
      } else if (isSparse) {
        if (b.avg == null) return;
        const cy = mapY(b.avg);
        trendPts.push({ x: cx, y: cy });
        shapes.push(`<circle class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${Math.min(5.2, Math.max(3.6, barW * 0.4)).toFixed(1)}" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>`);
      } else if (data.metric === "training_index") {
        if (b.load != null && b.load > 0) {
          const bh = Math.max(3, (b.load / maxLoad) * plotH * 0.56);
          shapes.push(`<rect class="svg-bar-grow" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.28" opacity="0.28" x="${(cx - barW / 2).toFixed(1)}" y="${(pBot - bh).toFixed(1)}" width="${barW.toFixed(1)}" height="${bh.toFixed(1)}" rx="${Math.min(4, barW / 2).toFixed(1)}" fill="${accent}"/>`);
        }
        if (b.ctl != null) ctlPts.push({ x: cx, y: mapY(b.ctl), slot: i });
        if (b.atl != null) atlPts.push({ x: cx, y: mapY(b.atl), slot: i });
      } else {
        // Range capsules for heart_rate, spo2, stress
        const lo = b.min ?? b.avg;
        const hi = b.max ?? b.avg;
        if (lo == null || hi == null) return;
        const yT = mapY(hi);
        const yB = mapY(lo);
        const capW = Math.max(4.5, Math.min(16, barW));
        const h = Math.max(capW, yB - yT);
        const yRect = yB - yT < capW ? (yT + yB) / 2 - capW / 2 : yT;
        shapes.push(`<rect class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="0.88" opacity="0.88" x="${(cx - capW / 2).toFixed(1)}" y="${yRect.toFixed(1)}" width="${capW.toFixed(1)}" height="${h.toFixed(1)}" rx="${(capW / 2).toFixed(1)}" fill="${accent}"/>`);
        if (data.metric === "heart_rate" && b.rest != null) {
          shapes.push(`<circle class="svg-cap-expand" style="--stagger:${staggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" cx="${cx.toFixed(1)}" cy="${mapY(b.rest).toFixed(1)}" r="2.2" fill="${p.surfaceSolid}"/>`);
        }
      }
    });

    if (!slotZones.length) {
      buckets.forEach((b, i) => slotZones.push({ index: i, cx: pLeft + (i + 0.5) * slotW, bucket: b }));
    }

    const hrvLineSvg = hrvLinePts.length > 1
      ? `<path class="svg-line-draw" d="${buildSmoothSvgPath(hrvLinePts)}" fill="none" stroke="${accent}" stroke-width="${isHollowLine ? "2" : "1.8"}" stroke-linecap="round" stroke-linejoin="round" opacity="${isHollowLine ? "0.86" : "0.72"}"/>`
      : "";

    let trendOverlaySvg = "";
    if (trendPts.length > 1) {
      const td = buildSmoothSvgPath(trendPts);
      const areaD = `${td} L${trendPts[trendPts.length - 1].x.toFixed(1)} ${pBot} L${trendPts[0].x.toFixed(1)} ${pBot} Z`;
      trendOverlaySvg = `
        <path class="svg-line-draw" d="${areaD}" fill="${accent}" fill-opacity="0.12"/>
        <path class="svg-line-draw" d="${td}" fill="none" stroke="${accent}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>
      `;
    } else if (data.metric === "training_index") {
      if (ctlPts.length > 1) {
        trendOverlaySvg += `<path class="svg-line-draw" d="${buildSmoothSvgPath(ctlPts)}" fill="none" stroke="${p.teal}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
      if (atlPts.length > 1) {
        trendOverlaySvg += `<path class="svg-line-draw" d="${buildSmoothSvgPath(atlPts)}" fill="none" stroke="${p.orange}" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>`;
      }
    }

    const legendStrip =
      data.metric === "training_index"
        ? `
          <div class="chart-legend-row">
            <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.teal}"></span>体能 (CTL)</span>
            <span class="chart-legend-item"><span class="ring-swatch" style="background:${p.orange}"></span>疲劳 (ATL)</span>
            <span class="chart-legend-item"><span class="ring-swatch" style="background:${accent};opacity:0.45"></span>训练负荷</span>
          </div>
        `
        : "";

    wrapEl.innerHTML = `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        ${gridSvg}
        ${xTicksSvg}
        ${extraLayer}
        ${hrvLineSvg}
        ${trendOverlaySvg}
        ${shapes.join("")}
        <g class="scrub-cursor-line" opacity="0">
          <line x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text2}" stroke-width="1.5"/>
          <circle cx="0" cy="${pTop}" r="3.5" fill="${accent}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>
        </g>
      </svg>
      ${legendStrip}
    `;

    const svgEl = wrapEl.querySelector("svg");
    attachScrubHandlers(svgEl, slotZones, defaultHero, ({ bucket: b }) => {
      if (data.metric === "steps") {
        const subTxt = data.scope === "D" ? "小时累计" : (data.scope === "6M" || data.scope === "Y" ? `总 ${fmtNum(b.sum, 0)} 步` : "当日合计");
        return {
          kicker: b.scrub_title,
          primary: b.val != null ? fmtNum(b.val, 0) : "0",
          unit: "步",
          sub: subTxt,
        };
      }
      if (data.metric === "active_energy" || data.metric === "basal_energy") {
        return {
          kicker: b.scrub_title,
          primary: b.val != null ? fmtNum(b.val, 0) : "-",
          unit: "千卡",
          sub: data.metric === "basal_energy" ? "每日基础代谢 (BMR)" : (data.scope === "D" ? "小时消耗" : "每日活动消耗"),
        };
      }
      if (data.metric === "distance") {
        return {
          kicker: b.scrub_title,
          primary: b.val != null ? fmtNum(b.val, 2) : "0",
          unit: "公里",
          sub: data.scope === "D" ? "小时估算距离" : (data.scope === "6M" || data.scope === "Y" ? `总 ${fmtNum(b.sum, 1)} 公里` : "当日步行+跑步"),
        };
      }
      if (data.metric === "resting_hr") {
        return {
          kicker: b.scrub_title,
          primary: b.avg != null ? fmtNum(b.avg, 1) : "-",
          unit: "次/分",
          sub: b.min != null && b.max != null && b.min !== b.max ? `范围 ${fmtNum(b.min, 0)}–${fmtNum(b.max, 0)} 次/分` : "静息心率",
        };
      }
      if (data.metric === "sleep") {
        return {
          kicker: b.scrub_title,
          primary: b.val != null ? fmtMinHmCn(b.val) : "-",
          unit: "",
          sub: b.score != null ? `评分 ${fmtNum(b.score, 0)} · 深睡 ${fmtNum(b.deep, 0)}m · REM ${fmtNum(b.rem, 0)}m` : "无睡眠数据",
        };
      }
      if (data.metric === "hrv") {
        return {
          kicker: b.scrub_title,
          primary: b.avg != null ? fmtNum(b.avg, 1) : "-",
          unit: "毫秒",
          sub: b.min != null && b.max != null ? `区间 ${fmtNum(b.min, 0)}–${fmtNum(b.max, 0)} 毫秒` : "暂无记录",
        };
      }
      if (data.metric === "spo2") {
        return {
          kicker: b.scrub_title,
          primary: b.min != null && b.max != null ? (b.min === b.max ? `${b.min}%` : `${b.min}–${b.max}%`) : "-",
          unit: "",
          sub: b.avg != null ? `平均血氧 ${b.avg}%` : "暂无记录",
        };
      }
      if (data.metric === "vo2max") {
        return {
          kicker: b.scrub_title,
          primary: b.avg != null ? fmtNum(b.avg, 1) : "-",
          unit: "mL/kg·min",
          sub: b.level ? `有氧适能等级 · ${b.level}` : "本时段无评估",
        };
      }
      if (data.metric === "training_index") {
        return {
          kicker: b.scrub_title,
          primary: b.tsb != null ? `${b.tsb >= 0 ? "+" : ""}${fmtNum(b.tsb, 1)}` : "-",
          unit: "分",
          sub: b.ctl != null ? `体能 ${b.ctl} · 疲劳 ${b.atl} · 负荷 ${Math.round(b.load || 0)}` : "暂无记录",
        };
      }
      if (data.metric === "running_index") {
        return {
          kicker: b.scrub_title,
          primary: b.avg != null ? fmtNum(b.avg, 1) : "-",
          unit: "分",
          sub: b.tier ? `跑力等级 · ${b.tier}` : "本时段无测算",
        };
      }
      if (data.metric === "stress") {
        return {
          kicker: b.scrub_title,
          primary: b.avg != null ? `${b.avg}` : "-",
          unit: "分",
          sub: b.min != null && b.max != null ? `范围 ${b.min}–${b.max} 分` : "暂无记录",
        };
      }
      // heart_rate
      return {
        kicker: b.scrub_title,
        primary: b.min != null && b.max != null ? (b.min === b.max ? `${b.min}` : `${b.min}–${b.max}`) : "-",
        unit: "次/分",
        sub: b.rest != null ? `静息心率 ${b.rest} bpm` : (b.avg != null ? `时段均心率 ${b.avg} bpm` : "暂无记录"),
      };
    });
  }

  function sleepBlockPath(x, y, w, h, rTL, rTR, rBR, rBL) {
    const maxR = Math.min(w / 2, h / 2);
    const tl = Math.max(0, Math.min(rTL, maxR));
    const tr = Math.max(0, Math.min(rTR, maxR));
    const br = Math.max(0, Math.min(rBR, maxR));
    const bl = Math.max(0, Math.min(rBL, maxR));
    return [
      `M${(x + tl).toFixed(2)},${y.toFixed(2)}`,
      `H${(x + w - tr).toFixed(2)}`,
      tr > 0 ? `A${tr.toFixed(2)},${tr.toFixed(2)} 0 0 1 ${(x + w).toFixed(2)},${(y + tr).toFixed(2)}` : "",
      `V${(y + h - br).toFixed(2)}`,
      br > 0 ? `A${br.toFixed(2)},${br.toFixed(2)} 0 0 1 ${(x + w - br).toFixed(2)},${(y + h).toFixed(2)}` : "",
      `H${(x + bl).toFixed(2)}`,
      bl > 0 ? `A${bl.toFixed(2)},${bl.toFixed(2)} 0 0 1 ${x.toFixed(2)},${(y + h - bl).toFixed(2)}` : "",
      `V${(y + tl).toFixed(2)}`,
      tl > 0 ? `A${tl.toFixed(2)},${tl.toFixed(2)} 0 0 1 ${(x + tl).toFixed(2)},${y.toFixed(2)}` : "",
      "Z",
    ].join("");
  }

  // Pixel-Exact iOS 17/18 Sleep Stages Hypnogram with Seamless Edge-Aligned Gradient Connectors
  function drawSleepHypnogramSvg(wrapEl, data, p) {
    const slp = data.sleep_detail;
    const stages = (slp?.stages || []).filter((s) => ["awake", "rem", "light", "deep"].includes(s.stage));
    if (!stages.length) {
      wrapEl.innerHTML = '<div class="empty-inline-box">当晚暂无夜间精细睡眠分期明细（可切换 周/月 查看趋势）</div>';
      return;
    }

    const uid = ++svgUid;
    const W = Math.max(300, Math.round(wrapEl.clientWidth || 340));
    const H = 216;
    const pLeft = 8;
    const pRight = W - 54;
    const pTop = 12;
    const pBot = H - 24;
    const plotH = pBot - pTop;
    const laneH = plotH / 4;
    const rowH = 22;

    const stageCfg = {
      awake: { row: 0, label: "清醒", color: p.awake, topC: p.dark ? "#FF8B70" : "#FF7A5C", botC: p.awake },
      rem: { row: 1, label: "快速眼动", color: p.rem, topC: p.dark ? "#70D7FF" : "#48C8F5", botC: p.rem },
      light: { row: 2, label: "核心睡眠", color: p.lightSleep, topC: p.dark ? "#529BFF" : "#1E88FF", botC: p.lightSleep },
      deep: { row: 3, label: "深度睡眠", color: p.deep, topC: p.dark ? "#7A7DFF" : "#5650DE", botC: p.deep },
    };
    const rowLabels = [
      { row: 0, label: "清醒", color: p.awake },
      { row: 1, label: "快速眼动", color: p.rem },
      { row: 2, label: "核心", color: p.lightSleep },
      { row: 3, label: "深度", color: p.deep },
    ];

    const tMin = Math.min(...stages.map((s) => Number(s.start_ms)));
    const tMax = Math.max(...stages.map((s) => Number(s.end_ms)));
    const tSpan = Math.max(tMax - tMin, 60000);
    const mapX = (ms) => pLeft + ((Number(ms) - tMin) / tSpan) * (pRight - pLeft);
    const rowY = (r) => pTop + r * laneH + (laneH - rowH) / 2;

    // Build clean 2-hour (or 1-hour on short nights) time ticks aligned to local hours
    const spanHours = tSpan / 3600000;
    const stepHours = spanHours <= 4.5 ? 1 : 2;
    const stepMs = stepHours * 3600000;
    const firstTickMs = Math.ceil(tMin / stepMs) * stepMs;

    const timeTicks = [];
    let lastTickX = -999;
    for (let tm = firstTickMs; tm <= tMax; tm += stepHours * 3600000) {
      const tx = mapX(tm);
      if (tx >= pLeft + 10 && tx <= pRight - 10 && tx - lastTickX >= 42) {
        lastTickX = tx;
        const dtStr = new Date(tm).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
        timeTicks.push(`
          <line x1="${tx.toFixed(1)}" y1="${pTop}" x2="${tx.toFixed(1)}" y2="${pBot + 4}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2.5 3"/>
          <text x="${tx.toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${p.text2}">${dtStr}</text>
        `);
      }
    }

    // Horizontal divider hairlines
    const dividersSvg = [0, 1, 2, 3, 4]
      .map((idx) => {
        const dy = (pTop + idx * laneH).toFixed(1);
        return `<line x1="${pLeft}" y1="${dy}" x2="${pRight}" y2="${dy}" stroke="${p.grid}" stroke-width="1"/>`;
      })
      .join("");

    const labelsSvg = rowLabels
      .map((rl) => {
        const cy = pTop + (rl.row + 0.5) * laneH + 3.8;
        return `<text x="${W - 2}" y="${cy.toFixed(1)}" text-anchor="end" font-size="10.5" font-weight="700" fill="${rl.color}">${rl.label}</text>`;
      })
      .join("");

    const defsParts = [
      `<filter id="slp-glow-${uid}" x="-25%" y="-35%" width="150%" height="190%">
         <feGaussianBlur stdDeviation="4.5"/>
       </filter>`,
    ];
    Object.entries(stageCfg).forEach(([k, sc]) => {
      defsParts.push(`
        <linearGradient id="slp-fill-${uid}-${k}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${sc.topC}"/>
          <stop offset="100%" stop-color="${sc.botC}"/>
        </linearGradient>
      `);
    });

    const glowSvg = [];
    const bridgesSvg = [];
    const blocksSvg = [];
    const slotZones = [];
    const maxGapMs = 20 * 60 * 1000;
    const rFree = 5.5;
    const bridgeW = 2.0;
    const halfB = bridgeW / 2;

    // 1. Pre-compute monotonically non-overlapping screen X intervals [rawX1, rawX2] with min width 1.4px
    const rawCoords = stages.map((st) => {
      const x1 = mapX(st.start_ms);
      const x2 = Math.max(x1 + 1.4, mapX(st.end_ms));
      return { x1, x2 };
    });
    for (let i = 1; i < rawCoords.length; i += 1) {
      const gapMs = Number(stages[i].start_ms) - Number(stages[i - 1].end_ms);
      if (gapMs <= maxGapMs) {
        // Snap contiguous transition boundary so block[i-1].x2 === block[i].x1
        const midX = rawCoords[i - 1].x2;
        rawCoords[i].x1 = midX;
        if (rawCoords[i].x2 < midX + 1.4) {
          rawCoords[i].x2 = midX + 1.4;
        }
      }
    }

    for (let i = 0; i < stages.length; i += 1) {
      const st = stages[i];
      const cfg = stageCfg[st.stage] || stageCfg.light;
      let x1 = rawCoords[i].x1;
      let x2 = rawCoords[i].x2;
      const y = rowY(cfg.row);

      let rTL = rFree;
      let rTR = rFree;
      let rBR = rFree;
      let rBL = rFree;

      if (i > 0) {
        const prev = stages[i - 1];
        const prevCfg = stageCfg[prev.stage] || stageCfg.light;
        if (cfg.row !== prevCfg.row && Number(st.start_ms) - Number(prev.end_ms) <= maxGapMs) {
          x1 -= halfB;
          if (prevCfg.row < cfg.row) rTL = 0;
          else rBL = 0;
        }
      }

      if (i < stages.length - 1) {
        const nxt = stages[i + 1];
        const nxtCfg = stageCfg[nxt.stage] || stageCfg.light;
        const gapMs = Number(nxt.start_ms) - Number(st.end_ms);
        if (cfg.row !== nxtCfg.row && gapMs <= maxGapMs) {
          const xTrans = rawCoords[i].x2;
          x2 = xTrans + halfB;
          if (nxtCfg.row > cfg.row) rBR = 0;
          else rTR = 0;

          const topCfg = cfg.row < nxtCfg.row ? cfg : nxtCfg;
          const botCfg = cfg.row < nxtCfg.row ? nxtCfg : cfg;
          const gapTop = rowY(topCfg.row) + rowH;
          const gapBot = rowY(botCfg.row);
          const gradId = `slp-g-${uid}-${i}`;
          const cTop = topCfg.botC;
          const cBot = botCfg.topC;
          const cMix25 = blendHex(cTop, cBot, 0.25);
          const cMix50 = blendHex(cTop, cBot, 0.50);
          const cMix75 = blendHex(cTop, cBot, 0.75);
          defsParts.push(`
            <linearGradient id="${gradId}" gradientUnits="userSpaceOnUse" x1="0" y1="${gapTop.toFixed(2)}" x2="0" y2="${gapBot.toFixed(2)}">
              <stop offset="0%" stop-color="${cTop}" stop-opacity="1"/>
              <stop offset="25%" stop-color="${cMix25}" stop-opacity="0.96"/>
              <stop offset="50%" stop-color="${cMix50}" stop-opacity="0.94"/>
              <stop offset="75%" stop-color="${cMix75}" stop-opacity="0.96"/>
              <stop offset="100%" stop-color="${cBot}" stop-opacity="1"/>
            </linearGradient>
          `);
          const gyTop = gapTop - 0.6;
          const gyBot = gapBot + 0.6;
          const bx = xTrans - halfB;
          const bh = Math.max(2, gyBot - gyTop);
          const staggerMs = Math.min(280, Math.round((i / Math.max(stages.length, 1)) * 240));
          bridgesSvg.push(`<rect class="svg-sleep-bridge" style="--stagger:${staggerMs}ms" data-bprev="${i}" data-bnext="${i + 1}" x="${bx.toFixed(2)}" y="${gyTop.toFixed(2)}" width="${bridgeW.toFixed(2)}" height="${bh.toFixed(2)}" fill="url(#${gradId})"/>`);
        }
      }

      const bw = Math.max(bridgeW, x2 - x1);
      const dPath = sleepBlockPath(x1, y, bw, rowH, rTL, rTR, rBR, rBL);
      const blockStaggerMs = Math.min(280, Math.round((i / Math.max(stages.length, 1)) * 240));
      const glowOp = p.dark ? "0.55" : "0.44";
      glowSvg.push(`<path class="svg-sleep-glow" style="--stagger:${blockStaggerMs}ms;--glow-op:${glowOp}" data-glow-slot="${i}" data-base-op="${glowOp}" opacity="${glowOp}" transform="translate(0, 1.8)" d="${dPath}" fill="${cfg.color}"/>`);
      blocksSvg.push(`<path class="svg-sleep-block" style="--stagger:${blockStaggerMs}ms" data-slot="${i}" data-base-op="1" opacity="1" d="${dPath}" fill="url(#slp-fill-${uid}-${st.stage})"/>`);
      slotZones.push({
        index: i,
        cx: (x1 + x2) / 2,
        stage: st,
        label: cfg.label,
      });
    }

    const defaultHero = {
      kicker: data.hero?.kicker || "夜间睡眠总时长",
      primary: data.hero?.primary || "-",
      unit: "",
      sub: getDefaultHeroSub(data),
    };

    wrapEl.innerHTML = `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        <defs>${defsParts.join("")}</defs>
        ${dividersSvg}
        ${timeTicks.join("")}
        ${labelsSvg}
        <g filter="url(#slp-glow-${uid})">${glowSvg.join("")}</g>
        ${bridgesSvg.join("")}
        ${blocksSvg.join("")}
        <g class="scrub-cursor-line" opacity="0">
          <line x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text}" stroke-width="1.5"/>
          <circle cx="0" cy="${pTop}" r="3.5" fill="${p.indigo}" stroke="${p.surfaceSolid}" stroke-width="1.4"/>
        </g>
      </svg>
    `;

    const svgEl = wrapEl.querySelector("svg");
    attachScrubHandlers(svgEl, slotZones, defaultHero, (hit) => {
      const sIso = hit.stage.start_iso ? hit.stage.start_iso.slice(11, 16) : new Date(hit.stage.start_ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
      const eIso = hit.stage.end_iso ? hit.stage.end_iso.slice(11, 16) : new Date(hit.stage.end_ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Shanghai" });
      return {
        kicker: `${hit.label} · ${sIso} – ${eIso}`,
        primary: fmtMinHmCn(hit.stage.min),
        unit: "",
        sub: hit.stage.vitals || "该阶段暂无分时体征采样",
      };
    });
  }

  function drawSleepSummaryBarsSvg(wrapEl, slp, p) {
    if (!slp) {
      wrapEl.innerHTML = '<div class="empty-inline-box">当晚暂无睡眠明细</div>';
      return;
    }
    const items = [
      { label: "核心睡眠", min: Number(slp.light_min || 0), color: p.lightSleep },
      { label: "深度睡眠", min: Number(slp.deep_min || 0), color: p.deep },
      { label: "快速眼动 (REM)", min: Number(slp.rem_min || 0), color: p.rem },
      { label: "清醒", min: Number(slp.awake_min || 0), color: p.awake },
    ];
    const tot = Math.max(items.reduce((a, b) => a + b.min, 0), 1);
    wrapEl.innerHTML = `
      <div class="sleep-amount-list">
        ${items
          .map((it) => {
            const pct = Math.round((it.min / tot) * 100);
            const barW = Math.max(4, Math.min(100, (it.min / tot) * 100));
            return `
              <div class="sleep-amount-item">
                <div class="sleep-amount-head">
                  <span class="sleep-amount-left">
                    <span class="sleep-amount-dot" style="background:${it.color}"></span>
                    <span class="sleep-amount-name">${escapeHtml(it.label)}</span>
                  </span>
                  <span class="sleep-amount-val">${fmtMinHmCn(it.min)}<span class="sleep-amount-pct">(${pct}%)</span></span>
                </div>
                <div class="sleep-amount-track">
                  <div class="sleep-amount-fill" style="width:${barW.toFixed(1)}%;background:${it.color}"></div>
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Apple Fitness Activity Rings Detail View (Week Strip + 24h Tri-Chart)
  // -----------------------------------------------------------------------

  function drawMini24hSvg(hours, getter, color, unitSuffix, p) {
    const W = 320;
    const H = 104;
    const pLeft = 4;
    const pRight = W - 26;
    const pTop = 8;
    const pBot = H - 18;
    const vals = hours.map((h) => Number(getter(h) || 0));
    const maxV = Math.max(...vals, 1);
    const slotW = (pRight - pLeft) / 24;
    const barW = Math.max(4, slotW * 0.58);

    const bars = vals
      .map((v, idx) => {
        const hPx = v > 0 ? Math.max(3, (v / maxV) * (pBot - pTop)) : 2;
        const x = (pLeft + (idx + 0.5) * slotW - barW / 2).toFixed(1);
        const y = (pBot - hPx).toFixed(1);
        const op = v > 0 ? "0.95" : "0.18";
        const staggerMs = idx * 10;
        return `<rect class="svg-bar-grow" style="--stagger:${staggerMs}ms" x="${x}" y="${y}" width="${barW.toFixed(1)}" height="${hPx.toFixed(1)}" rx="${(barW / 2).toFixed(1)}" fill="${v > 0 ? color : p.text3}" opacity="${op}"/>`;
      })
      .join("");

    const ticks = [0, 6, 12, 18]
      .map((h) => {
        const x = (pLeft + (h + 0.5) * slotW).toFixed(1);
        return `<text x="${x}" y="${H - 4}" text-anchor="middle" font-size="9.5" font-weight="600" fill="${p.text2}">${h}时</text>`;
      })
      .join("");

    return `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        <line x1="${pLeft}" y1="${pTop}" x2="${pRight}" y2="${pTop}" stroke="${p.grid}" stroke-width="1" stroke-dasharray="2 2"/>
        <text x="${W - 1}" y="${pTop + 4}" text-anchor="end" font-size="9.5" font-weight="600" fill="${p.text2}">${Math.round(maxV)}${unitSuffix}</text>
        ${bars}
        ${ticks}
      </svg>
    `;
  }

  function renderActivityDetailView(body, data, navDir = "initial") {
    const p = getThemePalette();
    const rg = data.rings || {};
    const week = data.week_strip || [];
    const hours = data.hourly || [];
    const isUpdate = navDir !== "initial";
    const cardAnim = navDir === "resize" ? "" : (isUpdate ? "chart-crossfade" : "stagger-card");
    const weekCardAnim = navDir === "resize" || isUpdate ? "" : "stagger-card";

    const weekCardHtml = `
      <div class="fitness-week-card ${weekCardAnim}" style="--card-idx:0">
        <div class="period-stepper" style="margin-bottom:4px;">
          <button id="act-prev-wk" class="stepper-arrow" type="button" ${data.prev_week_end ? "" : "disabled"}>‹</button>
          <div class="stepper-label">${escapeHtml(data.range_label)}</div>
          <button id="act-next-wk" class="stepper-arrow" type="button" ${data.next_week_end ? "" : "disabled"}>›</button>
        </div>
        <div class="fitness-week-grid">
          ${week
            .map(
              (d) => `
            <button class="week-day-btn ${d.is_selected ? "selected" : ""} ${d.is_future ? "future" : ""}" data-date="${d.date}" ${d.is_future ? "disabled" : ""} type="button">
              <span class="wk-name">${escapeHtml(d.weekday)}</span>
              ${renderMiniRingIcon(d.move_kcal / Math.max(d.move_goal, 1), d.ex_min / d.ex_goal, d.stand_hrs / d.stand_goal)}
              <span class="wk-num">${d.day_num}</span>
            </button>
          `
            )
            .join("")}
        </div>
      </div>
    `;

    const bigRingsHtml = `
      <div class="fitness-big-rings-card ${cardAnim}" style="--card-idx:1">
        <div class="fitness-big-svg-wrap">
          ${renderActivityRingsSvg(rg.move_kcal / Math.max(rg.move_goal, 1), rg.ex_min / Math.max(rg.ex_goal, 1), rg.stand_hrs / Math.max(rg.stand_goal, 1))}
        </div>
        <div class="fitness-tri-stats">
          <div class="tri-stat-box">
            <div class="tri-stat-lbl" style="color:var(--ring-move)">活动</div>
            <div class="tri-stat-num">${fmtNum(rg.move_kcal, 0)}</div>
            <div class="tri-stat-goal">/ ${fmtNum(rg.move_goal, 0)} 千卡</div>
          </div>
          <div class="tri-stat-box">
            <div class="tri-stat-lbl" style="color:var(--ring-ex)">锻炼</div>
            <div class="tri-stat-num">${fmtNum(rg.ex_min, 0)}</div>
            <div class="tri-stat-goal">/ ${rg.ex_goal} 分钟</div>
          </div>
          <div class="tri-stat-box">
            <div class="tri-stat-lbl" style="color:var(--ring-stand)">活跃</div>
            <div class="tri-stat-num">${fmtNum(rg.stand_hrs, 0)}</div>
            <div class="tri-stat-goal">/ ${rg.stand_goal} 小时</div>
          </div>
        </div>
        <div class="sleep-hero-foot" style="justify-content:center;">
          <span>总步数 ${fmtNum(rg.steps)} 步</span>
          <span>距离 ${fmtNum(rg.distance_km, 2)} km</span>
          ${rg.basal_kcal ? `<span>静息基础消耗 ${fmtNum(rg.basal_kcal, 0)} kcal</span>` : ""}
        </div>
      </div>
    `;

    const hourlyHtml = data.hourly_available
      ? `
        <div class="hourly-triple-grid ${cardAnim}" style="--card-idx:2">
          <div class="hourly-mini-card">
            <div class="metric-title" style="color:var(--ring-move);margin-bottom:6px;">活动热量 · 逐时</div>
            ${drawMini24hSvg(hours, (h) => h.move_kcal, p.move, "", p)}
          </div>
          <div class="hourly-mini-card">
            <div class="metric-title" style="color:var(--ring-ex);margin-bottom:6px;">中高强度锻炼 · 逐时</div>
            ${drawMini24hSvg(hours, (h) => h.ex_min, p.ex, "m", p)}
          </div>
          <div class="hourly-mini-card">
            <div class="metric-title" style="color:var(--ring-stand);margin-bottom:6px;">活跃小时 · 24h</div>
            ${drawMini24hSvg(hours, (h) => (h.stand ? 1 : 0), p.stand, "", p)}
          </div>
        </div>
      `
      : `<div class="card ${cardAnim}" style="--card-idx:2"><div class="card-note">该历史日期仅存每日圆环汇总（分小时步数/热量仅保留近期约 32 天）。</div></div>`;

    const wos = data.workouts || [];
    const woCardHtml = `
      <div class="card grouped-card ${cardAnim}" style="--card-idx:3">
        <div class="card-header" style="padding:14px 18px 8px;margin-bottom:0;">
          <h3 class="card-title">当日体能训练</h3>
          <span class="card-note">${wos.length} 次</span>
        </div>
        ${
          wos.length
            ? wos
                .map(
                  (w) => `
                <button class="grouped-row" data-wid="${w.workout_id}" type="button">
                  <div class="grouped-row-left">
                    <div class="wo-sport-badge">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="5" r="2"/><path d="M7 21l3-6 2.5 1.5L15 21"/><path d="M6 12l4-3 3 2 4-3"/></svg>
                    </div>
                    <div>
                      <div class="grouped-title">${escapeHtml(w.sport_name)} ${w.has_gps ? '<span class="gps-pill">GPS</span>' : ""}</div>
                      <div class="grouped-sub">${escapeHtml((w.start_iso || "").slice(11, 16))} · 时长 ${fmtDurationSec(w.duration_s)}</div>
                    </div>
                  </div>
                  <div class="grouped-row-right">
                    <div class="grouped-val">${w.distance_m ? (w.distance_m / 1000).toFixed(2) + " km" : fmtNum(w.calories_kcal, 0) + " kcal"}</div>
                    <div class="grouped-meta">查看轨迹 ›</div>
                  </div>
                </button>
              `
                )
                .join("")
            : '<div style="padding:14px 18px;" class="card-note">当日暂无独立记录的体能训练</div>'
        }
      </div>
    `;

    body.innerHTML = weekCardHtml + bigRingsHtml + hourlyHtml + woCardHtml;
    body.dataset.mountedMetric = "activity";

    body.querySelectorAll(".week-day-btn:not([disabled])").forEach((b) => {
      b.addEventListener("click", () => {
        if (!detailState) return;
        detailState.endDate = b.dataset.date;
        fetchAndRenderMetricDetail();
      });
    });

    const pWk = $("act-prev-wk");
    const nWk = $("act-next-wk");
    if (pWk) {
      pWk.addEventListener("click", () => {
        if (data.prev_week_end && detailState) {
          detailState.endDate = data.prev_week_end;
          fetchAndRenderMetricDetail();
        }
      });
    }
    if (nWk) {
      nWk.addEventListener("click", () => {
        if (data.next_week_end && detailState) {
          detailState.endDate = data.next_week_end;
          fetchAndRenderMetricDetail();
        }
      });
    }

    body.querySelectorAll(".grouped-row[data-wid]").forEach((b) => {
      b.addEventListener("click", () => {
        selectedWorkoutId = Number(b.dataset.wid);
        switchTab("workouts", { openDetailId: selectedWorkoutId, originEl: b });
      });
    });
  }

  // -----------------------------------------------------------------------
  // Tab 3: Browse Categories + Daily Snapshot
  // -----------------------------------------------------------------------

  function getBrowseMetricItems(data) {
    const latest = data.latest_day || {};
    const daysDesc = [...(data.recent_14d || data.daily_series || [])].reverse();

    const ringCompletion = [
      [latest.calories_kcal, Number(latest.calorie_goal_kcal) || 300],
      [latest.moderate_high_min, 25],
      [latest.active_hours, 12],
    ].map(([value, goal]) => value == null ? "—" : `${Math.round(Number(value) / goal * 100)}%`).join(" / ");
    const ath = data.athletic_summary || {};
    return [
      { metric: "activity", scope: "D", title: "三环", color: "var(--ring-move)", bg: "rgba(250,17,79,0.12)", val: ringCompletion },
      { metric: "active_energy", scope: "D", title: "活动能量", color: "var(--apple-red)", bg: "rgba(255,59,48,0.12)", val: `${fmtNum(latest.calories_kcal, 0)} 千卡` },
      { metric: "basal_energy", scope: "W", title: "静息能量", color: "var(--apple-orange)", bg: "rgba(255,107,0,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.basal_metabolism_kcal).value, 0)} 千卡` },
      { metric: "steps", scope: "D", title: "步数", color: "var(--apple-orange)", bg: "rgba(255,149,0,0.12)", val: `${fmtNum(latest.steps, 0)} 步` },
      { metric: "distance", scope: "D", title: "步行+跑步距离", color: "var(--apple-orange)", bg: "rgba(255,107,0,0.12)", val: `${fmtNum((latest.distance_m || 0) / 1000, 2)} 公里` },
      { metric: "sleep", scope: "D", title: "睡眠", color: "var(--apple-indigo)", bg: "rgba(88,86,214,0.12)", val: fmtMinHmCn(data.latest_night_sleep?.total_sleep_min ?? latest.sleep_total_min) },
      { metric: "heart_rate", scope: "D", title: "心率", color: "var(--apple-red)", bg: "rgba(255,45,85,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.hr_last ?? d.hr_avg ?? d.hr_rest).value, 0)} 次/分` },
      { metric: "ecg", scope: "W", title: "心电图", color: "var(--apple-red)", bg: "rgba(255,45,85,0.12)", val: "查看记录" },
      { metric: "temperature", scope: "W", title: "温度", color: "var(--apple-orange)", bg: "rgba(255,149,0,0.12)",
        val: [latest.temp_last == null ? "" : `体温 ${fmtNum(latest.temp_last, 1)} °C`,
          latest.skin_temp_baseline_delta == null ? "" : `腕温 ${signedTemperature(latest.skin_temp_baseline_delta)} °C`].filter(Boolean).join(" · ") || "体温与腕温" },
      { metric: "resting_hr", scope: "W", title: "静息心率", color: "var(--apple-red)", bg: "rgba(255,45,85,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.hr_rest).value, 0)} 次/分` },
      { metric: "hrv", scope: "W", title: "心率变异性 (HRV)", color: "var(--apple-green)", bg: "rgba(40,205,65,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.hrv_avg ?? d.hrv_last).value, 1)} 毫秒` },
      { metric: "spo2", scope: "W", title: "血氧饱和度 (SpO₂)", color: "var(--apple-teal)", bg: "rgba(48,176,199,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.spo2_avg).value, 1)}%` },
      { metric: "stress", scope: "W", title: "压力与心理状态", color: "var(--apple-purple)", bg: "rgba(175,82,222,0.12)", val: `${fmtNum(pickLatestValid(daysDesc, (d) => d.stress_avg).value, 1)} 分` },
      { metric: "vo2max", scope: "6M", title: "最大摄氧量 (VO₂ Max)", color: "var(--apple-red)", bg: "rgba(255,59,48,0.12)", val: ath.vo2max?.latest != null ? `${fmtNum(ath.vo2max.latest, 1)} mL/kg·min` : "-" },
      { metric: "training_index", scope: "M", title: "训练指数与负荷", color: "var(--apple-blue)", bg: "rgba(0,122,255,0.12)", val: ath.training_index?.tsb != null ? `${ath.training_index.tsb >= 0 ? "+" : ""}${fmtNum(ath.training_index.tsb, 1)} 分` : "-" },
      { metric: "running_index", scope: "6M", title: "跑步指数 (RAI)", color: "var(--apple-green)", bg: "rgba(40,205,65,0.12)", val: ath.running_index?.latest != null ? `${fmtNum(ath.running_index.latest, 1)} 分` : "-" },
    ];

  }

  function renderBrowseCategories(data) {
    const box = $("browse-categories");
    if (!box || !data) return;
    if (!restoringNavigation) $("tab-browse")?.classList.remove("no-anim-replay");
    const items = getBrowseMetricItems(data);
    const row = (item) => `
      <button class="grouped-row" data-metric="${item.metric}" data-scope="${item.scope}" type="button">
        <div class="grouped-row-left">
          <div class="cat-icon-box" style="background:${item.bg};color:${item.color}">
            ${appleCategoryIconSvg(item.metric)}
          </div>
          <div class="grouped-title">${escapeHtml(item.title)}</div>
        </div>
        <div class="grouped-row-right">
          <div class="grouped-val">${escapeHtml(item.val)} ›</div>
        </div>
      </button>`;
    box.innerHTML = items.map(row).join("");

    box.querySelectorAll(".grouped-row").forEach((b) => {
      b.addEventListener("click", () => {
        openMetricDetail(b.dataset.metric, { scope: b.dataset.scope, fromTab: "browse" }, b);
      });
    });
    browseRenderedRef = data;
  }

  async function fetchDaySnapshotData(dateStr = "") {
    const key = dateStr || "";
    if (daySnapshotCache.has(key)) return daySnapshotCache.get(key);
    if (daySnapshotInflight.has(key)) return daySnapshotInflight.get(key);
    const epoch = preloadEpoch;
    const url = key ? `/api/v1/dashboard/day?date=${encodeURIComponent(key)}` : "/api/v1/dashboard/day";
    const req = apiJson(url)
      .then((data) => {
        if (epoch === preloadEpoch) {
          cacheMapSet(daySnapshotCache, key, data, 14);
          if (data?.date) cacheMapSet(daySnapshotCache, data.date, data, 14);
        }
        return data;
      })
      .finally(() => {
        if (daySnapshotInflight.get(key) === req) daySnapshotInflight.delete(key);
      });
    daySnapshotInflight.set(key, req);
    return req;
  }

  async function loadDaySnapshot(dateStr) {
    const data = await fetchDaySnapshotData(dateStr || "");
    dayCache = data;
    if (data.empty) return;

    selectedDay = data.date;
    $("day-picker").value = data.date;
    $("day-prev-btn").disabled = !data.prev_date;
    $("day-prev-btn").dataset.date = data.prev_date || "";
    $("day-next-btn").disabled = !data.next_date;
    $("day-next-btn").dataset.date = data.next_date || "";

    const seriesForPills = overviewCache?.recent_14d || overviewCache?.daily_series || [];
    if (seriesForPills.length) {
      const recent = seriesForPills.slice(-10).reverse();
      $("recent-day-pills").innerHTML = recent
        .map((r) => `<button class="chip-pill ${r.date === data.date ? "active" : ""}" data-day="${r.date}" type="button">${r.date.slice(5)}</button>`)
        .join("");
      $("recent-day-pills").querySelectorAll(".chip-pill").forEach((b) => {
        b.addEventListener("click", () => loadDaySnapshot(b.dataset.day));
      });
    }

    const d = data.daily || {};
    const tiles = [
      { metric: "steps", color: "var(--apple-orange)", lbl: "步数", val: `${fmtNum(d.steps)} 步` },
      { metric: "activity", color: "var(--ring-move)", lbl: "活动热量", val: `${fmtNum(d.calories_kcal, 0)} 千卡` },
      { metric: "sleep", color: "var(--apple-indigo)", lbl: "睡眠 / 评分", val: `${fmtMinHm(d.sleep_total_min)} · ${fmtNum(d.sleep_score, 0)}` },
      { metric: "heart_rate", color: "var(--apple-red)", lbl: "心率 (静/极值)", val: `${fmtNum(d.hr_rest, 0)} (${fmtNum(d.hr_min, 0)}~${fmtNum(d.hr_max, 0)})` },
      { metric: "hrv", color: "var(--apple-green)", lbl: "HRV 均值", val: `${fmtNum(d.hrv_avg ?? d.hrv_last, 1)} 毫秒` },
      { metric: "spo2", color: "var(--apple-teal)", lbl: "血氧 均 / 低", val: `${fmtNum(d.spo2_avg, 1)}% / ${fmtNum(d.spo2_min, 0)}%` },
      { metric: "stress", color: "var(--apple-purple)", lbl: "压力 均 / 峰", val: `${fmtNum(d.stress_avg, 1)} / ${fmtNum(d.stress_max, 0)}` },
      { metric: "activity", color: "var(--ring-ex)", lbl: "锻炼 / 活跃", val: `${fmtNum(d.moderate_high_min, 0)}分 · ${fmtNum(d.active_hours, 0)}小时` },
    ];
    $("day-strip").innerHTML = tiles
      .map(
        (t) => `
      <div class="day-tile interactive-card" data-metric="${t.metric}" role="button" tabindex="0">
        <div class="day-tile-lbl" style="color:${t.color}"><span class="metric-icon-inline">${appleCategoryIconSvg(t.metric)}</span><span>${t.lbl}</span></div>
        <div class="day-tile-val">${t.val}</div>
      </div>
    `
      )
      .join("");

    $("day-strip").querySelectorAll(".day-tile").forEach((el) => {
      el.addEventListener("click", () => {
        openMetricDetail(el.dataset.metric, { scope: "D", endDate: selectedDay, fromTab: "browse" }, el);
      });
    });
    dayRenderedDate = data.date || "";
  }

  $("day-picker").addEventListener("change", (e) => {
    if (e.target.value) loadDaySnapshot(e.target.value);
  });
  $("day-prev-btn").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.date) loadDaySnapshot(e.currentTarget.dataset.date);
  });
  $("day-next-btn").addEventListener("click", (e) => {
    if (e.currentTarget.dataset.date) loadDaySnapshot(e.currentTarget.dataset.date);
  });

  // -----------------------------------------------------------------------
  // Tab 2: Apple Fitness Workouts List & Pixel-Exact Detail View
  // -----------------------------------------------------------------------

  function workoutIconSvg(sportName) {
    const s = String(sportName || "");
    if (s.includes("骑")) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6a1 1 0 1 0 2 0 1 1 0 0 0-2 0"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/></svg>';
    }
    if (s.includes("力量") || s.includes("器械")) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5v11M17.5 6.5v11M3 9v6M21 9v6M6.5 12h11"/></svg>';
    }
    if (s.includes("步")) {
      return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2"/><path d="M10 21l2-6 3 2 1 4"/><path d="M8 13l4-4 3 3 2-1"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="5" r="2"/><path d="M7 21l3-6 2.5 1.5L15 21"/><path d="M6 12l4-3 3 2 4-3"/><path d="M10 9l-1 5"/></svg>';
  }

  function fmtPaceNoUnit(sPerKm) {
    if (!sPerKm || sPerKm <= 0) return "-";
    const total = Math.round(Number(sPerKm));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}'${String(s).padStart(2, "0")}"`;
  }

  function isCyclingWorkout(d) {
    const id = Number(d?.sport_type_id);
    const name = String(d?.sport_name || "");
    return id === 259 || id === 260 || name.includes("骑");
  }

  function isSwimmingWorkout(d) {
    const id = Number(d?.sport_type_id);
    const name = String(d?.sport_name || "");
    return id === 262 || id === 266 || name.includes("泳");
  }

  function paceToSpeedKmh(sPerKm) {
    const v = Number(sPerKm);
    return Number.isFinite(v) && v > 0 ? 3600 / v : null;
  }

  function fmtSpeedKmh(sPerKm) {
    const kmh = paceToSpeedKmh(sPerKm);
    return kmh == null ? "-" : `${kmh.toFixed(1)} km/h`;
  }

  function fmtSpeedKmhVal(sPerKm) {
    const kmh = paceToSpeedKmh(sPerKm);
    return kmh == null ? "-" : kmh.toFixed(1);
  }

  function paceToPer100m(sPerKm) {
    const v = Number(sPerKm);
    return Number.isFinite(v) && v > 0 ? v / 10 : null;
  }

  function fmtSwimPaceNoUnit(sPerKm) {
    const v = paceToPer100m(sPerKm);
    return v == null ? "-" : fmtPaceNoUnit(v);
  }

  function fmtSwimPace(sPerKm) {
    const v = paceToPer100m(sPerKm);
    return v == null ? "-" : `${fmtPaceNoUnit(v)}/百米`;
  }

  function fmtWorkoutPace(w, sPerKm) {
    if (isCyclingWorkout(w)) return fmtSpeedKmh(sPerKm);
    if (isSwimmingWorkout(w)) return fmtSwimPace(sPerKm);
    return fmtPace(sPerKm);
  }

  function renderWorkoutPace(d, palette) {
    const card = $("wo-pace-card");
    const isCycling = isCyclingWorkout(d);
    if (isCycling) {
      let series = (d.gps_track || [])
        .filter((pt) => Number.isFinite(pt.elapsed_s) && (pt.speed_kmh > 0 || pt.pace_s_per_km > 0))
        .map((pt) => ({
          ...pt,
          speed_kmh: pt.speed_kmh > 0 ? Number(pt.speed_kmh) : paceToSpeedKmh(pt.pace_s_per_km),
        }))
        .filter((pt) => Number.isFinite(pt.speed_kmh) && pt.speed_kmh > 0);
      let source = "轨迹速度";
      if (series.length < 2) {
        let elapsed = 0;
        series = (d.splits || []).filter((s) => s.sp > 0 && s.sd > 0).map((s) => {
          elapsed += Number(s.sd) / 100000 * Number(s.sp);
          return { elapsed_s: elapsed, speed_kmh: paceToSpeedKmh(s.sp), time: fmtDurationSec(elapsed) };
        }).filter((pt) => Number.isFinite(pt.speed_kmh) && pt.speed_kmh > 0);
        source = "分段均值 · 估算用时";
      }
      card.classList.toggle("hidden", series.length < 2);
      if (series.length < 2) return;
      const avgSpeed = paceToSpeedKmh(d.pace_avg_s_per_km)
        ?? (d.distance_m > 0 && d.duration_s > 0 ? (d.distance_m / d.duration_s) * 3.6 : null);
      const label = avgSpeed != null ? `平均 ${avgSpeed.toFixed(1)} km/h · ${source}` : source;
      const best = `最高速度 ${Math.max(...series.map((pt) => pt.speed_kmh)).toFixed(1)} km/h`;
      card.innerHTML = `<div class="card-header" style="margin-bottom:8px"><div>
        <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-cyan)"></span>速度曲线（km/h）</h3>
        <p id="wo-pace-readout" class="card-note" data-default="${escapeHtml(label)}">${escapeHtml(label)}</p></div>
        <span class="status-pill" style="color:var(--fit-cyan)">${escapeHtml(best)}</span></div>
        <div class="svg-chart-wrap"></div>`;
      drawWorkoutLineChartSvg(card.querySelector(".svg-chart-wrap"), {
        series, getX: (pt) => pt.elapsed_s, getY: (pt) => pt.speed_kmh,
        color: "var(--fit-cyan)", cursorPrefix: "wo-speed", readoutElId: "wo-pace-readout",
        estimated: source.startsWith("分段"), invertY: false, fallbackMin: 0, fallbackMax: 40,
        formatTick: (v) => Number(v).toFixed(v >= 100 ? 0 : 1),
        formatScrub: (pt, value) => `${pt.time} · ${Number(value).toFixed(1)} km/h`,
      }, palette);
      return;
    }

    if (isSwimmingWorkout(d)) {
      let series = (d.gps_track || [])
        .filter((pt) => Number.isFinite(pt.elapsed_s) && (pt.pace_s_per_100m > 0 || pt.pace_s_per_km > 0))
        .map((pt) => ({
          ...pt,
          pace_s_per_100m: pt.pace_s_per_100m > 0 ? Number(pt.pace_s_per_100m) : paceToPer100m(pt.pace_s_per_km),
        }))
        .filter((pt) => Number.isFinite(pt.pace_s_per_100m) && pt.pace_s_per_100m > 0);
      let source = "轨迹配速";
      if (series.length < 2) {
        let elapsed = 0;
        series = (d.splits || []).filter((s) => s.sp > 0 && s.sd > 0).map((s) => {
          elapsed += Number(s.st) > 0 ? Number(s.st) : (Number(s.sd) / 100000 * Number(s.sp));
          return { elapsed_s: elapsed, pace_s_per_100m: paceToPer100m(s.sp), time: fmtDurationSec(elapsed) };
        }).filter((pt) => Number.isFinite(pt.pace_s_per_100m) && pt.pace_s_per_100m > 0);
        source = "分段均值 · 估算用时";
      }
      card.classList.toggle("hidden", series.length < 2);
      if (series.length < 2) return;
      const label = d.pace_avg_s_per_km > 0 ? "平均 " + fmtSwimPace(d.pace_avg_s_per_km) + " · " + source : source;
      const best = "最高配速 " + fmtPaceNoUnit(Math.min(...series.map((pt) => pt.pace_s_per_100m))) + "/百米";
      card.innerHTML = `<div class="card-header" style="margin-bottom:8px"><div>
        <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-cyan)"></span>配速曲线（/百米）</h3>
        <p id="wo-pace-readout" class="card-note" data-default="${escapeHtml(label)}">${escapeHtml(label)}</p></div>
        <span class="status-pill" style="color:var(--fit-cyan)">${escapeHtml(best)}</span></div>
        <div class="svg-chart-wrap"></div>`;
      drawWorkoutLineChartSvg(card.querySelector(".svg-chart-wrap"), {
        series, getX: (pt) => pt.elapsed_s, getY: (pt) => pt.pace_s_per_100m,
        color: "var(--fit-cyan)", cursorPrefix: "wo-swim-pace", readoutElId: "wo-pace-readout",
        estimated: source.startsWith("分段"), invertY: true, formatTick: (v) => (v === 0 ? "0:00" : fmtPaceNoUnit(v)),
        formatScrub: (pt, value) => `${pt.time} · ${fmtPaceNoUnit(value)}/百米`,
      }, palette);
      return;
    }

    let series = (d.gps_track || []).filter(pt => Number.isFinite(pt.elapsed_s) && pt.pace_s_per_km > 0);
    let source = "轨迹配速";
    if (series.length < 2) {
      let elapsed = 0;
      series = (d.splits || []).filter(s => s.sp > 0 && s.sd > 0).map(s => {
        elapsed += Number(s.sd) / 100000 * Number(s.sp);
        return { elapsed_s: elapsed, pace_s_per_km: Number(s.sp), time: fmtDurationSec(elapsed) };
      });
      source = "分段均值 · 估算用时";
    }
    card.classList.toggle("hidden", series.length < 2);
    if (series.length < 2) return;
    const label = d.pace_avg_s_per_km > 0 ? "平均 " + fmtPace(d.pace_avg_s_per_km) + " · " + source : source;
    const best = "最高配速 " + fmtPaceNoUnit(Math.min(...series.map(pt=>pt.pace_s_per_km)));
    card.innerHTML = `<div class="card-header" style="margin-bottom:8px"><div>
      <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-cyan)"></span>配速曲线</h3>
      <p id="wo-pace-readout" class="card-note" data-default="${escapeHtml(label)}">${escapeHtml(label)}</p></div>
      <span class="status-pill" style="color:var(--fit-cyan)">${escapeHtml(best)}</span></div>
      <div class="svg-chart-wrap"></div>`;
    drawWorkoutLineChartSvg(card.querySelector(".svg-chart-wrap"), {
      series, getX: pt => pt.elapsed_s, getY: pt => pt.pace_s_per_km,
      color: "var(--fit-cyan)", cursorPrefix: "wo-pace", readoutElId: "wo-pace-readout",
      estimated:source.startsWith("分段"), invertY: true, formatTick: v => v === 0 ? "0:00" : fmtPaceNoUnit(v),
      formatScrub: (pt, value) => pt.time + " · " + fmtPace(value),
    }, palette);
  }

  function smoothTrackPaces(pts, fallbackPace) {
    const raw = pts.map((pt) => (pt.pace_s_per_km != null && pt.pace_s_per_km > 0 ? Number(pt.pace_s_per_km) : null));
    const valid = raw.filter((v) => v != null).sort((a, b) => a - b);
    const med = valid.length ? valid[Math.floor(valid.length / 2)] : (fallbackPace || 330);
    const clamped = raw.map((v) => {
      if (v == null) return med;
      return Math.max(med * 0.72, Math.min(med * 1.28, v));
    });

    // 9-point moving median filter to reject transient GPS dropout spikes
    const medFiltered = clamped.map((_, idx) => {
      const win = clamped.slice(Math.max(0, idx - 4), Math.min(clamped.length, idx + 5)).sort((a, b) => a - b);
      return win[Math.floor(win.length / 2)];
    });

    // 5 passes of 15-point Gaussian filter for buttery pace transitions
    const kernel = [1, 2, 4, 7, 11, 16, 20, 22, 20, 16, 11, 7, 4, 2, 1];
    const half = 7;
    let cur = medFiltered;
    for (let pass = 0; pass < 5; pass += 1) {
      cur = cur.map((_, idx) => {
        let sumW = 0;
        let sumV = 0;
        for (let k = -half; k <= half; k += 1) {
          const j = idx + k;
          if (j >= 0 && j < cur.length) {
            const w = kernel[k + half];
            sumW += w;
            sumV += cur[j] * w;
          }
        }
        return sumV / Math.max(sumW, 1);
      });
    }
    return cur;
  }

  function paceToSmoothColor(pace, fastPace, slowPace) {
    if (!pace || slowPace <= fastPace) return "#FFD60A";
    const t = Math.max(0, Math.min(1, (pace - fastPace) / (slowPace - fastPace)));
    const stops = [
      { t: 0.0, c: "#28CD41" },
      { t: 0.17, c: "#56D832" },
      { t: 0.33, c: "#A8E01E" },
      { t: 0.50, c: "#FFD60A" },
      { t: 0.66, c: "#FF9F0A" },
      { t: 0.83, c: "#FF6B1A" },
      { t: 1.0, c: "#FF3B30" },
    ];
    for (let i = 0; i < stops.length - 1; i += 1) {
      if (t <= stops[i + 1].t) {
        let localT = (t - stops[i].t) / (stops[i + 1].t - stops[i].t);
        localT = localT * localT * (3 - 2 * localT);
        return blendHex(stops[i].c, stops[i + 1].c, localT);
      }
    }
    return stops[stops.length - 1].c;
  }

  function smoothGpsCoords(pts) {
    const n = pts.length;
    if (n < 7) return pts;
    const kernel = [1, 3, 6, 7, 6, 3, 1];
    const half = 3;
    let cur = pts;
    for (let pass = 0; pass < 5; pass += 1) {
      cur = cur.map((pt, idx) => {
        if (idx === 0 || idx === n - 1) return pt;
        let sw = 0;
        let slat = 0;
        let slon = 0;
        for (let k = -half; k <= half; k += 1) {
          const j = idx + k;
          if (j >= 0 && j < n) {
            const wt = kernel[k + half];
            sw += wt;
            slat += cur[j].lat * wt;
            slon += cur[j].lon * wt;
          }
        }
        return { ...pt, lat: slat / sw, lon: slon / sw };
      });
    }
    return cur;
  }

  function catmullRomSubdivide(pts, paces, subSteps = 2) {
    if (pts.length < 3 || subSteps <= 1) {
      return pts.map((pt, idx) => ({ lat: pt.lat, lon: pt.lon, pace: paces[idx] }));
    }
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n - 1; i += 1) {
      const p0 = pts[Math.max(0, i - 1)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(n - 1, i + 2)];
      const pa = paces[i];
      const pb = paces[i + 1];
      for (let s = 0; s < subSteps; s += 1) {
        const t = s / subSteps;
        const t2 = t * t;
        const t3 = t2 * t;
        const lat = 0.5 * ((2 * p1.lat) + (-p0.lat + p2.lat) * t + (2 * p0.lat - 5 * p1.lat + 4 * p2.lat - p3.lat) * t2 + (-p0.lat + 3 * p1.lat - 3 * p2.lat + p3.lat) * t3);
        const lon = 0.5 * ((2 * p1.lon) + (-p0.lon + p2.lon) * t + (2 * p0.lon - 5 * p1.lon + 4 * p2.lon - p3.lon) * t2 + (-p0.lon + 3 * p1.lon - 3 * p2.lon + p3.lon) * t3);
        out.push({ lat, lon, pace: pa + (pb - pa) * t });
      }
    }
    out.push({ lat: pts[n - 1].lat, lon: pts[n - 1].lon, pace: paces[n - 1] });
    return out;
  }

  async function fetchWorkoutsData(sport = "") {
    const key = sport || "";
    if (workoutsListCache.has(key)) return workoutsListCache.get(key);
    if (workoutsListInflight.has(key)) return workoutsListInflight.get(key);
    const epoch = preloadEpoch;
    const url = key ? `/api/v1/dashboard/workouts?sport=${encodeURIComponent(key)}` : "/api/v1/dashboard/workouts";
    const req = apiJson(url)
      .then((data) => {
        if (epoch === preloadEpoch) cacheMapSet(workoutsListCache, key, data, 8);
        return data;
      })
      .finally(() => {
        if (workoutsListInflight.get(key) === req) workoutsListInflight.delete(key);
      });
    workoutsListInflight.set(key, req);
    return req;
  }

  async function loadWorkouts(sport, opts = {}) {
    const data = await fetchWorkoutsData(sport || "");
    workoutsCache = data;

    const pills = [{ sport_name: "", label: "全部" }].concat(
      (data.sport_breakdown || []).map((s) => ({ sport_name: s.sport_name, label: `${s.sport_name} (${s.count})` }))
    );
    $("sport-filter-pills").innerHTML = pills
      .map((p) => `<button class="chip-pill ${currentSportFilter === p.sport_name ? "active" : ""}" data-sport="${escapeHtml(p.sport_name)}" type="button">${escapeHtml(p.label)}</button>`)
      .join("");

    $("sport-filter-pills").querySelectorAll(".chip-pill").forEach((b) => {
      b.addEventListener("click", () => {
        currentSportFilter = b.dataset.sport;
        selectedWorkoutId = null;
        $("workouts-layout").classList.remove("mobile-detail-open");
        $("app-shell").classList.remove("wo-detail-active");
        loadWorkouts(currentSportFilter);
      });
    });

    const list = data.workouts || [];
    const totDist = list.reduce((a, w) => a + (w.distance_m || 0), 0);
    const totDur = list.reduce((a, w) => a + (w.duration_s || 0), 0);
    const totalsText = `${list.length} 次训练 · ${(totDist / 1000).toFixed(1)} 公里 · ${(totDur / 3600).toFixed(1)} 小时`;
    $("workouts-totals").textContent = totalsText;

    const listEl = $("workout-list");
    workoutsRenderedKey = `${sport || ""}|1`;
    if (!list.length) {
      listEl.innerHTML = '<div class="card"><div class="card-note">该分类暂无运动记录</div></div>';
      return;
    }

    if (opts.openDetailId) {
      selectedWorkoutId = opts.openDetailId;
    } else if (!selectedWorkoutId || !list.some((w) => w.workout_id === selectedWorkoutId)) {
      selectedWorkoutId = list[0].workout_id;
    }

    listEl.innerHTML = list
      .map((w) => {
        const heroMetric = w.distance_m && w.distance_m > 0
          ? `${(w.distance_m / 1000).toFixed(2)} 公里`
          : fmtDurationSec(w.duration_s);
        const metaParts = [];
        if (w.distance_m && w.distance_m > 0) metaParts.push(fmtDurationSec(w.duration_s));
        if (w.pace_avg_s_per_km) metaParts.push(fmtWorkoutPace(w, w.pace_avg_s_per_km));
        else if (w.calories_kcal) metaParts.push(`${fmtNum(w.calories_kcal, 0)} 千卡`);
        if (w.hr_avg) metaParts.push(`${fmtNum(w.hr_avg, 0)} bpm`);
        return `
          <button class="wo-list-item ${w.workout_id === selectedWorkoutId ? "active" : ""}" data-wid="${w.workout_id}" type="button">
            <div class="wo-list-left">
              <div class="wo-list-circle">${workoutIconSvg(w.sport_name)}</div>
              <div>
                <div class="wo-list-sport">
                  <span>${escapeHtml(w.sport_name)}</span>
                  ${w.has_gps ? '<span class="gps-pill">GPS</span>' : ""}
                </div>
                <div class="wo-list-big">${escapeHtml(heroMetric)}</div>
                <div class="wo-list-sub">${escapeHtml(metaParts.join(" · "))}</div>
              </div>
            </div>
            <div class="wo-list-right">${escapeHtml(w.date.slice(5))} ›</div>
          </button>
        `;
      })
      .join("");

    listEl.querySelectorAll(".wo-list-item").forEach((b) => {
      b.addEventListener("click", () => {
        selectedWorkoutId = Number(b.dataset.wid);
        listEl.querySelectorAll(".wo-list-item").forEach((x) => x.classList.toggle("active", Number(x.dataset.wid) === selectedWorkoutId));
        loadWorkoutDetail(selectedWorkoutId, isMobileViewport(), b);
      });
    });

    if (!opts.skipDetail && (opts.openDetailId || !isMobileViewport())) {
      await loadWorkoutDetail(selectedWorkoutId, isMobileViewport() && Boolean(opts.openDetailId));
    }
    if (currentTab === "workouts") {
      list.slice(0, 5).forEach((w) => queueWorkoutPreload(w.workout_id));
    }
  }

  let workoutListScrollY = 0;
  $("wo-back-btn").addEventListener("click", () => requestHealthBack(() => {
    const panel = $("workout-detail-card");
    const listEl = $("workout-list");
    triggerViewTransition(panel, "ios-view-exit-right");
    const finishWoBack = async () => {
      woExitTimer = null;
      if (panel) panel.classList.remove("ios-view-exit-right");
      $("workouts-layout").classList.remove("mobile-detail-open");
      $("app-shell").classList.remove("wo-detail-active");
      const origin=workoutOrigin;
      if(origin){
        currentSportFilter=origin.filter;
        await switchTab(origin.tab);
        if(origin.detail) await openMetricDetail(origin.detail.metric,origin.detail);
        if(origin.pro) await openProInsightsView(origin.pro,origin.tab);
        window.scrollTo({top:origin.y,behavior:"instant"});
        return;
      }
      freezePanelAnimations(listEl);
      window.scrollTo({ top: workoutListScrollY, behavior: "instant" });
    };
    const reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      finishWoBack();
    } else {
      if (woExitTimer) clearTimeout(woExitTimer);
      woExitTimer = setTimeout(finishWoBack, 175);
    }
  }));

  function applyMapTiles() {
    if (!leafletMap || !window.L) return;
    if (activeTileLayer) {
      leafletMap.removeLayer(activeTileLayer);
    }
    const modeKey = manualMapOverride || (getTheme() === "dark" ? "gaode_dark" : "gaode_vec");
    const cfg = MAP_PROVIDERS[modeKey] || MAP_PROVIDERS.gaode_vec;
    const mapEl = $("workout-map");
    if (mapEl) {
      mapEl.classList.toggle("gaode-dark-tiles", Boolean(cfg.darkFilter));
    }
    const layerOpts = { maxZoom: 18, attribution: cfg.attr };
    if (cfg.subdomains) layerOpts.subdomains = cfg.subdomains;
    activeTileLayer = window.L.tileLayer(cfg.url, layerOpts).addTo(leafletMap);
    const btn = $("toggle-map-layer");
    if (btn) {
      btn.disabled = false;
      btn.textContent = `底图：${cfg.label}`;
    }
    return cfg;
  }

  $("toggle-map-layer")?.addEventListener("click", () => {
    const currentKey = manualMapOverride || (getTheme() === "dark" ? "gaode_dark" : "gaode_vec");
    const curIdx = MAP_ORDER.indexOf(currentKey);
    const nextKey = MAP_ORDER[(curIdx + 1) % MAP_ORDER.length];
    manualMapOverride = nextKey;
    const cfg = applyMapTiles();
    if (cfg) showToast(`已切换至：${cfg.label}`);
  });

  function openTrainingOverlay() {
    pushHealthView("overlay", { workoutId: workoutDetailCache.workout_id });
    const dialog=document.createElement("dialog");
    dialog.className="training-overlay";
    dialog.setAttribute("aria-label","横屏训练图表");
    const curves=[...overlaySeries.values()];
    const selected=new Set(curves.slice(0,2));
    dialog.innerHTML=`<div class="overlay-stage"><header><strong>训练曲线</strong><span>各自量程 · 实心最高，空心最低</span><button type="button">关闭</button></header><div class="overlay-legend"></div><svg role="img" aria-label="训练曲线叠加图"></svg><output tabindex="0">拖动查看同一时刻的读数</output></div>`;
    document.body.append(dialog);
    const svg=dialog.querySelector("svg"),legend=dialog.querySelector(".overlay-legend"),out=dialog.querySelector("output");
    let inspect=null;
    const curveEntryTimes = new Map();
    const curveExits = new Map();
    const curveExitDuration = 240;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const draw=()=>{
      const w=svg.clientWidth,h=svg.clientHeight;
      if(!w || !h)return;
      const left=14,right=w-14,top=12,bottom=h-25;
      const duration=curves[0].duration;
      const x=t=>left+(right-left)*t/duration;
      const ticks=[0,.25,.5,.75,1];
      let shapes=ticks.map(f=>`<path d="M${x(duration*f)} ${top}V${bottom}" stroke="currentColor" opacity=".12"/><text x="${x(duration*f)}" y="${h-6}" text-anchor="${f===0?"start":f===1?"end":"middle"}">${fmtDurationSec(duration*f)}</text>`).join("");
      const values=[];
      for(const [index, curve] of curves.entries()){
        const {groups,low,high,color,invertY,format,gap}=curve;
        const exit = curveExits.get(curve);
        if (!selected.has(curve) && !exit) continue;
        const gradientId = "overlay-curve-" + index;
        const y=v=>{const n=high.rawY===low.rawY ? 0.5 : (v-low.rawY)/(high.rawY-low.rawY);return top+(invertY?n:1-n)*(bottom-top);};
        const paths = groups.map(group => group.map((pt, i) =>
          (i ? "L" : "M") + x(pt.s.elapsed_s).toFixed(1) + " " + y(pt.rawY).toFixed(1)
        ).join(" "));
        const area = paths.map((path, i) => {
          const group = groups[i];
          return path + " L" + x(group.at(-1).s.elapsed_s) + " " + bottom
            + " L" + x(group[0].s.elapsed_s) + " " + bottom + " Z";
        }).join(" ");
        const elapsed = performance.now() - (curveEntryTimes.get(curve) ?? -Infinity);
        const entry = exit
          ? ` class="overlay-curve-exit" style="animation-delay:-${performance.now() - exit.start}ms"`
          : elapsed < 360
            ? ` class="overlay-curve-enter" style="animation-delay:-${elapsed}ms"`
            : "";
        if (!entry) curveEntryTimes.delete(curve);
        shapes += `
          <g${entry}><defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${color}" stop-opacity="0.30"/>
            <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
          </linearGradient></defs>
          <path d="${area}" fill="url(#${gradientId})"/>
          <path d="${paths.join(" ")}" fill="none" stroke="${color}" stroke-width="2.2"
            stroke-linecap="round" stroke-linejoin="round"/>
        `;
        shapes+=extremeDots(low,high,color,pt=>x(pt.s.elapsed_s),pt=>y(pt.rawY),invertY)+"</g>";
        if(inspect!=null && selected.has(curve)){
          const pt=curve.points.reduce((a,b)=>Math.abs(a.s.elapsed_s-inspect)<=Math.abs(b.s.elapsed_s-inspect)?a:b);
          const close=Math.abs(pt.s.elapsed_s-inspect)<=Math.min(gap/2,60);
          values.push(curve.name+" "+(close?format(pt.rawY):"—"));
        }
      }
      if(inspect!=null)shapes+=`<path d="M${x(inspect)} ${top}V${bottom}" stroke="currentColor" stroke-dasharray="3 3"/>`;
      svg.setAttribute("viewBox",`0 0 ${w} ${h}`);svg.innerHTML=shapes;
      out.textContent=inspect==null?"拖动查看同一时刻的读数":fmtDurationSec(inspect)+"　"+values.join("　");
    };
    for(const curve of curves){
      const label=document.createElement("label");
      label.style.setProperty("--series-color",curve.color);
      const input=document.createElement("input");input.type="checkbox";input.checked=selected.has(curve);
      input.onchange = () => {
        if (input.checked) {
          const exit = curveExits.get(curve);
          if (exit) {
            clearTimeout(exit.timer);
            curveExits.delete(curve);
          }
          selected.add(curve);
          if (!reducedMotion.matches) curveEntryTimes.set(curve, performance.now());
        } else {
          selected.delete(curve);
          curveEntryTimes.delete(curve);
          if (!reducedMotion.matches) {
            const start = performance.now();
            const timer = setTimeout(() => {
              curveExits.delete(curve);
              draw();
            }, curveExitDuration);
            curveExits.set(curve, { start, timer });
          }
        }
        draw();
      };
      label.append(input,document.createTextNode(curve.name));legend.append(label);
    }
    let lastOverlaySample = null;
    const pick=e=>{
      const pos=new DOMPoint(e.clientX,e.clientY).matrixTransform(svg.getScreenCTM().inverse());
      inspect=Math.max(0,Math.min(1,(pos.x-14)/(svg.clientWidth-28)))*curves[0].duration;
      const reference = selected.values().next().value;
      if (reference && e.pointerType !== "mouse" && svg.hasPointerCapture(e.pointerId)) {
        const t = inspect;
        const nearest = reference.points.reduce((a, b) => Math.abs(a.s.elapsed_s - t) <= Math.abs(b.s.elapsed_s - t) ? a : b);
        if (Math.abs(nearest.s.elapsed_s - t) <= Math.min(60, reference.gap / 2)) {
          if (lastOverlaySample && lastOverlaySample !== nearest) triggerHapticTick(8);
          lastOverlaySample = nearest;
        }
      }
      draw();
    };
    svg.onpointerdown = e => {
      lastOverlaySample = null;
      svg.setPointerCapture(e.pointerId);
      pick(e);
    };
    svg.onpointermove=e=>{if(svg.hasPointerCapture(e.pointerId)||e.pointerType==="mouse")pick(e);};
    const stage = dialog.querySelector(".overlay-stage");
    const dismiss = async () => {
      if (!dialog.open || dialog.classList.contains("is-closing")) return;
      dialog.classList.add("is-closing");
      await animateDialogDismiss(dialog, stage, null, { opacity: 0, scale: 0.96 }, 220, true);
    };
    dialog.addEventListener("health-overlay-dismiss", dismiss);
    let closeRequested = false;
    const requestClose = () => {
      if (closeRequested || dialog.classList.contains("is-closing")) return;
      closeRequested = true;
      requestHealthBack(dismiss);
    };
    dialog.querySelector("button").onclick = requestClose;
    dialog.oncancel = event => {
      event.preventDefault();
      requestClose();
    };
    const observer=new ResizeObserver(draw);
    dialog.onclose = () => {
      observer.disconnect();
      for (const exit of curveExits.values()) clearTimeout(exit.timer);
      curveExits.clear();
      dialog.remove();
      syncNativeBackState();
      $("overlay-toggle")?.focus();
    };
    dialog.showModal();observer.observe(svg);draw();syncNativeBackState();
  }

  function extremeDots(low,high,color,x,y,invert) {
    const top=invert?low:high,bottom=invert?high:low;
    const dot=(pt,filled)=>`<circle cx="${x(pt)}" cy="${y(pt)}" r="3.7" fill="${filled?color:"var(--surface-solid,#fff)"}" stroke="${filled?"var(--surface-solid,#fff)":color}" stroke-width="1.8"><title>${filled?"最高点":"最低点"}</title></circle>`;
    return dot(top,true)+(bottom.rawY===top.rawY?"":dot(bottom,false));
  }

  function drawWorkoutLineChartSvg(wrapEl, opts, p) {
    const duration = Math.max(1,(Date.parse(workoutDetailCache.end_iso)-Number(workoutDetailCache.workout_id))/1000 || workoutDetailCache.duration_s);
    const raw = opts.series.filter(s => Number.isFinite(opts.getY(s)) && s.elapsed_s >= 0 && s.elapsed_s <= duration);
    if (!wrapEl || raw.length < 2) return;
    const W = Math.max(300, Math.round(wrapEl.clientWidth || 340));
    const H = opts.height || 162;
    const pLeft = 6;
    const pRight = W - (opts.rightPad || 38);
    const pTop = 12;
    const pBot = H - 22;
    const ys = raw.map((s) => Number(opts.getY(s)));
    const extraVals = [...ys];
    if (opts.refLine != null) extraVals.push(opts.refLine);
    if (opts.band) extraVals.push(opts.band.lo, opts.band.hi);
    const [yLo, yHi, yTicks] = niceBounds(extraVals, opts.fallbackMin ?? 0, opts.fallbackMax ?? 100);
    const mapX = t => pLeft + t / duration * (pRight-pLeft);
    const mapY = (v) => pTop + ((opts.invertY ? Number(v) - yLo : yHi - Number(v)) / Math.max(yHi - yLo, 1e-6)) * (pBot - pTop);

    const gridSvg = yTicks
      .filter((t) => t >= yLo - 1e-6 && t <= yHi + 1e-6)
      .map((t) => {
        const y = mapY(t).toFixed(1);
        const lbl = opts.formatTick ? opts.formatTick(t) : String(Math.round(t));
        return `
          <line x1="${pLeft}" y1="${y}" x2="${pRight}" y2="${y}" stroke="${p.grid}" stroke-width="1"/>
          <text x="${W - 2}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end" font-size="10" font-weight="600" fill="${p.text2}">${lbl}</text>
        `;
      })
      .join("");

    let bandSvg = "";
    if (opts.band) {
      const bTop = mapY(Math.min(yHi, opts.band.hi));
      const bBot = mapY(Math.max(yLo, opts.band.lo));
      if (bBot > bTop) {
        bandSvg += `<rect x="${pLeft}" y="${bTop.toFixed(1)}" width="${(pRight - pLeft).toFixed(1)}" height="${(bBot - bTop).toFixed(1)}" rx="4" fill="${opts.band.color}" fill-opacity="0.14"/>`;
      }
    }
    if (opts.refLine != null && opts.refLine >= yLo && opts.refLine <= yHi) {
      const ry = mapY(opts.refLine).toFixed(1);
      bandSvg += `<line x1="${pLeft}" y1="${ry}" x2="${pRight}" y2="${ry}" stroke="${opts.refColor || opts.color}" stroke-width="1.2" stroke-dasharray="4 3" opacity="0.72"/>`;
      if (opts.refLabel) {
        bandSvg += `<text x="${pLeft + 4}" y="${(Number(ry) - 4).toFixed(1)}" font-size="9.5" font-weight="700" fill="${opts.refColor || opts.color}">${escapeHtml(opts.refLabel)}</text>`;
      }
    }

    const pts = raw.map(s=>({x:mapX(s.elapsed_s),y:mapY(opts.getY(s)),rawY:opts.getY(s),s}));
    const intervals = raw.slice(1).map((s,i)=>s.elapsed_s-raw[i].elapsed_s).filter(n=>n>0).sort((a,b)=>a-b);
    const gap = opts.estimated ? Infinity : Math.min(120,Math.max(15,3*(intervals[Math.floor(intervals.length/2)] || 5)));
    const groups=[];
    for(const pt of pts){
      const last=groups.at(-1);
      if(!last || pt.s.elapsed_s-last.at(-1).s.elapsed_s>gap) groups.push([pt]);
      else last.push(pt);
    }
    const paths=groups.map(g=>g.map((pt,i)=>(i?"L":"M")+pt.x.toFixed(1)+" "+pt.y.toFixed(1)).join(" "));
    const linePath=paths.join(" ");
    const areaPath=paths.map((path,i)=>path+" L"+groups[i].at(-1).x+" "+pBot+" L"+groups[i][0].x+" "+pBot+" Z").join(" ");
    const uid=++svgUid;
    const [firstTick,midTick,lastTick]=[0,duration/2,duration].map(t=>fmtDurationSec(Math.round(t)));
    const cp = opts.cursorPrefix || `wo-c-${uid}`;

    const low=pts.reduce((a,b)=>a.rawY<=b.rawY?a:b),high=pts.reduce((a,b)=>a.rawY>=b.rawY?a:b);
    const labels={"wo-pace":["配速","/km"],"wo-swim-pace":["配速","/百米"],"wo-speed":["速度"," km/h"],"wo-hr":["心率"," bpm"],"wo-cad":["步频"," spm"],"wo-elevation":["海拔"," m"],"wo-bal":["左侧触地","%"]};
    const [name,unit]=labels[cp] || (opts.color===p.purple?["垂直振幅"," cm"]:["触地时间"," ms"]);
    const format=v=>(cp==="wo-pace"||cp==="wo-swim-pace")?fmtPaceNoUnit(v)+unit:Number(v.toFixed(1))+unit;
    overlaySeries.set(name,{name,format,points:pts,groups,low,high,gap,duration,invertY:opts.invertY,color:opts.color});
    if(opts.overlayOnly)return;
    wrapEl.innerHTML = `
      <svg class="apple-svg-chart" viewBox="0 0 ${W} ${H}">
        <defs>
          <linearGradient id="${cp}-grad-${uid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${opts.color}" stop-opacity="0.30"/>
            <stop offset="100%" stop-color="${opts.color}" stop-opacity="0.02"/>
          </linearGradient>
        </defs>
        ${gridSvg}
        ${bandSvg}
        <path class="svg-line-draw" d="${areaPath}" fill="url(#${cp}-grad-${uid})"/>
        <path class="svg-line-draw" d="${linePath}" fill="none" stroke="${opts.color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
        ${extremeDots(low,high,opts.color,pt=>pt.x,pt=>pt.y,opts.invertY)}
        <text x="${pLeft}" y="${H - 5}" text-anchor="start" font-size="10" font-weight="600" fill="${p.text2}">${escapeHtml(firstTick)}</text>
        <text x="${((pLeft + pRight) / 2).toFixed(1)}" y="${H - 5}" text-anchor="middle" font-size="10" font-weight="600" fill="${p.text2}">${escapeHtml(midTick)}</text>
        <text x="${pRight}" y="${H - 5}" text-anchor="end" font-size="10" font-weight="600" fill="${p.text2}">${escapeHtml(lastTick)}</text>
        <line id="${cp}-cursor" x1="0" y1="${pTop}" x2="0" y2="${pBot}" stroke="${p.text2}" stroke-width="1.3" opacity="0"/>
        <circle id="${cp}-dot" cx="0" cy="0" r="4" fill="${opts.color}" stroke="${p.surfaceSolid}" stroke-width="1.5" opacity="0"/>
      </svg>
    `;

    const svgEl = wrapEl.querySelector("svg");
    const cursor = $(`${cp}-cursor`);
    const dot = $(`${cp}-dot`);
    const readoutEl = opts.readoutElId ? $(opts.readoutElId) : null;
    const defaultLabel = readoutEl?.dataset.default || "";

    chartReaders.push(seconds => {
      const show = seconds != null;
      cursor.setAttribute("opacity",show?"1":"0");
      const cx = mapX(seconds || 0);
      cursor.setAttribute("x1",cx); cursor.setAttribute("x2",cx);
      const nearest = show && pts.reduce((a,b)=>Math.abs(a.s.elapsed_s-seconds)<=Math.abs(b.s.elapsed_s-seconds)?a:b);
      const hit = nearest && Math.abs(nearest.s.elapsed_s-seconds)<=Math.min(60,gap/2);
      dot.setAttribute("opacity",hit?"1":"0");
      if(hit){dot.setAttribute("cx",nearest.x);dot.setAttribute("cy",nearest.y);}
      if(readoutEl) readoutEl.textContent = !show ? defaultLabel : hit ? opts.formatScrub(nearest.s,nearest.rawY) : fmtDurationSec(seconds)+" · 暂无邻近采样";
    });
    let lastScrubSample = null;
    bindChartScrubGesture(svgEl, (clientX, pointerType) => {
      const rect = svgEl.getBoundingClientRect();
      const t = Math.max(0, Math.min(duration, ((clientX - rect.left) * W / rect.width - pLeft) / (pRight - pLeft) * duration));
      if (pointerType !== "mouse") {
        const nearest = pts.reduce((a, b) => Math.abs(a.s.elapsed_s - t) <= Math.abs(b.s.elapsed_s - t) ? a : b);
        if (Math.abs(nearest.s.elapsed_s - t) <= Math.min(60, gap / 2)) {
          if (lastScrubSample && lastScrubSample !== nearest) triggerHapticTick(8);
          lastScrubSample = nearest;
        }
      }
      chartReaders.forEach(read => read(t));
    }, () => {
      lastScrubSample = null;
      chartReaders.forEach(read => read(null));
    });

  }

  function drawWorkoutHrLineSvg(wrapEl, series, p) {
    drawWorkoutLineChartSvg(wrapEl, {
      series,
      getX: (s) => s.t_ms,
      getY: (s) => s.hr,
      color: p.red,
      fallbackMin: 60,
      fallbackMax: 180,
      cursorPrefix: "wo-hr",
      readoutElId: "wo-hr-scrub-label",
      formatScrub: (s, val) => `${s.time} · ${Math.round(val)} 次/分`,
    }, p);
  }

  function drawWorkoutElevationSvg(wrap, pts, palette) {
    drawWorkoutLineChartSvg(wrap, {series:pts, getY:p=>p.ele_m, color:palette.teal,
      cursorPrefix:"wo-elevation", readoutElId:"wo-ele-readout", formatTick:v=>Math.round(v)+"m",
      formatScrub:(p,v)=>p.time+" · 海拔 "+Math.round(v)+" 米"},palette);
  }

  function renderWorkoutDetailCards(d, noAnim = false) {
    chartReaders = [];
    overlaySeries.clear();
    routeCursor?.remove(); routeCursor=null;
    $("workout-detail-card")?.classList.toggle("no-anim-replay", Boolean(noAnim));
    const p = getThemePalette();
    const isCycling = isCyclingWorkout(d);
    const isSwimming = isSwimmingWorkout(d);
    const hidePosture = isCycling || isSwimming;

    // 1. Apple Fitness Header + Color-Coded 2-Column Details Card
    const stats = [
      { lbl: "锻炼时长", val: fmtDurationSec(d.duration_s), unit: "", color: "var(--fit-yellow)" },
    ];
    if (d.distance_m && d.distance_m > 0) {
      stats.push({ lbl: "总距离", val: (d.distance_m / 1000).toFixed(2), unit: "公里", color: "var(--fit-cyan)" });
    }
    if (isCycling) {
      const avgKmh = paceToSpeedKmh(d.pace_avg_s_per_km)
        ?? (d.distance_m > 0 && d.duration_s > 0 ? (d.distance_m / d.duration_s) * 3.6 : null);
      if (avgKmh && avgKmh > 0) {
        stats.push({ lbl: "平均速度", val: avgKmh.toFixed(1), unit: "km/h", color: "var(--fit-cyan)" });
      }
    } else if (d.pace_avg_s_per_km && d.pace_avg_s_per_km > 0) {
      stats.push({
        lbl: "平均配速",
        val: isSwimming ? fmtSwimPaceNoUnit(d.pace_avg_s_per_km) : fmtPaceNoUnit(d.pace_avg_s_per_km),
        unit: isSwimming ? "/百米" : "/公里",
        color: "var(--fit-cyan)",
      });
    }
    if (d.calories_kcal && d.calories_kcal > 0) {
      stats.push({ lbl: "动态千卡", val: fmtNum(d.calories_kcal, 0), unit: "千卡", color: "var(--fit-red)" });
    }
    if (d.hr_avg && d.hr_avg > 0) {
      stats.push({ lbl: "平均心率", val: fmtNum(d.hr_avg, 0), unit: "次/分", color: "var(--fit-red)" });
    }
    if (d.elevation_gain_m && d.elevation_gain_m > 0) {
      stats.push({ lbl: "累计爬升", val: fmtNum(d.elevation_gain_m, 0), unit: "米", color: "var(--fit-green)" });
    }
    if (d.cadence_avg_spm && d.cadence_avg_spm > 0) {
      stats.push({ lbl: "平均步频", val: fmtNum(d.cadence_avg_spm, 0), unit: "步/分", color: "var(--fit-green)" });
    }
    if (d.pace_best_s_per_km && d.pace_best_s_per_km > 0) {
      if (isCycling) {
        stats.push({ lbl: "最佳速度", val: fmtSpeedKmhVal(d.pace_best_s_per_km), unit: "km/h", color: "var(--fit-purple)" });
      } else {
        stats.push({
          lbl: "最佳配速",
          val: isSwimming ? fmtSwimPaceNoUnit(d.pace_best_s_per_km) : fmtPaceNoUnit(d.pace_best_s_per_km),
          unit: isSwimming ? "/百米" : "/公里",
          color: "var(--fit-purple)",
        });
      }
    }

    const tm = d.training_metrics || {};
    const tBadges = [];
    if (tm.training_load) tBadges.push(`<span class="wo-tbadge" style="color:var(--apple-blue)">训练负荷 ${fmtNum(tm.training_load, 0)}</span>`);
    if (tm.aerobic_te) tBadges.push(`<span class="wo-tbadge" style="color:var(--fit-green)">有氧效果 ${fmtNum(tm.aerobic_te, 1)}</span>`);
    if (tm.anaerobic_te) tBadges.push(`<span class="wo-tbadge" style="color:var(--fit-purple)">无氧效果 ${fmtNum(tm.anaerobic_te, 1)}</span>`);
    if (tm.recovery_time_min) {
      const recHrs = Math.round(Number(tm.recovery_time_min) / 60);
      if (recHrs > 0) tBadges.push(`<span class="wo-tbadge" style="color:var(--apple-orange)">恢复 ${recHrs} 小时</span>`);
    }
    if (tm.vo2max) tBadges.push(`<span class="wo-tbadge" style="color:var(--fit-red)">VO₂ Max ${fmtNum(tm.vo2max, 1)}</span>`);

    const priority=["锻炼时长","总距离",isCycling?"平均速度":"平均配速","平均心率"];
    stats.sort((a,b)=>(priority.includes(a.lbl)?priority.indexOf(a.lbl):10)-(priority.includes(b.lbl)?priority.indexOf(b.lbl):10));
    const lastRowThreshold = stats.length - (stats.length % 2 === 0 ? 2 : 1);
    $("wo-apple-header-card").innerHTML = `
      <div class="fit-top-row">
        <div class="fit-title-left">
          <div class="fit-circle-badge">${workoutIconSvg(d.sport_name)}</div>
          <div>
            <h2 class="fit-sport-name">${escapeHtml(d.sport_name)}</h2>
            <p class="fit-sub-time">${escapeHtml(d.date)} · ${escapeHtml((d.start_iso || "").slice(11, 16))} – ${escapeHtml((d.end_iso || "").slice(11, 16))}</p>
          </div>
        </div>
      </div>
      <div class="fit-details-grid">
        ${stats
          .map(
            (st, idx) => `
          <div class="fit-stat-cell ${idx >= lastRowThreshold ? "no-border" : ""}">
            <div class="fit-stat-lbl">${escapeHtml(st.lbl)}</div>
            <div class="fit-stat-val" style="color:${st.color}">${escapeHtml(st.val)}${st.unit ? `<span class="fit-stat-unit">${escapeHtml(st.unit)}</span>` : ""}</div>
          </div>
        `
          )
          .join("")}
      </div>
      ${tBadges.length ? `<div class="wo-training-strip">${tBadges.join("")}</div>` : ""}
    `;

    const mobileNavTitle = $("wo-mobile-nav-title");
    if (mobileNavTitle) mobileNavTitle.textContent = d.sport_name || "训练详情";

    // 2. Pace-Gradient GPS Route Map (Smoothed Pace + Catmull-Rom + Casing)
    const pts = d.gps_track || [];
    const gpxHref = `/api/v1/dashboard/workout.gpx?id=${d.workout_id}`;
    if (d.has_gps && pts.length > 1 && window.L) {
      $("wo-map-card").classList.remove("hidden");
      $("wo-gpx-btn").href = gpxHref;
      $("wo-gpx-btn-mobile").classList.remove("hidden");
      $("wo-gpx-btn-mobile").href = gpxHref;

      if (!leafletMap) {
        if (window.L.DomUtil && !window.L.DomUtil.__patched2d) {
          window.L.DomUtil.__patched2d = true;
          window.L.DomUtil.setTransform = function (el, offset, scale) {
            const pos = offset || new window.L.Point(0, 0);
            el.style.transform = `translate(${pos.x}px, ${pos.y}px)${scale ? ` scale(${scale})` : ""}`;
          };
        }
        leafletMap = window.L.map("workout-map", {
          zoomControl: true,
          scrollWheelZoom: false,
          zoomSnap: 0.25,
          zoomDelta: 0.5,
        });
        // Preserve sub-pixel floating-point vertices instead of Leaflet's default ._round() pixel snapping
        leafletMap.latLngToLayerPoint = function (latlng) {
          const projected = this.project(window.L.latLng(latlng));
          const pt = projected._subtract(this.getPixelOrigin());
          pt.x = Math.round(pt.x * 100) / 100;
          pt.y = Math.round(pt.y * 100) / 100;
          return pt;
        };
        applyMapTiles();
        leafletLayerGroup = window.L.layerGroup().addTo(leafletMap);
      } else {
        leafletLayerGroup.clearLayers();
      }

      const smoothedPaces = smoothTrackPaces(pts, d.pace_avg_s_per_km || 330);
      const sorted = [...smoothedPaces].sort((a, b) => a - b);
      let fastPace = sorted[Math.floor(sorted.length * 0.05)] ?? 240;
      let slowPace = sorted[Math.floor(sorted.length * 0.95)] ?? 420;
      if (slowPace - fastPace < 52) {
        const mid = (fastPace + slowPace) / 2;
        fastPace = mid - 26;
        slowPace = mid + 26;
      }

      const geoPts = smoothGpsCoords(pts);
      const dense = catmullRomSubdivide(geoPts, smoothedPaces, 3);

      // Subtle anti-aliased surface halo casing underneath the continuous gradient ribbon
      window.L.polyline(
        dense.map((pt) => [pt.lat, pt.lon]),
        {
          color: p.dark ? "#1C1C1E" : "#FFFFFF",
          weight: 6.4,
          opacity: 1,
          noClip: true,
          smoothFactor: 0,
          lineCap: "round",
          lineJoin: "round",
        }
      ).addTo(leafletLayerGroup);

      for (let i = 0; i < dense.length - 1; i += 1) {
        const segPts = dense.slice(i, Math.min(dense.length, i + 3));
        const pMid = segPts.length > 2 ? segPts[1].pace : (dense[i].pace + dense[i + 1].pace) / 2;
        window.L.polyline(
          segPts.map((pt) => [pt.lat, pt.lon]),
          {
            color: paceToSmoothColor(pMid, fastPace, slowPace),
            weight: 4.6,
            opacity: 1,
            noClip: true,
            smoothFactor: 0,
            lineCap: "round",
            lineJoin: "round",
          }
        ).addTo(leafletLayerGroup);
      }

      chartReaders.push(t=>{
        const hit=t==null?null:pts.reduce((a,b)=>Math.abs(a.elapsed_s-t)<=Math.abs(b.elapsed_s-t)?a:b);
        if(!hit || Math.abs(hit.elapsed_s-t)>15){routeCursor?.remove();routeCursor=null;return;}
        const pos=[hit.lat,hit.lon];
        if(routeCursor) routeCursor.setLatLng(pos);
        else routeCursor=window.L.circleMarker(pos,{radius:6,color:"white",weight:2,fillColor:"#087aff",fillOpacity:1}).addTo(leafletLayerGroup);
      });
      const fullBounds = window.L.latLngBounds(pts.map((pt) => [pt.lat, pt.lon]));
      lastWorkoutBounds = fullBounds;
      window.L.circleMarker([pts[0].lat, pts[0].lon], {
        radius: 6, color: "#FFFFFF", weight: 2, fillColor: "#30D158", fillOpacity: 1,
      }).bindTooltip("起点").addTo(leafletLayerGroup);
      window.L.circleMarker([pts[pts.length - 1].lat, pts[pts.length - 1].lon], {
        radius: 6, color: "#FFFFFF", weight: 2, fillColor: "#FF453A", fillOpacity: 1,
      }).bindTooltip("终点").addTo(leafletLayerGroup);

      const fitRoute = () => {
        if (!leafletMap) return;
        leafletMap.invalidateSize();
        leafletMap.fitBounds(fullBounds, { padding: [18, 18] });
      };
      setTimeout(fitRoute, 70);
      setTimeout(fitRoute, 230);
    } else {
      lastWorkoutBounds = null;
      $("wo-map-card").classList.add("hidden");
      $("wo-gpx-btn-mobile").classList.add("hidden");
    }

    // 3. Heart Rate Curve SVG + 5 HRR Zones
    const hrSeries = d.hr_series || [];
    const hrZones = d.hr_zones || [];
    const hrCard = $("wo-hr-card");
    if (hrSeries.length > 1 || hrZones.length > 0) {
      hrCard.classList.remove("hidden");
      const defaultHrLbl = `均 ${fmtNum(d.hr_avg, 0)} · 最高 ${fmtNum(d.hr_max, 0)} 次/分`;
      const maxZoneSec = Math.max(...hrZones.map((z) => z.duration_s), 1);

      hrCard.innerHTML = `
        <div class="card-header" style="margin-bottom:8px;">
          <div>
            <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-red)"></span>心率与区间</h3>
            <p id="wo-hr-scrub-label" class="card-note" data-default="${escapeHtml(defaultHrLbl)}">${escapeHtml(defaultHrLbl)}</p>
          </div>
          <span class="status-pill" style="color:var(--fit-red)">最低 ${fmtNum(d.hr_min, 0)} bpm</span>
        </div>
        ${hrSeries.length > 1 ? '<div id="wo-hr-svg-wrap" class="svg-chart-wrap"></div>' : '<div class="card-note">暂无高密度心率采样序列</div>'}
        ${
          hrZones.length
            ? `
          <div class="hr-zones-list">
            ${hrZones
              .map(
                (z) => `
              <div class="hr-zone-row">
                <div class="hr-zone-meta">
                  <div class="hr-zone-name" style="color:${z.color}">区间 ${z.zone} · ${escapeHtml(z.name)}</div>
                  <div class="hr-zone-bpm">${escapeHtml(z.range_bpm)} bpm</div>
                </div>
                <div class="hr-zone-track">
                  <div class="hr-zone-fill" style="width:${z.duration_s > 0 ? Math.max(4, Math.round((z.duration_s / maxZoneSec) * 100)) : 0}%;background:${z.color};opacity:${z.duration_s > 0 ? 1 : 0}"></div>
                </div>
                <div class="hr-zone-dur">${fmtDurationSec(z.duration_s)}</div>
              </div>
            `
              )
              .join("")}
          </div>
        `
            : ""
        }
      `;
      if (hrSeries.length > 1) {
        drawWorkoutHrLineSvg($("wo-hr-svg-wrap"), hrSeries, p);
      }
    } else {
      hrCard.classList.add("hidden");
    }

    renderWorkoutPace(d, p);
    // 4. Apple Fitness Visual Splits Card
    const splits = d.splits || [];
    const splitsCard = $("wo-splits-card");
    if (splits.length > 0) {
      splitsCard.classList.remove("hidden");
      const parsedSplits = splits.map((s) => ({
        sn: s.sn, duration: Number(s.st),
        dist_m: s.sd ? Number(s.sd) / 100.0 : 0,
        pace: s.sp ? Number(s.sp) : 0,
        hr: s.shr || "-",
        cad: s.sc || "-",
      }));
      let swimStdDist = 100;
      if (isSwimming) {
        const distCounts = new Map();
        parsedSplits.forEach((s) => {
          if (s.dist_m >= 20) {
            const k = Math.round(s.dist_m);
            distCounts.set(k, (distCounts.get(k) || 0) + 1);
          }
        });
        let bestC = 0;
        distCounts.forEach((c, k) => {
          if (c > bestC) { bestC = c; swimStdDist = k; }
        });
      }
      const isFullSplit = (s) => isSwimming ? (swimStdDist > 0 && Math.abs(s.dist_m - swimStdDist) <= 2) : (Math.abs(s.dist_m - 1000) <= 5);
      const paceCandidates = parsedSplits.filter((s) => s.pace > 0 && isFullSplit(s));
      const minPace = paceCandidates.length ? Math.min(...paceCandidates.map((s) => s.pace)) : 0;
      const maxPace = paceCandidates.length ? Math.max(...paceCandidates.map((s) => s.pace)) : 0;
      const allValidPaces = parsedSplits.filter((s) => s.pace > 0).map((s) => s.pace);
      const fastestRef = minPace || (allValidPaces.length ? Math.min(...allValidPaces) : 0);
      const fastestLbl = isSwimming ? `最快分段 ${fmtSwimPace(minPace)}` : `最快完整公里 ${isCycling ? fmtSpeedKmh(minPace) : fmtPace(minPace)}`;

      splitsCard.innerHTML = `
        <div class="card-header" style="margin-bottom:6px;">
          <div>
            <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-cyan)"></span>${isCycling ? "分段速度" : "分段配速"}</h3>
            <p class="card-note">共 ${parsedSplits.length} 段 · 设备分段${minPace ? " · " + fastestLbl : ""}</p>
          </div>
        </div>
        <div class="splits-list">
          ${parsedSplits
            .map((s) => {
              const isFastest = minPace > 0 && s.pace === minPace && parsedSplits.length > 1 && isFullSplit(s);
              const barPct = s.pace > 0
                ? (maxPace > minPace && isFullSplit(s)
                    ? Math.round(52 + ((maxPace - s.pace) / (maxPace - minPace)) * 46)
                    : Math.max(18, Math.min(96, Math.round((fastestRef / s.pace) * 96))))
                : 20;
              const segLabel = isSwimming
                ? (Math.abs(s.dist_m - 100) <= 2 ? `第${escapeHtml(s.sn)}百米` : `#${escapeHtml(s.sn)} · ${fmtNum(s.dist_m, 0)}米`)
                : (Math.abs(s.dist_m - 1000) <= 5 ? `第${escapeHtml(s.sn)}公里` : `${fmtNum(s.dist_m, 0)}米`);
              return `
                <div class="split-row">
                  <div class="split-idx">${segLabel}${s.duration>0?`<small class="seg-time">${fmtDurationSec(s.duration)}</small>`:""}</div>
                  <div class="split-bar-wrap">
                    <div class="split-bar-top">
                      <span class="split-pace-num">${s.pace > 0 ? (isCycling ? fmtSpeedKmh(s.pace) : (isSwimming ? fmtSwimPace(s.pace) : fmtPace(s.pace))) : "-"}</span>
                      ${isFastest ? '<span class="split-fast-pill">最快</span>' : ""}
                    </div>
                    <div class="split-bar-track">
                      <div class="split-bar-fill" style="width:${barPct}%;${isFastest ? "background:var(--fit-green)" : ""}"></div>
                    </div>
                  </div>
                  <div class="split-right">
                    <div class="split-hr">${escapeHtml(s.hr)} bpm</div>
                    <div>${escapeHtml(s.cad)} spm</div>
                  </div>
                </div>
              `;
            })
            .join("")}
        </div>
      `;
    } else {
      splitsCard.classList.add("hidden");
    }

    // 4a. Pro Aerobic Efficiency & Fatigue Drift Card
    const bioCard = $("wo-biomech-card");
    if (bioCard) {
      const bm = d.biomechanics;
      if (bm && bm.ef != null) {
        bioCard.classList.remove("hidden");
        const decVal = bm.decoupling_pct != null ? `${bm.decoupling_pct > 0 ? "+" : ""}${bm.decoupling_pct}%` : "-";
        const pacePair = bm.first_half_pace && bm.second_half_pace
          ? (isSwimming
              ? `${bm.first_half_pace.replace(/\s*\/百米$/i, "")} → ${bm.second_half_pace}`
              : `${bm.first_half_pace.replace(/\s*\/km$/i, "")} → ${bm.second_half_pace.replace(/\s*\/km$/i, "")}`)
          : (isCycling ? "全程匀速" : "全程均速");
        const shortStrategy = String(bm.pace_strategy || "-").split(" · ")[0];
        const drifts = bm.drift_rows || [];
        const driftDetailHtml = `
          ${
            drifts.length
              ? `<div class="drift-list" style="border-top:none;">
                  ${drifts
                    .map(
                      (dr) => `
                    <div class="drift-row">
                      <span class="drift-lbl">${escapeHtml(dr.label)}</span>
                      <span class="drift-right">
                        <span>${escapeHtml(dr.early)} → ${escapeHtml(dr.late)}</span>
                        <span class="drift-delta-txt ${escapeHtml(dr.sentiment || "neutral")}">${escapeHtml(dr.delta_text)}</span>
                      </span>
                    </div>
                  `
                    )
                    .join("")}
                </div>`
              : ""
          }
          ${bm.verdict ? `<p class="pro-note-text">${escapeHtml(bm.verdict)}</p>` : ""}
        `;

        bioCard.innerHTML = `
          <div class="card-header" style="margin-bottom:6px;">
            <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-indigo)"></span>${hidePosture ? "有氧效率" : "有氧效率与跑姿"}</h3>
          </div>
          <div class="apple-stat-strip">
            <div>
              <div class="apple-stat-lbl">效率系数 EF</div>
              <div class="apple-stat-val" style="color:var(--fit-green)">${escapeHtml(bm.ef)}</div>
            </div>
            <div>
              <div class="apple-stat-lbl">有氧解耦</div>
              <div class="apple-stat-val" style="color:${escapeHtml(bm.decoupling_color || p.text)}">${escapeHtml(decVal)}</div>
            </div>
            <div>
              <div class="apple-stat-lbl">${isCycling ? "速度策略" : "配速策略"}</div>
              <div class="apple-stat-val apple-stat-val-sm">${escapeHtml(shortStrategy)}</div>
              <div class="apple-stat-sub">${escapeHtml(pacePair)}</div>
            </div>
          </div>
          ${renderInlineDisclosureHtml(hidePosture ? "效率衰减与分析明细" : "跑姿衰减与分析明细", drifts.length ? `${drifts.length} 项对比` : "", driftDetailHtml)}
        `;
        bindAppleDisclosures(bioCard);
      } else {
        bioCard.classList.add("hidden");
      }
    }

    const recovery=$("wo-recovery");
    const measured=d.recovery || [];
    recovery.classList.toggle("hidden",!measured.some(p=>p.target>0));
    const end=measured.find(p=>p.target===0);
    recovery.innerHTML='<h3 class="card-title">运动后心率恢复</h3>'+measured.map(pt=>{
      const delta=end && pt.target>0 ? " · "+(end.hr>=pt.hr?"下降 ":"上升 ")+Math.abs(end.hr-pt.hr)+" 次/分":"";
      return `<div class="kv-row"><span>${pt.offset>=0?"结束后":"结束前"} ${Math.abs(pt.offset)} 秒</span><strong>${pt.hr} bpm${delta}</strong></div>`;
    }).join("");
    if(splits.length>5){
      const extra=[...splitsCard.querySelectorAll(".split-row")].slice(5);
      const drawer = document.createElement("div");
      drawer.className = "accordion-drawer split-drawer";
      const content = document.createElement("div");
      content.className = "accordion-inner";
      extra[0].before(drawer);
      content.append(...extra);
      drawer.append(content);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "text-link-btn";
      const set = open => {
        drawer.classList.toggle("open", open);
        drawer.inert = !open;
        toggle.textContent = open ? "收起分段" : "显示全部 " + splits.length + " 段";
        toggle.setAttribute("aria-expanded", String(open));
      };
      set(false);
      toggle.onclick = () => set(!drawer.classList.contains("open"));
      splitsCard.append(toggle);
    }
    // 4b. Running Cadence Curve Card (步频走势图)
    const cadSeries = d.cadence_series || [];
    const cadCard = $("wo-cadence-card");
    if (cadCard) {
      if (cadSeries.length > 1) {
        cadCard.classList.remove("hidden");
        const cadVals = cadSeries.map((s) => Number(s.spm));
        const avgCad = d.cadence_avg_spm || Math.round(cadVals.reduce((a, b) => a + b, 0) / cadVals.length);
        const maxCad = d.cadence_best_spm || Math.max(...cadVals);
        const defaultCadLbl = `平均 ${fmtNum(avgCad, 0)} · 最高 ${fmtNum(maxCad, 0)} 步/分`;
        cadCard.innerHTML = `
          <div class="card-header" style="margin-bottom:8px;">
            <div>
              <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-green)"></span>步频走势</h3>
              <p id="wo-cad-scrub-label" class="card-note" data-default="${escapeHtml(defaultCadLbl)}">${escapeHtml(defaultCadLbl)}</p>
            </div>
            <span class="status-pill" style="color:var(--fit-green)">最高 ${fmtNum(maxCad, 0)} spm</span>
          </div>
          <div id="wo-cad-svg-wrap" class="svg-chart-wrap"></div>
        `;
        drawWorkoutLineChartSvg($("wo-cad-svg-wrap"), {
          series: cadSeries,
          getX: (s) => s.elapsed_s,
          getY: (s) => s.spm,
          color: p.green,
          fallbackMin: 130,
          fallbackMax: 200,
          refLine: 180,
          refColor: p.text2,
          refLabel: "180 步/分",
          cursorPrefix: "wo-cad",
          readoutElId: "wo-cad-scrub-label",
          formatScrub: (s, val) => `${s.time} · ${Math.round(val)} 步/分`,
        }, p);
      } else {
        cadCard.classList.add("hidden");
      }
    }

    // 4c. Running Form: Left-Right Ground Contact Balance & GCT / Vertical Oscillation
    const postSeries = d.posture_series || [];
    const balCard = $("wo-balance-card");
    const dyn = d.running_dynamics || {};
    if (balCard) {
      const balSamples = postSeries.filter((s) => s.gtb_left != null);
      const gctSamples = postSeries.filter((s) => s.gct_ms != null);
      const voSamples = postSeries.filter((s) => s.vo_cm != null);
      if (balSamples.length > 1 || gctSamples.length > 1) {
        balCard.classList.remove("hidden");
        const avgBalL = dyn.avg_gc_tb != null
          ? Number(dyn.avg_gc_tb)
          : balSamples.length
            ? Number((balSamples.reduce((a, s) => a + s.gtb_left, 0) / balSamples.length).toFixed(2))
            : 50.0;
        const avgBalR = Number((100 - avgBalL).toFixed(2));
        const balSym = Math.abs(avgBalL - 50) <= 1.0 ? "高度对称" : Math.abs(avgBalL - 50) <= 2.0 ? "均衡良好" : "略偏一侧";
        const markerLeft = Math.max(8, Math.min(92, 50 + (avgBalL - 50) * 10)).toFixed(1);
        const defaultBalLbl = `均值 左 ${avgBalL.toFixed(1)}% / 右 ${avgBalR.toFixed(1)}% · 理想区间 49%–51%`;

        const avgGct = dyn.avg_gct_ms || (gctSamples.length ? Math.round(gctSamples.reduce((a, s) => a + s.gct_ms, 0) / gctSamples.length) : null);
        const avgVo = dyn.avg_v_osc_cm || (voSamples.length ? Number((voSamples.reduce((a, s) => a + s.vo_cm, 0) / voSamples.length).toFixed(1)) : null);
        const hasSecondary = gctSamples.length > 1 || voSamples.length > 1;
        let activePostureMode = gctSamples.length > 1 ? "gct" : "vo";

        balCard.innerHTML = `
          <div class="card-header" style="margin-bottom:8px;">
            <div>
              <h3 class="card-title"><span class="dot-badge" style="background:var(--fit-cyan)"></span>左右触地平衡</h3>
            </div>
            <span class="status-pill balance-status" style="color:${Math.abs(avgBalL - 50) <= 1.0 ? p.green : p.blue}">${balSym}</span>
          </div>
          <p id="wo-bal-scrub-label" class="card-note" data-default="${escapeHtml(defaultBalLbl)}">${escapeHtml(defaultBalLbl)}</p>
          <div class="balance-gauge-wrap">
            <div class="balance-lr-labels">
              <span style="color:var(--fit-cyan)">左脚 ${avgBalL.toFixed(1)}%</span>
              <span class="card-note">50.0% 平衡轴</span>
              <span style="color:var(--fit-purple)">右脚 ${avgBalR.toFixed(1)}%</span>
            </div>
            <div class="balance-bar-track">
              <div class="balance-ideal-zone"></div>
              <div class="balance-center-tick"></div>
              <div class="balance-marker" style="left:${markerLeft}%"></div>
            </div>
          </div>
          ${balSamples.length > 1 ? '<div id="wo-bal-svg-wrap" class="svg-chart-wrap"></div>' : ""}
          ${
            hasSecondary
              ? `
                <div class="posture-sub-head">
                  <div>
                    <div style="font-size:13px;font-weight:700;" id="wo-post-title">触地时间与垂直振幅</div>
                    <div class="card-note" id="wo-post-scrub-label" tabindex="0" data-default="均触地 ${avgGct ?? "-"} ms · 均振幅 ${avgVo ?? "-"} cm">均触地 ${avgGct ?? "-"} ms · 均振幅 ${avgVo ?? "-"} cm</div>
                  </div>
                  <div id="wo-post-seg" class="posture-seg">
                    ${gctSamples.length > 1 ? `<button class="seg-btn ${activePostureMode === "gct" ? "active" : ""}" data-pmode="gct" type="button">触地时间</button>` : ""}
                    ${voSamples.length > 1 ? `<button class="seg-btn ${activePostureMode === "vo" ? "active" : ""}" data-pmode="vo" type="button">垂直振幅</button>` : ""}
                  </div>
                </div>
                <div id="wo-post-svg-wrap" class="svg-chart-wrap"></div>
              `
              : ""
          }
        `;

        if (balSamples.length > 1) {
          drawWorkoutLineChartSvg($("wo-bal-svg-wrap"), {
            series: balSamples,
            getX: (s) => s.elapsed_s,
            getY: (s) => s.gtb_left,
            color: p.teal,
            fallbackMin: 47,
            fallbackMax: 53,
            refLine: 50,
            refColor: p.text2,
            band: { lo: 49, hi: 51, color: p.green },
            cursorPrefix: "wo-bal",
            readoutElId: "wo-bal-scrub-label",
            formatTick: (v) => `${Number(v).toFixed(1)}%`,
            formatScrub: (s, val) => `${s.time} · 左 ${val.toFixed(1)}% / 右 ${(100 - val).toFixed(1)}%`,
          }, p);
        }

        const drawSecondaryPosture = (mode,overlayOnly=false) => {
          const wrap = $("wo-post-svg-wrap");
          const lblEl = $("wo-post-scrub-label");
          if (!wrap) return;
          if (mode === "vo" && voSamples.length > 1) {
            const defTxt = `平均垂直振幅 ${avgVo ?? "-"} cm`;
            if (lblEl && !overlayOnly) {
              lblEl.dataset.default = defTxt;
              lblEl.textContent = defTxt;
            }
            drawWorkoutLineChartSvg(wrap, {
              overlayOnly, series: voSamples,
              getX: (s) => s.elapsed_s,
              getY: (s) => s.vo_cm,
              color: p.purple,
              fallbackMin: 6,
              fallbackMax: 12,
              cursorPrefix: "wo-post",
              readoutElId: "wo-post-scrub-label",
              formatTick: (v) => `${Number(v).toFixed(1)}cm`,
              formatScrub: (s, val) => `${s.time} · 垂直振幅 ${val.toFixed(1)} cm`,
            }, p);
          } else if (gctSamples.length > 1) {
            const defTxt = `平均触地时间 ${avgGct ?? "-"} ms`;
            if (lblEl && !overlayOnly) {
              lblEl.dataset.default = defTxt;
              lblEl.textContent = defTxt;
            }
            drawWorkoutLineChartSvg(wrap, {
              overlayOnly, series: gctSamples,
              getX: (s) => s.elapsed_s,
              getY: (s) => s.gct_ms,
              color: p.orange,
              fallbackMin: 200,
              fallbackMax: 320,
              cursorPrefix: "wo-post",
              readoutElId: "wo-post-scrub-label",
              formatTick: (v) => `${Math.round(v)}ms`,
              formatScrub: (s, val) => `${s.time} · 触地 ${Math.round(val)} ms`,
            }, p);
          }
        };

        if (hasSecondary) {
          if(voSamples.length>1 && gctSamples.length>1)drawSecondaryPosture(activePostureMode==="vo"?"gct":"vo",true);
          drawSecondaryPosture(activePostureMode);
          balCard.querySelectorAll("#wo-post-seg .seg-btn").forEach((b) => {
            b.addEventListener("click", () => {
              activePostureMode = b.dataset.pmode;
              balCard.querySelectorAll("#wo-post-seg .seg-btn").forEach((x) => x.classList.toggle("active", x === b));
              drawSecondaryPosture(activePostureMode);
            });
          });
        }
      } else {
        balCard.classList.add("hidden");
      }
    }

    // 5. Elevation Profile SVG + Running Dynamics Card
    const hasEle = pts.some((pt) => pt.ele_m !== null && pt.ele_m !== undefined);
    const dynRows = [];
    const avgGctNum = dyn.avg_gct_ms || dyn.mAvgGroundContactTime || d.avg_gct_ms;
    const avgVoNum = dyn.avg_v_osc_cm ?? (dyn.mAvgVerticalOscillation ? Number(dyn.mAvgVerticalOscillation) / 10 : null);
    if (avgGctNum) dynRows.push({ label: "平均触地时间", value: `${Math.round(avgGctNum)} 毫秒` });
    if (avgVoNum) dynRows.push({ label: "平均垂直振幅", value: `${fmtNum(avgVoNum, 1)} 厘米` });
    if (dyn.avg_gc_tb != null) {
      const lPct = Number(dyn.avg_gc_tb);
      dynRows.push({ label: "左右触地平衡", value: `左 ${lPct.toFixed(1)}% / 右 ${(100 - lPct).toFixed(1)}%` });
    }
    if (d.steps) dynRows.push({ label: "总步数", value: `${fmtNum(d.steps)} 步` });
    if (d.cadence_best_spm) dynRows.push({ label: "最高步频", value: `${fmtNum(d.cadence_best_spm, 0)} 步/分` });

    const eleCard = $("wo-ele-card");
    if (hasEle || dynRows.length > 0) {
      eleCard.classList.remove("hidden");
      const ep = d.elevation_profile || {};
      const eleSub = ep.min_ele_m != null ? `海拔 ${ep.min_ele_m} ~ ${ep.max_ele_m} m · 爬升 ${fmtNum(d.elevation_gain_m, 0)} m` : "运行动态细节";
      eleCard.innerHTML = `
        <div class="card-header" style="margin-bottom:8px;">
          <div>
            <h3 class="card-title"><span class="dot-badge" style="background:var(--apple-teal)"></span>海拔与跑步动态</h3>
            <p class="card-note" id="wo-ele-readout" data-default="${escapeHtml(eleSub)}">${escapeHtml(eleSub)}</p>
          </div>
        </div>
        ${hasEle ? '<div id="wo-ele-svg-wrap" class="svg-chart-wrap" style="margin-bottom:10px;"></div>' : ""}
        ${
          dynRows.length
            ? `<div class="kv-list">${dynRows.map((r) => `<div class="kv-row"><span class="kv-k">${escapeHtml(r.label)}</span><span class="kv-v">${escapeHtml(r.value)}</span></div>`).join("")}</div>`
            : ""
        }
      `;
      if (hasEle) drawWorkoutElevationSvg($("wo-ele-svg-wrap"), pts, p);
    } else {
      eleCard.classList.add("hidden");
    }
    $("wo-view-switch").classList.toggle("hidden",overlaySeries.size===0);
    $("overlay-toggle").onclick=openTrainingOverlay;

  }

  async function fetchWorkoutData(wid) {
    const key = String(wid);
    if (workoutQueryCache.has(key)) return workoutQueryCache.get(key);
    if (workoutInflight.has(key)) return workoutInflight.get(key);
    const epoch = preloadEpoch;
    const req = apiJson(`/api/v1/dashboard/workout?id=${wid}&max_points=1000`)
      .then((data) => {
        if (epoch === preloadEpoch) cacheMapSet(workoutQueryCache, key, data, 24);
        return data;
      })
      .finally(() => {
        if (workoutInflight.get(key) === req) workoutInflight.delete(key);
      });
    workoutInflight.set(key, req);
    return req;
  }

  async function loadWorkoutDetail(wid, openMobileDetail = false, originOrMeta = null, extraOpts = {}) {
    if (woExitTimer) {
      clearTimeout(woExitTimer);
      woExitTimer = null;
    }
    const deferFinalize = typeof extraOpts.deferFinalize === "function" ? extraOpts.deferFinalize : null;
    let originMeta = null;
    if (openMobileDetail && !restoringNavigation && canUseContainerTransform()) {
      originMeta = originOrMeta instanceof Element ? captureOriginCard(originOrMeta) : originOrMeta;
    }
    if (openMobileDetail) {
      if (navigationRoute.view !== "workout" || navigationRoute.workoutId !== wid) pushHealthView("workout", { workoutId: wid });
      if (originMeta) originByDepth.set(navigationRoute.depth, originMeta);
      workoutListScrollY = window.scrollY || 0;
      if (!originMeta) {
        $("workouts-layout").classList.add("mobile-detail-open");
        $("app-shell").classList.add("wo-detail-active");
        if (!restoringNavigation) triggerViewTransition($("workout-detail-card"), "ios-view-enter");
        window.scrollTo({ top: 0, behavior: "instant" });
      }
    }
    const request = ++workoutRequest;
    const routeRef = navigationRoute;
    let afterOpening = null;
    if (openMobileDetail && originMeta) {
      const prewarmedData = workoutQueryCache.get(String(wid)) || null;
      const fetchPromise = prewarmedData ? null : fetchWorkoutData(wid);
      if (restoringNavigation || request !== workoutRequest || navigationRoute !== routeRef) return;

      const finishMobileOpen = () => {
        if (request !== workoutRequest) return;
        if (deferFinalize) {
          deferFinalize();
        } else {
          $("workouts-layout").classList.add("mobile-detail-open");
          $("app-shell").classList.add("wo-detail-active");

        }
      };

      if (prewarmedData) {
        await runContainerOpenTransition({
          targetEl: $("workout-detail-card"),
          originMeta,
          prepare: () => {
            if (request !== workoutRequest) return;
            workoutDetailCache = prewarmedData;
            renderWorkoutDetailCards(prewarmedData, true);
            sealOneShotAnimations($("workout-detail-card"));
          },
          onFinish: () => {
            finishMobileOpen();
            if (request === workoutRequest) refitWorkoutMap();
          },
        });
        return;
      }

      afterOpening = runContainerOpenTransition({
        targetEl: $("workout-detail-card"),
        originMeta,
        prepare: () => {
          workoutDetailCache = null;
          [
            "wo-map-card",
            "wo-view-switch",
            "wo-pace-card",
            "wo-hr-card",
            "wo-ele-card",
            "wo-cadence-card",
            "wo-recovery",
            "wo-splits-card",
            "wo-biomech-card",
            "wo-balance-card",
            "wo-gpx-btn-mobile",
          ].forEach((cid) => $(cid)?.classList.add("hidden"));
          const hdr = $("wo-apple-header-card");
          if (hdr) hdr.innerHTML = '<div class="fit-empty-msg">正在载入训练记录…</div>';
          const navT = $("wo-mobile-nav-title");
          if (navT) navT.textContent = "训练详情";
        },
        onFinish: finishMobileOpen,
      });
      let data;
      try {
        data = await (fetchPromise || fetchWorkoutData(wid));
      } catch (error) {
        if (!(await afterOpening)) return;
        if (request === workoutRequest) {
          $("wo-apple-header-card").innerHTML = `<div class="fit-empty-msg">加载训练记录失败：${escapeHtml(error.message)}</div>`;
        }
        return;
      }
      if (!canPopulateOpening($("workout-detail-card")) && !(await afterOpening)) return;
      if (request !== workoutRequest || routeRef !== navigationRoute) return;
      workoutDetailCache = data;
      renderWorkoutDetailCards(data, true);
      sealOneShotAnimations($("workout-detail-card"));
      if (await afterOpening && request === workoutRequest && routeRef === navigationRoute) refitWorkoutMap();
      return;
    }
    const data = await fetchWorkoutData(wid);
    if (request !== workoutRequest) return;
    workoutDetailCache = data;
    renderWorkoutDetailCards(data, Boolean(afterOpening));
    if (afterOpening) refitWorkoutMap();
  }

  // -----------------------------------------------------------------------
  // Tab 4: More & System Status
  // -----------------------------------------------------------------------

  const dataExportOptions = [
    { value: "DECRYPTED", label: "导出已解密全量数据库", meta: "保留华为运动健康原始表，可用 SQLite 工具打开" },
    { value: "ENCRYPTED", label: "导出原始数据库快照", meta: "保存华为运动健康数据库原文件" },
    { value: "PANEL", label: "导出面板数据库", meta: "保存面板使用的整理后数据" },
    { value: "KEY", label: "导出 SQLCipher 密钥文件" },
    { value: "COPY_KEY", label: "复制 SQLCipher 密钥" },
  ];

  function confirmSettingsAction(title, subtitle, label, onConfirm) {
    openGlassSelectSheet({
      title, subtitle,
      options: [{ value: "confirm", label }],
      onSelect: onConfirm,
    });
  }

  function openDataExportSettings() {
    openGlassSelectSheet({
      title: "数据与密钥导出",
      options: dataExportOptions,
      onSelect: (kind, option) => {
        const exportData = () => window.__panelNative?.exportData?.(kind);
        if (kind === "KEY" || kind === "COPY_KEY") {
          confirmSettingsAction("确认导出解密密钥",
            "持有密钥和原始数据库的人可以解密全部健康记录。请仅保存到受信任的位置。",
            option.label, exportData);
        } else exportData();
      },
    });
  }

  function openMcpSettings() {
    const state = JSON.parse(window.__panelNative?.mcpState?.() || "null");
    if (!state) return;
    openGlassSelectSheet({
      title: "本地 MCP 服务",
      subtitle: [state.status, state.url].filter(Boolean).join(" · "),
      options: [
        { value: state.active ? "stop" : "start", label: state.active ? "停止服务" : "启动服务" },
        ...(!state.active ? [{ value: "configure", label: "设置端口和访问范围" }] : []),
        { value: "copy-token", label: "复制 Bearer Token" },
        { value: "copy-config", label: "复制客户端 JSON 配置" },
        { value: "reset", label: "重置 Token" },
      ],
      onSelect: (action) => {
        if (action === "configure") {
          openGlassSelectSheet({
            title: "设置端口和访问范围",
            port: state.port,
            value: state.lan ? "lan" : "local",
            options: [
              { value: "local", label: "仅本机", meta: "绑定 127.0.0.1" },
              { value: "lan", label: "允许局域网访问" },
            ],
            onSelect: (scope, _, port) => {
              const save = () => window.__panelNative?.saveMcpConfig?.(port, scope === "lan");
              if (scope === "lan") {
                confirmSettingsAction("允许局域网访问？",
                  "局域网使用明文 HTTP。仅在受信任的网络中启用。",
                  "允许局域网访问", save);
              } else save();
            },
          });
        } else if (action === "reset") {
          confirmSettingsAction("重置 Token", "服务将停止，现有客户端需要重新配置。",
            "重置 Token", () => window.__panelNative?.mcpAction?.("reset"));
        } else window.__panelNative?.mcpAction?.(action);
      },
    });
  }

  $("data-export-settings")?.addEventListener("click", openDataExportSettings);
  $("mcp-service-settings")?.addEventListener("click", openMcpSettings);

  function renderMoreTab() {
    if (!overviewCache || !overviewCache.sync_status) return;
    const st = overviewCache.sync_status;
    const c = st.counts || {};
    const meta = st.sync_meta || {};

    $("sys-status-box").innerHTML = `
      <div class="kv-row"><span class="kv-k">健康数据库大小</span><span class="kv-v">${fmtNum(st.db_size_mb, 2)} MB</span></div>
      <div class="kv-row"><span class="kv-k">日汇总覆盖范围</span><span class="kv-v">${fmtNum(c.daily_summary)} 天 (${escapeHtml(st.daily_date_range?.min || "-")} ~ ${escapeHtml(st.daily_date_range?.max || "-")})</span></div>
      <div class="kv-row"><span class="kv-k">科学睡眠 / 小睡记录</span><span class="kv-v">${fmtNum(c.sleep_sessions)} 次</span></div>
      <div class="kv-row"><span class="kv-k">连续与分时体征点</span><span class="kv-v">${fmtNum(c.vitals_points)} 条</span></div>
      <div class="kv-row"><span class="kv-k">单次训练记录</span><span class="kv-v">${fmtNum(c.workouts)} 次</span></div>
      <div class="kv-row"><span class="kv-k">最近导入时间</span><span class="kv-v">${escapeHtml(meta.last_synced_iso || "-")}</span></div>
    `;
  }

  startOfflinePanel();
})();

/* Automatically pan workout readouts that overflow their available width. */
(() => {
  const selector = ".workout-detail-panel :is(.apple-stat-sub, .workout-scroll-text, #wo-post-scrub-label), .training-overlay[open] output";
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const positions = new Map();
  const pause = 1200;
  const speed = .028;
  let frame = 0;

  function pan(now) {
    frame = 0;
    if (window.__isPanelTransitionBusy?.()) return;
    for (const [el, state] of positions) {
      const travel = state.distance / speed;
      const phase = (now - state.start) % (2 * (pause + travel));
      const offset = Math.min(phase - pause, 2 * (travel + pause) - phase);
      el.scrollLeft = Math.max(0, Math.min(state.distance, offset * speed));
    }
    if (positions.size) frame = requestAnimationFrame(pan);
  }

  function scan() {
    if (window.__isPanelTransitionBusy?.()) return;
    if (document.hidden || motion.matches || (!positions.size && !document.querySelector(".wo-detail-active, .training-overlay[open]"))) {
      for (const el of positions.keys()) el.scrollLeft = 0;
      positions.clear();
      return;
    }
    const visible = new Set();
    const now = performance.now();
    for (const el of document.querySelectorAll(selector)) {
      const distance = el.scrollWidth - el.clientWidth;
      if (!el.clientWidth || distance < 1) continue;
      visible.add(el);
      const text = el.textContent;
      const previous = positions.get(el);
      if (previous?.distance !== distance || previous.text !== text) {
        positions.set(el, { distance, text, start: now });
      }
    }
    for (const el of positions.keys()) {
      if (visible.has(el)) continue;
      el.scrollLeft = 0;
      positions.delete(el);
    }
    if (positions.size && !frame) frame = requestAnimationFrame(pan);
  }

  setInterval(scan, 500);
  document.addEventListener("visibilitychange", scan);
  motion.addEventListener("change", scan);
})();


/* Keep the touch light clipped to the glass surface that received the gesture. */
(() => {
  const selector = ".main-content :is(.card, .ah-card, .highlight-card, .hl-insight-card, .metric-card, .trend-card, .wo-list-item, .apple-chart-card, .nap-card, .all-data-btn, .fitness-week-card, .fitness-big-rings-card, .hourly-mini-card, .heatmap-card, .race-pred-tile, .day-tile, .wo-card-btn, .grouped-card):not(details), .has-library-glass, .main-content details.card, .pin-editor-surface";
  const layer = document.createElement("span");
  layer.className = "glass-touch-layer";
  layer.setAttribute("aria-hidden", "true");
  const glow = document.createElement("span");
  glow.className = "glass-touch-glow";
  layer.append(glow);
  const rim = document.createElement("span");
  rim.className = "glass-touch-outline";
  const edgeGlow = glow.cloneNode();
  rim.append(edgeGlow);
  layer.append(rim);
  const horizontal = { value: 0, velocity: 0 };
  const vertical = { value: 0, velocity: 0 };
  let lastPaint = null;
  let scrollMoved = false;

  function advance(axis, target, elapsed, rate) {
    const distance = axis.value - target;
    const slope = axis.velocity + rate * distance;
    const decay = Math.exp(-rate * elapsed);
    axis.value = target + (distance + slope * elapsed) * decay;
    axis.velocity = (axis.velocity - rate * slope * elapsed) * decay;
    if (Math.abs(axis.value - target) < .25 && Math.abs(axis.velocity) < 8) {
      axis.value = target;
      axis.velocity = 0;
      return false;
    }
    return true;
  }
  let previousTransform = "";
  let isLit = false;
  let pull = null;
  let draggedCard = null;
  let draggedAt = -Infinity;

  function roundedRectPath(x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    const right = x + width;
    const bottom = y + height;
    return `M${x + r} ${y}H${right - r}Q${right} ${y} ${right} ${y + r}V${bottom - r}Q${right} ${bottom} ${right - r} ${bottom}H${x + r}Q${x} ${bottom} ${x} ${bottom - r}V${y + r}Q${x} ${y} ${x + r} ${y}Z`;
  }

  let surface = null;
  let bounds = null;
  let pointer = null;
  let frame = 0;
  let x = 0;
  let y = 0;

  function paint(now) {
    frame = 0;
    if (!surface?.isConnected) return;
    bounds ||= surface.getBoundingClientRect();
    const targetX = x - bounds.left;
    const targetY = y - bounds.top;
    const tolerance = isLit ? 4 : 0;
    const inside = targetX >= -tolerance && targetX <= bounds.width + tolerance
      && targetY >= -tolerance && targetY <= bounds.height + tolerance;
    if (isLit !== inside) {
      isLit = inside;
      layer.classList.toggle("is-releasing", !inside);
      layer.classList.toggle("visible", inside);
    }
    if (!inside) {
      lastPaint = null;
      return;
    }
    if (lastPaint === null || scrollMoved) {
      scrollMoved = false;
      horizontal.value = targetX;
      horizontal.velocity = 0;
      vertical.value = targetY;
      vertical.velocity = 0;
    }
    const elapsed = Math.min(.032, Math.max(.001, (now - (lastPaint ?? now)) / 1000));
    lastPaint = now;
    const movingX = advance(horizontal, targetX, elapsed, 52);
    const movingY = advance(vertical, targetY, elapsed, 36);
    const localX = horizontal.value;
    const localY = vertical.value;
    const nearEdge = Math.min(localX, localY, bounds.width - localX, bounds.height - localY) < 120;
    const edgeWasVisible = rim.classList.contains("visible");
    rim.classList.toggle("visible", nearEdge);
    const transform = `translate3d(${localX + 1}px, ${localY + 1}px, 0) translate(-50%, -50%)`;
    if (transform !== previousTransform) {
      glow.style.transform = transform;
    }
    if (nearEdge && (!edgeWasVisible || transform !== previousTransform)) edgeGlow.style.transform = transform;
    previousTransform = transform;
    if (movingX || movingY) frame = requestAnimationFrame(paint);
  }

  function move(point) {
    x = point.clientX;
    y = point.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function show(target, id, point) {
    if (!(target instanceof Element) || pointer !== null) return;
    const next = target.closest(selector);
    if (!next) return;
    if (surface !== next || !layer.isConnected) {
      surface?.classList.remove("glass-touch-host");
      surface = next;
      surface.classList.add("glass-touch-host");
      const mount = surface.matches("details") ? surface.querySelector(":scope > summary") : surface;
      layer.style.borderRadius = getComputedStyle(surface).borderRadius;
      layer.classList.toggle("is-compact", surface.matches("#mobile-header, #bottom-dock, #dock-indicator, .detail-nav-bar, .day-nav-bar, .wo-mobile-back-bar"));
      (mount || surface).append(layer);
    }
    pointer = id;
    bounds = null;
    previousTransform = "";
    lastPaint = null;
    scrollMoved = false;
    bounds = surface.getBoundingClientRect();
    const width = layer.clientWidth;
    const height = layer.clientHeight;
    const radius = Number.parseFloat(layer.style.borderRadius) || 0;
    const thickness = 2;
    if (width > thickness * 2 && height > thickness * 2) {
      const outer = roundedRectPath(0, 0, width, height, radius);
      const inner = roundedRectPath(thickness, thickness, width - thickness * 2, height - thickness * 2, Math.max(0, radius - thickness));
      rim.style.clipPath = `path(evenodd, "${outer} ${inner}")`;
    } else {
      rim.style.clipPath = "inset(50%)";
    }
    move(point);
  }

  function clear(immediate = false) {
    if (pull?.active) window.__panelPtr?.onCancelDrag();
    pull = null;
    pointer = null;
    bounds = null;
    cancelAnimationFrame(frame);
    frame = 0;
    if (immediate) layer.classList.remove("visible", "is-releasing");
    else if (isLit) layer.classList.add("is-releasing");
    isLit = false;
    layer.classList.remove("visible");
  }
  window.__clearGlassTouchLight = (immediate = false) => {
    clear(Boolean(immediate));
  };

  let hasNativeSample = false;
  window.__panelLightSample = (nx, ny) => {
    if (typeof pointer !== "string" || pull?.active) return;
    hasNativeSample = true;
    x = nx * window.innerWidth;
    y = ny * window.innerHeight;
    bounds = null;
    scrollMoved = true;
    if (!frame) frame = requestAnimationFrame(paint);
  };

  const options = { passive: true, capture: true };
  window.addEventListener("touchstart", event => {
    hasNativeSample = false;
    draggedCard = null;
    if (event.touches.length > 1) {
      clear();
      return;
    }
    const point = event.changedTouches[0];
    if (!point || !(event.target instanceof Element)) return;
    const id = "touch-" + point.identifier;
    const target = event.target;
    const shell = target.closest("#app-shell");
    if (window.__isPanelTransitionBusy?.()) return;
    if (shell && window.scrollY <= 2 && target.closest(".main-content") &&
        !shell.matches(".detail-active, .wo-detail-active") &&
        !target.closest("dialog, .leaflet-container, .training-overlay, input, .svg-chart-wrap, .apple-svg-chart, .h-scroll-pills, .workout-list, .table-wrap, .heatmap-scroll")) {
      pull = { id, x: point.clientX, y: point.clientY, active: false, target };
    }
    show(target, id, point);
  }, options);
  window.addEventListener("touchmove", event => {
    for (const point of event.changedTouches) {
      const id = "touch-" + point.identifier;
      if (pull?.id === id) {
        const dy = point.clientY - pull.y;
        if (!pull.active && (dy < -6 || Math.abs(point.clientX - pull.x) > Math.max(8, dy) || window.scrollY > 2)) {
          pull = null;
        } else if (dy > 16 || pull.active) {
          pull.active = true;
          window.__panelPtr?.onMove(Math.max(0, dy));
        }
      }
      if (id === pointer && !pull?.active && !hasNativeSample) move(point);
    }
  }, options);
  for (const type of ["touchend", "touchcancel"]) {
    window.addEventListener(type, event => {
      for (const point of event.changedTouches) {
        const id = "touch-" + point.identifier;
        if (pull?.id === id) {
          if (pull.active) {
            draggedCard = pull.target.closest("button, a, summary, [role='button'], .dashboard-card-glass") || pull.target;
            draggedAt = performance.now();
            window.__panelPtr?.onEnd(type === "touchend");
          }
          pull = null;
        }
        if (id === pointer) clear();
      }
    }, options);
  }
  window.addEventListener("pointerdown", event => {
    if (event.isPrimary && event.pointerType === "pen") show(event.target, event.pointerId, event);
  }, options);
  window.addEventListener("pointermove", event => {
    if (event.pointerId === pointer) move(event);
  }, options);
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    window.addEventListener(type, event => {
      if (event.pointerId === pointer) clear();
    }, options);
  }
  window.addEventListener("scroll", () => {
    if (pointer === null) return;
    bounds = null;
    scrollMoved = true;
    if (!frame) frame = requestAnimationFrame(paint);
  }, options);
  window.addEventListener("click", event => {
    if (!event.detail || !draggedCard?.contains(event.target) || performance.now() - draggedAt > 350) return;
    event.preventDefault();
    event.stopPropagation();
    draggedCard = null;
  }, true);
  window.addEventListener("resize", clear, options);
  window.addEventListener("blur", clear);
})();
