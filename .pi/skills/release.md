---
name: release
description: Prepare, tag, publish, and verify pi fork releases, including the GitHub Release that pi update reads. Use for release preparation, local release smoke tests, tagging, and recovery.
---

# Releasing pi

Run repository commands from the repo root (two directories above this skill), unless instructed otherwise.

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

**This fork publishes nothing to npm.** A release is a version bump, a git tag, and a GitHub Release on `i-enliven/pi`. There is no release CI (`.github/` is deleted), so pushing a tag publishes git refs only. `pi update` and the startup version check read `releases/latest` from the fork repository (`PI_UPDATE_REPO` overrides it) and fall back to the `main` branch `packages/coding-agent/package.json` version while no release exists. The repository keeps no `CHANGELOG.md` files; write the release notes for the GitHub Release by hand.

1. **Local smoke test**: build an unreleased release and smoke test it from outside the repo (so it cannot resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"
   /tmp/pi-local-release/node/pi

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   /tmp/pi-local-release/bun/pi
   ```
   Verify both Node and Bun startup, model/account listing, interactive startup, and at least one real prompt with the intended default provider. The bare commands `/tmp/pi-local-release/node/pi` and `/tmp/pi-local-release/bun/pi` start interactive mode; run each in tmux, submit a prompt, and wait for the model reply before considering the interactive smoke test passed. Failures are release blockers unless the user explicitly accepts the risk.

   Load and follow [interactive-testing.md](interactive-testing.md) for the tmux workflow. Start each release binary from `/tmp`, not the repo root.

2. **Refresh the committed Nix model catalog** when model data changed: `npm run sync:nix-model-catalog`. The Nix build hydrates from `nix/model-catalog/models.all.json` without network access.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   The script bumps all package versions, regenerates release artifacts, runs `npm run check`, builds the packages, runs `./test.sh`, checks the packed coding-agent consumer install, commits `Release vX.Y.Z`, tags `vX.Y.Z`, then pushes `main` and the tag.

   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was installed recently. Review any lockfile or install lock diffs the release creates before push.

   If the test suite already passed in `npm run release:local` and only fails from machine load, `PI_RELEASE_SKIP_TESTS=1` skips `./test.sh` in the release script; checks and the packed install check still run. Use it only with the user's approval.

   Never rerun the release script after a tag was pushed.

4. **Publish the GitHub Release**: the tag alone does not create a release, and non-checkout installs only learn about a new version from `releases/latest`. Write the notes, then:
   ```bash
   gh release create v<X.Y.Z> --title "v<X.Y.Z>" --notes-file /tmp/notes.md
   ```
   State that the fork does not publish to npm and link the source install steps, as the `v1.1.0` release does. `npm run release:fix-links` rewrites floating or relative links in already-published release notes.

5. **Verify the release**:
   - Source checkout: in a clone that is behind the tag, `pi update` fetches the update remote (`fork`, `PI_UPDATE_REMOTE`, the tracked upstream, then `origin`), reports the commits behind, then runs `git pull --ff-only`, `npm install --ignore-scripts`, and `npm run build`.
   - Non-checkout install (a global install from a clone, or the packed installs under `/tmp/pi-local-release`): `pi update` prints the fork clone/build/install commands for the new version and renders the release body as the update note.

6. **If something is wrong after the tag is pushed**: do not rerun the release script or move the tag. Fix `main`, then ship the fix in the next release.