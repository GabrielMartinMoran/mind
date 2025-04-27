export class ArgParser {
    private shape: string[];

    constructor(shape: string[]) {
        this.shape = shape;
    }

    matches(args: string[]): boolean {
        if (this.shape.length !== args.length) {
            return false;
        }
        for (let i = 0; i < this.shape.length; i++) {
            if (this.isParam(this.shape[i]!)) {
                continue;
            }
            if (!this.shape[i]?.split('|').some((x) => x === args[i])) {
                return false;
            }
        }
        return true;
    }

    static param(name: string): string {
        return `<${name}>`;
    }

    protected isParam(part: string): boolean {
        return part.startsWith('<') && part.endsWith('>');
    }

    protected getParamName(part: string): string {
        return part.slice(1).slice(0, -1);
    }

    getParams(args: string[]): any {
        const params: any = {};
        for (let i = 0; i < this.shape.length; i++) {
            const part = this.shape[i]!;
            if (this.isParam(part)) {
                const name = this.getParamName(part);
                params[name] = args[i];
            }
        }
        return params;
    }

    public getRenderedShape(): string {
        return this.shape
            .map((part) => {
                if (this.isParam(part)) {
                    const name = this.getParamName(part);
                    return `<${name}>`;
                }
                return part;
            })
            .join(' ');
    }
}
