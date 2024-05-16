# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

A workflow action that cleans up images in the GitHub Container Registry
(ghcr.io)

It includes the following features:

- Automatic GitHub user/organization repository support
- Removing by tags, including untagging multi tagged images
- Multi architecture image support
- Keeping a number of untagged images
- Keeping a number of tagged images
- Supports wildcard syntax for tag/exclude tag options
- Validate multi architecture images have all platform digests packages

## Setup

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

| Option          | Required | Defaults         | Description                                                          |
| --------------- | :------: | ---------------- | -------------------------------------------------------------------- |
| token           |   yes    |                  | Token used to connect with ghcr.io and the package API               |
| tags            |    no    |                  | Comma separated list of tags to delete (supports wildcard syntax)    |
| exclude-tags    |    no    |                  | Comma separated list of tags to exclude (supports wildcard syntax)   |
| keep-n-untagged |    no    |                  | Number of untagged images to keep, sorted by date                    |
| keep-n-tagged   |    no    |                  | Number of tagged images to keep, sorted by date                      |
| dry-run         |    no    | false            | Simulate cleanup action, does not make changes (true/false)          |
| validate        |    no    | false            | Validate all multi architecture images in the registry after cleanup |
| owner           |    no    | project owner    | The repository owner, can be organization or user type               |
| name            |    no    | respository name | The package name                                                     |

If the tags, keep_n_untagged or keep_n_tagged options are not set then all
untagged images will be deleted.

The keep_n_untagged and keep_n_tagged options can not be set at the same time.

## Usage

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
          tags: mytag,mytag2
          token: ${{ secrets.GITHUB_TOKEN }}
```

If the tag links to an image with multiple tags, the action will unlink the tag
before is deleted, effetively untagging the image, but the underlying image will
not be deleted unless all tags are deleted.

### Keep 'n' untagged images cleanup (keep-n-untagged)

Keeps all tagged images and removes all untagged images except for the number of
"keep-n-untagged" images (sorted by date). It supports multi-architecture images
so the number of untagged images showing after running the action may be higher
then the keep-n-untagged value set.

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
are sorted by date. Additional exclude-tags values are not include the total
count.

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

### Override default repository/package

The default settings will use the current project to determine the owner and
package name but for cross project setup these can be overriden by setting owner
and name values.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          tags: mytag,mytag2
          owner: dataaxiom
          name: tiecd
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

Simulates how to keep 10 tagged images as well as the dev-image.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - name: 'Clean up docker images'
        uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-tagged: 10
          exclude-tags: dev
          dry-run: true
          token: ${{ secrets.GITHUB_TOKEN }}
```

## Notes

### Do a dry-run

Test the cleanup action first by setting the "dry-run: true" option on the
action and then reviewing the workflow log. This mode will simulate the cleanup
action but will not delete any images/packages.

### Package Restoration

GitHub has a package restoration API capability. The package IDs are printed in
the workflow log where the ghcr-cleanup-action is run.

[Restore Organization Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)

[Restore User Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)

### Ghost Images

Multi architecture images which have no underlying platform digest packages are
automatically removed for the keep-n-untagged and keep-n-tagged modes and not
include in their count. Partially corrupt images are not removed by default, use
the validate option to be able to identify then fix them.

### Validate Option

Set the validate option to true to enable a full scan of the image repository at
the end of the exectuion to check that all multi architecture images have no
missing platform images. Warnings will be outputed if there are missing
packages.
