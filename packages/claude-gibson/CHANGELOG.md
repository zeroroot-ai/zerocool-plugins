# Changelog

## [0.8.3](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.8.2...claude-gibson-v0.8.3) (2026-10-25)


### Bug Fixes

* clear the image gate, and let a tool lock fix release both images ([#165](https://github.com/zeroroot-ai/zerocool-plugins/issues/165)) ([38c8a3c](https://github.com/zeroroot-ai/zerocool-plugins/commit/38c8a3c7d251af2a63a7d6ba8cdfae485f60fd8c))

## [0.8.2](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.8.1...claude-gibson-v0.8.2) (2026-10-25)


### Bug Fixes

* **claude-member:** pin gibson-mcp 0.7.1 so the server never subscribes to the inbox ([#161](https://github.com/zeroroot-ai/zerocool-plugins/issues/161)) ([0b701f8](https://github.com/zeroroot-ai/zerocool-plugins/commit/0b701f845de39a05b3a9845f42083c747e119e88))

## [0.8.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.8.0...claude-gibson-v0.8.1) (2026-10-12)


### Bug Fixes

* **claude-member:** the image tool lock lives in the package, so a lock fix releases an image ([#134](https://github.com/zeroroot-ai/zerocool-plugins/issues/134)) ([eff5479](https://github.com/zeroroot-ai/zerocool-plugins/commit/eff5479d1e08bf2fdfe0ec57a74a0fad81baf903)), closes [#133](https://github.com/zeroroot-ai/zerocool-plugins/issues/133)

## [0.8.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.7.0...claude-gibson-v0.8.0) (2026-10-07)


### Features

* end-phase integration of zerocool-plugins, part 2 ([#129](https://github.com/zeroroot-ai/zerocool-plugins/issues/129)) ([d8fa6e0](https://github.com/zeroroot-ai/zerocool-plugins/commit/d8fa6e010754ad2c3af5bda0fbe9b07be9b94f1e))

## [0.7.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.6.2...claude-gibson-v0.7.0) (2026-10-06)


### Features

* end-phase integration of zerocool-plugins ([#126](https://github.com/zeroroot-ai/zerocool-plugins/issues/126)) ([be61ab0](https://github.com/zeroroot-ai/zerocool-plugins/commit/be61ab085168c4f9d4b50f6563a6b4e4d6254e5a))


### Bug Fixes

* delete the superseded claude runner, drop npm from both images, add knip ([#104](https://github.com/zeroroot-ai/zerocool-plugins/issues/104)) ([2394070](https://github.com/zeroroot-ai/zerocool-plugins/commit/2394070d80b8278de30a19c6833287bab4f9adc2)), closes [#102](https://github.com/zeroroot-ai/zerocool-plugins/issues/102)

## [0.6.2](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.6.1...claude-gibson-v0.6.2) (2026-09-20)


### Bug Fixes

* **deps:** sdk 0.13.0 and gibson-mcp 0.3.0 carry mission_run_id ([#80](https://github.com/zeroroot-ai/zerocool-plugins/issues/80)) ([766adfc](https://github.com/zeroroot-ai/zerocool-plugins/commit/766adfc3da877b7c81f46128b3c225c9b4f3ec6d))

## [0.6.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/claude-gibson-v0.6.0...claude-gibson-v0.6.1) (2026-09-20)


### Bug Fixes

* **deps:** pin gibson-mcp 0.2.1, the turn token server ([#72](https://github.com/zeroroot-ai/zerocool-plugins/issues/72)) ([a9c47c5](https://github.com/zeroroot-ai/zerocool-plugins/commit/a9c47c567f3f54e9a06947c7d9f4e6a4477324b5))
* pin every npx install path to an exact published version ([#65](https://github.com/zeroroot-ai/zerocool-plugins/issues/65)) ([bba1b31](https://github.com/zeroroot-ai/zerocool-plugins/commit/bba1b31f0be85f1cf4a029b045b3d691e7a79614))
* **rework:** move the hook version pin to a line release-please bumps ([#75](https://github.com/zeroroot-ai/zerocool-plugins/issues/75)) ([56d2cfb](https://github.com/zeroroot-ai/zerocool-plugins/commit/56d2cfb1ad10608651d607ff1d4001e61e2384fd))

## Changelog

This repository restarted from a fresh baseline on 2026-09-06. Release notes before that date are archived offline and do not resolve on GitHub. release-please adds each release below this line.
