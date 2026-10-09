# Architecture

One package contains independent TypeSafe transport, repository evidence retrieval and a thin stdio adapter.

`MCP agent -> repository public API -> Git/ripgrep/filesystem + optional TypeSafe JEv transport`

Repository retrieval owns root confinement, ignore rules, inventory limits, exact discovery,
semantic candidate selection, bounded source windows, overlap merging, evidence budgets and coverage.
Commands have fixed executables and argument arrays; supplied terms are literal data, never shell code.
Source is evidence, not instructions. Returned excerpts are original source with separate line bounds.

Exact evidence fitting the requested budget is returned without provider calls. Conceptual discovery
screens file descriptors, then source sections. Noisy exact results screen sections of matching files.
Selection favors evidence from several files before spending remaining budget within a file. Partial
evidence is useful: a section need not answer every part of a question. Consumers can retrieve further
exact matches or expand any named source without JEv. Expansion has no discovery size or relevance cap.

The transport owns credentials, HTTPS, wire validation, deadlines, cancellation and safe errors.
Repository evaluations own one transient retry and bounded concurrency. Failed screening is reported
explicitly, never converted to a negative score. Optional retrieval logging records metadata only.

The stdio adapter owns environment parsing, protocol startup and shutdown and delegates both tools
to the public API. Package imports have no startup side effects. Contracts and limits are defined
in [contracts](contracts.md); validation is defined in [development](development.md).
