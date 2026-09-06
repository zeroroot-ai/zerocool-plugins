# Changelog

## [0.9.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.8.0...opencode-gibson-v0.9.0) (2026-09-01)


### Features

* **opencode:** the plugin becomes an adapter; the tools come from gibson-mcp ([#126](https://github.com/zeroroot-ai/zerocool-plugins/issues/126)) ([1cf714a](https://github.com/zeroroot-ai/zerocool-plugins/commit/1cf714aefaa0fa3086db33bf8e058959b3f08095)), closes [#103](https://github.com/zeroroot-ai/zerocool-plugins/issues/103)

## [0.8.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.7.0...opencode-gibson-v0.8.0) (2026-08-31)


### Features

* **watch:** name the checked-in Scan mission instead of building it ([#99](https://github.com/zeroroot-ai/zerocool-plugins/issues/99)) ([5dac712](https://github.com/zeroroot-ai/zerocool-plugins/commit/5dac712668b6d0e61cb978f6491fbe3a6ab9ca84))

## [0.7.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.6.0...opencode-gibson-v0.7.0) (2026-08-30)


### Features

* **agent:** finish the Fix — read findings in priority order, move their status ([#97](https://github.com/zeroroot-ai/zerocool-plugins/issues/97)) ([91ebf6a](https://github.com/zeroroot-ai/zerocool-plugins/commit/91ebf6a36b3f49da53cd653419aa3d9d1f3f4505))

## [0.6.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.5.0...opencode-gibson-v0.6.0) (2026-08-30)


### Features

* **agent:** the Fix — change the repository, open an auto-merging request, report the scan ([#94](https://github.com/zeroroot-ai/zerocool-plugins/issues/94)) ([a2286bd](https://github.com/zeroroot-ai/zerocool-plugins/commit/a2286bd3aa53816245deb971599b5b8ec81fb918)), closes [#89](https://github.com/zeroroot-ai/zerocool-plugins/issues/89)

## [0.5.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.4.0...opencode-gibson-v0.5.0) (2026-08-30)


### Features

* **agent:** always-on watch loop, one Scan mission per finished pipeline ([#92](https://github.com/zeroroot-ai/zerocool-plugins/issues/92)) ([109adb4](https://github.com/zeroroot-ai/zerocool-plugins/commit/109adb42db0112b69177fb726783887b004c058d))

## [0.4.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.3.1...opencode-gibson-v0.4.0) (2026-08-30)


### Features

* **agent:** source-analysis task, semgrep candidates triaged by the model ([#90](https://github.com/zeroroot-ai/zerocool-plugins/issues/90)) ([2ebfa27](https://github.com/zeroroot-ai/zerocool-plugins/commit/2ebfa2702d4af5c1802f475c5977bbf4b28eff34)), closes [#87](https://github.com/zeroroot-ai/zerocool-plugins/issues/87)

## [0.3.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.3.0...opencode-gibson-v0.3.1) (2026-08-29)


### Bug Fixes

* **opencode-gibson:** conform the sandboxed dispatch to gibson's env contract ([#79](https://github.com/zeroroot-ai/zerocool-plugins/issues/79)) ([79495c6](https://github.com/zeroroot-ai/zerocool-plugins/commit/79495c619bcd602b15b18460ae4c3a532e1ffe15))

## [0.3.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.2.2...opencode-gibson-v0.3.0) (2026-08-28)


### Features

* **opencode-gibson:** run zerocool as a sandboxed dispatched agent ([#72](https://github.com/zeroroot-ai/zerocool-plugins/issues/72)) ([ee6e76d](https://github.com/zeroroot-ai/zerocool-plugins/commit/ee6e76db20739f86acd23147bd473a6937a8a338))

## [0.2.2](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.2.1...opencode-gibson-v0.2.2) (2026-08-28)


### Bug Fixes

* **package:** declare the repository so provenance verifies ([#62](https://github.com/zeroroot-ai/zerocool-plugins/issues/62)) ([528af39](https://github.com/zeroroot-ai/zerocool-plugins/commit/528af3923d869ad04ced2ee24b28b375769cced1))

## [0.2.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.2.0...opencode-gibson-v0.2.1) (2026-08-19)


### Bug Fixes

* **deps:** install @zeroroot-ai/sdk from npm, not a git URL ([#54](https://github.com/zeroroot-ai/zerocool-plugins/issues/54)) ([03fd7c4](https://github.com/zeroroot-ai/zerocool-plugins/commit/03fd7c49720a4fe03c185f162cce0de975e86275))

## [0.2.0](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.1.1...opencode-gibson-v0.2.0) (2026-08-17)


### Features

* **agent:** serve kind=agent dispatched work by driving opencode headless ([#47](https://github.com/zeroroot-ai/zerocool-plugins/issues/47)) ([bc111bb](https://github.com/zeroroot-ai/zerocool-plugins/commit/bc111bb8c93d3e7fd13afd4b7532c5d33a7403b0))
* **knowledge:** a dispatched run reads with its task grant ([#49](https://github.com/zeroroot-ai/zerocool-plugins/issues/49)) ([f3f9f8f](https://github.com/zeroroot-ai/zerocool-plugins/commit/f3f9f8f2806914dd5c9f68db97eb672d47e65465)), closes [#48](https://github.com/zeroroot-ai/zerocool-plugins/issues/48)

## [0.1.1](https://github.com/zeroroot-ai/zerocool-plugins/compare/opencode-gibson-v0.1.0...opencode-gibson-v0.1.1) (2026-08-16)


### Bug Fixes

* **deps:** fetch @zerocool/sdk over public https, not a deploy key ([#42](https://github.com/zeroroot-ai/zerocool-plugins/issues/42)) ([e17eff7](https://github.com/zeroroot-ai/zerocool-plugins/commit/e17eff79a355249d5e37b5c2fee5d9f242764a5b)), closes [#26](https://github.com/zeroroot-ai/zerocool-plugins/issues/26)

## 0.1.0 (2026-08-16)


### Features

* findings, knowledge, Gibson tools, delegation and componentize ([#7](https://github.com/zeroroot-ai/zerocool-plugins/issues/7)-[#11](https://github.com/zeroroot-ai/zerocool-plugins/issues/11)) ([#23](https://github.com/zeroroot-ai/zerocool-plugins/issues/23)) ([094a656](https://github.com/zeroroot-ai/zerocool-plugins/commit/094a65638fe95f7a354960932e5d28f3d9e68813))
* **llm:** consume the streaming + tool-calling shim — Depth-1 completion ([#32](https://github.com/zeroroot-ai/zerocool-plugins/issues/32)) ([3cd4544](https://github.com/zeroroot-ai/zerocool-plugins/commit/3cd4544659e0e306e6c84b68f007e22c702205ef)), closes [#6](https://github.com/zeroroot-ai/zerocool-plugins/issues/6)
* serve dispatched tool work — zerocool-serve + http_probe ([#27](https://github.com/zeroroot-ai/zerocool-plugins/issues/27)) ([48eed16](https://github.com/zeroroot-ai/zerocool-plugins/commit/48eed16459340d365c25048f04facca9c2e8c3e7))
* **serve:** close out kind=tool dispatched mode — bin, README, harness seam ([#31](https://github.com/zeroroot-ai/zerocool-plugins/issues/31)) ([47ca3bc](https://github.com/zeroroot-ai/zerocool-plugins/commit/47ca3bc7fb8d14b64b4b05a34bc04a449afb541e)), closes [#14](https://github.com/zeroroot-ai/zerocool-plugins/issues/14)
* zero-config Gibson LLM provider via the config hook ([#22](https://github.com/zeroroot-ai/zerocool-plugins/issues/22)) ([cd9a02a](https://github.com/zeroroot-ai/zerocool-plugins/commit/cd9a02aa44829a531307290ee0f63abb1dc39041))


### Bug Fixes

* build main from its own lockfile, and add the repo's first CI ([#30](https://github.com/zeroroot-ai/zerocool-plugins/issues/30)) ([2abfb22](https://github.com/zeroroot-ai/zerocool-plugins/commit/2abfb227a2467e1b436d87b3506f799108ff4e1c))
* check in once, then run unattended ([#24](https://github.com/zeroroot-ai/zerocool-plugins/issues/24)) ([305441e](https://github.com/zeroroot-ai/zerocool-plugins/commit/305441ebe0a97c4fac1964fa21aea40b0798211f))
* **llm:** bump the SDK pin so a tool result survives the second step ([#39](https://github.com/zeroroot-ai/zerocool-plugins/issues/39)) ([eab4afb](https://github.com/zeroroot-ai/zerocool-plugins/commit/eab4afb6591b0d35a2be39ac73a8e544ecc50bd1)), closes [#6](https://github.com/zeroroot-ai/zerocool-plugins/issues/6)
