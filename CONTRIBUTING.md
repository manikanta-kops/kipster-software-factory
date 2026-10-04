# Contributing

Thanks for helping improve Kipster Software Factory.

## Before you start

For anything larger than a small fix, open an issue first so we can agree on
the approach. Read [the architecture](docs/architecture.md) for the area you
are changing.

## Setup

Use the Node.js version in `.nvmrc` and install PostgreSQL 18 so `initdb` and
`pg_ctl` are on `PATH`:

```sh
nvm install
npm ci
npm run dev
```

## Pull requests

- Branch from `next` and open the pull request against `next`.
- Run `npm run check`, `npm test` and `npm run test:e2e`. CI runs them again.
- Database migrations are append-only once merged; API responses change by
  addition only.
- Describe what changed, why, and how you verified it.

By contributing, you agree that your contributions are licensed under the
[Apache-2.0 license](LICENSE).
