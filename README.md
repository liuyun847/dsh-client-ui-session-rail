---
description: "DSH Web 客户端插件:侧边栏收起时,在左侧 56px 轨道的空白区竖排显示活跃会话横条(阻塞→已完成未读→运行中),悬停出详情卡,点击跳转"
kind: "plugin"
---

# dsh-client-ui-session-rail

侧边栏收起(56px 图标轨道)时,在左侧空白区竖排显示"活跃会话"横条。

```
┌──────────┐
│   🐟     │  ← 品牌/收起按钮
│   ＋     │
│   ✦      │
│   🔍     │
│          │
│   ▬▬     │ ← 阻塞(琥珀)      ┐
│   ▬▬     │ ← 阻塞              │ 本插件渲染的横条栏
│   ▬▬     │ ← 已完成未读(绿)    │ (垂直居中,最多 420px,超出内部滚动)
│   ▬▬     │ ← 运行中(蓝,呼吸)  ┘
│          │
│   ⚙      │  ← 设置
└──────────┘
```

- **顺序**:阻塞 → 已完成未读 → 运行中,同档按最近更新倒序。
- **初始形态**:与右侧对话索引同构的 20×2px 圆角横条,静止缩到 60%,悬停/聚焦放大到 100%。
- **悬停**:右侧弹出详情卡(会话标题 / 状态 · 多久以前 / 工作区)。
- **点击**:跳到该会话(`uiWorkspace.openSession`),侧边栏保持收起。
- **空闲会话不进栏**,所以栏里出现的每一条都是"有事在等"的会话。

## 状态与配色

| 档位 | 判定(与 ui-workspace 的行状态同口径) | 颜色 |
|---|---|---|
| 阻塞 | `pendingInteraction.kind` ∈ approval / plan-review / question | `--dsw-alias-state-warn-primary`(与侧边栏"等待审批"点同色) |
| 已完成未读 | `completionUnread === true`(且自己没在跑、子代理也没在跑) | `--dsw-alias-state-success-primary`(与"已完成"点同色) |
| 运行中 | 自己 `running === true`,**或**名下还有 `running` 的直接子代理 | `--dsw-alias-state-business-primary`(蓝色强调色)+ 1s 呼吸 |

优先级照抄侧边栏状态点:阻塞 > 自己运行 > 子代理运行 > 已完成未读 > 空闲。
只有子代理在跑的会话在侧边栏也是"进行中",所以这里同样进栏;悬停卡片会补一句
"N 个子智能体运行中"。子代理清单取自该会话的 `subagentCatalog` 投影,每个子代理的
running 先看状态快照、再看目录行(与 ui-workspace 的 runningChildCount 一致)。

## 实现要点

三个落点全部走座位契约,**不读别的插件的 DOM / 样式 / 组件源码**:

1. `sidebar.footer.action`(ui-sidebar 声明的 root 级 list 座位)——它的 owner props 带 `wide`,
   这是框架给插件看"侧边栏是否收起"的唯一正规通道。本插件在那里注册一个**不渲染 DOM 的探针**,
   把 `wide` 发布到模块内的折叠态源。
2. `shell.overlay`(ui-layout 声明的 frame 级浮动层,在列容器之外、z-index 20)——横条栏渲染在这里:
   `left:0` + 垂直居中,正好落在轨道中段的空白区。**不用 `position:fixed` 挂在探针身上**:
   祖先一旦有 transform/filter,fixed 就改成相对该祖先定位,收起动画留下的 transform 会让横条错位。
3. 数据来自标准 props:`useSessions`(会话目录)、`useSessionStatus`(running / pendingInteraction /
   completionUnread)、`useWorkspaces`(归档集 + 工作区标题)。跳转回调与 `t` 走注册的 inject 面。

样式只吃主题令牌(`--dsw-alias-*` / `--dsw-radius-lg` / `--dsw-elevation-panel` / `--dsw-font-*`),
浅色深色自动跟随;`prefers-reduced-motion` 下关掉呼吸与过渡。可见文案走 locale 服务
(命名空间 `sessionRail`,zh/en 双词典)。

## 已知边界

- **只在真正还剩 56px 轨道时出图**:ui-layout 对 macOS 桌面与 Windows 标题栏桌面把收起宽度设为 0
  (整列压平,没有空白区可放),本插件在这两种平台不出图。
- **子代理只算直接子代理**:清单来自该会话自己的 `subagentCatalog` 投影(侧边栏同源);
  子代理会话自身仍不进栏(侧边栏也不列)。
- **归档过滤依赖工作区快照**:`useWorkspaces` 缺席时退化为不过滤归档会话(并留一条控制台告警)。
- 横条栏是浮层,不吃鼠标事件的部分(横条之间的空隙)会穿透到下层界面。

## 安装与启用

本包是 profile 组合包(bundle):装进 profile 后,插件页「已安装」里的总开关写
`dsh.profile.bundles`,行级开关向 profile 的 `cordis.patch.yml` 写 disabled 覆盖。

```powershell
# 安装(或重装以刷新链接)
# 用 plugin_manager 工具:action=install_bundle, target=<本包绝对路径>
```

**客户端插件的加载边界**:页面必须**在插件装好之后**打开(或刷新)。本机实测:宿主侧
`dsh-client-hmr` 的 `/plugins/events` 实时图同步在这个页面上没生效 —— 停用另一个客户端插件
(`@michengai/dsh-btw`)后宿主条目确实消失,而页面里的注册仍在。所以**装完新插件要刷新一次页面**
(F5);刷新后 `sidebar.footer.action` 座位里应出现 `session-rail-probe`、`shell.overlay` 里应出现
`session-rail`(可用 cordis_inspect_query 查 Slots 核对)。

## 验收状态(2026-09-26 实机)

已实测:

- 宿主行 `include:session-rail` 生效;刷新后两个座位条目都注册上了。
- 侧边栏收起时横条栏出现:UIA 树里 `Group "活跃会话"` + 三条 `Button "<标题> · <状态>"`,
  顺序 = 阻塞在前、运行中在后,无障碍名走的是词典中文(证明 `locale` 座位与词典注册都生效)。
- 抓屏量像素(1280×720 逻辑坐标):阻塞条 `rgb(245,158,11)` = `--dsw-static-amber-500`;
  运行中条 `rgb(79,106,153)` = 深色主题的蓝色强调色 `#7aaaff` 按呼吸动画的半透明叠加;
  两条运行条处在不同呼吸相位(动画在跑);条宽 18px = 20 CSS × 静止 0.6(与右侧索引同构)。
- 单测 24/24(`node tests/derive.test.mjs`)。

**未能由我实测**(工具面限制,不是已知缺陷):点击跳转。本机浏览器窗口是
`Chrome_WidgetWin_1`,Cua Driver 拒绝后台投递键鼠;`move_cursor` 移动真实指针后页面收不到
hover(条宽仍是静止态的 18px),而抢前台会打断用户正在做的事,故没有继续。

用户实测补充(2026-09-26):悬停详情卡能出,但**移开鼠标后不消失** —— 已修
(横条补 `onPointerLeave`/`onPointerCancel`,原先只挂了 `onBlur`,鼠标划过而没点过时收不掉);
新增的渲染层用例会断言这两个处理函数存在,防止回归。

## 开发

```
lib/client.js          浏览器半侧(唯一有行为的文件):纯函数 + 组件 + apply
lib/index.js           宿主半侧:空 apply(只为让加载器发现本包)
cordis.patch.yml       profile 层 patch(一行 insert)
tests/derive.test.mjs  纯函数单测 + apply 冒烟(node tests/derive.test.mjs,24 例)
```

改代码后:工作区这份是 `link:` 进 profile 的(实测 profile 里是 Junction),
改文件即时生效;但页面仍需刷新才会重新执行 bundle。

### 踩过的坑

- **详情卡只挂 `onBlur` 收不掉**:卡片自己是 `pointer-events:none`,收不到任何鼠标事件;
  鼠标划过横条(没点过、没聚焦)时不会触发 blur,卡片就一直挂着。横条必须自己处理
  `onPointerLeave`(顺带 `onPointerCancel`,指针被系统抢走时也要收)。
- **`--dsw-alias-brand-primary` 不是蓝色强调色**:这套设计里它是"品牌墨色"
  (`--dsw-static-neutral-bluish-1000`,浅色主题近黑),深色主题下画出来是**浅灰横条**。
  实测抓屏量到 rgb(178,178,179) 才发现。蓝色强调色是 `--dsw-alias-state-business-primary`
  (= `--dsw-static-deepseek-500` #4176e6)。单测里加了一条断言禁止再用 brand-primary 当强调色。
- **`inject` 必须声明全**:动态客户端包的 `apply` 会等到 `inject` 里的服务全部就位才跑。
  最初只写 `["slots"]`,apply 在 `slots` 一就绪就执行,那时 `uiWorkspace` / `locale` 还没被各自的
  插件 provide,`ctx.get("uiWorkspace")` 返回 undefined ⇒ 整插件静默不注册(座位表里查不到条目,
  页面无任何表现)。现在是 `["slots", "uiWorkspace", "locale"]`。
- **`locale: NS` 与词典注册的顺序**:`ui-locale` 的 apply 里 `provide("locale")` 之后**同步**
  `installLocale()`,所以等到 locale 服务再执行就一定能拿到框架合成的 `t` 座位;服务缺席时组件
  退回中文兜底,不硬崩。
- **探针与横条栏的时序**:探针的 effect 先于浮层的订阅 effect 跑,横条栏在订阅时补读一次当前值
  (`setValue(collapsedValue)`),否则"一开始就是收起态"会漏掉第一次发布。
