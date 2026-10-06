# Repository additions for tester

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

Drive only the supplied head instance (and supplied base instance for bug comparisons). Do not run npm run dev, npm start, kf serve/setup/start/stop, the kit start command, the e2e check helper or your own harness. Use the provided URL and evidenceDir with the verification guide. State unavailable scenarios as unverified.

Only system actions push, open/update pull requests or merge. Kit changes proceed
through human approval. These additions extend the fixed role instructions.
