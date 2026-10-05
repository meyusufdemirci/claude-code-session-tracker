# Development

Requires Node 22.18+ to run from source, because `dev` and `test` load `.ts`
files directly and let Node strip the types. The published package is compiled
JavaScript and runs on Node 20+.

```sh
pnpm install
pnpm dev                       # run from source, watch mode
pnpm test                      # unit tests
pnpm test:watch                # re-run on change
pnpm test:coverage             # unit tests + a coverage report
pnpm build                     # tsc + copy web assets
pnpm typecheck                 # src and test
npm pack                       # -> claude-code-session-tracker-<version>.tgz
pnpm smoke ./claude-code-session-tracker-<version>.tgz pnpm
```

`test/` mirrors `src/` and runs on `node --test` with no runner, no config, and
no dependency — the same rule the package itself follows. Fixtures are real
files in a temp directory rather than a mocked `fs`, because what is worth
testing here are properties of real files: a multi-byte character cut by a chunk
boundary, a slug only the directory tree can disambiguate, a cache that turns on
mtime. `test/helpers/records.ts` holds the transcript shapes in one place, so
the day the `.jsonl` format changes, the failure is a named test rather than a
silent wrong number.

`pnpm smoke` installs the packed tarball into a temporary directory with the
package manager you name, then runs the installed binary against a fixture
transcript. It is what CI runs — Node 20/22/24 × npm/pnpm/yarn/bun on Linux,
plus npm on macOS and Windows — so a change that only works from source fails
before it ships.

Everything that parses a transcript lives in `src/sources/claude-code/`. The
`Source` interface in `src/sources/source.ts` is the seam a second tool
(Codex, Cursor) would plug into; `src/core/` knows nothing about Claude Code.

The menu bar app lives in `macos/` and is built with Xcode and
[XcodeGen](https://github.com/yonaskolb/XcodeGen); the Xcode project is generated,
not checked in.

```sh
brew install xcodegen          # once; Xcode itself is needed too
macos/build.sh                 # -> macos/build/Claude Code Session Tracker.app
macos/build.sh install         # builds it, copies it to /Applications and opens it
```

It takes its version from `package.json` and is signed to run locally; set
`DEVELOPMENT_TEAM` before `build.sh` to sign it with your own team. To have it run
a source checkout instead of the installed tracker:

```sh
defaults write com.meyusufdemirci.claude-code-session-tracker.app trackerCommand "node $PWD/src/cli.ts"
```

`menubar install` has two kinds of test. `test/menubar.test.ts` stands in for
`ditto`, `open` and the rest, so it runs on any machine and proves the order
things happen in. `scripts/menubar-check.mjs` is the other half, for a Mac: it
installs a zip you built with the real programs and checks the app starts, stays
up, and is replaced and removed cleanly. CI runs it on a macOS runner whenever the
app or the command changes.

```sh
ditto -c -k --keepParent "macos/build/Claude Code Session Tracker.app" app.zip
node scripts/menubar-check.mjs app.zip /tmp/Applications   # omit the folder to use /Applications
```

The Claude Code plugin lives in `plugin/`, and `.claude-plugin/marketplace.json` at
the root is what makes this repository a marketplace for it. Its two skills only
run the `status` and `open` commands, so `test/status.test.ts` and
`test/open.test.ts` are where their behaviour is tested, and `test/plugin.test.ts`
checks the plugin has not drifted from the package: same version, same command
names. To try it against a source checkout, put the build on your `PATH` and load
the folder:

```sh
pnpm build && npm link         # the skills run whatever `claude-code-session-tracker` resolves to
claude plugin validate --strict ./plugin
claude --plugin-dir ./plugin   # then /tracker:status
```

Releasing is a tag: `npm version <patch|minor|major>` then `git push --follow-tags`.
`npm version` gives the plugin the same version before it commits, and the release
stops at a tag whose plugin was left behind.
The release workflow builds the menu bar app first, writes its zip's checksum into
the package as `dist/menubar.json`, re-runs the checks, attaches the zip to a GitHub
release for the tag, publishes with npm provenance, and then moves the Homebrew tap
forward. The app goes up before npm does, so no published version ever points at an
app that is not there to download.

Two things follow from the checksum. A version that reached npm cannot be
re-released: the app never builds byte-identical twice, so a second run would
replace the zip that the published package vouches for, and the workflow stops
rather than do that. And a pre-release tag such as `v0.10.0-rc.1` is the way to try
a release end to end — it publishes to npm under `next` instead of `latest`, is
marked as a pre-release on GitHub, and leaves the Homebrew tap alone.

`pnpm formula` prints the Homebrew formula for a published version, rendered from
the tarball on npm — Homebrew wants a `sha256` of the exact file it will download
and npm only advertises a sha512, so the tarball is fetched and hashed rather than
described. Nothing `.rb` is committed here: the rendered formula lives in
[`meyusufdemirci/homebrew-tap`](https://github.com/meyusufdemirci/homebrew-tap),
pushed by `.github/workflows/homebrew.yml` once the version is on the registry and
once `brew install`, `brew test` and `brew audit --strict` have all passed on a
macOS runner. That workflow also runs on its own from the Actions tab, which is the
repair path when a release reaches npm but not the tap — an npm publish cannot be
taken back, so it must not require a second version to fix.

The push needs a `HOMEBREW_TAP_TOKEN` repository secret: a fine-grained PAT with
**Contents: read and write** on the tap repository, and nothing else.

```sh
pnpm formula                   # the formula for this package.json's version
pnpm formula --version latest  # for whatever npm currently serves
```

Project plan and phase breakdown: [`PLAN.md`](../PLAN.md).
