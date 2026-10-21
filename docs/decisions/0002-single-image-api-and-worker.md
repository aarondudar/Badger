# 0002: Single image for API and worker

## Context

The API and the queue worker both need the provided SAST scanner, the grading code, and the AWS clients. The course requires extending the provided Express backend, not replacing it.

## Options considered

- Separate codebases and images for API and worker
- One codebase (`sast/backend`) and one image, with two entrypoints

## Decision

Build one image from `sast/backend/Dockerfile`. The API runs `npm start`; the worker runs `npm run worker`.

## Consequences

- Shared code (scanner, grading, clients) is never duplicated or out of sync.
- One build in CI and one image to push in Milestone 3.
- The API image includes `git`, which only the worker needs; acceptable for this project.
