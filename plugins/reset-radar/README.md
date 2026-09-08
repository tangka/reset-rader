# 重置雷达 Codex Plugin

用重置雷达长期会员 API Key，结合**本机 Codex 周额度**，查询个人未来 24 小时重置概率。需要 Node.js 22+ 与已登录的 Codex 账号；macOS 可复用 Codex 桌面端自带的可执行文件，无需另装 Codex CLI；Windows 请确保 `codex` 在 `PATH` 中，或设置 `RESET_RADAR_CODEX_PATH` 指向绝对 `codex.exe`。无第三方运行依赖，`npm` 仅用于开发检查。

## 计算规则

- 雷达只取 `overview?naturalCycle=exclude` 的额外重置概率，单位 0–100。
- 本机只读取 10080 分钟的周额度窗口；5 小时额度不参与。
- 周额度将在未来 24 小时内自然重置：个人概率为 100%；否则等于雷达额外重置概率。
- 这是依据当前周额度时间表的估计，不代表额外发卡/重置已官宣。周额度信息缺失或已过期时，个人概率为空，不伪造或顺延时间。
- 雷达概率、自然重置时间与个人结果分别输出。雷达数据超过 2 小时拒绝使用；仅计算和展示通用 Codex 周额度，不监听额外模型额度分组。缺少通用周额度时不以其他模型额度代替。

## 安装与配置

这是自包含的插件目录，按 [Codex 插件安装规范](https://developers.openai.com/plugins/build/plugins) 安装后，在新任务中使用 `$reset-radar`。分发时只复制本目录，不包含项目 `.env`、private 数据或任何会员 Key。

安装仍使用 `codex plugin` 命令，所选可执行文件需支持 `plugin`。PATH 中没有 `codex` 时，可直接调用已安装的桌面端程序，例如：

```bash
"/Applications/Codex.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/Codex.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

如果你的 Codex 桌面应用包名为 `ChatGPT.app`，对应命令为：

```bash
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin marketplace add https://github.com/tangka/reset-rader.git
"/Applications/ChatGPT.app/Contents/Resources/codex" plugin add reset-radar@reset-radar
```

使用实际安装的 Codex 应用包；仅凭 `ChatGPT.app` 文件名不能确认应用身份。

先在重置雷达小程序“雷达会员 → API Key”获取自己的 Key（仅长期会员）。已打开悬浮雷达时，直接在卡片内粘贴 Key，点击“保存并连接”，无需终端或重启。以后可点“修改 Key”，已有 Key 不会回显。保存成功只表示本机配置已写入；联网结果以卡片实际状态为准。

不使用悬浮框时，也可在本机终端配置，不要粘贴到聊天中：复制 Key 后，在本插件目录运行：

```bash
pbpaste | node skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

Windows PowerShell：

```powershell
Get-Clipboard | node skills/reset-radar/scripts/reset-radar.mjs configure --key-stdin
```

macOS/Linux 的 Key 仅保存到本机 `~/.config/reset-radar/api-key`，权限 600；Windows 保存至 `%LOCALAPPDATA%\\reset-radar\\api-key`。也支持现有 `RESET_RADAR_API_KEY` 环境变量或 `RESET_RADAR_API_KEY_FILE` 私有文件。不要把 Key 写入命令参数、插件文件、仓库或提醒提示词。代码不会读取 Codex 登录凭证，也不会上传个人额度/时间。

默认服务地址为 `https://api.tangka.online/radar-api/member/v1`，仅在用户明确指定可信自建服务时覆盖 `RESET_RADAR_API_BASE`。服务器必须支持并回显 `naturalCycle: "exclude"`，旧服务忽略参数时插件会明确报错，不会混入公共自然周期。

## 周额度读取程序

macOS 会先查找正在运行的 Codex 桌面应用，再检查 `/Applications`、`~/Applications` 下的常见安装位置。核对应用标识 `com.openai.codex` 后，使用该应用的 `Contents/Resources/codex`；没有找到可用的桌面端程序时，回退到 PATH 中的 `codex`。Windows/Linux 使用 PATH 中的 `codex`。

自定义安装位置可设置 `RESET_RADAR_CODEX_APP`，值必须是绝对 `.app` 路径；也可用 `RESET_RADAR_CODEX_PATH` 指定可执行文件的绝对路径。显式配置无效时会报错，不回退到其他程序。这两个设置只选择周额度读取程序；Windows 原生悬浮框不依赖 CDP，macOS 的 CDP 卡片仍不扩展到其他应用路径。

在本插件目录查看最终选择的来源和命令：

```bash
node skills/reset-radar/scripts/codex-runtime.mjs
```

此诊断只解析本机程序路径，不读取账户或调用 API。路径探测成功不等于账户登录有效，也不等于所需 app-server 协议兼容；实际个人额度查询成功后，才能确认当前读取链路可用。

## 使用

```bash
node skills/reset-radar/scripts/reset-radar.mjs personal
node skills/reset-radar/scripts/reset-radar.mjs overview
node skills/reset-radar/scripts/reset-radar.mjs status
node skills/reset-radar/scripts/reset-radar.mjs history codex --limit 7
```

个人额度通过官方只读 [`account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server#rate-limits) 读取。计算本身不运行模型、不消耗重置卡、不修改账户。查询结果不能当作“已经开奖”，已确认事件另查历史。

## 提醒

对 Codex 说“每 10 分钟检查，个人概率达到 80% 时提醒我”，插件技能会使用 Codex 的任务提醒机制；**安装不会自动启动**。提醒运行可能消耗 Codex 模型额度。需要已配置的本机 Key；不要把 Key 填入提醒内容。

也可手动运行 `check --threshold 80`（单次、持久去重）或 `watch --threshold 80`（前台循环，每 10 分钟一次，Ctrl+C 停止）。前台 watch 只打印结果，不是手机推送服务；关闭终端即停止。仅高概率首次到达/新周窗口触发提醒，不重复弹报。HTTP 429 遵守等待时间，不绕过限流；401/403 停止前台轮询。

每账户三个只读接口共享 30 次/10 分钟、并发 2 的服务端限额。插件默认串行 10 分钟一次；更换 Key 不应被用来绕过限制。`RESET_RADAR_STATE_DIR` 可指定本机私有状态目录，默认与 Key 目录相同。

## 验证

```bash
npm test
npm run check
```

测试使用明确的测试 HTTP 服务和测试 Key，不当作线上数据；真实线上可用性必须另外验证。

## 悬浮卡片

### Windows 原生卡片

Windows 直接打开独立的置顶卡片，不修改、重启或调试启动 Codex。卡片支持拖动、收起、关闭和手动刷新；首次打开立即计算，仍遵守 API 的 429 等待时间。窗口只从本地 Node 桥接读取已经筛选的概率、倒计时和用量字段，不接收或保存 API Key。

```powershell
node skills/reset-radar/scripts/reset-radar.mjs overlay doctor
node skills/reset-radar/scripts/reset-radar.mjs overlay start
```

保留启动命令的终端进程。关闭卡片或 Ctrl+C 会停止该会话并清理临时展示状态。

### macOS Codex 内部卡片

插件可通过本机 CDP 调试会话，把雷达卡片挂在 Codex 主界面右下角。不是系统置顶窗，也不依赖 Pets。支持拖动、收起、关闭，以及个人 24 小时概率、额外重置概率和周额度倒计时。

```bash
node skills/reset-radar/scripts/reset-radar.mjs overlay doctor
node skills/reset-radar/scripts/reset-radar.mjs overlay start
```

macOS 仅支持已验证的 Codex 主界面目标。无接口会明确报错，不自动重启。若列出多个窗口，指定 `--port <端口> --target <窗口ID>`。卡片内数据每 10 分钟自动查询，倒计时本地每秒更新，不运行额外 SDK 研判。点击顶部“−”左侧的“↻”可立即刷新雷达与本机周额度，读取期间图标旋转并禁用，重复点击不排队。手动刷新不绕过服务端 429 等待时间，重开卡片仍遵守限流。Key 由用户主动在密码框中输入，经当前卡片专用的一次性本机通道交给 Node 保存；提交立即清空输入，不写入聊天、日志、URL 或浏览器存储，也不把已保存 Key 送回卡片。Key 只发给配置的会员 API 鉴权。若由 `RESET_RADAR_API_KEY` 环境变量提供，则不能在卡片内覆盖，需先移除该变量，避免下次启动仍用旧值。

若当前客户端没有调试入口，正常退出 Codex 后，在外部终端运行：

```bash
node skills/reset-radar/scripts/reset-radar.mjs overlay launch
# 使用上一步返回的端口，先 doctor 验证，再 start。
```

这是非官方兼容功能：需要用户同意调试启动；CDP 会提高同机进程访问客户端的能力，客户端升级也可能使其失效。启动命令拒绝结束运行中的客户端，不改应用包/主题/安全配置。未经过 `doctor` 和当前窗口真实展示验证，不视为已适配成功。关闭卡片或 Ctrl+C 停止数据桥接；正常退出并重新打开 Codex 可结束这次调试启动。

悬浮框的 Codex 周额度显示倒计时、已用和剩余百分比，随现有 10 分钟读取更新。用量只在本机展示，不发送到雷达 API；用量未知、连接失效或周额度已到期时显示“使用率暂不可用”，不当作 0%。已用超过 100% 时剩余显示 0%。

缺少会员 Key 时直接显示配置表单，失败可重新粘贴并保存；服务端未提供 `naturalCycle=exclude` 时不代入其他概率。实机验收、会员 API 部署与插件代码测试是不同状态。
