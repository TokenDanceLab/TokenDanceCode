# TokenDanceCode Tool Reference

Built-in tools registered in the default tool registry. Each tool includes a description, input schema, output format, risk level, concurrency, and example usage.

## echo

Returns input text unchanged. Used for runtime and SDK smoke tests.

- **Risk**: read
- **Concurrency**: parallel_safe
- **Permission (default)**: allowed in all modes

### Input

```json
{ "text": "string" }
```

### Output

```json
{ "text": "string" }
```

### Example

```json
{ "name": "echo", "input": { "text": "hello world" } }
```

---

## read_file

Read a UTF-8 workspace file after path and secret-like subject checks.

- **Risk**: read
- **Concurrency**: parallel_safe
- **Subject**: workspace_path from `path` input field

### Input

```json
{ "path": "relative/path/to/file.txt" }
```

### Output

```json
{ "path": "relative/path/to/file.txt", "content": "file contents" }
```

### Notes

- Path must be relative and stay under the session workspace.
- Secret-like paths (`.env`, files containing `secret`, `token`, `credential`, `private_key`) require approval or are denied in safe mode.
- Absolute paths and path traversal (`..`) are rejected.

---

## write_file

Write UTF-8 content to a workspace file after path and permission checks.

- **Risk**: write
- **Concurrency**: exclusive
- **Subject**: workspace_path from `path` input field

### Input

```json
{ "path": "relative/path/to/file.txt", "content": "new file contents" }
```

### Output

```json
{ "path": "relative/path/to/file.txt", "bytes": 18 }
```

### Notes

- Creates parent directories if they do not exist.
- Same path restrictions as `read_file` apply.
- Requires approval in default and safe modes.

---

## edit_file

Perform exact-string replacement in a file. The `old_string` must match exactly and be unique within the file.

- **Risk**: write
- **Concurrency**: exclusive
- **Subject**: workspace_path from `path` input field

### Input

```json
{
  "path": "relative/path/to/file.txt",
  "old_string": "text to find",
  "new_string": "replacement text",
  "replace_all": false
}
```

### Output

```json
{ "path": "relative/path/to/file.txt", "replacements": 1 }
```

### Notes

- `replace_all` defaults to `false`. When `false`, the old_string must appear exactly once.
- When `replace_all` is `true`, all occurrences are replaced and `replacements` reflects the count.
- Same path restrictions as `read_file` apply.

---

## glob

Find files matching a glob pattern. Returns paths sorted by modification time (most recent first).

- **Risk**: read
- **Concurrency**: parallel_safe
- **Subject**: workspace_path from `path` input field (directory accepted)

### Input

```json
{ "path": ".", "pattern": "**/*.rs" }
```

### Output

```json
{ "files": ["src/main.rs", "src/lib.rs"], "count": 2 }
```

### Notes

- `path` defaults to `.` (current directory).
- Results are limited to 500 files.
- Skips `.git`, `target`, and `node_modules` directories.

---

## grep

Search file contents using regex patterns. Supports content, files_with_matches, and count output modes.

- **Risk**: read
- **Concurrency**: parallel_safe
- **Subject**: workspace_path from `path` input field (directory accepted)

### Input

```json
{
  "path": ".",
  "pattern": "fn main",
  "output_mode": "content",
  "glob": "*.rs",
  "head_limit": 200
}
```

### Output (content mode)

```json
{
  "matches": ["src/main.rs:1:fn main() {"],
  "count": 1
}
```

### Output (files_with_matches mode)

```json
{ "files": ["src/main.rs"], "count": 1 }
```

### Output (count mode)

```json
{
  "entries": [{ "file": "src/main.rs", "count": 1 }],
  "total_files": 1
}
```

### Notes

- `path` defaults to `.`.
- `output_mode` defaults to `content`. Options: `content`, `files_with_matches`, `count`.
- `glob` is an optional file filter (e.g. `*.rs`).
- `head_limit` defaults to 200.
- Uses the `regex` crate for pattern matching.

---

## run_powershell

Execute a PowerShell command after destructive-command classification.

- **Risk**: shell
- **Concurrency**: exclusive
- **Subject**: powershell_command from `command` input field

### Input

```json
{
  "command": "Write-Output hello",
  "timeout": 120,
  "run_in_background": false
}
```

### Output

```json
{
  "command": "Write-Output hello",
  "stdout": "hello\r\n",
  "stderr": "",
  "exit_code": 0,
  "success": true
}
```

### Notes

- Destructive commands (`Remove-Item`, `rm`, `del /s`, `erase /s`, `Clear-Content`, `Format-Volume`, `Stop-Computer`) are hard-denied in every permission mode, including Yolo.
- `timeout` defaults to 120 seconds, capped at 600 seconds.
- `run_in_background` returns a placeholder response (background execution not yet implemented).
- Requires approval in default and auto modes. Denied in safe mode. Allowed in Yolo mode.
