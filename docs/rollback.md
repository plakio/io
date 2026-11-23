# Rollback

The OpenTUI/OpenCode build replaces the Pi-based build in `0.2.0`. If it must be rolled back:

## Homebrew

Keep the previous `io` bottle or formula revision available in the tap. Reinstall it with:

```bash
brew uninstall io
brew install plakio/tap/io@0.1
```

If the tap does not keep a versioned formula, extract the previous formula from the tap history:

```bash
brew extract --version=0.1.20 io plakio/tap
brew install plakio/tap/io@0.1.20
```

## From source

```bash
git checkout v0.1.20
npm ci --ignore-scripts
npm run build
./dist/cli.js --version
```

## Data

- The `0.2.0` build writes its sessions to IO's OpenCode database under `$XDG_DATA_HOME/io`.
- Pi session files under `$XDG_DATA_HOME/io/sessions` are not deleted by the import; they remain available to the old build.
- Pi `auth.json` is not deleted. `io auth import` only reads it.
- Reverting does not require undoing the import.

## Release notes

State the runtime change explicitly: `0.2.0` requires Bun 1.3.14+ for the binary, or Node.js 26.4+ for source. Pi-based `0.1.x` remains the rollback target until the new build has been validated on each platform.
