enum State {
  Initial,
  Replacement,
  After,
}

const BEGIN = /\/\*\*\s+@inject-begin\s+(?<name>\S+)\s+\*\//;
const END = /\/\*\*\s+@inject-end\s+\*\//;

export function applyDirectTemplate(
  lines: string[],
  data: Record<string, unknown>,
): string {
  const output: string[] = [];
  let state = State.Initial;
  for (const line of lines) {
    switch (state) {
      case State.Initial: {
        const matched = line.match(BEGIN);
        const name = matched?.groups?.name as string | null;
        if (name != null) {
          state = State.Replacement;
          output.push(`const ${name} = ${JSON.stringify(data)};`);
        } else {
          output.push(line);
        }
        break;
      }
      case State.Replacement:
        if (line.match(END)) {
          state = State.After;
        }
        break;
      case State.After:
        output.push(line);
        break;
    }
  }
  if (state === State.Replacement) {
    console.warn("unexpected EOF!");
  }
  return output.join("\n");
}
