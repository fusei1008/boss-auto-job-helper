// ==UserScript==
// @name         BOSS 直聘求职助手 (通用版·低频防封)
// @name:en      BOSS Zhipin Auto Job Helper (Universal)
// @namespace    boss-auto-job-helper
// @version      2.0.0
// @description  通用版求职自动助手，不限专业方向：超低频真人慢速巡检、薪资字体自动解密、详情深度核验、沟通结果确认、平台上限/风控识别，内置互联网/算法/硬件/机械/生物医药/财务/销售/职能/设计/供应链/教育等方向预设，关键词与招呼语完全可自定义。
// @author       niz
// @license      MIT
// @homepageURL  https://github.com/YOUR_GITHUB_USERNAME/boss-auto-job-helper
// @supportURL   https://github.com/YOUR_GITHUB_USERNAME/boss-auto-job-helper/issues
// @match        https://zhipin.com/*
// @match        https://*.zhipin.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// ==/UserScript==

/*
 * 参考与致谢（均为 MIT 许可，详见 README 的「参考与致谢」一节）：
 *   - Ocyss/boss-helper              浏览器端自动化方案的整体形态
 *   - eatmoreduck/boss-zhipin-scraper 前端字体反爬（薪资加密）的识别与还原思路
 *   - xirichuyi/boss-job-agent        「不绕过扫码/人机验证/平台限制」的边界设定
 *   - longsizhuo/BossZhiPin_Job_Search 招呼语模板化 + 发送前规则审核
 *   - can4hou6joeng4/boss-agent-cli   结构化输出与结果确认
 */

(function () {
  "use strict";

  // 避免在第三方 iframe 或风控验证框 iframe 中重复加载
  if (window.top !== window.self) return;

  const PANEL_ID = "boss-auto-helper-panel";
  const STYLE_ID = "boss-auto-helper-style";
  const SETTINGS_VERSION = "v2.0.0";

  const MIN_INTERVAL_SEC = 20;          // 单次投递间隔的硬下限（秒）
  const MAX_VISITED = 2500;             // 已阅岗位缓存上限
  const MAX_LOGS = 100;                 // 日志保留条数
  const MAX_CONSECUTIVE_FAILURES = 5;   // 连续异常达到此值自动暂停
  const MAX_EMPTY_LOAD_ROUNDS = 6;      // 连续拉取都没有新岗位时停止
  const DETAIL_TIMEOUT_MS = 6000;       // 等待右侧详情切换的最长时间
  const CONFIRM_TIMEOUT_MS = 8000;      // 点击沟通后等待平台反馈的最长时间

  const STORAGE_KEYS = {
    settings: "bossAutoHelper.settings",
    stats: "bossAutoHelper.stats",
    visited: "bossAutoHelper.visitedJobs",
    logs: "bossAutoHelper.logs",
    pending: "bossAutoHelper.pendingContact",
    applied: "bossAutoHelper.appliedCompanies"
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
    contactButton: ".op-btn-chat, .btn-startchat, [class*='btn-chat'], [class*='op-btn'], a, button",
    dialog: ".dialog-wrap, .boss-popup__wrapper, .boss-dialog, [role='dialog'], .verify-slider, .geetest_panel",
    anyButton: "button, a, .btn, [class*='btn']",
    chatInput: ".chat-conversation .chat-input, .chat-input, .chat-editor, textarea[placeholder*='打招呼'], textarea[placeholder*='留个言'], textarea, [contenteditable='true']",
    sendButton: ".chat-conversation .btn-send, .btn-send, [class*='btn-send']",
    pagerNext: "a, button, [class*='next'], [class*='arrow-right']"
  };

  // ========================== 方向预设库 ==========================
  // 每个预设包含：名称 / 包含关键词 / 排除关键词 / 招呼语 / 最低月薪(K)
  // 招呼语支持占位符：{company} {title}（也可写 {公司} {岗位}）
  // 想新增方向？照着下面任意一条复制一份，改 key 和内容即可，面板下拉框会自动出现。

  // 通用排除词：各方向共用。命中即跳过，主要用于滤掉纯销售/电销/流水线等无效岗位。
  const COMMON_EXCLUDE = "销售, 电销, 电话销售, 微信销售, 网络销售, 地推, 招商, 渠道, 猎头, 保险, 催收, 房产, 中介, 客服, 普工, 兼职, 日结, 小时工, 劳务派遣, 操作工, 包装工, 产线流水线, 车间工人, 学徒";

  // 兜底招呼语：所有预设都可自行改写，面板里也能直接编辑
  const DEFAULT_GREETING = "您好！我对贵司的「{title}」岗位很感兴趣，我的经历与该岗位的要求比较匹配。方便的话想进一步沟通，期待您的回复！";

  const PRESETS = {
    tech: {
      name: "💻 互联网 / 软件研发",
      includeKeywords: "Java, Golang, Go语言, Python, PHP, C++, C#, C语言, 前端, 后端, 全栈, Web前端, 服务端, 客户端, Android, iOS, 鸿蒙, 小程序, 软件工程师, 软件开发, 开发工程师, 测试开发, 软件测试, 自动化测试, 运维, 运维开发, SRE, DevOps, 架构师, 微服务, 分布式, 云原生, Kubernetes, Docker, 数据库, DBA, 网络安全, 安全工程师, 音视频开发, 图形开发, 游戏开发, Unity, 虚幻, UE4, UE5, 嵌入式软件",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我的技术栈与岗位要求比较匹配，也做过同类项目。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 8
    },
    ai_data: {
      name: "🤖 算法 / AI / 大数据",
      includeKeywords: "算法, 算法工程师, 机器学习, 深度学习, 大模型, LLM, NLP, 自然语言处理, 计算机视觉, 推荐算法, 搜索算法, 广告算法, 数据挖掘, 数据科学, 数据分析, 数据开发, 数据仓库, 数据平台, 大数据, 数据工程, 商业分析, 量化, 强化学习, 多模态, AIGC, 语音识别, 图像算法, 感知算法, 自动驾驶算法",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在数据处理与算法建模方面有相关经验，与该岗位方向比较匹配。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 10
    },
    hardware: {
      name: "🔌 电子 / 硬件 / 嵌入式",
      includeKeywords: "硬件工程师, 硬件开发, 嵌入式, 单片机, MCU, ARM, FPGA, DSP, PCB, 电路设计, 模拟电路, 数字电路, 射频, 天线, 电源工程师, 驱动开发, 固件, 电气工程师, 自动化工程师, 仪器仪表, 传感器, 芯片设计, IC设计, 版图, 验证工程师, EMC",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在硬件/嵌入式方向有相关项目经验，与该岗位要求比较匹配。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 7
    },
    mech: {
      name: "⚙️ 机械 / 制造 / 工艺",
      includeKeywords: "机械设计, 机械工程师, 结构设计, 结构工程师, 工艺工程师, 制程工程师, 模具, 非标自动化, 夹具, 设备工程师, 生产管理, 生产主管, 质量管理, 质量工程师, 精益生产, IE工程师, 工业工程, 材料工程师, 焊接, 数控, CNC, 钣金, 注塑, 热处理, 装配",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在机械/工艺方向有相关经验，踏实肯干，与该岗位要求比较匹配。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 6
    },
    bio_rd: {
      name: "🧬 生物医药 / 化工研发",
      includeKeywords: "分子生物, 合成生物, 重组蛋白, 蛋白纯化, 蛋白表达, 多肽, 环肽, 噬菌体, 噬菌体展示, 抗体, 抗体工程, 酶催化, 载体构建, 质粒构建, 基因克隆, FPLC, AKTA, 生物淘选, 生物合成, 生化研发, 蛋白工程, 分子克隆, 表达纯化, 纯化表征, 研发研究员, 研发工程师, 生物研发, 科研助理, 研发助理",
      excludeKeywords: COMMON_EXCLUDE + ", 临床协调, CRA, CRC, 招投标, 采购, 申报专员, 饲养员",
      greetingText: "您好！看到贵司正在招聘「{title}」，与我的研发经历高度匹配。希望能向您呈递详细简历并深入沟通！",
      minSalaryK: 7
    },
    bioinfo: {
      name: "🧫 生信分析 / 计算生物",
      includeKeywords: "生信, 生信分析, 生信工程师, 计算生物, 计算化学, AI研究助理, AI助理, 结构生物, 分子模拟, 分子对接, 药物设计, 机器学习, Python, 科研助理, 研发助理",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对「{title}」岗位非常感兴趣。我在科研中熟练使用 Python 进行数据挖掘、序列/结构建模与自动化分析，熟悉各类 AI 辅助科研工具。希望能向您呈递详细简历并进一步沟通！",
      minSalaryK: 8
    },
    qc_analysis: {
      name: "🧪 质检 / 分析检测",
      includeKeywords: "分析检测, 质检, QA, QC, 理化检验, 检验员, 实验员, 化验员, 仪器分析, 色谱分析, HPLC, 质谱分析, 食品检验, 材料检测, 无损检测, 计量, 校准, 研发助理, 助理工程师",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣。我具备扎实的实验操作、仪器分析（HPLC/质谱等）与数据处理能力，踏实严谨。希望能向您呈递详细简历并进一步交流！",
      minSalaryK: 6
    },
    finance: {
      name: "📊 财务 / 审计 / 金融",
      includeKeywords: "会计, 财务, 财务分析, 财务BP, 审计, 税务, 出纳, 成本会计, 总账, 资金管理, 风控, 合规, 投资, 投研, 证券, 基金, 银行, 信贷, 保险精算, 量化研究",
      excludeKeywords: "电销, 电话销售, 网络销售, 地推, 招商, 猎头, 保险销售, 保险代理, 催收, 房产, 中介, 客服, 普工, 兼职, 日结, 小时工, 劳务派遣, 操作工, 包装工, 产线流水线",
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在财务/金融相关方向有相应经验，做事细致严谨。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 6
    },
    sales_mkt: {
      name: "📣 销售 / 市场 / 运营",
      includeKeywords: "销售, 大客户, 渠道, 商务拓展, 市场, 品牌, 市场营销, 运营, 用户运营, 内容运营, 新媒体运营, 电商运营, 活动运营, 产品运营, 社群运营, 增长, 推广, 媒介, 公关, 广告, 客户成功, 售后",
      excludeKeywords: "催收, 保险代理, 房产中介, 客服, 普工, 兼职, 日结, 小时工, 劳务派遣, 操作工, 包装工, 产线流水线",
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我有相关的客户开拓与成单经验，抗压能力强。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 0
    },
    hr_admin: {
      name: "🧑‍💼 人力 / 行政 / 职能",
      includeKeywords: "招聘, 人力资源, HR, HRBP, 人事, 薪酬绩效, 培训, 组织发展, 行政, 总裁助理, 总经理助理, 法务, 律师, 知识产权, 专利, 内控, 战略, 投资者关系",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在职能/人力相关方向有相应经验，沟通协调能力较强。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 5
    },
    design: {
      name: "🎨 设计 / 创意",
      includeKeywords: "UI设计, UX, 交互设计, 视觉设计, 平面设计, 电商设计, 工业设计, 产品设计, 3D设计, 动画设计, 游戏美术, 原画, 插画, 视频剪辑, 影视后期, 摄影师, 品牌设计, 包装设计, 室内设计, 景观设计, 建筑设计",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我熟悉完整的设计流程，可随时提供作品集。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 6
    },
    supply: {
      name: "📦 供应链 / 采购 / 物流",
      includeKeywords: "采购, 供应链, 物流, 仓储, 库存, 计划员, 生产计划, 物料, 关务, 报关, 外贸, 单证, 跟单, 品质, 供应商管理, SQE, 配送, 运输",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我在采购/供应链方向有相应经验，熟悉业务流程与供应商管理。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 6
    },
    edu: {
      name: "🎓 教育 / 教师 / 教研",
      includeKeywords: "教师, 老师, 讲师, 教研, 助教, 课程顾问, 培训师, 教务, 班主任, 早教, 幼教, 留学顾问",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: "您好！我对贵司的「{title}」岗位很感兴趣，我有教学/教研相关经验，善于沟通与表达。方便的话想进一步沟通，期待您的回复！",
      minSalaryK: 5
    },
    general: {
      name: "🌐 通用（不限定方向，仅按排除词过滤）",
      includeKeywords: "",
      excludeKeywords: COMMON_EXCLUDE,
      greetingText: DEFAULT_GREETING,
      minSalaryK: 0
    }
  };

  // 默认使用的预设（用户可在面板下拉框中一键切换）
  const DEFAULT_PRESET_KEY = "tech";

  // 把招呼语里的占位符替换成当前岗位的真实信息
  function renderGreeting(text) {
    const tpl = String(text || "");
    if (!tpl) return "";
    return tpl
      .replace(/\{company\}|\{公司\}/g, state.currentCompany || "")
      .replace(/\{title\}|\{岗位\}/g, state.currentTitle || "")
      .trim();
  }

  // 默认配置
  const DEFAULT_SETTINGS = {
    version: SETTINGS_VERSION,
    intervalMin: 45,           // 最小安全投递间隔 45 秒 (慢速低频)
    intervalMax: 90,           // 最大安全投递间隔 90 秒 (慢速低频，不给平台造成压力)
    dailyMax: 40,              // 每日低频适度上限 (建议 30-50，安全稳定)
    presetKey: DEFAULT_PRESET_KEY, // 面板下拉框当前选中的方向预设
    minSalaryK: PRESETS[DEFAULT_PRESET_KEY].minSalaryK,
    excludeInternships: true,  // 自动排除实习生岗位
    autoSendGreeting: true,    // 页面弹出可编辑输入框时，自动填入并发送定制介绍
    greetingText: PRESETS[DEFAULT_PRESET_KEY].greetingText,
    includeKeywords: PRESETS[DEFAULT_PRESET_KEY].includeKeywords,
    excludeKeywords: PRESETS[DEFAULT_PRESET_KEY].excludeKeywords,
    panelCollapsed: false,
    panelHidden: false,
    panelX: null,
    panelY: null
  };

  const STATUS_LABELS = {
    IDLE: "空闲",
    RUNNING: "低频运行中",
    PAUSED: "已暂停",
    STOPPED: "已停止",
    ERROR: "异常保护停止"
  };

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
      title: title || "未知岗位",
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
    const lines = list.map(item => `${item.company} ${item.title || ""}`.trim()).join("\n");
    
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
          💡 <b>一键复制</b>：无需在下载目录里翻找文件，直接点击下方【一键复制】，粘贴到任意文本编辑器或下游工具即可使用：
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
  // 重要：升级版本时绝不覆盖用户已经填好的关键词/招呼语，只补全缺失字段。
  function sanitizeSettings(raw) {
    const src = raw && typeof raw === "object" ? raw : {};
    const s = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (src[key] !== undefined && src[key] !== null) s[key] = src[key];
    }
    s.version = SETTINGS_VERSION;

    s.presetKey = PRESETS[s.presetKey] ? s.presetKey : DEFAULT_PRESET_KEY;
    s.intervalMin = clampNum(s.intervalMin, MIN_INTERVAL_SEC, 300, DEFAULT_SETTINGS.intervalMin);
    s.intervalMax = clampNum(s.intervalMax, s.intervalMin, 600, DEFAULT_SETTINGS.intervalMax);
    s.dailyMax = clampNum(s.dailyMax, 1, 150, DEFAULT_SETTINGS.dailyMax);
    s.minSalaryK = clampNum(s.minSalaryK, 0, 100, DEFAULT_SETTINGS.minSalaryK, false);
    s.excludeInternships = Boolean(s.excludeInternships);
    s.autoSendGreeting = Boolean(s.autoSendGreeting);
    s.includeKeywords = String(s.includeKeywords ?? "").trim();
    s.excludeKeywords = String(s.excludeKeywords ?? "").trim();
    s.greetingText = String(s.greetingText ?? "").trim();
    s.panelCollapsed = Boolean(s.panelCollapsed);
    s.panelHidden = Boolean(s.panelHidden);
    s.panelX = typeof s.panelX === "string" ? s.panelX : null;
    s.panelY = typeof s.panelY === "string" ? s.panelY : null;
    return s;
  }

  function loadSettings() {
    const stored = storeGet(STORAGE_KEYS.settings, null);
    const merged = sanitizeSettings(stored);
    if (!stored || stored.version !== SETTINGS_VERSION) storeSet(STORAGE_KEYS.settings, merged);
    return merged;
  }

  function saveSettings(patch) {
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

  // 初筛：只针对卡片文本（标题/公司/标签）快速判断
  // 包含关键词留空 = 不按方向筛选（仅受排除词约束），便于做“不限方向”的通用投递
  function checkCardQuickFilter(title, company, tags) {
    const cardText = `${title} ${company} ${tags.join(" ")}`;
    const ex = findMatch(cardText, state.kw.exclude);
    if (ex) return { pass: false, skipReason: `卡片命中排除词【${ex}】` };
    if (state.kw.include.length === 0) return { pass: true };
    if (findMatch(cardText, state.kw.include)) return { pass: true };
    return { pass: false, skipReason: "卡片未命中任何包含关键词" };
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

  // 若弹窗/聊天区出现可编辑输入框，填入定制介绍并发送一次；返回是否已发送
  async function trySendGreeting(dialogs) {
    const roots = dialogs.length ? dialogs : Array.from(document.querySelectorAll(".chat-conversation, .boss-popup__wrapper, .dialog-wrap, .chat-message-box"));
    for (const root of roots) {
      const input = Array.from(root.querySelectorAll(SEL.chatInput)).find(el => isVisible(el) && !inPanel(el));
      if (!input) continue;
      try {
        setInputValue(input, state.settings.greetingText);
        await sleep(400);
        const sendBtn = Array.from(root.querySelectorAll(SEL.sendButton)).find(el => isVisible(el))
          || findVisibleButtonByText(root, /^(发送|确定发送|确认发送|留个言)$/);
        if (sendBtn) {
          sendBtn.click();
          addLog("已自动发送高转化求职介绍");
          await sleep(600);
          return true;
        }
      } catch {}
    }
    return false;
  }

  // 点击“立即沟通”之后等待平台反馈，确认是否真的建立了沟通。
  // 返回 { result: "confirmed" | "limit" | "risk" | "unconfirmed", text? }
  async function confirmContact() {
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    let confirmed = false;
    let stayed = false;
    let greetingSent = false;

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

      // 2. 出现可编辑的打招呼输入框时，只发送一次定制介绍
      if (!greetingSent && state.settings.autoSendGreeting && state.settings.greetingText) {
        greetingSent = await trySendGreeting(dialogs);
      }

      // 3. “留在此页”确认框：平台已自动发送默认招呼语，点击留在列表页
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

      // 4. 详情面板按钮变成“继续沟通”即视为成功
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

  // 处理一张未评估过的卡片。返回 "handled" | "no_target" | "no_more" | "stop"
  async function processNextCard() {
    const cards = getVisibleJobCards();
    let targetCard = null;
    let targetKey = "";
    for (const card of cards) {
      const key = getCardKey(card);
      if (key && !state.visitedKeys.has(key)) {
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
    recordVisited(targetKey);

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

    // 卡片级关键词初筛 (避免点击无关岗位)
    const quick = checkCardQuickFilter(title, company, tags);
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

    // 深度核验详情描述（确保命中目标关键词，且无隐蔽销售话术）
    const deep = checkDetailKeywords(`${title} ${company} ${tags.join(" ")} ${detailText}`);
    if (!deep.pass) return skipCard(deep.reason, label, 2000, 1200);

    // 检查沟通按钮状态
    const contact = findContactButton();
    if (!contact) return skipCard("未匹配到沟通入口", label, 1500, 0);
    if (contact.state !== "ready") return skipCard(CONTACT_SKIP_LABELS[contact.state] || contact.text, label, 1500, 0);

    // 触发立即沟通：先落盘意图再点击
    savePendingContact({ key: targetKey, company, title, date: todayKey(), at: Date.now() });
    addLog(`🎯 命中意向岗位：${label} (${decodeBossSalary(rawSalary) || "薪资未知"})`);
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
    state.emptyRounds = 0;
    addLog("=== 低频自动投递已启动 (慢速防封模式) ===");
    renderStatus();

    try {
      while (state.mode === "RUNNING") {
        rollStatsIfNewDay();

        // 每日配额上限检查
        if (state.stats.success >= state.settings.dailyMax) {
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
        width: 340px;
        z-index: 9999999;
        box-sizing: border-box;
        padding: 14px;
        border-radius: 12px;
        background: #ffffff;
        color: #1f2937;
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.18), 0 0 0 1px rgba(13, 148, 136, 0.35);
        font-size: 13px;
        line-height: 1.45;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        user-select: none;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .bh-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
        padding-bottom: 6px;
        border-bottom: 1px solid #e5e7eb;
        cursor: move;
      }
      #${PANEL_ID} .bh-title {
        font-weight: 700;
        font-size: 14px;
        color: #0d9488;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${PANEL_ID} .bh-badge {
        display: inline-block;
        font-size: 11px;
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
        background: #f3f4f6;
        color: #4b5563;
        border-radius: 6px;
        padding: 4px 8px;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
      }
      #${PANEL_ID} .bh-btn-tool:hover { background: #e5e7eb; color: #111827; }
      #${PANEL_ID}.is-collapsed { width: 230px; padding: 10px 14px; }
      #${PANEL_ID}.is-collapsed .bh-body { display: none; }
      #${PANEL_ID}.is-collapsed .bh-header { margin-bottom: 0; padding-bottom: 0; border-bottom: none; }
      #${PANEL_ID} .bh-row { display: flex; gap: 8px; margin: 6px 0; }
      #${PANEL_ID} .bh-col { flex: 1; }
      #${PANEL_ID} label { display: block; font-size: 11px; color: #4b5563; margin-bottom: 2px; font-weight: 500; }
      #${PANEL_ID} input[type="number"], #${PANEL_ID} textarea {
        width: 100%;
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 5px 7px;
        color: #111827;
        font-size: 12px;
        font-family: inherit;
        user-select: text;
      }
      #${PANEL_ID} textarea { resize: vertical; min-height: 40px; }
      #${PANEL_ID} select {
        border: 1px solid #d1d5db;
        border-radius: 6px;
        padding: 4px 6px;
        color: #111827;
        font-size: 12px;
        font-family: inherit;
        background: #ffffff;
        cursor: pointer;
      }
      #${PANEL_ID} .bh-checkbox-row {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 6px 0;
        font-size: 12px;
        color: #374151;
        cursor: pointer;
      }
      #${PANEL_ID} .bh-actions {
        display: grid;
        grid-template-columns: 1.4fr 1fr 1fr;
        gap: 6px;
        margin: 10px 0 8px 0;
      }
      #${PANEL_ID} .bh-btn-main {
        border: none;
        border-radius: 6px;
        padding: 8px 0;
        color: #ffffff;
        font-weight: 600;
        cursor: pointer;
        font-size: 12px;
        transition: opacity 0.2s;
      }
      #${PANEL_ID} .bh-btn-main:hover { opacity: 0.9; }
      #${PANEL_ID} .bh-btn-start { background: #0d9488; }
      #${PANEL_ID} .bh-btn-pause { background: #d97706; }
      #${PANEL_ID} .bh-btn-stop  { background: #dc2626; }
      #${PANEL_ID} .bh-status-box {
        background: #f0fdfa;
        border: 1px solid #99f6e4;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 12px;
        color: #0f766e;
        margin-top: 6px;
        word-break: break-all;
      }
      #${PANEL_ID} .bh-stats-box {
        display: flex;
        justify-content: space-between;
        align-items: center;
        background: #f9fafb;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 11px;
        color: #4b5563;
        margin-top: 6px;
        font-weight: 500;
      }
      #${PANEL_ID} .bh-stats-box span b { color: #0d9488; }
      #${PANEL_ID} .bh-extra-tools {
        display: flex;
        justify-content: flex-end;
        gap: 6px;
        margin-top: 4px;
      }
      #${PANEL_ID} .bh-btn-link {
        border: none;
        background: transparent;
        color: #6b7280;
        cursor: pointer;
        font-size: 11px;
        text-decoration: underline;
        padding: 0;
      }
      #${PANEL_ID} .bh-btn-link:hover { color: #0f766e; }
      #${PANEL_ID} .bh-logs {
        max-height: 115px;
        overflow-y: auto;
        background: #111827;
        color: #a7f3d0;
        font-family: "Consolas", monospace;
        font-size: 11px;
        padding: 6px 8px;
        border-radius: 6px;
        margin-top: 8px;
        white-space: pre-wrap;
        user-select: text;
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
          <span>BOSS 低频求职助手</span>
          <span class="bh-badge" data-role="status-badge">空闲</span>
        </div>
        <div class="bh-header-tools">
          <button class="bh-btn-tool" data-action="collapse" title="收起/展开">收起</button>
          <button class="bh-btn-tool" data-action="hide" title="关闭面板">×</button>
        </div>
      </div>
      <div class="bh-body">
        <div class="bh-row">
          <div class="bh-col">
            <label>安全投递间隔(秒): 最小 ~ 最大</label>
            <div style="display:flex;gap:4px;align-items:center;">
              <input data-role="interval-min" type="number" min="20" max="300" style="width:52px;" title="单次投递最小随机间隔">
              <span>~</span>
              <input data-role="interval-max" type="number" min="20" max="600" style="width:52px;" title="单次投递最大随机间隔">
            </div>
          </div>
          <div class="bh-col">
            <label>每日上限 / 最低月薪</label>
            <div style="display:flex;gap:4px;align-items:center;">
              <input data-role="daily-max" type="number" min="1" max="150" style="width:50px;" title="每日低频适度上限">
              <span>人</span>
              <input data-role="min-salary" type="number" min="0" max="100" step="0.5" style="width:50px;" title="最低月薪(K)，0 表示不限">
              <span>K</span>
            </div>
          </div>
        </div>

        <label class="bh-checkbox-row">
          <input data-role="exclude-interns" type="checkbox">
          <span>自动排除实习岗位 (只投正式全职岗位)</span>
        </label>

        <div style="display:flex;gap:4px;margin:6px 0 8px 0;align-items:center;">
          <span style="font-size:11px;color:#4b5563;font-weight:600;white-space:nowrap;">方向预设:</span>
          <select data-role="preset-select" style="flex:1;min-width:0;" title="选择方向后点击【应用】，一键填充关键词、排除词、招呼语与最低薪资"></select>
          <button type="button" class="bh-btn-tool" data-action="apply-preset" style="background:#ccfbf1;color:#0f766e;font-weight:600;white-space:nowrap;" title="用所选方向覆盖当前关键词与招呼语">应用</button>
        </div>

        <label>包含关键词 (任一命中即可；英文短词如 AI/QA 按整词匹配；<b>留空 = 不限方向</b>):</label>
        <textarea data-role="include-keywords" rows="2" placeholder="例如: Java, 后端, 前端, 算法, 数据分析..."></textarea>

        <label>排除关键词 (命中任一即跳过，可按需删改):</label>
        <textarea data-role="exclude-keywords" rows="2" placeholder="例如: 销售, 电销, 客服, 普工, 兼职..."></textarea>

        <label class="bh-checkbox-row" title="BOSS 会自动发送你在平台设置的默认招呼语；只有页面弹出可编辑输入框时，才会额外填入并发送下面这段介绍">
          <input data-role="auto-greeting" type="checkbox">
          <span>弹出输入框时自动发送求职介绍 (平台默认招呼语仍会先发)</span>
        </label>
        <textarea data-role="greeting-text" rows="3" placeholder="求职介绍语，可用占位符 {title} / {company} 自动替换为当前岗位与公司名"></textarea>

        <div style="font-size:11px;color:#475569;margin:6px 0;background:#f0fdfa;padding:6px 8px;border-radius:6px;border-left:3px solid #0d9488;line-height:1.45;">
          💡 <b>交换简历指南</b>：平台打招呼仅开启会话。每天完成自动打招呼后，请前往【消息】列表向已读 HR 主动点击<b>【发简历】</b>递送 PDF 附件，才能大幅促成简历交换！
        </div>

        <!-- 当前选中岗位直投与企业邮箱侦测 (方案A) -->
        <div style="margin:8px 0;padding:8px 10px;border-radius:8px;background:#f8fafc;border:1px solid #e2e8f0;">
          <div style="font-size:11px;color:#0f766e;font-weight:600;margin-bottom:5px;display:flex;justify-content:space-between;align-items:center;">
            <span>🎯 目标公司直投/侦测:</span>
            <span data-role="hunter-company" style="color:#1e293b;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:normal;" title="点击卡片可切换目标">点击卡片选中</span>
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;">
            <button type="button" class="bh-btn-tool" data-action="hunt-wechat" style="background:#ecfdf5;color:#047857;border:1px solid #a7f3d0;" title="在搜狗微信中查找该公司的招聘推文与HR邮箱">🔍 搜公众号推文</button>
            <button type="button" class="bh-btn-tool" data-action="hunt-aiqicha" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;" title="直达爱企查查询工商登记邮箱与官网">🏢 查爱企查/官网</button>
            <button type="button" class="bh-btn-tool" data-action="hunt-mailto" style="background:#fff7ed;color:#c2410c;border:1px solid #fed7aa;" title="唤起本地邮件客户端直接发信">✉️ 邮件直投</button>
          </div>
        </div>

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

        <div class="bh-extra-tools">
          <button class="bh-btn-link" data-action="reset-stats">重置今日统计</button>
          <span style="color:#d1d5db;">|</span>
          <button class="bh-btn-link" data-action="clear-visited">清空已阅记录</button>
          <span style="color:#d1d5db;">|</span>
          <button class="bh-btn-link" data-action="reset-default-preset" style="color:#0d9488;font-weight:600;">恢复默认预设</button>
          <span style="color:#d1d5db;">|</span>
          <button class="bh-btn-link" data-action="export-applied" style="color:#0284c7;font-weight:600;">📋 导出/复制已投公司名单</button>
        </div>

        <div class="bh-status-box" data-role="message">低频助手已就绪，点击【开始低频投递】</div>
        <div class="bh-logs" data-role="logs"></div>
      </div>
    `;

    restorePanelPosition(panel);
    setupDraggable(panel);

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

    // 方向预设下拉框（新增预设后会自动出现，无需改这里）
    const presetSelect = panel.querySelector('[data-role="preset-select"]');
    presetSelect.innerHTML = Object.entries(PRESETS)
      .map(([key, p]) => `<option value="${key}">${p.name}</option>`)
      .join("");
    presetSelect.value = state.settings.presetKey;

    // 应用预设：覆盖关键词 / 排除词 / 招呼语 / 最低薪资
    function applyPreset(key, silent) {
      const p = PRESETS[key];
      if (!p) return;
      if (!silent && state.settings.includeKeywords && state.settings.includeKeywords !== p.includeKeywords) {
        if (!confirm(`将用【${p.name}】覆盖当前的关键词、排除词与招呼语，确定继续吗？`)) return;
      }
      saveSettings({
        presetKey: key,
        includeKeywords: p.includeKeywords,
        excludeKeywords: p.excludeKeywords,
        greetingText: p.greetingText,
        minSalaryK: p.minSalaryK
      });
      presetSelect.value = key;
      addLog(`已载入【${p.name}】预设（关键词 / 排除词 / 招呼语 / 最低薪资）`);
    }

    presetSelect.addEventListener("change", () => {
      const p = PRESETS[presetSelect.value];
      if (p) addLog(`已选择方向【${p.name}】，点击右侧【应用】生效`);
    });

    panel.querySelector('[data-action="apply-preset"]').addEventListener("click", () => {
      applyPreset(presetSelect.value, false);
    });

    panel.querySelector('[data-action="reset-default-preset"]').addEventListener("click", () => {
      if (!confirm("确定恢复默认预设吗？当前关键词与招呼语会被覆盖。")) return;
      applyPreset(DEFAULT_PRESET_KEY, true);
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
      const title = state.currentTitle || "应聘岗位";
      if (!comp) {
        alert("请先在页面中点击任意职位卡片以选定目标公司！");
        return;
      }
      const subject = `【应聘-${title}】个人简历`;
      const body = renderGreeting(state.settings.greetingText);
      window.location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      addLog(`✉️ 已唤起邮件客户端准备直投【${comp} · ${title}】`);
    });

    panel.querySelector('[data-action="export-applied"]').addEventListener("click", () => {
      showAppliedCompaniesModal();
    });

    panel.querySelector('[data-action="start"]').addEventListener("click", () => {
      savePanelValues();
      if (state.isRunning) return;
      if (state.stats.success >= state.settings.dailyMax) {
        alert("今日已达低频安全上限！如需继续，请调高上限或点击【重置今日统计】。");
        return;
      }
      startLoop();
    });

    panel.querySelector('[data-action="pause"]').addEventListener("click", () => {
      if (state.mode !== "RUNNING") return;
      state.mode = "PAUSED";
      setMessage("已暂停投递");
      addLog("已手动暂停低频投递");
    });

    panel.querySelector('[data-action="stop"]').addEventListener("click", () => {
      state.mode = "STOPPED";
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

    panel.querySelectorAll("input, textarea").forEach(input => input.addEventListener("change", savePanelValues));

    document.body.appendChild(panel);
    syncInputsFromSettings(true);
    renderStatus();
  }

  function savePanelValues() {
    const p = document.getElementById(PANEL_ID);
    if (!p) return;
    const field = role => p.querySelector(`[data-role="${role}"]`);
    saveSettings({
      intervalMin: field("interval-min").value,
      intervalMax: field("interval-max").value,
      dailyMax: field("daily-max").value,
      minSalaryK: field("min-salary").value,
      excludeInternships: field("exclude-interns").checked,
      autoSendGreeting: field("auto-greeting").checked,
      includeKeywords: field("include-keywords").value,
      excludeKeywords: field("exclude-keywords").value,
      greetingText: field("greeting-text").value
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
      ["greeting-text", "value", s.greetingText]
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

    p.classList.toggle("is-collapsed", state.settings.panelCollapsed);
    p.querySelector('[data-action="collapse"]').textContent = state.settings.panelCollapsed ? "展开" : "收起";
    p.querySelector('[data-role="status-badge"]').textContent = STATUS_LABELS[state.mode] || state.mode;

    const startBtn = p.querySelector('[data-action="start"]');
    if (state.mode === "PAUSED") {
      startBtn.textContent = "▶ 继续投递";
      startBtn.style.opacity = "1";
    } else if (state.mode === "RUNNING") {
      startBtn.textContent = "● 运行中";
      startBtn.style.opacity = "0.7";
    } else {
      startBtn.textContent = "▶ 开始低频投递";
      startBtn.style.opacity = "1";
    }

    p.querySelector('[data-role="stat-success"]').textContent = state.stats.success;
    p.querySelector('[data-role="stat-skipped"]').textContent = state.stats.skipped;
    p.querySelector('[data-role="stat-failed"]').textContent = state.stats.failed;
    p.querySelector('[data-role="stat-remain"]').textContent = Math.max(0, state.settings.dailyMax - state.stats.success);

    p.querySelector('[data-role="message"]').textContent = state.currentMessage;
    const logBox = p.querySelector('[data-role="logs"]');
    logBox.textContent = state.logs.slice(-12).join("\n");
    logBox.scrollTop = logBox.scrollHeight;
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
