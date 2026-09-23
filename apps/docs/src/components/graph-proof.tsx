import { terminalExampleCatalog, toTerminalExample } from "@/lib/terminal-examples";
import { TerminalDemo } from "./terminal-demo";

export function GraphProof() {
  const [first, ...rest] = terminalExampleCatalog;
  return <TerminalDemo examples={[toTerminalExample(first), ...rest.map(toTerminalExample)]} />;
}
