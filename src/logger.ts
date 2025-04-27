export interface Logger {
    logInfo: (message: string) => void;
    logError: (message: string) => void;
}

export const useLogger = (): Logger => {
    const logInfo = (message: string) => {
        console.log(message);
    };

    const logError = (message: string) => {
        console.error(message);
    };

    return {
        logInfo,
        logError,
    };
};
