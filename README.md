# 划词翻译增强版 · Reliable Translate

由 **fulinrenjian** 发起和维护、使用 AI 辅助开发的 Zotero 翻译增强版。基于 [windingwind/Translate for Zotero v2.4.8](https://github.com/windingwind/zotero-pdf-translate/releases/tag/v2.4.8)，保留原作者及贡献者的工作，按 **AGPL-3.0-or-later** 发布。这是独立维护的分支。

## 主要改进

- 划词浮窗显示翻译进度、完成和失败状态，支持重试、复制及切换服务。
- 拖动浮窗四边或四角可调整整体宽高并记住尺寸；点击「↺」恢复默认大小。正文为单一滚动区。
- 0.1.4 新增「⠿ 移动」手柄，按住可把翻译框移到不遮挡图片的位置。
- 译文绑定当前阅读器与选区，避免旧请求结果覆盖新选区。
- 段落默认使用必应适配器；已完成的同一选区可复用结果。
- 「加入笔记」追加到当前阅读器中打开的可编辑笔记末尾；没有编辑器时新建当前文献的子笔记。独立附件会在同一文库创建独立笔记。
- 笔记保存原文、译文、来源和真实页码；实际保存后显示反馈，同一完成任务重复点击不会重复写入。

## 安装与使用

目标版本为 **Zotero 10.0.x**。功能实机验证环境为 Windows、Zotero 10.0.6，其他平台尚未实测。

1. 在本仓库 [0.1.4 发布页](https://github.com/fulinrenjian/zotero-reliable-translate/releases/tag/v0.1.4) 下载 `Reliable-Translate-0.1.4.xpi`。
2. 在 Zotero「工具 → 插件」中停用原 Translate for Zotero，避免重复触发。
3. 点击齿轮 →「从文件安装插件」，选择 XPI，按提示重启。
4. 打开 PDF 并选择英文，完成后可复制译文或点击「加入笔记」。

设置只在首次迁移时从旧插件复制到本插件的独立设置分支；已有新设置优先。段落服务的默认切换仅应用一次，之后尊重手动选择。本版使用**手动更新**。需要回退时停用增强版，再启用原插件；已保存的笔记会保留。

## 速度与验证范围

2026-10-13，0.1.1 在本机真实 PDF 上，111、126、130 词选区分别在 **471、458、881 毫秒**显示完整译文。三个选区来自同段落的逐步扩展，各自首次翻译；重复缓存结果未用于这组数据。词数按空白分隔计算。

实机已核对新建子笔记、追加到同一笔记、原有文本保留、原文/译文/来源/页码/位置元数据落盘及同次选区防重复。复杂格式和图片保留仅经过离线检查。

0.1.3 进一步改进了浮窗缩放与滚动。上述历史时间不是所有网络环境下的保证，新版实测范围见 [验证说明](docs/VERIFICATION.md) 和 [更新记录](CHANGELOG.md)。

## 在线翻译与使用条件

在线翻译会把待翻译文本发给你选择的服务商。默认必应适配器调用 Microsoft Edge 翻译端点，与需要订阅凭证的 Azure Translator API 不同；也保留腾讯 TranSmart、知网等网页服务适配器。

本次发布准备尚未找到上述三个网页端点允许第三方客户端调用的明确官方依据。它们可能改变访问条件、限流或停止工作。本项目不代表服务商，不承诺接口持续免费或固定响应时间。项目代码的 AGPL 许可不能替代在线服务的使用条款。具体数据流见 [隐私与服务说明](PRIVACY.md)。

维护者目前不做商业运营；项目代码仍按 AGPL 授权，不额外添加「禁止商用」条件。服务商的条款另行适用。

## 从源码构建

使用 Node.js 24 和 npm，在源码目录执行：

```sh
npm ci
npm run test:local
npm run build
```

XPI 位于 `build/`。`test:local` 使用本地模拟对象验证选区、请求、缓存和笔记边界；构建同时进行 TypeScript 检查。不要把构建成功当作所有平台的 UI 验证。

发布包应同时提供本项目源码、锁定的依赖信息、构建文件及 `vendor-sources/` 中的对应运行时依赖源码归档。归档来源、版本和 SHA-256 见该目录的清单。构建工具依赖通过 `npm ci` 安装。

## 来源与许可

- 上游：windingwind 及 [上游贡献者](https://github.com/windingwind/zotero-pdf-translate/graphs/contributors)。基准提交：`2e3d77ddbf3157d8813c61c828957386ab802bdb`（v2.4.8）。
- 本分支：fulinrenjian，AI 辅助开发。修改时间：2026-10-12 至 2026-10-14；修改范围见 [CHANGELOG.md](CHANGELOG.md)。
- 项目许可：[AGPL-3.0-or-later](LICENSE)。[NOTICE](addon/NOTICE.txt) 记录改版来源；第三方组件保留各自的 [许可与版权通知](addon/THIRD_PARTY_NOTICES.txt)。
- 新增的 `reliable-translate.svg` 图标由本分支以矢量路径制作，并按项目许可分发；其他继承资源保留上游归属。

## 反馈

请在 [本分支 Issues](https://github.com/fulinrenjian/zotero-reliable-translate/issues) 报告增强版问题，附 Zotero/插件版本、复现步骤和脱敏后的错误信息。不要上传密钥、完整 Zotero 配置或未获许可的论文文件。原项目资料仍可作为服务配置参考，但本分支的问题由本分支处理。
