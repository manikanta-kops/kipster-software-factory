# Repository additions for reviewer

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

Check explicit database/home/port isolation and scheduler disabling when reviewing self-verification. Kit, CI and migrations retain owner review even when tests and proof pass.

Only system actions push, open/update pull requests or merge. Kit changes proceed
through human approval. These additions extend the fixed role instructions.
