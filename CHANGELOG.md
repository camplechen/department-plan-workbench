# 改动记录

> 新记录写在最上面。每次修改前先读本文件，修改后追加一条。规则见 `AGENTS.md`。

## 2026-11-14 17:40（来源：Codex 应用）
- 改动内容：连接 GitHub origin 并接续远端 main 历史，保留本地文件与业务数据；配置 main 跟踪 origin/main；新增应用 / CLI 每次完成调整后检查、中文提交并推送的共享规则及维护说明；保留完整本地忽略规则。此前 GitHub v1.0.0 已发布并核验源码包。
- 涉及文件：`AGENTS.md`、`README.md`、`.gitignore`、`CHANGELOG.md`（远端及分支跟踪为本机 Git 配置）
- 测试情况：npm test 6 项通过；已获取远端历史；推送 dry-run 未通过本机认证，未实际推送；待提交文件排除业务数据、上传图片及凭据。
- 未完成 / 待办：本次提交需在本机完成 GitHub 推送登录后同步；浏览器图文交互及 Windows / Linux 实机验收仍待完成。

## 2026-11-14 16:20（来源：Codex 应用）
- 改动内容：准备 GitHub 源码开源版；新增 GPL-3.0-or-later 许可证及第三方组件说明，补充通用 ZIP 下载、npm ci 安装、Windows / macOS / Linux 启动与升级说明；完善忽略规则以排除业务数据、上传图片、依赖、生成资源及本机配置；初始化本地 Git 仓库，未提交或上传。
- 涉及文件：`README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`package.json`、`package-lock.json`、`.gitignore`、`CHANGELOG.md`
- 测试情况：本地 npm test 6 项通过；仅复制待发布源码到独立目录，npm ci 成功（安装审计 0 个已知漏洞），6 项测试通过；npm start 后首页、空白数据及编辑器资源验证正常，临时服务已关闭；待发布文件敏感信息特征检查通过且不含业务数据。
- 未完成 / 待办：尚未上传 GitHub；首次公开版本的浏览器图文交互验收及 Windows / Linux 实机安装未执行。

## 2026-11-14 11:25（来源：Codex 应用）
- 改动内容：重新读取最新项目文件后重启 3210 本地服务，使 CLI 图文编辑器升级的服务端路由生效；明确 Codex 应用 / CLI 每次启动、重启前须重新读取项目规则、完整改动记录、说明、启动配置及相关源码，核对服务所属目录。同步更新启动说明。
- 涉及文件：`AGENTS.md`、`README.md`、`CHANGELOG.md`
- 测试情况：`npm test` 全部通过（6 项，0 失败）；重启后首页、图文编辑器脚本、TinyMCE 主脚本及中文包均返回 HTTP 200。
- 未完成 / 待办：图文编辑器真实点击、截图粘贴 / 拖拽及视觉验收仍待进行（沿用 CLI 记录）。

## 2026-11-14 11:20（来源：Codex CLI）
- 改动内容：将计划两个字段升级为本地 TinyMCE 8 中文社区版图文编辑器，支持图片上传 / 截图粘贴 / 拖拽 / 缩放 / 对齐、字体字号与颜色高亮、上下标、标题对齐行距缩进列表引用分割线、表格增删行列、链接、清除格式、撤销重做与全屏；加宽弹窗并处理编辑器浮层与原生 dialog 的层级。新增本地图片上传 / 读取接口，限制类型、文件头与单张 10MB，UUID 文件名，图片地址入库；使用 sanitize-html 共用 HTML / CSS 白名单，兼容旧纯文本与旧颜色，详情图文展示及点击查看原图，摘要 / 搜索 / CSV 保持纯文本。npm 安装后自动生成本地资源，无运行时 CDN / 外部资源依赖，补充安装及完整图片备份说明。
- 涉及文件：`package.json`、`package-lock.json`、`.gitignore`、`server.js`、`src/rich-text.js`、`scripts/build-vendor.mjs`、`public/index.html`、`public/app.js`、`public/rich-editor.js`、`public/rich-text.js`、`public/editor-content.css`、`public/style.css`、`public/vendor/tinymce/`、`test/rich-text.test.js`、`test/workbench.test.js`、`README.md`、`CHANGELOG.md`
- 测试情况：`npm test` 全部通过（6 项，0 失败），覆盖图文格式与 HTML / CSS / 图片地址过滤、旧数据兼容、上传大小 / 类型 / 文件头 / 跨来源限制、图片读取与重启恢复、静态资源及核心生命周期；JavaScript 语法检查通过；`npm audit --omit=dev` 为 0 个已知漏洞。测试使用 3219 和独立临时数据目录；尝试 3221 临时预览但浏览器控制宿主不可用。未停止或重启 3210，`data/workbench.json` SHA-256 校验未变化。
- 未完成 / 待办：浏览器宿主不可用，真实点击、截图粘贴 / 拖拽及视觉效果未能实测；需后续浏览器验收。当前 3210 服务按要求保持运行，服务端上传及新增静态资源路由需之后由用户自行重启生效；此前避免使用旧服务编辑图文内容。未引用的已上传图片暂不自动清理。

## 2026-11-14 11:01（来源：Codex CLI）
- 改动内容：计划「目标与验收标准」「行动安排 / 进展记录」新增原生富文本工具栏与快捷键、预设颜色、安全链接、清除格式及撤销 / 重做；HTML 保存、前后端与粘贴白名单过滤；空目标校验；详情富文本展示，搜索与 CSV 使用纯文本；兼容旧纯文本换行。同步更新功能说明，并将记录说明移到所有记录上方。无新增依赖或外部资源请求。
- 涉及文件：`server.js`、`public/app.js`、`public/rich-text.js`、`public/rich-editor.js`、`public/style.css`、`test/workbench.test.js`、`test/rich-text.test.js`、`README.md`、`CHANGELOG.md`
- 测试情况：`npm test` 全部通过（4 项测试，0 失败），覆盖格式与 HTML / 链接过滤、空目标、旧数据兼容、保存读取及核心生命周期；JavaScript 语法检查通过。测试使用临时数据目录与 3219 端口；未停止或重启 3210 服务，未修改 `data/workbench.json`。
- 未完成 / 待办：浏览器检查工具不可用，工具栏真实交互与视觉效果尚未实测；服务端改动需在后续允许重启服务时生效。

## 2026-11-14 10:50（来源：Codex 应用）
- 改动内容：将侧栏品牌标题及浏览器标签页标题统一更名为「部门计划工作台」，同步更新项目说明标题。
- 涉及文件：`public/index.html`、`README.md`、`CHANGELOG.md`
- 测试情况：`npm test` 通过（1 项测试，0 失败）；本地首页返回新标题。
- 未完成 / 待办：无。

## 2026-11-14 10:46（来源：Grok Bot）
- 改动内容：新增 `AGENTS.md`（协作规则）和 `CHANGELOG.md`（改动记录），用于 Codex 应用与 Codex CLI 之间交接。
- 涉及文件：`AGENTS.md`、`CHANGELOG.md`
- 测试情况：未改动业务代码，无需测试。
- 未完成 / 待办：无。

## 2026-11-12 19:18（来源：Codex CLI）
- 改动内容：完成第一版「部门协作工作台」（部门工作计划制定 / 依据管理）。
  - 计划新增、编辑、删除，字段含部门、负责人、周期、目标与验收标准、行动安排、状态、进度；标记「已完成」时进度自动为 100%。
  - 制定依据库：分类、来源、日期、关键要求；一项计划可关联多条依据；被引用的依据禁止删除。
  - 按依据查看计划（未关联计划单独展示），依据详情可反查关联计划。
  - 搜索、部门与状态筛选、逾期识别、概览统计、导出当前筛选结果为中文 CSV。
  - 数据本地保存在 `data/workbench.json`（先写临时文件再替换，并发修改按顺序处理）。
  - 启动：`npm start`，访问 http://127.0.0.1:3210；无第三方依赖，需 Node.js 20+。
- 涉及文件：`package.json`、`server.js`、`public/index.html`、`public/style.css`、`public/app.js`、`test/workbench.test.js`、`README.md`、`.gitignore`
- 测试情况：`npm test` 核心流程及重启恢复测试通过；本地接口已验证可访问；未做页面视觉验收。
- 未完成 / 待办：第一版没有多人账号、审批流程、附件上传、自动提醒、云端同步。
