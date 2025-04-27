import { CONFIG } from './config';
import * as fs from 'fs';
import type { Brain } from './types';

export interface BrainProvider {
    createSpace: (name: string, description: string) => void;
    saveBrain: (brain: Brain) => void;
    getBrain: () => Brain;
}

export const useBrainProvider = (): BrainProvider => {
    const saveBrain = (brain: Brain) => {
        fs.writeFileSync(CONFIG.storagePath, JSON.stringify(brain, null, 4));
    };

    const getBrain = (): Brain => {
        if (!fs.existsSync(CONFIG.storagePath)) {
            return {} as Brain;
        }
        const brain = JSON.parse(fs.readFileSync(CONFIG.storagePath, 'utf8'));
        return brain;
    };

    const createSpace = (name: string, description: string) => {
        const brain = getBrain();
        if (brain[name] !== undefined) {
            throw new Error(`Space ${name} already exists`);
        }
        brain[name] = {
            description,
            memories: [],
        };
        saveBrain(brain);
    };

    return {
        createSpace,
        saveBrain,
        getBrain,
    };
};
