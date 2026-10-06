# Repository additions for onboarder

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

Commit a formatted, checked kit. Do not manually execute its verify.start or call startVerification; the verify-kit system action owns boot and cleanup. Address its stage findings on a fresh routed attempt.

Only system actions push, open/update pull requests or merge. Kit changes proceed
through human approval. These additions extend the fixed role instructions.
