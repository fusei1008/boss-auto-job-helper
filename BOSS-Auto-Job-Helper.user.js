// ==UserScript==
// @name         BOSS 直聘全自动求职助手 (Jev 深度研判·智能低频防封版)
// @namespace    local.boss-auto-helper
// @version      1.6.0
// @description  基于 TypeSafe Jev 多维正交语义深度研判与战略择优投递。支持真研发深度量化、外包与培训陷阱拦截、资历层级校验与超低频真人慢速巡检。
// @author       niz
// @license      MIT
// @homepageURL  https://github.com/fusei1008/boss-auto-job-helper
// @supportURL   https://github.com/fusei1008/boss-auto-job-helper/issues
// @match        https://zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @connect      api.typesafe.ai
// @connect      openrouter.ai
// ==/UserScript==

(function () {
  "use strict";

  // 避免在第三方 iframe 或风控验证框 iframe 中重复加载
  if (window.top !== window.self) return;

  const PANEL_ID = "boss-auto-helper-panel";
  const STYLE_ID = "boss-auto-helper-style";
  const SETTINGS_VERSION = "v1.5.0";

  // 单次投递间隔的硬下限（秒）
  const MIN_INTERVAL_SEC = 20;
  // 已阅岗位缓存上限
  const MAX_VISITED = 2500;
  // 日志保留条数
  const MAX_LOGS = 100;
  // 连续异常达到此值自动暂停
  const MAX_CONSECUTIVE_FAILURES = 5;
  // 连续拉取都没有新岗位时停止
  const MAX_EMPTY_LOAD_ROUNDS = 6;
  // 等待右侧详情切换的最长时间
  const DETAIL_TIMEOUT_MS = 6000;
  // 点击沟通后等待平台反馈的最长时间
  const CONFIRM_TIMEOUT_MS = 8000;
  // Jev 决策记录保留条数
  const MAX_JEV_DECISIONS = 300;
  // Jev 连续调用失败达到此值自动暂停（绝不降级为纯规则投递）
  const MAX_JEV_FAILURES = 3;

  const STORAGE_KEYS = {
    settings: "bossAutoHelper.settings",
    stats: "bossAutoHelper.stats",
    visited: "bossAutoHelper.visitedJobs",
    logs: "bossAutoHelper.logs",
    pending: "bossAutoHelper.pendingContact",
    applied: "bossAutoHelper.appliedCompanies",
    jevDecisions: "bossAutoHelper.jevDecisions",
    jevApiKey: "TYPESAFE_API_KEY"
  };

  // 必须在 state 初始化之前求值：loadSettings/loadStats 都会经过 storeGet
  const hasGM = typeof GM_getValue === "function" && typeof GM_setValue === "function";

  // 页面选择器集中放置：平台改版时只需要改这里。
  // 数组表示按顺序尝试，取第一个有结果的。
  const SEL = {
    jobCard: [".job-card-wrap", ".job-card-box", ".job-card-wrapper", "[class*='job-card']", ".job-list-box li"],
    cardClickTarget: ".job-card-box, .job-card-left, .job-card-body, [class*='job-title']",
    activeCard: ".job-card-wrap.active",
    jobName: ".job-name, [class*='job-name']",
    company: ".boss-name, .company-name, [class*='company-name']",
    salary: ".job-salary, [class*='salary']",
    tags: [".tag-list li", ".job-card-footer li", "[class*='tag']"],
    detail: [".job-detail-box", ".job-detail-body", ".job-detail", "[class*='job-detail']", ".detail-content", ".job-sec-text"],
    // 详情面板里的纯职位描述正文（不含按钮、BOSS 信息、公司介绍）
    jdText: ".job-sec-text",
    contactButton: ".op-btn-chat, .btn-startchat, [class*='btn-chat'], [class*='op-btn'], a, button",
    dialog: ".dialog-wrap, .boss-popup__wrapper, .boss-dialog, [role='dialog'], .verify-slider, .geetest_panel",
    anyButton: "button, a, .btn, [class*='btn']",
    chatInput: ".chat-conversation .chat-input, .chat-input, .chat-editor, textarea[placeholder*='打招呼'], textarea[placeholder*='留个言'], textarea, [contenteditable='true']",
    sendButton: ".chat-conversation .btn-send, .btn-send, [class*='btn-send']",
    pagerNext: "a, button, [class*='next'], [class*='arrow-right']"
  };

  // 预设配置库：支持一键在前端快速切换
  const PRESETS = {
    bio_rd: {
      name: "🧬 生物研发(分子/合成生物/蛋白/抗体/多肽)",
      candidateProfile: "求职意向：生物研发工程师、分子生物研究员、蛋白纯化/表达研发助理。\n学历与技能：生物学/生物工程相关硕士或优秀本科。精通分子克隆、质粒构建、重组蛋白表达与纯化（AKTA/FPLC）、抗体工程、噬菌体展示或多肽合成，具备严谨扎实的实验与记录功底。\n核心偏好：正规生物医药企业或研发机构的研发主业。\n绝对排除：劳务派遣外包、医药电话销售、医药招商、动物房日常清洗打杂、纯流水线车间操作工。",
      includeKeywords: "分子生物, 合成生物, 重组蛋白, 蛋白纯化, 蛋白表达, 多肽, 环肽, 噬菌体, 噬菌体展示, 抗体, 抗体工程, 酶催化, 载体构建, 质粒构建, 基因克隆, FPLC, AKTA, 生物淘选, 生物合成, 生化研发, 蛋白工程, 分子克隆, 表达纯化, 纯化表征, 研发研究员, 研发工程师, 生物研发, 科研助理, 研发助理",
      excludeKeywords: "销售, 电销, 电话销售, 微信销售, 网络销售, 社群, 推广, 地推, 客服, 招商, 顾问, 渠道, 商务拓展, 猎头, 保险, 催收, 房产, 普工, 兼职, 劳务派遣, 操作工, 包装工, 产线流水线, 车间工人, 动物房饲养员, 饲养员, 临床协调, CRA, CRC, 招投标, 采购, 申报专员",
      greetingText: "您好！我是xxx。看到贵司正在招聘此岗位，与我的研发经历高度匹配。希望能向您呈递详细简历并深入沟通！",
      minSalaryK: 7,
      jevMinDepth: 1.0
    },
    bioinfo_ai: {
      name: "💻 生信分析/AI科研助理/计算生物",
      candidateProfile: "求职意向：生信分析工程师、AI科研助理、计算生物研究员。\n学历与技能：生物信息学/计算生物学/计算机/生物技术专业背景。精通使用 Python/R 开展组学数据挖掘、NGS 二代/三代高通量测序流程搭建、单细胞分析、分子对接、蛋白质结构预测（AlphaFold）或机器学习建模。\n核心偏好：具有真正数据挖掘与前沿流程搭建价值的核心技术岗位。\n绝对排除：中介外包派遣、低端数据录入、非技术性IT网管运维、挂名销售、转岗培训机构。",
      includeKeywords: "生信, 生信分析, 生信工程师, 计算生物, 计算化学, AI研究助理, AI助理, 数据分析, Python, 算法, 结构生物, 分子模拟, 分子对接, 药物设计, 机器学习, 科研助理, 研发助理",
      excludeKeywords: "销售, 电销, 客服, 招商, 普工, 操作工, 包装工, 产线流水线, 劳务派遣, 兼职",
      greetingText: "您好！我对该岗位非常感兴趣。我是xxx,在科研中熟练使用Python进行生物数据挖掘、序列/结构建模与自动化分析，熟悉各类AI辅助科研工具。希望能向您呈递详细简历并进一步沟通！",
      minSalaryK: 8,
      jevMinDepth: 1.0
    },
    qc_analysis: {
      name: "🧪 分析检测/质检/理化实验",
      candidateProfile: "求职意向：QC理化分析员、分析检测工程师、实验员、助理工程师。\n学历与技能：分析化学/药物分析/生物医药专业。精通高效液相色谱（HPLC）、气相色谱（GC）、质谱分析等仪器操作与方法验证，严格遵循 GMP/GLP 规范。\n核心偏好：规范仪器分析与研发质检岗位。\n绝对排除：车间纯体力包装搬运工、无仪器操作的简单巡检、电话客服、劳务中介派遣。",
      includeKeywords: "分析检测, 质检, QA, QC, 理化检验, 检验员, 实验员, 化验员, 仪器分析, 色谱分析, HPLC, 质谱分析, 研发助理, 助理工程师",
      excludeKeywords: "销售, 电销, 客服, 招商, 普工, 兼职, 劳务派遣, 操作工, 包装工, 产线流水线",
      greetingText: "您好！我对贵司该岗位很感兴趣。我是xx，具备扎实的实验操作、分析检测（HPLC/质谱）与数据分析能力，踏实严谨。希望能向您呈递详细简历并进一步交流！",
      minSalaryK: 6,
      // QC 岗天然处在"按 SOP 执行"这一级（深度约 1），门槛放低一点
      jevMinDepth: 0.7
    }
  };

  // 默认配置
  const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    // 最小安全投递间隔 45 秒 (慢速低频)
    intervalMin: 45,
    // 最大安全投递间隔 90 秒 (慢速低频，不给平台造成压力)
    intervalMax: 90,
    // 每日低频适度上限 (建议 30-50，安全稳定)
    dailyMax: 40,
    minSalaryK: PRESETS.bio_rd.minSalaryK,
    // 自动排除实习生岗位
    excludeInternships: true,
    // 卡片标签要求的最低经验年限 ≥ 此值时跳过（0 表示不限；应届生建议 3，即跳过 3-5年 及以上）
    maxExpYears: 3,
    // 跳过学历标签为博士的岗位
    skipPhdJobs: true,
    // 尊重 BOSS 原生机制：点击立即沟通由平台原生发出官方打招呼
    autoSendGreeting: false,
    greetingText: PRESETS.bio_rd.greetingText,
    includeKeywords: PRESETS.bio_rd.includeKeywords,
    excludeKeywords: PRESETS.bio_rd.excludeKeywords,
    panelCollapsed: false,
    panelHidden: false,
    panelX: null,
    panelY: null,
    // Jev 智能研判深度配置
    jevEnabled: true,
    jevApiKey: "",
    candidateProfile: PRESETS.bio_rd.candidateProfile,
    // 最低研发深度门槛 (0~2，低于此值视为低端打杂)
    jevMinDepth: PRESETS.bio_rd.jevMinDepth,
    // 陷阱可疑阈值：派遣/收费培训/伪销售/触犯排除项任一概率高于此值转人工复核（≥0.7 直接拒）
    jevMaxTrap: 0.35,
    // 自动投递的最低等级：S / A / B，低于此等级但通过研判的岗位记为备选
    jevMinTier: "A",
    // 校准模式：只研判、打标记，不点沟通、不占额度、不写入已阅
    jevDryRun: false,
    activeTab: "jev"
  };

  // Jev 分级的高低顺序（sanitizeSettings 在 state 初始化时就会用到，必须放在 state 之前）
  const JEV_TIER_RANK = { S: 3, A: 2, B: 1 };

  const STATUS_LABELS = {
    IDLE: "空闲",
    RUNNING: "低频运行中",
    PAUSED: "已暂停",
    STOPPED: "已停止",
    ERROR: "异常保护停止"
  };

  // 泛研发领域词：仅在 Jev 研判开启时生效。标题/标签没命中包含词、但带有这些词的岗位（如"研究员""实验员""蛋白科学家"）
  // 也点开详情交给 Jev 判断对口程度；纯规则模式下不使用，保持原有的严格预筛
  const BROAD_TECH_WORDS = [
    "研发", "研究", "实验", "科研", "生物", "生信", "医药", "药物", "制药", "蛋白",
    "抗体", "细胞", "分子", "基因", "检测", "分析", "质检", "质控", "化验", "算法"
  ];

  // 风控与拦截特征（弹窗文本 / 页面路径）
  const RISK_PATTERN = /验证码|安全验证|身份验证|请先登录|扫码登录|异常访问|访问受限|访问过于频繁|操作过于频繁|账号存在风险|账户存在风险|当前操作存在风险|安全风险|请稍后再试|人机验证|拖动滑块|请完成验证/;
  const RISK_PATH_PATTERN = /captcha|\/verify|\/login|passport|security/i;
  // 平台每日沟通上限提示（例如“您今天已与120位BOSS沟通”）
  const LIMIT_PATTERN = /已与\s*\d+\s*位\s*BOSS\s*沟通|沟通(?:次数|人数)|已达上限|达到上限|次数已用完|明天再来|明日再试/i;

  const CONTACT_SKIP_LABELS = {
    already_contacted: "此前已沟通",
    app_only: "需在APP内沟通",
    closed: "职位已关闭",
    disabled: "沟通按钮不可用"
  };

  // 状态机
  const state = {
    mode: "IDLE",
    isRunning: false,
    settings: loadSettings(),
    stats: loadStats(),
    visitedKeys: loadVisited(),
    logs: loadLogs(),
    kw: { include: [], exclude: [] },
    batchCount: 0,
    consecutiveFailures: 0,
    // Jev 连续调用失败次数（与页面异常分开计数）
    jevFailures: 0,
    // 校准模式下本次会话已研判的岗位（不落盘，正式投递时会重新评估）
    sessionSeen: new Set(),
    emptyRounds: 0,
    currentMessage: "低频助手已就绪，点击【开始低频投递】",
    currentCompany: "",
    currentTitle: ""
  };

  // ========================== 本地存储辅助 ==========================
  function storeGet(key, fallback) {
    try {
      if (hasGM) {
        const v = GM_getValue(key, undefined);
        return v === undefined ? fallback : v;
      }
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function storeSet(key, value) {
    try {
      if (hasGM) GM_setValue(key, value);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  }

  function loadAppliedCompanies() {
    return storeGet(STORAGE_KEYS.applied, []);
  }

  function recordAppliedCompany(company, title, salary) {
    if (!company) return;
    const list = loadAppliedCompanies();
    const key = `${company}_${title || ""}`;
    const idx = list.findIndex(item => item.key === key);
    const record = {
      key,
      company,
      title: title || "研发岗位",
      salary: salary || "",
      date: todayKey(),
      time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
    };
    if (idx >= 0) {
      list[idx] = record;
    } else {
      list.push(record);
    }
    const trimmed = list.slice(-1000);
    storeSet(STORAGE_KEYS.applied, trimmed);
  }

  function exportAppliedCompanies() {
    const list = loadAppliedCompanies();
    if (!list.length) {
      alert("目前暂无已投递公司记录！只要运行助手沟通岗位，或者在页面中点击卡片，都会自动记录。");
      return;
    }
    const jsonStr = JSON.stringify(list, null, 2);
    const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `boss_applied_companies_${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    addLog(`📥 已导出 ${list.length} 家公司名单 (可直接拖入Python直投工具运行)`);
  }

  function showAppliedCompaniesModal() {
    const list = loadAppliedCompanies();
    if (!list.length) {
      alert("目前暂无已投递公司记录！只要运行助手沟通岗位，或者在页面中点击卡片，都会自动记录。");
      return;
    }
    const lines = list.map(item => `${item.company} ${item.title || "研发工程师"}`).join("\n");
    
    // 移除已有弹窗
    const old = document.getElementById("bh-export-modal");
    if (old) old.remove();

    const modal = document.createElement("div");
    modal.id = "bh-export-modal";
    modal.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:99999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);";
    modal.innerHTML = `
      <div style="background:#ffffff;border-radius:12px;width:560px;max-width:92%;padding:22px 24px;box-shadow:0 16px 40px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:13px;color:#1e293b;box-sizing:border-box;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;border-bottom:1px solid #e2e8f0;padding-bottom:10px;">
          <b style="font-size:15px;color:#0d9488;">📋 目标公司名单 (共 ${list.length} 家)</b>
          <button id="bh-modal-close" style="border:none;background:none;font-size:22px;line-height:1;cursor:pointer;color:#94a3b8;">&times;</button>
        </div>
        <p style="font-size:12px;color:#64748b;margin:0 0 10px 0;line-height:1.5;">
          💡 <b>NAS / 远程浏览器专属快捷方式</b>：无需在 NAS 容器内翻找下载目录！直接点击下方【一键复制】，粘贴到本地电脑的 <b>companies.txt</b> 即可直接开始 Python 邮箱挖掘：
        </p>
        <textarea id="bh-modal-txt" style="width:100%;height:190px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-family:Consolas,monospace;font-size:12px;box-sizing:border-box;background:#f8fafc;color:#0f172a;line-height:1.5;resize:vertical;" readonly>${lines}</textarea>
        <div style="margin-top:14px;display:flex;justify-content:space-between;align-items:center;">
          <span id="bh-copy-tip" style="font-size:12px;color:#059669;font-weight:600;"></span>
          <div style="display:flex;gap:8px;">
            <button id="bh-btn-copy-txt" style="background:#0d9488;color:#ffffff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-weight:600;font-size:12px;">📋 一键复制到剪贴板</button>
            <button id="bh-btn-dl-json" style="background:#f1f5f9;color:#334155;border:1px solid #cbd5e1;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:12px;">📥 另存为 JSON 文件</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const txtArea = modal.querySelector("#bh-modal-txt");
    txtArea.focus();
    txtArea.select();

    modal.querySelector("#bh-modal-close").addEventListener("click", () => modal.remove());

    modal.querySelector("#bh-btn-copy-txt").addEventListener("click", () => {
      txtArea.select();
      let ok = false;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(lines).then(() => {
          modal.querySelector("#bh-copy-tip").textContent = "✅ 已成功复制到剪贴板！";
        }).catch(() => {
          document.execCommand("copy");
          modal.querySelector("#bh-copy-tip").textContent = "✅ 已复制到剪贴板！";
        });
        ok = true;
      }
      if (!ok) {
        document.execCommand("copy");
        modal.querySelector("#bh-copy-tip").textContent = "✅ 已复制到剪贴板！";
      }
    });

    modal.querySelector("#bh-btn-dl-json").addEventListener("click", () => {
      exportAppliedCompanies();
    });

    modal.addEventListener("click", e => {
      if (e.target === modal) modal.remove();
    });
  }

  function setCurrentTarget(company, title) {
    if (!company) return;
    state.currentCompany = company;
    state.currentTitle = title || "";
    const p = document.getElementById(PANEL_ID);
    if (p) {
      const el = p.querySelector('[data-role="hunter-company"]');
      if (el) el.textContent = `${company} · ${title || ""}`.slice(0, 22);
    }
  }

  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function freshStats() {
    return { date: todayKey(), success: 0, skipped: 0, failed: 0 };
  }

  function loadStats() {
    const stored = storeGet(STORAGE_KEYS.stats, null);
    if (!stored || stored.date !== todayKey()) return freshStats();
    return { ...freshStats(), ...stored };
  }

  function saveStats() {
    storeSet(STORAGE_KEYS.stats, state.stats);
  }

  // 跨天仍在运行时自动归零
  function rollStatsIfNewDay() {
    if (state.stats.date === todayKey()) return;
    state.stats = freshStats();
    saveStats();
    addLog("已跨天，今日统计自动归零");
  }

  function loadVisited() {
    const list = storeGet(STORAGE_KEYS.visited, []);
    return new Set(Array.isArray(list) ? list.slice(-MAX_VISITED) : []);
  }

  function recordVisited(key) {
    if (!key) return;
    state.visitedKeys.add(key);
    if (state.visitedKeys.size > MAX_VISITED) {
      state.visitedKeys = new Set(Array.from(state.visitedKeys).slice(-MAX_VISITED));
    }
    storeSet(STORAGE_KEYS.visited, Array.from(state.visitedKeys));
  }

  function loadLogs() {
    const stored = storeGet(STORAGE_KEYS.logs, []);
    return Array.isArray(stored) ? stored.slice(-MAX_LOGS) : [];
  }

  function addLog(msg) {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    state.logs.push(`[${time}] ${msg}`);
    if (state.logs.length > MAX_LOGS) state.logs = state.logs.slice(-MAX_LOGS);
    storeSet(STORAGE_KEYS.logs, state.logs);
    renderStatus();
  }

  function clampNum(value, min, max, fallback, integer = true) {
    let n = value === "" || value === null || value === undefined ? NaN : Number(value);
    if (!Number.isFinite(n)) n = fallback;
    if (integer) n = Math.round(n);
    return Math.min(max, Math.max(min, n));
  }

  // 每次读取/保存都做一次规整：老版本设置和手输的异常值在这里统一收口。
  // 若检测到属于旧版化妆品关键词或版本升级，自动平滑升级为生物医药高转化预设。
  function sanitizeSettings(raw) {
    const src = raw && typeof raw === "object" ? { ...raw } : {};
    const isOldVersion = !src.version || src.version !== SETTINGS_VERSION;
    const hasOldKeywords = typeof src.includeKeywords === "string" && (src.includeKeywords.includes("化妆品研发") || src.includeKeywords.includes("配方师"));

    if (isOldVersion || hasOldKeywords) {
      src.includeKeywords = DEFAULT_SETTINGS.includeKeywords;
      src.excludeKeywords = DEFAULT_SETTINGS.excludeKeywords;
      src.greetingText = DEFAULT_SETTINGS.greetingText;
      src.minSalaryK = DEFAULT_SETTINGS.minSalaryK;
    }

    const s = { ...DEFAULT_SETTINGS, ...src, version: SETTINGS_VERSION };
    s.intervalMin = clampNum(s.intervalMin, MIN_INTERVAL_SEC, 300, DEFAULT_SETTINGS.intervalMin);
    s.intervalMax = clampNum(s.intervalMax, s.intervalMin, 600, DEFAULT_SETTINGS.intervalMax);
    s.dailyMax = clampNum(s.dailyMax, 1, 150, DEFAULT_SETTINGS.dailyMax);
    s.minSalaryK = clampNum(s.minSalaryK, 0, 100, DEFAULT_SETTINGS.minSalaryK, false);
    s.excludeInternships = Boolean(s.excludeInternships);
    s.maxExpYears = clampNum(s.maxExpYears, 0, 20, DEFAULT_SETTINGS.maxExpYears);
    s.skipPhdJobs = Boolean(s.skipPhdJobs ?? DEFAULT_SETTINGS.skipPhdJobs);
    s.autoSendGreeting = Boolean(s.autoSendGreeting);
    s.includeKeywords = String(s.includeKeywords ?? "").trim();
    s.excludeKeywords = String(s.excludeKeywords ?? "").trim();
    s.greetingText = String(s.greetingText ?? "").trim();
    s.panelCollapsed = Boolean(s.panelCollapsed);
    s.panelHidden = Boolean(s.panelHidden);
    s.panelX = typeof s.panelX === "string" ? s.panelX : null;
    s.panelY = typeof s.panelY === "string" ? s.panelY : null;

    // Jev 智能设置规整
    s.jevEnabled = Boolean(s.jevEnabled ?? DEFAULT_SETTINGS.jevEnabled);
    s.jevApiKey = String(s.jevApiKey || storeGet(STORAGE_KEYS.jevApiKey, "") || "").trim();
    s.candidateProfile = String(s.candidateProfile || DEFAULT_SETTINGS.candidateProfile).trim();
    s.jevMinDepth = clampNum(s.jevMinDepth, 0, 2, DEFAULT_SETTINGS.jevMinDepth, false);
    s.jevMaxTrap = clampNum(s.jevMaxTrap, 0.05, 0.95, DEFAULT_SETTINGS.jevMaxTrap, false);
    s.jevMinTier = JEV_TIER_RANK[s.jevMinTier] ? s.jevMinTier : DEFAULT_SETTINGS.jevMinTier;
    s.jevDryRun = Boolean(s.jevDryRun);
    delete s.jevOnlySAndA; // 旧版开关，已由 jevMinTier 取代
    s.activeTab = String(s.activeTab || DEFAULT_SETTINGS.activeTab || "jev");
    return s;
  }

  function loadSettings() {
    const stored = storeGet(STORAGE_KEYS.settings, null);
    const merged = sanitizeSettings(stored);
    if (!stored || stored.version !== SETTINGS_VERSION) storeSet(STORAGE_KEYS.settings, merged);
    return merged;
  }

  function saveSettings(patch) {
    if (patch && patch.jevApiKey !== undefined) {
      storeSet(STORAGE_KEYS.jevApiKey, String(patch.jevApiKey || "").trim());
    }
    state.settings = sanitizeSettings({ ...state.settings, ...patch });
    storeSet(STORAGE_KEYS.settings, state.settings);
    rebuildKeywordCache();
    syncInputsFromSettings(false);
    renderStatus();
  }

  function rebuildKeywordCache() {
    state.kw = {
      include: buildMatchers(parseKeywords(state.settings.includeKeywords)),
      exclude: buildMatchers(parseKeywords(state.settings.excludeKeywords))
    };
  }

  // 沟通意图先落盘再点击：若点击后页面跳转/刷新，下次加载时能补记，避免重复联系或少计配额
  function savePendingContact(info) {
    storeSet(STORAGE_KEYS.pending, info);
  }

  function clearPendingContact() {
    storeSet(STORAGE_KEYS.pending, null);
  }

  function settlePendingContactOnLoad() {
    const pending = storeGet(STORAGE_KEYS.pending, null);
    if (!pending || !pending.key) return;
    clearPendingContact();
    const sameDay = pending.date === todayKey();
    if (sameDay) {
      state.stats.success++;
      saveStats();
    }
    addLog(`上次点击沟通后页面已跳转，未能当场确认：${pending.company} · ${pending.title}（${sameDay ? "已按成功计入今日" : "非今日，不计入"}）`);
  }

  // 声音提示（温和蜂鸣提醒）
  function playBeep(freq = 440, durationMs = 200) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      setTimeout(() => {
        osc.stop();
        ctx.close();
      }, durationMs);
    } catch {}
  }

  function notify(text) {
    if (typeof GM_notification === "function") {
      try {
        GM_notification({ title: "BOSS求职助手", text });
      } catch {}
    }
  }

  // ========================== 薪资字体解密 ==========================
  // BOSS 自定义字体 kanzhun-mix 把数字 0-9 渲染到私用区码点 U+E031..U+E03A，
  // 接口与 DOM 文本里都是这些码点（2026-09 实测）。换字体时只需更新这个基准值。
  const SALARY_PUA_BASE = 0xe031;

  function decodeBossSalary(text) {
    if (!text || typeof text !== "string") return "";
    let out = "";
    for (const ch of text) {
      const code = ch.codePointAt(0);
      out += code >= SALARY_PUA_BASE && code <= SALARY_PUA_BASE + 9 ? String(code - SALARY_PUA_BASE) : ch;
    }
    return out;
  }

  // 返回月薪下限（单位 K）；日薪/时薪/面议/无法识别时返回 null（不做过滤）
  function parseSalaryMinK(rawSalary) {
    const s = decodeBossSalary(rawSalary).replace(/\s/g, "").replace(/[·•]?\d{1,2}薪$/, "");
    if (!s || /日|天|时|周|面议/.test(s)) return null;
    if (/年/.test(s)) {
      const ym = s.match(/^(\d+(?:\.\d+)?)(?:[-–—~至]\d+(?:\.\d+)?)?[万Ww]/);
      return ym ? (Number(ym[1]) * 10) / 12 : null;
    }
    // 8-13K / 8K-13K / 1-2万 / 5000-8000元 / 5000-8000 / 10K以上 / 15K
    const m = s.match(/^(\d+(?:\.\d+)?)([kK]|万|元)?(?:[-–—~至](\d+(?:\.\d+)?))?([kK]|万|元)?(?:\/月)?(?:以上|起)?$/);
    if (!m) return null;
    const min = Number(m[1]);
    const unit = m[4] || m[2] || "";
    let factor;
    if (unit === "万") factor = 10;
    else if (unit === "元") factor = 0.001;
    else if (unit) factor = 1;
    else factor = min >= 1000 ? 0.001 : 1; // 无单位：四位数按元，否则按 K
    return min * factor;
  }

  function formatK(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }

  // ========================== 关键词过滤 ==========================
  function parseKeywords(str) {
    return String(str || "")
      .split(/[\s,，、;；|]+/)
      .map(k => k.trim())
      .filter(Boolean);
  }

  // 纯英文/数字的关键词（AI、QA、QC、Python）按整词匹配，避免 email、Shanghai、maintain 等误命中 “ai”；
  // 含中文的关键词按子串匹配。
  function buildMatchers(list) {
    return list.map(raw => {
      const kw = raw.toLowerCase();
      if (/^[a-z0-9+#.]+$/.test(kw)) {
        const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`(^|[^a-z])${escaped}(?![a-z])`);
        return { raw, test: text => re.test(text) };
      }
      return { raw, test: text => text.includes(kw) };
    });
  }

  function findMatch(text, matchers) {
    const lower = String(text || "").toLowerCase();
    const hit = matchers.find(m => m.test(lower));
    return hit ? hit.raw : null;
  }

  // 初筛：只针对卡片文本（标题/公司/标签）快速判断。
  // broad=true（Jev 研判开启）时，标题/标签带泛研发领域词也放行，对口与否交给 Jev
  function checkCardQuickFilter(title, company, tags, broad = false) {
    const cardText = `${title} ${company} ${tags.join(" ")}`;
    const ex = findMatch(cardText, state.kw.exclude);
    if (ex) return { pass: false, skipReason: `卡片命中排除词【${ex}】` };
    if (findMatch(cardText, state.kw.include)) return { pass: true };
    const roleText = `${title} ${tags.join(" ")}`;
    if (broad && BROAD_TECH_WORDS.some(w => roleText.includes(w))) return { pass: true };
    return { pass: false, skipReason: "岗位方向非目标技术/研发类" };
  }

  // 深筛：结合右侧详情描述进行校验
  function checkDetailKeywords(fullText) {
    const ex = findMatch(fullText, state.kw.exclude);
    if (ex) return { pass: false, reason: `详情命中排除词【${ex}】` };
    if (state.kw.include.length > 0 && !findMatch(fullText, state.kw.include)) {
      return { pass: false, reason: "详情未命中任何目标关键词" };
    }
    return { pass: true, reason: "" };
  }

  // 卡片标签里的经验要求下限（年）："经验不限/在校/应届/1年以内" 视为 0；识别不出返回 null（不过滤）
  function parseExpMinYears(tags) {
    for (const raw of tags) {
      const t = String(raw).replace(/\s/g, "");
      if (/经验不限|在校|应届|1年以内/.test(t)) return 0;
      const m = t.match(/^(\d+)(?:-\d+)?年(?:以上)?$/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  // ========================== Jev 决策引擎 ==========================
  // 问题设计遵循 TypeSafe 官方指引（docs.typesafe.ai）：英文指令（Jev 的主训练语言）、一问一判、
  // 数字比较留在代码里、state 只放与判断相关的内容、用 probabilities 区分"判定"与"拿不准"。
  // 模型版本钉死，调好的阈值才不会随 jev-latest 升级而漂移。
  const JEV_ENDPOINTS = {
    typesafe: { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0" },
    openrouter: { url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13" }
  };
  // TypeSafe 直连不返回 cost，按官方价 $0.042 / 百万输入 token 估算（输出免费）
  const JEV_USD_PER_INPUT_TOKEN = 0.042 / 1e6;
  // 永久性错误（Key 无效、余额不足、请求格式错误等），重试无意义，立即暂停
  const JEV_FATAL_STATUS = [400, 401, 402, 403, 404, 413, 422];
  // 限流 / 服务端错误 / 超时的退避重试间隔
  const JEV_RETRY_WAITS_MS = [2000, 5000];
  // 陷阱类问题概率 ≥ 此值直接拒；介于 jevMaxTrap 与此值之间转人工复核
  const JEV_TRAP_REJECT = 0.7;
  // "相近可转或直接对口" 的概率之和：低于前者直接拒，低于后者转人工复核
  const JEV_FIT_REJECT_BELOW = 0.3;
  const JEV_FIT_PASS_AT = 0.7;
  // 职位描述正文上限（Jev 上下文 32k token，这里只防兜底取到整块详情时过长）
  const JEV_JD_MAX_CHARS = 4000;

  function getActiveJevKey() {
    return (state.settings.jevApiKey || storeGet(STORAGE_KEYS.jevApiKey, "") || "").trim();
  }

  function isJevActive() {
    return Boolean(state.settings.jevEnabled && getActiveJevKey());
  }

  function jevError(message, status = 0, fatal = false) {
    const err = new Error(message);
    err.status = status;
    err.fatal = fatal;
    return err;
  }

  function postJev(payload, key) {
    const isOpenRouter = key.startsWith("sk-or-");
    const endpoint = isOpenRouter ? JEV_ENDPOINTS.openrouter : JEV_ENDPOINTS.typesafe;
    const headers = {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json"
    };
    if (isOpenRouter) {
      headers["X-OpenRouter-Title"] = "BOSS Auto Job Helper";
    }

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: endpoint.url,
        headers,
        data: JSON.stringify({ ...payload, model: endpoint.model }),
        timeout: 15000,
        onload: res => {
          if (res.status >= 200 && res.status < 300) {
            try {
              const data = JSON.parse(res.responseText);
              if (data && data.answers) resolve(data);
              else reject(jevError("Jev 响应缺失 answers 属性"));
            } catch (err) {
              reject(jevError("Jev 响应 JSON 解析失败: " + err.message));
            }
            return;
          }
          let msg = `HTTP ${res.status}`;
          try {
            const errObj = JSON.parse(res.responseText);
            if (errObj.error?.message) msg += `: ${errObj.error.message}`;
            else if (errObj.message) msg += `: ${errObj.message}`;
            else if (errObj.detail) msg += `: ${typeof errObj.detail === "string" ? errObj.detail : JSON.stringify(errObj.detail)}`;
          } catch {}
          reject(jevError(msg, res.status, JEV_FATAL_STATUS.includes(res.status)));
        },
        ontimeout: () => reject(jevError("Jev 网络请求超时 (15秒)")),
        onerror: e => reject(jevError(`网络请求失败: ${e.statusText || "网络异常"}`))
      });
    });
  }

  // 返回完整响应 { model, answers, usage }。限流/服务端错误/超时自动退避重试，永久性错误直接抛出（err.fatal）
  async function requestJevAPI(payload) {
    const key = getActiveJevKey();
    if (!key) throw jevError("未配置 Jev API Key", 0, true);
    if (typeof GM_xmlhttpRequest !== "function") throw jevError("当前运行环境缺少 GM_xmlhttpRequest 授权", 0, true);
    for (let attempt = 0; ; attempt++) {
      try {
        return await postJev(payload, key);
      } catch (err) {
        if (err.fatal || attempt >= JEV_RETRY_WAITS_MS.length) throw err;
        await sleep(JEV_RETRY_WAITS_MS[attempt]);
      }
    }
  }

  // 6 个问题一次请求、并行评估，只付一份 state 的成本。问题 id 不会发给模型，完整语义都写在 instructions 里；
  // 每级/每侧的 examples 用中文 JD 风格，贴近真实输入才有帮助。经验年限、学历、薪资这类数字比较留在代码里做。
  const JEV_QUESTIONS = {
    fit: {
      type: "score",
      instructions: "How closely do the main duties in `job` match the target roles and core skills in `candidate.profile`?",
      criteria: [
        "The job is in a different field from `candidate.profile`, or it is a non-technical role such as sales, customer service, admin, recruiting or general labor",
        "The job is in the same broad industry, but its main duties need a specialty that `candidate.profile` does not list",
        "Some main duties use skills listed in `candidate.profile`, and the rest is a closely related specialty the candidate could learn within weeks",
        "The main duties directly use the core skills or match the target role listed in `candidate.profile`"
      ]
    },
    depth: {
      type: "score",
      instructions: "How much independent technical or scientific work do the duties in `job.description` involve?",
      criteria: [
        { what: "Routine support or manual work that needs little technical judgment", examples: ["负责实验室日常清洁、器皿清洗和耗材整理", "按要求录入数据、整理台账", "流水线包装、设备看管"] },
        { what: "Runs established procedures, standard assays or existing pipelines and reports the results", examples: ["按SOP完成样品检测并出具报告", "协助研究员完成质粒提取、细胞培养等常规实验", "运行已有分析流程并整理结果"] },
        { what: "Designs or optimizes experiments, methods or pipelines, or owns a research or development project", examples: ["独立设计实验方案并优化工艺参数", "负责新抗体或新蛋白的开发与表征", "搭建并优化生信分析流程"] }
      ]
    },
    dispatch: {
      type: "noul",
      instructions: "Is the person hired for `job` employed through a labor-dispatch or staffing agency, or sent to work on-site at a different client company?",
      criteria: {
        true: { what: "The posting says or clearly implies dispatch, third-party staffing, or on-site placement at a client", examples: ["劳务派遣", "外包岗位，派驻到合作药企", "与第三方人力公司签订劳动合同"] },
        false: "`job.company` hires the person as its own employee. A CRO or CDMO hiring staff for its own labs counts as its own employee."
      }
    },
    paid_training: {
      type: "noul",
      instructions: "Does `job` require applicants to pay money, or to finish a training course before they get a job offer?",
      criteria: {
        true: { what: "Applicants must pay training fees, take a training loan, pay a deposit, or pass a training course before being hired", examples: ["先培训后上岗，培训费用可分期", "招转培", "入职需缴纳押金"] },
        false: "Applicants pay nothing. Free onboarding training provided by the employer after hiring is normal."
      }
    },
    sales_in_disguise: {
      type: "noul",
      instructions: "Are the main duties in `job.description` selling products, promoting to customers, or meeting sales targets?",
      criteria: {
        true: { what: "Most duties are selling, promotion, business development or customer acquisition", examples: ["负责区域客户开发，完成销售指标", "医院学术推广", "维护经销商渠道"] },
        false: "The main duties are technical, scientific or laboratory work, including technical support that carries no sales target"
      }
    },
    excluded: {
      type: "noul",
      instructions: "Is the main work in `job` one of the job types that `candidate.profile` explicitly says to exclude?"
    }
  };

  /**
   * 对展开的职位做一次 Jev 研判
   * @param {{title: string, company: string}} job
   * @param {string} description 职位描述正文
   * @returns {Promise<Object>} 成功返回 interpretJevAnswers 的结论；失败返回 { failed, fatal, reason }，调用方绝不放行
   */
  async function evaluateJobWithJev(job, description) {
    const payload = {
      state: {
        candidate: { profile: state.settings.candidateProfile || PRESETS.bio_rd.candidateProfile },
        job: {
          title: job.title,
          company: job.company,
          description: (description || "").slice(0, JEV_JD_MAX_CHARS)
        }
      },
      questions: JEV_QUESTIONS
    };
    try {
      const data = await requestJevAPI(payload);
      const verdict = interpretJevAnswers(readJevAnswers(data.answers));
      verdict.model = String(data.model || "");
      verdict.costUsd = jevCostUsd(data.usage);
      return verdict;
    } catch (error) {
      return { failed: true, fatal: Boolean(error.fatal), reason: error.message };
    }
  }

  function jevCostUsd(usage) {
    if (!usage) return 0;
    if (typeof usage.cost === "number") return usage.cost;
    return (Number(usage.input_tokens) || 0) * JEV_USD_PER_INPUT_TOKEN;
  }

  // 严格读取：缺字段或类型不对就当作调用失败，而不是拿默认值糊过去
  function readJevAnswers(answers) {
    const need = (id, field) => {
      const a = answers && answers[id];
      if (!a || typeof a[field] !== "number") throw jevError(`Jev 响应缺少 ${id}.${field}`);
      return a;
    };
    const fit = need("fit", "score");
    const p = fit.probabilities;
    if (!p || typeof p !== "object") throw jevError("Jev 响应缺少 fit.probabilities");
    return {
      fit: fit.score,
      // 落在"相近可转"与"直接对口"两级上的概率之和，即 Jev 认为这个岗位值得投的把握
      fitMass: (Number(p["2"]) || 0) + (Number(p["3"]) || 0),
      depth: need("depth", "score").score,
      traps: {
        dispatch: need("dispatch", "noul").noul,
        paid_training: need("paid_training", "noul").noul,
        sales_in_disguise: need("sales_in_disguise", "noul").noul,
        excluded: need("excluded", "noul").noul
      }
    };
  }

  const JEV_TRAP_LABELS = {
    dispatch: "劳务派遣/外派驻场",
    paid_training: "收费培训/招转培",
    sales_in_disguise: "名为技术实为销售",
    excluded: "属于画像里的绝对排除项"
  };
  const JEV_TIER_BADGES = {
    S: { text: "💎 S级·核心对口", cls: "bh-badge-s" },
    A: { text: "⭐ A级·对口", cls: "bh-badge-a" },
    B: { text: "🔹 B级·相近可转", cls: "bh-badge-b" }
  };

  /**
   * 把 Jev 的原始判断变成动作：先看明确的红线（拒），再看拿不准的（转人工复核），最后分级。
   * verdict: "apply" 自动投递 | "hold" 通过但低于自动投递等级，记为备选 | "review" 待人工复核 | "reject" 拒绝
   */
  function interpretJevAnswers(r) {
    const s = state.settings;
    const pct = v => `${Math.round(v * 100)}%`;
    const [trapKey, trapProb] = Object.entries(r.traps).sort((a, b) => b[1] - a[1])[0];
    const trapName = JEV_TRAP_LABELS[trapKey];
    const reject = (badge, reason) => ({ ...r, verdict: "reject", tier: "", badgeText: `🚫 ${badge}`, badgeClass: "bh-badge-reject", reason });
    const review = (badge, reason) => ({ ...r, verdict: "review", tier: "", badgeText: `🟡 待复核·${badge}`, badgeClass: "bh-badge-b", reason });

    // 1. 明确的红线：一票否决
    if (trapProb >= JEV_TRAP_REJECT) {
      return reject(trapName, `Jev 判定${trapName}（${pct(trapProb)}）`);
    }
    if (r.fitMass < JEV_FIT_REJECT_BELOW) {
      return reject("专业不对口", `Jev 判定专业不对口（相近或对口的概率仅 ${pct(r.fitMass)}）`);
    }
    if (r.depth < s.jevMinDepth) {
      return reject(`偏打杂 (深度${r.depth.toFixed(1)})`, `Jev 判定研发深度 ${r.depth.toFixed(2)}，低于门槛 ${s.jevMinDepth}`);
    }

    // 2. 拿不准：不自动投、也不自动拒，交给人
    if (trapProb > s.jevMaxTrap) {
      return review(trapName, `Jev 对"${trapName}"拿不准（${pct(trapProb)}）`);
    }
    if (r.fitMass < JEV_FIT_PASS_AT) {
      return review("对口存疑", `Jev 对专业对口拿不准（相近或对口的概率 ${pct(r.fitMass)}）`);
    }

    // 3. 分级：直接对口为 A，深度也高为 S，相近可转为 B
    const tier = r.fit >= 2.5 ? (r.depth >= 1.5 ? "S" : "A") : "B";
    const apply = JEV_TIER_RANK[tier] >= JEV_TIER_RANK[s.jevMinTier];
    const detail = `对口 ${r.fit.toFixed(1)}/3，深度 ${r.depth.toFixed(1)}/2，最高风险 ${trapName} ${pct(trapProb)}`;
    return {
      ...r,
      verdict: apply ? "apply" : "hold",
      tier,
      badgeText: `${JEV_TIER_BADGES[tier].text} (深度${r.depth.toFixed(1)})`,
      badgeClass: JEV_TIER_BADGES[tier].cls,
      reason: `Jev ${tier}级（${detail}）${apply ? "" : `，低于自动投递等级 ${s.jevMinTier}，记为备选`}`
    };
  }

  function loadJevDecisions() {
    const list = storeGet(STORAGE_KEYS.jevDecisions, []);
    return Array.isArray(list) ? list : [];
  }

  // 每个岗位的 Jev 原始判断与结论都落盘，用于事后抽查、校准阈值
  function recordJevDecision(job, v, dryRun) {
    const r2 = x => Math.round(x * 100) / 100;
    const list = loadJevDecisions();
    list.push({
      at: new Date().toLocaleString("zh-CN", { hour12: false }),
      ...job,
      verdict: v.verdict,
      tier: v.tier,
      dryRun: Boolean(dryRun),
      reason: v.reason,
      fit: r2(v.fit),
      fitMass: r2(v.fitMass),
      depth: r2(v.depth),
      traps: Object.fromEntries(Object.entries(v.traps).map(([k, p]) => [k, r2(p)])),
      model: v.model,
      costUsd: v.costUsd
    });
    storeSet(STORAGE_KEYS.jevDecisions, list.slice(-MAX_JEV_DECISIONS));
  }

  const JEV_VERDICT_LABELS = { apply: "✅投递", hold: "🔹备选", review: "🟡待复核", reject: "🚫拒绝" };

  function formatJevDecision(d) {
    const pct = v => `${Math.round((v || 0) * 100)}%`;
    const t = d.traps || {};
    const verdict = d.dryRun && d.verdict === "apply" ? "🧪会投" : JEV_VERDICT_LABELS[d.verdict] || d.verdict;
    return `[${d.at}] ${verdict}${d.tier ? " " + d.tier : ""} | ${d.company} · ${d.title} ${d.salary || ""}\n` +
      `    对口${d.fit}/3（相近或对口${pct(d.fitMass)}） 深度${d.depth}/2 | 派遣${pct(t.dispatch)} 收费培训${pct(t.paid_training)} 伪销售${pct(t.sales_in_disguise)} 排除项${pct(t.excluded)}` +
      (d.url ? `\n    ${d.url}` : "");
  }

  function showJevDecisionsModal() {
    const all = loadJevDecisions().slice().reverse();
    if (!all.length) {
      alert("还没有 Jev 决策记录。开启 Jev 研判（建议先勾选校准模式）跑一轮就会生成。");
      return;
    }
    const old = document.getElementById("bh-jev-modal");
    if (old) old.remove();

    const count = v => all.filter(d => d.verdict === v).length;
    const cost = all.reduce((sum, d) => sum + (Number(d.costUsd) || 0), 0);

    const modal = document.createElement("div");
    modal.id = "bh-jev-modal";
    modal.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.55);z-index:99999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(2px);";
    modal.innerHTML = `
      <div style="background:#ffffff;border-radius:12px;width:680px;max-width:94%;padding:20px 22px;box-shadow:0 16px 40px rgba(0,0,0,0.3);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;font-size:13px;color:#1e293b;box-sizing:border-box;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;border-bottom:1px solid #e2e8f0;padding-bottom:8px;">
          <b style="font-size:15px;color:#15803d;">📊 Jev 决策记录（保留最近 ${MAX_JEV_DECISIONS} 条）</b>
          <button data-act="close" style="border:none;background:none;font-size:22px;line-height:1;cursor:pointer;color:#94a3b8;">&times;</button>
        </div>
        <div data-role="summary" style="font-size:12px;color:#475569;margin-bottom:6px;"></div>
        <label style="font-size:12px;color:#334155;display:flex;align-items:center;gap:4px;margin-bottom:6px;cursor:pointer;">
          <input type="checkbox" data-act="filter"> 只看待复核和备选（需要你手动处理的岗位）
        </label>
        <textarea data-role="list" readonly style="width:100%;height:320px;border:1px solid #cbd5e1;border-radius:8px;padding:10px;font-family:Consolas,monospace;font-size:12px;box-sizing:border-box;background:#f8fafc;color:#0f172a;line-height:1.5;resize:vertical;"></textarea>
        <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px;">
          <button data-act="clear" style="background:#f1f5f9;color:#b91c1c;border:1px solid #fecaca;border-radius:6px;padding:7px 12px;cursor:pointer;font-size:12px;">🗑 清空记录</button>
          <button data-act="download" style="background:#15803d;color:#ffffff;border:none;border-radius:6px;padding:7px 16px;cursor:pointer;font-weight:600;font-size:12px;">📥 下载 JSON</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    // 岗位标题/公司名来自页面，一律走 textContent / value，不拼进 innerHTML
    modal.querySelector('[data-role="summary"]').textContent =
      `共 ${all.length} 条：投递 ${count("apply")} · 备选 ${count("hold")} · 待复核 ${count("review")} · 拒绝 ${count("reject")}｜Jev 花费约 $${cost.toFixed(4)}`;
    const listEl = modal.querySelector('[data-role="list"]');
    const render = onlyPending => {
      const rows = onlyPending ? all.filter(d => d.verdict === "review" || d.verdict === "hold") : all;
      listEl.value = rows.length ? rows.map(formatJevDecision).join("\n") : "（没有需要手动处理的岗位）";
    };
    render(false);

    modal.querySelector('[data-act="filter"]').addEventListener("change", e => render(e.target.checked));
    modal.querySelector('[data-act="close"]').addEventListener("click", () => modal.remove());
    modal.querySelector('[data-act="download"]').addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `boss_jev_decisions_${todayKey()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
    modal.querySelector('[data-act="clear"]').addEventListener("click", () => {
      if (!confirm("确定清空全部 Jev 决策记录吗？")) return;
      storeSet(STORAGE_KEYS.jevDecisions, []);
      modal.remove();
      addLog("已清空 Jev 决策记录");
    });
    modal.addEventListener("click", e => {
      if (e.target === modal) modal.remove();
    });
  }

  function injectCardBadge(card, text, className) {
    if (!card) return;
    let badge = card.querySelector(".bh-jev-card-badge");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "bh-jev-card-badge";
      const target = card.querySelector(SEL.jobName) || card.querySelector(".job-name, .job-title, [class*='job-name']") || card;
      target.appendChild(badge);
    }
    badge.className = `bh-jev-card-badge ${className || ""}`;
    badge.textContent = text;
  }

  // ========================== DOM 辅助 ==========================
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function inPanel(el) {
    return !!(el && el.closest && el.closest(`#${PANEL_ID}`));
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function jitter(baseMs, spreadMs) {
    return baseMs + Math.floor(Math.random() * (spreadMs + 1));
  }

  function textOf(root, selector) {
    const el = root.querySelector(selector);
    return el ? (el.textContent || "").trim() : "";
  }

  // 依次尝试多个选择器，返回第一个非空结果
  function queryFirst(root, selectors) {
    for (const sel of selectors) {
      const list = Array.from(root.querySelectorAll(sel));
      if (list.length) return list;
    }
    return [];
  }

  function queryVisibleFirst(root, selectors) {
    for (const sel of selectors) {
      const list = Array.from(root.querySelectorAll(sel)).filter(el => isVisible(el) && !inPanel(el));
      if (list.length) return list;
    }
    return [];
  }

  // 抓取当前页面所有职位卡片（只保留最外层，避免宽匹配选择器同时命中内外层节点）
  function getVisibleJobCards() {
    const list = queryVisibleFirst(document, SEL.jobCard).filter(el => (el.innerText || "").trim().length > 20);
    return list.filter(el => !list.some(other => other !== el && other.contains(el)));
  }

  // 获取卡片唯一标识
  function getCardKey(card) {
    const link = card.querySelector('a[href*="/job_detail/"]');
    const m = link && (link.getAttribute("href") || "").match(/\/job_detail\/([\w-]+)\.html/);
    if (m) return m[1];
    const dataId = card.getAttribute("data-jobid") || card.getAttribute("data-id");
    if (dataId) return dataId;
    const title = textOf(card, SEL.jobName);
    const company = textOf(card, SEL.company);
    if (title || company) return `${company}_${title}`.replace(/\s+/g, "_");
    return (card.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  function extractCardInfo(card) {
    const tagEls = queryFirst(card, SEL.tags);
    return {
      title: textOf(card, SEL.jobName),
      company: textOf(card, SEL.company),
      rawSalary: textOf(card, SEL.salary),
      tags: tagEls.map(t => (t.textContent || "").trim()).filter(Boolean)
    };
  }

  // 寻找滚动容器（适配推荐流与搜索结果流）
  function findScrollableContainer() {
    const firstCard = getVisibleJobCards()[0];
    let node = firstCard ? firstCard.parentElement : null;
    while (node && node !== document.body && node !== document.documentElement) {
      if (node.scrollHeight > node.clientHeight + 40) {
        const oy = window.getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll") return node;
      }
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function getDetailElement() {
    for (const sel of SEL.detail) {
      const el = document.querySelector(sel);
      if (el && isVisible(el) && !inPanel(el)) return el;
    }
    return null;
  }

  function getDetailText() {
    const el = getDetailElement();
    return el ? (el.innerText || "").trim() : "";
  }

  // 只取职位描述正文，不带按钮、BOSS 信息、公司介绍等噪声；拿不到时退回整块详情
  function getJobDescription() {
    const el = getDetailElement();
    if (!el) return "";
    const jd = el.querySelector(SEL.jdText);
    return ((jd && jd.innerText) || el.innerText || "").trim();
  }

  function getCardUrl(card) {
    const link = card.querySelector('a[href*="/job_detail/"]');
    return link ? link.href : "";
  }

  // 安全点击卡片：阻止 <a target=_blank> 打开新标签或跳转，站点自身的 SPA 点击逻辑不受影响
  function clickCard(card) {
    const target = card.querySelector(SEL.cardClickTarget) || card;
    const guard = e => {
      if (e.target && e.target.closest && e.target.closest("a[href]")) e.preventDefault();
    };
    card.addEventListener("click", guard, { capture: true, once: true });
    try {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.click();
    } finally {
      card.removeEventListener("click", guard, { capture: true });
    }
  }

  // 点击卡片后等待右侧详情真正切换到该岗位，避免读到上一条的旧详情。超时返回 null。
  async function waitForDetail({ card, title, company, previousText }) {
    const start = Date.now();
    while (Date.now() - start < DETAIL_TIMEOUT_MS) {
      const text = getDetailText();
      const lenient = Date.now() - start > 2500;
      if (text && text.length >= 30) {
        const changed = text !== previousText;
        const titleOk = !title || text.includes(title);
        const companyOk = !company || text.includes(company);
        const active = document.querySelector(SEL.activeCard);
        const activeOk = active ? (active === card || active.contains(card) || card.contains(active)) : null;
        if (activeOk !== false) {
          if (changed && (titleOk || (lenient && text.length >= 80))) return text;
          if (!changed && lenient && titleOk && (activeOk === true || companyOk)) return text; // 该岗位详情本来就已展示
        }
      }
      await sleep(250);
    }
    return null;
  }

  // 查找沟通按钮（优先在详情面板内找，遍历全部候选而不是只看第一个）
  function findContactButton() {
    const scope = getDetailElement() || document;
    const candidates = Array.from(scope.querySelectorAll(SEL.contactButton)).filter(el => isVisible(el) && !inPanel(el));
    for (const el of candidates) {
      const text = (el.innerText || "").trim();
      if (!text || text.length > 12) continue;
      let contactState = null;
      if (text.includes("立即沟通")) contactState = "ready";
      else if (/继续沟通|已沟通/.test(text)) contactState = "already_contacted";
      else if (/去APP|去App|扫码/.test(text)) contactState = "app_only";
      else if (/已关闭|停止招聘|已下线/.test(text)) contactState = "closed";
      if (!contactState) continue;
      const disabled = el.disabled || el.getAttribute("aria-disabled") === "true" || /(^|\s)(disabled|is-disabled)(\s|$)/.test(el.className) || window.getComputedStyle(el).pointerEvents === "none";
      if (contactState === "ready" && disabled) contactState = "disabled";
      return { button: el, state: contactState, text };
    }
    return null;
  }

  function getVisibleDialogs() {
    return Array.from(document.querySelectorAll(SEL.dialog)).filter(d => isVisible(d) && !inPanel(d));
  }

  function findVisibleButtonByText(root, pattern) {
    return Array.from(root.querySelectorAll(SEL.anyButton))
      .find(b => pattern.test((b.innerText || "").trim()) && isVisible(b) && !inPanel(b));
  }

  // 以框架能感知的方式写入输入框（Vue/React 绑定的 value 需要走原生 setter）
  function setInputValue(input, text) {
    if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
      const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value");
      if (setter && setter.set) setter.set.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      input.focus();
      input.textContent = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  // 点击“立即沟通”之后等待平台反馈，确认是否真的建立了沟通。
  // 遵循平台 Host 真实逻辑：点击立即沟通后，平台自动发送账号官方默认招呼语建立会话。
  // 返回 { result: "confirmed" | "limit" | "risk" | "unconfirmed", text? }
  async function confirmContact() {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let confirmed = false;
    let stayed = false;

    while (Date.now() < deadline) {
      const dialogs = getVisibleDialogs();

      // 1. 平台每日上限 / 风控弹窗优先识别
      for (const d of dialogs) {
        const t = d.innerText || "";
        const limit = t.match(LIMIT_PATTERN);
        if (limit) return { result: "limit", text: limit[0] };
        const risk = t.match(RISK_PATTERN);
        if (risk) return { result: "risk", text: risk[0] };
        if (/已向.*发送|发送成功|已发送/.test(t)) confirmed = true;
      }

      // 2. “留在此页”确认框：平台发送官方打招呼后提示是否查看会话，自动点击留在列表页
      if (!stayed) {
        const stayBtn = findVisibleButtonByText(document, /^留在此页$/);
        if (stayBtn) {
          stayBtn.click();
          stayed = true;
          confirmed = true;
          addLog("已自动确认【留在此页】");
          await sleep(600);
          continue;
        }
      }

      // 3. 详情面板按钮变成“继续沟通”即视为建立成功
      const contact = findContactButton();
      if (contact && contact.state === "already_contacted") confirmed = true;

      if (confirmed && dialogs.length === 0) break;
      await sleep(350);
    }
    return { result: confirmed ? "confirmed" : "unconfirmed" };
  }

  // 检查是否存在风控/验证/登录阻碍（只看路径，避免查询串里的 securityId 误判）
  function checkRiskWarning() {
    if (RISK_PATH_PATTERN.test(location.pathname)) return "安全风控/登录跳转";
    for (const d of getVisibleDialogs()) {
      const m = (d.innerText || "").match(RISK_PATTERN);
      if (m) return m[0];
    }
    return null;
  }

  // 列表不存在时判断是不是整页被登录墙/验证页挡住
  function checkBlockedPage() {
    const text = document.body ? document.body.innerText || "" : "";
    const m = text.match(/请先登录|扫码登录|访问受限|异常访问|请完成验证|拖动滑块|人机验证/);
    return m ? m[0] : null;
  }

  // 滚动加载更多或安全翻页；返回列表是否出现了变化
  async function loadMoreOrNextPage() {
    addLog("当前批次已扫描完毕，正在慢速拉取新职位...");
    const before = new Set(getVisibleJobCards().map(getCardKey));
    const snapshot = () => new Set(getVisibleJobCards().map(getCardKey));
    const hasNew = () => Array.from(snapshot()).some(k => !before.has(k));

    // 1. 列表容器下拉（推荐列表 / 无限滚动），先滚一屏，再滚到底触发懒加载
    const container = findScrollableContainer();
    const step = Math.max(300, Math.floor((container.clientHeight || window.innerHeight) * 0.7));
    container.scrollBy({ top: step, behavior: "smooth" });
    await sleep(2500);
    if (hasNew()) {
      addLog(`成功拉取到新职位 (当前可见 ${snapshot().size} 个)`);
      return true;
    }
    container.scrollTo({ top: container.scrollHeight, behavior: "smooth" });
    await sleep(3000);
    if (hasNew()) {
      addLog(`成功拉取到新职位 (当前可见 ${snapshot().size} 个)`);
      return true;
    }

    // 2. 分页控件（搜索结果列表）
    const next = Array.from(document.querySelectorAll(SEL.pagerNext)).find(el => {
      if (!isVisible(el) || inPanel(el)) return false;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
      if (el.closest(".disabled, .is-disabled")) return false;
      const text = (el.innerText || "").trim();
      const byText = /^(下一页|下一頁|>|›)$/.test(text);
      const byClass = /(^|\s)(ui-icon-arrow-right|btn-next|page-next|next-page|pager-next)(\s|$)/.test(el.className);
      return byText || byClass;
    });
    if (next) {
      (next.closest("a, button") || next).click();
      addLog("已触发平稳翻页，等待下一页加载...");
      await sleep(3500);
      const after = snapshot();
      const same = after.size === before.size && Array.from(after).every(k => before.has(k));
      return !same;
    }

    return false;
  }

  // ========================== 主投递循环 (低频慢速防封) ==========================
  function setMessage(msg) {
    state.currentMessage = msg;
    renderStatus();
  }

  async function countdown(totalSec, message) {
    for (let remain = totalSec; remain > 0; remain--) {
      if (state.mode !== "RUNNING") return;
      setMessage(message(remain));
      await sleep(1000);
    }
  }

  function randomIntervalSec() {
    const min = Math.max(MIN_INTERVAL_SEC, state.settings.intervalMin);
    const max = Math.max(min, state.settings.intervalMax);
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  async function skipCard(reason, label, baseMs, spreadMs) {
    state.stats.skipped++;
    saveStats();
    addLog(`跳过[${reason}]：${label}`);
    await sleep(jitter(baseMs, spreadMs)); // 真人扫视停顿，避免瞬时刷屏
    return "handled";
  }

  async function failCard(reason, label) {
    state.stats.failed++;
    state.consecutiveFailures++;
    saveStats();
    addLog(`⚠️ 失败[${reason}]：${label}`);
    await sleep(jitter(2000, 1000));
    return "handled";
  }

  function pauseForRisk(risk) {
    state.mode = "PAUSED";
    setMessage(`⚠️ 检测到安全验证【${risk}】，已自动暂停保护`);
    addLog(`⚠️ 检测到平台验证:【${risk}】，已暂停保护账号！`);
    playBeep(260, 600);
    notify(`检测到平台弹出【${risk}】，请手动完成验证后点击【继续投递】`);
    alert(`BOSS求职助手提醒：检测到平台弹出【${risk}】，已自动暂停。请在页面手动完成验证后再点击【继续投递】。`);
  }

  function stopForLimit(text) {
    state.mode = "STOPPED";
    setMessage(`⛔ 平台提示【${text}】，今日已停止`);
    addLog(`⛔ 平台提示【${text}】，本日不再投递，请明天再来`);
    playBeep(300, 500);
    notify(`平台提示【${text}】，已停止今日投递`);
  }

  function pauseForJev(message) {
    state.mode = "PAUSED";
    setMessage(`⚠️ Jev 不可用，已暂停：${message}`);
    addLog(`⛔ Jev 不可用，已暂停（不会降级为纯规则投递）：${message}`);
    playBeep(300, 500);
    notify(`Jev 不可用，已暂停投递：${message}`);
  }

  // Jev 失败时绝不放行：本岗位退回未读（稍后重试），永久性错误或连续失败则暂停
  async function handleJevFailure(verdict, key, label) {
    state.visitedKeys.delete(key);
    state.sessionSeen.delete(key);
    storeSet(STORAGE_KEYS.visited, Array.from(state.visitedKeys));
    state.stats.failed++;
    state.jevFailures++;
    saveStats();
    addLog(`⚠️ Jev 研判失败 [${verdict.reason}]：${label}（未投递，稍后重试）`);
    if (verdict.fatal || state.jevFailures >= MAX_JEV_FAILURES) {
      pauseForJev(verdict.fatal ? verdict.reason : `连续 ${state.jevFailures} 次调用失败：${verdict.reason}`);
      return "stop";
    }
    await sleep(jitter(4000, 2000));
    return "handled";
  }

  // 处理一张未评估过的卡片。返回 "handled" | "no_target" | "no_more" | "stop"
  async function processNextCard() {
    const dryRun = state.settings.jevDryRun;
    const cards = getVisibleJobCards();
    let targetCard = null;
    let targetKey = "";
    for (const card of cards) {
      const key = getCardKey(card);
      if (key && !state.visitedKeys.has(key) && !(dryRun && state.sessionSeen.has(key))) {
        targetCard = card;
        targetKey = key;
        break;
      }
    }

    // 当前可见卡片都已评估：平稳下拉或翻页
    if (!targetCard) {
      if (cards.length === 0) {
        const blocked = checkBlockedPage();
        if (blocked) {
          pauseForRisk(blocked);
          return "stop";
        }
        if (state.emptyRounds === 0) addLog("当前页面没有找到职位列表，请在 BOSS 的“推荐”或搜索结果页运行");
      }
      state.emptyRounds++;
      const changed = await loadMoreOrNextPage();
      if (!changed || state.emptyRounds >= MAX_EMPTY_LOAD_ROUNDS) return "no_more";
      await sleep(2000);
      return "no_target";
    }
    state.emptyRounds = 0;

    // 立即打标记录，防止任何偶发情况导致重复评估
    // 校准模式只记在本次会话里（不落盘），切回正式投递时这些岗位会重新评估
    if (dryRun) state.sessionSeen.add(targetKey);
    else recordVisited(targetKey);

    const { title, company, rawSalary, tags } = extractCardInfo(targetCard);
    const label = `${company} · ${title}`;
    setCurrentTarget(company, title);
    setMessage(`低频评估中：${label}`);

    // 实习生过滤
    if (state.settings.excludeInternships && (/实习/.test(title) || tags.some(t => /实习/.test(t)))) {
      return skipCard("实习岗位", label, 1200, 800);
    }

    // 最低薪资门槛过滤 (内置解密)
    if (state.settings.minSalaryK > 0) {
      const minK = parseSalaryMinK(rawSalary);
      if (minK !== null && minK < state.settings.minSalaryK) {
        return skipCard(`薪资低于${state.settings.minSalaryK}K(实际${formatK(minK)}K)`, label, 1200, 800);
      }
    }

    // 经验年限、学历这类数字/等级比较在代码里做（Jev 不擅长数值比较）
    if (state.settings.maxExpYears > 0) {
      const expMin = parseExpMinYears(tags);
      if (expMin !== null && expMin >= state.settings.maxExpYears) {
        return skipCard(`经验要求${expMin}年起，超出上限${state.settings.maxExpYears}年`, label, 1200, 800);
      }
    }
    if (state.settings.skipPhdJobs && tags.some(t => /博士/.test(t))) {
      return skipCard("要求博士学历", label, 1200, 800);
    }

    // 两级关键词初筛 (避免点击无关岗位，但保留广义研发助理以点开深查)
    const jevActive = isJevActive();
    const quick = checkCardQuickFilter(title, company, tags, jevActive);
    if (!quick.pass) return skipCard(quick.skipReason, label, 1400, 900);

    // 展开右侧详情，并确认详情已切换到本岗位
    const previousText = getDetailText();
    clickCard(targetCard);
    await sleep(800);
    const detailText = await waitForDetail({ card: targetCard, title, company, previousText });
    if (detailText === null) {
      return failCard("详情面板未在预期时间内加载，可能页面结构变化或网络较慢", label);
    }
    state.consecutiveFailures = 0; // 详情能正常加载，说明页面工作正常

    if (!jevActive) {
      // 纯规则模式：本地关键词深筛（挡掉明显冲突的黑名单词）
      const deep = checkDetailKeywords(`${title} ${company} ${tags.join(" ")} ${detailText}`);
      if (!deep.pass) return skipCard(deep.reason, label, 2000, 1200);
    } else {
      // Jev 模式：正文不再用关键词一票否决（"集研发、生产、销售于一体""补充商业保险"这类字眼会误杀），
      // 对口、深度、陷阱全部交给 Jev；它出错时绝不放行
      setMessage(`Jev 研判中：${label}`);
      const verdict = await evaluateJobWithJev({ title, company }, getJobDescription());
      if (verdict.failed) return handleJevFailure(verdict, targetKey, label);
      state.jevFailures = 0;
      recordJevDecision({ key: targetKey, url: getCardUrl(targetCard), company, title, salary: decodeBossSalary(rawSalary) }, verdict, dryRun);
      injectCardBadge(targetCard, verdict.badgeText, verdict.badgeClass);
      if (verdict.verdict !== "apply") {
        const kind = { review: "待复核", hold: "备选", reject: "Jev 拒绝" }[verdict.verdict];
        return skipCard(`${kind}·${verdict.reason}`, label, 1800, 1000);
      }
      addLog(`✨ [Jev 研判通过] ${verdict.reason}`);
    }

    // 3. 检查沟通按钮状态 (严格遵循 Host 规则：已沟通则跳过，仅在未沟通时点击立即沟通)
    const contact = findContactButton();
    if (!contact) return skipCard("未匹配到沟通入口", label, 1500, 0);
    if (contact.state === "already_contacted") {
      return skipCard("此前已沟通 (继续沟通状态)", label, 1500, 0);
    }
    if (contact.state !== "ready") {
      return skipCard(CONTACT_SKIP_LABELS[contact.state] || contact.text, label, 1500, 0);
    }

    // 校准模式到此为止：只记录"会投递"，不点击沟通、不占额度
    if (dryRun) {
      addLog(`🧪 [校准] 会投递：${label}`);
      await sleep(jitter(2500, 1500));
      return "handled";
    }

    // 4. 触发立即沟通：点击按钮由平台发送官方预设招呼语建立会话
    savePendingContact({ key: targetKey, company, title, date: todayKey(), at: Date.now() });
    addLog(`🎯 触发立即沟通：${label} (${decodeBossSalary(rawSalary) || "薪资未知"})`);
    contact.button.click();
    await sleep(1200);
    const confirm = await confirmContact();
    clearPendingContact();

    if (confirm.result === "limit") {
      stopForLimit(confirm.text);
      return "stop";
    }
    if (confirm.result === "risk") {
      pauseForRisk(confirm.text);
      return "stop";
    }

    // 未能当场确认时按成功计入（对每日配额更保守），但记为一次异常
    state.stats.success++;
    state.batchCount++;
    recordAppliedCompany(company, title, decodeBossSalary(rawSalary));
    saveStats();
    if (confirm.result === "confirmed") {
      addLog(`✅ 沟通成功！今日累计已投递: ${state.stats.success}/${state.settings.dailyMax}`);
    } else {
      state.consecutiveFailures++;
      addLog(`⚠️ 未能确认沟通结果（已按成功计入）：${label}`);
    }

    // 防疲劳慢速保护：每连续沟通 3 人，额外休息 60-120 秒
    if (state.batchCount >= 3 && state.mode === "RUNNING" && state.stats.success < state.settings.dailyMax) {
      state.batchCount = 0;
      const restSec = 60 + Math.floor(Math.random() * 60);
      addLog(`☕ 连续投递3个岗位，启动防疲劳保护，休整 ${restSec} 秒...`);
      await countdown(restSec, remain => `☕ 防疲劳休整中... 剩余 ${remain} 秒后继续`);
    }

    // 常规单次投递低频随机等待
    if (state.mode === "RUNNING" && state.stats.success < state.settings.dailyMax) {
      await countdown(randomIntervalSec(), remain => `低频安全倒计时... 约 ${remain} 秒后评估下一岗位`);
    }
    return "handled";
  }

  async function startLoop() {
    if (state.isRunning) return;
    state.isRunning = true;
    state.mode = "RUNNING";
    state.consecutiveFailures = 0;
    state.jevFailures = 0;
    state.emptyRounds = 0;
    const s = state.settings;
    const modeText = s.jevDryRun ? "🧪 校准模式已启动（只研判、不投递）" : "低频自动投递已启动 (慢速防封模式)";
    const jevText = isJevActive() ? `Jev 研判开启，自动投递最低等级 ${s.jevMinTier}` : "纯关键词规则";
    addLog(`=== ${modeText} · ${jevText} ===`);
    renderStatus();

    try {
      while (state.mode === "RUNNING") {
        rollStatsIfNewDay();

        // 每日配额上限检查
        if (!state.settings.jevDryRun && state.stats.success >= state.settings.dailyMax) {
          state.mode = "STOPPED";
          setMessage("今日已达上限，已稳妥停止");
          addLog(`今日已达低频安全上限 (${state.settings.dailyMax})，投递自动停止`);
          playBeep(600, 300);
          break;
        }

        // 连续异常保护（页面改版、详情打不开、沟通无法确认等）
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          state.mode = "PAUSED";
          setMessage("⚠️ 连续多次处理异常，已自动暂停保护");
          addLog("⚠️ 连续多次处理异常，已暂停。请确认当前是左右分栏的职位列表页，且页面未改版");
          playBeep(300, 500);
          break;
        }

        // 平台风控与验证检测
        const risk = checkRiskWarning();
        if (risk) {
          pauseForRisk(risk);
          break;
        }

        let outcome;
        try {
          outcome = await processNextCard();
        } catch (err) {
          state.stats.failed++;
          state.consecutiveFailures++;
          saveStats();
          addLog(`⚠️ 处理岗位时出现异常：${err && err.message ? err.message : err}`);
          await sleep(jitter(2000, 1000));
          continue;
        }

        if (outcome === "no_more") {
          state.mode = "STOPPED";
          if (getVisibleJobCards().length === 0) {
            setMessage("当前页面没有职位列表，已停止");
            addLog("当前页面没有职位列表，请打开 BOSS 的“推荐”或搜索结果页后再开始。");
          } else {
            setMessage("所有岗位已处理完毕");
            addLog("当前条件下所有岗位均已查阅完毕，平稳停止。");
          }
          break;
        }
        if (outcome === "stop") break;
      }
    } finally {
      state.isRunning = false;
      if (state.mode === "RUNNING") state.mode = "IDLE";
      renderStatus();
    }
  }

  // ========================== 界面渲染与交互 ==========================
  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 20px;
        bottom: 20px;
        width: 360px;
        max-height: 88vh;
        z-index: 9999999;
        box-sizing: border-box;
        padding: 12px 14px 10px 14px;
        border-radius: 14px;
        background: #ffffff;
        color: #1f2937;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(13, 148, 136, 0.3);
        font-size: 12px;
        line-height: 1.45;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        user-select: none;
        display: flex;
        flex-direction: column;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .bh-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
        padding-bottom: 5px;
        border-bottom: 1px solid #e5e7eb;
        cursor: move;
      }
      #${PANEL_ID} .bh-title {
        font-weight: 700;
        font-size: 13px;
        color: #0d9488;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${PANEL_ID} .bh-badge {
        display: inline-block;
        font-size: 10px;
        padding: 2px 6px;
        border-radius: 4px;
        background: #ccfbf1;
        color: #0f766e;
        font-weight: 600;
      }
      #${PANEL_ID} .bh-header-tools {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #${PANEL_ID} .bh-btn-tool {
        border: none;
        background: #f1f5f9;
        color: #475569;
        border-radius: 6px;
        padding: 3px 7px;
        cursor: pointer;
        font-size: 11px;
        transition: all 0.15s;
      }
      #${PANEL_ID} .bh-btn-tool:hover { background: #e2e8f0; color: #0f172a; }
      #${PANEL_ID}.is-collapsed { width: 230px; padding: 10px 14px; }
      #${PANEL_ID}.is-collapsed .bh-body { display: none; }
      #${PANEL_ID}.is-collapsed .bh-header { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
      #${PANEL_ID} .bh-body {
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      #${PANEL_ID} .bh-row { display: flex; gap: 6px; margin: 4px 0; }
      #${PANEL_ID} .bh-col { flex: 1; }
      #${PANEL_ID} label { display: block; font-size: 10px; color: #475569; margin-bottom: 2px; font-weight: 600; }
      #${PANEL_ID} input[type="number"], #${PANEL_ID} input[type="text"], #${PANEL_ID} input[type="password"], #${PANEL_ID} textarea, #${PANEL_ID} select {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 4px 6px;
        color: #0f172a;
        font-size: 11px;
        font-family: inherit;
        user-select: text;
        background: #ffffff;
      }
      #${PANEL_ID} input:focus, #${PANEL_ID} textarea:focus, #${PANEL_ID} select:focus {
        border-color: #0d9488;
        outline: none;
        box-shadow: 0 0 0 2px rgba(13, 148, 136, 0.15);
      }
      #${PANEL_ID} textarea { resize: vertical; min-height: 36px; line-height: 1.4; }
      #${PANEL_ID} .bh-checkbox-row {
        display: flex;
        align-items: center;
        gap: 5px;
        margin: 4px 0;
        font-size: 11px;
        color: #334155;
        cursor: pointer;
      }
      #${PANEL_ID} .bh-actions {
        display: grid;
        grid-template-columns: 1.3fr 1fr 1fr;
        gap: 6px;
        margin: 4px 0 6px 0;
      }
      #${PANEL_ID} .bh-btn-main {
        border: none;
        border-radius: 6px;
        padding: 7px 0;
        color: #ffffff;
        font-weight: 600;
        cursor: pointer;
        font-size: 11px;
        transition: opacity 0.2s;
        text-align: center;
      }
      #${PANEL_ID} .bh-btn-main:hover { opacity: 0.9; }
      #${PANEL_ID} .bh-btn-start { background: #0d9488; }
      #${PANEL_ID} .bh-btn-pause { background: #d97706; }
      #${PANEL_ID} .bh-btn-stop  { background: #dc2626; }
      #${PANEL_ID} .bh-status-box {
        background: #f0fdfa;
        border: 1px solid #99f6e4;
        border-radius: 6px;
        padding: 5px 8px;
        font-size: 11px;
        color: #0f766e;
        margin: 4px 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${PANEL_ID} .bh-stats-box {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 10px;
        color: #475569;
        margin: 2px 0 4px 0;
        font-weight: 500;
      }
      #${PANEL_ID} .bh-stats-box span b { color: #0d9488; }
      #${PANEL_ID} .bh-tabs-nav {
        display: flex;
        gap: 3px;
        margin: 4px 0;
        border-bottom: 1px solid #e2e8f0;
        padding-bottom: 4px;
      }
      #${PANEL_ID} .bh-tab-btn {
        border: none;
        background: transparent;
        color: #64748b;
        font-size: 11px;
        font-weight: 600;
        padding: 4px 6px;
        border-radius: 6px;
        cursor: pointer;
        transition: all 0.15s;
        flex: 1;
        text-align: center;
      }
      #${PANEL_ID} .bh-tab-btn:hover {
        background: #f1f5f9;
        color: #0f172a;
      }
      #${PANEL_ID} .bh-tab-btn.active {
        background: #0d9488;
        color: #ffffff;
      }
      #${PANEL_ID} .bh-tab-content {
        max-height: 260px;
        overflow-y: auto;
        padding-right: 3px;
        padding-top: 4px;
      }
      #${PANEL_ID} .bh-tab-content::-webkit-scrollbar, #${PANEL_ID} .bh-logs::-webkit-scrollbar {
        width: 4px;
      }
      #${PANEL_ID} .bh-tab-content::-webkit-scrollbar-thumb, #${PANEL_ID} .bh-logs::-webkit-scrollbar-thumb {
        background: #cbd5e1;
        border-radius: 4px;
      }
      #${PANEL_ID} .bh-extra-tools {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 6px;
      }
      #${PANEL_ID} .bh-btn-link {
        border: none;
        background: transparent;
        color: #64748b;
        cursor: pointer;
        font-size: 10px;
        text-decoration: underline;
        padding: 0;
      }
      #${PANEL_ID} .bh-btn-link:hover { color: #0f766e; }
      #${PANEL_ID} .bh-logs {
        max-height: 200px;
        min-height: 120px;
        overflow-y: auto;
        background: #0f172a;
        color: #34d399;
        font-family: Consolas, monospace;
        font-size: 10px;
        line-height: 1.4;
        padding: 6px 8px;
        border-radius: 6px;
        white-space: pre-wrap;
        user-select: text;
      }
      .bh-jev-card-badge {
        display: inline-block;
        margin-left: 6px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
        vertical-align: middle;
        line-height: 1.35;
      }
      .bh-badge-s {
        background: #dcfce7 !important;
        color: #15803d !important;
        border: 1px solid #86efac !important;
      }
      .bh-badge-a {
        background: #e0f2fe !important;
        color: #0369a1 !important;
        border: 1px solid #7dd3fc !important;
      }
      .bh-badge-b {
        background: #fef3c7 !important;
        color: #b45309 !important;
        border: 1px solid #fde68a !important;
      }
      .bh-badge-reject {
        background: #fee2e2 !important;
        color: #b91c1c !important;
        border: 1px solid #fca5a5 !important;
      }
      .bh-jev-box {
        margin: 4px 0 6px 0;
        padding: 8px 10px;
        border-radius: 8px;
        background: #f0fdf4;
        border: 1px solid #bbf7d0;
      }
      .bh-jev-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 11px;
        font-weight: 700;
        color: #15803d;
        margin-bottom: 5px;
      }
    `;
    document.head.appendChild(style);
  }

  // 拖拽面板支持（拖动期间才挂载 mousemove 监听）
  function setupDraggable(panel) {
    const header = panel.querySelector(".bh-header");
    header.addEventListener("mousedown", e => {
      if (e.button !== 0 || e.target.closest("button")) return;
      const rect = panel.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const origLeft = rect.left;
      const origTop = rect.top;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      panel.style.left = `${origLeft}px`;
      panel.style.top = `${origTop}px`;
      e.preventDefault();

      const onMove = ev => {
        const left = Math.max(10, Math.min(window.innerWidth - panel.offsetWidth - 10, origLeft + ev.clientX - startX));
        const top = Math.max(10, Math.min(window.innerHeight - panel.offsetHeight - 10, origTop + ev.clientY - startY));
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        saveSettings({ panelX: panel.style.left, panelY: panel.style.top });
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });
  }

  // 恢复用户拖拽保存的位置，并保证在当前窗口内可见
  function restorePanelPosition(panel) {
    const { panelX, panelY } = state.settings;
    if (!panelX || !panelY) return;
    const x = parseFloat(panelX);
    const y = parseFloat(panelY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${Math.max(10, Math.min(window.innerWidth - 60, x))}px`;
    panel.style.top = `${Math.max(10, Math.min(window.innerHeight - 40, y))}px`;
  }

  function renderPanel() {
    if (document.getElementById(PANEL_ID)) return;
    injectStyles();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="bh-header" title="可按住此栏拖拽移动面板">
        <div class="bh-title">
          <span>🧬 BOSS 智能求职助手</span>
          <span class="bh-badge" data-role="status-badge">空闲</span>
        </div>
        <div class="bh-header-tools">
          <button class="bh-btn-tool" data-action="collapse" title="收起/展开">收起</button>
          <button class="bh-btn-tool" data-action="hide" title="关闭面板">×</button>
        </div>
      </div>
      <div class="bh-body">
        <!-- 顶部常驻控制区 -->
        <div class="bh-actions">
          <button class="bh-btn-main bh-btn-start" data-action="start">▶ 开始低频投递</button>
          <button class="bh-btn-main bh-btn-pause" data-action="pause">⏸ 暂停</button>
          <button class="bh-btn-main bh-btn-stop"  data-action="stop">⏹ 停止</button>
        </div>

        <div class="bh-stats-box">
          <span>成功: <b data-role="stat-success">0</b></span>
          <span>跳过: <span data-role="stat-skipped">0</span></span>
          <span>失败: <span data-role="stat-failed">0</span></span>
          <span>剩余: <b data-role="stat-remain">40</b></span>
        </div>

        <div class="bh-status-box" data-role="message">低频助手已就绪，点击【开始低频投递】</div>

        <!-- 4 分区分页导航栏 -->
        <div class="bh-tabs-nav">
          <button type="button" class="bh-tab-btn active" data-tab="jev">🧠 Jev研判</button>
          <button type="button" class="bh-tab-btn" data-tab="rules">📋 规则配置</button>
          <button type="button" class="bh-tab-btn" data-tab="hunter">🎯 目标直投</button>
          <button type="button" class="bh-tab-btn" data-tab="logs">📜 运行日志</button>
        </div>

        <!-- Tab 1: Jev 智能多维研判 -->
        <div class="bh-tab-content" data-tab-content="jev">
          <div class="bh-jev-box">
            <div class="bh-jev-header">
              <span>🧠 Jev 决策模型 (TypeSafe / OpenRouter)</span>
              <label style="font-size:11px;cursor:pointer;display:flex;align-items:center;gap:3px;font-weight:normal;">
                <input data-role="jev-enabled" type="checkbox"> 开启研判
              </label>
            </div>
            <div style="margin-bottom:6px;">
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                <label style="font-size:10px;color:#166534;font-weight:600;margin:0;">Jev API 密钥:</label>
                <div style="display:flex;gap:4px;">
                  <button type="button" class="bh-btn-tool" data-action="toggle-jev-key-view" style="padding:1px 5px;font-size:10px;" title="查看/隐藏明文">👁️</button>
                  <button type="button" class="bh-btn-tool" data-action="test-jev-key" style="padding:1px 6px;font-size:10px;background:#bbf7d0;color:#14532d;font-weight:600;" title="测试密钥有效性">⚡ 测试连接</button>
                </div>
              </div>
              <input data-role="jev-api-key" type="password" placeholder="输入密钥启用深度研判 (留空则降级为纯规则)" style="width:100%;font-size:11px;padding:4px 6px;">
            </div>
            <div style="margin-bottom:6px;">
              <label style="font-size:10px;color:#166534;font-weight:600;">真实学术/科研画像与排斥要求 (Jev 锚点):</label>
              <textarea data-role="candidate-profile" rows="4" placeholder="写清：学历与毕业年份、真正做过的技术（越具体越好）、目标岗位；另起一行写『绝对排除：…』列出不想要的岗位类型" style="width:100%;font-size:11px;padding:4px 6px;"></textarea>
            </div>
            <div class="bh-row" style="margin:4px 0;">
              <div class="bh-col">
                <label style="font-size:10px;color:#166534;">最低研发深度 (0~2):</label>
                <input data-role="jev-min-depth" type="number" min="0" max="2" step="0.1" style="width:100%;font-size:11px;padding:3px 5px;" title="低于此分的打杂/清洗/低端岗位直接淘汰">
              </div>
              <div class="bh-col">
                <label style="font-size:10px;color:#166534;">陷阱可疑阈值 (0~1):</label>
                <input data-role="jev-max-trap" type="number" min="0.1" max="0.9" step="0.05" style="width:100%;font-size:11px;padding:3px 5px;" title="派遣/收费培训/伪销售/触犯排除项任一概率高于此值转人工复核（不投也不拒）；达到 0.7 直接拒">
              </div>
            </div>
            <div style="margin:4px 0;">
              <label style="font-size:10px;color:#166534;">自动投递最低等级:</label>
              <select data-role="jev-min-tier" style="width:100%;font-size:11px;padding:3px 5px;" title="通过研判但低于此等级的岗位记为备选，可在决策记录里手动处理">
                <option value="S">仅 S 级（直接对口且研发深度高）</option>
                <option value="A">S + A 级（直接对口，推荐）</option>
                <option value="B">S + A + B 级（含相近可转的专业）</option>
              </select>
            </div>
            <label class="bh-checkbox-row" style="font-size:11px;color:#166534;margin:4px 0 0 0;">
              <input data-role="jev-dry-run" type="checkbox">
              <span>🧪 校准模式：只研判、打标记，不点沟通、不占额度</span>
            </label>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:6px;">
              <span style="font-size:10px;color:#64748b;">🟡待复核 / 🔹备选 不会自动投递</span>
              <button type="button" class="bh-btn-tool" data-action="show-jev-decisions" style="background:#dcfce7;color:#14532d;font-weight:600;" title="查看每个岗位的 Jev 分数、结论与链接，可导出 JSON">📊 决策记录</button>
            </div>
          </div>
        </div>

        <!-- Tab 2: 规则与词库配置 -->
        <div class="bh-tab-content" data-tab-content="rules" style="display:none;">
          <div style="display:flex;gap:4px;margin:2px 0 6px 0;align-items:center;flex-wrap:wrap;">
            <span style="font-size:11px;color:#4b5563;font-weight:600;">方向预设:</span>
            <button type="button" class="bh-btn-tool" data-preset="bio_rd" style="background:#ccfbf1;color:#0f766e;font-weight:600;" title="分子生物、合成生物、重组蛋白纯化、多肽、噬菌体、抗体">🧬 生物研发(推荐)</button>
            <button type="button" class="bh-btn-tool" data-preset="bioinfo_ai" title="生信分析、AI科研助理、计算生物、Python">💻 生信/AI计算</button>
            <button type="button" class="bh-btn-tool" data-preset="qc_analysis" title="分析检测、理化质检、仪器分析">🧪 质检/分析</button>
          </div>

          <label>包含关键词 (任一命中即可；英文短词如 AI/QA 按整词匹配):</label>
          <textarea data-role="include-keywords" rows="2" placeholder="分子生物, 合成生物, 重组蛋白, 蛋白纯化, 噬菌体, 抗体, 多肽..."></textarea>

          <label style="margin-top:5px;">排除关键词 (命中任一即跳过，已排除纯销售/电销/流水线):</label>
          <textarea data-role="exclude-keywords" rows="2" placeholder="销售, 电销, 客服, 招商, 普工..."></textarea>

          <div class="bh-row" style="margin-top:6px;">
            <div class="bh-col">
              <label>安全投递间隔(秒):</label>
              <div style="display:flex;gap:4px;align-items:center;">
                <input data-role="interval-min" type="number" min="20" max="300" style="width:48px;" title="单次投递最小随机间隔">
                <span>~</span>
                <input data-role="interval-max" type="number" min="20" max="600" style="width:48px;" title="单次投递最大随机间隔">
              </div>
            </div>
            <div class="bh-col">
              <label>每日上限 / 最低月薪:</label>
              <div style="display:flex;gap:4px;align-items:center;">
                <input data-role="daily-max" type="number" min="1" max="150" style="width:46px;" title="每日低频适度上限">
                <span>人</span>
                <input data-role="min-salary" type="number" min="0" max="100" step="0.5" style="width:46px;" title="最低月薪(K)，0 表示不限">
                <span>K</span>
              </div>
            </div>
          </div>

          <label class="bh-checkbox-row" style="margin-top:6px;">
            <input data-role="exclude-interns" type="checkbox">
            <span>自动排除实习岗位 (只投正式全职/应届研发)</span>
          </label>
          <div style="display:flex;align-items:center;gap:4px;margin:4px 0;font-size:11px;color:#334155;">
            <span>经验要求 ≥</span>
            <input data-role="max-exp-years" type="number" min="0" max="20" style="width:42px;" title="卡片标签要求的最低经验年限达到此值就跳过，例如 3 表示跳过 3-5年、5-10年 的岗位；0 表示不限">
            <span>年的岗位跳过 (0=不限)</span>
          </div>
          <label class="bh-checkbox-row">
            <input data-role="skip-phd" type="checkbox">
            <span>跳过要求博士学历的岗位</span>
          </label>

          <div class="bh-extra-tools" style="margin-top:8px;">
            <button class="bh-btn-link" data-action="reset-stats">重置今日统计</button>
            <span style="color:#d1d5db;">|</span>
            <button class="bh-btn-link" data-action="clear-visited">清空已阅记录</button>
            <span style="color:#d1d5db;">|</span>
            <button class="bh-btn-link" data-action="load-bio-preset" style="color:#0d9488;font-weight:600;">恢复预设</button>
          </div>
        </div>

        <!-- Tab 3: 目标直投/企业侦测 -->
        <div class="bh-tab-content" data-tab-content="hunter" style="display:none;">
          <div style="padding:8px 10px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;margin-bottom:8px;">
            <div style="font-size:11px;color:#0f766e;font-weight:600;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;">
              <span>🎯 目标公司直投/侦测:</span>
              <span data-role="hunter-company" style="color:#1e293b;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:normal;" title="点击卡片可切换目标">点击卡片选中</span>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;">
              <button type="button" class="bh-btn-tool" data-action="hunt-wechat" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;" title="在搜狗微信中查找该公司的招聘推文与HR邮箱">🔍 搜公众号推文</button>
              <button type="button" class="bh-btn-tool" data-action="hunt-aiqicha" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;" title="直达爱企查查询工商登记邮箱与官网">🏢 查爱企查/官网</button>
              <button type="button" class="bh-btn-tool" data-action="hunt-mailto" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;" title="唤起本地邮件客户端直接发信">✉️ 邮件直投</button>
            </div>
          </div>

          <div style="font-size:11px;color:#475569;margin-bottom:8px;background:#f0fdfa;padding:8px 10px;border-radius:8px;border-left:3px solid #0d9488;line-height:1.45;">
            💡 <b>交换简历指南</b>：BOSS平台打招呼仅开启会话。每天完成自动打招呼后，请前往【消息】列表向已读HR主动点击<b>【发简历】</b>递送PDF附件，才能大幅促成简历交换！
          </div>

          <div style="display:flex;justify-content:flex-end;">
            <button class="bh-btn-tool" data-action="export-applied" style="background:#0284c7;color:#ffffff;font-weight:600;padding:6px 12px;border:none;" title="导出公司名单直接导入Python脚本">📋 导出/复制名单 (NAS/本地通用)</button>
          </div>
        </div>

        <!-- Tab 4: 运行终端日志 -->
        <div class="bh-tab-content" data-tab-content="logs" style="display:none;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
            <span style="font-size:11px;color:#64748b;font-weight:600;">实时巡视与决策流水:</span>
            <button type="button" class="bh-btn-link" data-action="clear-logs" style="font-size:10px;">清空日志</button>
          </div>
          <div class="bh-logs" data-role="logs"></div>
        </div>
      </div>
    `;

    restorePanelPosition(panel);
    setupDraggable(panel);

    function switchTab(tabKey) {
      panel.querySelectorAll(".bh-tab-btn").forEach(btn => {
        btn.classList.toggle("active", btn.getAttribute("data-tab") === tabKey);
      });
      panel.querySelectorAll(".bh-tab-content").forEach(content => {
        content.style.display = content.getAttribute("data-tab-content") === tabKey ? "block" : "none";
      });
      saveSettings({ activeTab: tabKey });
    }

    panel.querySelectorAll(".bh-tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.getAttribute("data-tab")));
    });

    switchTab(state.settings.activeTab || "jev");

    panel.querySelector('[data-action="clear-logs"]')?.addEventListener("click", () => {
      state.logs = [];
      storeSet(STORAGE_KEYS.logs, []);
      renderStatus();
    });

    panel.querySelector('[data-action="collapse"]').addEventListener("click", () => {
      saveSettings({ panelCollapsed: !state.settings.panelCollapsed });
    });

    panel.querySelector('[data-action="hide"]').addEventListener("click", () => {
      if (state.isRunning) {
        state.mode = "STOPPED";
        addLog("面板已关闭，投递随之停止");
      }
      saveSettings({ panelHidden: true });
      panel.remove();
    });

    panel.querySelectorAll("[data-preset]").forEach(btn => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-preset");
        const p = PRESETS[key];
        if (!p) return;
        saveSettings({
          candidateProfile: p.candidateProfile || state.settings.candidateProfile,
          includeKeywords: p.includeKeywords,
          excludeKeywords: p.excludeKeywords,
          greetingText: p.greetingText,
          minSalaryK: p.minSalaryK,
          jevMinDepth: p.jevMinDepth
        });
        addLog(`已载入【${p.name}】专属学术画像、关键词与配置！`);
      });
    });

    panel.querySelector('[data-action="load-bio-preset"]').addEventListener("click", () => {
      const p = PRESETS.bio_rd;
      saveSettings({
        candidateProfile: p.candidateProfile || state.settings.candidateProfile,
        includeKeywords: p.includeKeywords,
        excludeKeywords: p.excludeKeywords,
        greetingText: p.greetingText,
        minSalaryK: p.minSalaryK,
        jevMinDepth: p.jevMinDepth
      });
      addLog("已恢复【生物研发】专属科研画像与配置！");
    });

    panel.querySelector('[data-action="hunt-wechat"]').addEventListener("click", () => {
      const comp = state.currentCompany;
      if (!comp) {
        alert("请先在页面中点击任意职位卡片以选定目标公司！");
        return;
      }
      const url = `https://weixin.sogou.com/weixin?type=2&query=${encodeURIComponent(comp + " 招聘 邮箱")}`;
      window.open(url, "_blank");
      addLog(`🔍 已在新窗口打开搜狗微信检索【${comp}】招聘推文`);
    });

    panel.querySelector('[data-action="hunt-aiqicha"]').addEventListener("click", () => {
      const comp = state.currentCompany;
      if (!comp) {
        alert("请先在页面中点击任意职位卡片以选定目标公司！");
        return;
      }
      const url = `https://aiqicha.baidu.com/s?q=${encodeURIComponent(comp)}`;
      window.open(url, "_blank");
      addLog(`🏢 已打开爱企查查询【${comp}】工商与联系邮箱`);
    });

    panel.querySelector('[data-action="hunt-mailto"]').addEventListener("click", () => {
      const comp = state.currentCompany;
      const title = state.currentTitle || "研发岗位";
      if (!comp) {
        alert("请先在页面中点击任意职位卡片以选定目标公司！");
        return;
      }
      const subject = `【应聘-${title}】个人简历`;
      const body = state.settings.greetingText;
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      addLog(`✉️ 已唤起邮件客户端准备直投【${comp} · ${title}】`);
    });

    panel.querySelector('[data-action="export-applied"]').addEventListener("click", () => {
      showAppliedCompaniesModal();
    });

    panel.querySelector('[data-action="show-jev-decisions"]').addEventListener("click", () => {
      showJevDecisionsModal();
    });

    panel.querySelector('[data-action="toggle-jev-key-view"]').addEventListener("click", () => {
      const input = panel.querySelector('[data-role="jev-api-key"]');
      if (!input) return;
      const isPwd = input.type === "password";
      input.type = isPwd ? "text" : "password";
      panel.querySelector('[data-action="toggle-jev-key-view"]').textContent = isPwd ? "🙈" : "👁️";
    });

    panel.querySelector('[data-action="test-jev-key"]').addEventListener("click", async () => {
      savePanelValues();
      const key = getActiveJevKey();
      if (!key) {
        alert("请先在输入框中填入 Jev API Key！\n\n支持：\n1. TypeSafe 官方 Key (直连端点)\n2. OpenRouter Key (sk-or-...)");
        return;
      }
      const testBtn = panel.querySelector('[data-action="test-jev-key"]');
      const originalText = testBtn.textContent;
      testBtn.textContent = "⏳ 探测中...";
      testBtn.disabled = true;
      try {
        const data = await requestJevAPI({
          state: { probe: "testing connection and authentication" },
          questions: {
            is_valid: {
              type: "noul",
              instructions: "Is this connection test request received successfully?"
            }
          }
        });
        if (typeof data.answers.is_valid?.noul === "number") {
          const provider = key.startsWith("sk-or-") ? "OpenRouter" : "TypeSafe 官方";
          addLog(`✅ Jev API 校验成功！接入节点：${provider}，应答模型 ${data.model || "未知"}`);
          alert(`✅ Jev API Key 验证成功！

接入节点：${provider}
应答模型：${data.model || "未知"}

建议先勾选【校准模式】跑一轮，抽查决策记录后再正式投递。`);
        } else {
          addLog("⚠️ Jev 返回格式不完整，但网络已联通。");
          alert("⚠️ Jev 返回格式不完整，请检查模型节点状态。");
        }
      } catch (err) {
        addLog(`❌ Jev 连接测试失败：${err.message}`);
        alert(`❌ Jev API 连接测试失败：\n${err.message}\n\n请检查：\n1. Key 是否完整且无多余空格\n2. 账户额度/Balance 是否充足\n3. 网络是否可访问 TypeSafe/OpenRouter API`);
      } finally {
        testBtn.textContent = originalText;
        testBtn.disabled = false;
      }
    });

    panel.querySelector('[data-action="start"]').addEventListener("click", () => {
      try {
        savePanelValues();
      } catch (err) {
        console.error("保存面板设置异常:", err);
      }
      if (state.mode === "RUNNING") return;
      state.isRunning = false;
      if (state.settings.jevEnabled && !getActiveJevKey() &&
        !confirm("已开启 Jev 研判但没有填写 API Key，本次将只按关键词规则筛选。确定继续吗？")) {
        return;
      }
      if (!state.settings.jevDryRun && state.stats.success >= state.settings.dailyMax) {
        alert("今日已达低频安全上限！如需继续，请调高上限或点击【重置今日统计】。");
        return;
      }
      startLoop();
    });

    panel.querySelector('[data-action="pause"]').addEventListener("click", () => {
      if (state.mode !== "RUNNING") return;
      state.mode = "PAUSED";
      state.isRunning = false;
      setMessage("已暂停投递");
      addLog("已手动暂停低频投递");
    });

    panel.querySelector('[data-action="stop"]').addEventListener("click", () => {
      state.mode = "STOPPED";
      state.isRunning = false;
      setMessage("已停止投递");
      addLog("已手动停止投递");
    });

    panel.querySelector('[data-action="reset-stats"]').addEventListener("click", () => {
      if (!confirm("确定要重置今天的投递统计吗？")) return;
      state.stats = freshStats();
      saveStats();
      addLog("已重置今日投递统计");
    });

    panel.querySelector('[data-action="clear-visited"]').addEventListener("click", () => {
      if (!confirm("确定要清空已浏览岗位缓存吗？(清空后可重新评估之前跳过的岗位)")) return;
      state.visitedKeys.clear();
      storeSet(STORAGE_KEYS.visited, []);
      addLog("已清空已阅岗位缓存记录");
    });

    panel.querySelectorAll("input, textarea, select").forEach(input => input.addEventListener("change", savePanelValues));

    document.body.appendChild(panel);
    syncInputsFromSettings(true);
    renderStatus();
  }

  function savePanelValues() {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;
    const field = role => p.querySelector(`[data-role="${role}"]`);
    const val = (role, fallback) => {
      const el = field(role);
      return el ? el.value : fallback;
    };
    const bool = (role, fallback) => {
      const el = field(role);
      return el ? el.checked : fallback;
    };

    saveSettings({
      intervalMin: val("interval-min", state.settings.intervalMin),
      intervalMax: val("interval-max", state.settings.intervalMax),
      dailyMax: val("daily-max", state.settings.dailyMax),
      minSalaryK: val("min-salary", state.settings.minSalaryK),
      excludeInternships: bool("exclude-interns", state.settings.excludeInternships),
      autoSendGreeting: bool("auto-greeting", state.settings.autoSendGreeting),
      includeKeywords: val("include-keywords", state.settings.includeKeywords),
      excludeKeywords: val("exclude-keywords", state.settings.excludeKeywords),
      greetingText: val("greeting-text", state.settings.greetingText),
      // Jev 智能设置
      jevEnabled: bool("jev-enabled", state.settings.jevEnabled),
      jevApiKey: val("jev-api-key", state.settings.jevApiKey),
      candidateProfile: val("candidate-profile", state.settings.candidateProfile),
      jevMinDepth: val("jev-min-depth", state.settings.jevMinDepth),
      jevMaxTrap: val("jev-max-trap", state.settings.jevMaxTrap),
      jevMinTier: val("jev-min-tier", state.settings.jevMinTier),
      jevDryRun: bool("jev-dry-run", state.settings.jevDryRun),
      maxExpYears: val("max-exp-years", state.settings.maxExpYears),
      skipPhdJobs: bool("skip-phd", state.settings.skipPhdJobs)
    });
    syncInputsFromSettings(true); // 把规整后的值（如被钳位的间隔）回显到输入框
  }

  // 只在设置变化时回写输入框；非强制模式下不覆盖用户正在编辑的输入框
  function syncInputsFromSettings(force) {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;
    const s = state.settings;
    const fields = [
      ["interval-min", "value", s.intervalMin],
      ["interval-max", "value", s.intervalMax],
      ["daily-max", "value", s.dailyMax],
      ["min-salary", "value", s.minSalaryK],
      ["exclude-interns", "checked", s.excludeInternships],
      ["auto-greeting", "checked", s.autoSendGreeting],
      ["include-keywords", "value", s.includeKeywords],
      ["exclude-keywords", "value", s.excludeKeywords],
      ["greeting-text", "value", s.greetingText],
      ["jev-enabled", "checked", s.jevEnabled],
      ["jev-api-key", "value", s.jevApiKey],
      ["candidate-profile", "value", s.candidateProfile],
      ["jev-min-depth", "value", s.jevMinDepth],
      ["jev-max-trap", "value", s.jevMaxTrap],
      ["jev-min-tier", "value", s.jevMinTier],
      ["jev-dry-run", "checked", s.jevDryRun],
      ["max-exp-years", "value", s.maxExpYears],
      ["skip-phd", "checked", s.skipPhdJobs]
    ];
    for (const [role, prop, value] of fields) {
      const el = p.querySelector(`[data-role="${role}"]`);
      if (!el || (!force && el === document.activeElement)) continue;
      if (prop === "checked") {
        if (el.checked !== value) el.checked = value;
      } else if (String(el.value) !== String(value)) {
        el.value = value;
      }
    }
  }

  // 高频刷新的状态区（徽标、按钮、统计、消息、日志），不触碰输入框
  function renderStatus() {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;

    if (p.classList) p.classList.toggle("is-collapsed", Boolean(state.settings.panelCollapsed));
    const collapseBtn = p.querySelector('[data-action="collapse"]');
    if (collapseBtn) collapseBtn.textContent = state.settings.panelCollapsed ? "展开" : "收起";
    const statusBadge = p.querySelector('[data-role="status-badge"]');
    if (statusBadge) statusBadge.textContent = STATUS_LABELS[state.mode] || state.mode;

    const startBtn = p.querySelector('[data-action="start"]');
    if (startBtn) {
      if (state.mode === "PAUSED") {
        startBtn.textContent = "▶ 继续投递";
        startBtn.style.opacity = "1";
      } else if (state.mode === "RUNNING") {
        startBtn.textContent = "● 运行中";
        startBtn.style.opacity = "0.7";
      } else {
        startBtn.textContent = state.settings.jevDryRun ? "▶ 开始校准研判" : "▶ 开始低频投递";
        startBtn.style.opacity = "1";
      }
    }

    const setText = (role, val) => {
      const el = p.querySelector(`[data-role="${role}"]`);
      if (el) el.textContent = val;
    };

    setText("stat-success", state.stats.success);
    setText("stat-skipped", state.stats.skipped);
    setText("stat-failed", state.stats.failed);
    setText("stat-remain", Math.max(0, state.settings.dailyMax - state.stats.success));
    setText("message", state.currentMessage);

    const logBox = p.querySelector('[data-role="logs"]');
    if (logBox) {
      logBox.textContent = state.logs.slice(-12).join("\n");
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // ========================== 初始化入口 ==========================
  function init() {
    if (!/(^|\.)zhipin\.com$/.test(location.hostname)) return;

    rebuildKeywordCache();
    settlePendingContactOnLoad();

    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("显示 BOSS 低频求职面板", () => {
        saveSettings({ panelHidden: false, panelCollapsed: false });
        renderPanel();
      });
    }

    // 页面卡片点击监听：用户点击任意职位卡片时，面板自动同步该目标公司信息
    document.addEventListener("click", e => {
      try {
        const card = e.target && e.target.closest && e.target.closest(SEL.jobCard.join(", "));
        if (card && !inPanel(card)) {
          const info = extractCardInfo(card);
          if (info && info.company) {
            setCurrentTarget(info.company, info.title);
          }
        }
      } catch {}
    }, { passive: true, capture: true });

    if (state.settings.panelHidden) return;

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", renderPanel, { once: true });
    } else {
      renderPanel();
    }
  }

  init();
})();
