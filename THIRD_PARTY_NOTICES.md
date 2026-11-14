# 第三方组件许可说明

本项目原创代码按 GPL-3.0-or-later 发布。第三方组件保留各自版权和许可，不因本项目许可声明而改变。

| 组件 | 用途 | 许可与声明位置（执行 npm ci 后） |
|---|---|---|
| TinyMCE 8 | 本地图文编辑器 | GPL-2.0-or-later（本项目选择 GPL 模式）；`node_modules/tinymce/license.md`、`notices.txt`，同时复制到 `public/vendor/tinymce/` |
| tinymce-i18n | 中文语言包 | 原创工具与补丁采用 MIT；语言包按对应 TinyMCE 版本的许可。详见 `node_modules/tinymce-i18n/LICENSE.md`、`NOTICE.md`，安装时复制到 `public/vendor/tinymce/langs/` |
| sanitize-html | HTML 白名单过滤 | MIT；`node_modules/sanitize-html/LICENSE` |
| esbuild | 本地浏览器模块构建 | MIT；`node_modules/esbuild/LICENSE.md` |

准确依赖版本和间接依赖列表见 `package-lock.json`；完整许可和版权声明以安装包内文件为准。安装阶段通过 npm 下载组件，运行时从本机提供资源。安装命令同时下载开发依赖，因为构建需要 esbuild。

仓库不包含 `node_modules/`、生成的 `public/vendor/` 和 `public/rich-text.js`。分发自行构建的资源时，应保留上述许可、版权和相应源码，并核对所有被打包的间接依赖声明；不要仅以本表代替第三方许可原文。
