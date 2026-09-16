# ZenNotes self-hosted server

The Go server owns the self-hosted API, authentication, filesystem access, and
vault watching. The main ZenNotes repository owns the browser app and publishes
its immutable build. Laravel Cloud remains a separate service.

## Build and verify

Go 1.25 or later is sufficient for API development:

```sh
go vet ./...
go test ./...
go run ./cmd/zennotes-server
```

Production bundles include the browser artifact pinned in
`web-artifact/manifest.json`:

```sh
go run ./cmd/prepare-web -manifest web-artifact/manifest.json -output web/dist
go test -tags=embed_web ./web
go build -tags=embed_web -trimpath -o bin/zennotes-server ./cmd/zennotes-server
```

No Node install or sibling source checkout is needed. The importer checks
protocol, source, tar paths/types, size, archive SHA-256, and every file checksum.
The reviewed manifest is the trust anchor. Dirty local candidates require
`-allow-dirty`; release and CI paths deliberately omit that flag.

## Distribution

`docker build .` builds the same Go-only distribution. Preserve image ownership
and the existing `adibhanna/zennotes` image when the publisher cutover is approved.
Runtime defaults remain UID 65532, port 7878, `/workspace`, `/data/server.json`, and
the existing `ZENNOTES_*` variables. Existing authentication/base-path behavior
and note bytes are covered by HTTP fixtures under `internal/httpserver/testdata`.

`nix-build` uses the pinned browser archive and Go vendor hash in `release.json`.
It never compiles frontend source. A local rehearsal can use
`nix-build --arg allowDirty true` with an adjacent candidate archive.

To update the web app, review a new manifest, run Go/import/embed/HTTP tests, and
release it with the server source. Roll back by selecting the prior server image
or binary and restoring its pin; no vault migration is introduced.

## Extraction gate

This directory is prepared in a local rehearsal before publication. Do not enable
its Docker publisher while the main repository still publishes the same tags.
First approve and publish a clean browser artifact, extract approved history,
verify destination CI and candidate installation, then switch one channel at a
time. The main repository retains its source and previous release until a verified
destination release and rollback rehearsal exist.
