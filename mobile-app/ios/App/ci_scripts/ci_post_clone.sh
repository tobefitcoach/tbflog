#!/bin/sh
# Xcode Cloud: node_modules is gitignored, but the Capacitor iOS project
# references packages inside it, so install it before Xcode resolves packages.
set -e

# Always the same Node major version, not "whatever is newest today" - a
# new Node release must never be able to break an app build on its own.
# node@22 is keg-only in Homebrew, so put it on the PATH explicitly.
brew install node@22
export PATH="$(brew --prefix node@22)/bin:$PATH"
node --version

cd "$CI_PRIMARY_REPOSITORY_PATH/mobile-app"
npm ci

# public/, config.xml and capacitor.config.json are generated (gitignored) by
# `cap sync`, and the app target's build phases expect them to exist.
npx cap sync ios
