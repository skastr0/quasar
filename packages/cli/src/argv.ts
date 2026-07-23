type ParsedOption = {
  readonly name: string;
  readonly value: string | undefined;
};

export type ParsedCliArguments = {
  readonly positionals: readonly string[];
  readonly missingValueOptions: readonly string[];
  readonly first: (name: string) => string | undefined;
  readonly all: (...names: readonly string[]) => readonly string[];
  readonly has: (name: string) => boolean;
};

export const parseCliArguments = (
  argv: readonly string[],
  valueOptionNames: ReadonlySet<string>,
): ParsedCliArguments => {
  const options: ParsedOption[] = [];
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (valueOptionNames.has(token)) {
      const value = argv[index + 1];
      options.push({ name: token, value });
      if (value !== undefined) index += 1;
      continue;
    }
    if (token !== "-" && token.startsWith("-")) {
      options.push({ name: token, value: undefined });
      continue;
    }
    positionals.push(token);
  }

  return {
    positionals,
    missingValueOptions: options.flatMap((option) =>
      valueOptionNames.has(option.name) && option.value === undefined ? [option.name] : []
    ),
    first: (name) => options.find((option) => option.name === name)?.value,
    all: (...names) => options.flatMap((option) =>
      names.includes(option.name) && option.value !== undefined ? [option.value] : []
    ),
    has: (name) => options.some((option) => option.name === name),
  };
};
