// 浏览器端插件主体:侧边栏收起(56px 图标轨道)时,在左侧空白区竖排显示"活跃会话"
// 的彩色横条 —— 阻塞 → 已完成未读 → 运行中,从上到下;悬停出详情卡,点击跳转该会话。
// "运行中"含两种:自己在本轮运行,或自己空闲但名下还有子代理在跑(与侧边栏状态点同口径)。
// 样式对齐右侧对话索引(ui-chat 的 TurnNavigator):20×2px 圆角横条、静止 scaleX(.6)、
// 悬停/聚焦放大到 1、悬停出浮层卡片、点击导航。颜色沿用官方状态语义:
// 阻塞 = state-warn(与侧边栏"等待审批"点同色)、已完成未读 = state-success(同"已完成"点)、
// 运行中 = state-business(蓝色强调色)并带 1s 呼吸。
// 注意别用 --dsw-alias-brand-primary:这套设计里它是"品牌墨色"(浅色主题近黑、深色主题浅灰),
// 不是蓝色强调色 —— 实测深色主题下画出来是灰条,与"运行中"的语义不符(见 README「踩过的坑」)。
//
// 落点(全部走座位契约,不读别的插件的 DOM/样式/组件源码):
//  1. `sidebar.footer.action`(ui-sidebar 声明的 root 级 list 座位)的 owner props 带
//     `wide` —— 框架给插件看"侧边栏是否收起"的唯一正规通道 ⇒ 注册一个不渲染的探针
//     组件,把 wide 发布到本模块的折叠态源;
//  2. `shell.overlay`(ui-layout 声明的 frame 级浮动层,在列容器之外、z-index 20)是
//     "位置已知的浮层"的正规座位 ⇒ 横条栏渲染在这里:left:0 + 垂直居中,正落在轨道
//     中段的空白区(上段是品牌/新建/面板图标,下段是设置)。
//     不用 position:fixed 挂在探针自己身上:祖先一旦有 transform/filter,fixed 就改成
//     相对该祖先定位,收起动画留下的 transform 会让横条错位。
//  3. 数据全部来自标准 props:`useSessions`(会话目录)、`useSessionStatus`(running /
//     pendingInteraction / completionUnread)、`useWorkspaces`(归档集 + 工作区标题)。
//
// 格式遵循 DSH 客户端插件契约:window.__ModuleLoader__.load + 具名导出 apply/inject。
// 注意 apply 的 inject 必须声明 ["slots", "uiWorkspace", "locale"]:动态包的 apply 会等到
// inject 里的服务全部就位才跑,少声明一个就会在服务尚未 provide 时提前执行(见下方 apply)。
window.__ModuleLoader__.load({
  id: "dsh-client-ui-session-rail",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var react = require("react");

    // ══ 词典(可见文案一律走 locale 服务,不硬编码在组件里)════════════════
    var NS = "sessionRail";
    var zh = {
      "rail.label": "活跃会话",
      "rail.mark": "{title} · {state}",
      "state.approval": "等待审批",
      "state.planReview": "计划待审",
      "state.question": "等待回答",
      "state.done": "已完成未读",
      "state.running": "进行中",
      "state.subagents": "{n} 个子智能体运行中",
      "time.now": "刚刚",
      "time.minutes": "{n}分钟",
      "time.hours": "{n}小时",
      "time.days": "{n}天",
      "time.months": "{n}个月",
      "time.years": "{n}年",
      "time.ago": "{t}前",
    };
    var en = {
      "rail.label": "Active sessions",
      "rail.mark": "{title} · {state}",
      "state.approval": "Waiting for approval",
      "state.planReview": "Plan awaiting review",
      "state.question": "Waiting for answer",
      "state.done": "Completed, unread",
      "state.running": "Running",
      "state.subagents": "{n} subagents running",
      "time.now": "now",
      "time.minutes": "{n}min",
      "time.hours": "{n}h",
      "time.days": "{n}d",
      "time.months": "{n}mo",
      "time.years": "{n}y",
      "time.ago": "{t} ago",
    };

    // ══ 纯函数区(可单测,见 tests/derive.test.mjs)═══════════════════════
    var MINUTE = 60000;
    var HOUR = 3600000;
    var DAY = 86400000;
    var MONTH = 30 * DAY;
    var YEAR = 365 * DAY;

    /**
     * 紧凑相对时间分桶。阈值与 ui-primitives 的 relativeTime 逐条一致
     * (两处描述同一件事:同一会话在侧边栏与这里说同样的"多久以前")。
     * @param {number} at - 目标时刻(epoch ms)。
     * @param {number} now - 当前时刻(epoch ms,由调用方注入,便于纯函数测试)。
     * @returns {{unit: string, n: number}} 分桶与量级(now 桶恒为 0)。
     */
    function relativeTime(at, now) {
      var diff = Math.max(0, now - at);
      if (diff < MINUTE) return { unit: "now", n: 0 };
      if (diff < HOUR) return { unit: "minutes", n: Math.floor(diff / MINUTE) };
      if (diff < DAY) return { unit: "hours", n: Math.floor(diff / HOUR) };
      if (diff < MONTH) return { unit: "days", n: Math.floor(diff / DAY) };
      if (diff < YEAR) return { unit: "months", n: Math.floor(diff / MONTH) };
      return { unit: "years", n: Math.floor(diff / YEAR) };
    }

    /** 档位:阻塞最先,其次已完成未读,最后运行中(需求给定的从上到下顺序)。 */
    var RANK = { blocked: 0, done: 1, running: 2 };

    /**
     * 可见的待处理交互种类。与 ui-workspace 的 visiblePendingKind 同一白名单:
     * 未来新增的种类按"无阻塞"处理,不猜。
     * @param {object|undefined} status - useSessionStatus 的单个会话状态。
     * @returns {string|undefined} approval / plan-review / question 之一。
     */
    function pendingKindOf(status) {
      var interaction = status === undefined || status === null ? undefined : status.pendingInteraction;
      var kind = interaction === undefined || interaction === null ? undefined : interaction.kind;
      return kind === "approval" || kind === "plan-review" || kind === "question" ? kind : undefined;
    }

    /**
     * 一个会话在栏里的档位;undefined = 不进栏(空闲)。
     * 判定口径与 ui-workspace 的 sessionStatuses 逐条对齐:待处理交互压过一切,
     * 自己在本轮运行压过子代理,子代理在跑压过未读完成;快照没有 running 时退回
     * 目录行自己的 running。
     * @param {object|undefined} status - useSessionStatus 的单个会话状态。
     * @param {boolean|undefined} summaryRunning - 会话摘要上的 running(兜底)。
     * @param {number} runningSubagents - 该会话下正在跑的直接子代理数(见 runningSubagentCount)。
     * @returns {string|undefined} blocked / done / running。
     */
    function railStateOf(status, summaryRunning, runningSubagents) {
      if (pendingKindOf(status) !== undefined) return "blocked";
      var running = status === undefined || status === null || status.running === undefined ? summaryRunning : status.running;
      if (running === true) return "running";
      if (typeof runningSubagents === "number" && runningSubagents > 0) return "running";
      if (status !== undefined && status !== null && status.completionUnread === true) return "done";
      return undefined;
    }

    /**
     * 一个会话名下正在跑的直接子代理数。口径照抄 ui-workspace 的 runningChildCount:
     * 子代理清单来自该会话的 subagentCatalog 投影,每个子代理的 running 先看状态快照、
     * 再看目录行自己的 running。清单或投影缺失时记 0。
     * @param {object|undefined} list - 会话列表快照(要 projectionsBySession 与 byId)。
     * @param {object|undefined} statuses - useSessionStatus 的状态快照。
     * @param {string} sessionId - 父会话 id。
     * @returns {number} 运行中的直接子代理数。
     */
    function runningSubagentCount(list, statuses, sessionId) {
      if (list === undefined || list === null) return 0;
      var bySession = list.projectionsBySession;
      var snapshot = bySession === undefined || bySession === null ? undefined : bySession[sessionId];
      var values = snapshot === undefined || snapshot === null ? undefined : snapshot.values;
      var catalog = values === undefined || values === null ? undefined : values.subagentCatalog;
      if (!Array.isArray(catalog)) return 0;
      var byId = list.byId === undefined || list.byId === null ? {} : list.byId;
      var count = 0;
      for (var i = 0; i < catalog.length; i++) {
        var child = catalog[i];
        if (child === undefined || child === null) continue;
        var childStatus = statusOf(statuses, child.id);
        var running = childStatus === undefined || childStatus === null || childStatus.running === undefined
          ? (byId[child.id] === undefined || byId[child.id] === null ? undefined : byId[child.id].running)
          : childStatus.running;
        if (running === true) count += 1;
      }
      return count;
    }

    /** 从状态快照取一行:契约是 ReadonlyMap,兼容纯对象形态以免上游换形状即静默失效。 */
    function statusOf(statuses, id) {
      if (statuses === undefined || statuses === null) return undefined;
      if (typeof statuses.get === "function") return statuses.get(id);
      return statuses[id];
    }

    /**
     * 会话 id → 工作区标题(详情卡用)。同一会话被多个工作区记账时取先出现者,
     * 与 ui-workspace 搜索结果的归属口径一致。
     * @param {object|undefined} workspaces - useWorkspaces 的快照。
     * @returns {Record<string, string>} 无快照时为空表。
     */
    function indexWorkspaceTitles(workspaces) {
      var titles = Object.create(null);
      if (workspaces === undefined || workspaces === null || !Array.isArray(workspaces.items)) return titles;
      for (var i = 0; i < workspaces.items.length; i++) {
        var view = workspaces.items[i];
        if (view === undefined || view === null || !Array.isArray(view.sessionIds)) continue;
        for (var j = 0; j < view.sessionIds.length; j++) {
          var id = view.sessionIds[j];
          if (titles[id] === undefined) titles[id] = view.title;
        }
      }
      return titles;
    }

    /**
     * 推导栏内行:阻塞 → 已完成未读 → 运行中,同档按最近更新倒序。
     * "运行中"含两种情况:自己在本轮运行,或自己空闲但名下还有子代理在跑
     * (与侧边栏状态点同口径 —— 只有子代理在跑的会话在侧边栏也是"进行中")。
     * 跳过三类会话:空会话(工作区的"新建会话"占位)、子代理会话(侧边栏同样不列)、
     * 归档会话(仅当归档集可得时过滤)。
     * @param {object} input - { list, statuses, archived, workspaceTitles }。
     * @returns {Array<object>} 行:{ id, title, state, kind, subagents, updatedAt, workspace }。
     */
    function deriveRows(input) {
      var rows = [];
      var list = input.list;
      if (list === undefined || list === null || !Array.isArray(list.ids) || list.byId === undefined || list.byId === null) return rows;
      var statuses = input.statuses;
      var archived = input.archived;
      var titles = input.workspaceTitles;
      for (var i = 0; i < list.ids.length; i++) {
        var id = list.ids[i];
        var summary = list.byId[id];
        if (summary === undefined || summary === null) continue;
        if (summary.blank === true) continue;
        if (summary.origin === "subagent") continue;
        if (Array.isArray(archived) && archived.indexOf(id) !== -1) continue;
        var status = statusOf(statuses, id);
        var subagents = runningSubagentCount(list, statuses, id);
        var state = railStateOf(status, summary.running, subagents);
        if (state === undefined) continue;
        rows.push({
          id: id,
          title: summary.displayTitle === undefined || summary.displayTitle === "" ? id : summary.displayTitle,
          state: state,
          kind: pendingKindOf(status),
          subagents: subagents,
          updatedAt: typeof summary.updatedAt === "number" ? summary.updatedAt : 0,
          workspace: titles === undefined ? undefined : titles[id],
        });
      }
      rows.sort(compareRows);
      return rows;
    }

    /** 档位升序;同档最近更新在前;再同则按 id —— 全序,便于断言且排序稳定。 */
    function compareRows(a, b) {
      var rank = RANK[a.state] - RANK[b.state];
      if (rank !== 0) return rank;
      if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    }

    /** 极简模板替换:{name} 占位;缺 key 时回落到 key 本身(降级路径专用)。 */
    function template(text, params) {
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, function (match, name) {
        return params[name] === undefined ? match : String(params[name]);
      });
    }

    /** 未拿到 locale 座位时的中文兜底翻译(只影响文案,不影响功能)。 */
    function fallbackTranslate(key, params) {
      var text = zh[key];
      return text === undefined ? key : template(text, params);
    }

    /** 详情卡与无障碍名用的状态文案;阻塞按具体种类细分。 */
    function stateLabel(row, t) {
      if (row.state === "blocked") {
        if (row.kind === "approval") return t("state.approval");
        if (row.kind === "plan-review") return t("state.planReview");
        return t("state.question");
      }
      return row.state === "done" ? t("state.done") : t("state.running");
    }

    /** "3分钟前"式文案:分桶 → 单位词 → ago 模板,与侧边栏悬停卡同一套说法。 */
    function timeAgo(at, now, t) {
      var bucket = relativeTime(at, now);
      if (bucket.unit === "now") return t("time.now");
      return t("time.ago", { t: t("time." + bucket.unit, { n: bucket.n }) });
    }

    /**
     * 详情卡的状态行:状态词 [+ N 个子智能体运行中] + 相对时间。
     * 有子代理时补一句,和侧边栏状态点的说法一致(只有子代理在跑的会话也显示"进行中")。
     * @param {object} row - 栏内行。
     * @param {string} time - 已算好的相对时间文案。
     * @param {Function} t - 翻译函数。
     * @returns {string} 一行文案。
     */
    function previewMeta(row, time, t) {
      var parts = [stateLabel(row, t)];
      if (typeof row.subagents === "number" && row.subagents > 0) parts.push(t("state.subagents", { n: row.subagents }));
      parts.push(time);
      return parts.join(" · ");
    }

    // ══ 折叠态:模块内共享源 ════════════════════════════════════════════
    // 探针组件(在 footer.action 里)与横条栏(在 shell.overlay 里)是本插件的
    // 两个座位注册,靠这个模块内的小源通信。null = 未知(探针还没渲染过),
    // 此时不显示 —— 宁可晚 150ms 出现,也不要在展开的侧边栏上闪一下。
    var collapsedValue = null;
    var collapsedListeners = [];

    /** 发布折叠态;值不变时不通知(渲染次数与状态变化次数对齐)。 */
    function publishCollapsed(next) {
      if (collapsedValue === next) return;
      collapsedValue = next;
      var listeners = collapsedListeners.slice();
      for (var i = 0; i < listeners.length; i++) listeners[i]();
    }

    /** 订阅折叠态(React 18 的 useState + useEffect,不依赖 useSyncExternalStore)。 */
    function useCollapsed() {
      var pair = react.useState(collapsedValue);
      var value = pair[0];
      var setValue = pair[1];
      react.useEffect(function () {
        // 渲染到订阅之间可能已经变过,先对齐一次再挂监听。
        setValue(collapsedValue);
        var listener = function () { setValue(collapsedValue); };
        collapsedListeners.push(listener);
        return function () {
          var index = collapsedListeners.indexOf(listener);
          if (index !== -1) collapsedListeners.splice(index, 1);
        };
      }, []);
      return value;
    }

    /**
     * 收起时左侧是否真的还剩一条 56px 轨道。ui-layout 对 darwin 桌面与
     * Windows 标题栏桌面把收起宽度设为 0(整列压平,没有空白区可放),
     * 这两种平台下本插件不出图。读的是 <html> 上的平台标记(全应用都按它分派),
     * 不是别的插件的组件状态。
     */
    function railExists() {
      if (typeof document === "undefined" || document === null) return false;
      var root = document.documentElement;
      if (root === null || root === undefined) return false;
      if (root.dataset !== undefined && root.dataset.platform === "darwin") return false;
      return typeof root.hasAttribute === "function" ? !root.hasAttribute("data-windows-titlebar") : true;
    }

    // ══ 组件 ═══════════════════════════════════════════════════════════
    /** 详情卡半高(卡片最高 100px),用于把它夹在栏框内,不越出 AppFrame。 */
    var PREVIEW_HALF = 50;
    /** 稳定的恒等选择器:整份快照进组件,派生一律在 useMemo 里做。 */
    function identity(snapshot) { return snapshot; }
    /** 预览卡的唯一 id(无障碍 aria-describedby 指向它)。 */
    var previewSeq = 0;

    /**
     * 折叠态探针:注册在 `sidebar.footer.action`,自己不渲染任何 DOM,
     * 只把 owner props 的 `wide` 发布成"是否收起"。卸载(整列被移除,例如
     * macOS 桌面收起)时回到未知,横条栏随之消失。
     */
    function RailPresence(props) {
      var collapsed = props.wide === false;
      react.useEffect(function () {
        publishCollapsed(collapsed);
      }, [collapsed]);
      react.useEffect(function () {
        return function () { publishCollapsed(null); };
      }, []);
      return null;
    }

    /**
     * 横条栏视图。纯展示:行、翻译、跳转回调都由外层给。
     * 悬停/聚焦出详情卡(位置按被悬停横条的屏幕位置算,并夹在栏框内),
     * 点击跳转,失焦收起。
     */
    function RailView(props) {
      var rows = props.rows;
      var t = typeof props.t === "function" ? props.t : fallbackTranslate;
      var openSession = props.openSession;
      var frame = react.useRef(null);
      var idRef = react.useRef(null);
      if (idRef.current === null) {
        previewSeq += 1;
        idRef.current = "session-rail-preview-" + previewSeq;
      }
      var previewId = idRef.current;
      var previewPair = react.useState(null);
      var preview = previewPair[0];
      var setPreview = previewPair[1];

      /** 打开详情卡:纵向中心对齐被悬停的横条,并夹在栏框高度内。 */
      function showPreview(row, element) {
        var frameElement = frame.current;
        if (frameElement === null || element === null || element === undefined) return;
        var frameRect = frameElement.getBoundingClientRect();
        var rect = element.getBoundingClientRect();
        var center = rect.top - frameRect.top + rect.height / 2;
        var top = Math.max(PREVIEW_HALF, Math.min(center, Math.max(PREVIEW_HALF, frameRect.height - PREVIEW_HALF)));
        setPreview({ row: row, top: top, time: timeAgo(row.updatedAt, Date.now(), t) });
      }

      function renderMark(row) {
        var open = preview !== null && preview.row.id === row.id;
        return react.createElement("button", {
          key: row.id,
          type: "button",
          className: "sr-mark sr-mark--" + row.state + (open ? " sr-mark--preview" : ""),
          "aria-label": t("rail.mark", { title: row.title, state: stateLabel(row, t) }),
          "aria-describedby": open ? previewId : undefined,
          onPointerEnter: function (event) { showPreview(row, event.currentTarget); },
          // 指针移开必须自己收卡片:详情卡是 pointer-events:none,收不到任何鼠标事件,
          // 只靠 onBlur 收不掉"鼠标划过但没点过"的那次(实测就是这个漏)。
          onPointerLeave: function () { setPreview(null); },
          onPointerCancel: function () { setPreview(null); },
          onFocus: function (event) { showPreview(row, event.currentTarget); },
          onBlur: function () { setPreview(null); },
          onClick: function () { openSession(row.id); },
        });
      }

      var previewNode = preview === null ? null : react.createElement("div", {
        className: "sr-preview",
        id: previewId,
        role: "tooltip",
        style: { top: preview.top + "px" },
      }, [
        react.createElement("div", { className: "sr-preview-title", key: "title" }, preview.row.title),
        react.createElement("div", { className: "sr-preview-meta", key: "state" }, [
          react.createElement("span", { className: "sr-preview-dot sr-dot--" + preview.row.state, key: "dot" }),
          react.createElement("span", { className: "sr-preview-text", key: "text" }, previewMeta(preview.row, preview.time, t)),
        ]),
        preview.row.workspace === undefined
          ? null
          : react.createElement("div", { className: "sr-preview-meta", key: "workspace" }, [
              react.createElement("span", { className: "sr-preview-text", key: "text" }, preview.row.workspace),
            ]),
      ]);

      return react.createElement("div", {
        ref: frame,
        className: "sr-root sr-frame",
        role: "group",
        "aria-label": t("rail.label"),
      }, [
        react.createElement("div", { className: "sr-scroller", key: "scroller" }, rows.map(renderMark)),
        previewNode,
      ]);
    }

    /**
     * 有工作区快照的实现:额外拿到归档集(过滤归档会话)与工作区标题(详情卡)。
     */
    function FullRail(props) {
      var list = props.useSessions(identity);
      var statuses = props.useSessionStatus(identity);
      var workspaces = props.useWorkspaces(identity);
      var rows = react.useMemo(function () {
        return deriveRows({
          list: list,
          statuses: statuses,
          archived: workspaces === undefined || workspaces === null ? undefined : workspaces.archivedSessionIds,
          workspaceTitles: indexWorkspaceTitles(workspaces),
        });
      }, [list, statuses, workspaces]);
      var collapsed = useCollapsed();
      if (collapsed !== true || !railExists() || rows.length === 0) return null;
      return react.createElement(RailView, { rows: rows, t: props.t, openSession: props.openSession });
    }

    /** 退化实现:没有 useWorkspaces 时不滤归档、详情卡不显示工作区(其余不变)。 */
    function BasicRail(props) {
      var list = props.useSessions(identity);
      var statuses = props.useSessionStatus(identity);
      var rows = react.useMemo(function () {
        return deriveRows({ list: list, statuses: statuses });
      }, [list, statuses]);
      var collapsed = useCollapsed();
      if (collapsed !== true || !railExists() || rows.length === 0) return null;
      return react.createElement(RailView, { rows: rows, t: props.t, openSession: props.openSession });
    }

    /**
     * 座位入口:自身不调用任何 hook,只按稳定的标准 props 选实现,
     * 让两个子组件各自无条件调用自己的 hooks(不违反 Hooks 规则)。
     */
    function SessionRailEntry(props) {
      if (typeof props.useSessions !== "function" || typeof props.useSessionStatus !== "function") {
        warnOnce("标准 props 缺少 useSessions/useSessionStatus,活跃会话栏已停用");
        return null;
      }
      if (typeof props.useWorkspaces !== "function") {
        warnOnce("标准 props 缺少 useWorkspaces,退化为不过滤归档会话、详情卡不显示工作区");
        return react.createElement(BasicRail, props);
      }
      return react.createElement(FullRail, props);
    }

    /** 降级告警只报一次,避免每轮渲染刷屏(HMR 重载会重置)。 */
    var warned = false;
    function warnOnce(message) {
      if (warned) return;
      warned = true;
      console.warn("[session-rail] " + message);
    }

    // ══ 样式(只吃主题令牌,浅色/深色自动跟随)═══════════════════════════
    var CSS = [
      // 栏框:轨道宽 56px、垂直居中,落在轨道中段的空白区。pointer-events 关掉,
      // 只有横条自己接管指针,不挡底下的界面。
      ".sr-root.sr-frame{position:absolute;left:0;top:50%;width:56px;display:flex;flex-direction:column;align-items:center;pointer-events:none;transform:translateY(-50%)}",
      ".sr-scroller{display:flex;flex-direction:column;align-items:center;max-height:min(60vh,420px);padding:6px 0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:none;pointer-events:none}",
      ".sr-scroller::-webkit-scrollbar{display:none}",
      // 横条:与右侧索引同构 —— 20×2px、圆角 2px、静止 scaleX(.6)、悬停/聚焦放大到 1。
      ".sr-mark{position:relative;flex:none;width:56px;height:10px;padding:0;border:0;border-radius:8px;background:none;cursor:pointer;pointer-events:auto}",
      ".sr-mark::before{content:'';position:absolute;top:50%;left:50%;width:20px;height:2px;border-radius:2px;background:var(--dsw-alias-border-l4);transform:translate(-50%,-50%) scaleX(.6);transition:transform .14s,background-color .14s}",
      ".sr-mark:hover::before,.sr-mark--preview::before{transform:translate(-50%,-50%) scaleX(1)}",
      ".sr-mark--blocked::before{background:var(--dsw-alias-state-warn-primary)}",
      ".sr-mark--done::before{background:var(--dsw-alias-state-success-primary)}",
      ".sr-mark--running::before{background:var(--dsw-alias-state-business-primary);animation:sr-mark-busy 1s ease-in-out infinite}",
      ".sr-mark:focus-visible{outline:none}",
      ".sr-mark:focus-visible::after{content:'';position:absolute;inset:0 8px;border-radius:8px;outline:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-1px}",
      // 详情卡:与右侧索引的预览同款(浮层底色 + 面板投影 + lg 圆角),出现在横条右侧。
      ".sr-preview{position:absolute;left:calc(100% + 8px);width:min(300px,60vw);box-sizing:border-box;padding:10px 12px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);pointer-events:none;transform:translateY(-50%);animation:sr-preview-in .12s ease-out}",
      ".sr-preview-title{font:var(--dsw-font-xs-strong-13);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sr-preview-meta{display:flex;align-items:center;gap:5px;margin-top:4px;min-width:0}",
      ".sr-preview-text{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-caption);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".sr-preview-dot{flex:none;width:6px;height:6px;border-radius:50%}",
      ".sr-dot--blocked{background:var(--dsw-alias-state-warn-primary)}",
      ".sr-dot--done{background:var(--dsw-alias-state-success-primary)}",
      ".sr-dot--running{background:var(--dsw-alias-state-business-primary)}",
      "@keyframes sr-mark-busy{0%,100%{opacity:1}50%{opacity:.35}}",
      "@keyframes sr-preview-in{0%{opacity:0;transform:translate(4px,-50%)}100%{opacity:1;transform:translate(0,-50%)}}",
      "@media (prefers-reduced-motion:reduce){.sr-mark--running::before,.sr-preview{animation:none}.sr-mark::before{transition:none}}",
    ].join("");

    var TAG_ID = "dsh-client-ui-session-rail/session-rail.css";

    /** 插入样式表并把移除交给 fiber 清理(HMR/停用时不留下游离的 <style>)。 */
    function installStyles(ctx) {
      ctx.effect(function () {
        if (typeof document === "undefined" || document === null) return function () {};
        if (document.querySelector("style[data-plugin-css=" + JSON.stringify(TAG_ID) + "]") !== null) return function () {};
        var tag = document.createElement("style");
        tag.dataset.plugin = "dsh-client-ui-session-rail";
        tag.dataset.pluginCss = TAG_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      }, "session-rail: styles");
    }

    // ══ 插件主体 ═══════════════════════════════════════════════════════
    // 三个都是硬依赖,声明在 inject 里 —— 动态包的 apply 会一直等到它们全部就位
    // (运行时的 activation gating:waitingFor = inject 里 ctx.get 仍为 undefined 的名字)。
    // 这一点踩过坑:只声明 ["slots"] 时 apply 会在 slots 一就绪就跑,那时 uiWorkspace /
    // locale 还没被各自的插件 provide,`ctx.get("uiWorkspace")` 返回 undefined,
    // 于是整插件静默不注册(座位表里查不到条目,页面无任何表现)。
    var inject = ["slots", "uiWorkspace", "locale"];

    /**
     * 注册两个座位条目:折叠态探针(footer.action)与横条栏(shell.overlay)。
     * uiWorkspace.openSession 缺席时整体不注册 —— 不能跳转的横条栏只会误导人
     * (inject 已声明该服务,这条只是防御性检查)。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      var slots = ctx.get("slots");
      if (slots === undefined || slots === null) return;
      var uiWorkspace = ctx.get("uiWorkspace");
      if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== "function") {
        console.error("[session-rail] 缺少 uiWorkspace.openSession,活跃会话栏无法跳转,本插件不注册");
        return;
      }
      var locale = ctx.get("locale");
      var hasLocale = locale !== undefined && locale !== null && typeof locale.register === "function";

      installStyles(ctx);
      if (hasLocale) {
        ctx.effect(function () {
          var offZh = locale.register(NS, "zh", zh);
          var offEn = locale.register(NS, "en", en);
          return function () { offZh(); offEn(); };
        }, "session-rail: dictionaries");
      }

      var railOptions = {
        name: "shell.overlay",
        id: "session-rail",
        order: 10,
        inject: function () {
          return {
            openSession: function (sessionId) { uiWorkspace.openSession(sessionId); },
          };
        },
      };
      // 声明 locale 才拿到框架合成的 t 座位(切语言时自动重渲);inject 里已保证
      // locale 服务就位,而 ui-locale 的 apply 在 provide 之后同步 installLocale,
      // 故渲染时 locale face 必定已装。缺席时组件退回中文兜底,不硬崩。
      if (hasLocale) railOptions.locale = NS;

      ctx.effect(function () {
        return slots.inject("sidebar.footer.action", function () {
          return slots.register({ name: "sidebar.footer.action", id: "session-rail-probe" }, RailPresence);
        });
      }, "session-rail: collapse probe");

      ctx.effect(function () {
        return slots.inject("shell.overlay", function () {
          return slots.register(railOptions, SessionRailEntry);
        });
      }, "session-rail: rail overlay");

      console.info("[session-rail] 已加载:侧边栏收起时在左侧空白区显示活跃会话横条");
    }

    exports.apply = apply;
    exports.inject = inject;
    // 测试钩子:纯函数(浏览器侧不消费)。
    exports.__test = {
      relativeTime: relativeTime,
      railStateOf: railStateOf,
      pendingKindOf: pendingKindOf,
      runningSubagentCount: runningSubagentCount,
      indexWorkspaceTitles: indexWorkspaceTitles,
      deriveRows: deriveRows,
      compareRows: compareRows,
      timeAgo: timeAgo,
      stateLabel: stateLabel,
      previewMeta: previewMeta,
      template: template,
      CSS: CSS,
    };
    return module.exports;
  },
});
