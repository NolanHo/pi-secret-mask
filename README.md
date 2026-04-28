# pi-secret-mask

Chinese: [README_zh.md](README_zh.md)

`pi-secret-mask` masks newly observed secrets before Pi sends context to an LLM. The model sees a `secret_ref` marker and can use the secret by passing `${secret:psm_mask_*}` to a tool. The extension injects the real value at the tool boundary.

## Install

Install from GitHub:

```bash
pi install https://github.com/NolanHo/pi-secret-mask
```

Test without installing:

```bash
pi -e https://github.com/NolanHo/pi-secret-mask
```

Install from a local clone:

```bash
pi install ./pi-secret-mask
```

Install after npm publication:

```bash
pi install npm:pi-secret-mask
```

Runtime command:

```text
/secret-mask status
/secret-mask on
/secret-mask off
```

## Behavior

When enabled, the extension covers model-facing paths it controls:

1. `context`: masks normal conversation context before provider requests.
2. `before_provider_request`: scans the final provider payload as a last-line guard.
3. `session_before_compact`: if secrets are detected in compaction input, generates a masked summary instead of allowing default raw compaction.
4. `session_before_tree`: if secrets are detected in branch-summary input, generates a masked branch summary.
5. `tool_call`: replaces `${secret:psm_mask_*}` references in tool arguments with stored secret values.
6. `tool_result`: redacts injected secrets from successful tool outputs.

A masked value appears like this:

```text
OPENAI_API_KEY=[secret_ref id=psm_mask_0123456789abcdef01234567 label=secret chars=51. Use ${secret:psm_mask_0123456789abcdef01234567} in tool arguments to use this secret without reading it.]
```

The model can use the secret:

```json
{
  "command": "curl -H 'Authorization: Bearer ${secret:psm_mask_0123456789abcdef01234567}' https://api.example.com/me"
}
```

The model cannot read the secret through this extension. There is no recall tool for `psm_mask_*` artifacts.

## Artifact storage

Secrets are stored under:

```text
~/.pi/agent/pi-secret-mask/<session-id>/psm_mask_<hash>.json
```

Files are written with mode `0600`. IDs are deterministic within a session for the same pattern, source path, and secret value.

## Compaction and tree summaries

Normal `context` hooks do not imply that Pi's default compaction uses masked messages. This extension registers `session_before_compact` and `session_before_tree` to handle those model calls separately.

If compaction input contains no newly matched secrets, the extension lets Pi use default compaction. If compaction input contains matched secrets, the extension generates a masked summary. If masked summary generation fails, the extension cancels compaction rather than falling back to raw default compaction.

This protects secrets observed after the extension is loaded. Secrets already stored in an old session before installing this extension are out of scope.

## Matching rules

The extension matches these patterns.

| Rule | Matches | Examples |
|---|---|---|
| `private-key-block` | PEM private key blocks from `BEGIN ... PRIVATE KEY` to `END ... PRIVATE KEY` | RSA, EC, OpenSSH-style private key PEM blocks |
| `auth-header-token` | `Bearer`, `Basic`, or `Token` credentials, optionally after `Authorization:` or `Authorization=` | `Authorization: Bearer eyJ...`, `Token abcdef...` |
| `sensitive-query-param` | URL query parameters named `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier`, `code_challenge`, `state`, `nonce` | `?access_token=abc123...`, `&client_secret=s3cr3t...` |
| `secret-assignment` | Assignments whose key contains `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `CLIENT_SECRET`, or `AUTH` | `OPENAI_API_KEY=sk-...`, `password: hunter2long` |
| `json-secret-field` | Quoted JSON-like fields named `api_key`, `access_token`, `refresh_token`, `id_token`, `secret`, `password`, `private_key`, `client_secret`, `authorization` | `"api_key": "sk-..."`, `'password': '...'` |
| `known-token-prefix` | Common token prefixes | `sk-`, `sk-ant-`, `sk-proj-`, `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `npm_`, `pypi-`, `hf_`, `AIza`, `AKIA`, `ASIA` |

Length thresholds exist to reduce false positives:

- auth header token body: at least 16 chars
- sensitive query value: at least 8 chars
- assignment value: at least 8 chars
- known-prefix suffix: at least 12 chars after the prefix expression

## Custom matching config

You can add custom literal or regex patterns without editing package source.

Config files are loaded in this order:

1. Global: `$PI_CODING_AGENT_DIR/pi-secret-mask/config.json`, or `~/.pi/agent/pi-secret-mask/config.json` when `PI_CODING_AGENT_DIR` is unset.
2. Project: `<cwd>/.pi/secret-mask.json`.
3. Explicit: path from `PI_SECRET_MASK_CONFIG`.

Later files add patterns; they do not disable default patterns.

Literal match example for a user-specific password or token:

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

Regex match example where the full match is the secret:

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

Regex match example preserving a prefix and masking capture group 1:

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

Pattern fields:

| Field | Applies to | Meaning |
|---|---|---|
| `type` | all | `literal` or `regex` |
| `name` | all | Stable name used in artifact metadata |
| `label` | all | Human-readable marker label shown to the model |
| `value` | literal | Exact string to mask |
| `caseSensitive` | literal | Defaults to `true`; set `false` for case-insensitive literal matching |
| `pattern` | regex | JavaScript regular expression source string |
| `flags` | regex | JavaScript regex flags; `g` is added automatically, `y` is removed |
| `secretGroup` | regex | Capture group to store and mask; defaults to `0` for the full match |

## Common non-matches

The extension will not reliably catch:

- low-entropy or short secrets, for example `password=abc123`
- secrets whose key names do not contain the configured sensitive words
- custom token formats without a known prefix
- secrets split across multiple text blocks or multiple lines in unusual formats
- binary files or image content
- secrets already summarized into old compaction entries before this extension was loaded

If your environment uses a custom token format, add a literal or regex entry to the config file.

## Security boundary

This is context redaction, not a sandbox.

Out of scope:

- malicious or untrusted extensions running in the same Pi process
- filesystem-level isolation of artifact files
- raw secrets already present in session history before installation
- tools that echo injected secrets
- failing tool calls on Pi versions that ignore `tool_result` patches when `isError` is true

Successful tool results can be redacted by this extension, but some Pi versions discard `tool_result` modifications for failing tool calls. Avoid commands that echo secrets, `set -x`, verbose auth debug logs, and shell traces when using `${secret:...}` references.
