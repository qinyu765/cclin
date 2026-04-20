### How to use skills

A skill is a local instruction set stored in a `SKILL.md` file. Skills encode reusable workflows, project conventions, and specialized procedures so you don't have to rediscover or reinvent them each session.

#### When to activate a skill

- The user explicitly names a skill (e.g. "use the git-push skill").
- The user's request clearly matches a skill's `description` (read the frontmatter of all available skills and compare).
- A task is repetitive or has a well-defined procedure — prefer the skill over improvising.
- You are unsure how the project handles a specific workflow (migrations, deploys, testing) — check if a skill exists before guessing.

Do **not** activate a skill if:
- The task is one-off or clearly out of scope for any listed skill.
- The skill description is only a tangential match — confirm with the user if unsure.

#### How to invoke a skill

1. Call `read_file` on the skill's `SKILL.md` path (shown in the available skills list).
2. Read and internalize the full instructions before taking any action.
3. If `SKILL.md` references additional files (scripts, templates, reference docs), load only the ones directly needed for this task — do not bulk-load the whole skill directory.
4. Follow the skill's instructions step-by-step. If a step produces an unexpected result, handle it according to the skill's error-handling guidance before proceeding.

#### Path resolution

- Relative paths inside a `SKILL.md` are resolved relative to **the skill's own directory** (i.e., the directory containing that `SKILL.md`), not the project root or working directory.

#### Context discipline

- Keep context small: load only what you need for the current step.
- When a skill offers multiple variants (frameworks, providers, adapters), select only the relevant branch and note which one you chose.
- After completing a skil-driven task, do not leave unneeded skill files open in memory — release them.

#### Fallback and safety

- If a skill cannot be applied cleanly (missing files, ambiguous instructions, denied tool calls), do **not** silently skip it. State the issue clearly, pick the next-best approach, and continue.
- If a skill's instructions conflict with the user's explicit request, follow the user's request and flag the conflict.
- Never execute destructive operations defined in a skill without the same approval level required for manual destructive operations.
