# Badger: GitHub Repo Report Card

Submit a public GitHub repo URL; Badger scans its JavaScript with the course SAST scanner, grades it, and serves an embeddable README badge.

## Quick start

Requires Docker. No AWS account needed: AWS services are emulated locally.

```sh
cp .env.example .env
docker compose up --build
```

The API is on `localhost:3000`. To run, inspect, and test each part locally, see [`docs/local-development.md`](docs/local-development.md).

## Docs

- [`docs/local-development.md`](docs/local-development.md): local environment, inspecting the emulator, testing each part
- [`docs/architecture.md`](docs/architecture.md): target AWS architecture
- [`docs/contracts.md`](docs/contracts.md): API routes, job message, scan record, report format
- [`docs/SKELETON_SPEC.md`](docs/SKELETON_SPEC.md): Milestone 1–2 spec

Route curl examples are still to come.
