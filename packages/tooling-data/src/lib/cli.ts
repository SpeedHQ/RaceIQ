export function optionValue(
  name: string,
  args: readonly string[] = process.argv,
): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
