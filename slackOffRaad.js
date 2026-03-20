// ==UserScript==
// @name         SlackOffRead-隐藏知乎、V2ex、X、少数派等网站的头部图标和信息，避免老板一眼看出你在摸鱼。
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Hide obvious site header bars and bottom bars on common slack-off websites.
// @author       A2ayak
// @match        *://v2ex.com/*
// @match        *://www.v2ex.com/*
// @match        *://sspai.com/*
// @match        *://www.sspai.com/*
// @match        *://zhihu.com/*
// @match        *://www.zhihu.com/*
// @match        *://x.com/*
// @match        *://www.x.com/*
// @match        *://twitter.com/*
// @match        *://www.twitter.com/*
// @match        *://linux.do/*
// @match        *://www.linux.do/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEYS = {
    enabled: "slackoff:enabled",
    aggressive: "slackoff:aggressive",
    debug: "slackoff:debug"
  };

  const STYLE_ID = "slackoff-style";
  const HIDDEN_ATTR = "data-slackoff-hidden";
  const REASON_ATTR = "data-slackoff-reason";
  const RERUN_DELAY = 120;

  const FRAMEWORK_RULES = {
    discourse: {
      selectors: [".d-header", ".d-header-wrap"],
      optionalSelectors: [".footer-nav"]
    }
  };

  // 站点配置入口：
  // - id: 站点标识，仅用于阅读和排查
  // - hosts: 命中的域名列表，支持主域名和子域名匹配
  // - selectors: 默认隐藏的稳定选择器，优先使用这类规则
  // - optionalSelectors: 仅在 aggressive 模式下启用的附加隐藏规则
  // - framework: 复用通用框架规则，例如 discourse
  // - observer: 是否启用 DOM 监听，适合 SPA 或会动态刷新的站点
  // - mode: safe 表示只吃静态规则，hybrid 表示静态规则 + 通用启发式
  // - heuristics: 站点专属的启发式补充配置
  const SITE_RULES = [
    {
      id: "v2ex",
      hosts: ["v2ex.com", "www.v2ex.com"],
      selectors: ["#Top", "#Bottom"],
      observer: false,
      mode: "safe"
    },
    {
      id: "sspai",
      hosts: ["sspai.com", "www.sspai.com"],
      selectors: ["header.ss__custom__header__wrapper", "nav.home__footer"],
      optionalSelectors: [".app_toolbar"],
      observer: true,
      mode: "safe"
    },
    {
      id: "zhihu",
      hosts: ["zhihu.com", "www.zhihu.com"],
      selectors: [
        "header.AppHeader",
        ".PageBottomFooter",
        ".SignFlowHomepage-footer"
      ],
      optionalSelectors: [
        "[class*='TopstoryTabs']",
        "[class*='ExploreHomePage-footer']"
      ],
      observer: true,
      mode: "safe"
    },
    {
      id: "x",
      hosts: ["x.com", "www.x.com", "twitter.com", "www.twitter.com"],
      // X 这里改成纯静态规则：只隐藏 header 本身和底部 BottomBar，不再碰上层容器。
      selectors: ["[data-testid='BottomBar']"],
      observer: true,
      mode: "safe"
    },
    {
      id: "linuxdo",
      hosts: ["linux.do", "www.linux.do"],
      framework: "discourse",
      selectors: [],
      observer: true,
      mode: "safe"
    }
  ];

  // 通用启发式配置：
  // - candidateSelectors: 会被扫描的候选元素
  // - includeKeywords: 命中这些关键词时，更像是站点头尾栏
  // - excludeKeywords: 命中这些关键词时，避免误杀弹窗、评论区、编辑器等
  // - positions: 只处理 fixed / sticky 之类贴边栏
  // - maxHeight: 超过这个高度就不当作头尾栏处理
  // - minWidthRatio: 元素宽度至少占视口多少比例才考虑隐藏
  // - edgeThreshold: 元素距离顶部或底部多近时才算边缘栏
  // - allowSideRail: 是否允许识别左侧导航轨道
  // - sideRailMaxWidth / sideRailMinHeight / sideRailMaxLeft: 左侧导航轨道的几何约束
  const GENERIC_BAR_RULE = {
    candidateSelectors: [
      "header",
      "nav",
      "footer",
      "[role='banner']",
      "[role='navigation']",
      "[role='contentinfo']",
      "[class*='header']",
      "[class*='Header']",
      "[class*='footer']",
      "[class*='Footer']",
      "[class*='navbar']",
      "[class*='Navbar']",
      "[class*='topbar']",
      "[class*='TopBar']",
      "[class*='bottombar']",
      "[class*='BottomBar']",
      "[class*='tabbar']",
      "[class*='TabBar']",
      "[class*='toolbar']",
      "[class*='Toolbar']",
      "[class*='dock']",
      "[class*='Dock']",
      "[id*='header']",
      "[id*='Header']",
      "[id*='footer']",
      "[id*='Footer']",
      "[id*='topbar']",
      "[id*='TopBar']",
      "[id*='bottombar']",
      "[id*='BottomBar']"
    ],
    includeKeywords: [
      "header",
      "appheader",
      "navbar",
      "topbar",
      "bottombar",
      "tabbar",
      "footer",
      "dock",
      "toolbar",
      "banner",
      "navigation"
    ],
    excludeKeywords: [
      "modal",
      "dialog",
      "drawer",
      "toast",
      "tooltip",
      "popover",
      "dropdown",
      "comment",
      "editor",
      "player",
      "carousel",
      "sidebar",
      "sidepanel"
    ],
    positions: ["fixed", "sticky"],
    maxHeight: 160,
    minWidthRatio: 0.55,
    edgeThreshold: 24,
    allowSideRail: false,
    sideRailMaxWidth: 320,
    sideRailMinHeight: 280,
    sideRailMaxLeft: 120
  };

  const state = {
    enabled: loadFlag(STORAGE_KEYS.enabled, true),
    aggressive: loadFlag(STORAGE_KEYS.aggressive, false),
    debug: loadFlag(STORAGE_KEYS.debug, false),
    observer: null,
    rerunTimer: null,
    currentRule: null
  };

  state.currentRule = resolveRule(window.location.hostname);

  if (!state.currentRule) {
    return;
  }

  compileAndApply();
  startLifecycle();

  function startLifecycle() {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
    } else {
      onReady();
    }

    window.addEventListener("keydown", onKeydown, true);
    window.addEventListener("resize", scheduleApply, { passive: true });
    window.addEventListener("hashchange", scheduleApply, { passive: true });
    window.addEventListener("popstate", scheduleApply, { passive: true });
  }

  function onReady() {
    compileAndApply();
    if (state.currentRule.observer) {
      startObserver();
    }
  }

  function onKeydown(event) {
    if (!(event.altKey && event.shiftKey)) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "s") {
      state.enabled = !state.enabled;
      saveFlag(STORAGE_KEYS.enabled, state.enabled);
      compileAndApply();
      log("enabled", state.enabled);
      return;
    }

    if (key === "a") {
      state.aggressive = !state.aggressive;
      saveFlag(STORAGE_KEYS.aggressive, state.aggressive);
      compileAndApply();
      log("aggressive", state.aggressive);
      return;
    }

    if (key === "d") {
      state.debug = !state.debug;
      saveFlag(STORAGE_KEYS.debug, state.debug);
      log("debug", state.debug);
      scheduleApply();
    }
  }

  function startObserver() {
    if (state.observer || !document.documentElement) {
      return;
    }

    state.observer = new MutationObserver(() => {
      scheduleApply();
    });

    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style", "aria-label", "role"]
    });
  }

  function scheduleApply() {
    window.clearTimeout(state.rerunTimer);
    state.rerunTimer = window.setTimeout(() => {
      compileAndApply();
    }, RERUN_DELAY);
  }

  function compileAndApply() {
    // 第一层：站点规则和框架规则，直接注入 CSS 隐藏。
    applyStaticCss();

    if (!state.enabled) {
      clearGenericMarks();
      return;
    }

    // 第二层 / 第三层：只在 hybrid 站点上补动态启发式隐藏。
    applyHeuristicHiding();
  }

  function applyStaticCss() {
    const styleEl = ensureStyleElement();
    const selectors = collectStaticSelectors();
    const cssLines = [];

    if (selectors.length > 0) {
      cssLines.push(`${selectors.join(",\n")} { display: none !important; }`);
    }

    cssLines.push(`[${HIDDEN_ATTR}="1"] { display: none !important; }`);
    styleEl.textContent = state.enabled ? cssLines.join("\n\n") : "";
  }

  function collectStaticSelectors() {
    if (!state.currentRule) {
      return [];
    }

    const selectors = [];
    selectors.push(...normalizeSelectors(state.currentRule.selectors));

    if (
      state.currentRule.framework &&
      FRAMEWORK_RULES[state.currentRule.framework]
    ) {
      selectors.push(
        ...normalizeSelectors(
          FRAMEWORK_RULES[state.currentRule.framework].selectors
        )
      );
      if (state.aggressive) {
        selectors.push(
          ...normalizeSelectors(
            FRAMEWORK_RULES[state.currentRule.framework].optionalSelectors
          )
        );
      }
    }

    if (state.aggressive) {
      selectors.push(
        ...normalizeSelectors(state.currentRule.optionalSelectors)
      );
    }

    return [...new Set(selectors)];
  }

  function applyHeuristicHiding() {
    clearGenericMarks();

    const candidateSelectors = collectHeuristicSelectors();
    if (!candidateSelectors.length) {
      return;
    }

    const candidates = collectCandidates(candidateSelectors);
    for (const element of candidates) {
      if (shouldHideHeuristicElement(element)) {
        markElement(element, "heuristic");
      }
    }
  }

  function collectHeuristicSelectors() {
    const selectors = [];

    if (state.currentRule.mode === "hybrid") {
      selectors.push(...GENERIC_BAR_RULE.candidateSelectors);
    }

    if (state.currentRule.heuristics?.candidateSelectors) {
      selectors.push(...state.currentRule.heuristics.candidateSelectors);
    }

    return [...new Set(selectors)];
  }

  function collectCandidates(selectors) {
    const result = new Set();

    for (const selector of selectors) {
      try {
        for (const element of document.querySelectorAll(selector)) {
          result.add(element);
        }
      } catch (error) {
        log("invalid selector", selector, error);
      }
    }

    return [...result];
  }

  function shouldHideHeuristicElement(element) {
    if (!(element instanceof HTMLElement)) {
      return false;
    }

    if (
      element.hasAttribute(HIDDEN_ATTR) ||
      element.closest(`[${HIDDEN_ATTR}="1"]`)
    ) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const heuristicRule = getHeuristicRule();
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return false;
    }

    if (rect.height > heuristicRule.maxHeight) {
      return false;
    }

    if (!heuristicRule.positions.includes(style.position)) {
      return false;
    }

    const semantics = collectSemanticText(element);
    if (containsKeyword(semantics, GENERIC_BAR_RULE.excludeKeywords)) {
      return false;
    }

    const nearTop = rect.top <= heuristicRule.edgeThreshold;
    const nearBottom =
      window.innerHeight - rect.bottom <= heuristicRule.edgeThreshold;
    const isSideRail = isLikelySideRail(
      element,
      rect,
      semantics,
      heuristicRule
    );

    if (
      !isSideRail &&
      rect.width < window.innerWidth * heuristicRule.minWidthRatio
    ) {
      return false;
    }

    if (!nearTop && !nearBottom && !isSideRail) {
      return false;
    }

    const looksSemantic =
      ["HEADER", "NAV", "FOOTER"].includes(element.tagName) ||
      ["banner", "navigation", "contentinfo"].includes(
        (element.getAttribute("role") || "").toLowerCase()
      ) ||
      containsKeyword(semantics, GENERIC_BAR_RULE.includeKeywords);

    if (!looksSemantic) {
      return false;
    }

    return true;
  }

  function getHeuristicRule() {
    return {
      ...GENERIC_BAR_RULE,
      ...(state.currentRule?.heuristics || {})
    };
  }

  function isLikelySideRail(element, rect, semantics, heuristicRule) {
    if (!heuristicRule.allowSideRail) {
      return false;
    }

    const role = (element.getAttribute("role") || "").toLowerCase();
    const isNavigationLike =
      element.tagName === "NAV" ||
      role === "navigation" ||
      containsKeyword(semantics, ["navigation", "sidebar"]);

    return (
      isNavigationLike &&
      rect.left <= heuristicRule.sideRailMaxLeft &&
      rect.width <= heuristicRule.sideRailMaxWidth &&
      rect.height >= heuristicRule.sideRailMinHeight
    );
  }

  function markElement(element, reason) {
    element.setAttribute(HIDDEN_ATTR, "1");
    element.setAttribute(REASON_ATTR, reason);

    if (state.debug) {
      log("hide", describeElement(element), reason);
    }
  }

  function clearGenericMarks() {
    const marked = document.querySelectorAll(`[${HIDDEN_ATTR}="1"]`);
    for (const element of marked) {
      element.removeAttribute(HIDDEN_ATTR);
      element.removeAttribute(REASON_ATTR);
    }
  }

  function resolveRule(hostname) {
    const normalized = hostname.toLowerCase();
    return SITE_RULES.find((rule) =>
      rule.hosts.some((host) => hostMatches(normalized, host))
    );
  }

  function hostMatches(hostname, host) {
    return hostname === host || hostname.endsWith(`.${host}`);
  }

  function normalizeSelectors(selectors) {
    return (selectors || []).filter(Boolean);
  }

  function collectSemanticText(element) {
    const parts = [
      element.tagName,
      element.id,
      getClassName(element),
      element.getAttribute("role"),
      element.getAttribute("aria-label"),
      element.getAttribute("data-testid")
    ];

    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function containsKeyword(text, keywords) {
    return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
  }

  function getClassName(element) {
    if (typeof element.className === "string") {
      return element.className;
    }

    if (element.className && typeof element.className.baseVal === "string") {
      return element.className.baseVal;
    }

    return "";
  }

  function ensureStyleElement() {
    let styleEl = document.getElementById(STYLE_ID);
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(styleEl);
    }
    return styleEl;
  }

  function loadFlag(key, fallbackValue) {
    try {
      const value = window.localStorage.getItem(key);
      if (value === null) {
        return fallbackValue;
      }
      return value === "1";
    } catch {
      return fallbackValue;
    }
  }

  function saveFlag(key, value) {
    try {
      window.localStorage.setItem(key, value ? "1" : "0");
    } catch {
      // 某些受限站点可能不允许写 localStorage，这里直接忽略。
    }
  }

  function describeElement(element) {
    const id = element.id ? `#${element.id}` : "";
    const className = getClassName(element)
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3)
      .map((name) => `.${name}`)
      .join("");
    return `${element.tagName.toLowerCase()}${id}${className}`;
  }

  function log(...args) {
    if (!state.debug) {
      return;
    }
    console.info("[slackoff]", ...args);
  }
})();
