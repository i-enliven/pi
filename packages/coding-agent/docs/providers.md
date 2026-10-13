# Providers

Pi ships one built-in provider, **GitHub Copilot**. Every other model service is either a compatible endpoint configured in [`models.json`](models.md#configure-a-compatible-endpoint) or a provider registered by an [extension](custom-provider.md).

A provider declares the authentication methods it supports:

- Sign in through a browser or device flow backed by OAuth.
- Provide an API key.

Run `/login` and select a provider to see the methods it offers.

## Authenticate interactively

Run `/login` and select a provider. Pi guides you through its OAuth or API-key flow and saves the resulting credential in [`auth.json`](configuration.md#agent-directory).

On a remote or headless machine, an OAuth callback may not reach the local process. When prompted, paste the final redirect URL or authorization code back into Pi.

Run `/logout` and select a provider to remove its stored credential. This does not unset environment variables, remove authentication from `models.json`, or revoke the credential at the provider.

`auth.json` can contain API keys and OAuth tokens. Keep it private and do not commit it.

## Use an API key from the environment

Environment variables are useful in CI and anywhere Pi should not store the key. Set the variable before starting Pi:

```bash
export COPILOT_GITHUB_TOKEN=...
pi
```

| Provider | Environment variable |
|---|---|
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |

Endpoints configured in `models.json` read their key through that file's own `$NAME` or `${NAME}` interpolation, so a custom endpoint needs no reserved variable name. See [Load an API key from a command](#load-an-api-key-from-a-command).

A stored credential owns its provider: once Pi has saved a credential for a provider in `auth.json`, it does not consult the environment for that provider. Clear it with `/logout` to switch back.

## Provider-scoped environment values

A stored API-key credential can carry an `env` object. Its values take priority over the process environment for that provider:

```json
{
  "my-proxy": {
    "type": "api_key",
    "key": "...",
    "env": {
      "PI_CACHE_RETENTION": "long"
    }
  }
}
```

Use it for configuration a request needs but that should not leak into every other provider call.

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in `auth.json` to a command prefixed with `!`:

```json
{
  "github-copilot": {
    "type": "api_key",
    "key": "!op read 'op://Personal/GitHub Copilot/token'"
  }
}
```

Pi runs the command when the key is first needed and caches its standard output for the process lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until Pi restarts.

The same syntax works for the `apiKey` field of a `models.json` provider.

## Configure a compatible endpoint

When a service speaks one of the three protocols Pi implements, configure it in [`models.json`](configuration.md#agent-directory) instead of writing an extension:

| `api` | Protocol |
|---|---|
| `anthropic-messages` | Anthropic Messages |
| `openai-completions` | OpenAI Chat Completions |
| `openai-responses` | OpenAI Responses |

Any other `api` value is a schema error and Pi rejects the whole file. See [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint) for the file format, model metadata, and compatibility flags.

## Provider extensions

An extension registers a provider with `pi.registerProvider()`, and that provider then appears in `/login` next to the built-in one. Custom providers can define their own login flows, model discovery, and streaming. See [Custom Providers](custom-provider.md).

## Stale credential entries

`auth.json` entries are keyed by provider ID and are read only for providers Pi currently has registered. An entry for a provider Pi does not know about is ignored; Pi neither migrates nor deletes it. Remove such entries by hand.