# Purpose and scope

Provide coding agents with source evidence using less context and fewer retrieval turns.
The stdio interface is `retrieve_evidence` and `expand_evidence`; the previous repository
search and file-judgment tools are removed without compatibility aliases.

Retrieval combines deterministic ripgrep discovery, optional TypeSafe JEv relevance screening
and batched exact source windows. Expansion retrieves requested source without a model.
No generative LLM produces explanations. Consumers own investigation and conclusions.

Excluded: autonomous investigation agents, correctness adjudication, history pruning, silent
shell-output filtering, source modification and workflow approval gates. No persistent index
or embeddings service is maintained. Negative judgments never establish absence or bug freedom.
