# pkgs

Ewan's personal package monorepo — TypeScript/Svelte packages managed with [pnpm workspaces](https://pnpm.io/workspaces), Rust tools via [Cargo](https://doc.rust-lang.org/cargo/reference/workspaces.html) + [Nix flake](https://nixos.wiki/wiki/Flakes), and Python utilities.

Full documentation at **[docs.ewancroft.uk](https://docs.ewancroft.uk/projects/pkgs)**.

> 🧶 Also available on [Tangled](https://tangled.org/ewancroft.uk/pkgs)

## Packages

| Package                                                            | Description                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| [`@ewanc26/tid`](./packages/tid)                                   | Zero-dependency AT Protocol TID generation                           |
| [`@ewanc26/atproto`](./packages/atproto)                           | AT Protocol service layer                                            |
| [`@ewanc26/ui`](./packages/ui)                                     | Svelte UI component library                                          |
| [`@ewanc26/utils`](./packages/utils)                               | Shared utility functions                                             |
| [`@ewanc26/noise`](./packages/noise)                               | Deterministic value-noise generation                                 |
| [`@ewanc26/noise-avatar`](./packages/noise-avatar)                 | Noise-based avatar generation                                        |
| [`@ewanc26/bismuth`](./packages/bismuth)                           | Convert `pub.leaflet` / `site.standard.document` records to Markdown |
| [`@ewanc26/svelte-standard-site`](./packages/svelte-standard-site) | SvelteKit library for `site.standard.*` AT Protocol records          |
| [`@ewanc26/pds-landing`](./packages/pds-landing)                   | Svelte components for an AT Protocol PDS landing page                |
| [`@ewanc26/supporters`](./packages/supporters)                     | Ko-fi supporter display backed by AT Protocol                        |
| [`@ewanc26/wafrn-theme`](./packages/wafrn-theme)                   | WAFRN CSS theme — Catppuccin terminal aesthetic                      |
| [`@ewanc26/tangled-sync`](./packages/tangled-sync)                 | CLI for syncing GitHub repos to Tangled                              |
| [`malachite`](./packages/malachite)                                | Music listening history → AT Protocol scrobble importer (CLI)        |
| [`malachite-web`](./packages/malachite-web)                        | Music listening history → AT Protocol scrobble importer (web frontend, private) |
| [`nix-config-tools`](./packages/nix-config-tools)                  | Nix config management tools (Rust)                                   |
| [`llm-analyser`](./packages/llm-analyser)                          | `.docx` analysis with Ollama (Python)                                |
| [`@ewanc26/rock-tumbl`](./packages/rock-tumbl)                     | Starter package for rock-tumbl                                       |
| [`@ewanc26/croft-click-billing`](./packages/croft-click-billing)   | DID handshake, sessions, Stripe billing and entitlements for the croft.click managed service (private) |

## Try the tools

Several of these packages ship as browser-based apps at **[croft.click](https://croft.click)**. They need no separate account — you sign in with your AT Protocol identity — and your imported data goes from your machine to your own PDS, not to a croft.click database:

| Tool                                              | What it does                                                       |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| [Malachite](https://malachite.croft.click)        | Import Last.fm and Spotify listening history into Teal              |
| [Opal](https://opal.croft.click)                  | Convert Twitter, Mastodon, Threads, and Nostr posts to Bluesky      |
| [Jasper](https://jasper.croft.click)              | Import Instagram photos, stories, and videos to Grain or Spark      |
| [Bismuth](https://bismuth.croft.click)            | Convert ATProto richtext-block documents to Markdown                |
| [Tourmaline](https://tourmaline.croft.click)      | Analyse your Teal.fm scrobbles and find your listener archetype     |

### Hosted service vs. self-hosting

The hosted deployments at croft.click are run independently by one developer. Free hosted use is not guaranteed indefinitely, and heavier use of the official deployments may move to a paid plan to cover running costs. That pays for the **hosted service only**: the source stays AGPL-3.0-only and you can always self-host it for free. See [`MAINTENANCE.md`](./MAINTENANCE.md) for each tool's status and what to expect from support, and [the managed-service design](./docs/croft-click/billing-design.md) for how identity and billing work.

## Support

All of this is open source, built and maintained in my spare time. If any of it is useful to you, a one-off tip or a monthly sponsorship keeps it going. It's voluntary and separate from paying for hosted access:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-F16061?style=for-the-badge&logo=ko-fi&logoColor=white)](https://ko-fi.com/ewancroft)
[![GitHub Sponsors](https://img.shields.io/badge/GitHub%20Sponsors-30363D?style=for-the-badge&logo=github&logoColor=white)](https://github.com/sponsors/ewanc26)

Not up for that? Starring the repo, filing a good bug report, or pointing someone at [croft.click](https://croft.click) helps just as much.

## Licence

AGPL-3.0-only (TypeScript/Svelte) · MIT (Rust)

## Star History

<a href="https://www.star-history.com/?repos=ewanc26%2Fpkgs&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=ewanc26/pkgs&type=date&theme=dark&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=ewanc26/pkgs&type=date&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=ewanc26/pkgs&type=date&legend=bottom-right" />
 </picture>
</a>
