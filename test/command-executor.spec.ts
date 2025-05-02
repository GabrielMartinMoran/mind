import { describe, expect, test } from 'bun:test';
import { executeCommand } from '../src/command-executor';
import { useMockedBrainProvider } from './mocks/mocked-brain-provider';
import { mockedLogger } from './mocks/mocked-logger';
import { style } from 'bun-style';

describe('Command Executor', () => {
    test('should show help', () => {
        const logger = mockedLogger();
        executeCommand(['help'], useMockedBrainProvider(), logger);

        const logs = logger.getLogs();
        expect(logs[0].message).toBe(style('💻 Allowed commands:', ['bold', 'black']));
    });

    test('should create space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        executeCommand(['create', 'test-space', 'A space for testing'], brainProvider, logger);

        expect(Object.keys(brainProvider.getBrain())).toContain('test-space');
        expect(brainProvider.getBrain()['test-space']?.description).toBe('A space for testing');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: style('✅ Space test-space created', ['bold', 'green']),
        });
    });

    test('should list spaces', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('space1', 'Space 1');
        brainProvider.createSpace('space2', 'Space 2');

        executeCommand(['list'], brainProvider, logger);

        const logs = logger.getLogs();
        expect(logs[0].message).toBe(style('🧠 Spaces:', ['bold', 'magenta']));
        expect(logs[1].message).toBe(`   ${style('1. space1', ['bold'])}: ${style('Space 1', ['gray'])}`);
        expect(logs[2].message).toBe(`   ${style('2. space2', ['bold'])}: ${style('Space 2', ['gray'])}`);
    });

    test('should read space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['add', 'test-space', 'memory1'], brainProvider, logger);
        executeCommand(['add', 'test-space', 'memory2'], brainProvider, logger);

        executeCommand(['read', 'test-space'], brainProvider, logger);

        const logs = logger.getLogs();
        expect(logs).toContainEqual({
            type: 'info',
            message: style('🛸 test-space:', ['bold', 'blue']),
        });
        expect(logs).toContainEqual({
            type: 'info',
            message: `   ${style('1.', ['bold'])} memory1`,
        });
        expect(logs).toContainEqual({
            type: 'info',
            message: `   ${style('2.', ['bold'])} memory2`,
        });
    });

    test('should read empty space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['read', 'test-space'], brainProvider, logger);

        const logs = logger.getLogs();
        expect(logs).toContainEqual({
            type: 'info',
            message: style('   No memories found!', ['dim']),
        });
    });

    test('should rename space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('old-space', 'An old space');
        executeCommand(['rename', 'old-space', 'new-space'], brainProvider, logger);

        const spaces = Object.keys(brainProvider.getBrain());
        expect(spaces).not.toContain('old-space');
        expect(spaces).toContain('new-space');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: style('✅ Space old-space renamed to new-space', ['bold', 'green']),
        });
    });

    test('should add memory to space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['add', 'test-space', 'new memory'], brainProvider, logger);

        const brain = brainProvider.getBrain();
        expect(brain['test-space'].memories).toContain('new memory');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: style('✅ Memory added: ', ['bold', 'green']) + `\n   ${style('new memory', ['dim'])}`,
        });
    });

    test('should remove memory from space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['add', 'test-space', 'memory1'], brainProvider, logger);
        executeCommand(['add', 'test-space', 'memory2'], brainProvider, logger);

        executeCommand(['remove', 'test-space', '1'], brainProvider, logger);

        const brain = brainProvider.getBrain();
        expect(brain['test-space'].memories).not.toContain('memory1');
        expect(brain['test-space'].memories).toContain('memory2');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: style('✅ Memory removed: ', ['bold', 'green']) + `\n   ${style('memory1', ['dim'])}`,
        });
    });

    test('should delete space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['delete', 'test-space'], brainProvider, logger);

        expect(Object.keys(brainProvider.getBrain())).not.toContain('test-space');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: style('✅ Space test-space deleted', ['bold', 'green']),
        });
    });

    test('should throw error for unknown command', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        expect(() => {
            executeCommand(['unknown'], brainProvider, logger);
        }).toThrow('Unknown command unknown. Run mind help for getting the list of valid commands');
    });

    test('should throw error for non-existent space', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        expect(() => {
            executeCommand(['read', 'non-existent'], brainProvider, logger);
        }).toThrow('Space non-existent does not exist');
    });

    test('should throw error for invalid memory index', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        expect(() => {
            executeCommand(['remove', 'test-space', '1'], brainProvider, logger);
        }).toThrow('Memory index 1 is not valid for space test-space');
    });

    test('should handle empty args', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        expect(() => {
            executeCommand([], brainProvider, logger);
        }).toThrow('No arguments provided');
    });

    test('should change space description', () => {
        const brainProvider = useMockedBrainProvider();
        const logger = mockedLogger();

        brainProvider.createSpace('test-space', 'A test space');
        executeCommand(['describe', 'test-space', 'A new description'], brainProvider, logger);

        const brain = brainProvider.getBrain();
        expect(brain['test-space'].description).toBe('A new description');
        expect(logger.getLogs()).toContainEqual({
            type: 'info',
            message: 'Space test-space description changed',
        });
    });
});
