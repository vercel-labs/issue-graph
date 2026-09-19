import { readFile } from "node:fs/promises";

const USAGE = `usage: issue-graph skills [list] [--json]
       issue-graph skills get core [--full] [--json]

  list          list guides bundled with this installation (default)
  get core      print the version-matched core guide
  --full        include the guide's bundled workflow references
  --json        emit a versioned JSON envelope on stdout
  -h, --help    show this

Plain text/Markdown is the default, including in pipes.
No network, GitHub authentication, snapshots, or installation changes.`;

const SKILLS = [
  {
    name: "core",
    description:
      "Status-first routing, bounded GitHub evidence collection, and safety guidance for issue-graph workflows.",
    files: ["references/workflows.md"],
  },
] as const;

class SkillsUsageError extends Error {}

interface SkillsIO {
  stdout: (value: string) => void;
  stderr: (value: string) => void;
}

type SkillReader = (name: string, path: string) => Promise<string>;

async function readBundledSkill(name: string, path: string): Promise<string> {
  try {
    return await readFile(new URL(`../skill-data/${name}/${path}`, import.meta.url), "utf8");
  } catch {
    throw new Error(
      `Cannot read bundled skill ${name} (${path}). Reinstall or rebuild issue-graph with its skill-data directory.`,
    );
  }
}

type SkillsArgs = { json: boolean; full: boolean } & (
  | { command: "help" }
  | { command: "list" }
  | { command: "get"; skill: (typeof SKILLS)[number] }
);

function parseSkillsArgs(argv: string[]): SkillsArgs {
  const words: string[] = [];
  let full = false;
  let json = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--full") full = true;
    else if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg.startsWith("-")) {
      throw new SkillsUsageError(`unknown skills flag: ${JSON.stringify(arg)}`);
    } else words.push(arg);
  }
  const command = words[0] ?? "list";
  if (command !== "list" && command !== "get") {
    throw new SkillsUsageError(`unknown skills command: ${JSON.stringify(command)}`);
  }
  if (help) return { command: "help" as const, json, full };
  if (command === "list") {
    if (words.length > 1 || full) {
      throw new SkillsUsageError("skills list accepts only --json; use skills get core --full");
    }
    return { command, json, full };
  }
  if (words.length !== 2) {
    throw new SkillsUsageError("skills get requires exactly one name: issue-graph skills get core");
  }
  const skill = SKILLS.find((entry) => entry.name === words[1]);
  if (!skill) {
    throw new SkillsUsageError(`unknown skill: ${JSON.stringify(words[1])}; available: core`);
  }
  return { command, json, full, skill };
}

export async function runSkills(
  argv: string[],
  io: SkillsIO,
  read: SkillReader = readBundledSkill,
): Promise<number> {
  const emit = (data: unknown, nextSteps: string[]) =>
    io.stdout(`${JSON.stringify({ schemaVersion: 1, success: true, data, nextSteps }, null, 2)}\n`);
  try {
    const args = parseSkillsArgs(argv);
    if (args.command === "help") {
      if (args.json) emit({ usage: USAGE }, ["issue-graph skills get core"]);
      else io.stdout(`${USAGE}\n`);
      return 0;
    }
    if (args.command === "list") {
      const data = SKILLS.map(({ name, description }) => ({ name, description }));
      if (args.json) emit(data, ["issue-graph skills get core"]);
      else {
        io.stdout(
          `${data.map(({ name, description }) => `${name}  ${description}`).join("\n")}\n\nRead a guide: issue-graph skills get core\n`,
        );
      }
      return 0;
    }
    const { skill } = args;
    const content = await read(skill.name, "SKILL.md");
    const files = args.full
      ? await Promise.all(
          skill.files.map(async (path) => ({ path, content: await read(skill.name, path) })),
        )
      : undefined;
    if (args.json) {
      emit(
        [{ name: skill.name, content, ...(files ? { files } : {}) }],
        [args.full ? "issue-graph schema" : "issue-graph skills get core --full"],
      );
    } else {
      const parts = [content.trimEnd()];
      for (const file of files ?? [])
        parts.push(`--- ${file.path} ---\n\n${file.content.trimEnd()}`);
      io.stdout(`${parts.join("\n\n")}\n`);
    }
    return 0;
  } catch (error) {
    const usage = error instanceof SkillsUsageError;
    const message = error instanceof Error ? error.message : String(error);
    const hint = usage ? "Run issue-graph skills --help." : "Check the installed skill-data files.";
    if (argv.includes("--json")) {
      io.stdout(
        `${JSON.stringify({ schemaVersion: 1, success: false, error: { code: usage ? "USAGE_ERROR" : "SKILL_READ_FAILED", message, hint } }, null, 2)}\n`,
      );
    } else io.stderr(`${message}\n${hint}\n`);
    return usage ? 2 : 1;
  }
}
