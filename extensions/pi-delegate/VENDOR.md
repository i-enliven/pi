# Vendored `@bermudi/pi-delegate` 0.5.0

Copied on 2026-10-10 from `~/.pi/agent/npm/node_modules/@bermudi/pi-delegate`, including the local fixes already applied there for this fork.

## How it loads

`package.json` declares `pi.extensions: ["./delegate.ts"]`, so Pi discovers it through the `.pi/extensions/*/package.json` manifest rule (`resolveExtensionEntries` in `packages/coding-agent/src/core/extensions/loader.ts`). `src/**` is imported by `delegate.ts` and is not discovered as extensions itself.

Runtime imports are limited to `node:*`, `typebox`, and the four host-provided `@i-enliven/pi-*` packages, which Pi aliases for extensions (`getAliases` in the same loader). No `node_modules` install is needed in this directory; the `devDependencies` block is upstream metadata only.

## Notes

- Do not replace this tree with a fresh `pi install` copy: that drops the fork fixes. Re-apply them when pulling upstream.
- Keep `npm:@bermudi/pi-delegate` out of `~/.pi/agent/settings.json`. If both copies load, tool names resolve first-wins (project extensions load before global, so this copy provides `delegate`, `delegate_ticket`, `delegate_session`), but the global copy's factory and event handlers still run twice.
- Project extensions load only after project trust is granted for this repo.