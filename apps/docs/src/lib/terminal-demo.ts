export interface TerminalDemoProps {
  command: string;
  output: string;
}

export interface TerminalDemoRuntimeProps extends TerminalDemoProps {
  active: boolean;
  reducedMotion: boolean;
  replay: number;
  onError: () => void;
}

export const CLEAR_TERMINAL = "\x1b[0m\x1b[3J\x1b[H";

export function plainTerminalText(text: string): string {
  return Array.from(text.replace(/\r\n?/g, "\n"))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 10 || code === 9 || (code >= 32 && !(code >= 127 && code <= 159));
    })
    .join("")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/_\(([^)\n]*)\)_/g, "($1)");
}

export function colorTerminalLine(line: string): string {
  const clean = plainTerminalText(line);
  const heading = /^#{1,3}\s/.test(clean);
  const base = heading ? "\x1b[1;36m" : "\x1b[0m";
  const text = clean.replace(/^#{1,3}\s+/, "").replace(/\b(OPEN|CLOSED|MERGED)\b/g, (state) => {
    const color = state === "OPEN" ? 32 : 35;
    return `\x1b[${color}m${state}${base}`;
  });
  return `${base}${text}\x1b[0m\r\n`;
}

export interface ReplayFrame {
  text: string;
  delay: number;
}

export function terminalReplayFrames(command: string, output: string): ReplayFrame[] {
  const frames: ReplayFrame[] = [{ text: "\x1b[?25h\x1b[1;32m$\x1b[0m ", delay: 0 }];
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  for (const { segment } of segmenter.segment(plainTerminalText(command).replace(/\n/g, " "))) {
    frames.push({ text: segment, delay: 16 });
  }
  frames.push({ text: "\r\n\r\n", delay: 240 });
  const lines = output.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  for (const line of lines) {
    frames.push({ text: colorTerminalLine(line), delay: line ? 65 : 30 });
  }
  frames.push({ text: "\x1b[?25l", delay: 0 });
  return frames;
}

export function createTerminalPlayback(frames: ReplayFrame[], write: (text: string) => void) {
  let index = 0;
  let transcript = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const append = (text: string) => {
    transcript += text;
    write(text);
  };
  const advance = () => {
    timer = undefined;
    if (disposed || index >= frames.length) return;
    append(frames[index++].text);
    if (!disposed && index < frames.length) timer = setTimeout(advance, frames[index].delay);
  };

  return {
    get transcript() {
      return transcript;
    },
    setActive(active: boolean, reducedMotion = false) {
      cancel();
      if (disposed || !active || index >= frames.length) return;
      if (reducedMotion) {
        const remaining = frames
          .slice(index)
          .map((frame) => frame.text)
          .join("");
        index = frames.length;
        append(remaining);
      } else {
        timer = setTimeout(advance, frames[index].delay);
      }
    },
    dispose() {
      disposed = true;
      cancel();
    },
  };
}
