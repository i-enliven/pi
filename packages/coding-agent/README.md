# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](docs/extensions.md), [skills](docs/skills.md), [prompt templates](docs/prompt-templates.md), and [themes](docs/themes.md). Bundle them as [Pi packages](docs/packages.md).

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or build a package that does it your way.

Use Pi [interactively](docs/usage.md), automate it in [print or JSON mode](docs/cli.md), control it over [RPC](docs/rpc.md), or build apps with the [Pi TypeScript SDK](docs/sdk.md).

## Install from source

This fork installs Pi locally from this repository. It requires Node.js 22.19 or newer, and it does not use the pi.dev installer or the npm registry.

From the repository root:

```bash
npm install --ignore-scripts
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
```

Verify the installation:

```bash
pi --version
```

Alternatively, run Pi straight from the checkout without a global install:

```bash
../../pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

Run `/login` inside Pi to connect your GitHub Copilot subscription, or set `COPILOT_GITHUB_TOKEN`. Compatible endpoints and local servers are configured through [`models.json`](docs/models.md). Then give Pi a task.

See the [documentation](docs/index.md) for full setup and usage instructions.

## Update

`pi update` updates a source checkout in place: it fetches the fork remote and, when the checkout is behind, pulls, reinstalls dependencies, and rebuilds. It refuses to touch a checkout with uncommitted changes or a branch that has diverged from the remote.

For a global install made from a clone, refresh the global package after the rebuild:

```bash
cd /path/to/pi
npm install -g --ignore-scripts ./packages/coding-agent
```

## Development

Before submitting changes, run:

```bash
npm run check
./test.sh
```

## License

MIT