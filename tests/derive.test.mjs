/**
 * 纯函数单测 + apply 冒烟测试:相对时间分桶、状态归并、栏内行推导与排序,
 * 以及"插件主体在桩上下文里能跑通并注册两个座位条目"。
 *
 * lib/client.js 是浏览器 bundle(顶层调用 window.__ModuleLoader__.load),
 * 这里先注入 window 桩与 react 桩,再动态 import 取 factory 的返回值,
 * 通过 __test 导出直接测纯逻辑(不渲染任何组件);apply 用假 ctx 走一遍注册路径,
 * 这样"刷新页面才发现 apply 抛错"的坑能在本地先拦住。
 *
 * 运行:node tests/derive.test.mjs
 */
const CLIENT_PATH = new URL("../lib/client.js", import.meta.url);

// ── 加载 bundle 定义 ────────────────────────────────────────────────
let definition;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { definition = def; },
  },
};
// railExists() 会读 document(平台标记);给个"普通浏览器"桩,让渲染路径能跑通。
globalThis.document = {
  documentElement: { dataset: {}, hasAttribute: () => false },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, remove() {} }),
  head: { appendChild() {} },
};
await import(CLIENT_PATH.href);

/** React 桩:useEffect 立即执行回调(模拟挂载)但**不**执行清理函数(否则探针一挂载就把折叠态清回未知)。 */
const reactStub = {
  useState(value) { return [value, () => {}]; },
  useEffect(effect) { effect(); },
  useRef(value) { return { current: value }; },
  useMemo(factory) { return factory(); },
  createElement(type, props, children) {
    const element = { type, props: props ?? {}, children: children === undefined ? [] : (Array.isArray(children) ? children : [children]) };
    // 函数组件就地展开(桩里没有 Fiber,直接调用即可;所有 hook 桩都是无状态的)。
    return typeof type === "function" ? type(element.props) : element;
  },
};

/** 深度遍历 createElement 造出的假树。 */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  visit(node);
  walk(node.children, visit);
}

function loadModule() {
  if (definition === undefined) throw new Error("client.js 未通过 window.__ModuleLoader__.load 注册定义");
  return definition.factory((spec) => {
    if (spec === "react") return reactStub;
    throw new Error("未预期的 require: " + spec);
  });
}

// ── 断言辅助 ────────────────────────────────────────────────────────
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (error) {
    results.push({ name, ok: false, error });
  }
}
function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error((label ?? "值") + " 期望 " + String(expected) + ",实际 " + String(actual));
  }
}
function deepEqual(actual, expected, label) {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) {
    throw new Error((label ?? "值") + " 期望 " + right + ",实际 " + left);
  }
}

// ── 取被测函数 ──────────────────────────────────────────────────────
const mod = loadModule();
/** 词典命名空间(与 client.js 的 NS 常量对齐;改一处必须同步另一处)。 */
const NS_EXPECTED = "sessionRail";
const T = mod.__test;
if (T === undefined) throw new Error("缺少 __test 导出");
for (const name of ["relativeTime", "railStateOf", "pendingKindOf", "indexWorkspaceTitles", "deriveRows", "compareRows", "timeAgo", "stateLabel", "template", "CSS"]) {
  if (T[name] === undefined) throw new Error("缺少 __test." + name);
}

// ── 造数据 ──────────────────────────────────────────────────────────
const NOW = 1_800_000_000_000; // 固定"现在",让时间断言不依赖运行时刻

/** 造一行会话摘要;subagent 行必须显式给 origin。 */
function summary(id, overrides = {}) {
  return {
    id,
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: NOW,
    retainedBy: {},
    ...overrides,
  };
}
/** 造一份会话列表快照(ids 与 byId 同源)。 */
function listOf(...rows) {
  const byId = {};
  const ids = [];
  for (const row of rows) {
    byId[row.id] = row;
    ids.push(row.id);
  }
  return { ids, byId, phase: "ready", projectionsBySession: {} };
}
/** 造一份状态快照(Map 形态,契约形状)。 */
function statusesOf(entries) {
  return new Map(Object.entries(entries));
}

// ══ relativeTime ════════════════════════════════════════════════════
test("relativeTime:各档阈值与 ui-primitives 一致", () => {
  deepEqual(T.relativeTime(NOW, NOW), { unit: "now", n: 0 }, "同一时刻");
  deepEqual(T.relativeTime(NOW - 59_999, NOW), { unit: "now", n: 0 }, "59.999 秒");
  deepEqual(T.relativeTime(NOW - 60_000, NOW), { unit: "minutes", n: 1 }, "整 1 分钟");
  deepEqual(T.relativeTime(NOW - 3_599_999, NOW), { unit: "minutes", n: 59 }, "不到 1 小时");
  deepEqual(T.relativeTime(NOW - 3_600_000, NOW), { unit: "hours", n: 1 }, "整 1 小时");
  deepEqual(T.relativeTime(NOW - 86_400_000, NOW), { unit: "days", n: 1 }, "整 1 天");
  deepEqual(T.relativeTime(NOW - 29 * 86_400_000, NOW), { unit: "days", n: 29 }, "不到 30 天");
  deepEqual(T.relativeTime(NOW - 30 * 86_400_000, NOW), { unit: "months", n: 1 }, "整 30 天");
  deepEqual(T.relativeTime(NOW - 364 * 86_400_000, NOW), { unit: "months", n: 12 }, "不到 1 年");
  deepEqual(T.relativeTime(NOW - 365 * 86_400_000, NOW), { unit: "years", n: 1 }, "整 1 年");
});

test("relativeTime:未来时刻夹到 now(不出现负时长)", () => {
  deepEqual(T.relativeTime(NOW + 10_000, NOW), { unit: "now", n: 0 });
});

// ══ pendingKindOf / railStateOf ═════════════════════════════════════
test("pendingKindOf:白名单三种命中,其余(含未知种类)按无阻塞", () => {
  equal(T.pendingKindOf({ pendingInteraction: { kind: "approval" } }), "approval");
  equal(T.pendingKindOf({ pendingInteraction: { kind: "plan-review" } }), "plan-review");
  equal(T.pendingKindOf({ pendingInteraction: { kind: "question" } }), "question");
  equal(T.pendingKindOf({ pendingInteraction: { kind: "future-kind" } }), undefined);
  equal(T.pendingKindOf({}), undefined);
  equal(T.pendingKindOf(undefined), undefined);
  equal(T.pendingKindOf(null), undefined);
});

test("railStateOf:阻塞 > 自己运行 > 子代理运行 > 已完成未读 > 空闲(与侧边栏状态点同口径)", () => {
  equal(T.railStateOf({ pendingInteraction: { kind: "approval" }, completionUnread: true, running: true }, false, 3), "blocked");
  equal(T.railStateOf({ completionUnread: true, running: true }, false, 0), "running", "又跑起来了就不是已完成");
  equal(T.railStateOf({ completionUnread: true, running: false }, false, 2), "running", "子代理在跑压过未读完成");
  equal(T.railStateOf({ completionUnread: true, running: false }, false, 0), "done");
  equal(T.railStateOf({ running: true, completionUnread: false }, false, 0), "running");
  equal(T.railStateOf({ running: false, completionUnread: false }, true, 0), undefined, "快照 running=false 压过摘要 true");
  equal(T.railStateOf({ completionUnread: false }, false, 0), undefined);
});

test("railStateOf:只有子代理在跑的会话算运行中(需求:也要显示)", () => {
  equal(T.railStateOf({ running: false, completionUnread: false }, false, 1), "running");
  equal(T.railStateOf(undefined, undefined, 2), "running");
  equal(T.railStateOf(undefined, undefined, 0), undefined);
});

test("railStateOf:快照没有 running 时退回摘要行(基线未到时仍能出图)", () => {
  equal(T.railStateOf(undefined, true, 0), "running");
  equal(T.railStateOf({}, true, 0), "running");
  equal(T.railStateOf(undefined, false, 0), undefined);
  equal(T.railStateOf(undefined, undefined, 0), undefined);
});

// ══ runningSubagentCount ════════════════════════════════════════════
test("runningSubagentCount:数直接子代理,先看状态快照再看目录行", () => {
  const list = listOf(summary("parent"), summary("child-a", { origin: "subagent" }), summary("child-b", { origin: "subagent", running: true }));
  list.projectionsBySession = {
    parent: { values: { subagentCatalog: [{ id: "child-a" }, { id: "child-b" }] } },
  };
  equal(T.runningSubagentCount(list, new Map(), "parent"), 1, "child-a 无状态无 running,child-b 摘要 running");
  equal(T.runningSubagentCount(list, statusesOf({ "child-a": { running: true } }), "parent"), 2, "快照优先");
  equal(T.runningSubagentCount(list, statusesOf({ "child-b": { running: false } }), "parent"), 0, "快照 running=false 压过摘要 true");
});

test("runningSubagentCount:缺投影/缺清单/畸形输入一律 0", () => {
  const bare = listOf(summary("parent"));
  equal(T.runningSubagentCount(bare, new Map(), "parent"), 0);
  equal(T.runningSubagentCount(undefined, new Map(), "parent"), 0);
  equal(T.runningSubagentCount({ ids: [], byId: {}, projectionsBySession: { parent: {} } }, new Map(), "parent"), 0);
  equal(T.runningSubagentCount({ ids: [], byId: {}, projectionsBySession: { parent: { values: { subagentCatalog: "nope" } } } }, new Map(), "parent"), 0);
  const withNulls = { ids: [], byId: {}, projectionsBySession: { parent: { values: { subagentCatalog: [null, { id: "gone" }] } } } };
  equal(T.runningSubagentCount(withNulls, new Map(), "parent"), 0, "空行与查不到的会话都不计");
});

// ══ indexWorkspaceTitles ════════════════════════════════════════════
test("indexWorkspaceTitles:会话归属先到先得,畸形快照不抛错", () => {
  const titles = T.indexWorkspaceTitles({
    items: [
      { title: "A", sessionIds: ["s1", "s2"] },
      { title: "B", sessionIds: ["s2", "s3"] },
      { title: "C" },
      null,
    ],
  });
  equal(titles.s1, "A");
  equal(titles.s2, "A", "同会话被两个工作区记账时取先出现者");
  equal(titles.s3, "B");
  deepEqual(Object.keys(T.indexWorkspaceTitles(undefined)), []);
  deepEqual(Object.keys(T.indexWorkspaceTitles({ items: "nope" })), []);
});

// ══ deriveRows ══════════════════════════════════════════════════════
test("deriveRows:档位顺序 = 阻塞 → 已完成未读 → 运行中", () => {
  const list = listOf(summary("run"), summary("blk"), summary("done"));
  const statuses = statusesOf({
    run: { running: true, completionUnread: false },
    blk: { running: true, pendingInteraction: { kind: "question" }, completionUnread: false },
    done: { running: false, completionUnread: true },
  });
  const rows = T.deriveRows({ list, statuses });
  deepEqual(rows.map((row) => row.state), ["blocked", "done", "running"]);
  deepEqual(rows.map((row) => row.id), ["blk", "done", "run"]);
});

test("deriveRows:同档按最近更新倒序", () => {
  const list = listOf(
    summary("old", { updatedAt: NOW - 5000 }),
    summary("new", { updatedAt: NOW }),
    summary("mid", { updatedAt: NOW - 1000 }),
  );
  const statuses = statusesOf({
    old: { running: true, completionUnread: false },
    new: { running: true, completionUnread: false },
    mid: { running: true, completionUnread: false },
  });
  deepEqual(T.deriveRows({ list, statuses }).map((row) => row.id), ["new", "mid", "old"]);
});

test("deriveRows:空闲会话不进栏", () => {
  const list = listOf(summary("idle"), summary("run"));
  const statuses = statusesOf({
    idle: { running: false, completionUnread: false },
    run: { running: true, completionUnread: false },
  });
  deepEqual(T.deriveRows({ list, statuses }).map((row) => row.id), ["run"]);
});

test("deriveRows:只有子代理在跑的会话也算运行中并进栏(带子代理数)", () => {
  const list = listOf(
    summary("parent", { running: false }),
    summary("child-1", { origin: "subagent", running: true }),
    summary("child-2", { origin: "subagent", running: false }),
    summary("quiet", { running: false }),
  );
  list.projectionsBySession = {
    parent: { values: { subagentCatalog: [{ id: "child-1" }, { id: "child-2" }] } },
  };
  const statuses = statusesOf({
    parent: { running: false, completionUnread: false },
    quiet: { running: false, completionUnread: false },
  });
  const rows = T.deriveRows({ list, statuses });
  deepEqual(rows.map((row) => row.id), ["parent"], "子代理在跑 ⇒ 进栏;子代理会话自己不列");
  equal(rows[0].state, "running");
  equal(rows[0].subagents, 1, "只数在跑的那个子代理");
});

test("deriveRows:子代理全部停下后,父会话回到空闲不进栏", () => {
  const list = listOf(summary("parent", { running: false }), summary("child", { origin: "subagent", running: false }));
  list.projectionsBySession = { parent: { values: { subagentCatalog: [{ id: "child" }] } } };
  const statuses = statusesOf({ parent: { running: false, completionUnread: false } });
  deepEqual(T.deriveRows({ list, statuses }), []);
});

test("deriveRows:自己也在跑时同样带出子代理数(详情卡要显示)", () => {
  const list = listOf(summary("parent", { running: true }), summary("c1", { origin: "subagent", running: true }), summary("c2", { origin: "subagent", running: true }));
  list.projectionsBySession = { parent: { values: { subagentCatalog: [{ id: "c1" }, { id: "c2" }] } } };
  const statuses = statusesOf({ parent: { running: true, completionUnread: false } });
  const rows = T.deriveRows({ list, statuses });
  equal(rows.length, 1);
  equal(rows[0].state, "running");
  equal(rows[0].subagents, 2);
});

test("deriveRows:没有投影数据时按无子代理处理(不抛错)", () => {
  const list = listOf(summary("parent", { running: false }));
  deepEqual(T.deriveRows({ list, statuses: statusesOf({ parent: { running: false } }) }), []);
});

test("deriveRows:跳过空会话、子代理会话、归档会话", () => {
  const list = listOf(
    summary("blank", { blank: true }),
    summary("child", { origin: "subagent" }),
    summary("archived"),
    summary("keep"),
  );
  const statuses = statusesOf({
    blank: { running: true, completionUnread: false },
    child: { running: true, completionUnread: false },
    archived: { running: true, completionUnread: false },
    keep: { running: true, completionUnread: false },
  });
  deepEqual(T.deriveRows({ list, statuses, archived: ["archived"] }).map((row) => row.id), ["keep"]);
  deepEqual(
    T.deriveRows({ list, statuses }).map((row) => row.id),
    ["archived", "keep"],
    "归档集缺失时不过滤(退化路径)",
  );
});

test("deriveRows:标题空串退回 id,并带上工作区标题与阻塞种类", () => {
  const list = listOf(summary("s1", { displayTitle: "" }), summary("s2", { displayTitle: "标题" }));
  const statuses = statusesOf({
    s1: { running: true, completionUnread: false },
    s2: { running: true, pendingInteraction: { kind: "plan-review" }, completionUnread: false },
  });
  const rows = T.deriveRows({
    list,
    statuses,
    workspaceTitles: { s1: "工作区", s2: "工作区" },
  });
  equal(rows[0].title, "标题");
  equal(rows[0].kind, "plan-review");
  equal(rows[0].workspace, "工作区");
  equal(rows[1].title, "s1", "空标题退回会话 id");
  equal(rows[1].kind, undefined);
});

test("deriveRows:状态快照可为纯对象(形状兼容),缺失时按摘要 running 判定", () => {
  const list = listOf(summary("s1", { running: true }), summary("s2", { running: false }));
  const rows = T.deriveRows({ list, statuses: { s1: { running: true } } });
  deepEqual(rows.map((row) => row.id), ["s1"]);
});

test("deriveRows:空/畸形输入一律返回空数组", () => {
  deepEqual(T.deriveRows({}), []);
  deepEqual(T.deriveRows({ list: null, statuses: null }), []);
  deepEqual(T.deriveRows({ list: { ids: "nope" } }), []);
  deepEqual(T.deriveRows({ list: { ids: ["ghost"], byId: {} } }), [], "ids 指向不存在的行时跳过");
});

test("deriveRows:updatedAt 缺失按 0 处理,不产生 NaN 排序", () => {
  const list = listOf(summary("a", { updatedAt: undefined }), summary("b", { updatedAt: NOW }));
  const statuses = statusesOf({
    a: { running: true },
    b: { running: true },
  });
  deepEqual(T.deriveRows({ list, statuses }).map((row) => row.id), ["b", "a"]);
});

// ══ 文案 ════════════════════════════════════════════════════════════
test("template:占位替换,缺参数保留原样", () => {
  equal(T.template("{n}分钟", { n: 5 }), "5分钟");
  equal(T.template("{a}-{b}", { a: 1 }), "1-{b}");
  equal(T.template("无占位"), "无占位");
});

test("stateLabel / timeAgo:阻塞细分种类,时间走 ago 模板", () => {
  const t = (key, params) => T.template({ "state.approval": "等待审批", "state.running": "进行中", "state.done": "已完成未读", "state.question": "等待回答", "state.planReview": "计划待审", "state.subagents": "{n} 个子智能体运行中", "time.now": "刚刚", "time.minutes": "{n}分钟", "time.ago": "{t}前" }[key] ?? key, params);
  equal(T.stateLabel({ state: "blocked", kind: "approval" }, t), "等待审批");
  equal(T.stateLabel({ state: "blocked", kind: "plan-review" }, t), "计划待审");
  equal(T.stateLabel({ state: "blocked", kind: undefined }, t), "等待回答");
  equal(T.stateLabel({ state: "done" }, t), "已完成未读");
  equal(T.stateLabel({ state: "running" }, t), "进行中");
  equal(T.timeAgo(NOW - 3 * 60_000, NOW, t), "3分钟前");
  equal(T.timeAgo(NOW, NOW, t), "刚刚");
});

test("previewMeta:状态行 = 状态词 [+ N 个子智能体运行中] + 相对时间", () => {
  const t = (key, params) => T.template({ "state.running": "进行中", "state.subagents": "{n} 个子智能体运行中" }[key] ?? key, params);
  equal(T.previewMeta({ state: "running", subagents: 0 }, "3分钟前", t), "进行中 · 3分钟前");
  equal(T.previewMeta({ state: "running", subagents: 2 }, "3分钟前", t), "进行中 · 2 个子智能体运行中 · 3分钟前");
  equal(T.previewMeta({ state: "running" }, "刚刚", t), "进行中 · 刚刚", "没有 subagents 字段时按 0 处理");
});

// ══ 样式纪律 ════════════════════════════════════════════════════════
test("CSS:只用主题令牌,没有写死的颜色", () => {
  const css = T.CSS;
  if (/#[0-9a-fA-F]{3,8}\b/.test(css)) throw new Error("出现写死的十六进制颜色:" + css.match(/#[0-9a-fA-F]{3,8}\b/)[0]);
  if (/\brgba?\(|\bhsla?\(/.test(css)) throw new Error("出现写死的颜色函数");
  for (const token of ["--dsw-alias-state-warn-primary", "--dsw-alias-state-success-primary", "--dsw-alias-state-business-primary", "--dsw-alias-bg-layer-1", "--dsw-radius-lg", "--dsw-elevation-panel"]) {
    if (!css.includes(token)) throw new Error("缺少主题令牌 " + token);
  }
  if (css.includes("--dsw-alias-brand-primary")) {
    throw new Error("--dsw-alias-brand-primary 是品牌墨色(深色主题下是浅灰),不能当强调色用");
  }
});

test("CSS:与右侧索引同构的横条几何(20×2、scaleX(.6)、悬停放大)", () => {
  const css = T.CSS;
  if (!css.includes("width:20px;height:2px")) throw new Error("横条不是 20×2px");
  if (!css.includes("scaleX(.6)")) throw new Error("静止态不是 scaleX(.6)");
  if (!css.includes("scaleX(1)")) throw new Error("悬停/聚焦态没有放大到 scaleX(1)");
  if (!css.includes("prefers-reduced-motion")) throw new Error("缺少降低动效分支");
});

// ══ apply 冒烟 ══════════════════════════════════════════════════════
/** 假 ctx:记录 effect / 座位注册,服务按名返回桩。 */
function fakeContext(options = {}) {
  const effects = [];
  const injections = [];
  const registrations = [];
  const localeDicts = [];
  const ctx = {
    effect(callback, label) {
      const dispose = callback();
      effects.push({ label, dispose });
      return dispose;
    },
    get(name) {
      if (name === "slots") {
        return {
          inject(slot, callback) {
            injections.push(slot);
            return callback();
          },
          register(opts, component) {
            registrations.push({ opts, component });
            return () => {};
          },
        };
      }
      if (name === "uiWorkspace") return options.noWorkspace ? undefined : { openSession: () => {} };
      if (name === "locale") {
        return options.noLocale ? undefined : {
          register(ns, locale, dict) { localeDicts.push({ ns, locale, dict }); return () => {}; },
          bind: () => (key) => key,
        };
      }
      return undefined;
    },
  };
  return { ctx, effects, injections, registrations, localeDicts };
}

test("apply:注册探针与横条栏两个座位条目,不抛错", () => {
  const fake = fakeContext();
  mod.apply(fake.ctx);
  deepEqual(fake.injections, ["sidebar.footer.action", "shell.overlay"]);
  deepEqual(fake.registrations.map((entry) => entry.opts.name), ["sidebar.footer.action", "shell.overlay"]);
  deepEqual(fake.registrations.map((entry) => entry.opts.id), ["session-rail-probe", "session-rail"]);
  equal(fake.registrations[0].opts.order, undefined, "探针不参与排序");
  equal(fake.registrations[1].opts.order, 10);
  equal(typeof fake.registrations[1].opts.inject, "function", "横条栏的业务面走 inject 工厂");
  equal(fake.registrations[1].opts.locale, NS_EXPECTED, "声明 locale 以拿到框架合成的 t 座位");
  deepEqual(fake.localeDicts.map((entry) => entry.locale), ["zh", "en"]);
  equal(typeof fake.registrations[1].component, "function");
  equal(typeof fake.registrations[0].component, "function");
});

test("apply:inject 声明三个硬依赖(少声明会提前执行而静默不注册)", () => {
  deepEqual(mod.inject, ["slots", "uiWorkspace", "locale"]);
});

test("apply:缺 uiWorkspace 时不注册(不能跳转就不出图)", () => {
  const fake = fakeContext({ noWorkspace: true });
  mod.apply(fake.ctx);
  deepEqual(fake.registrations, []);
});

test("apply:缺 locale 服务时仍注册,只是不带 t 座位", () => {
  const fake = fakeContext({ noLocale: true });
  mod.apply(fake.ctx);
  deepEqual(fake.registrations.map((entry) => entry.opts.name), ["sidebar.footer.action", "shell.overlay"]);
  equal(fake.registrations[1].opts.locale, undefined);
  deepEqual(fake.localeDicts, []);
});

test("apply:effect 带标签注册清理(样式/词典/两个座位)", () => {
  const fake = fakeContext();
  mod.apply(fake.ctx);
  const labels = fake.effects.map((entry) => entry.label);
  if (!labels.includes("session-rail: styles")) throw new Error("缺样式清理:" + labels.join(","));
  if (!labels.includes("session-rail: dictionaries")) throw new Error("缺词典清理");
  if (!labels.includes("session-rail: collapse probe")) throw new Error("缺探针清理");
  if (!labels.includes("session-rail: rail overlay")) throw new Error("缺横条栏清理");
});

test("组件入口:标准 props 缺失时不抛错、不渲染", () => {
  const entry = fakeContext();
  mod.apply(entry.ctx);
  const overlay = entry.registrations.find((row) => row.opts.name === "shell.overlay");
  equal(overlay.component({}), null, "缺 useSessions/useSessionStatus 时返回 null");
  const probe = entry.registrations.find((row) => row.opts.name === "sidebar.footer.action");
  equal(probe.component({ wide: true }), null, "探针永不渲染");
});

// ══ 渲染层:横条的鼠标契约 ══════════════════════════════════════════
/**
 * 让探针先发布"已收起",再用假标准 props 渲染横条栏,返回 createElement 假树里的所有 button。
 * 每次都用**新模块实例**(factory 每次调用都是新闭包),这样折叠态从"未知"开始、不受别的用例影响。
 */
function renderMarks(options = {}) {
  const instance = loadModule();
  const entry = fakeContext();
  instance.apply(entry.ctx);
  const probe = entry.registrations.find((row) => row.opts.name === "sidebar.footer.action");
  if (options.publish !== false) probe.component({ wide: options.wide ?? false });
  const overlay = entry.registrations.find((row) => row.opts.name === "shell.overlay");

  const list = listOf(summary("blocked-session"), summary("run-session", { running: true }));
  const statuses = statusesOf({
    "blocked-session": { running: false, pendingInteraction: { kind: "question" }, completionUnread: false },
    "run-session": { running: true, completionUnread: false },
  });
  const props = {
    useSessions: (select) => select(list),
    useSessionStatus: (select) => select(statuses),
    useWorkspaces: (select) => select({ items: [] }),
    t: (key) => key,
    openSession: () => {},
  };
  const tree = overlay.component(props);
  const buttons = [];
  walk(tree, (node) => {
    if (node.type === "button") buttons.push(node);
  });
  return { tree, buttons };
}

test("横条:鼠标移开必须收卡片(实测漏过的 bug:只挂 onBlur 收不掉)", () => {
  const { buttons } = renderMarks();
  equal(buttons.length, 2, "两条活跃会话各一根横条");
  for (const button of buttons) {
    equal(typeof button.props.onPointerEnter, "function", "缺悬停进入处理");
    equal(typeof button.props.onPointerLeave, "function", "缺悬停离开处理 ⇒ 卡片不会自己消失");
    equal(typeof button.props.onPointerCancel, "function", "缺指针取消处理");
    equal(typeof button.props.onBlur, "function", "缺失焦处理");
    equal(typeof button.props.onClick, "function", "缺点击处理");
  }
});

test("横条:档位顺序与无障碍名(阻塞在前,带状态词)", () => {
  const { buttons } = renderMarks();
  if (!buttons[0].props.className.includes("sr-mark--blocked")) throw new Error("第一根不是阻塞档:" + buttons[0].props.className);
  if (!buttons[1].props.className.includes("sr-mark--running")) throw new Error("第二根不是运行中档:" + buttons[1].props.className);
  equal(buttons[0].props["aria-label"], "rail.mark", "桩 t 原样返回 key");
});

test("横条:侧边栏展开时不渲染", () => {
  const { tree } = renderMarks({ wide: true });
  equal(tree, null);
});

test("横条:探针还没发布过就保持未知,不渲染(避免在展开的侧边栏上闪一下)", () => {
  const { tree } = renderMarks({ publish: false });
  equal(tree, null);
});

test("横条:浮层入口挂在 shell.overlay,容器带 group 与栏名", () => {
  const { tree } = renderMarks();
  equal(tree.type, "div");
  equal(tree.props.role, "group");
  equal(tree.props["aria-label"], "rail.label", "桩 t 原样返回 key");
  if (!String(tree.props.className).includes("sr-frame")) throw new Error("缺 sr-frame 类:" + tree.props.className);
});

// ── 汇总 ────────────────────────────────────────────────────────────
const failed = results.filter((entry) => !entry.ok);
for (const entry of results) {
  console.log((entry.ok ? "PASS " : "FAIL ") + entry.name);
  if (!entry.ok) console.log("     " + entry.error.message);
}
console.log("\n" + (results.length - failed.length) + "/" + results.length + " 通过");
if (failed.length > 0) process.exitCode = 1;
