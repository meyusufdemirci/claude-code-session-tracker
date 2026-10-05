# Menu bar and widget (macOS)

`menubar install` downloads the app, puts it in `/Applications` — or in
`~/Applications` where that is not yours to write to — and opens it. It needs
macOS 14 or later. Run it again after updating the tracker to bring the app to the
same version; `menubar status` says when the two differ, and `menubar uninstall`
removes it.

- **What it downloads** is the app built by the same release as the copy of the
  tracker you ran, from that version's
  [GitHub release](https://github.com/meyusufdemirci/claude-code-session-tracker/releases)
  and no other. The package carries that zip's SHA-256, and anything that does not
  match is refused before it is unpacked.
- **It is not signed with an Apple Developer ID**, only to run locally. macOS asks
  about an unsigned app when a browser has marked it as downloaded, and this is
  fetched by the command you ran, so it opens without a prompt. macOS may ask about
  the login item or the widget again after an update, since each build is signed
  afresh. To run only what you compiled, build it yourself — see
  [Development](development.md).
- **The tracker still has to be installed**, since the app runs it rather than
  containing it. A copy fetched by `npx` is gone when its cache is cleared, so
  `--with-tracker` installs one that stays; without it, the panel offers
  **Install and start**, described below. If the tracker's install fails, the app
  is not installed either.
- **On** starts `claude-code-session-tracker --no-open`, found through your login
  shell's `PATH`, and its output goes to the same log as `autostart`. Where
  `autostart on` has been run, it starts that copy instead, so the tracker that
  comes back is the one that was running. When the
  tracker is not installed, the panel says so and offers **Install and start**,
  which runs `brew install meyusufdemirci/tap/claude-code-session-tracker` — or
  `npm install -g claude-code-session-tracker` where there is no Homebrew — and
  turns it on once that is done.
- **Off** stops whichever copy is answering — one the app started, one `autostart`
  started, or one left running in a terminal.
- The switch is remembered: quit the app with the tracker on, and it turns it back
  on the next time it opens. Left off, it stays off: the copy `autostart` brings
  up at login is stopped again when the app opens. **Open at login** in the panel
  adds the app to Login Items.
- The widget reads the tracker on loopback every five minutes. It cannot start a
  process from its sandbox, so clicking it while the tracker is off asks the app to
  start it; clicking it while it runs opens the page.
