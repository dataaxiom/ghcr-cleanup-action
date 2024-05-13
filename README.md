# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

A workflow action that cleans up images in the GitHub Container Registry
(ghcr.io)

It includes the following features:

- GitHub User and Organization code repository support
- Multi tag untagging support
- Multi architecture image support
- Supporting keeping a number of untagged images

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

| Option          | Required | Description                                            |
| --------------- | :------: | ------------------------------------------------------ |
| token           |   yes    | Token used to connect with ghcr.io and the package API |
| tags            |    no    | Comma sperated list of tags to delete                  |
| number-untagged |    no    | Number of untagged images to keep, sorted by date      |
| owner           |    no    | The repository owner, can be organization or user      |
| name            |    no    | The package name                                       |

If the tags or number_untagged options are not set then all untagged images will
be deleted.

The tags and number_untagged options can not be set at the same time.

## Usage

### Cleanup untagged images

To cleanup all untagged images in a image repository only the token is required
to be set. It will use the current repository information to setup the owner and
package name.

```yaml
steps:
  - name: ghcr.io Cleanup Action
    id: ghcr-clenaup-action
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          token: ${{secrets.GITHUB_TOKEN}}
```

### Cleanup tagged images

Set the tags option to delete specific tags

```yaml
jobs:
  - name: ghcr.io image cleanup sction
    id: ghcr-clenaup-action
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          tags: mytag,mytag2
          token: ${{secrets.GITHUB_TOKEN}}
```

If the tag links to an image with multiple tags, the action will unlink the tag
before is deleted, effetively untagging the image, but the underlying image will
not be deleted unless all tags are deleted.

### Cleanup 'n' untagged images

Cleans up untagged images but keeps the last "number-tagged" images. It supports
multi-architecture images so the number of untagged images showing after running
the action may be higher then the number-tagged value set.

```yaml
jobs:
  - name: ghcr.io image cleanup sction
    id: ghcr-clenaup-action
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          number-untagged: 3
          token: ${{secrets.GITHUB_TOKEN}}
```

### Delete image when Pull Reqeust is closed

```yaml
name: Cleanup Pull Request Images
on:
  pull_request:
    types: [closed]
jobs:
  ghcr-cleanup-image:
    name: ghcr.io image cleanup action
    runs-on: ubuntu-latest
    steps:
      - name: Delete image
        uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          tags: pr-${{github.event.pull_request.number}}
          token: ${{secrets.GITHUB_TOKEN}}
```

### Daily image cleanup

```yaml
name: Cleanup Untagged Images
on:
  # every day at 01:30am
  schedule:
    - cron: '30 1 * * *'
  # or manually
  workflow_dispatch:
jobs:
  ghcr-cleanup-image:
    name: Delete Untagged Images
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          token: ${{secrets.GITHUB_TOKEN}}
```

### Override default repository/package

The default settings will use the current project to determine the owner and
package name but for cross project setup these can be overriden by setting owner
and name values.

```yaml
jobs:
  - name: ghcr.io Cleanup Action
    id: ghcr-clenaup-action
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1.0.0
        with:
          tags: mytag,mytag2
          owner: dataaxiom
          name: tiecd
          token: ${{secrets.GITHUB_TOKEN}}
```
