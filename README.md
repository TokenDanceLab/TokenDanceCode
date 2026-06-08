# TokenDanceCode

TokenDanceCode 是一个面向个人开发者的本地命令行 Coding Agent。

你可以在任意本地代码仓库中打开终端，运行 `tokendance`，然后让它阅读项目、修改文件、运行 PowerShell 命令、检查 Git diff、管理任务和 Todo，并把会话过程保存为 transcript。

它的目标体验接近 Claude Code / Codex CLI，但项目本身使用 Python 从零实现，优先适配 Windows 和 PowerShell。

包名和全局命令都是：

```powershell
tokendance
```

![image-20260608180914434](C:\Users\29332\AppData\Roaming\Typora\typora-user-images\image-20260608180914434.png)

## 主要功能

- 交互式终端 Coding Agent。
- 支持模型流式输出。
- 支持 Anthropic-compatible 模型供应商。
- 内置文件工具：`read_file`、`write_file`、`edit_file`、`glob`。
- 内置 patch 和 PowerShell 工具，并经过权限系统管控。
- 支持 slash commands：状态、配置、diff、review、quality、tasks、todo、transcript、memory、resume、worktree 等。
- 每次会话都会保存 JSONL transcript。
- Git 能力内置：diff、review、revert、quality gate、worktree。
- Windows / PowerShell 是一等支持环境。

## 环境要求

- Python 3.11 或更高版本。
- Git。
- Windows 下推荐使用 PowerShell。
- 如果要使用真实模型，需要一个 Anthropic-compatible API key。

如果没有配置 API key，`tokendance` 也可以启动，此时会使用 MockProvider，适合做安装冒烟测试。

## 从源码安装

克隆仓库：

```powershell
git clone https://github.com/TokenDanceLab/TokenDanceCode.git
cd TokenDanceCode
```

创建并激活虚拟环境：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
```

安装项目：

```powershell
python -m pip install -U pip
python -m pip install -e .
```

确认命令可用：

```powershell
tokendance --version
tokendance doctor
```

也可以用 `pipx` 安装为全局命令：

```powershell
pipx install .
tokendance doctor
```

如果你要参与开发，推荐使用虚拟环境加 editable install，也就是 `pip install -e .`。

## 配置模型

TokenDanceCode 当前在检测到 `ANTHROPIC_API_KEY` 时会自动启用真实模型。

配置可以放在以下位置：

- 当前 PowerShell 会话环境变量。
- 当前项目根目录的 `.env`。
- 全局 `~/.tokendance/.env`。

### 方式一：当前 PowerShell 会话

使用 Anthropic 官方接口：

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
$env:MODEL_ID = "claude-sonnet-4-6"
```

使用 Anthropic-compatible 第三方接口，例如 DeepSeek：

```powershell
$env:ANTHROPIC_API_KEY = "your-api-key"
$env:ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic"
$env:MODEL_ID = "deepseek-v4-pro"
```

### 方式二：项目 `.env`

在项目根目录创建 `.env`：

```env
ANTHROPIC_API_KEY=your-api-key
MODEL_ID=claude-sonnet-4-6
```

DeepSeek-compatible 示例：

```env
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
MODEL_ID=deepseek-v4-pro
```

不要把 `.env` 提交到 Git。仓库已经默认忽略它。

## 启动使用

在你想让 Agent 工作的代码仓库中运行：

```powershell
tokendance
```

启动后可以直接输入自然语言任务，例如：

```text
完整阅读这个项目
修复当前失败的测试
检查 git diff 并给我 review
帮我添加一个 README
```

退出会话：

```text
/exit
```

恢复最近的本地会话元数据：

```powershell
tokendance resume
```

## 常用 Slash Commands

在交互式 shell 中可以使用：

```text
/help
/status
/config
/doctor
/permissions default
/permissions safe
/permissions auto
/permissions yolo
/diff
/review
/quality python -m unittest discover tests
/tasks
/todo
/transcript search <query>
/memory
/compact
/resume
/worktree
/exit
```

权限模式说明：

- `default`：默认受保护模式。
- `safe`：写入和高风险操作更谨慎。
- `auto`：自动允许更多常规操作。
- `yolo`：限制最少，使用时要小心。

## 项目结构

```text
TokenDanceCode/
├── pyproject.toml
├── README.md
├── docs/
├── src/tokendance/
│   ├── cli/          # Typer 入口、交互 shell、renderer、slash commands
│   ├── core/         # runtime、session state、turn loop、events、recovery
│   ├── models/       # provider-neutral 类型和模型适配器
│   ├── tools/        # file、shell、patch、task、todo、subagent tools
│   ├── permissions/  # 权限模式和 PowerShell 风险检查
│   ├── execution/    # 命令执行层
│   ├── storage/      # transcript、JSONL、原子写、路径处理
│   ├── context/      # memory、compact、resume、transcript search
│   ├── tasks/        # 持久任务和会话 Todo
│   ├── git/          # git service、worktree、review、revert、quality
│   ├── agents/       # subagent manager、worker、reviewer
│   └── config/       # TOML 配置和环境密钥
└── tests/
    ├── unit/
    └── integration/
```

## 开发与测试

安装开发依赖：

```powershell
python -m pip install -e ".[dev]"
```

运行全部测试：

```powershell
python -m unittest discover tests
```

运行部分测试：

```powershell
python -m unittest tests.unit.cli.test_shell
python -m unittest tests.unit.core.test_turn_runner
python -m unittest tests.unit.models.test_provider_mapping
```

检查 CLI：

```powershell
tokendance doctor
```

## 给新用户的注意事项

- 在哪个目录运行 `tokendance`，哪个目录就是当前 workspace root。
- 会话 transcript 会保存到当前项目的 `.tokendance/` 下。
- `glob` 工具默认排除 `.git`、`.tokendance`、虚拟环境、缓存目录、build/dist、`node_modules` 和 `.env`。
- CLI 会对大工具输出做摘要，不会把完整大文件内容直接刷到终端。
- 真实模型集成测试默认跳过，需要显式配置相关环境变量后才会运行。

## 当前状态

TokenDanceCode 目前还是早期本地 Agent 实现，适合开发、测试和自用验证。

它还不是正式发布到 PyPI 的包。现阶段推荐从源码安装，或者在仓库根目录使用：

```powershell
pipx install .
```

后续可以继续补充正式发布流程、安装包、首次运行向导和更完整的配置命令。
