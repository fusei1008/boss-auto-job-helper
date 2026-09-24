/**
 * 冒烟测试：直接加载 BOSS-Auto-Job-Helper.user.js 核心纯逻辑
 * 校验方向预设、关键词匹配、薪资解密、招呼语占位符、经验标签等。
 *
 * 运行：node test/smoke-test.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SCRIPT = path.join(__dirname, "..", "BOSS-Auto-Job-Helper.user.js");
let src = fs.readFileSync(SCRIPT, "utf8");

const HOOK = `  if (typeof __HOOK__ === "function") {
    __HOOK__({ PRESETS, DEFAULT_SETTINGS, sanitizeSettings,
      checkCardQuickFilter, checkDetailKeywords, buildMatchers, parseKeywords, findMatch,
      decodeBossSalary, parseSalaryMinK, saveSettings, state, parseExpMinYears, rebuildKeywordCache });
  }
  init();`;
if (!src.includes("\n  init();")) {
  console.error("注入测试钩子失败：未找到 init() 调用");
  process.exit(1);
}
src = src.replace("\n  init();", "\n" + HOOK);

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

let pass = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  failures.push(`${name}${extra !== undefined ? "  →  实际: " + JSON.stringify(extra) : ""}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), actual);
}

// 1. 预设库结构
const PRESETS = hook.PRESETS;
ok("预设库已导出", !!PRESETS);
ok("预设包含 bio_rd", !!PRESETS.bio_rd);
for (const [key, p] of Object.entries(PRESETS)) {
  ok(`预设 ${key} 有名称`, typeof p.name === "string" && p.name.length > 0);
  ok(`预设 ${key} 有招呼语`, typeof p.greetingText === "string" && p.greetingText.length > 0);
  ok(`预设 ${key} 有排除词`, typeof p.excludeKeywords === "string" && p.excludeKeywords.length > 0);
  ok(`预设 ${key} 最低薪资为数字`, typeof p.minSalaryK === "number");
}

// 2. 薪资字体解密与解析
const pua = code => String.fromCodePoint(0xe031 + code);
eq("PUA 码点解密为数字", hook.decodeBossSalary(`${pua(1)}${pua(2)}-${pua(2)}${pua(0)}K`), "12-20K");
eq("普通文本原样返回", hook.decodeBossSalary("8-13K"), "8-13K");
eq("K 区间取下限", hook.parseSalaryMinK("8-13K"), 8);
eq("K 区间带薪数", hook.parseSalaryMinK("15-20K·14薪"), 15);
eq("万区间换算成 K", hook.parseSalaryMinK("1-2万"), 10);
eq("元区间换算成 K", hook.parseSalaryMinK("5000-8000元"), 5);
eq("面议返回 null", hook.parseSalaryMinK("面议"), null);
eq("日薪返回 null", hook.parseSalaryMinK("200-300元/天"), null);
eq("年薪换算成月 K", hook.parseSalaryMinK("18-24万/年"), 15);

// 3. 经验年限解析
eq("经验不限为 0", hook.parseExpMinYears(["经验不限"]), 0);
eq("在校应届为 0", hook.parseExpMinYears(["在校/应届"]), 0);
eq("1-3年为 1", hook.parseExpMinYears(["1-3年"]), 1);
eq("3-5年为 3", hook.parseExpMinYears(["3-5年"]), 3);
eq("5年以上为 5", hook.parseExpMinYears(["5年以上"]), 5);

// 4. 详情关键词核验
hook.state.settings.includeKeywords = "分子生物, 蛋白纯化";
hook.state.settings.excludeKeywords = "销售, 电销, 提成";
hook.rebuildKeywordCache();
eq("包含目标词通过", hook.checkDetailKeywords("分子生物学背景，精通蛋白纯化").pass, true);
eq("命中排除词拦截", hook.checkDetailKeywords("负责区域销售指标达成，底薪加提成").pass, false);

// 5. 关键词匹配规则
const m = hook.buildMatchers(hook.parseKeywords("AI, QA, Python, 蛋白纯化, 分子生物"));
eq("AI 不误命中 email", hook.findMatch("email marketing", m), null);
eq("AI 命中 ai工程师", hook.findMatch("ai工程师", m), "AI");
eq("Python 命中 python开发", hook.findMatch("python开发", m), "Python");
eq("中文按子串命中", hook.findMatch("重组蛋白纯化研究员", m), "蛋白纯化");

console.log(`\n通过 ${pass} 项，失败 ${failures.length} 项`);
if (failures.length) {
  console.log("\n失败明细：");
  failures.forEach(f => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("✅ 全部通过");
