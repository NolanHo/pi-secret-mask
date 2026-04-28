# pi-secret-mask

Chinese: [README_zh.md](README_zh.md)

`pi-secret-mask` is a Pi extension that masks secrets before they are sent to an LLM. In model-visible text, a secret is replaced with a marker such as `[secret_ref id=psm_mask_example ...]`. If the model later passes `${secret:psm_mask_example}` to a tool, the extension restores the real value only for that tool call.

## Install

Prerequisite: Pi is installed locally and the `pi` command works.

Install from GitHub:

```bash
pi install https://github.com/NolanHo/pi-secret-mask
```

Run Pi once with the extension loaded, without installing it permanently:

```bash
pi -e https://github.com/NolanHo/pi-secret-mask
```

Install from a local clone:

```bash
cd /path/to/pi-secret-mask
pi install .
```

Inside a Pi session, use:

```text
/secret-mask status
/secret-mask on
/secret-mask off
```

Masking is enabled by default.

## Behavior

When enabled, the extension masks secrets in model-facing text it controls:

1. Chat context sent to the model.
2. The final provider request, as a last safety pass.
3. Conversation summaries created during compaction.
4. Branch summaries.
5. Tool arguments that use `${secret:<id>}` references.
6. Successful tool outputs, where injected secrets are redacted again.

A masked value appears like this:

```text
OPENAI_API_KEY=[secret_ref id=psm_mask_example label=secret chars=51. Use ${secret:psm_mask_example} in tool arguments to use this secret without reading it.]
```

The model can use the secret by passing the reference to a tool:

```json
{
  "command": "curl -H 'Authorization: Bearer ${secret:psm_mask_example}' https://api.example.com/me"
}
```

This extension does not provide a command or tool that prints stored secrets back into chat. To support later tool calls, the raw secret is stored locally on disk under Pi's data directory.

## Artifact storage

Secrets are stored under:

```text
~/.pi/agent/pi-secret-mask/<session-id>/psm_mask_<hash>.json
```

Files are written with mode `0600`.

## Compaction and tree summaries

Pi may summarize earlier conversation turns and branch history. This extension attempts to mask secrets in those summaries too. If a summary contains a matched secret and the extension cannot produce a masked summary, it blocks summarization instead of letting the raw secret through.

This protects secrets observed after the extension is loaded. Secrets already stored in old summaries before installing this extension are out of scope.

## Matching rules

The extension matches these patterns.

| Rule | Matches | Examples |
|---|---|---|
| `private-key-block` | PEM private key blocks from `BEGIN ... PRIVATE KEY` to `END ... PRIVATE KEY` | RSA, EC, OpenSSH-style private key PEM blocks |
| `auth-header-token` | `Bearer`, `Basic`, or `Token` credentials, optionally after `Authorization:` or `Authorization=` | `Authorization: Bearer eyJ...`, `Token abcdef...` |
| `sensitive-query-param` | URL query parameters named `access_token`, `refresh_token`, `id_token`, `client_secret`, `code`, `code_verifier`, `code_challenge`, `state`, `nonce` | `?access_token=abc123...&client_secret=def456...` |
| `secret-assignment` | Assignments whose key contains `API_KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `PRIVATE_KEY`, `CLIENT_SECRET`, or `AUTH` | `OPENAI_API_KEY=sk-...`, `password: my-secret-password` |
| `json-secret-field` | Quoted JSON-like fields named `api_key`, `access_token`, `refresh_token`, `id_token`, `secret`, `password`, `private_key`, `client_secret`, `authorization` | `"api_key": "sk-..."`, `'password': '...'` |
| `known-token-prefix` | Common token prefixes | `sk-`, `sk-ant-`, `sk-proj-`, `ghp_`, `github_pat_`, `glpat-`, `xoxb-`, `npm_`, `pypi-`, `hf_`, `AIza`, `AKIA`, `ASIA` |

Length thresholds reduce false positives:

- auth header token body: at least 16 chars
- sensitive query value: at least 8 chars
- assignment value: at least 8 chars
- known-prefix suffix: at least 12 chars after the prefix expression

## Custom matching config

You can add custom literal or regex patterns without editing package source.

Config files are loaded in this order:

1. Global: `<Pi data dir>/pi-secret-mask/config.json`. The Pi data dir is `$PI_CODING_AGENT_DIR` if you override it; otherwise it defaults to `~/.pi/agent`.
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
- failing tool calls that expose injected secrets in error output

On some Pi versions, a failing tool call may still expose an injected secret in its error output. Avoid commands that echo secrets, shell tracing (`set -x`), or verbose auth/debug logging when using `${secret:...}` references.
