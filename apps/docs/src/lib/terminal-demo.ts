export interface TerminalExample {
  id: string;
  label: string;
  summary: string;
  command: string;
  output: string;
}

export interface TerminalDemoProps {
  examples: readonly [TerminalExample, ...TerminalExample[]];
}

export function plainTerminalText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 10 || code === 9 || (code >= 32 && !(code >= 127 && code <= 159));
    })
    .join("")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/_\(([^)\n]*)\)_/g, "($1)")
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, "$1");
}
