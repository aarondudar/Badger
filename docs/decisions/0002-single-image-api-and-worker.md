# 0002: Single image for API and worker

- Status: accepted
- Date: 2026-11-02

## Context

The API and the queue worker both need the provided SAST scanner, the grading code, and the AWS clients. The course requires extending the provided Express backend (`sast/backend`), not replacing it, and requires at least one Dockerized component.

## Options considered

1. **Separate codebases and images** for API and worker. Each image stays minimal, but the scanner, grading, and clients must be shared through a package or copied, and the two can drift.
2. **One codebase, two images** (multi-target Dockerfile). Shared code, smaller images, but two builds to run and push.
3. **One codebase (`sast/backend`) and one image, with two entrypoints.**

## Decision

Option 3. Build one image from `sast/backend/Dockerfile` (Node LTS slim, `git` installed, `npm ci --omit=dev`, non-root `node` user). The default command runs the API (`npm start`); the worker service overrides it with `npm run worker`. On ECS (Milestone 3) these become two task definitions using the same image with different commands.

## Consequences

- Shared code (scanner, grading, clients) is never duplicated or out of sync.
- One build in CI and one image to push in Milestone 3.
- The API and worker scale independently (separate services and tasks), even though they share an image.
- The API image includes `git`, which only the worker needs; an acceptable cost for this project.
