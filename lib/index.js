/**
 * 宿主半侧:本插件不需要任何宿主行为。
 *
 * 它做的事全在浏览器里——借 `sidebar.footer.action` 座位读侧边栏折叠态,
 * 往 `shell.overlay` 座位渲染活跃会话横条栏。宿主行只负责让加载器发现本包
 * (见包内 `cordis.patch.yml` 与 `package.json` 的 `dsh.client`)。
 *
 * 保留空 apply 是契约要求:宿主插件必须导出 apply 或服务类。
 */
export function apply() {}
