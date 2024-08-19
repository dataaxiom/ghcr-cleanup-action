# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

A workflow action that cleans up images in the GitHub Container Registry
(ghcr.io). Its focus is on supporting multi-architecture images.

It includes the following features:

- Automatic GitHub user/organization repository support
- Deleting images by tag names
- Deleting untagged images
- Keeping a number of untagged images
- Keeping a number of tagged images
- Untagging of multi-tagged images
- Multi-architecture image support
- Referrers/GitHub attestation support (OCIv1 tag approach)
- Supports wildcard syntax for tag delete/exclude options
- Retry and throttle support for the GitHub API calls
- Validation mode, verifying multi-architecture & referrers image contents

## Setup

### Setup token permissions

To allow the injected GITHUB_TOKEN to have access to delete the images it
requires its permissions to have been set correctly, either by:

1. In GitHub project Settings > Actions > General, set the Workflow permissions
   option to "Read and write permissions"
1. Set the permissions directly in the workflow by setting the packages value to
   write.

   ```yaml
   jobs:
     delete-untagged-images:
       name: Delete Untagged Images
       runs-on: ubuntu-latest
       permissions:
         packages: write
   ```

### Define the action

The most basic setup with no delete or keep options deletes all untagged images
from the repository. Untagged here means a top-level container image, not the
underlying parts of a multi-architecture image (which appear as untagged also).

To get started add the action definition to a workflow file.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          dry-run: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

The action calls both the registry (ghcr.io) and the GitHub Package APIs to
facilitate support for multi-architecture images. This is required to determine
the relationships between all the multi-architecture image contents. It
downloads the manifest information for all images and maps the contents to the
underlying packages, which appear as untagged in GitHub (as seen in the web
interface). To safely delete untagged images the action determines first if the
untagged package is actually in use by another image/package and skips these.
Likewise to delete an image it needs to delete all of the underlying packages.

### Do a dry-run first

It's recommended to test the cleanup action first by setting the `dry-run: true`
option on the action and then reviewing the workflow log. This mode will
simulate the cleanup action but will not delete any images/packages. This is
especially important when using a wildcard syntax or the older-than option to
select images.

## Action Options

### Repository Options

| Option     | Required | Defaults        | Description                                                      |
| ---------- | :------: | --------------- | ---------------------------------------------------------------- |
| token      |   yes    |                 | Token used to connect with ghcr.io and the Package API           |
| owner      |    no    | project owner   | The GitHub repository owner, can be an organization or user type |
| repository |    no    | repository name | The GitHub repository name                                       |
| package    |    no    | repository name | The GitHub repository package name to operate on                 |

If the owner, repository or package options are not set then the values are
automatically set from the project environment where the action is running.

### Clean-up Options

| Option                | Required | Defaults  | Description                                                                                             |
| --------------------- | :------: | --------- | ------------------------------------------------------------------------------------------------------- |
| delete-tags           |    no    |           | Comma-separated list of tags to delete (supports wildcard syntax), can be abbreviated as `tags`         |
| exclude-tags          |    no    |           | Comma-separated list of tags strictly to be preserved/excluded from deletion (supports wildcard syntax) |
| delete-untagged       |    no    | depends\* | Delete all untagged images                                                                              |
| keep-n-untagged       |    no    |           | Number of untagged images to keep, sorted by date, keeping the latest                                   |
| keep-n-tagged         |    no    |           | Number of tagged images to keep, sorted by date, keeping the latest                                     |
| delete-ghost-images   |    no    | false     | Delete multi-architecture images where all underlying platform images are missing                       |
| delete-partial-images |    no    | false     | Delete multi-architecture images where some (but not all) underlying platform images are missing        |
| older-than            |    no    |           | Only include images for processing that are older than this interval (eg 5 days, 6 months or 1 year)    |

\* If no delete or keep options are set on the action then the action defaults
the option `delete-untagged` to "true" and will delete all untagged images.

### Other Options

| Option    | Required | Defaults | Description                                                          |
| --------- | :------: | -------- | -------------------------------------------------------------------- |
| dry-run   |    no    | false    | Simulate a cleanup action but does not make any changes (true/false) |
| validate  |    no    | false    | Validate all multi-architecture images in the registry after cleanup |
| log-level |    no    | info     | The log level (error/warn/info/debug)                                |

## Delete Options

### `delete-tags`

Comma-separated list of tags to delete (supports a wildcard syntax). Can be
abbreviated as `tags`. Use this option to delete specific tags in the package
repository.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-tags: mytag*,dev # same as tags: mytag*,dev
          token: ${{ secrets.GITHUB_TOKEN }}
```

If the tag links to an image with multiple tags the action will unlink the tag
before is deleted, effectively untagging the image but the underlying image will
not be deleted (unless all of its other tags have been deleted also).

The option can make use of a simple wildcard syntax to match multiple images.
See the [wildcard-match](https://github.com/axtgr/wildcard-match#readme) project
for its syntax. It supports the ?, \* and \*\* wildcard characters.

### `delete-untagged`

This option is the same as the default mode, however, this option can be
combined with any of the other options (except for the `keep-n-untagged`)

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-untagged: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

### `exclude-tags`

This option is used to exclude tagged images from being deleted. Use it to
exclude tags when combined with other options. It takes priority over all other
options.

The option can make use of a simple wildcard syntax to match multiple images.
See the [wildcard-match](https://github.com/axtgr/wildcard-match#readme) project
for its syntax. It supports the ?, \* and \*\* wildcard characters.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          exclude-tags: dev,latest,pr*
          keep-n-tagged: 10
          token: ${{ secrets.GITHUB_TOKEN }}
```

### `older-than`

To limit the action to images that are older than a certain time this setting
can be used. Set this option to a relative date value from now. This option can
be used with all of the delete and keep options narrowing their scope to which
images they will process.

The syntax supports the following units in the plural and singular forms:
seconds, minutes, hours, days, weeks, months and years

The option uses a simple human-interval syntax to match images. See the
[human-interval](https://github.com/agenda/human-interval/tree/master) project
for more information.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          olden-than: 1 year
          keep-n-tagged: 10
          token: ${{ secrets.GITHUB_TOKEN }}
```

### `delete-ghost-images` and `delete-partial-images`

These options clean up invalid multi-architecture images. They are intended for
more as a one-time use in cleaning up repositories that have been corrupted.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-ghost-images: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Keep Options

### `keep-n-untagged`

Includes for deletion all untagged images but excludes (keeps) a number of them.
The value of this option sets the number of untagged images to keep. Untagged
images are sorted by date and the most recent untagged images are kept. May be
combined with other delete options (except the `delete-untagged` option).

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-untagged: 3
          token: ${{ secrets.GITHUB_TOKEN }}
```

Setting `keep-n-untagged` to 0 has the same effect as setting the
`delete-untagged` option to true, deleting all untagged images.

### `keep-n-tagged`

Includes for deletion all tagged images but excludes (keeps) a number of them.
The value of this option sets the number of tagged images to keep. Tagged images
are sorted by date and the most recent tagged images are kept. May be combined
with other delete options.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-tagged: 3
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Samples Action Setups

### Complex example `keep-n-tagged`

Simulates how to keep 10 tagged images as well as the dev image. Additionally
deletes all untagged images. Also removes multi-arch containers that are missing
some or all underlying packages.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - name: 'Clean up docker images'
        uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          dry-run: true
          keep-n-tagged: 10
          exclude-tags: dev
          delete-untagged: true
          delete-partial-images: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Delete an image when a pull request is closed

```yaml
name: Cleanup Pull Request Images
on:
  pull_request:
    types: [closed]
jobs:
  ghcr-cleanup-image:
    name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - name: Delete image
        uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          tags: pr-${{github.event.pull_request.number}}
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Daily image cleanup of untagged images

```yaml
name: Daily Image Cleanup
on:
  # every day at 01:30am
  schedule:
    - cron: '30 1 * * *'
  # or manually
  workflow_dispatch:
jobs:
  ghcr-cleanup-image:
    name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Override default owner/repository/package

The default settings will use the current project to determine the owner,
repository and package names but for cross-project and multiple package support
these can be overridden by setting the owner, repository and package options.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          tags: mytag,mytag2
          owner: dataaxiom
          repository: tiecd
          package: tiecd
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Operations

### Effect on image download counts

To ensure the integrity of all images in the package repository all of the image
manifests are required to be downloaded and cross referenced each time the
action is run. The effect of this is that it will increase the package download
count showing in GitHub for all packages by one. The action does not download
the underlying package itself, just the manifests. But GitHub uses that event to
mark it as a download.

### Concurrency

The action is not designed to be run in parallel. Due to the nature of the
cleanup process and determining what can be safely deleted it requires that no
other package publishing or deleting process is occurring at the same time. It's
recommended to use a GitHub concurrency group with this action in complex/busy
repositories.

### Package Restoration

GitHub has a package restoration API capability. The package IDs are printed in
the workflow log where the ghcr-cleanup-action is run.

[Restore Organization Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)

[Restore User Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)

### Validate Option

Set the `validate` option to true to enable a full scan of the image repository
at the end of the execution to check that all multi-architecture images have no
missing platform images. Warnings will be outputted if there are missing
packages.
