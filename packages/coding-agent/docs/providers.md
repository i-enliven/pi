# Providers

This fork ships one built-in provider, **GitHub Copilot**. Everything else is a [compatible endpoint](models.md#configure-a-compatible-endpoint) configured in `models.json`, a [provider extension](custom-provider.md), or a local [llama.cpp router](llama-cpp.md).

GitHub Copilot supports two authentication methods:

- Sign in through the device flow backed by OAuth (a Copilot subscription).
- Provide an API key through `COPILOT_GITHUB_TOKEN`.

Use `/login [provider]` to see the methods supported by a provider.

## Authenticate interactively

Run `/login` and select GitHub Copilot. Pi starts the device flow, prints the verification URL and one-time code, and saves the resulting credential in [`auth.json`](configuration.md#agent-directory).

Open the URL on any machine with a browser and enter the code. This works on remote and headless hosts where a browser cannot reach the Pi process.

Run `/logout` and select a provider to remove its stored credential. This does not unset environment variables, remove authentication from `models.json`, or revoke the credential at the provider.

`auth.json` can contain API keys and OAuth tokens. Keep it private and do not commit it.

## Use an API key from the environment

Environment variables are useful in CI and anywhere Pi should not store the key. Set the variable before starting Pi:

```bash
export COPILOT_GITHUB_TOKEN=ghp_...
pi
```

| Provider | Environment variable |
|---|---|
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

`GH_TOKEN` and `GITHUB_TOKEN` are read by the Copilot OAuth flow when it exchanges a GitHub account token, not as an API-key fallback.

A stored `auth.json` credential takes priority over the environment variable. Pi never falls back to the environment after a stored credential fails to refresh.

Compatible endpoints configured in `models.json` have no built-in environment variable. Resolve their keys through `$NAME` interpolation in `apiKey`, a stored credential, or an explicit `--api-key`. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint).

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in `auth.json` to a command prefixed with `!`:

```json
{
  "github-copilot": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'copilot'"
  }
}
```

Pi runs the command when the key is first needed and caches its standard output for the process lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until Pi restarts.

## Copilot model availability

The Copilot catalog lists the models your account can use. Models that your plan does not include, or that you have not enabled, are not offered in `/model`.

If a request fails with "The requested model is not supported", enable the model in VS Code: open Copilot Chat, click the model selector, select the model (warning icon), and click "Enable".

## Provider-scoped environment values

A stored API-key credential can include an `env` object. Its values take priority over the process environment for that provider, and are used to interpolate `apiKey` and header values from `models.json`:

```json
{
  "github-copilot": {
    "type": "api_key",
    "key": "$COPILOT_TOKEN",
    "env": {
      "COPILOT_TOKEN": "ghp_..."
    }
  }
}
```