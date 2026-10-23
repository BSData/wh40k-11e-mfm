import { appendFileSync } from 'node:fs';

/**
 * Step outputs as GitHub reads them from `$GITHUB_OUTPUT`: `key=value`, one per line. A
 * value must be a single line; one with a line break could set outputs of its own.
 */
export function stepOutputs(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`Step output ${key} spans lines: ${value}`);
      return `${key}=${value}\n`;
    })
    .join('');
}

/** Append step outputs to `file` (`$GITHUB_OUTPUT`), or hand them back for printing. */
export function writeOutputs(
  values: Record<string, string>,
  file: string | undefined,
  print: (text: string) => void,
): void {
  const text = stepOutputs(values);
  if (file) appendFileSync(file, text);
  else print(text);
}
