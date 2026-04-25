export interface CliArgs {
  command?: "migrate-agent-config";
  dir?: string;
  help: boolean;
  cli: boolean;
  yolo: boolean;
}

export function parseCliArgs(argv: string[]): { args: CliArgs; errors: string[] } {
  const args: CliArgs = { help: false, cli: false, yolo: false };
  const errors: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];

    if (a === "migrate-agent-config") {
      if (args.command) {
        errors.push(`Unexpected command: ${a}`);
      } else {
        args.command = "migrate-agent-config";
      }
      continue;
    }

    if (a === "--help" || a === "-h") {
      args.help = true;
      continue;
    }

    if (a === "--cli" || a === "-c") {
      args.cli = true;
      continue;
    }

    if (a === "--yolo" || a === "-y") {
      args.yolo = true;
      continue;
    }

    if (a === "--dir" || a === "-d") {
      const v = argv[i + 1];
      if (!v || v.startsWith("-")) {
        errors.push(`Missing value for ${a}. Usage: ${a} <directory_path>`);
      } else {
        args.dir = v;
        i++;
      }
      continue;
    }

    errors.push(`Unknown argument: ${a}`);
  }

  return { args, errors };
}
