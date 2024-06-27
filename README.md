# ghcr.io Repository Cleanup Action

[![GitHub Super-Linter](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/jenskeiner/ghcr-container-repository-cleanup-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

A workflow action that deletes obsolete tags and versions from a GitHub
Container Registry (ghcr.io) package repository.

This action is originally based on
[Ghcr Cleanup Action](https://github.com/dataaxiom/ghcr-cleanup-action), but has
different semantics.

Includes the following features:

- Automatic GitHub user/organization repository support.
- Deleting images by tags that match a regular expression.
- Keeping images by tags that match a regular expression.
- Keeping a number of most recent remaining tags.
- Keeping a number of most recent remaining untagged images.
- Multi-architecture and attestation support.
- Deletion by tag also deletes all reachable child images.
- Reachable child images are only deleted if not reachable through any excluded
  tag.

## Setup

### Token Permissions

THe injected GITHUB_TOKEN needs permissions to delete images/package versions
from the package repository. Ensure permissions are set up correctly:

- In project Settings > Actions > General set the Workflow permissions option to
  "Read and write permissions", or
- Set the permissions directly in the workflow by setting the packages value to
  write.

  ```yaml
  jobs:
    delete-package-versions:
      name: Delete Package Versions
      runs-on: ubuntu-latest
      permissions:
        packages: write
  ```

### Action Options

| Option          | Required | Defaults        | Description                                                 |
| --------------- | :------: | --------------- | ----------------------------------------------------------- |
| token           |   yes    |                 | Token used to connect with `ghcr.io` and the packages API   |
| owner           |    no    | project owner   | The repository owner, can be organization or user type      |
| repository      |    no    | repository name | The repository name                                         |
| package         |    no    | repository name | The package name                                            |
| include-tags    |    no    |                 | Regular expression matching tags to delete                  |
| exclude-tags    |    no    |                 | Regular expression matching tags to keep                    |
| keep-n-tagged   |    no    |                 | Number of remaining tags to keep, sorted by date            |
| keep-n-untagged |    no    |                 | Number of remaining untagged images to keep, sorted by date |
| dry-run         |    no    | false           | Wheter to simulate cleanup action without actual deletion   |

## Determining the tags and versions to delete

The action collects tags and package versions to delete or to keep in separate
sets, according to the specified options. If an option is not given, the
relevant logic behind it is not executed and thus does not affect any of these
sets.

Finally, all collected tags and images to delete are removed from the package
repository, unless they are included in the sets of tags or images that should
be kept.

Rationale: The same image may be referenced by different tagged
(multi-architecture) images. If one parent image should be deleted while the
other should be kept, according to the `include-tags` and `exclude-tags` regular
expressions, then the child image should be kept to maintain the integrity of
the tagged image that is kept.

### Included tags

If the option `include-tags` is set, it is used as a regular expression to
determine tags that should be deleted. Additionally, all images that are
reachable from a matching tag (including the image that holds the tag itself)
are added to the set of images to delete.

### Excluded tags

If the option `exclude-tags` is set, then similarly to the `tags` option, the
regular expression determines the tags that should be kept. Also, all reachable
images are added to the set of images to keep.

Note that the set of tags (images) to delete and keep may overlap.

### Keeping the most recent remaining tags

If the option `keep-n-tagged` is set, then all tags not already affected by the
`include-tags` or `exclude-tags` option are ordered by date and the most recent
`keep-n-tagged` tags are added to the set of tags to keep. Likewise, all
reachabe images are added to the set of images to keep.

All remaining tags, but not their reachable images, are added to the set of tags
to delete.

### Keeping the most recent untagged images

If the option `keep-n-untagged` is set, then all images not yet excluded from
deletion by the options `include-tags`, `exclude-tags`, or `keep-n-tagged` are
ordered by date and the most recent `keep-n-untagged` images are added to the
set of images to keep. The remaining images are added to the set of images to
delete.

### Deletion

When all tags and images to delete or keep have been determined, the action
carries out the actual deletion process. Each tag that is in the set of tags to
delete but not in the set of tags to keep is deleted, independently of the image
it is attached to. Then, each image to delete that is not in the set of images
to keep is deleted as well.

## Examples

### Delete specific tagged images

Set the `include-tags` option to delete specific tags.

```yaml
jobs:
  - name: Cleanup
    runs-on: ubuntu-latest
    steps:
      - uses: jenskeiner/ghcr-cleanup-action@v1
        with:
          include-tags: mytag|mytag2
          token: ${{ secrets.GITHUB_TOKEN }}
```

This will delete `mytag` and `mytag2` as well as all reachable images, except
those also reachable through another tag.

This mode is useful, e.g. when tags related to a pull request should be deleted
when the pull request is closed.

```yaml
name: Cleanup Pull Request Images
on:
  pull_request:
    types: [closed]
jobs:
  ghcr-cleanup-image:
    name: Cleanup
    runs-on: ubuntu-latest
    steps:
      - name: Delete pull request tags and images
        uses: jenskeiner/ghcr-cleanup-action@v1
        with:
          include-tags: pr-${{github.event.pull_request.number}}
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Keep specific tagged images

To cleanup all untagged images in a image repository only the token is required
to be set. It will use the current repository information to setup the owner and
package name.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: jenskeiner/ghcr-cleanup-action@v1
        with:
          exclude-tags: mytag|mytag2
          keep-n-tagged: 0
          keep-n-untagged: 0
          token: ${{ secrets.GITHUB_TOKEN }}
```

This will delete all tags and images except `mytag1`and `mytag2` and all
reachable images.

This mode is useful for a periodicly triggered workflow that cleans up obsolete
images from a package repository.

```yaml
name: Periodic Repository Cleanup
on:
  schedule:
    - cron: '0 0 * * *'
jobs:
  ghcr-cleanup-image:
    name: Cleanup
    runs-on: ubuntu-latest
    steps:
      - name: Delete obsolete tags and images
        uses: jenskeiner/ghcr-cleanup-action@v1
        with:
          # Don't delete main, master, develop, semantic version tags, 
          # and pull request tags.
          exclude-tags: '^main|master|develop|\d+(?:\.\d+){0,2}|pr-\d+$' 
          keep-n-tagged: 0
          keep-n-untagged: 0
          token: ${{ secrets.GITHUB_TOKEN }}
```

### Keeping a number of recent tags or images

THere may be reasons to keep a certain number of tags and images not covered by
`exclude-tags`. In this case, use `keep-n-tagged` and `keep-n-untagged` options
with a positive value.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: jenskeiner/ghcr-cleanup-action@v1
        with:
          exclude-tags: mytag|mytag2
          keep-n-tagged: 3
          keep-n-untagged: 3
          token: ${{ secrets.GITHUB_TOKEN }}
```

In addition to `mytag1`and `mytag2` and their reachable images, this will keep
the three most recent tags and their reachable images, as well as the three most
recent images not already covered by the previous exclusions.

### Override default owner/repository/package

The default settings will use the current project to determine the owner,
repository and package name but for cross project and multiple package support
these can be overriden by setting owner, repository and package values.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          owner: myowner
          repository: myrepo
          package: mypackage
          token: ${{ secrets.GITHUB_TOKEN }}
          ...
```

## Notes

### Do a dry-run

Test the cleanup action first by setting the `dry-run: true` option on the
action and then reviewing the workflow log. This mode will simulate the cleanup
action but will not delete any tags or images.

### Package Restoration

GitHub has a package restoration API capability. The package IDs are printed in
the workflow log where the ghcr-cleanup-action is run.

[Restore Organization Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)

[Restore User Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)
