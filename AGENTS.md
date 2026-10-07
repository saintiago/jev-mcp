# JEv project guide

## Working rules

Keep this package small. Apply KISS, DRY, YAGNI, SOLID, composition and focused
public contracts. Add abstractions only for current requirements. Account for
implementation, validation, failure handling, documentation and maintenance.

Documentation states intent; code embodies it. When they disagree, correct the
code. Update the owning document when intentionally changing a contract. Jira
issues reference docs rather than introducing hidden requirements.

Develop in Linux/WSL. Use Nexus and the global nexus-app-change skill for
nontrivial application changes after the initial manual bootstrap. Handle small
edits, documentation and local maintenance directly. Explicit user workflow
instructions take precedence. Launch Nexus in a separate visible WSL terminal
with TERM=xterm-256color and COLORTERM=truecolor.

Keep the API independent of MCP and consumers. The adapter calls the public API;
it must not duplicate request, validation or error policy. Consumers own prompts,
routing, thresholds and decisions. Allow only the opt-in local usage log defined
in [contracts](docs/contracts.md#local-usage-logging). Never log supplied state,
credentials, authentication headers or raw provider error bodies.

## Authoritative documents

- [Purpose and scope](docs/project-charter.md)
- [Architecture](docs/architecture.md)
- [API and MCP contracts](docs/contracts.md)
- [Tooling, testing and delivery](docs/development.md)

README is the entry point. Each rule has one authoritative home. No separate
document per small module or duplicate task inventory is needed. Jira is the queue.
