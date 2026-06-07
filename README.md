# Tokendance

Tokendance 是一个面向个人开发工作流的本地命令行 coding agent。项目仍处于分阶段开发中；当前 README 记录已经能从代码结构中确认的入口、配置和验收方式。

## 环境要求

- Windows PowerShell 5.1 或 PowerShell 7。
- Python 3.11 或更高版本。
- Git，供 `/diff`、`/review`、worktree 验收和源码安装使用。
- 可选：`pipx`，用于安装隔离的全局 `tokendance` 命令。

## 安装

从源码做 editable install，适合开发和本地验收：

```powershell
Set-Location C:\Users\29332\Desktop\TokenDanceCode
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e .
tokendance --version
tokendance doctor
```

如果只想安装全局命令，可以在仓库根目录运行：

```powershell
pipx install .
tokendance --version
```

如果 PowerShell 阻止激活虚拟环境，不需要修改全局执行策略；可以直接调用虚拟环境里的 Python：

```powershell
.\.venv\Scripts\python.exe -m pip install -e .
```

## Windows PowerShell 快速使用

```powershell
Set-Location C:\Users\29332\Desktop\TokenDanceCode
tokendance doctor
tokendance
```

进入交互 shell 后可用的 slash 命令包括：

```text
/help
/status
/mode work|teach
/permissions default|safe|auto|yolo
/config
/doctor
/memory
/transcript search <query>
/compact
/resume
/diff
/review
/revert latest
/quality <command>
/agents
/worktree list|create <name>|remove <name> [--discard]|keep <name>
/exit
```

顶层命令：

```powershell
tokendance --version
tokendance doctor
tokendance resume
tokendance resume <latest-session-id>
```

当前根命令默认使用本地 mock provider 回显普通消息；task/todo 和 subagent/worktree 工具已经注册到默认 runtime。自然语言是否触发这些工具，取决于所选 provider 是否发出对应 tool call；也可以通过单元测试、工具层或 `/agents`、`/worktree` slash 命令验收。

## 配置与 API key

Provider 读取环境变量中的 API key：

```powershell
$env:OPENAI_API_KEY = "sk-..."
$env:ANTHROPIC_API_KEY = "sk-ant-..."
```

只在当前 PowerShell 会话中设置 key 更适合本地验收，避免把密钥写入仓库或 transcript。若确实要写入用户环境变量，可使用 PowerShell 的 `[Environment]::SetEnvironmentVariable(...)`，但不要提交任何包含 key 的配置文件。

配置模型支持这些字段：

```toml
provider = "openai"          # openai 或 anthropic
model = "gpt-5.4"
permission_mode = "default"  # default、safe、auto、yolo
executor_backend = "local"   # local、venv、conda、docker、worktree
project_state = "local"      # local、global、disabled
```

在交互 shell 中运行 `/config` 可以查看当前上下文值。当前 CLI 默认值为 `provider=openai`、`model=gpt-5.4`、`permission_mode=default`。

## tokendance doctor

`tokendance doctor` 会输出本地环境基础信息：

```text
Python: ...
OS: ...
Shell: ...
CWD: ...
```

如果 doctor 能运行，说明 console script、Python 环境和基本导入路径可用。Stage 15 的后续验收应继续扩展它，让它报告 API key、Git、PowerShell 和配置文件问题。

## 权限模式

Tokendance 当前支持 `default`、`safe`、`auto`、`yolo` 四种权限模式：

- 工作区内读取：所有模式允许。
- 工作区外读取：需要确认。
- 工作区内写入：`safe` 需要确认，`default`、`auto`、`yolo` 允许。
- 工作区外写入：所有模式拒绝。
- PowerShell 命令：按风险分类处理，常见只读命令如 `Get-ChildItem`、`git status` 允许；未知命令需要确认；`Remove-Item`、`Set-ExecutionPolicy`、`git reset --hard`、`git clean -fdx` 等高风险命令拒绝。

注意：当前 `yolo` 不会绕过工作区外写入或高风险 PowerShell 拒绝规则。

## 常用测试命令

本项目测试以 `unittest` 为主：

```powershell
python -m unittest discover
python -m unittest discover -s tests\unit
python -m unittest discover -s tests\integration
python -m unittest tests.unit.cli.test_main
python -m unittest tests.unit.cli.test_commands
python -m unittest tests.unit.permissions.test_engine
python -m unittest tests.unit.tasks.test_task_store tests.unit.tasks.test_todo_store
python -m unittest tests.unit.agents.test_manager tests.unit.git.test_worktree tests.unit.tools.test_subagent
```

真实 provider 集成测试默认跳过。需要显式启用时，在有可用 API key 的 PowerShell 会话中设置：

```powershell
$env:TOKENDANCE_RUN_MODEL_INTEGRATION = "1"
$env:TOKENDANCE_OPENAI_TEST_MODEL = "gpt-5.4"
$env:TOKENDANCE_ANTHROPIC_TEST_MODEL = "claude-sonnet-4-5"
python -m unittest tests.integration.models.test_real_providers
```

## 本地状态位置

- 项目状态：`.tokendance\`
- session：`.tokendance\sessions\<session-id>\session.json`
- transcript：`.tokendance\sessions\<session-id>\transcript.jsonl`
- compact 摘要：`.tokendance\sessions\<session-id>\compact\`
- edit patch artifact：`.tokendance\sessions\<session-id>\edits\`
- task 状态：`.tokendance\tasks\`
- subagent 结果：`.tokendance\agents\`
- worktree 状态：`.tokendance\worktrees\`
- 用户级状态：`~\.tokendance\`

## 常见故障排查

- `tokendance` 不是可识别命令：确认已经运行 `python -m pip install -e .` 或 `pipx install .`，并重新打开 PowerShell。
- `Activate.ps1` 被策略阻止：直接使用 `.\.venv\Scripts\python.exe ...`，或只为当前进程使用受限的 PowerShell 绕过方式。
- `OPENAI_API_KEY is not configured` 或 `ANTHROPIC_API_KEY is not configured`：在当前 PowerShell 会话设置对应环境变量。
- `tokendance resume` 提示没有可恢复 session：先运行 `tokendance`，输入任意消息后用 `/exit` 正常退出。
- `/diff` 或 `/review` 报 Git 错误：确认当前目录是 Git 仓库，并且 Git 可在 PowerShell 中运行。
- `/worktree create <name>` 失败：确认当前目录是 Git 仓库，且 worktree 名只包含字母、数字、点、下划线或连字符。
- `Permission required`：当前操作命中了需要确认的规则；切换 `/permissions default|auto|yolo` 只影响工作区内写入，不会允许高风险 shell 命令。
- `Permission denied`：通常是工作区外写入或被拒绝的 PowerShell 命令；换到临时 worktree 或仓库内路径重新验收。
- `python -m unittest discover` 找不到包：确认在仓库根目录运行，并已安装 editable 包；也可临时设置 `$env:PYTHONPATH = "src"`。
- PowerShell 路径或参数含空格：用引号包裹路径，例如 `Set-Location "C:\path with spaces\project"`。

完整手动验收步骤见 `docs/端到端验收清单.md`。
