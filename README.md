# GitHub Container Registry Image Cleanup Action

[![GitHub Super-Linter](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/dataaxiom/ghcr-cleanup-action/actions/workflows/codeql-analysis.yml)

A workflow action that deletes images from the GitHub Container Registry
(ghcr.io). Its primary focus is on supporting multi-architecture container
images.

It includes the following features:

- Automatic GitHub user/organization repository support
- Deleting images by tag names
- Deleting untagged images
- Keeping a number of untagged images
- Keeping a number of tagged images
- Untagging of multi-tagged images
- Multiple package execution
- Referrers/GitHub attestation support (OCIv1 tag approach)
- Sigstore cosign support
- Retry and throttle support for the GitHub API calls
- Validation mode to verify multi-architecture & referrers images

## Setup

### Setup token permissions

To allow the injected GITHUB_TOKEN secret to have access to delete images it
requires its permissions to have been set correctly, either by:

1. In the GitHub site, Settings > Actions > General, set the Workflow
   permissions option to "Read and write permissions".
1. or by setting the permissions directly in the workflow by setting the
   packages value to write.

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
from the repository. Deleting a multi-architecture image will also delete the
underlying child images.

To get started add an action definition to a workflow file.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          dry-run: true
```

The action calls both the registry API (ghcr.io) and the GitHub package API to
facilitate support for multi-architecture images. This is required to determine
the relationships between all of the multi-architecture image contents. It
downloads the manifest descriptors of all images and maps their content to the
underlying packages. Which for multi-architecture images the underlying packages
appear as untagged in GitHub (as seen in the web interface). To safely delete
untagged images the action determines first if the untagged package is actually
in use by another image/package and skips these. Likewise to delete an image it
needs to delete all of the underlying packages.

### Do a dry-run first

It's recommended to test the cleanup action first by setting the `dry-run: true`
option on the action and then reviewing the workflow log. This mode will
simulate the cleanup action but will not delete any images/packages. This is
especially important when using a wildcard/regular expression syntaxes or the
`older-than` option to select images.

## How It Works

The high level processing of the action occurs as follows:

1. For each package.
1. Download all package metadata and their manifests and put them into a working
   'filter set'.
1. Remove all child images from the working filter set (including referrers and
   cosign images).
1. Remove `exclude-tags` images from filter set.
1. Remove images which are younger than the `older-than` option from the filter
   set.
1. Stage for deletion `delete-tags` images present in the filter set.
1. Stage for deletion `delete-ghost-images`, `delete-partial-iamges` and
   `delete-orphaned-images` images present in the filter set.
1. Process `keep-n-tagged` images from the filter set, stage remainder tagged
   images for deletion.
1. Process `keep-n-untagged` images from the filter set, stage remainder
   untagged images for deletion.
1. Or process `delete-untagged`, staging all untagged images in filter set for
   deletion.
1. Preform the deletion on all staged packages, including their children if
   present.

## Action Options

### Repository Options

| Option          | Required | Defaults             | Description                                                                                                                                                                              |
| --------------- | :------: | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| token           |   yes    | secrets.GITHUB_TOKEN | Token used to connect with ghcr.io and the Package API                                                                                                                                   |
| owner           |    no    | project owner        | The GitHub repository owner, can be an organization or user type                                                                                                                         |
| repository      |    no    | repository name      | The GitHub repository name                                                                                                                                                               |
| package(s)      |    no    | repository name      | Comma-separated list of packages to cleanup. Supports dynamic packages (wildcard or regular expression) by enabling the `expand-packages` option. Can be used as `package` or `packages` |
| expand-packages |    no    | false                | Enable wildcard or regular expression support on the `package(s)` option to support dynamic package selection. It requires use of a Personal Access Token (PAT) for the `token` value.   |

If the owner, repository or package options are not set then the values are
automatically set from the project environment where the action is running.

### Cleanup Options

| Option                 | Required | Defaults  | Description                                                                                                                                                                                          |
| ---------------------- | :------: | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| delete-tags            |    no    |           | Comma-separated list of tags to delete (supports wildcard syntax), can be abbreviated as `tags`. A regular expression selector can be used instead by setting the `use-regex` option to true         |
| exclude-tags           |    no    |           | Comma-separated list of tags strictly to be preserved/excluded from deletion (supports wildcard syntax). A regular expression selector can be used instead by setting the `use-regex` option to true |
| delete-untagged        |    no    | depends\* | Delete all untagged images                                                                                                                                                                           |
| keep-n-untagged        |    no    |           | Number of untagged images to keep, sorted by date, keeping the latest                                                                                                                                |
| keep-n-tagged          |    no    |           | Number of tagged images to keep, sorted by date, keeping the latest                                                                                                                                  |
| delete-ghost-images    |    no    | false     | Delete multi-architecture images where all underlying platform images are missing                                                                                                                    |
| delete-partial-images  |    no    | false     | Delete multi-architecture images where some (but not all) underlying platform images are missing                                                                                                     |
| delete-orphaned-images |    no    | false     | Delete tagged images which have no parent (e.g. referrers and cosign tags missing their parent)                                                                                                      |
| older-than             |    no    |           | Only include images for processing that are older than this interval (eg 5 days, 6 months or 1 year)                                                                                                 |

\* If no delete or keep options are set on the action then the action defaults
the option `delete-untagged` to "true" and will delete all untagged images.

### Other Options

| Option    | Required | Defaults | Description                                                                                                                   |
| --------- | :------: | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| use-regex |    no    | false    | If set to true, the `delete-tags`,`exclude-tags` and `package` options expect a regular expression selector (if they are set) |
| dry-run   |    no    | false    | Simulate a cleanup action but does not make any changes (true/false)                                                          |
| validate  |    no    | false    | Validate all multi-architecture images in the registry after cleanup                                                          |
| log-level |    no    | info     | The log level (error/warn/info/debug)                                                                                         |

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
```

If a tag to be deleted links to an image with multiple tags the action will
unlink the tag before is deleted, effectively untagging the image. But the
underlying image will not be deleted (unless all of its additional tags have
been deleted also).

The option can make use of a simple wildcard syntax to match multiple images.
See the [wildcard-match](https://github.com/axtgr/wildcard-match#readme) project
for its syntax. It supports the ?, \* and \*\* wildcard characters.

To use a regular expression instead of a comma-seperated list set the
`use-regex` option to true.

Tag values can additionaly be expressed in the sha256: digest format.

### `delete-untagged`

This option deletes all untagged images from package repository. It is the same
as the default mode, however, this option can be combined with any of the other
options (except for the `keep-n-untagged`).

Note: Untagged here means untagged images not untagged packages (in GitHub). So
after running this option on repositories with multi-architecture images there
could still be untagged packages showing in GitHub.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-untagged: true
```

### `exclude-tags`

This option is used to exclude tagged images from being deleted. Use it to
exclude tags when combined with other options. It takes priority over all other
options.

The option can make use of a simple wildcard syntax to match multiple images.
See the [wildcard-match](https://github.com/axtgr/wildcard-match#readme) project
for its syntax. It supports the ?, \* and \*\* wildcard characters.

To use a regular expression instead of a comma-seperated list set the
`use-regex` option to true.

Tag values can additionaly be expressed in the sha256 digest format.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          exclude-tags: dev,latest,pr*
          keep-n-tagged: 10
```

### `older-than`

To limit the action to images that are older than a certain time this setting
can be used. Set this option to a relative date value from now. This option can
be used with all of the delete and keep options narrowing their scope to which
images they will process.

The syntax supports the following units in the plural and singular forms:
seconds, minutes, hours, days, weeks, months and years.

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
          older-than: 1 year
          keep-n-tagged: 10
```

### `delete-ghost-images` and `delete-partial-images`

These options clean up invalid multi-architecture images. They are intended to
assist in cleaning up repositories that have been corrupted. Use the `validate`
option first to identify the images which are not valid.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          delete-ghost-images: true
```

### `delete-orphaned-images`

This option removes tagged images where the assoicated parent image does not
exist. It searches for images with tags starting with "sha256-" and then
searches for the equivalent sha256: digest. If an image digest is not found then
it's flagged for deletion. This picks up orphaned referrers and cosign images.

## Keep Options

### `keep-n-untagged`

Includes for deletion all untagged images but excludes (keeps) a number of them.
The value of this option sets the number of untagged images to keep. Untagged
images are sorted by date and the most recent untagged images are kept. May be
combined with other delete options (except the `delete-untagged` option).

Note: Untagged here means untagged images not untagged packages in GitHub.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          keep-n-untagged: 3
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
```

This option operates on all tagged entries. To narrow it's scope use the
`exclude-tag` option also.

## Personal Access Tokens (PAT's)

The default injected token (`secret.GITHUB_TOKEN`) is sufficient for packages
which have been created by a repository project pipeline (or the package has
been setup to grant admin access to it). For setups where the action is
accessing a package in a different repository or dynamic package selection is
being used (`expand-packages` is set to true) a Personal Access Token (PAT) is
required for the `token`.

The PAT should be setup as a Classic token. This is due to the GitGub Registry
API currently only supporting Classic tokens. The token should be setup with
both `write:packages` and `delete:packages` scopes.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          token: ${{ secrets.MY_GHCR_PAT }}
```

## Multiple Package Support

The `package` (or `packages`) options can be set to a comma separated list of
packages to operate on.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          packages: myimage1,myimage2
```

To utilize a wildcard set the `expand-packages` option to true and utilize a PAT
for the token.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          packages: myimage*,someotherimage
          expand-packages: true
          token: ${{ secrets.GHCR_PAT }}
```

A regular expression can be used alternatively. This requires the `use-regex`
option to be set to true.

```yaml
jobs:
  - name: ghcr.io cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          packages: '^myimage[12]$'
          expand-packages: true
          use-regex: true
          token: ${{ secrets.GHCR_PAT }}
```

Multiple package execution can also be achieved by using the GitHub workflow
matrix mechanism.

## Sample Action Setups

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
```

### Delete all untagged images and keep 3 latest (rc) images

This sample operates on multiple packages and makes use of a regular expression
selector. It excludes all versioned images and the latest and main tags from
processing.

```yaml
cleanup-images:
  name: cleanup-images
  runs-on: ubuntu-latest
  concurrency:
    group: cleanup-images
  steps:
    - uses: dataaxiom/ghcr-cleanup-action@v1
      with:
        packages: 'tiecd/k8s,tiecd/okd,tiecd/gke,tiecd/eks,tiecd/aks,tiecd/node18,tiecd/node20'
        delete-untagged: true
        keep-n-tagged: 3
        exclude-tags: "^\\d+\\.\\d+\\.\\d+$|^latest$|^main$"
        use-regex: true
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
          delete-tags: pr-${{github.event.pull_request.number}}
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
```

### Override default owner/repository/package

The default settings will use the current project to determine the owner,
repository and package names but for cross-project and multiple package support
these can be overridden by setting the owner, repository and package options.

The example below uses a regular expression as the selector for the
`delete-tags` option.

```yaml
jobs:
  - name: ghcr cleanup action
    runs-on: ubuntu-latest
    steps:
      - uses: dataaxiom/ghcr-cleanup-action@v1
        with:
          owner: dataaxiom
          repository: tiecd
          package: tiecd
          delete-tags: '^mytag[12]$'
          use-regex: true
```

## Operations

### Effect on image download counts

To ensure the integrity of all images in the package repository all of of the
image manifests are required to be downloaded and cross-referenced each time the
action is run. The effect of this is that it will increase the package download
count showing in GitHub for all packages by one. The action does not download
the underlying package itself, just the manifests. But GitHub uses that event to
mark it as a download.

### Concurrency

The action is not designed to be run in parallel on the same package repository.
Due to the nature of the cleanup process and determining what can be safely
deleted it requires that no other package publishing or deleting process is
occurring at the same time. It's recommended to use a GitHub concurrency group
with this action in complex/busy repositories.

```yaml
cleanup-images:
  name: cleanup-images
  runs-on: ubuntu-latest
  concurrency:
    group: cleanup-images
  steps:
    - uses: dataaxiom/ghcr-cleanup-action@v1
```

### Validate Option

Set the `validate` option to true to enable a full scan of the image repository
at the end of the execution to check that all multi-architecture images have no
missing platform images. Warnings will be outputted if there are missing
packages.

### Packages Downloaded More Than 5000 Times

Public packages that have been downloaded more than 5000 times are prohibited by
GitHub to be deleted. Currently the only way to exclude these is set the
exclude-tags for these images so that they are not processed by the action.

There is currently no public GitHub API to retrieve the download counts, which
would be required to programmatically remove these from been processed by the
action.

### Package Restoration

GitHub has a package restoration API capability. The package IDs are printed in
the workflow log where the ghcr-cleanup-action is run.

[Restore Organization Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-package-version-for-an-organization)

[Restore User Package](https://docs.github.com/en/rest/packages/packages?apiVersion=2022-11-28#restore-a-package-version-for-the-authenticated-user)
