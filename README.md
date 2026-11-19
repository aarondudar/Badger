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

## API routes

Full request and response shapes are in [`docs/contracts.md`](docs/contracts.md). With the stack running (`localhost:3000`):

```sh
# Queue a scan: 202 with the queued record; 400 if the URL isn't a public GitHub repo
curl -i -X POST localhost:3000/scan/repo -H 'Content-Type: application/json' \
  -d '{"repoUrl":"https://github.com/expressjs/cors"}'
# {"repo":"expressjs/cors","scanId":"2026-11-19T13:23:41.226Z_0c1134","status":"queued","requestedAt":"..."}

# Latest scan, any status (queued, running, complete, failed); 404 if never scanned
curl localhost:3000/grade/expressjs/cors

# Last 20 scans, newest first
curl localhost:3000/grade/expressjs/cors/history

# README badge (SVG, cached 5 minutes): latest grade, "scanning", or "unknown"
curl -i localhost:3000/badge/expressjs/cors
```

Owner and repo are case-insensitive. To use the badge in a README:

```md
[![security](https://<api-host>/badge/<owner>/<repo>)](https://github.com/<owner>/<repo>)
```

Browser calls to `/scan` and `/grade` are limited to `ALLOWED_ORIGINS` (see `.env.example`); `/badge` is open to any origin.
