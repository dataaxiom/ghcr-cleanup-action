# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml)
![Coverage](./badges/coverage.svg)

A GitHub Action that deletes container images from the GitHub Container Registry
(ghcr.io). It safely handles multi-architecture images, attestation and Sigstore
cosign referrers, and supports flexible retention rules including tag patterns,
age, and "keep the N most recent" policies.

- [Quick start](#quick-start)
- [Examples](#examples)
- [Inputs](#inputs)
- [Option details](#option-details)
- [Token setup](#token-setup)
- [Operational notes](#operational-notes)
- [Cleanup algorithm](#cleanup-algorithm)

## Quick start

With no options set, the action deletes all untagged images from the current
repository's package. Always test with `dry-run: true` first.

```yaml
jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          dry-run: true
```

When `owner`, `repository`, and `package` are omitted, they default to the
current workflow's project. Deleting a multi-architecture image also deletes its
child platform images automatically.

## Examples

### Daily cleanup of untagged images

```yaml
name: Daily Image Cleanup
on:
  schedule:
    - cron: '30 1 * * *'
  workflow_dispatch:
jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
```

### Delete images when a pull request closes

```yaml
name: Cleanup PR Images
on:
  pull_request:
    types: [closed]
jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-tags: pr-${{ github.event.pull_request.number }}
```

### Keep the 3 most recent release candidates

```yaml
jobs:
  cleanup:
    runs-on: ubuntu-latest
    concurrency:
      group: cleanup-images
    permissions:
      packages: write
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          packages: 'tiecd/k8s'
          delete-tags: '*-rc*'
          keep-n-tagged: 3
```

### Keep 10 tagged images plus `dev`, drop everything else

```yaml
jobs:
  cleanup:
    runs-on: ubuntu-latest
    permissions:
      packages: write
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-tagged: 10
          exclude-tags: dev
          delete-untagged: true
          delete-partial-images: true
```

### Cross-repository cleanup with a regular expression

```yaml
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          token: ${{ secrets.MY_PAT }}
          owner: dataaxiom
          repository: tiecd
          package: tiecd
          delete-tags: '^mytag[12]$'
          use-regex: true
```

## Inputs

### Repository

| Option            | Default                | Description                                                                                         |
| ----------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `token`           | `secrets.GITHUB_TOKEN` | Token used to call ghcr.io and the Package API.                                                     |
| `owner`           | project owner          | GitHub user or organization that owns the package.                                                  |
| `repository`      | repository name        | GitHub repository the package belongs to.                                                           |
| `package(s)`      | repository name        | Comma-separated list of packages. Accepts `package` or `packages`. Wildcards require a PAT (below). |
| `expand-packages` | `false`                | Enable wildcard / regular expression matching on `package(s)`. Requires a PAT for `token`.          |

### Cleanup rules

| Option                   | Default    | Description                                                                                                    |
| ------------------------ | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `delete-tags`            |            | Comma-separated tags to delete (wildcards by default; regular expression if `use-regex: true`). Alias: `tags`. |
| `exclude-tags`           |            | Tags to always preserve. Takes priority over every other rule.                                                 |
| `delete-untagged`        | depends \* | Delete all untagged images.                                                                                    |
| `keep-n-untagged`        |            | Number of untagged images to keep, newest first.                                                               |
| `keep-n-tagged`          |            | Number of tagged images to keep, newest first.                                                                 |
| `delete-ghost-images`    | `false`    | Delete multi-arch images whose platform children are all missing.                                              |
| `delete-partial-images`  | `false`    | Delete multi-arch images whose platform children are partially missing.                                        |
| `delete-orphaned-images` | `false`    | Delete tagged referrer / cosign images whose parent no longer exists.                                          |
| `older-than`             |            | Only include images older than this interval (e.g. `5 days`, `6 months`, `1 year`).                            |

\* When no delete or keep options are set, `delete-untagged` defaults to `true`.

### Other

| Option           | Default                  | Description                                                                           |
| ---------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `use-regex`      | `false`                  | Treat `delete-tags`, `exclude-tags`, and `package(s)` as regular expression patterns. |
| `dry-run`        | `false`                  | Log everything that would be deleted without making changes.                          |
| `validate`       | `false`                  | After cleanup, verify all multi-arch images have their platform children.             |
| `registry-url`   | `https://ghcr.io/`       | Container registry URL.                                                               |
| `github-api-url` | `https://api.github.com` | GitHub API URL.                                                                       |
| `log-level`      | `info`                   | One of `error`, `warn`, `info`, `debug`.                                              |

### Conventions

- **Tag and package patterns** use
  [wildcard-match](https://github.com/axtgr/wildcard-match#readme) syntax (`?`,
  `*`, `**`) by default. Set `use-regex: true` to use regular expressions
  instead.
- **Tag values** may also be given as `sha256:` digest strings.
- **"Untagged"** refers to untagged _images_, not untagged GitHub _packages_.
  Cleaning up a multi-arch image may leave untagged platform packages visible in
  the GitHub UI.

## Option details

### `delete-tags`

Deletes the matching tags. If a tag points to an image that also has other tags,
the action unlinks the tag without deleting the underlying image — the image is
removed only once all its tags are gone.

### `exclude-tags`

Tags listed here are excluded from every other rule. Useful as a safety net
alongside `keep-n-tagged` or `older-than`.

```yaml
with:
  exclude-tags: dev,latest,pr*
  keep-n-tagged: 10
```

### `delete-untagged`

Deletes every untagged image. This is the default when no other rules are set,
but it can also be combined explicitly with any rule except `keep-n-untagged`.

### `keep-n-untagged`

Sorts untagged images by date and keeps the newest _N_. Setting it to `0` is
equivalent to `delete-untagged: true`. Cannot be combined with
`delete-untagged`.

### `keep-n-tagged`

Sorts tagged images by date and keeps the newest _N_. By default it operates on
all tagged images; combine with `delete-tags` to restrict it to a subset, or
with `exclude-tags` to protect specific tags.

### `older-than`

Restricts every delete and keep rule to images older than the given interval.
Accepts singular and plural units: `seconds`, `minutes`, `hours`, `days`,
`weeks`, `months`, `years` (see
[human-interval](https://github.com/agenda/human-interval)).

```yaml
with:
  older-than: 1 year
  keep-n-tagged: 10
```

The example keeps every image younger than a year, plus the 10 newest images
older than a year.

### `delete-ghost-images` / `delete-partial-images`

Clean up multi-architecture images whose platform children are missing. Run with
`validate: true` first to see which images would be affected.

### `delete-orphaned-images`

Finds tagged images named `sha256-…` whose corresponding `sha256:` digest no
longer exists, and deletes them. Catches stranded referrer and cosign artifacts.

## Token setup

### Injected `GITHUB_TOKEN` (default)

Grant the workflow `packages: write`:

```yaml
permissions:
  packages: write
```

Alternatively, set **Settings → Actions → General → Workflow permissions** to
"Read and write permissions" for the repository.

The package itself must also grant the workflow's repository the **Admin** role
under **Package Settings → Manage Actions access**.

### Personal Access Token (PAT)

A PAT is required when:

- the package lives in a different repository than the workflow, or
- `expand-packages: true` is used.

Create a **Classic** PAT (the GitHub Registry API does not yet support
fine-grained tokens) with both `write:packages` and `delete:packages` scopes,
and pass it via `token`:

```yaml
with:
  token: ${{ secrets.MY_PAT }}
```

## Operational notes

### Concurrency

The action is not safe to run in parallel against the same package. Use a GitHub
`concurrency` group on busy repositories:

```yaml
concurrency:
  group: cleanup-images
```

### Validation

`validate: true` performs a post-run scan of every multi-architecture image and
warns if any platform children are missing. It is informational — the action
does not fail on warnings.

### Multiple packages

`package` (or `packages`) accepts a comma-separated list. To match by wildcard
or regular expression, set `expand-packages: true` and use a PAT:

```yaml
with:
  packages: myimage*,someotherimage
  expand-packages: true
  token: ${{ secrets.MY_PAT }}
```

### Effect on download counts

The action downloads every manifest in the package to safely cross-reference
multi-arch relationships. GitHub records each manifest fetch as a download, so
the package's download count rises by one per run. The underlying image layers
are not downloaded.

### Restoring deleted packages

The workflow log prints the ID of every deleted package version. Use the GitHub
REST API to restore one:

- [Restore organization package version](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)
- [Restore user package version](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)

### Limitations

- **Public packages downloaded over 5,000 times** cannot be deleted by GitHub
  policy. There is currently no API to read the download count, so the only
  workaround is to add those tags to `exclude-tags`.

## Cleanup algorithm

For each package:

1. Load every package version and its manifest into a working set.
1. Remove child images (multi-arch platform layers, referrers, cosign).
1. Remove `exclude-tags` matches.
1. Remove anything younger than `older-than`.
1. Stage matches of `delete-tags`, `delete-ghost-images`,
   `delete-partial-images`, and `delete-orphaned-images` for deletion.
1. Apply `keep-n-tagged` and `keep-n-untagged` (or `delete-untagged`), staging
   the remainder for deletion.
1. Delete staged versions, including their children.
