# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

A workflow action that cleans up images in the GitHub Container Registry
(ghcr.io)

It includes the following features:

- Automatic GitHub user/organization repository support
- Removing by tags, including untagging multi tagged images
- Multi architecture image support
- Referrers/Attestation support (OCIv1 tag approach)
- Keeping a number of untagged images
- Keeping a number of tagged images
- Supports wildcard syntax for tag/exclude tag options
- Multi architecture & Referrers image validation mode

## Setup

### Do a dry-run

Test the cleanup action first by setting the "dry-run: true" option on the
action and then reviewing the workflow log. This mode will simulate the cleanup
action but will not delete any images/packages. This is especially important
when using a wildcard syntax to select images.

### Token Permissions

To allow the injected GITHUB_TOKEN to have access to delete the images/packages
ensure it's permissions have been setup correctly, either by:

1. In project Settings > Actions > General set the Workflow permissions option
   to "Read and write permissions"
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

### Action Options

#### General Settings

| Option     | Required | Defaults        | Description                                            |
| ---------- | :------: | --------------- | ------------------------------------------------------ |
| token      |   yes    |                 | Token used to connect with ghcr.io and the package API |
| owner      |    no    | project owner   | The repository owner, can be organization or user type |
| repository |    no    | repository name | The repository name                                    |
| package    |    no    | repository name | The package name                                       |
| log-level  |    no    | warn            | The log level (error/warn/info/debug)                  |

#### Clean-up Options

| Option                | Required | Defaults  | Description                                                                                                |
| --------------------- | :------: | --------- | ---------------------------------------------------------------------------------------------------------- |
| delete-tags           |    no    |           | Comma separated list of tags to delete (supports wildcard syntax. Can abe abbreviated as `tags`)           |
| exclude-tags          |    no    |           | Commma separated list of tags strictly to be preserved / excluded from deletion (supports wildcard syntax) |
| keep-n-untagged       |    no    |           | Number of untagged images to keep, sorted by date                                                          |
| keep-n-tagged         |    no    |           | Number of tagged images to keep, sorted by date                                                            |
| delete-untagged       |    no    | depends\* | Delete untagged images (not belonging to multi-arch containers)                                            |
| delete-ghost-images   |    no    | false     | Delete multi architecture images where all underlying platform images are missing                          |
| delete-partial-images |    no    | false     | Delete multi architecture images where some (but not all) underlying platform images are missing           |

\* True when no other options set, else false

The keep-n-untagged and keep-n-tagged options can not be set at the same time.

## Main Execution Modes

### Delete all untagged images

To cleanup all untagged images in a image repository only the token is required
to be set. It will use the current repository information to setup the owner and
package name.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Delete specific tagged images

Set the tags option to delete specific tags

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-tags: mytag,mytag2 # same as tags: mytag,mytag2
          token: ${{ secrets.GITHUB_TOKEN }}
```

If the tag links to an image with multiple tags, the action will unlink the tag
before is deleted, effetively untagging the image, but the underlying image will
not be deleted unless all tags are deleted.

### Keep 'n' untagged images cleanup (keep-n-untagged)

Keeps all tagged images and removes all untagged images except for the number of
"keep-n-untagged" images (sorted by date). It supports multi-architecture images
so the number of untagged images showing after running the action may be higher
then the keep-n-untagged value set. May be combined with tags option to delete
those tags too.

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

### Keep 'n' tagged images cleanup (keep-n-tagged)

Keeps a number (keep-n-tagged) of tagged images and then deletes the rest. Tags
are sorted by date. The number to be kept does not include items that will
anyways be kept due to exclude-tags option. Example: If there are 100 tagged
images, and user sets keep-n-tagged: 3 and exclude-tags: a, b in total 5 images
will be kept

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

## Extra Samples

### Delete image when pull request is closed

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

### Daily image cleanup

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
repository and package name but for cross project and multiple package support
these can be overriden by setting owner, repository and package values.

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

### Tag Wildcard

The tags and exclude-tags options can use a wildcard syntax, using the ?, \* and
\*\* characters. (Utilizes the wildcard-match library)

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-tagged: 3
          exclude-tags: 'v*,dev,latest'
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Keep 10 tagged images and "dev" image, and dry-run

Simulates how to keep 10 tagged images as well as the dev-image. Additionally
deletes all untagged images (not belonging to multi-arch containers). Also
removes multi-arch containers that are missing some or all underlying packages.

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
          delete-ghost-images: true
          delete-partial-images: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Notes

### Package Restoration

GitHub has a package restoration API capability. The package IDs are printed in
the workflow log where the ghcr-cleanup-action is run.

[Restore Organization Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)

[Restore User Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)

### Ghost Images

Multi architecture images which have no underlying platform packages are
automatically removed for the keep-n-untagged and keep-n-tagged modes and not
included in their count. Partially corrupt images are not removed by default,
use the validate option to be able to identify and then fix them.

### Validate Option

Set the validate option to true to enable a full scan of the image repository at
the end of the execution to check that all multi architecture images have no
missing platform images. Warnings will be outputted if there are missing
packages.
