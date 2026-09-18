/**
 * 冒烟测试：直接加载 BOSS-Auto-Job-Helper.user.js 的真实逻辑（用最小 DOM 桩），
 * 校验方向预设、关键词匹配、薪资解密、配置迁移等核心纯逻辑。
 *
 * 运行： node test/smoke-test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = path.join(__dirname, "..", "BOSS-Auto-Job-Helper.user.js");
let src = fs.readFileSync(SCRIPT, "utf8");

// 在 init() 之前插一个钩子，把内部函数暴露给测试
const HOOK = `  if (typeof __HOOK__ === "function") {
    __HOOK__({ PRESETS, DEFAULT_SETTINGS, DEFAULT_PRESET_KEY, COMMON_EXCLUDE, sanitizeSettings,
      checkCardQuickFilter, checkDetailKeywords, buildMatchers, parseKeywords, findMatch,
      decodeBossSalary, parseSalaryMinK, renderGreeting, saveSettings, state });
  }
  init();`;
if (!src.includes("\n  init();")) {
  console.error("注入测试钩子失败：未找到 init() 调用");
  process.exit(1);
}
src = src.replace("\n  init();", "\n" + HOOK);

// ---- 最小运行环境桩 ----
const store = new Map();
const noop = () => {};
const stubEl = () => ({
  style: {}, classList: { toggle: noop, add: noop, remove: noop },
  setAttribute: noop, getAttribute: () => null, addEventListener: noop,
  appendChild: noop, removeChild: noop, remove: noop, querySelector: () => null,
  querySelectorAll: () => [], focus: noop, select: noop, contains: () => false
});

const sandbox = {
  console,
  location: { hostname: "example.com", pathname: "/", href: "" },
  document: {
    getElementById: () => null,
    createElement: stubEl,
    addEventListener: noop,
    querySelector: () => null,
    querySelectorAll: () => [],
    head: { appendChild: noop },
    body: { appendChild: noop, innerText: "" },
    readyState: "complete"
  },
  localStorage: {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v)
  },
  setTimeout, clearTimeout, Math, Date, JSON, Number, String, Array, Object, Set, Boolean, RegExp, Error,
  navigator: { clipboard: null },
  alert: noop, confirm: () => true
};
sandbox.window = sandbox;
sandbox.self = sandbox;
sandbox.top = sandbox;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.innerWidth = 1280;
sandbox.window.innerHeight = 800;
sandbox.window.addEventListener = noop;
sandbox.window.getComputedStyle = () => ({ display: "block", visibility: "visible", opacity: "1", overflowY: "auto", pointerEvents: "auto" });
sandbox.globalThis = sandbox;

const hook = {};
sandbox.__HOOK__ = d => Object.assign(hook, d);

vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "BOSS-Auto-Job-Helper.user.js" });

// ---- 断言工具 ----
let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra !== undefined ? "  →  实际: " + JSON.stringify(extra) : ""}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), actual);
}

// ---- 1. 预设库结构完整性 ----
const PRESETS = hook.PRESETS;
ok("预设库已导出", !!PRESETS);
ok("预设数量 >= 12", Object.keys(PRESETS).length >= 12, Object.keys(PRESETS).length);
ok("默认预设存在", !!PRESETS[hook.DEFAULT_PRESET_KEY], hook.DEFAULT_PRESET_KEY);
for (const [key, p] of Object.entries(PRESETS)) {
  ok(`预设 ${key} 有名称`, typeof p.name === "string" && p.name.length > 0);
  ok(`预设 ${key} 有招呼语`, typeof p.greetingText === "string" && p.greetingText.length > 0);
  ok(`预设 ${key} 有排除词`, typeof p.excludeKeywords === "string" && p.excludeKeywords.length > 0);
  ok(`预设 ${key} 最低薪资为数字`, typeof p.minSalaryK === "number");
  ok(`预设 ${key} 关键词可解析`, Array.isArray(hook.parseKeywords(p.includeKeywords)));
}
ok("已无生物医药专属的旧预设键", !PRESETS.bioinfo_ai);

// ---- 2. 默认配置 ----
eq("默认最低薪资取自默认预设", hook.DEFAULT_SETTINGS.minSalaryK, PRESETS[hook.DEFAULT_PRESET_KEY].minSalaryK);
eq("默认关键词取自默认预设", hook.DEFAULT_SETTINGS.includeKeywords, PRESETS[hook.DEFAULT_PRESET_KEY].includeKeywords);

// ---- 3. 配置迁移：升级版本绝不能覆盖用户配置 ----
const migrated = hook.sanitizeSettings({ version: "v1.4.0", includeKeywords: "蛋白纯化, 抗体", excludeKeywords: "销售", greetingText: "你好", minSalaryK: 9 });
eq("升级不覆盖用户关键词", migrated.includeKeywords, "蛋白纯化, 抗体");
eq("升级不覆盖用户排除词", migrated.excludeKeywords, "销售");
eq("升级不覆盖用户招呼语", migrated.greetingText, "你好");
eq("升级不覆盖用户薪资门槛", migrated.minSalaryK, 9);
eq("升级后写入新版本号", migrated.version, hook.DEFAULT_SETTINGS.version);

const fresh = hook.sanitizeSettings(null);
eq("全新安装使用默认预设关键词", fresh.includeKeywords, PRESETS[hook.DEFAULT_PRESET_KEY].includeKeywords);
eq("全新安装预设键正确", fresh.presetKey, hook.DEFAULT_PRESET_KEY);

const emptied = hook.sanitizeSettings({ includeKeywords: "", excludeKeywords: "销售" });
eq("用户主动清空关键词不会被回填", emptied.includeKeywords, "");

const clamped = hook.sanitizeSettings({ intervalMin: 5, intervalMax: 3 });
eq("间隔下限被钳位到 20 秒", clamped.intervalMin, 20);
eq("最大值不低于最小值", clamped.intervalMax, 20);

const badPreset = hook.sanitizeSettings({ presetKey: "不存在的预设" });
eq("非法预设键回落到默认预设", badPreset.presetKey, hook.DEFAULT_PRESET_KEY);

// ---- 4. 关键词匹配规则（英文短词整词匹配，中文子串匹配）----
const m = hook.buildMatchers(hook.parseKeywords("AI, QA, Java, 后端, C++"));
eq("AI 不误命中 email", hook.findMatch("email marketing", m), null);
eq("AI 命中 ai工程师", hook.findMatch("ai工程师", m), "AI");
eq("Java 不误命中 javascript", hook.findMatch("javascript 开发", m), null);
eq("Java 命中 java开发", hook.findMatch("java开发", m), "Java");
eq("C++ 可命中", hook.findMatch("熟悉 c++ 编程", m), "C++");
eq("中文按子串命中", hook.findMatch("高级后端开发", m), "后端");

// ---- 5. 卡片初筛 ----
function applyPreset(key) {
  const p = PRESETS[key];
  hook.saveSettings({ presetKey: key, includeKeywords: p.includeKeywords, excludeKeywords: p.excludeKeywords, greetingText: p.greetingText, minSalaryK: p.minSalaryK });
}

applyPreset("tech");
eq("互联网预设命中 Java 岗位", hook.checkCardQuickFilter("Java开发工程师", "某科技公司", []).pass, true);
eq("互联网预设跳过电话销售", hook.checkCardQuickFilter("电话销售", "某公司", []).pass, false);
eq("互联网预设跳过生物研发岗", hook.checkCardQuickFilter("蛋白纯化研究员", "某生物", []).pass, false);

applyPreset("bio_rd");
eq("生物预设命中蛋白纯化岗", hook.checkCardQuickFilter("蛋白纯化研究员", "某生物", []).pass, true);
eq("生物预设跳过销售岗", hook.checkCardQuickFilter("生物试剂销售", "某公司", []).pass, false);

applyPreset("sales_mkt");
eq("销售预设命中大客户销售", hook.checkCardQuickFilter("大客户销售", "某公司", []).pass, true);
eq("销售预设跳过催收岗", hook.checkCardQuickFilter("催收专员", "某公司", []).pass, false);

applyPreset("general");
eq("通用预设不限定方向（研发岗通过）", hook.checkCardQuickFilter("蛋白纯化研究员", "某生物", []).pass, true);
eq("通用预设不限定方向（运营岗通过）", hook.checkCardQuickFilter("新媒体运营", "某公司", []).pass, true);
eq("通用预设仍受排除词约束", hook.checkCardQuickFilter("电话销售", "某公司", []).pass, false);

applyPreset("general");
eq("包含关键词留空时不按方向筛选", hook.checkCardQuickFilter("任意奇怪岗位名", "某公司", []).pass, true);

// 详情深筛
applyPreset("tech");
eq("详情命中包含词通过", hook.checkDetailKeywords("岗位职责：负责后端服务开发，熟悉 Java").pass, true);
eq("详情未命中包含词被拦截", hook.checkDetailKeywords("岗位职责：负责仓库货物搬运").pass, false);

// ---- 6. 薪资字体解密与解析 ----
const pua = code => String.fromCodePoint(0xe031 + code);
eq("PUA 码点解密为数字", hook.decodeBossSalary(`${pua(1)}${pua(2)}-${pua(2)}${pua(0)}K`), "12-20K");
eq("普通文本原样返回", hook.decodeBossSalary("8-13K"), "8-13K");
eq("K 区间取下限", hook.parseSalaryMinK("8-13K"), 8);
eq("K 区间带薪数", hook.parseSalaryMinK("15-20K·14薪"), 15);
eq("万区间换算成 K", hook.parseSalaryMinK("1-2万"), 10);
eq("元区间换算成 K", hook.parseSalaryMinK("5000-8000元"), 5);
eq("无单位四位数按元", hook.parseSalaryMinK("6000-9000"), 6);
eq("面议返回 null", hook.parseSalaryMinK("面议"), null);
eq("日薪返回 null", hook.parseSalaryMinK("200-300元/天"), null);
// 带“年”才按年薪折算成月薪；不带“年”的“万”按原语义视为月薪万
eq("年薪换算成月 K", hook.parseSalaryMinK("18-24万/年"), 15);
eq("带年薪字样但数字在后不识别", hook.parseSalaryMinK("年薪18-24万"), null);
eq("不带年的万按月度万处理", hook.parseSalaryMinK("18-24万"), 180);
eq("加密薪资也能解析", hook.parseSalaryMinK(`${pua(8)}-${pua(1)}${pua(3)}K`), 8);

// ---- 7. 招呼语占位符 ----
hook.state.currentCompany = "某某科技有限公司";
hook.state.currentTitle = "后端开发工程师";
eq("{title} 占位符被替换", hook.renderGreeting("应聘{title}"), "应聘后端开发工程师");
eq("{company} 占位符被替换", hook.renderGreeting("你好{company}"), "你好某某科技有限公司");
eq("中文占位符也可用", hook.renderGreeting("{公司}-{岗位}"), "某某科技有限公司-后端开发工程师");
eq("空招呼语返回空串", hook.renderGreeting(""), "");

// ---- 8. 每个预设实际跑一遍过滤，确认不抛异常 ----
for (const key of Object.keys(PRESETS)) {
  let crashed = false;
  try {
    applyPreset(key);
    hook.checkCardQuickFilter("后端开发工程师", "某公司", ["五险一金"]);
    hook.checkCardQuickFilter("销售专员", "某公司", []);
    hook.checkDetailKeywords("岗位职责：负责相关工作，要求本科以上学历");
  } catch (e) {
    crashed = true;
    failures.push(`预设 ${key} 执行过滤时抛异常: ${e.message}`);
  }
  ok(`预设 ${key} 过滤流程无异常`, !crashed);
}

// ---- 输出 ----
console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log("\n失败明细：");
  failures.forEach(f => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("✅ 全部通过");
