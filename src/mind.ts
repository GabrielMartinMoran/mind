import { useBrainProvider } from './brain-provider';
import { executeCommand } from './command-executor';
import { useLogger } from './logger';

const logger = useLogger();
try {
    const args = process.argv.slice(2);
    executeCommand(args, useBrainProvider(), logger);
} catch (e: any) {
    logger.logError(e.message);
    process.exit(1);
}
