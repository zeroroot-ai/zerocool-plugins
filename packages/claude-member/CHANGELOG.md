# Changelog

## [0.4.2](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-member-v0.4.1...claude-member-v0.4.2) (2026-09-20)


### Bug Fixes

* **claude-member:** an RPC rejection never ends the member ([#78](https://github.com/zeroroot-ai/zerocool-plugins/issues/78)) ([1f3ea02](https://github.com/zeroroot-ai/zerocool-plugins/commit/1f3ea02161e9c5627d7e401daeec825ab7555054))

## [0.4.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-member-v0.4.0...claude-member-v0.4.1) (2026-09-20)


### Bug Fixes

* **claude-member:** default the state dir to the sandbox scratch path ([#76](https://github.com/zeroroot-ai/zerocool-plugins/issues/76)) ([2a21b1f](https://github.com/zeroroot-ai/zerocool-plugins/commit/2a21b1faefd9b0708d2ebd291726d508e4023270))

## [0.4.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-member-v0.3.2...claude-member-v0.4.0) (2026-09-20)


### Features

* **claude-member:** trust the platform CA handed in GIBSON_PLATFORM_CA_PEM ([#74](https://github.com/zeroroot-ai/zerocool-plugins/issues/74)) ([49143f1](https://github.com/zeroroot-ai/zerocool-plugins/commit/49143f17d5029b3c2064b51b012701adb5543f1a))


### Bug Fixes

* **claude-member:** authenticate the per-turn grant control plane ([#67](https://github.com/zeroroot-ai/zerocool-plugins/issues/67)) ([4b72ffd](https://github.com/zeroroot-ai/zerocool-plugins/commit/4b72ffd688325bb12a6224e5482aa09d06e108b6))
* **claude-member:** make the fake claude wait for stdin before it replays ([#63](https://github.com/zeroroot-ai/zerocool-plugins/issues/63)) ([73a2051](https://github.com/zeroroot-ai/zerocool-plugins/commit/73a2051f018c34e2e26241414a1fc693f9de8604))
* **claude-member:** refuse to start without the gVisor sandbox marker ([#66](https://github.com/zeroroot-ai/zerocool-plugins/issues/66)) ([1d4a5c8](https://github.com/zeroroot-ai/zerocool-plugins/commit/1d4a5c8066794f7122fdb70fedcc6493cc39ee7d))
* **claude-member:** scrub the capture machine from the transcript fixtures ([#62](https://github.com/zeroroot-ai/zerocool-plugins/issues/62)) ([8b64c8c](https://github.com/zeroroot-ai/zerocool-plugins/commit/8b64c8cadcbb9f3b0f7971b93d6bb52162fe95fa))

## Changelog

This repository restarted from a fresh baseline on 2026-09-06. Release notes before that date are archived offline and do not resolve on GitHub. release-please adds each release below this line.
