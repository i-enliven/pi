<p align="center">
  <img alt="Pi" src="packages/coding-agent/docs/images/exy.png" width="128">
</p>

# Pi

Pi is a minimal, extensible agent harness that you can make your own.

Adapt Pi to your workflows, not the other way around. Customize Pi with [extensions](packages/coding-agent/docs/extensions.md), [skills](packages/coding-agent/docs/skills.md), [prompt templates](packages/coding-agent/docs/prompt-templates.md), and [themes](packages/coding-agent/docs/themes.md). Bundle them as [Pi packages](packages/coding-agent/docs/packages.md).

Pi ships with powerful defaults but skips features like sub-agents and plan mode. Ask Pi to build what you want, or build a package that does it your way.

Use Pi [interactively](packages/coding-agent/docs/usage.md), automate it in [print or JSON mode](packages/coding-agent/docs/cli.md), control it over [RPC](packages/coding-agent/docs/rpc.md), or build apps with the [Pi TypeScript SDK](packages/coding-agent/docs/sdk.md).

## Install from source

This fork installs Pi locally from this repository. It requires Node.js 22.19 or newer, and it does not use the pi.dev installer or the npm registry.

```bash
git clone https://github.com/i-enliven/pi
cd pi
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
./pi-test.sh
```

`pi-test.sh` can be called from any directory and preserves the caller's working directory.

Start Pi in the directory where you want it to work:

```bash
cd /path/to/project
pi
```

Run `/login` inside Pi to connect your GitHub Copilot subscription, or set `COPILOT_GITHUB_TOKEN`. Compatible endpoints and local servers are configured through [`models.json`](packages/coding-agent/docs/models.md). Then give Pi a task.

See the [documentation](packages/coding-agent/docs/index.md) for full setup and usage instructions.

## Update

`pi update` updates a source checkout in place: it fetches the fork remote and, when the checkout is behind, pulls, reinstalls dependencies, and rebuilds. It refuses to touch a checkout with uncommitted changes or a branch that has diverged from the remote.

For a global install made from a clone, refresh the global package after the rebuild:

```bash
cd /path/to/pi
npm install -g --ignore-scripts ./packages/coding-agent
```

For a fresh install of the latest fork state, repeat the [install steps](#install-from-source).

## Development

Run Pi from a working checkout:

```bash
git clone https://github.com/i-enliven/pi
cd pi
npm install --ignore-scripts
./pi-test.sh
```

Before submitting changes, run:

```bash
npm run check
./test.sh
```

## How Pi is built

Pi is a monorepo of deep modules. The coding agent is built as a single esbuild bundle (`dist/bundle/cli.js`) so a local install has one entrypoint.

- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and generated artifacts.
- Local installs and builds use `--ignore-scripts`; Pi does not require dependency lifecycle scripts for a normal installation.
- Model data ships bundled with the repository; the optional runtime catalog overlay still reads upstream model metadata (cached offline after first fetch).

## License

MIT