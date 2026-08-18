# Changelog

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
