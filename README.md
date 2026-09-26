
# dsh-fish-widget

一个运行在 DSH 网页界面中的大肥鱼互动挂件。支持八种情态、拖拽吸附、点击互动、自定义素材，以及纯娱乐性质的对话拦截。

## 重要提醒

插件默认开启 `intercept`。开启时，它会拦截用户消息并显示大肥鱼的整活回复，真实模型不会收到该轮请求。

- 临时让一轮交给真实模型：在消息开头输入 `!!`
- 恢复正常对话：右键大肥鱼或气泡，关闭“拦截（不干活）”
- 也可以在配置文件中设置 `"intercept": false`

## 功能

- 八种情态：待机、思考、偷吃、挂机、完成、被揉、被按和抓包
- 可拖动并自动吸附窗口边缘
- 单击、双击、长按均有不同反馈
- 内置一组大肥鱼互动台词和八张角色素材
- 支持替换角色图片、增加同状态变体和添加音效
- 配置和素材修改后即时生效

## 安装

本仓库已经包含可直接运行的 `lib/`，且没有需要在安装时执行的 `prepare` 构建脚本，因此可以直接从 GitHub 安装，不需要先发布到 npm，也不需要配置 `allowBuilds`。GitHub Release 的 `.tgz` 只是可选的备用分发方式。

### 安装前准备

DSH 使用 `pnpm` 管理每个 profile 的插件依赖。请打开一个新的 PowerShell，依次检查：

```powershell
node -v
npm -v
pnpm -v
dsh --version
```

如果只有 `pnpm` 显示“不是内部或外部命令”，安装 pnpm 10：

```powershell
npm install -g pnpm@10
```

安装完成后关闭并重新打开 PowerShell，再运行 `pnpm -v` 确认能显示版本号。如果 `node` 和 `npm` 也不存在，请先安装 Node.js LTS。

### Windows 推荐安装流程

1. 完全退出正在运行的 DSH Host。若终端正在运行 `dsh web`，按 `Ctrl + C` 停止。
2. 另外打开一个新的 PowerShell。不要在正在运行 `dsh web` 的窗口中输入安装命令；该窗口被服务器进程占用是正常现象。
3. 运行：

```powershell
dsh plugin --profile web add github:cyberangal/dsh-fish-widget
```

4. 安装成功后重新启动 DSH：

```powershell
dsh web
```

5. 刷新 DSH 网页。如果使用的 profile 不是 `web`，请把命令中的 `web` 换成实际 profile 名称。

### `dsh` 不是命令时

先关闭旧的 CMD/PowerShell，再打开新窗口重试。若 DSH 没有加入系统 PATH，请进入你的 DSH 安装目录，通过 pnpm 调用：

```powershell
cd D:\你的DSH安装目录
pnpm exec dsh plugin --profile web add github:cyberangal/dsh-fish-widget
pnpm exec dsh web
```

### 常见安装错误

| 提示 | 原因与处理 |
|---|---|
| `'pnpm' 不是内部或外部命令` | 运行 `npm install -g pnpm@10`，然后重新打开 PowerShell |
| `'dsh' 不是内部或外部命令` | 重新打开终端；仍不行就进入 DSH 安装目录使用 `pnpm exec dsh ...` |
| 运行 `dsh web` 后无法继续输入 | DSH 服务正在前台运行；另开 PowerShell，或按 `Ctrl + C` 停止 |
| 安装成功但看不到挂件 | 完全重启 DSH Host，并确认安装与启动使用的是同一个 profile |

### 本地目录安装

```powershell
dsh plugin --profile web add link:/绝对路径/dsh-fish-widget
```

## 使用

| 操作 | 效果 |
|---|---|
| 拖动 | 移动挂件，松手后吸附边缘 |
| 单击 | 摸一摸大肥鱼 |
| 双击 | 触发抓包反应 |
| 长按 | 压扁效果 |
| 右键 | 打开设置菜单 |

## 配置

默认配置文件：

```text
~/.dsh/dsh-fish/config.json
```

示例：

```json
{
  "enabled": true,
  "intercept": true,
  "bypassPrefix": "!!",
  "idleMinutes": 3,
  "lineIntervalMs": 4500,
  "name": "大肥鱼",
  "volume": 0.5,
  "sound": true
}
```

主要选项：

| 选项 | 说明 |
|---|---|
| `enabled` | 是否显示挂件 |
| `intercept` | 是否拦截对话并输出整活回复 |
| `bypassPrefix` | 单轮放行前缀，默认为 `!!` |
| `idleMinutes` | 进入长时间挂机状态前等待的分钟数 |
| `lineIntervalMs` | 自动更换气泡台词的间隔 |
| `name` | 气泡中显示的角色名 |
| `volume` | 音量，范围为 `0` 到 `1`，也可填 `"mute"` |
| `sound` | 是否启用音效 |

## 自定义图片和音效

默认素材目录：

```text
~/.dsh/dsh-fish/assets/
```

图片按以下名称放入目录：

```text
calm.webp
thinking.webp
eating.webp
idle.webp
done.webp
rua.webp
pressed.webp
shock.webp
```

图片支持 `png`、`jpg`、`jpeg`、`gif`、`webp`、`svg` 和 `avif`。同一情态可以增加数字后缀，例如 `thinking-2.png`，插件会随机切换。所有图片建议使用相同画布尺寸和角色位置，避免切换时跳动。

可选音效名称：

```text
press.mp3
release.mp3
rua.mp3
done.mp3
```

放入素材后刷新页面即可，不需要重新安装插件。

## 关闭与卸载

只关闭对话拦截：

```json
{
  "intercept": false
}
```

卸载插件：

```sh
dsh plugin --profile web remove dsh-fish-widget
```

## 隐私与网络

插件不会读取或上传 API Key、聊天记录、账号资料及其他个人文件。浏览器端只与当前 DSH 宿主提供的本地接口通信。用户配置和自定义素材保存在本机的 `~/.dsh/dsh-fish/` 中。

## 许可

- 插件代码使用 MIT License，见 [LICENSE](./LICENSE)。
- `assets/` 中的八张图片为本项目生成的配套素材，可随本插件使用和分发；请勿将其单独打包冒充原创素材出售。
