import { CONFIG } from './config';
import * as fs from 'fs';
import type { Brain } from './types';

export interface BrainProvider {
    createSpace: (name: string) => void;
    listSpaces: () => string[];
    saveBrain: (brain: Brain) => void;
    getBrain: () => Brain;
}

export const useBrainProvider = (): BrainProvider => {
    const saveBrain = (brain: Brain) => {
        fs.writeFileSync(CONFIG.storagePath, JSON.stringify(brain, null, 4));
    };

    const getBrain = (): Brain => {
        if (!fs.existsSync(CONFIG.storagePath)) {
            return {};
        }
        const brain = JSON.parse(fs.readFileSync(CONFIG.storagePath, 'utf8'));
        return brain;
    };

    const createSpace = (name: string) => {
        const brain = getBrain();
        if (brain[name] !== undefined) {
            throw new Error(`Space ${name} already exists`);
        }
        brain[name] = [];
        saveBrain(brain);
    };

    const listSpaces = (): string[] => {
        const brain = getBrain();
        return Object.keys(brain);
    };

    return {
        createSpace,
        listSpaces,
        saveBrain,
        getBrain,
    };
};
