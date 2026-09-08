# 重置雷达 · Codex Plugin

[English](README.md) | 简体中文

开发者：唐卡/Tangka

在 Codex 里查看自己的周额度使用率、重置倒计时和未来 24 小时重置概率。Windows 使用原生悬浮卡片；macOS 可选在 Codex 主窗口内显示卡片。

这是独立插件仓库，不需要安装重置雷达小程序源码、采集器或后端。数据服务仍使用重置雷达会员 API。

## 使用前准备

- Node.js **22 或更新版本**，终端中能运行 `node`；`npm` 仅用于开发检查。
- 已登录自己的 Codex 账号。macOS 周额度查询可复用 Codex 桌面端自带的可执行文件，无需另装 Codex CLI；Windows 请确保 `codex` 已在 `PATH` 中，或用 `RESET_RADAR_CODEX_PATH` 指定绝对 `codex.exe` 路径；安装命令需要所用可执行文件支持 `plugin`。
- 重置雷达小程序的有效**长期会员 API Key**；月度会员不包含 API 权益，每个人使用自己的 Key。
- Windows、macOS 与 Linux 均支持普通查询和监控。**Windows** 悬浮框是本机原生窗口，无需重启 Codex 或开启调试端口；macOS 主窗口内卡片仍是非官方 CDP 调试接入，客户端升级可能使其失效。

## 安装

### 从 GitHub 安装

在终端执行以下命令：

```bash
codex plugin marketplace add https://github.com/tangka/reset-rader.git
codex plugin add reset-radar@reset-radar
```

如果 PATH 中没有 `codex`，可以直接用桌面端自带的可执行文件运行相同命令。应用位于 `/Applications/Codex.app` 时：

```bash
"/Applications/Codex.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/Codex.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

如果你的 Codex 桌面应用包名为 `ChatGPT.app`，则使用对应的实际路径：

```bash
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

只使用实际安装的 Codex 应用包，文件名相同并不代表应用就是 Codex。下方本地安装和更新命令中的 `codex` 也可以替换成上述带引号的可执行文件路径。

项目仓库为 [tangka/reset-rader](https://github.com/tangka/reset-rader)，插件与 marketplace 的安装标识均为 `reset-radar`。仓库公开，会员接口仍需要你自己的 Key。

这使用 [Codex 官方 marketplace 安装命令](https://learn.chatgpt.com/docs/developer-commands#codex-plugin-marketplace)，不需要复制 Skill 文件或运行远程安装脚本。

### 从收到的本地目录安装

在解压或克隆后的**本仓库根目录**执行：

```bash
codex plugin marketplace add .
codex plugin add reset-radar@reset-radar
```

安装后新建一个 Codex 任务，选择“重置雷达”插件，或输入：

> 使用重置雷达插件，打开悬浮雷达。

仅安装插件不会自动启动悬浮框或定时提醒。此前装过同名个人版插件时，先在 Codex 插件管理中停用旧版，避免同时启用两份。

## 首次打开与填写 Key

先在将用于启动插件的终端确认 `node --version` 可用。macOS 查询周额度时，插件会先查找正在运行的 Codex 桌面应用，再检查 `/Applications`、`~/Applications` 下的常见位置，核对应用标识 `com.openai.codex` 后使用其 `Contents/Resources/codex`。Windows 和 Linux 使用 `PATH` 中的 `codex`。

自定义安装位置可通过 `RESET_RADAR_CODEX_APP` 指定绝对 `.app` 路径，或通过 `RESET_RADAR_CODEX_PATH` 指定可执行文件的绝对路径。显式配置无效时会报错，不会悄悄回退。这些配置只选择周额度读取程序，不改变悬浮卡片的 CDP 探测与调试启动所支持的应用路径。

在本地仓库根目录运行以下命令，可查看将使用的程序来源和路径，不读取账户或调用 API：

```bash
node plugins/reset-radar/skills/reset-radar/scripts/codex-runtime.mjs
```

找到程序仅表示路径解析成功；账户登录和所需 app-server 协议是否兼容，仍需通过实际个人额度查询确认。

1. Windows 直接运行 `overlay start` 打开原生卡片，不重启 Codex、不启用调试入口。macOS 才会检测本机调试入口；没有时会说明风险，并在**获得你同意后**由你正常退出 Codex、从外部终端调试启动。
2. 连接成功后，在卡片密码框粘贴自己的会员 Key，点击“保存并连接”。不要把 Key 发到聊天里。
3. 卡片会显示个人概率、额外重置概率、周额度倒计时、已用/剩余百分比。顶部 `↻` 立即刷新，`−` 收起，`×` 关闭；关闭后再次让 Codex“打开悬浮雷达”即可。

数据桥接进程需持续运行；关闭终端、退出 Codex 或页面重新加载可能使卡片停止，插件不会暗中重新开启。悬浮不可用时，仍可使用普通查询：

> 使用重置雷达插件，查询我的 Codex 周额度和个人重置概率。

仅在普通查询模式下需要终端配置 Key：先复制 Key，再在本仓库根目录由你自己运行以下命令（不会把 Key 放进命令参数）：

```bash
pbpaste | node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

Windows PowerShell 使用：

```powershell
Get-Clipboard | node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

更多命令、调试启动、错误处理和提醒设置见 [插件使用说明](plugins/reset-radar/README.md)。

### Windows 原生悬浮卡片（本地仓库方式）

```powershell
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay start
```

窗口打开期间保留该终端进程。首次打开会立即刷新，但仍遵守服务端 `429` 等待时间；窗口只接收本机 Node 桥接筛选后的展示字段，不接收已保存的 API Key。

### macOS 悬浮卡片外部终端手动启动（本地仓库方式）

在本仓库根目录执行检测：

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor
```

若提示没有调试入口，阅读上面的风险说明，确认愿意启用后，先保存工作并正常退出 Codex，再在**外部终端**执行：

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay launch
```

仅在启动检测成功后，使用输出中的实际 `port` 和 `targetId`，依次执行以下命令。将占位值替换为本次检测值，不沿用别人的端口或窗口 ID：

```bash
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay doctor --port 实际端口 --target 实际窗口ID
node plugins/reset-radar/skills/reset-radar/scripts/reset-radar.mjs overlay start --port 实际端口 --target 实际窗口ID
```

保留最后这个终端进程。若检测本来就成功，可直接用检测得到的端口与窗口启动，不需要退出或重新启动 Codex。失败时停止操作，不绕过应用禁用的调试能力。

## 数据与权限

- macOS/Linux 的 Key 保存在本机 `~/.config/reset-radar/api-key`，文件权限为 `600`；Windows 保存至 `%LOCALAPPDATA%\\reset-radar\\api-key`。Key 只发送到配置的会员 API 用于鉴权。不要共用、提交或打包自己的 Key。
- Windows 读写通过系统 Windows PowerShell 核验文件所有者及 ACL，新文件创建时即设置私有权限；已有文件权限不安全或目录允许其他用户写入时直接拒绝，不修改目录权限或覆盖原 Key。自定义 Key/状态路径同样检查；无法核验 ACL 时不会跳过检查继续使用。
- 个人用量和重置时间由本机 Codex 的只读接口提供，不上传到雷达 API；只使用通用 Codex 周额度，不监听模型专属额度。
- 雷达返回**不含自然周期**的额外重置概率。若自己的周额度将在未来 24 小时内自然重置，个人数值为 100%；否则采用额外重置概率。它是时间表推算，不表示额外重置已经发生；数据缺失或过期会显示不可用。
- 默认每 10 分钟刷新一次；会员账户共用 30 次/10 分钟、并发 2 的服务端限额，手动刷新也遵守 429 等待时间。更换 Key 不重置账户额度。
- 悬浮数据刷新不运行模型研判。主动要求 Codex 定时提醒时，Codex 任务运行可能使用模型额度。
- 调试启动会提高本机其他进程访问 Codex 的能力。只在可信电脑上使用；正常退出再重新打开 Codex，可结束这次调试启动。

## 更新

Git 安装的用户在作者发布更新后执行：

```bash
codex plugin marketplace upgrade reset-radar
codex plugin add reset-radar@reset-radar
```

本地目录安装的用户先取得新版目录，再重新执行安装命令。更新后新建任务；已有悬浮框先关闭，再重新打开，不自动中断当前会话。

## 开发与验证

无第三方运行依赖，不需要 `npm install`：

```bash
npm test
npm run check
```

测试自动发现，使用本地测试服务和明确的测试 Key；测试通过不等于已在另一台电脑或所有 Codex 版本上验收。分发只包含本仓库，不能复制个人 `.config`、`.env` 或任何用户数据。

通过 Git 分发与进入 Codex 官方插件目录是两回事，本项目不宣称已经通过官方目录审核。
