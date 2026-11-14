# Maintenance and support policy

The croft.click tools and the packages in this repository are built and
maintained independently by one developer, in limited time. This page sets
expectations so that everyone, including the maintainer, knows what to
count on.

## What you can rely on

- **The source stays free software.** The TypeScript/Svelte code is
  AGPL-3.0-only (Rust tools are MIT). You may self-host it under the
  licence's terms without paying anyone. Already-published releases will
  never be made retroactively proprietary or restricted.
- **The official hosted deployments at croft.click are a service, not a
  promise.** Free hosted operation is not guaranteed indefinitely. Some
  hosted features may need a paid plan to cover running costs (see
  [the managed-service design](./docs/croft-click/billing-design.md)).
  Paying is for using the official deployments, never for permission to run
  the code.
- Maintenance, support and new features are **best-effort**, unless a
  separate, explicit paid support arrangement says otherwise. A paid hosted
  plan covers using the service at its published limits. It does not by
  itself include bespoke development, priority support or feature requests.

## Issues and feature requests

- Opening an issue is welcome, but it does not create an obligation for it
  to be implemented.
- Feature requests may be declined or closed as `wontfix`, usually with a
  short reason.
- `help wanted` means a community contribution is welcome. It is the best
  way to get something done that the maintainer can't prioritise.
- Breakage caused by changes in third-party APIs and services (Bluesky,
  Teal, Grain, Spotify, Last.fm, Instagram and others) is fixed as
  maintainer time allows, roughly in order of how many people it affects.
- Security reports take priority over everything else. Please report them
  privately via GitHub's security advisory form rather than a public issue.

## Tool status

Each hosted tool is in one of three states:

- **Active**: bug fixes and discretionary feature development.
- **Maintenance**: compatibility, security and serious bug fixes only. New
  features are unlikely.
- **Archived**: no ongoing maintenance. The source remains available, and
  the hosted deployment may be switched off with advance notice.

A tool can move between states when continuing to maintain it is not
sustainable. Moves to Maintenance or Archived are announced in the repository
and on croft.click before they take effect.

| Tool                  | Package(s)                     | Hosted at                                                | Status |
| --------------------- | ------------------------------ | -------------------------------------------------------- | ------ |
| Malachite             | `malachite`, `malachite-web`   | [malachite.croft.click](https://malachite.croft.click)   | Active |
| Jasper                | `jasper`, `jasper-web`         | [jasper.croft.click](https://jasper.croft.click)         | Active |
| Bismuth               | `bismuth`, `bismuth-web`       | [bismuth.croft.click](https://bismuth.croft.click)       | Active |
| Opal                  | `opal`, `opal-web`             | [opal.croft.click](https://opal.croft.click)             | Active |
| rock-tumbl            | `rock-tumbl`, `rock-tumbl-web` | [rock-tumbl.croft.click](https://rock-tumbl.croft.click) | Active |
| Tourmaline            | `tourmaline`                   | [tourmaline.croft.click](https://tourmaline.croft.click) | Active |
| croft.click directory | `croft-click`                  | [croft.click](https://croft.click)                       | Active |

Hasharium and Devlog are listed on croft.click but are not developed in
this repository, so their status is set where they live.

## Supporting the work

Ko-fi tips and GitHub Sponsors remain **voluntary** support. They are a
thank-you, separate from buying access to the hosted service, and they
don't change what this policy promises.
