import { CONFIG } from './config';
import * as fs from 'fs';

export const saveBrain = (brain: any) => {
    fs.writeFileSync(CONFIG.storagePath, JSON.stringify(brain, null, 4));
};

export const getBrain = () => {
    if (!fs.existsSync(CONFIG.storagePath)) {
        return {};
    }
    const brain = JSON.parse(fs.readFileSync(CONFIG.storagePath, 'utf8'));
    return brain;
};

export const createSpace = (name: string) => {
    const brain = getBrain();
    if (brain[name] !== undefined) {
        throw new Error(`Space ${name} already exists`);
    }
    brain[name] = [];
    saveBrain(brain);
};

export const listSpaces = (): string[] => {
    const brain = getBrain();
    return Object.keys(brain);
};
