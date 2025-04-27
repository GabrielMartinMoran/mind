const mockedBrains: any = {};

export const useMockedBrainProvider = () => {
    // Random brain id
    const brainId = Math.random().toString(36).substring(2, 15);

    const saveBrain = (brain: any) => {
        mockedBrains[brainId] = brain;
    };

    const getBrain = () => {
        if (mockedBrains[brainId] === undefined) {
            mockedBrains[brainId] = {};
        }
        return mockedBrains[brainId];
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
