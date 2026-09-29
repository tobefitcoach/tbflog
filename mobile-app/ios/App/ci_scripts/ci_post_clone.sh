#!/bin/sh
# Xcode Cloud: node_modules is gitignored, but the Capacitor iOS project
# references packages inside it, so install it before Xcode resolves packages.
set -e

brew install node

cd "$CI_PRIMARY_REPOSITORY_PATH/mobile-app"
npm ci
