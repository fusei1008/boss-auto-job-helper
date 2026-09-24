/**
 * 单元与集成测试：加载真实 userscript，用官方文档格式的模拟响应检验 Jev 决策与故障处理
 * 运行：node test/verify.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const scriptPath = path.join(__dirname, "..", "BOSS-Auto-Job-Helper.user.js");
let src = fs.readFileSync(scriptPath, "utf8");
src = src.replace("\n  init();", `
  __HOOK__({ state, sanitizeSettings, interpretJevAnswers, readJevAnswers, evaluateJobWithJev,
    parseExpMinYears, checkCardQuickFilter, JEV_QUESTIONS, loadJevDecisions, recordJevDecision, rebuildKeywordCache });
  init();`);

const store = new Map();
let xhrQueue = [];
const sent = [];
const noop = () => {};
const el = () => ({ style: {}, classList: { toggle: noop }, setAttribute: noop, getAttribute: () => null,
  addEventListener: noop, appendChild: noop, remove: noop, querySelector: () => null, querySelectorAll: () => [] });
const sandbox = {
  console, Math, Date, JSON, Number, String, Array, Object, Set, Boolean, RegExp, Error, Promise,
  setTimeout: fn => setTimeout(fn, 0), clearTimeout,
  location: { hostname: "example.com", pathname: "/" },
  document: { getElementById: () => null, createElement: el, addEventListener: noop, querySelector: () => null,
    querySelectorAll: () => [], head: { appendChild: noop }, body: { appendChild: noop, innerText: "" }, readyState: "complete" },
  GM_getValue: (k, d) => (store.has(k) ? store.get(k) : d),
  GM_setValue: (k, v) => store.set(k, v),
  GM_registerMenuCommand: noop, GM_notification: noop,
  GM_xmlhttpRequest: opts => {
    sent.push(opts);
    const r = xhrQueue.shift();
    setTimeout(() => (r === "timeout" ? opts.ontimeout() : opts.onload(r)), 0);
  },
  alert: noop, confirm: () => true
};
sandbox.window = sandbox;
sandbox.window.top = sandbox.window.self = sandbox;
let api;
sandbox.__HOOK__ = x => (api = x);

// 旧版设置：带 jevOnlySAndA 和用户自定义关键词，升级后关键词不能被重置
store.set("bossAutoHelper.settings", { version: "v1.5.0", includeKeywords: "我的自定义词", jevOnlySAndA: true, jevApiKey: "sk-or-test" });
vm.runInNewContext(src, sandbox);
assert(api, "脚本加载失败");

let pass = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  ✓", name); });

const ans = (fit, depth, t = {}) => ({
  fit: { type: "score", score: fit.score, probabilities: fit.p, confidence: 0.9, legend: {} },
  depth: { type: "score", score: depth, probabilities: {}, confidence: 0.9, legend: {} },
  dispatch: { type: "noul", noul: t.dispatch ?? 0.02 },
  paid_training: { type: "noul", noul: t.paid_training ?? 0.01 },
  sales_in_disguise: { type: "noul", noul: t.sales ?? 0.03 },
  excluded: { type: "noul", noul: t.excluded ?? 0.04 }
});
const direct = { score: 2.9, p: { 0: 0, 1: 0, 2: 0.1, 3: 0.9 } };
const adjacent = { score: 2.0, p: { 0: 0, 1: 0.05, 2: 0.9, 3: 0.05 } };
const unrelated = { score: 0.2, p: { 0: 0.8, 1: 0.2, 2: 0, 3: 0 } };
const unsure = { score: 1.5, p: { 0: 0.1, 1: 0.4, 2: 0.4, 3: 0.1 } };
const decide = a => api.interpretJevAnswers(api.readJevAnswers(a));
const ok200 = body => ({ status: 200, responseText: JSON.stringify(body) });

(async () => {
  console.log("设置迁移");
  await ok("旧开关 jevOnlySAndA 被移除、自定义关键词保留、新项取默认值", () => {
    const s = api.state.settings;
    assert.strictEqual(s.jevOnlySAndA, undefined);
    assert.strictEqual(s.includeKeywords, "我的自定义词");
    assert.strictEqual(s.jevMinTier, "A");
    assert.strictEqual(s.jevDryRun, false);
    assert.strictEqual(s.maxExpYears, 3);
    assert.strictEqual(s.skipPhdJobs, true);
    assert.strictEqual(api.sanitizeSettings({ jevMinTier: "X" }).jevMinTier, "A");
  });

  console.log("问题定义符合官方 API 约束");
  await ok("类型合法、score 2~10 级、noul criteria 只有 true/false、指令为英文", () => {
    for (const [id, q] of Object.entries(api.JEV_QUESTIONS)) {
      assert(["noul", "choice", "score"].includes(q.type), id);
      assert(/^[\x20-\x7e]+$/.test(q.instructions), `${id} 指令应为英文`);
      if (q.type === "score") assert(q.criteria.length >= 2 && q.criteria.length <= 10, id);
      if (q.type === "noul" && q.criteria) assert.deepStrictEqual(Object.keys(q.criteria).sort(), ["false", "true"], id);
    }
  });

  console.log("决策分流");
  await ok("直接对口 + 深度高 → S 级投递", () => { const v = decide(ans(direct, 1.7)); assert.strictEqual(v.verdict, "apply"); assert.strictEqual(v.tier, "S"); });
  await ok("直接对口 + 深度一般 → A 级投递", () => { const v = decide(ans(direct, 1.2)); assert.strictEqual(v.verdict, "apply"); assert.strictEqual(v.tier, "A"); });
  await ok("相近可转 → B 级，默认只记备选不投", () => { const v = decide(ans(adjacent, 1.3)); assert.strictEqual(v.tier, "B"); assert.strictEqual(v.verdict, "hold"); });
  await ok("派遣概率 85% → 拒", () => assert.strictEqual(decide(ans(direct, 1.6, { dispatch: 0.85 })).verdict, "reject"));
  await ok("派遣概率 50% → 待复核（不投不拒）", () => assert.strictEqual(decide(ans(direct, 1.6, { dispatch: 0.5 })).verdict, "review"));
  await ok("专业无关 → 拒（即使陷阱也拿不准，先拒）", () => assert.strictEqual(decide(ans(unrelated, 1.6, { sales: 0.5 })).verdict, "reject"));
  await ok("对口拿不准 → 待复核", () => assert.strictEqual(decide(ans(unsure, 1.6)).verdict, "review"));
  await ok("深度 0.6 低于门槛 1.0 → 拒", () => assert.strictEqual(decide(ans(direct, 0.6)).verdict, "reject"));
  await ok("响应缺字段 → 报错而不是默认值", () => { const a = ans(direct, 1.5); delete a.excluded; assert.throws(() => api.readJevAnswers(a)); });
  await ok("最低等级改成 B 后，B 级也投", () => {
    api.state.settings.jevMinTier = "B";
    assert.strictEqual(decide(ans(adjacent, 1.3)).verdict, "apply");
    api.state.settings.jevMinTier = "A";
  });

  console.log("网络与故障（绝不放行）");
  const job = { title: "蛋白纯化研究员", company: "某生物" };
  await ok("OpenRouter Key → decisions 端点 + 钉死 typesafe/jev-1.13，只发纯 JD", async () => {
    xhrQueue = [ok200({ model: "typesafe/jev-1.13-20260917", answers: ans(direct, 1.7), usage: { input_tokens: 3000, cost: 0.000126 } })];
    const v = await api.evaluateJobWithJev(job, "负责重组蛋白表达纯化");
    const req = sent[sent.length - 1], body = JSON.parse(req.data);
    assert.strictEqual(req.url, "https://openrouter.ai/api/alpha/decisions");
    assert.strictEqual(body.model, "typesafe/jev-1.13");
    assert.strictEqual(body.state.job.description, "负责重组蛋白表达纯化");
    assert.deepStrictEqual(Object.keys(body.state.job).sort(), ["company", "description", "title"]);
    assert.strictEqual(v.verdict, "apply");
    assert.strictEqual(v.costUsd, 0.000126);
  });
  await ok("TypeSafe 直连 Key → systemone 端点 + 钉死 jev-1.13.0", async () => {
    api.state.settings.jevApiKey = "ts-test";
    xhrQueue = [ok200({ model: "jev-1.13.0", answers: ans(direct, 1.7), usage: { input_tokens: 1000 } })];
    const v = await api.evaluateJobWithJev(job, "x");
    const req = sent[sent.length - 1];
    assert.strictEqual(req.url, "https://api.typesafe.ai/v1/systemone");
    assert.strictEqual(JSON.parse(req.data).model, "jev-1.13.0");
    assert(Math.abs(v.costUsd - 0.000042) < 1e-12);
    api.state.settings.jevApiKey = "sk-or-test";
  });
  await ok("402 余额不足 → failed + fatal，不重试", async () => {
    const n = sent.length;
    xhrQueue = [{ status: 402, responseText: JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }) }];
    const v = await api.evaluateJobWithJev(job, "x");
    assert(v.failed && v.fatal && /402/.test(v.reason));
    assert.strictEqual(sent.length - n, 1);
  });
  await ok("429 → 自动退避重试后成功", async () => {
    xhrQueue = [{ status: 429, responseText: "{}" }, ok200({ answers: ans(direct, 1.2) })];
    const v = await api.evaluateJobWithJev(job, "x");
    assert.strictEqual(v.verdict, "apply");
  });
  await ok("连续超时 3 次 → failed（非 fatal，由调用方累计后暂停）", async () => {
    xhrQueue = ["timeout", "timeout", "timeout"];
    const v = await api.evaluateJobWithJev(job, "x");
    assert(v.failed && !v.fatal);
  });
  await ok("200 但缺 fit.probabilities → failed，不会被当成通过", async () => {
    const a = ans(direct, 1.5); delete a.fit.probabilities;
    xhrQueue = [ok200({ answers: a })];
    assert((await api.evaluateJobWithJev(job, "x")).failed);
  });

  console.log("代码侧规则");
  await ok("经验标签解析", () => {
    const f = api.parseExpMinYears;
    assert.strictEqual(f(["1-3年", "硕士"]), 1); assert.strictEqual(f(["3-5年"]), 3); assert.strictEqual(f(["10年以上"]), 10);
    assert.strictEqual(f(["经验不限"]), 0); assert.strictEqual(f(["在校/应届"]), 0); assert.strictEqual(f(["1年以内"]), 0);
    assert.strictEqual(f(["上海", "本科"]), null);
  });
  api.state.settings.includeKeywords = "蛋白纯化, 重组蛋白";
  api.state.settings.excludeKeywords = "销售, 电销, 客服";
  api.rebuildKeywordCache();
  await ok("『高级研究员』：纯规则模式跳过，Jev 模式放行给 Jev 判；标题带销售仍硬排除", () => {
    assert.strictEqual(api.checkCardQuickFilter("高级研究员", "某生物", ["1-3年"], false).pass, false);
    assert.strictEqual(api.checkCardQuickFilter("高级研究员", "某生物", ["1-3年"], true).pass, true);
    assert.strictEqual(api.checkCardQuickFilter("医药销售代表", "某生物", [], true).pass, false);
  });
  await ok("决策记录落盘且带全部分数", () => {
    const v = decide(ans(direct, 1.7));
    api.recordJevDecision({ key: "k1", url: "u", company: "c", title: "t", salary: "10-15K" }, { ...v, model: "m", costUsd: 0.0001 }, true);
    const d = api.loadJevDecisions().pop();
    assert.strictEqual(d.verdict, "apply"); assert.strictEqual(d.dryRun, true);
    assert.deepStrictEqual(Object.keys(d.traps).sort(), ["dispatch", "excluded", "paid_training", "sales_in_disguise"]);
  });

  console.log(`\n全部通过：${pass} 项`);
})().catch(e => { console.error("\n✗ 失败：", e && e.message ? e.message : e); process.exit(1); });
