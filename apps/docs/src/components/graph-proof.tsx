import graph from "@/lib/example-graph.json";
import { TerminalDemo } from "./terminal-demo";

export function GraphProof() {
  return <TerminalDemo command={graph.command} output={graph.terminalOutput} />;
}
