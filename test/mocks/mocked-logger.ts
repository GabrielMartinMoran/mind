export const mockedLogger = () => {
    const logs: any[] = [];

    const logInfo = (message: string) => {
        console.log(message);
        logs.push({
            type: 'info',
            message,
        });
    };

    const logError = (message: string) => {
        console.error(message);
        logs.push({
            type: 'error',
            message,
        });
    };

    const getLogs = () => {
        return logs;
    };

    return {
        logInfo,
        logError,
        getLogs,
    };
};
