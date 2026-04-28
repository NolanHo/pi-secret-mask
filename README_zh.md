# pi-secret-mask

English: [README.md](README.md)

`pi-secret-mask` 会在 Pi 把上下文发给 LLM 之前遮蔽新出现的 secret. 模型只能看到 `secret_ref` 标记, 并且可以在工具参数里传入 `${secret:psm_mask_*}` 来使用 secret. 插件会在工具执行边界把真实值注入进去.

## 安装

从 GitHub 安装:

```bash
pi install https://github.com/NolanHo/pi-secret-mask
```

不安装直接测试:

```bash
pi -e https://github.com/NolanHo/pi-secret-mask
```

从本地 clone 安装:

```bash
pi install ./pi-secret-mask
```

发布到 npm 后安装:

```bash
pi install npm:pi-secret-mask
```

运行时命令:

```text
/secret-mask status
/secret-mask on
/secret-mask off
```

## 行为

启用后, 插件覆盖它能控制的 model-facing 路径:

1. `context`: 在普通 provider request 前遮蔽对话上下文.
2. `before_provider_request`: 在最终 provider payload 上再扫一遍, 作为最后防线.
3. `session_before_compact`: 如果 compaction 输入里发现 secret, 生成 masked summary, 不让默认 raw compaction 继续.
4. `session_before_tree`: 如果 branch summary 输入里发现 secret, 生成 masked branch summary.
5. `tool_call`: 把工具参数中的 `${secret:psm_mask_*}` 替换成本地保存的真实 secret.
6. `tool_result`: 从成功的工具输出里 redact 被注入过的 secret.

遮蔽后的值类似这样:

```text
OPENAI_API_KEY=[secret_ref id=psm_mask_0123456789abcdef01234567 label=secret chars=51. Use ${secret:psm_mask_0123456789abcdef01234567} in tool arguments to use this secret without reading it.]
```

模型可以使用 secret:

```json
{
  "command": "curl -H 'Authorization: Bearer ${secret:psm_mask_0123456789abcdef01234567}' https://api.example.com/me"
}
```

模型不能通过这个插件读取 secret. 插件不提供读取 `psm_mask_*` artifact 的 recall 工具.

## Artifact 存储

Secret 保存在:

```text
~/.pi/agent/pi-secret-mask/<session-id>/psm_mask_<hash>.json
```

文件用 `0600` 权限写入. 同一个 session 内, 相同 pattern, source path, secret value 会得到确定性的 artifact id.

## Compaction 和 tree summary

普通 `context` hook 不等于 Pi 默认 compaction 一定会使用 masked messages. 所以这个插件单独注册了 `session_before_compact` 和 `session_before_tree`, 处理这两类模型调用.

如果 compaction 输入没有新匹配到的 secret, 插件让 Pi 使用默认 compaction. 如果 compaction 输入包含匹配到的 secret, 插件生成 masked summary. 如果 masked summary 生成失败, 插件会取消 compaction, 不会 fallback 到默认 raw compaction.

这个保护从插件加载后开始生效. 安装插件之前已经写入旧 session 的 raw secret 不在保护范围内.

## 匹配规则

插件匹配以下模式.

| 规则 | 匹配内容 | 示例 |
|---|---|---|
| `private-key-block` | 从 `BEGIN ... PRIVATE KEY` 到 `END ... PRIVATE KEY` 的 PEM private key block | RSA, EC, OpenSSH-style private key PEM blocks |
| `auth-header-token` | `Bearer`, `Basic`, `Token` 凭证, 前面可以带 `Authorization:` 或 `Authorization=` | `Authorization: Bearer eyJ...`, `Token abcdef...` |
| `sensitive-query-param` | URL query 参数: `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier`, `code_challenge`, `state`, `nonce` | `?access_token=abc123...`, `&client_secret=s3cr3t...` |
| `secret-assignment` | key 名包含 `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `CLIENT_SECRET`, `AUTH` 的赋值 | `OPENAI_API_KEY=sk-...`, `password: hunter2long` |
| `json-secret-field` | quoted JSON-like 字段: `api_key`, `access_token`, `refresh_token`, `id_token`, `secret`, `password`, `private_key`, `client_secret`, `authorization` | `"api_key": "sk-..."`, `'password': '...'` |
| `known-token-prefix` | 常见 token prefix | `sk-`, `sk-ant-`, `sk-proj-`, `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `npm_`, `pypi-`, `hf_`, `AIza`, `AKIA`, `ASIA` |

为了降低误报, 规则带有长度阈值:

- auth header token body: 至少 16 个字符
- sensitive query value: 至少 8 个字符
- assignment value: 至少 8 个字符
- known-prefix suffix: prefix 表达式后至少 12 个字符

## 自定义匹配配置

你可以通过配置文件添加 literal 或 regex pattern, 不需要修改 package 源码.

配置文件按顺序加载:

1. 全局: `$PI_CODING_AGENT_DIR/pi-secret-mask/config.json`; 如果没有设置 `PI_CODING_AGENT_DIR`, 则使用 `~/.pi/agent/pi-secret-mask/config.json`.
2. 项目: `<cwd>/.pi/secret-mask.json`.
3. 显式指定: `PI_SECRET_MASK_CONFIG` 指向的路径.

后加载的文件会追加 pattern; 不会禁用默认 pattern.

Literal match 示例, 适合用户自己的密码或 token:

```json
{
  "patterns": [
    {
      "type": "literal",
      "name": "personal-db-password",
      "value": "correct horse battery staple",
      "label": "database password"
    }
  ]
}
```

Regex match 示例, 整个 match 都是 secret:

```json
{
  "patterns": [
    {
      "type": "regex",
      "name": "internal-token",
      "pattern": "INTERNAL_[A-Za-z0-9]{32}",
      "label": "internal token"
    }
  ]
}
```

Regex match 示例, 保留 prefix, 只 mask capture group 1:

```json
{
  "patterns": [
    {
      "type": "regex",
      "name": "legacy-password-field",
      "pattern": "legacy_password=([^\\s]+)",
      "secretGroup": 1,
      "label": "legacy password"
    }
  ]
}
```

字段说明:

| 字段 | 适用范围 | 含义 |
|---|---|---|
| `type` | all | `literal` 或 `regex` |
| `name` | all | 稳定名称, 写入 artifact metadata |
| `label` | all | marker 里展示给模型看的标签 |
| `value` | literal | 要 mask 的精确字符串 |
| `caseSensitive` | literal | 默认 `true`; 设为 `false` 后 literal 匹配不区分大小写 |
| `pattern` | regex | JavaScript 正则表达式 source string |
| `flags` | regex | JavaScript regex flags; 自动添加 `g`, 自动移除 `y` |
| `secretGroup` | regex | 要保存和 mask 的 capture group; 默认 `0`, 表示整个 match |

## 常见匹配不到的情况

插件不能稳定捕获:

- 低熵或很短的 secret, 例如 `password=abc123`
- key 名不包含上述敏感词的 secret
- 没有已知 prefix 的自定义 token 格式
- 被拆到多个 text block 里的 secret
- 特殊换行格式里的 secret
- 二进制文件或图片内容
- 插件加载前已经进入旧 compaction summary 的 secret

如果你的环境有自定义 token 格式, 在配置文件里添加 literal 或 regex pattern.

## 安全边界

这是 context redaction, 不是 sandbox.

不在范围内:

- 同一个 Pi 进程里运行的恶意或不可信 extension
- artifact 文件的文件系统级隔离
- 安装前已经存在于 session history 的 raw secret
- 工具主动 echo 注入的 secret
- 某些 Pi 版本里, `isError` 为 true 时会忽略 `tool_result` patch 的失败工具调用

成功的工具结果可以被这个插件 redact, 但某些 Pi 版本会丢弃失败工具调用的 `tool_result` 修改. 使用 `${secret:...}` 时避免 echo secret, `set -x`, verbose auth debug log, shell trace.
