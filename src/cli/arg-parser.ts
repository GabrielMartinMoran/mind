import { style } from '../helpers/style';

export class ArgParser {
  private shape: string[];
  private description: string;
  private flags: { name: string; alias?: string; hasValue: boolean; description?: string }[];

  constructor(
    shape: string[],
    description: string,
    flags: { name: string; alias?: string; hasValue: boolean; description?: string }[] = []
  ) {
    this.shape = shape;
    this.description = description;
    this.flags = flags;
  }

  /**
   * Matches positional args (ignoring flags like --tag, --tier, --label).
   */
  matches(args: string[]): boolean {
    if (!this.flagsAreValid(args)) return false;
    const positional = this.getPositionalArgs(args);

    // Match shape parts to positional args, handling command synonyms with spaces
    let posIdx = 0;

    for (let shapeIdx = 0; shapeIdx < this.shape.length; shapeIdx++) {
      const part = this.shape[shapeIdx]!;

      if (this.isParam(part)) {
        // It's a parameter - should match current positional
        if (posIdx >= positional.length) return false;
        posIdx++;
      } else {
        // It's a command part - check all alternatives (split by |)
        const aliases = part.split('|');
        let foundMatch = false;

        for (const alias of aliases) {
          const words = alias
            .trim()
            .split(/\s+/)
            .filter(w => w.length > 0);
          const wordCount = words.length;

          // Check if positional matches this alias starting at posIdx
          if (posIdx + wordCount <= positional.length) {
            let match = true;
            for (let w = 0; w < wordCount; w++) {
              if (positional[posIdx + w] !== words[w]) {
                match = false;
                break;
              }
            }
            if (match) {
              posIdx += wordCount;
              foundMatch = true;
              break;
            }
          }
        }

        if (!foundMatch) return false;

        // Found match for this shape entry.
        // If we've consumed all positional args:
        // - If no more shape entries: return true
        // - If next shape entry is a param: continue (param will consume next positional or fail)
        // - If next shape entry is a command part (another alias): return true (don't try it)
        if (posIdx === positional.length) {
          const nextPart = this.shape[shapeIdx + 1];
          if (!nextPart) {
            return true;
          }
          // If next part is a command part (not a param), return true - don't try to match it
          if (!this.isParam(nextPart)) {
            return true;
          }
          // Next is a param - continue to next iteration
        }
      }
    }

    // Must have consumed all positional args
    return posIdx === positional.length;
  }

  static param(name: string): string {
    return `<${name}>`;
  }

  protected isParam(part: string): boolean {
    return part.startsWith('<') && part.endsWith('>');
  }

  protected getParamName(part: string): string {
    return part.slice(1, -1);
  }

  /**
   * Extract positional args, stripping out --flag and --flag=value pairs.
   */
  public getPositionalArgs(args: string[]): string[] {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg.startsWith('--')) {
        // Check if this flag expects a value
        const flagName = arg.replace(/^--/, '');
        const flag = this.flags.find(f => f.name === flagName || f.alias === flagName);
        if (flag?.hasValue) {
          i++; // skip the next arg (the value)
        }
        continue;
      }
      result.push(arg);
    }
    return result;
  }

  private flagsAreValid(args: string[]): boolean {
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith('--')) continue;

      const flagName = arg.replace(/^--/, '');
      const flag = this.flags.find(f => f.name === flagName || f.alias === flagName);
      if (!flag) return false;

      if (flag.hasValue) {
        const value = args[i + 1];
        if (!value || value.startsWith('--')) return false;
        i++;
      }
    }
    return true;
  }

  getParams(args: string[]): any {
    const positional = this.getPositionalArgs(args);
    const params: any = {};

    let posIdx = 0;

    for (let shapeIdx = 0; shapeIdx < this.shape.length; shapeIdx++) {
      const part = this.shape[shapeIdx]!;

      if (this.isParam(part)) {
        // It's a parameter - assign current positional arg
        params[this.getParamName(part)] = positional[posIdx] ?? undefined;
        posIdx++;
      } else {
        // It's a command part - skip the words
        const aliases = part.split('|');
        // Find matching alias to know how many words to skip
        let wordCount = 0;
        for (const alias of aliases) {
          const words = alias
            .trim()
            .split(/\s+/)
            .filter(w => w.length > 0);
          const testWords = positional.slice(posIdx, posIdx + words.length);
          if (testWords.length === words.length && testWords.every((w, i) => w === words[i])) {
            wordCount = words.length;
            break;
          }
        }
        posIdx += wordCount;
      }
    }
    return params;
  }

  getFlags(args: string[]): Record<string, string | boolean> {
    const flags: Record<string, string | boolean> = {};
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!arg.startsWith('--')) continue;
      const flagName = arg.replace(/^--/, '');
      const flag = this.flags.find(f => f.name === flagName || f.alias === flagName);
      if (flag?.hasValue && i + 1 < args.length) {
        flags[flag.name] = args[++i]!;
      } else if (flag) {
        flags[flag.name] = true;
      }
    }
    return flags;
  }

  public getRendered(): string {
    const flagsStr = this.flags
      .map(f => {
        const flagPart = f.hasValue ? ` [--${f.name} <value>]` : ` [--${f.name}]`;
        const descPart = f.description ? style(` (${f.description})`, ['dim']) : '';
        return flagPart + descPart;
      })
      .join('');

    return (
      style(
        'mind ' +
          this.shape
            .map(part => {
              if (this.isParam(part)) {
                return style(`<${this.getParamName(part)}>`, ['italic']);
              }
              return part;
            })
            .join(' ') +
          flagsStr,
        ['bold']
      ) + style(`\n      ↪ ${this.description}`, ['dim'])
    );
  }
}
