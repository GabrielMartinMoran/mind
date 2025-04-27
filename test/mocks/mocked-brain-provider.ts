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

    const createSpace = (name: string) => {
        getBrain()[name] = [];
    };

    const listSpaces = (): string[] => {
        return Object.keys(getBrain());
    };

    return {
        createSpace,
        listSpaces,
        saveBrain,
        getBrain,
    };
};
