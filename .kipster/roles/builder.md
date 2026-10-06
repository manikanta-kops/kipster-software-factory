# Repository additions for builder

Read [self-verification isolation](../context/isolation.md) before executing
repository commands. Ticket code affects only its checkout and disposable
verification; the running scratch factory changes only after a deliberate restart
outside agent attempts. Do not touch another scratch factory, the owner’s app,
shared development databases, default factory home or integration secrets.

Change only the ticket checkout. Format all edited files, explicitly including hidden kit files, and run the complete deterministic gate before reporting done.

Only system actions push, open/update pull requests or merge. Kit changes are
allowed when the ticket needs them. The owner reviews them on the pull request,
so make them and continue; never stop to ask. These additions extend the fixed
role instructions.
