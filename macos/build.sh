#!/bin/sh
# Build the menu bar app and its widget into macos/build/.
#
#   ./build.sh            build "Claude Code Session Tracker.app"
#   ./build.sh install    build it, copy it to /Applications and open it
#
# Needs Xcode and XcodeGen (brew install xcodegen). Signs to run locally unless
# DEVELOPMENT_TEAM is set, in which case Xcode signs with that team.
set -eu

cd "$(dirname "$0")"
APP="Claude Code Session Tracker.app"

command -v xcodegen >/dev/null 2>&1 || { echo "XcodeGen is needed: brew install xcodegen" >&2; exit 1; }
xcodegen generate --quiet

action="${1:-}"
set -- -project SessionTracker.xcodeproj -scheme SessionTracker -configuration Release -destination generic/platform=macOS -derivedDataPath build/DerivedData -quiet
if [ -n "${DEVELOPMENT_TEAM:-}" ]; then
  set -- "$@" DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development"
fi
xcodebuild "$@" build

rm -rf "build/$APP"
cp -R "build/DerivedData/Build/Products/Release/$APP" "build/$APP"
echo "Built macos/build/$APP"

if [ "$action" = "install" ]; then
  osascript -e 'quit app "Claude Code Session Tracker"' >/dev/null 2>&1 || true
  rm -rf "/Applications/$APP"
  cp -R "build/$APP" "/Applications/$APP"
  open "/Applications/$APP"
  echo "Installed /Applications/$APP"
fi
